// Mouse/keyboard input for the active tool. Each tool kind is a handler object with
// optional hover/down/drag/up/frame/options callbacks; more kinds are registered by
// other modules via registerTool().
import { idx, inBounds, lCells, N, forRadius, DIRS } from '../core/grid.js';
import { ROADS, CLASS_NAMES, ROAD_RANK, lanesText, UPGRADES } from '../data/roads.js';
import { ZONES } from '../data/zones.js';
import { pickGround } from '../world/picking.js';
import { planRoad, placeRoad, planRoadLine, placeRoadLine, planLayer, placeLayer, setZone, canZoneCell, placePlot, plotBlocker, bulldozeCell, bulldozePreview, terraform, brushCells, isOwned, spend, canAfford, planClearTrees, clearTrees, CLEAR_TREE_COST } from '../sim/build.js';
import { snapEnd, snapToDirs, gridDirs, gridLayout, lineCells } from '../sim/roadsegs.js';
import { planRoadCrossing, placeRoadCrossing } from '../sim/bridges.js';
import { bridgeHover, bridgeClick } from './bridgeSteps.js';
import { bus } from '../core/events.js';
import { cellHeight } from '../sim/mapgen.js';
import { ISSUE_ICONS, ISSUE_TEXT } from '../sim/problems.js';

const handlers = {};
export function registerTool(kind, handler) { handlers[kind] = handler; }

export function createTools(app) {
  const { view, state } = app;
  const canvas = view.renderer.domElement;
  const tip = document.getElementById('tooltip');
  const opts = document.getElementById('tool-options');
  const tools = { current: { kind: 'select' }, hover: null, dragStart: null, down: false, mouse: { x: 0, y: 0 } };

  // Does this kind of tool show an options window (on the right, where panels go)?
  tools.hasOptions = (kind) => kind !== 'select' && !!handlers[kind]?.options;
  tools.set = (tool) => {
    handlers[tools.current.kind]?.exit?.(app, tools.current);
    // one window on the right at a time: the tool's own options replace any open panel
    if (tools.hasOptions(tool.kind)) app.panels?.closeAll();
    tools.current = { ...tool };
    tools.dragStart = null;
    app.preview.clearCells();
    app.preview.hideGhost();
    app.preview.setRing(0, 0, 0);
    app.preview.setBrush(0, 0, 0);
    tools.showTip(null);
    handlers[tools.current.kind]?.enter?.(app, tools.current);
    renderOptions();
    bus.emit('tool:changed', tools.current);
  };

  function renderOptions() {
    const h = handlers[tools.current.kind];
    opts.innerHTML = '';
    if (h?.options) {
      h.options(app, tools.current, opts, renderOptions);
      opts.classList.toggle('open', opts.childElementCount > 0);
      // every tool box can be closed: that puts the tool away
      const x = document.createElement('button');
      x.className = 'box-close';
      x.title = 'Close this tool (Esc)';
      x.textContent = '✕';
      x.onclick = () => { tools.set({ kind: 'select' }); bus.emit('escape'); };
      opts.appendChild(x);
    } else opts.classList.remove('open');
  }
  tools.renderOptions = renderOptions;

  tools.showTip = (html, x = tools.mouse.x, y = tools.mouse.y) => {
    if (!html) { tip.style.display = 'none'; return; }
    tip.innerHTML = html;
    tip.style.display = 'block';
    // the interface may be zoomed (Interface size setting): place it in its own units; on a
    // touch screen it goes above the finger, where the hand doesn't cover it
    const z = app.uiScale || 1;
    if (tools.touch) {
      const w = tip.offsetWidth * z, h = tip.offsetHeight * z;
      tip.style.left = `${Math.max(4, Math.min(window.innerWidth - w - 4, x - w / 2)) / z}px`;
      tip.style.top = `${Math.max(4, y - h - 56) / z}px`;
      return;
    }
    tip.style.left = `${(x + 16) / z}px`;
    tip.style.top = `${(y + 16) / z}px`;
  };

  const pick = (e) => pickGround(view, state, e.clientX, e.clientY);
  // a tool at work (what it spends goes with the change Undo records)
  const work = (fn) => (app.undo ? app.undo.during(fn) : fn());

  // Touch: a finger that lands waits a moment before the tool reacts, so two fingers landing
  // for a pinch or a twist (see camera.js) don't build anything. The press goes ahead as soon
  // as the finger moves, lifts (a tap) or stays down a moment; a second finger calls it off.
  let pending = null;
  const fingers = () => view.cam.touches?.() || 0;
  function commit() {
    if (!pending) return;
    clearTimeout(pending.timer);
    const { e, p } = pending;
    pending = null;
    press(e, p);
  }
  function callOff() {
    if (pending) { clearTimeout(pending.timer); pending = null; }
    if (tools.down) { tools.down = false; tools.dragStart = null; app.undo?.end(); }
    app.preview.clearCells();
    tools.showTip(null);
  }

  canvas.addEventListener('pointermove', (e) => {
    const touch = e.pointerType === 'touch';
    if (touch && fingers() > 1) return;
    if (!touch) tools.touch = false;
    tools.mouse.x = e.clientX; tools.mouse.y = e.clientY;
    if (pending && pending.id === e.pointerId && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > 8) commit();
    const p = pick(e);
    tools.hover = p;
    const h = handlers[tools.current.kind];
    if (!p) { tools.showTip(null); return; }
    if (tools.down && tools.dragStart) {
      work(() => h?.drag?.(app, tools.current, tools.dragStart, p, e));
      // tools that place one thing (a building) follow the finger or the held button
      if (!h?.drag) h?.hover?.(app, tools.current, p, e);
    } else h?.hover?.(app, tools.current, p, e);
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    tools.touch = e.pointerType === 'touch';
    tools.mouse.x = e.clientX; tools.mouse.y = e.clientY;
    if (tools.touch && fingers() > 1) { callOff(); return; }
    const p = pick(e);
    if (!p) return;
    if (!tools.touch) { press(e, p); return; }
    // show what the tool would do under the finger, then wait a moment
    tools.hover = p;
    handlers[tools.current.kind]?.hover?.(app, tools.current, p, e);
    pending = { e, p, id: e.pointerId, x: e.clientX, y: e.clientY, timer: setTimeout(commit, 140) };
  });
  function press(e, p) {
    tools.down = true;
    tools.hover = p;
    tools.dragStart = p;
    tools.downAt = { x: e.clientX, y: e.clientY };
    // whatever this press of the button builds or removes can be undone (see sim/undo.js)
    const label = changeLabel(tools.current);
    if (label) app.undo?.begin(label);
    work(() => {
      handlers[tools.current.kind]?.down?.(app, tools.current, p, e);
      handlers[tools.current.kind]?.drag?.(app, tools.current, p, p, e);
    });
  }
  window.addEventListener('pointerup', (e) => {
    if (pending && pending.id === e.pointerId) commit(); // a quick tap
    if (e.button !== 0 || !tools.down) return;
    tools.down = false;
    // Where the button came up: barely moving counts as a click on the cell it went down on
    // (so a click never becomes a small drag), and otherwise it's the cell under the pointer
    // now, not the last one it moved over (the camera may have moved since)
    const moved = tools.downAt ? Math.hypot(e.clientX - tools.downAt.x, e.clientY - tools.downAt.y) : Infinity;
    const p = moved < 6 ? tools.dragStart : (e.target === canvas && pick(e)) || tools.hover || tools.dragStart;
    // a left drag that panned the map isn't a click
    const panned = tools.current.kind === 'select' && view.cam.justPanned;
    if (tools.dragStart && p && !panned) work(() => handlers[tools.current.kind]?.up?.(app, tools.current, tools.dragStart, p, e));
    tools.dragStart = null;
    app.undo?.end();
  });
  window.addEventListener('blur', () => { callOff(); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerleave', () => tools.showTip(null));
  // Esc or a right click first cancels what the tool is in the middle of (a road you're
  // drawing, a line's stops...), then puts the tool away. Esc also closes the menus; a right
  // click leaves the build menu open so you can pick something else.
  tools.cancel = (closeMenus = true) => {
    if (handlers[tools.current.kind]?.cancel?.(app, tools.current)) return;
    tools.set({ kind: 'select' });
    if (closeMenus) bus.emit('escape');
  };
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'Escape') { tools.cancel(); return; }
    handlers[tools.current.kind]?.key?.(app, tools.current, e);
  });
  // With no tool active, a left drag pans the map and a double click flies there
  view.cam.leftPans = () => tools.current.kind === 'select';
  view.cam.onDoubleClick = () => tools.current.kind === 'select';
  view.cam.onRightClick = () => tools.cancel(false);

  tools.frame = (dt) => {
    const h = handlers[tools.current.kind];
    if (h?.frame) work(() => h.frame(app, tools.current, dt, tools.down ? tools.hover : null));
  };

  app.tools = tools;
  return tools;
}

// ----------------------------------------------------------------------- helpers
export const money = (v) => `₡${Math.round(v).toLocaleString()}`;

// What using a tool changes, as named on the Undo button (null: nothing that can be undone)
function changeLabel(t) {
  switch (t.kind) {
    case 'road': return t.mode === 'replace' ? `${ROADS[t.type].name} (re-surfaced)` : t.mode === 'bridge' ? `${ROADS[t.type].name} bridge` : ROADS[t.type].name;
    case 'zone': return t.zone ? `${ZONES[t.zone].name} zoning` : 'Removed zoning';
    case 'bulldoze': return 'Bulldozing';
    case 'plop': case 'landfill': return t.def?.name || 'Building';
    case 'bridge': return 'Bridge';
    case 'layer': return t.label || 'Line';
    case 'powerline': return 'Power line';
    case 'terraform': return 'Terrain';
    case 'tree': return t.mode === 'remove' ? 'Cleared trees' : 'Planted trees';
    case 'upgrade': return UPGRADES.find((u) => u.bit === t.bit)?.name || 'Road upgrade';
    case 'surface': return 'Surface paint';
    case 'district': return 'District painting';
    default: return null;
  }
}

function dragCells(a, b) {
  return lCells(a.cx, a.cy, b.cx, b.cy, Math.abs(b.cx - a.cx) >= Math.abs(b.cy - a.cy));
}
function rectCells(a, b) {
  const cells = [];
  const x0 = Math.min(a.cx, b.cx), x1 = Math.max(a.cx, b.cx), y0 = Math.min(a.cy, b.cy), y1 = Math.max(a.cy, b.cy);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.push([x, y]);
  return cells;
}
export function segButtons(parent, label, items, current, onPick) {
  const wrap = document.createElement('div');
  if (label) wrap.innerHTML = `<div class="section-title">${label}</div>`;
  const seg = document.createElement('div');
  seg.className = 'seg';
  for (const [value, text, tip] of items) {
    const b = document.createElement('button');
    b.textContent = text;
    if (tip) b.dataset.tip = tip;
    if (value === current) b.classList.add('on');
    b.onclick = () => onPick(value);
    seg.appendChild(b);
  }
  wrap.appendChild(seg);
  parent.appendChild(wrap);
}
export function slider(parent, label, min, max, step, value, onInput) {
  const l = document.createElement('label');
  l.innerHTML = `<span>${label}</span>`;
  const r = document.createElement('input');
  Object.assign(r, { type: 'range', min, max, step, value });
  r.oninput = () => onInput(+r.value);
  l.appendChild(r);
  parent.appendChild(l);
}

// One-way direction from a drag: the direction of travel
function dragDir(a, b) {
  const dx = b.cx - a.cx, dy = b.cy - a.cy;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 0 : 2;
  return dy >= 0 ? 1 : 3;
}

// ------------------------------------------------------------------ select tool
registerTool('select', {
  hover(app, t, p) {
    const i = idx(p.cx, p.cy);
    const b = app.state.buildings.get(app.state.bld[i]);
    let html = null;
    if (b) {
      html = `<b>${b.name || b.def.name}</b>${b.kind === 'zone' ? `<br><span class="muted">Level ${b.level}${b.abandoned ? ' · Abandoned' : ''}</span>` : ''}`;
      if (b.cons) html += `<br>🏗️ Under construction · ${Math.round(b.cons.progress * 100)}%`;
      // what it needs (the icons over it), in words
      for (const k of b.issues || []) html += `<br><span class="${['fire', 'noroad', 'power', 'water', 'full'].includes(k) ? 'bad' : 'warn'}">${ISSUE_ICONS[k]} ${ISSUE_TEXT[k]}</span>`;
    }
    else if (app.state.road[i]) { const r = ROADS[app.state.road[i]]; html = `<b>${r.name}</b><br><span class="muted">${CLASS_NAMES[r.cls]} · condition ${Math.round(app.state.roadCond[i] * 100)}%</span>`; }
    else if (app.state.zone[i]) html = `<span class="muted">Zoned:</span> ${ZONES[app.state.zone[i]].name}`;
    app.tools.showTip(html);
  },
  up(app, t, a, p) {
    const i = idx(p.cx, p.cy);
    const id = app.state.bld[i];
    bus.emit('select', id ? { type: 'building', id } : app.state.road[i] ? { type: 'road', x: p.cx, y: p.cy } : null);
  },
});

// ------------------------------------------------------------------ road tool
// Straight (the default): click where the road starts, then where it ends. It runs along the
// grid, or along (or square to) a road at an angle you start from; hold Shift for any angle.
// Any angle: the same, but the road goes wherever you point (it snaps straight near the grid
// and 45°; Shift gives 15° steps). Either way it keeps going from the end, click by click, so
// a road can be laid out piece by piece; right click or Esc stops. Pressing at one point and
// releasing at another builds that piece in one go. Where a road is drawn across water, the
// water is bridged with a bridge of the same road type (see planRoadCrossing).
// Bridge: a bridge of this road type between two points you click, over water, valleys,
// roads or railways (the same as the Bridge tool).
const ROAD_MODES = [
  ['straight', 'Straight', 'Along the grid (or along an angled road you start from). Click the start, then the end; it keeps going from there. Hold Shift for any angle.'],
  ['angle', 'Any angle', 'Click the start, then the end, at any angle. It snaps straight near the grid and at 45°; hold Shift for 15° steps.'],
  ['bend', 'Right angle', 'Drag: the road runs along the longer side first, then turns a corner.'],
  ['grid', 'Grid', 'Lay out a whole grid of roads: click a corner, click to set the first side (its direction and length), then click to set how far it reaches. Turn it with the angle buttons.'],
  ['replace', 'Replace', 'Re-surface existing road between two points with this road type (more lanes, faster).'],
  ['bridge', 'Bridge', 'A bridge of this road type: click where it starts, then where it ends. It arches over water, valleys, roads and railways.'],
];
const roadTip = (t) => ({
  straight: 'Click where the road starts, then where it ends. It runs along the grid, or along an angled road you start from. Keep clicking to continue; right click or Esc to stop. Hold Shift for any angle.',
  angle: 'Click where the road starts, then where it ends — at any angle. Keep clicking to continue the road; right click or Esc to stop. Hold Shift to snap to 15° steps.',
  bend: 'Drag: the road runs along the longer side first, then turns a right angle.',
  grid: 'Click a corner, then click where the first side ends, then click how far the grid reaches. Right click goes back a step.',
  replace: 'Click two points along existing road (any angle) to re-surface it with this road type.',
  bridge: 'Click where the bridge starts (on land, or on the end of a road), then where it ends. It leaves each end level with the road and arches over water, valleys and the roads or railways below. Bigger roads get sturdier bridges.',
})[t.mode || 'straight'];
const bridgeName = (t) => `${ROADS[t.type].name} bridge`;

registerTool('road', {
  options(app, t, el, rerender) {
    const r = ROADS[t.type];
    el.innerHTML = `<h4>${r.name}</h4><div class="road-class"><b>${CLASS_NAMES[r.cls]}</b> · ${lanesText(r)} · ${r.speed} km/h<br><span class="muted">${r.role}</span></div>`;
    segButtons(el, 'Mode', ROAD_MODES, t.mode || 'straight', (v) => { t.mode = v; t.start = t.gA = t.gB = null; t.bridge = { start: null }; app.preview.clearCells(); rerender(); });
    if (t.mode === 'grid') {
      segButtons(el, 'Direction', [['grid', 'On the grid', 'The grid lines up with the map.'], ['free', 'Any angle', 'The first side points where you click (in steps of about 5–15°). Holding Shift does the same.']], t.gridFree ? 'free' : 'grid', (v) => { t.gridFree = v === 'free'; rerender(); });
      slider(el, `Block size: ${t.spacing || 6} cells (${(t.spacing || 6) * 8} m)`, 4, 12, 1, t.spacing || 6, (v) => { t.spacing = v; rerender(); });
    }
    const step = t.mode === 'grid' ? (t.gB ? 'Step 3 of 3: click how far the grid reaches.' : t.gA ? 'Step 2 of 3: click where the first side ends.' : 'Step 1 of 3: click a corner.') : '';
    const across = t.mode === 'straight' || t.mode === 'angle' || !t.mode ? ' Across water it builds a bridge by itself.' : '';
    el.insertAdjacentHTML('beforeend', `<p class="muted">${roadTip(t)}${across}${ROADS[t.type].oneway ? ' One-way: it runs from where you start toward where you end.' : ''}</p>
      ${t.start ? `<p class="muted">Drawing from (${t.start[0]}, ${t.start[1]}).</p>` : ''}${t.mode === 'bridge' && t.bridge?.start ? `<p class="muted">The bridge starts at (${t.bridge.start.cx}, ${t.bridge.start.cy}): click where it ends.</p>` : ''}${step ? `<p><b>${step}</b></p>` : ''}`);
  },
  enter(app, t) { t.start = t.gA = t.gB = null; t.bridge = { start: null }; },
  exit(app) { app.preview.clearCells(); },
  // Esc / right click: stop the road being drawn, or go back a step in the grid (a further
  // press puts the tool away)
  cancel(app, t) {
    if (t.gB) t.gB = null;
    else if (t.gA) t.gA = null;
    else if (t.start) t.start = null;
    else if (t.bridge?.start) t.bridge.start = null;
    else return false;
    app.preview.clearCells();
    app.tools.renderOptions();
    return true;
  },
  // ---- Grid: a corner, then the first side (direction and length), then how far it reaches
  gridFor(t, p, e) {
    if (!t.gA) return null;
    // once the first side is set, its direction stays as it was clicked
    const onGrid = t.gB ? t.gridLocked : !t.gridFree && !e?.shiftKey;
    return gridLayout(t.gA, t.gB || [p.cx, p.cy], t.gB ? [p.cx, p.cy] : null, t.spacing || 6, onGrid);
  },
  gridPlans(app, t, lay) {
    const s = app.state, seen = new Set();
    let cost = 0, blocked = 0, water = 0;
    const plans = lay.lines.map(([a, b]) => {
      const plan = planRoadLine(s, a, b, t.type);
      for (const [x, y] of plan.cells) { const i = idx(x, y); if (!seen.has(i)) { seen.add(i); cost += ROADS[t.type].cost * (s.bridgeH[i] ? 3 : 1); } }
      if (plan.bad.length) blocked++;
      water += plan.water;
      return plan;
    });
    return { plans, cost: Math.round(cost), blocked, water };
  },
  gridHover(app, t, p, e) {
    const s = app.state;
    const lay = this.gridFor(t, p, e);
    if (!lay) {
      app.preview.setCells([[p.cx, p.cy, isOwned(s, p.cx, p.cy) ? ROADS[t.type].color : '#ff4a3a']]);
      app.tools.showTip(`<b>Road grid</b> · ${ROADS[t.type].name}<br><span class="muted">Click a corner of the grid</span>`);
      return;
    }
    const g = this.gridPlans(app, t, lay);
    const cells = [];
    for (const plan of g.plans) {
      const bad = new Set(plan.bad.map(([x, y]) => idx(x, y)));
      for (const [x, y] of plan.line) cells.push([x, y, bad.has(idx(x, y)) ? '#ff4a3a' : s.road[idx(x, y)] ? '#ffffff' : '#4fc3ff']);
    }
    app.preview.setCells(cells);
    const afford = s.money >= g.cost || s.options.unlimitedMoney;
    app.tools.showTip(`${t.gB ? `${lay.cols} × ${lay.rows} block${lay.cols * lay.rows === 1 ? '' : 's'} · ` : ''}${Math.round(lay.len * 8)}${lay.depth ? ` × ${Math.round(lay.depth * 8)}` : ''} m · ${lay.angle ? `turned ${lay.angle}°` : 'on the grid'} · <span class="${afford ? '' : 'bad'}">${money(g.cost)}</span>`
      + `<br><span class="muted">${t.gB ? 'Click to build the grid' : 'Click where the first side ends'}${t.gridFree || e?.shiftKey ? '' : ' · Shift: any angle'}</span>`
      + `${g.water ? '<br><span class="bad">Crosses water: draw those roads with Straight (it builds the bridge) or use the Bridge mode first</span>' : g.blocked ? `<br><span class="bad">${g.blocked} of its roads ${g.blocked === 1 ? 'is' : 'are'} blocked and won't be built</span>` : ''}`);
  },
  gridClick(app, t, p, e) {
    const s = app.state;
    if (!t.gA) { t.gA = [p.cx, p.cy]; app.tools.renderOptions(); this.gridHover(app, t, p, e); return; }
    const lay = this.gridFor(t, p, e);
    if (!lay) return;
    if (!t.gB) { t.gB = lay.lines[0][1]; t.gridLocked = !t.gridFree && !e?.shiftKey; app.tools.renderOptions(); this.gridHover(app, t, p, e); return; }
    const g = this.gridPlans(app, t, lay);
    if (!canAfford(s, g.cost)) { app.toast('Not enough money for this grid', 'bad'); return; }
    let built = 0, failed = 0;
    for (const [a, b] of lay.lines) {
      const res = placeRoadLine(s, a, b, t.type);
      if (res.error) failed++; else built++;
    }
    if (failed) app.toast(`${failed} of the grid's roads couldn't be built (water, a steep slope, a railway or a building in the way)`, 'warn', `Built ${built} road${built === 1 ? '' : 's'}`);
    t.gA = t.gB = null;
    app.tools.renderOptions();
    this.gridHover(app, t, p, e);
  },
  pointMode: (t) => (t.mode || 'straight') === 'straight' || t.mode === 'angle' || t.mode === 'replace',
  // Where a road from `from` would end if you clicked at p: on the grid (Straight), or free
  endFor(app, t, p, e, from = t.start) {
    if (!from) return [p.cx, p.cy];
    if ((t.mode || 'straight') === 'straight' && !e?.shiftKey) return snapToDirs(from[0], from[1], p.cx, p.cy, gridDirs(app.state, from[0], from[1]));
    return snapEnd(from[0], from[1], p.cx, p.cy, t.mode !== 'straight' && !!e?.shiftKey);
  },
  // A road across water: the land pieces as usual, the bridges over the water in their own colour
  showCrossing(app, t, a, b, cr) {
    const s = app.state;
    // (a road that can't be built shows red all along)
    const cells = cr.ok ? [] : lineCells(a[0], a[1], b[0], b[1]).map(([x, y]) => [x, y, '#ff4a3a']);
    for (const pc of cr.pieces) {
      if (!pc.plan) continue;
      if (pc.kind === 'road') for (const [x, y] of pc.plan.line) cells.push([x, y, !cr.ok ? '#ff4a3a' : s.road[idx(x, y)] ? '#ffffff' : '#4fc3ff']);
      else pc.plan.cells.forEach(([x, y], k) => { const end = k === 0 || k === pc.plan.cells.length - 1; cells.push([x, y, !pc.plan.ok ? '#ff4a3a' : end ? '#ffffff' : '#b9a8ff', pc.plan.ok && !end ? pc.plan.heights[k] - 0.1 : undefined]); });
    }
    app.preview.setCells(cells);
    const ang = Math.round((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 360) % 180;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const afford = s.money >= cr.cost || s.options.unlimitedMoney;
    app.tools.showTip(cr.ok
      ? `${Math.round(len * 8)} m · ${ang}° · <span class="${afford ? '' : 'bad'}">${money(cr.cost)}</span><br>🌉 With a ${cr.span}-cell ${bridgeName(t).toLowerCase()} over the water`
      : `<span class="bad">${cr.reason}</span>`);
    return cr;
  },
  showLine(app, t, a, b) {
    const s = app.state;
    if (t.mode !== 'replace') {
      const cr = planRoadCrossing(s, a, b, t.type);
      if (cr) return this.showCrossing(app, t, a, b, cr);
    }
    const plan = planRoadLine(s, a, b, t.type, { replace: t.mode === 'replace' });
    const bad = new Set(plan.bad.map(([x, y]) => idx(x, y)));
    const cells = plan.line.map(([x, y]) => {
      const i = idx(x, y);
      const color = bad.has(i) ? '#ff4a3a' : s.road[i] && t.mode !== 'replace' ? '#ffffff' : '#4fc3ff';
      return [x, y, color];
    });
    app.preview.setCells(cells);
    const ang = Math.round((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 360) % 180;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const afford = s.money >= plan.cost || s.options.unlimitedMoney;
    const blocked = plan.bad.length - plan.water;
    app.tools.showTip(`${Math.round(len * 8)} m · ${ang}°${plan.diagonal ? '' : ' (straight)'} · <span class="${afford ? '' : 'bad'}">${money(plan.cost)}</span>`
      + `${plan.water ? `<br><span class="bad">Can't re-surface water: use the Bridge mode</span>` : ''}`
      + `${blocked ? `<br><span class="bad">${blocked} cell${blocked === 1 ? '' : 's'} blocked (steep slope, railway, bridge or building)</span>` : ''}`
      + `${plan.diagonal && plan.bad.length ? '<br><span class="bad">A road at an angle has to be clear all the way</span>' : ''}`);
    return plan;
  },
  hover(app, t, p, e) {
    if (t.mode === 'grid') { this.gridHover(app, t, p, e); return; }
    if (t.mode === 'bridge') { bridgeHover(app, t.bridge || (t.bridge = { start: null }), p, 'road', t.type, bridgeName(t)); return; }
    if (this.pointMode(t)) {
      if (t.start) { this.showLine(app, t, t.start, this.endFor(app, t, p, e)); return; }
      const ok = isOwned(app.state, p.cx, p.cy);
      app.preview.setCells([[p.cx, p.cy, ok ? ROADS[t.type].color : '#ff4a3a']]);
      app.tools.showTip(`${ROADS[t.type].name} · ${money(ROADS[t.type].cost)} / cell · ${ROADS[t.type].speed} km/h<br><span class="muted">${t.mode === 'replace' ? 'Click the start of the stretch to re-surface' : 'Click where the road starts'}</span>`);
      return;
    }
    const ok = isOwned(app.state, p.cx, p.cy);
    app.preview.setCells([[p.cx, p.cy, ok ? ROADS[t.type].color : '#ff4a3a']]);
    app.tools.showTip(`${ROADS[t.type].name}<br><span class="muted">${money(ROADS[t.type].cost)} / cell · ${ROADS[t.type].speed} km/h</span>`);
  },
  drag(app, t, a, b, e) {
    if (t.mode === 'grid') { this.gridHover(app, t, b, e); return; }
    if (t.mode === 'bridge') { this.hover(app, t, b, e); return; }
    if (this.pointMode(t)) {
      const from = this.fromFor(t, a, b, e);
      if (!t.start && a.cx === b.cx && a.cy === b.cy) { this.hover(app, t, b, e); return; }
      this.showLine(app, t, from, this.endFor(app, t, b, e, from));
      return;
    }
    const cells = this.cells(app, t, a, b);
    const plan = planRoad(app.state, cells, t.type);
    app.preview.setCells([...plan.ok.map(([x, y]) => [x, y, '#4fc3ff']), ...plan.bad.map(([x, y]) => [x, y, '#ff4a3a'])]);
    const afford = app.state.money >= plan.cost || app.state.options.unlimitedMoney;
    app.tools.showTip(`${plan.ok.length} cells · <span class="${afford ? '' : 'bad'}">${money(plan.cost)}</span>${plan.water ? `<br><span class="bad">Can't build on water: draw it with Straight (it builds the bridge) or use the Bridge mode</span>` : ''}${plan.bad.length - plan.water ? `<br><span class="bad">${plan.bad.length - plan.water} blocked (steep slope, railway or building)</span>` : ''}`);
  },
  cells(app, t, a, b) {
    return dragCells(a, b).filter(([x, y]) => !app.state.road[idx(x, y)]);
  },
  // Where this piece starts: the end of the last piece (you keep drawing from it), but on a
  // touch screen a drag that starts somewhere else is a new road from under the finger
  fromFor(t, a, b, e) {
    if (!t.start) return [a.cx, a.cy];
    const dragged = a.cx !== b.cx || a.cy !== b.cy;
    if (e?.pointerType === 'touch' && dragged && Math.max(Math.abs(a.cx - t.start[0]), Math.abs(a.cy - t.start[1])) > 2) return [a.cx, a.cy];
    return t.start;
  },
  up(app, t, a, b, e) {
    if (t.mode === 'grid') { this.gridClick(app, t, b, e); return; }
    if (t.mode === 'bridge') { bridgeClick(app, t.bridge || (t.bridge = { start: null }), b, 'road', t.type, bridgeName(t)); return; }
    if (this.pointMode(t)) {
      // the first click (without dragging) just sets where the road starts
      if (!t.start && a.cx === b.cx && a.cy === b.cy) {
        t.start = [b.cx, b.cy];
        app.tools.renderOptions();
        this.hover(app, t, b, e);
        return;
      }
      const from = this.fromFor(t, a, b, e);
      const to = this.endFor(app, t, b, e, from);
      if (from[0] === to[0] && from[1] === to[1]) return;
      // across water: road on the land, a bridge of this road type over the water
      const cr = t.mode !== 'replace' ? planRoadCrossing(app.state, from, to, t.type) : null;
      if (cr) {
        if (!cr.ok) { app.toast(cr.reason, 'bad', "Can't build here"); return; }
        const done = placeRoadCrossing(app.state, cr, t.type);
        if (done.error === 'money') { app.toast('Not enough money', 'bad'); return; }
        app.toast(`${cr.span}-cell span · ${money(cr.cost)} with the road`, 'good', `🌉 ${bridgeName(t)} built`);
        t.start = to;
        app.tools.renderOptions();
        this.hover(app, t, b, e);
        return;
      }
      const res = placeRoadLine(app.state, from, to, t.type, { replace: t.mode === 'replace' });
      if (res.error === 'money') { app.toast('Not enough money', 'bad'); return; }
      if (res.error === 'blocked') { app.toast('Something is in the way of this road (water, a steep slope, a railway, a bridge or a building)', 'bad', "Can't build here"); return; }
      // keep drawing from the end of this piece
      t.start = to;
      app.tools.renderOptions();
      this.hover(app, t, b, e);
      return;
    }
    const cells = this.cells(app, t, a, b);
    const res = placeRoad(app.state, cells, t.type, dragDir(a, b), { path: t.mode === 'bend' ? dragCells(a, b) : null });
    if (!res && cells.length) app.toast('Not enough money', 'bad');
    app.preview.clearCells();
  },
});

// ------------------------------------------- generic network layer tool (rail, power...)
const LAYER_COLORS = { rail: '#9b8b77', subway: '#b06be0', power: '#ffd34f', pipe: '#3aa0ff', path: '#e3d6b4' };
registerTool('layer', {
  hover(app, t, p) { app.preview.setCells([[p.cx, p.cy, LAYER_COLORS[t.layer]]]); app.tools.showTip(t.label); },
  drag(app, t, a, b) {
    const plan = planLayer(app.state, t.layer, dragCells(a, b));
    app.preview.setCells([...plan.ok.map(([x, y]) => [x, y, LAYER_COLORS[t.layer]]), ...plan.bad.map(([x, y]) => [x, y, '#ff4a3a'])]);
    app.tools.showTip(`${t.label}: ${plan.ok.length} cells · ${money(plan.cost)}${plan.water ? '<br><span class="bad">Can\'t build on water — use the 🌉 Bridge tool</span>' : ''}`);
  },
  up(app, t, a, b) {
    const res = placeLayer(app.state, t.layer, dragCells(a, b));
    if (!res) app.toast('Can\'t build there (or not enough money)', 'bad');
    app.preview.clearCells();
  },
  enter(app, t) { app.setLayerHint?.(t.layer, true); },
  exit(app, t) { app.setLayerHint?.(t.layer, false); },
});

// ------------------------------------------------------------------ zoning tool
// Modes: Rectangle (drag a box), Paint (a brush), Lots (lay out lots of a size you choose
// along a road, with the buildings set back behind a front yard) and Fill (one block, or one
// patch of a single zone). The mode you last used is kept when you switch zone types.
const ZONE_MODES = [
  ['marquee', 'Rectangle', 'Drag a rectangle over land next to roads.'],
  ['paint', 'Paint', 'Paint zoning with a round brush.'],
  ['lots', 'Lots', 'Lay out lots of a size you choose along a road, with the buildings set back behind a front yard.'],
  ['fill', 'Fill', 'Fill one patch: empty land up to the roads, or a patch of one zone (only that zone changes).'],
];
const ZONE_TIPS = {
  marquee: 'Drag a rectangle over land next to roads.',
  paint: 'Drag to paint zoning with a round brush.',
  lots: 'Drag beside a road to lay out lots of the size below along it (drag along the road itself to do both sides). Buildings grow on the whole lot, set back from the street by the front yard.',
  fill: 'Click to fill one patch: empty land up to the roads, or a patch of one zone (only that zone changes, not its neighbours).',
};

registerTool('zone', {
  options(app, t, el, rerender) {
    el.innerHTML = `<h4>${t.zone ? ZONES[t.zone].name : 'Remove zoning'}</h4>`;
    const mode = t.mode || 'marquee';
    segButtons(el, 'Mode', t.zone ? ZONE_MODES : ZONE_MODES.filter(([k]) => k !== 'lots'), mode, (v) => { t.mode = v; app.zoneMode = v; rerender(); });
    if (mode === 'paint') slider(el, `Brush size: ${t.size ?? 1}`, 0, 4, 1, t.size ?? 1, (v) => { t.size = v; rerender(); });
    if (mode === 'lots') {
      const L = app.lots;
      slider(el, `Lot width (along the road): ${L.w} cell${L.w > 1 ? 's' : ''}`, 1, 6, 1, L.w, (v) => { L.w = v; rerender(); });
      slider(el, `Lot depth: ${L.d} cells`, 2, 6, 1, L.d, (v) => { L.d = v; L.setback = Math.min(L.setback, v - 1); rerender(); });
      slider(el, `Front yard (setback): ${L.setback} cell${L.setback === 1 ? '' : 's'}`, 0, Math.min(3, L.d - 1), 1, Math.min(L.setback, L.d - 1), (v) => { L.setback = v; rerender(); });
      el.insertAdjacentHTML('beforeend', `<div class="lot-diagram">${lotDiagram(L)}</div>`);
    }
    el.insertAdjacentHTML('beforeend', `<p class="muted">${ZONE_TIPS[mode]} Right click or Esc to stop.</p>`);
  },
  enter(app, t) {
    app.lots = app.lots || { w: 2, d: 3, setback: 1 };
    if (!t.mode) t.mode = app.zoneMode && (t.zone || app.zoneMode !== 'lots') ? app.zoneMode : t.zone ? 'marquee' : 'paint';
    app.overlays?.setZoneMode(true);
  },
  exit(app) { app.overlays?.setZoneMode(false); },
  cells(app, t, a, b) {
    const mode = t.mode || 'marquee';
    if (mode === 'marquee') return rectCells(a, b);
    if (mode === 'paint') {
      const out = [];
      forRadius(b.cx + 0.5, b.cy + 0.5, (t.size ?? 1) + 0.5, (x, y) => out.push([x, y]));
      return out;
    }
    return floodZone(app, b.cx, b.cy, t.zone);
  },
  hover(app, t, p) {
    if (t.mode === 'lots') { this.showLots(app, t, p, p); return; }
    const cells = (t.mode || 'marquee') === 'marquee' ? [[p.cx, p.cy]] : this.cells(app, t, p, p);
    this.show(app, t, cells);
    app.tools.showTip(this.roadHint(app, t, p));
  },
  // High-density zones only grow beside a collector or bigger: say so over local streets
  roadHint(app, t, p) {
    const need = t.zone && ZONES[t.zone].needsRoad;
    if (!need) return null;
    let best = -1;
    forRadius(p.cx + 0.5, p.cy + 0.5, 3.5, (x, y) => { const r = app.state.road[idx(x, y)]; if (r) best = Math.max(best, ROAD_RANK[ROADS[r].cls]); });
    return best >= 0 && best < ROAD_RANK[need] ? '<span class="warn">Needs a Medium Road, One-Way Road or bigger in front: high density won\'t grow on local streets</span>' : null;
  },
  show(app, t, cells) {
    const zonable = app.ctx.zonable;
    const color = t.zone ? ZONES[t.zone].color : '#ff6b5a';
    app.preview.setCells(cells.filter(([x, y]) => (t.zone ? canZoneCell(app.state, zonable, x, y, t.zone) : app.state.zone[idx(x, y)])).map(([x, y]) => [x, y, color]));
  },
  showLots(app, t, a, b) {
    const lots = lotPlan(app, t, a, b);
    const color = ZONES[t.zone].color;
    const cells = [];
    for (const lot of lots) {
      const [x0, y0, x1, y1] = lot.rect;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (!inBounds(x, y)) continue;
          const edge = x === x0 || x === x1 || y === y0 || y === y1;
          const yard = lot.yard.has(idx(x, y));
          cells.push([x, y, !lot.ok ? '#ff4a3a' : yard ? '#e8f0dc' : edge ? shade(color, 0.72) : color]);
        }
      }
    }
    app.preview.setCells(cells);
    const ok = lots.filter((l) => l.ok).length;
    const L = app.lots;
    app.tools.showTip(lots.length
      ? `${ok} lot${ok === 1 ? '' : 's'} · ${L.w} × ${L.d} cells${L.setback ? ` · ${L.setback * 8} m front yard` : ''}${ok < lots.length ? `<br><span class="bad">${lots.length - ok} can't go there: ${lots.find((l) => !l.ok).reason}</span>` : ''}`
      : '<span class="muted">Drag beside a road (or along it) to lay out lots</span>');
  },
  drag(app, t, a, b) {
    if (t.mode === 'lots') { this.showLots(app, t, a, b); return; }
    const cells = this.cells(app, t, a, b);
    this.show(app, t, cells);
    if ((t.mode || 'marquee') === 'paint') setZone(app.state, app.ctx.zonable, cells, t.zone || 0);
  },
  up(app, t, a, b) {
    if (t.mode === 'lots') {
      let n = 0;
      for (const lot of lotPlan(app, t, a, b)) if (lot.ok) { placePlot(app.state, app.ctx.zonable, lot.rect, lot.rot, Math.min(app.lots.setback, app.lots.d - 1), t.zone); n++; }
      if (!n) app.toast('No room for lots there: they need open land of yours beside a road', 'warn');
      this.showLots(app, t, b, b);
      return;
    }
    if ((t.mode || 'marquee') !== 'paint') setZone(app.state, app.ctx.zonable, this.cells(app, t, a, b), t.zone || 0);
    this.hover(app, t, b);
  },
});

const shade = (hex, k) => {
  const c = parseInt(hex.slice(1), 16);
  const r = Math.round(((c >> 16) & 255) * k), g = Math.round(((c >> 8) & 255) * k), bl = Math.round((c & 255) * k);
  return `rgb(${r},${g},${bl})`;
};

// A little picture of the lot: road at the bottom, yard, then the building's part
function lotDiagram(L) {
  const cell = 14, w = L.w * cell, h = L.d * cell;
  const yard = L.setback * cell;
  return `<svg width="${w + 2}" height="${h + 14}" viewBox="0 0 ${w + 2} ${h + 14}" aria-label="Lot ${L.w} by ${L.d} with a ${L.setback}-cell front yard">
    <rect x="1" y="1" width="${w}" height="${h - yard}" fill="#5fd36b" opacity="0.85"/>
    ${yard ? `<rect x="1" y="${h - yard + 1}" width="${w}" height="${yard}" fill="#e8f0dc"/>` : ''}
    <rect x="1" y="1" width="${w}" height="${h}" fill="none" stroke="#f5f5f0" stroke-width="1.5"/>
    <rect x="1" y="${h + 3}" width="${w}" height="9" fill="#4a4d55"/><line x1="1" x2="${w + 1}" y1="${h + 7.5}" y2="${h + 7.5}" stroke="#f1c94a" stroke-dasharray="3 3"/>
  </svg><span>${L.w * 8} × ${L.d * 8} m lot${L.setback ? `, building ${L.setback * 8} m back from the street` : ''}</span>`;
}

// Lots along a road from a drag a → b (straight along the grid). Dragging beside a road lays
// lots out on that side; dragging along the road itself does both sides.
function lotPlan(app, t, a, b) {
  const s = app.state, zonable = app.ctx.zonable;
  if (!zonable || !t.zone) return [];
  const { w: W, d: D } = app.lots;
  const S = Math.min(app.lots.setback, D - 1);
  const horizontal = Math.abs(b.cx - a.cx) >= Math.abs(b.cy - a.cy);
  const len = (horizontal ? Math.abs(b.cx - a.cx) : Math.abs(b.cy - a.cy)) + 1;
  const sx = horizontal ? Math.sign(b.cx - a.cx) || 1 : 0, sy = horizontal ? 0 : Math.sign(b.cy - a.cy) || 1;
  const count = Math.max(1, Math.floor(len / W));
  const perp = horizontal ? [1, 3] : [0, 2];
  const sides = [];
  if (s.road[idx(a.cx, a.cy)]) for (const d of perp) sides.push({ away: d, base: 1 });
  else {
    for (const d of perp) {
      const rx = a.cx + DIRS[d][0], ry = a.cy + DIRS[d][1];
      if (inBounds(rx, ry) && s.road[idx(rx, ry)]) { sides.push({ away: (d + 2) % 4, base: 0 }); break; }
    }
  }
  const lots = [];
  for (const { away, base } of sides) {
    const [ax, ay] = DIRS[away];
    for (let k = 0; k < count; k++) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const yard = new Set();
      for (let j = 0; j < W; j++) {
        for (let m = 0; m < D; m++) {
          const x = a.cx + sx * (k * W + j) + ax * (base + m), y = a.cy + sy * (k * W + j) + ay * (base + m);
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
          if (m < S && inBounds(x, y)) yard.add(idx(x, y));
        }
      }
      const rect = [x0, y0, x1, y1];
      const reason = plotBlocker(s, zonable, rect, t.zone);
      lots.push({ rect, rot: (away + 2) % 4, yard, ok: !reason, reason });
    }
  }
  return lots;
}

// Flood fill for zoning: from the clicked cell through the connected patch of the same zone
// (or of unzoned land), stopping at roads and at other zones. So re-zoning one patch never
// spills into the zone next to it.
function floodZone(app, sx, sy) {
  const { state, ctx } = app;
  const z = ctx.zonable;
  if (!z || !inBounds(sx, sy)) return [];
  const start = idx(sx, sy);
  if (z[start] === 0 || z[start] === 255) return [];
  const same = state.zone[start];
  const seen = new Set([start]);
  const out = [];
  const q = [start];
  for (let h = 0; h < q.length && out.length < 900; h++) {
    const i = q[h];
    const x = i % N, y = (i / N) | 0;
    out.push([x, y]);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const j = idx(nx, ny);
      if (seen.has(j) || z[j] === 0 || z[j] === 255 || !isOwned(state, nx, ny) || state.zone[j] !== same) continue;
      seen.add(j);
      q.push(j);
    }
  }
  return out;
}

// ---------------------------------------------------------------- bulldoze tool
// Single (the default): click to remove one thing, a whole building or one piece (cell) of
// road, railway, power line, pipe or footpath; dragging removes each piece you pass over.
// Area: drag a rectangle and everything in it goes when you let go. "Only" limits it to
// buildings, roads & lines, zoning or trees.
const BULLDOZE_MODES = [
  ['single', 'Single', 'Click to remove one thing (a building, or one piece of road or line). Drag to remove each piece you pass over.'],
  ['area', 'Area', 'Drag a rectangle: everything inside it goes when you let go.'],
];
const BULLDOZE_ONLY = [['all', 'Anything'], ['building', 'Buildings'], ['network', 'Roads & lines'], ['zone', 'Zoning'], ['trees', 'Trees']];
let bulldozeMode = 'single'; // the mode you used last
registerTool('bulldoze', {
  options(app, t, el, rerender) {
    el.innerHTML = '<h4>🚜 Bulldozer</h4>';
    segButtons(el, 'Mode', BULLDOZE_MODES, t.mode || 'single', (v) => { t.mode = bulldozeMode = v; app.preview.clearCells(); rerender(); });
    segButtons(el, 'Only', BULLDOZE_ONLY, t.filter || 'all', (v) => { t.filter = v; app.peekResource?.(v === 'trees' ? 'forest' : null); rerender(); });
    const how = (t.mode || 'single') === 'single' ? 'Click to remove one thing; drag to remove each piece you pass over.' : 'Drag a rectangle; everything in it goes when you let go.';
    el.insertAdjacentHTML('beforeend', `<p class="muted">${how} ${t.filter === 'trees' ? `Cutting trees removes the forest resource (₡${CLEAR_TREE_COST} per cell).` : 'You get back half of what you paid (grown buildings refund nothing).'} Changed your mind? <b>Undo</b> (Ctrl+Z) puts it back.</p>`);
  },
  layers(t) {
    const f = t.filter || 'all';
    return f === 'building' ? ['building'] : f === 'network' ? ['road', 'rail', 'power', 'pipe', 'path', 'subway'] : ['building', 'road', 'rail', 'power', 'pipe', 'path', 'subway'];
  },
  enter(app, t) { t.mode = t.mode || bulldozeMode; if (t.filter === 'trees') app.peekResource?.('forest'); },
  exit(app) { app.peekResource?.(null); app.preview.clearCells(); },
  // What a click on cell (x, y) removes: { cells (to highlight), text, refund } or null
  target(app, t, x, y) {
    const s = app.state, f = t.filter || 'all', i = idx(x, y);
    if (f === 'trees') { const p = planClearTrees(s, [[x, y]]); return p.cost ? { cells: [[x, y]], text: 'Clear trees', cost: p.cost } : null; }
    if (f === 'zone') return s.zone[i] && isOwned(s, x, y) ? { cells: [[x, y]], text: `Remove ${ZONES[s.zone[i]].name} zoning` } : null;
    const e = bulldozePreview(s, x, y, this.layers(t));
    if (!e) return null;
    const what = e.building ? (e.building.name || e.building.def.name) : ({ road: ROADS[s.road[i]]?.name || 'road', rail: 'railway', power: 'power line', pipe: 'water pipe', path: 'footpath', subway: 'subway' })[e.what] || e.what;
    const b = e.building;
    const cells = b ? [] : [[x, y]];
    if (b) for (let yy = b.y0; yy <= b.y1; yy++) for (let xx = b.x0; xx <= b.x1; xx++) cells.push([xx, yy]);
    return { cells, text: `Remove ${b ? '' : 'this piece of '}${what}`, refund: e.refund };
  },
  // Remove the thing at (x, y) (once per cell in a stroke). Returns the refund.
  removeAt(app, t, x, y) {
    const s = app.state, f = t.filter || 'all', i = idx(x, y);
    if (!inBounds(x, y) || t.stroke?.has(i)) return 0;
    t.stroke?.add(i);
    if (f === 'trees') { if (!clearTrees(s, [[x, y]])) app.toast('Not enough money', 'bad'); return 0; }
    if (f === 'zone') { setZone(s, app.ctx.zonable, [[x, y]], 0); return 0; }
    const r = bulldozeCell(s, x, y, this.layers(t));
    if (r) t.removed = (t.removed || 0) + 1;
    return r ? r.refund : 0;
  },
  estimate(app, t, cells) {
    if ((t.filter || 'all') === 'zone' || t.filter === 'trees') return null;
    let total = 0, n = 0;
    const seen = new Set();
    for (const [x, y] of cells) {
      const p = bulldozePreview(app.state, x, y, this.layers(t));
      if (!p) continue;
      if (p.building) { if (seen.has(p.building.id)) continue; seen.add(p.building.id); }
      total += p.refund; n++;
    }
    return { total, n };
  },
  hover(app, t, p) {
    app.peekResource?.(t.filter === 'trees' ? 'forest' : null);
    if ((t.mode || 'single') === 'area') {
      app.preview.setCells([[p.cx, p.cy, '#ff6b5a']]);
      app.tools.showTip('<b>Bulldoze an area</b><br><span class="muted">Drag a rectangle</span>');
      return;
    }
    // highlight exactly what a click takes away
    const tg = this.target(app, t, p.cx, p.cy);
    app.preview.setCells(tg ? tg.cells.map(([x, y]) => [x, y, '#ff4a3a']) : [[p.cx, p.cy, '#ff6b5a']]);
    app.tools.showTip(tg ? `${tg.text}${tg.refund ? ` · <span class="good">+${money(tg.refund)}</span> back` : ''}${tg.cost ? ` · ${money(tg.cost)}` : ''}` : '<span class="muted">Nothing to remove here</span>');
  },
  down(app, t) { t.stroke = new Set(); t.got = 0; t.removed = 0; t.last = null; },
  drag(app, t, a, b) {
    if ((t.mode || 'single') === 'single') {
      // a click removes what's under it; dragging starts once the pointer has really moved
      const m = app.tools.mouse, d0 = app.tools.downAt;
      if (t.last && d0 && Math.hypot(m.x - d0.x, m.y - d0.y) < 6) return;
      // every cell the pointer passed over since last time (so a quick drag skips nothing)
      const from = t.last || [a.cx, a.cy];
      for (const [x, y] of lineCells(from[0], from[1], b.cx, b.cy)) t.got += this.removeAt(app, t, x, y);
      t.last = [b.cx, b.cy];
      this.hover(app, t, b);
      if (t.removed > 1 || t.got) app.tools.showTip(`Removed ${t.removed}${t.got ? ` · <span class="good">+${money(t.got)}</span> back` : ''}`);
      return;
    }
    const cells = rectCells(a, b);
    app.preview.setCells(cells.map(([x, y]) => [x, y, '#ff6b5a']));
    if (t.filter === 'trees') { app.tools.showTip(treeTip(planClearTrees(app.state, cells))); return; }
    const e = this.estimate(app, t, cells);
    if (e) app.tools.showTip(`${e.n} item${e.n === 1 ? '' : 's'}${e.total ? ` · <span class="good">+${money(e.total)}</span> back` : ''}`);
  },
  up(app, t, a, b) {
    const f = t.filter || 'all';
    if ((t.mode || 'single') === 'single') {
      if (t.got) app.toast(`+${money(t.got)} refunded`, 'good');
      t.stroke = null;
      this.hover(app, t, b);
      return;
    }
    if (f === 'trees') {
      const r = clearTrees(app.state, rectCells(a, b));
      if (!r) app.toast('Not enough money', 'bad');
      app.preview.clearCells();
      return;
    }
    let total = 0;
    t.stroke = new Set();
    for (const [x, y] of rectCells(a, b)) total += this.removeAt(app, t, x, y);
    t.stroke = null;
    if (total) app.toast(`+${money(total)} refunded`, 'good');
    app.preview.clearCells();
  },
});

// -------------------------------------------------------------- terraform tool
registerTool('terraform', {
  options(app, t, el, rerender) {
    el.innerHTML = '<h4>Terrain</h4>';
    segButtons(el, 'Mode', [['raise', 'Raise'], ['lower', 'Lower'], ['level', 'Level'], ['smooth', 'Soften']], t.mode || 'raise', (v) => { t.mode = v; rerender(); });
    slider(el, `Brush size: ${t.size ?? 2} cell${(t.size ?? 2) === 0 ? '' : 's'} out`, 0, 10, 1, t.size ?? 2, (v) => { t.size = v; rerender(); });
    slider(el, 'Strength', 0.05, 1, 0.05, t.strength ?? 0.35, (v) => { t.strength = v; });
    el.insertAdjacentHTML('beforeend', `<p class="muted">${(t.mode || 'raise') === 'level' ? 'Click a tile and hold: everything under the brush is flattened to <b>that tile\'s height</b>.' : 'Hold the mouse button to keep shaping.'} Size 0 = a single tile. Costs ₡25 per second of use.</p>`);
  },
  showBrush(app, t, p) {
    const color = (t.mode || 'raise') === 'level' ? '#ffe066' : '#ffffff';
    app.preview.setCells(brushCells(p.cx, p.cy, t.size ?? 2).map(([x, y]) => [x, y, color]));
  },
  hover(app, t, p) {
    this.showBrush(app, t, p);
    app.tools.showTip((t.mode || 'raise') === 'level' ? `Level to ${(cellHeight(app.state, p.cx, p.cy) * 8).toFixed(0)} m` : null);
  },
  down(app, t, p) { t.target = cellHeight(app.state, p.cx, p.cy); },
  drag(app, t, a, b) {
    this.showBrush(app, t, b);
    if ((t.mode || 'raise') === 'level') app.tools.showTip(`Levelling to ${(t.target * 8).toFixed(0)} m`);
  },
  frame(app, t, dt, p) {
    if (!p) return;
    if (!spend(app.state, 25 * dt, 'terrain')) return;
    if (terraform(app.state, p.cx, p.cy, t.size ?? 2, t.mode || 'raise', (t.strength ?? 0.35) * dt * 4, t.target)) this.showBrush(app, t, p);
  },
  exit(app) { app.preview.clearCells(); },
});

// ------------------------------------------------------------------- tree tools
const treeTip = (p) => (p.trees || p.forest
  ? `Clear ${p.trees} tree cell${p.trees === 1 ? '' : 's'} · ${money(p.cost)}${p.forest ? `<br><span class="warn">Removes the forest resource on ${p.forest} cell${p.forest === 1 ? '' : 's'}</span>` : ''}`
  : '<span class="muted">No trees here</span>');

registerTool('tree', {
  options(app, t, el, rerender) {
    el.innerHTML = '<h4>Trees</h4>';
    segButtons(el, 'Mode', [['plant', 'Plant'], ['remove', 'Clear']], t.mode || 'plant', (v) => { t.mode = v; app.peekResource?.(v === 'remove' ? 'forest' : null); rerender(); });
    slider(el, 'Brush size', 0, 6, 1, t.size ?? 1, (v) => { t.size = v; });
    el.insertAdjacentHTML('beforeend', t.mode === 'remove'
      ? `<p class="muted">Cuts trees and removes the <b>forest resource</b> under them, so forestry can't be zoned there and the forest won't grow back. ₡${CLEAR_TREE_COST} per cell.</p>`
      : '<p class="muted">₡10 per tree. Trees soak up noise and air pollution and raise land value.</p>');
  },
  enter(app, t) { if (t.mode === 'remove') app.peekResource?.('forest'); },
  exit(app) { app.peekResource?.(null); app.preview.setBrush(0, 0, 0); },
  cells(t, b) {
    const out = [];
    forRadius(b.cx + 0.5, b.cy + 0.5, (t.size ?? 1) + 0.5, (x, y) => out.push([x, y]));
    return out;
  },
  hover(app, t, p) {
    app.preview.setBrush(p.cx + 0.5, p.cy + 0.5, (t.size ?? 1) + 0.5);
    if (t.mode === 'remove') app.tools.showTip(treeTip(planClearTrees(app.state, this.cells(t, p))));
  },
  drag(app, t, a, b) {
    app.preview.setBrush(b.cx + 0.5, b.cy + 0.5, (t.size ?? 1) + 0.5);
    const s = app.state;
    if (t.mode === 'remove') {
      const r = clearTrees(s, this.cells(t, b));
      if (!r) app.toast('Not enough money', 'bad');
      return;
    }
    let changed = 0;
    for (const [x, y] of this.cells(t, b)) {
      const i = idx(x, y);
      if (!isOwned(s, x, y) || s.road[i] || s.bld[i] || s.water[i] || s.rail[i]) continue;
      if (s.tree[i] < 3 && spend(s, 10, 'trees')) { s.tree[i]++; s.counters.treesPlanted++; changed++; }
    }
    if (changed) bus.emit('trees:changed');
  },
});
