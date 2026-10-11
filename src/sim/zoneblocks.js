// Zone strips. Zoning runs in strips along each road (like Cities: Skylines): every road you
// can zone beside has a strip of zone cells on each side, ZONE_DEPTH cells deep, set square
// to the road wherever it goes, curves included. A strip's columns are a cell apart along the
// kerb. A zone cell is left out where it would overlap a road, water, a railway, a pylon, a
// footpath or a building you placed, or where the land isn't yours or is too steep. Where the
// strips of two roads facing each other meet (between parallel roads, on the inside of a bend)
// the cell nearer its road keeps its place (the older road's, when they're as near). The
// strips of roads that cross each other overlap in the corners between them: there it's the
// first building to grow that takes the land (its cells are then taken for both).
//
// What each zone cell is painted is kept with its road (seg.zs: one string per side, a
// character per cell), so it's saved with the roads and undone with them. When a road changes
// shape (split by a new junction, redrawn) its cells take the paint of whatever cell was where
// they are before. The grid of zones the rest of the game reads (state.zone) is worked out
// from the strips: each grid cell takes the zone of the strip cell over it.
import { N, idx, TILE, TILES } from '../core/grid.js';
import { ROADS } from '../data/roads.js';
import { ZONE_DEPTH } from '../data/zones.js';
import { bus } from '../core/events.js';
import { rn } from './roadnet.js';
import { bez, bezTan, tAtS } from './roadgeom.js';
import { roadWidth } from './lanes.js';
import { cellSlope } from './mapgen.js';
import { maxSlopeAt } from './projects.js';
import { roadBox } from './extent.js';

export const DEPTH = ZONE_DEPTH;
const ZC = '0123456789abcdefghijklmnopqrstuvwxyz';
const charOf = (z) => ZC[z] || '0';
const zoneOfChar = (c) => Math.max(0, ZC.indexOf(c));
const FINE = 4;          // the road mask: points per cell each way
const SPACING = 0.8;     // zone cells closer than this overlap
// points across a cell tested for a road: along it, and out from its road
const ALONG = [-0.4, 0, 0.4], OUT = [-0.15, 0.2, 0.45];

let L = null, dirty = true;
// (pipes and the subway are underground: they don't get in the way)
bus.on('network:changed', ({ layer } = {}) => { if (layer !== 'pipe' && layer !== 'subway') dirty = true; });
bus.on('terrain:changed', () => { dirty = true; });
bus.on('tiles:changed', () => { dirty = true; });
bus.on('building:add', (b) => { if (b.kind !== 'zone') dirty = true; });
bus.on('building:remove', (b) => { if (b.kind !== 'zone') dirty = true; });
export const zonesDirty = () => { dirty = true; };

const owned = (state, x, y) => x >= 0 && y >= 0 && x < N && y < N && state.tiles[((y / TILE) | 0) * TILES + ((x / TILE) | 0)] === 1;
const zonableSeg = (s) => ROADS[s.type].zonable && !s.br && !s.tn;

// The strips as they are now (worked out again if anything changed). stale: the strips as
// they were last worked out will do (to clear the zoning under something being built, before
// the change is finished)
export function zoneLayout(state, { stale = false } = {}) {
  if (stale && L && L.state === state) return L;
  if (!L || L.state !== state || dirty || L.X !== rn(state)) rebuild(state);
  return L;
}

// Where every road's surface is, on a fine grid over the part of the map with roads (for
// leaving out zone cells that overlap one): onRoad(x, z)
function roadMask(state, X) {
  const box = roadBox(state);
  if (!box) return () => false;
  const ox = box[0] * FINE, oz = box[1] * FINE;
  const W = (box[2] - box[0] + 1) * FINE, H = (box[3] - box[1] + 1) * FINE;
  const mask = new Uint8Array(W * H);
  const p = [0, 0];
  for (const s of X.seg.values()) {
    const g = X.geo.get(s.id);
    if (!g || s.tn) continue;
    const r = roadWidth(ROADS[s.type]) / 2;
    const R = Math.ceil(r * FINE);
    const n = Math.max(2, Math.ceil(g.len / 0.15));
    for (let k = 0; k <= n; k++) {
      bez(g.c, tAtS(g.tab, (g.len * k) / n), p);
      const fx = p[0] * FINE, fz = p[1] * FINE;
      const ix = Math.floor(fx), iz = Math.floor(fz);
      for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        const x = ix + dx, z = iz + dz;
        if (x < ox || z < oz || x >= ox + W || z >= oz + H) continue;
        if ((x + 0.5 - fx) ** 2 + (z + 0.5 - fz) ** 2 <= (r * FINE) ** 2) mask[(z - oz) * W + x - ox] = 1;
      }
    }
    // (a road's end is round)
  }
  return (x, z) => {
    const fx = Math.floor(x * FINE) - ox, fz = Math.floor(z * FINE) - oz;
    return fx >= 0 && fz >= 0 && fx < W && fz < H && mask[fz * W + fx] === 1;
  };
}

// The columns of one side of a road: where each starts at the kerb, and which way is along
// the road (t) and out from it (n)
function columns(X, s, side) {
  const g = X.geo.get(s.id);
  const e = roadWidth(ROADS[s.type]) / 2;
  const sg = side ? -1 : 1;
  // the length of the line through the first row's middles
  const n = Math.max(2, Math.ceil(g.len / 0.25));
  const ss = new Float32Array(n + 1), ls = new Float32Array(n + 1);
  const p = [0, 0], d = [0, 0];
  let px = 0, pz = 0;
  for (let k = 0; k <= n; k++) {
    const s0 = (g.len * k) / n, t = tAtS(g.tab, s0);
    bez(g.c, t, p); bezTan(g.c, t, d);
    const x = p[0] - d[1] * sg * (e + 0.5), z = p[1] + d[0] * sg * (e + 0.5);
    ss[k] = s0;
    ls[k] = k ? ls[k - 1] + Math.hypot(x - px, z - pz) : 0;
    px = x; pz = z;
  }
  const L0 = ls[n], cols = Math.max(0, Math.floor(L0 + 1e-6));
  const out = { seg: s.id, side, cols, e, x: new Float32Array(cols), z: new Float32Array(cols), tx: new Float32Array(cols), tz: new Float32Array(cols) };
  let k = 0;
  for (let c = 0; c < cols; c++) {
    const want = c + 0.5 + (L0 - cols) / 2;
    while (k < n && ls[k + 1] < want) k++;
    const f = (want - ls[k]) / Math.max(1e-6, ls[k + 1] - ls[k]);
    const t = tAtS(g.tab, ss[k] + (ss[k + 1] - ss[k]) * f);
    bez(g.c, t, p); bezTan(g.c, t, d);
    out.x[c] = p[0]; out.z[c] = p[1]; out.tx[c] = d[0]; out.tz[c] = d[1];
  }
  return out;
}

// The middle of the zone cell in column c, row r of a strip; its "out" direction (away from
// the road) and "along" direction
function cellFrame(F, c, r, out) {
  const sg = F.side ? -1 : 1;
  const nx = -F.tz[c] * sg, nz = F.tx[c] * sg;
  const o = F.e + 0.5 + r;
  out.x = F.x[c] + nx * o; out.z = F.z[c] + nz * o;
  out.nx = nx; out.nz = nz; out.tx = F.tx[c] * sg; out.tz = F.tz[c] * sg;
  return out;
}

function rebuild(state) {
  const X = rn(state);
  const prev = L && L.state === state ? L : null;
  // the paint as it was, by where it was (for roads that changed shape)
  const old = new Map();
  if (prev) {
    for (const c of prev.cells) {
      const s = X.seg.get(c.seg);
      const str = s?.zs?.[c.side];
      const z = str ? zoneOfChar(str[c.col * DEPTH + c.row]) : 0;
      if (!z) continue;
      const key = Math.floor(c.x) + Math.floor(c.z) * N;
      if (!old.has(key)) old.set(key, []);
      old.get(key).push(c.x, c.z, z);
    }
  }
  const paintAt = (x, z) => {
    if (!prev) {
      // (a city from before the strips: its zones were painted cell by cell)
      const gx = Math.floor(x), gz = Math.floor(z);
      return gx >= 0 && gz >= 0 && gx < N && gz < N ? state.zone[gz * N + gx] : 0;
    }
    let best = 0, bd = 0.6 * 0.6;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const list = old.get(Math.floor(x) + dx + (Math.floor(z) + dz) * N);
      if (!list) continue;
      for (let k = 0; k < list.length; k += 3) { const d = (list[k] - x) ** 2 + (list[k + 1] - z) ** 2; if (d < bd) { bd = d; best = list[k + 2]; } }
    }
    return best;
  };

  const onRoad = roadMask(state, X);
  const segs = [...X.seg.values()].filter((s) => X.geo.has(s.id) && zonableSeg(s)).sort((a, b) => a.id - b.id);
  const frames = [], reshaped = new Set();
  const f = { x: 0, z: 0, nx: 0, nz: 0, tx: 0, tz: 0 };
  for (const s of segs) {
    for (const side of [0, 1]) {
      const F = columns(X, s, side);
      frames.push(F);
      // a road that's new or changed shape: its cells take the paint of what was there
      // (its own lists: never shared with another road)
      if (side === 0) { s.zs = [s.zs?.[0] ?? '', s.zs?.[1] ?? '']; s.zc = [s.zc?.[0] ?? -1, s.zc?.[1] ?? -1]; }
      if (s.zc[side] !== F.cols || s.zs[side].length !== F.cols * DEPTH) {
        reshaped.add(`${s.id}:${side}`);
        let str = '';
        for (let c = 0; c < F.cols; c++) for (let r = 0; r < DEPTH; r++) { cellFrame(F, c, r, f); str += charOf(paintAt(f.x, f.z)); }
        s.zs[side] = str;
        s.zc[side] = F.cols;
      }
    }
  }
  // what's in the way, cell by cell of the grid (0 nothing, 1 in the way, 2 too steep; worked
  // out the first time it's asked, as only the cells beside roads ever are)
  const block = new Uint8Array(N * N).fill(255);
  const blockAt = (gx, gz) => {
    const i = gz * N + gx;
    if (block[i] !== 255) return block[i];
    let v = 0;
    if (!owned(state, gx, gz) || state.water[i] || state.power[i] || state.path[i] || (state.rail[i] && !state.railH[i])) v = 1;
    else if (state.bld[i]) { const b = state.buildings.get(state.bld[i]); if (b && b.kind !== 'zone') v = 1; }
    if (!v && cellSlope(state, gx, gz) > maxSlopeAt(state, gx, gz)) v = 2;
    return (block[i] = v);
  };
  const blocked = (gx, gz) => gx < 0 || gz < 0 || gx >= N || gz >= N || blockAt(gx, gz) === 1;
  // row by row (the first rows of every road first), each road in the order it was built
  // (the cells by the grid cell under their middle: head[grid cell] -> the last one, next[k] ->
  // the one before it)
  const cells = [], head = new Int32Array(N * N).fill(-1), next = [], strips = new Map();
  for (const F of frames) strips.set(`${F.seg}:${F.side}`, { ...F, idx: new Int32Array(F.cols * DEPTH).fill(-1) });
  // (a cell of a strip facing the same way or the opposite way, too close)
  const near = (x, z, nx, nz) => {
    const gx = Math.floor(x), gz = Math.floor(z);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const x2 = gx + dx, z2 = gz + dz;
      if (x2 < 0 || z2 < 0 || x2 >= N || z2 >= N) continue;
      for (let k = head[z2 * N + x2]; k >= 0; k = next[k]) {
        const o = cells[k];
        if ((o.x - x) ** 2 + (o.z - z) ** 2 < SPACING * SPACING && Math.abs(o.nx * nx + o.nz * nz) > 0.5) return true;
      }
    }
    return false;
  };
  for (let r = 0; r < DEPTH; r++) {
    for (const F of frames) {
      const S = strips.get(`${F.seg}:${F.side}`);
      for (let c = 0; c < F.cols; c++) {
        cellFrame(F, c, r, f);
        if (f.x < 0.5 || f.z < 0.5 || f.x > N - 0.5 || f.z > N - 0.5) continue;
        // (the cell behind it in its own strip has to be there: a strip doesn't jump a gap)
        if (r > 0 && S.idx[c * DEPTH + r - 1] < 0) continue;
        const gx = Math.floor(f.x), gz = Math.floor(f.z);
        if (blockAt(gx, gz) || near(f.x, f.z, f.nx, f.nz)) continue;
        // (on a road: tested at points across the cell, those on the side toward its own road
        // a little in from the edge, as the road mask is only so fine)
        let bad = false;
        for (let m = 0; m < 9 && !bad; m++) {
          const a = ALONG[m % 3], b = OUT[(m / 3) | 0];
          if (onRoad(f.x + f.tx * a + f.nx * b, f.z + f.tz * a + f.nz * b)) bad = true;
        }
        for (let m = 0; m < 4 && !bad; m++) {
          const a = m & 1 ? 0.42 : -0.42, b = m & 2 ? 0.42 : -0.42;
          if (blocked(Math.floor(f.x + f.tx * a + f.nx * b), Math.floor(f.z + f.tz * a + f.nz * b))) bad = true;
        }
        if (bad) continue;
        const k = cells.length;
        cells.push({ k, seg: F.seg, side: F.side, col: c, row: r, x: f.x, z: f.z, nx: f.nx, nz: f.nz, tx: f.tx, tz: f.tz, g: gz * N + gx, gs: null });
        S.idx[c * DEPTH + r] = k;
        next.push(head[gz * N + gx]);
        head[gz * N + gx] = k;
      }
    }
  }
  // the grid cells each zone cell stands over (the one under its middle, and any whose middle
  // is inside it); which zone cell speaks for each grid cell (the first: nearest its road)
  const owner = new Int32Array(N * N).fill(-1);
  for (const c of cells) {
    const gs = [c.g];
    if (owner[c.g] < 0) owner[c.g] = c.k;
    const gx = c.g % N, gz = (c.g / N) | 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const x = gx + dx, z = gz + dz;
      if (x < 0 || z < 0 || x >= N || z >= N) continue;
      const vx = x + 0.5 - c.x, vz = z + 0.5 - c.z;
      if (Math.abs(vx * c.tx + vz * c.tz) > 0.5 || Math.abs(vx * c.nx + vz * c.nz) > 0.5) continue;
      const i = z * N + x;
      gs.push(i);
      if (owner[i] < 0) owner[i] = c.k;
    }
    c.gs = gs;
  }
  // lots laid out on a strip that changed shape (or on the grid, before the strips) are undone
  // (their cells keep their zone)
  if (state.plots?.length) state.plots = state.plots.filter((p) => p.seg != null && X.seg.has(p.seg) && !reshaped.has(`${p.seg}:${p.side}`));
  L = { state, X, cells, strips, head, next, owner, ver: (L?.ver || 0) + 1 };
  dirty = false;
  syncGrid(state);
  bus.emit('zones:layout');
}

// The zone painted on a zone cell
export function zoneOf(state, c) {
  const s = rn(state).seg.get(c.seg);
  const str = s?.zs?.[c.side];
  return str ? zoneOfChar(str[c.col * DEPTH + c.row] || '0') : 0;
}

// The grid of zones (state.zone) and how far each grid cell is from its road (ctx.zonable:
// 1.. for zone cells, 0 on roads, 255 elsewhere), from the strips
function syncGrid(state) {
  state.zone.fill(0);
  for (const c of L.cells) {
    const z = zoneOf(state, c);
    if (z) for (const i of c.gs) state.zone[i] = z;
  }
}
export function zonableGrid(state) {
  const Z = zoneLayout(state);
  const out = new Uint8Array(N * N).fill(255);
  for (let i = 0; i < N * N; i++) if (state.road[i]) out[i] = 0;
  for (const c of Z.cells) for (const i of c.gs) if (out[i] === 255) out[i] = c.row + 1;
  return out;
}

// The zone cells whose middles are in grid cell (x, z)
function* inCell(Z, x, z) {
  if (x < 0 || z < 0 || x >= N || z >= N) return;
  for (let k = Z.head[z * N + x]; k >= 0; k = Z.next[k]) yield k;
}

// The zone cell at column c, row r of a strip (or null)
export function cellOf(Z, seg, side, c, r) {
  const S = Z.strips.get(`${seg}:${side}`);
  if (!S || c < 0 || c >= S.cols || r < 0 || r >= DEPTH) return null;
  const k = S.idx[c * DEPTH + r];
  return k >= 0 ? Z.cells[k] : null;
}
// Zone cells whose middle is within r of a point
export function cellsNear(Z, x, z, r) {
  const out = [];
  const R = Math.ceil(r) + 1;
  for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
    for (const k of inCell(Z, Math.floor(x) + dx, Math.floor(z) + dz)) { const c = Z.cells[k]; if ((c.x - x) ** 2 + (c.z - z) ** 2 <= r * r) out.push(c); }
  }
  return out;
}
// The zone cell a point is on (or null)
export function cellAt(Z, x, z) {
  for (const c of cellsNear(Z, x, z, 0.75)) {
    const vx = x - c.x, vz = z - c.z;
    if (Math.abs(vx * c.tx + vz * c.tz) <= 0.5 && Math.abs(vx * c.nx + vz * c.nz) <= 0.5) return c;
  }
  return null;
}
// Zone cells whose middle is in a rectangle of the map
export function cellsInRect(Z, x0, z0, x1, z1) {
  const out = [];
  for (let gz = Math.floor(Math.min(z0, z1)) - 1; gz <= Math.floor(Math.max(z0, z1)) + 1; gz++) {
    for (let gx = Math.floor(Math.min(x0, x1)) - 1; gx <= Math.floor(Math.max(x0, x1)) + 1; gx++) {
      for (const k of inCell(Z, gx, gz)) {
        const c = Z.cells[k];
        if (c.x >= Math.min(x0, x1) && c.x <= Math.max(x0, x1) && c.z >= Math.min(z0, z1) && c.z <= Math.max(z0, z1)) out.push(c);
      }
    }
  }
  return out;
}
// Zone cells standing over these grid cells
export function cellsOnGrid(Z, gridCells) {
  const out = new Set();
  for (const i of gridCells) {
    const k = Z.owner[i];
    if (k >= 0) out.add(Z.cells[k]);
    for (const j of inCell(Z, i % N, (i / N) | 0)) out.add(Z.cells[j]);
  }
  return [...out];
}

// Paint zone cells (0: unzone them). Returns how many changed.
export function paintCells(state, cells, zoneId) {
  const X = rn(state);
  const bySide = new Map();
  for (const c of cells) {
    const key = `${c.seg}:${c.side}`;
    if (!bySide.has(key)) bySide.set(key, []);
    bySide.get(key).push(c);
  }
  let n = 0;
  for (const list of bySide.values()) {
    const s = X.seg.get(list[0].seg);
    if (!s?.zs) continue;
    const chars = s.zs[list[0].side].split('');
    for (const c of list) {
      const at = c.col * DEPTH + c.row;
      if (chars[at] === charOf(zoneId)) continue;
      chars[at] = charOf(zoneId);
      for (const i of c.gs || []) state.zone[i] = zoneId;
      n++;
    }
    s.zs[list[0].side] = chars.join('');
  }
  return n;
}
