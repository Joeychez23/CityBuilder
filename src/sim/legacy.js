// Cities from before the road network update (grid roads) can't be opened any more, but
// they're never thrown away: each one found (the city saved in this browser, a file, an
// account or region city you tried to open) is kept here, in the browser's database, so a
// new city's autosave can't overwrite it. The start screen lists them for download.
import { SAVE_KEY, isLegacySave } from './save.js';

const DB = 'gridlock-legacy';
const STORE = 'cities';
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => rej(t.error);
  });
}

// A short fingerprint of the save text, so the same city isn't kept twice
function fingerprint(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += Math.max(1, (text.length / 20000) | 0)) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${text.length.toString(36)}-${(h >>> 0).toString(36)}`;
}

// Keep a legacy save (returns its record); name: the city's name if known
export async function keepLegacy(text, name = '') {
  const id = fingerprint(text);
  const existing = await tx('readonly', (s) => s.get(id)).catch(() => null);
  if (existing) return existing;
  const rec = { id, text, name: name || 'Old city', keptAt: Date.now() };
  await tx('readwrite', (s) => s.put(rec));
  // read it back before relying on it
  const back = await tx('readonly', (s) => s.get(id));
  if (!back || back.text !== text) throw new Error('Could not keep the old city');
  return rec;
}

export const listLegacy = () => tx('readonly', (s) => s.getAll()).catch(() => []);

// Offer a kept city as a file (it opens in a version of the game from before the update)
export function downloadLegacy(rec) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rec.text], { type: 'application/octet-stream' }));
  a.download = `${(rec.name || 'old-city').replace(/[^\w -]+/g, '').trim() || 'old-city'} (grid roads).city`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// The city saved in this browser: if it's a legacy one, keep a copy. Returns true if it was.
export async function checkSavedCity() {
  let text = null;
  try { text = localStorage.getItem(SAVE_KEY); } catch { return false; }
  if (!text || !(await isLegacySave(text))) return false;
  try { await keepLegacy(text, await nameOf(text)); } catch (err) { console.warn(err); }
  return true;
}

export async function nameOf(text) {
  try {
    let json = text;
    if (text.startsWith('GZ:')) {
      const bin = atob(text.slice(3));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      json = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    }
    return /"cityName":"((?:[^"\\]|\\.)*)"/.exec(json)?.[1] || '';
  } catch { return ''; }
}
