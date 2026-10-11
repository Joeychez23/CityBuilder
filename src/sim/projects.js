// Projects you lay out on the map (data/projects.js): areas you draw (Central Park, beaches,
// the boardwalk), the theme park and its rides, and canals and the water taxis on them.
import { N, idx, inBounds, DIRS, clamp, hidx } from '../core/grid.js';
import { isService, center, serviceEfficiency, touchesGroundRoad, areaCost } from './services.js';
import { createBuilding, footprintBlocker, spend, isOwned, removeBuilding, clearZoneCell, MAX_BUILD_SLOPE } from './build.js';
import { cellHeight, cellSlope, recomputeWater } from './mapgen.js';
import { labelComponents } from './networks.js';
import { startConstruction } from './construction.js';
import { earn } from './economy.js';
import { monthlyMean } from './climate.js';
import { monthFloat, dateOf } from './simulation.js';
import { CLIMATES } from '../data/maps.js';
import { PARK_REACH } from '../data/projects.js';
import { bus } from '../core/events.js';
import { rng } from '../core/rng.js';
import { astar } from './pathfind.js';

const EDU_MIX = [0.3, 0.35, 0.22, 0.1, 0.03];
const SAND = 4; // the Sand surface paint (world/overlays.js SURFACES)

// A beach taken away takes its sand with it
export function clearSand(state, b) {
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) if (state.surface[idx(x, y)] === SAND) state.surface[idx(x, y)] = 0;
  bus.emit('surface:changed');
}

// ------------------------------------------------------------------ areas
// How much the weather favours a day at the beach (0.1 in a cold month .. 1.4 in high summer)
export function beachWeather(state) {
  const t = monthlyMean(CLIMATES[state.climate], monthFloat(state) - 0.5);
  return clamp((t - 9) / 13, 0.1, 1.4) * (state.weather.rain > 0.5 ? 0.6 : 1);
}

const roadNear = (state, [x0, y0, x1, y1], reach) => {
  for (let y = y0 - reach; y <= y1 + reach; y++) for (let x = x0 - reach; x <= x1 + reach; x++) {
    if ((x >= x0 && x <= x1 && y >= y0 && y <= y1) || !inBounds(x, y)) continue;
    const i = idx(x, y);
    if (state.road[i] && !state.bridgeH[i]) return true;
  }
  return false;
};
const nearWaterCell = (state, x, y, r) => {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (inBounds(x + dx, y + dy) && state.water[idx(x + dx, y + dy)]) return true;
  return false;
};

// The side of a rectangle to face: one with a road along it (else the nearest water)
function facingSide(state, [x0, y0, x1, y1]) {
  for (const rot of [1, 3, 0, 2]) {
    const [dx, dy] = DIRS[rot];
    const cells = dx ? Array.from({ length: y1 - y0 + 1 }, (_, k) => [dx > 0 ? x1 + 1 : x0 - 1, y0 + k]) : Array.from({ length: x1 - x0 + 1 }, (_, k) => [x0 + k, dy > 0 ? y1 + 1 : y0 - 1]);
    if (cells.some(([x, y]) => inBounds(x, y) && state.road[idx(x, y)] && !state.bridgeH[idx(x, y)])) return rot;
  }
  // a strip lies along its length
  return x1 - x0 >= y1 - y0 ? 1 : 0;
}

export function planArea(state, def, rect) {
  const [x0, y0, x1, y1] = rect;
  const w = x1 - x0 + 1, h = y1 - y0 + 1, cells = w * h;
  const A = def.area;
  const plan = { rect, w, h, cells, cost: areaCost(def, cells), reason: null };
  const short = Math.min(w, h), long = Math.max(w, h);
  if (A.strip ? short > 2 : short < A.min) plan.reason = A.strip ? 'A boardwalk is 1 or 2 cells wide' : `At least ${A.min} × ${A.min} cells`;
  else if (long > A.max) plan.reason = `At most ${A.max} cells long`;
  else if (A.strip && long < 3) plan.reason = 'At least 3 cells long';
  if (plan.reason) return plan;
  plan.reason = footprintBlocker(state, x0, y0, x1, y1);
  // (a beach can run down a sloping shore: it lies on the ground as it is)
  if (plan.reason === 'Too steep here' && def.sand) {
    let steep = false;
    for (let y = y0; y <= y1 && !steep; y++) for (let x = x0; x <= x1; x++) if (cellSlope(state, x, y) > 2.6) { steep = true; break; }
    plan.reason = steep ? 'Too steep here' : null;
  }
  if (plan.reason) return plan;
  if (A.shore) {
    let wet = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (nearWaterCell(state, x, y, A.strip ? 2 : 1)) wet++;
    if (wet < Math.max(1, cells * (A.strip ? 0.6 : 0.25))) { plan.reason = A.strip ? 'Draw it along the water\'s edge' : 'A beach has to touch the water'; return plan; }
    if (!roadNear(state, rect, 3)) { plan.reason = 'Needs a road within 3 cells'; return plan; }
  } else if (!touchesGroundRoad(state, x0, y0, x1, y1)) plan.reason = 'Needs a road along one side';
  return plan;
}

export function placeArea(state, ctx, def, rect) {
  const plan = planArea(state, def, rect);
  if (plan.reason) return { error: plan.reason };
  if (!spend(state, plan.cost, def.cat)) return { error: 'Not enough money' };
  const keep = def.sand ? Float32Array.from(state.height) : null;
  const b = createBuilding(state, 'service', def, ...rect, facingSide(state, rect), { stored: 0, load: 0, staff: def.workers || 0 });
  if (keep) {
    // a beach keeps the shore's slope (no levelling), and the sand is painted on the ground
    state.height.set(keep);
    for (let y = rect[1]; y <= rect[3]; y++) for (let x = rect[0]; x <= rect[2]; x++) state.surface[idx(x, y)] = SAND;
    bus.emit('surface:changed');
  }
  Object.assign(b, def.scale(plan.cells));
  b.jobs = def.workers || 0;
  b.jobsEdu = EDU_MIX.map((v) => Math.round(v * b.jobs));
  b.jobsEdu[0] += b.jobs - b.jobsEdu.reduce((a, c) => a + c, 0);
  startConstruction(state, b);
  bus.emit('xp', { amount: Math.max(5, Math.round(plan.cost / 4000)), reason: 'service' });
  bus.emit('services:changed');
  return { building: b, plan };
}

// ---------------------------------------------------------------- theme park
export const themeGate = (state) => { for (const b of state.buildings.values()) if (b.def.themeGate) return b; return null; };
export const DEFAULT_TICKET = 30;

export function rideBlocker(state, def, x0, y0, x1, y1) {
  const g = themeGate(state);
  if (!g) return 'Build the Theme Park Gate first';
  const [gx, gy] = center(g);
  if (Math.hypot((x0 + x1) / 2 - gx, (y0 + y1) / 2 - gy) > PARK_REACH) return `Too far from the gate (rides stand within ${PARK_REACH * 8} m of it)`;
  return null;
}

// Daily: who comes to the park, how long they queue, what the tickets earn
export function themeParkDaily(state, ctx) {
  const g = themeGate(state);
  if (!g || g.cons) return;
  const [gx, gy] = center(g);
  const rides = [...state.buildings.values()].filter((b) => isService(b) && b.def.ride && Math.hypot(center(b)[0] - gx, center(b)[1] - gy) <= PARK_REACH + 3);
  const seen = new Map();
  let capacity = 0, appeal = 0;
  for (const r of rides) {
    const eff = Math.min(1, serviceEfficiency(state, r));
    r.efficiency = eff;
    capacity += r.def.ride.capacity * eff;
    const n = seen.get(r.def.id) || 0;
    appeal += r.def.ride.appeal * (n ? 0.5 / n : 1) * eff;
    seen.set(r.def.id, n + 1);
  }
  const ticket = g.ticket ?? DEFAULT_TICKET;
  const open = Math.min(1, serviceEfficiency(state, g));
  const wd = dateOf(state.time.day).weekday;
  const price = clamp(1.35 - ticket / 55, 0.15, 1.3);
  const want = rides.length ? ((state.stats.tourists || 0) * (0.1 + Math.min(0.4, appeal / 45)) + state.citizens.size * 0.008 * (1 + appeal / 15)) * price * (wd === 0 || wd >= 5 ? 1.3 : 0.9) * open : 0;
  // each visitor rides about three times; queues past an hour and a half put people off
  const queue = capacity > 0 ? (want * 3 / capacity) * 1.2 : 0;
  const stay = queue > 1.5 ? clamp(1.5 / queue, 0.35, 1) : 1;
  const visitors = Math.round(want * stay);
  g.visitors = visitors;
  g.queue = capacity > 0 ? (visitors * 3 / capacity) * 1.2 : 0;
  g.capacity = Math.round(capacity);
  g.appeal = appeal;
  g.rides = rides.length;
  g.turnedAway = Math.round(want - visitors);
  g.ticketIncome = visitors * ticket;
  g.parkAttract = rides.length ? 4 + appeal * 1.6 * (g.queue > 2 ? 0.6 : 1) : 0;
  for (const r of rides) r.riders = capacity > 0 ? Math.round(visitors * 3 * (r.def.ride.capacity * (r.efficiency ?? 1)) / capacity) : 0;
  earn(state, 'themepark', g.ticketIncome);
}

// ------------------------------------------------------------ the boardwalk
// Its kiosks sell to the people out by the water (more in summer); the city takes the money
export function boardwalksDaily(state) {
  const walks = [...state.buildings.values()].filter((b) => isService(b) && b.def.promenade);
  if (!walks.length) return;
  const sun = beachWeather(state);
  const crowd = ((state.stats.tourists || 0) * 0.35 + state.citizens.size * 0.01) * sun;
  const total = walks.reduce((a, b) => a + (b.attract || 1), 0);
  let income = 0;
  for (const b of walks) {
    const cap = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * 30 * Math.min(1, serviceEfficiency(state, b));
    b.customers = Math.round(Math.min(cap, crowd * ((b.attract || 1) / total)));
    b.kioskIncome = b.customers * 9;
    income += b.kioskIncome;
  }
  earn(state, 'promenade', income);
}

// ------------------------------------------------------------------ canals
export const CANAL_COST = 900; // per cell dug
export const CANAL_SIDE_SLOPE = 3.5; // the land along a canal can be steep: buildings stand on quays

// Cells a canal from a to b covers: straight along whichever axis is longer, `width` wide
export function canalCells(a, b, width) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const alongX = Math.abs(dx) >= Math.abs(dy);
  const out = [];
  const len = alongX ? Math.abs(dx) : Math.abs(dy), s = Math.sign(alongX ? dx : dy) || 1;
  for (let k = 0; k <= len; k++) for (let w = 0; w < width; w++) {
    const x = alongX ? a[0] + k * s : a[0] + w, y = alongX ? a[1] + w : a[1] + k * s;
    if (inBounds(x, y)) out.push([x, y]);
  }
  return out;
}

export function planCanal(state, cells) {
  const ok = [], bad = [];
  let joins = false;
  const set = new Set(cells.map(([x, y]) => idx(x, y)));
  for (const [x, y] of cells) {
    const i = idx(x, y);
    if (state.water[i]) { joins = true; continue; }
    const b = state.bld[i] && state.buildings.get(state.bld[i]);
    if (!isOwned(state, x, y) || state.road[i] || state.rail[i] || state.power[i] || state.path[i] || (b && b.kind !== 'zone') || (b && b.def.signature)) { bad.push([x, y]); continue; }
    ok.push([x, y]);
    for (const [dx, dy] of DIRS) { const j = idx(x + dx, y + dy); if (inBounds(x + dx, y + dy) && state.water[j] && !set.has(j)) joins = true; }
  }
  return { ok, bad, cost: ok.length * CANAL_COST, joins, reason: bad.length ? 'Something is in the way (roads need a bridge over the canal afterwards)' : !joins ? 'A canal has to join the water (a river, lake, the sea or another canal)' : !ok.length ? 'Already water' : null };
}

// Dig: the canal's cells drop below the water; the corners inside it go deep, the ones on its
// banks only just under water, so the land beside it stays where it was (on quays)
export function digCanal(state, cells) {
  const plan = planCanal(state, cells);
  if (plan.reason) return { error: plan.reason };
  if (!spend(state, plan.cost, 'canal')) return { error: 'Not enough money' };
  const sea = state.seaLevel;
  for (const [x, y] of plan.ok) {
    const i = idx(x, y);
    const b = state.bld[i] && state.buildings.get(state.bld[i]);
    if (b) removeBuilding(state, b.id);
    clearZoneCell(state, i);
    state.tree[i] = 0; state.forestMax[i] = 0;
    state.canal[i] = 1;
  }
  const wet = (x, y) => inBounds(x, y) && (state.canal[idx(x, y)] || state.water[idx(x, y)]);
  let x0 = N, y0 = N, x1 = 0, y1 = 0;
  for (const [x, y] of plan.ok) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    for (const [cx, cy] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) {
      const inside = wet(cx - 1, cy - 1) && wet(cx, cy - 1) && wet(cx - 1, cy) && wet(cx, cy);
      const k = hidx(cx, cy);
      state.height[k] = Math.min(state.height[k], inside ? sea - 2 : sea + 0.02);
    }
  }
  // a 1-wide canal has no corners inside it: deepen its middle so it still holds water
  for (const [x, y] of plan.ok) if (cellHeight(state, x, y) >= sea - 0.05) for (const [cx, cy] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) state.height[hidx(cx, cy)] = Math.min(state.height[hidx(cx, cy)], sea - 0.3);
  recomputeWater(state, Math.max(0, x0 - 1), Math.max(0, y0 - 1), Math.min(N - 1, x1 + 1), Math.min(N - 1, y1 + 1));
  bus.emit('terrain:changed', { x0: x0 - 1, y0: y0 - 1, x1: x1 + 1, y1: y1 + 1 });
  bus.emit('canal:changed');
  bus.emit('trees:changed');
  bus.emit('zones:changed', { count: 0 });
  return { plan };
}

// Land along a canal (within 2 cells): steep is fine there (quays), and it's worth more
let sideMask = null, sideState = null;
bus.on('canal:changed', () => { sideMask = null; });
bus.on('terrain:changed', () => { sideMask = null; });
export function canalSide(state, i) {
  if (!state.canal) return false;
  if (!sideMask || sideState !== state) {
    sideMask = new Uint8Array(N * N);
    sideState = state;
    for (let k = 0; k < N * N; k++) {
      if (!state.canal[k]) continue;
      const x = k % N, y = (k / N) | 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (inBounds(x + dx, y + dy)) sideMask[idx(x + dx, y + dy)] = 1;
    }
  }
  return sideMask[i] === 1;
}
// The steepest a cell may be to build on (land beside a canal stands on quays)
export const maxSlopeAt = (state, x, y) => (state.canal && canalSide(state, idx(x, y)) ? CANAL_SIDE_SLOPE : MAX_BUILD_SLOPE);

// ------------------------------------------------------------- water taxis
// Piers on the same body of water are joined by water taxis. Routes (and their paths over
// the water, for the boats you see) are worked out again when piers or the water change.
let waterComp = null, waterStamp = -1;
bus.on('terrain:changed', () => { waterStamp = -1; });
bus.on('canal:changed', () => { waterStamp = -1; });
function pierWater(state, b) {
  let best = -1, bd = 1e9;
  const [cx, cy] = center(b);
  for (let y = b.y0 - 2; y <= b.y1 + 2; y++) for (let x = b.x0 - 2; x <= b.x1 + 2; x++) {
    if (!inBounds(x, y) || !state.water[idx(x, y)]) continue;
    const d = Math.abs(x - cx) + Math.abs(y - cy);
    if (d < bd) { bd = d; best = idx(x, y); }
  }
  return best;
}
export function waterTaxiRoutes(state, ctx) {
  const piers = [...state.buildings.values()].filter((b) => isService(b) && b.def.waterTaxi);
  const key = piers.map((p) => p.id).join(',');
  if (ctx.taxiRoutesKey === key && waterStamp === ctx.waterTaxiStamp && ctx.taxiRoutes) return ctx.taxiRoutes;
  if (waterStamp < 0) { waterComp = labelComponents(state.water).comp; waterStamp = (ctx.waterTaxiStamp || 0) + 1; }
  ctx.waterTaxiStamp = waterStamp;
  ctx.taxiRoutesKey = key;
  const at = piers.map((p) => ({ pier: p, cell: pierWater(state, p) })).filter((p) => p.cell >= 0);
  const routes = [];
  for (let a = 0; a < at.length; a++) for (let c = a + 1; c < at.length; c++) {
    if (waterComp[at[a].cell] !== waterComp[at[c].cell]) continue;
    const path = astar(at[a].cell, at[c].cell, (i) => state.water[i] > 0, () => 1, 1, 20000);
    if (path) routes.push({ a: at[a].pier.id, b: at[c].pier.id, path, riders: 0 });
  }
  ctx.taxiRoutes = routes;
  bus.emit('watertaxi:routes', routes);
  return routes;
}

// Called by traffic: does a water taxi serve this trip (a pier near each end, on the same
// water)? Returns the route, or null.
export function waterTaxiOption(state, ctx, a, b, dist) {
  const routes = ctx.taxiRoutes;
  if (!routes?.length || dist < 10) return null;
  const ax = a % N, ay = (a / N) | 0, bx = b % N, by = (b / N) | 0;
  const near = (p, x, y) => { const pb = state.buildings.get(p); if (!pb) return false; const [px, py] = center(pb); return Math.abs(px - x) + Math.abs(py - y) <= 9; };
  for (const r of routes) {
    if ((near(r.a, ax, ay) && near(r.b, bx, by)) || (near(r.b, ax, ay) && near(r.a, bx, by))) return rng.chance(0.5) ? r : null;
  }
  return null;
}
export const WATER_TAXI_FARE = 3;
export function waterTaxisDaily(state, ctx) {
  waterTaxiRoutes(state, ctx);
  let riders = 0;
  for (const r of ctx.taxiRoutes || []) { r.ridersYesterday = Math.round(r.riders); riders += r.riders; r.riders = 0; }
  state.stats.waterTaxiRiders = Math.round(riders);
  earn(state, 'transit', riders * WATER_TAXI_FARE);
}

export const slopeOK = (state, x, y) => cellSlope(state, x, y) <= maxSlopeAt(state, x, y);
