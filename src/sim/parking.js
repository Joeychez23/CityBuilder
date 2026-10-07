// Getting to work: how each commuter travels (walk, bus or car) and where the drivers park.
// Workplaces need parking: drivers park in Parking Lots and Garages within a short walk of
// their job (industry and small shops also have a few spaces of their own). A lot holds as
// many cars as it has spaces; the nearest drivers take them first. When the lots near work
// are full, the drivers left over leave the car at home and walk to work instead (or take
// the bus when one goes there): a long walk makes them late and unhappy. People from
// neighbouring cities who find no space can't come in at all.
import { N } from '../core/grid.js';
import { center, serviceEfficiency } from './services.js';
import { LINE_TYPES } from '../data/transport.js';
import { lineRunning } from './transit.js';
import { earn } from './economy.js';

export const WALK_CELLS = 8;    // commutes shorter than this (in cells) are walked
export const PARK_REACH = 9;    // drivers walk at most this far from a lot to work

// A bus or tram line with stops near both ends, as { line, a, b } (stop cells), or null
export function lineBetween(state, from, to) {
  let best = null, bestWalk = 1e9;
  const [fx, fy] = center(from), [tx, ty] = center(to);
  for (const line of state.lines) {
    if ((line.type !== 'bus' && line.type !== 'tram') || !lineRunning(state, line)) continue;
    const r = LINE_TYPES[line.type].stopRadius;
    let a = -1, b = -1, da = 1e9, db = 1e9;
    for (const s of line.stops) {
      const sx = s % N, sy = (s / N) | 0;
      const d1 = Math.abs(sx - fx) + Math.abs(sy - fy), d2 = Math.abs(sx - tx) + Math.abs(sy - ty);
      if (d1 <= r && d1 < da) { da = d1; a = s; }
      if (d2 <= r && d2 < db) { db = d2; b = s; }
    }
    if (a < 0 || b < 0 || a === b) continue;
    if (da + db < bestWalk) { bestWalk = da + db; best = { line, a, b }; }
  }
  return best;
}

// How this citizen gets from home to work: 'walk', 'bus' or 'car' (or 'none' if they can't)
export function commuteMode(state, ctx, c) {
  const hh = state.households.get(c.hh);
  const home = hh && state.buildings.get(hh.home);
  const work = state.buildings.get(c.job || c.school);
  if (!home || !work) return { mode: 'none' };
  const [hx, hy] = center(home), [wx, wy] = center(work);
  const dist = Math.abs(hx - wx) + Math.abs(hy - wy);
  if (dist < WALK_CELLS) return { mode: 'walk', home, work, dist };
  const ride = lineBetween(state, home, work);
  // car owners still take the bus about half the time when there's a good line
  if (ride && (!hh.car || ((c.id * 7919) % 100) < 50)) return { mode: 'bus', home, work, dist, ...ride };
  if (hh.car && c.job) {
    if (!c.noParking) return { mode: 'car', home, work, dist, lot: c.lot ? state.buildings.get(c.lot) : null };
    // the lots near work are full: the car stays at home
    return ride ? { mode: 'bus', home, work, dist, ...ride } : { mode: 'walk', home, work, dist, noSpace: true };
  }
  if (ride) return { mode: 'bus', home, work, dist, ...ride };
  if (dist < WALK_CELLS * 3) return { mode: 'walk', home, work, dist };
  return { mode: hh.car ? 'car' : 'none', home, work, dist };
}

// Spaces a workplace has on its own lot
export function onSiteSpaces(b) {
  if (b.kind !== 'zone' || !b.jobs) return 0;
  const cells = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
  if (b.def.cat === 'spec') return b.jobs; // farms, mines and forestry have yards
  if (b.def.cat === 'ind') return Math.round(b.jobs * 0.4);
  if (b.def.key === 'com_low') return cells * 2;
  return 0;
}

export const lotSpaces = (state, b) => Math.round((b.def.parking || 0) * Math.min(1, serviceEfficiency(state, b) + 0.2));

// Daily: count drivers per workplace and hand out spaces in nearby lots, nearest first
export function parkingDaily(state, ctx) {
  const lots = [];
  const work = new Map(); // workplace -> drivers (citizens)
  for (const b of state.buildings.values()) {
    if (b.def.parking && !b.cons) { b.used = 0; b.turnedAway = 0; b.spaces = lotSpaces(state, b); lots.push(b); }
    if (b.jobs && b.kind === 'zone') { b.parkingNeed = 0; b.parkingGot = 0; b.parkWalk = 0; b.parkLost = 0; b.nearLot = 0; work.set(b, []); }
  }
  for (const c of state.citizens.values()) {
    c.noParking = false;
    c.walkDist = 0;
    c.lot = 0;
    if (!c.job) continue;
    const b = state.buildings.get(c.job);
    if (!b || !work.has(b)) continue;
    const m = commuteMode(state, ctx, c);
    if (m.mode === 'car') work.get(b).push(c);
  }
  // Commuters from neighbouring cities always drive in
  const need = [];
  for (const [b, drivers] of work) {
    b.parkingNeed = drivers.length + (b.commuters || 0);
    const own = Math.min(b.parkingNeed, onSiteSpaces(b));
    b.parkingGot = own;
    if (b.parkingNeed > own) need.push(b);
  }
  // Nearest lot-workplace pairs first
  const pairs = [];
  for (const b of need) {
    const [bx, by] = center(b);
    let near = Infinity;
    for (const l of lots) {
      const [lx, ly] = center(l);
      const d = Math.abs(bx - lx) + Math.abs(by - ly);
      if (d > PARK_REACH + (l.x1 - l.x0)) continue;
      pairs.push([d, b, l]);
      if (d < near) { near = d; b.nearLot = l.id; }
    }
  }
  pairs.sort((p, q) => p[0] - q[0]);
  for (const [, b, l] of pairs) {
    const want = b.parkingNeed - b.parkingGot;
    const free = l.spaces - l.used;
    if (want <= 0 || free <= 0) continue;
    const n = Math.min(want, free);
    l.used += n;
    b.parkingGot += n;
    (b.lots || (b.lots = [])).push(l.id);
  }
  // Whoever is left without a space leaves the car at home and walks (residents get the
  // spaces before outside commuters do; those can't walk in from another city)
  let short = 0, stuck = 0, walking = 0;
  for (const [b, drivers] of work) {
    b.parkingShort = b.parkingNeed ? Math.max(0, 1 - b.parkingGot / b.parkingNeed) : 0;
    const missing = b.parkingNeed - b.parkingGot;
    if (missing > 0) { short++; stuck += missing; }
    const walkers = Math.max(0, drivers.length - b.parkingGot);
    b.parkWalk = b.parkingNeed ? walkers / b.parkingNeed : 0;
    b.parkLost = b.parkingNeed ? (missing - walkers) / b.parkingNeed : 0;
    walking += walkers;
    // the lot they'd have parked in (the nearest) was full
    const near = missing > 0 && b.nearLot && state.buildings.get(b.nearLot);
    if (near) near.turnedAway = (near.turnedAway || 0) + missing;
    const lotIds = b.lots || [];
    const [wx, wy] = center(b);
    drivers.forEach((c, k) => {
      if (k >= b.parkingGot) {
        c.noParking = true;
        const home = state.buildings.get(state.households.get(c.hh)?.home);
        if (home) { const [hx, hy] = center(home); c.walkDist = Math.abs(hx - wx) + Math.abs(hy - wy); }
      } else c.lot = lotIds[k % Math.max(1, lotIds.length)] || 0;
    });
    b.lots = null;
  }
  // Lots earn the parking fee from the cars that use them
  let income = 0;
  for (const l of lots) income += l.used * (l.parkingFee ?? state.fees.parking) * 0.5;
  earn(state, 'parking', income);
  state.stats.parking = { lots: lots.length, spaces: lots.reduce((a, l) => a + l.spaces, 0), used: lots.reduce((a, l) => a + l.used, 0), shortWorkplaces: short, carsWithoutSpace: stuck, walking, fullLots: lots.filter((l) => l.turnedAway > 0).length };
}

// Share of a day's parkers in the lot at this hour (workday curve)
export function occupancyAt(hour) {
  if (hour < 6 || hour >= 21) return 0.12;
  if (hour < 8) return 0.12 + (hour - 6) * 0.42;
  if (hour < 17) return 1;
  return Math.max(0.12, 1 - (hour - 17) * 0.24);
}

