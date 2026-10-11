// Power line tool. Start the line on a power plant (the wire runs from the plant), on a road
// (it gets a Power Connector), on an existing pylon, or by placing a pylon next to a source.
// Then keep clicking: open land gets pylons (long stretches get extra ones), a road gets a
// Power Connector that feeds the line into that road's network, and a plant gets the wire
// run to it. Click the last pylon again, press Enter or right click to finish the line.
import { registerTool, money } from './tools.js';
import { idx } from '../core/grid.js';
import { planPowerLine, buildPowerLine, placePylon, pylonBlocker, pylonSourceReason, terminalAt, hasConnector, PYLON_COST, MAX_SPAN, CONNECTOR } from '../sim/power.js';
import { spend, isOwned } from '../sim/build.js';
import { UPG } from '../data/roads.js';
import { setCellUpgrade } from '../sim/roadnet.js';
import { bus } from '../core/events.js';

const plantName = (s, i) => { const b = s.buildings.get(s.bld[i]); return b ? b.name || b.def.name : 'the plant'; };

registerTool('powerline', {
  enter(app, t) { t.last = null; app.setPowerView?.(true); },
  exit(app) { app.power.clearPreview(); app.preview.clearCells(); app.setPowerView?.(false); },
  options(app, t, el) {
    el.innerHTML = `<h4>⚡ Power line</h4><p class="muted">${t.last == null
      ? 'Start at a <b>power plant</b> (click it), on a <b>road</b>, on an existing pylon, or on the outside power line.'
      : 'Click open land to run wires on, a <b>road</b> to feed the line into its network (a Power Connector is added), or a <b>plant</b> to connect to it. Click the last pylon again, press Enter or right click to finish.'}
      Roads carry power to every building beside them; a power line only reaches a road through a Power Connector.
      Wires span up to ${MAX_SPAN} cells between pylons and pass over roads, rails, water and buildings.</p>
      <div class="row"><span class="k">Pylon</span><span>${money(PYLON_COST)}</span></div>
      <div class="row"><span class="k">Power Connector</span><span>${money(CONNECTOR.cost)}</span></div>`;
  },
  hover(app, t, p) {
    const s = app.state;
    const i = idx(p.cx, p.cy);
    const term = s.power[i] ? null : terminalAt(s, i);
    if (t.last == null) {
      app.power.clearPreview();
      if (s.power[i]) { app.preview.setCells([[p.cx, p.cy, '#ffd34f']]); app.tools.showTip('Extend from this pylon'); return; }
      if (term === 'building') { app.preview.setCells([[p.cx, p.cy, '#ffd34f']]); app.tools.showTip(`Start the line at ${plantName(s, i)}`); return; }
      if (term === 'road') {
        const ok = isOwned(s, p.cx, p.cy);
        app.preview.setCells([[p.cx, p.cy, ok ? '#ffd34f' : '#ff4a3a']]);
        app.tools.showTip(!ok ? '<span class="bad">Not your land</span>' : hasConnector(s, i) ? 'Start at this Power Connector' : `Start from this road · adds a Power Connector (${money(CONNECTOR.cost)})`);
        return;
      }
      const reason = pylonBlocker(s, p.cx, p.cy) || pylonSourceReason(s, app.ctx, p.cx, p.cy);
      app.preview.setCells([[p.cx, p.cy, reason ? '#ff4a3a' : '#ffd34f']]);
      app.tools.showTip(reason ? `<span class="bad">${reason}</span>` : `Place a pylon · ${money(PYLON_COST)}`);
      return;
    }
    app.preview.clearCells();
    if (i === t.last) { app.power.clearPreview(); app.tools.showTip('Click to finish this line'); return; }
    const plan = planPowerLine(s, t.last, p.cx, p.cy);
    app.power.setPreview(plan.chain || [t.last, i], plan.pylons || [], plan.ok);
    const what = plan.end === 'road' ? `feeds this road${plan.connector != null ? ` (Power Connector ${money(CONNECTOR.cost)})` : ''}` : plan.end === 'building' ? `connects to ${plantName(s, i)}` : `${plan.pylons.length} new pylon${plan.pylons.length === 1 ? '' : 's'}`;
    app.tools.showTip(plan.ok ? `${what} · ${plan.spans.length} span${plan.spans.length === 1 ? '' : 's'} · ${money(plan.cost)}` : `<span class="bad">${plan.reason}</span>`);
  },
  up(app, t, a, p) {
    const s = app.state;
    const i = idx(p.cx, p.cy);
    if (t.last == null) {
      if (s.power[i]) { t.last = i; app.tools.renderOptions(); return; }
      const term = terminalAt(s, i);
      if (term === 'building') { t.last = i; app.tools.renderOptions(); return; }
      if (term === 'road') {
        if (!isOwned(s, p.cx, p.cy)) { app.toast('Not your land', 'bad'); return; }
        if (!hasConnector(s, i)) {
          if (!spend(s, CONNECTOR.cost, 'electricity')) { app.toast('Not enough money', 'bad'); return; }
          setCellUpgrade(s, i, UPG.POWER, true);
        }
        t.last = i;
        app.tools.renderOptions();
        return;
      }
      const res = placePylon(s, p.cx, p.cy, app.ctx);
      if (res.error) { app.toast(res.error, 'bad'); return; }
      t.last = res.pylon;
      app.tools.renderOptions();
      return;
    }
    if (i === t.last) { this.finish(app, t); return; }
    const plan = planPowerLine(s, t.last, p.cx, p.cy);
    if (!plan.ok) { app.toast(plan.reason, 'bad'); return; }
    if (!buildPowerLine(s, plan)) { app.toast('Not enough money', 'bad'); return; }
    app.power.clearPreview();
    // reaching a road or a plant ends the line there; otherwise keep going from the new pylon
    if (plan.end) {
      app.toast(plan.end === 'road' ? 'The line now feeds this road\'s network.' : `Connected to ${plantName(s, plan.chain[plan.chain.length - 1])}.`, 'good', '⚡ Power line connected');
      this.finish(app, t);
      return;
    }
    t.last = plan.chain[plan.chain.length - 1];
  },
  key(app, t, e) { if (e.key === 'Enter' || e.key === 'Backspace') this.finish(app, t); },
  cancel(app, t) { if (t.last == null) return false; this.finish(app, t); return true; },
  finish(app, t) { t.last = null; app.power.clearPreview(); app.tools.renderOptions(); },
});
