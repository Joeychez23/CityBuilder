// Construction: nothing appears finished the moment you place it. A new building starts as a
// building site (fence, scaffolding, a crane on big jobs) and rises over some game hours;
// until it's done it has no residents, jobs or services and costs no upkeep. Builders' trucks
// come and go. A city service can be rushed (finished at once) for a quarter of its price.
// A grown building that levels up is renovated: scaffolding and new floors go up while it
// stays open, and the new level counts when the work is done.
//
// Disasters: a building destroyed by a tornado, fire or lightning leaves rubble. Its owner
// rebuilds it where it stood once the site is cleared (grown buildings for free; for a city
// service, insurance pays half and the city the rest), and the rebuild goes through
// construction like anything else.
import { idx, clamp } from '../core/grid.js';
import { bus } from '../core/events.js';
import { STEP_MINUTES } from './simulation.js';
import { updateCapacity } from './growth.js';
import { createBuilding, spend, footprintFree } from './build.js';
import { defFor } from '../data/registry.js';
import { ZONES } from '../data/zones.js';
import { rng } from '../core/rng.js';
import { accessCell, outsideCell, route } from './traffic.js';

export const RUSH_SHARE = 0.25;     // rushing a service costs this share of its price
const CLEANUP_HOURS = 10;           // rubble is cleared before rebuilding starts

// Game hours to build something
export function buildHours(b) {
  const def = b.def;
  const area = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
  if (def.longBuild) return def.longBuild.days * 24; // a grand project: built over many days
  if (b.kind === 'zone' && def.bought) return clamp(10 + area * 0.6, 12, 48);
  if (b.kind === 'zone') return clamp(3 + area * 1.2 + (def.floors || 1) * 1.3 + (b.level - 1) * 2, 4, 36);
  return clamp(4 + (def.cost || 0) / 12000 + area * 0.25, 4, 72);
}

export const underConstruction = (b) => !!b.cons;

// Put a just-created building under construction (unless the sandbox builds instantly).
// The building was drawn finished when it was created: redraw it as a building site at once.
export function startConstruction(state, b) {
  if (state.options.instantBuild) return b;
  b.cons = { progress: 0, hours: buildHours(b) };
  if (b.kind === 'zone') { b.hhCap = 0; b.jobs = 0; }
  else b.jobs = 0;
  b.step = 0; // how far the visible building has risen (in tenths)
  bus.emit('building:changed', b);
  return b;
}

// Levelling up: the building is renovated and extended (scaffolding goes up, new floors rise)
// while it stays open. The new level counts once the work is done.
export function startRenovation(state, b) {
  if (b.reno || b.cons) return false;
  if (state.options.instantBuild) { finishRenovation(state, b, b.level + 1); return true; }
  b.reno = { progress: 0, hours: clamp(3 + (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * 0.6 + b.level * 1.5, 4, 20), to: b.level + 1 };
  b.step = 0;
  bus.emit('building:changed', b);
  return true;
}

function finishRenovation(state, b, level) {
  delete b.reno;
  b.level = level;
  b.levelProgress = 0;
  updateCapacity(b);
  bus.emit('building:changed', b);
  bus.emit('building:levelup', b);
  bus.emit('xp', { amount: b.level * 2, reason: 'level' });
}

export function finishConstruction(state, b) {
  if (!b.cons) return;
  delete b.cons;
  b.step = 10;
  b.built = state.time.day;
  if (b.kind === 'zone') updateCapacity(b);
  else b.jobs = b.def.workers || 0;
  bus.emit('building:changed', b);
  bus.emit('services:changed');
  bus.emit('construction:done', b);
}

// Pay to finish a city service right away
export function rushCost(b) { return Math.round((b.def.cost || 0) * RUSH_SHARE); }
export const canRush = (b) => b.kind !== 'zone' && !b.def.longBuild;
export function rushConstruction(state, b) {
  if (!b.cons || !canRush(b)) return false;
  if (!spend(state, rushCost(b), b.def.cat || 'construction')) return false;
  finishConstruction(state, b);
  return true;
}

// Every simulation step: sites make progress, trucks visit, rubble gets rebuilt
export function constructionStep(state, ctx) {
  let sites = 0;
  for (const b of state.buildings.values()) {
    if (b.reno) {
      b.reno.progress = Math.min(1, b.reno.progress + STEP_MINUTES / 60 / b.reno.hours);
      const step = Math.floor(b.reno.progress * 10);
      if (b.reno.progress >= 1) finishRenovation(state, b, b.reno.to);
      else if (step !== b.step) { b.step = step; bus.emit('building:changed', b); }
      continue;
    }
    if (!b.cons) continue;
    sites++;
    if (b.cons.paused) continue; // a grand project whose work you paused
    b.cons.progress = Math.min(1, b.cons.progress + STEP_MINUTES / 60 / b.cons.hours);
    const step = Math.floor(b.cons.progress * 10);
    if (step !== b.step) { b.step = step; bus.emit('building:changed', b); }
    if (b.cons.progress >= 1) { finishConstruction(state, b); continue; }
    // a builder's truck now and then (from outside town, or the nearest road)
    if (rng.chance(0.06)) {
      const to = accessCell(state, ctx, b), from = outsideCell(state);
      if (to >= 0 && from >= 0) {
        ctx.routeBudget = Math.max(ctx.routeBudget || 0, 0) + 1;
        const path = route(state, ctx, from, to, 'truck');
        if (path) bus.emit('vehicle:spawn', { path, type: 'truck', color: '#f0a020' });
      }
    }
  }
  state.stats.constructionSites = sites;
  if (state.rebuilds?.length) rebuildStep(state, ctx);
}

// ------------------------------------------------------------- disasters
// Remember a destroyed building so it can be rebuilt where it stood
export function rememberRuin(state, b, why) {
  if (b.def.permanent) return;
  state.rebuilds = state.rebuilds || [];
  state.rebuilds.push({
    kind: b.kind, type: b.type, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, rot: b.rot, level: b.level || 1,
    name: b.name || null, setback: b.setback || 0, plot: b.plot || 0, zone: b.kind === 'zone' ? b.def.id : 0,
    since: state.time.day * 1440 + state.time.minutes, why,
  });
}
// (callers emit 'rebuilds:changed' once the building is gone)

// Cells held for rebuilding (nothing else grows there meanwhile)
export function reservedCells(state) {
  const set = new Set();
  for (const r of state.rebuilds || []) for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) set.add(idx(x, y));
  return set;
}

function rebuildStep(state, ctx) {
  const now = state.time.day * 1440 + state.time.minutes;
  const keep = [];
  for (const r of state.rebuilds) {
    if (now - r.since < CLEANUP_HOURS * 60) { keep.push(r); continue; }
    const def = defFor(r.kind, r.type) || (r.kind === 'zone' ? ZONES[r.type] : null);
    if (!def) continue;
    // something else was built there in the meantime: nothing to rebuild
    if (!footprintFree(state, r.x0, r.y0, r.x1, r.y1, 0, false)) continue;
    if (r.kind === 'zone' && !def.signature) {
      let zoned = true;
      for (let y = r.y0; y <= r.y1 && zoned; y++) for (let x = r.x0; x <= r.x1; x++) if (state.zone[idx(x, y)] !== r.zone) { zoned = false; break; }
      if (!zoned) continue; // re-zoned: the owner doesn't rebuild
    } else if (r.kind !== 'zone') {
      // the city pays half (insurance covers the rest); without the money it waits
      const share = Math.round((def.cost || 0) * 0.5);
      if (!def.free && !spend(state, share, def.cat || 'construction')) { keep.push(r); continue; }
    }
    const b = createBuilding(state, r.kind, def, r.x0, r.y0, r.x1, r.y1, r.rot, r.kind === 'zone'
      ? { level: r.level, setback: r.setback, plot: r.plot, name: r.name || undefined }
      : { stored: 0, load: 0, staff: def.workers || 0, name: r.name || undefined });
    if (r.kind === 'zone') updateCapacity(b);
    else { b.jobs = def.workers || 0; bus.emit('services:changed'); }
    startConstruction(state, b);
    bus.emit('notify', { kind: 'info', icon: '🏗️', title: 'Rebuilding', target: b.id, quiet: r.kind === 'zone',
      msg: `${r.name || def.name} is being rebuilt where it stood${r.kind === 'zone' ? '' : ' (insurance paid half)'}.` });
  }
  const changed = keep.length !== state.rebuilds.length;
  state.rebuilds = keep;
  ctx.reservedDirty = true;
  if (changed) bus.emit('rebuilds:changed');
}
