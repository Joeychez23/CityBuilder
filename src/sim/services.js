// Service buildings: placement rules, efficiency (budget × staffing × power), coverage
// grids that other systems read, and the hourly garbage / mail / deathcare collection.
import { N, idx, inBounds, forRadius, clamp } from '../core/grid.js';
import { createBuilding, footprintFree, footprintBlocker, isOwned, spend, clearZoneCell, changeHooks } from './build.js';
import { buildingRoadComp } from './networks.js';
import { bus } from '../core/events.js';
import { hasPerk } from '../data/progression.js';
import { charge } from './economy.js';
import { startConstruction } from './construction.js';
import { landmarkBlocker } from './landmarks.js';

export const COVERAGE_KEYS = ['health', 'fire', 'police', 'leisure', 'post', 'telecom', 'welfare', 'cityhall', 'shelter',
  'garbage', 'death', 'education1', 'education2', 'forestWatch', 'roadMaint', 'heli'];

// Which coverage grid a service contributes to
export function coverageKey(def) {
  if (def.health) return 'health';
  if (def.forestWatch) return 'forestWatch';
  if (def.engines) return 'fire';
  if (def.patrol) return 'police';
  if (def.leisure) return 'leisure';
  if (def.mail) return 'post';
  if (def.net) return 'telecom';
  if (def.welfare) return 'welfare';
  if (def.cityHall) return 'cityhall';
  if (def.shelter) return 'shelter';
  if (def.garbageRate) return 'garbage';
  if (def.deathRate) return 'death';
  if (def.eduLevel === 1) return 'education1';
  if (def.eduLevel === 2) return 'education2';
  if (def.roadMaint) return 'roadMaint';
  return null;
}

export const center = (b) => [Math.floor((b.x0 + b.x1) / 2), Math.floor((b.y0 + b.y1) / 2)];
export const centerIdx = (b) => { const [x, y] = center(b); return idx(x, y); };
// A working city service (a building site isn't one yet)
export const isService = (b) => (b.kind === 'service' || b.kind === 'transport') && !b.cons;

export function budgetOf(state, cat) { return state.budgets[cat] ?? 100; }

// 0..1.5: how well a service building is running right now
export function serviceEfficiency(state, b) {
  const def = b.def;
  const budget = clamp(budgetOf(state, def.cat) / 100, 0.5, 1.5);
  const staffing = def.workers ? clamp((b.staff ?? def.workers) / def.workers, 0.25, 1) : 1;
  const power = def.power ? 1 : 0.4 + 0.6 * (b.power ?? 1); // generators don't need power themselves
  const access = b.roadAccess === false ? 0 : 1;
  // (a strike: the service barely runs, sim/society.js)
  return budget * staffing * power * access * (b.onFire ? 0.2 : 1) * (state.strike?.cat === def.cat ? 0.15 : 1);
}

// ------------------------------------------------------------------ placement
// Returns null if OK, or a reason string
export function serviceBlocker(state, ctx, def, x0, y0, x1, y1) {
  const blocked = footprintBlocker(state, x0, y0, x1, y1);
  if (blocked) return blocked;
  if (def.unique) for (const b of state.buildings.values()) if (b.def === def) return 'Only one per city';
  if (def.needs) {
    let n = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (state[def.needs][idx(x, y)] > 0.05) n++;
    if (n < ((x1 - x0 + 1) * (y1 - y0 + 1)) / 2) return `Must be placed on ${def.needs}`;
  }
  if (def.needsShip && !state.connectionsAvailable.ship) return 'This map has no sea lane';
  if (def.needsWater && !touchesWater(state, x0, y0, x1, y1)) return 'Must be placed next to water';
  if (def.needsRail && !touchesLayer(state, state.rail, x0, y0, x1, y1)) return 'Must be next to railway tracks';
  if (!def.inPark && !touchesGroundRoad(state, x0, y0, x1, y1)) return 'Needs a road next to it'; // (rides stand in the park grounds)
  return landmarkBlocker(state, def, x0, y0, x1, y1);
}

// Is there a ground-level road along a side of this rectangle? (bridge decks don't give
// access, and a road only touching a corner doesn't either: driveways, power and water all
// need a shared edge)
export function touchesGroundRoad(state, x0, y0, x1, y1) {
  for (let y = y0 - 1; y <= y1 + 1; y++) {
    for (let x = x0 - 1; x <= x1 + 1; x++) {
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
      if ((x < x0 || x > x1) && (y < y0 || y > y1)) continue; // a corner
      if (!inBounds(x, y)) continue;
      const i = idx(x, y);
      if (state.road[i] && !state.bridgeH[i]) return true;
    }
  }
  return false;
}

export function touchesWater(state, x0, y0, x1, y1) { return touchesLayer(state, state.water, x0, y0, x1, y1, 2); }
export function touchesLayer(state, layer, x0, y0, x1, y1, reach = 1) {
  for (let y = y0 - reach; y <= y1 + reach; y++) {
    for (let x = x0 - reach; x <= x1 + reach; x++) {
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
      if (inBounds(x, y) && layer[idx(x, y)]) return true;
    }
  }
  return false;
}

export function placeService(state, ctx, def, x0, y0, x1, y1, rot, extra = {}, price = null) {
  const reason = serviceBlocker(state, ctx, def, x0, y0, x1, y1);
  if (reason) return { error: reason };
  const cost = def.free ? 0 : price ?? def.cost;
  if (!spend(state, cost, def.cat)) return { error: 'Not enough money' };
  const b = createBuilding(state, def.kind || 'service', def, x0, y0, x1, y1, rot, { stored: 0, load: 0, staff: def.workers || 0, ...extra });
  b.jobs = def.workers || 0;
  b.jobsEdu = eduMixForService(def);
  startConstruction(state, b);
  bus.emit('xp', { amount: Math.max(5, Math.round(cost / 4000)), reason: 'service' });
  bus.emit('services:changed');
  return { building: b };
}

function eduMixForService(def) {
  const w = def.workers || 0;
  const hi = ['education', 'health', 'police'].includes(def.cat) ? [0.05, 0.15, 0.3, 0.3, 0.2] : [0.25, 0.3, 0.25, 0.15, 0.05];
  const out = hi.map((v) => Math.round(v * w));
  out[0] += w - out.reduce((a, c) => a + c, 0);
  return out;
}

// ------------------------------------------------------- storage & expansion
// Landfills hold what their area allows (draw more area next to one to grow it). Cemeteries
// fill up too: each expansion adds 2 rows of land behind (or beside) the site and 75% more
// room, up to MAX_EXPANSIONS times.
export const MAX_EXPANSIONS = 3;
export const cellsOf = (b) => (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
export const storageCap = (b) => (b.def.storagePerCell ? cellsOf(b) * b.def.storagePerCell : (b.def.storage || 0) * (1 + 0.75 * (b.expansions || 0)));
// Upkeep per day (area-built services pay per cell)
export const buildingUpkeep = (b) => (b.def.upkeepPerCell ? b.def.upkeep + cellsOf(b) * b.def.upkeepPerCell : (b.def.upkeep || 0) + (b.extraUpkeep || 0));
// What an area-built service costs for this many cells
export const areaCost = (def, cells) => Math.round(def.cost + cells * def.perCell);

function stripRect(b, d, n) {
  if (d === 0) return [b.x1 + 1, b.y0, b.x1 + n, b.y1];
  if (d === 1) return [b.x0, b.y1 + 1, b.x1, b.y1 + n];
  if (d === 2) return [b.x0 - n, b.y0, b.x0 - 1, b.y1];
  return [b.x0, b.y0 - n, b.x1, b.y0 - 1];
}

export function expansionPlan(state, b) {
  if (!b.def.storage) return { error: 'This building can\'t be expanded' };
  if (b.def.area) return { error: 'Drag more landfill area next to it (Garbage → Landfill)' };
  if ((b.expansions || 0) >= MAX_EXPANSIONS) return { error: 'Fully expanded' };
  const cost = Math.round(b.def.cost * 0.6);
  const back = ((b.rot || 0) + 2) % 4;
  for (const d of [back, ((b.rot || 0) + 1) % 4, ((b.rot || 0) + 3) % 4]) {
    const strip = stripRect(b, d, 2);
    const [x0, y0, x1, y1] = strip;
    if (!inBounds(x0, y0) || !inBounds(x1, y1)) continue;
    if (footprintFree(state, x0, y0, x1, y1)) return { strip, dir: d, cost, adds: Math.round(b.def.storage * 0.75) };
  }
  return { error: 'No room: it needs 2 free, flat rows of your land behind or beside it', cost };
}

export function expandStorage(state, b) {
  const plan = expansionPlan(state, b);
  if (plan.error) return plan;
  if (!spend(state, plan.cost, b.def.cat)) return { error: 'Not enough money' };
  changeHooks.modifying?.(state, b);
  const [x0, y0, x1, y1] = plan.strip;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = idx(x, y);
      state.bld[i] = b.id; clearZoneCell(state, i); state.tree[i] = 0;
    }
  }
  b.x0 = Math.min(b.x0, x0); b.y0 = Math.min(b.y0, y0); b.x1 = Math.max(b.x1, x1); b.y1 = Math.max(b.y1, y1);
  const alongX = b.rot === 1 || b.rot === 3;
  b.w = alongX ? b.x1 - b.x0 + 1 : b.y1 - b.y0 + 1;
  b.d = alongX ? b.y1 - b.y0 + 1 : b.x1 - b.x0 + 1;
  b.expansions = (b.expansions || 0) + 1;
  b.extraUpkeep = (b.extraUpkeep || 0) + b.def.upkeep * 0.35;
  b.full = false;
  bus.emit('building:changed', b);
  bus.emit('services:changed');
  bus.emit('trees:changed');
  bus.emit('zones:changed', { count: 0 });
  return plan;
}

// ------------------------------------------------------------------ coverage
export function computeCoverage(state, ctx) {
  for (const k of COVERAGE_KEYS) {
    if (!ctx.coverage[k]) ctx.coverage[k] = new Float32Array(N * N);
    else ctx.coverage[k].fill(0);
  }
  for (const b of state.buildings.values()) {
    if (!isService(b)) continue;
    const def = b.def;
    const key = coverageKey(def);
    if (!key || !def.radius) continue;
    b.roadAccess = !!buildingRoadComp(state, ctx, b);
    const eff = serviceEfficiency(state, b);
    b.efficiency = eff;
    if (eff <= 0) continue;
    const grid = ctx.coverage[key];
    // (a park or beach you drew reaches as far as its size allows: b.radius)
    const r = (b.radius || def.radius) * Math.sqrt(clamp(eff, 0.5, 1.3)) * (key === 'telecom' && hasPerk(state, 'comms_fiber') ? 1.25 : 1);
    const [cx, cy] = center(b);
    const strength = (key === 'leisure' ? def.leisure * (hasPerk(state, 'parks_care') ? 1.15 : 1) : key === 'health' ? def.health * (hasPerk(state, 'health_research') ? 1.15 : 1) : 1);
    const heli = def.heli ? ctx.coverage.heli : null;
    forRadius(cx + 0.5, cy + 0.5, r, (x, y, d) => {
      const i = idx(x, y);
      if (b.serveDistrict && state.district[i] !== b.serveDistrict) return;
      const v = strength * eff * (1 - (d / r) * (d / r) * 0.6);
      if (heli) heli[i] = Math.max(heli[i], v);
      // leisure stacks a little; everything else takes the best provider
      grid[i] = key === 'leisure' ? Math.min(2, grid[i] + v * 0.6) : Math.max(grid[i], v);
    });
  }
  // City-wide reach of the "Import City Services" policy
  if (state.policies.importServices) {
    for (const k of ['health', 'fire', 'police', 'garbage', 'death']) {
      const g = ctx.coverage[k];
      for (let i = 0; i < g.length; i++) g[i] = Math.max(g[i], 0.45);
    }
  }
  ctx.coverageReady = true;
}

export const covAt = (ctx, key, b) => (ctx.coverage[key] ? ctx.coverage[key][centerIdx(b)] : 0);

// ------------------------------------------------------- hourly collection rounds
// Facilities pick up from the nearest buildings first, up to their hourly capacity.
// Hearses work through a day's capacity in a few hours (the deceased of a day all turn up
// at midnight), so they're done by the morning instead of all day.
const HEARSE_HOURS = 6;
function collect(state, ctx, filter, rateKey, field, onCollect) {
  const providers = [...state.buildings.values()].filter((b) => isService(b) && b.def[rateKey] && filter(b));
  if (!providers.length) return 0;
  const consumers = [...state.buildings.values()].filter((b) => b[field] > 0.01);
  const day = state.time.day;
  let total = 0;
  for (const p of providers) {
    const def = p.def;
    if (p.doneDay !== day) { p.doneDay = day; p.doneYesterday = p.doneToday || 0; p.doneToday = 0; }
    if (def.storage && p.stored >= storageCap(p)) { p.full = true; continue; }
    p.full = false;
    const eff = p.efficiency ?? serviceEfficiency(state, p);
    const daily = def[rateKey] * eff * (rateKey === 'garbageRate' && hasPerk(state, 'garbage_trucks') ? 1.2 : 1);
    let cap = rateKey === 'deathRate' ? Math.min(daily / HEARSE_HOURS, daily - p.doneToday) : daily / 24;
    if (def.storage) cap = Math.min(cap, storageCap(p) - p.stored);
    if (cap <= 0) { p.load = 0; continue; }
    const [px, py] = center(p);
    const r2 = (def.radius || 999) ** 2;
    const near = consumers
      .map((c) => { const [x, y] = center(c); return [c, (x - px) ** 2 + (y - py) ** 2]; })
      .filter(([c, d2]) => d2 <= r2 && (!p.serveDistrict || c.district === p.serveDistrict))
      .sort((a, b) => a[1] - b[1]);
    let got = 0;
    for (const [c] of near) {
      if (got >= cap) break;
      const take = Math.min(c[field], cap - got);
      c[field] -= take;
      got += take;
    }
    p.load = got;
    p.doneToday += got;
    if (def.storage) {
      p.stored += got;
      // the mound on the site grows in steps you can see
      const bucket = Math.floor((p.stored / storageCap(p)) * 10);
      if (bucket !== p.fillBucket) { p.fillBucket = bucket; bus.emit('building:changed', p); }
    }
    total += got;
    onCollect?.(p, got);
  }
  return total;
}

export function hourlyCollections(state, ctx) {
  const imported = state.policies.importServices;
  ctx.hourly = ctx.hourly || {};
  // Garbage is collected by trucks (sim/garbage.js); what incinerators burned this hour
  // becomes electricity
  ctx.hourly.incineratedPower = (ctx.burnedHour || 0) * 0.12; // MW from burning
  ctx.burnedHour = 0;
  collect(state, ctx, () => true, 'mail', 'mailOut');
  collect(state, ctx, () => true, 'deathRate', 'dead');
  // how long the deceased have been waiting in each building (for the warning and well-being)
  for (const b of state.buildings.values()) {
    if ((b.dead || 0) > 0.01) b.deadHours = (b.deadHours || 0) + 1;
    else if (b.deadHours) b.deadHours = 0;
  }
  // Imported services quietly handle some of the leftovers, for a fee
  if (imported) {
    let fee = 0;
    for (const b of state.buildings.values()) {
      if (b.garbage > 2) { fee += b.garbage * 4; b.garbage *= 0.6; }
      if (b.dead > 0) { fee += b.dead * 120; b.dead = 0; }
    }
    charge(state, 'imports', fee);
  }
}
