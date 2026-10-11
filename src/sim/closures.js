// Road closures: a street closed for a film shoot, broken by an earthquake until the road
// crews mend it, or under flood water. Closed road can't be driven on (routes go round it),
// but the buildings along it keep their address. state.closed holds why each cell is shut.
import { bus } from '../core/events.js';

export const CLOSED = { film: 1, quake: 2, flood: 3 };
export const CLOSED_NAMES = { 1: 'Closed for filming', 2: 'Broken by the earthquake', 3: 'Under flood water' };
const now = (state) => state.time.day * 1440 + state.time.minutes;

// Close road cells for `minutes` (Infinity: until something reopens them)
export function closeRoads(state, cells, minutes, why) {
  state.closures = state.closures || [];
  const list = cells.filter((i) => state.road[i]);
  if (!list.length) return null;
  const c = { cells: list, until: minutes === Infinity ? null : now(state) + minutes, why };
  state.closures.push(c);
  for (const i of list) state.closed[i] = CLOSED[why];
  bus.emit('roads:closed');
  return c;
}

// Re-open cells (all of a closure's, or the ones given)
export function reopen(state, cells) {
  const set = new Set(cells);
  for (const c of state.closures || []) c.cells = c.cells.filter((i) => !set.has(i));
  state.closures = (state.closures || []).filter((c) => c.cells.length);
  refreshClosed(state);
}

export function refreshClosed(state) {
  state.closed.fill(0);
  // (an earthquake breaks pipes too, where there's no road over them)
  for (const c of state.closures || []) for (const i of c.cells) if (state.road[i] || (c.why === 'quake' && state.pipe[i])) state.closed[i] = Math.max(state.closed[i], CLOSED[c.why]);
  bus.emit('roads:closed');
}

// Hourly: closures whose time is up open again
export function closuresHourly(state) {
  if (!state.closures?.length) return;
  const t = now(state);
  const before = state.closures.length;
  state.closures = state.closures.filter((c) => c.until == null || c.until > t);
  if (state.closures.length !== before) refreshClosed(state);
}
