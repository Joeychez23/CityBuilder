// Save / load: typed-array layers become base64 strings, Maps become arrays, and building
// definitions are re-linked by id on load.
import { createState, ROAD_RASTER } from '../core/state.js';
import { MAPS } from '../data/maps.js';
import { defFor } from '../data/registry.js';
import { N, TILE, TILES, DIRS, inBounds } from '../core/grid.js';
import { generateMap, embedLayer, recomputeWater, extendHighway } from './mapgen.js';

export const SAVE_KEY = 'gridlock-city-save';
export const MAPS_KEY = 'gridlock-custom-maps';

const TRANSIENT_BUILDING_KEYS = new Set(['def', 'vis', 'baseColors']);
const NOT_SAVED = new Set(ROAD_RASTER);

// A city from before roads became a network of nodes and segments (its roads are cells). It
// can't be opened in this version; it's kept, untouched, wherever it was saved.
export class LegacyCityError extends Error {
  constructor() {
    super('This city was built before the road network update, and can\'t be opened in this version. It hasn\'t been changed or deleted.');
    this.name = 'LegacyCityError';
  }
}
// Is this save text (or parsed save) from before the road network?
export const isLegacyData = (data) => !data || !data.roads || (data.version || 0) < 9;
export async function isLegacySave(text) {
  try {
    if (!text) return false;
    const json = text.startsWith('GZ:') ? await gunzip(text) : text;
    return !json.includes('"roads":{"nodes":');
  } catch { return false; }
}

function toB64(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(str, Type) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Type(bytes.buffer);
}

export function serialize(state) {
  const out = {};
  for (const [k, v] of Object.entries(state)) {
    if (NOT_SAVED.has(k)) continue;
    if (ArrayBuffer.isView(v)) out[k] = { $ta: v.constructor.name, d: toB64(v) };
    else if (v instanceof Map) {
      out[k] = {
        $map: [...v.entries()].map(([id, e]) => [id, k === 'buildings' ? Object.fromEntries(Object.entries(e).filter(([kk]) => !TRANSIENT_BUILDING_KEYS.has(kk))) : e]),
      };
    } else out[k] = v;
  }
  out.savedAt = Date.now();
  out.gridN = N;
  return JSON.stringify(out);
}

const TYPES = { Float32Array, Uint8Array, Int32Array, Uint16Array };

export function deserialize(text) {
  const data = JSON.parse(text);
  if (isLegacyData(data)) throw new LegacyCityError();
  const map = MAPS.find((m) => m.id === data.mapId) || MAPS[0];
  const side = data.gridN || (data.zone?.$ta ? Math.round(Math.sqrt(fromB64(data.zone.d, Uint8Array).length)) : N);
  const resized = side !== N && resizeSave(data, map, side);
  const state = createState(map, data.options);
  for (const [k, v] of Object.entries(data)) {
    if (v && v.$ta) state[k] = fromB64(v.d, TYPES[v.$ta]);
    else if (v && v.$arr) state[k] = v.$arr;
    else if (v && v.$map) state[k] = new Map(v.$map);
    else state[k] = v;
  }
  if (resized) { recomputeWater(state); extendHighway(state); }
  // buildings of a type the game no longer has (e.g. the hydro dam and the airport parts) are
  // taken down, so the rest of the city still loads
  for (const b of [...state.buildings.values()]) {
    b.def = defFor(b.kind, b.type);
    if (b.def) continue;
    console.warn(`Removed a building of a type that no longer exists: ${b.kind}/${b.type}`);
    const cells = b.cells || [];
    if (!b.cells) for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) cells.push(y * N + x);
    for (const i of cells) if (state.bld?.[i] === b.id) state.bld[i] = 0;
    state.buildings.delete(b.id);
  }
  // Core layers must exist; newer layers default to empty for older saves (the per-cell road
  // layers are worked out from the road network when the city starts)
  for (const k of ['height', 'zone', 'bld']) if (!data[k]) throw new Error(`Save is missing layer ${k}`);
  return state;
}

// Cities from a smaller map (the map used to be 17 × 17 tiles) are moved into the middle of
// a freshly generated map of the current size: everything shifts by the same number of whole
// tiles, the land around them is new, and the outside highway, railway and power line are
// carried on out to the new map edge (the highway once the city is loaded: see
// extendHighway in sim/mapgen.js). Decoded layers are left in data as { $arr }.
function resizeSave(data, map, oldN) {
  const O = (N - oldN) / 2;
  if (O < 0 || O % TILE) throw new Error(`This city is ${oldN} cells across and can't be placed on a ${N}-cell map`);
  const OT = O / TILE, oldTiles = oldN / TILE;
  const fresh = createState(map, data.options);
  generateMap(fresh, map);
  fresh.power.fill(0); // the city's own outside power line is kept and extended instead
  const shift = (i) => ((((i / oldN) | 0) + O) * N + (i % oldN) + O);
  const cell = (i) => (i == null || i < 0 ? i : shift(i));
  for (const [k, v] of Object.entries(data)) {
    if (!v || !v.$ta) continue;
    const old = fromB64(v.d, TYPES[v.$ta]);
    let out;
    if (k === 'tiles') {
      out = new Uint8Array(TILES * TILES).fill(data.options?.allTiles ? 1 : 0);
      for (let ty = 0; ty < oldTiles; ty++) for (let tx = 0; tx < oldTiles; tx++) out[(ty + OT) * TILES + tx + OT] = old[ty * oldTiles + tx];
    } else if (k === 'height') {
      out = Float32Array.from(fresh.height);
      embedLayer(out, old, oldN + 1, true);
    } else if (old.length === oldN * oldN) {
      out = fresh[k] && fresh[k].length === N * N ? fresh[k].slice() : new old.constructor(N * N);
      embedLayer(out, old, oldN);
    } else out = old;
    data[k] = { $arr: out };
  }
  // Whatever stands somewhere on the map moves with the city: its box, its middle, its cells,
  // the cell at its front and where it drains to
  const move = (o) => {
    if (!o) return;
    if (o.x0 != null) { o.x0 += O; o.x1 += O; o.y0 += O; o.y1 += O; }
    if (o.cx != null) { o.cx += O; o.cz += O; }
    if (o.cells) o.cells = o.cells.map(cell);
    if (o.front != null) o.front = cell(o.front);
    if (o.discharge) o.discharge = [o.discharge[0] + O, o.discharge[1] + O];
  };
  for (const [, b] of data.buildings?.$map || []) {
    move(b);
    delete b.access; delete b.accessStamp; delete b.comp; delete b.compStamp;
  }
  for (const list of [data.ruins, data.rebuilds, data.plots]) for (const o of list || []) move(o);
  for (const n of data.roads.nodes) { n.x += O; n.z += O; }
  for (const sg of data.roads.segs) sg.k = sg.k.map((v) => v + O);
  data.stops = Object.fromEntries(Object.entries(data.stops || {}).map(([c, st]) => [shift(+c), st]));
  for (const l of data.lines || []) { l.stops = l.stops.map(shift); l.path = null; l.stopIndex = null; l.parts = null; l.valid = false; }
  for (const t of data.tunnels || []) { t.a = shift(t.a); t.b = shift(t.b); }
  for (const lb of data.landmarkBridges || []) move(lb);
  for (const c of data.closures || []) move(c);
  // requests and petitions that point at a street
  for (const d of [...(data.decisions || []), ...(data.politics?.petitions || [])]) {
    if (d.cell != null) d.cell = cell(d.cell);
    if (d.data?.cell != null) d.data.cell = cell(d.data.cell);
  }
  data.events = [];
  if (data.stats) delete data.stats.worstJam;
  // Outside connections: the new map's railway, sea lane and air route; the highway's (its
  // road is carried on when the city is loaded); the city's own power line carried on to the
  // new map edge (around the new railway and highway)
  const power = data.power.$arr;
  const spans = (data.powerSpans || []).map(([a, b]) => [shift(a), shift(b)]);
  const conns = fresh.connections.filter((c) => c.type !== 'power');
  const oldPower = (data.connections || []).find((c) => c.type === 'power');
  if (oldPower) {
    let x = oldPower.x + O, y = oldPower.y + O;
    const [dx, dy] = DIRS[oldPower.dir ?? 2];
    let prev = y * N + x;
    for (;;) {
      let step = 0;
      while (step < 6 && inBounds(x + dx, y + dy)) { x += dx; y += dy; step++; }
      if (!step) break;
      let px = x, py = y;
      for (let k = 0; k < 3 && (fresh.road[py * N + px] || fresh.rail[py * N + px]); k++) { if (dx) py++; else px++; }
      const i = py * N + px;
      power[i] = 1;
      spans.push([prev, i]);
      prev = i;
    }
    conns.push({ ...oldPower, x: prev % N, y: (prev / N) | 0, end: oldPower.end != null ? shift(oldPower.end) : undefined });
  }
  data.powerSpans = spans;
  data.connections = conns;
  data.gridN = N;
  return true;
}

// Compressed save strings ("GZ:" + base64 of gzipped JSON) keep saves small enough for
// localStorage. Falls back to plain JSON where CompressionStream isn't available.
async function streamBytes(stream) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
export async function pack(state) {
  const json = serialize(state);
  if (typeof CompressionStream === 'undefined') return json;
  const gz = await streamBytes(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip')));
  let s = '';
  for (let i = 0; i < gz.length; i += 0x8000) s += String.fromCharCode.apply(null, gz.subarray(i, i + 0x8000));
  return `GZ:${btoa(s)}`;
}
async function gunzip(text) {
  const bin = atob(text.slice(3));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const raw = await streamBytes(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
  return new TextDecoder().decode(raw);
}
export async function unpack(text) {
  if (!text.startsWith('GZ:')) return deserialize(text);
  return deserialize(await gunzip(text));
}
