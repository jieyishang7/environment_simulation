// Wires the park model, the three.js view and the toolbar together.

import { Park, MOW_HEIGHT, NEEDS_MOWING_ABOVE, SQFT_PER_USER, LEASH_LENGTH } from './model.js?v=10';
import { ParkView, ACTIVITY_COLORS, GRASS_SHORT, GRASS_TALL } from './view.js?v=10';
import { loadMap } from './map.js?v=10';
import { DistanceModel } from './distance.js?v=10';
import { DistanceUI } from './distance-ui.js?v=10';
import { MowerUI } from './mower-ui.js?v=10';

const map = await loadMap();
const park = new Park(map);
const view = new ParkView(document.getElementById('viewport'), park);
const $ = (id) => document.getElementById(id);
const distance = new DistanceUI({
  park, view, model: new DistanceModel(park), root: document.getElementById('distance'),
  getSelection: () => selection, onChange: () => refresh(),
});

const mowerUI = new MowerUI({
  park, view, root: view.mowerCard,
  onChange: (sel) => (sel ? select(sel) : refresh()),
});
let selection = null;
let autoTimer = null;

function select(sel) {
  selection = sel;
  distance.selectionChanged();
  view.selection = sel;
  refresh();
}

function run(result) {
  if (result && !result.ok && result.reason && !park.log.at(-1)?.message.includes(result.reason)) {
    park.note(result.reason, 'warn');
  }
  if (selection?.type === 'user' && !park.user(selection.id)) select(null);
  refresh();
}

const selectedUser = () => (selection?.type === 'user' ? park.user(selection.id) : null);
const selectedLawn = () => (selection?.type === 'lawn' ? park.lawn(selection.id) : null);

const actions = {
  add() {
    const r = park.addUser(view.focusPoint());
    run(r);
    if (r.ok) select({ type: 'user', id: r.user.id });
  },
  remove() { run(park.removeUser(selection?.id)); },
  activity() { run(park.changeActivity(selection?.id)); },
  bench() { run(park.sitOnBench(selection?.id)); },
  dog() {
    const r = park.addDog(selectedUser()?.id, view.focusPoint());
    run(r);
    if (r.ok) select({ type: 'user', id: r.user.id });
  },
  leash() { run(park.toggleLeash(selection?.id)); },
  fetch() {
    const r = park.fetch(selection?.id);
    if (r.ok) view.animateFetch(selection.id, r.run, r.ball);
    run(r);
  },
  advance() {
    const trails = park.advanceTime();
    view.animateTrails(trails, autoTimer ? 850 : 700);
    run({ ok: true });
  },
  clear() { run(park.clearLawn(selection?.id)); },
  mow() {
    const r = park.mowLawn(selection?.id, view.focusPoint());
    run(r);
    if (r.ok && park.mowerActive('great-lawn') && selection?.id === 'great-lawn') mowerUI.zoomToMower();
  },
  toggle() { run(park.toggleLawn(selection?.id)); },
  auto() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    } else {
      actions.advance();
      autoTimer = setInterval(actions.advance, 900);
    }
    refresh();
  },
  reset() {
    if (autoTimer) actions.auto();
    park.reset();
    distance.escape();
    select(null);
  },
  measure() { distance.startMeasure(); },
};

for (const btn of document.querySelectorAll('[data-action]')) {
  btn.addEventListener('click', () => actions[btn.dataset.action]());
}

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  const map = {
    a: 'add', Delete: 'remove', Backspace: 'remove', c: 'activity', b: 'bench',
    d: 'dog', l: 'leash', f: 'fetch', t: 'advance', ' ': 'advance', p: 'auto',
    x: 'clear', m: 'mow', o: 'toggle', g: 'measure', Escape: null,
  };
  if (!(e.key in map)) return;
  e.preventDefault();
  if (map[e.key] === null) {
    if (distance.escape()) return refresh();
    return select(null);
  }
  const btn = document.querySelector(`[data-action="${map[e.key]}"]`);
  if (!btn.disabled) actions[map[e.key]]();
});

// Click (not drag) to select.
const canvas = view.renderer.domElement;
let down = null;
canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
  const picked = view.pick(e.clientX, e.clientY);
  if (distance.pick(picked, view.groundPoint(e.clientX, e.clientY))) return;
  select(picked);
});

// Keep the side panel below the toolbar however many rows it wraps to.
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty('--toolbar-h', `${entry.target.offsetHeight}px`);
}).observe($('toolbar'));

// ---- panels ---------------------------------------------------------------

function refresh() {
  view.sync();
  updateToolbar();
  renderInspector();
  renderRules();
  renderLog();
  mowerUI.render();
  distance.update();
  const dogs = park.users.filter((u) => u.type === 'dog').length;
  $('day').textContent = `Day ${park.day}`;
  $('census').textContent = `${park.users.length - dogs} people · ${dogs} dogs`;
}

function updateToolbar() {
  const user = selectedUser();
  const lawn = selectedLawn();
  const person = user?.type === 'person' ? user : null;
  const dog = user?.type === 'dog' ? user : null;
  const set = (action, enabled, title) => {
    const b = document.querySelector(`[data-action="${action}"]`);
    b.disabled = !enabled;
    if (title) b.title = title;
  };
  set('remove', !!user, user ? `Remove ${user.name}${person && park.dogsOf(person).length ? ' and their dogs' : ''}` : 'Select a user to remove');
  const next = { walking: 'standing', standing: 'sitting', sitting: 'walking' };
  set('activity', !!user, person ? `${person.activity} → ${next[person.activity]}`
    : dog ? `Change what ${dog.name} is doing` : 'Select a user to change activity');
  set('bench', !!person && person.locationType !== 'bench',
    person ? `Sit ${person.name} on the nearest free bench` : 'Select a person to sit on a bench');
  set('dog', !dog, person ? `Give ${person.name} a dog on a leash` : 'Bring a new visitor with a dog');
  set('leash', !!dog, dog ? (dog.leashed ? `Let ${dog.name} off the leash (owner must be on a lawn)` : `Leash ${dog.name}`) : 'Select a dog');
  set('fetch', !!dog && !dog.leashed, dog ? (dog.leashed ? `Unleash ${dog.name} first` : `Throw a ball for ${dog.name}`) : 'Select an unleashed dog');
  const here = lawn ? park.usersOnLawn(lawn.id).length : 0;
  set('clear', !!lawn && here > 0, lawn ? (here ? `Send ${here} users on ${lawn.name} to the path` : `${lawn.name} is empty`) : 'Select a lawn to clear');
  const mowCheck = lawn && park.canMow(lawn);
  const mowing = lawn && park.mowerActive(lawn.id);
  const great = lawn?.id === 'great-lawn';
  set('mow', !!lawn, lawn
    ? (mowing ? `Stop the mower on ${lawn.name}` : great ? 'Start the mower on the Great Lawn (stops within 1.5 m of anyone)'
      : mowCheck.ok ? `Mow ${lawn.name} to ${MOW_HEIGHT}″` : `Blocked: ${mowCheck.reason}`)
    : 'Select a lawn to mow');
  document.querySelector('[data-action="mow"] .label').textContent = mowing ? 'Stop mower' : 'Mow';
  set('toggle', !!lawn, lawn ? `${lawn.status === 'open' ? 'Close' : 'Open'} ${lawn.name}` : 'Select a lawn to open or close');

  document.querySelector('[data-action="dog"] .label').textContent = person ? 'Give dog' : 'Add dog';
  document.querySelector('[data-action="leash"] .label').textContent = dog && !dog.leashed ? 'Leash' : 'Unleash';
  document.querySelector('[data-action="toggle"] .label').textContent =
    lawn ? (lawn.status === 'open' ? 'Close' : 'Open') : 'Open/close';
  const auto = document.querySelector('[data-action="auto"]');
  auto.classList.toggle('active', !!autoTimer);
  auto.querySelector('.label').textContent = autoTimer ? 'Pause' : 'Play';
  auto.querySelector('.icon').textContent = autoTimer ? '❚❚' : '▶';
}

// "East Drive, Wallach Walk and 12 footpaths" for a list of paths.
function pathList(ids) {
  const named = new Set();
  let other = 0;
  for (const id of ids) {
    const p = park.path(id);
    if (/^(Footpath|Trail|Steps|Bridle path|Bike path|Track|Service road|Park road|Walk)$/.test(p.name)) other++;
    else named.add(p.name);
  }
  const parts = [...named];
  if (other) parts.push(`${other} ${other === 1 ? 'footpath' : 'footpaths'}`);
  return parts.join(', ') || '—';
}

const row = (k, v) => `<div class="row"><span>${k}</span><span>${v}</span></div>`;
const chip = (activity) => `<span class="chip" style="--c:${ACTIVITY_COLORS[activity]}">${activity}</span>`;

function renderInspector() {
  const el = $('inspector');
  if (!selection) {
    el.innerHTML = `<h2>Nothing selected</h2>
      <p class="hint">Click a person, dog, lawn, path or bench in the park. Drag to orbit, right-drag to pan, scroll to zoom out to the whole park and the streets around it.</p>`;
    return;
  }
  if (selection.type === 'user') {
    const u = park.user(selection.id);
    const common = `
      ${row('Activity', chip(u.activity))}
      ${row('Position', `(${u.position.x.toFixed(1)}, ${u.position.y.toFixed(1)}) ft`)}
      ${row('Location', `${park.locationName(u)} <small>(${u.locationType})</small>`)}`;
    if (u.type === 'dog') {
      const o = park.owner(u);
      el.innerHTML = `<div class="kind">User · dog</div><h2>🐕 ${u.name}</h2>${common}
        ${row('Owner', o.name)}
        ${row('Leash', u.leashed ? `on (${LEASH_LENGTH} ft)` : 'off')}
        <p class="hint">${u.leashed
          ? `Stays beside ${o.name}. Can be let off the leash when ${o.name} is on a lawn.`
          : `Free to play on ${park.locationName(u)}. Try Fetch, or change activity to rest.`}</p>`;
      return;
    }
    const dogs = park.dogsOf(u);
    el.innerHTML = `<div class="kind">User · person</div><h2>${u.name}</h2>${common}
      ${row('Dogs', dogs.length ? dogs.map((d) => d.name).join(', ') : '—')}
      <p class="hint">Change activity cycles walking → standing → sitting → walking. Sit on bench works from anywhere.</p>`;
    return;
  }
  if (selection.type === 'lawn') {
    const l = park.lawn(selection.id);
    const here = park.usersOnLawn(l.id);
    const dogs = here.filter((u) => u.type === 'dog').length;
    const mow = park.canMow(l);
    el.innerHTML = `<div class="kind">Lawn</div><h2>${l.name}</h2>
      ${row('Grass height', `${l.grassHeight.toFixed(1)}″${park.needsMowing(l) ? ' <span class="badge mow">needs mowing</span>' : ''}`)}
      ${row('Area', `${Math.round(l.area).toLocaleString()} ft² <small>(${(l.area / 43560).toFixed(1)} acres)</small>`)}
      ${row('Status', `<span class="badge ${l.status}">${l.status}</span>`)}
      ${row('Users', `${here.length} / ${l.capacity.toLocaleString()} <small>(area ÷ ${SQFT_PER_USER})</small>`)}
      ${row('', `<small>${here.length - dogs} people, ${dogs} dogs</small>`)}
      ${row('Bordered by', pathList(l.borderedBy))}
      ${row('Boundary', `${l.boundary.length}-sided polygon`)}
      <p class="hint">${park.mowerActive(l.id) ? `The mower is working here, ${Math.round(park.mower.progress * 100)}% done. It stops whenever anyone is within 1.5 m.`
        : l.id === 'great-lawn' ? `Press Mow to start the ride-on mower${here.length ? `. It will stop whenever one of the ${here.length} users here is within 1.5 m` : ''}.`
          : mow.ok ? 'Can be mowed now.' : `Can't mow: ${mow.reason}. Use Clear lawn to send everyone to the path.`}</p>`;
    return;
  }
  if (selection.type === 'bench') {
    const b = park.bench(selection.id);
    const sitters = park.usersOnBench(b.id);
    el.innerHTML = `<div class="kind">Bench</div><h2>${b.name}</h2>
      ${row('Seats', `${sitters.length} / ${b.seats} taken`)}
      ${row('Sitting', sitters.map((u) => u.name).join(', ') || '—')}
      ${row('Beside', park.path(b.pathId).name)}
      <p class="hint">Select a person and press Sit on bench to use the nearest free bench.</p>`;
    return;
  }
  const p = park.path(selection.id);
  el.innerHTML = `<div class="kind">Path</div><h2>${p.name}</h2>
    ${row('Type', p.osmKind)}
    ${row('Width', `${p.width} ft`)}
    ${row('Length', `${p.len.toFixed(0)} ft`)}
    ${row('Users', park.usersOnPath(p.id).length)}
    ${row('Borders lawns', p.bordersLawns.map((id) => park.lawn(id).name).join(', ') || '—')}
    ${row('Benches', p.benches.map((id) => park.bench(id).name).join(', ') || '—')}
    ${row('Connects to', pathList(p.connectsTo))}`;
}

function renderRules() {
  const results = park.validate();
  const bad = results.filter((r) => !r.ok).length;
  $('rules-summary').textContent = bad ? `${bad} violated` : 'all satisfied';
  $('rules-summary').className = bad ? 'bad' : 'good';
  $('rules').innerHTML = results.map((r) => `
    <li class="${r.ok ? 'ok' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.rule}
      ${r.violations.map((v) => `<div class="violation">${v}</div>`).join('')}</li>`).join('');
}

function renderLog() {
  $('log').innerHTML = park.log.slice(-5).reverse()
    .map((e, i) => `<div class="entry ${e.level} ${i === 0 ? 'latest' : ''}"><span>Day ${e.day}</span>${e.message}</div>`)
    .join('');
}

function renderLegend() {
  $('legend-activity').innerHTML = Object.keys(ACTIVITY_COLORS).map(chip).join('');
  $('legend-grass').style.background = `linear-gradient(90deg, ${GRASS_SHORT}, ${GRASS_TALL})`;
  $('mow-threshold').textContent = `> ${NEEDS_MOWING_ABOVE}″`;
}

// Handy for poking at the model from the browser console.
window.parkApp = { park, view, actions, select, distance, mowerUI };

// The mower runs in real time, independent of Advance / Play.
let lastTick = performance.now();
let mowerPanelAt = 0;
function mowerLoop(now) {
  const dt = Math.min(0.1, Math.max(0, (now - lastTick) / 1000));
  lastTick = now;
  if (park.tickMower(dt)) refresh();
  else if (park.mower && now > mowerPanelAt) {
    mowerPanelAt = now + 250;
    mowerUI.render();
  }
  mowerUI.tick(now);
  requestAnimationFrame(mowerLoop);
}
requestAnimationFrame(mowerLoop);

renderLegend();
if (window.innerWidth < 760) document.querySelector('#side details[open]')?.removeAttribute('open');
refresh();
