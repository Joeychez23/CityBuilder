// Procedural maps: heightmap by terrain style, water, natural resources, forests,
// starting tiles and outside connections (highway, rail, sea lane, air).
import { N, HN, TILE, TILES, idx, hidx, clamp, lerp, inBounds, DIRS } from '../core/grid.js';
import { makeNoise } from '../core/noise.js';
import { makeRng } from '../core/rng.js';
import { gradeCells } from './grade.js';
import { bridgeWaterRuns, bridgeConnection, bridgeLayers } from './bridges.js';
import { planRoad, buildRoad, emptyRoads, commitRoads, rn, MAX_BRIDGE } from './roadnet.js';
import { forgetBoxes } from './extent.js';
import { makeIsland } from './islands.js';
import { isLayer, fromLayer } from './layers.js';

const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

export const START_TILE_MIN = (TILES - 3) / 2; // starting area: the 3 × 3 tiles in the middle
export const START_TILE_MAX = START_TILE_MIN + 2;
export const CENTER = N / 2;
// Terrain styles were designed for a map FEATURE cells across: noise, rivers and valleys
// keep that size in cells on bigger maps (so a bigger map has more hills and lakes, not
// bigger ones), while coastlines and mountain walls follow the whole map.
export const FEATURE = 144;

// Distance from point (u,v) to a meandering river running top → bottom.
function riverDist(noise, u, v, offset, amp, freq) {
  const cx = offset + amp * Math.sin(v * Math.PI * freq + offset * 9) + 0.06 * noise.fbm(v * 3, offset * 7, 3);
  return Math.abs(u - cx);
}

// (u, v): position in feature units (0.5, 0.5 = map centre); (un, vn): 0..1 across the map
function styleHeight(map, noise, u, v, sea, un = u, vn = v) {
  const style = map.style;
  const R = map.river || {}; // where this map's river runs (fraction of the map width)
  const base = noise.fbm(u * 3.2, v * 3.2, 5);
  const detail = noise.fbm(u * 9 + 31, v * 9 + 17, 3);
  const dc = Math.hypot(u - 0.5, v - 0.5);
  let h;
  switch (style) {
    case 'archipelago': {
      // the home island in the middle, and a ring of islands across the whole map
      const dn = Math.hypot(un - 0.5, vn - 0.5);
      h = sea - 1.5 + base * 7 + detail * 0.8 + 3.2 * smooth(0.45, 0.05, dc) + 2.4 * smooth(0.62, 0.2, dn);
      break;
    }
    case 'highlands': {
      h = 6 + base * 4 + noise.ridged(u * 2.5, v * 2.5, 4) * 3 + detail * 0.6;
      const d = riverDist(noise, u, v, R.offset ?? 0.32, R.amp ?? 0.12, R.freq ?? 2.2);
      h = lerp(sea - 1.2, h, smooth(0.012, 0.06, d));
      break;
    }
    case 'lakeland': {
      h = 5.2 + base * 2 + detail * 0.5;
      const lakes = noise.fbm(u * 5 + 100, v * 5 + 100, 3);
      h = lerp(h, sea - 1.5, smooth(-0.12, -0.3, lakes) * smooth(0.12, 0.25, dc));
      break;
    }
    case 'mountain': {
      // a wide, flat valley floor with the peaks along the sides of the map
      const across = Math.abs(un - 0.5) * 2;
      h = 4.6 + base * 1.2 + Math.pow(smooth(0.42, 1, across), 1.6) * 20 * (0.6 + noise.ridged(u * 3, v * 3, 4) * 0.7);
      const d = riverDist(noise, u, v, R.offset ?? 0.5, R.amp ?? 0.06, R.freq ?? 1.5);
      h = lerp(sea - 1, h, smooth(0.008, 0.045, d));
      break;
    }
    case 'delta': {
      h = sea + 1.3 + base * 0.7 + detail * 0.3 - smooth(0.82, 1, vn) * 3.5;
      for (const [o, a, f] of [[-0.38, 0.07, 1.2], [0.25, 0.08, 1.4], [0.55, 0.1, 1.9], [0.8, 0.06, 2.6], [1.42, 0.09, 1.6]]) {
        const d = riverDist(noise, u, v, o, a, f);
        h = lerp(sea - 1, h, smooth(0.006, 0.03 + v * 0.02, d));
      }
      break;
    }
    case 'peninsula': {
      const edge = Math.min(un, 1 - un, 1 - vn + 0.6);
      h = sea - 2 + (base * 3 + 5) * smooth(0.04, 0.3, edge + base * 0.08) + detail * 0.5;
      break;
    }
    case 'mesa': {
      const n = base * 0.5 + 0.5;
      const steps = Math.floor(n * 4) / 4;
      const frac = n * 4 - Math.floor(n * 4);
      h = sea + 1.5 + (steps + smooth(0.6, 1, frac) * 0.25) * 8 + detail * 0.4;
      const d = riverDist(noise, u, v, R.offset ?? 0.62, R.amp ?? 0.15, R.freq ?? 1.2);
      h = lerp(sea - 0.7, h, smooth(0.008, 0.04, d));
      break;
    }
    case 'fjords': {
      h = 5.5 + noise.ridged(u * 3, v * 3, 5) * 9 + base * 2;
      const inlet = Math.abs(Math.sin(v * Math.PI * 3 + base * 1.5));
      const reach = smooth(0.35, 0.95, un);
      h = lerp(h, sea - 3, smooth(0.35, 0.05, inlet) * reach);
      h = lerp(h, sea - 3, smooth(0.9, 0.99, un));
      break;
    }
    default: { // plains
      h = 4.6 + base * 1.1 + detail * 0.3;
      const d = riverDist(noise, u, v, R.offset ?? 0.7, R.amp ?? 0.1, R.freq ?? 1.7);
      h = lerp(sea - 1.1, h, smooth(0.01, 0.04, d));
    }
  }
  return h;
}

// Every starting area gets water it can use: a lake or a bay with a creek or channel out to
// the map edge (see `start` in data/maps.js). Returns how wet a heightmap corner is (0..1).
function startWater(spec, noise, x, y) {
  if (!spec) return 0;
  const cx = CENTER + spec.cx, cy = CENTER + spec.cy;
  const wob = noise.fbm(x * 0.15 + 300, y * 0.15 + 300, 2) * 0.35;
  const q = ((x - cx) / spec.rx) ** 2 + ((y - cy) / spec.ry) ** 2 + wob;
  let wet = smooth(1.15, 0.8, q);
  if (spec.to) {
    // a winding channel from the water out to the map edge
    const [along, across, a0, a1] = spec.to === 'east' ? [x, y, cx, N] : spec.to === 'west' ? [x, y, 0, cx] : spec.to === 'south' ? [y, x, cy, N] : [y, x, 0, cy];
    const mid = spec.to === 'east' || spec.to === 'west' ? cy : cx;
    if (along >= a0 && along <= a1) {
      const line = mid + Math.sin(along * 0.11 + spec.cx) * 3.5 + noise.fbm(along * 0.05, 40, 2) * 4;
      wet = Math.max(wet, smooth((spec.width || 2) + 1.4, (spec.width || 2) - 0.4, Math.abs(across - line)));
    }
  }
  return wet;
}

// A patch of each of the map's main resources in the starting area, so specialized industry
// can start early (and the resource view has something to show)
function startResources(state, map, noise, rnd) {
  const spots = [[-14, -14], [14, -14], [-14, 14], [14, 14], [0, -17], [-17, 0], [17, 0], [0, 17]].sort(() => rnd.next() - 0.5);
  for (const key of map.startResources || []) {
    for (const [ox, oy] of spots) {
      const cx = CENTER + ox, cy = CENTER + oy;
      let land = 0;
      for (let y = cy - 4; y <= cy + 4; y++) for (let x = cx - 4; x <= cx + 4; x++) if (!state.water[idx(x, y)] && !state.road[idx(x, y)]) land++;
      if (land < 60) continue;
      spots.splice(spots.indexOf(spots.find((s) => s[0] === ox && s[1] === oy)), 1);
      for (let y = cy - 5; y <= cy + 5; y++) {
        for (let x = cx - 5; x <= cx + 5; x++) {
          const i = idx(x, y);
          const d = Math.hypot(x - cx, y - cy) + noise.fbm(x * 0.3, y * 0.3, 2) * 2;
          if (d > 4.6 || state.water[i] || state.road[i]) continue;
          if (key === 'forest') { state.forestMax[i] = 1; state.tree[i] = Math.max(state.tree[i], d < 3 ? 3 : 2); }
          else state[key][i] = Math.max(state[key][i], clamp(0.95 - d * 0.08, 0.4, 0.95));
        }
      }
      break;
    }
  }
}

// The height of the ground at heightmap corner (x, y) of a map, before it's smoothed and the
// highway, railway and power line are laid: the map's island (or old terrain style), its
// hills flattened toward town, the starting area made buildable, and its water
function terrainShaper(map, noise, sea) {
  // (island maps say how much of their hills' height to keep around town and further out;
  // the old maps, how much by their terrain style)
  const isle = map.island ? makeIsland(map, noise) : null;
  const relief = isle ? isle.relief : [RELIEF[map.style] ?? 0.5, Math.min(1, (RELIEF[map.style] ?? 0.5) * 1.8)];
  const [near, far] = isle ? [80, 220] : [70, 130];
  return (x, y) => {
    const u = 0.5 + (x - CENTER) / FEATURE, v = 0.5 + (y - CENTER) / FEATURE;
    let h = isle ? isle.height(x, y, sea) : styleHeight(map, noise, u, v, sea, x / (HN - 1), y / (HN - 1));
    // Most of the map is gentle, buildable land: the hills are flattened (water stays where
    // it is), and only further from town do they keep more of their height
    const edge = smooth(near, far, Math.max(Math.abs(x - CENTER), Math.abs(y - CENTER)));
    const k = lerp(relief[0], relief[1], edge);
    if (h > sea + 0.4) h = sea + 0.4 + (h - sea - 0.4) * k;
    // Make the starting area buildable: pull the land toward gentle ground above the water,
    // but keep rivers and lakes that run through it (towns need water for pumps and sewage)
    const dc = Math.hypot(x - CENTER, y - CENTER);
    const m = smooth(46, 16, dc);
    if (h < sea - 0.15) h = lerp(h, Math.min(h, sea - 0.9), m);
    else h = lerp(h, clamp(lerp(h, sea + 2, 0.75), sea + 0.9, sea + 3.2), m);
    const wet = startWater(map.start, noise, x, y);
    if (wet > 0) h = Math.min(h, lerp(h, sea - 1.3, wet)); // (out at sea it's deep enough already)
    return clamp(h, 0, 40);
  };
}

export function generateMap(state, map) {
  const noise = makeNoise(map.seed);
  const rnd = makeRng(map.seed * 7 + 3);
  const H = state.height;
  const shape = terrainShaper(map, noise, state.seaLevel);
  for (let y = 0; y < HN; y++) for (let x = 0; x < HN; x++) H[hidx(x, y)] = shape(x, y);
  softenLand(state, 3);

  // Dominant water current for pollution transport (rivers run "down" the map, coasts drift east)
  state.flow = map.flow || (map.style === 'fjords' || map.style === 'archipelago' ? [1, 0] : [0, 1]);

  carveHighway(state);
  recomputeWater(state);
  buildHighway(state);
  generateResources(state, map, noise, rnd);
  setupStartTiles(state);
  startResources(state, map, noise, rnd);
  setupConnections(state, map);
  addPowerConnection(state);
  // Grade the pre-built railway into the terrain like player-built track (the highway was
  // graded as it was built)
  const cellsOf = (layer) => { const out = []; for (let i = 0; i < N * N; i++) if (layer[i]) out.push([i % N, (i / N) | 0]); return out; };
  gradeCells(state, state.rail, cellsOf(state.rail));
  recomputeWater(state);
  bridgeConnections(state);
  // (anything left on the water that couldn't be planned still gets a deck)
  bridgeWaterRuns(state, 'rail');
  commitRoads(state, { silent: true });
  forgetBoxes();
}

// A quick look at a map for the start screen, S × S pixels (RGBA), without making all of it:
// the ground sampled under each pixel, its forests, and the highway and railway drawn in
export function previewMap(map, S, sea = 3) {
  const noise = makeNoise(map.seed);
  const shape = terrainShaper(map, noise, sea);
  const R = map.resources;
  const data = new Uint8ClampedArray(S * S * 4);
  const paint = (px, py, r, g, b) => { const o = (py * S + px) * 4; data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255; };
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const x = ((px + 0.5) / S) * N, y = ((py + 0.5) / S) * N;
      const h = shape(x, y) - sea;
      if (h < 0) { paint(px, py, 40, 110 + h * 10, 170 + h * 8); continue; }
      const t = Math.min(1, h / 18);
      const u = 0.5 + (x - CENTER) / FEATURE, v = 0.5 + (y - CENTER) / FEATURE;
      const tree = h > 0.45 && noise.fbm(u * 8 + 800, v * 8 + 800, 4) > 0.3 - R.forest * 0.4;
      paint(px, py, 100 + t * 130 - (tree ? 40 : 0), 150 + t * 80 - (tree ? 30 : 0), 80 + t * 150 - (tree ? 20 : 0));
    }
  }
  const line = (x0, y0, x1, y1, [r, g, b]) => {
    const n = Math.ceil((Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / N) * S * 2);
    for (let k = 0; k <= n; k++) paint(Math.min(S - 1, Math.floor(((x0 + ((x1 - x0) * k) / n) / N) * S)), Math.min(S - 1, Math.floor(((y0 + ((y1 - y0) * k) / n) / N) * S)), r, g, b);
  };
  line(0, CENTER, HIGHWAY_END, CENTER, [60, 60, 66]);
  if (map.connections.rail) {
    const side = map.rail?.side || 'north', at = CENTER + (map.rail?.at ?? 10);
    const [x0, y0] = side === 'east' ? [N - 1, at] : side === 'west' ? [0, at] : side === 'south' ? [at, N - 1] : [at, 0];
    const [dx, dy] = DIRS[({ east: 0, south: 1, west: 2, north: 3 }[side] + 2) % 4];
    line(x0, y0, x0 + dx * RAIL_END, y0 + dy * RAIL_END, [60, 60, 66]);
  }
  return data;
}

// How much of each style's relief is kept (1 = all of it). Maps are mostly flat to build on;
// the character comes from water, a few hills and the mountains toward the edges.
const RELIEF = { plains: 0.75, delta: 1, lakeland: 0.6, highlands: 0.38, mountain: 0.65, peninsula: 0.5, mesa: 0.5, fjords: 0.36, archipelago: 0.55 };

// Smooth out small cliffs on land (water and shores are left alone)
function softenLand(state, passes) {
  const H = state.height, sea = state.seaLevel;
  const tmp = new Float32Array(H.length);
  for (let p = 0; p < passes; p++) {
    tmp.set(H);
    for (let y = 1; y < HN - 1; y++) {
      for (let x = 1; x < HN - 1; x++) {
        const i = hidx(x, y);
        if (tmp[i] < sea + 0.3) continue;
        const nb = [tmp[i - 1], tmp[i + 1], tmp[i - HN], tmp[i + HN]];
        if (nb.some((v) => v < sea + 0.3)) continue; // keep the shoreline exactly
        H[i] = tmp[i] * 0.5 + (nb[0] + nb[1] + nb[2] + nb[3]) * 0.125;
      }
    }
  }
}

// Average height of the 4 corners of a cell
export function cellHeight(state, x, y) {
  const H = state.height;
  return (H[hidx(x, y)] + H[hidx(x + 1, y)] + H[hidx(x, y + 1)] + H[hidx(x + 1, y + 1)]) * 0.25;
}

// Ground height at any point, exactly as the terrain mesh draws it: each cell is two
// triangles split along the diagonal from its north-east to its south-west corner
export function terrainAt(state, px, pz) {
  const H = state.height;
  const x = Math.min(N - 1, Math.max(0, Math.floor(px))), y = Math.min(N - 1, Math.max(0, Math.floor(pz)));
  const fx = Math.min(1, Math.max(0, px - x)), fz = Math.min(1, Math.max(0, pz - y));
  const a = H[hidx(x, y)], b = H[hidx(x + 1, y)], c = H[hidx(x, y + 1)], d = H[hidx(x + 1, y + 1)];
  if (fx + fz <= 1) return a + (b - a) * fx + (c - a) * fz;
  return d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
}

// How uneven a cell is (max corner difference) — steep cells can't hold buildings.
export function cellSlope(state, x, y) {
  const H = state.height;
  const a = H[hidx(x, y)], b = H[hidx(x + 1, y)], c = H[hidx(x, y + 1)], d = H[hidx(x + 1, y + 1)];
  return Math.max(a, b, c, d) - Math.min(a, b, c, d);
}

export function recomputeWater(state, x0 = 0, y0 = 0, x1 = N - 1, y1 = N - 1) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      state.water[idx(x, y)] = cellHeight(state, x, y) < state.seaLevel ? 1 : 0;
    }
  }
}

// How far in from the map edge the pre-built highway and railway run
const HIGHWAY_END = START_TILE_MIN * TILE + 4, RAIL_END = START_TILE_MIN * TILE - 2;

// The cells of a pre-built outside connection (the highway or the railway), from the map edge
// inward, as far as it was laid and is still there
export function connectionLine(state, c) {
  const net = c.type === 'road' ? state.road : state.rail;
  const [sx, sy] = DIRS[(c.dir + 2) % 4];
  const len = (c.type === 'road' ? HIGHWAY_END : RAIL_END) + 1;
  const line = [];
  for (let k = 0, x = c.x, y = c.y; k < len && inBounds(x, y) && net[idx(x, y)]; k++, x += sx, y += sy) line.push([x, y]);
  return line;
}

// Bridges where the pre-built highway and railway cross water, planned like the player's own
// (see bridgeConnection). Returns how many it built.
export function bridgeConnections(state, opts) {
  let built = 0;
  for (const c of state.connections) if (c.type === 'rail') built += bridgeConnection(state, c.type, connectionLine(state, c), opts);
  return built;
}

// The outside highway runs in from the west edge, along the centre row, and stops at the
// edge of the starting area. It follows the lie of the land (a smoothed, not-too-steep
// profile of it) and the ground beside it is eased onto it over a few cells, so it never
// sits in a trench or on a wall. Water cells become bridges.
function carveHighway(state) {
  const y = CENTER;
  const H = state.height, sea = state.seaLevel;
  const end = HIGHWAY_END;
  // the land's height along the route (water is skipped: the road bridges it)
  const raw = [];
  for (let x = 0; x <= end + 1; x++) {
    const h = (H[hidx(x, y)] + H[hidx(x, y + 1)]) / 2;
    raw.push(h < sea + 0.2 ? null : Math.max(sea + 0.6, h));
  }
  // smooth along the route, then limit the grade both ways
  let last = sea + 1.5;
  const prof = raw.map((_, x) => {
    let s = 0, n = 0;
    for (let k = -10; k <= 10; k++) { const j = x + k; if (j >= 0 && j < raw.length && raw[j] != null) { s += raw[j]; n++; } }
    last = n ? s / n : last;
    return last;
  });
  const GRADE = 0.22;
  for (let x = 1; x < prof.length; x++) prof[x] = clamp(prof[x], prof[x - 1] - GRADE, prof[x - 1] + GRADE);
  for (let x = prof.length - 2; x >= 0; x--) prof[x] = clamp(prof[x], prof[x + 1] - GRADE, prof[x + 1] + GRADE);
  // the road's own corners, then the land beside it eased onto the road's height
  const ease = { 0: 1, 1: 1, '-1': 0.8, 2: 0.8, '-2': 0.5, 3: 0.5, '-3': 0.25, 4: 0.25 };
  for (let x = 0; x <= end + 1; x++) {
    for (let dy = -3; dy <= 4; dy++) {
      const i = hidx(x, y + dy);
      if (H[i] < sea - 0.2) continue; // leave water alone: the road becomes a bridge
      H[i] = lerp(H[i], prof[x], ease[dy]);
    }
  }
}

// The highway itself: a road of the network from the map edge in to the starting area, built
// like any other (it bridges the water on its way). Its end on the map edge is the outside
// connection; none of it can be bulldozed.
function buildHighway(state) {
  const y = CENTER, end = HIGHWAY_END;
  if (highwayLine(state, { x: 0.02, z: y + 0.5 }, { x: end + 0.5, z: y + 0.5 }, 6)) {
    const edge = [...rn(state).node.values()].find((n) => n.x < 0.1);
    if (edge) edge.out = 1;
  }
  if (!state.connections.some((c) => c.type === 'road')) state.connections.push({ type: 'road', x: 0, y, dir: 2, name: 'West Highway' });
}

// A pre-built highway along a straight line from a to b ({ x, z }), built like a road you draw.
// Water wider than one raised road can span (MAX_BRIDGE) is crossed in pieces, joined at
// points over the water. A piece that starts over the water stays raised to its end, so the
// highway also breaks a few cells past the shore after those (and after the sea at the map
// edge). Its segments are locked. False if it couldn't be built.
function highwayLine(state, a, b, type) {
  const spec = (p, q) => ({ a: p, b: q, type, anywhere: true, waterEnds: true });
  const points = [a];
  if (!planRoad(state, spec(a, b)).ok) {
    // (break it inside each stretch of water too wide for one span)
    const len = Math.hypot(b.x - a.x, b.z - a.z), STEP = 0.5;
    const at = (d) => ({ x: a.x + ((b.x - a.x) * d) / len, z: a.z + ((b.z - a.z) * d) / len });
    const wet = (d) => { const p = at(d); return inBounds(Math.floor(p.x), Math.floor(p.z)) && state.water[idx(Math.floor(p.x), Math.floor(p.z))]; };
    let from = -1;
    for (let d = 0; d <= len + STEP; d += STEP) {
      const w = d <= len && wet(d);
      if (w && from < 0) from = d;
      if (!w && from >= 0) {
        const run = d - from, n = Math.ceil(run / (MAX_BRIDGE - 24));
        if (n > 1 || from === 0) {
          for (let k = 1; k < n; k++) points.push(at(from + (run * k) / n));
          if (d + 8 < len) points.push(at(d + 8));
        }
        from = -1;
      }
    }
  }
  points.push(b);
  // (a piece that won't go is tried again in two halves, joined halfway)
  const piece = (p, q, depth = 0) => {
    const plan = planRoad(state, spec(p, q));
    if (!plan.ok) {
      const m = { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 };
      if (depth < 4 && Math.hypot(q.x - p.x, q.z - p.z) > 8) return piece(p, m, depth + 1) && piece(m, q, depth + 1);
      console.warn('The highway could not be built:', plan.reason, plan.bad);
      return false;
    }
    const res = buildRoad(state, plan, { free: true, silent: true });
    const X = rn(state);
    for (const id of res.segs) { const sg = X.seg.get(id); if (sg) sg.locked = 1; }
    return true;
  };
  for (let k = 1; k < points.length; k++) if (!piece(points[k - 1], points[k])) return false;
  return true;
}

// A city moved onto a bigger map (see sim/save.js) keeps its own highway: it's carried on from
// where the old map's edge was out to the new one, along the line the new map's land was
// shaped for, and its new end is the outside connection
export function extendHighway(state) {
  commitRoads(state, { silent: true });
  const end = [...rn(state).node.values()].find((n) => n.out && n.x > 0.1);
  if (!end) return;
  const on = [...rn(state).seg.values()].find((s) => s.a === end.id || s.b === end.id);
  if (!highwayLine(state, { x: 0.02, z: end.z }, { x: end.x, z: end.z }, on?.type || 6)) return;
  for (const n of rn(state).node.values()) n.out = n.x < 0.1 ? 1 : 0;
}

function generateResources(state, map, noise, rnd) {
  const R = map.resources;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      if (state.water[i]) continue;
      const u = 0.5 + (x - CENTER) / FEATURE, v = 0.5 + (y - CENTER) / FEATURE;
      const h = cellHeight(state, x, y) - state.seaLevel;
      const slope = cellSlope(state, x, y);
      const f = noise.fbm(u * 6 + 50, v * 6 + 50, 3);
      if (slope < 0.6 && h < 5 && f > 0.25 - R.fertile * 0.35) state.fertile[i] = clamp((f + 0.1) * 1.6, 0.2, 1);
      const o = noise.fbm(u * 7 + 200, v * 7 + 200, 3);
      if (o > 0.42 - R.ore * 0.2) state.ore[i] = clamp((o - 0.2) * 2.2, 0.2, 1);
      const oi = noise.fbm(u * 6 + 400, v * 6 + 400, 3);
      if (oi > 0.45 - R.oil * 0.2) state.oil[i] = clamp((oi - 0.25) * 2.2, 0.2, 1);
      const g = noise.fbm(u * 3 + 600, v * 3 + 600, 3);
      if (g > 0.15 - R.groundwater * 0.3) state.groundwater[i] = clamp((g + 0.2) * 1.4, 0.2, 1);
      // Forests: avoid the starting crossroads so the player has open land
      const t = noise.fbm(u * 8 + 800, v * 8 + 800, 4);
      const dc = Math.hypot(x - CENTER, y - CENTER);
      // forests stay a little thinner on the starting land so there's room to build
      const inStart = x >= START_TILE_MIN * TILE && x < (START_TILE_MAX + 1) * TILE && y >= START_TILE_MIN * TILE && y < (START_TILE_MAX + 1) * TILE;
      if (t > 0.3 - R.forest * 0.4 + (inStart ? 0.14 : 0) && dc > 14 && !state.road[i]) {
        state.forestMax[i] = 1;
        state.tree[i] = t > 0.4 ? 3 : t > 0.3 ? 2 : 1;
        if (rnd.chance(0.15)) state.tree[i] = Math.max(1, state.tree[i] - 1);
      }
    }
  }
}

function setupStartTiles(state) {
  for (let ty = START_TILE_MIN; ty <= START_TILE_MAX; ty++) {
    for (let tx = START_TILE_MIN; tx <= START_TILE_MAX; tx++) state.tiles[ty * TILES + tx] = 1;
  }
}

function setupConnections(state, map) {
  const c = map.connections;
  if (c.rail) {
    // A rail stub comes in from a map edge (the north, unless the map says otherwise) to the
    // edge of the starting area; the player links it to a train station.
    const side = map.rail?.side || 'north', at = CENTER + (map.rail?.at ?? 10);
    const dir = { east: 0, south: 1, west: 2, north: 3 }[side];
    const [dx, dy] = DIRS[(dir + 2) % 4]; // (inward)
    const x0 = side === 'east' ? N - 1 : side === 'west' ? 0 : at, y0 = side === 'south' ? N - 1 : side === 'north' ? 0 : at;
    const H = state.height;
    for (let k = 0; k <= RAIL_END; k++) {
      const x = x0 + dx * k, y = y0 + dy * k, i = idx(x, y);
      state.rail[i] = 1;
      state.tree[i] = 0;
      state.forestMax[i] = 0;
      // (the ground under it is lifted a little out of the wet; the sea floor is left alone)
      for (const [ox, oy] of dx ? [[0, 0], [0, 1]] : [[0, 0], [1, 0]]) {
        const j = hidx(x + ox, y + oy);
        if (H[j] > state.seaLevel - 0.2) H[j] = lerp(H[j], Math.max(H[j], state.seaLevel + 0.6), 0.6);
      }
    }
    state.connections.push({ type: 'rail', x: x0, y: y0, dir, name: `${side[0].toUpperCase()}${side.slice(1)} Railway` });
  }
  if (c.ship) {
    // The shipping lane: the middle of an edge out at sea (the east one if it can), else any
    // water on an edge
    const edges = [[N - 1, CENTER, 0], [CENTER, N - 1, 1], [CENTER, 0, 3], [0, CENTER, 2]];
    for (let i = 0; i < N; i++) edges.push([N - 1, i, 0], [i, N - 1, 1], [i, 0, 3], [0, i, 2]);
    const found = edges.find(([x, y]) => state.water[idx(x, y)]);
    if (found) state.connections.push({ type: 'ship', x: found[0], y: found[1], dir: found[2], name: 'Sea Lane' });
    else state.connectionsAvailable.ship = false;
  }
  if (c.air) state.connections.push({ type: 'air', x: N - 1, y: 0, dir: 0, name: 'Air Route' });
  recomputeWater(state);
}

// The outside power line: pylons from a map edge to the edge of the starting area. Networks
// it reaches can buy electricity from neighbouring cities (see utilities). The straightest
// route with the least water is chosen; pylons that must stand in water are offshore towers.
export function addPowerConnection(state) {
  if (state.connections.some((c) => c.type === 'power')) return;
  const lo = START_TILE_MIN * TILE, hi = (START_TILE_MAX + 1) * TILE - 1;
  const routes = [];
  for (const off of [-6, -9, 6, 9, -12, 12]) {
    const r = CENTER + off;
    routes.push({ dir: 2, cells: (k) => [lo - k, r], len: lo });       // from the west
    routes.push({ dir: 0, cells: (k) => [hi + k, r], len: N - 1 - hi }); // from the east
    routes.push({ dir: 1, cells: (k) => [r, hi + k], len: N - 1 - hi }); // from the south
  }
  const cost = (rt) => {
    let c = 0;
    for (let k = 0; k <= rt.len; k++) {
      const [x, y] = rt.cells(k);
      const i = idx(x, y);
      c += state.water[i] ? 3 : 0;
      c += state.road[i] || state.rail[i] ? 2 : 0;
    }
    return c;
  };
  routes.sort((a, b) => cost(a) - cost(b));
  const rt = routes[0];
  const chain = [];
  const STEP = 6;
  for (let k = 0; k <= rt.len; k += STEP) {
    const at = Math.min(k, rt.len);
    let [x, y] = rt.cells(at);
    // nudge off roads and rails
    for (let n = 0; n < 3 && (state.road[idx(x, y)] || state.rail[idx(x, y)]); n++) [x, y] = rt.dir === 1 ? [x + 1, y] : [x, y + 1];
    chain.push(idx(x, y));
  }
  const [ex, ey] = rt.cells(rt.len);
  if (chain[chain.length - 1] !== idx(ex, ey)) chain.push(idx(ex, ey));
  chain.reverse(); // edge first
  for (const i of chain) { state.power[i] = 1; state.tree[i] = 0; state.zone[i] = 0; }
  for (let k = 1; k < chain.length; k++) state.powerSpans.push([chain[k - 1], chain[k]]);
  const first = chain[0];
  state.connections.push({ type: 'power', x: first % N, y: (first / N) | 0, dir: rt.dir, name: 'Outside power line', end: chain[chain.length - 1] });
}

// Paste a layer from a smaller (older) map into the middle of this one. Heights (corner
// layers) fade into the surrounding terrain over the outer few cells, so there's no cliff
// where the old map ended.
export function embedLayer(target, src, srcSide, corners = false) {
  const side = corners ? HN : N;
  const O = (side - srcSide) / 2;
  if (O < 0 || O !== Math.floor(O)) return false;
  for (let y = 0; y < srcSide; y++) {
    for (let x = 0; x < srcSide; x++) {
      const v = src[y * srcSide + x];
      const i = (y + O) * side + x + O;
      if (corners) {
        const w = Math.min(1, Math.min(x, y, srcSide - 1 - x, srcSide - 1 - y) / 8);
        target[i] += (v - target[i]) * w;
      } else target[i] = v;
    }
  }
  return true;
}

// Overlay a map saved from the map editor (its layers as saved: see sim/layers.js) onto a fresh
// state. Maps made for the smaller, older map sizes are placed in the middle.
export function applyCustomMap(state, custom) {
  for (const [k, v] of Object.entries(custom.layers || {})) {
    if (!isLayer(v) || !state[k]) continue;
    const arr = fromLayer(v);
    if (arr.length === state[k].length) state[k] = arr;
    else {
      const side = Math.round(Math.sqrt(arr.length));
      embedLayer(state[k], arr, side, k === 'height');
    }
  }
  recomputeWater(state);
  // the pre-built highway: built again on this map's own land and water
  state.roads = emptyRoads();
  commitRoads(state, { silent: true });
  buildHighway(state);
  // the pre-built railway: graded and bridged again over this map's own land and water
  for (const c of state.connections) {
    if (c.type !== 'rail') continue;
    const [net, H, dir] = bridgeLayers(state, c.type);
    const line = connectionLine(state, c);
    for (const [x, y] of line) { H[idx(x, y)] = 0; dir[idx(x, y)] = 0; }
    gradeCells(state, net, line);
  }
  recomputeWater(state);
  bridgeConnections(state);
  bridgeWaterRuns(state, 'rail');
  commitRoads(state, { silent: true });
  forgetBoxes();
}
