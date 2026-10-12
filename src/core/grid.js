// The world is a square grid of cells. One cell = 8 m (the size of a zoning cell),
// and one cell = 1 world unit in three.js.
export const N = 1040;             // cells per side (65 × 65 map tiles, about 8.3 km)
export const TILE = 16;            // cells per map tile (side)
export const TILES = N / TILE;     // map tiles per side (65)
export const CELL_M = 8;           // metres per cell, for display only
export const HN = N + 1;           // heightmap is sampled at cell corners

export const idx = (x, y) => y * N + x;
export const hidx = (x, y) => y * HN + x;
export const inBounds = (x, y) => x >= 0 && y >= 0 && x < N && y < N;
export const cellX = (i) => i % N;
export const cellY = (i) => (i / N) | 0;
export const tileOf = (x, y) => ((y / TILE) | 0) * TILES + ((x / TILE) | 0);

// 4-neighbourhood: east, south, west, north. A direction index d is used everywhere
// (building facing, road connections bitmask: 1=E 2=S 4=W 8=N).
export const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

export function forNeighbors(x, y, fn) {
  for (let d = 0; d < 4; d++) {
    const nx = x + DIRS[d][0];
    const ny = y + DIRS[d][1];
    if (inBounds(nx, ny)) fn(nx, ny, d);
  }
}

// Cells inside a circle, calling fn(x, y, distance)
export function forRadius(cx, cy, r, fn) {
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(N - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(N - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2) fn(x, y, Math.sqrt(d2));
    }
  }
}

// Straight-ish line of cells between two points, axis-aligned in an L shape
// (first along the longer axis, then the shorter). Used by road/rail/pipe tools.
export function lCells(x0, y0, x1, y1, horizontalFirst) {
  const cells = [];
  const sx = Math.sign(x1 - x0), sy = Math.sign(y1 - y0);
  let x = x0, y = y0;
  cells.push([x, y]);
  const stepX = () => { while (x !== x1) { x += sx; cells.push([x, y]); } };
  const stepY = () => { while (y !== y1) { y += sy; cells.push([x, y]); } };
  if (horizontalFirst) { stepX(); stepY(); } else { stepY(); stepX(); }
  return cells;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

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
