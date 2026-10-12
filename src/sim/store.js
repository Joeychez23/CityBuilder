// What this browser keeps between visits, besides small settings: the city you're playing, a
// city handed over to the page as it reloads (one opened from your account), and the maps
// made in the map editor. A city goes in localStorage when it fits, as it always has, and
// otherwise in the browser's database (IndexedDB), which holds far more; only one copy is
// kept, so an older one can't be mistaken for it.
import { SAVE_KEY, MAPS_KEY } from './save.js';

export const PENDING_LOAD = 'gridlock-pending-load';  // a city handed over (its save text)
export const PENDING_CLOUD = 'gridlock-pending-cloud'; // ...and its id in your account
const PENDING_DB = 'gridlock-pending-db';              // ...handed over through the database

const DB = 'gridlock-store';
const STORE = 'items';
let opened = null;
function db() {
  opened ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => { opened = null; rej(r.error); };
  });
  return opened;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
const get = (id) => tx('readonly', (s) => s.get(id)).then((r) => r?.value ?? null, () => null);
const put = (id, value) => tx('readwrite', (s) => s.put({ id, value }));
const del = (id) => tx('readwrite', (s) => s.delete(id)).catch(() => {});

// ----------------------------------------------------------------- the saved city
export async function putSave(text) {
  try {
    localStorage.setItem(SAVE_KEY, text);
    await del('city');
    return;
  } catch { /* too big for localStorage (or it's blocked): into the database */ }
  await put('city', text);
  try { localStorage.removeItem(SAVE_KEY); } catch { /* storage blocked */ }
}
export async function getSave() {
  try { const text = localStorage.getItem(SAVE_KEY); if (text) return text; } catch { /* storage blocked */ }
  return get('city');
}

// ------------------------------------------------- a city handed over to the reloaded page
export async function handOver(text, cloudId = null) {
  try {
    sessionStorage.removeItem(PENDING_DB);
    if (cloudId) sessionStorage.setItem(PENDING_CLOUD, cloudId);
    try { sessionStorage.setItem(PENDING_LOAD, text); } catch {
      await put('handover', text);
      sessionStorage.setItem(PENDING_DB, '1');
    }
    return true;
  } catch { return false; }
}
// Is a city waiting to be opened? (then the page opens it rather than showing the menu)
export function handedOver() {
  try { return !!(sessionStorage.getItem(PENDING_LOAD) || sessionStorage.getItem(PENDING_DB)); } catch { return false; }
}
// The city handed over, and its id in your account: { text, cloudId } (it's opened once)
export async function takeHandOver() {
  let text = null, cloudId = null;
  try {
    text = sessionStorage.getItem(PENDING_LOAD);
    cloudId = sessionStorage.getItem(PENDING_CLOUD);
    const inDb = sessionStorage.getItem(PENDING_DB);
    for (const k of [PENDING_LOAD, PENDING_CLOUD, PENDING_DB]) sessionStorage.removeItem(k);
    if (!text && inDb) { text = await get('handover'); await del('handover'); }
  } catch { /* storage blocked */ }
  return { text, cloudId };
}

// ------------------------------------------------------------ maps from the map editor
// (the last few kept; older ones were kept in localStorage)
export async function customMapList() {
  let old = [];
  try { old = JSON.parse(localStorage.getItem(MAPS_KEY) || '[]'); } catch { /* none */ }
  return [...old, ...((await get('maps')) || [])];
}
export async function addCustomMap(map) {
  await put('maps', ((await get('maps')) || []).concat(map).slice(-6));
}
