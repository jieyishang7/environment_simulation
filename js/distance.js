// Two distance metrics over the park, and the walking network they need.
//
//   straight line  Euclidean distance, as the crow flies. Ignores everything.
//   on foot        The shortest walk along the footpaths, cutting straight
//                  across any OPEN lawn. Closed lawns are fenced, so the walk
//                  goes around them. Computed with Dijkstra's algorithm.
//
// "Paths only" (the same walk without lawn shortcuts) is kept as a reference,
// so you can see how much the lawns save.
//
// The network is built once from the map: every path vertex is a node (long
// segments are split every STEP ft), path segments are edges, and each lawn
// adds straight edges between the path points around its edge, tagged with
// the lawn so they switch off when it closes. Where a path crosses the park
// boundary there is an exit node; nearby exit nodes are grouped into gates.

import * as G from './geometry.js?v=4';

const STEP = 40;              // ft between nodes along a path
const LAWN_EDGE_REACH = 16;   // a path node this close to a lawn can step onto it
const LAWN_ACCESS_SPACING = 35;
const LAWN_SAMPLE = 8;        // ft between checks along a lawn crossing
const LAWN_SLACK = 12;        // a crossing may graze this far outside the lawn outline
const GATE_RADIUS = 220;      // exit nodes this close together are one gate
export const WALK_FT_PER_MIN = 270; // about 3 mph
export const DETOUR_FLAG = 1.5;     // on foot ÷ straight line above this counts as "far on foot"

const PERIMETER = ['Central Park West', 'Central Park South', 'Fifth Avenue', 'Central Park North',
  'Cathedral Parkway', 'Frederick Douglass Circle', 'Duke Ellington Circle', 'Columbus Circle', 'Grand Army Plaza'];

const hyp = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function shortStreet(name) {
  return name.replace(/^West /, 'W ').replace(/^East /, 'E ').replace(/ Street$/, ' St')
    .replace(/ Avenue$/, ' Ave').replace(/ Boulevard$/, ' Blvd');
}

// Point where segment ab crosses the polygon outline (first crossing from a).
function crossing(a, b, poly) {
  let best = null;
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i], d = poly[(i + 1) % poly.length];
    const r = { x: b.x - a.x, y: b.y - a.y }, s = { x: d.x - c.x, y: d.y - c.y };
    const den = r.x * s.y - r.y * s.x;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
    const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && (!best || t < best)) best = t;
  }
  return best ?? 0.5;
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

export class DistanceModel {
  constructor(park) {
    this.park = park;
    const t0 = performance.now();
    this.buildNetwork();
    this.buildGates();
    this.buildLawnEdges();
    this.buildMs = performance.now() - t0;
  }

  // ---- network -------------------------------------------------------------

  addNode(p) {
    this.nodes.push({ x: p.x, y: p.y });
    this.adj.push([]);
    return this.nodes.length - 1;
  }

  addEdge(a, b, w, lawn = null) {
    this.adj[a].push({ to: b, w, lawn });
    this.adj[b].push({ to: a, w, lawn });
  }

  buildNetwork() {
    const { park } = this;
    const outline = park.map.park.points;
    this.nodes = [];
    this.adj = [];
    this.pathEdges = []; // [a, b] for drawing the distance field
    this.pathEdgeWidths = [];
    this.exitNodes = [];
    this.stations = new Map(); // pathId -> [{n, d}] by distance along the path
    const ends = new Map();
    const endNode = (osm, p) => {
      if (!ends.has(osm)) ends.set(osm, this.addNode(p));
      return ends.get(osm);
    };

    for (const path of park.paths) {
      const { points, cum } = path;
      // Stations: every vertex, plus extra points on long segments.
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
      // Exits: where the path crosses the park outline.
      const withExits = [st[0]];
      for (let i = 1; i < st.length; i++) {
        const a = st[i - 1], b = st[i];
        if (G.pointInPolygon(a.p, outline) !== G.pointInPolygon(b.p, outline)) {
          const t = crossing(a.p, b.p, outline);
          withExits.push({ d: a.d + (b.d - a.d) * t, p: { x: a.p.x + (b.p.x - a.p.x) * t, y: a.p.y + (b.p.y - a.p.y) * t }, exit: true });
        }
        withExits.push(b);
      }
      const list = withExits.map((s, i) => {
        const n = i === 0 ? endNode(path.from, s.p) : i === withExits.length - 1 ? endNode(path.to, s.p) : this.addNode(s.p);
        if (s.exit) this.exitNodes.push({ n, path });
        return { n, d: s.d };
      });
      for (let i = 1; i < list.length; i++) {
        this.addEdge(list[i - 1].n, list[i].n, list[i].d - list[i - 1].d);
        this.pathEdges.push([list[i - 1].n, list[i].n]);
        this.pathEdgeWidths.push(path.width);
      }
      this.stations.set(path.id, list);
    }
    this.nodeIndex = new G.GridIndex(120);
    this.nodes.forEach((p, i) => this.nodeIndex.insert(i, { minX: p.x, maxX: p.x, minY: p.y, maxY: p.y }));
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
    const gates = [];
    for (const e of this.exitNodes) {
      const p = this.nodes[e.n];
      let g = gates.find((x) => hyp(x.point, p) < GATE_RADIUS);
      if (!g) {
        g = { id: `gate${gates.length + 1}`, point: { ...p }, nodes: [] };
        gates.push(g);
      }
      g.nodes.push(e.n);
    }
    const used = new Map();
    for (const g of gates) {
      const p = g.point;
      const side = [['W', p.x - box.minX], ['E', box.maxX - p.x], ['S', p.y - box.minY], ['N', box.maxY - p.y]]
        .sort((a, b) => a[1] - b[1])[0][0];
      let name;
      if (side === 'W' || side === 'E') {
        const k = streetAt(p.y);
        name = side === 'W' ? `CPW & W ${ord(k)} St` : `5th Ave & E ${ord(k)} St`;
        g.onto = side === 'W' ? 'Central Park West' : 'Fifth Avenue';
      } else {
        const ave = nearestAvenue(p);
        const edge = side === 'S' ? 'CP South' : 'CP North';
        name = ave && ave.d < 600 ? `${edge} & ${shortStreet(ave.name)}` : edge;
        g.onto = side === 'S' ? 'Central Park South' : 'Central Park North';
      }
      const k = (used.get(name) || 0) + 1;
      used.set(name, k);
      g.name = k > 1 ? `${name} (${k})` : name;
    }
    this.gates = gates;
  }

  // Straight edges across each lawn between path points around its edge.
  buildLawnEdges() {
    this.lawnAccess = new Map();
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
      for (let i = 0; i < kept.length; i++) {
        for (let j = i + 1; j < kept.length; j++) {
          const a = this.nodes[kept[i]], c = this.nodes[kept[j]];
          if (this.crossesLawn(lawn, a, c)) {
            this.addEdge(kept[i], kept[j], hyp(a, c), lawn.id);
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

  // Dijkstra from a place over the whole network.
  run(place, lawns) {
    const N = this.nodes.length;
    const dist = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const att = this.attach(place, lawns);
    const heap = new MinHeap();
    att.forEach((a, k) => {
      if (a.w < dist[a.n]) {
        dist[a.n] = a.w;
        prev[a.n] = -2 - k; // marks "reached straight from the source, via attachment k"
        heap.push(a.w, a.n);
      }
    });
    const open = new Map(this.park.lawns.map((l) => [l.id, lawns && l.status === 'open']));
    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > dist[u]) continue;
      for (const e of this.adj[u]) {
        if (e.lawn && !open.get(e.lawn)) continue;
        const nd = d + e.w;
        if (nd < dist[e.to]) {
          dist[e.to] = nd;
          prev[e.to] = u;
          heap.push(nd, e.to);
        }
      }
    }
    return { place, lawns, att, dist, prev };
  }

  // Points from the source of `run` to node n.
  routeTo(run, n) {
    const chain = [];
    let u = n;
    while (u >= 0) {
      chain.push(this.nodes[u]);
      const p = run.prev[u];
      if (p <= -2) {
        const a = run.att[-2 - p];
        return [...a.via.slice(0, -1), ...chain.reverse()];
      }
      u = p;
    }
    return chain.reverse();
  }

  // Shortest walk from the source of `run` to another place.
  walkTo(run, target) {
    const tAtt = this.attach(target, run.lawns);
    let best = { d: Infinity, route: [] };
    for (const t of tAtt) {
      const d = run.dist[t.n] + t.w;
      if (d < best.d) best = { d, t };
    }
    if (best.t) best.route = [...this.routeTo(run, best.t.n), ...best.t.via.slice(0, -1).reverse()];
    // Same stretch of the same path, or the same open lawn: go directly.
    const a = run.place, b = target;
    if (a.along && b.along && a.along.pathId === b.along.pathId) {
      const d = a.along.dist + Math.abs(a.along.d - b.along.d) + b.along.dist;
      if (d < best.d) {
        const path = this.park.path(a.along.pathId);
        const lo = Math.min(a.along.d, b.along.d), hi = Math.max(a.along.d, b.along.d);
        const inner = path.cum.map((c, i) => [c, path.points[i]]).filter(([c]) => c > lo && c < hi).map(([, p]) => p);
        if (a.along.d > b.along.d) inner.reverse();
        best = { d, route: [a.point, a.along.point, ...inner, b.along.point, b.point] };
      }
    }
    if (run.lawns && a.loc?.type === 'lawn' && b.loc?.type === 'lawn' && a.loc.id === b.loc.id) {
      const lawn = this.park.lawn(a.loc.id);
      if (lawn.status === 'open' && this.crossesLawn(lawn, a.point, b.point) && hyp(a.point, b.point) < best.d) {
        best = { d: hyp(a.point, b.point), route: [a.point, b.point] };
      }
    }
    return best;
  }

  // ---- what the panel and the view ask for ---------------------------------

  // Everything about distances from one place: both runs, every gate and lawn,
  // and (optionally) a second place.
  analyze(origin, target = null) {
    const foot = this.run(origin, true);
    const paths = this.run(origin, false);
    const o = origin.point;
    // extra(n): the last step from node n onto the place itself.
    const minAt = (run, ns, extra = () => 0) => ns.reduce((m, n) => {
      const d = run.dist[n] + extra(n);
      return d < m.d ? { d, n } : m;
    }, { d: Infinity, n: -1 });

    const gates = this.gates.map((g) => {
      const f = minAt(foot, g.nodes), p = minAt(paths, g.nodes);
      return { kind: 'gate', id: g.id, name: g.name, onto: g.onto, point: g.point, straight: hyp(o, g.point), foot: f.d, paths: p.d, footNode: f.n, pathsNode: p.n };
    }).filter((g) => Number.isFinite(g.foot));

    const ownLawn = origin.loc?.type === 'lawn' ? origin.loc.id : null;
    const lawns = this.park.lawns.filter((l) => l.id !== ownLawn).map((l) => {
      const acc = this.lawnAccess.get(l.id);
      const step = (n) => G.distanceToPolygon(this.nodes[n], l.boundary);
      const f = minAt(foot, acc, step), p = minAt(paths, acc, step);
      const edge = G.nearestOnBoundary(o, l.boundary).point;
      return { kind: 'lawn', id: l.id, name: l.name, open: l.status === 'open', point: edge, straight: G.distanceToPolygon(o, l.boundary), foot: f.d, paths: p.d, footNode: f.n, pathsNode: p.n };
    });

    const byStraight = (xs) => xs.slice().sort((a, b) => a.straight - b.straight)[0];
    const byFoot = (xs) => xs.slice().sort((a, b) => a.foot - b.foot)[0];
    const openLawns = lawns.filter((l) => l.open);
    const result = {
      origin, gates, lawns,
      gate: { line: byStraight(gates), foot: byFoot(gates) },
      lawn: { line: byStraight(lawns), lineOpen: byStraight(openLawns), foot: byFoot(openLawns) },
      foot, paths,
    };

    // Routes for the headline answers.
    const withRoutes = (x) => x && {
      ...x,
      footRoute: x.footNode >= 0 ? this.routeTo(foot, x.footNode) : [],
      pathsRoute: x.pathsNode >= 0 ? this.routeTo(paths, x.pathsNode) : [],
    };
    result.gate.foot = withRoutes(result.gate.foot);
    result.gate.line = withRoutes(result.gate.line);
    result.lawn.foot = withRoutes(result.lawn.foot);

    if (target) {
      const f = this.walkTo(foot, target), p = this.walkTo(paths, target);
      result.target = { kind: 'place', name: target.name, point: target.point, straight: hyp(o, target.point), foot: f.d, paths: p.d, footRoute: f.route, pathsRoute: p.route };
    }
    return result;
  }
}
