// Power lines: pylons on single cells, joined by overhead wires that span up to MAX_SPAN
// cells in any direction, over roads, rails, water and buildings.
//
// Where power goes:
//  - Roads carry power along them, to every building beside them. A power plant (or a
//    battery) feeds the roads it stands next to.
//  - Power lines (high voltage) don't feed roads or buildings directly. They connect to:
//    other pylons, power plants and batteries (the wire runs to the plant), and Power
//    Connectors: a transformer you put on a road (Roads → Power Connector, or just finish a
//    power line on a road) that feeds the line's power into that road's network.
//  - The outside power line brings power from neighbouring cities.
// A wire's ends are pylon cells, or "terminals": a road cell with a Power Connector, or a cell
// of a power plant or battery.
import { N, idx, inBounds, DIRS } from '../core/grid.js';
import { isOwned, spend, refund, REFUND_RATE, clearZoneCell } from './build.js';
import { UPG, UPGRADES } from '../data/roads.js';
import { bus } from '../core/events.js';
import { setCellUpgrade } from './roadnet.js';

export const PYLON_COST = 80;
export const SPAN_COST = 6; // per cell of wire
export const MAX_SPAN = 8;  // cells between pylons
export const CONNECTOR = UPGRADES.find((u) => u.bit === UPG.POWER);

const cellXY = (i) => [i % N, (i / N) | 0];
export const spanLength = (a, b) => { const [ax, ay] = cellXY(a), [bx, by] = cellXY(b); return Math.hypot(bx - ax, by - ay); };

// Buildings power lines can run to: plants and batteries
export const isPowerBuilding = (b) => !!(b && !b.cons && (b.def.power || b.def.battery));
export const hasConnector = (state, i) => !!(state.road[i] && state.roadUpg[i] & UPG.POWER);

// What a wire can end on at cell i (besides a pylon): 'road' (a road with a Power Connector,
// or one that will get one), 'building' (a plant or battery), or null
export function terminalAt(state, i) {
  if (state.road[i] && !state.bridgeH[i]) return 'road';
  const b = state.bld[i] && state.buildings.get(state.bld[i]);
  return isPowerBuilding(b) ? 'building' : null;
}
export const isNode = (state, i) => !!state.power[i] || hasConnector(state, i) || terminalAt(state, i) === 'building';

// May electricity flow between neighbouring cells i and j? (the electricity network layer is
// roads, buildings and pylons; see computeUtilities)
export function powerLinked(state, i, j) {
  const pi = state.power[i], pj = state.power[j];
  if (!pi && !pj) return true;              // roads and buildings: always
  if (pi && pj) return true;                // pylon to pylon
  const other = pi ? j : i;                 // a pylon next to a road or building
  if (hasConnector(state, other)) return true;
  return isPowerBuilding(state.bld[other] && state.buildings.get(state.bld[other]));
}

// Why a line can't start here (null = it can)
export function pylonSourceReason(state, ctx, x, y) {
  for (const [dx, dy] of DIRS) {
    const nx = x + dx, ny = y + dy;
    if (!inBounds(nx, ny)) continue;
    const j = idx(nx, ny);
    if (state.power[j] || hasConnector(state, j)) return null;
    if (terminalAt(state, j) === 'building') return null;
  }
  return 'Start at a power plant, a Power Connector on a road, an existing pylon or the outside power line (or click a plant to run the line from it)';
}

export function pylonBlocker(state, x, y) {
  if (!inBounds(x, y)) return 'Off the map';
  if (!isOwned(state, x, y)) return 'Not your land';
  const i = idx(x, y);
  if (state.water[i]) return 'Pylons can\'t stand in water (wires can cross it)';
  if (state.road[i] || state.rail[i] || state.path[i]) return 'Pylons stand beside roads and tracks — the wires pass over them';
  if (state.bld[i]) return 'A building is in the way';
  return null;
}

// Cost of a pylon plus all the wires attached to it (what you'd get back on demolition)
export function pylonValue(state, i) {
  let v = PYLON_COST;
  for (const [a, b] of state.powerSpans) if (a === i || b === i) v += spanLength(a, b) * SPAN_COST;
  return v;
}

const spanExists = (state, a, b) => state.powerSpans.some(([p, q]) => (p === a && q === b) || (p === b && q === a));

// Plan a line from a node (fromIdx: a pylon or a terminal) to a target cell. The target can
// be open land (a new pylon), an existing pylon, a road (it gets a Power Connector) or a
// power plant. Long lines get pylons spaced evenly along the way.
export function planPowerLine(state, fromIdx, tx, ty) {
  const plan = { ok: false, reason: null, pylons: [], spans: [], cost: 0, connector: null, end: null };
  if (!inBounds(tx, ty)) { plan.reason = 'Off the map'; return plan; }
  let to = idx(tx, ty);
  if (to === fromIdx) { plan.reason = 'Pick a different spot'; return plan; }
  const term = state.power[to] ? null : terminalAt(state, to);
  if (term === 'building') {
    // run the wire to the plant cell nearest to where the line comes from
    const b = state.buildings.get(state.bld[to]);
    const [fx, fy] = cellXY(fromIdx);
    let best = to, bd = 1e9;
    for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) {
      const d = Math.hypot(x - fx, y - fy);
      if (d < bd) { bd = d; best = idx(x, y); }
    }
    to = best;
    plan.end = 'building';
  } else if (term === 'road') {
    if (!isOwned(state, tx, ty)) { plan.reason = 'Not your land'; return plan; }
    plan.end = 'road';
    if (!hasConnector(state, to)) { plan.connector = to; plan.cost += CONNECTOR.cost; }
  } else if (!state.power[to]) {
    const r = pylonBlocker(state, tx, ty);
    if (r) { plan.reason = r; return plan; }
  }
  const [fx, fy] = cellXY(fromIdx);
  const [ex, ey] = cellXY(to);
  const dist = Math.hypot(ex - fx, ey - fy);
  const segments = Math.max(1, Math.ceil(dist / MAX_SPAN));
  const chain = [fromIdx];
  for (let k = 1; k < segments; k++) {
    const px = fx + ((ex - fx) * k) / segments, py = fy + ((ey - fy) * k) / segments;
    // nearest free cell to the ideal point
    let best = -1, bestD = 1e9;
    for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
      const cx = Math.round(px) + ox, cy = Math.round(py) + oy;
      if (!inBounds(cx, cy)) continue;
      const ci = idx(cx, cy);
      const ok = state.power[ci] || !pylonBlocker(state, cx, cy);
      const d = Math.hypot(cx - px, cy - py);
      if (ok && d < bestD) { best = ci; bestD = d; }
    }
    if (best < 0) { plan.reason = 'No room for a pylon along the way'; return plan; }
    chain.push(best);
  }
  chain.push(to);
  for (let k = 1; k < chain.length; k++) {
    const a = chain[k - 1], b = chain[k];
    const len = spanLength(a, b);
    if (len > MAX_SPAN + 1.5) { plan.reason = 'Pylons would be too far apart here'; return plan; }
    if (a === b || spanExists(state, a, b)) continue;
    plan.spans.push([a, b]);
    plan.cost += len * SPAN_COST;
  }
  for (const i of chain) {
    if (state.power[i] || plan.pylons.includes(i) || i === to && plan.end) continue;
    if (i === fromIdx && !state.power[i]) continue; // the line starts at a terminal
    plan.pylons.push(i);
    plan.cost += PYLON_COST;
  }
  plan.chain = chain;
  plan.cost = Math.round(plan.cost);
  plan.ok = true;
  return plan;
}

export function placePylon(state, x, y, ctx = null) {
  const r = pylonBlocker(state, x, y) || pylonSourceReason(state, ctx, x, y);
  if (r) return { error: r };
  if (!spend(state, PYLON_COST, 'electricity')) return { error: 'Not enough money' };
  const i = idx(x, y);
  state.power[i] = 1;
  clearZoneCell(state, i);
  state.tree[i] = 0;
  bus.emit('network:changed', { layer: 'power' });
  bus.emit('trees:changed');
  return { pylon: i };
}

export function buildPowerLine(state, plan) {
  if (!plan.ok || !spend(state, plan.cost, 'electricity')) return false;
  for (const i of plan.pylons) { state.power[i] = 1; clearZoneCell(state, i); state.tree[i] = 0; }
  if (plan.connector != null) setCellUpgrade(state, plan.connector, UPG.POWER, true, { silent: true });
  state.powerSpans.push(...plan.spans);
  bus.emit('network:changed', { layer: 'power' });
  if (plan.connector != null) bus.emit('network:changed', { layer: 'road' });
  bus.emit('trees:changed');
  return true;
}

// Remove a pylon and every wire attached to it. Returns the refund.
export function removePylon(state, i) {
  const back = refund(state, pylonValue(state, i) * REFUND_RATE);
  state.power[i] = 0;
  state.powerSpans = state.powerSpans.filter(([a, b]) => a !== i && b !== i);
  bus.emit('network:changed', { layer: 'power' });
  return back;
}

// Wires that end on these cells come down (a removed connector, plant or road)
export function dropSpansAt(state, cells) {
  const set = cells instanceof Set ? cells : new Set(cells);
  const before = state.powerSpans.length;
  state.powerSpans = state.powerSpans.filter(([a, b]) => (!set.has(a) || state.power[a]) && (!set.has(b) || state.power[b]));
  if (state.powerSpans.length !== before) bus.emit('network:changed', { layer: 'power' });
}

// Older saves stored power lines cell by cell: link neighbouring line cells with wires.
export function migratePowerLines(state) {
  if (Array.isArray(state.powerSpans) && state.powerSpans.length) return;
  state.powerSpans = [];
  for (let i = 0; i < N * N; i++) {
    if (!state.power[i]) continue;
    const [x, y] = cellXY(i);
    if (x + 1 < N && state.power[i + 1]) state.powerSpans.push([i, i + 1]);
    if (y + 1 < N && state.power[i + N]) state.powerSpans.push([i, i + N]);
  }
}

// Cities from before Power Connectors: a pylon beside a road fed it directly. Give each such
// pylon a connector on the road next to it, so those towns keep their power.
export function addLegacyConnectors(state) {
  let n = 0;
  for (let i = 0; i < N * N; i++) {
    if (!state.power[i]) continue;
    const [x, y] = cellXY(i);
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const j = idx(nx, ny);
      if (state.road[j] && !state.bridgeH[j]) { setCellUpgrade(state, j, UPG.POWER, true, { silent: true }); n++; break; }
    }
  }
  return n;
}
