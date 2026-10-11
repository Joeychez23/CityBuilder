// Connected components of the road and rail networks, and which of them reach an
// outside connection. Recomputed only when a network changes.
import { N, idx, inBounds, DIRS } from '../core/grid.js';
import { pruneTunnels, joinThroughLinks } from './tunnels.js';
import { linked } from './bridges.js';

// linkFn(i, j, d) -> may i connect to neighbour j? (bridges only connect along their axis)
export function labelComponents(layer, extraLink, linkFn) {
  const comp = new Int32Array(N * N).fill(-1);
  let count = 0;
  const stack = [];
  for (let i = 0; i < N * N; i++) {
    if (!layer[i] || comp[i] !== -1) continue;
    comp[i] = count;
    stack.push(i);
    while (stack.length) {
      const c = stack.pop();
      const x = c % N, y = (c / N) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
        if (!inBounds(nx, ny)) continue;
        const j = idx(nx, ny);
        if (comp[j] !== -1) continue;
        if (!layer[j] && !(extraLink && extraLink(j))) continue;
        if (linkFn && layer[j] && !linkFn(c, j, d)) continue;
        comp[j] = count;
        stack.push(j);
      }
    }
    count++;
  }
  return { comp, count };
}

export function computeRoadNetwork(state, ctx) {
  pruneTunnels(state); // a tunnel whose portal lost its road closes
  const { comp, count } = labelComponents(state.road, null, (i, j, d) => linked(state, 'road', i, j, d));
  joinThroughLinks(state, 'road', comp, count);
  const outside = new Uint8Array(count);
  const size = new Int32Array(count);
  for (let i = 0; i < N * N; i++) if (comp[i] >= 0) size[comp[i]]++;
  for (const c of state.connections) {
    if (c.type !== 'road') continue;
    const k = comp[idx(c.x, c.y)];
    if (k >= 0) outside[k] = 1;
  }
  ctx.net.roadComp = comp;
  ctx.net.roadOutside = outside;
  ctx.net.roadSize = size;

  const rail = labelComponents(state.rail, null, (i, j, d) => linked(state, 'rail', i, j, d));
  joinThroughLinks(state, 'rail', rail.comp, rail.count);
  const railOutside = new Uint8Array(rail.count);
  for (const c of state.connections) {
    if (c.type !== 'rail') continue;
    const k = rail.comp[idx(c.x, c.y)];
    if (k >= 0) railOutside[k] = 1;
  }
  ctx.net.railComp = rail.comp;
  ctx.net.railOutside = railOutside;
  ctx.net.subwayComp = labelComponents(state.subway).comp;
}

// The road component a building's front faces (or any adjacent road), -1 if none.
export function buildingRoadComp(state, ctx, b) {
  const [fx, fy] = DIRS[b.rot || 0];
  // check the cells just outside the footprint, front side first
  const cand = [];
  for (let y = b.y0 - 1; y <= b.y1 + 1; y++) {
    for (let x = b.x0 - 1; x <= b.x1 + 1; x++) {
      if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) continue;
      if ((x < b.x0 || x > b.x1) && (y < b.y0 || y > b.y1)) continue; // skip diagonals
      if (!inBounds(x, y)) continue;
      const front = (fx > 0 && x > b.x1) || (fx < 0 && x < b.x0) || (fy > 0 && y > b.y1) || (fy < 0 && y < b.y0);
      cand.push([x, y, front]);
    }
  }
  cand.sort((a, c) => c[2] - a[2]);
  for (const [x, y] of cand) {
    if (state.bridgeH[idx(x, y)]) continue;
    const k = ctx.net.roadComp[idx(x, y)];
    if (k >= 0) return { comp: k, x, y };
  }
  // rides in a theme park are reached through its gate
  if (b.def.inPark) for (const g of state.buildings.values()) if (g.def.themeGate) return buildingRoadComp(state, ctx, g);
  // a beach or boardwalk on the shore: a road within a few cells will do
  if (b.def.area?.shore) {
    for (let r = 2; r <= 3; r++) for (let y = b.y0 - r; y <= b.y1 + r; y++) for (let x = b.x0 - r; x <= b.x1 + r; x++) {
      if (!inBounds(x, y) || (x >= b.x0 - r + 1 && x <= b.x1 + r - 1 && y >= b.y0 - r + 1 && y <= b.y1 + r - 1)) continue;
      const i = idx(x, y);
      if (state.bridgeH[i]) continue;
      const k = ctx.net.roadComp[i];
      if (k >= 0) return { comp: k, x, y };
    }
  }
  return null;
}
