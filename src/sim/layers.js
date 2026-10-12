// Typed-array layers (the ground's height, zones, resources, pollution...) as they're kept in
// saves and in maps made with the map editor: base64 strings, the number layers squeezed first.
import { N, HN } from '../core/grid.js';

export function toB64(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(str, Type) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Type(bytes.buffer);
}

// The big number layers (the ground's height, resources, pollution...) are saved in 16 bits,
// each value as how far it is from what its neighbours to the west, north and north-west
// predict, the high bytes kept apart from the low ones: these layers are smooth, so that's
// mostly small numbers, which compress to a fraction of the size. Heights keep steps of
// 1/1024; any other layer is spread over its own range (natural resources, in 254 steps),
// and zero stays exactly zero. { $q: 'Float32Array', w: row length, step | lo + hi + n, d }
const HEIGHT_STEP = 1 / 1024;
const COARSE = new Set(['fertile', 'ore', 'oil', 'groundwater', 'forestMax']);
function packFloats(arr, w, step = 0, levels = 65534) {
  const n = arr.length;
  let lo = 0, hi = 0;
  if (!step) for (let i = 0; i < n; i++) { const v = arr[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const k = step ? 1 / step : hi > lo ? levels / (hi - lo) : 0;
  const q = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    q[i] = step ? Math.min(65535, Math.max(0, Math.round(v * k))) : v === 0 ? 0 : 1 + Math.round((v - lo) * k);
  }
  const out = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    const x = i % w;
    const a = x ? q[i - 1] : 0, b = i >= w ? q[i - w] : 0, c = x && i >= w ? q[i - w - 1] : 0;
    const r = (q[i] - (x && i >= w ? a + b - c : x ? a : b)) & 0xffff;
    out[i] = r & 255;
    out[n + i] = r >> 8;
  }
  return step ? { $q: 'Float32Array', w, step, d: toB64(out) } : { $q: 'Float32Array', w, lo, hi, n: levels, d: toB64(out) };
}
function unpackFloats(v) {
  const bytes = fromB64(v.d, Uint8Array);
  const n = bytes.length / 2, w = v.w;
  const q = new Uint16Array(n), out = new Float32Array(n);
  const k = v.step || (v.hi > v.lo ? (v.hi - v.lo) / v.n : 0);
  for (let i = 0; i < n; i++) {
    const x = i % w;
    const a = x ? q[i - 1] : 0, b = i >= w ? q[i - w] : 0, c = x && i >= w ? q[i - w - 1] : 0;
    q[i] = ((x && i >= w ? a + b - c : x ? a : b) + (bytes[i] | (bytes[n + i] << 8))) & 0xffff;
    out[i] = v.step ? q[i] * k : q[i] ? v.lo + (q[i] - 1) * k : 0;
  }
  return out;
}
const TYPES = { Float32Array, Uint8Array, Int32Array, Uint16Array };

// A layer of the state (by its name) as it's saved: number layers as above, the others as
// they are ({ $ta: type, d: base64 })
export function packLayer(name, arr) {
  if (arr instanceof Float32Array) return packFloats(arr, name === 'height' ? HN : N, name === 'height' ? HEIGHT_STEP : 0, COARSE.has(name) ? 254 : 65534);
  return { $ta: arr.constructor.name, d: toB64(arr) };
}
// A saved layer, whichever way it was saved
export const isLayer = (v) => !!v && !!(v.$ta || v.$q);
export const fromLayer = (v) => (v.$q ? unpackFloats(v) : fromB64(v.d, TYPES[v.$ta]));
