// Bridges for railways and footpaths: raised spans between two chosen end points, over water,
// valleys, roads or other track below. Each bridge cell stores its deck height and its axis;
// bridge cells only connect along that axis, so a bridge running next to track never snaps
// onto it sideways. (Road bridges are raised roads of the network, sim/roadnet.js, which
// shares the deck shape, archProfile, and clearances from here.)
import { N, idx, hidx, inBounds } from '../core/grid.js';
import { cellHeight } from './mapgen.js';
import { isOwned, spend, removeBuilding, LAYER_COST, refund, networkValue, REFUND_RATE, clearZoneCell } from './build.js';
import { gradeCells } from './grade.js';
import { bus } from '../core/events.js';

export const WATER_CLEARANCE = 0.9;  // deck above the water
export const LAND_CLEARANCE = 0.05;  // deck above open ground (it can run along the bank)
export const CROSS_CLEARANCE = 1.3;  // deck above a railway or footpath it passes over
export const UNDER_CLEARANCE = 1.0;  // deck above a road passing under it
export const MAX_BRIDGE_GRADE = 0.6; // height change per cell
const AXIS_X = 1, AXIS_Z = 2;

// Layer name -> [network array, height array, axis array] (railways and footpaths: roads are
// a network of their own, sim/roadnet.js)
export function bridgeLayers(state, layer) {
  if (layer === 'path') return [state.path, state.pathH, state.pathDir];
  return [state.rail, state.railH, state.railDir];
}

// May network cells i and j (j is i's neighbour in direction d) connect?
export function linked(state, layer, i, j, d) {
  return baseLinked(state, layer, i, j, d);
}

// Bridges connect only along their axis (or, at an angle, along their line)
function baseLinked(state, layer, i, j, d) {
  const [net, , dir] = bridgeLayers(state, layer);
  if (!net[i] || !net[j]) return false;
  const di = dir[i], dj = dir[j];
  if (!di && !dj) return true;
  const axis = d === 0 || d === 2 ? AXIS_X : AXIS_Z;
  if (di && di !== axis) return false;
  if (dj && dj !== axis) return false;
  return true;
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

// Straight run of cells from a to b, snapped onto a's row or column
export function bridgeCells(a, b) {
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
// cells it stays level (flat, see archProfile): where a road, railway or footpath passes under it
function deckFloor(state, layer, cells) {
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
    return f;
  });
  return { floor, flat };
}

// layer: 'rail' | 'path'
// anywhere: the land needn't be yours (the outside railway the map starts with)
export function planBridge(state, layer, type, a, b, { allowWaterEnds = false, anywhere = false } = {}) {
  const { cells, axis } = bridgeCells(a, b);
  const plan = { layer, type, cells, axis, ok: false, reason: null, heights: [], cost: 0, maxGrade: 0, spanOver: { water: 0, land: 0, cross: 0 } };
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
      if (layer === 'rail' && state.road[i] && !state.bridgeH[i]) { plan.reason = 'An end is on a road'; return plan; }
    } else {
      if (H[i]) { plan.reason = 'Bridges can\'t overlap'; return plan; }
      // railways and footpaths can't cross their own kind
      if (net[i]) {
        const across = axis === AXIS_X ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
        if (across.some(([dx, dy]) => inBounds(x + dx, y + dy) && net[idx(x + dx, y + dy)] && linked(state, layer, i, idx(x + dx, y + dy), dx === 1 ? 0 : dx === -1 ? 2 : dy === 1 ? 1 : 3))) {
          plan.reason = layer === 'rail' ? 'A railway bridge can\'t cross another railway' : 'A footbridge can\'t cross another footpath';
          return plan;
        }
      }
      // something else may sit underneath only if it stays at ground level
      const under = (layer !== 'road' && state.road[i]) || (layer !== 'rail' && state.rail[i]) || (layer !== 'path' && state.path[i]);
      const underRaised = state.bridgeH[i] || state.railH[i] || state.pathH[i];
      if (underRaised) { plan.reason = 'Bridges can\'t cross other bridges'; return plan; }
      if (state.water[i]) plan.spanOver.water++;
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
  const { floor, flat } = deckFloor(state, layer, cells);
  const h = archProfile(hA, hB, floor, null, flat);
  plan.maxGrade = deckGrade(h);
  plan.heights = h;
  if (plan.maxGrade > MAX_BRIDGE_GRADE) { plan.reason = 'Too steep: move the ends farther apart or onto higher ground'; return plan; }
  // --- cost: ends at normal price if new, span at triple price
  const unit = LAYER_COST[layer];
  for (let k = 0; k <= n; k++) {
    const i = idx(...cells[k]);
    const end = k === 0 || k === n;
    if (end) plan.cost += net[i] ? 0 : unit;
    else plan.cost += unit * 3;
  }
  plan.cost = Math.round(plan.cost);
  plan.ok = true;
  return plan;
}

export function buildBridge(state, plan, { free = false } = {}) {
  if (!plan.ok) return false;
  if (!free && !spend(state, plan.cost, 'bridges')) return false;
  const [net, H, dir] = bridgeLayers(state, plan.layer);
  const n = plan.cells.length - 1;
  const endsToGrade = [];
  plan.cells.forEach(([x, y], k) => {
    const i = idx(x, y);
    const end = k === 0 || k === n;
    if (state.bld[i]) removeBuilding(state, state.bld[i]);
    state.tree[i] = 0;
    clearZoneCell(state, i);
    net[i] = 1;
    if (!end) { H[i] = plan.heights[k]; dir[i] = plan.axis; }
    else if (!state.water[i]) endsToGrade.push([x, y]);
  });
  if (endsToGrade.length) gradeCells(state, net, endsToGrade);
  bus.emit('terrain:changed', { x0: 0, y0: 0, x1: N - 1, y1: N - 1 });
  bus.emit('network:changed', { layer: plan.layer });
  bus.emit('xp', { amount: Math.max(3, n), reason: 'bridge' });
  return true;
}

export function clearBridgeCell(state, layer, i) {
  const [, H, dir] = bridgeLayers(state, layer);
  H[i] = 0;
  dir[i] = 0;
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

// The outside railway a map starts with (laid straight in from the map edge) crosses water on
// bridges planned like the player's own (planBridge): each stretch of water is spanned from the land before it to the land
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
  const type = 0;
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
  const plan = (a, b) => planBridge(state, layer, type, { cx: line[a][0], cy: line[a][1] }, { cx: line[b][0], cy: line[b][1] }, { allowWaterEnds: true, anywhere: true });
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
      net[j] = 0;
      H[j] = 0; dir[j] = 0;
    }
  };
  for (let i = 0; i < N * N; i++) {
    if (!H[i] || seen[i]) continue;
    const x = i % N, y = (i / N) | 0;
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
