// Two distance metrics over the park, for four ways of getting around.
//
//   straight line  Euclidean distance, as the crow flies. Ignores everything.
//   by route       The fastest trip for the chosen mode over the real network,
//                  measured as the length of that route (and its time).
//                  Computed with Dijkstra's algorithm on travel time.
//
// Modes, and the rules the network enforces for each:
//   walk   any footpath, plus straight across OPEN lawns (closed ones are
//          fenced, so the walk goes around them), plus the sidewalks of the
//          streets around the park. 3 mph.
//   run    the same network as walking, at 6 mph.
//   bike   ride only where cycling is allowed: the park drives, bike lanes
//          and the streets. Anywhere else you walk the bike (3 mph). No bikes
//          on the lawns. 10 mph riding.
//   drive  private cars are banned from the park drives; they cross the park
//          only on the four sunken transverse roads (65th, 79th, 86th, 97th)
//          and use the streets around it. From inside the park you walk to
//          the curb, get in (1 min), drive, park (1 min) and walk on. 15 mph.
//
// "Paths only" (walking without lawn shortcuts) is kept as a reference.
//
// Every mode has its own entrances: gates where a footpath crosses the park
// outline (walk, run), the subset of those where a rideable drive or bike lane
// crosses it (bike), and the mouths of the transverse roads (drive).

import * as G from './geometry.js?v=10';

const STEP = 40;              // ft between nodes along a path
const LAWN_EDGE_REACH = 16;   // a path node this close to a lawn can step onto it
const LAWN_ACCESS_SPACING = 35;
const LAWN_SAMPLE = 8;        // ft between checks along a lawn crossing
const LAWN_SLACK = 12;        // a crossing may graze this far outside the lawn outline
const GATE_RADIUS = 220;      // exit nodes this close together are one gate
const SNAP = 4;               // street vertices this close are one node
const CURB_REACH = 200;       // a gate this close to a street node connects to it
const CAR_SWITCH = 60;        // s to get into, or park and get out of, a car
export const DETOUR_FLAG = 1.5;     // route ÷ straight line above this counts as "far by route"

const fps = (mph) => (mph * 5280) / 3600;
export const MODES = {
  walk: { key: 'walk', label: 'Walk', icon: '🚶', mph: 3, verb: 'on foot' },
  run: { key: 'run', label: 'Run', icon: '🏃', mph: 6, verb: 'running' },
  bike: { key: 'bike', label: 'Bike', icon: '🚲', mph: 10, verb: 'by bike' },
  drive: { key: 'drive', label: 'Drive', icon: '🚗', mph: 15, verb: 'by car' },
};
const WALK = fps(3);

const PERIMETER = ['Central Park West', 'Central Park South', 'Fifth Avenue', 'Central Park North',
  'Cathedral Parkway', 'Frederick Douglass Circle', 'Duke Ellington Circle', 'Columbus Circle', 'Grand Army Plaza'];

const hyp = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// Where cycling is allowed: the loop drives, the named roads that lead onto
// them from the street grid (approaches like W 72nd St or Lenox Ave), the
// 102nd St crossing and bike lanes. Not footpaths, bridle paths or the
// unnamed service roads.
const rideable = (path) => (/Drive$/.test(path.name) && path.name !== 'Former Drive')
  || path.osmKind === 'cycleway'
  || (['service', 'unclassified'].includes(path.osmKind) && !['Service road', 'Park road'].includes(path.name));

function shortStreet(name) {
  return name.replace(/^West /, 'W ').replace(/^East /, 'E ').replace(/ Street$/, ' St')
    .replace(/ Avenue$/, ' Ave').replace(/ Boulevard$/, ' Blvd');
}

// Point where segment ab crosses the polygon outline (first crossing from a).
function crossing(a, b, poly) {
  let best = null;
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i], d = poly[(i + 1) % poly.length];
    const t = segT(a, b, c, d);
    if (t && (!best || t[0] < best)) best = t[0];
  }
  return best ?? 0.5;
}

// Parameters (t along ab, u along cd) where two segments cross, or null.
function segT(a, b, c, d) {
  const r = { x: b.x - a.x, y: b.y - a.y }, s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : null;
}

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0], topK = k[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return [topK, top];
  }
}

// How each step of a route was travelled, for drawing it.
const HOW = { foot: 0, ride: 1, push: 2, car: 3, switch: 4 };

export class DistanceModel {
  constructor(park) {
    this.park = park;
    const t0 = performance.now();
    this.nodes = [];
    this.adj = [];
    this.drawEdges = []; // {a, b, width} for the distance overlay
    this.buildPaths();
    this.buildStreets();
    this.buildGates();
    this.buildCurbs();
    this.buildCarGates();
    this.buildLawnEdges();
    this.buildMs = performance.now() - t0;
  }

  // ---- network -------------------------------------------------------------

  addNode(p) {
    this.nodes.push({ x: p.x, y: p.y });
    this.adj.push([]);
    return this.nodes.length - 1;
  }

  // e: {lawn, foot, ride, car} — who may use the edge.
  addEdge(a, b, w, e) {
    this.adj[a].push({ to: b, w, ...e });
    this.adj[b].push({ to: a, w, ...e });
  }

  // The park's footpaths: every vertex is a node, with extra nodes every STEP
  // ft on long segments and an exit node where a path crosses the outline.
  buildPaths() {
    const { park } = this;
    const outline = park.map.park.points;
    this.exitNodes = [];
    this.stations = new Map(); // pathId -> [{n, d}] by distance along the path
    const ends = new Map();
    const endNode = (osm, p) => {
      if (!ends.has(osm)) ends.set(osm, this.addNode(p));
      return ends.get(osm);
    };
    for (const path of park.paths) {
      const { points, cum } = path;
      const st = [];
      for (let i = 0; i < points.length; i++) {
        if (i > 0) {
          const len = cum[i] - cum[i - 1];
          const k = Math.floor(len / STEP);
          for (let j = 1; j <= k; j++) {
            const f = j / (k + 1);
            st.push({ d: cum[i - 1] + len * f, p: { x: points[i - 1].x + (points[i].x - points[i - 1].x) * f, y: points[i - 1].y + (points[i].y - points[i - 1].y) * f } });
          }
        }
        st.push({ d: cum[i], p: points[i] });
      }
      const withExits = [st[0]];
      for (let i = 1; i < st.length; i++) {
        const a = st[i - 1], b = st[i];
        if (G.pointInPolygon(a.p, outline) !== G.pointInPolygon(b.p, outline)) {
          const t = crossing(a.p, b.p, outline);
          withExits.push({ d: a.d + (b.d - a.d) * t, p: { x: a.p.x + (b.p.x - a.p.x) * t, y: a.p.y + (b.p.y - a.p.y) * t }, exit: true });
        }
        withExits.push(b);
      }
      const ride = rideable(path);
      const list = withExits.map((s, i) => {
        const n = i === 0 ? endNode(path.from, s.p) : i === withExits.length - 1 ? endNode(path.to, s.p) : this.addNode(s.p);
        if (s.exit) this.exitNodes.push({ n, path, ride });
        return { n, d: s.d };
      });
      for (let i = 1; i < list.length; i++) {
        this.addEdge(list[i - 1].n, list[i].n, list[i].d - list[i - 1].d, { foot: true, ride });
        this.drawEdges.push({ a: list[i - 1].n, b: list[i].n, width: path.width });
      }
      this.stations.set(path.id, list);
    }
    this.pathNodeCount = this.nodes.length;
    this.nodeIndex = new G.GridIndex(120);
    this.nodes.forEach((p, i) => this.nodeIndex.insert(i, { minX: p.x, maxX: p.x, minY: p.y, maxY: p.y }));
  }

  // Streets around the park (cars, bikes, and people on the sidewalks) and the
  // transverse roads through it (cars only). The map's street lines don't
  // share nodes, so they are split where they cross and snapped together.
  buildStreets() {
    const lines = [
      ...this.park.map.streets.map((s) => ({ points: s.points, car: true, foot: true, ride: true, width: s.width })),
      ...this.park.map.transverses.map((s) => ({ points: s.points, car: true, foot: false, ride: false, width: s.width, transverse: s.name })),
    ];
    const segs = [];
    for (const l of lines) {
      for (let i = 1; i < l.points.length; i++) segs.push({ a: l.points[i - 1], b: l.points[i], line: l, cuts: [0, 1] });
    }
    const index = new G.GridIndex(250);
    segs.forEach((s) => index.insert(s, G.bbox([s.a, s.b])));
    for (const s of segs) {
      for (const o of index.inBox(G.bbox([s.a, s.b]))) {
        if (o === s) continue;
        const t = segT(s.a, s.b, o.a, o.b);
        if (t) s.cuts.push(t[0]);
        // T-junctions: an end of o that stops just short of (or on) s.
        for (const p of [o.a, o.b]) {
          const c = G.closestOnSegment(p, s.a, s.b);
          if (c.dist < SNAP && c.t > 0 && c.t < 1) s.cuts.push(c.t);
        }
      }
    }
    // Snap points to nodes within SNAP ft.
    const grid = new Map();
    const key = (x, y) => `${x},${y}`;
    this.streetNodes = new Set();
    const nodeAt = (p) => {
      const gx = Math.floor(p.x / SNAP), gy = Math.floor(p.y / SNAP);
      for (let i = gx - 1; i <= gx + 1; i++) {
        for (let j = gy - 1; j <= gy + 1; j++) {
          for (const n of grid.get(key(i, j)) || []) if (hyp(this.nodes[n], p) < SNAP) return n;
        }
      }
      const n = this.addNode(p);
      if (!grid.has(key(gx, gy))) grid.set(key(gx, gy), []);
      grid.get(key(gx, gy)).push(n);
      this.streetNodes.add(n);
      return n;
    };
    this.transverseNodes = new Map(); // node -> transverse name
    for (const s of segs) {
      const cuts = [...new Set(s.cuts.map((t) => Math.round(t * 1e6) / 1e6))].sort((x, y) => x - y);
      const len = hyp(s.a, s.b);
      let prev = null;
      for (const t of cuts) {
        const n = nodeAt({ x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t });
        if (s.line.transverse) this.transverseNodes.set(n, s.line.transverse);
        if (prev !== null && prev.n !== n) {
          const w = (t - prev.t) * len;
          this.addEdge(prev.n, n, w, { car: true, foot: s.line.foot, ride: s.line.ride, street: true });
          this.drawEdges.push({ a: prev.n, b: n, width: Math.min(s.line.width, 30) * 0.6 });
        }
        prev = { n, t };
      }
    }
  }

  // Groups exit nodes into gates, named after the side of the park they open
  // onto and the cross street (or avenue) they line up with.
  buildGates() {
    const streets = this.park.map.streets.filter((s) => s.name);
    // The map is square to the Manhattan grid, so a numbered street is a line
    // of constant y. Fit street number against y to name any point.
    const xs = [];
    for (const s of streets) {
      const m = s.name.match(/^(?:West|East) (\d+)(?:st|nd|rd|th) Street$/);
      if (m) xs.push([s.points.reduce((a, p) => a + p.y, 0) / s.points.length, +m[1]]);
    }
    const n = xs.length;
    const my = xs.reduce((a, [y]) => a + y, 0) / n, mn = xs.reduce((a, [, k]) => a + k, 0) / n;
    const slope = xs.reduce((a, [y, k]) => a + (y - my) * (k - mn), 0) / xs.reduce((a, [y]) => a + (y - my) ** 2, 0);
    const streetAt = (y) => Math.round(mn + slope * (y - my));
    const ord = (k) => `${k}${[11, 12, 13].includes(k % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][k % 10] || 'th'}`;
    const nearestAvenue = (p) => {
      let best = null;
      for (const s of streets) {
        if (PERIMETER.includes(s.name) || /Street|Transverse/.test(s.name)) continue;
        for (let i = 1; i < s.points.length; i++) {
          const d = G.closestOnSegment(p, s.points[i - 1], s.points[i]).dist;
          if (!best || d < best.d) best = { d, name: s.name };
        }
      }
      return best;
    };
    const box = G.bbox(this.park.map.park.points);
    this.sideOf = (p) => [['W', p.x - box.minX], ['E', box.maxX - p.x], ['S', p.y - box.minY], ['N', box.maxY - p.y]]
      .sort((a, b) => a[1] - b[1])[0][0];
    this.placeName = (p) => {
      const side = this.sideOf(p);
      if (side === 'W' || side === 'E') {
        const k = streetAt(p.y);
        return side === 'W' ? `CPW & W ${ord(k)} St` : `5th Ave & E ${ord(k)} St`;
      }
      const ave = nearestAvenue(p);
      const edge = side === 'S' ? 'CP South' : 'CP North';
      return ave && ave.d < 600 ? `${edge} & ${shortStreet(ave.name)}` : edge;
    };
    const group = (exits, prefix) => {
      const gates = [];
      for (const e of exits) {
        const p = this.nodes[e.n];
        let g = gates.find((x) => hyp(x.point, p) < GATE_RADIUS);
        if (!g) {
          g = { id: `${prefix}${gates.length + 1}`, point: { ...p }, nodes: [] };
          gates.push(g);
        }
        g.nodes.push(e.n);
      }
      const used = new Map();
      for (const g of gates) {
        const name = this.placeName(g.point);
        const k = (used.get(name) || 0) + 1;
        used.set(name, k);
        g.name = k > 1 ? `${name} (${k})` : name;
      }
      return gates;
    };
    this.gates = group(this.exitNodes, 'gate');
    this.bikeGates = group(this.exitNodes.filter((e) => e.ride), 'bike');
  }

  // Each footpath gate meets the sidewalk at the nearest street node.
  buildCurbs() {
    const streetIndex = new G.GridIndex(150);
    for (const n of this.streetNodes) {
      if (this.adj[n].some((e) => e.foot)) streetIndex.insert(n, { minX: this.nodes[n].x, maxX: this.nodes[n].x, minY: this.nodes[n].y, maxY: this.nodes[n].y });
    }
    for (const e of this.exitNodes) {
      const p = this.nodes[e.n];
      let best = null;
      for (const n of streetIndex.near(p, CURB_REACH)) {
        const d = hyp(p, this.nodes[n]);
        if (d < CURB_REACH && (!best || d < best.d)) best = { n, d };
      }
      if (best) this.addEdge(e.n, best.n, best.d, { foot: true, ride: true, curb: true });
    }
  }

  // Car entrances: where a transverse road meets the street grid.
  buildCarGates() {
    const mouths = [];
    for (const [n, name] of this.transverseNodes) {
      if (this.adj[n].some((e) => e.street && e.foot)) mouths.push({ n, name });
    }
    const gates = [];
    for (const m of mouths) {
      const p = this.nodes[m.n];
      let g = gates.find((x) => x.transverse === m.name && hyp(x.point, p) < 400);
      if (!g) {
        const side = this.sideOf(p);
        const onto = side === 'W' ? 'CPW' : side === 'E' ? '5th Ave' : side === 'S' ? 'CP South' : 'CP North';
        g = { id: `car${gates.length + 1}`, point: { ...p }, nodes: [], transverse: m.name, name: `${m.name.replace(' Street', ' St')} · ${onto}` };
        gates.push(g);
      }
      g.nodes.push(m.n);
    }
    this.carGates = gates;
  }

  // Straight edges across each lawn between path points around its edge.
  buildLawnEdges() {
    this.lawnAccess = new Map();
    this.lawnStep = new Map(); // lawn -> (access node -> ft from the node onto the lawn)
    let count = 0;
    for (const lawn of this.park.lawns) {
      const b = lawn.box;
      const near = this.nodeIndex.inBox({ minX: b.minX - 30, minY: b.minY - 30, maxX: b.maxX + 30, maxY: b.maxY + 30 })
        .filter((n) => G.distanceToPolygon(this.nodes[n], lawn.boundary) <= LAWN_EDGE_REACH);
      const kept = [];
      for (const n of near) {
        if (kept.every((m) => hyp(this.nodes[m], this.nodes[n]) >= LAWN_ACCESS_SPACING)) kept.push(n);
      }
      this.lawnAccess.set(lawn.id, kept);
      this.lawnStep.set(lawn.id, new Map(kept.map((n) => [n, G.distanceToPolygon(this.nodes[n], lawn.boundary)])));
      for (let i = 0; i < kept.length; i++) {
        for (let j = i + 1; j < kept.length; j++) {
          const a = this.nodes[kept[i]], c = this.nodes[kept[j]];
          if (this.crossesLawn(lawn, a, c)) {
            this.addEdge(kept[i], kept[j], hyp(a, c), { foot: true, lawn: lawn.id });
            count++;
          }
        }
      }
    }
    this.lawnEdgeCount = count;
  }

  // Whether the straight walk a -> b stays on the lawn (grazing the edge where
  // paths cut through it is fine).
  crossesLawn(lawn, a, b) {
    const n = Math.ceil(hyp(a, b) / LAWN_SAMPLE);
    for (let k = 1; k < n; k++) {
      const q = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
      if (!G.pointInPolygon(q, lawn.boundary) && G.nearestOnBoundary(q, lawn.boundary).dist > LAWN_SLACK) return false;
    }
    return true;
  }

  // ---- places ----------------------------------------------------------------

  // A place is {point, loc: {type, id} | null}. Returns how it joins the
  // network: [{n, w, via}] where via is the drawn leg from the place to node n.
  attach(place, lawns) {
    // The same place is attached once per lawn setting and reused by every
    // mode (checking lawn crossings is the slow part).
    place.attached ??= {};
    const memo = place.attached[lawns ? 1 : 0];
    if (memo) return memo;
    const out = this.attachNow(place, lawns);
    place.attached[lawns ? 1 : 0] = out;
    return out;
  }

  attachNow(place, lawns) {
    const { park } = this;
    const { point, loc } = place;
    const out = [];
    const onPath = (path) => {
      const c = G.closestOnPolyline(point, path.points, path.cum);
      const st = this.stations.get(path.id);
      let k = 0;
      while (k < st.length - 2 && st[k + 1].d < c.d) k++;
      for (const s of [st[k], st[k + 1]]) {
        if (s) out.push({ n: s.n, w: c.dist + Math.abs(c.d - s.d), via: [point, c.point, this.nodes[s.n]] });
      }
      return c;
    };
    if (loc?.type === 'path') place.along = { pathId: loc.id, ...onPath(park.path(loc.id)) };
    else if (loc?.type === 'bench') place.along = { pathId: park.bench(loc.id).pathId, ...onPath(park.path(park.bench(loc.id).pathId)) };
    else {
      if (loc?.type === 'lawn' && lawns && park.lawn(loc.id).status === 'open') {
        const lawn = park.lawn(loc.id);
        for (const n of this.lawnAccess.get(lawn.id)) {
          const p = this.nodes[n];
          if (this.crossesLawn(lawn, point, p)) out.push({ n, w: hyp(point, p), via: [point, p] });
        }
      }
      // Off the network (a lawn, the woods): walk straight to the nearest path.
      let near = [];
      for (let r = 40; !near.length && r < 20000; r *= 2) near = park.pathsNear(point, r);
      if (near.length) onPath(near[0].path);
    }
    return out;
  }

  // Dijkstra on travel time from a place, for one mode. Driving has three
  // phases per node: walking to the car, in the car, walking from the car.
  // `lawns: false` gives the paths-only reference.
  run(place, mode, { lawns = mode !== 'bike' } = {}) {
    const N = this.nodes.length;
    const P = mode === 'drive' ? 3 : 1;
    const S = N * P;
    const time = new Float64Array(S).fill(Infinity);
    const len = new Float64Array(S).fill(Infinity);
    const prev = new Int32Array(S).fill(-1);
    const how = new Int8Array(S).fill(-1);
    const footSpeed = mode === 'run' ? fps(6) : WALK;
    const rideSpeed = fps(10), carSpeed = fps(15);
    const att = this.attach(place, lawns);
    const heap = new MinHeap();
    att.forEach((a, k) => {
      const t = a.w / footSpeed;
      if (t < time[a.n * P]) {
        time[a.n * P] = t;
        len[a.n * P] = a.w;
        prev[a.n * P] = -2 - k; // reached straight from the source, via attachment k
        how[a.n * P] = mode === 'bike' ? HOW.push : HOW.foot;
        heap.push(t, a.n * P);
      }
    });
    const open = new Map(this.park.lawns.map((l) => [l.id, lawns && l.status === 'open']));
    const relax = (s, ns, dt, dl, h) => {
      const nt = time[s] + dt;
      if (nt < time[ns]) {
        time[ns] = nt;
        len[ns] = len[s] + dl;
        prev[ns] = s;
        how[ns] = h;
        heap.push(nt, ns);
      }
    };
    while (heap.size) {
      const [t, s] = heap.pop();
      if (t > time[s]) continue;
      const u = P === 1 ? s : Math.floor(s / P);
      const ph = s - u * P;
      if (mode === 'drive' && ph === 1) {
        for (const e of this.adj[u]) if (e.car) relax(s, e.to * P + 1, e.w / carSpeed, e.w, HOW.car);
        if (this.streetNodes.has(u)) relax(s, u * P + 2, CAR_SWITCH, 0, HOW.switch);
        continue;
      }
      if (mode === 'drive' && ph === 0 && this.streetNodes.has(u) && this.adj[u].some((e) => e.car)) {
        relax(s, u * P + 1, CAR_SWITCH, 0, HOW.switch);
      }
      for (const e of this.adj[u]) {
        if (!e.foot || (e.lawn && (mode === 'bike' || !open.get(e.lawn)))) continue;
        if (mode === 'bike' && e.ride) relax(s, e.to * P + ph, e.w / rideSpeed, e.w, HOW.ride);
        else relax(s, e.to * P + ph, e.w / footSpeed, e.w, mode === 'bike' ? HOW.push : HOW.foot);
      }
    }
    return { place, mode, lawns, P, att, time, len, prev, how, footSpeed };
  }

  // Best arrival at node n: any phase for walking modes; for driving, only
  // after using the car.
  at(run, n) {
    if (run.P === 1) return { s: n, time: run.time[n], len: run.len[n] };
    const a = n * 3 + 1, b = n * 3 + 2;
    const s = run.time[a] <= run.time[b] ? a : b;
    return { s, time: run.time[s], len: run.len[s] };
  }

  // The route from the source of `run` to state s, as segments
  // [{kind: 'main' | 'walk', points}] ('walk' = walking the bike, or the walk
  // to and from the car).
  routeTo(run, s) {
    const steps = [];
    let u = s;
    while (u >= 0) {
      const n = Math.floor(u / run.P);
      steps.push({ p: this.nodes[n], how: run.how[u] });
      const p = run.prev[u];
      if (p <= -2) {
        const via = run.att[-2 - p].via;
        steps.push(...via.slice(0, -1).reverse().map((q) => ({ p: q, how: run.how[u] })));
        break;
      }
      u = p;
    }
    steps.reverse();
    const kindOf = (h) => (run.mode === 'walk' || run.mode === 'run' ? 'main'
      : h === HOW.ride || h === HOW.car ? 'main' : 'walk');
    const segs = [];
    for (let i = 1; i < steps.length; i++) {
      if (steps[i].how === HOW.switch) continue;
      const kind = kindOf(steps[i].how);
      const last = segs.at(-1);
      if (last && last.kind === kind) last.points.push(steps[i].p);
      else segs.push({ kind, points: [steps[i - 1].p, steps[i].p] });
    }
    return segs;
  }

  // Fastest trip from the source of `run` to another place.
  tripTo(run, target) {
    const tAtt = this.attach(target, run.lawns);
    const lastSpeed = run.mode === 'run' ? run.footSpeed : WALK;
    let best = { time: Infinity, len: Infinity, route: [] };
    for (const t of tAtt) {
      const a = this.at(run, t.n);
      const time = a.time + t.w / lastSpeed;
      if (time < best.time) best = { time, len: a.len + t.w, s: a.s, t };
    }
    if (best.t) {
      best.route = this.routeTo(run, best.s);
      const kind = run.mode === 'walk' || run.mode === 'run' ? 'main' : 'walk';
      best.route.push({ kind, points: best.t.via.slice().reverse() });
    }
    if (run.mode !== 'walk' && run.mode !== 'run') return best;
    // Same stretch of the same path, or the same open lawn: go directly.
    const a = run.place, b = target;
    if (a.along && b.along && a.along.pathId === b.along.pathId) {
      const d = a.along.dist + Math.abs(a.along.d - b.along.d) + b.along.dist;
      if (d / lastSpeed < best.time) {
        const path = this.park.path(a.along.pathId);
        const lo = Math.min(a.along.d, b.along.d), hi = Math.max(a.along.d, b.along.d);
        const inner = path.cum.map((c, i) => [c, path.points[i]]).filter(([c]) => c > lo && c < hi).map(([, p]) => p);
        if (a.along.d > b.along.d) inner.reverse();
        best = { time: d / lastSpeed, len: d, route: [{ kind: 'main', points: [a.point, a.along.point, ...inner, b.along.point, b.point] }] };
      }
    }
    if (run.lawns && a.loc?.type === 'lawn' && b.loc?.type === 'lawn' && a.loc.id === b.loc.id) {
      const lawn = this.park.lawn(a.loc.id);
      const d = hyp(a.point, b.point);
      if (lawn.status === 'open' && this.crossesLawn(lawn, a.point, b.point) && d / lastSpeed < best.time) {
        best = { time: d / lastSpeed, len: d, route: [{ kind: 'main', points: [a.point, b.point] }] };
      }
    }
    return best;
  }

  entrancesFor(mode) {
    return mode === 'bike' ? this.bikeGates : mode === 'drive' ? this.carGates : this.gates;
  }

  // ---- what the panel and the view ask for ---------------------------------

  // Everything about distances from one place for one mode: its entrances,
  // lawns (walking and running), an optional second place, and how all four
  // modes compare.
  analyze(origin, target, mode) {
    // Running uses exactly the walking network at twice the speed, so its
    // runs are the walking runs with every time halved.
    const asRun = (w) => ({ ...w, mode: 'run', time: w.time.map((t) => (t * WALK) / fps(6)), footSpeed: fps(6) });
    const runs = { walk: this.run(origin, 'walk'), bike: this.run(origin, 'bike'), drive: this.run(origin, 'drive') };
    runs.run = asRun(runs.walk);
    const r = runs[mode];
    let ref = null;
    if (mode === 'walk' || mode === 'run') {
      ref = this.run(origin, 'walk', { lawns: false });
      if (mode === 'run') ref = asRun(ref);
    }
    const o = origin.point;

    // For a set of target nodes (+ a last step from each), the best arrival.
    const best = (run, ns, extra = () => 0) => {
      let b = { time: Infinity, len: Infinity, s: -1 };
      for (const n of ns) {
        const a = this.at(run, n);
        const x = extra(n);
        const time = a.time + x / (run.mode === 'run' ? run.footSpeed : WALK);
        if (time < b.time) b = { time, len: a.len + x, s: a.s };
      }
      return b;
    };
    const entrances = (run, refRun) => this.entrancesFor(run.mode).map((g) => {
      const b = best(run, g.nodes);
      const p = refRun ? best(refRun, g.nodes) : null;
      return { kind: 'gate', id: g.id, name: g.name, point: g.point, straight: hyp(o, g.point), len: b.len, time: b.time, s: b.s, refLen: p?.len };
    }).filter((g) => Number.isFinite(g.time));

    const gates = entrances(r, ref);
    let lawns = [];
    if (mode === 'walk' || mode === 'run') {
      const ownLawn = origin.loc?.type === 'lawn' ? origin.loc.id : null;
      lawns = this.park.lawns.filter((l) => l.id !== ownLawn).map((l) => {
        const steps = this.lawnStep.get(l.id);
        const step = (n) => steps.get(n);
        const acc = this.lawnAccess.get(l.id);
        const b = best(r, acc, step), p = best(ref, acc, step);
        return { kind: 'lawn', id: l.id, name: l.name, open: l.status === 'open', point: G.nearestOnBoundary(o, l.boundary).point, straight: G.distanceToPolygon(o, l.boundary), len: b.len, time: b.time, s: b.s, refLen: p.len };
      });
    }
    const byStraight = (xs) => xs.slice().sort((a, b) => a.straight - b.straight)[0];
    const byTime = (xs) => xs.slice().sort((a, b) => a.time - b.time)[0];
    const withRoute = (run) => (x) => x && { ...x, route: x.s >= 0 ? this.routeTo(run, x.s) : [] };
    const openLawns = lawns.filter((l) => l.open);
    const result = {
      origin, mode, gates, lawns,
      gate: { line: byStraight(gates), route: withRoute(r)(byTime(gates)) },
      lawn: lawns.length ? { line: byStraight(lawns), lineOpen: byStraight(openLawns), route: withRoute(r)(byTime(openLawns)) } : null,
      run: r,
    };
    if (ref && result.gate.route) {
      const p = best(ref, this.entrancesFor(mode).find((g) => g.id === result.gate.route.id).nodes);
      result.gate.route.refRoute = this.routeTo(ref, p.s);
    }
    if (target) {
      const t = this.tripTo(r, target);
      const p = ref ? this.tripTo(ref, target) : null;
      result.target = { kind: 'place', name: target.name, point: target.point, straight: hyp(o, target.point), len: t.len, time: t.time, route: t.route, refLen: p?.len, refRoute: p?.route };
    }
    // The same question for every mode: to B if there is one, else out of the park.
    result.compare = Object.keys(MODES).map((m) => {
      if (target) {
        const t = this.tripTo(runs[m], target);
        return { mode: m, time: t.time, len: t.len, to: target.name };
      }
      const g = byTime(entrances(runs[m]));
      return { mode: m, time: g?.time ?? Infinity, len: g?.len ?? Infinity, to: g?.name };
    });
    return result;
  }
}
