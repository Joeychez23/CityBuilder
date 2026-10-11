// Surface heights for railways and footpaths, shared by the renderer and the trains and people
// on them. (Roads have their own heights along each road: see sim/roadnet.js.)
//  - Bridge cells use their stored deck height.
//  - Ground pieces follow the (graded) terrain, but are lifted wherever the ground under
//    their full width would poke through, so a track is never below the ground.
//  - Each piece has a centre height and an edge height toward every connected neighbour.
//    Neighbours share the same edge height, so pieces always meet. Along a straight bridge
//    the edge heights follow a curve through the cells either side, so the deck rounds over
//    its top and into its ramps rather than bending at each cell.
import { N, idx, hidx, DIRS, inBounds } from '../core/grid.js';
import { cellHeight } from './mapgen.js';
import { bridgeLayers, linked, WATER_CLEARANCE } from './bridges.js';
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
  const [net, H, axis] = bridgeLayers(state, layer);
  const center = new Float32Array(NN);
  const edge = new Float32Array(NN * 4);
  const masks = new Uint8Array(NN);
  const H0 = state.height;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      if (!net[i]) continue;
      const mask = linkMask(state, layer, x, y);
      masks[i] = mask;
      if (H[i]) { center[i] = H[i]; continue; }
      let c = cellHeight(state, x, y);
      const a = H0[hidx(x, y)], b = H0[hidx(x + 1, y)], cc = H0[hidx(x, y + 1)], d = H0[hidx(x + 1, y + 1)];
      // Straight pieces only need to clear the ground beside them; junctions, bends and
      // ends have a flat pad, which must clear the whole cell.
      if (mask === 5) c = Math.max(c, (a + b) / 2, (cc + d) / 2);
      else if (mask === 10) c = Math.max(c, (a + cc) / 2, (b + d) / 2);
      else c = Math.max(c, a, b, cc, d);
      if (state.water[i]) c = Math.max(c, state.seaLevel + WATER_CLEARANCE); // shouldn't happen: water gets bridges
      center[i] = c;
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
        // (between two cells of a straight bridge: a curve through them and the cells beyond
        // each, kept between their two heights)
        if (H[i] && H[j] && axis[i] === axis[j] && axis[i] === ((d & 1) ? 2 : 1)) {
          const back = (d + 2) % 4;
          const pi = mask & (1 << back) ? center[idx(x + DIRS[back][0], y + DIRS[back][1])] : center[i];
          const nj = masks[j] & (1 << d) ? center[idx(x + 2 * DIRS[d][0], y + 2 * DIRS[d][1])] : center[j];
          e = Math.min(Math.max(center[i], center[j]), Math.max(Math.min(center[i], center[j]), (9 * (center[i] + center[j]) - pi - nj) / 16));
        }
        if (!H[i] || !H[j]) { const [c1, c2] = edgeCorners(state, x, y, d); e = Math.max(e, c1, c2); }
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
  cache = { ground: groundHeights(state), rail: solveLayer(state, 'rail'), path: solveLayer(state, 'path') };
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
