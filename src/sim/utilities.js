// Electricity, water and sewage. Roads carry power and pipes to the buildings beside them;
// power lines join networks (into a road only through a Power Connector, see sim/power.js)
// and pipes extend the water network. Each connected network balances supply against
// demand, with batteries. Power can only be bought from neighbouring cities on the network
// the outside power line feeds; water and sewage trade over the highway connection.
import { N, idx, clamp, DIRS, inBounds } from '../core/grid.js';
import { labelComponents } from './networks.js';
import { isService, serviceEfficiency, center, touchesWater } from './services.js';
import { hourOf } from './simulation.js';
import { hasPerk } from '../data/progression.js';
import { earn, charge } from './economy.js';
import { powerLinked } from './power.js';

const IMPORT_PRICE = { power: 260, water: 0.32, sewage: 0.28 };   // per MW·day / per m³
const EXPORT_PRICE = { power: 90, water: 0.08 };
const IMPORT_CAP = { power: 6, water: 6000, sewage: 6000 };

// Overhead wires connect distant pylons: merge their components (union-find on labels)
function joinBySpans(labels, spans) {
  if (!spans?.length) return;
  const parent = Array.from({ length: labels.count }, (_, k) => k);
  const find = (k) => { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
  for (const [a, b] of spans) {
    const ca = labels.comp[a], cb = labels.comp[b];
    if (ca >= 0 && cb >= 0) parent[find(ca)] = find(cb);
  }
  for (let i = 0; i < labels.comp.length; i++) if (labels.comp[i] >= 0) labels.comp[i] = find(labels.comp[i]);
}

// Monthly use per building
export function powerUse(state, b) {
  const def = b.def;
  if (isService(b)) return def.power ? 0 : (def.powerUse ?? (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * 0.06);
  const hh = b.households?.length || 0;
  const workers = b.workerCount || 0;
  const perJob = def.cat === 'ind' || def.cat === 'spec' ? 0.004 : def.cat === 'off' ? 0.0025 : 0.002;
  let use = hh * 0.0026 * (1 + (b.level - 1) * 0.12) + workers * perJob;
  if (b.district && state.districts.find((d) => d.id === b.district)?.policies?.energyAwareness) use *= 0.95;
  return use;
}
export function waterUse(state, b) {
  if (isService(b)) return b.def.waterUse ?? (b.def.cat === 'health' ? 400 : 60);
  const hh = b.households?.length || 0;
  const workers = b.workerCount || 0;
  return hh * 4.2 + workers * (b.def.cat === 'ind' ? 3.5 : 1.8);
}

// Sewage upstream of drinking water upsets residents. Water on each map flows one way
// (state.flow: rivers run south, the sea current on some maps runs east), and whatever a
// sewage outlet pours out is carried downstream through the connected water: a widening
// plume reaching PLUME.reach cells along the current (treated water from a treatment plant
// doesn't carry as far). Right where it pours in, it also spreads a little every way. A
// surface water pump whose intake is inside a plume is pumping up sewage.
export const PLUME = { raw: { reach: 64, close: 5 }, treated: { reach: 20, close: 3 } };

export function flowNames(state) {
  const [fx, fy] = state.flow || [0, 1];
  if (Math.abs(fx) >= Math.abs(fy)) return fx >= 0 ? { down: 'east', up: 'west', arrow: '→' } : { down: 'west', up: 'east', arrow: '←' };
  return fy >= 0 ? { down: 'south', up: 'north', arrow: '↓' } : { down: 'north', up: 'south', arrow: '↑' };
}

// Water cells a sewage building's outflow reaches (a Set of cell indices), or null if it
// doesn't pour into any water. `b` only needs x0..y1 and def, so tools can ask about a
// building before it's placed.
export function sewagePlume(state, b) {
  const at = b.discharge || dischargeCell(state, b);
  if (!at) return null;
  const P = b.def.id === 'treatment' ? PLUME.treated : PLUME.raw;
  const [fx, fy] = state.flow || [0, 1];
  const start = idx(at[0], at[1]);
  const set = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const i = stack.pop();
    const x = i % N, y = (i / N) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const j = idx(nx, ny);
      if (set.has(j) || !state.water[j]) continue;
      const rx = nx - at[0], ry = ny - at[1];
      const along = rx * fx + ry * fy;            // how far downstream
      const across = Math.abs(rx * fy - ry * fx); // how far to the side
      const close = Math.hypot(rx, ry) <= P.close;
      if (!close && (along <= 0 || along > P.reach || across > 8 + along * 0.6)) continue;
      set.add(j);
      stack.push(j);
    }
  }
  return set;
}

// Where a surface water pump draws its water from (null for groundwater pumps and towers)
export function intakeCell(state, b) {
  if (!b.def.water || b.def.needs === 'groundwater') return null;
  const c = dischargeCell(state, b);
  return c ? idx(c[0], c[1]) : null;
}

// Which sewage plume (if any) a pump's intake sits in: { outlet, along, close } or null
export function upstreamSewage(state, pump, plumes) {
  const intake = intakeCell(state, pump);
  if (intake == null) return null;
  let best = null;
  for (const [o, set] of plumes) {
    if (!set.has(intake)) continue;
    const at = o.discharge || dischargeCell(state, o);
    const [fx, fy] = state.flow || [0, 1];
    const rx = (intake % N) - at[0], ry = ((intake / N) | 0) - at[1];
    const along = rx * fx + ry * fy;
    const close = along <= 0 || Math.hypot(rx, ry) <= (o.def.id === 'treatment' ? PLUME.treated : PLUME.raw).close;
    // the nearest offender upstream is the one to name
    if (!best || Math.hypot(rx, ry) < best.dist) best = { outlet: o, along: Math.max(0, along), dist: Math.hypot(rx, ry), close };
  }
  return best;
}

// The water cell a building pours into (nearest water within reach), as [x, y] or null
export function dischargeCell(state, b) {
  let best = null, bd = 1e9;
  const [cx, cy] = center(b);
  for (let y = b.y0 - 3; y <= b.y1 + 3; y++) {
    for (let x = b.x0 - 3; x <= b.x1 + 3; x++) {
      if (x < 0 || y < 0 || x >= N || y >= N || !state.water[idx(x, y)]) continue;
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d < bd) { bd = d; best = [x, y]; }
    }
  }
  return best;
}

// Heating & cooling: power use rises when it's cold or hot (comfort band ≈ 18–22 °C)
export const temperatureFactor = (t) => 1 + Math.max(0, 18 - t) * 0.018 + Math.max(0, t - 24) * 0.022;

function feeFactor(fee, def) { return clamp(1 - (fee / def - 1) * 0.12, 0.6, 1.15); }

export function computeUtilities(state, ctx, opts = {}) {
  // --- network components
  const elecLayer = new Uint8Array(N * N);
  const waterLayer = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const net = state.road[i] || state.bld[i];
    elecLayer[i] = net || state.power[i] ? 1 : 0;
    waterLayer[i] = net || state.pipe[i] ? 1 : 0;
  }
  const elec = labelComponents(elecLayer, null, (i, j) => powerLinked(state, i, j));
  joinBySpans(elec, state.powerSpans);
  const wat = labelComponents(waterLayer);
  const outsideCell = state.connections.find((c) => c.type === 'road');
  const watOutside = outsideCell ? wat.comp[idx(outsideCell.x, outsideCell.y)] : -1;
  // Networks fed by the outside power line can import (and export) electricity
  const elecOutside = new Set();
  for (const c of state.connections) {
    if (c.type !== 'power') continue;
    const k = elec.comp[idx(c.x, c.y)];
    if (k >= 0) elecOutside.add(k);
  }

  const P = new Map(); // comp -> { supply, demand, batteries[], plants[], count }
  const W = new Map(); // comp -> { supply, demand, sewageCap, sewageDemand, pollution }
  const get = (m, k) => { if (!m.has(k)) m.set(k, { supply: 0, demand: 0, batteries: [], plants: [], count: 0, sewageCap: 0, sewageDemand: 0, pollutionSum: 0, producers: [] }); return m.get(k); };

  const w = state.weather;
  const hour = hourOf(state);
  const daylight = clamp(Math.sin(((hour - 6) / 12) * Math.PI) * 1.3, 0, 1);
  const tf = temperatureFactor(w.temp);
  const pf = feeFactor(state.fees.electricity, 0.2);
  const wf = feeFactor(state.fees.water, 0.3);
  const stats = { produced: 0, consumed: 0, imported: 0, exported: 0, capacity: 0, battery: 0, batteryCap: 0, batteryOut: 0, byCat: {}, waterProduced: 0, waterConsumed: 0, sewageTreated: 0, sewageProduced: 0, waterImported: 0, sewageImported: 0, pollutedWater: 0 };
  ctx.sewageOut = [];

  for (const b of state.buildings.values()) {
    const [cx, cy] = center(b);
    const ci = idx(cx, cy);
    const ek = elec.comp[ci], wk = wat.comp[ci];
    b.elecComp = ek; b.waterComp = wk;
    const def = b.def;
    if (isService(b)) {
      const eff = serviceEfficiency(state, b);
      if (def.power) {
        let out = def.power * Math.min(eff, 1.2) * (hasPerk(state, 'power_efficiency') ? 1.1 : 1);
        if (def.wind) out *= clamp(0.25 + w.wind * 1.1, 0.15, 1.4) * (state.windBoost || 1);
        if (def.solar) out *= daylight * (1 - w.cloud * 0.6) * (1 - w.snow * 0.5);
        if (def.needs === 'groundwater') out *= clamp(groundAt(state, b) * 1.5, 0.2, 1);
        if (def.needsWater && !touchesWater(state, b.x0, b.y0, b.x1, b.y1)) out *= 0.1;
        b.output = out;
        get(P, ek).supply += out;
        get(P, ek).plants.push(b);
        stats.capacity += def.power;
      }
      if (def.battery) { b.charge = b.charge ?? 0; get(P, ek).batteries.push(b); stats.batteryCap += def.battery; }
      if (def.water) {
        let out = def.water * Math.min(eff, 1.2) * (hasPerk(state, 'water_efficiency') ? 1.15 : 1);
        let poll = 0;
        if (def.needs === 'groundwater') {
          const g = groundAt(state, b);
          out *= clamp(g * 1.6, 0.1, 1);
          poll = gwPollAt(state, b);
          drawGroundwater(state, b, out);
        } else {
          const near = nearestWaterPollution(state, b);
          if (near < 0) out = 0;
          poll = Math.max(0, near);
        }
        b.output = out;
        b.waterQuality = 1 - poll;
        const c = get(W, wk);
        c.supply += out;
        c.pollutionSum += poll * out;
      }
      if (def.sewage) {
        const c = get(W, wk);
        const cap = def.sewage * Math.min(eff, 1.2);
        c.sewageCap += cap;
        c.producers.push(b);
      }
    }
    const pu = powerUse(state, b) * tf * pf;
    const wu = waterUse(state, b) * wf;
    b.powerUse = pu; b.waterUse = wu;
    if (pu > 0) {
      const c = get(P, ek);
      c.demand += pu; c.count++;
      if (c.sample == null) c.sample = b.id;
      const cat = isService(b) ? 'services' : b.def.cat === 'spec' ? 'ind' : b.def.mixed ? 'res' : b.def.cat;
      stats.byCat[cat] = (stats.byCat[cat] || 0) + pu;
    }
    if (wu > 0) { const c = get(W, wk); c.demand += wu; c.sewageDemand += wu; }
  }
  // Incinerators feed power into the network they sit on
  if (ctx.hourly?.incineratedPower) {
    for (const b of state.buildings.values()) {
      if (b.def.burns) { get(P, b.elecComp).supply += ctx.hourly.incineratedPower; break; }
    }
  }

  // --- balance each network
  const powerRatio = new Map();
  const nets = [];
  const sourced = new Set(elecOutside);
  for (const [k, c] of P) {
    let supply = c.supply;
    stats.produced += c.supply;
    stats.consumed += c.demand;
    let deficit = c.demand - supply;
    // batteries: charge on surplus, discharge on deficit (charge in MW·hours). A preview
    // (recomputed mid-hour) works out the same balance without moving any charge.
    let fromBatteries = 0, imp = 0;
    for (const bat of c.batteries) {
      const cap = bat.def.battery;
      let charge = bat.charge || 0;
      if (deficit > 0 && charge > 0) {
        const give = Math.min(deficit, charge, cap / 4);
        charge -= give; supply += give; deficit -= give; fromBatteries += give;
      } else if (deficit < 0 && charge < cap) {
        const take = Math.min(-deficit, cap - charge, cap / 4);
        charge += take; deficit += take;
      }
      if (!opts.preview) bat.charge = charge;
      stats.battery += charge;
    }
    stats.batteryOut += fromBatteries;
    if (elecOutside.has(k)) {
      if (deficit > 0) {
        imp = Math.min(deficit, IMPORT_CAP.power + c.demand * 0.05);
        supply += imp; deficit -= imp; stats.imported += imp;
      } else if (deficit < 0) stats.exported += -deficit;
    }
    const ratio = c.demand > 0 ? clamp(supply / c.demand, 0, 1) : 1;
    powerRatio.set(k, ratio);
    const hasSource = c.plants.length > 0 || c.batteries.length > 0 || elecOutside.has(k) || c.supply > 0;
    if (hasSource) sourced.add(k);
    nets.push({ comp: k, demand: c.demand, produced: c.supply, batteries: fromBatteries, imported: imp, ratio, buildings: c.count, sample: c.sample, plants: c.plants.map((b) => b.id), outside: elecOutside.has(k), hasSource });
  }
  nets.sort((a, b) => b.demand - a.demand);
  ctx.elecComp = elec.comp;
  ctx.elecSourced = sourced;
  ctx.elecNets = nets;
  const waterRatio = new Map(), sewageRatio = new Map(), waterPoll = new Map();
  for (const [k, c] of W) {
    let supply = c.supply;
    stats.waterProduced += c.supply;
    stats.waterConsumed += c.demand;
    stats.sewageProduced += c.sewageDemand;
    if (k === watOutside && c.demand > supply) {
      const imp = Math.min(c.demand - supply, IMPORT_CAP.water + c.demand * 0.1);
      supply += imp; stats.waterImported += imp;
    } else if (k === watOutside) stats.waterExported = (stats.waterExported || 0) + (supply - c.demand);
    waterRatio.set(k, c.demand > 0 ? clamp(supply / c.demand, 0, 1) : 1);
    waterPoll.set(k, c.supply > 0 ? c.pollutionSum / c.supply : 0);
    let sewCap = c.sewageCap;
    if (k === watOutside && c.sewageDemand > sewCap) {
      const imp = Math.min(c.sewageDemand - sewCap, IMPORT_CAP.sewage + c.sewageDemand * 0.1);
      sewCap += imp; stats.sewageImported += imp;
    }
    sewageRatio.set(k, c.sewageDemand > 0 ? clamp(sewCap / c.sewageDemand, 0, 1) : 1);
    // Where the sewage ends up: split across outlets/treatment plants by capacity
    const handled = Math.min(c.sewageDemand, c.sewageCap);
    for (const p of c.producers) {
      const share = c.sewageCap > 0 ? (p.def.sewage / c.sewageCap) * handled : 0;
      p.load = share;
      stats.sewageTreated += p.def.id === 'treatment' ? share : 0;
      const [x, y] = center(p);
      p.discharge = dischargeCell(state, p);
      ctx.sewageOut.push({ x, y, amount: share * (p.def.id === 'treatment' ? 0.15 : 1), b: p, at: p.discharge });
    }
  }

  // --- sewage upstream of drinking water: everyone on a network fed by a pump that draws
  // from a sewage plume is upset (the water also gets dirty as the plume reaches it)
  const pumps = [], plumes = new Map();
  for (const b of state.buildings.values()) {
    if (!isService(b)) continue;
    if (b.def.water) pumps.push(b);
    if (b.def.sewage) { const set = sewagePlume(state, b); if (set) plumes.set(b, set); }
  }
  ctx.sewagePlumes = plumes;
  const contaminated = new Set();
  ctx.sewageUpstream = [];
  for (const p of pumps) {
    const hit = upstreamSewage(state, p, plumes);
    p.sewageUpstream = hit ? { id: hit.outlet.id, along: hit.along, close: hit.close } : null;
    if (!hit) continue;
    ctx.sewageUpstream.push({ pump: p.id, outlet: hit.outlet.id, along: hit.along, close: hit.close });
    if (p.waterComp >= 0) contaminated.add(p.waterComp);
  }
  ctx.contaminatedWater = contaminated;

  // --- apply to buildings
  let unpowered = 0, dry = 0;
  for (const b of state.buildings.values()) {
    b.power = b.powerUse > 0 ? powerRatio.get(b.elecComp) ?? 0 : 1;
    b.water = b.waterUse > 0 ? waterRatio.get(b.waterComp) ?? 0 : 1;
    b.sewage = b.waterUse > 0 ? sewageRatio.get(b.waterComp) ?? 0 : 1;
    b.waterPolluted = waterPoll.get(b.waterComp) ?? 0;
    if (b.power < 0.6 && b.powerUse > 0) unpowered++;
    if (b.water < 0.6 && b.waterUse > 0) dry++;
    if (b.waterPolluted > 0.25) stats.pollutedWater++;
  }
  stats.unpowered = unpowered;
  stats.dry = dry;

  state.stats.utilities = stats;
  if (opts.preview) return; // recomputed mid-hour after a change: no money moves

  // --- trade money, per hour
  const hourCost = (stats.imported * IMPORT_PRICE.power + stats.waterImported * IMPORT_PRICE.water + stats.sewageImported * IMPORT_PRICE.sewage) / 24;
  const hourIncome = (stats.exported * EXPORT_PRICE.power + (stats.waterExported || 0) * EXPORT_PRICE.water) / 24;
  charge(state, 'imports', hourCost);
  earn(state, 'exports', hourIncome);
  // Utility fees paid by citizens and companies
  const feeIncome = (stats.consumed * state.fees.electricity * 750 + stats.waterConsumed * state.fees.water * 0.5) / 24;
  earn(state, 'fees', feeIncome);
}

function groundAt(state, b) {
  let sum = 0, n = 0;
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) { sum += state.groundwater[idx(x, y)]; n++; }
  return sum / n;
}
function gwPollAt(state, b) {
  let sum = 0, n = 0;
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) { sum += state.gwPollution[idx(x, y)]; n++; }
  return clamp(sum / n, 0, 1);
}
// Pumping lowers groundwater; it refills slowly (see pollution/resources system)
function drawGroundwater(state, b, out) {
  const k = (out / 6000) * 0.0025;
  for (let y = b.y0 - 2; y <= b.y1 + 2; y++) {
    for (let x = b.x0 - 2; x <= b.x1 + 2; x++) {
      if (x < 0 || y < 0 || x >= N || y >= N) continue;
      const i = idx(x, y);
      if (state.groundwater[i] > 0) state.groundwater[i] = Math.max(0, state.groundwater[i] - k);
    }
  }
}
// Pollution of the closest water cell (-1 if no water within reach)
function nearestWaterPollution(state, b) {
  let best = -1, bestD = 1e9;
  for (let y = b.y0 - 2; y <= b.y1 + 2; y++) {
    for (let x = b.x0 - 2; x <= b.x1 + 2; x++) {
      if (x < 0 || y < 0 || x >= N || y >= N) continue;
      const i = idx(x, y);
      if (!state.water[i]) continue;
      const d = Math.abs(x - (b.x0 + b.x1) / 2) + Math.abs(y - (b.y0 + b.y1) / 2);
      if (d < bestD) { bestD = d; best = clamp(state.waterPoll[i], 0, 1); }
    }
  }
  return best;
}

