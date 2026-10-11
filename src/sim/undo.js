// Undo: what you built or removed in the last minute can be taken back, most recent first,
// with what it cost paid back in full (and refunds you got taken back). A change is recorded
// as the difference it made: the map layers it touched (roads, zoning, terrain, trees...), the
// buildings it added, removed or altered (with the households living in them), and the lists
// it changed (roads at an angle, lots, power lines, stops...). Undoing writes all of that
// back. Whatever the city did in between makes way: a building that has grown since on land
// the change zoned goes, people who lost their homes move back in.
import { HN, N } from '../core/grid.js';
import { bus } from '../core/events.js';
import { removeBuilding, changeHooks } from './build.js';
import { difficultyOf } from '../data/difficulty.js';
import { centerIdx } from './services.js';

export const UNDO_SECONDS = 60;
const MAX_STEPS = 20;
// Map layers a change can touch
const LAYERS = ['height', 'water', 'road', 'roadDir', 'roadUpg', 'roadCond', 'roadNode', 'bridgeH', 'bridgeDir', 'underRoad', 'underDir',
  'rail', 'railH', 'railDir', 'path', 'pathH', 'pathDir', 'subway', 'power', 'pipe',
  'zone', 'plot', 'bld', 'district', 'tree', 'forestMax', 'surface', 'canal'];
// Lists a change can touch (compared as JSON)
const LISTS = ['roadSegs', 'plots', 'powerSpans', 'stops', 'districts', 'rebuilds', 'ruins', 'connections', 'tunnels', 'landmarkBridges'];
// Which network each layer belongs to (to redraw and re-route it)
const NETWORK = { road: 'road', roadDir: 'road', roadUpg: 'road', roadCond: 'road', roadNode: 'road', bridgeH: 'road', bridgeDir: 'road', underRoad: 'road', underDir: 'road',
  rail: 'rail', railH: 'rail', railDir: 'rail', path: 'path', pathH: 'path', pathDir: 'path', subway: 'subway', power: 'power', pipe: 'pipe' };

// Cells whose value differs between two copies of a layer: { idx, old } (null if none)
function diff(before, now) {
  if (!now || before.length !== now.length) return null;
  const idx = [], old = [];
  const words = before.byteOffset % 4 === 0 && now.byteOffset % 4 === 0 && before.byteLength % 4 === 0;
  if (words) {
    // compare four bytes at a time; look closer only where they differ
    const a = new Uint32Array(before.buffer, before.byteOffset, before.byteLength / 4);
    const b = new Uint32Array(now.buffer, now.byteOffset, now.byteLength / 4);
    const per = 4 / before.BYTES_PER_ELEMENT;
    for (let w = 0; w < a.length; w++) {
      if (a[w] === b[w]) continue;
      for (let k = w * per; k < w * per + per; k++) if (!Object.is(before[k], now[k])) { idx.push(k); old.push(before[k]); }
    }
  } else {
    for (let k = 0; k < before.length; k++) if (!Object.is(before[k], now[k])) { idx.push(k); old.push(before[k]); }
  }
  return idx.length ? { idx: Int32Array.from(idx), old: before.constructor.from(old) } : null;
}

export function createUndo(state) {
  const steps = []; // the most recent last
  let tx = null;    // the change being recorded
  let undoing = false;

  // What a change spends, refunds, removes and alters (see changeHooks in build.js). Money
  // and experience count only while the tool itself is at work (see undo.during), not what
  // the city spends on its own in the meantime.
  let active = 0;
  changeHooks.spend = (amount) => { if (tx && active) tx.spent += amount; };
  changeHooks.refund = (amount) => { if (tx && active && !undoing) tx.refunded += amount; };
  changeHooks.removing = (st, b) => {
    if (!tx || undoing || st !== state || tx.captured.has(b.id)) return;
    // the households living there and the people in them, as they were
    const households = [], citizens = [];
    for (const hid of b.households || []) {
      const hh = state.households.get(hid);
      if (!hh) continue;
      households.push({ ...hh, members: [...hh.members] });
      for (const cid of hh.members) { const c = state.citizens.get(cid); if (c) citizens.push({ ...c }); }
    }
    tx.captured.set(b.id, { b, households, citizens, workers: [...(b.workers || [])] });
  };
  // a building made bigger: its outline (and what came with it) as it was
  changeHooks.modifying = (st, b) => {
    if (!tx || undoing || st !== state || tx.altered.has(b.id)) return;
    const was = {};
    for (const k of ['x0', 'y0', 'x1', 'y1', 'w', 'd', 'full', 'expansions', 'extraUpkeep']) was[k] = b[k];
    tx.altered.set(b.id, { b, was });
  };
  bus.on('xp', (e) => { if (tx && active && !undoing) tx.xp += (e.amount || 0) * difficultyOf(state).xp; });

  const undo = { steps };

  // Run a tool's own handling of a click, drag or key (what it spends belongs to the change)
  undo.during = (fn) => {
    active++;
    try { return fn(); } finally { active--; }
  };

  // Start recording a change (false if one is already being recorded)
  undo.begin = (label) => {
    if (undoing) return false;
    if (tx) undo.end();
    tx = {
      label, copies: {}, lists: {}, nextId: state.nextId, buildingIds: new Set(state.buildings.keys()),
      spent: 0, refunded: 0, xp: 0, captured: new Map(), altered: new Map(),
      counters: { bulldozed: state.counters.bulldozed || 0, treesPlanted: state.counters.treesPlanted || 0, treesCleared: state.counters.treesCleared || 0 },
      day: state.time.day, ledger: state.ledger,
    };
    for (const k of LAYERS) if (state[k]) tx.copies[k] = state[k].slice();
    for (const k of LISTS) tx.lists[k] = JSON.stringify(state[k] ?? null);
    return true;
  };

  // Finish recording: keep the change if it changed anything
  undo.end = () => {
    const t = tx;
    tx = null;
    if (!t) return null;
    const layers = {}, lists = {};
    let changed = false;
    for (const [k, before] of Object.entries(t.copies)) {
      const d = diff(before, state[k]);
      if (d) { layers[k] = d; changed = true; }
    }
    for (const k of LISTS) {
      if (JSON.stringify(state[k] ?? null) !== t.lists[k]) { lists[k] = t.lists[k]; changed = true; }
    }
    const added = [], removed = [];
    for (const id of state.buildings.keys()) if (!t.buildingIds.has(id)) added.push(id);
    for (const [id, cap] of t.captured) if (t.buildingIds.has(id) && !state.buildings.has(id)) removed.push(cap);
    if (added.length || removed.length || t.altered.size) changed = true;
    if (!changed && !t.spent && !t.refunded) return null;
    const c = state.counters;
    const step = {
      label: t.label, at: performance.now(), layers, lists, added, removed, altered: [...t.altered.values()],
      nextId: t.nextId, spent: t.spent, refunded: t.refunded, xp: t.xp, day: t.day, ledger: t.ledger,
      counters: { bulldozed: (c.bulldozed || 0) - t.counters.bulldozed, treesPlanted: (c.treesPlanted || 0) - t.counters.treesPlanted, treesCleared: (c.treesCleared || 0) - t.counters.treesCleared },
    };
    steps.push(step);
    while (steps.length > MAX_STEPS) steps.shift();
    bus.emit('undo:changed');
    return step;
  };

  // Record fn() as one change
  undo.wrap = (label, fn) => {
    const mine = undo.begin(label);
    try { return undo.during(fn); } finally { if (mine) undo.end(); }
  };

  const fresh = (st) => performance.now() - st.at < UNDO_SECONDS * 1000;
  const prune = () => { while (steps.length && !fresh(steps[0])) steps.shift(); };
  undo.top = () => { prune(); return steps[steps.length - 1] || null; };
  undo.count = () => { prune(); return steps.length; };
  undo.secondsLeft = (st) => Math.max(0, Math.ceil(UNDO_SECONDS - (performance.now() - st.at) / 1000));

  // Why the last change can't be undone right now (null if it can): a refund you got for
  // it has to be paid back
  undo.blocker = () => {
    const st = undo.top();
    if (!st) return 'Nothing to undo';
    if (!state.options.unlimitedMoney && state.money + st.spent < st.refunded) return 'Not enough money to pay back what bulldozing it refunded';
    return null;
  };

  // Take back the last change. Returns it (or null if there's nothing to undo).
  undo.undo = () => {
    if (tx) undo.end();
    if (undo.blocker()) return null;
    const st = steps.pop();
    undoing = true;
    try { apply(st); } finally { undoing = false; }
    bus.emit('undo:changed');
    return st;
  };

  function apply(st) {
    const L = st.layers;
    // the buildings the change took away, by id
    const back = new Map(st.removed.map((r) => [r.b.id, r]));
    // 1) what the change built goes, and so does anything that has appeared since on the land
    //    it changed (a house grown on new zoning, a shop on the lot of one it knocked down)
    for (const id of st.added) if (state.buildings.has(id)) removeBuilding(state, id);
    const clear = (i) => { const id = state.bld[i]; if (id && id >= st.nextId && !back.has(id) && state.buildings.has(id)) removeBuilding(state, id); };
    for (const k of ['bld', 'zone', 'plot', 'road', 'rail', 'path', 'power']) if (L[k]) for (const i of L[k].idx) clear(i);
    // 2) the map layers as they were
    for (const [k, d] of Object.entries(L)) {
      const arr = state[k];
      if (!arr) continue;
      for (let n = 0; n < d.idx.length; n++) arr[d.idx[n]] = d.old[n];
    }
    // 3) the lists as they were
    for (const [k, json] of Object.entries(st.lists)) {
      const v = JSON.parse(json);
      if (v !== null) state[k] = v;
    }
    // 4) buildings it altered (a landfill it made bigger...) go back to how they were
    for (const { b, was } of st.altered) {
      if (!state.buildings.has(b.id)) continue;
      Object.assign(b, was);
      bus.emit('building:changed', b);
    }
    // 5) the buildings it removed come back, with the people who lived there
    for (const { b, households, citizens, workers } of back.values()) {
      if (state.buildings.has(b.id)) continue;
      for (let y = b.y0; y <= b.y1; y++) {
        for (let x = b.x0; x <= b.x1; x++) {
          const i = y * N + x;
          const other = state.bld[i];
          if (other && other !== b.id && other >= st.nextId && state.buildings.has(other)) removeBuilding(state, other);
          state.bld[i] = b.id;
        }
      }
      state.buildings.set(b.id, b);
      // its workers come back, unless they've found another job since
      b.workers = (workers || []).filter((id) => {
        const c = state.citizens.get(id);
        if (!c || (c.job && c.job !== b.id)) return false;
        c.job = b.id;
        return true;
      });
      b.households = [];
      for (const hh of households || []) {
        if (state.households.has(hh.id)) continue;
        state.households.set(hh.id, hh);
        b.households.push(hh.id);
      }
      for (const c of citizens || []) {
        if (state.citizens.has(c.id)) continue;
        // back to their job and school, if those are still there (and the job has room)
        const w = c.job && state.buildings.get(c.job);
        if (!w) c.job = 0;
        else if (!w.workers.includes(c.id)) { if (w.workers.length < (w.jobs || 0)) w.workers.push(c.id); else c.job = 0; }
        const sc = c.school && state.buildings.get(c.school);
        if (sc) sc.studentCount = (sc.studentCount || 0) + 1; else c.school = 0;
        state.citizens.set(c.id, c);
      }
      b.district = state.district[centerIdx(b)];
      bus.emit('building:add', b);
    }
    // (no cell may point at a building that isn't there)
    if (L.bld) for (const i of L.bld.idx) if (state.bld[i] && !state.buildings.has(state.bld[i])) state.bld[i] = 0;
    // 6) money, experience and counters
    if (!state.options.unlimitedMoney) state.money += st.spent;
    state.money -= st.refunded;
    if (st.day === state.time.day) state.stats.spentToday = Math.max(0, (state.stats.spentToday || 0) - st.spent);
    if (st.ledger === state.ledger) state.ledger.income.refunds = Math.max(0, (state.ledger.income.refunds || 0) - st.refunded);
    state.progression.xp = Math.max(0, state.progression.xp - st.xp);
    for (const [k, v] of Object.entries(st.counters)) if (v) state.counters[k] = Math.max(0, (state.counters[k] || 0) - v);
    // 7) let everything that depends on these know
    const nets = new Set();
    for (const k of Object.keys(L)) if (NETWORK[k]) nets.add(NETWORK[k]);
    if (st.lists.roadSegs) nets.add('road');
    if (st.lists.powerSpans) nets.add('power');
    if (st.lists.stops) nets.add('stops');
    if (L.height || L.water) {
      let x0 = N, y0 = N, x1 = 0, y1 = 0;
      const grow = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
      for (const i of L.height?.idx || []) grow(i % HN, (i / HN) | 0);
      for (const i of L.water?.idx || []) grow(i % N, (i / N) | 0);
      bus.emit('terrain:changed', { x0: Math.max(0, x0 - 1), y0: Math.max(0, y0 - 1), x1: Math.min(N - 1, x1), y1: Math.min(N - 1, y1) });
    }
    for (const layer of nets) bus.emit('network:changed', { layer });
    if (L.zone || L.plot || L.surface || st.lists.plots) bus.emit('zones:changed', { count: 1 });
    if (L.tree || L.forestMax) bus.emit('trees:changed');
    if (L.district || st.lists.districts) {
      for (const b of state.buildings.values()) b.district = state.district[centerIdx(b)];
      bus.emit('districts:changed');
    }
    if (st.lists.rebuilds) bus.emit('rebuilds:changed');
    if (st.added.length || back.size || st.altered.length) bus.emit('services:changed');
  }

  return undo;
}
