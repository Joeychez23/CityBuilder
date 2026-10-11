// Landmark bridges: a road bridge built as a suspension bridge, with tall towers and cables,
// over a wide stretch of water. It's a raised road of the network like any bridge (drawn with
// the road tool's Bridge mode, sim/roadnet.js), and also draws visitors and lifts the
// neighbourhoods at either end like a landmark.
// state.landmarkBridges: [{ id, name, seg (its road segment), cells: [cell...], type }]
import { N } from '../core/grid.js';
import { bus } from '../core/events.js';
import { rn } from './roadnet.js';
import { chainCells } from './roadraster.js';

export const LANDMARK_MIN_SPAN = 10;   // cells between the ends
export const LANDMARK_EXTRA = 300000;  // on top of twice the ordinary bridge's price
export const LANDMARK_ATTRACT = 15;
const NAMES = ['Golden Strait Bridge', 'Harbour Bridge', 'Twin Towers Crossing', 'Bay Bridge', 'Skyline Span', 'River Gate Bridge'];

// A planned road (see planRoad) that's one bridge: twice its price, plus the landmark's
export const landmarkCost = (plan) => Math.round(plan.cost * 2 + LANDMARK_EXTRA);

// Why a planned bridge can't be a suspension bridge (null if it can)
export function landmarkSpanReason(state, plan) {
  const spans = plan.pieces.filter((pc) => pc.br);
  if (spans.length !== 1 || plan.pieces.length !== 1) return 'A suspension bridge is one span, with no junction on it';
  const pc = spans[0];
  if (pc.tab.len < LANDMARK_MIN_SPAN) return `A suspension bridge spans at least ${LANDMARK_MIN_SPAN} cells`;
  let wet = 0;
  for (const i of pc.chain.cells) if (i >= 0 && state.water[i]) wet++;
  if (wet < 6) return 'A suspension bridge goes over open water';
  return null;
}

// The bridge segment sid was built as a suspension bridge: it's a landmark now
export function markLandmark(state, sid) {
  const X = rn(state);
  const s = X.seg.get(sid);
  if (!s) return null;
  const g = X.geo.get(sid);
  if (!g.chain) g.chain = chainCells(g.c, g.tab);
  state.landmarkBridges = state.landmarkBridges || [];
  state.landmarkSeq = (state.landmarkSeq || 0) + 1;
  const lb = { id: state.landmarkSeq, name: NAMES[(state.landmarkSeq - 1) % NAMES.length], seg: sid, cells: [...g.chain.cells].filter((i) => i >= 0), type: s.type };
  state.landmarkBridges.push(lb);
  state.journal.push({ day: state.time.day, kind: 'milestone', text: `${lb.name} opened` });
  bus.emit('landmarkbridges:changed');
  bus.emit('signatures:changed');
  bus.emit('xp', { amount: 80, reason: 'landmark' });
  return lb;
}

// A landmark bridge whose span has been taken away goes with it
export function pruneLandmarkBridges(state) {
  const list = state.landmarkBridges || [];
  const X = rn(state);
  const keep = list.filter((lb) => lb.seg != null && X.seg.get(lb.seg)?.br);
  if (keep.length !== list.length) { state.landmarkBridges = keep; bus.emit('landmarkbridges:changed'); bus.emit('signatures:changed'); }
}

// Where to put a landmark's well-being and visitors: the middle of the span
export function bridgeMid(lb) {
  const i = lb.cells[Math.floor(lb.cells.length / 2)];
  return [i % N, (i / N) | 0];
}
