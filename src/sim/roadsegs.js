// Roads at any angle. A straight road between two cells is kept as a segment (from one cell
// centre to the other) and laid out on the grid as the staircase of cells the line passes
// through. The simulation (routes, zoning, power, access) keeps working cell by cell; the
// segment is what gets drawn, and what cars and people follow, so diagonal roads look and
// drive straight instead of zigzagging.
import { N, idx, inBounds, DIRS } from '../core/grid.js';
import { bus } from '../core/events.js';

// Cells a straight line from cell centre (ax, ay) to (bx, by) passes through, in order.
// Consecutive cells always share an edge (where the line passes exactly through a corner,
// both cells next to it are taken), so the road stays connected for the simulation.
export function lineCells(ax, ay, bx, by) {
  const cells = [[ax, ay]];
  const dx = bx - ax, dy = by - ay;
  const sx = Math.sign(dx), sy = Math.sign(dy);
  const nx = Math.abs(dx), ny = Math.abs(dy);
  let x = ax, y = ay, ix = 0, iy = 0;
  while (ix < nx || iy < ny) {
    // compare where the line next crosses a vertical vs a horizontal cell edge
    const tx = nx ? (ix + 0.5) / nx : Infinity, ty = ny ? (iy + 0.5) / ny : Infinity;
    if (Math.abs(tx - ty) < 1e-9) {
      x += sx; ix++; cells.push([x, y]);
      y += sy; iy++; cells.push([x, y]);
    } else if (tx < ty) { x += sx; ix++; cells.push([x, y]); }
    else { y += sy; iy++; cells.push([x, y]); }
  }
  return cells;
}

export const isAxisLine = (ax, ay, bx, by) => ax === bx || ay === by;

// Snap the end of a road being drawn: straight along the grid or at 45° when it's close,
// or to steps of 15° when Shift is held
export function snapEnd(sx, sy, ex, ey, fine = false) {
  const dx = ex - sx, dy = ey - sy;
  if (!dx && !dy) return [ex, ey];
  const ang = Math.atan2(dy, dx), len = Math.hypot(dx, dy);
  if (fine) {
    const a = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
    return [sx + Math.round(Math.cos(a) * len), sy + Math.round(Math.sin(a) * len)];
  }
  const step = Math.PI / 4;
  const a = Math.round(ang / step) * step;
  if (Math.abs(ang - a) > 0.065) return [ex, ey];
  const k = Math.round(a / step) & 7;
  if (k % 2 === 0) return k % 4 === 0 ? [ex, sy] : [sx, ey]; // along the grid
  const m = Math.round((Math.abs(dx) + Math.abs(dy)) / 2);
  return [sx + Math.sign(dx) * m, sy + Math.sign(dy) * m];
}

// Snap the end of a road to one of a few directions: whichever the pointer is nearest to,
// ending at the cell nearest the pointer along it. A direction is [dx, dy] in whole cells
// (like [3, 1]): the road then ends a whole number of those steps away, so it runs exactly
// that way (roads drawn off an angled grid stay parallel or square to it).
export function snapToDirs(sx, sy, ex, ey, dirs) {
  const vx = ex - sx, vy = ey - sy;
  if (!vx && !vy) return [ex, ey];
  let best = null, bd = Infinity;
  for (const [px, py] of dirs) {
    const l = Math.hypot(px, py) || 1, ux = px / l, uy = py / l;
    for (const k of [1, -1]) {
      const t = (vx * ux + vy * uy) * k;
      if (t <= 0) continue;
      const perp = Math.abs(vx * uy - vy * ux);
      if (perp < bd - 1e-9) { bd = perp; best = [px * k, py * k, t / l]; }
    }
  }
  if (!best) return [ex, ey];
  const [px, py, steps] = best;
  const n = Math.max(1, Math.round(steps));
  return [Math.round(sx + px * n), Math.round(sy + py * n)];
}

// Directions a road drawn "on the grid" from cell (x, y) may take: along the map's grid, and
// along (or square to) any road at an angle that passes through that cell, in the smallest
// whole-cell steps that run that way (a road from (0, 0) to (21, 7) gives [3, 1] and [-1, 3])
export function gridDirs(state, x, y) {
  const dirs = [[1, 0], [0, 1]];
  if (!inBounds(x, y)) return dirs;
  const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
  for (const s of segIndex(state).byCell.get(idx(x, y)) || []) {
    let dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
    const g = gcd(Math.abs(dx), Math.abs(dy)) || 1;
    dx /= g; dy /= g;
    // a long step (an odd angle) is shortened to roughly a cell, at the cost of exactness
    const l = Math.hypot(dx, dy);
    if (l > 8) { dx /= l; dy /= l; }
    dirs.push([dx, dy], [-dy, dx]);
  }
  return dirs;
}

// Directions a rotated road grid can take. They are whole-cell steps (1 across and 2 up...),
// so every junction of the grid lands exactly on a cell and its roads stay parallel:
// 0°, 14°, 18°, 27°, 34°, 45°, and the same mirrored and turned.
const BASE_STEPS = [[1, 0], [4, 1], [3, 1], [2, 1], [3, 2], [1, 1]];
export const GRID_STEPS = (() => {
  const out = [], seen = new Set();
  for (const [p, q] of BASE_STEPS) for (const [a, b] of [[p, q], [q, p]]) for (const sx of [1, -1]) for (const sy of [1, -1]) {
    const k = `${a * sx},${b * sy}`;
    if (!seen.has(k)) { seen.add(k); out.push([a * sx, b * sy]); }
  }
  return out;
})();
const AXIS_STEPS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

// A road grid from corner A: its first side runs toward `toward` (along the map's grid when
// onGrid, else at the nearest of GRID_STEPS) and it reaches out toward `reach` on one side,
// with a road about every `block` cells. Returns the roads as [[a, b], ...] cell pairs.
export function gridLayout(A, toward, reach, block, onGrid) {
  const vx = toward[0] - A[0], vy = toward[1] - A[1];
  if (!vx && !vy) return null;
  let u = null, best = -Infinity;
  for (const st of onGrid ? AXIS_STEPS : GRID_STEPS) {
    const c = (vx * st[0] + vy * st[1]) / Math.hypot(st[0], st[1]);
    if (c > best) { best = c; u = st; }
  }
  const ul = Math.hypot(u[0], u[1]);
  const ku = Math.max(1, Math.round(best / ul));
  let w = [-u[1], u[0]], kd = 0;
  if (reach) {
    let d = ((reach[0] - A[0]) * w[0] + (reach[1] - A[1]) * w[1]) / ul;
    if (d < 0) { w = [-w[0], -w[1]]; d = -d; }
    kd = Math.max(1, Math.round(d / ul));
  }
  const n = Math.max(1, Math.round(block / ul)); // steps between roads
  const at = (i, j) => [A[0] + u[0] * i + w[0] * j, A[1] + u[1] * i + w[1] * j];
  // where the roads go along one side: every n steps, and at the far edge (a last block much
  // shorter than the rest is merged into the one before)
  const marks = (k) => {
    const m = [];
    for (let i = 0; i < k; i += n) m.push(i);
    if (m.length > 1 && k - m[m.length - 1] < n / 2) m.pop();
    m.push(k);
    return m;
  };
  const lines = [];
  if (!kd) lines.push([at(0, 0), at(ku, 0)]);
  else {
    for (const j of marks(kd)) lines.push([at(0, j), at(ku, j)]);
    for (const i of marks(ku)) lines.push([at(i, 0), at(i, kd)]);
  }
  // how far it's turned from the map's grid (0–45°)
  const a = (Math.atan2(Math.abs(u[1]), Math.abs(u[0])) * 180) / Math.PI;
  const angle = Math.round(Math.min(a, 90 - a));
  return { lines, angle, cols: marks(ku).length - 1, rows: kd ? marks(kd).length - 1 : 0, len: ku * ul, depth: kd * ul };
}

// The direction of travel from each cell to the next (for one-way roads)
export function stepDirs(cells) {
  const dirs = [];
  for (let k = 0; k < cells.length; k++) {
    const [x0, y0] = cells[Math.min(k, cells.length - 2)] || cells[k];
    const [x1, y1] = cells[Math.min(k + 1, cells.length - 1)];
    const dx = x1 - x0, dy = y1 - y0;
    dirs.push(dx > 0 ? 0 : dx < 0 ? 2 : dy > 0 ? 1 : 3);
  }
  return dirs;
}

// ---------------------------------------------------------------- lookups
// Derived from state.roadSegs whenever the road network changes:
//   byCell:   cell -> segments drawn through it
//   internal: links (cell * 4 + dir) the diagonal draws, so the grid arms between those
//             cells are left out
//   ends:     cells where a segment starts or ends
//   cellsOf:  segment -> its whole staircase of cells, in order (orderOf: cell -> place in it)
// A cell bulldozed out of the middle of a segment is kept in its `cut` list ([x, y] pairs):
// it's no longer part of that road, so a road built there later doesn't join it, and the
// two pieces left either side end there (drawn with a rounded end).
let cache = null, cacheState = null, dirty = true;
bus.on('network:changed', () => { dirty = true; });

export function segIndex(state) {
  if (!dirty && cache && cacheState === state) return cache;
  const byCell = new Map(), internal = new Set(), ends = new Set(), cellsOf = new Map(), orderOf = new Map();
  const keep = [];
  for (const s of state.roadSegs || []) {
    const cells = lineCells(s.a[0], s.a[1], s.b[0], s.b[1]);
    const cut = s.cut?.length ? new Set(s.cut.map(([x, y]) => idx(x, y))) : null;
    const part = (x, y) => inBounds(x, y) && !(cut && cut.has(idx(x, y)));
    // a segment whose road has been bulldozed away entirely is forgotten
    if (!cells.some(([x, y]) => part(x, y) && state.road[idx(x, y)])) continue;
    keep.push(s);
    cellsOf.set(s, cells);
    const order = new Map();
    orderOf.set(s, order);
    for (let k = 0; k < cells.length; k++) {
      const [x, y] = cells[k];
      if (!part(x, y)) continue;
      const i = idx(x, y);
      order.set(i, k);
      if (!byCell.has(i)) byCell.set(i, []);
      byCell.get(i).push(s);
      if (k + 1 < cells.length && part(...cells[k + 1])) {
        const [x2, y2] = cells[k + 1];
        const d = x2 > x ? 0 : x2 < x ? 2 : y2 > y ? 1 : 3;
        internal.add(i * 4 + d);
        internal.add(idx(x2, y2) * 4 + ((d + 2) % 4));
      }
    }
    ends.add(idx(s.a[0], s.a[1]));
    ends.add(idx(s.b[0], s.b[1]));
  }
  if (state.roadSegs && keep.length !== state.roadSegs.length) state.roadSegs = keep;
  cache = { byCell, internal, ends, cellsOf, orderOf };
  cacheState = state;
  dirty = false;
  return cache;
}

// Is the next cell along segment s from cell i (step -1 or +1 along its staircase) still a
// piece of that road? (false where the road was bulldozed, or past the segment's end)
export function segContinues(state, s, i, step) {
  const SG = segIndex(state);
  const k = SG.orderOf.get(s)?.get(i);
  const cells = SG.cellsOf.get(s);
  if (k == null || !cells) return false;
  const nb = cells[k + step];
  if (!nb || !inBounds(nb[0], nb[1])) return false;
  const j = idx(nb[0], nb[1]);
  return !!state.road[j] && SG.orderOf.get(s).has(j);
}

// The part of a segment inside cell (x, y), as parameters [t0, t1] along it (or null)
export function clipToCell(s, x, y) {
  const ax = s.a[0] + 0.5, ay = s.a[1] + 0.5, dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
  let t0 = 0, t1 = 1;
  const edge = (p, q) => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  if (!edge(-dx, ax - x) || !edge(dx, x + 1 - ax) || !edge(-dy, ay - y) || !edge(dy, y + 1 - ay)) return null;
  return t1 - t0 > 1e-6 ? [t0, t1] : null;
}

export const segPoint = (s, t) => [s.a[0] + 0.5 + (s.b[0] - s.a[0]) * t, s.a[1] + 0.5 + (s.b[1] - s.a[1]) * t];

// Where two segments cross, as their parameters [t1, t2] (null if they don't)
export function segCross(s1, s2) {
  const d1x = s1.b[0] - s1.a[0], d1y = s1.b[1] - s1.a[1], d2x = s2.b[0] - s2.a[0], d2y = s2.b[1] - s2.a[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const ox = s2.a[0] - s1.a[0], oy = s2.a[1] - s1.a[1];
  const t1 = (ox * d2y - oy * d2x) / den, t2 = (ox * d1y - oy * d1x) / den;
  return t1 >= 0 && t1 <= 1 && t2 >= 0 && t2 <= 1 ? [t1, t2] : null;
}

// Where the roads at an angle through cell (x, y) cross inside it: { point, at: Map(segment -> t) }
export function crossingIn(segs, x, y) {
  for (let a = 0; a < segs.length; a++) {
    for (let b = a + 1; b < segs.length; b++) {
      const t = segCross(segs[a], segs[b]);
      if (!t) continue;
      const p = segPoint(segs[a], t[0]);
      if (p[0] < x - 0.02 || p[0] > x + 1.02 || p[1] < y - 0.02 || p[1] > y + 1.02) continue;
      return { point: p, at: new Map([[segs[a], t[0]], [segs[b], t[1]]]) };
    }
  }
  return null;
}

// Where a cell centre lands when projected onto the segment (as a parameter, clamped)
export function segParam(s, px, py) {
  const ax = s.a[0] + 0.5, ay = s.a[1] + 0.5, dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
  const l2 = dx * dx + dy * dy || 1;
  return Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
}

// The segment two neighbouring cells are both on, with the line passing between them
function sharedSeg(SG, i, j) {
  if (j == null || j < 0) return null;
  const d = j === i + 1 ? 0 : j === i - 1 ? 2 : j === i + N ? 1 : j === i - N ? 3 : -1;
  if (d < 0 || !SG.internal.has(i * 4 + d)) return null;
  const a = SG.byCell.get(i), b = SG.byCell.get(j);
  return a && b ? a.find((s) => b.includes(s)) || null : null;
}

// Points ([x, z], world units) to move through along a path of road cells: cell centres,
// except where the path runs along a diagonal road, where they're pulled onto its line
export function roadPathPoints(state, path) {
  const SG = segIndex(state);
  const pts = new Array(path.length);
  for (let k = 0; k < path.length; k++) {
    const i = path[k];
    const x = (i % N) + 0.5, z = ((i / N) | 0) + 0.5;
    const s = SG.byCell.has(i) ? sharedSeg(SG, i, path[k - 1]) || sharedSeg(SG, i, path[k + 1]) : null;
    pts[k] = s ? segPoint(s, segParam(s, x, z)) : [x, z];
  }
  return pts;
}

// Two spots beside the road in a cell (for lamps, street trees and stop signs): the cell
// corners on a grid road, or either side of the line on a diagonal one
export function roadsideSpots(state, i, inset = 0.42) {
  const SG = segIndex(state);
  const x = i % N, y = (i / N) | 0;
  const s = SG.byCell.get(i)?.[0];
  if (s && !SG.ends.has(i)) {
    const c = clipToCell(s, x, y);
    if (c) {
      const [mx, mz] = segPoint(s, (c[0] + c[1]) / 2);
      const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], l = Math.hypot(dx, dy) || 1;
      const nx = -dy / l, nz = dx / l;
      return [[mx + nx * inset, mz + nz * inset], [mx - nx * inset, mz - nz * inset]];
    }
  }
  return [[x + 0.08, y + 0.08], [x + 0.92, y + 0.92]];
}

// Is this road cell part of a diagonal (not at one of its ends)?
export const onDiagonal = (state, i) => {
  const SG = segIndex(state);
  return SG.byCell.has(i) && !SG.ends.has(i);
};

// Neighbour index helper for renderers
export const neighbour = (i, d) => {
  const x = (i % N) + DIRS[d][0], y = ((i / N) | 0) + DIRS[d][1];
  return inBounds(x, y) ? idx(x, y) : -1;
};
