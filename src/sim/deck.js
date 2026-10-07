// Surface heights for roads, railways and footpaths, shared by the renderer and vehicles.
//  - Bridge cells use their stored deck height.
//  - Ground pieces follow the (graded) terrain, but are lifted wherever the ground under
//    their full width would poke through, so a road is never below the ground.
//  - Each piece has a centre height and an edge height toward every connected neighbour.
//    Neighbours share the same edge height, so pieces always meet.
import { N, idx, hidx, DIRS, inBounds } from '../core/grid.js';
import { cellHeight, terrainAt } from './mapgen.js';
import { bridgeLayers, linked, WATER_CLEARANCE } from './bridges.js';
import { segIndex, segPoint, segParam, clipToCell, crossingIn } from './roadsegs.js';
import { bus } from '../core/events.js';

const NN = N * N;
let cache = null;
let cacheState = null;
let dirty = true;
bus.on('network:changed', () => { dirty = true; });
bus.on('terrain:changed', () => { dirty = true; });

// Terrain corners of the shared edge between a cell and its neighbour in direction d
function edgeCorners(state, x, y, d) {
  const H = state.height;
  if (d === 0) return [H[hidx(x + 1, y)], H[hidx(x + 1, y + 1)]];
  if (d === 1) return [H[hidx(x, y + 1)], H[hidx(x + 1, y + 1)]];
  if (d === 2) return [H[hidx(x, y)], H[hidx(x, y + 1)]];
  return [H[hidx(x, y)], H[hidx(x + 1, y)]];
}

export function linkMask(state, layer, x, y) {
  const i = idx(x, y);
  let mask = 0;
  for (let d = 0; d < 4; d++) {
    const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
    if (inBounds(nx, ny) && linked(state, layer, i, idx(nx, ny), d)) mask |= 1 << d;
  }
  return mask;
}

function solveLayer(state, layer) {
  const [net, H] = bridgeLayers(state, layer);
  const center = new Float32Array(NN);
  const edge = new Float32Array(NN * 4);
  const masks = new Uint8Array(NN);
  const H0 = state.height;
  const SG = layer === 'road' ? segIndex(state) : null;
  const alongLine = new Uint8Array(NN); // pieces of a road at an angle (see below)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      if (!net[i]) continue;
      const mask = linkMask(state, layer, x, y);
      masks[i] = mask;
      if (H[i]) { center[i] = H[i]; continue; }
      let c = cellHeight(state, x, y);
      const a = H0[hidx(x, y)], b = H0[hidx(x + 1, y)], cc = H0[hidx(x, y + 1)], d = H0[hidx(x + 1, y + 1)];
      // A road at an angle running through (not one of its ends, no grid road joining it):
      // its surface is the ground along its own line (the ground under its whole width is
      // graded to that, see gradeAlongSegment)
      const seg = SG && !SG.ends.has(i) && SG.byCell.get(i);
      let own = 0;
      if (seg) for (let k = 0; k < 4; k++) if (SG.internal.has(i * 4 + k)) own |= 1 << k;
      if (seg && (mask & ~own) === 0) {
        // where two of them cross in this cell, the ground at the crossing (both pass through
        // it there); otherwise the ground on the line of the one that runs furthest through it
        const cross = seg.length > 1 ? crossingIn(seg, x, y) : null;
        let px, pz;
        if (cross) [px, pz] = cross.point;
        else {
          let s0 = seg[0], best = -1;
          if (seg.length > 1) for (const sg of seg) { const cl = clipToCell(sg, x, y); const l = cl ? cl[1] - cl[0] : 0; if (l > best) { best = l; s0 = sg; } }
          [px, pz] = segPoint(s0, segParam(s0, x + 0.5, y + 0.5));
        }
        c = terrainAt(state, px, pz);
        alongLine[i] = 1;
      }
      // Straight pieces only need to clear the ground beside them; junctions, bends and
      // ends have a flat pad, which must clear the whole cell.
      else if (mask === 5) c = Math.max(c, (a + b) / 2, (cc + d) / 2);
      else if (mask === 10) c = Math.max(c, (a + cc) / 2, (b + d) / 2);
      else c = Math.max(c, a, b, cc, d);
      if (state.water[i]) c = Math.max(c, state.seaLevel + WATER_CLEARANCE); // shouldn't happen: water gets bridges
      center[i] = c;
    }
  }
  // Roads at an angle: smooth each one's heights along its length, only ever upward (so it
  // never sinks below the ground it follows). On a slope a junction's pad sits a little
  // higher than the ground beside it; the rise to it is spread over the cells before it
  // instead of making a sharp kink. Junctions, ends and crossings stay where they are.
  if (SG) {
    for (const [sg, cells] of SG.cellsOf) {
      const order = SG.orderOf.get(sg);
      const pts = [];
      for (const [x, y] of cells) {
        if (!inBounds(x, y)) continue;
        const i = idx(x, y);
        if (!net[i] || H[i] || !order.has(i) || !clipToCell(sg, x, y)) continue;
        pts.push([i, alongLine[i] === 1 && SG.byCell.get(i).length === 1]);
      }
      if (pts.length < 3) continue;
      const base = pts.map(([i]) => center[i]);
      const hs = base.slice();
      for (let pass = 0; pass < 5; pass++) {
        const prev = hs.slice();
        for (let k = 1; k < hs.length - 1; k++) if (pts[k][1]) hs[k] = Math.max(base[k], (prev[k - 1] + prev[k] * 2 + prev[k + 1]) / 4);
      }
      pts.forEach(([i, free], k) => { if (free) center[i] = hs[k]; });
    }
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      const mask = masks[i];
      if (!net[i]) continue;
      for (let d = 0; d < 4; d++) {
        if (!(mask & (1 << d))) { edge[i * 4 + d] = center[i]; continue; }
        const j = idx(x + DIRS[d][0], y + DIRS[d][1]);
        let e = (center[i] + center[j]) / 2;
        // (between two pieces of a road at an angle the line doesn't cross that edge's corners)
        if ((!H[i] || !H[j]) && !(alongLine[i] && alongLine[j])) { const [c1, c2] = edgeCorners(state, x, y, d); e = Math.max(e, c1, c2); }
        edge[i * 4 + d] = e;
      }
    }
  }
  return { center, edge, masks };
}

function groundHeights(state) {
  const ground = new Float32Array(NN);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      const h = cellHeight(state, x, y);
      ground[i] = state.water[i] ? Math.max(h, state.seaLevel) : h;
    }
  }
  return ground;
}

export function getDeck(state) {
  if (!dirty && cacheState === state && cache) return cache;
  cache = { ground: groundHeights(state), road: solveLayer(state, 'road'), rail: solveLayer(state, 'rail'), path: solveLayer(state, 'path') };
  cacheState = state;
  dirty = false;
  return cache;
}

// Height along the way from cell i to its neighbour j (f = 0 at i's centre, 1 at j's)
export function deckBetween(L, i, j, f) {
  if (i === j) return L.center[i];
  const d = j === i + 1 ? 0 : j === i + N ? 1 : j === i - 1 ? 2 : 3;
  const dj = (d + 2) % 4;
  return f < 0.5
    ? L.center[i] + (L.edge[i * 4 + d] - L.center[i]) * (f * 2)
    : L.edge[j * 4 + dj] + (L.center[j] - L.edge[j * 4 + dj]) * ((f - 0.5) * 2);
}
