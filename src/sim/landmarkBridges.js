// Landmark bridges: a road bridge built as a suspension bridge, with tall towers and cables,
// over a wide stretch of water. It carries the road like any bridge (sim/bridges.js) and
// also draws visitors and lifts the neighbourhoods at either end like a landmark.
// state.landmarkBridges: [{ id, name, cells: [cell...], heights: [...], type }]
import { N } from '../core/grid.js';
import { buildBridge } from './bridges.js';
import { spend, refund } from './build.js';
import { bus } from '../core/events.js';

export const LANDMARK_MIN_SPAN = 10;   // cells between the ends
export const LANDMARK_EXTRA = 300000;  // on top of twice the ordinary bridge's price
export const LANDMARK_ATTRACT = 15;
const NAMES = ['Golden Strait Bridge', 'Harbour Bridge', 'Twin Towers Crossing', 'Bay Bridge', 'Skyline Span', 'River Gate Bridge'];

export const landmarkCost = (plan) => Math.round(plan.cost * 2 + LANDMARK_EXTRA);
export function landmarkReason(plan) {
  if (!plan.ok) return plan.reason;
  if (plan.cells.length - 2 < LANDMARK_MIN_SPAN) return `A suspension bridge spans at least ${LANDMARK_MIN_SPAN} cells`;
  if (plan.spanOver.water < 6) return 'A suspension bridge goes over open water';
  if (plan.layer !== 'road') return 'Only road bridges can be suspension bridges';
  return null;
}

export function buildLandmarkBridge(state, plan) {
  const reason = landmarkReason(plan);
  if (reason) return { error: reason };
  const extra = landmarkCost(plan) - plan.cost;
  if (!spend(state, extra, 'bridges')) return { error: 'Not enough money' };
  if (!buildBridge(state, plan)) { refund(state, extra); return { error: 'Not enough money' }; }
  state.landmarkBridges = state.landmarkBridges || [];
  state.landmarkSeq = (state.landmarkSeq || 0) + 1;
  const lb = { id: state.landmarkSeq, name: NAMES[(state.landmarkSeq - 1) % NAMES.length], cells: plan.cells.map(([x, y]) => y * N + x), heights: plan.heights.slice(), type: plan.type };
  state.landmarkBridges.push(lb);
  state.journal.push({ day: state.time.day, kind: 'milestone', text: `${lb.name} opened` });
  bus.emit('landmarkbridges:changed');
  bus.emit('signatures:changed');
  bus.emit('xp', { amount: 80, reason: 'landmark' });
  return { bridge: lb };
}

// A landmark bridge with part of its span taken away is just a ruin of road: it goes
export function pruneLandmarkBridges(state) {
  const list = state.landmarkBridges || [];
  const keep = list.filter((lb) => lb.cells.slice(1, -1).every((i) => state.road[i] && state.bridgeH[i]));
  if (keep.length !== list.length) { state.landmarkBridges = keep; bus.emit('landmarkbridges:changed'); bus.emit('signatures:changed'); }
}

// Where to put a landmark's well-being and visitors: the middle of the span
export function bridgeMid(lb) {
  const i = lb.cells[Math.floor(lb.cells.length / 2)];
  return [i % N, (i / N) | 0];
}
