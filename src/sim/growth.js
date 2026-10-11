// Zoned buildings spawn on painted cells next to roads when there is demand for them.
import { ROADS, ROAD_RANK, rankOf } from '../data/roads.js';
import { ZONES, MIXED_EDU } from '../data/zones.js';
import { stripBuilding, plotCells, plotOfCell } from './build.js';
import { rng } from '../core/rng.js';
import { startConstruction, reservedCells } from './construction.js';
import { zoneLayout, zoneOf, cellOf } from './zoneblocks.js';
import { rn } from './roadnet.js';
import { graph } from './roadgraph.js';

// Which demand value drives each zone
export function demandFor(state, def) {
  const d = state.demand;
  switch (def.key) {
    case 'res_low': return d.resLow;
    case 'res_row': case 'res_med': return d.resMed;
    case 'res_high': case 'res_tower': case 'res_mixed': case 'res_lowrent': return d.resHigh;
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
  const cells = b.w * Math.max(1, b.d - (b.setback || 0));
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

// Front cells: the first row of a zone strip, zoned and empty, along a road that reaches an
// outside connection.
function collectFronts(state, ctx) {
  const Z = zoneLayout(state);
  const Gr = graph(state), X = rn(state);
  const out = new Map();
  const reaches = (sid) => {
    if (!out.has(sid)) { const sg = X.seg.get(sid); const k = sg ? Gr.comp.get(sg.a) : -1; out.set(sid, k >= 0 && !!ctx.net.roadOutside?.[k]); }
    return out.get(sid);
  };
  const fronts = [];
  for (const c of Z.cells) {
    if (c.row !== 0 || state.bld[c.g]) continue;
    const z = zoneOf(state, c);
    if (z && reaches(c.seg)) fronts.push({ c, z });
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
    const { c, z } = fronts[k];
    const def = ZONES[z];
    const demand = demandFor(state, def);
    if (demand <= 0.02 || rng.next() > demand * 0.35) continue;
    if (state.bld[c.g] || zoneOf(state, c) !== z) continue;
    const plot = plotOfCell(state, c);
    if (plot ? spawnPlot(state, plot) : trySpawn(state, def, c)) {
      fronts[k] = fronts[fronts.length - 1];
      fronts.pop();
    }
  }
}

// Can a building take these zone cells? (all painted with its zone, and nothing on them)
function cellsFree(state, cells, zone) {
  for (const c of cells) {
    if (zoneOf(state, c) !== zone) return false;
    for (const i of c.gs) if (state.bld[i] || reserved.has(i)) return false;
  }
  return true;
}

// A lot you laid out: the building takes the whole lot (its size), set back by its front yard
function spawnPlot(state, p) {
  const def = ZONES[p.zone];
  if (!def) return null;
  const cells = plotCells(state, p);
  if (!cells || !cellsFree(state, cells, p.zone)) return null;
  if (def.resource && resourceShare(state, def, cells) < 0.3) return null;
  if (def.needsRoad && rankOf(rn(state).seg.get(p.seg)?.type) < ROAD_RANK[def.needsRoad]) return null;
  const b = stripBuilding(state, 'zone', def, cells, p.w, p.d, { plot: p.id, setback: p.setback || 0 });
  updateCapacity(b);
  return startConstruction(state, b);
}

// A building on the lot sizes its zone grows on, with this front cell at one end of it
function trySpawn(state, def, c) {
  const Z = zoneLayout(state);
  const rank = rankOf(rn(state).seg.get(c.seg)?.type);
  if (def.needsRoad && rank < ROAD_RANK[def.needsRoad]) return null;
  const lots = [...[...def.lots].sort(() => rng.next() - 0.5), ...(def.fallbackLots || [])];
  for (const [w, d] of lots) {
    for (const shift of [0, -(w - 1)]) {
      const cells = [];
      for (let j = 0; j < w && cells.length === j * d; j++) {
        for (let r = 0; r < d; r++) {
          const cc = cellOf(Z, c.seg, c.side, c.col + shift + j, r);
          if (!cc || plotOfCell(state, cc)) break;
          cells.push(cc);
        }
      }
      if (cells.length !== w * d || !cellsFree(state, cells, def.id)) continue;
      if (def.resource && resourceShare(state, def, cells) < 0.3) continue;
      const b = stripBuilding(state, 'zone', def, cells, w, d);
      updateCapacity(b);
      return startConstruction(state, b);
    }
  }
  return null;
}

function resourceShare(state, def, cells) {
  let n = 0, tot = 0;
  const layer = def.resource === 'forest' ? state.forestMax : state[def.resource];
  for (const c of cells) { tot++; if (layer[c.g] > 0) n++; }
  return n / tot;
}
