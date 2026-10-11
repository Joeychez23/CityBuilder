// Where things are built, as boxes [x0, y0, x1, y1] of cells (inclusive; null: nothing), so
// passes over the whole map can skip the empty land around the city (on a big map, most of
// it). The box of a grid layer (rail, pipes, power lines...) is found once and kept until
// that network changes; roads and buildings are looked up from their own lists.
import { N, TILE, TILES } from '../core/grid.js';
import { bus } from '../core/events.js';

const kept = new Map(); // layer name -> { state, box }
bus.on('network:changed', (e) => { if (e?.layer) kept.delete(e.layer); else kept.clear(); });
// (for code that changes the layers without saying so: making a map)
export const forgetBoxes = () => kept.clear();

export function union(a, b) {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
// A box grown by `pad` cells, within the map
export const grow = (b, pad) => (b ? [Math.max(0, b[0] - pad), Math.max(0, b[1] - pad), Math.min(N - 1, b[2] + pad), Math.min(N - 1, b[3] + pad)] : null);

// The box around a grid layer's cells (state[name], e.g. 'rail' or 'pipe')
export function layerBox(state, name) {
  let k = kept.get(name);
  if (!k || k.state !== state) {
    const layer = state[name];
    let x0 = N, y0 = N, x1 = -1, y1 = -1;
    for (let y = 0; y < N; y++) {
      const row = y * N;
      for (let x = 0; x < N; x++) {
        if (!layer[row + x]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
    k = { state, box: x1 >= 0 ? [x0, y0, x1, y1] : null };
    kept.set(name, k);
  }
  return k.box;
}

// The box around the road network (a curve never strays outside its ends and handles; the
// roads' cells reach a cell or two beyond the middle line)
export function roadBox(state) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, z) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < y0) y0 = z; if (z > y1) y1 = z; };
  for (const n of state.roads.nodes) add(n.x, n.z);
  for (const s of state.roads.segs) { add(s.k[0], s.k[1]); add(s.k[2], s.k[3]); }
  return x1 >= x0 ? grow([Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1)], 3) : null;
}

// The box around the buildings
export function buildingBox(state) {
  let x0 = N, y0 = N, x1 = -1, y1 = -1;
  for (const b of state.buildings.values()) {
    if (b.x0 < x0) x0 = b.x0;
    if (b.y0 < y0) y0 = b.y0;
    if (b.x1 > x1) x1 = b.x1;
    if (b.y1 > y1) y1 = b.y1;
  }
  return x1 >= 0 ? [x0, y0, x1, y1] : null;
}

// The part of the map you're playing on, for weather and disasters that strike anywhere
// (lightning, wildfires, tornadoes): your land, grown to at least AREA cells across around
// its middle (as much as the whole map once was), within the map
const AREA = 17 * TILE;
export function playArea(state) {
  let x0 = TILES, y0 = TILES, x1 = -1, y1 = -1;
  for (let t = 0; t < state.tiles.length; t++) {
    if (!state.tiles[t]) continue;
    const tx = t % TILES, ty = (t / TILES) | 0;
    if (tx < x0) x0 = tx;
    if (tx > x1) x1 = tx;
    if (ty < y0) y0 = ty;
    if (ty > y1) y1 = ty;
  }
  if (x1 < 0) return [0, 0, N - 1, N - 1];
  const span = (a, b) => {
    let lo = a * TILE, hi = (b + 1) * TILE - 1;
    const short = AREA - (hi - lo + 1);
    if (short > 0) { lo -= Math.floor(short / 2); hi += Math.ceil(short / 2); }
    if (lo < 0) { hi -= lo; lo = 0; }
    if (hi > N - 1) { lo -= hi - (N - 1); hi = N - 1; }
    return [Math.max(0, lo), hi];
  };
  const [ax, bx] = span(x0, x1), [ay, by] = span(y0, y1);
  return [ax, ay, bx, by];
}
// A random cell of a box (rand: 0..1)
export const cellIn = ([x0, y0, x1, y1], rand) => (y0 + Math.floor(rand() * (y1 - y0 + 1))) * N + x0 + Math.floor(rand() * (x1 - x0 + 1));
