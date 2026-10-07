// Electricity panel (opened from ⚡ in the top bar): how much power the city needs right now
// against what's available, where it comes from, who uses it, and each separate network, so
// it's clear which part of town is short or has no source at all.
import { registerPanel, row, meter, pct } from '../ui/panels.js';
import { money } from '../ui/tools.js';
import { bus } from '../core/events.js';

export const mw = (v) => (v < 1 ? `${Math.round(v * 1000).toLocaleString()} kW` : `${v.toFixed(1)} MW`);
const CAT = { res: ['🏠', 'Homes'], com: ['🛍️', 'Shops'], ind: ['🏭', 'Industry'], off: ['🏢', 'Offices'], services: ['🏛️', 'City services'] };

registerPanel({
  key: 'power', icon: '⚡', title: 'Electricity', order: 16, rail: false,
  render(app, body) {
    const s = app.state;
    const u = s.stats.utilities || {};
    const need = u.consumed || 0;
    const made = u.produced || 0, bat = u.batteryOut || 0, imp = u.imported || 0;
    const have = made + bat + imp;
    const short = (app.ctx.elecNets || []).filter((n) => n.demand > 0 && n.ratio < 0.995);
    const outside = s.connections.find((c) => c.type === 'power');
    const outsideNet = (app.ctx.elecNets || []).find((n) => n.outside);
    let html = `<button class="btn ${app.infoViews?.current?.key === 'electricity' ? 'primary' : ''}" data-grid style="float:right">⚡ ${app.infoViews?.current?.key === 'electricity' ? 'Hide' : 'Show'} the grid</button>
      <div class="bigstat"><b class="${need > have + 0.01 ? 'bad' : ''}">${mw(need)}</b><span>needed right now<br>of ${mw(have)} available</span></div>
      ${meter(have ? need / have : need ? 1 : 0, need > have + 0.01 ? 'var(--bad)' : 'var(--yellow)')}
      <div class="muted" style="font-size:11px;margin:6px 0 2px">Use rises when it's cold or hot (heating and cooling) and with the electricity fee. Buildings short of power go dark at night and their people get upset.</div>
      <div class="section-title">Sources</div>`;
    const plants = [...s.buildings.values()].filter((b) => b.def.power);
    html += plants.length ? plants.map((b) => row(`${b.name || b.def.name}`, `${mw(b.output || 0)} <span class="muted">/ ${mw(b.def.power)}</span>`)).join('') : '<div class="muted">No power plants yet.</div>';
    if (u.batteryCap) html += row('Batteries', `${mw(bat)} out · ${Math.round(u.battery || 0)} / ${u.batteryCap} MWh`);
    html += row('Bought from neighbours', imp ? `${mw(imp)} · ${money(imp * 260)}/day` : outsideNet ? 'not needed' : '<span class="warn">not connected</span>');
    if (!outsideNet && outside) html += '<div class="muted" style="font-size:11px">Run a power line from the outside power line (pylons at the map edge) to buy power when you\'re short.</div>';
    if (u.exported) html += row('Sold to neighbours', mw(u.exported));
    html += '<div class="section-title">Who uses it</div>';
    for (const [k, [ico, name]] of Object.entries(CAT)) {
      const v = u.byCat?.[k] || 0;
      if (v) html += `<div class="row"><span class="k">${ico} ${name}</span>${meter(need ? v / need : 0, 'var(--blue)')}<span class="num" style="width:70px;text-align:right">${mw(v)}</span></div>`;
    }
    html += `<div class="section-title">Networks (${(app.ctx.elecNets || []).length})</div><div class="muted" style="font-size:11px;margin-bottom:4px">Roads carry power to the buildings beside them, and plants feed the roads they touch. A separate network needs its own plant, or a power line ending on one of its roads (through a Power Connector).</div>`;
    body.innerHTML = html;
    body.querySelector('[data-grid]').onclick = () => { app.setPowerView(app.infoViews.current?.key !== 'electricity'); app.panels.refresh('power'); };
    for (const n of (app.ctx.elecNets || []).slice(0, 12)) {
      const el = document.createElement('div');
      el.className = `list-item ${n.ratio >= 0.995 ? 'done' : ''}`;
      if (n.ratio < 0.995) el.style.borderLeftColor = 'var(--bad)';
      const status = !n.hasSource ? '<span class="bad">no source</span>' : n.ratio < 0.995 ? `<span class="bad">${pct(n.ratio)} supplied</span>` : '<span class="good">OK</span>';
      el.innerHTML = `<div class="row"><b>${n.buildings} building${n.buildings === 1 ? '' : 's'}${n.outside ? ' · outside line' : ''}</b>${status}</div>
        ${row('Needs · made here', `${mw(n.demand)} · ${mw(n.produced)}`)}${n.imported ? row('Bought', mw(n.imported)) : ''}
        ${n.sample ? '<button class="btn" data-go>Show</button>' : ''}`;
      el.querySelector('[data-go]')?.addEventListener('click', () => {
        const b = s.buildings.get(n.sample);
        if (b) { app.focusOn((b.x0 + b.x1 + 1) / 2, (b.y0 + b.y1 + 1) / 2); bus.emit('select', { type: 'building', id: b.id }); }
      });
      body.appendChild(el);
    }
    if (short.length) body.insertAdjacentHTML('beforeend', `<div class="bad" style="margin-top:6px">${short.length} network${short.length === 1 ? ' is' : 's are'} short of power.</div>`);
  },
});

export const powerPanel = {};
