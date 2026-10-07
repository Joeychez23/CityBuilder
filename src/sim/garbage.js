// Garbage trucks. Landfills, incinerators and recycling centers send trucks out to collect
// from the buildings in their area, the fullest (and nearest) bins first. A truck drives
// there through the traffic, loads up from that building and its neighbours, drives back and
// tips its load: into the landfill (which slowly fills up), into the incinerator (which turns
// it into electricity) or into recycling (raw materials for industry). A landfill's trucks
// stay home once it's full, and places no truck can reach keep piling up garbage.
import { idx } from '../core/grid.js';
import { isService, center, serviceEfficiency, storageCap, cellsOf } from './services.js';
import { accessCell, route } from './traffic.js';
import { STEP_MINUTES } from './simulation.js';
import { bus } from '../core/events.js';
import { hasPerk } from '../data/progression.js';

export const TRUCK_LOAD = 7;   // tonnes a truck carries
const PER_CELL = 0.55;         // minutes per road cell driven
const LOADING = 20;            // minutes at the kerb
const PICKUP = 0.6;            // tonnes waiting before a building gets a visit
const NEIGHBOURS = 6;          // cells around the stop the crew also empties (the street they drive along)

export const isGarbageFacility = (b) => isService(b) && !!b.def.garbageRate;

// Trucks a facility runs (a bigger landfill runs more; budget and staff matter)
export function truckCount(state, b) {
  const base = b.def.area ? 2 + Math.floor(cellsOf(b) / 12) : b.def.trucks || 3;
  return Math.max(1, Math.round(base * Math.min(1.25, serviceEfficiency(state, b))));
}

function ensure(ctx) {
  if (!ctx.garbageRuns) ctx.garbageRuns = [];
  if (!ctx.trucksOut) ctx.trucksOut = new Map();
}
export const trucksOut = (ctx, b) => ctx.trucksOut?.get(b.id) || 0;

// The next stop for one of this facility's trucks: the most garbage, weighed against distance
function pickTarget(state, ctx, p, taken) {
  const [px, py] = center(p);
  const r2 = (p.def.radius || 30) ** 2;
  let best = null, bestScore = 0;
  for (const b of state.buildings.values()) {
    if ((b.garbage || 0) < PICKUP || taken.has(b.id) || b.cons) continue;
    if (p.serveDistrict && b.district !== p.serveDistrict) continue;
    const [x, y] = center(b);
    const d2 = (x - px) ** 2 + (y - py) ** 2;
    if (d2 > r2) continue;
    const score = b.garbage / (1 + Math.sqrt(d2) / 18);
    if (score > bestScore) { bestScore = score; best = b; }
  }
  return best;
}

// Empty the bins at the stop and around it, up to what the truck holds
function load(state, run) {
  const target = state.buildings.get(run.target);
  let got = 0;
  const cap = TRUCK_LOAD * (hasPerk(state, 'garbage_trucks') ? 1.2 : 1);
  const take = (b) => {
    if (!b || got >= cap) return;
    const t = Math.min(b.garbage || 0, cap - got);
    b.garbage -= t;
    got += t;
  };
  take(target);
  if (target) {
    const [tx, ty] = center(target);
    const seen = new Set([target.id]);
    for (let y = ty - NEIGHBOURS; y <= ty + NEIGHBOURS && got < cap; y++) {
      for (let x = tx - NEIGHBOURS; x <= tx + NEIGHBOURS && got < cap; x++) {
        const id = state.bld[idx(Math.max(0, x), Math.max(0, y))];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const b = state.buildings.get(id);
        if (b && !isService(b) && (b.garbage || 0) > 0.05) take(b);
      }
    }
  }
  run.load = got;
}

function unload(state, ctx, run) {
  const p = state.buildings.get(run.facility);
  if (!p) return;
  let t = run.load;
  if (p.def.storage) {
    t = Math.min(t, Math.max(0, storageCap(p) - (p.stored || 0)));
    p.stored = (p.stored || 0) + t;
    const bucket = Math.floor((p.stored / storageCap(p)) * 10);
    if (bucket !== p.fillBucket) { p.fillBucket = bucket; bus.emit('building:changed', p); }
  }
  if (p.def.burns) ctx.burnedHour = (ctx.burnedHour || 0) + t;
  if (p.def.recycles) state.market.recycled = (state.market.recycled || 0) + t;
  p.collectedToday = (p.collectedToday || 0) + t;
}

// The truck you see on the road. At the faster game speeds a round is over long before a truck
// could drive it, so a facility never shows more trucks than it runs (the view skips the rest),
// and they leave the map when the facility is bulldozed.
const showTruck = (state, p, path) => bus.emit('vehicle:spawn', { path, type: 'service', svc: p.def, owner: p.id, limit: truckCount(state, p) });

// Every simulation step: trucks drive, load and unload; idle trucks head out
export function garbageStep(state, ctx) {
  ensure(ctx);
  for (const run of ctx.garbageRuns) {
    // the facility was bulldozed: its trucks are gone with it
    if (!state.buildings.has(run.facility)) { run.phase = 'done'; continue; }
    run.eta -= STEP_MINUTES;
    if (run.eta > 0) continue;
    if (run.phase === 'going') { load(state, run); run.phase = 'loading'; run.eta = LOADING; }
    else if (run.phase === 'loading') {
      run.phase = 'return';
      run.eta = run.path.length * PER_CELL;
      const p = state.buildings.get(run.facility);
      showTruck(state, p, [...run.path].reverse());
    } else if (run.phase === 'return') {
      unload(state, ctx, run);
      run.phase = 'done';
      ctx.trucksOut.set(run.facility, Math.max(0, (ctx.trucksOut.get(run.facility) || 1) - 1));
    }
  }
  ctx.garbageRuns = ctx.garbageRuns.filter((r) => r.phase !== 'done');
  for (const id of ctx.trucksOut.keys()) if (!state.buildings.has(id)) ctx.trucksOut.delete(id);
  // send out idle trucks
  const taken = new Set(ctx.garbageRuns.filter((r) => r.phase === 'going').map((r) => r.target));
  for (const p of state.buildings.values()) {
    if (!isGarbageFacility(p)) continue;
    if (p.def.storage && (p.stored || 0) >= storageCap(p) - 0.5) { p.full = true; continue; }
    p.full = false;
    const from = accessCell(state, ctx, p);
    if (from < 0) continue;
    let free = truckCount(state, p) - trucksOut(ctx, p);
    let tries = 0;
    while (free > 0 && tries++ < 4) {
      const target = pickTarget(state, ctx, p, taken);
      if (!target) break;
      taken.add(target.id);
      const to = accessCell(state, ctx, target);
      if (to < 0 || ctx.net.roadComp[to] !== ctx.net.roadComp[from]) continue;
      ctx.routeBudget = Math.max(ctx.routeBudget || 0, 0) + 1;
      const path = from === to ? [from, to] : route(state, ctx, from, to, 'service');
      if (!path) continue;
      ctx.garbageRuns.push({ facility: p.id, target: target.id, path, phase: 'going', eta: path.length * PER_CELL, load: 0 });
      ctx.trucksOut.set(p.id, trucksOut(ctx, p) + 1);
      showTruck(state, p, path);
      free--;
    }
  }
}

// Daily: reset the day's counters
export function garbageDaily(state) {
  for (const b of state.buildings.values()) if (isGarbageFacility(b)) { b.load = (b.collectedToday || 0) / 24; b.collectedToday = 0; }
}
