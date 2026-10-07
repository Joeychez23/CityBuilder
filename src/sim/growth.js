// Zoned buildings spawn on painted cells next to roads when there is demand for them.
import { N, idx, inBounds, DIRS } from '../core/grid.js';
import { ROADS, ROAD_RANK, rankOf } from '../data/roads.js';
import { ZONES, MIXED_EDU } from '../data/zones.js';
import { createBuilding, footprint, footprintFree } from './build.js';
import { rng } from '../core/rng.js';
import { segIndex } from './roadsegs.js';
import { startConstruction, reservedCells } from './construction.js';

// Which demand value drives each zone
export function demandFor(state, def) {
  const d = state.demand;
  switch (def.key) {
    case 'res_low': return d.resLow;
    case 'res_row': case 'res_med': return d.resMed;
    case 'res_high': case 'res_mixed': case 'res_lowrent': return d.resHigh;
    default:
      if (def.cat === 'spec') return d.ind * 0.8 + 0.1;
      return d[def.cat];
  }
}

// Workplace / household capacity for a zoned building at its current level.
export function updateCapacity(b) {
  if (b.kind !== 'zone') return;
  const def = b.def;
  if (def.signature) {
    b.hhCap = def.cat === 'res' ? def.hh : 0;
    b.jobs = def.jobs || 0;
    b.jobsEdu = def.edu.map((v) => Math.round(v * b.jobs));
    b.jobsEdu[0] += b.jobs - b.jobsEdu.reduce((a, c) => a + c, 0);
    return;
  }
  // on a lot with a front yard, only the part behind the yard is built on
  const cells = b.setback ? b.w * Math.max(1, b.d - b.setback) : (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
  const lvl = b.level;
  b.hhCap = 0;
  b.jobs = 0;
  if (def.cat === 'res') {
    b.hhCap = def.key === 'res_low' ? (cells >= 4 ? 2 : 1) : Math.max(1, Math.round(cells * def.hh * (1 + (lvl - 1) * 0.18)));
    if (def.mixed) b.jobs = Math.round(cells * def.jobs * (1 + (lvl - 1) * 0.15));
  } else {
    b.jobs = Math.max(1, Math.round(cells * def.jobs * (1 + (lvl - 1) * 0.2)));
  }
  // Higher levels need more educated workers
  const base = def.mixed ? MIXED_EDU : def.edu || MIXED_EDU;
  const shift = (lvl - 1) * 0.04;
  const edu = base.map((v, k) => Math.max(0, v + (k === 0 ? -shift * 2 : k >= 2 ? shift * 0.67 : 0)));
  const sum = edu.reduce((a, c) => a + c, 0);
  b.jobsEdu = edu.map((v) => Math.round((v / sum) * b.jobs));
  b.jobsEdu[0] += b.jobs - b.jobsEdu.reduce((a, c) => a + c, 0);
}

// Front cells: zoned, empty, next to a zonable road that reaches an outside connection.
function collectFronts(state, ctx) {
  const fronts = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      const z = state.zone[i];
      if (!z || state.bld[i]) continue;
      for (let d = 0; d < 4; d++) {
        const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
        if (!inBounds(nx, ny)) continue;
        const j = idx(nx, ny);
        const t = state.road[j];
        if (!t || !ROADS[t].zonable || state.bridgeH[j]) continue;
        if (!ctx.net.roadOutside[ctx.net.roadComp[j]]) continue;
        fronts.push([x, y, d, z]);
        break;
      }
    }
  }
  return fronts;
}

let reserved = new Set();
export function growthStep(state, ctx) {
  // cells waiting for a destroyed building to be rebuilt stay free meanwhile
  if (ctx.reservedDirty || !ctx.reservedReady) { reserved = reservedCells(state); ctx.reservedDirty = false; ctx.reservedReady = true; }
  if (ctx.frontsDirty || !ctx.fronts || ctx.stepCount % 12 === 0) {
    ctx.fronts = collectFronts(state, ctx);
    ctx.frontsDirty = false;
  }
  const fronts = ctx.fronts;
  if (!fronts.length) return;
  const tries = Math.min(fronts.length, 24);
  for (let t = 0; t < tries; t++) {
    const k = Math.floor(rng.next() * fronts.length);
    const [x, y, rot, z] = fronts[k];
    const def = ZONES[z];
    const demand = demandFor(state, def);
    if (demand <= 0.02 || rng.next() > demand * 0.35) continue;
    if (state.bld[idx(x, y)] || state.zone[idx(x, y)] !== z) continue;
    const plot = state.plot[idx(x, y)] && state.plots.find((p) => p.id === state.plot[idx(x, y)]);
    if (plot ? spawnPlot(state, plot) : trySpawn(state, def, x, y, rot)) {
      fronts[k] = fronts[fronts.length - 1];
      fronts.pop();
    }
  }
}

// A lot you laid out: the building takes the whole lot (its size), set back by its front yard
function spawnPlot(state, p) {
  const def = ZONES[p.zone];
  if (!def) return null;
  for (let y = p.y0; y <= p.y1; y++) {
    for (let x = p.x0; x <= p.x1; x++) {
      const i = idx(x, y);
      if (state.bld[i] || state.zone[i] !== p.zone || state.plot[i] !== p.id || reserved.has(i)) return null;
    }
  }
  if (def.resource && resourceShare(state, def, p.x0, p.y0, p.x1, p.y1) < 0.3) return null;
  if (def.needsRoad && plotFrontRank(state, p) < ROAD_RANK[def.needsRoad]) return null;
  const b = createBuilding(state, 'zone', def, p.x0, p.y0, p.x1, p.y1, p.rot, { plot: p.id, setback: p.setback || 0 });
  updateCapacity(b);
  return startConstruction(state, b);
}

function trySpawn(state, def, x, y, rot) {
  const lots = [...def.lots].sort(() => rng.next() - 0.5);
  for (const [w, d] of lots) {
    // try the lot with this cell at either end along the road
    for (const shift of [0, -(w - 1)]) {
      const [sx, sy] = DIRS[rot][1] === 0 ? [0, 1] : [1, 0];
      const ax = x + sx * shift, ay = y + sy * shift;
      const [x0, y0, x1, y1] = footprint(ax, ay, w, d, rot);
      if (!footprintFree(state, x0, y0, x1, y1, def.id)) continue;
      if (reserved.size && touchesReserved(x0, y0, x1, y1)) continue;
      // every cell of the front row must touch the road
      if (!frontTouchesRoad(state, ax, ay, w, rot)) continue;
      if (def.needsRoad && frontRank(state, ax, ay, w, rot) < ROAD_RANK[def.needsRoad]) continue;
      if (def.resource && resourceShare(state, def, x0, y0, x1, y1) < 0.3) continue;
      const b = createBuilding(state, 'zone', def, x0, y0, x1, y1, rot);
      updateCapacity(b);
      return startConstruction(state, b);
    }
  }
  return null;
}

// The biggest class of road along a lot's front (see the road hierarchy in data/roads.js):
// high-density buildings only grow beside a collector or bigger
function frontRank(state, ax, ay, w, rot) {
  const [sx, sy] = DIRS[rot][1] === 0 ? [0, 1] : [1, 0];
  let r = -1;
  for (let k = 0; k < w; k++) {
    const fx = ax + sx * k + DIRS[rot][0], fy = ay + sy * k + DIRS[rot][1];
    if (inBounds(fx, fy)) r = Math.max(r, rankOf(state.road[idx(fx, fy)]));
  }
  return r;
}
function plotFrontRank(state, p) {
  const [dx, dy] = DIRS[p.rot];
  let r = -1;
  for (let y = p.y0; y <= p.y1; y++) {
    for (let x = p.x0; x <= p.x1; x++) {
      const fx = x + dx, fy = y + dy;
      if (fx >= p.x0 && fx <= p.x1 && fy >= p.y0 && fy <= p.y1) continue; // still inside the lot
      if (inBounds(fx, fy)) r = Math.max(r, rankOf(state.road[idx(fx, fy)]));
    }
  }
  return r;
}

function touchesReserved(x0, y0, x1, y1) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (reserved.has(idx(x, y))) return true;
  return false;
}

// Most of the lot's front row has to touch the road (all of it along a grid road; along a
// road at an angle the cells step away from it, so half is enough)
function frontTouchesRoad(state, ax, ay, w, rot) {
  const [sx, sy] = DIRS[rot][1] === 0 ? [0, 1] : [1, 0];
  let n = 0;
  for (let k = 0; k < w; k++) {
    const fx = ax + sx * k + DIRS[rot][0], fy = ay + sy * k + DIRS[rot][1];
    if (inBounds(fx, fy) && state.road[idx(fx, fy)] && !state.bridgeH[idx(fx, fy)]) n++;
  }
  if (n === w) return true;
  return n >= Math.ceil(w / 2) && (state.roadSegs || []).length > 0 && n > 0 && touchesDiagonal(state, ax, ay, w, rot);
}

function touchesDiagonal(state, ax, ay, w, rot) {
  const SG = segIndex(state);
  const [sx, sy] = DIRS[rot][1] === 0 ? [0, 1] : [1, 0];
  for (let k = 0; k < w; k++) {
    const fx = ax + sx * k + DIRS[rot][0], fy = ay + sy * k + DIRS[rot][1];
    if (inBounds(fx, fy) && SG.byCell.has(idx(fx, fy))) return true;
  }
  return false;
}

function resourceShare(state, def, x0, y0, x1, y1) {
  let n = 0, tot = 0;
  const layer = def.resource === 'forest' ? state.forestMax : state[def.resource];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { tot++; if (layer[idx(x, y)] > 0) n++; }
  return n / tot;
}
