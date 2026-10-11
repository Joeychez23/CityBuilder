// Railway tunnel tool: click railway track where the tunnel goes in, then where it comes out.
// It runs straight underground between them, under anything (sim/tunnels.js). (Road tunnels
// are drawn with the road tool's Tunnel mode, see toolsRoad.js.)
import { registerTool, money } from './tools.js';
import { N, idx, CELL_M, lineCells } from '../core/grid.js';
import { planTunnel, buildTunnel, TUNNEL_MAX, TUNNEL_COST } from '../sim/tunnels.js';

const onTrack = (s, i) => s.rail[i] && !s.railH[i];

registerTool('tunnel', {
  enter(app, t) { t.start = null; t.layer = 'rail'; },
  exit(app) { app.preview.clearCells(); },
  options(app, t, el) {
    el.innerHTML = `<h4>🚇 Railway tunnel</h4>
      <p class="muted">${t.start != null ? 'Now click where it comes out.' : 'Click a railway track where the tunnel goes in.'} It runs straight underground, up to ${TUNNEL_MAX} cells (${TUNNEL_MAX * CELL_M} m), under hills, water, buildings and roads: nothing above it is touched. Trains take it on their way. Right click or Esc to pick a new start.</p>
      <div class="row"><span class="k">Cost</span><span>about ${money(TUNNEL_COST + 120)}+ per cell</span></div>`;
  },
  hover(app, t, p) {
    const s = app.state, i = idx(p.cx, p.cy);
    if (t.start == null) {
      const ok = onTrack(s, i);
      app.preview.setCells([[p.cx, p.cy, ok ? '#ffb84f' : '#ff4a3a']]);
      app.tools.showTip(ok ? 'Tunnel · click to start here' : '<span class="bad">Start on a railway</span>');
      return;
    }
    const plan = planTunnel(s, t.layer, t.start, i);
    app.preview.setCells(lineCells(t.start % N, (t.start / N) | 0, p.cx, p.cy).map(([x, y]) => [x, y, plan.reason ? '#ff4a3a' : '#ffb84f']));
    const afford = s.options.unlimitedMoney || s.money >= plan.cost;
    app.tools.showTip(plan.reason ? `<span class="bad">${plan.reason}</span>` : `🚇 ${Math.round(plan.len)} cells (${Math.round(plan.len * CELL_M)} m) · <span class="${afford ? '' : 'bad'}">${money(plan.cost)}</span>`);
  },
  up(app, t, a, p) {
    const s = app.state, i = idx(p.cx, p.cy);
    if (t.start == null) {
      if (!onTrack(s, i)) { app.toast('Start the tunnel on a railway', 'warn'); return; }
      t.start = i;
      app.tools.renderOptions();
      return;
    }
    const res = buildTunnel(s, planTunnel(s, t.layer, t.start, i));
    if (res.error) { app.toast(res.error, 'bad', "Can't bore this tunnel"); return; }
    app.toast(`${Math.round(res.tunnel.len)} cells · ${money(res.tunnel.cost)}`, 'good', '🚇 Tunnel open');
    t.start = null;
    app.tools.renderOptions();
    app.preview.clearCells();
  },
  cancel(app, t) {
    if (t.start == null) return false;
    t.start = null;
    app.tools.renderOptions();
    app.preview.clearCells();
    return true;
  },
});
