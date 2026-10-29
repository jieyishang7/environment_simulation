// three.js rendering of the park model on the Central Park map.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as G from './geometry.js?v=4';
import { GRASS_MIN, GRASS_MAX } from './model.js?v=4';

export const ACTIVITY_COLORS = {
  walking: '#2f74e0',
  standing: '#f08c00',
  sitting: '#a23cc4',
  playing: '#e0457b',
};
export const GRASS_SHORT = '#c4ec8a';
export const GRASS_TALL = '#1d5418';

const LAWN_TOP = 0.3;
const PATH_TOP = 0.15;
const BENCH_SEAT = 1.5;
const SHORT = new THREE.Color(GRASS_SHORT);
const TALL = new THREE.Color(GRASS_TALL);

export function grassColor(h) {
  const f = Math.max(0, Math.min(1, (h - GRASS_MIN) / (GRASS_MAX - GRASS_MIN)));
  return new THREE.Color().lerpColors(SHORT, TALL, f);
}

// Model (x, y) on the ground maps to three.js (x, height, -y), so +y is "north".
const v3 = (p, h = 0) => new THREE.Vector3(p.x, h, -p.y);

function shapeOf(poly) {
  return new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x, p.y)));
}

function flatGeometry(poly, depth) {
  const g = new THREE.ExtrudeGeometry(shapeOf(poly), { depth, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  return g;
}

function outline(poly, y, material) {
  const pts = poly.map((p) => v3(p, y));
  pts.push(pts[0].clone());
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), material);
  line.computeLineDistances();
  return line;
}

// Flat ribbons along polylines (paths, streets), as one merged geometry.
// faceOwner[i] is the index of the line that triangle i belongs to.
function ribbonGeometry(lines, y, widthOf) {
  const pos = [];
  const faceOwner = [];
  lines.forEach((line, k) => {
    const pts = line.points;
    const hw = widthOf(line) / 2;
    const tri = (a, b, c) => {
      pos.push(a.x, y, -a.y, b.x, y, -b.y, c.x, y, -c.y);
      faceOwner.push(k);
    };
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-6) continue;
      const nx = (-(b.y - a.y) / len) * hw, ny = ((b.x - a.x) / len) * hw;
      const a1 = { x: a.x + nx, y: a.y + ny }, a2 = { x: a.x - nx, y: a.y - ny };
      const b1 = { x: b.x + nx, y: b.y + ny }, b2 = { x: b.x - nx, y: b.y - ny };
      tri(a2, b2, b1);
      tri(a2, b1, a1);
    }
    // Round joints so bends and junctions have no notches.
    for (let i = 0; i < pts.length; i++) {
      if (pts.length === 2 && hw < 6) break;
      const c = pts[i];
      const n = 8;
      for (let j = 0; j < n; j++) {
        const t0 = (j / n) * Math.PI * 2, t1 = ((j + 1) / n) * Math.PI * 2;
        tri(c, { x: c.x + Math.cos(t0) * hw, y: c.y + Math.sin(t0) * hw }, { x: c.x + Math.cos(t1) * hw, y: c.y + Math.sin(t1) * hw });
      }
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return { geometry: g, faceOwner };
}

// Ground cover is nearly coplanar, which z-fights from far away. Instead of
// relying on depth, these layers skip depth writes and paint in `order`
// (higher on top) before everything that stands on them.
const GROUND_HEIGHT = 0.12;
function groundLayer(scene, geometry, color, order, extra = {}) {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 1, depthWrite: false, ...extra }));
  mesh.position.y = (order / 10) * GROUND_HEIGHT;
  mesh.renderOrder = order - 20;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

// Flat fills for many polygons merged into one geometry.
function fillGeometry(polys, y) {
  const parts = polys.filter((p) => p.length >= 3).map((p) => {
    const g = new THREE.ShapeGeometry(shapeOf(p)).rotateX(-Math.PI / 2);
    g.translate(0, y, 0);
    return g;
  });
  return mergeGeometries(parts);
}

// Extruded building footprints (walls and flat roofs) in one geometry.
function buildingGeometry(buildings) {
  const pos = [];
  const col = [];
  const base = new THREE.Color('#e9e4da');
  const c = new THREE.Color();
  buildings.forEach((b, k) => {
    const pts = G.toCCW(b.points);
    const h = Math.max(12, b.height);
    c.copy(base).offsetHSL(0, 0, ((k * 37) % 11 - 5) / 120);
    const push = (p, y) => { pos.push(p.x, y, -p.y); col.push(c.r, c.g, c.b); };
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], d = pts[(i + 1) % pts.length];
      push(a, 0); push(d, 0); push(d, h);
      push(a, 0); push(d, h); push(a, h);
    }
    const tris = THREE.ShapeUtils.triangulateShape(pts.map((p) => new THREE.Vector2(p.x, p.y)), []);
    for (const [i, j, m] of tris) { push(pts[i], h); push(pts[j], h); push(pts[m], h); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

// The two distance metrics (and the paths-only reference) keep these colors in
// the 3D view and in every chart: categorical slots 1-3 of the chart palette.
export const METRIC_COLORS = {
  straight: '#2a78d6',
  foot: '#eb6834',
  paths: '#1baf7a',
};

// A dashed flat line from a to b.
function dashedGeometry(a, b, y, w, dash, gap) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const lines = [];
  for (let s = 0; s < len; s += dash + gap) {
    const e = Math.min(len, s + dash);
    const at = (t) => ({ x: a.x + ((b.x - a.x) * t) / len, y: a.y + ((b.y - a.y) * t) / len });
    lines.push({ points: [at(s), at(e)] });
  }
  return ribbonGeometry(lines, y, () => w).geometry;
}

// Color for v on a ramp of hex stops spread evenly over [lo, hi].
export function rampColor(ramp, lo, hi, v) {
  const f = Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(f));
  return new THREE.Color(ramp[i]).lerp(new THREE.Color(ramp[i + 1]), f - i);
}

// The path network colored per node: field = {nodes, edges, widths, values,
// ramp, domain}. A node with a non-finite value hides its edges.
function fieldGeometry(field, y, s) {
  const pos = [];
  const col = [];
  const { nodes, edges, values, ramp, domain } = field;
  const colors = Array.from(values, (v) => (Number.isFinite(v) ? rampColor(ramp, domain[0], domain[1], v) : null));
  for (let k = 0; k < edges.length; k++) {
    const [i, j] = edges[k];
    const ci = colors[i], cj = colors[j];
    if (!ci || !cj) continue;
    const a = nodes[i], b = nodes[j];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const hw = Math.max(field.widths[k] * 0.5, 1.1 * s);
    const nx = (-(b.y - a.y) / len) * hw, ny = ((b.x - a.x) / len) * hw;
    const quad = [[a, ci, 1], [b, cj, 1], [b, cj, -1], [a, ci, 1], [b, cj, -1], [a, ci, -1]];
    for (const [p, c, side] of quad) {
      pos.push(p.x + nx * side, y, -(p.y + ny * side));
      col.push(c.r, c.g, c.b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

function hatchTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.strokeStyle = 'rgba(190, 40, 40, 0.75)';
  ctx.lineWidth = 9;
  for (let k = -64; k <= 128; k += 32) {
    ctx.beginPath();
    ctx.moveTo(k, 0);
    ctx.lineTo(k + 64, 64);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / 4, 1 / 4);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function label(className) {
  const div = document.createElement('div');
  div.className = className;
  return { div, obj: new CSS2DObject(div) };
}

export class ParkView {
  constructor(container, park) {
    this.park = park;
    this.container = container;
    this.selection = null;
    this.animations = new Map();
    this.clock = new THREE.Clock();

    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const labels = new CSS2DRenderer();
    labels.domElement.className = 'labels-layer';
    container.appendChild(labels.domElement);
    this.labelRenderer = labels;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#dde9e4');
    scene.fog = new THREE.Fog('#dde9e4', 9000, 26000);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 40000);
    this.camera = camera;

    // Start looking at the visitors by the Great Lawn. Narrow screens put the
    // inspector below the map; wide ones to its right.
    const controls = new OrbitControls(camera, renderer.domElement);
    const f = park.focus;
    if (container.clientWidth < 760) {
      camera.position.set(f.x, 260, -f.y + 190);
      controls.target.set(f.x, 0, -f.y + 10);
    } else {
      camera.position.set(f.x + 10, 105, -f.y + 135);
      controls.target.set(f.x + 25, 0, -f.y - 10);
    }
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.47;
    controls.minDistance = 12;
    controls.maxDistance = 18000;
    controls.zoomSpeed = 1.4;
    this.controls = controls;

    scene.add(new THREE.HemisphereLight('#ffffff', '#6f8f58', 1.1));
    // The sun and its shadow box follow the camera target, so shadows stay
    // crisp wherever you are in the park.
    const sun = new THREE.DirectionalLight('#fff6e5', 1.9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -160, right: 160, top: 160, bottom: -160, near: 10, far: 600 });
    sun.shadow.bias = -0.0005;
    scene.add(sun, sun.target);
    this.sun = sun;

    this.buildGround();
    this.buildCity();
    this.buildPaths();
    this.buildLawns();
    this.buildTrees();
    this.buildBenches();

    this.userGroup = new THREE.Group();
    scene.add(this.userGroup);
    this.userViews = new Map();
    this.userGeo = {
      stand: new THREE.CapsuleGeometry(0.75, 2.6, 4, 12),
      sit: new THREE.CapsuleGeometry(0.8, 0.9, 4, 12),
      head: new THREE.SphereGeometry(0.62, 16, 12),
      ring: new THREE.RingGeometry(1.35, 1.75, 32).rotateX(-Math.PI / 2),
      blanket: new THREE.BoxGeometry(2.6, 0.06, 2.6),
    };
    this.userMats = Object.fromEntries(Object.entries(ACTIVITY_COLORS)
      .map(([k, c]) => [k, new THREE.MeshStandardMaterial({ color: c, roughness: 0.55 })]));
    this.headMat = new THREE.MeshStandardMaterial({ color: '#f1c9a5', roughness: 0.7 });
    this.ringMat = new THREE.MeshBasicMaterial({ color: '#ffd43b', side: THREE.DoubleSide });
    this.blanketMat = new THREE.MeshStandardMaterial({ color: '#e8e1cf', roughness: 0.9 });

    this.dogGeo = {
      body: new THREE.CapsuleGeometry(0.42, 1.2, 4, 10),
      leg: new THREE.CylinderGeometry(0.1, 0.09, 0.9, 6),
      head: new THREE.SphereGeometry(0.38, 14, 10),
      snout: new THREE.BoxGeometry(0.42, 0.26, 0.3),
      nose: new THREE.SphereGeometry(0.08, 8, 6),
      ear: new THREE.BoxGeometry(0.12, 0.34, 0.16),
      tail: new THREE.CylinderGeometry(0.05, 0.08, 0.8, 6),
      collar: new THREE.TorusGeometry(0.34, 0.07, 6, 16),
      disk: new THREE.CircleGeometry(1.3, 24).rotateX(-Math.PI / 2),
    };
    this.dogFurs = ['#b07a45', '#3b3029', '#d9b98c', '#8c6b5a', '#f0e6d6']
      .map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 }));
    this.dogNoseMat = new THREE.MeshStandardMaterial({ color: '#2b211c', roughness: 0.6 });
    this.diskMats = Object.fromEntries(Object.entries(ACTIVITY_COLORS)
      .map(([k, c]) => [k, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.45, depthWrite: false })]));
    this.leashMat = new THREE.LineBasicMaterial({ color: '#c92a2a' });
    this.leashGroup = new THREE.Group();
    scene.add(this.leashGroup);
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), new THREE.MeshStandardMaterial({ color: '#d8f03c', roughness: 0.6 }));
    this.ball.castShadow = true;
    this.ball.visible = false;
    scene.add(this.ball);
    this.fetchAnim = null;

    this.buildDistanceLayer();
    this.raycaster = new THREE.Raycaster();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.sync();
    renderer.setAnimationLoop(() => this.frame());
  }

  // ---- static scenery --------------------------------------------------

  buildGround() {
    const map = this.park.map;
    // City blocks (pavement), then the park and what grows in it.
    groundLayer(this.scene, new THREE.CircleGeometry(30000, 64).rotateX(-Math.PI / 2), '#d6d2ca', 0);
    groundLayer(this.scene, fillGeometry([map.park.points], 0), '#b7cf98', 2);
    groundLayer(this.scene, fillGeometry(map.grass.map((g) => g.points), 0), '#9fcd78', 3);
    groundLayer(this.scene, fillGeometry(map.woods.map((w) => w.points), 0), '#6f9a55', 4);
    groundLayer(this.scene, fillGeometry(map.water.map((w) => w.points), 0), '#5fa8d3', 5,
      { roughness: 0.2, metalness: 0.1 });
    for (const w of map.water) {
      if (!w.name || G.polygonArea(w.points) < 20000) continue;
      const { div, obj } = label('place-label water-label');
      div.textContent = w.name;
      obj.position.copy(v3(G.centroid(w.points), 2));
      this.scene.add(obj);
    }
  }

  // Streets of the Manhattan grid and the buildings that line the park.
  buildCity() {
    const map = this.park.map;
    groundLayer(this.scene, ribbonGeometry(map.streets, 0, (s) => s.width).geometry, '#8d9096', 1);
    groundLayer(this.scene, ribbonGeometry(map.transverses, 0, (s) => s.width).geometry, '#7b7e84', 6);

    const buildings = new THREE.Mesh(buildingGeometry(map.buildings),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
    buildings.castShadow = true;
    buildings.receiveShadow = true;
    this.scene.add(buildings);

    // One label per street name, at the point nearest the park.
    const park = map.park.points;
    const best = new Map();
    for (const st of map.streets) {
      if (!st.name) continue;
      for (const p of st.points) {
        if (G.pointInPolygon(p, park)) continue;
        const d = G.nearestOnBoundary(p, park).dist;
        if (d < 40) continue;
        if (!best.has(st.name) || d < best.get(st.name).d) best.set(st.name, { d, p });
      }
    }
    this.streetLabels = [];
    for (const [name, { d, p }] of best) {
      if (d > 450) continue;
      const { div, obj } = label('place-label street-label');
      div.textContent = name;
      obj.position.copy(v3(p, 3));
      this.scene.add(obj);
      this.streetLabels.push(obj);
    }
  }

  buildPaths() {
    const paths = this.park.paths;
    const { geometry, faceOwner } = ribbonGeometry(paths, 0, (p) => p.width);
    const mesh = groundLayer(this.scene, geometry, '#e7dcc4', 7);
    mesh.position.y = PATH_TOP;
    mesh.userData = { kind: 'path' };
    this.pathMesh = mesh;
    this.pathFaceOwner = faceOwner;

    // The selected path gets a highlight ribbon and a label.
    this.pathSel = new THREE.Mesh(new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: '#ffd43b', transparent: true, opacity: 0.55, depthWrite: false }));
    this.pathSel.renderOrder = 3;
    this.scene.add(this.pathSel);
    const { div, obj } = label('path-label selected');
    this.pathLabel = { div, obj };
    this.scene.add(obj);
    this.shownPath = null;
  }

  buildLawns() {
    this.lawnViews = new Map();
    const hatch = hatchTexture();
    const tuftGeo = new THREE.ConeGeometry(0.32, 1, 5).translate(0, 0.5, 0);
    const postGeo = new THREE.BoxGeometry(0.28, 3, 0.28).translate(0, 1.5, 0);
    const woodMat = new THREE.MeshStandardMaterial({ color: '#8a5a33', roughness: 0.8 });

    for (const lawn of this.park.lawns) {
      const group = new THREE.Group();
      this.scene.add(group);

      const mat = new THREE.MeshStandardMaterial({ color: grassColor(lawn.grassHeight), roughness: 0.9 });
      const mesh = new THREE.Mesh(flatGeometry(lawn.boundary, LAWN_TOP), mat);
      mesh.receiveShadow = true;
      mesh.userData = { kind: 'lawn', id: lawn.id };
      group.add(mesh);

      // Grass tufts whose height tracks the lawn's grass height.
      const count = Math.min(4000, Math.round(lawn.area / 2.2));
      const tuftMat = new THREE.MeshStandardMaterial({ color: grassColor(lawn.grassHeight), roughness: 0.85 });
      const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, count);
      tufts.castShadow = false;
      tufts.receiveShadow = true;
      const tuftData = [];
      const rng = mulberry([...lawn.id].reduce((h, ch) => h * 31 + ch.charCodeAt(0), 7));
      for (let i = 0; i < count; i++) {
        tuftData.push({
          p: G.randomPointInPolygon(lawn.boundary, 0.35, rng),
          s: 0.65 + rng() * 0.7,
          r: rng() * Math.PI,
        });
      }
      group.add(tufts);

      // Hatching and a fence show a closed lawn.
      const hatchMesh = new THREE.Mesh(
        new THREE.ShapeGeometry(shapeOf(lawn.boundary)).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ map: hatch, transparent: true, depthWrite: false, opacity: 0.85 }),
      );
      hatchMesh.position.y = LAWN_TOP + 0.04;
      hatchMesh.renderOrder = 2;
      group.add(hatchMesh);
      const fence = this.buildFence(lawn.boundary, postGeo, woodMat);
      group.add(fence);

      // Dashed amber outline marks a lawn that needs mowing.
      const mowLine = outline(lawn.boundary, LAWN_TOP + 0.08,
        new THREE.LineDashedMaterial({ color: '#ff8c00', dashSize: 1.4, gapSize: 0.8, transparent: true }));
      group.add(mowLine);
      const sel = outline(lawn.boundary, LAWN_TOP + 0.12, new THREE.LineBasicMaterial({ color: '#ffd43b' }));
      group.add(sel);

      const { div, obj } = label('lawn-label');
      const c = G.centroid(lawn.boundary);
      obj.position.copy(v3(c, 4));
      group.add(obj);

      this.lawnViews.set(lawn.id, {
        group, mesh, mat, tufts, tuftMat, tuftData, hatchMesh, fence, mowLine, sel, div, shownHeight: null,
      });
    }
  }

  buildFence(poly, postGeo, woodMat) {
    const fence = new THREE.Group();
    const posts = [];
    const rails = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(1, Math.ceil(len / 3));
      for (let k = 0; k < n; k++) posts.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
      for (const h of [1.1, 2.4]) rails.push({ a, b, len, h });
    }
    const m = new THREE.Matrix4();
    const inst = new THREE.InstancedMesh(postGeo, woodMat, posts.length);
    posts.forEach((p, i) => {
      m.makeTranslation(p.x, LAWN_TOP, -p.y);
      inst.setMatrixAt(i, m);
    });
    const railMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.18, 0.12), woodMat, rails.length);
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    rails.forEach(({ a, b, len, h }, i) => {
      q.setFromAxisAngle(up, Math.atan2(b.y - a.y, b.x - a.x));
      m.compose(v3({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, LAWN_TOP + h), q, new THREE.Vector3(len, 1, 1));
      railMesh.setMatrixAt(i, m);
    });
    inst.castShadow = railMesh.castShadow = true;
    fence.add(inst, railMesh);
    return fence;
  }

  // Trees fill the park's wooded areas.
  buildTrees() {
    const woods = this.park.map.woods;
    const rng = mulberry(1858);
    const spots = [];
    for (const w of woods) {
      const n = Math.min(400, Math.round(G.polygonArea(w.points) / 1400));
      for (let i = 0; i < n; i++) spots.push(G.randomPointInPolygon(w.points, 4, rng));
    }
    const trunkGeo = new THREE.CylinderGeometry(0.35, 0.5, 4, 6).translate(0, 2, 0);
    const crownGeo = new THREE.IcosahedronGeometry(2.6, 1).translate(0, 5.6, 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: '#6b4a2f' }), spots.length);
    const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: '#ffffff', flatShading: true }), spots.length);
    const greens = ['#3f7d3a', '#4f8f3f', '#2f6b35'].map((c) => new THREE.Color(c));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    spots.forEach((p, i) => {
      const k = 3 + rng() * 2.5;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI);
      m.compose(v3(p), q, new THREE.Vector3(k, k, k));
      trunks.setMatrixAt(i, m);
      crowns.setMatrixAt(i, m);
      crowns.setColorAt(i, greens[i % 3]);
    });
    trunks.castShadow = crowns.castShadow = true;
    this.scene.add(trunks, crowns);
  }

  buildBenches() {
    this.benchViews = new Map();
    const wood = new THREE.MeshStandardMaterial({ color: '#9c6b3f', roughness: 0.75 });
    const metal = new THREE.MeshStandardMaterial({ color: '#4a4f55', roughness: 0.4, metalness: 0.5 });
    const padMat = new THREE.MeshStandardMaterial({ color: '#cbbd9f', roughness: 1 });
    for (const b of this.park.benches) {
      const pad = new THREE.Mesh(flatGeometry(b.boundary, 0.1), padMat);
      pad.receiveShadow = true;
      pad.userData = { kind: 'bench', id: b.id };
      this.scene.add(pad);

      // Local x runs along the bench, local z across it.
      const g = new THREE.Group();
      const seat = new THREE.Mesh(new THREE.BoxGeometry(b.length, 0.18, 1.2), wood);
      seat.position.y = 1.4;
      const awayZ = Math.sign(b.u.y * b.facing.x - b.u.x * b.facing.y) || 1;
      const back = new THREE.Mesh(new THREE.BoxGeometry(b.length, 1.0, 0.14), wood);
      back.position.set(0, 2.1, -awayZ * 0.6);
      back.rotation.x = awayZ * 0.12;
      g.add(seat, back);
      for (const x of [-2.1, 2.1]) {
        for (const z of [-0.45, 0.45]) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.4, 0.16), metal);
          leg.position.set(x, 0.7, z);
          g.add(leg);
        }
      }
      g.traverse((m) => {
        if (m.isMesh) { m.castShadow = true; m.userData = { kind: 'bench', id: b.id }; }
      });
      g.position.copy(v3(b.center, 0.1));
      g.rotation.y = Math.atan2(b.u.y, b.u.x);
      this.scene.add(g);

      const sel = outline(b.boundary, 0.14, new THREE.LineBasicMaterial({ color: '#ffd43b' }));
      this.scene.add(sel);
      const { div, obj } = label('bench-label');
      obj.position.copy(v3(b.center, 0.4));
      this.scene.add(obj);
      this.benchViews.set(b.id, { group: g, pad, sel, div, obj });
    }
  }

  // ---- model -> view -----------------------------------------------------

  sync() {
    const park = this.park;
    for (const lawn of park.lawns) this.syncLawn(lawn);
    this.syncPathSelection();
    for (const bench of park.benches) {
      const bv = this.benchViews.get(bench.id);
      const sel = this.selection?.type === 'bench' && this.selection.id === bench.id;
      const n = park.usersOnBench(bench.id).length;
      bv.sel.visible = sel;
      bv.div.textContent = `${n}/${bench.seats}`;
      bv.div.classList.toggle('full', n >= bench.seats);
      bv.div.classList.toggle('selected', sel);
    }

    const live = new Set(park.users.map((u) => u.id));
    for (const [id, uv] of this.userViews) {
      if (!live.has(id)) {
        this.userGroup.remove(uv.group);
        uv.group.remove(uv.labelObj);
        if (uv.leash) this.leashGroup.remove(uv.leash);
        this.userViews.delete(id);
        this.animations.delete(id);
        if (this.fetchAnim?.dogId === id) this.endFetch();
      }
    }
    for (const user of park.users) this.syncUser(user);
  }

  syncPathSelection() {
    const id = this.selection?.type === 'path' ? this.selection.id : null;
    if (id === this.shownPath) return;
    this.shownPath = id;
    const path = id && this.park.path(id);
    this.pathSel.geometry.dispose();
    this.pathSel.geometry = path ? ribbonGeometry([path], PATH_TOP + 0.04, (p) => p.width + 0.6).geometry : new THREE.BufferGeometry();
    this.pathLabel.obj.visible = !!path;
    if (path) {
      this.pathLabel.div.textContent = path.name;
      this.pathLabel.obj.position.copy(v3(this.park.pathPoint(path, 0.5), 0.6));
    }
  }

  syncLawn(lawn) {
    const lv = this.lawnViews.get(lawn.id);
    const color = grassColor(lawn.grassHeight);
    lv.mat.color.copy(color);
    lv.tuftMat.color.copy(color).multiplyScalar(0.82);
    if (lv.shownHeight !== lawn.grassHeight) {
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0);
      const hFt = lawn.grassHeight / 12;
      lv.tuftData.forEach((t, i) => {
        q.setFromAxisAngle(up, t.r);
        m.compose(v3(t.p, LAWN_TOP - 0.02), q, new THREE.Vector3(1, hFt * t.s, 1));
        lv.tufts.setMatrixAt(i, m);
      });
      lv.tufts.instanceMatrix.needsUpdate = true;
      lv.shownHeight = lawn.grassHeight;
    }
    const closed = lawn.status === 'closed';
    lv.hatchMesh.visible = closed;
    lv.fence.visible = closed;
    const needs = this.park.needsMowing(lawn);
    lv.mowLine.visible = needs;
    const selected = this.selection?.type === 'lawn' && this.selection.id === lawn.id;
    lv.sel.visible = selected;
    lv.mat.emissive.set(selected ? '#3a3a10' : '#000000');

    const here = this.park.usersOnLawn(lawn.id);
    const dogs = here.filter((u) => u.type === 'dog').length;
    const people = here.length - dogs;
    lv.div.classList.toggle('selected', selected);
    lv.div.innerHTML = `
      <div class="ll-name">${lawn.name}</div>
      <div class="ll-stats">${lawn.grassHeight.toFixed(1)}″ grass · ${here.length}/${lawn.capacity} users</div>
      ${here.length ? `<div class="ll-stats">${people} ${people === 1 ? 'person' : 'people'}${dogs ? `, ${dogs} dog${dogs === 1 ? '' : 's'}` : ''}</div>` : ''}
      <div class="ll-badges">
        <span class="badge ${closed ? 'closed' : 'open'}">${closed ? 'Closed' : 'Open'}</span>
        ${needs ? '<span class="badge mow">✂ Needs mowing</span>' : ''}
      </div>`;
  }

  makePersonView(user) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(this.userGeo.stand, this.userMats[user.activity]);
    const head = new THREE.Mesh(this.userGeo.head, this.headMat);
    const ring = new THREE.Mesh(this.userGeo.ring, this.ringMat);
    const blanket = new THREE.Mesh(this.userGeo.blanket, this.blanketMat);
    body.castShadow = head.castShadow = true;
    blanket.receiveShadow = true;
    blanket.position.y = 0.05;
    ring.position.y = 0.08;
    for (const m of [body, head, blanket]) m.userData = { kind: 'user', id: user.id };
    group.add(body, head, ring, blanket);
    return { group, body, head, ring, blanket };
  }

  // A dog faces local +x. `pose` tilts when the dog sits; the disk under it
  // shows its activity color.
  makeDogView(user) {
    const g = this.dogGeo;
    const fur = this.dogFurs[user.id % this.dogFurs.length];
    const group = new THREE.Group();
    const pose = new THREE.Group();
    const add = (geo, mat, x, y, z, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.z = rz;
      m.castShadow = true;
      m.userData = { kind: 'user', id: user.id };
      pose.add(m);
      return m;
    };
    add(g.body, fur, 0, 1.15, 0, Math.PI / 2);
    for (const x of [-0.5, 0.5]) for (const z of [-0.24, 0.24]) add(g.leg, fur, x, 0.45, z);
    add(g.head, fur, 1.05, 1.62, 0);
    add(g.snout, fur, 1.42, 1.52, 0);
    add(g.nose, this.dogNoseMat, 1.63, 1.56, 0);
    add(g.ear, this.dogNoseMat, 0.95, 1.9, 0.24, 0.3);
    add(g.ear, this.dogNoseMat, 0.95, 1.9, -0.24, 0.3);
    add(g.tail, fur, -0.95, 1.5, 0, 0.9);
    const collar = add(g.collar, this.userMats[user.activity], 0.72, 1.45, 0, Math.PI / 2);
    collar.rotation.set(0, 0, Math.PI / 2 - 0.35);
    group.add(pose);
    const disk = new THREE.Mesh(g.disk, this.diskMats[user.activity]);
    disk.position.y = 0.04;
    disk.userData = { kind: 'user', id: user.id };
    const ring = new THREE.Mesh(this.userGeo.ring, this.ringMat);
    ring.scale.setScalar(0.9);
    ring.position.y = 0.08;
    group.add(disk, ring);

    const leash = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), this.leashMat);
    leash.frustumCulled = false;
    this.leashGroup.add(leash);
    return { group, pose, collar, disk, ring, leash, heading: 0 };
  }

  syncUser(user) {
    let uv = this.userViews.get(user.id);
    if (!uv) {
      uv = user.type === 'dog' ? this.makeDogView(user) : this.makePersonView(user);
      const { div, obj } = label('user-label');
      Object.assign(uv, { type: user.type, div, labelObj: obj, activity: null, phase: Math.random() * 6 });
      uv.group.add(obj);
      this.userGroup.add(uv.group);
      uv.group.position.copy(v3(user.position, this.surfaceHeight(user)));
      this.userViews.set(user.id, uv);
    }
    const sitting = user.activity === 'sitting';
    if (uv.activity !== user.activity) {
      if (uv.type === 'dog') {
        uv.collar.material = this.userMats[user.activity];
        uv.disk.material = this.diskMats[user.activity];
        uv.pose.rotation.z = sitting ? 0.5 : 0;
        uv.labelObj.position.y = 3.2;
      } else {
        uv.body.geometry = sitting ? this.userGeo.sit : this.userGeo.stand;
        uv.body.material = this.userMats[user.activity];
        uv.body.position.y = sitting ? 1.25 : 2.05;
        uv.head.position.y = sitting ? 2.85 : 4.6;
        uv.labelObj.position.y = sitting ? 4.3 : 6.1;
      }
      uv.activity = user.activity;
    }
    if (uv.type === 'person') uv.blanket.visible = sitting && user.locationType === 'lawn';
    else {
      uv.leashed = user.leashed;
      uv.ownerId = user.ownerId;
      uv.leash.visible = user.leashed;
    }
    const selected = this.selection?.type === 'user' && this.selection.id === user.id;
    uv.ring.visible = selected;
    uv.labelObj.visible = selected;
    uv.div.textContent = user.type === 'dog'
      ? `🐕 ${user.name} · ${user.activity} · ${user.leashed ? 'leashed' : 'off leash'}`
      : `${user.name} · ${user.activity}`;
    uv.div.style.borderColor = ACTIVITY_COLORS[user.activity];
    // Tween to the model position unless already heading there.
    const target = v3(user.position, this.surfaceHeight(user));
    const anim = this.animations.get(user.id);
    const heading = anim ? anim.points[anim.points.length - 1] : uv.group.position;
    if (heading.distanceTo(target) > 0.01) {
      this.animations.set(user.id, { points: [uv.group.position.clone(), target], start: performance.now(), duration: 450 });
    }
  }

  surfaceHeight(user) {
    if (user.locationType === 'bench') return BENCH_SEAT;
    return user.locationType === 'lawn' ? LAWN_TOP : PATH_TOP;
  }

  // Animate users along the waypoints returned by Park.advanceTime().
  animateTrails(trails, duration = 700) {
    const now = performance.now();
    for (const [id, trail] of trails) {
      const uv = this.userViews.get(id);
      const user = this.park.user(id);
      if (!uv || !user) continue;
      const h = this.surfaceHeight(user);
      const pts = [uv.group.position.clone(), ...trail.slice(1).map((p) => v3(p, h))];
      this.animations.set(id, { points: pts, start: now, duration });
    }
  }

  // The ball flies from the owner to where it lands; the dog runs out for it
  // and carries it back.
  animateFetch(dogId, run, ball) {
    const dog = this.park.user(dogId);
    const owner = dog && this.park.owner(dog);
    const uv = this.userViews.get(dogId);
    const ov = owner && this.userViews.get(owner.id);
    if (!uv || !ov) return;
    const now = performance.now();
    const duration = 2200;
    this.animations.set(dogId, {
      points: [uv.group.position.clone(), v3(ball, LAWN_TOP), v3(run[2], LAWN_TOP)],
      start: now + 350,
      duration: duration - 350,
    });
    this.fetchAnim = {
      dogId, start: now, duration, caught: false,
      from: ov.group.position.clone().setY(LAWN_TOP + 3.5),
      to: v3(ball, LAWN_TOP + 0.3),
    };
    this.ball.visible = true;
  }

  endFetch() {
    this.fetchAnim = null;
    this.ball.visible = false;
  }

  // ---- interaction ---------------------------------------------------------

  pick(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const userHits = this.raycaster.intersectObjects(this.userGroup.children, true)
      .filter((h) => h.object.userData.kind === 'user');
    if (userHits.length) return { type: 'user', id: userHits[0].object.userData.id };
    const surfaces = [
      ...[...this.benchViews.values()].flatMap((v) => [v.pad, ...v.group.children]),
      ...[...this.lawnViews.values()].map((v) => v.mesh),
      this.pathMesh,
    ];
    const hit = this.raycaster.intersectObjects(surfaces, false)[0];
    if (hit?.object === this.pathMesh) return { type: 'path', id: this.park.paths[this.pathFaceOwner[hit.faceIndex]].id };
    if (hit) return { type: hit.object.userData.kind, id: hit.object.userData.id };
    return null;
  }

  // Model point on the ground under the cursor.
  groundPoint(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return null;
    return { x: hit.x, y: -hit.z };
  }

  // ---- distances -------------------------------------------------------

  buildDistanceLayer() {
    this.distGroup = new THREE.Group();
    this.scene.add(this.distGroup);
    this.distShown = null;
    this.distScale = 1;
    const flat = (color, opacity = 0.95) => new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    });
    this.distMats = {
      straight: flat(METRIC_COLORS.straight),
      foot: flat(METRIC_COLORS.foot),
      paths: flat(METRIC_COLORS.paths, 0.85),
      gate: flat('#0b0b0b', 0.75),
      origin: flat('#0b0b0b', 0.9),
      field: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.92, depthWrite: false, depthTest: false, side: THREE.DoubleSide }),
    };
  }

  // d: { analysis, show: {line, foot, paths, labels}, gates, field } from main.js,
  // or null to clear.
  showDistance(d) {
    this.distShown = d;
    this.renderDistance();
  }

  renderDistance() {
    const group = this.distGroup;
    for (const c of [...group.children]) {
      group.remove(c);
      c.geometry?.dispose();
    }
    const d = this.distShown;
    if (!d) return;
    const s = this.distScale;
    const add = (geometry, mat, order) => {
      const m = new THREE.Mesh(geometry, mat);
      m.renderOrder = order;
      group.add(m);
      return m;
    };
    const ribbon = (points, y, w) => ribbonGeometry([{ points }], y, () => w).geometry;

    if (d.field) add(fieldGeometry(d.field, 0.6, s), this.distMats.field, 20);

    // Every gate, as a dark dot where a path leaves the park.
    const dot = new THREE.CircleGeometry(2.6 * s, 20).rotateX(-Math.PI / 2);
    const dots = d.gates.map((g) => dot.clone().translate(g.point.x, 0.8, -g.point.y));
    if (dots.length) add(mergeGeometries(dots), this.distMats.gate, 21);
    dot.dispose();

    for (const leg of d.legs) {
      if (leg.paths?.length > 1) add(ribbon(leg.paths, 0.9, 2.4 * s), this.distMats.paths, 22);
      if (leg.line) add(dashedGeometry(leg.line[0], leg.line[1], 1.0, 2.2 * s, 12 * s, 8 * s), this.distMats.straight, 23);
      if (leg.foot?.length > 1) add(ribbon(leg.foot, 1.1, 3.4 * s), this.distMats.foot, 24);
    }
    const ring = new THREE.RingGeometry(3.5 * s, 5.2 * s, 28).rotateX(-Math.PI / 2);
    add(ring.translate(d.origin.x, 1.2, -d.origin.y), this.distMats.origin, 25);

    for (const l of d.labels) {
      const { div, obj } = label(`dist-label ${l.cls || ''}`);
      div.innerHTML = l.html;
      if (l.color) div.style.setProperty('--c', l.color);
      obj.position.copy(v3(l.point, 3));
      group.add(obj);
    }
  }

  // Moves the camera so all `points` (model coordinates) are in view, keeping
  // the current viewing direction.
  fitTo(points) {
    if (!points.length) return;
    const b = G.bbox(points);
    const c = new THREE.Vector3((b.minX + b.maxX) / 2, 0, -(b.minY + b.maxY) / 2);
    const size = Math.max(b.maxX - b.minX, b.maxY - b.minY, 120);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    // Keep it fairly top-down so the route isn't hidden behind trees.
    dir.y = Math.max(dir.y, 0.75);
    dir.normalize();
    const dist = (size / 2) / Math.tan((this.camera.fov * Math.PI) / 360) * 1.55;
    // The side panel covers the right of the screen: shift the target right.
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    const shift = this.container.clientWidth > 760 ? size * 0.22 : 0;
    this.controls.target.copy(c).addScaledVector(right, -shift);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
  }

  // Model point the camera is looking at.
  focusPoint() {
    const t = this.controls.target;
    return { x: t.x, y: -t.z };
  }

  // ---- loop ------------------------------------------------------------

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
  }

  frame() {
    const now = performance.now();
    const t = this.clock.getElapsedTime();
    for (const [id, a] of this.animations) {
      const uv = this.userViews.get(id);
      if (!uv) continue;
      const f = Math.max(0, Math.min(1, (now - a.start) / a.duration));
      const prev = uv.group.position.clone();
      uv.group.position.copy(pointAlong(a.points, easeInOut(f)));
      if (uv.type === 'dog') {
        const dx = uv.group.position.x - prev.x;
        const dz = uv.group.position.z - prev.z;
        if (dx * dx + dz * dz > 1e-4) uv.heading = Math.atan2(-dz, dx);
      }
      if (f >= 1) this.animations.delete(id);
    }
    for (const [id, uv] of this.userViews) {
      const moving = this.animations.has(id);
      if (uv.type === 'dog') {
        // Turn smoothly toward the direction of travel; trot or bounce.
        let d = uv.heading - uv.group.rotation.y;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        uv.group.rotation.y += d * 0.2;
        const hop = uv.activity === 'playing' ? Math.abs(Math.sin(t * 7 + uv.phase)) * 0.45
          : moving ? Math.abs(Math.sin(t * 16 + uv.phase)) * 0.12 : 0;
        uv.pose.position.y = hop;
        if (uv.leashed) this.updateLeash(uv);
      } else {
        // Walkers bob gently; everyone else breathes.
        const walking = moving && uv.activity === 'walking';
        uv.body.scale.y = 1 + Math.sin(t * (walking ? 14 : 2) + uv.phase) * (walking ? 0.04 : 0.012);
      }
      uv.ring.rotation.y = t;
    }
    this.updateBall(now);
    for (const lv of this.lawnViews.values()) {
      if (lv.mowLine.visible) lv.mowLine.material.opacity = 0.55 + 0.45 * Math.sin(t * 4);
    }
    this.controls.update();
    const target = this.controls.target;
    this.sun.position.set(target.x - 80, 180, target.z + 100);
    this.sun.target.position.copy(target);
    const far = this.camera.position.distanceTo(target);
    this.container.classList.toggle('zoomed-out', far > 1200);
    // Distance routes stay a readable width on screen as you zoom.
    const scale = Math.max(1, Math.min(30, far / 300));
    if (Math.abs(scale / this.distScale - 1) > 0.3) {
      this.distScale = scale;
      if (this.distShown) this.renderDistance();
    }
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }

  updateLeash(uv) {
    const ov = this.userViews.get(uv.ownerId);
    if (!ov) return;
    const collar = uv.collar.getWorldPosition(new THREE.Vector3());
    const hand = ov.group.position.clone();
    hand.y += ov.activity === 'sitting' ? 1.9 : 2.7;
    const pos = uv.leash.geometry.attributes.position;
    pos.setXYZ(0, collar.x, collar.y, collar.z);
    pos.setXYZ(1, hand.x, hand.y, hand.z);
    pos.needsUpdate = true;
  }

  updateBall(now) {
    const fa = this.fetchAnim;
    if (!fa) return;
    const f = (now - fa.start) / fa.duration;
    const uv = this.userViews.get(fa.dogId);
    if (f >= 1 || !uv) return this.endFetch();
    const flight = 0.3;
    if (f < flight) {
      const k = f / flight;
      this.ball.position.lerpVectors(fa.from, fa.to, k);
      this.ball.position.y += Math.sin(Math.PI * k) * 9;
      return;
    }
    if (!fa.caught && uv.group.position.distanceTo(fa.to) < 1.6) fa.caught = true;
    if (fa.caught) {
      uv.pose.localToWorld(this.ball.position.set(1.55, 1.35, 0));
    } else {
      this.ball.position.copy(fa.to);
    }
  }
}

function easeInOut(f) {
  return f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
}

function pointAlong(points, f) {
  if (points.length === 1) return points[0].clone();
  const lens = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = points[i].distanceTo(points[i - 1]);
    lens.push(d);
    total += d;
  }
  if (total < 1e-6) return points[points.length - 1].clone();
  let target = f * total;
  for (let i = 0; i < lens.length; i++) {
    if (target <= lens[i] || i === lens.length - 1) {
      const k = lens[i] > 0 ? Math.min(1, target / lens[i]) : 1;
      return points[i].clone().lerp(points[i + 1], k);
    }
    target -= lens[i];
  }
  return points[points.length - 1].clone();
}

function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
