// Emergency services on the road. Fire engines drive from a fire station to a burning
// building and only start fighting the fire once they arrive; police cars drive to crime
// scenes and make the arrest there; ambulances fetch the sick. Each station has a limited
// number of vehicles, and stations only answer calls within reach, so where you build
// them (and the traffic in between) matters. Police also patrol their neighbourhood.
import { N } from '../core/grid.js';
import { route, accessCell } from './traffic.js';
import { isService, center, serviceEfficiency } from './services.js';
import { STEP_MINUTES } from './simulation.js';
import { rng } from '../core/rng.js';
import { bus } from '../core/events.js';
import { logLife, leaveJob, leaveSchool } from './citizens.js';

const KINDS = {
  fire: { has: (d) => d.engines, units: (d, eff) => Math.max(1, Math.round(d.engines * eff)), turnout: 4, perCell: 0.45, reach: 1.8, icon: '🚒' },
  police: { has: (d) => d.patrol, units: (d, eff) => Math.max(1, Math.round((2 + (d.cells || 10) / 15) * eff)), turnout: 2, perCell: 0.4, reach: 1.8, icon: '🚓' },
  health: { has: (d) => d.patients, units: (d, eff) => Math.max(1, Math.round((1 + d.patients / 80) * eff)), turnout: 3, perCell: 0.45, reach: 1.6, icon: '🚑' },
};

const ensure = (ctx) => {
  if (!ctx.incidents) ctx.incidents = [];
  if (!ctx.busy) ctx.busy = new Map();
};

export function unitsOf(state, b, kind) {
  const K = KINDS[kind];
  return K.units(b.def, Math.max(0.3, serviceEfficiency(state, b)));
}

// Send the nearest free vehicle of this kind to a building. Returns the incident, or null
// if no station can reach it right now.
export function dispatch(state, ctx, kind, target, extra = {}) {
  ensure(ctx);
  const K = KINDS[kind];
  const goal = accessCell(state, ctx, target);
  if (goal < 0) return null;
  const [tx, ty] = center(target);
  const stations = [];
  for (const b of state.buildings.values()) {
    if (!isService(b) || !K.has(b.def) || b.onFire) continue;
    const [sx, sy] = center(b);
    const d = Math.abs(sx - tx) + Math.abs(sy - ty);
    if (d > (b.def.radius || 30) * K.reach) continue;
    stations.push([d, b]);
  }
  stations.sort((a, b) => a[0] - b[0]);
  for (const [, st] of stations) {
    if ((ctx.busy.get(st.id) || 0) >= unitsOf(state, st, kind)) continue;
    const from = accessCell(state, ctx, st);
    if (from < 0 || ctx.net.roadComp[from] !== ctx.net.roadComp[goal]) continue;
    ctx.routeBudget = Math.max(ctx.routeBudget || 0, 0) + 1;
    const path = from === goal ? [from, goal] : route(state, ctx, from, goal, 'service');
    if (!path) continue;
    const eta = K.turnout + path.length * K.perCell;
    const inc = { kind, station: st.id, target: target.id, path, eta, phase: 'going', took: 0, ...extra };
    ctx.busy.set(st.id, (ctx.busy.get(st.id) || 0) + 1);
    ctx.incidents.push(inc);
    bus.emit('vehicle:spawn', { path, type: 'emergency', siren: kind, svc: st.def, inc, owner: st.id });
    return inc;
  }
  return null;
}

function finish(state, ctx, inc) {
  inc.phase = 'return';
  inc.eta = inc.path.length * KINDS[inc.kind].perCell;
  if (state.buildings.has(inc.station)) bus.emit('vehicle:spawn', { path: [...inc.path].reverse(), type: 'emergency', siren: null, svc: state.buildings.get(inc.station)?.def, owner: inc.station });
}

// Every simulation step: vehicles arrive, work the scene, and drive back
export function emergencyStep(state, ctx) {
  ensure(ctx);
  for (const inc of ctx.incidents) {
    // the station was bulldozed: its vehicles are gone with it
    if (!state.buildings.has(inc.station)) { inc.phase = 'done'; ctx.busy.delete(inc.station); continue; }
    inc.eta -= STEP_MINUTES;
    inc.took += STEP_MINUTES;
    const b = state.buildings.get(inc.target);
    if (inc.phase === 'going' && inc.eta <= 0) {
      inc.phase = 'scene';
      inc.onScene = 0;
      if (b) b.responseMinutes = inc.took;
      bus.emit('emergency:arrived', inc);
    }
    if (inc.phase === 'scene') {
      inc.onScene += STEP_MINUTES;
      if (inc.kind === 'fire') {
        // engines fight the fire until it's out (or the building is lost)
        if (!b || !b.onFire) finish(state, ctx, inc);
        else if (rng.chance(0.28)) {
          b.onFire = 0;
          b.fireDamage = Math.max(0, (b.fireDamage || 0) - 0.1);
          state.journal.push({ day: state.time.day, kind: 'fire', text: `Firefighters put out the fire at ${b.name || b.def.name} (${Math.round(inc.took)} min)` });
          bus.emit('building:changed', b);
          finish(state, ctx, inc);
        }
      } else if (inc.kind === 'police') {
        if (inc.onScene >= 20) { arrest(state, ctx, inc); finish(state, ctx, inc); }
      } else if (inc.onScene >= 20) finish(state, ctx, inc);
    }
    if (inc.phase === 'return' && inc.eta <= 0) {
      inc.phase = 'done';
      ctx.busy.set(inc.station, Math.max(0, (ctx.busy.get(inc.station) || 1) - 1));
    }
  }
  ctx.incidents = ctx.incidents.filter((i) => i.phase !== 'done');
}

// Police on the scene: the faster they got there, the likelier the arrest
function arrest(state, ctx, inc) {
  const c = state.citizens.get(inc.offender);
  if (!c || c.jail) return;
  const jailFree = (state.stats.jailCap || 0) > (state.stats.jailed || 0);
  const chance = Math.max(0.2, 0.9 - inc.took / 120);
  if (!jailFree || !rng.chance(chance)) { logLife(state, c, 'Got away from the police'); return; }
  c.jail = state.policies.preRelease ? 3 : 5;
  if (state.policies.preRelease && rng.chance(0.5)) c.criminal = 0;
  leaveJob(state, c); leaveSchool(state, c);
  state.stats.jailed = (state.stats.jailed || 0) + 1;
  state.stats.arrestsToday = (state.stats.arrestsToday || 0) + 1;
  logLife(state, c, 'Arrested by the police');
}

// Hourly: police cars patrol around their station
export function patrolsHourly(state, ctx) {
  ensure(ctx);
  for (const b of state.buildings.values()) {
    if (!isService(b) || !b.def.patrol || (b.efficiency ?? 1) <= 0) continue;
    if ((ctx.busy.get(b.id) || 0) >= unitsOf(state, b, 'police') || !rng.chance(0.5)) continue;
    const from = accessCell(state, ctx, b);
    if (from < 0) continue;
    const [sx, sy] = center(b);
    const r = b.def.radius * 0.6;
    for (let k = 0; k < 6; k++) {
      const x = Math.round(sx + (rng.next() - 0.5) * 2 * r), y = Math.round(sy + (rng.next() - 0.5) * 2 * r);
      if (x < 0 || y < 0 || x >= N || y >= N) continue;
      const to = y * N + x;
      if (!state.road[to] || ctx.net.roadComp[to] !== ctx.net.roadComp[from]) continue;
      ctx.routeBudget = Math.max(ctx.routeBudget || 0, 0) + 1;
      const out = route(state, ctx, from, to, 'service');
      if (out && out.length > 4) bus.emit('vehicle:spawn', { path: [...out, ...[...out].reverse().slice(1)], type: 'emergency', siren: null, patrol: true, svc: b.def, owner: b.id });
      break;
    }
  }
}

// Hourly: ambulances fetch some of the sick (treatment itself happens in citizens.js)
export function ambulancesHourly(state, ctx) {
  if (!(state.stats.sick > 0) || !rng.chance(Math.min(0.9, state.stats.sick / 20))) return;
  let k = 0;
  for (const c of state.citizens.values()) {
    if (++k > 300) break;
    if (!c.sick || rng.chance(0.7)) continue;
    const hh = state.households.get(c.hh);
    const home = hh && state.buildings.get(hh.home);
    if (home) dispatch(state, ctx, 'health', home);
    return;
  }
}

export const emergencyIcon = (kind) => KINDS[kind]?.icon || '🚨';
