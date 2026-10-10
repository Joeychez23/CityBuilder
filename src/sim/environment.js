// Pollution (air, ground, noise, water, groundwater), land value, and natural resources
// regenerating or being damaged.
//
// Pollution builds up the longer it lingers: smog settles into the ground, contaminated
// ground gives off fumes and dust in turn and slowly seeps into the land around it, so a
// place that has been polluted for weeks keeps getting worse. Industrial, ore and oil land
// takes the worst of it (spills and waste settle there twice as fast) and is the slowest to
// recover once the factories go.
import { N, idx, inBounds, clamp, DIRS } from '../core/grid.js';
import { ROADS, UPG } from '../data/roads.js';
import { isService, center } from './services.js';
import { bus } from '../core/events.js';
import { ZONE_LIST } from '../data/zones.js';

const NN = N * N;
// (a new industrial area starts out about half as smoggy as it ends up a month later)
const SETTLE_FROM = 0.12;  // air pollution above this settles into the ground...
const SETTLE = 0.0006;     // ...this much of it each hour
const DIRTY_SETTLE = 2;    // × that on industrial, ore and oil land
const FUMES = 0.04;        // share of a cell's ground pollution given back to its air each hour
const SEEP = 40;           // ground pollution spreads to the cells around (smaller = faster)
const SOIL_KEEP = 0.992;   // ground pollution left after an hour (it heals in about a week)
const DIRTY_KEEP = 0.9985; // ...and on industrial land (half gone in a week, most in a month)
const DIRTY = new Uint8Array(256);
for (const z of ZONE_LIST) if (z.cat === 'ind' || z.key === 'spec_ore' || z.key === 'spec_oil') DIRTY[z.id] = 1;
const tmp = new Float32Array(NN);

// The box around everything non-zero in a layer, grown by `pad` cells (diffusion only has
// to look there: on a big map most of the land is clean and quiet)
function activeBox(layer, pad) {
  let x0 = N, y0 = N, x1 = -1, y1 = -1;
  for (let y = 0; y < N; y++) {
    const row = y * N;
    for (let x = 0; x < N; x++) {
      if (layer[row + x] > 1e-5) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return [Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(N - 1, x1 + pad), Math.min(N - 1, y1 + pad)];
}

// Blur a layer in place (diffusion), optionally drifting it along a vector (wind / current).
// Only the part of the map with something in it is touched.
function diffuse(layer, keep, drift = [0, 0], mask = null, box = activeBox(layer, 1)) {
  if (!box) return;
  const [wx, wy] = drift;
  const [bx0, by0, bx1, by1] = box;
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const i = idx(x, y);
      if (mask && !mask[i]) { tmp[i] = 0; continue; }
      let s = layer[i] * keep, w = keep;
      for (let d = 0; d < 4; d++) {
        const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
        if (!inBounds(nx, ny)) continue;
        const j = idx(nx, ny);
        if (mask && !mask[j]) continue;
        // upwind neighbours push more pollution into this cell
        const k = 1 + (DIRS[d][0] * -wx + DIRS[d][1] * -wy);
        s += layer[j] * Math.max(0.1, k);
        w += Math.max(0.1, k);
      }
      tmp[i] = s / w;
    }
  }
  for (let y = by0; y <= by1; y++) {
    const row = y * N;
    layer.set(tmp.subarray(row + bx0, row + bx1 + 1), row + bx0);
  }
}

export function pollutionHourly(state, ctx) {
  const air = state.air, ground = state.ground, noise = state.noise, wp = state.waterPoll;
  const w = state.weather;
  const filters = state.policies.pollutionManagement ? 0.7 : 1;
  const highSpeed = state.policies.highSpeedHighways;

  // --- sources. Industrial noise is also tracked on its own: residents hate living next to
  // factories far more than next to a busy shopping street.
  noise.fill(0);
  const ind = ctx.indNoise || (ctx.indNoise = new Float32Array(NN));
  ind.fill(0);
  for (const b of state.buildings.values()) {
    const [cx, cy] = center(b);
    const i = idx(cx, cy);
    const p = b.def.pollution;
    const eff = isService(b) ? (b.efficiency ?? 1) : 1;
    if (p) {
      if (p.air) air[i] += p.air * 0.12 * eff;
      if (p.ground) ground[i] += p.ground * 0.01 * eff;
      if (p.noise) noise[i] += p.noise;
    }
    if (b.kind === 'zone' && !b.abandoned) {
      const cat = b.def.cat;
      const size = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
      if (cat === 'ind') {
        const heavy = b.def.pollute || 1; // large industry is dirtier
        air[i] += 0.018 * size * filters * heavy * (b.efficiency ?? 0.5); noise[i] += 0.35 * heavy;
        for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) ground[idx(x, y)] += 0.004 * filters * heavy;
        const loud = (0.55 + size * 0.06) * heavy * (0.5 + 0.5 * Math.min(1, b.efficiency ?? 0.5)) * (b.level > 2 ? 1.15 : 1);
        for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) ind[idx(x, y)] += loud / size * 1.6;
      }
      if (cat === 'spec') {
        const g = b.def.key === 'spec_oil' || b.def.key === 'spec_ore' ? 0.004 : 0.001;
        for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) ground[idx(x, y)] += g;
        noise[i] += 0.2;
        if (b.def.key === 'spec_ore' || b.def.key === 'spec_oil') for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) ind[idx(x, y)] += 0.5 / size * 1.6;
      }
      if (cat === 'com') noise[i] += 0.15 * size * 0.3;
    }
  }
  // Traffic: air & noise along busy roads
  for (let i = 0; i < NN; i++) {
    const t = state.road[i];
    if (!t) continue;
    const vol = state.roadVol[i];
    const dist = state.district[i] && state.districts.find((d) => d.id === state.district[i]);
    const combustionBan = dist?.policies?.combustionBan ? 0.4 : 1;
    const heavyBan = dist?.policies?.heavyBan ? 0.8 : 1;
    let n = (0.06 + vol * 0.035) * ROADS[t].noise * (highSpeed && ROADS[t].key === 'highway' ? 1.4 : 1) * heavyBan;
    if (state.roadUpg[i] & UPG.TREES) n *= 0.7;
    if (state.roadUpg[i] & UPG.BARRIER) n *= 0.35;
    if (dist?.policies?.speedBumps) n *= 0.75;
    noise[i] += n;
    air[i] += vol * 0.0015 * combustionBan * heavyBan * (ctx.electricVehicles ? 0.5 : 1);
  }
  // contaminated ground gives off fumes and dust
  for (let i = 0; i < NN; i++) if (ground[i] > 0.005) air[i] += ground[i] * FUMES;
  // --- spread: air drifts with the wind; noise spreads a little and never accumulates;
  // ground pollution seeps slowly into the land around it
  const windDir = ctx.windDir || [1, 0];
  diffuse(air, 4, [windDir[0] * w.wind * 0.6, windDir[1] * w.wind * 0.6]);
  diffuse(noise, 2);
  diffuse(noise, 3);
  diffuse(ground, SEEP);
  // factory noise carries further (a few blocks)
  const indBox = activeBox(ind, 10);
  for (let k = 0; k < 10; k++) diffuse(ind, 1, [0, 0], null, indBox);
  for (let i = 0; i < NN; i++) {
    ind[i] = clamp(Math.sqrt(ind[i]) * 2.4 - 0.04 - state.tree[i] * 0.05, 0, 1.5);
    noise[i] += ind[i] * 0.5;
  }
  const zone = state.zone;
  for (let i = 0; i < NN; i++) {
    // trees soak up some pollution; rain washes the air; what's left hanging over a place
    // settles into its ground
    const tree = state.tree[i] * 0.004;
    air[i] = clamp(air[i] * (0.94 - w.rain * 0.06) - tree, 0, 1.5);
    const dirty = DIRTY[zone[i]];
    const settle = Math.max(0, air[i] - SETTLE_FROM) * SETTLE * (dirty ? DIRTY_SETTLE : 1);
    ground[i] = state.water[i] ? 0 : clamp(ground[i] * (dirty ? DIRTY_KEEP : SOIL_KEEP) + settle - (state.tree[i] ? 0.0004 : 0), 0, 1.5);
    noise[i] = clamp(noise[i] - state.tree[i] * 0.03, 0, 1.5);
  }

  // --- water: sewage enters at outlets, flows with the current, dilutes and decays
  for (const s of ctx.sewageOut || []) {
    if (s.at) { wp[idx(s.at[0], s.at[1])] += s.amount / 2500; continue; }
    // find the water cell nearest to the outlet
    let best = -1, bd = 1e9;
    for (let y = s.y - 3; y <= s.y + 3; y++) for (let x = s.x - 3; x <= s.x + 3; x++) {
      if (!inBounds(x, y) || !state.water[idx(x, y)]) continue;
      const d = Math.abs(x - s.x) + Math.abs(y - s.y);
      if (d < bd) { bd = d; best = idx(x, y); }
    }
    if (best >= 0) wp[best] += s.amount / 2500;
  }
  // ground pollution next to water leaks into it
  for (let i = 0; i < NN; i++) if (!state.water[i] && ground[i] > 0.2) {
    const x = i % N, y = (i / N) | 0;
    for (const [dx, dy] of DIRS) { const nx = x + dx, ny = y + dy; if (inBounds(nx, ny) && state.water[idx(nx, ny)]) wp[idx(nx, ny)] += ground[i] * 0.004; }
  }
  diffuse(wp, 2, state.flow, state.water);
  for (let i = 0; i < NN; i++) wp[i] = state.water[i] ? clamp(wp[i] * 0.985, 0, 1.5) : 0;

  // --- groundwater: refills slowly; ground pollution seeps in, then slowly cleans
  for (let i = 0; i < NN; i++) {
    if (state.groundwater[i] <= 0 && !ctx.gwOrigin?.[i]) continue;
    if (!ctx.gwOrigin) ctx.gwOrigin = new Float32Array(NN);
    if (!ctx.gwOrigin[i]) ctx.gwOrigin[i] = Math.max(state.groundwater[i], 0.01);
    state.groundwater[i] = Math.min(ctx.gwOrigin[i], state.groundwater[i] + 0.0006);
    state.gwPollution[i] = clamp(state.gwPollution[i] * 0.997 + ground[i] * 0.003, 0, 1);
  }
}

// Land value: roads + services + parks + water views + centrality, minus pollution & crime
export function landValueDaily(state, ctx) {
  const lv = state.landValue;
  const cov = ctx.coverage;
  const g = (k, i) => (cov[k] ? cov[k][i] : 0);
  const c = N / 2;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      if (state.water[i]) { lv[i] = 0; continue; }
      let v = 0.18;
      v += Math.min(1, g('leisure', i)) * 0.18 + g('health', i) * 0.06 + g('police', i) * 0.06 + g('fire', i) * 0.04;
      v += g('education1', i) * 0.05 + g('education2', i) * 0.04 + Math.min(1, g('telecom', i)) * 0.05 + g('post', i) * 0.03;
      v += (ctx.sigBoost?.[i] || 0) * 0.02 + (ctx.transitCov?.[i] || 0) * 0.08;
      v += nearWater(state, x, y) ? 0.08 : 0;
      v += state.tree[i] ? 0.02 : 0;
      v += Math.max(0, 1 - Math.hypot(x - c, y - c) / 80) * 0.08;
      v -= state.air[i] * 0.35 + state.ground[i] * 0.3 + state.noise[i] * 0.2;
      const b = state.bld[i] && state.buildings.get(state.bld[i]);
      if (b) v -= (b.crime || 0) * 0.002 + ((b.garbage || 0) > 4 ? 0.05 : 0);
      lv[i] = lv[i] * 0.6 + clamp(v, 0, 1) * 0.4;
    }
  }
}

// Cells within 3 of water (a water view raises land value), worked out again only when the
// terrain changes
let nearWaterMask = null, nearWaterState = null;
bus.on('terrain:changed', () => { nearWaterMask = null; });
function nearWater(state, x, y) {
  if (!nearWaterMask || nearWaterState !== state) {
    nearWaterMask = new Uint8Array(NN);
    nearWaterState = state;
    for (let i = 0; i < NN; i++) {
      if (!state.water[i]) continue;
      const wx = i % N, wy = (i / N) | 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const nx = wx + dx, ny = wy + dy;
        if (inBounds(nx, ny)) nearWaterMask[idx(nx, ny)] = 1;
      }
    }
  }
  return nearWaterMask[idx(x, y)] === 1;
}

// Forests regrow and spread, ground pollution kills trees and fertile land, fertile land recovers
export function natureDaily(state) {
  let changed = false;
  for (let i = 0; i < NN; i++) {
    if (state.ground[i] > 0.45 && state.tree[i] && Math.random() < 0.08) { state.tree[i]--; changed = true; }
    if (state.ground[i] > 0.3) state.fertile[i] = Math.max(0, state.fertile[i] - 0.01);
    if (state.burnt[i] > 0) state.burnt[i] = Math.max(0, state.burnt[i] - 0.03);
    if (state.forestMax[i] && state.tree[i] < 3 && !state.bld[i] && !state.road[i] && !state.rail[i] && !state.path[i] && state.burnt[i] < 0.2 && state.ground[i] < 0.3 && Math.random() < 0.03) {
      state.tree[i]++;
      changed = true;
    }
  }
  return changed;
}
