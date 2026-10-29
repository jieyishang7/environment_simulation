// The Distance panel: picks an origin, a travel mode and (optionally) a second
// place, runs the distance model, and shows the answers in the 3D view
// (straight line vs route), as bars, as a comparison of all four modes, and as
// a scatter of every entrance and lawn (straight line on x, route on y).

import * as G from './geometry.js?v=5';
import { DETOUR_FLAG, MODES } from './distance.js?v=5';
import { METRIC_COLORS } from './view.js?v=5';

const C = METRIC_COLORS;
const TIME_RAMP = ['#fde3d4', '#f6b08f', '#eb6834', '#b8441a', '#7a2a0c'];
const DETOUR_RAMP = ['#ece9fb', '#b7aef0', '#6250d6', '#3d2fa6', '#231a66'];
const DETOUR_MAX = 3;

const ft = (d) => (Number.isFinite(d) ? `${Math.round(d).toLocaleString()} ft` : 'no route');
const mins = (s) => (Number.isFinite(s) ? (s < 90 ? `${Math.max(1, Math.round(s))} s` : `${(s / 60).toFixed(s < 600 ? 1 : 0)} min`) : '—');
const ratio = (x) => (x.straight > 1 ? x.len / x.straight : 1);
const ord = (k) => `${k}${[11, 12, 13].includes(k % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][k % 10] || 'th'}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const segLen = (segs, kind) => (segs || []).filter((s) => !kind || s.kind === kind)
  .reduce((a, s) => a + s.points.reduce((b, p, i) => (i ? b + Math.hypot(p.x - s.points[i - 1].x, p.y - s.points[i - 1].y) : b), 0), 0);

const ROUTE_NAME = { walk: 'On foot', run: 'Running', bike: 'By bike', drive: 'By car' };
const ENTRANCE_TITLE = { walk: 'Nearest exit', run: 'Nearest exit', bike: 'Nearest bike entrance', drive: 'Nearest car entrance' };
const ENTRANCE_WORD = { walk: 'gate', run: 'gate', bike: 'bike entrance', drive: 'car entrance' };

export class DistanceUI {
  constructor({ park, view, model, root, getSelection, onChange }) {
    Object.assign(this, { park, view, model, root, getSelection, onChange });
    this.a = null;        // origin picked with Measure (else the selection)
    this.b = null;        // second place
    this.picking = null;  // 'a' | 'b' | null
    this.mode = 'walk';
    this.active = 'gate'; // which answer the 3D view draws: gate | lawn | target
    this.overlay = 'off'; // 'off' | 'time' | 'detour'
    this.result = null;

    root.addEventListener('click', (e) => {
      const el = e.target.closest('[data-dist]');
      if (!el) return;
      const [cmd, arg, arg2] = el.dataset.dist.split(':');
      if (cmd === 'active') this.active = arg;
      if (cmd === 'overlay') this.overlay = arg;
      if (cmd === 'mode') {
        this.mode = arg;
        if (this.active === 'lawn' && (arg === 'bike' || arg === 'drive')) this.active = 'gate';
      }
      if (cmd === 'clear') { this.b = null; this.a = null; this.active = 'gate'; }
      if (cmd === 'measure') return this.startMeasure();
      if (cmd === 'fit') return this.fit();
      if (cmd === 'to') { this.b = { kind: arg, id: arg2 }; this.active = 'target'; }
      this.onChange();
    });
    root.addEventListener('pointermove', (e) => this.hover(e));
    root.addEventListener('pointerleave', () => this.hover(null));
  }

  // ---- picking ---------------------------------------------------------

  startMeasure() {
    this.picking = this.picking ? null : this.originRef() ? 'b' : 'a';
    this.onChange();
  }

  // A click on the map while measuring. Returns true if it was consumed.
  pick(sel, ground) {
    if (!this.picking) return false;
    let ref = null;
    if (sel?.type === 'user') ref = { kind: 'user', id: sel.id };
    else if (sel?.type === 'bench') ref = { kind: 'bench', id: sel.id };
    else if (ground) ref = { kind: 'point', point: ground };
    if (!ref) return true;
    if (this.picking === 'a') {
      this.a = ref;
      this.picking = 'b';
    } else {
      this.b = ref;
      this.picking = null;
      this.active = 'target';
    }
    this.onChange();
    return true;
  }

  // The selection changed by clicking: it becomes the origin.
  selectionChanged() {
    if (!this.picking) this.a = null;
  }

  escape() {
    const had = this.picking || this.a || this.b;
    this.picking = null;
    this.a = null;
    this.b = null;
    this.active = 'gate';
    return !!had;
  }

  originRef() {
    if (this.a) return this.a;
    const s = this.getSelection();
    return s ? { kind: s.type, id: s.id } : null;
  }

  resolve(ref) {
    if (!ref) return null;
    const { park, model } = this;
    if (ref.kind === 'user') {
      const u = park.user(ref.id);
      return u && { point: { ...u.position }, loc: { type: u.locationType, id: u.locationId }, name: u.name };
    }
    if (ref.kind === 'bench') {
      const b = park.bench(ref.id);
      return b && { point: { ...b.center }, loc: { type: 'bench', id: b.id }, name: b.name };
    }
    if (ref.kind === 'lawn') {
      const l = park.lawn(ref.id);
      return l && { point: G.pushInside(G.centroid(l.boundary), l.boundary, 5), loc: { type: 'lawn', id: l.id }, name: `middle of ${l.name}` };
    }
    if (ref.kind === 'path') {
      const p = park.path(ref.id);
      return p && { point: park.pathPoint(p, 0.5), loc: { type: 'path', id: p.id }, name: `middle of ${p.name}` };
    }
    if (ref.kind === 'gate') {
      const g = [...model.gates, ...model.bikeGates, ...model.carGates].find((x) => x.id === ref.id);
      return g && { point: { ...g.point }, loc: null, name: g.name };
    }
    const loc = park.locate(ref.point);
    const where = loc ? (loc.type === 'lawn' ? park.lawn(loc.id) : loc.type === 'bench' ? park.bench(loc.id) : park.path(loc.id)).name : null;
    return { point: { ...ref.point }, loc, name: where ? `a spot on ${where}` : 'a spot in the park' };
  }

  // ---- update ------------------------------------------------------------

  update() {
    const origin = this.resolve(this.originRef());
    const target = this.resolve(this.b);
    if (this.b && !target) this.b = null;
    if (this.active === 'target' && !target) this.active = 'gate';
    this.result = origin ? this.model.analyze(origin, target, this.mode) : null;
    if (this.result && this.active === 'lawn' && !this.result.lawn) this.active = 'gate';
    this.renderPanel();
    this.renderView();
    document.body.classList.toggle('measuring', !!this.picking);
    const btn = document.querySelector('[data-action="measure"]');
    if (btn) {
      btn.classList.toggle('active', !!this.picking);
      btn.querySelector('.label').textContent = this.picking ? (this.picking === 'a' ? 'Click place A' : 'Click place B') : 'Measure';
    }
  }

  // ---- 3D view -----------------------------------------------------------

  fit() {
    const d = this.view.distShown;
    if (!d) return;
    this.view.fitTo([d.origin, ...d.legs.flatMap((l) => [...(l.line || []), ...(l.route || []).flatMap((s) => s.points)])]);
  }

  renderView() {
    const r = this.result;
    if (!r) return this.view.showDistance(null);
    const legs = [];
    const labels = [{ point: r.origin.point, html: `<b>A</b> ${esc(r.origin.name)}`, cls: 'origin' }];
    const tag = (metric, text, value) => `<span class="dl-metric" style="--c:${C[metric]}">${text}</span> <b>${value}</b>`;
    const routeTag = (x) => tag('foot', ROUTE_NAME[r.mode], `${ft(x.len)} · ${mins(x.time)}`);
    if (this.active === 'target' && r.target) {
      const t = r.target;
      legs.push({ line: [r.origin.point, t.point], route: t.route, ref: t.refRoute });
      labels.push({ point: t.point, html: `<b>B</b> ${esc(t.name)}<br>${tag('straight', 'Straight', ft(t.straight))} · ${routeTag(t)}`, cls: 'target' });
    } else {
      const q = this.active === 'lawn' ? r.lawn : r.gate;
      const { line, route } = q;
      if (line) legs.push({ line: [r.origin.point, line.point] });
      if (route) legs.push({ route: route.route, ref: route.refRoute });
      const closed = (x) => (x.open === false ? ' <span class="badge closed">closed</span>' : '');
      if (line && route && line.id === route.id) {
        labels.push({ point: route.point, html: `${esc(route.name)}<br>${tag('straight', 'Straight', ft(line.straight))} · ${routeTag(route)}`, cls: 'target' });
      } else {
        if (line) labels.push({ point: line.point, html: `${esc(line.name)}${closed(line)}<br>${tag('straight', 'Nearest in a straight line', ft(line.straight))}`, cls: 'target' });
        if (route) labels.push({ point: route.point, html: `${esc(route.name)}<br>${tag('foot', `Quickest ${MODES[r.mode].verb}`, `${ft(route.len)} · ${mins(route.time)}`)}`, cls: 'target' });
      }
    }
    // The current mode's entrances; bike and car entrances get an icon too.
    const entrances = this.model.entrancesFor(r.mode);
    if (r.mode === 'bike' || r.mode === 'drive') {
      for (const g of entrances) labels.push({ point: g.point, html: MODES[r.mode].icon, cls: 'entrance' });
    }
    let field = null;
    if (this.overlay !== 'off') {
      const m = this.model;
      const o = r.origin.point;
      const at = m.nodes.map((p, i) => m.at(r.run, i));
      let values, ramp, domain;
      if (this.overlay === 'time') {
        values = at.map((a) => a.time / 60);
        ramp = TIME_RAMP;
        domain = [0, this.timeMax(values)];
      } else {
        values = m.nodes.map((p, i) => {
          const s = Math.hypot(p.x - o.x, p.y - o.y);
          return Number.isFinite(at[i].len) ? (s < 120 ? 1 : at[i].len / s) : NaN;
        });
        ramp = DETOUR_RAMP;
        domain = [1, DETOUR_MAX];
      }
      field = { nodes: m.nodes, edges: m.drawEdges, values, ramp, domain };
    }
    this.view.showDistance({ origin: r.origin.point, gates: entrances, legs, labels, field });
  }

  // Top of the travel-time color scale: the 90th percentile, in whole minutes.
  timeMax(values) {
    const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
    return Math.max(2, Math.ceil(xs[Math.floor(xs.length * 0.9)] || 2));
  }

  // ---- panel -------------------------------------------------------------

  renderPanel() {
    const r = this.result;
    const root = this.root;
    const modes = `<div class="segs modes">${Object.values(MODES).map((m) =>
      `<button class="seg ${this.mode === m.key ? 'on' : ''}" data-dist="mode:${m.key}" title="${m.label}: ${m.mph} mph"><span>${m.icon}</span> ${m.label}</button>`).join('')}</div>`;
    const measureBtn = `<button class="small" data-dist="measure">📏 ${this.picking ? 'Cancel' : this.b ? 'Measure to another place' : 'Measure to a place'}</button>`;
    if (!r) {
      root.innerHTML = `${modes}<p class="hint">${this.picking ? 'Click anywhere in the park, or on a person, to set <b>A</b>.'
        : 'Select a person, dog or bench to see how far they are from the nearest exit and the next open lawn, two ways: in a straight line and by route, walking, running, cycling or driving. Or press <b>Measure</b> and click two places.'}</p>
        <div class="dist-actions">${measureBtn}</div>`;
      return;
    }
    const cards = [this.entranceCard(r)];
    if (r.lawn) cards.push(this.lawnCard(r));
    if (r.target) cards.unshift(this.targetCard(r));
    root.innerHTML = `
      ${modes}
      <div class="dist-from"><span>From</span> <b>A · ${esc(r.origin.name)}</b>${this.a ? ' <button class="link" data-dist="clear">reset</button>' : ''}</div>
      ${this.picking === 'b' ? '<p class="hint picking">Click a person or any spot in the park to measure to it (<b>B</b>).</p>' : ''}
      <div class="dist-key">
        <span style="--c:${C.straight}">Straight line</span>
        <span style="--c:${C.foot}">${ROUTE_NAME[r.mode]} route${r.mode === 'bike' ? ' (faded: walking the bike)' : r.mode === 'drive' ? ' (faded: walking to and from the car)' : ' (paths + open lawns)'}</span>
        ${r.mode === 'walk' || r.mode === 'run' ? `<span style="--c:${C.paths}">Paths only</span>` : ''}
      </div>
      ${cards.join('')}
      ${this.compareCard(r)}
      <div class="dist-actions">${measureBtn}${this.b ? '<button class="small" data-dist="clear">Clear B</button>' : ''}</div>
      ${this.farClose(r)}
      ${this.scatter(r)}
      ${this.overlayControl(r)}`;
  }

  bars(rows) {
    rows = rows.filter(Boolean);
    const max = Math.max(1, ...rows.map((x) => (Number.isFinite(x.d) ? x.d : 0)));
    return `<div class="bars">${rows.map((x) => `
      <div class="bar-row">
        <span class="bar-label">${x.label}</span>
        <span class="bar-track"><span class="bar" style="width:${Number.isFinite(x.d) ? Math.max(1.5, (x.d / max) * 100) : 0}%;--c:${x.color}"></span></span>
        <span class="bar-value">${x.value ?? ft(x.d)}</span>
        ${x.sub ? `<span class="bar-sub">${x.sub}</span>` : ''}
      </div>`).join('')}</div>`;
  }

  routeRows(x, toLine, toRoute, extraSub = '') {
    const r = this.result;
    const walkish = r.mode === 'walk' || r.mode === 'run';
    const saved = walkish ? x.refLen - x.len : 0;
    return this.bars([
      { label: 'Straight line', d: toLine.straight, color: C.straight, sub: toLine.name ? `to ${esc(toLine.name)}${toLine.open === false ? ' (closed)' : ''}` : '' },
      { label: ROUTE_NAME[r.mode], d: toRoute.len, color: C.foot, sub: `${toRoute.name ? `to ${esc(toRoute.name)} · ` : ''}${mins(toRoute.time)} at ${MODES[r.mode].mph} mph${extraSub}` },
      walkish ? { label: 'Paths only', d: x.refLen, color: C.paths, sub: saved > 20 ? `+${ft(saved)} without the lawns` : 'same as with the lawns' } : null,
    ]);
  }

  modeNotes(route) {
    const r = this.result;
    const notes = [];
    if (r.mode === 'bike') {
      const pushed = segLen(route.route, 'walk');
      if (pushed > 30) notes.push(`${ft(pushed)} of it is walking the bike: cycling is only allowed on the park drives and bike lanes, not the footpaths.`);
    }
    if (r.mode === 'drive') {
      const walked = segLen(route.route, 'walk');
      notes.push(`Private cars are banned from the park drives, so they cross the park only on the 65th, 79th, 86th and 97th St transverses${walked > 30 ? `. ${ft(walked)} of this trip is walking to or from the car` : ''}.`);
    }
    return notes;
  }

  entranceCard(r) {
    const { line, route } = r.gate;
    if (!route) return '';
    const notes = [];
    const word = ENTRANCE_WORD[r.mode];
    if (line.id !== route.id) {
      notes.push(`<b>${esc(line.name)}</b> is the closest ${word} in a straight line (${ft(line.straight)}), but it is ${ft(line.len)} ${MODES[r.mode].verb}. <b>${esc(route.name)}</b> is quicker (${ft(route.len)}, ${mins(route.time)}).`);
    }
    if (ratio(route) >= DETOUR_FLAG) notes.push(`The route is ${ratio(route).toFixed(1)}× the straight line.`);
    if ((r.mode === 'walk' || r.mode === 'run') && route.refLen - route.len > 20) notes.push(`Cutting across open lawns saves ${ft(route.refLen - route.len)}.`);
    notes.push(...this.modeNotes(route));
    const rank = r.gates.slice().sort((a, b) => a.straight - b.straight).findIndex((y) => y.id === route.id) + 1;
    return this.cardShell('gate', `${ENTRANCE_TITLE[r.mode]} <small>${MODES[r.mode].icon} ${this.model.entrancesFor(r.mode).length} in the park</small>`,
      this.routeRows(route, line, route, ` · ${ord(rank)} closest by line`), notes);
  }

  lawnCard(r) {
    const { line, route } = r.lawn;
    if (!route) return '';
    const notes = [];
    if (line && !line.open) {
      notes.push(`<b>${esc(line.name)}</b> is the closest lawn in a straight line (${ft(line.straight)}), but it is <b>closed</b>, so the route goes on to <b>${esc(route.name)}</b> (${ft(route.len)}).`);
    } else if (r.lawn.lineOpen && r.lawn.lineOpen.id !== route.id) {
      const lo = r.lawn.lineOpen;
      notes.push(`<b>${esc(lo.name)}</b> is closest in a straight line (${ft(lo.straight)}), but <b>${esc(route.name)}</b> is quicker to reach (${ft(route.len)}).`);
    }
    if (route.refLen - route.len > 20) notes.push(`Cutting across open lawns saves ${ft(route.refLen - route.len)}.`);
    return this.cardShell('lawn', 'Next open lawn', this.routeRows(route, line, route), notes);
  }

  targetCard(r) {
    const t = r.target;
    const notes = [];
    if (ratio(t) >= DETOUR_FLAG) notes.push(`<b>Close as the crow flies, far ${MODES[r.mode].verb}.</b> The route is ${ratio(t).toFixed(1)}× the straight line.`);
    if ((r.mode === 'walk' || r.mode === 'run') && t.refLen - t.len > 20) notes.push(`Cutting across open lawns saves ${ft(t.refLen - t.len)}.`);
    notes.push(...this.modeNotes(t));
    return this.cardShell('target', `A → B · ${esc(t.name)}`, this.routeRows(t, { straight: t.straight }, { len: t.len, time: t.time }), notes);
  }

  cardShell(key, title, body, notes) {
    const on = this.active === key;
    return `<section class="dist-card ${on ? 'active' : ''}" data-dist="active:${key}">
      <h3><span>${title}</span>${on ? '<button class="link" data-dist="fit">zoom to route</button>' : ''}</h3>
      ${body}
      ${notes.length ? `<div class="dist-note">⚠ ${notes.join(' ')}</div>` : ''}
    </section>`;
  }

  // The same question answered by all four modes, by time.
  compareCard(r) {
    const rows = r.compare;
    const max = Math.max(1, ...rows.map((x) => (Number.isFinite(x.time) ? x.time : 0)));
    const fastest = rows.filter((x) => Number.isFinite(x.time)).sort((a, b) => a.time - b.time)[0];
    const q = r.target ? `A → B` : 'Leaving the park';
    return `<section class="dist-compare">
      <h3><span>${q}: every way</span><small>by time</small></h3>
      ${rows.map((x) => {
        const m = MODES[x.mode];
        return `<div class="cmp-row ${x.mode === r.mode ? 'on' : ''}" data-dist="mode:${x.mode}">
          <span class="cmp-label">${m.icon} ${m.label}</span>
          <span class="bar-track"><span class="bar" style="width:${Number.isFinite(x.time) ? Math.max(1.5, (x.time / max) * 100) : 0}%;--c:${x.mode === r.mode ? C.foot : '#898781'}"></span></span>
          <span class="bar-value">${mins(x.time)}${x === fastest ? ' <span class="fast">fastest</span>' : ''}</span>
          <span class="bar-sub">${ft(x.len)}${r.target ? '' : ` · to ${esc(x.to)}`}</span>
        </div>`;
      }).join('')}
      <p class="hint">Click a row to switch mode. Times include walking the bike, and getting into and out of the car (1 min each).</p>
    </section>`;
  }

  // Places that are near by one metric but far by the other: the biggest
  // detours, and the biggest jumps in rank between the two metrics.
  farClose(r) {
    const places = [...r.gates, ...r.lawns.filter((l) => l.open)].filter((x) => Number.isFinite(x.len));
    const rankOf = (k) => new Map(places.slice().sort((a, b) => a[k] - b[k]).map((x, i) => [x.id, i + 1]));
    const byLine = rankOf('straight'), byRoute = rankOf('time');
    const rows = places
      .filter((x) => x.straight > 60 && byLine.get(x.id) <= 12)
      .map((x) => ({ x, k: ratio(x), jump: byRoute.get(x.id) - byLine.get(x.id) }))
      .filter((y) => y.k >= DETOUR_FLAG || y.jump >= 3)
      .sort((a, b) => b.k - a.k)
      .slice(0, 4);
    const verb = MODES[r.mode].verb;
    if (!rows.length) {
      return `<section class="dist-far"><h3>Near by one metric, far by the other</h3>
        <p class="hint">From here, the closest places are about as close ${verb} as in a straight line. Try a spot across the Reservoir or the Lake, switch to driving, or close a lawn.</p></section>`;
    }
    const nth = (k) => (k === 1 ? 'the' : `the ${ord(k)}`);
    return `<section class="dist-far"><h3>Near by one metric, far by the other</h3><ul>
      ${rows.map(({ x, k }) => `<li data-dist="to:${x.kind === 'gate' ? 'gate' : 'lawn'}:${x.id}">
        <span class="ratio" title="route ÷ straight line">×${k.toFixed(1)}</span>
        <span><b>${esc(x.name)}</b> is ${nth(byLine.get(x.id))} closest in a straight line (${ft(x.straight)})
        but ${nth(byRoute.get(x.id))} ${verb} (${ft(x.len)}, ${mins(x.time)}).</span></li>`).join('')}
      </ul></section>`;
  }

  // Every entrance and lawn: straight line (x) against route length (y) on
  // equal scales, so the diagonal is "no detour" and anything above the
  // dashed line is at least 1.5x farther by route.
  scatter(r) {
    const pts = [
      ...r.gates.map((g) => ({ ...g, shape: 'gate' })),
      ...r.lawns.map((l) => ({ ...l, shape: l.open ? 'lawn' : 'closed' })),
    ].filter((p) => Number.isFinite(p.len));
    if (r.target && Number.isFinite(r.target.len)) pts.push({ ...r.target, id: 'B', shape: 'target' });
    if (!pts.length) return '';
    const W = 272, H = 224, L = 40, R = 10, T = 10, B = 32;
    const maxV = Math.max(...pts.map((p) => Math.max(p.straight, p.len)));
    const step = niceStep(maxV);
    const max = Math.ceil(maxV / step) * step;
    const sx = (v) => L + (v / max) * (W - L - R);
    const sy = (v) => H - B - (v / max) * (H - T - B);
    const ticks = [];
    for (let v = 0; v <= max + 1e-6; v += step) ticks.push(v);
    const fmtK = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : `${v}`);
    const q = this.active === 'lawn' ? r.lawn : r.gate;
    const hi = this.active === 'target' ? ['B'] : [q?.route?.id, q?.line?.id];
    const word = ENTRANCE_WORD[r.mode];
    const mark = (p) => {
      const x = sx(p.straight), y = sy(p.len);
      const on = hi.includes(p.id);
      const tip = `${p.name}${p.shape === 'closed' ? ' (closed)' : ''}|${ft(p.straight)}|${ft(p.len)}|${ratio(p).toFixed(2)}|${mins(p.time)}`;
      const click = p.shape === 'target' ? '' : `data-dist="to:${p.shape === 'gate' ? 'gate' : 'lawn'}:${p.id}"`;
      const ring = on ? `<circle cx="${x}" cy="${y}" r="8" class="sc-hi"/>` : '';
      let shape;
      if (p.shape === 'gate') shape = `<circle cx="${x}" cy="${y}" r="4" class="sc-gate"/>`;
      else if (p.shape === 'target') shape = `<path d="M${x} ${y - 6}L${x + 6} ${y}L${x} ${y + 6}L${x - 6} ${y}Z" class="sc-target"/>`;
      else shape = `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" rx="1.5" class="${p.shape === 'lawn' ? 'sc-lawn' : 'sc-closed'}"/>`;
      return `<g class="sc-pt" data-tip="${esc(tip)}" ${click}>${ring}${shape}<circle cx="${x}" cy="${y}" r="10" fill="transparent"/></g>`;
    };
    const k = DETOUR_FLAG;
    return `
      <section class="dist-scatter">
        <h3>Every ${word}${r.lawns.length ? ' and lawn' : ''} from A</h3>
        <div class="sc-wrap">
        <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Scatter of straight-line against route distance">
          ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}" class="sc-grid"/>
            <text x="${L - 6}" y="${sy(v) + 3.5}" class="sc-tick" text-anchor="end">${fmtK(v)}</text>
            <text x="${sx(v)}" y="${H - B + 14}" class="sc-tick" text-anchor="middle">${fmtK(v)}</text>`).join('')}
          <path d="M${sx(0)} ${sy(0)}L${sx(max / k)} ${sy(max)}L${sx(0)} ${sy(max)}Z" class="sc-zone"/>
          <line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(max)}" y2="${sy(max)}" class="sc-diag"/>
          <line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(max / k)}" y2="${sy(max)}" class="sc-detour"/>
          <text x="${sx(max * 0.97)}" y="${sy(max * 0.97) + 14}" class="sc-ann" text-anchor="end">same distance</text>
          <text x="${sx((max * 0.97) / k) - 5}" y="${sy(max * 0.97) + 4}" class="sc-ann" text-anchor="end">${k}× by route</text>
          <line x1="${L}" x2="${W - R}" y1="${sy(0)}" y2="${sy(0)}" class="sc-axis"/>
          ${pts.filter((p) => !hi.includes(p.id)).map(mark).join('')}
          ${pts.filter((p) => hi.includes(p.id)).map(mark).join('')}
          <text x="${(L + W - R) / 2}" y="${H - 4}" class="sc-label" text-anchor="middle">Straight line (ft) →</text>
          <text x="11" y="${(T + H - B) / 2}" class="sc-label" text-anchor="middle" transform="rotate(-90 11 ${(T + H - B) / 2})">${ROUTE_NAME[r.mode]} route (ft) →</text>
        </svg>
        <div class="sc-tip" hidden></div>
        </div>
        <div class="sc-legend">
          <span><svg width="10" height="10"><circle cx="5" cy="5" r="4" class="sc-gate"/></svg>${word}</span>
          ${r.lawns.length ? `<span><svg width="10" height="10"><rect x="1" y="1" width="8" height="8" rx="1.5" class="sc-lawn"/></svg>open lawn</span>
          <span><svg width="10" height="10"><rect x="1" y="1" width="8" height="8" rx="1.5" class="sc-closed"/></svg>closed lawn</span>` : ''}
          ${r.target ? '<span><svg width="12" height="12"><path d="M6 0L12 6L6 12L0 6Z" class="sc-target"/></svg>B</span>' : ''}
        </div>
        <p class="hint">Points in the shaded wedge are at least ${k}× farther by route than in a straight line. Click a point to measure to it.</p>
      </section>`;
  }

  overlayControl(r) {
    const opt = (k, text) => `<button class="seg ${this.overlay === k ? 'on' : ''}" data-dist="overlay:${k}">${text}</button>`;
    let legend = '';
    if (this.overlay === 'time') {
      const m = this.model;
      const max = this.timeMax(m.nodes.map((p, i) => m.at(r.run, i).time / 60));
      legend = `<div class="ramp" style="background:linear-gradient(90deg,${TIME_RAMP.join(',')})"></div>
        <div class="ramp-ticks"><span>0 min</span><span>${max / 2} min</span><span>${max}+ min</span></div>
        <p class="hint">Every path and street colored by travel time from A, ${MODES[r.mode].verb}.</p>`;
    } else if (this.overlay === 'detour') {
      legend = `<div class="ramp" style="background:linear-gradient(90deg,${DETOUR_RAMP.join(',')})"></div>
        <div class="ramp-ticks"><span>×1 (direct)</span><span>×2</span><span>×${DETOUR_MAX}+</span></div>
        <p class="hint">Every path colored by route ÷ straight line from A. Dark paths are close as the crow flies but far ${MODES[r.mode].verb}.</p>`;
    }
    return `<section class="dist-overlay"><h3>Map overlay</h3>
      <div class="segs">${opt('off', 'Off')}${opt('time', 'Travel time')}${opt('detour', 'Detour ×')}</div>${legend}</section>`;
  }

  hover(e) {
    const tip = this.root.querySelector('.sc-tip');
    if (!tip) return;
    const g = e?.target.closest?.('.sc-pt');
    if (!g) { tip.hidden = true; return; }
    const [name, s, f, k, t] = g.dataset.tip.split('|');
    tip.innerHTML = `<b>${esc(name)}</b><div><span class="sw" style="--c:${C.straight}"></span>Straight line <b>${s}</b></div>
      <div><span class="sw" style="--c:${C.foot}"></span>${ROUTE_NAME[this.mode]} <b>${f}</b> · ${t}</div><div class="muted">×${(+k).toFixed(1)} detour</div>`;
    const wrap = tip.parentElement.getBoundingClientRect();
    const box = g.getBoundingClientRect();
    tip.hidden = false;
    const x = box.left - wrap.left + box.width / 2;
    tip.style.left = `${Math.min(wrap.width - tip.offsetWidth, Math.max(0, x - tip.offsetWidth / 2))}px`;
    tip.style.top = `${box.top - wrap.top - tip.offsetHeight - 6}px`;
  }
}

function niceStep(max) {
  const raw = max / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
}
