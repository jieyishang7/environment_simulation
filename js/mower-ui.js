// The mower's info card, which stands on the map at the south end of the
// Great Lawn: status, the occupant nearest the mower against the 1.5 m
// threshold, a 30-second distance trace, the rule in IF-THEN-ELSE form, and a
// beep while the alarm is on.

import { SAFE_M, SAFE_FT, FT_PER_M, MOWER_LAWN } from './mower.js?v=10';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const m2 = (ft) => `${(ft / FT_PER_M).toFixed(2)} m`;
const SCALE_M = 5; // the distance bar runs 0-5 m

export class MowerUI {
  constructor({ park, view, root, onChange }) {
    Object.assign(this, { park, view, root, onChange });
    this.sound = true;
    this.audio = null;
    this.beepAt = 0;
    // pointerdown, not click: the card re-renders a few times a second, which
    // can swap a button out between press and release.
    root.addEventListener('pointerdown', (e) => {
      const el = e.target.closest('[data-mower]');
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      const [cmd, arg] = el.dataset.mower.split(':');
      const m = this.park.mower;
      if (cmd === 'speed' && m) m.timeScale = +arg;
      if (cmd === 'sound') this.sound = !this.sound;
      if (cmd === 'stop' && m) this.park.mowLawn(m.lawnId);
      if (cmd === 'start') {
        const lawn = this.park.lawn(MOWER_LAWN);
        const south = lawn.boundary.reduce((a, p) => (p.y < a.y ? p : a));
        this.park.mowLawn(MOWER_LAWN, { x: south.x, y: south.y + 50 });
        this.zoomToMower();
      }
      if (cmd === 'find' && m) this.zoomToMower();
      if (cmd === 'select' && m) return this.onChange({ type: 'lawn', id: m.lawnId });
      this.onChange();
    });
  }

  // Frames the mower and its card together.
  zoomToMower() {
    const m = this.park.mower;
    if (!m) return;
    const lawn = this.park.lawn(MOWER_LAWN);
    const south = lawn.boundary.reduce((a, p) => (p.y < a.y ? p : a));
    const p = m.position;
    // The card hangs below its anchor south of the lawn, so leave room under it.
    this.view.fitTo([{ x: p.x - 45, y: p.y + 35 }, { x: p.x + 45, y: p.y - 20 }, { x: south.x, y: south.y - 95 }]);
  }

  // Called every frame: flags the card and beeps while the alarm is on.
  tick(now) {
    const m = this.park.mower;
    const alarm = m?.status === 'alarm';
    this.root.classList.toggle('alarm', alarm);
    if (alarm) {
      if (this.sound && now > this.beepAt) {
        this.beep();
        this.beepAt = now + 700;
      }
    }
  }

  beep() {
    try {
      this.audio ??= new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this.audio;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.2);
    } catch { /* no audio: the card and the map still show the alarm */ }
  }

  render() {
    const m = this.park.mower;
    const rule = `<div class="rule"><span class="kw if">IF</span> anyone is &lt; <b>${SAFE_M} m</b> (${SAFE_FT.toFixed(1)} ft) from the mower
      <span class="kw then">THEN</span> stop + alarm <span class="kw else">ELSE</span> keep mowing</div>
      <details class="mc-why"><summary>Metric: straight-line distance</summary>
      Measured from the mower's body to the person or dog. The blade is the danger, so a path or a fence line between them doesn't make anyone safer. If someone stays in the zone, the mower waits 2 s, then steers around them and leaves that patch unmowed.</details>`;
    const title = `<div class="mc-title">🚜 Great Lawn mower <span>proximity alarm · ${SAFE_M} m</span></div>`;
    if (!m || m.status === 'done' || m.status === 'stopped') {
      this.root.innerHTML = `${title}
        ${m ? `<p class="hint">${m.status === 'done' ? 'Done' : 'Stopped'}: ${Math.round(m.progress * 100)}% mowed, ${m.alarms} alarm${m.alarms === 1 ? '' : 's'}.</p>` : ''}
        <div class="dist-actions"><button class="small primary" data-mower="start">▶ Start mowing</button></div>
        <div class="mc-detail">${rule}</div>`;
      return;
    }
    const n = m.nearest;
    const status = {
      mowing: ['ok', 'Mowing'], alarm: ['alarm', '⚠ Alarm: stopped'], steering: ['warn', 'Steering around'],
      done: ['done', 'Done'], stopped: ['done', 'Stopped'],
    }[m.status];
    const dm = n ? n.dist / FT_PER_M : null;
    const barPct = n ? Math.min(100, (dm / SCALE_M) * 100) : 100;
    const thrPct = (SAFE_M / SCALE_M) * 100;
    const alarmLine = m.status === 'alarm'
      ? `<div class="mc-alarm">⚠ <b>STOP</b> · ${esc(n.name)} is ${m2(n.dist)} (${n.dist.toFixed(1)} ft) away, under ${SAFE_M} m</div>` : '';
    this.root.innerHTML = `${title}${alarmLine}
      <div class="mw-head">
        <span class="mw-status ${status[0]}">${status[1]}</span>
        <span class="mw-pct">${Math.round(m.progress * 100)}% mowed</span>
      </div>
      <div class="mw-near">
        <div class="mw-near-top"><span>Nearest occupant</span><b>${n ? `${esc(n.name)} · ${m2(n.dist)} <small>(${n.dist.toFixed(1)} ft)</small>` : 'no one nearby'}</b></div>
        <div class="mw-bar" title="Distance to the nearest occupant, 0-${SCALE_M} m">
          <span class="mw-danger" style="width:${thrPct}%"></span>
          <span class="mw-fill ${n && dm < SAFE_M ? 'in' : ''}" style="width:${barPct}%"></span>
          <span class="mw-thr" style="left:${thrPct}%"><i>${SAFE_M} m</i></span>
        </div>
        <div class="mw-scale"><span>0</span><span>${SCALE_M} m+</span></div>
      </div>
      ${this.trace(m)}
      <div class="mw-stats"><span><b>${m.alarms}</b> alarm${m.alarms === 1 ? '' : 's'}</span>
        ${[1, 5, 20].map((k) => `<button class="seg-sm ${m.timeScale === k ? 'on' : ''}" data-mower="speed:${k}" title="Speed">×${k}</button>`).join('')}
        <button class="seg-sm" data-mower="sound" title="Alarm sound">${this.sound ? '🔔' : '🔕'}</button>
        <button class="seg-sm" data-mower="find" title="Zoom to the mower">🔍</button>
        <button class="seg-sm stop" data-mower="stop" title="Stop the mower">■ Stop</button>
      </div>
      <div class="mc-detail">${rule}</div>
      </div>`;
  }

  // Distance to the nearest occupant over the last 30 s, with the threshold.
  trace(m) {
    const h = m.history.map((ft) => ft / FT_PER_M);
    if (h.length < 2) return '';
    const W = 272, H = 70, L = 26, R = 6, T = 6, B = 14;
    const max = SCALE_M;
    const x = (i) => L + (i / (120 - 1)) * (W - L - R);
    const y = (v) => T + (1 - Math.min(v, max) / max) * (H - T - B);
    const off = 120 - h.length;
    const d = h.map((v, i) => `${i ? 'L' : 'M'}${x(i + off).toFixed(1)} ${y(v).toFixed(1)}`).join('');
    return `<svg class="mw-trace" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Distance to the nearest occupant over the last 30 seconds">
      <rect x="${L}" y="${y(SAFE_M)}" width="${W - L - R}" height="${y(0) - y(SAFE_M)}" class="tr-zone"/>
      <line x1="${L}" x2="${W - R}" y1="${y(SAFE_M)}" y2="${y(SAFE_M)}" class="tr-thr"/>
      <line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="tr-axis"/>
      <text x="${L - 4}" y="${y(SAFE_M) + 3}" text-anchor="end" class="tr-tick">${SAFE_M}</text>
      <text x="${L - 4}" y="${y(max) + 6}" text-anchor="end" class="tr-tick">${max} m</text>
      <text x="${L}" y="${H - 2}" class="tr-tick">30 s ago</text>
      <text x="${W - R}" y="${H - 2}" text-anchor="end" class="tr-tick">now</text>
      <path d="${d}" class="tr-line"/>
      <circle cx="${x(119)}" cy="${y(h.at(-1))}" r="3" class="tr-dot ${h.at(-1) < SAFE_M ? 'in' : ''}"/>
    </svg>`;
  }
}
