// Fires (buildings and forests), lightning, hail storms and tornadoes. Fire stations put out
// building fires, firewatch towers spot forest fires early, helicopters douse them, shelters
// and the early warning system protect citizens from tornadoes.
import { N, idx, inBounds, DIRS, clamp } from '../core/grid.js';
import { rng } from '../core/rng.js';
import { isService, center, centerIdx } from './services.js';
import { removeBuilding } from './build.js';
import { logLife } from './citizens.js';
import { bus } from '../core/events.js';
import { charge } from './economy.js';
import { dispatch } from './emergency.js';
import { rememberRuin } from './construction.js';
import { difficultyOf } from '../data/difficulty.js';

// How often natural disasters strike: the difficulty, and the Weather Control Tower
export const disasterOdds = (state, ctx) => difficultyOf(state).disasters * (ctx.wonders?.weatherControl ? 0.33 : 1);

function journal(state, kind, text) {
  state.journal.push({ day: state.time.day, minutes: state.time.minutes, kind, text });
  if (state.journal.length > 200) state.journal.shift();
}

export function igniteBuilding(state, b, cause) {
  if (b.onFire || b.def.fireproof) return;
  b.onFire = 1;
  b.fireDamage = b.fireDamage || 0;
  journal(state, 'fire', `Fire at ${b.name || b.def.name} (${cause})`);
  bus.emit('building:changed', b);
  bus.emit('fire', { b });
}

// Daily: each building may catch fire depending on its hazard and fire coverage
export function fireRiskDaily(state, ctx) {
  const fireCov = ctx.coverage.fire;
  for (const b of state.buildings.values()) {
    if (b.onFire || b.abandoned) continue;
    const i = centerIdx(b);
    const cov = fireCov ? fireCov[i] : 0;
    let hazard = 0.0014 * (b.def.cat === 'ind' ? 2.2 : b.def.cat === 'spec' ? 1.5 : 1) * (1 + (ctx.dryness || 0)) * (b.power < 0.5 ? 1.3 : 1);
    // fire stations inspect buildings nearby; without them fires break out far more often
    hazard *= cov > 0.1 ? 1 - clamp(cov, 0, 1) * 0.8 : 2.2;
    b.fireHazard = hazard;
    if (rng.chance(hazard)) igniteBuilding(state, b, 'electrical fault');
  }
}

// Hourly: fires burn and spread until a fire engine arrives (see sim/emergency.js); forest
// fires spread through trees
export function firesHourly(state, ctx) {
  const fireCov = ctx.coverage.fire, heli = ctx.coverage.heli;
  for (const b of [...state.buildings.values()]) {
    if (!b.onFire) continue;
    const i = centerIdx(b);
    // call the fire department (again, if nobody could come last hour)
    const helping = (ctx.incidents || []).some((x) => x.kind === 'fire' && x.target === b.id && x.phase !== 'return');
    if (!helping) b.noHelp = !dispatch(state, ctx, 'fire', b);
    else b.noHelp = false;
    // helicopters douse fires anywhere in their range
    if (heli && heli[i] > 0.1 && rng.chance(0.3)) {
      b.onFire = 0;
      journal(state, 'fire', `A firefighting helicopter put out the fire at ${b.name || b.def.name}`);
      bus.emit('building:changed', b);
      continue;
    }
    // a fire with nobody fighting it burns faster
    b.fireDamage = (b.fireDamage || 0) + (helping ? 0.08 : 0.16) + (ctx.dryness || 0) * 0.08;
    // spread to neighbours
    if (rng.chance(0.08 + (ctx.dryness || 0) * 0.1)) {
      const [cx, cy] = center(b);
      const d = DIRS[Math.floor(rng.next() * 4)];
      const nx = cx + d[0] * 3, ny = cy + d[1] * 3;
      if (inBounds(nx, ny)) {
        const nb = state.buildings.get(state.bld[idx(nx, ny)]);
        if (nb && nb !== b) igniteBuilding(state, nb, 'spreading fire');
        else if (state.tree[idx(nx, ny)]) igniteCell(state, ctx, idx(nx, ny));
      }
    }
    if (b.fireDamage >= 1) destroyBuilding(state, b, 'burned down');
  }

  // --- forest fires
  const burning = ctx.burning || (ctx.burning = new Set());
  const w = state.weather;
  if (state.options.disasters) {
    // lightning during storms, and spontaneous fires in very dry weather
    const odds = disasterOdds(state, ctx);
    if (w.storm > 0.4 && rng.chance(0.25 * odds)) lightning(state, ctx);
    if ((ctx.dryness || 0) > 0.75 && rng.chance(((ctx.dryness - 0.75) * 0.25) * odds)) {
      const i = Math.floor(rng.next() * N * N);
      if (state.tree[i] >= 2) igniteCell(state, ctx, i, 'dry weather');
    }
  }
  if (!burning.size) return;
  const watch = ctx.coverage.forestWatch;
  const next = [];
  for (const i of burning) {
    const x = i % N, y = (i / N) | 0;
    const spotted = watch && watch[i] > 0.1;
    const doused = (heli && heli[i] > 0.1 && rng.chance(0.5)) || (fireCov && fireCov[i] > 0.4 && rng.chance(0.25)) || w.rain > 0.4;
    state.burnt[i] = 1;
    if (state.tree[i]) state.tree[i]--;
    if (doused || !state.tree[i]) continue;
    next.push(i);
    const spread = (0.25 + (ctx.dryness || 0) * 0.4 + w.wind * 0.1) * (spotted ? 0.35 : 1);
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const j = idx(nx, ny);
      if (state.tree[j] && !burning.has(j) && rng.chance(spread)) next.push(j);
      const b = state.bld[j] && state.buildings.get(state.bld[j]);
      if (b && rng.chance(spread * 0.3)) igniteBuilding(state, b, 'forest fire');
    }
  }
  ctx.burning = new Set(next.slice(0, 600));
  bus.emit('trees:changed');
  if (!ctx.burning.size) { journal(state, 'forestfire', 'The forest fire is out'); ctx.forestFireActive = false; }
}

export function igniteCell(state, ctx, i, cause = 'fire') {
  if (!state.tree[i]) return;
  const burning = ctx.burning || (ctx.burning = new Set());
  burning.add(i);
  if (!ctx.forestFireActive) {
    ctx.forestFireActive = true;
    state.counters.forestFire = true;
    journal(state, 'forestfire', `Forest fire started (${cause})`);
    bus.emit('notify', { kind: 'bad', icon: '🌲', title: 'Forest fire', cell: i, msg: `A forest fire broke out (${cause}). Firewatch towers and helicopters help contain it.` });
  }
}

function lightning(state, ctx) {
  const i = Math.floor(rng.next() * N * N);
  bus.emit('lightning', { cell: i });
  const b = state.bld[i] && state.buildings.get(state.bld[i]);
  if (b && rng.chance(0.4)) igniteBuilding(state, b, 'lightning strike');
  else if (state.tree[i]) igniteCell(state, ctx, i, 'lightning');
}

export function destroyBuilding(state, b, why) {
  // residents inside may be hurt; shelters and the warning system protect them
  journal(state, 'destroyed', `${b.name || b.def.name} ${why}`);
  for (const hid of b.households || []) {
    const hh = state.households.get(hid);
    for (const cid of hh?.members || []) { const c = state.citizens.get(cid); if (c) logLife(state, c, `Lost their home (${why})`); }
  }
  state.ruins = state.ruins || [];
  state.ruins.push({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, day: state.time.day });
  if (state.ruins.length > 200) state.ruins.shift();
  rememberRuin(state, b, why); // it'll be rebuilt where it stood once the rubble is cleared
  removeBuilding(state, b.id);
  bus.emit('rebuilds:changed');
  bus.emit('notify', { kind: 'bad', icon: '💥', title: 'Building destroyed', msg: `${b.def.name} ${why}.`, cell: b.y0 * N + b.x0 });
}

// Hail: damages buildings under the storm; repairs cost money
export function hailHourly(state, ctx) {
  if (!state.weather.hail || !state.options.disasters) return;
  if (!ctx.hailNotified) {
    ctx.hailNotified = true;
    state.counters.hail = true;
    journal(state, 'hail', 'Hail storm');
    bus.emit('notify', { kind: 'warn', icon: '🌨️', title: 'Hail storm', msg: 'Hail is damaging buildings across the city.' });
  }
  let repairs = 0;
  for (const b of state.buildings.values()) {
    if (rng.chance(0.15)) { b.condition = Math.max(0.3, (b.condition ?? 1) - 0.1); repairs += 200; }
  }
  charge(state, 'services', repairs);
}

// Tornado: a funnel crosses the map destroying what it touches
export function startTornado(state, ctx) {
  const side = Math.floor(rng.next() * 4);
  const p = rng.next() * N;
  const start = [[0, p], [p, 0], [N, p], [p, N]][side];
  const dir = [[1, 0], [0, 1], [-1, 0], [0, -1]][side];
  const ang = Math.atan2(dir[1], dir[0]) + (rng.next() - 0.5) * 0.8;
  ctx.tornado = { x: start[0], y: start[1], vx: Math.cos(ang), vy: Math.sin(ang), life: N * 1.4, warned: hasWarning(state) };
  state.counters.tornado = true;
  journal(state, 'tornado', 'A tornado touched down');
  bus.emit('notify', { kind: 'bad', icon: '🌪️', title: 'Tornado!', cell: Math.floor(ctx.tornado.y) * N + Math.floor(ctx.tornado.x), msg: ctx.tornado.warned ? 'The early warning system sent citizens to shelters.' : 'A tornado is tearing through the area!' });
}
const hasWarning = (state) => [...state.buildings.values()].some((b) => b.def.warning && !b.cons);

export function tornadoStep(state, ctx) {
  const t = ctx.tornado;
  if (!t) {
    // rare: a few times per decade, more in stormy weather
    if (state.options.disasters && state.time.day > 6 && rng.chance((0.00012 + state.weather.storm * 0.0004) * disasterOdds(state, ctx))) startTornado(state, ctx);
    return;
  }
  t.x += t.vx * 0.9; t.y += t.vy * 0.9; t.life -= 0.9;
  t.x += (rng.next() - 0.5) * 0.6; t.y += (rng.next() - 0.5) * 0.6;
  const shelterCov = ctx.coverage.shelter;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const x = Math.floor(t.x + dx), y = Math.floor(t.y + dy);
    if (!inBounds(x, y) || dx * dx + dy * dy > 5) continue;
    const i = idx(x, y);
    if (state.tree[i]) { state.tree[i] = 0; bus.emit('trees:changed'); }
    const b = state.bld[i] && state.buildings.get(state.bld[i]);
    if (b && !b.def.permanent && rng.chance(0.3)) {
      const protectedPeople = t.warned || (shelterCov && shelterCov[i] > 0.2);
      if (!protectedPeople) {
        for (const hid of b.households || []) {
          const hh = state.households.get(hid);
          for (const cid of [...(hh?.members || [])]) if (rng.chance(0.2)) { state.citizens.delete(cid); hh.members = hh.members.filter((m) => m !== cid); }
        }
      }
      destroyBuilding(state, b, 'was destroyed by a tornado');
    }
    if (state.road[i] && rng.chance(0.3)) state.roadCond[i] = Math.min(state.roadCond[i], 0.2);
  }
  if (t.life <= 0 || t.x < -5 || t.y < -5 || t.x > N + 5 || t.y > N + 5) {
    ctx.tornado = null;
    journal(state, 'tornado', 'The tornado dissipated');
  }
}
