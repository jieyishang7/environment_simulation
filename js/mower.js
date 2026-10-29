// A ride-on mower that drives over a lawn in stripes, with a proximity rule:
//
//   IF any person or dog is less than 1.5 m (4.9 ft) from the mower,
//   THEN the mower stops and sounds the alarm,
//   ELSE it keeps mowing.
//
// Metric: straight-line (Euclidean) distance from the mower's body (a
// rectangle) to the occupant's position. Straight line is the right metric
// here because the danger is the blade itself: nothing between a person and
// the mower (a path, a fence line) makes it safer.
//
// If someone stays inside the zone, the operator waits a moment, then steers
// around them; that patch is left unmowed. No rendering code.

import * as G from './geometry.js?v=10';

export const SAFE_M = 1.5;
export const FT_PER_M = 3.28084;
export const SAFE_FT = SAFE_M * FT_PER_M;    // 4.92 ft
export const MOWER_LENGTH = 6;               // ft
export const MOWER_WIDTH = 4.5;              // ft
export const CUT_WIDTH = 5;                  // ft, the deck: one stripe
export const MOWER_SPEED = 4;                // ft/s, about 2.7 mph
export const MOWER_LAWN = 'great-lawn';      // the mower works the Great Lawn
const RESUME_MARGIN = 0.5;                   // ft of hysteresis before moving again
const STEER_AFTER = 2;                       // s stopped before steering around
const SUBSTEP = 0.5;                         // ft moved between proximity checks
const RESUME_PROBE = 2;                      // ft ahead that must be clear to resume
const HISTORY = 120;                         // distance samples kept (30 s at 4 Hz)

const hyp = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Distance from p to a rectangle centred at c, pointing along unit u.
export function distanceToBody(p, c, u, length = MOWER_LENGTH, width = MOWER_WIDTH) {
  const dx = p.x - c.x, dy = p.y - c.y;
  const a = Math.abs(dx * u.x + dy * u.y) - length / 2;
  const b = Math.abs(-dx * u.y + dy * u.x) - width / 2;
  return Math.hypot(Math.max(a, 0), Math.max(b, 0));
}

// Back-and-forth stripes across a lawn, CUT_WIDTH apart, along its longer
// side, starting from the end nearest `start`. Returns route points with a
// `cut` flag per segment (false for the turns between stripes).
export function stripeRoute(poly, start) {
  const box = G.bbox(poly);
  const alongX = box.maxX - box.minX >= box.maxY - box.minY;
  // Work in (s, t): s along the stripes, t across them.
  const toST = (p) => (alongX ? { s: p.x, t: p.y } : { s: p.y, t: p.x });
  const toXY = (s, t) => (alongX ? { x: s, y: t } : { x: t, y: s });
  const pts = poly.map(toST);
  const tMin = alongX ? box.minY : box.minX, tMax = alongX ? box.maxY : box.maxX;
  const ts = [];
  for (let t = tMin + CUT_WIDTH / 2; t < tMax; t += CUT_WIDTH) ts.push(t);
  // Start on the stripe through `start` (where the camera is looking), mow
  // to the far side, then come back for the stripes on the near side.
  const st0 = toST(start);
  let k = 0;
  ts.forEach((t, i) => { if (Math.abs(t - st0.t) < Math.abs(ts[k] - st0.t)) k = i; });
  const toward = Math.abs(st0.t - tMax) < Math.abs(st0.t - tMin) ? -1 : 1;
  const order = toward > 0 ? [...ts.slice(k), ...ts.slice(0, k).reverse()] : [...ts.slice(0, k + 1).reverse(), ...ts.slice(k + 1)];
  ts.splice(0, ts.length, ...order);
  const route = [];
  const cut = [];
  let forward = true;
  for (const t of ts) {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a.t <= t && b.t > t) || (b.t <= t && a.t > t)) xs.push(a.s + ((t - a.t) / (b.t - a.t)) * (b.s - a.s));
    }
    xs.sort((p, q) => p - q);
    const runs = [];
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const s0 = xs[i] + MOWER_LENGTH / 2, s1 = xs[i + 1] - MOWER_LENGTH / 2;
      if (s1 > s0) runs.push([s0, s1]);
    }
    if (!runs.length) continue;
    if (!forward) { runs.reverse(); runs.forEach((r) => r.reverse()); }
    for (const [s0, s1] of runs) {
      if (route.length) cut.push(false);
      route.push(toXY(s0, t));
      cut.push(true);
      route.push(toXY(s1, t));
    }
    forward = !forward;
  }
  return { points: route, cut, cum: G.polylineLengths(route) };
}

export class Mower {
  constructor(park, lawn, start) {
    this.park = park;
    this.lawnId = lawn.id;
    this.route = stripeRoute(lawn.boundary, start);
    this.total = this.route.cum.at(-1) || 0;
    this.cutTotal = this.route.cut.reduce((a, c, i) => a + (c ? this.route.cum[i + 1] - this.route.cum[i] : 0), 0);
    this.s = 0;                 // ft along the route
    this.status = 'mowing';     // mowing | alarm | steering | done | stopped
    this.mowed = [];            // [s0, s1] intervals actually cut
    this.runStart = 0;
    this.alarmFor = 0;          // s spent stopped in the current alarm
    this.alarms = 0;            // how many times the alarm went off
    this.timeScale = 5;
    this.history = [];
    this.sampleClock = 0;
    this.steer = null;
    this.update();
  }

  get lawn() { return this.park.lawn(this.lawnId); }

  pose(s = this.s) {
    const f = G.pointOnPolyline(this.route.points, this.route.cum, Math.min(s, this.total));
    return { point: f.point, u: f.u, seg: f.seg };
  }

  // The occupant nearest the mower's body, at pose `p`.
  nearestTo(p) {
    let best = null;
    for (const u of this.park.users) {
      if (Math.abs(u.position.x - p.point.x) > 60 || Math.abs(u.position.y - p.point.y) > 60) continue;
      const d = distanceToBody(u.position, p.point, p.u);
      if (!best || d < best.dist) best = { id: u.id, name: u.name, type: u.type, dist: d, point: { ...u.position } };
    }
    return best;
  }

  update() {
    const p = this.steer ? { point: this.steer.at, u: this.steer.u } : this.pose();
    this.position = p.point;
    this.heading = p.u;
    this.nearest = this.nearestTo(p);
  }

  get progress() {
    const done = this.mowed.reduce((a, [s0, s1]) => a + this.cutLength(s0, s1), 0);
    return this.cutTotal ? Math.min(1, done / this.cutTotal) : 1;
  }

  // Length of route between s0 and s1 that is on a cutting segment.
  cutLength(s0, s1) {
    const { cum, cut } = this.route;
    let sum = 0;
    for (let i = 0; i < cut.length; i++) {
      if (!cut[i]) continue;
      const a = Math.max(s0, cum[i]), b = Math.min(s1, cum[i + 1]);
      if (b > a) sum += b - a;
    }
    return sum;
  }

  tooClose(n) { return n && n.dist < SAFE_FT; }

  // Advances the mower by dt seconds of real time. Returns an event name when
  // something worth logging happened.
  tick(dt) {
    if (this.status === 'done' || this.status === 'stopped') return null;
    const sim = dt * this.timeScale;
    this.sampleClock += dt;
    if (this.sampleClock >= 0.25) {
      this.sampleClock = 0;
      this.history.push(this.nearest ? Math.min(this.nearest.dist, 30) : 30);
      if (this.history.length > HISTORY) this.history.shift();
    }

    if (this.status === 'steering') {
      // Drive through the waypoints around the person, not cutting.
      // The proximity rule holds while steering too.
      const st = this.steer;
      let budget = MOWER_SPEED * sim;
      while (budget > 1e-9 && st.waypoints.length) {
        const to = st.waypoints[0];
        const left = hyp(st.at, to);
        if (left > 1e-6) st.u = { x: (to.x - st.at.x) / left, y: (to.y - st.at.y) / left };
        const step = Math.min(SUBSTEP, budget, left);
        st.at = step >= left ? { ...to } : { x: st.at.x + st.u.x * step, y: st.at.y + st.u.y * step };
        if (step >= left) st.waypoints.shift();
        budget -= step;
        this.update();
        // Backing away from the person it is steering around is allowed;
        // anyone else in the zone, or getting closer, stops it.
        const n = this.nearest;
        const leaving = n && n.id === st.aroundId && n.dist >= st.lastDist - 0.05;
        if (n?.id === st.aroundId) st.lastDist = Math.max(st.lastDist, n.dist);
        if (this.tooClose(n) && !leaving) {
          this.status = 'alarm';
          this.alarmFor = 0;
          this.alarms++;
          return 'alarm';
        }
      }
      if (!st.waypoints.length) {
        this.steer = null;
        this.s = st.s;
        this.runStart = this.s;
        this.status = 'mowing';
      }
      this.update();
      return null;
    }

    if (this.status === 'alarm') {
      // Stay stopped until the zone is clear here and a little way ahead.
      this.update();
      const ahead = this.nearestTo(this.pose(Math.min(this.total, this.s + RESUME_PROBE)));
      const clear = (n) => !n || n.dist >= SAFE_FT + RESUME_MARGIN;
      if (clear(this.nearest) && (this.steer || clear(ahead))) {
        this.status = this.steer ? 'steering' : 'mowing';
        this.runStart = this.s;
        return 'resume';
      }
      this.alarmFor += dt;
      if (this.alarmFor >= STEER_AFTER) return this.steerAround();
      return null;
    }

    // Mowing: move in small steps, and stop at the first one where anyone is
    // inside the zone.
    let budget = MOWER_SPEED * sim;
    while (budget > 1e-9 && this.s < this.total) {
      const step = Math.min(SUBSTEP, budget, this.total - this.s);
      this.s += step;
      budget -= step;
      this.update();
      if (this.tooClose(this.nearest)) {
        this.closeRun();
        this.status = 'alarm';
        this.alarmFor = 0;
        this.alarms++;
        return 'alarm';
      }
    }
    this.extendRun();
    if (this.s >= this.total) {
      this.closeRun();
      this.status = 'done';
      this.lawn.grassHeight = Math.min(this.lawn.grassHeight, 5);
      return 'done';
    }
    return null;
  }

  extendRun() {
    const last = this.mowed.at(-1);
    if (last && last[0] === this.runStart) last[1] = this.s;
    else this.mowed.push([this.runStart, this.s]);
  }

  closeRun() {
    if (this.s > this.runStart) this.extendRun();
    this.runStart = this.s;
  }

  // Whether the mower can drive along `pts` keeping everyone outside the zone
  // (or, while it is still inside, never getting closer than `floor`).
  pathClear(pts, floor = Infinity) {
    const limit = Math.min(SAFE_FT + RESUME_MARGIN, floor);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const len = hyp(a, b);
      if (len < 1e-6) continue;
      const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
      for (let d = 0; d <= len; d += 1) {
        const n = this.nearestTo({ point: { x: a.x + u.x * d, y: a.y + u.y * d }, u });
        if (n && n.dist < limit) return false;
      }
    }
    return true;
  }

  // Finds the next clear point on the route and a detour to it that keeps
  // everyone outside the zone, trying both sides of the person. If there is
  // none yet, keeps waiting.
  steerAround() {
    const from = this.position;
    const who = this.nearest?.point;
    for (let s = this.s + 2; s <= this.total; s += 2) {
      const p = this.pose(s);
      const n = this.nearestTo(p);
      if (n && n.dist < SAFE_FT + 2) continue;
      const to = p.point;
      const options = [[to]];
      if (who) {
        const c = G.closestOnSegment(who, from, to).point;
        let dx = c.x - who.x, dy = c.y - who.y;
        let d = Math.hypot(dx, dy);
        if (d < 1e-3) { dx = -(to.y - from.y); dy = to.x - from.x; d = Math.hypot(dx, dy) || 1; }
        const along = { x: (to.x - from.x) / (hyp(from, to) || 1), y: (to.y - from.y) / (hyp(from, to) || 1) };
        for (const side of [1, -1]) {
          for (const k of [1, 1.6, 2.4]) {
            const clear = (SAFE_FT + Math.hypot(MOWER_LENGTH, MOWER_WIDTH) / 2 + 1) * k;
            const via = { x: who.x + (side * dx / d) * clear, y: who.y + (side * dy / d) * clear };
            // Ease out sideways, pass the person, then rejoin the stripe.
            options.push([{ x: from.x + (via.x - c.x), y: from.y + (via.y - c.y) }, via,
              { x: via.x + along.x * clear, y: via.y + along.y * clear }, to]);
          }
        }
      }
      const floor = (this.nearest?.dist ?? Infinity) - 0.05;
      const plan = options.find((wps) => this.pathClear([from, ...wps], floor));
      if (plan) {
        this.closeRun();
        this.steer = { s, at: { ...from }, waypoints: plan, u: this.heading, around: this.nearest?.name, aroundId: this.nearest?.id, lastDist: this.nearest?.dist ?? Infinity };
        this.status = 'steering';
        return 'steer';
      }
      if (s > this.s + 80) break; // nothing workable nearby: wait and try again
    }
    this.alarmFor = 0;
    return null;
  }

  stop() {
    this.closeRun();
    this.status = 'stopped';
  }
}
