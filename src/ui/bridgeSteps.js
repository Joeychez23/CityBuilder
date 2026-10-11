// Laying out a bridge from a start point: shared by the Bridge tool and each road's Bridge
// mode. t.start is where the bridge starts ({ cx, cy }, or null while choosing it).
import { money } from './tools.js';
import { ROADS } from '../data/roads.js';
import { idx, CELL_M } from '../core/grid.js';
import { planBridge, buildBridge } from '../sim/bridges.js';
import { landmarkReason, landmarkCost, buildLandmarkBridge } from '../sim/landmarkBridges.js';

// Hovering with a bridge being laid out from t.start (or choosing where it starts)
export function bridgeHover(app, t, p, layer, type, name) {
  const s = app.state;
  if (!t.start) {
    const i = idx(p.cx, p.cy);
    const net = layer === 'rail' ? s.rail : layer === 'path' ? s.path : s.road;
    const onTrack = net[i] ? (layer === 'road' ? ROADS[s.road[i]].name : layer === 'rail' ? 'railway' : 'footpath') : null;
    app.preview.setCells([[p.cx, p.cy, s.water[i] ? '#ff4a3a' : '#ffffff']]);
    app.tools.showTip(s.water[i] ? '<span class="bad">Start on land</span>' : `${name} · start${onTrack ? ` · joins the ${onTrack}` : ''}`);
    return;
  }
  const plan = planBridge(s, layer, type, t.start, p);
  const cells = plan.cells.map(([x, y], k) => {
    const end = k === 0 || k === plan.cells.length - 1;
    const color = !plan.ok ? '#ff4a3a' : end ? '#ffffff' : '#4fc3ff';
    return [x, y, color, plan.ok && !end ? plan.heights[k] - 0.1 : undefined];
  });
  app.preview.setCells(cells);
  if (!plan.ok) { app.tools.showTip(`<span class="bad">${plan.reason}</span>`); return; }
  // a landmark suspension bridge (Bridge tool → Style)
  if (t.style === 'landmark') {
    const why = landmarkReason(plan);
    const cost = landmarkCost(plan);
    app.tools.showTip(why ? `<span class="bad">${why}</span>` : `🌉 Suspension bridge · ${plan.cells.length - 2} cells · <span class="${s.options.unlimitedMoney || s.money >= cost ? '' : 'bad'}">${money(cost)}</span><br><span class="muted">A landmark: +15 attractiveness, and well-being at either end</span>`);
    return;
  }
  const span = plan.cells.length - 2;
  const rise = Math.max(...plan.heights) - Math.min(plan.heights[0], plan.heights[plan.heights.length - 1]);
  const over = [plan.spanOver.water && `${plan.spanOver.water} over water`, plan.spanOver.cross && `${plan.spanOver.cross} over track`, plan.spanOver.land && `${plan.spanOver.land} over land`].filter(Boolean).join(', ');
  const afford = s.options.unlimitedMoney || s.money >= plan.cost;
  app.tools.showTip(`🌉 ${name} · ${span} cells (${over})<br>Rises up to ${Math.round(rise * CELL_M)} m · <span class="${afford ? '' : 'bad'}">${money(plan.cost)}</span>`);
}

// A click: set where the bridge starts, or build it to here. Returns true when it was built.
export function bridgeClick(app, t, p, layer, type, name) {
  if (!t.start) {
    if (app.state.water[idx(p.cx, p.cy)]) { app.toast('Bridges start on land', 'warn'); return false; }
    t.start = { cx: p.cx, cy: p.cy };
    app.tools.renderOptions();
    return false;
  }
  const plan = planBridge(app.state, layer, type, t.start, p);
  if (!plan.ok) { app.toast(plan.reason, 'bad', "Can't build this bridge"); return false; }
  if (t.style === 'landmark') {
    const res = buildLandmarkBridge(app.state, plan);
    if (res.error) { app.toast(res.error, 'bad', "Can't build this bridge"); return false; }
    app.toast(`${plan.cells.length - 2} cell span · ${money(landmarkCost(plan))}`, 'good', `🌉 ${res.bridge.name} opened`);
  } else if (!buildBridge(app.state, plan)) { app.toast('Not enough money', 'bad'); return false; }
  else app.toast(`${plan.cells.length - 2} cell span · ${money(plan.cost)}`, 'good', `${name} built`);
  t.start = null;
  app.tools.renderOptions();
  app.preview.clearCells();
  return true;
}

