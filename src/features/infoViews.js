// The 33 info views: each one colours the ground (heatmap), buildings and/or roads to show
// one aspect of the city, with a legend and a few headline numbers.
import * as THREE from 'three';
import { registerPanel, row, pct } from '../ui/panels.js';
import { ramp, rampCss } from '../world/overlays.js';
import { ROADS } from '../data/roads.js';
import { RESOURCES } from '../data/resources.js';
import { N } from '../core/grid.js';
import { isService, storageCap } from '../sim/services.js';
import { bus } from '../core/events.js';
import { money } from '../ui/tools.js';
import { flowNames } from '../sim/utilities.js';
import { congestion } from '../sim/traffic.js';
import { UPG } from '../data/roads.js';

const toCss = ([r, g, b]) => `rgb(${r | 0},${g | 0},${b | 0})`;
const bRamp = (name, t) => toCss(ramp(name, t));
const GREY = '#8d9097';
const heat = (layer, name, scale = 1, minA = 0.02) => (state) => (i) => {
  const v = layer(state)[i] * scale;
  if (v < minA) return null;
  const c = ramp(name, v);
  return [c[0], c[1], c[2], 90 + Math.min(1, v) * 120];
};
const coverageHeat = (key, name = 'good') => (state, ctx) => (i) => {
  const v = ctx.coverage[key]?.[i] || 0;
  if (v < 0.02) return state.water[i] ? null : [255, 90, 70, 60];
  const c = ramp(name, Math.min(1, v));
  return [c[0], c[1], c[2], 150];
};
const residents = (state, b) => {
  const out = [];
  for (const hid of b.households || []) for (const cid of state.households.get(hid)?.members || []) { const c = state.citizens.get(cid); if (c) out.push(c); }
  return out;
};
const zoneOnly = (cat, fn) => (state, ctx) => (b) => (b.kind === 'zone' && (!cat || b.def.cat === cat) ? fn(state, ctx, b) : GREY);

// Colour for an electricity network: powered, short of power, or none at all
function gridStatus(ctx) {
  const by = new Map();
  for (const n of ctx.elecNets || []) by.set(n.comp, n);
  return (k) => {
    const n = k != null && k >= 0 ? by.get(k) : null;
    if (!n) return ctx.elecSourced?.has(k) ? '#3fd27a' : '#ff4b3a';
    if (!n.hasSource) return '#ff4b3a';
    return n.ratio >= 0.995 ? '#3fd27a' : '#ffb300';
  };
}

export const INFO_VIEWS = [
  { key: 'roads', icon: '🛣️', name: 'Roads', legend: ['bad', 'Worn', 'Perfect'], road: (s) => (i) => bRamp('good', s.roadCond[i]),
    stats: (s) => row('Parking fee', `₡${s.fees.parking}`) + row('Road cells', s.road.reduce((a, v) => a + (v ? 1 : 0), 0)) },
  { key: 'traffic', icon: '🚦', name: 'Traffic', legend: ['good', 'Free flow', 'Backed up'], road: (s) => (i) => bRamp('bad', congestion(s, i) / 1.4),
    stats: (s) => row('Traffic flow', pct(s.stats.trafficFlow ?? 1)) + (s.stats.worstJam ? row('Worst jam', `${Math.round(s.stats.worstJam.ratio * 100)}% of capacity`, 'bad') : '')
      + '<div class="muted" style="font-size:11px;margin-top:4px">Red roads carry more than they can: queues back up onto the roads leading in. Bigger roads have more lanes; roundabouts move more cars than traffic lights.</div>' },
  { key: 'electricity', icon: '⚡', name: 'Power grid',
    keys: [['#3fd27a', 'Powered'], ['#ffb300', 'Not enough power'], ['#ff4b3a', 'No power'], ['#ffd34f', 'Plant / connector']],
    // every road and building coloured by the network it's on: is it connected, and does it
    // get all the power it needs?
    road: (s, ctx) => { const st = gridStatus(ctx); return (i) => ((s.roadUpg[i] & UPG.POWER) ? '#ffd34f' : st(ctx.elecComp?.[i])); },
    building: (s, ctx) => { const st = gridStatus(ctx); return (b) => (b.def.power ? '#ffd34f' : b.def.battery ? '#ffb000' : b.cons ? GREY : st(b.elecComp)); },
    stats: (s, ctx) => {
      const u = s.stats.utilities || {};
      const nets = ctx.elecNets || [];
      const dead = nets.filter((n) => n.demand > 0 && !n.hasSource).length, short = nets.filter((n) => n.hasSource && n.ratio < 0.995).length;
      let connectors = 0; for (let i = 0; i < s.roadUpg.length; i++) if (s.roadUpg[i] & UPG.POWER) connectors++;
      return row('Production / use', `${(u.produced || 0).toFixed(1)} / ${(u.consumed || 0).toFixed(1)} MW`) + row('Bought from outside', `${(u.imported || 0).toFixed(1)} MW`)
        + row('Battery', `${(u.battery || 0).toFixed(0)} / ${u.batteryCap || 0} MWh`) + row('Separate networks', nets.length) + row('Without a source', dead, dead ? 'bad' : '')
        + row('Short of power', short, short ? 'bad' : '') + row('Power Connectors', connectors) + row('Buildings without power', u.unpowered || 0, u.unpowered ? 'bad' : '')
        + '<div class="muted" style="font-size:11px;margin-top:4px">Roads carry power to every building beside them. Power plants feed the roads they touch; a power line feeds a road only through a Power Connector (end a power line on a road to add one).</div>';
    } },
  { key: 'water', icon: '💧', name: 'Water & Sewage', legend: ['blue', 'Dry', 'Groundwater'], layers: { pipes: true }, heat: heat((s) => s.groundwater, 'blue'),
    building: (s) => (b) => (b.def.water ? '#3aa0ff' : b.def.sewage ? '#8a6a3a' : bRamp('good', Math.min(b.water, b.sewage))),
    stats: (s, ctx) => { const u = s.stats.utilities || {}; const F = flowNames(s); return row('Current flows', `${F.down} ${F.arrow}`) + row('Water pumped / used', `${Math.round(u.waterProduced || 0)} / ${Math.round(u.waterConsumed || 0)} m³`) + row('Sewage handled / produced', `${Math.round(u.sewageTreated || 0)} / ${Math.round(u.sewageProduced || 0)} m³`) + row('Buildings with polluted tap water', u.pollutedWater || 0) + row('Pumps downstream of sewage', (ctx.sewageUpstream || []).length, (ctx.sewageUpstream || []).length ? 'bad' : ''); } },
  { key: 'health', icon: '🏥', name: 'Healthcare & Deathcare', legend: ['good', 'No coverage', 'Covered'], heat: coverageHeat('health'),
    building: zoneOnly(null, (s, c, b) => ((b.dead || 0) > 0 ? '#222' : residents(s, b).some((x) => x.sick) ? '#ff6b81' : bRamp('good', Math.min(1, (b.happiness ?? 60) / 100)))),
    stats: (s) => row('Sick', s.stats.sick || 0) + row('Treated today', s.stats.treated || 0) + row('Deaths today', s.stats.deaths || 0) },
  { key: 'garbage', icon: '🗑️', name: 'Garbage', legend: ['bad', 'Clean', 'Piling up'], heat: coverageHeat('garbage'),
    building: (s) => (b) => (isService(b) && b.def.garbageRate ? '#a3825a' : bRamp('bad', Math.min(1, (b.garbage || 0) / 6))),
    stats: (s, ctx) => ([...s.buildings.values()].filter((b) => b.def.garbageRate).map((b) => row(b.name || b.def.name, `${b.def.storage ? `${Math.round(b.stored || 0).toLocaleString()} / ${Math.round(storageCap(b)).toLocaleString()} t · ` : ''}🚛 ${ctx.trucksOut?.get(b.id) || 0} out`)).join('') || '<div class="muted">No landfills</div>')
      + '<div class="muted" style="font-size:11px;margin-top:4px">Garbage trucks drive out to collect it. Buildings their trucks can\'t reach, or that are out of range, pile up garbage.</div>' },
  { key: 'fire', icon: '🚒', name: 'Fire & Rescue', legend: ['bad', 'Low hazard', 'High hazard'], heat: coverageHeat('fire'),
    building: (s) => (b) => (b.onFire ? '#ff3b1a' : bRamp('bad', Math.min(1, (b.fireHazard || 0) * 500))),
    stats: (s, ctx) => row('Fire danger (dryness)', pct(ctx.dryness || 0)) + row('Burning buildings', [...s.buildings.values()].filter((b) => b.onFire).length) },
  { key: 'disaster', icon: '🌪️', name: 'Disaster Control', legend: ['good', 'Unsheltered', 'Shelter in range'], heat: coverageHeat('shelter'),
    building: (s) => (b) => (b.def.shelter || b.def.warning ? '#4fc3ff' : bRamp('good', b.condition ?? 1)),
    stats: (s) => row('Early warning', [...s.buildings.values()].some((b) => b.def.warning) ? 'Yes' : 'No') + row('Destroyed buildings (ruins)', (s.ruins || []).length) },
  { key: 'police', icon: '🚓', name: 'Police', legend: ['bad', 'Safe', 'High crime'], heat: coverageHeat('police'),
    building: (s) => (b) => (b.def.patrol || b.def.prison ? '#5b8cff' : bRamp('bad', (b.crime || 0) / 100)),
    stats: (s) => row('Crimes today', s.stats.crimes || 0) + row('Jailed / capacity', `${s.stats.jailed || 0} / ${s.stats.jailCap || 0}`) },
  { key: 'admin', icon: '🏛️', name: 'Administration', legend: ['good', 'Unwell', 'Well'], heat: coverageHeat('welfare'),
    building: zoneOnly('res', (s, c, b) => { const r = residents(s, b); return r.length ? bRamp('good', r.reduce((a, x) => a + x.wellbeing, 0) / r.length / 100) : GREY; }),
    stats: (s, ctx) => row('City Hall', ctx.cityHall ? 'Yes (−1% interest)' : 'No') + row('Central Bank', ctx.centralBank ? 'Yes (−2% interest)' : 'No') + row('Well-being', `${Math.round(s.stats.wellbeing ?? 0)}%`) },
  { key: 'education', icon: '🎓', name: 'Education', legend: ['heat', 'Uneducated', 'Highly educated'], heat: coverageHeat('education1'),
    building: zoneOnly('res', (s, c, b) => { const r = residents(s, b).filter((x) => x.age >= 18); return r.length ? bRamp('heat', r.reduce((a, x) => a + x.edu, 0) / r.length / 4) : GREY; }),
    stats: (s) => [...s.buildings.values()].filter((b) => b.def.students).map((b) => row(b.def.name, `${b.studentCount || 0} / ${b.def.students}`)).join('') || '<div class="muted">No schools</div>' },
  { key: 'transport', icon: '🚌', name: 'Transportation', legend: ['purple', 'No transit', 'Near a stop'], layers: { subway: true }, heat: (s, ctx) => (i) => { const v = ctx.transitCov?.[i] || 0; if (v < 0.05) return null; const c = ramp('purple', v); return [c[0], c[1], c[2], 140]; },
    road: (s) => { const lineCells = new Map(); for (const l of s.lines) for (const c of l.path || []) lineCells.set(c, l.color); return (i) => lineCells.get(i) || '#55585f'; },
    stats: (s) => s.lines.map((l) => row(`<span style="color:${l.color}">●</span> ${l.name}`, `${l.riders} riders · ${pct(l.usage)}`)).join('') || '<div class="muted">No lines</div>' },
  { key: 'post', icon: '📮', name: 'Post', legend: ['good', 'No mail service', 'Covered'], heat: coverageHeat('post'),
    building: (s) => (b) => (b.def.mail ? '#e7c34f' : bRamp('bad', Math.min(1, (b.mailOut || 0) / 40))) },
  { key: 'telecom', icon: '📡', name: 'Telecom', legend: ['good', 'No signal', 'Fast internet'], heat: coverageHeat('telecom') },
  { key: 'leisure', icon: '🌳', name: 'Leisure', legend: ['green', 'Nothing to do', 'Lots of leisure'], heat: coverageHeat('leisure', 'green'),
    building: (s) => (b) => (b.def.leisure ? '#5fd38a' : GREY) },
  { key: 'tourism', icon: '📸', name: 'Tourism', legend: ['heat', 'Unattractive', 'Attractive'], heat: coverageHeat('leisure', 'heat'),
    building: (s) => (b) => (b.def.attract || b.def.signature ? bRamp('heat', Math.min(1, (b.def.attract || 8) / 20)) : GREY),
    stats: (s) => row('Attractiveness', s.stats.attractiveness ?? 0) + row('Tourists today', (s.stats.tourists || 0).toLocaleString()) + row('Total visits', s.counters.tourists.toLocaleString()) },
  { key: 'outside', icon: '🌍', name: 'Outside Connections', legend: ['heat', 'Local', 'Trade'],
    heat: (s) => { const set = new Set(); for (const c of s.connections) for (let d = -2; d <= 2; d++) for (let e = -2; e <= 2; e++) { const x = c.x + d, y = c.y + e; if (x >= 0 && y >= 0 && x < N && y < N) set.add(y * N + x); } return (i) => (set.has(i) ? [255, 200, 60, 220] : null); },
    stats: (s) => s.connections.map((c) => row(c.name, c.type)).join('') + Object.entries(RESOURCES).map(([k, r]) => { const m = s.market[k] || {}; return (m.imported || m.exported) ? row(`${r.icon} ${r.name}`, `↓${Math.round(m.imported || 0)} ↑${Math.round(m.exported || 0)}`) : ''; }).join('') },
  { key: 'residential', icon: '🏠', name: 'Residential', legend: ['good', 'Unsuitable', 'Suitable'], heat: (s) => (i) => (s.zone[i] && s.zone[i] <= 6 ? null : s.water[i] ? null : [...ramp('good', s.landValue[i] - s.air[i] - s.noise[i] * 0.5 + 0.3), 110]),
    building: zoneOnly('res', (s, c, b) => bRamp('good', (b.level - 1) / 4)) },
  { key: 'commercial', icon: '🛍️', name: 'Commercial', legend: ['good', 'Losing money', 'Profitable'], heat: (s) => (i) => (s.water[i] ? null : [...ramp('good', s.landValue[i] + 0.2), 90]),
    building: zoneOnly('com', (s, c, b) => bRamp('good', 0.5 + (b.profit || 0) / 2000)), stats: (s) => row('Shop capacity / demand', `${Math.round(s.stats.retailCapacity || 0)} / ${Math.round(s.stats.retailDemand || 0)}`) },
  { key: 'industrial', icon: '🏭', name: 'Industrial', legend: ['good', 'Losing money', 'Profitable'], heat: heat((s) => s.fertile, 'green', 1, 0.1),
    building: (s) => (b) => (b.kind === 'zone' && (b.def.cat === 'ind' || b.def.cat === 'spec') ? bRamp('good', 0.5 + (b.profit || 0) / 2000) : GREY) },
  { key: 'office', icon: '🏢', name: 'Office', legend: ['good', 'Losing money', 'Profitable'], heat: coverageHeat('telecom'),
    building: zoneOnly('off', (s, c, b) => bRamp('good', 0.5 + (b.profit || 0) / 2000)) },
  { key: 'level', icon: '⬆️', name: 'Building Level', legend: ['heat', 'Level 1', 'Level 5'], building: zoneOnly(null, (s, c, b) => bRamp('heat', (b.level - 1) / 4)) },
  { key: 'landvalue', icon: '💎', name: 'Land Value', legend: ['heat', 'Low', 'High'], heat: heat((s) => s.landValue, 'heat', 1.4, 0.01) },
  { key: 'profit', icon: '💹', name: 'Company Profitability', legend: ['good', 'Losing money', 'Profitable'],
    building: (s) => (b) => (b.profit != null ? bRamp('good', 0.5 + b.profit / 2000) : GREY),
    stats: (s) => row('Profitable companies', `${s.stats.profitable || 0} / ${s.stats.companies || 0}`) + row('Export revenue', money(s.stats.exportIncome || 0)) },
  { key: 'resources', icon: '⛏️', name: 'Natural Resources', legend: ['green', 'None', 'Rich'],
    heat: (s) => (i) => { if (s.ore[i] > 0.1) return [80, 140, 255, 90 + s.ore[i] * 120]; if (s.oil[i] > 0.1) return [20, 20, 20, 90 + s.oil[i] * 120]; if (s.fertile[i] > 0.1) return [235, 205, 70, 80 + s.fertile[i] * 110]; if (s.forestMax[i]) return [40, 150, 60, 130]; if (s.groundwater[i] > 0.15) return [60, 170, 230, 60 + s.groundwater[i] * 80]; return null; },
    stats: () => '<div class="muted">🟦 Ore · ⬛ Oil · 🟨 Fertile land · 🟩 Forest · light blue: groundwater</div>' },
  { key: 'population', icon: '👥', name: 'Population', legend: ['heat', 'Empty', 'Crowded'], building: zoneOnly('res', (s, c, b) => bRamp('heat', b.households.length / Math.max(1, b.hhCap))),
    stats: (s) => row('Population', s.citizens.size.toLocaleString()) + row('Households', s.households.size.toLocaleString()) },
  { key: 'happiness', icon: '😊', name: 'Happiness', legend: ['good', 'Unhappy', 'Happy'], building: zoneOnly(null, (s, c, b) => (b.happiness == null ? GREY : bRamp('good', (b.happiness - 20) / 70))),
    stats: (s) => row('Average happiness', `${Math.round(s.stats.happiness ?? 0)}%`) },
  { key: 'wealth', icon: '💰', name: 'Citizen Wealth', legend: ['good', 'Poor', 'Wealthy'], building: zoneOnly('res', (s, c, b) => { let w = 0, n = 0; for (const h of b.households) { const hh = s.households.get(h); if (hh) { w += hh.wealth; n++; } } return n ? bRamp('good', 0.3 + w / n / 30000) : GREY; }) },
  { key: 'jobs', icon: '💼', name: 'Workplace Availability', legend: ['good', 'Full', 'Many open jobs'], building: (s) => (b) => (b.jobs ? bRamp('good', 1 - (b.workerCount ?? b.workers.length) / b.jobs) : GREY),
    stats: (s) => (s.stats.openJobsEdu || []).map((v, k) => row(['Uneducated', 'Poorly educated', 'Educated', 'Well educated', 'Highly educated'][k], `${v} open`)).join('') },
  { key: 'air', icon: '🌫️', name: 'Air Pollution', legend: ['bad', 'Clean', 'Polluted'], heat: heat((s) => s.air, 'bad', 1.6) },
  { key: 'ground', icon: '🟤', name: 'Ground Pollution', legend: ['bad', 'Clean', 'Polluted'], heat: heat((s) => s.ground, 'bad', 2) },
  { key: 'noise', icon: '🔊', name: 'Noise Pollution', legend: ['bad', 'Quiet', 'Loud'], heat: heat((s) => s.noise, 'bad', 1.4) },
  { key: 'indnoise', icon: '🏭', name: 'Industrial Noise', legend: ['bad', 'Quiet', 'Factories next door'],
    heat: (s, ctx) => (i) => { const v = (ctx.indNoise?.[i] || 0) * 1.3; if (v < 0.03) return null; const c = ramp('bad', v); return [c[0], c[1], c[2], 90 + Math.min(1, v) * 120]; },
    building: zoneOnly('res', (s, ctx, b) => { const f = b.factors?.wb.find(([k]) => k === 'Industrial noise'); return bRamp('bad', Math.min(1, -(f?.[1] || 0) / 30)); }),
    stats: (s) => { const f = (s.stats.happyFactors || []).find((x) => x.name === 'Industrial noise'); return f ? row('Residents affected', `${Math.round(f.share * 100)}%`) + row('Average effect', `${f.avg.toFixed(1)} well-being`) : '<div class="muted">Nobody is bothered by factory noise.</div>'; } },
  { key: 'waterpoll', icon: '🧪', name: 'Water Pollution', legend: ['bad', 'Clean', 'Polluted'], layers: { pipes: true },
    heat: (s) => (i) => { const v = s.water[i] ? s.waterPoll[i] * 2 : s.gwPollution[i] * 1.5; if (v < 0.02) return s.water[i] ? [70, 210, 120, 120] : null; return [...ramp('bad', v), 190]; },
    stats: (s, ctx) => { const F = flowNames(s); return row('Current flows', `${F.down} ${F.arrow}`) + '<div class="muted" style="font-size:11px;margin-top:4px">Sewage drifts downstream with the current. Keep sewage outlets downstream of every water pump.</div>'; } },
];

// The view stays on when its window closes (say, to place a building while you watch its
// coverage); the legend's ✕ or Esc turns it off
registerPanel({
  key: 'info', icon: '🗺️', title: 'Info Views', order: 20,
  render(app, body) {
    const cur = app.infoViews.current;
    body.innerHTML = `<div class="info-grid">${INFO_VIEWS.map((v) => `<button data-k="${v.key}" class="${cur?.key === v.key ? 'on' : ''}"><span class="ico">${v.icon}</span>${v.name}</button>`).join('')}</div>
      ${cur ? `<div class="section-title">${cur.icon} ${cur.name}</div>${cur.stats ? cur.stats(app.state, app.ctx) : ''}` : '<div class="muted" style="margin-top:8px">Pick a view to colour the map.</div>'}`;
    body.querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => {
      app.infoViews.set(cur?.key === b.dataset.k ? null : b.dataset.k);
      app.panels.refresh('info');
    }));
  },
});

export const infoViewsFeature = {
  init(app) {
    const legend = document.getElementById('legend');
    const iv = { current: null };
    app.infoViews = iv;
    iv.apply = () => {
      const v = iv.current;
      const { state, ctx } = app;
      app.overlays.setHeat(v?.heat ? v.heat(state, ctx) : null);
      app.buildings.setColorFn(v?.building ? v.building(state, ctx) : v ? () => GREY : null);
      const rf = v?.road ? v.road(state, ctx) : null;
      app.networks.setRoadColorFn(rf ? (i) => new THREE.Color(rf(i)).getHex() : null);
      app.setLayerHint('pipe', !!v?.layers?.pipes);
      app.setLayerHint('subway', !!v?.layers?.subway);
    };
    iv.set = (key) => {
      iv.current = INFO_VIEWS.find((v) => v.key === key) || null;
      const v = iv.current;
      if (v && !app.state.counters.infoViews.includes(v.key)) app.state.counters.infoViews.push(v.key);
      legend.classList.toggle('open', !!v);
      if (v) {
        legend.innerHTML = `<button class="box-close" title="Turn this view off">✕</button><b>${v.icon} ${v.name}</b>${v.keys
          ? `<div class="keys">${v.keys.map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join('')}</div>`
          : `<div class="ramp" style="background:${rampCss(v.legend[0])}"></div><div class="ends"><span>${v.legend[1]}</span><span>${v.legend[2]}</span></div>`}`;
        legend.querySelector('.box-close').onclick = () => { iv.set(null); app.panels.refresh('info'); };
      }
      iv.apply();
      bus.emit('infoview:changed', key);
    };
    // The power grid view, switched on by the power line tool and the Map strip's ⚡ Grid
    // button (it goes back to whatever view you had when the tool is put away)
    let before = null;
    app.setPowerView = (on) => {
      if (on) { if (iv.current?.key !== 'electricity') before = iv.current?.key || null; iv.set('electricity'); }
      else { iv.set(before); before = null; }
      app.panels.refresh('info');
    };
    // keep the grid colours current as power changes
    bus.on('network:recomputed', () => { if (iv.current?.key === 'electricity') iv.apply(); });
    // Keep the active view up to date as the simulation runs
    let n = 0;
    bus.on('step', () => { if (iv.current && ++n % 6 === 0) iv.apply(); });
    bus.on('building:add', (b) => { if (iv.current) app.buildings.recolor(b); });
    bus.on('escape', () => { if (iv.current) { iv.set(null); app.panels.refresh('info'); } });
  },
};
