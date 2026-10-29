// The Distance panel: picks an origin and (optionally) a second place, runs
// the distance model, and shows the answers three ways: in the 3D view
// (straight line vs walking route), as bars, and as a scatter of every gate
// and lawn (straight line on x, on foot on y).

import * as G from './geometry.js?v=4';
import { DETOUR_FLAG, WALK_FT_PER_MIN } from './distance.js?v=4';
import { METRIC_COLORS } from './view.js?v=4';

const C = METRIC_COLORS;
const FOOT_RAMP = ['#fde3d4', '#f6b08f', '#eb6834', '#b8441a', '#7a2a0c'];
const DETOUR_RAMP = ['#ece9fb', '#b7aef0', '#6250d6', '#3d2fa6', '#231a66'];
const DETOUR_MAX = 3;

const ft = (d) => (Number.isFinite(d) ? `${Math.round(d).toLocaleString()} ft` : 'no route');
const mins = (d) => (Number.isFinite(d) ? `${Math.max(1, Math.round(d / WALK_FT_PER_MIN))} min` : '');
const ratio = (x) => (x.straight > 1 ? x.foot / x.straight : 1);
const ord = (k) => `${k}${[11, 12, 13].includes(k % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][k % 10] || 'th'}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class DistanceUI {
  constructor({ park, view, model, root, getSelection, onChange }) {
    Object.assign(this, { park, view, model, root, getSelection, onChange });
    this.a = null;        // origin picked with Measure (else the selection)
    this.b = null;        // second place
    this.picking = null;  // 'a' | 'b' | null
    this.active = 'gate'; // which answer the 3D view draws
    this.overlay = 'off'; // 'off' | 'foot' | 'detour'
    this.result = null;

    root.addEventListener('click', (e) => {
      const el = e.target.closest('[data-dist]');
      if (!el) return;
      const [cmd, arg, arg2] = el.dataset.dist.split(':');
      if (cmd === 'active') this.active = arg;
      if (cmd === 'overlay') this.overlay = arg;
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
    if (this.picking) {
      this.picking = null;
    } else {
      this.picking = this.originRef() ? 'b' : 'a';
    }
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
    if (!s) return null;
    return { kind: s.type, id: s.id };
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
      const g = model.gates.find((x) => x.id === ref.id);
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
    this.result = origin ? this.model.analyze(origin, target) : null;
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
    this.view.fitTo([d.origin, ...d.legs.flatMap((l) => [...(l.line || []), ...(l.foot || []), ...(l.paths || [])])]);
  }

  renderView() {
    const r = this.result;
    if (!r) return this.view.showDistance(null);
    const legs = [];
    const labels = [{ point: r.origin.point, html: `<b>A</b> ${esc(r.origin.name)}`, cls: 'origin' }];
    const tag = (kind, text, x) => `<span class="dl-metric" style="--c:${C[kind]}">${text}</span> ${esc(x.name)}${x.open === false ? ' <span class="badge closed">closed</span>' : ''} · <b>${ft(kind === 'straight' ? x.straight : x.foot)}</b>`;
    if (this.active === 'target' && r.target) {
      const t = r.target;
      legs.push({ line: [r.origin.point, t.point], foot: t.footRoute, paths: t.pathsRoute });
      labels.push({ point: t.point, html: `<b>B</b> ${esc(t.name)}<br>${tag('straight', 'line', { ...t, name: '' })} · ${tag('foot', 'on foot', { ...t, name: '' })}`, cls: 'target' });
    } else {
      const q = this.active === 'lawn' ? r.lawn : r.gate;
      const line = q.line, foot = q.foot;
      if (line) legs.push({ line: [r.origin.point, line.point] });
      if (foot) legs.push({ foot: foot.footRoute, paths: foot.pathsRoute });
      if (line && foot && line.id === foot.id) {
        labels.push({ point: foot.point, html: `${esc(foot.name)}<br>${tag('straight', 'line', { ...line, name: '' })} · ${tag('foot', 'on foot', { ...foot, name: '' })}`, cls: 'target' });
      } else {
        if (line) labels.push({ point: line.point, html: tag('straight', 'nearest by straight line', line), cls: 'target' });
        if (foot) labels.push({ point: foot.point, html: tag('foot', 'nearest on foot', foot), cls: 'target' });
      }
    }
    let field = null;
    if (this.overlay !== 'off') {
      const m = this.model;
      const o = r.origin.point;
      const dist = r.foot.dist;
      let values, ramp, domain;
      if (this.overlay === 'foot') {
        values = dist;
        ramp = FOOT_RAMP;
        domain = [0, this.footMax(dist)];
      } else {
        values = m.nodes.map((p, i) => {
          const s = Math.hypot(p.x - o.x, p.y - o.y);
          return Number.isFinite(dist[i]) ? (s < 120 ? 1 : dist[i] / s) : NaN;
        });
        ramp = DETOUR_RAMP;
        domain = [1, DETOUR_MAX];
      }
      field = { nodes: m.nodes, edges: m.pathEdges, widths: m.pathEdgeWidths, values, ramp, domain };
    }
    this.view.showDistance({ origin: r.origin.point, gates: this.model.gates, legs, labels, field });
  }

  // Top of the on-foot color scale: the 90th percentile walk, in 500 ft steps.
  footMax(dist) {
    const xs = Array.from(dist).filter(Number.isFinite).sort((a, b) => a - b);
    return Math.max(500, Math.ceil(xs[Math.floor(xs.length * 0.9)] / 500) * 500);
  }

  // ---- panel -------------------------------------------------------------

  renderPanel() {
    const r = this.result;
    const root = this.root;
    const measureBtn = `<button class="small" data-dist="measure">📏 ${this.picking ? 'Cancel' : this.b ? 'Measure to another place' : 'Measure to a place'}</button>`;
    if (!r) {
      root.innerHTML = `<p class="hint">${this.picking ? 'Click anywhere in the park, or on a person, to set <b>A</b>.'
        : 'Select a person, dog or bench to see how far they are from the nearest exit and the next open lawn, two ways: in a straight line and on foot. Or press <b>Measure</b> and click two places.'}</p>
        <div class="dist-actions">${measureBtn}</div>`;
      return;
    }
    const cards = [this.card('gate', 'Nearest exit', r.gate, r.gates), this.card('lawn', 'Next open lawn', r.lawn, r.lawns)];
    if (r.target) cards.unshift(this.targetCard(r.target));
    root.innerHTML = `
      <div class="dist-from"><span>From</span> <b>A · ${esc(r.origin.name)}</b>${this.a ? ' <button class="link" data-dist="clear">reset</button>' : ''}</div>
      ${this.picking === 'b' ? '<p class="hint picking">Click a person or any spot in the park to measure to it (<b>B</b>).</p>' : ''}
      <div class="dist-key">
        <span style="--c:${C.straight}">Straight line</span>
        <span style="--c:${C.foot}">On foot (paths + open lawns)</span>
        <span style="--c:${C.paths}">Paths only</span>
      </div>
      ${cards.join('')}
      <div class="dist-actions">${measureBtn}${this.b ? '<button class="small" data-dist="clear">Clear B</button>' : ''}</div>
      ${this.farClose(r)}
      ${this.scatter(r)}
      ${this.overlayControl(r)}`;
  }

  bars(rows) {
    const max = Math.max(1, ...rows.map((x) => (Number.isFinite(x.d) ? x.d : 0)));
    return `<div class="bars">${rows.map((x) => `
      <div class="bar-row" title="${esc(x.label)}: ${ft(x.d)}">
        <span class="bar-label">${x.label}</span>
        <span class="bar-track"><span class="bar" style="width:${Number.isFinite(x.d) ? Math.max(1.5, (x.d / max) * 100) : 0}%;--c:${x.color}"></span></span>
        <span class="bar-value">${ft(x.d)}</span>
        ${x.sub ? `<span class="bar-sub">${x.sub}</span>` : ''}
      </div>`).join('')}</div>`;
  }

  card(key, title, q, all) {
    if (!q.foot) return '';
    const { line, foot } = q;
    const lineOpen = key === 'lawn' ? q.lineOpen : line;
    const notes = [];
    if (key === 'lawn' && line && !line.open) {
      notes.push(`<b>${esc(line.name)}</b> is the closest lawn in a straight line (${ft(line.straight)}), but it is <b>closed</b>, so the walk goes on to <b>${esc(foot.name)}</b> (${ft(foot.foot)}).`);
    } else if (lineOpen && lineOpen.id !== foot.id) {
      notes.push(`<b>${esc(lineOpen.name)}</b> is closest in a straight line (${ft(lineOpen.straight)}), but it is ${ft(lineOpen.foot)} on foot. <b>${esc(foot.name)}</b> is closer on foot (${ft(foot.foot)}).`);
    }
    if (ratio(foot) >= DETOUR_FLAG) notes.push(`The walk is ${ratio(foot).toFixed(1)}× the straight line.`);
    const saved = foot.paths - foot.foot;
    if (saved > 20) notes.push(`Cutting across open lawns saves ${ft(saved)} over staying on the paths.`);
    const rank = (xs, k, x) => xs.slice().sort((a, b) => a[k] - b[k]).findIndex((y) => y.id === x.id) + 1;
    const pool = key === 'lawn' ? all.filter((l) => l.open) : all;
    return `
      <section class="dist-card ${this.active === key ? 'active' : ''}" data-dist="active:${key}">
        <h3>${title}${this.active === key ? '<button class="link" data-dist="fit">zoom to route</button>' : ''}</h3>
        ${this.bars([
          { label: 'Straight line', d: line.straight, color: C.straight, sub: `to ${esc(line.name)}${line.open === false ? ' (closed)' : ''}` },
          { label: 'On foot', d: foot.foot, color: C.foot, sub: `to ${esc(foot.name)} · ${mins(foot.foot)} walk · ${ord(rank(pool, 'straight', foot))} closest by line` },
          { label: 'Paths only', d: foot.paths, color: C.paths, sub: saved > 20 ? `+${ft(saved)} without the lawns` : 'same as on foot' },
        ])}
        ${notes.length ? `<div class="dist-note">⚠ ${notes.join(' ')}</div>` : ''}
      </section>`;
  }

  targetCard(t) {
    const notes = [];
    const k = ratio(t);
    if (k >= DETOUR_FLAG) notes.push(`<b>Close as the crow flies, far on foot.</b> The walk is ${k.toFixed(1)}× the straight line.`);
    const saved = t.paths - t.foot;
    if (saved > 20) notes.push(`Cutting across open lawns saves ${ft(saved)}.`);
    return `
      <section class="dist-card ${this.active === 'target' ? 'active' : ''}" data-dist="active:target">
        <h3>A → B · ${esc(t.name)}${this.active === 'target' ? '<button class="link" data-dist="fit">zoom to route</button>' : ''}</h3>
        ${this.bars([
          { label: 'Straight line', d: t.straight, color: C.straight },
          { label: 'On foot', d: t.foot, color: C.foot, sub: `${mins(t.foot)} walk` },
          { label: 'Paths only', d: t.paths, color: C.paths },
        ])}
        ${notes.length ? `<div class="dist-note">⚠ ${notes.join(' ')}</div>` : ''}
      </section>`;
  }

  // Places that are near by one metric but far by the other: the biggest
  // detours, and the biggest jumps in rank between the two metrics.
  farClose(r) {
    const places = [...r.gates, ...r.lawns.filter((l) => l.open)].filter((x) => Number.isFinite(x.foot));
    const rankOf = (k) => new Map(places.slice().sort((a, b) => a[k] - b[k]).map((x, i) => [x.id, i + 1]));
    const byLine = rankOf('straight'), byFoot = rankOf('foot');
    const rows = places
      .filter((x) => x.straight > 60 && byLine.get(x.id) <= 12)
      .map((x) => ({ x, k: ratio(x), jump: byFoot.get(x.id) - byLine.get(x.id) }))
      .filter((y) => y.k >= DETOUR_FLAG || y.jump >= 3)
      .sort((a, b) => b.k - a.k)
      .slice(0, 4);
    if (!rows.length) {
      return `<section class="dist-far"><h3>Near by one metric, far by the other</h3>
        <p class="hint">From here, the closest places are about as close on foot as in a straight line. Try a spot across the Reservoir or the Lake, or close a lawn.</p></section>`;
    }
    return `<section class="dist-far"><h3>Near by one metric, far by the other</h3><ul>
      ${rows.map(({ x, k }) => `<li data-dist="to:${x.kind === 'gate' ? 'gate' : 'lawn'}:${x.id}">
        <span class="ratio" title="on foot ÷ straight line">×${k.toFixed(1)}</span>
        <span><b>${esc(x.name)}</b> is ${ordWord(byLine.get(x.id))} closest in a straight line (${ft(x.straight)})
        but ${ordWord(byFoot.get(x.id))} on foot (${ft(x.foot)}).</span></li>`).join('')}
      </ul></section>`;
  }

  // Every gate and lawn: straight line (x) against on foot (y), on equal scales,
  // so the diagonal is "no detour" and anything above the dashed line is at
  // least 1.5x farther on foot.
  scatter(r) {
    const pts = [
      ...r.gates.map((g) => ({ ...g, shape: 'gate' })),
      ...r.lawns.map((l) => ({ ...l, shape: l.open ? 'lawn' : 'closed' })),
    ].filter((p) => Number.isFinite(p.foot));
    if (r.target && Number.isFinite(r.target.foot)) pts.push({ ...r.target, id: 'B', shape: 'target' });
    const W = 272, H = 224, L = 40, R = 10, T = 10, B = 32;
    const maxV = Math.max(...pts.map((p) => Math.max(p.straight, p.foot)));
    const step = niceStep(maxV);
    const max = Math.ceil(maxV / step) * step;
    const sx = (v) => L + (v / max) * (W - L - R);
    const sy = (v) => H - B - (v / max) * (H - T - B);
    const ticks = [];
    for (let v = 0; v <= max + 1e-6; v += step) ticks.push(v);
    const fmtK = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : `${v}`);
    const hi = this.active === 'target' ? ['B'] : [(this.active === 'lawn' ? r.lawn : r.gate).foot?.id, (this.active === 'lawn' ? r.lawn : r.gate).line?.id];
    const mark = (p) => {
      const x = sx(p.straight), y = sy(p.foot);
      const on = hi.includes(p.id);
      const tip = `${p.name}${p.shape === 'closed' ? ' (closed)' : ''}|${ft(p.straight)}|${ft(p.foot)}|${ratio(p).toFixed(2)}`;
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
        <h3>Every gate and lawn from A</h3>
        <div class="sc-wrap">
        <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Scatter of straight-line against on-foot distance for every gate and lawn">
          ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}" class="sc-grid"/>
            <text x="${L - 6}" y="${sy(v) + 3.5}" class="sc-tick" text-anchor="end">${fmtK(v)}</text>
            <text x="${sx(v)}" y="${H - B + 14}" class="sc-tick" text-anchor="middle">${fmtK(v)}</text>`).join('')}
          <path d="M${sx(0)} ${sy(0)}L${sx(max / k)} ${sy(max)}L${sx(0)} ${sy(max)}Z" class="sc-zone"/>
          <line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(max)}" y2="${sy(max)}" class="sc-diag"/>
          <line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(max / k)}" y2="${sy(max)}" class="sc-detour"/>
          <text x="${sx(max * 0.97)}" y="${sy(max * 0.97) + 14}" class="sc-ann" text-anchor="end">same distance</text>
          <text x="${sx((max * 0.97) / k) - 5}" y="${sy(max * 0.97) + 4}" class="sc-ann" text-anchor="end">${k}× on foot</text>
          <line x1="${L}" x2="${W - R}" y1="${sy(0)}" y2="${sy(0)}" class="sc-axis"/>
          ${pts.filter((p) => !hi.includes(p.id)).map(mark).join('')}
          ${pts.filter((p) => hi.includes(p.id)).map(mark).join('')}
          <text x="${(L + W - R) / 2}" y="${H - 4}" class="sc-label" text-anchor="middle" style="--c:${C.straight}">Straight line (ft) →</text>
          <text x="11" y="${(T + H - B) / 2}" class="sc-label" text-anchor="middle" transform="rotate(-90 11 ${(T + H - B) / 2})">On foot (ft) →</text>
        </svg>
        <div class="sc-tip" hidden></div>
        </div>
        <div class="sc-legend">
          <span><svg width="10" height="10"><circle cx="5" cy="5" r="4" class="sc-gate"/></svg>gate</span>
          <span><svg width="10" height="10"><rect x="1" y="1" width="8" height="8" rx="1.5" class="sc-lawn"/></svg>open lawn</span>
          <span><svg width="10" height="10"><rect x="1" y="1" width="8" height="8" rx="1.5" class="sc-closed"/></svg>closed lawn</span>
          ${r.target ? '<span><svg width="12" height="12"><path d="M6 0L12 6L6 12L0 6Z" class="sc-target"/></svg>B</span>' : ''}
        </div>
        <p class="hint">Points in the shaded wedge are at least ${k}× farther on foot than in a straight line. Click a point to measure to it.</p>
      </section>`;
  }

  overlayControl(r) {
    const opt = (k, text) => `<button class="seg ${this.overlay === k ? 'on' : ''}" data-dist="overlay:${k}">${text}</button>`;
    let legend = '';
    if (this.overlay === 'foot') {
      const max = this.footMax(r.foot.dist);
      legend = `<div class="ramp" style="background:linear-gradient(90deg,${FOOT_RAMP.join(',')})"></div>
        <div class="ramp-ticks"><span>0</span><span>${ft(max / 2)}</span><span>${ft(max)}+</span></div>
        <p class="hint">Every path colored by how far it is from A on foot.</p>`;
    } else if (this.overlay === 'detour') {
      legend = `<div class="ramp" style="background:linear-gradient(90deg,${DETOUR_RAMP.join(',')})"></div>
        <div class="ramp-ticks"><span>×1 (direct)</span><span>×2</span><span>×${DETOUR_MAX}+</span></div>
        <p class="hint">Every path colored by on foot ÷ straight line from A. Dark paths are close as the crow flies but a long walk away.</p>`;
    }
    return `<section class="dist-overlay"><h3>Map overlay</h3>
      <div class="segs">${opt('off', 'Off')}${opt('foot', 'On-foot distance')}${opt('detour', 'Detour ×')}</div>${legend}</section>`;
  }

  hover(e) {
    const tip = this.root.querySelector('.sc-tip');
    if (!tip) return;
    const g = e?.target.closest?.('.sc-pt');
    if (!g) { tip.hidden = true; return; }
    const [name, s, f, k] = g.dataset.tip.split('|');
    tip.innerHTML = `<b>${esc(name)}</b><div><span class="sw" style="--c:${C.straight}"></span>Straight line <b>${s}</b></div>
      <div><span class="sw" style="--c:${C.foot}"></span>On foot <b>${f}</b></div><div class="muted">×${(+k).toFixed(1)} detour</div>`;
    const wrap = tip.parentElement.getBoundingClientRect();
    const box = g.getBoundingClientRect();
    tip.hidden = false;
    const x = box.left - wrap.left + box.width / 2;
    tip.style.left = `${Math.min(wrap.width - tip.offsetWidth, Math.max(0, x - tip.offsetWidth / 2))}px`;
    tip.style.top = `${box.top - wrap.top - tip.offsetHeight - 6}px`;
  }
}

function ordWord(k) {
  return k === 1 ? 'the' : `the ${ord(k)}`;
}

function niceStep(max) {
  const raw = max / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
}
