// Grading: when a road, rail or footpath is built on land, the terrain under it is cut and
// filled so the surface follows a smooth, not-too-steep profile. Roads then sit exactly on
// the ground — never buried in a hillside or floating above it. Water is left alone.
import { N, HN, idx, hidx, inBounds, DIRS } from '../core/grid.js';
import { cellHeight } from './mapgen.js';

export const MAX_GRADE = 0.35; // height change per cell (35%)

// Cells touching terrain corner (cx, cy)
const cornerCells = (cx, cy) => [[cx - 1, cy - 1], [cx, cy - 1], [cx - 1, cy], [cx, cy]].filter(([x, y]) => inBounds(x, y));

export function cornerTouches(state, cx, cy, test) {
  return cornerCells(cx, cy).some(([x, y]) => test(idx(x, y)));
}

// cells: [[x, y], ...] newly placed on `layer` (a typed array like state.road)
export function gradeCells(state, layer, cells) {
  // bridge spans are raised above the ground: they neither get graded nor shape the grading
  const raised = layer === state.rail ? state.railH : layer === state.path ? state.pathH : state.bridgeH;
  const ground = (j) => layer[j] && !state.water[j] && !raised[j];
  const set = new Map();
  for (const [x, y] of cells) {
    const i = idx(x, y);
    if (ground(i)) set.set(i, cellHeight(state, x, y));
  }
  if (!set.size) return null;
  // neighbours on the same network (new or existing), excluding bridges
  const nbrs = new Map();
  for (const i of set.keys()) {
    const x = i % N, y = (i / N) | 0;
    const list = [];
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const j = idx(nx, ny);
      if (ground(j)) list.push(j);
    }
    nbrs.set(i, list);
  }
  const h = (j) => (set.has(j) ? set.get(j) : cellHeight(state, j % N, (j / N) | 0));
  // 1) smooth small bumps along the network
  for (let pass = 0; pass < 4; pass++) {
    const next = new Map();
    for (const [i, v] of set) {
      const list = nbrs.get(i);
      if (!list.length) { next.set(i, v); continue; }
      let s = v * 2;
      for (const j of list) s += h(j);
      next.set(i, s / (2 + list.length));
    }
    for (const [i, v] of next) set.set(i, v);
  }
  // 2) limit the grade between neighbouring pieces (existing pieces stay fixed)
  for (let it = 0; it < 60; it++) {
    let moved = false;
    for (const [i, v] of set) {
      for (const j of nbrs.get(i)) {
        const hj = h(j);
        const d = v - hj;
        if (Math.abs(d) <= MAX_GRADE + 1e-4) continue;
        const excess = Math.abs(d) - MAX_GRADE;
        if (set.has(j)) {
          set.set(i, set.get(i) - Math.sign(d) * excess / 2);
          set.set(j, hj + Math.sign(d) * excess / 2);
        } else set.set(i, set.get(i) - Math.sign(d) * excess);
        moved = true;
      }
    }
    if (!moved) break;
  }
  // 3) write terrain corners: each corner becomes the average target of the network cells
  //    around it, so the ground under the road is exactly the road's surface
  const corners = new Set();
  for (const i of set.keys()) {
    const x = i % N, y = (i / N) | 0;
    corners.add(hidx(x, y)); corners.add(hidx(x + 1, y)); corners.add(hidx(x, y + 1)); corners.add(hidx(x + 1, y + 1));
  }
  // snapshot targets first: writing corners changes the cell heights we'd otherwise read
  const snap = new Map();
  for (const c of corners) {
    for (const [x, y] of cornerCells(c % HN, (c / HN) | 0)) {
      const j = idx(x, y);
      if (ground(j) && !snap.has(j)) snap.set(j, h(j));
    }
  }
  let x0 = N, y0 = N, x1 = 0, y1 = 0;
  for (const c of corners) {
    const cx = c % HN, cy = (c / HN) | 0;
    // Never touch the shoreline: rivers and coasts keep their shape. Road pieces on the
    // bank become bridge abutments instead (see deck.js).
    if (cornerTouches(state, cx, cy, (j) => state.water[j])) continue;
    let s = 0, n = 0;
    for (const [x, y] of cornerCells(cx, cy)) {
      const j = idx(x, y);
      if (!snap.has(j)) continue;
      s += snap.get(j); n++;
    }
    if (!n) continue;
    state.height[c] = s / n;
    x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
  }
  return x0 <= x1 ? { x0: Math.max(0, x0 - 1), y0: Math.max(0, y0 - 1), x1: Math.min(N - 1, x1), y1: Math.min(N - 1, y1) } : null;
}

