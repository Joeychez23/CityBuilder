// Traffic: sampled trips (commutes, shopping, trucks, service vehicles, tourists) are routed
// with A* over roads. Each sampled trip stands for many real ones and adds to the road's
// volume; congestion raises travel cost, so later trips route around jams. What a road can
// carry depends on its lanes, and junctions carry less (cars take turns at the lights).
// Where a road is over capacity the queue backs up onto the roads leading into it.
import { N, idx, DIRS, inBounds, clamp } from '../core/grid.js';
import { ROADS, UPG, rankOf } from '../data/roads.js';
import { astar } from './pathfind.js';
import { buildingRoadComp } from './networks.js';
import { isService, center } from './services.js';
import { hourOf } from './simulation.js';
import { rng } from '../core/rng.js';
import { bus } from '../core/events.js';
import { transitOption } from './transit.js';
import { linked, roadLinks, roadMasks } from './bridges.js';
import { hasPerk } from '../data/progression.js';
import { earn } from './economy.js';
import { isOwned } from './build.js';
import { waterTaxiOption } from './projects.js';
import { tunnelLinks } from './tunnels.js';

const NN = N * N;

// Roads a road cell connects to (3 or more = a junction)
export const roadNeighbours = (state, i) => roadLinks(state, i);

// How a junction is controlled: 0 none, 1 traffic lights, 2 roundabout, 3 give way (small
// roads: one car at a time), 4 merge (highways and one-way roads), 5 priority (a local street
// joins a bigger through road and gives way to it: the main road keeps most of its flow).
// That's the road hierarchy at work: local streets should feed collectors, collectors feed
// avenues; where bigger roads meet there are lights.
// (worked out for every road cell once per network change: routing asks constantly)
let kinds = null, kindsState = null, kindsDirty = true;
bus.on('network:changed', () => { kindsDirty = true; });
export function junctionKind(state, i) {
  if (kindsDirty || !kinds || kindsState !== state) {
    if (!kinds || kinds.length !== NN) kinds = new Uint8Array(NN);
    kindsState = state;
    kindsDirty = false;
    for (let k = 0; k < NN; k++) kinds[k] = state.road[k] ? computeKind(state, k) : 0;
  }
  return kinds[i];
}
function computeKind(state, i) {
  const t = state.road[i];
  if (!t || roadNeighbours(state, i) < 3) return 0;
  if (state.roadUpg[i] & UPG.ROUNDABOUT) return 2;
  if (ROADS[t].key === 'highway') return 4;
  const x = i % N, y = (i / N) | 0;
  const links = roadMasks(state)[i];
  let big = 0, oneway = true, top = -1, topCount = 0, n = 0, sideMax = -1;
  for (let d = 0; d < 4; d++) {
    if (!(links & (1 << d))) continue;
    const nt = state.road[idx(x + DIRS[d][0], y + DIRS[d][1])];
    if (!nt) continue;
    n++;
    big = Math.max(big, ROADS[nt].capacity);
    if (!ROADS[nt].oneway) oneway = false;
    const r = rankOf(nt);
    if (r > top) { top = r; topCount = 1; } else if (r === top) topCount++;
  }
  if (oneway) return 4;
  for (let d = 0; d < 4; d++) {
    if (!(links & (1 << d))) continue;
    const r = rankOf(state.road[idx(x + DIRS[d][0], y + DIRS[d][1])]);
    if (r < top) sideMax = Math.max(sideMax, r);
  }
  // a collector or bigger runs straight through and only local streets join it from the side
  if (topCount === 2 && top > 0 && n > 2 && sideMax === 0 && throughRoad(state, i, links, top)) return 5;
  return big <= 10 ? 3 : 1;
}

// Do the two biggest roads at a junction line up (enter on one side, leave on the other)?
function throughRoad(state, i, links, rank) {
  const x = i % N, y = (i / N) | 0;
  const isTop = (d) => (links & (1 << d)) && rankOf(state.road[idx(x + DIRS[d][0], y + DIRS[d][1])]) === rank;
  return (isTop(0) && isTop(2)) || (isTop(1) && isTop(3));
}

// Is this a side street arriving at a priority junction (it has to give way)?
export function givesWay(state, from, junction) {
  return junctionKind(state, junction) === 5 && rankOf(state.road[from]) < rankOf(state.road[junction]);
}

// Vehicles per cell this road cell carries before slowing down. Driveways onto an avenue
// (and, less, onto a collector) take some of it: cars slowing to turn in and out.
const JUNCTION_SHARE = [1, 0.55, 0.85, 0.5, 0.9, 0.82];
let driveways = null;
export const drivewaysAt = (i) => (driveways ? driveways[i] : 0);
export function cellCapacity(state, i) {
  const t = state.road[i];
  if (!t) return 1;
  const def = ROADS[t];
  let cap = def.capacity * JUNCTION_SHARE[junctionKind(state, i)];
  const dw = driveways ? driveways[i] : 0;
  if (dw && (def.cls === 'arterial' || def.cls === 'collector')) cap *= 1 - Math.min(0.3, dw * (def.cls === 'arterial' ? 0.08 : 0.04));
  return cap;
}

// Count the buildings whose driveway meets each road cell (hourly)
function countDriveways(state, ctx) {
  if (!driveways || driveways.length !== NN) driveways = new Uint8Array(NN);
  else driveways.fill(0);
  for (const b of state.buildings.values()) {
    if (b.cons) continue;
    const a = accessCell(state, ctx, b);
    if (a >= 0 && driveways[a] < 255) driveways[a]++;
  }
}
// Travel time multiplier for a volume/capacity ratio (gentle until full, then steep)
export const jamFactor = (r) => 1 + 1.2 * r * r + 0.8 * r * r * r * r;
export const congestion = (state, i) => state.roadVol[i] / cellCapacity(state, i);

// Build the travel-cost function for a vehicle type
export function makeRoadCost(state, ctx, vehicle = 'car') {
  const highSpeed = state.policies.highSpeedHighways;
  const dists = state.districts;
  const distPol = (i) => (state.district[i] ? dists.find((d) => d.id === state.district[i])?.policies : null);
  const closed = state.closed;
  return (from, to, d) => {
    if (!linked(state, 'road', from, to, d)) return Infinity;
    if (closed && closed[to]) return Infinity; // closed road (sim/closures.js)
    const t = state.road[to];
    const def = ROADS[t];
    // one-way rules
    if (ROADS[state.road[from]]?.oneway && state.roadDir[from] !== d) return Infinity;
    if (def.oneway && (state.roadDir[to] + 2) % 4 === d) return Infinity;
    let speed = def.speed * (highSpeed && def.key === 'highway' ? 1.2 : 1);
    let c = 50 / speed;
    // pulling out of a side street onto a busy main road takes a gap in the traffic
    if (givesWay(state, from, to)) c += 0.3 + 1.5 * Math.min(2, congestion(state, to));
    if (!(vehicle === 'bus' && state.roadUpg[to] & UPG.BUSLANE)) c *= jamFactor(congestion(state, to));
    if (state.accident[to] > 0) c += 25;
    if (state.roadUpg[to] & UPG.TOLL && vehicle !== 'service') c += (state.fees.toll ?? 3) * (vehicle === 'truck' ? 0.8 : 0.45);
    c *= 1 + state.roadSnow[to] * 0.8 + (1 - state.roadCond[to]) * 0.4;
    const nb = roadNeighbours(state, to);
    if (nb >= 3) c += state.roadUpg[to] & UPG.ROUNDABOUT ? 0.1 : t >= 4 ? 0.35 : 0.15;
    const p = distPol(to);
    if (p) {
      if (p.speedBumps) c *= 1.3;
      if (p.heavyBan && vehicle === 'truck') c *= 6;
      if (p.combustionBan && vehicle !== 'service') c *= 2.5;
      if (p.gated && vehicle !== 'service') c *= 3;
    }
    return c;
  };
}

// Road cell where a building's driveway meets the road (cached per network version)
export function accessCell(state, ctx, b) {
  if (b.accessStamp !== ctx.netStamp) {
    const a = buildingRoadComp(state, ctx, b);
    b.access = a ? idx(a.x, a.y) : -1;
    b.accessStamp = ctx.netStamp;
  }
  return b.access;
}

export function outsideCell(state) {
  const c = state.connections.find((k) => k.type === 'road');
  return c ? idx(c.x, c.y) : -1;
}

// What a route costs to drive right now (same units as the A* search)
const dirOf = (a, b) => (b === a + 1 ? 0 : b === a + N ? 1 : b === a - 1 ? 2 : 3);
export function pathCost(path, cost) {
  let c = 0;
  for (let k = 1; k < path.length; k++) c += cost(path[k - 1], path[k], dirOf(path[k - 1], path[k]));
  return c;
}

// Routes are remembered, but drivers keep an eye on the traffic: once a remembered route has
// got noticeably slower than when it was chosen (a jam built up on it), it's planned again,
// so trips take the longer way round when that's quicker than sitting in the queue.
const cache = new Map(); // "a-b-vehicle" -> { path, stamp, step, cost }
const FRESH = 3, MAX_AGE = 48, SLOWER = 1.2;
export function route(state, ctx, a, b, vehicle = 'car') {
  if (a < 0 || b < 0) return null;
  const key = `${a}-${b}-${vehicle}`;
  const hit = cache.get(key);
  const cost = makeRoadCost(state, ctx, vehicle);
  const age = hit ? ctx.stepCount - hit.step : Infinity;
  if (hit && hit.stamp === ctx.netStamp && age < MAX_AGE &&
    (age < FRESH || !hit.path || pathCost(hit.path, cost) <= hit.cost * SLOWER)) return hit.path;
  if (ctx.routeBudget <= 0) return hit?.path ?? null;
  ctx.routeBudget--;
  const path = astar(a, b, (i) => state.road[i] > 0, cost, 0.4, undefined, tunnelLinks(state, 'road'));
  cache.delete(key);
  cache.set(key, { path, stamp: ctx.netStamp, step: ctx.stepCount, cost: path ? pathCost(path, cost) : 0 });
  if (cache.size > 3000) cache.delete(cache.keys().next().value);
  return path;
}

export function rushFactor(h) {
  return 0.35 + 1.3 * Math.exp(-((h - 8) ** 2) / 1.5) + 1.1 * Math.exp(-((h - 17.5) ** 2) / 2) + 0.35 * Math.exp(-((h - 13) ** 2) / 6) - (h < 5 ? 0.25 : 0);
}

// Daily: lists to sample trips from
export function rebuildTripPools(state, ctx) {
  const commutes = [], homes = [], shops = [], industry = [], leisure = [], services = [], hotels = [];
  for (const c of state.citizens.values()) {
    if (!c.job && !c.school) continue;
    const hh = state.households.get(c.hh);
    if (hh) commutes.push([hh.home, c.job || c.school, hh.car]);
  }
  for (const b of state.buildings.values()) {
    if (b.kind === 'zone') {
      if (b.def.cat === 'res' && b.households.length) homes.push(b.id);
      if (b.product === 'retail') shops.push(b.id);
      if (b.def.cat === 'ind' || b.def.cat === 'spec') industry.push(b.id);
    } else if (isService(b)) {
      if (b.def.leisure || b.def.attract || b.def.themeGate) leisure.push(b.id);
      if (b.def.rooms && b.guests) hotels.push(b.id);
      // (garbage trucks aren't drawn from here: their real rounds are in garbage.js)
      if (b.def.patrol || b.def.mail || b.def.deathRate || b.def.roadMaint) services.push(b.id);
    }
    if (b.def.signature) leisure.push(b.id);
  }
  ctx.trips = { commutes, homes, shops, industry, leisure, services, hotels };
}

const pick = (arr) => arr[Math.floor(rng.next() * arr.length)];

function sampleTrip(state, ctx) {
  const T = ctx.trips;
  const h = hourOf(state);
  const r = rng.next();
  const B = state.buildings;
  const commuteShare = h > 6 && h < 10 ? 0.7 : h > 15 && h < 19 ? 0.6 : 0.3;
  if (r < commuteShare && T.commutes.length) {
    const [home, work, car] = pick(T.commutes);
    const evening = h > 12;
    return { from: B.get(evening ? work : home), to: B.get(evening ? home : work), type: 'car', car, purpose: 'commute' };
  }
  if (r < commuteShare + 0.18 && T.homes.length && T.shops.length) {
    return { from: B.get(pick(T.homes)), to: B.get(pick(T.shops)), type: 'car', car: rng.chance(0.75), purpose: 'shopping' };
  }
  if (r < commuteShare + 0.3 && T.industry.length) {
    const from = B.get(pick(T.industry));
    const toOutside = rng.chance(0.4) || !T.shops.length;
    return { from, to: toOutside ? 'outside' : B.get(pick(T.shops)), type: 'truck', car: true, purpose: 'cargo' };
  }
  if (r < commuteShare + 0.36 && T.services.length && T.homes.length) {
    const from = B.get(pick(T.services));
    return { from, to: B.get(pick(T.homes)), type: 'service', svc: from?.def, car: true, purpose: 'service' };
  }
  if (T.leisure.length && (T.homes.length || state.stats.tourists)) {
    const tourist = rng.chance(clamp((state.stats.tourists || 0) / 1500, 0.1, 0.6));
    // hotel guests set out from their hotel; day visitors drive in from outside
    const guest = tourist && T.hotels?.length && rng.chance((state.stats.hotelGuests || 0) / Math.max(1, state.stats.tourists));
    return { from: guest ? B.get(pick(T.hotels)) : tourist ? 'outside' : B.get(pick(T.homes)), to: B.get(pick(T.leisure)), type: 'car', car: true, purpose: tourist ? 'tourism' : 'leisure' };
  }
  return null;
}

// Road cells as a list (rebuilt when the network changes), so per-step passes stay cheap
function roadCells(state, ctx) {
  if (ctx.roadCellsStamp === ctx.netStamp && ctx.roadCells) return ctx.roadCells;
  const out = [];
  for (let i = 0; i < NN; i++) if (state.road[i]) out.push(i);
  ctx.roadCells = Int32Array.from(out);
  ctx.roadCellsStamp = ctx.netStamp;
  return ctx.roadCells;
}

// Queues back up: a cell carrying more than it can pushes part of the excess onto the road
// cells around it (the roads leading into a jammed junction fill up first)
function spillBack(state, ctx, cells) {
  const vol = state.roadVol;
  for (const i of cells) {
    const ex = vol[i] - cellCapacity(state, i);
    if (ex <= 0) continue;
    const x = i % N, y = (i / N) | 0;
    let n = 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
      if (inBounds(nx, ny) && linked(state, 'road', i, idx(nx, ny), d)) n++;
    }
    if (!n) continue;
    const push = ex * 0.22;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
      if (inBounds(nx, ny) && linked(state, 'road', i, idx(nx, ny), d)) vol[idx(nx, ny)] += push / n;
    }
    vol[i] -= push * 0.5;
  }
}

// Every simulation step: sample and route trips, accumulate road volume
export function trafficStep(state, ctx) {
  if (!ctx.trips) rebuildTripPools(state, ctx);
  const vol = state.roadVol;
  const cells = roadCells(state, ctx);
  for (const i of cells) if (vol[i] > 0) vol[i] *= 0.88;
  const pop = state.citizens.size;
  if (pop < 5) return;
  const h = hourOf(state);
  const real = pop * 0.012 * rushFactor(h) + (state.stats.tourists || 0) * 0.004;
  // more trips are sampled (and drawn) as the city grows: each one stands for about two
  const samples = clamp(Math.round(real / 2), 1, 24);
  const W = real / samples;
  ctx.routeBudget = 18;
  const out = outsideCell(state);
  let parking = 0, transitRiders = 0, tolls = 0;
  for (let k = 0; k < samples; k++) {
    const trip = sampleTrip(state, ctx);
    if (!trip || !trip.from || !trip.to) continue;
    const a = trip.from === 'outside' ? out : accessCell(state, ctx, trip.from);
    const b = trip.to === 'outside' ? out : accessCell(state, ctx, trip.to);
    if (a < 0 || b < 0 || a === b) continue;
    const ax = a % N, ay = (a / N) | 0, bx = b % N, by = (b / N) | 0;
    const dist = Math.abs(ax - bx) + Math.abs(ay - by);
    // Mode choice: walk short trips, take transit when it's competitive, otherwise drive
    if (trip.type === 'car' && trip.purpose !== 'tourism') {
      if (dist < 7) { ctx.walkTrips = (ctx.walkTrips || 0) + W; continue; }
      // the lots near work are full: the car stays at home and they take the bus or walk
      const dest = trip.to !== 'outside' ? trip.to : null;
      const parkFull = trip.purpose === 'commute' && dest?.parkingShort && rng.chance(dest.parkingShort);
      if (parkFull) trip.car = false;
      const tr = transitOption(state, ctx, a, b, dist, trip.car);
      if (tr) { transitRiders += W; tr.line.ridersToday = (tr.line.ridersToday || 0) + W; continue; }
      // a water taxi between piers near both ends
      const boat = waterTaxiOption(state, ctx, a, b, dist);
      if (boat) { boat.riders += W; transitRiders += W; continue; }
      if (parkFull) { ctx.walkTrips = (ctx.walkTrips || 0) + W; continue; }
      if (!trip.car) {
        if (ctx.taxis > 0) { trip.type = 'taxi'; ctx.taxiTrips = (ctx.taxiTrips || 0) + W; }
        else continue;
      }
    }
    const vehicle = trip.type === 'truck' ? 'truck' : trip.type === 'service' ? 'service' : 'car';
    const path = route(state, ctx, a, b, vehicle);
    if (!path) continue;
    const truckWeight = trip.type === 'truck' ? 1.8 / (1 + (ctx.cargoCapacity || 0) / 1500) : 1;
    let booths = 0;
    for (const c of path) { vol[c] += W * 0.12 * truckWeight; if (state.roadUpg[c] & UPG.TOLL) booths++; }
    if (booths && trip.type !== 'service') tolls += W * booths * (state.fees.toll ?? 3) * (trip.type === 'truck' ? 2 : 1);
    if (trip.purpose === 'shopping' || trip.purpose === 'leisure' || trip.purpose === 'tourism') {
      const dest = trip.to !== 'outside' ? trip.to : null;
      const distFee = state.district[b] ? state.districts.find((d) => d.id === state.district[b])?.policies?.parkingFee || 0 : 0;
      parking += W * ((dest?.parkingFee || 0) + distFee + state.fees.parking * 0.3) * 0.15;
    }
    // commuters you see are drawn by the people layer (they park and walk); the rest here
    if (trip.purpose !== 'commute') bus.emit('vehicle:spawn', { path, type: trip.type, svc: trip.svc, owner: trip.type === 'service' ? trip.from?.id : undefined });
  }
  spillBack(state, ctx, cells);
  earn(state, 'parking', parking);
  earn(state, 'tolls', tolls);
  ctx.transitRidersStep = transitRiders;
}

// Hourly: wear and tear, snow, accidents, maintenance, and the flow statistic
export function roadsHourly(state, ctx) {
  countDriveways(state, ctx);
  const w = state.weather;
  const h = hourOf(state);
  const night = h < 6 || h > 20;
  const maint = ctx.coverage.roadMaint;
  const highSpeed = state.policies.highSpeedHighways;
  let flowSum = 0, flowW = 0, booths = 0, worst = -1, worstR = 0;
  for (let i = 0; i < NN; i++) {
    const t = state.road[i];
    if (!t) continue;
    if (state.roadUpg[i] & UPG.TOLL) booths++;
    const def = ROADS[t];
    const v = state.roadVol[i];
    // road off your land (the outside connections) is the region's to look after: it's kept
    // up and cleared of snow as if a maintenance depot covered it
    const m = !isOwned(state, i % N, (i / N) | 0) ? 1 : maint ? maint[i] : 0;
    const wear = hasPerk(state, 'roads_asphalt') ? 0.6 : 1;
    state.roadCond[i] = clamp(state.roadCond[i] - (v * 0.00004 + 0.0002) * wear + m * 0.012, 0, 1);
    if (w.snow > 0.05 && w.temp < 1) state.roadSnow[i] = Math.min(1, state.roadSnow[i] + w.snow * 0.05);
    if (w.temp > 2) state.roadSnow[i] = Math.max(0, state.roadSnow[i] - 0.06);
    state.roadSnow[i] = Math.max(0, state.roadSnow[i] - m * 0.15);
    if (state.accident[i] > 0) state.accident[i] = Math.max(0, state.accident[i] - 60 * (1 + (ctx.coverage.police?.[i] || 0)));
    if (v > 1.5) {
      const dist = state.district[i] ? state.districts.find((d) => d.id === state.district[i])?.policies : null;
      let p = v * 0.000015 * (night && !(state.roadUpg[i] & UPG.LIGHTS) ? 2 : 1) * (1 + w.rain + w.snow * 2 + w.fog) *
        (1 + (1 - state.roadCond[i]) * 2) * (highSpeed && def.key === 'highway' ? 1.6 : 1) * (dist?.speedBumps ? 0.5 : 1);
      if (rng.chance(p)) {
        state.accident[i] = 120 + rng.next() * 120;
        ctx.accidents = (ctx.accidents || 0) + 1;
        bus.emit('accident', { cell: i });
      }
    }
    const r = v / cellCapacity(state, i);
    const flow = 1 / jamFactor(r);
    flowSum += flow * (v + 0.1);
    flowW += v + 0.1;
    if (r > worstR) { worstR = r; worst = i; }
  }
  state.stats.trafficFlow = flowW ? flowSum / flowW : 1;
  state.stats.worstJam = worst >= 0 && worstR > 1 ? { cell: worst, ratio: worstR } : null;
  ctx.tollBooths = booths;
  // How jammed it is around each place (for commuters stuck in traffic): road congestion,
  // spread a few cells so homes and workplaces feel the jams on the streets around them
  const jf = ctx.jamField || (ctx.jamField = new Float32Array(NN));
  jf.fill(0);
  for (const i of roadCells(state, ctx)) jf[i] = clamp((congestion(state, i) - 0.85) / 1.3, 0, 1);
  const tmp = new Float32Array(NN);
  for (let pass = 0; pass < 3; pass++) {
    tmp.set(jf);
    for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
      const i = y * N + x;
      const m = Math.max(tmp[i - 1], tmp[i + 1], tmp[i - N], tmp[i + N]) * 0.85;
      if (m > jf[i]) jf[i] = m;
    }
  }
}
