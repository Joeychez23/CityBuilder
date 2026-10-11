// Connected components of the road and rail networks, and which of them reach an
// outside connection. Recomputed only when a network changes. (Roads: by the road network's
// own graph, sim/roadgraph.js, so a road passing over another isn't joined to it.)
import { N, idx, inBounds, DIRS } from '../core/grid.js';
import { pruneTunnels, joinThroughLinks } from './tunnels.js';
import { linked } from './bridges.js';
import { graph } from './roadgraph.js';

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
  pruneTunnels(state); // a railway tunnel whose portal lost its track closes
  // roads: the connected parts of the road network (sim/roadgraph.js), onto the road's cells
  const Gr = graph(state);
  const X = Gr.X;
  const comp = new Int32Array(N * N).fill(-1);
  const count = Gr.compCount;
  const segComp = (sid) => { const sg = X.seg.get(sid); return sg ? Gr.comp.get(sg.a) ?? -1 : -1; };
  for (let i = 0; i < N * N; i++) if (state.road[i]) comp[i] = segComp(state.roadSeg[i]);
  const outside = new Uint8Array(count);
  const size = new Int32Array(count);
  for (let i = 0; i < N * N; i++) if (comp[i] >= 0) size[comp[i]]++;
  for (const n of X.node.values()) if (n.out) outside[Gr.comp.get(n.id)] = 1;
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
  // a building turned to face its road: the road at its front, else any road beside it
  if (b.cells) {
    if (b.front >= 0 && ctx.net.roadComp[b.front] >= 0 && !state.bridgeH[b.front]) return { comp: ctx.net.roadComp[b.front], x: b.front % N, y: (b.front / N) | 0 };
    const own = new Set(b.cells);
    for (const i of b.cells) {
      const x = i % N, y = (i / N) | 0;
      for (const [dx, dy] of DIRS) {
        if (!inBounds(x + dx, y + dy)) continue;
        const j = idx(x + dx, y + dy);
        if (own.has(j) || state.bridgeH[j]) continue;
        if (ctx.net.roadComp[j] >= 0) return { comp: ctx.net.roadComp[j], x: x + dx, y: y + dy };
      }
    }
    return null;
  }
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
