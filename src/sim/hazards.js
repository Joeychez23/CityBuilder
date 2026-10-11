// Bigger natural hazards for big cities, and the long-term climate:
//  - earthquakes break roads and the pipes under them (closed until road crews mend them),
//    shake down weak buildings and start fires
//  - on coastal maps, storm surges push the sea up over low ground for a few hours
//  - heatwaves in summer: hotter days (more power for cooling, people fall ill, dry land)
//  - decades of air pollution slowly warm the climate, and on coastal maps the sea rises
import { N, idx, inBounds, DIRS, clamp, forRadius } from '../core/grid.js';
import { rng } from '../core/rng.js';
import { isOwned } from './build.js';
import { cellHeight, recomputeWater } from './mapgen.js';
import { destroyBuilding, igniteBuilding, disasterOdds } from './disasters.js';
import { refreshClosed } from './closures.js';
import { charge } from './economy.js';
import { monthOf } from './simulation.js';
import { CLIMATES } from '../data/maps.js';
import { bus } from '../core/events.js';

function journal(state, kind, text) {
  state.journal.push({ day: state.time.day, minutes: state.time.minutes, kind, text });
  if (state.journal.length > 200) state.journal.shift();
}
const hasWarning = (state) => [...state.buildings.values()].some((b) => b.def.warning && !b.cons);
const now = (state) => state.time.day * 1440 + state.time.minutes;

// ---------------------------------------------------------------- earthquakes
// A few a year somewhere in the region; most are small. Magnitude 4.5..7.2.
export function earthquakeHourly(state, ctx) {
  if (!state.options.disasters || state.time.day < 10 || state.citizens.size < 500) return;
  if (!rng.chance(0.00045 * difficultyShare(state))) return;
  const mag = 4.5 + Math.pow(rng.next(), 2.2) * 2.7;
  // the epicentre: somewhere on (or near) your land
  let x = 0, y = 0;
  for (let k = 0; k < 40; k++) { x = rng.int(0, N - 1); y = rng.int(0, N - 1); if (isOwned(state, x, y)) break; }
  earthquake(state, ctx, x, y, mag);
}
const difficultyShare = (state) => (state.options.difficulty === 'easy' ? 0.5 : state.options.difficulty === 'hard' ? 1.5 : state.options.difficulty === 'expert' ? 2 : 1);

export function earthquake(state, ctx, x, y, mag) {
  const R = Math.round((mag - 4) * 13);
  const strength = (mag - 4.3) / 2.9; // 0..1
  const broken = [];
  let destroyed = 0, damaged = 0, fires = 0, hurt = 0;
  const warned = hasWarning(state);
  const seen = new Set();
  forRadius(x + 0.5, y + 0.5, R, (cx, cy, d) => {
    const i = idx(cx, cy);
    const shake = strength * (1 - d / R);
    // roads (and the pipes and cables under them) and pipes crack
    if ((state.road[i] || state.pipe[i]) && !state.closed[i] && isOwned(state, cx, cy) && rng.chance(shake * 0.35)) {
      broken.push(i);
      if (state.road[i]) state.roadCond[i] = Math.min(state.roadCond[i], 0.15);
    }
    const b = state.bld[i] && state.buildings.get(state.bld[i]);
    if (!b || seen.has(b.id)) return;
    seen.add(b.id);
    if (b.def.permanent) return;
    // old, low buildings come down; towers and new services are built to stand it
    const weak = b.kind === 'zone' ? (b.level <= 2 ? 1 : 0.5) : 0.25;
    if (rng.chance(shake * shake * 0.12 * weak)) {
      if (!warned) for (const hid of b.households || []) { const hh = state.households.get(hid); for (const cid of [...(hh?.members || [])]) if (rng.chance(0.15)) { state.citizens.delete(cid); hh.members = hh.members.filter((m) => m !== cid); hurt++; } }
      destroyBuilding(state, b, 'collapsed in the earthquake');
      destroyed++;
      return;
    }
    if (rng.chance(shake * 0.6)) { b.condition = Math.max(0.3, (b.condition ?? 1) - shake * 0.4); damaged++; }
    if (rng.chance(shake * 0.04)) { igniteBuilding(state, b, 'gas leak after the earthquake'); fires++; }
    // people hurt by falling things: the hospitals fill up
    if (rng.chance(shake * 0.3)) for (const hid of b.households || []) for (const cid of state.households.get(hid)?.members || []) { const c = state.citizens.get(cid); if (c && rng.chance(0.2)) { c.sick = Math.max(c.sick || 0, 1); c.health = Math.max(0, c.health - 15); } }
  });
  if (broken.length) {
    state.closures = state.closures || [];
    state.closures.push({ cells: broken, until: null, why: 'quake' });
    refreshClosed(state);
  }
  charge(state, 'services', damaged * 400);
  state.counters.earthquake = true;
  ctx.quake = { x, y, mag, t: 0 };
  const m = mag.toFixed(1);
  journal(state, 'quake', `Magnitude ${m} earthquake: ${broken.length} road and pipe cells broken, ${destroyed} buildings down`);
  bus.emit('quake', { x, y, mag });
  bus.emit('notify', { kind: mag > 5.5 ? 'bad' : 'warn', icon: '🫨', title: `Earthquake (magnitude ${m})`, cell: idx(x, y),
    msg: `${broken.length ? `${broken.length} cells of road and pipe broke: they're closed until road maintenance crews mend them (Transport → Road Maintenance Depot). ` : ''}${destroyed ? `${destroyed} building${destroyed === 1 ? '' : 's'} collapsed${hurt ? ` and ${hurt} people died` : ''}. ` : ''}${damaged ? `${damaged} damaged. ` : ''}${fires ? `${fires} fire${fires === 1 ? '' : 's'} broke out.` : ''}`.trim() || 'It was felt across the city, but nothing broke.' });
  return { broken: broken.length, destroyed, damaged, fires };
}

// Hourly: road crews mend broken cells, nearest to their depot first (a few a day without one)
export function quakeRepairsHourly(state, ctx) {
  const list = (state.closures || []).filter((c) => c.why === 'quake');
  if (!list.length) return;
  const maint = ctx.coverage.roadMaint;
  let fixed = 0;
  for (const c of list) {
    c.cells = c.cells.filter((i) => {
      const m = maint ? maint[i] : 0;
      if (rng.chance(0.004 + m * 0.18)) { if (state.road[i]) state.roadCond[i] = Math.max(state.roadCond[i], 0.6); fixed++; return false; }
      return true;
    });
  }
  state.closures = state.closures.filter((c) => c.cells.length);
  if (fixed) refreshClosed(state);
  if (!state.closures.some((c) => c.why === 'quake') && list.length) bus.emit('notify', { kind: 'good', icon: '🚧', title: 'Earthquake damage mended', msg: 'Every broken road and pipe is open again.' });
}

// --------------------------------------------------------------- storm surges
const coastal = (state) => !!state.connectionsAvailable?.ship;
export function surgeHourly(state, ctx) {
  const s = ctx.surge;
  if (s) {
    s.hours--;
    if (s.hours <= 0) endSurge(state, ctx);
    return;
  }
  if (!state.options.disasters || !coastal(state) || state.time.day < 10) return;
  const w = state.weather;
  if (w.storm > 0.5 && rng.chance(0.03 * disasterOdds(state, ctx))) startSurge(state, ctx, 0.6 + Math.pow(rng.next(), 2) * 1.2 + (state.climateChange?.seaRise || 0) * 0.5);
}

// Your land the sea can reach (from the open sea at the map edge) that lies lower than the
// surge. The water finds its way over any low ground, yours or not.
function surgeCells(state, rise) {
  const sea = state.seaLevel, H = sea + rise;
  const seen = new Uint8Array(N * N), out = [];
  const queue = [];
  for (let k = 0; k < N; k++) for (const [x, y] of [[k, 0], [k, N - 1], [0, k], [N - 1, k]]) { const i = idx(x, y); if (state.water[i] && !seen[i]) { seen[i] = 1; queue.push(i); } }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q], x = i % N, y = (i / N) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const j = idx(nx, ny);
      if (seen[j]) continue;
      seen[j] = 1;
      if (state.water[j]) { queue.push(j); continue; }
      if (cellHeight(state, nx, ny) < H) { queue.push(j); if (isOwned(state, nx, ny) && out.length < 8000) out.push(j); }
    }
  }
  return out;
}

export function startSurge(state, ctx, rise) {
  const cells = surgeCells(state, rise);
  ctx.surge = { rise, hours: 6 + rng.int(0, 10), cells, level: state.seaLevel + rise };
  state.counters.flood = true;
  const warned = hasWarning(state);
  const hit = new Set();
  const roads = [];
  for (const i of cells) {
    if (state.road[i]) roads.push(i);
    const b = state.bld[i] && state.buildings.get(state.bld[i]);
    if (b && !hit.has(b.id)) { hit.add(b.id); b.flooded = true; }
  }
  // people in flooded homes: most get out (all of them with the warning system)
  let drowned = 0;
  if (!warned) for (const id of hit) { const b = state.buildings.get(id); for (const hid of b?.households || []) { const hh = state.households.get(hid); for (const cid of [...(hh?.members || [])]) if (rng.chance(0.005)) { state.citizens.delete(cid); hh.members = hh.members.filter((m) => m !== cid); drowned++; } } }
  if (roads.length) { state.closures = state.closures || []; state.closures.push({ cells: roads, until: null, why: 'flood' }); refreshClosed(state); }
  journal(state, 'flood', `Storm surge: the sea rose ${(rise * 8).toFixed(0)} m over ${cells.length} cells of land`);
  bus.emit('surge', ctx.surge);
  bus.emit('notify', { kind: 'bad', icon: '🌊', title: 'Storm surge!', cell: cells[0],
    msg: cells.length ? `The sea came ${Math.round(rise * 8)} m up over low ground: ${hit.size} buildings flooded (no power or water until it goes down) and ${roads.length} road cells under water.${drowned ? ` ${drowned} people drowned.` : warned ? ' The warning system got everyone out.' : ''}` : 'High water along the coast, but nothing of yours was flooded.' });
}

function endSurge(state, ctx) {
  const s = ctx.surge;
  ctx.surge = null;
  let repairs = 0;
  for (const b of state.buildings.values()) {
    if (!b.flooded) continue;
    b.flooded = false;
    b.condition = Math.max(0.3, (b.condition ?? 1) - 0.25);
    repairs += b.kind === 'zone' ? 300 : 1500;
    // some ruined shops and homes are given up
    if (b.kind === 'zone' && !b.def.signature && rng.chance(0.08)) bus.emit('building:collapse', b);
  }
  state.closures = (state.closures || []).filter((c) => c.why !== 'flood');
  refreshClosed(state);
  charge(state, 'services', repairs);
  journal(state, 'flood', 'The flood water went down');
  bus.emit('surge', null);
  bus.emit('notify', { kind: 'info', icon: '🌊', title: 'The water went down', msg: `Clean-up and repairs: ₡${Math.round(repairs).toLocaleString()}. ${s?.cells.length ? 'Low ground by the sea will flood again in the next big storm.' : ''}` });
}

// ----------------------------------------------------------------- heatwaves
export function heatwaveDaily(state, ctx) {
  const hw = ctx.heatwave;
  if (hw) {
    hw.days--;
    if (hw.days <= 0) { ctx.heatwave = null; journal(state, 'heat', 'The heatwave broke'); bus.emit('notify', { kind: 'good', icon: '🌡️', title: 'The heatwave broke', msg: 'Temperatures are back to normal.' }); }
    return;
  }
  if (!state.options.disasters) return;
  const cl = CLIMATES[state.climate];
  const m = monthOf(state);
  const summer = m >= 5 && m <= 7;
  if (!summer || cl.maxT < 20) return;
  // more often in a hot climate, and as the climate warms
  const warm = state.climateChange?.warming || 0;
  if (!rng.chance((0.03 + (cl.maxT - 20) * 0.004 + warm * 0.03) * disasterOdds(state, ctx))) return;
  startHeatwave(state, ctx);
}
export function startHeatwave(state, ctx) {
  const tamed = ctx.wonders?.weatherControl;
  ctx.heatwave = { days: 3 + rng.int(0, 4), boost: tamed ? 3.5 : 7 };
  state.counters.heatwave = true;
  journal(state, 'heat', 'A heatwave began');
  bus.emit('notify', { kind: 'warn', icon: '🌡️', title: 'Heatwave', msg: `${ctx.heatwave.days} days of scorching heat: air conditioning drives up power use, old people fall ill, and the land dries out (fires spread). Parks and trees help.${tamed ? ' The Weather Control Tower is keeping it milder.' : ''}` });
}
// Health: the heat is hard on everyone, less so with parks and shade around
export const heatFactor = (ctx, leisure) => (ctx.heatwave ? -(ctx.heatwave.boost >= 6 ? 7 : 4) * (1 - Math.min(0.6, leisure * 0.5)) : 0);

// --------------------------------------------------------- the long-term climate
// Each day the smog over the city adds to what's in the atmosphere; a little of it clears
// again every day. Warming follows what's built up, and on coastal maps, after a while, the
// sea rises with it (slowly: whatever gets in its way is lost).
export function climateDaily(state, ctx) {
  if (state.options.climateChange === false) return;
  const C = state.climateChange || (state.climateChange = { carbon: 0, warming: 0, seaRise: 0, notified: 0 });
  let smog = 0;
  for (let i = 0; i < state.air.length; i += 3) smog += state.air[i];
  smog *= 3;
  C.lastEmission = smog;
  C.carbon = Math.max(0, C.carbon * 0.996 + smog * 0.03);
  C.warming = clamp(C.carbon / 3000, 0, 4);
  const step = Math.floor(C.warming * 2) / 2;
  if (step > (C.notified || 0)) {
    C.notified = step;
    bus.emit('notify', { kind: 'warn', icon: '🌍', title: `The climate has warmed ${step.toFixed(1)} °C`, msg: `Years of smog are warming the region: hotter summers and more heatwaves${coastal(state) ? ', and before long a rising sea' : ''}. Cleaner power, carbon capture, the Eco Dome and trees slow it.` });
    journal(state, 'climate', `The climate has warmed ${step.toFixed(1)} °C since the city was founded`);
  }
  // the sea follows the warming once it passes a degree, on maps that reach the sea
  if (!coastal(state)) return;
  const target = Math.max(0, C.warming - 1) * 0.35;
  if (target > C.seaRise + 0.05) raiseSea(state, ctx, 0.05);
}

function raiseSea(state, ctx, by) {
  const C = state.climateChange;
  C.seaRise += by;
  state.seaLevel += by;
  recomputeWater(state);
  // anything now standing in the sea is lost
  let lost = 0;
  for (const b of [...state.buildings.values()]) {
    let wet = 0, cells = 0;
    for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) { cells++; if (state.water[idx(x, y)]) wet++; }
    if (wet > cells / 2 && !b.def.needsWater) { destroyBuilding(state, b, 'was swallowed by the rising sea'); lost++; }
  }
  bus.emit('terrain:changed', { x0: 0, y0: 0, x1: N - 1, y1: N - 1 });
  bus.emit('network:changed', { layer: 'road' });
  bus.emit('sea:changed', state.seaLevel);
  journal(state, 'climate', `The sea rose to ${(C.seaRise * 8).toFixed(1)} m above where it was`);
  bus.emit('notify', { kind: 'bad', icon: '🌊', title: 'The sea is rising', msg: `The sea is now ${(C.seaRise * 8).toFixed(1)} m higher than when the city was founded.${lost ? ` ${lost} building${lost === 1 ? '' : 's'} on the shore went under.` : ' Low ground along the shore is going under.'}` });
}
