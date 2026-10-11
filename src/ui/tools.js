// Mouse/keyboard input for the active tool. Each tool kind is a handler object with
// optional hover/down/drag/up/frame/options callbacks; more kinds are registered by
// other modules via registerTool().
import { idx, inBounds, lCells, N, forRadius } from '../core/grid.js';
import { ROADS, CLASS_NAMES, ROAD_RANK, lanesText, UPGRADES } from '../data/roads.js';
import { ZONES } from '../data/zones.js';
import { pickGround } from '../world/picking.js';
import { buildingCells, planLayer, placeLayer, setZone, zoneCells, canZoneStrip, placePlot, plotBlocker, bulldozeCell, bulldozePreview, terraform, brushCells, isOwned, spend, canAfford, planClearTrees, clearTrees, CLEAR_TREE_COST } from '../sim/build.js';
import { zoneLayout, zoneOf, cellAt, cellsNear, cellsInRect, cellOf } from '../sim/zoneblocks.js';
import { nearestSeg } from '../sim/roadnet.js';
import { lineCells } from '../sim/roadsegs.js';
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
    case 'road': return t.mode === 'upgrade' ? `${ROADS[t.type].name} (upgraded)` : t.mode === 'bridge' ? `${ROADS[t.type].name} bridge` : ROADS[t.type].name;
    case 'zone': return t.zone ? `${ZONES[t.zone].name} zoning` : 'Removed zoning';
    case 'bulldoze': return 'Bulldozing';
    case 'plop': case 'landfill': case 'area': return t.def?.name || 'Building';
    case 'canal': return 'Canal';
    case 'tunnel': return t.layer === 'rail' ? 'Railway tunnel' : 'Road tunnel';
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

// (the road tool is in ui/toolsRoad.js)

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
  exit(app) { app.overlays?.setZoneMode(false); app.zones?.clearPreview(); },
  // The zone cells (of the strips along the roads) a drag from a to b covers
  cells(app, t, a, b) {
    const Z = zoneLayout(app.state);
    const mode = t.mode || 'marquee';
    if (mode === 'marquee') return a === b ? [cellAt(Z, b.x, b.z)].filter(Boolean) : cellsInRect(Z, a.x, a.z, b.x, b.z);
    if (mode === 'paint') return cellsNear(Z, b.x, b.z, (t.size ?? 1) + 0.6);
    return floodZone(app, b);
  },
  hover(app, t, p) {
    if (t.mode === 'lots') { this.showLots(app, t, p, p); return; }
    this.show(app, t, this.cells(app, t, p, p));
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
    const color = t.zone ? ZONES[t.zone].color : '#ff6b5a';
    app.zones.preview(cells.filter((c) => (t.zone ? canZoneStrip(app.state, c, t.zone) : zoneOf(app.state, c))), color);
  },
  showLots(app, t, a, b) {
    const lots = lotPlan(app, t, a, b);
    const color = ZONES[t.zone].color;
    const items = [];
    for (const lot of lots) {
      for (const c of lot.cells) {
        const edge = c.col === lot.col || c.col === lot.col + lot.w - 1 || c.row === lot.d - 1;
        items.push([c, !lot.ok ? '#ff4a3a' : c.row < lot.setback ? '#e8f0dc' : edge ? shade(color, 0.72) : color]);
      }
    }
    app.zones.preview(items);
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
    if ((t.mode || 'marquee') === 'paint') zoneCells(app.state, cells, t.zone || 0);
  },
  up(app, t, a, b) {
    if (t.mode === 'lots') {
      let n = 0;
      for (const lot of lotPlan(app, t, a, b)) if (lot.ok) { placePlot(app.state, lot, lot.setback, t.zone); n++; }
      if (!n) app.toast('No room for lots there: they need open land of yours beside a road', 'warn');
      this.showLots(app, t, b, b);
      return;
    }
    if ((t.mode || 'marquee') !== 'paint') zoneCells(app.state, this.cells(app, t, a, b), t.zone || 0);
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

// Lots along a road from a drag a → b. Dragging beside a road lays lots out along the zone
// strip on that side; dragging along the road itself does both sides.
function lotPlan(app, t, a, b) {
  const s = app.state;
  if (!t.zone) return [];
  const Z = zoneLayout(s);
  const { w: W, d: D } = app.lots;
  const S = Math.min(app.lots.setback, D - 1);
  // the column of a strip nearest a point
  const colNear = (strip, x, z) => {
    let best = 0, bd = Infinity;
    for (let c = 0; c < strip.cols; c++) { const d = (strip.x[c] - x) ** 2 + (strip.z[c] - z) ** 2; if (d < bd) { bd = d; best = c; } }
    return best;
  };
  const sides = [];
  const start = cellAt(Z, a.x, a.z);
  if (start) sides.push({ seg: start.seg, side: start.side, at: start.col });
  else {
    const q = nearestSeg(s, a.x, a.z, 0.6, (sg) => ROADS[sg.type].zonable && !sg.br && !sg.tn);
    if (q) for (const side of [0, 1]) { const st = Z.strips.get(`${q.id}:${side}`); if (st?.cols) sides.push({ seg: q.id, side, at: colNear(st, a.x, a.z) }); }
  }
  const lots = [];
  for (const { seg, side, at } of sides) {
    const strip = Z.strips.get(`${seg}:${side}`);
    const end = colNear(strip, b.x, b.z);
    const dir = Math.sign(end - at) || 1;
    const count = Math.max(1, Math.floor((Math.abs(end - at) + 1) / W));
    for (let k = 0; k < count; k++) {
      const col = dir > 0 ? at + k * W : at - k * W - (W - 1);
      const lot = { seg, side, col, w: W, d: D, setback: S };
      const cells = [];
      for (let j = 0; j < W; j++) for (let r = 0; r < D; r++) { const c = cellOf(Z, seg, side, col + j, r); if (c) cells.push(c); }
      const reason = plotBlocker(s, lot, t.zone);
      lots.push({ ...lot, cells, ok: !reason, reason });
    }
  }
  return lots;
}

// Flood fill for zoning: from the clicked zone cell through the joined-up patch of the same
// zone (or of unzoned cells). So re-zoning one patch never spills into the zone next to it.
function floodZone(app, p) {
  const { state } = app;
  const Z = zoneLayout(state);
  const start = cellAt(Z, p.x, p.z);
  if (!start || !isOwned(state, start.g % N, (start.g / N) | 0)) return [];
  const same = zoneOf(state, start);
  const seen = new Set([start.k]);
  const out = [];
  const q = [start];
  for (let h = 0; h < q.length && out.length < 900; h++) {
    const c = q[h];
    out.push(c);
    for (const o of cellsNear(Z, c.x, c.z, 1.15)) {
      if (seen.has(o.k) || zoneOf(state, o) !== same || !isOwned(state, o.g % N, (o.g / N) | 0)) continue;
      seen.add(o.k);
      q.push(o);
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
    const cells = b ? buildingCells(b) : [[x, y]];
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
