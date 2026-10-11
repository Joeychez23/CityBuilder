// Tools for the projects you lay out (sim/projects.js):
//  - area: drag out Central Park, a beach or the boardwalk, like zoning
//  - canal: drag a straight canal from the water into your land, 2 or 3 cells wide
import { registerTool, money, segButtons } from './tools.js';
import { planArea, placeArea, planCanal, digCanal, canalCells, CANAL_COST } from '../sim/projects.js';
import { perWeek } from '../sim/economy.js';

const rectOf = (a, b) => [Math.min(a.cx, b.cx), Math.min(a.cy, b.cy), Math.max(a.cx, b.cx), Math.max(a.cy, b.cy)];

registerTool('area', {
  options(app, t, el) {
    const d = t.def, A = d.area;
    el.innerHTML = `<h4>${d.name}</h4><p class="muted">${d.desc}</p>
      <div class="row"><span class="k">Size</span><span>${A.strip ? `1–2 wide, up to ${A.max} long` : `${A.min} × ${A.min} to ${A.max} × ${A.max} cells`}</span></div>
      <div class="row"><span class="k">Cost</span><span>${money(d.cost)} + ${money(d.perCell)} per cell</span></div>
      <div class="row"><span class="k">Upkeep</span><span>${money(perWeek(d.upkeep))} + ${money(perWeek(d.upkeepPerCell))} per cell /wk</span></div>
      <p class="muted">Drag out the area.</p>`;
  },
  hover(app, t, p) {
    app.preview.setCells([[p.cx, p.cy, '#5fd38a']]);
    app.tools.showTip(`<b>${t.def.name}</b> · drag out the area`);
  },
  drag(app, t, a, b) {
    const plan = planArea(app.state, t.def, rectOf(a, b));
    const [x0, y0, x1, y1] = plan.rect;
    const cells = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.push([x, y, plan.reason ? '#ff4a3a' : t.def.area.shore ? '#ead9a6' : '#5fd38a']);
    app.preview.setCells(cells);
    const s = t.def.scale(plan.cells);
    const afford = app.state.options.unlimitedMoney || app.state.money >= plan.cost;
    app.tools.showTip(`${plan.w} × ${plan.h} cells · reaches ${s.radius * 8} m · +${s.attract} attractiveness · <span class="${afford ? '' : 'bad'}">${money(plan.cost)}</span>${plan.reason ? `<br><span class="bad">${plan.reason}</span>` : ''}`);
  },
  up(app, t, a, b) {
    const res = placeArea(app.state, app.ctx, t.def, rectOf(a, b));
    if (res.error) app.toast(res.error, 'bad');
    else app.toast(`${res.plan.w} × ${res.plan.h} cells`, 'good', `🌳 ${t.def.name} laid out`);
    app.preview.clearCells();
  },
});

registerTool('canal', {
  options(app, t, el, rerender) {
    el.innerHTML = `<h4>🛶 Canal</h4><p class="muted">Drag a straight canal from the water (a river, lake, the sea or another canal) into your land. Homes along a canal are worth a lot, and water taxis can run on it. Roads crossing it need a bridge (Roads → Bridge) afterwards.</p>
      <div class="row"><span class="k">Cost</span><span>${money(CANAL_COST)} per cell</span></div>`;
    segButtons(el, 'Width', [[2, '2 cells'], [3, '3 cells']], t.width || 2, (v) => { t.width = v; rerender(); });
  },
  hover(app, t, p) {
    app.preview.setCells([[p.cx, p.cy, '#3aa0ff']]);
    app.tools.showTip('<b>Canal</b> · drag from the water into your land');
  },
  drag(app, t, a, b) {
    const cells = canalCells([a.cx, a.cy], [b.cx, b.cy], t.width || 2);
    const plan = planCanal(app.state, cells);
    const bad = new Set(plan.bad.map(([x, y]) => `${x},${y}`));
    app.preview.setCells(cells.map(([x, y]) => [x, y, bad.has(`${x},${y}`) ? '#ff4a3a' : plan.reason ? '#ff9a3a' : '#3aa0ff']));
    app.tools.showTip(`${plan.ok.length} cells · <span class="${app.state.money >= plan.cost || app.state.options.unlimitedMoney ? '' : 'bad'}">${money(plan.cost)}</span>${plan.reason ? `<br><span class="bad">${plan.reason}</span>` : ''}`);
  },
  up(app, t, a, b) {
    const res = digCanal(app.state, canalCells([a.cx, a.cy], [b.cx, b.cy], t.width || 2));
    if (res.error) app.toast(res.error, 'bad');
    else app.toast(`${res.plan.ok.length} cells dug`, 'good', '🛶 Canal');
    app.preview.clearCells();
  },
});
