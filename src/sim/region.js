// The region: your city and the neighbour cities you found next door. They're kept together
// in the browser's database (IndexedDB: cities are too big to keep several in localStorage),
// each with a summary of how it was doing when you last left it. While you play one city,
// the others' summaries feed into it: power they have spare, workers looking for jobs,
// jobs going begging, and goods to trade. (Only the city you're in runs; the others wait.)
import { pack } from './save.js';
import { AGE } from './citizens.js';
import { RESOURCES } from '../data/resources.js';
import { earn } from './economy.js';

const DB = 'gridlock-region';
const STORE = 'cities';
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE, { keyPath: 'id' }); r.result.createObjectStore('regions', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => rej(t.error);
  });
}
export const getRegion = (id) => tx('regions', 'readonly', (s) => s.get(id));
export const putRegion = (r) => tx('regions', 'readwrite', (s) => s.put(r));
export const getCityText = async (id) => (await tx(STORE, 'readonly', (s) => s.get(id)))?.text;
export const putCity = (id, text) => tx(STORE, 'readwrite', (s) => s.put({ id, text }));

// How a city is doing, for its neighbours
export function snapshot(state) {
  const u = state.stats.utilities || {};
  const jobless = [0, 0, 0, 0, 0];
  for (const c of state.citizens.values()) {
    if (c.age < AGE.adult || c.age >= AGE.senior || c.job || c.school || c.jail || c.outsideJob) continue;
    jobless[Math.min(4, c.edu)]++;
  }
  const trade = {};
  for (const [k, m] of Object.entries(state.market || {})) if (m && typeof m === 'object' && RESOURCES[k]) trade[k] = { ex: Math.round(m.exported || 0), im: Math.round(m.imported || 0) };
  return {
    name: state.cityName, mapName: state.mapName, pop: state.citizens.size, day: state.time.day, money: Math.round(state.money),
    powerSpare: Math.max(0, Math.round(((u.produced || 0) + (u.batteryOut || 0) - (u.consumed || 0)) * 10) / 10),
    powerShort: Math.max(0, Math.round(((u.consumed || 0) - (u.produced || 0)) * 10) / 10),
    jobless: jobless.reduce((a, v) => a + v, 0), openJobs: (state.stats.openJobsEdu || []).reduce((a, v) => a + v, 0), trade,
    milestone: state.progression.milestone,
  };
}

// Save this city into the region (with its summary)
export async function saveToRegion(state) {
  if (!state.region) return;
  const text = await pack(state);
  await putCity(state.region.cityId, text);
  const r = (await getRegion(state.region.id)) || { id: state.region.id, cities: [] };
  const me = r.cities.find((c) => c.id === state.region.cityId);
  const snap = snapshot(state);
  if (me) Object.assign(me, { snapshot: snap, name: state.cityName, savedAt: Date.now() });
  else r.cities.push({ id: state.region.cityId, name: state.cityName, mapId: state.mapId, side: state.region.side || 'home', snapshot: snap, savedAt: Date.now() });
  await putRegion(r);
  return r;
}

// What the neighbours offer this city (from their summaries)
export function neighbourOffer(region, cityId) {
  const out = { cities: 0, powerSpare: 0, powerShort: 0, workers: 0, jobs: 0, trade: {} };
  for (const c of region?.cities || []) {
    if (c.id === cityId || !c.snapshot) continue;
    const s = c.snapshot;
    out.cities++;
    out.powerSpare += s.powerSpare; out.powerShort += s.powerShort;
    out.workers += s.jobless; out.jobs += s.openJobs;
    for (const [k, t] of Object.entries(s.trade || {})) { const o = out.trade[k] || (out.trade[k] = { ex: 0, im: 0 }); o.ex += t.ex; o.im += t.im; }
  }
  return out;
}

// Daily: goods your neighbours need that you sell, and goods you buy that they make, go by
// road between you instead of round the world: a better price for what you sell, a cheaper
// one for what you buy. The difference is the city's regional trade income.
export function regionalTradeDaily(state, ctx) {
  const N = ctx.region?.offer;
  if (!N?.cities) return;
  let gain = 0;
  for (const [k, m] of Object.entries(state.market || {})) {
    const t = N.trade[k];
    if (!t || !m || typeof m !== 'object' || !RESOURCES[k]) continue;
    gain += Math.min(m.exported || 0, t.im) * RESOURCES[k].price * 0.15;
    gain += Math.min(m.imported || 0, t.ex) * RESOURCES[k].price * 0.1;
  }
  ctx.region.tradeGain = gain;
  earn(state, 'regional', gain);
}
