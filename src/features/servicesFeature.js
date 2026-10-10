// Wires city services into the game: simulation systems, build menus, notifications.
import { registerSystem } from '../sim/simulation.js';
import { computeCoverage, hourlyCollections, isService } from '../sim/services.js';
import { computeUtilities } from '../sim/utilities.js';
import { registerCategory } from '../ui/toolbar.js';
import { SERVICE_CATS, SERVICE_LIST } from '../data/services.js';
import { money } from '../ui/tools.js';
import { bus } from '../core/events.js';
import '../ui/toolsPlop.js';
import '../ui/toolsLandfill.js';
import { garbageStep, garbageDaily } from '../sim/garbage.js';
import { perWeek } from '../sim/economy.js';
import { parkReach } from '../sim/parking.js';
import { createSewageView } from '../world/sewageView.js';
import { emergencyStep, patrolsHourly, ambulancesHourly, dispatch } from '../sim/emergency.js';
import { crimeHourly } from '../sim/wellbeing.js';

// Buildings produce garbage and mail every hour; collection happens in hourlyCollections.
function produceWaste(state) {
  const recycling = (d) => d?.policies?.recycling;
  const filters = state.policies.pollutionManagement ? 1.15 : 1;
  for (const b of state.buildings.values()) {
    if (isService(b) || b.abandoned) continue;
    const hh = b.households?.length || 0;
    const w = b.workerCount || 0;
    let g = hh * 0.0045 + w * (b.def.cat === 'ind' ? 0.006 : 0.003);
    if (b.def.cat === 'ind') g *= filters;
    if (b.district && recycling(state.districts.find((d) => d.id === b.district))) g *= 0.8;
    b.garbage = (b.garbage || 0) + g;
    b.garbageRate = g; // tonnes an hour, for telling a late pickup from a missed one
    b.mailOut = (b.mailOut || 0) + (hh * 1 + w * 0.5) / 24;
  }
}

// Service buildings are staffed by citizens (matched like any job) plus commuters from
// neighbouring cities when the highway is connected.
function staffServices(state, ctx) {
  for (const b of state.buildings.values()) {
    if (!isService(b) || !b.def.workers) continue;
    const open = Math.max(0, b.def.workers - (b.workers?.length || 0));
    const comp = b.comp ?? -1;
    const commuters = comp >= 0 && ctx.net.roadOutside[comp] ? Math.ceil(open * 0.6) : 0;
    b.staff = (b.workers?.length || 0) + commuters;
    b.workerCount = b.staff;
  }
}

// The numbers worth knowing about a service building, for its hover tip
export function serviceTipRows(d) {
  const rows = [];
  if (d.area) rows.push(['Cost', `${money(d.cost)} + ${money(d.perCell)} per cell`], ['Holds', `${d.storagePerCell} t per cell`]);
  else rows.push(['Cost', money(d.cost)], ['Upkeep', `${money(perWeek(d.upkeep || 0))}/wk`]);
  if (d.radius) rows.push(['Reach', `${d.radius * 8} m`]);
  if (d.power) rows.push(['Power', `${d.power} MW`]);
  if (d.battery) rows.push(['Stores', `${d.battery} MWh`]);
  if (d.water) rows.push(['Water', `${d.water.toLocaleString()} m³ a day`]);
  if (d.sewage) rows.push(['Sewage', `${d.sewage.toLocaleString()} m³ a day`]);
  if (d.patients) rows.push(['Patients', `${d.patients} a day`]);
  if (d.deathRate) rows.push(['Deceased', `${d.deathRate} a day`]);
  if (d.rooms) rows.push(['Rooms', `${d.rooms} · ${money(d.roomRate)} a night`]);
  if (d.students) rows.push(['Students', d.students]);
  if (d.engines) rows.push(['Fire engines', d.engines]);
  if (d.cells || d.prison) rows.push(['Cells', d.cells || d.prison]);
  if (d.trucks) rows.push(['Garbage trucks', d.trucks]);
  if (d.parking) rows.push(['Parking', `${d.parking} cars`], ['Walk to work', `up to ${parkReach(d) * 8} m`]);
  if (d.vehicles) rows.push(['Vehicles', d.vehicles]);
  if (d.workers) rows.push(['Workers', d.workers]);
  if (d.pollution) rows.push(['Pollution', Object.keys(d.pollution).join(', ')]);
  return rows;
}

// Network tools that live in the service menus
const EXTRA_ITEMS = {
  electricity: [
    { group: 'Network', name: 'Power line', color: '#ffd34f', meta: 'From a plant to a road · pylons span up to 8 cells', desc: 'Start on a power plant (or a road, a pylon or the outside line) and click your way to a road: the line feeds that road\'s network through a Power Connector. Roads carry power to every building beside them.', tool: { kind: 'powerline' }, isActive: (t) => t.kind === 'powerline' },
    { group: 'Network', name: 'Power Connector', color: '#4f7a52', meta: '₡1,500 · a transformer on a road', desc: 'Put it on a road next to a power line\'s pylon (or end a power line on a road): it feeds the line\'s power into that road and every building along it.', tool: { kind: 'upgrade', bit: 128, key: 'power' }, isActive: (t) => t.kind === 'upgrade' && t.bit === 128 },
  ],
  water: [{ group: 'Network', name: 'Water pipe', color: '#3aa0ff', meta: '₡10/cell · roads carry pipes too', tool: { kind: 'layer', layer: 'pipe', label: 'Water pipe' }, isActive: (t) => t.layer === 'pipe' }],
};

export const servicesFeature = {
  init(app) {
    const { state } = app;
    registerSystem({ name: 'staff', every: 'day', run: staffServices });
    registerSystem({ name: 'waste', every: 'hour', run: produceWaste });
    registerSystem({ name: 'collections', every: 'hour', run: hourlyCollections });
    registerSystem({ name: 'garbage-trucks', every: 'step', run: garbageStep });
    registerSystem({ name: 'garbage-day', every: 'day', run: garbageDaily });
    registerSystem({ name: 'utilities', every: 'hour', run: computeUtilities });
    registerSystem({ name: 'lights', every: 'hour', run: () => { app.buildings.refreshLights(); app.networks.refreshLamps(app.ctx); app.sewage.dirty = true; } });
    app.sewage = createSewageView(app.view, state, app.ctx);
    registerSystem({ name: 'coverage', every: 'hour', run: computeCoverage });
    registerSystem({ name: 'emergency', every: 'step', run: emergencyStep });
    // call the fire department the moment a fire starts
    bus.on('fire', ({ b }) => { if (!(app.ctx.incidents || []).some((x) => x.kind === 'fire' && x.target === b.id)) b.noHelp = !dispatch(state, app.ctx, 'fire', b); });
    registerSystem({ name: 'crime', every: 'hour', run: crimeHourly });
    registerSystem({ name: 'patrols', every: 'hour', run: patrolsHourly });
    registerSystem({ name: 'ambulances', every: 'hour', run: ambulancesHourly });

    // Recompute right away when services or networks change, so the player sees the effect
    const refresh = () => { app.ctx.servicesDirty = true; };
    bus.on('services:changed', refresh);
    bus.on('building:add', (b) => { if (isService(b)) refresh(); });
    bus.on('building:remove', (b) => { if (isService(b)) refresh(); });
    bus.on('network:recomputed', refresh);

    for (const [key, cat] of Object.entries(SERVICE_CATS)) {
      if (key === 'transport') continue; // added by the transport feature
      registerCategory({
        key, icon: cat.icon, name: cat.name.split(' ')[0], order: cat.order,
        items: () => [...SERVICE_LIST.filter((s) => s.cat === key).map((s) => ({
          group: s.group || cat.name, name: s.name, color: cat.color,
          meta: s.area ? `Draw an area · ${money(s.perCell)}/cell · ${s.storagePerCell} t/cell` : `${money(s.cost)} · ${money(perWeek(s.upkeep))}/wk${s.power ? ` · ${s.power} MW` : ''}${s.water ? ` · ${s.water.toLocaleString()} m³` : ''}${s.sewage ? ` · ${s.sewage.toLocaleString()} m³` : ''}${s.rooms ? ` · ${s.rooms} rooms` : ''}`,
          desc: s.desc,
          tipRows: serviceTipRows(s),
          tool: s.area ? { kind: 'landfill', def: s } : { kind: 'plop', def: s },
          isActive: (t) => (t.kind === 'plop' || t.kind === 'landfill') && t.def === s,
          locked: () => app.lockReason(s),
        })), ...(EXTRA_ITEMS[key] || [])],
      });
    }
    computeCoverage(state, app.ctx);
  },
  frame(app, dt) {
    app.sewage.update(dt);
    if (app.ctx.servicesDirty) {
      app.ctx.servicesDirty = false;
      computeCoverage(app.state, app.ctx);
      computeUtilities(app.state, app.ctx, { preview: true });
      app.buildings.refreshLights();
      app.networks.refreshLamps(app.ctx);
      app.sewage.dirty = true;
    }
  },
};
