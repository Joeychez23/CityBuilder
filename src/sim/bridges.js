// Bridges: raised spans of road, railway or footpath between two chosen end points. They can
// cross water, valleys, railways or roads below. Each bridge cell stores its deck height and
// its axis; bridge cells only connect along that axis, so a bridge running next to a road
// never snaps onto it sideways. Road bridges can also run at an angle: those are a road
// segment (see roadsegs.js) lifted off the ground, and connect only along their line.
// A road bridge over a road leaves that road running on underneath it (an underpass, below).
import { N, idx, hidx, inBounds, DIRS } from '../core/grid.js';
import { lineCells, isAxisLine, segIndex, snapEnd, segParam, stepDirs } from './roadsegs.js';
import { ROADS, UPGRADES } from '../data/roads.js';
import { cellHeight } from './mapgen.js';
import { isOwned, spend, removeBuilding, LAYER_COST, refund, networkValue, REFUND_RATE, clearZoneCell, planRoadLine, placeRoadLine, canAfford, clearRoadCell } from './build.js';
import { gradeCells } from './grade.js';
import { bus } from '../core/events.js';

export const WATER_CLEARANCE = 0.9;  // deck above the water
export const LAND_CLEARANCE = 0.05;  // deck above open ground (it can run along the bank)
export const CROSS_CLEARANCE = 1.3;  // deck above a railway or footpath it passes over
export const UNDER_CLEARANCE = 1.0;  // deck above a road passing under it
export const MAX_BRIDGE_GRADE = 0.6; // height change per cell
const AXIS_X = 1, AXIS_Z = 2, AXIS_DIAG = 3;

// Layer name -> [network array, height array, axis array]
export function bridgeLayers(state, layer) {
  if (layer === 'rail') return [state.rail, state.railH, state.railDir];
  if (layer === 'path') return [state.path, state.pathH, state.pathDir];
  return [state.road, state.bridgeH, state.bridgeDir];
}

// May network cells i and j (j is i's neighbour in direction d) connect?
// Roads: a road at an angle only connects along its own line, at its two ends, and where
// another road was built across it (a "node", see state.roadNode). So a road drawn at an angle
// never snaps sideways onto the roads it passes beside or the one it ends on: junctions are
// only where you made them. Worked out once per network change (see roadMasks).
export function linked(state, layer, i, j, d) {
  if (layer === 'road') return (roadMasks(state)[i] >> d) & 1;
  return baseLinked(state, layer, i, j, d);
}

// Bridges connect only along their axis (or, at an angle, along their line)
function baseLinked(state, layer, i, j, d) {
  const [net, , dir] = bridgeLayers(state, layer);
  if (!net[i] || !net[j]) return false;
  const di = dir[i], dj = dir[j];
  if (!di && !dj) return true;
  const axis = d === 0 || d === 2 ? AXIS_X : AXIS_Z;
  // a bridge at an angle only connects to the cells along its own line
  if (di === AXIS_DIAG || dj === AXIS_DIAG) {
    const SG = segIndex(state);
    if (di === AXIS_DIAG && !SG.internal.has(i * 4 + d)) return false;
    if (dj === AXIS_DIAG && !SG.internal.has(j * 4 + ((d + 2) % 4))) return false;
    if (di && di !== AXIS_DIAG && di !== axis) return false;
    if (dj && dj !== AXIS_DIAG && dj !== axis) return false;
    return true;
  }
  if (di && di !== axis) return false;
  if (dj && dj !== axis) return false;
  return true;
}

// Per road cell, a bitmask of the neighbours it connects to (1 = E, 2 = S, 4 = W, 8 = N)
let masks = null, masksState = null, masksDirty = true;
bus.on('network:changed', () => { masksDirty = true; });
export function roadMasks(state) {
  if (!masksDirty && masks && masksState === state) return masks;
  const NN = N * N;
  if (!masks || masks.length !== NN) masks = new Uint8Array(NN);
  else masks.fill(0);
  masksState = state;
  masksDirty = false;
  const SG = segIndex(state);
  const node = state.roadNode;
  // a cell in the middle of a road at an angle (not one of its ends or a junction you built)
  const inner = (i) => SG.byCell.has(i) && !SG.ends.has(i) && !(node && node[i]);
  const road = state.road;
  for (let i = 0; i < NN; i++) {
    if (!road[i]) continue;
    const x = i % N, y = (i / N) | 0;
    for (let d = 0; d < 2; d++) { // east and south; the other side gets the mirror bit
      const nx = x + (d === 0 ? 1 : 0), ny = y + (d === 1 ? 1 : 0);
      if (nx >= N || ny >= N) continue;
      const j = ny * N + nx;
      if (!road[j] || !baseLinked(state, 'road', i, j, d)) continue;
      if (inner(i) && !SG.internal.has(i * 4 + d)) continue;
      if (inner(j) && !SG.internal.has(j * 4 + d + 2)) continue;
      masks[i] |= 1 << d;
      masks[j] |= 1 << (d + 2);
    }
  }
  return masks;
}

// How many roads a road cell connects to (3 or more = a junction)
export const roadLinks = (state, i) => { const m = roadMasks(state)[i]; return (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1); };

// Older cities (before junction nodes): keep the connections they had where a road crosses
// a road at an angle, or ends against its side, so nothing comes apart on load. A cell of an
// angled road becomes a junction when a road beside it carries straight on away from it, or
// stops right there (it was built to meet it); roads that only run alongside stay apart.
export function migrateRoadNodes(state) {
  if (!state.roadNode) state.roadNode = new Uint8Array(N * N);
  const SG = segIndex(state);
  const road = state.road;
  const nb = (i, d) => { const x = (i % N) + [1, 0, -1, 0][d], y = ((i / N) | 0) + [0, 1, 0, -1][d]; return inBounds(x, y) ? idx(x, y) : -1; };
  for (const [i] of SG.byCell) {
    if (!road[i] || SG.ends.has(i)) continue;
    for (let d = 0; d < 4; d++) {
      if (SG.internal.has(i * 4 + d)) continue;
      const j = nb(i, d);
      if (j < 0 || !road[j]) continue;
      const k = nb(j, d);
      let others = 0;
      for (let e = 0; e < 4; e++) { const m = nb(j, e); if (m >= 0 && m !== i && road[m]) others++; }
      if ((k >= 0 && road[k]) || others === 0) { state.roadNode[i] = 1; break; }
    }
  }
  bus.emit('network:changed', { layer: 'road' });
}

const maxCorner = (state, x, y) => {
  const H = state.height;
  return Math.max(H[hidx(x, y)], H[hidx(x + 1, y)], H[hidx(x, y + 1)], H[hidx(x + 1, y + 1)]);
};

// Height of a bridge end: an existing road/rail surface, or the ground it will be built on
function endHeight(state, layer, x, y) {
  const [, H] = bridgeLayers(state, layer);
  const i = idx(x, y);
  if (H[i]) return H[i];
  if (state.water[i]) return state.seaLevel + WATER_CLEARANCE;
  return cellHeight(state, x, y);
}

// Straight run of cells from a to b. Road bridges may run at an angle (snapping to the grid
// and 45° when close); railway and footbridges are snapped onto a's row or column.
export function bridgeCells(a, b, layer = 'road') {
  if (layer === 'road') {
    const [ex, ey] = snapEnd(a.cx, a.cy, b.cx, b.cy);
    if (!isAxisLine(a.cx, a.cy, ex, ey)) {
      const cells = lineCells(a.cx, a.cy, ex, ey);
      const seg = { a: [a.cx, a.cy], b: [ex, ey] };
      const len = Math.hypot(ex - a.cx, ey - a.cy);
      // how far along the bridge each cell is (cells on a diagonal aren't evenly spaced)
      const along = cells.map(([x, y]) => segParam(seg, x + 0.5, y + 0.5) * len);
      return { cells, axis: AXIS_DIAG, seg, along };
    }
    b = { cx: ex, cy: ey };
  }
  const horizontal = Math.abs(b.cx - a.cx) >= Math.abs(b.cy - a.cy);
  const ex = horizontal ? b.cx : a.cx, ey = horizontal ? a.cy : b.cy;
  const n = Math.max(Math.abs(ex - a.cx), Math.abs(ey - a.cy));
  const sx = Math.sign(ex - a.cx), sy = Math.sign(ey - a.cy);
  const cells = [];
  for (let k = 0; k <= n; k++) cells.push([a.cx + sx * k, a.cy + sy * k]);
  return { cells, axis: horizontal ? AXIS_X : AXIS_Z };
}

// The deck seen from the side: the lowest line over the floor heights (the upper concave
// hull of the ends and the floor, so no dips between high points), drawn as one smooth curve
// through its corners. It leaves each end level with the road, eases into the climb and
// levels off on top, so even a short overpass reads as a ramp, a level stretch over the road
// and a ramp down, like a long one, rather than coming to a peak. floor[0] and floor[n] are
// ignored (the ends are hA and hB). xs: how far along the bridge each cell is (default: one
// cell apart). flat[k]: the deck stays at cell k's floor for this far either side of its
// centre (over a road or track passing under it, the deck is level across all of it).
// Where the curve would be too steep, its ramps are eased less, down to straight lines.
export function archProfile(hA, hB, floor, xs = null, flat = null) {
  const n = floor.length - 1;
  const X = xs || floor.map((_, k) => k);
  const hullOf = () => {
    const pts = [[X[0], hA]];
    const put = (x, y) => {
      if (x <= X[0] || x >= X[n]) return;
      const last = pts[pts.length - 1];
      if (x - last[0] < 1e-6) last[1] = Math.max(last[1], y); else pts.push([x, y]);
    };
    for (let k = 1; k < n; k++) {
      if (!Number.isFinite(floor[k])) continue;
      const w = flat?.[k] || 0;
      if (w) put(X[k] - w, floor[k]);
      put(X[k], floor[k]);
      if (w) put(X[k] + w, floor[k]);
    }
    pts.push([X[n], hB]);
    const hull = [];
    for (const p of pts) {
      while (hull.length >= 2) {
        const [ax, ay] = hull[hull.length - 2], [bx, by] = hull[hull.length - 1];
        // drop the middle point if it lies below the line from a to p (keeps the top envelope)
        if ((by - ay) * (p[0] - ax) <= (p[1] - ay) * (bx - ax)) hull.pop(); else break;
      }
      hull.push(p);
    }
    return hull;
  };
  // the hull's straight lines, or a smooth curve through its corners: level at each end and
  // wherever it tops out, elsewhere turning gently (the slopes either side, harmonically
  // averaged, so it never overshoots)
  const trace = (hull, smooth) => {
    const slope = (v) => (hull[v + 1][1] - hull[v][1]) / Math.max(1e-6, hull[v + 1][0] - hull[v][0]);
    const tan = hull.map((_, v) => {
      if (!smooth || v === 0 || v === hull.length - 1) return 0;
      const d0 = slope(v - 1), d1 = slope(v);
      return d0 * d1 > 1e-12 ? (2 * d0 * d1) / (d0 + d1) : 0;
    });
    let v = 0;
    return X.map((x, k) => {
      if (k === 0) return hA;
      if (k === n) return hB;
      while (v < hull.length - 2 && x > hull[v + 1][0]) v++;
      const [x0, y0] = hull[v], [x1, y1] = hull[v + 1];
      const len = Math.max(1e-6, x1 - x0), t = Math.min(1, Math.max(0, (x - x0) / len));
      const h = smooth
        ? (2 * t ** 3 - 3 * t * t + 1) * y0 + (t ** 3 - 2 * t * t + t) * len * tan[v] + (3 * t * t - 2 * t ** 3) * y1 + (t ** 3 - t * t) * len * tan[v + 1]
        : y0 + (y1 - y0) * t;
      return Math.max(h, floor[k]);
    });
  };
  const hull = hullOf();
  const straight = trace(hull, false), eased = trace(hull, true);
  const tries = [eased, eased.map((h, k) => (h + straight[k]) / 2), straight];
  return tries.find((h) => deckGrade(h, X) <= MAX_BRIDGE_GRADE) || straight;
}

// The steepest step along a deck (height change per cell)
export function deckGrade(h, xs = null) {
  let g = 0;
  for (let k = 1; k < h.length; k++) g = Math.max(g, Math.abs(h[k] - h[k - 1]) / Math.max(0.5, xs ? xs[k] - xs[k - 1] : 1));
  return g;
}

// What a bridge's deck must clear over each cell (-Infinity at the ends), and over which
// cells it stays level (flat, see archProfile): where a road, railway or footpath passes under
// it. under: the span cells (by index along the bridge) a road passes under, as an underpass.
function deckFloor(state, layer, cells, under) {
  const n = cells.length - 1;
  const flat = new Array(n + 1).fill(0);
  const floor = cells.map(([x, y], k) => {
    if (k === 0 || k === n) return -Infinity;
    const i = idx(x, y);
    const ground = maxCorner(state, x, y);
    let f = ground + LAND_CLEARANCE;
    if (state.water[i]) f = Math.max(f, state.seaLevel + WATER_CLEARANCE);
    const below = (layer !== 'road' && state.road[i]) || (layer !== 'rail' && state.rail[i]) || (layer !== 'path' && state.path[i]);
    if (below) { f = Math.max(f, ground + CROSS_CLEARANCE); flat[k] = 0.5; }
    if (under.has(k)) { f = Math.max(f, ground + UNDER_CLEARANCE); flat[k] = 0.5; }
    return f;
  });
  return { floor, flat };
}

// layer: 'road' | 'rail' | 'path' ; type: road type id when layer is 'road'
// anywhere: the land needn't be yours (the outside connections the map starts with)
// overRoads: a road bridge may pass over roads, which carry on underneath (off for the outside
// connections, which lift track that's already there)
export function planBridge(state, layer, type, a, b, { allowWaterEnds = false, anywhere = false, overRoads = true } = {}) {
  const { cells, axis, seg, along } = bridgeCells(a, b, layer);
  const plan = { layer, type, cells, axis, seg, ok: false, reason: null, heights: [], cost: 0, maxGrade: 0, spanOver: { water: 0, land: 0, cross: 0, roads: 0 }, under: new Set(), cutOff: 0 };
  const n = cells.length - 1;
  if (n < 2) { plan.reason = 'Drag farther: a bridge spans at least one cell'; return plan; }
  const [net, H] = bridgeLayers(state, layer);
  // --- validity of every cell
  for (let k = 0; k <= n; k++) {
    const [x, y] = cells[k];
    const i = idx(x, y);
    if (!inBounds(x, y) || (!anywhere && !isOwned(state, x, y))) { plan.reason = 'Part of the bridge is outside your land'; return plan; }
    const bld = state.bld[i] && state.buildings.get(state.bld[i]);
    if (bld && bld.kind !== 'zone') { plan.reason = `${bld.def.name} is in the way`; return plan; }
    const end = k === 0 || k === n;
    if (end) {
      if (state.water[i] && !allowWaterEnds) { plan.reason = 'Both ends must be on land'; return plan; }
      if (H[i]) { plan.reason = 'Ends can\'t sit on another bridge'; return plan; }
      if (layer === 'road' && state.rail[i] && !state.railH[i]) { plan.reason = 'An end is on a railway'; return plan; }
      if (layer === 'rail' && state.road[i] && !state.bridgeH[i]) { plan.reason = 'An end is on a road'; return plan; }
    } else {
      // if (net[i]) { plan.reason = layer === 'road' ? 'Road bridges can\'t pass over other roads' : layer === 'rail' ? 'The span crosses existing railway' : 'The span crosses an existing footpath'; return plan; }
      if (H[i]) { plan.reason = 'Bridges can\'t overlap'; return plan; }
      if (axis === AXIS_DIAG && net[i]) { plan.reason = 'A bridge at an angle can\'t pass over other roads'; return plan; }
      // it may run along a road (that stretch becomes bridge); a road crossing it carries on
      // underneath (an underpass). Railways and footpaths can't cross their own kind.
      if (net[i] && axis !== AXIS_DIAG) {
        const across = axis === AXIS_X ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
        if (across.some(([dx, dy]) => inBounds(x + dx, y + dy) && net[idx(x + dx, y + dy)] && linked(state, layer, i, idx(x + dx, y + dy), dx === 1 ? 0 : dx === -1 ? 2 : dy === 1 ? 1 : 3))) {
          const why = layer !== 'road' ? (layer === 'rail' ? 'A railway bridge can\'t cross another railway' : 'A footbridge can\'t cross another footpath')
            : !overRoads ? 'A road crosses it' : underpassBlocker(state, x, y, axis);
          if (why) { plan.reason = why; return plan; }
          plan.under.add(k);
        }
      }
      // something else may sit underneath only if it stays at ground level
      const under = (layer !== 'road' && state.road[i]) || (layer !== 'rail' && state.rail[i]) || (layer !== 'path' && state.path[i]);
      const underRaised = state.bridgeH[i] || state.railH[i] || state.pathH[i];
      if (underRaised) { plan.reason = 'Bridges can\'t cross other bridges'; return plan; }
      if (state.water[i]) plan.spanOver.water++;
      else if (plan.under.has(k)) plan.spanOver.roads++;
      else if (under) plan.spanOver.cross++;
      else plan.spanOver.land++;
    }
  }
  // --- deck profile: one smooth arch from end to end. It starts level with the road at each
  // end, rises just enough to clear the water (or the tracks underneath), stays level over
  // whatever passes under it and never sags in the middle, so driving onto it feels like a
  // ramp, not a step.
  const hA = endHeight(state, layer, ...cells[0]);
  const hB = endHeight(state, layer, ...cells[n]);
  const { floor, flat } = deckFloor(state, layer, cells, plan.under);
  const h = archProfile(hA, hB, floor, along, flat);
  plan.maxGrade = deckGrade(h, along);
  plan.heights = h;
  if (plan.maxGrade > MAX_BRIDGE_GRADE) { plan.reason = 'Too steep: move the ends farther apart or onto higher ground'; return plan; }
  // --- cost: ends at normal price if new, span at triple price
  const unit = layer === 'road' ? ROADS[type].cost : LAYER_COST[layer];
  for (let k = 0; k <= n; k++) {
    const i = idx(...cells[k]);
    const end = k === 0 || k === n;
    if (end) plan.cost += net[i] ? 0 : unit;
    else plan.cost += unit * 3;
  }
  plan.cost = Math.round(plan.cost);
  if (layer === 'road') plan.cutOff = cutOffBy(state, plan);
  plan.ok = true;
  return plan;
}

// Buildings that get to the road only from cells this bridge lifts off the ground (their
// driveway can't climb onto a deck): they'd be left without a road
function cutOffBy(state, plan) {
  const span = new Set();
  plan.cells.forEach(([x, y], k) => { if (k > 0 && k < plan.cells.length - 1) span.add(idx(x, y)); });
  const seen = new Set();
  let n = 0;
  for (const i of span) {
    if (!state.road[i]) continue;
    const x = i % N, y = (i / N) | 0;
    for (const [dx, dy] of DIRS) {
      if (!inBounds(x + dx, y + dy)) continue;
      const b = state.buildings.get(state.bld[idx(x + dx, y + dy)]);
      if (!b || seen.has(b.id) || b.def.inPark) continue;
      seen.add(b.id);
      let other = false;
      for (let yy = b.y0 - 1; yy <= b.y1 + 1 && !other; yy++) for (let xx = b.x0 - 1; xx <= b.x1 + 1; xx++) {
        if ((xx < b.x0 || xx > b.x1) && (yy < b.y0 || yy > b.y1)) continue;
        if (!inBounds(xx, yy) || (xx >= b.x0 && xx <= b.x1 && yy >= b.y0 && yy <= b.y1)) continue;
        const j = idx(xx, yy);
        if (state.road[j] && !state.bridgeH[j] && !span.has(j)) { other = true; break; }
      }
      if (!other) n++;
    }
  }
  return n;
}

export function buildBridge(state, plan, { free = false } = {}) {
  if (!plan.ok) return false;
  if (!free && !spend(state, plan.cost, 'bridges')) return false;
  const [net, H, dir] = bridgeLayers(state, plan.layer);
  const n = plan.cells.length - 1;
  const endsToGrade = [];
  const travel = stepDirs(plan.cells); // (one-way roads run from the start toward the end)
  plan.cells.forEach(([x, y], k) => {
    const i = idx(x, y);
    const end = k === 0 || k === n;
    if (state.bld[i]) removeBuilding(state, state.bld[i]);
    state.tree[i] = 0;
    clearZoneCell(state, i);
    if (plan.under?.has(k)) {
      // the road crossing here carries on underneath; the cell's road is the bridge now
      makeUnderpass(state, i, plan.axis);
      state.road[i] = plan.type;
      state.roadDir[i] = travel[k];
    } else if (plan.layer === 'road') {
      // road already there keeps its own type (only Replace re-surfaces road): a stretch of
      // it the bridge runs along is raised onto the deck as it is
      if (!net[i]) { state.road[i] = plan.type; state.roadDir[i] = travel[k]; }
      if (!end) state.roadCond[i] = 1;
    } else net[i] = 1;
    if (!end) { H[i] = plan.heights[k]; dir[i] = plan.axis; }
    else if (!state.water[i]) endsToGrade.push([x, y]);
  });
  if (endsToGrade.length) gradeCells(state, net, endsToGrade);
  // a bridge at an angle is drawn (and driven) along its line, like any diagonal road
  if (plan.axis === AXIS_DIAG && plan.seg) {
    state.roadSegs = state.roadSegs || [];
    state.roadSegs.push({ a: [...plan.seg.a], b: [...plan.seg.b] });
  }
  bus.emit('terrain:changed', { x0: 0, y0: 0, x1: N - 1, y1: N - 1 });
  bus.emit('network:changed', { layer: plan.layer === 'road' ? 'road' : plan.layer });
  bus.emit('xp', { amount: Math.max(3, n), reason: 'bridge' });
  return true;
}

// A road from cell a to cell b that crosses water: ordinary road on the land, and a bridge
// of the same road type over each stretch of water, from the last land cell before it to the
// first one after it. A road at an angle can only be split where its line passes exactly
// through the middle of a cell (so every piece runs along the same line); where it can't be,
// the bridge reaches further, up to the whole road. Returns null when the road stays on land,
// else { ok, reason, pieces: [{ kind: 'road' | 'bridge', a, b, plan }], cost, span }.
const gcd = (p, q) => (q ? gcd(q, p % q) : Math.abs(p));
export function planRoadCrossing(state, a, b, type) {
  const line = lineCells(a[0], a[1], b[0], b[1]);
  const wet = ([x, y]) => inBounds(x, y) && state.water[idx(x, y)] && !state.bridgeH[idx(x, y)];
  if (!line.some(wet)) return null;
  const fail = (reason) => ({ ok: false, reason, pieces: [], cost: 0, span: 0 });
  // the points it can be split at, and where each one is along its staircase of cells
  const dx = b[0] - a[0], dy = b[1] - a[1], g = gcd(Math.abs(dx), Math.abs(dy)) || 1;
  const at = new Map(line.map(([x, y], k) => [x * 1e5 + y, k]));
  const marks = [];
  for (let j = 0; j <= g; j++) { const m = [a[0] + (dx / g) * j, a[1] + (dy / g) * j]; marks.push({ m, k: at.get(m[0] * 1e5 + m[1]) }); }
  // each stretch of water, bridged from the last split point on land before it to the first after
  const spans = [];
  for (let k = 0; k < line.length; k++) {
    if (!wet(line[k])) continue;
    let e = k;
    while (e + 1 < line.length && wet(line[e + 1])) e++;
    let j0 = -1, j1 = -1;
    marks.forEach((mk, j) => {
      if (mk.k < k && !wet(mk.m)) j0 = j;
      if (mk.k > e && !wet(mk.m) && j1 < 0) j1 = j;
    });
    if (j0 < 0 || j1 < 0) return fail('A bridge needs land at both ends: start and end the road on land');
    const last = spans[spans.length - 1];
    if (last && j0 <= last[1]) last[1] = Math.max(last[1], j1); else spans.push([j0, j1]);
    k = e;
  }
  // where the banks are high, a bridge that only just spans the water would be too steep:
  // it starts further back on the land instead (a longer ramp up to it)
  const tryPlan = (j0, j1) => planBridge(state, 'road', type, { cx: marks[j0].m[0], cy: marks[j0].m[1] }, { cx: marks[j1].m[0], cy: marks[j1].m[1] });
  // does the stretch of line k0..k1 already have road on it? (it would go up onto the bridge)
  const roadIn = (k0, k1) => { for (let k = k0; k <= k1; k++) if (state.road[idx(...line[k])]) return true; return false; };
  for (let n = 0; n < spans.length; n++) {
    let [j0, j1] = spans[n];
    const lo = n ? spans[n - 1][1] : 0, hi = n + 1 < spans.length ? spans[n + 1][0] : marks.length - 1;
    for (let grow = 0; grow < 12; grow++) {
      const p = tryPlan(j0, j1);
      if (p.ok || !/steep/i.test(p.reason || '')) break;
      let canA = j0 - 1 >= lo && !wet(marks[j0 - 1].m), canB = j1 + 1 <= hi && !wet(marks[j1 + 1].m);
      if (!canA && !canB) break;
      // reach back over open land first, not over a road already there (say the bigger road
      // this one starts from): that road would end up raised onto the bridge
      const roadA = canA && roadIn(marks[j0 - 1].k + 1, marks[j0].k), roadB = canB && roadIn(marks[j1].k, marks[j1 + 1].k - 1);
      if (canA && canB && roadA !== roadB) { canA = !roadA; canB = !roadB; }
      if (canA && (grow % 2 === 0 || !canB)) j0--; else j1++;
    }
    spans[n] = [j0, j1];
  }
  const pieces = [];
  let from = 0;
  for (const [j0, j1] of spans) {
    if (j0 > from) pieces.push({ kind: 'road', a: marks[from].m, b: marks[j0].m });
    pieces.push({ kind: 'bridge', a: marks[j0].m, b: marks[j1].m });
    from = j1;
  }
  if (from < marks.length - 1) pieces.push({ kind: 'road', a: marks[from].m, b: marks[marks.length - 1].m });
  let cost = 0, span = 0;
  const unit = ROADS[type].cost;
  for (let p = 0; p < pieces.length; p++) {
    const pc = pieces[p];
    if (pc.kind === 'road') {
      pc.plan = planRoadLine(state, pc.a, pc.b, type);
      if (pc.plan.bad.length && pc.plan.diagonal) return fail('Something is in the way of the road (a steep slope, a railway or a building)');
      cost += pc.plan.cost;
      continue;
    }
    pc.plan = planBridge(state, 'road', type, { cx: pc.a[0], cy: pc.a[1] }, { cx: pc.b[0], cy: pc.b[1] });
    if (!pc.plan.ok) return { ...fail(pc.plan.reason), pieces: pieces.filter((q) => q.plan) };
    cost += pc.plan.cost;
    span += pc.plan.cells.length - 2;
    // an end shared with the road piece beside it is only paid for once
    for (const [q, e] of [[p - 1, pc.a], [p + 1, pc.b]]) if (pieces[q]?.kind === 'road' && !state.road[idx(e[0], e[1])]) cost -= unit;
  }
  return { ok: true, reason: null, pieces, cost: Math.round(cost), span };
}

export function placeRoadCrossing(state, plan, type) {
  if (!plan.ok) return { error: 'blocked' };
  if (!canAfford(state, plan.cost)) return { error: 'money' };
  for (const pc of plan.pieces) {
    if (pc.kind === 'road') placeRoadLine(state, pc.a, pc.b, type);
    else buildBridge(state, planBridge(state, 'road', type, { cx: pc.a[0], cy: pc.a[1] }, { cx: pc.b[0], cy: pc.b[1] }));
  }
  return { ok: true };
}

// Clear bridge data when a cell's track is removed
export function clearBridgeCell(state, layer, i) {
  const [, H, dir] = bridgeLayers(state, layer);
  H[i] = 0;
  dir[i] = 0;
}

// ----------------------------------------------------------------- underpasses
// Where a road bridge passes over a road, the cell's road (state.road, bridgeH, bridgeDir) is
// the bridge, and the road below is kept in state.underRoad (its type) and state.underDir (its
// one-way direction). It runs straight across, square to the bridge, and doesn't meet it:
// traffic on it goes from the ground road on one side of the deck to the other (linked like a
// tunnel, see underpassLinks), with no junction to wait at, and the bridge's traffic flies
// over. Taking the bridge down leaves the road below as it was.

// The cells either side of an underpass along the road beneath it, or null
export function underpassEnds(state, i) {
  if (!state.underRoad?.[i]) return null;
  const x = i % N, y = (i / N) | 0;
  const [dx, dy] = state.bridgeDir[i] === AXIS_Z ? [1, 0] : [0, 1];
  if (!inBounds(x - dx, y - dy) || !inBounds(x + dx, y + dy)) return null;
  return [idx(x - dx, y - dy), idx(x + dx, y + dy)];
}

// Is the step from cell a to cell b (two apart) the way under a bridge? The cell under the
// deck, or -1
export function underpassBetween(state, a, b) {
  const dx = (b % N) - (a % N), dy = ((b / N) | 0) - ((a / N) | 0);
  const m = (a + b) / 2;
  if (!(Math.abs(dx) + Math.abs(dy) === 2 && (dx === 0 || dy === 0)) || !state.underRoad?.[m]) return -1;
  return (dx !== 0) === (state.bridgeDir[m] === AXIS_Z) ? m : -1;
}

// Why a road bridge running along `axis` can't pass over the road at (x, y), or null
function underpassBlocker(state, x, y, axis) {
  const i = idx(x, y);
  const [dx, dy] = axis === AXIS_X ? [0, 1] : [1, 0];
  const sides = [[x - dx, y - dy, axis === AXIS_X ? 3 : 2], [x + dx, y + dy, axis === AXIS_X ? 1 : 0]];
  if (segIndex(state).byCell.has(i)) return 'A road bridge can only pass over roads that run square to it, not at an angle';
  for (const [sx, sy, d] of sides) {
    const j = inBounds(sx, sy) ? idx(sx, sy) : -1;
    if (j < 0 || !state.road[j] || !linked(state, 'road', i, j, d)) return `A road joins from the side at (${x}, ${y}): a bridge can only pass over a road that carries straight on under it`;
    if (state.bridgeH[j]) return 'Bridges can\'t cross other bridges';
  }
  if ((state.tunnels || []).some((t) => t.layer === 'road' && (t.a === i || t.b === i))) return `A tunnel starts at (${x}, ${y})`;
  if (state.stops?.[i]) return `A stop is at (${x}, ${y}): move it off the crossing first`;
  return null;
}

// The road crossing cell i goes under the bridge being built along `axis` there
function makeUnderpass(state, i, axis) {
  const x = i % N, y = (i / N) | 0;
  const [dx, dy] = axis === AXIS_X ? [0, 1] : [1, 0];
  const a = idx(x - dx, y - dy), b = idx(x + dx, y + dy);
  const ta = state.road[a], tb = state.road[b], t = state.road[i];
  const type = ta === tb ? ta : t === ta || t === tb ? t : ta;
  // a one-way road keeps its direction of travel (along the road under the bridge)
  const from = [i, a, b].find((j) => state.road[j] === type && (state.roadDir[j] & 1) === (dx ? 0 : 1));
  state.underRoad[i] = type;
  state.underDir[i] = ROADS[type].oneway && from != null ? state.roadDir[from] : 0;
  // upgrades on the crossing (a roundabout, lights...) have nothing left to do: half back
  let back = 0;
  for (const u of UPGRADES) if (state.roadUpg[i] & u.bit) back += u.cost;
  refund(state, back * REFUND_RATE);
  clearRoadCell(state, i);
}

// A bridge cell taken away: the road that ran under it is back on the ground
export function restoreUnderRoad(state, i) {
  const t = state.underRoad?.[i];
  if (!t) return;
  state.road[i] = t;
  state.roadDir[i] = state.underDir[i];
  state.roadCond[i] = 1;
  state.roadUpg[i] = 0;
  state.underRoad[i] = 0;
  state.underDir[i] = 0;
}

// An underpass whose road is gone from either side of the bridge is filled in (with a
// refund for it). Returns the refund.
export function pruneUnderpasses(state) {
  const U = state.underRoad;
  if (!U) return 0;
  let r = 0;
  for (let i = 0; i < N * N; i++) {
    if (!U[i]) continue;
    const ends = underpassEnds(state, i);
    if (state.road[i] && state.bridgeH[i] && ends && ends.every((j) => state.road[j] && !state.bridgeH[j])) continue;
    r += refund(state, ROADS[U[i]].cost * REFUND_RATE);
    U[i] = 0;
    state.underDir[i] = 0;
  }
  return r;
}

// For routing: the ground road either side of each underpass, linked under the deck (one way
// only on a one-way road). add(from, to, cost)
export function underpassLinks(state, add) {
  const U = state.underRoad;
  if (!U) return;
  for (let i = 0; i < N * N; i++) {
    if (!U[i]) continue;
    const ends = underpassEnds(state, i);
    if (!ends) continue;
    const [a, b] = ends;
    if (!state.road[a] || !state.road[b] || state.bridgeH[a] || state.bridgeH[b]) continue;
    const def = ROADS[U[i]];
    const c = 2 * (50 / def.speed); // two cells at the road's speed, with nothing to stop for
    const ab = b - a === 2 ? 0 : 1; // a to b runs east or south
    if (!def.oneway || state.underDir[i] === ab) add(a, b, c);
    if (!def.oneway || state.underDir[i] === ab + 2) add(b, a, c);
  }
}

// Can a straight road being drawn through bridge cell i (running east-west if alongX) pass
// under it? (the bridge must run square to it and be high enough above the ground there)
export function canPassUnder(state, i, alongX) {
  if (!state.road[i] || !state.bridgeH[i] || state.underRoad[i]) return false;
  const dir = state.bridgeDir[i];
  if (dir === AXIS_DIAG || (dir === AXIS_Z) !== alongX) return false;
  const x = i % N, y = (i / N) | 0;
  return state.bridgeH[i] - maxCorner(state, x, y) >= UNDER_CLEARANCE - 0.05 && !state.water[i];
}

// A road was drawn straight through bridge cells (line: its cells, dirs: one-way direction
// of each): where it passes square under a high enough deck, with road either side, it
// carries on underneath. Returns how many underpasses it made.
export function roadUnderBridges(state, line, type, dirs) {
  if (line.length < 3) return 0;
  const alongX = line[0][1] === line[line.length - 1][1];
  let made = 0;
  for (let k = 1; k < line.length - 1; k++) {
    const i = idx(...line[k]);
    if (!canPassUnder(state, i, alongX)) continue;
    const a = idx(...line[k - 1]), b = idx(...line[k + 1]);
    if (!state.road[a] || !state.road[b] || state.bridgeH[a] || state.bridgeH[b]) continue;
    state.underRoad[i] = type;
    state.underDir[i] = ROADS[type].oneway ? dirs[k] : 0;
    made++;
  }
  return made;
}

// Overpasses built before their deck levelled off over the road (they came to a peak there)
// get the deck the bridge tool builds now: each straight road bridge with a road under it is
// re-profiled between its two ends, where the new deck isn't too steep. Returns how many.
export function reshapeOverpasses(state) {
  const H = state.bridgeH, axis = state.bridgeDir;
  const seen = new Uint8Array(N * N);
  let changed = 0;
  for (let i = 0; i < N * N; i++) {
    if (!state.underRoad[i] || !H[i] || seen[i] || (axis[i] !== AXIS_X && axis[i] !== AXIS_Z)) continue;
    const [dx, dy] = axis[i] === AXIS_X ? [1, 0] : [0, 1];
    const deck = (x, y) => inBounds(x, y) && H[idx(x, y)] && axis[idx(x, y)] === axis[i];
    let x = i % N, y = (i / N) | 0;
    while (deck(x - dx, y - dy)) { x -= dx; y -= dy; }
    const cells = [[x - dx, y - dy]];
    for (; deck(x, y); x += dx, y += dy) { cells.push([x, y]); seen[idx(x, y)] = 1; }
    cells.push([x, y]);
    if (!cells.every(([cx, cy]) => inBounds(cx, cy) && state.road[idx(cx, cy)])) continue;
    const n = cells.length - 1;
    const under = new Set();
    for (let k = 1; k < n; k++) if (state.underRoad[idx(...cells[k])]) under.add(k);
    const { floor, flat } = deckFloor(state, 'road', cells, under);
    const h = archProfile(endHeight(state, 'road', ...cells[0]), endHeight(state, 'road', ...cells[n]), floor, null, flat);
    if (deckGrade(h) > MAX_BRIDGE_GRADE) continue;
    for (let k = 1; k < n; k++) H[idx(...cells[k])] = h[k];
    changed++;
  }
  return changed;
}

// Turn existing track over water into bridges (the starting highway and railway, and roads
// from older saves): each straight run of water cells becomes one span.
export function bridgeWaterRuns(state, layer) {
  const [net, H, dir] = bridgeLayers(state, layer);
  const done = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) {
    if (!net[i] || !state.water[i] || H[i] || done[i]) continue;
    const x = i % N, y = (i / N) | 0;
    // follow the run along whichever axis it continues
    const horiz = (inBounds(x + 1, y) && net[idx(x + 1, y)] && state.water[idx(x + 1, y)]) || (inBounds(x - 1, y) && net[idx(x - 1, y)] && state.water[idx(x - 1, y)]);
    const [sx, sy] = horiz ? [1, 0] : [0, 1];
    let a = [x, y], b = [x, y];
    while (inBounds(a[0] - sx, a[1] - sy) && net[idx(a[0] - sx, a[1] - sy)] && state.water[idx(a[0] - sx, a[1] - sy)]) a = [a[0] - sx, a[1] - sy];
    while (inBounds(b[0] + sx, b[1] + sy) && net[idx(b[0] + sx, b[1] + sy)] && state.water[idx(b[0] + sx, b[1] + sy)]) b = [b[0] + sx, b[1] + sy];
    // ends are the land cells just outside the run (or the run itself at the map edge)
    const ea = inBounds(a[0] - sx, a[1] - sy) ? [a[0] - sx, a[1] - sy] : a;
    const eb = inBounds(b[0] + sx, b[1] + sy) ? [b[0] + sx, b[1] + sy] : b;
    const hA = endHeight(state, layer, ...ea), hB = endHeight(state, layer, ...eb);
    const len = Math.max(1, Math.abs(eb[0] - ea[0]) + Math.abs(eb[1] - ea[1]));
    for (let k = 0; ; k++) {
      const cx = a[0] + sx * k, cy = a[1] + sy * k;
      const j = idx(cx, cy);
      const t = (Math.abs(cx - ea[0]) + Math.abs(cy - ea[1])) / len;
      H[j] = Math.max(hA + (hB - hA) * t, state.seaLevel + WATER_CLEARANCE);
      dir[j] = horiz ? AXIS_X : AXIS_Z;
      done[j] = 1;
      if (cx === b[0] && cy === b[1]) break;
    }
  }
}

// The outside connections a map starts with (the highway and the railway, laid straight in
// from the map edge) cross water on bridges planned like the player's own (planBridge, as in
// planRoadCrossing): each stretch of water is spanned from the land before it to the land
// after it, reaching further back over the land where the deck can't climb to the bank in
// time, in one smooth arch that leaves each end level with the track. At the map edge the
// deck simply runs on out over the water. line: the track's cells from the map edge inward.
// onlyBad: keep any crossing that already meets that (in older cities only the old flat
// spans, with a sudden ramp at each end, are rebuilt). Returns how many bridges it built.
export function bridgeConnection(state, layer, line, { onlyBad = false } = {}) {
  const [, H, dir] = bridgeLayers(state, layer);
  const at = line.map(([x, y]) => idx(x, y));
  const last = at.length - 1;
  if (last < 2) return 0;
  const type = layer === 'road' ? state.road[at[0]] : 0;
  const wet = (k) => !!state.water[at[k]];
  // each stretch of water (with any deck already over it) and the land either side of it
  const spans = [];
  for (let k = 0; k <= last; k++) {
    if (!wet(k) && !H[at[k]]) continue;
    let e = k;
    while (e < last && (wet(e + 1) || H[at[e + 1]])) e++;
    let keep = false;
    if (onlyBad) {
      // the deck from bank to bank: over all the water, and never steeper than a bridge may be
      const hs = k > 0 ? [cellHeight(state, ...line[k - 1])] : [];
      keep = true;
      for (let j = k; j <= e && keep; j++) { if (!H[at[j]]) keep = false; else hs.push(H[at[j]]); }
      if (e < last) hs.push(cellHeight(state, ...line[e + 1]));
      for (let j = 1; j < hs.length && keep; j++) if (Math.abs(hs[j] - hs[j - 1]) > MAX_BRIDGE_GRADE + 0.05) keep = false;
    }
    // (a bridge on it that crosses no water, over a valley or a road, is left as it is)
    let dry = true;
    for (let j = k; j <= e; j++) if (wet(j)) dry = false;
    const s = { k0: Math.max(0, k - 1), k1: Math.min(last, e + 1), keep: keep || dry };
    const prev = spans[spans.length - 1];
    if (prev && s.k0 <= prev.k1) { prev.k1 = s.k1; prev.keep = prev.keep && s.keep; } else spans.push(s);
    k = e;
  }
  const plan = (a, b) => planBridge(state, layer, type, { cx: line[a][0], cy: line[a][1] }, { cx: line[b][0], cy: line[b][1] }, { allowWaterEnds: true, anywhere: true, overRoads: false });
  const steep = (p) => !p.ok && /steep/i.test(p.reason || '');
  let built = 0;
  for (let n = 0; n < spans.length; n++) {
    const sp = spans[n];
    if (sp.keep) continue;
    const lo = n ? spans[n - 1].k1 : 0, hi = n + 1 < spans.length ? spans[n + 1].k0 : last;
    // clear the old deck (it's put back if no bridge can be planned)
    const old = [];
    for (let k = sp.k0; k <= sp.k1; k++) if (H[at[k]]) { old.push([at[k], H[at[k]], dir[at[k]]]); H[at[k]] = 0; dir[at[k]] = 0; }
    let { k0, k1 } = sp, blockA = false, blockB = false;
    let p = plan(k0, k1);
    for (let grow = 0; grow < 16 && steep(p); grow++) {
      const canA = !blockA && k0 - 1 >= lo && !wet(k0 - 1), canB = !blockB && k1 + 1 <= hi && !wet(k1 + 1);
      if (!canA && !canB) break;
      const toA = canA && (grow % 2 === 0 || !canB);
      const q = toA ? plan(k0 - 1, k1) : plan(k0, k1 + 1);
      if (!q.ok && !steep(q)) { if (toA) blockA = true; else blockB = true; continue; }
      p = q;
      if (toA) k0--; else k1++;
    }
    // a bank too high to reach in time still gets the smoothest arch there is
    if (!p.ok && !(steep(p) && p.heights.length)) { for (const [i, h, d] of old) { H[i] = h; dir[i] = d; } continue; }
    raiseTrack(state, layer, p);
    sp.k0 = k0; sp.k1 = k1;
    built++;
  }
  return built;
}

// Lift track that's already there onto a planned bridge. No cost and no events: map
// generation and loading call this, and refresh what they need themselves.
function raiseTrack(state, layer, plan) {
  const [net, H, dir] = bridgeLayers(state, layer);
  const n = plan.cells.length - 1;
  const ends = [];
  plan.cells.forEach(([x, y], k) => {
    const i = idx(x, y);
    // an end on dry land stays on the ground (graded level with the deck); one out in the
    // water at the map edge is part of the deck
    if ((k === 0 || k === n) && !state.water[i]) { ends.push([x, y]); return; }
    H[i] = plan.heights[k];
    dir[i] = plan.axis;
    state.tree[i] = 0;
  });
  if (ends.length) gradeCells(state, net, ends);
}

// A bridge span is only valid while both of its ends rest on ground-level track. Remove any
// span (contiguous raised cells along its axis) that has lost an end, so nothing is left
// floating in the air.
export function pruneBridges(state, layer) {
  const [net, H, dir] = bridgeLayers(state, layer);
  const seen = new Uint8Array(N * N);
  let refunded = 0;
  const drop = (run) => {
    for (const j of run) {
      refunded += refund(state, networkValue(state, layer, j) * REFUND_RATE);
      if (layer === 'road') { state.road[j] = 0; state.roadUpg[j] = 0; } else net[j] = 0;
      H[j] = 0; dir[j] = 0;
      if (layer === 'road') restoreUnderRoad(state, j); // (the road below stays)
    }
  };
  for (let i = 0; i < N * N; i++) {
    if (!H[i] || seen[i]) continue;
    const x = i % N, y = (i / N) | 0;
    if (dir[i] === AXIS_DIAG) {
      // a bridge at an angle: the raised cells along its segment need both ends on the ground
      const SG = segIndex(state);
      const sg = SG.byCell.get(i)?.[0];
      const cells = sg ? SG.cellsOf.get(sg) : null;
      if (!cells) { seen[i] = 1; drop([i]); continue; }
      const run = cells.map(([cx, cy]) => idx(cx, cy)).filter((j) => H[j] && dir[j] === AXIS_DIAG);
      for (const j of run) seen[j] = 1;
      const endOk = ([ex, ey]) => net[idx(ex, ey)] && !H[idx(ex, ey)];
      if (!endOk(cells[0]) || !endOk(cells[cells.length - 1])) drop(run);
      continue;
    }
    const [sx, sy] = dir[i] === AXIS_Z ? [0, 1] : [1, 0];
    const run = [];
    let cx = x, cy = y;
    while (inBounds(cx - sx, cy - sy) && net[idx(cx - sx, cy - sy)] && H[idx(cx - sx, cy - sy)]) { cx -= sx; cy -= sy; }
    const start = [cx, cy];
    while (inBounds(cx, cy) && net[idx(cx, cy)] && H[idx(cx, cy)]) { run.push(idx(cx, cy)); seen[idx(cx, cy)] = 1; cx += sx; cy += sy; }
    // an end is fine if it rests on ground-level track, or runs off the map edge (outside connection)
    const endOk = (ex, ey) => !inBounds(ex, ey) || (net[idx(ex, ey)] && !H[idx(ex, ey)]);
    if (endOk(start[0] - sx, start[1] - sy) && endOk(cx, cy)) continue;
    drop(run);
  }
  return refunded;
}
