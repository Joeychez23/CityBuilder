// Transportation: traffic simulation, visible vehicles, transport buildings, line tool and
// the transport lines panel.
import { registerSystem } from '../sim/simulation.js';
import { trafficStep, roadsHourly, rebuildTripPools } from '../sim/traffic.js';
import { parkingDaily } from '../sim/parking.js';
import { transitDaily, createLine, stopCellFor, depotOK, computeLinePath, maxVehicles, passableFor, LINE_COLORS, SCHEDULES, lineUpkeep } from '../sim/transit.js';
import { astar } from '../sim/pathfind.js';
import { TRANSPORT_LIST, LINE_TYPES } from '../data/transport.js';
import { SERVICE_CATS } from '../data/services.js';
import { registerCategory } from '../ui/toolbar.js';
import { registerTool, money } from '../ui/tools.js';
import { registerPanel, row, meter, pct } from '../ui/panels.js';
import { createVehiclesView } from '../world/vehiclesView.js';
import { createPeopleView } from '../world/peopleView.js';
import { bus } from '../core/events.js';
import { N } from '../core/grid.js';
import { perWeek } from '../sim/economy.js';
import { serviceTipRows } from './servicesFeature.js';

// ------------------------------------------------------------------- line tool
registerTool('line', {
  enter(app, t) { t.stops = []; app.setLayerHint?.(t.lineType === 'subway' ? 'subway' : null, true); },
  exit(app, t) { app.preview.clearCells(); app.setLayerHint?.('subway', false); },
  options(app, t, el) {
    const d = LINE_TYPES[t.lineType];
    el.innerHTML = `<h4>New ${d.name} line</h4><div class="muted">Click ${d.station ? 'stations' : 'roads'} in order to add stops. Click the first stop again (or press Enter) to finish. Backspace removes the last stop.</div>
      ${row('Stops', t.stops?.length || 0)}${depotOK(app.state, t.lineType) ? '' : `<p class="bad">Build a ${d.station ? 'station' : 'depot'} first.</p>`}`;
  },
  draw(app, t, hoverCell) {
    const s = app.state;
    const pass = passableFor(s, t.lineType);
    const cells = [];
    const pts = hoverCell >= 0 ? [...t.stops, hoverCell] : t.stops;
    for (let k = 0; k + 1 < pts.length; k++) {
      const seg = astar(pts[k], pts[k + 1], pass, () => 1, 1, 20000);
      for (const c of seg || []) cells.push([c % N, (c / N) | 0, seg ? t.color : '#ff4a3a']);
    }
    for (const c of t.stops) cells.push([c % N, (c / N) | 0, '#ffffff']);
    app.preview.setCells(cells);
  },
  hover(app, t, p) {
    const cell = stopCellFor(app.state, t.lineType, p.cy * N + p.cx);
    this.draw(app, t, cell);
    app.tools.showTip(cell >= 0 ? `Add stop ${t.stops.length + 1}` : `<span class="bad">Not a valid ${LINE_TYPES[t.lineType].station ? 'station' : 'stop location'}</span>`);
  },
  up(app, t, a, p) {
    const cell = stopCellFor(app.state, t.lineType, p.cy * N + p.cx);
    if (cell < 0) return;
    if (t.stops.length >= 2 && cell === t.stops[0]) return this.finish(app, t);
    if (t.stops[t.stops.length - 1] !== cell) t.stops.push(cell);
    app.tools.renderOptions();
    this.draw(app, t, -1);
  },
  key(app, t, e) {
    if (e.key === 'Enter') this.finish(app, t);
    if (e.key === 'Backspace') { t.stops.pop(); this.draw(app, t, -1); app.tools.renderOptions(); }
  },
  cancel(app, t) {
    if (!t.stops?.length) return false;
    t.stops = [];
    app.preview.clearCells();
    app.tools.renderOptions();
    return true;
  },
  finish(app, t) {
    const s = app.state;
    if (t.stops.length < 2) { app.toast('A line needs at least two stops', 'warn'); return; }
    if (!depotOK(s, t.lineType)) { app.toast(`Build a ${LINE_TYPES[t.lineType].station ? 'station' : 'depot'} first`, 'bad'); return; }
    const line = createLine(s, app.ctx, t.lineType, [...t.stops]);
    if (line.type === 'bus' || line.type === 'tram') for (const c of line.stops) s.stops[c] = { type: line.type };
    if (!line.valid) app.toast(line.problem, 'bad', `${line.name} can't run`);
    else app.toast(`${line.stops.length} stops · ${line.length} cells`, 'good', `${line.name} created`);
    bus.emit('network:changed', { layer: 'stops' });
    bus.emit('xp', { amount: 10, reason: 'transit' });
    t.stops = [];
    t.color = LINE_COLORS[s.lines.length % LINE_COLORS.length];
    app.preview.clearCells();
    app.tools.renderOptions();
  },
});

// ------------------------------------------------------------------ panel
registerPanel({
  key: 'transport', icon: '🚌', title: 'Transportation', order: 30,
  render(app, body, st, rerender) {
    const s = app.state;
    const S = s.stats;
    const acc = S.transitAccess || {};
    let html = `${row('Traffic flow', pct(S.trafficFlow ?? 1), (S.trafficFlow ?? 1) < 0.6 ? 'bad' : 'good')}
      ${row('Transit riders (yesterday)', Math.round(S.transitRiders || 0).toLocaleString())}
      ${row('Active lines', S.activeLines || 0)}${row('Taxis available', Math.round(app.ctx.taxis || 0))}
      ${row('Cargo capacity', `${S.cargoCapacity || 0} t`)}
      ${row('Outside travel', `${acc.rail ? '🚆' : ''}${acc.ship ? '🚢' : ''}${acc.air ? '✈️' : ''} 🛣️`)}
      ${row('Vehicles · people on screen', `${app.vehicles.count()} · ${app.people.count()}`)}
      ${row('Parking spaces used', `${S.parking?.used || 0} / ${S.parking?.spaces || 0} in ${S.parking?.lots || 0} lots`)}
      ${S.parking?.fullLots ? row('Full lots', `<span class="warn">${S.parking.fullLots}</span>`) : ''}
      ${S.parking?.walking ? row('Walk to work (no space)', `<span class="warn">${S.parking.walking}</span>`) : ''}
      ${S.parking?.carsWithoutSpace > (S.parking?.walking || 0) ? row("Commuters who can't park", `<span class="bad">${S.parking.carsWithoutSpace - (S.parking.walking || 0)}</span>`) : ''}
      ${row('Toll booths', `${app.ctx.tollBooths || 0} · ₡${s.fees.toll ?? 3} per vehicle`)}
      <div class="section-title">Lines</div>`;
    if (!s.lines.length) html += '<div class="muted">No lines yet. Build a depot or station, then use the line tools in Transportation.</div>';
    body.innerHTML = html;
    for (const line of s.lines) {
      const el = document.createElement('div');
      el.className = 'list-item';
      const max = maxVehicles(s, line.type);
      el.innerHTML = `<div class="row"><b><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${line.color};margin-right:6px"></span>
        <input type="text" value="${line.name}" style="width:150px" data-k="name"></b>
        <span><button class="btn" data-a="show" title="Show on map">👁</button> <button class="btn" data-a="del" title="Delete line">🗑</button></span></div>
        ${line.valid ? '' : `<div class="bad">${line.problem || 'Route broken'}</div>`}
        ${row('Stops · length', `${line.stops.length} · ${line.length || 0} cells`)}
        ${row('Riders yesterday', line.riders.toLocaleString())}
        <div class="row"><span class="k">Usage</span>${meter(line.usage, line.usage > 0.9 ? 'var(--bad)' : 'var(--good)')}<span class="num" style="width:40px;text-align:right">${pct(line.usage)}</span></div>
        <label class="row"><span class="k">Vehicles</span><span><input type="range" min="0" max="${Math.max(1, max)}" value="${line.vehicles}" data-k="vehicles" style="width:110px"> <b>${line.vehicles}</b></span></label>
        <label class="row"><span class="k">Ticket price</span><span><input type="range" min="0" max="10" value="${line.ticket}" data-k="ticket" style="width:110px"> <b>₡${line.ticket}</b></span></label>
        <label class="row"><span class="k">Runs</span><select data-k="schedule">${Object.entries(SCHEDULES).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('')}</select></label>
        ${row('Upkeep', `${money(perWeek(lineUpkeep(line)))}/wk <span class="muted">· ${(SCHEDULES[line.schedule] || SCHEDULES.both).hours} h a day</span>`)}`;
      el.querySelector('select').value = line.schedule;
      el.querySelectorAll('[data-k]').forEach((inp) => inp.addEventListener('change', () => {
        const k = inp.dataset.k;
        line[k] = k === 'name' || k === 'schedule' ? inp.value : +inp.value;
        rerender();
      }));
      el.querySelector('[data-a="show"]').onclick = () => app.preview.setCells(line.path?.map((c) => [c % N, (c / N) | 0, line.color]) || []);
      el.querySelector('[data-a="del"]').onclick = () => {
        s.lines = s.lines.filter((l) => l !== line);
        for (const c of line.stops) if (!s.lines.some((l) => l.stops.includes(c))) delete s.stops[c];
        bus.emit('network:changed', { layer: 'stops' });
        rerender();
      };
      body.appendChild(el);
    }
  },
});

export const transportFeature = {
  init(app) {
    const { state } = app;
    app.vehicles = createVehiclesView(app.view, state);
    app.people = createPeopleView(app);
    app.vehicles.onStop = app.people.onStop;
    // parking is worked out daily; also right away when lots or workplaces change
    let parkingSoon = null;
    const replan = () => { clearTimeout(parkingSoon); parkingSoon = setTimeout(() => parkingDaily(state, app.ctx), 300); };
    bus.on('building:add', (b) => { if (b.def.parking) replan(); });
    bus.on('building:remove', (b) => { if (b.def.parking) replan(); });
    replan();
    registerSystem({ name: 'traffic', every: 'step', run: trafficStep });
    registerSystem({ name: 'roads', every: 'hour', run: roadsHourly });
    registerSystem({ name: 'trip-pools', every: 'day', run: rebuildTripPools });
    registerSystem({ name: 'transit', every: 'day', run: transitDaily });
    registerSystem({ name: 'parking', every: 'day', run: parkingDaily });
    // Lines re-route when the network changes
    bus.on('network:recomputed', () => { for (const l of state.lines) computeLinePath(state, app.ctx, l); });
    bus.on('building:remove', () => { app.ctx.trips = null; });
    // Road colours follow snow, wear and accidents
    let steps = 0;
    bus.on('step', () => { if (++steps % 6 === 0) app.networks.recolorRoads(); });
    bus.on('accident', ({ cell }) => {
      if (Math.random() < 0.3) app.toast(`Traffic accident near (${cell % N}, ${(cell / N) | 0})`, 'warn');
      state.journal.push({ day: state.time.day, kind: 'accident', text: 'Traffic accident' });
    });

    const cat = SERVICE_CATS.transport;
    registerCategory({
      key: 'transport', icon: cat.icon, name: 'Transport', order: cat.order,
      items: () => [
        ...TRANSPORT_LIST.map((d) => ({
          group: d.group || 'Buildings', name: d.name, color: cat.color, desc: d.desc, tipRows: serviceTipRows(d),
          meta: `${money(d.cost)} · ${money(perWeek(d.upkeep))}/wk`,
          tool: { kind: 'plop', def: d }, isActive: (t) => t.kind === 'plop' && t.def === d,
          locked: () => app.lockReason(d),
        })),
        ...Object.entries(LINE_TYPES).map(([k, d]) => ({
          group: 'Lines', name: `${d.name} line`, color: d.color,
          desc: `${d.station ? 'Click stations in order' : 'Click roads in order to place stops'}, then the first stop again to finish. Riders walk to the stops; each ${d.name.toLowerCase()} carries ${d.capacity}. Set how many run and when in the Transportation panel: a line only costs upkeep for the hours it runs.`,
          meta: `${d.station ? 'Click stations' : 'Click roads'} · ${money(perWeek(d.upkeep))}/wk per vehicle running all day`,
          tool: { kind: 'line', lineType: k, color: LINE_COLORS[state.lines.length % LINE_COLORS.length] },
          isActive: (t) => t.kind === 'line' && t.lineType === k,
          locked: () => app.lockReason(d),
        })),
        { group: 'Tracks', name: 'Railway', color: '#9b8b77', meta: '₡120/cell', tool: { kind: 'layer', layer: 'rail', label: 'Railway' }, isActive: (t) => t.layer === 'rail', locked: () => app.lockReason({ milestone: 5, devNode: 'transit_train' }) },
        { group: 'Tracks', name: 'Railway bridge', color: '#9b8b77', meta: '₡360/cell span · click start, then end', tool: { kind: 'bridge', kindKey: 'rail' }, isActive: (t) => t.kind === 'bridge' && t.kindKey === 'rail', locked: () => app.lockReason({ milestone: 5, devNode: 'transit_train' }) },
        { group: 'Tracks', name: 'Railway tunnel', color: '#9b8b77', meta: '₡820+/cell · portal to portal', desc: 'Bore a railway tunnel between two stretches of track, straight under hills, water or town (up to 512 m). Trains take it on their way.', tool: { kind: 'tunnel', layer: 'rail' }, isActive: (t) => t.kind === 'tunnel' && t.layer === 'rail', locked: () => app.lockReason({ milestone: 11 }) },
        { group: 'Tracks', name: 'Subway tunnel', color: '#b06be0', meta: '₡300/cell · underground', tool: { kind: 'layer', layer: 'subway', label: 'Subway tunnel' }, isActive: (t) => t.layer === 'subway', locked: () => app.lockReason({ milestone: 8, devNode: 'transit_subway' }) },
      ],
    });
  },
  frame(app, dt) {
    const show = app.vehiclesEnabled !== false && app.layers?.traffic !== false;
    app.vehicles.setVisible(show);
    app.vehicles.update(dt);
    app.people.setVisible(show);
    app.people.update(dt);
  },
};
