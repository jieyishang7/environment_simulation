// The semantic model of the park: entities (Lawn, Path, Bench, User), their
// relationships, the rules that constrain them and the actions that change
// them. Users are people or dogs. This module has no rendering code.

import * as G from './geometry.js?v=6';

export const ACTIVITIES = ['walking', 'standing', 'sitting', 'playing'];
export const GRASS_MIN = 2;
export const GRASS_MAX = 20;
export const MOW_HEIGHT = 5;
export const NEEDS_MOWING_ABOVE = 15;
export const MIN_PATH_WIDTH = 1.5;
export const SQFT_PER_USER = 10;
export const BENCH_SEATS = 3;
export const LEASH_LENGTH = 6; // ft

const PERSON_SPACING = 2; // ft between people placed on a lawn
const DOG_SPACING = 1.2;
const LAWN_MARGIN = 1; // ft clearance from a lawn edge when placing users
const DOG_NAMES = ['Biscuit', 'Luna', 'Max', 'Pepper', 'Rex', 'Daisy', 'Milo', 'Ziggy', 'Olive', 'Bruno', 'Pickles', 'Nala'];

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pt = (x, y) => ({ x, y });

const PATH_KIND_NAMES = {
  footway: 'Footpath', path: 'Trail', steps: 'Steps', bridleway: 'Bridle path', cycleway: 'Bike path',
  track: 'Track', service: 'Service road', unclassified: 'Park road', pedestrian: 'Walk',
};

const BORDER_TOLERANCE = 6; // ft between a path's edge and a lawn it borders

// Starting grass height (″), status and daily growth for the real lawns.
const LAWN_START = {
  'great-lawn': [7, 'open', 0.8],
  'sheep-meadow': [17, 'open', 1.1],
  'east-meadow': [10, 'open', 0.9],
  'north-meadow': [12, 'open', 1.0],
  'cedar-hill': [13, 'closed', 1.4],
  'pilgrim-hill': [6, 'open', 1.2],
  'great-hill': [15.5, 'open', 0.7],
  'east-green': [9, 'open', 1.3],
  'frisbee-hill': [11, 'open', 1.0],
  'dene-slope': [8, 'open', 1.1],
  'childrens-glade': [5, 'open', 0.9],
};

// A path is a stretch of real footway between two junctions, described by its
// centerline polyline and width. `from` and `to` name the map nodes at its
// ends; paths that share a node meet there.
function makePath(f) {
  const points = f.points;
  const cum = G.polylineLengths(points);
  const bb = G.bbox(points);
  const hw = f.width / 2;
  return {
    kind: 'path', id: f.id, name: f.name || PATH_KIND_NAMES[f.kind] || 'Path', osmKind: f.kind,
    width: f.width, points, cum, len: cum[cum.length - 1], from: f.from, to: f.to,
    box: { minX: bb.minX - hw, minY: bb.minY - hw, maxX: bb.maxX + hw, maxY: bb.maxY + hw },
    bordersLawns: [], connectsTo: [], benches: [], junctions: [], range: [0, 1],
  };
}

function makeLawn(id, name, boundary, grassHeight, status, growth) {
  const poly = G.toCCW(boundary);
  const area = G.polygonArea(poly);
  return {
    kind: 'lawn', id, name, boundary: poly, area, box: G.bbox(poly),
    capacity: Math.floor(area / SQFT_PER_USER),
    grassHeight, status, growth, borderedBy: [],
  };
}

// A bench stands just off one side of a path (side +1 or -1 along the path's
// normal at s), parallel to it and facing it.
function makeBench(id, name, path, s, side) {
  const length = 5;
  const depth = 1.6;
  const f = G.pointOnPolyline(path.points, path.cum, path.len * s);
  const { u, n } = f;
  const off = side * (path.width / 2 + 0.35 + depth / 2);
  const center = pt(f.point.x + n.x * off, f.point.y + n.y * off);
  const corner = (k, m) => pt(
    center.x + u.x * (length / 2) * k + n.x * (depth / 2) * m,
    center.y + u.y * (length / 2) * k + n.y * (depth / 2) * m,
  );
  const boundary = G.toCCW([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]);
  return {
    kind: 'bench', id, name, pathId: path.id, s, side, center, length, depth,
    u, facing: pt(-side * n.x, -side * n.y), boundary, box: G.bbox(boundary),
    seats: BENCH_SEATS,
    seatPoints: [-1.6, 0, 1.6].map((k) => pt(center.x + u.x * k, center.y + u.y * k)),
  };
}

export class Park {
  // `map` is the parsed Central Park extract from map.js.
  constructor(map, seed = 7) {
    this.map = map;
    this.paths = map.paths.map(makePath);
    this.pathById = new Map(this.paths.map((p) => [p.id, p]));
    this.pathIndex = new G.GridIndex(150);
    for (const p of this.paths) this.pathIndex.insert(p, p.box);
    this.reset(seed);
  }

  reset(seed = 7) {
    this.rng = mulberry32(seed);
    this.day = 0;
    this.nextUserId = 1;
    this.dogNameIndex = 0;
    this.users = [];
    this.log = [];

    this.lawns = this.map.lawns.map((l) => {
      const [h, status, growth] = LAWN_START[l.id] || [8, 'open', 1];
      return makeLawn(l.id, l.name, l.points, h, status, growth);
    });
    this.computeRelationships();
    // The visitors start at the south end of the Great Lawn, by Turtle Pond.
    const great = this.lawn('great-lawn');
    const south = great.boundary.reduce((m, p) => (p.y < m.y ? p : m));
    this.focus = pt(south.x, south.y + 40);
    this.benches = this.placeBenches();
    for (const p of this.paths) p.benches = this.benches.filter((b) => b.pathId === p.id).map((b) => b.id);
    this.staticChecks = this.checkLayout();

    const nearby = this.pathsNear(this.focus, 200)
      .filter(({ path }) => path.width <= 12 && path.len > 12)
      .slice(0, 6);
    const people = nearby.map(({ path, c }, i) =>
      this.spawnWalker(path.id, Math.max(0.15, Math.min(0.85, c.d / path.len)), i % 2 ? -1 : 1));
    const f = this.focus;
    const sitterA = this.spawnOnLawn('great-lawn', 'sitting', pt(f.x - 12, f.y + 18));
    this.spawnOnLawn('great-lawn', 'sitting', pt(f.x + 14, f.y + 30));
    this.spawnOnLawn('great-lawn', 'sitting', pt(f.x + 30, f.y + 12));
    this.spawnOnLawn('great-lawn', 'standing', pt(f.x + 4, f.y + 8));
    const bench = this.benches
      .slice()
      .sort((a, b) => Math.hypot(a.center.x - f.x, a.center.y - f.y) - Math.hypot(b.center.x - f.x, b.center.y - f.y))[0];
    this.seatOnBench(this.newPerson('sitting', pt(0, 0), { type: 'bench', id: bench.id }), bench);

    this.attachDog(people[2]);
    const luna = this.attachDog(sitterA);
    this.unleash(luna, true);

    this.note('Central Park opened with 11 visitors and 2 dogs at the Great Lawn.');
  }

  // A few benches along the paths that border each lawn, on the side away
  // from the lawn, wherever they clear every lawn, path and other bench.
  placeBenches() {
    const benches = [];
    // One by the starting spot, so the first visitors have somewhere to sit.
    for (const { path } of this.pathsNear(this.focus, 150)) {
      if (path.width > 12 || path.osmKind === 'steps' || path.len < 16) continue;
      for (const side of [1, -1]) {
        const bench = makeBench('b1', 'Turtle Pond Bench', path, 0.5, side);
        if (!benches.length && this.benchClear(bench, benches)) benches.push(bench);
      }
      if (benches.length) break;
    }
    for (const lawn of this.lawns) {
      const want = lawn.area > 150000 ? 3 : 1;
      const center = G.centroid(lawn.boundary);
      const candidates = lawn.borderedBy.map((id) => this.path(id))
        .filter((p) => p.width <= 12 && p.osmKind !== 'steps' && p.len >= 16)
        .sort((a, b) => b.len - a.len);
      let placed = 0;
      for (const path of candidates) {
        if (placed >= want) break;
        // Middle of the path's longest straight stretch.
        let seg = 1;
        for (let i = 1; i < path.points.length; i++) {
          if (path.cum[i] - path.cum[i - 1] > path.cum[seg] - path.cum[seg - 1]) seg = i;
        }
        if (path.cum[seg] - path.cum[seg - 1] < 8) continue;
        const s = (path.cum[seg - 1] + path.cum[seg]) / 2 / path.len;
        const f = G.pointOnPolyline(path.points, path.cum, s * path.len);
        const toLawn = (center.x - f.point.x) * f.n.x + (center.y - f.point.y) * f.n.y;
        const side = toLawn > 0 ? -1 : 1;
        const id = `b${benches.length + 1}`;
        const bench = makeBench(id, `${lawn.name} Bench${want > 1 ? ` ${placed + 1}` : ''}`, path, s, side);
        if (this.benchClear(bench, benches)) {
          benches.push(bench);
          placed++;
        }
      }
    }
    return benches;
  }

  benchClear(bench, others) {
    if (others.some((o) => Math.hypot(o.center.x - bench.center.x, o.center.y - bench.center.y) < 8)) return false;
    if (this.lawns.some((l) => G.bboxOverlap(l.box, bench.box) && G.polygonsOverlap(l.boundary, bench.boundary))) return false;
    if (this.map.water.some((w) => bench.boundary.some((c) => G.pointInPolygon(c, w.points)))) return false;
    return this.pathIndex.inBox(bench.box).every((p) =>
      G.polylineToPolygonDistance(p.points, bench.boundary, p.cum) >= p.width / 2 - 0.01);
  }

  // ---- lookups ---------------------------------------------------------

  path(id) { return this.pathById.get(id); }
  lawn(id) { return this.lawns.find((l) => l.id === id); }
  bench(id) { return this.benches.find((b) => b.id === id); }
  user(id) { return this.users.find((u) => u.id === id); }
  usersAt(type, id) { return this.users.filter((u) => u.locationType === type && u.locationId === id); }
  usersOnLawn(id) { return this.usersAt('lawn', id); }
  usersOnPath(id) { return this.usersAt('path', id); }
  usersOnBench(id) { return this.usersAt('bench', id); }
  dogsOf(person) { return this.users.filter((u) => u.type === 'dog' && u.ownerId === person.id); }
  owner(dog) { return this.user(dog.ownerId); }
  needsMowing(lawn) { return lawn.grassHeight > NEEDS_MOWING_ABOVE; }
  locationName(u) {
    const where = u.locationType === 'lawn' ? this.lawn(u.locationId)
      : u.locationType === 'bench' ? this.bench(u.locationId) : this.path(u.locationId);
    return where ? where.name : '—';
  }

  note(message, level = 'info') {
    this.log.push({ day: this.day, message, level });
    if (this.log.length > 200) this.log.shift();
  }

  // ---- relationships ---------------------------------------------------

  computeRelationships() {
    for (const lawn of this.lawns) {
      lawn.borderedBy = this.pathIndex.inBox({
        minX: lawn.box.minX - 30, minY: lawn.box.minY - 30, maxX: lawn.box.maxX + 30, maxY: lawn.box.maxY + 30,
      })
        .filter((p) => G.polylineToPolygonDistance(p.points, lawn.boundary, p.cum) <= p.width / 2 + BORDER_TOLERANCE)
        .map((p) => p.id);
    }
    const byLawn = new Map();
    for (const l of this.lawns) for (const id of l.borderedBy) byLawn.set(id, [...(byLawn.get(id) || []), l.id]);

    // Paths meet where they share an end node. Walkers turn there.
    const ends = new Map();
    for (const p of this.paths) {
      for (const [node, s] of [[p.from, 0], [p.to, 1]]) {
        if (!ends.has(node)) ends.set(node, []);
        ends.get(node).push({ path: p, s });
      }
    }
    for (const p of this.paths) {
      p.bordersLawns = byLawn.get(p.id) || [];
      p.junctions = [];
      for (const [node, s] of [[p.from, 0], [p.to, 1]]) {
        for (const e of ends.get(node)) {
          if (e.path !== p) p.junctions.push({ s, other: e.path.id, otherS: e.s });
        }
      }
      p.junctions.sort((x, y) => x.s - y.s);
      p.connectsTo = [...new Set(p.junctions.map((j) => j.other))];
      p.range = [0, 1];
    }
  }

  // Static layout rules: they depend only on the map, so they're checked once.
  checkLayout() {
    const overlaps = [];
    for (let i = 0; i < this.lawns.length; i++) {
      const a = this.lawns[i];
      for (const b of this.lawns.slice(i + 1)) {
        if (G.bboxOverlap(a.box, b.box) && G.polygonsOverlap(a.boundary, b.boundary)) overlaps.push(`${a.name} overlaps ${b.name}`);
      }
      for (const p of this.pathIndex.inBox(a.box)) {
        if (G.polylineEntersPolygon(p.points, a.boundary)) overlaps.push(`${p.name} cuts across ${a.name}`);
      }
    }
    for (const b of this.benches) {
      if (!this.benchClear(b, this.benches.filter((o) => o !== b))) overlaps.push(`${b.name} overlaps its surroundings`);
    }
    const unbordered = [
      ...this.lawns.filter((l) => l.borderedBy.length === 0).map((l) => `${l.name} borders no path`),
      ...this.benches.filter((b) => {
        const p = this.path(b.pathId);
        return G.polylineToPolygonDistance(p.points, b.boundary, p.cum) > p.width / 2 + 0.5;
      }).map((b) => `${b.name} is away from any path`),
    ];
    const narrow = this.paths.filter((p) => p.width < MIN_PATH_WIDTH).map((p) => `${p.name} is ${p.width} ft wide`);
    return { overlaps, unbordered, narrow };
  }

  // ---- positions -------------------------------------------------------

  pathPoint(path, t, lane = 0) {
    const f = G.pointOnPolyline(path.points, path.cum, path.len * t);
    return pt(f.point.x + f.n.x * lane, f.point.y + f.n.y * lane);
  }

  // Paths whose centerline passes within r ft of p, nearest first.
  pathsNear(p, r) {
    return this.pathIndex.near(p, r)
      .map((path) => ({ path, c: G.closestOnPolyline(p, path.points, path.cum) }))
      .filter((x) => x.c.dist <= r)
      .sort((a, b) => a.c.dist - b.c.dist);
  }

  // Which lawn, path or bench contains p (boundaries count as inside).
  locate(p) {
    for (const l of this.lawns) {
      if (G.bboxOverlap(l.box, { minX: p.x, maxX: p.x, minY: p.y, maxY: p.y }, 0.01) && G.containsPoint(l.boundary, p)) {
        return { type: 'lawn', id: l.id };
      }
    }
    const onPath = this.pathsNear(p, 20).find((x) => x.c.dist <= x.path.width / 2 + 0.05);
    if (onPath) return { type: 'path', id: onPath.path.id };
    for (const b of this.benches) if (G.containsPoint(b.boundary, p)) return { type: 'bench', id: b.id };
    return null;
  }

  randomLane(path) {
    return (this.rng() * 2 - 1) * path.width * 0.32;
  }

  // A dog walks half a step to the side of its owner, inside the path.
  dogLane(ownerLane, path) {
    const lane = ownerLane + (ownerLane >= 0 ? -1.3 : 1.3);
    const max = path.width * 0.42;
    return Math.max(-max, Math.min(max, lane));
  }

  // Free spot on a lawn near `near`, keeping users apart.
  findLawnSpot(lawn, near, spacing = PERSON_SPACING, ignore = null) {
    const others = this.usersOnLawn(lawn.id).filter((u) => u !== ignore);
    const clear = (p) => others.every((o) => Math.hypot(o.position.x - p.x, o.position.y - p.y) >= spacing);
    const base = G.pushInside(near, lawn.boundary, LAWN_MARGIN);
    if (clear(base)) return base;
    for (let r = 1; r < 40; r += 1) {
      for (let k = 0; k < 10; k++) {
        const ang = this.rng() * Math.PI * 2;
        const p = pt(base.x + Math.cos(ang) * r, base.y + Math.sin(ang) * r);
        if (G.strictlyInside(p, lawn.boundary, LAWN_MARGIN) && clear(p)) return p;
      }
    }
    return G.randomPointInPolygon(lawn.boundary, LAWN_MARGIN, this.rng);
  }

  // ---- creation helpers ------------------------------------------------

  newUser(type, activity, position, location, extra = {}) {
    const id = this.nextUserId++;
    const user = {
      id, type, activity, position,
      name: type === 'dog' ? DOG_NAMES[this.dogNameIndex++ % DOG_NAMES.length] : `Visitor ${id}`,
      locationType: location.type, locationId: location.id,
      walk: null, speed: 8 + this.rng() * 5, ...extra,
    };
    this.users.push(user);
    return user;
  }

  newPerson(activity, position, location) {
    return this.newUser('person', activity, position, location);
  }

  spawnWalker(pathId, t, dir) {
    const path = this.path(pathId);
    const [lo, hi] = path.range;
    const tt = Math.max(lo, Math.min(hi, t));
    const lane = this.randomLane(path);
    const user = this.newPerson('walking', this.pathPoint(path, tt, lane), { type: 'path', id: pathId });
    user.walk = { pathId, t: tt, dir, lane };
    return user;
  }

  spawnOnLawn(lawnId, activity, near) {
    const lawn = this.lawn(lawnId);
    return this.newPerson(activity, this.findLawnSpot(lawn, near), { type: 'lawn', id: lawnId });
  }

  attachDog(owner) {
    const dog = this.newUser('dog', owner.activity, { ...owner.position },
      { type: owner.locationType, id: owner.locationId }, { ownerId: owner.id, leashed: true });
    this.followOwner(dog);
    return dog;
  }

  // ---- placement -----------------------------------------------------------

  // Puts a leashed dog beside its owner, matching what the owner is doing.
  followOwner(dog) {
    const owner = this.owner(dog);
    dog.leashed = true;
    if (owner.locationType === 'path') {
      const path = this.path(owner.locationId);
      dog.walk = { ...owner.walk, lane: this.dogLane(owner.walk.lane, path) };
      dog.position = this.pathPoint(path, dog.walk.t, dog.walk.lane);
      dog.activity = 'walking';
      dog.locationType = 'path';
      dog.locationId = path.id;
    } else if (owner.locationType === 'lawn') {
      const lawn = this.lawn(owner.locationId);
      const near = pt(owner.position.x + 1.6, owner.position.y - 0.8);
      dog.walk = null;
      dog.position = this.findLawnSpot(lawn, near, DOG_SPACING, dog);
      dog.activity = owner.activity;
      dog.locationType = 'lawn';
      dog.locationId = lawn.id;
    } else {
      // Owner on a bench: the dog sits on the path at their feet.
      const bench = this.bench(owner.locationId);
      const path = this.path(bench.pathId);
      const along = G.closestOnPolyline(owner.position, path.points, path.cum).d;
      dog.walk = null;
      dog.position = this.pathPoint(path, along / path.len, bench.side * (path.width / 2 - 0.7));
      dog.activity = 'sitting';
      dog.locationType = 'path';
      dog.locationId = path.id;
    }
  }

  // Leashed dogs follow; unleashed dogs are leashed up first.
  bringDogs(person) {
    for (const dog of this.dogsOf(person)) this.followOwner(dog);
  }

  // Puts a person on the path nearest their position, walking.
  moveToNearestPath(user) {
    let near = [];
    for (let r = 40; !near.length && r < 5000; r *= 2) near = this.pathsNear(user.position, r);
    const best = { path: near[0].path, t: near[0].c.d / near[0].path.len };
    const { path } = best;
    const [lo, hi] = path.range;
    const t = Math.max(lo, Math.min(hi, best.t));
    const lane = this.randomLane(path);
    user.activity = 'walking';
    user.walk = { pathId: path.id, t, dir: this.rng() < 0.5 ? 1 : -1, lane };
    user.position = this.pathPoint(path, t, lane);
    user.locationType = 'path';
    user.locationId = path.id;
    this.bringDogs(user);
    return path;
  }

  seatOnBench(person, bench) {
    const taken = this.usersOnBench(bench.id).filter((u) => u !== person).map((u) => u.seat);
    const seat = [1, 0, 2].find((s) => !taken.includes(s));
    person.activity = 'sitting';
    person.walk = null;
    person.seat = seat;
    person.position = { ...bench.seatPoints[seat] };
    person.locationType = 'bench';
    person.locationId = bench.id;
    this.bringDogs(person);
  }

  unleash(dog, quiet = false) {
    const owner = this.owner(dog);
    if (owner.locationType !== 'lawn') {
      return this.refuse(`${dog.name} can only be let off the leash on a lawn, and ${owner.name} is on ${this.locationName(owner)}.`);
    }
    const lawn = this.lawn(owner.locationId);
    const ang = this.rng() * Math.PI * 2;
    const near = pt(owner.position.x + Math.cos(ang) * 5, owner.position.y + Math.sin(ang) * 5);
    dog.leashed = false;
    dog.activity = 'playing';
    dog.walk = null;
    dog.position = this.findLawnSpot(lawn, near, DOG_SPACING, dog);
    if (!quiet) this.note(`${owner.name} let ${dog.name} off the leash on ${lawn.name}.`);
    return { ok: true };
  }

  // ---- rules used by actions ---------------------------------------------

  // Whether `count` more users (a person plus their dogs) may enter a lawn.
  canEnterLawn(lawn, count = 1) {
    if (lawn.status !== 'open') return { ok: false, reason: `${lawn.name} is closed` };
    const n = this.usersOnLawn(lawn.id).length;
    if (n + count > lawn.capacity) {
      return { ok: false, reason: `${lawn.name} is full (${n}/${lawn.capacity})` };
    }
    return { ok: true };
  }

  canMow(lawn) {
    const n = this.usersOnLawn(lawn.id).length;
    if (n > 0) return { ok: false, reason: `${lawn.name} has ${n} ${n === 1 ? 'user' : 'users'} on it` };
    return { ok: true };
  }

  // ---- actions -----------------------------------------------------------

  // A new visitor arrives on a path near `near` (where the camera is looking).
  addUser(near = this.focus) {
    const options = this.pathsNear(near, 120).map((x) => x.path).filter((p) => p.len > 4);
    const pool = options.length ? options : this.paths;
    const path = pool[Math.floor(this.rng() * pool.length)];
    const [lo, hi] = path.range;
    const user = this.spawnWalker(path.id, lo + (hi - lo) * this.rng(), this.rng() < 0.5 ? 1 : -1);
    this.note(`${user.name} arrived on ${path.name}, walking.`);
    return { ok: true, user };
  }

  // Gives the selected person a dog on a leash, or brings a new visitor with
  // a dog when no person is selected.
  addDog(ownerId, near) {
    let owner = ownerId ? this.user(ownerId) : null;
    if (owner && owner.type !== 'person') owner = this.owner(owner);
    if (owner?.locationType === 'lawn') {
      const check = this.canEnterLawn(this.lawn(owner.locationId));
      if (!check.ok) return this.refuse(`No room for a dog: ${check.reason}.`);
    }
    if (!owner) owner = this.addUser(near).user;
    const dog = this.attachDog(owner);
    this.note(`${owner.name} brought ${dog.name} the dog, on a leash.`);
    return { ok: true, user: dog };
  }

  removeUser(id) {
    const user = this.user(id);
    if (!user) return { ok: false, reason: 'Select a user first' };
    const gone = [user, ...(user.type === 'person' ? this.dogsOf(user) : [])];
    this.users = this.users.filter((u) => !gone.includes(u));
    this.note(`${gone.map((u) => u.name).join(' and ')} left the park.`);
    return { ok: true };
  }

  changeActivity(id) {
    const user = this.user(id);
    if (!user) return { ok: false, reason: 'Select a user first' };
    return user.type === 'dog' ? this.changeDogActivity(user) : this.changePersonActivity(user);
  }

  // walking -> standing -> sitting -> walking
  changePersonActivity(user) {
    const dogs = this.dogsOf(user);

    if (user.activity === 'walking') {
      // Standing happens on a lawn: step onto the nearest open lawn bordering
      // the current path that has room for this person and their dogs.
      const path = this.path(user.locationId);
      const candidates = path.bordersLawns
        .map((lid) => this.lawn(lid))
        .map((l) => ({ l, d: G.distanceToPolygon(user.position, l.boundary), check: this.canEnterLawn(l, 1 + dogs.length) }))
        .sort((x, y) => x.d - y.d);
      const target = candidates.find((c) => c.check.ok);
      if (!target) {
        const why = candidates.length
          ? candidates.map((c) => c.check.reason).join('; ')
          : `${path.name} borders no lawn`;
        return this.refuse(`${user.name} can't stop to stand: ${why}.`);
      }
      user.position = this.findLawnSpot(target.l, user.position);
      user.activity = 'standing';
      user.walk = null;
      user.locationType = 'lawn';
      user.locationId = target.l.id;
      this.bringDogs(user);
      this.note(`${user.name} stepped onto ${target.l.name} and is standing.`);
      return { ok: true };
    }

    if (user.activity === 'standing') {
      user.activity = 'sitting';
      for (const dog of dogs) if (dog.leashed) dog.activity = 'sitting';
      this.note(`${user.name} sat down on ${this.lawn(user.locationId).name}.`);
      return { ok: true };
    }

    // sitting -> walking: walking must happen on a path.
    const path = this.moveToNearestPath(user);
    this.note(`${user.name} got up and is walking on ${path.name}` +
      (dogs.length ? `, with ${dogs.map((d) => d.name).join(' and ')} on the leash.` : '.'));
    return { ok: true };
  }

  // A leashed dog does what its owner does, except it may stand or sit when
  // the owner is stopped. An unleashed dog cycles playing -> standing -> sitting.
  changeDogActivity(dog) {
    const owner = this.owner(dog);
    if (dog.leashed) {
      if (owner.activity === 'walking') return this.refuse(`${dog.name} is on the leash and walks with ${owner.name}.`);
      if (owner.locationType === 'bench') return this.refuse(`${dog.name} is resting at ${owner.name}'s feet by the bench.`);
      dog.activity = dog.activity === 'standing' ? 'sitting' : 'standing';
    } else {
      dog.activity = { playing: 'standing', standing: 'sitting', sitting: 'playing' }[dog.activity];
    }
    this.note(`${dog.name} is now ${dog.activity}.`);
    return { ok: true };
  }

  sitOnBench(id) {
    const user = this.user(id);
    if (!user) return { ok: false, reason: 'Select a person first' };
    if (user.type !== 'person') return this.refuse(`Dogs don't sit on benches.`);
    if (user.locationType === 'bench') return this.refuse(`${user.name} is already on ${this.locationName(user)}.`);
    const free = this.benches
      .filter((b) => this.usersOnBench(b.id).length < b.seats)
      .sort((a, b) => Math.hypot(a.center.x - user.position.x, a.center.y - user.position.y) -
                      Math.hypot(b.center.x - user.position.x, b.center.y - user.position.y));
    if (!free.length) return this.refuse('Every bench is full.');
    this.seatOnBench(user, free[0]);
    this.note(`${user.name} sat down on ${free[0].name}.`);
    return { ok: true };
  }

  toggleLeash(id) {
    const dog = this.user(id);
    if (!dog || dog.type !== 'dog') return { ok: false, reason: 'Select a dog first' };
    if (!dog.leashed) {
      this.followOwner(dog);
      this.note(`${this.owner(dog).name} put ${dog.name} back on the leash.`);
      return { ok: true };
    }
    return this.unleash(dog);
  }

  // The owner throws a ball; the dog runs out for it and brings it back.
  // Returns the dog's run so the view can animate it.
  fetch(id) {
    const dog = this.user(id);
    if (!dog || dog.type !== 'dog') return { ok: false, reason: 'Select a dog first' };
    if (dog.leashed) return this.refuse(`${dog.name} needs to be off the leash to play fetch.`);
    const owner = this.owner(dog);
    const lawn = this.lawn(dog.locationId);
    const ang = this.rng() * Math.PI * 2;
    const reach = 15 + this.rng() * 20;
    const ball = G.pushInside(pt(owner.position.x + Math.cos(ang) * reach, owner.position.y + Math.sin(ang) * reach),
      lawn.boundary, LAWN_MARGIN);
    const start = { ...dog.position };
    dog.position = this.findLawnSpot(lawn, pt(owner.position.x + 1.5, owner.position.y + 1), DOG_SPACING, dog);
    dog.activity = 'playing';
    this.note(`${owner.name} threw a ball and ${dog.name} fetched it.`);
    return { ok: true, run: [start, ball, { ...dog.position }], ball };
  }

  // Sends everyone on a lawn (people and dogs) to the nearest path so it can
  // be mowed. Returns how many users left.
  clearLawn(id, quiet = false) {
    const lawn = this.lawn(id);
    if (!lawn) return { ok: false, reason: 'Select a lawn first' };
    const here = this.usersOnLawn(lawn.id);
    const people = here.filter((u) => u.type === 'person');
    for (const p of people) this.moveToNearestPath(p);
    // Dogs whose owner is elsewhere are fetched back to their owner too.
    for (const d of here.filter((u) => u.type === 'dog' && u.locationType === 'lawn')) this.followOwner(d);
    if (!quiet) {
      this.note(here.length
        ? `Cleared ${lawn.name}: ${people.length} ${people.length === 1 ? 'person' : 'people'}` +
          (here.length > people.length ? ` and ${here.length - people.length} dog${here.length - people.length === 1 ? '' : 's'}` : '') +
          ' moved to the nearest path.'
        : `${lawn.name} is already empty.`);
    }
    return { ok: true, count: here.length };
  }

  mowLawn(id) {
    const lawn = this.lawn(id);
    if (!lawn) return { ok: false, reason: 'Select a lawn first' };
    const check = this.canMow(lawn);
    if (!check.ok) return this.refuse(`Can't mow: ${check.reason}. Clear the lawn first.`);
    const before = lawn.grassHeight;
    lawn.grassHeight = MOW_HEIGHT;
    this.note(`${lawn.name} mowed from ${before.toFixed(1)}″ to ${MOW_HEIGHT}″.`);
    return { ok: true };
  }

  toggleLawn(id) {
    const lawn = this.lawn(id);
    if (!lawn) return { ok: false, reason: 'Select a lawn first' };
    if (lawn.status === 'open') {
      lawn.status = 'closed';
      const { count } = this.clearLawn(lawn.id, true);
      this.note(`${lawn.name} closed.` +
        (count ? ` ${count} ${count === 1 ? 'user moved' : 'users moved'} to the nearest path.` : ''));
    } else {
      lawn.status = 'open';
      this.note(`${lawn.name} reopened.`);
    }
    return { ok: true };
  }

  // Moves walkers along their paths (leashed dogs alongside), lets unleashed
  // dogs roam and grows the grass. Returns, per user, the waypoints travelled
  // so the view can animate along them.
  advanceTime() {
    this.day += 1;
    for (const lawn of this.lawns) {
      lawn.grassHeight = Math.min(GRASS_MAX, lawn.grassHeight + lawn.growth);
    }
    const trails = new Map();
    for (const user of this.users) {
      if (user.type !== 'person' || user.activity !== 'walking') continue;
      const stops = this.walk(user, user.speed);
      trails.set(user.id, this.trailPoints(stops, user.walk.lane));
      for (const dog of this.dogsOf(user)) {
        this.followOwner(dog);
        trails.set(dog.id, this.trailPoints(stops, dog.walk.lane));
      }
    }
    for (const dog of this.users) {
      if (dog.type !== 'dog' || dog.leashed || dog.activity !== 'playing') continue;
      const lawn = this.lawn(dog.locationId);
      const start = { ...dog.position };
      const ang = this.rng() * Math.PI * 2;
      dog.position = this.findLawnSpot(lawn, pt(start.x + Math.cos(ang) * 6, start.y + Math.sin(ang) * 6), DOG_SPACING, dog);
      trails.set(dog.id, [start, { ...dog.position }]);
    }
    const due = this.lawns.filter((l) => this.needsMowing(l)).map((l) => l.name);
    this.note(`Day ${this.day}: grass grew.` + (due.length ? ` Needs mowing: ${due.join(', ')}.` : ''));
    return trails;
  }

  // Waypoints for an animation through `stops`, following each path's bends.
  trailPoints(stops, lane) {
    const pts = [];
    stops.forEach((s, i) => {
      const path = this.path(s.pathId);
      const max = path.width * 0.42;
      const l = Math.max(-max, Math.min(max, lane));
      const prev = stops[i - 1];
      if (prev && prev.pathId === s.pathId) {
        const d0 = prev.t * path.len;
        const d1 = s.t * path.len;
        const inner = path.cum.filter((c) => c > Math.min(d0, d1) + 1e-6 && c < Math.max(d0, d1) - 1e-6);
        if (d1 < d0) inner.reverse();
        for (const c of inner) pts.push(this.pathPoint(path, c / path.len, l));
      }
      pts.push(this.pathPoint(path, s.t, l));
    });
    return pts;
  }

  // Walks a person `distance` ft along the path network. Returns the stops
  // passed through as {pathId, t}.
  walk(user, distance) {
    const stops = [{ pathId: user.walk.pathId, t: user.walk.t }];
    let remaining = distance;
    for (let guard = 0; remaining > 1e-6 && guard < 200; guard++) {
      const w = user.walk;
      const path = this.path(w.pathId);
      const [lo, hi] = path.range;
      const end = w.dir > 0 ? hi : lo;
      const ahead = path.junctions
        .filter((j) => (w.dir > 0 ? j.s > w.t + 1e-6 && j.s <= hi + 1e-9 : j.s < w.t - 1e-6 && j.s >= lo - 1e-9))
        .sort((x, y) => Math.abs(x.s - w.t) - Math.abs(y.s - w.t));
      const stopS = ahead.length ? ahead[0].s : end;
      const span = Math.abs(stopS - w.t) * path.len;

      if (span > remaining) {
        w.t += (w.dir * remaining) / path.len;
        remaining = 0;
        stops.push({ pathId: path.id, t: w.t });
        break;
      }
      w.t = stopS;
      remaining -= span;
      stops.push({ pathId: path.id, t: w.t });

      const here = path.junctions.filter((j) => Math.abs(j.s - stopS) < 1e-6);
      const atEnd = Math.abs(stopS - end) < 1e-9;
      if (atEnd && here.length === 0) {
        w.dir = -w.dir;
      } else if (here.length && (atEnd || this.rng() < 0.4)) {
        const j = here[Math.floor(this.rng() * here.length)];
        const next = this.path(j.other);
        const [nlo, nhi] = next.range;
        w.pathId = next.id;
        w.t = Math.max(nlo, Math.min(nhi, j.otherS));
        if (w.t <= nlo + 1e-6) w.dir = 1;
        else if (w.t >= nhi - 1e-6) w.dir = -1;
        else w.dir = this.rng() < 0.5 ? 1 : -1;
        w.lane = Math.max(-next.width * 0.32, Math.min(next.width * 0.32, w.lane));
        stops.push({ pathId: next.id, t: w.t });
      }
    }
    user.position = this.pathPoint(this.path(user.walk.pathId), user.walk.t, user.walk.lane);
    user.locationType = 'path';
    user.locationId = user.walk.pathId;
    return stops;
  }

  refuse(reason) {
    this.note(reason, 'warn');
    return { ok: false, reason };
  }

  // ---- full rule check -------------------------------------------------

  validate() {
    const results = [];
    const add = (rule, violations) => results.push({ rule, ok: violations.length === 0, violations });
    const people = this.users.filter((u) => u.type === 'person');
    const dogs = this.users.filter((u) => u.type === 'dog');

    add('Every user is on a path, lawn or bench', this.users
      .filter((u) => !this.locate(u.position))
      .map((u) => `${u.name} is off the grounds`));

    add('Walking users are on a path', this.users
      .filter((u) => u.activity === 'walking' && u.locationType !== 'path')
      .map((u) => `${u.name} is walking off-path`));

    add('People stand on a lawn and sit on a lawn or bench', people
      .filter((u) => (u.activity === 'standing' && u.locationType !== 'lawn') ||
                     (u.activity === 'sitting' && u.locationType === 'path'))
      .map((u) => `${u.name} is ${u.activity} on ${this.locationName(u)}`));

    add(`Only people sit on benches, at most ${BENCH_SEATS} per bench`, [
      ...this.users.filter((u) => u.locationType === 'bench' && (u.type !== 'person' || u.activity !== 'sitting'))
        .map((u) => `${u.name} is on ${this.locationName(u)}`),
      ...this.benches.filter((b) => this.usersOnBench(b.id).length > b.seats)
        .map((b) => `${b.name}: ${this.usersOnBench(b.id).length}/${b.seats}`),
    ]);

    add('Users are only on open lawns', this.lawns
      .filter((l) => l.status !== 'open' && this.usersOnLawn(l.id).length)
      .map((l) => `${l.name} is closed but occupied`));

    add(`Users per lawn ≤ area ÷ ${SQFT_PER_USER} ft²`, this.lawns
      .filter((l) => this.usersOnLawn(l.id).length > l.capacity)
      .map((l) => `${l.name}: ${this.usersOnLawn(l.id).length}/${l.capacity}`));

    add(`Leashed dogs stay within ${LEASH_LENGTH} ft of their owner`, dogs
      .filter((d) => d.leashed)
      .filter((d) => {
        const o = this.owner(d);
        return !o || Math.hypot(o.position.x - d.position.x, o.position.y - d.position.y) > LEASH_LENGTH;
      })
      .map((d) => `${d.name} has wandered off`));

    add('Unleashed dogs are on a lawn with their owner', dogs
      .filter((d) => !d.leashed)
      .filter((d) => {
        const o = this.owner(d);
        return d.locationType !== 'lawn' || !o || o.locationType !== 'lawn' || o.locationId !== d.locationId;
      })
      .map((d) => `${d.name} is loose`));

    add('Only unleashed dogs play', this.users
      .filter((u) => u.activity === 'playing' && (u.type !== 'dog' || u.leashed))
      .map((u) => `${u.name} is playing on the leash`));

    add('Lawns, paths and benches do not overlap', this.staticChecks.overlaps);
    add('Every lawn and bench borders a path', this.staticChecks.unbordered);
    add(`Path width ≥ ${MIN_PATH_WIDTH} ft`, this.staticChecks.narrow);

    add(`Grass height between ${GRASS_MIN}″ and ${GRASS_MAX}″`, this.lawns
      .filter((l) => l.grassHeight < GRASS_MIN || l.grassHeight > GRASS_MAX)
      .map((l) => `${l.name} is ${l.grassHeight.toFixed(1)}″`));

    return results;
  }
}
