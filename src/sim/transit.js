// Public transport lines (bus, tram, train, subway), taxis, cargo terminals and the city's
// outside travel connections (rail, sea, air).
import { N, idx, clamp } from '../core/grid.js';
import { UPG } from '../data/roads.js';
import { LINE_TYPES } from '../data/transport.js';
import { astar } from './pathfind.js';
import { isService, center, serviceEfficiency } from './services.js';
import { hourOf } from './simulation.js';
import { rng } from '../core/rng.js';
import { newId } from '../core/state.js';
import { makeRoadCost } from './traffic.js';
import { linked } from './bridges.js';
import { hasPerk } from '../data/progression.js';
import { earn, charge } from './economy.js';

export const LINE_COLORS = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff'];
export const DEFAULT_TICKET = { bus: 2, tram: 2, train: 4, subway: 3 };

function stationCells(state, type) {
  const set = new Set();
  const want = LINE_TYPES[type].station;
  if (!want) return set;
  for (const b of state.buildings.values()) {
    if (b.def.id !== want) continue;
    for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) set.add(idx(x, y));
  }
  return set;
}

export function passableFor(state, type) {
  if (type === 'bus') return (i) => state.road[i] > 0;
  if (type === 'tram') return (i) => state.road[i] > 0 && (state.roadUpg[i] & UPG.TRAM) > 0;
  const stations = stationCells(state, type);
  if (type === 'train') return (i) => state.rail[i] > 0 || stations.has(i);
  return (i) => state.subway[i] > 0 || stations.has(i);
}

// Can this cell be a stop for this line type? Returns the stop cell (or -1).
export function stopCellFor(state, type, cell) {
  if (type === 'bus') return state.road[cell] ? cell : -1;
  if (type === 'tram') return state.road[cell] && state.roadUpg[cell] & UPG.TRAM ? cell : -1;
  const b = state.buildings.get(state.bld[cell]);
  if (b && b.def.id === LINE_TYPES[type].station) return idx(...center(b));
  return -1;
}

export function computeLinePath(state, ctx, line) {
  const pass = passableFor(state, line.type);
  const cost = line.type === 'bus' || line.type === 'tram' ? makeRoadCost(state, ctx, 'bus')
    : line.type === 'train' ? (f, t, d) => (state.rail[f] && state.rail[t] && !linked(state, 'rail', f, t, d) ? Infinity : 1) : () => 1;
  const path = [];
  const stopIndex = [];
  const n = line.stops.length;
  if (n < 2) { line.path = null; line.valid = false; return; }
  for (let k = 0; k < n; k++) {
    const a = line.stops[k], b = line.stops[(k + 1) % n];
    const seg = astar(a, b, pass, (f, t, d) => (Number.isFinite(cost(f, t, d)) ? Math.max(0.3, cost(f, t, d)) : 3), 0.3, N * N);
    if (!seg) { line.path = null; line.valid = false; line.problem = `No ${LINE_TYPES[line.type].name.toLowerCase()} route between stops ${k + 1} and ${((k + 1) % n) + 1}`; return; }
    stopIndex.push(path.length);
    path.push(...(k === 0 ? seg : seg.slice(1)));
  }
  line.path = path;
  line.stopIndex = stopIndex;
  line.length = path.length;
  line.valid = true;
  line.problem = null;
}

export function createLine(state, ctx, type, stops) {
  const id = newId(state);
  const k = state.lines.length;
  const line = {
    id, type, stops, name: `${LINE_TYPES[type].name} Line ${state.lines.filter((l) => l.type === type).length + 1}`,
    color: LINE_COLORS[k % LINE_COLORS.length], vehicles: 2, ticket: DEFAULT_TICKET[type], schedule: 'both',
    riders: 0, ridersToday: 0, usage: 0, active: true,
  };
  computeLinePath(state, ctx, line);
  state.lines.push(line);
  return line;
}

export function depotOK(state, type) {
  const def = LINE_TYPES[type];
  if (def.station) return [...state.buildings.values()].filter((b) => b.def.id === def.station && !b.cons).length >= 1;
  return [...state.buildings.values()].some((b) => b.def.id === def.depot && !b.cons);
}

export function maxVehicles(state, type) {
  const def = LINE_TYPES[type];
  if (def.station) return 12;
  let n = 0;
  for (const b of state.buildings.values()) if (b.def.id === def.depot && !b.cons) n += b.def.vehicles;
  return n;
}

// When lines run. A line only costs upkeep for the hours it runs.
export const SCHEDULES = {
  both: { name: 'Day & night', hours: 24, runs: () => true },
  day: { name: 'Day only (6:00–22:00)', hours: 16, runs: (h) => h >= 6 && h < 22 },
  rush: { name: 'Rush hours (6–10, 15–19)', hours: 8, runs: (h) => (h >= 6 && h < 10) || (h >= 15 && h < 19) },
  night: { name: 'Night only (22:00–6:00)', hours: 8, runs: (h) => h >= 22 || h < 6 },
};
export const scheduleShare = (line) => (SCHEDULES[line.schedule] || SCHEDULES.both).hours / 24;
// Upkeep per day for a line: per vehicle, for the share of the day it runs
export const lineUpkeep = (line) => LINE_TYPES[line.type].upkeep * line.vehicles * scheduleShare(line);

export function lineRunning(state, line) {
  if (!line.valid || !line.active || !line.vehicles) return false;
  return (SCHEDULES[line.schedule] || SCHEDULES.both).runs(hourOf(state));
}

export function dailyCapacity(line) {
  const def = LINE_TYPES[line.type];
  const loopHours = Math.max(0.3, (line.length || 30) / (60 * def.speed));
  return line.vehicles * def.capacity * ((24 * scheduleShare(line)) / loopHours) * 0.25;
}

// Called by traffic sampling: is there a line that serves both ends and beats driving?
export function transitOption(state, ctx, a, b, dist, hasCar) {
  if (!state.lines.length) return null;
  const ax = a % N, ay = (a / N) | 0, bx = b % N, by = (b / N) | 0;
  let best = null, bestCost = Infinity;
  for (const line of state.lines) {
    if (!lineRunning(state, line)) continue;
    const def = LINE_TYPES[line.type];
    const r = def.stopRadius;
    let ia = -1, ib = -1, da = 1e9, db = 1e9;
    line.stops.forEach((s, k) => {
      const sx = s % N, sy = (s / N) | 0;
      const d1 = Math.abs(sx - ax) + Math.abs(sy - ay), d2 = Math.abs(sx - bx) + Math.abs(sy - by);
      if (d1 <= r && d1 < da) { da = d1; ia = k; }
      if (d2 <= r && d2 < db) { db = d2; ib = k; }
    });
    if (ia < 0 || ib < 0 || ia === ib) continue;
    if ((line.ridersToday || 0) >= dailyCapacity(line)) continue;
    const ride = (dist * 0.8) / def.speed;
    const cost = (da + db) * 0.6 + ride + line.ticket + 3 / Math.max(1, line.vehicles) - (hasPerk(state, 'transit_priority') ? 2 : 0);
    if (cost < bestCost) { bestCost = cost; best = line; }
  }
  if (!best) return null;
  const parking = state.fees.parking * 0.3;
  const carCost = dist * 0.9 * (1 + (1 - (state.stats.trafficFlow ?? 1)) * 2) + parking + 4;
  const p = hasCar ? clamp(0.5 + (carCost - bestCost) / 20, 0.05, 0.9) : 0.95;
  return rng.chance(p) ? { line: best } : null;
}

// Daily: fares, upkeep, usage stats, taxis, cargo and outside access
export function transitDaily(state, ctx) {
  let income = 0, upkeep = 0;
  const budget = (state.budgets.transport ?? 100) / 100;
  for (const line of state.lines) {
    if (!line.valid) computeLinePath(state, ctx, line);
    line.riders = Math.round(line.ridersToday || 0);
    line.usage = line.valid ? clamp(line.riders / Math.max(1, dailyCapacity(line)), 0, 1) : 0;
    income += line.riders * line.ticket;
    line.ridersToday = 0;
    // vehicles only cost money for the hours they're out (a day-only line costs two thirds)
    if (line.active && line.valid) upkeep += lineUpkeep(line) * budget;
  }
  // Taxis: households without cars use them; the minimum-fare policy earns more per ride
  let taxis = 0;
  for (const b of state.buildings.values()) if (b.def.id === 'taxidepot' && !b.cons) taxis += b.def.vehicles * serviceEfficiency(state, b);
  ctx.taxis = taxis;
  const fare = 4 + (state.policies.taxiMinFare ? 6 : 0);
  income += Math.min(ctx.taxiTrips || 0, taxis * 40) * fare * (state.policies.taxiMinFare ? 0.8 : 1);
  ctx.taxiTrips = 0;

  // How expensive getting around feels (0 = normal). Ticket prices above the default, parking
  // fees and road tolls above normal, and the minimum taxi fare all count.
  const active = state.lines.filter((l) => l.valid && l.active && l.vehicles > 0);
  const ticketOver = active.length ? active.reduce((a, l) => a + Math.max(0, l.ticket - DEFAULT_TICKET[l.type]) / DEFAULT_TICKET[l.type], 0) / active.length : 0;
  const parkingOver = Math.max(0, state.fees.parking - 10) / 10;
  const tollOver = ctx.tollBooths ? Math.max(0, (state.fees.toll ?? 3) - 3) / 3 : 0;
  ctx.transportCost = {
    transit: ticketOver * 7 + (state.policies.taxiMinFare ? 2 : 0),
    car: parkingOver * 6 + tollOver * 6 + (ctx.tollBooths ? 0.5 : 0),
  };
  state.stats.transportCost = ctx.transportCost;

  // Cargo terminals count only when they reach the outside world
  let cargo = 0;
  const access = { rail: false, ship: false, air: false };
  for (const b of state.buildings.values()) {
    if (b.kind !== 'transport' || b.cons) continue;
    const id = b.def.id;
    const railOutside = (() => {
      for (let y = b.y0 - 1; y <= b.y1 + 1; y++) for (let x = b.x0 - 1; x <= b.x1 + 1; x++) {
        if (x < 0 || y < 0 || x >= N || y >= N) continue;
        const c = ctx.net.railComp?.[idx(x, y)];
        if (c >= 0 && ctx.net.railOutside[c]) return true;
      }
      return false;
    })();
    if (id === 'cargotrain' && railOutside) cargo += b.def.cargo;
    if ((id === 'cargoharbor') && state.connectionsAvailable.ship) cargo += b.def.cargo;
    if (id === 'airport') { cargo += b.def.cargo; access.air = true; }
    if (id === 'trainstation' && railOutside) access.rail = true;
    if (id === 'harbor' && state.connectionsAvailable.ship) access.ship = true;
  }
  ctx.cargoCapacity = cargo;
  ctx.transitAccess = access;
  state.stats.cargoCapacity = cargo;
  state.stats.transitAccess = access;
  state.stats.transitRiders = state.lines.reduce((a, l) => a + l.riders, 0);
  state.stats.activeLines = state.lines.filter((l) => l.valid && l.active && l.vehicles > 0).length;

  earn(state, 'transit', income);
  charge(state, 'transit', upkeep);

  // Transit coverage raises land value around stops
  const cov = ctx.transitCov || (ctx.transitCov = new Float32Array(N * N));
  cov.fill(0);
  for (const line of state.lines) {
    if (!line.valid || !line.active) continue;
    const r = LINE_TYPES[line.type].stopRadius;
    for (const s of line.stops) {
      const sx = s % N, sy = (s / N) | 0;
      for (let y = Math.max(0, sy - r); y <= Math.min(N - 1, sy + r); y++) {
        for (let x = Math.max(0, sx - r); x <= Math.min(N - 1, sx + r); x++) {
          const d = Math.abs(x - sx) + Math.abs(y - sy);
          if (d <= r) cov[idx(x, y)] = Math.max(cov[idx(x, y)], 1 - d / (r + 1));
        }
      }
    }
  }
}

export function isTransportStation(b) { return isService(b) && b.def.station; }
