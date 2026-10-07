// Landfill tool: drag out the area, like zoning. The bigger the landfill, the more garbage
// it holds and the more trucks it sends out. Drag along the side of an existing landfill
// (the full length of that side) to make it bigger instead of starting a new one.
import { registerTool, money } from './tools.js';
import { idx, inBounds, DIRS } from '../core/grid.js';
import { footprintBlocker, spend, clearZoneCell, changeHooks } from '../sim/build.js';
import { touchesGroundRoad, placeService, areaCost, cellsOf, storageCap } from '../sim/services.js';
import { bus } from '../core/events.js';

const rectOf = (a, b) => [Math.min(a.cx, b.cx), Math.min(a.cy, b.cy), Math.max(a.cx, b.cx), Math.max(a.cy, b.cy)];

// Which existing landfill this area would extend (it has to run the full length of one side)
function extends_(state, def, [x0, y0, x1, y1]) {
  for (const b of state.buildings.values()) {
    if (b.def.id !== def.id || b.cons) continue;
    const sameRows = y0 === b.y0 && y1 === b.y1, sameCols = x0 === b.x0 && x1 === b.x1;
    if (sameRows && (x0 === b.x1 + 1 || x1 === b.x0 - 1)) return b;
    if (sameCols && (y0 === b.y1 + 1 || y1 === b.y0 - 1)) return b;
  }
  return null;
}

// The side of the area to face: one with a road along it
function facingRoad(state, [x0, y0, x1, y1]) {
  for (const rot of [1, 3, 0, 2]) {
    const [dx, dy] = DIRS[rot];
    const cells = dx ? Array.from({ length: y1 - y0 + 1 }, (_, k) => [dx > 0 ? x1 + 1 : x0 - 1, y0 + k]) : Array.from({ length: x1 - x0 + 1 }, (_, k) => [x0 + k, dy > 0 ? y1 + 1 : y0 - 1]);
    if (cells.some(([x, y]) => inBounds(x, y) && state.road[idx(x, y)] && !state.bridgeH[idx(x, y)])) return rot;
  }
  return 1;
}

export function planLandfill(state, def, rect) {
  const [x0, y0, x1, y1] = rect;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const cells = w * h;
  const grow = extends_(state, def, rect);
  const plan = { rect, w, h, cells, grow, cost: grow ? Math.round(cells * def.perCell) : areaCost(def, cells), reason: null };
  plan.holds = Math.round((grow ? cellsOf(grow) + cells : cells) * def.storagePerCell);
  const blocked = footprintBlocker(state, x0, y0, x1, y1);
  if (blocked) plan.reason = blocked;
  else if (!grow && (w < def.area.min || h < def.area.min)) plan.reason = `At least ${def.area.min} × ${def.area.min} cells`;
  else if (Math.max(w, grow ? 0 : h) > def.area.max || (grow && (Math.max(grow.x1, x1) - Math.min(grow.x0, x0) + 1 > def.area.max || Math.max(grow.y1, y1) - Math.min(grow.y0, y0) + 1 > def.area.max))) plan.reason = `At most ${def.area.max} cells across`;
  else if (!grow && !touchesGroundRoad(state, x0, y0, x1, y1)) plan.reason = 'Needs a road along one side';
  return plan;
}

export function placeLandfill(state, ctx, def, rect) {
  const plan = planLandfill(state, def, rect);
  if (plan.reason) return { error: plan.reason };
  if (!plan.grow) {
    const res = placeService(state, ctx, def, ...rect, facingRoad(state, rect), {}, plan.cost);
    return res.error ? res : { building: res.building, plan };
  }
  if (!spend(state, plan.cost, def.cat)) return { error: 'Not enough money' };
  const b = plan.grow;
  changeHooks.modifying?.(state, b);
  const [x0, y0, x1, y1] = rect;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = idx(x, y);
    state.bld[i] = b.id; clearZoneCell(state, i); state.tree[i] = 0;
  }
  b.x0 = Math.min(b.x0, x0); b.y0 = Math.min(b.y0, y0); b.x1 = Math.max(b.x1, x1); b.y1 = Math.max(b.y1, y1);
  const alongX = b.rot === 1 || b.rot === 3;
  b.w = alongX ? b.x1 - b.x0 + 1 : b.y1 - b.y0 + 1;
  b.d = alongX ? b.y1 - b.y0 + 1 : b.x1 - b.x0 + 1;
  b.full = false;
  bus.emit('building:changed', b);
  bus.emit('services:changed');
  bus.emit('trees:changed');
  bus.emit('zones:changed', { count: 0 });
  return { building: b, plan };
}

registerTool('landfill', {
  options(app, t, el) {
    const d = t.def;
    el.innerHTML = `<h4>🗑️ ${d.name}</h4>
      <p class="muted">Drag out an area next to a road, like zoning. The bigger it is, the more it holds and the more garbage trucks it sends out. Drag along the full side of a landfill to make it bigger.</p>
      <div class="row"><span class="k">Holds</span><span>${d.storagePerCell} t per cell</span></div>
      <div class="row"><span class="k">Cost</span><span>${money(d.cost)} + ${money(d.perCell)} per cell</span></div>
      <div class="row"><span class="k">Upkeep</span><span>${money((d.upkeep + d.upkeepPerCell * 16) * 7)}/wk for 4 × 4</span></div>
      <div class="row"><span class="k">Trucks</span><span>2, plus 1 per 12 cells</span></div>`;
  },
  hover(app, t, p) {
    app.preview.setCells([[p.cx, p.cy, '#a3825a']]);
    app.tools.showTip(`<b>${t.def.name}</b> · drag out the area`);
  },
  drag(app, t, a, b) {
    const plan = planLandfill(app.state, t.def, rectOf(a, b));
    const [x0, y0, x1, y1] = plan.rect;
    const cells = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.push([x, y, plan.reason ? '#ff4a3a' : '#a3825a']);
    app.preview.setCells(cells);
    const afford = app.state.options.unlimitedMoney || app.state.money >= plan.cost;
    app.tools.showTip(`${plan.w} × ${plan.h} cells${plan.grow ? ` · makes ${plan.grow.name || 'the landfill'} bigger` : ''} · holds ${plan.holds.toLocaleString()} t · <span class="${afford ? '' : 'bad'}">${money(plan.cost)}</span>${plan.reason ? `<br><span class="bad">${plan.reason}</span>` : ''}`);
  },
  up(app, t, a, b) {
    const res = placeLandfill(app.state, app.ctx, t.def, rectOf(a, b));
    if (res.error) app.toast(res.error, 'bad');
    else app.toast(`Holds ${Math.round(storageCap(res.building)).toLocaleString()} t`, 'good', res.plan.grow ? '🗑️ Landfill extended' : '🗑️ Landfill laid out');
    app.preview.clearCells();
  },
});
