// The road network: connection points (nodes) joined by segments. A segment is a curve
// (sim/roadgeom.js) from one node to another; where roads meet there is a node, and nowhere
// else, so two roads cross only where you join them (or, raised far enough above each other,
// pass over and under). Everything is in world units: one unit is one cell (8 m).
//
// state.roads = { nodes, segs, nextId } (saved as it is)
//   node: { id, x, z, elev, ctrl, out }
//     elev: height above the ground (0 = on the ground); ctrl: '' (decided by the roads that
//     meet there), 'lights', 'stop' or 'roundabout'; out: the end of an outside connection
//   seg:  { id, a, b, type, k: [c1x, c1z, c2x, c2z], br, upg, cond, day, toll, power, locked }
//     k: the curve's two control points (the ends are its nodes); br: a raised road (a bridge,
//     its deck in one arch from end to end); upg: upgrades (UPG bits); toll / power: where a
//     toll booth or power connector stands along it (0..1); locked: the outside connection
//     A one-way road runs from a to b.
//
// Ground roads follow the land: their height along the way is the terrain under them,
// smoothed and held to MAX_GRADE, and the ground under them is graded to it when they're
// built. Raised roads arch from end to end like any bridge (archProfile in bridges.js).
import { N, idx, hidx, inBounds } from '../core/grid.js';
import { ROADS, UPG } from '../data/roads.js';
import { bus } from '../core/events.js';
import { terrainAt, cellSlope, recomputeWater } from './mapgen.js';
import { arcTable, sampleCurve, nearestOnCurve, curveCrossings, splitCurve, straightCurve, bez, bezTan, tAtS, sAtT } from './roadgeom.js';
import { archProfile, deckGrade, WATER_CLEARANCE, LAND_CLEARANCE, CROSS_CLEARANCE, UNDER_CLEARANCE, MAX_BRIDGE_GRADE } from './bridges.js';
import { MAX_GRADE } from './grade.js';
import { isOwned, spend, refund, removeBuilding, clearZoneCell, REFUND_RATE } from './build.js';
import { writeRaster, chainCells, cellAlong } from './roadraster.js';
import { dropSpansAt } from './power.js';

export const MIN_LEN = 1;          // shortest piece of road between two nodes
export const MAX_SEG = 12;         // longer ground roads are split into pieces about this long
export const MAX_BRIDGE = 64;      // the longest span a raised road can make
export const SNAP_NODE = 0.75;     // a road ending this close to a node joins it
export const MIN_ANGLE = (25 * Math.PI) / 180; // roads can't meet at a sharper angle
export const MEET_DH = 0.6;        // roads crossing closer than this in height have to meet
const STEEP_CELL = 2.4;            // ground rougher than this across a cell can't take a road
const PROFILE_STEP = 0.5;

export const emptyRoads = () => ({ nodes: [], segs: [], nextId: 1 });
export const roadDef = (s) => ROADS[s.type];

// ------------------------------------------------------------------- the index
// Looked up constantly, so it's built once per change: nodes and segments by id, the
// segments at each node, each segment's curve (with its length, samples and the cells it runs
// through) and a coarse grid of which segments are near each part of the map.
let IX = null, ver = 0, hver = 0;
bus.on('terrain:changed', () => { hver++; });
const BUCKET = 8, BW = Math.ceil(N / BUCKET) + 2;
const bucketKey = (bx, bz) => (bz + 1) * BW + (bx + 1);

// (the cache is also checked against the network's size and id counter, so it can't go stale
// even if the network is changed some other way)
const sigOf = (R) => R.nextId * 1e6 + R.segs.length * 1e3 + R.nodes.length;
export function rn(state) {
  const R = state.roads;
  if (IX && IX.R === R && IX.ver === ver && IX.sig === sigOf(R)) return IX;
  const node = new Map(), seg = new Map(), at = new Map(), geo = new Map(), hash = new Map();
  for (const n of R.nodes) { node.set(n.id, n); at.set(n.id, []); }
  for (const s of R.segs) {
    seg.set(s.id, s);
    at.get(s.a)?.push(s.id);
    at.get(s.b)?.push(s.id);
  }
  IX = { R, ver, sig: sigOf(R), node, seg, at, geo, hash };
  for (const s of R.segs) {
    if (!node.has(s.a) || !node.has(s.b)) continue;
    const g = makeGeo(curveOf(IX, s));
    geo.set(s.id, g);
    for (let bz = Math.floor((g.box[1] - 1) / BUCKET); bz <= Math.floor((g.box[3] + 1) / BUCKET); bz++) {
      for (let bx = Math.floor((g.box[0] - 1) / BUCKET); bx <= Math.floor((g.box[2] + 1) / BUCKET); bx++) {
        const k = bucketKey(bx, bz);
        if (!hash.has(k)) hash.set(k, []);
        hash.get(k).push(s.id);
      }
    }
  }
  return IX;
}

export const curveOf = (X, s) => { const a = X.node.get(s.a), b = X.node.get(s.b); return [a.x, a.z, s.k[0], s.k[1], s.k[2], s.k[3], b.x, b.z]; };
function makeGeo(c) {
  const tab = arcTable(c);
  const pts = sampleCurve(c, tab, 0.25);
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of pts) { box[0] = Math.min(box[0], p.x); box[1] = Math.min(box[1], p.z); box[2] = Math.max(box[2], p.x); box[3] = Math.max(box[3], p.z); }
  return { c, tab, len: tab.len, pts, box, prof: null, profV: -1, chain: null };
}

// Segments with any part within r of (x, z)'s neighbourhood (coarse: check the distance yourself)
export function segsNear(state, x0, z0, x1 = x0, z1 = z0, r = 1) {
  const X = rn(state);
  const out = new Set();
  for (let bz = Math.floor((Math.min(z0, z1) - r) / BUCKET); bz <= Math.floor((Math.max(z0, z1) + r) / BUCKET); bz++) {
    for (let bx = Math.floor((Math.min(x0, x1) - r) / BUCKET); bx <= Math.floor((Math.max(x0, x1) + r) / BUCKET); bx++) {
      for (const id of X.hash.get(bucketKey(bx, bz)) || []) out.add(id);
    }
  }
  return out;
}

// The segment nearest a point (within maxD): { id, t, s, x, z, d } or null
export function nearestSeg(state, x, z, maxD = 0.6, filter = null) {
  const X = rn(state);
  let best = null;
  for (const id of segsNear(state, x, z, x, z, maxD + 1)) {
    if (filter && !filter(X.seg.get(id))) continue;
    const g = X.geo.get(id);
    if (!g || x < g.box[0] - maxD || x > g.box[2] + maxD || z < g.box[1] - maxD || z > g.box[3] + maxD) continue;
    const q = nearestOnCurve(g.c, g.tab, x, z);
    if (q.d <= maxD && (!best || q.d < best.d)) best = { id, ...q };
  }
  return best;
}

export function nearestNode(state, x, z, maxD = SNAP_NODE, filter = null) {
  const X = rn(state);
  let best = null, bd = maxD;
  for (const n of X.node.values()) {
    if (filter && !filter(n)) continue;
    const d = Math.hypot(n.x - x, n.z - z);
    if (d <= bd) { bd = d; best = n; }
  }
  return best;
}

// Direction a segment leaves a node in (unit [x, z])
export function leaveDir(X, sid, nid) {
  const s = X.seg.get(sid), g = X.geo.get(sid);
  const d = bezTan(g.c, s.a === nid ? 0 : 1);
  return s.a === nid ? d : [-d[0], -d[1]];
}

// ------------------------------------------------------------------- heights
const clampX = (v) => Math.min(N - 0.001, Math.max(0, v));
export const groundAt = (state, x, z) => terrainAt(state, clampX(x), clampX(z));
const waterAt = (state, x, z) => { const cx = Math.floor(x), cz = Math.floor(z); return inBounds(cx, cz) && state.water[idx(cx, cz)]; };

// The road surface at a node
export function nodeY(state, n) {
  const g = groundAt(state, n.x, n.z);
  return n.elev ? Math.max(g, state.seaLevel) + n.elev : g;
}

// Height along a ground road: the land under it, smoothed and held to MAX_GRADE, from hA at
// its start to hB at its end. { ss, hs, steep }
function groundProfile(state, c, tab, hA, hB) {
  const n = Math.max(1, Math.ceil(tab.len / PROFILE_STEP));
  const ss = new Float32Array(n + 1), hs = new Float32Array(n + 1), p = [0, 0];
  for (let k = 0; k <= n; k++) {
    ss[k] = (tab.len * k) / n;
    bez(c, tAtS(tab, ss[k]), p);
    hs[k] = Math.max(groundAt(state, p[0], p[1]), waterAt(state, p[0], p[1]) ? state.seaLevel + 0.1 : -Infinity);
  }
  hs[0] = hA; hs[n] = hB;
  for (let pass = 0; pass < 3; pass++) {
    const h = hs.slice();
    for (let k = 1; k < n; k++) hs[k] = (h[k - 1] + 2 * h[k] + h[k + 1]) / 4;
  }
  const G = MAX_GRADE * (tab.len / n);
  for (let it = 0; it < 4; it++) {
    for (let k = 1; k < n; k++) hs[k] = Math.min(hs[k - 1] + G, Math.max(hs[k - 1] - G, hs[k]));
    for (let k = n - 1; k > 0; k--) hs[k] = Math.min(hs[k + 1] + G, Math.max(hs[k + 1] - G, hs[k]));
  }
  return { ss, hs, steep: Math.abs(hB - hA) > MAX_GRADE * 1.08 * tab.len + 0.05 };
}

// Height along a raised road: one arch from hA to hB that clears the water, the land, and any
// railway, footpath or road under it (level over those). except: segments it may meet.
function bridgeProfile(state, c, tab, hA, hB, except = null, X = rn(state)) {
  const n = Math.max(2, Math.ceil(tab.len / PROFILE_STEP));
  const ss = new Array(n + 1), floor = new Array(n + 1).fill(-Infinity), flat = new Array(n + 1).fill(0), p = [0, 0];
  for (let k = 0; k <= n; k++) ss[k] = (tab.len * k) / n;
  for (let k = 1; k < n; k++) {
    bez(c, tAtS(tab, ss[k]), p);
    const cx = Math.floor(p[0]), cz = Math.floor(p[1]);
    let f = groundAt(state, p[0], p[1]) + LAND_CLEARANCE;
    if (inBounds(cx, cz)) {
      const i = idx(cx, cz);
      if (state.water[i]) f = Math.max(f, state.seaLevel + WATER_CLEARANCE);
      if ((state.rail[i] && !state.railH[i]) || (state.path[i] && !state.pathH[i])) { f = Math.max(f, groundAt(state, p[0], p[1]) + CROSS_CLEARANCE); flat[k] = 0.5; }
    }
    floor[k] = f;
  }
  // ground roads it passes over: level over them, high enough for traffic underneath
  const box = c.reduce((b, v, j) => (j % 2 ? [b[0], Math.min(b[1], v), b[2], Math.max(b[3], v)] : [Math.min(b[0], v), b[1], Math.max(b[2], v), b[3]]), [Infinity, Infinity, -Infinity, -Infinity]);
  for (const id of segsNear(state, box[0], box[1], box[2], box[3], 1)) {
    if (except?.has(id)) continue;
    const s = X.seg.get(id), g = X.geo.get(id);
    if (!g || s.br) continue;
    for (const x of curveCrossings(c, tab, g.c, g.tab, 0)) {
      const sAt = sAtT(tab, x.ta), under = segY(state, id, sAtT(g.tab, x.tb));
      for (let k = 1; k < n; k++) {
        if (Math.abs(ss[k] - sAt) > 0.9) continue;
        floor[k] = Math.max(floor[k], under + UNDER_CLEARANCE);
        flat[k] = Math.max(flat[k], 0.5);
      }
    }
  }
  const hs = archProfile(hA, hB, floor, ss, flat);
  return { ss: Float32Array.from(ss), hs: Float32Array.from(hs), steep: deckGrade(hs, ss) > MAX_BRIDGE_GRADE + 1e-3, floor };
}

export const profileAt = (prof, s) => {
  const { ss, hs } = prof;
  const n = ss.length - 1;
  if (s <= 0) return hs[0];
  if (s >= ss[n]) return hs[n];
  const k = Math.min(n - 1, Math.floor((s / ss[n]) * n));
  const f = (s - ss[k]) / Math.max(1e-9, ss[k + 1] - ss[k]);
  return hs[k] + (hs[k + 1] - hs[k]) * f;
};

// A segment's height profile (cached until the network or the terrain changes)
export function profileOf(state, sid) {
  const X = rn(state);
  const g = X.geo.get(sid), s = X.seg.get(sid);
  if (g.prof && g.profV === hver) return g.prof;
  const hA = nodeY(state, X.node.get(s.a)), hB = nodeY(state, X.node.get(s.b));
  g.prof = s.br ? bridgeProfile(state, g.c, g.tab, hA, hB, new Set([sid]), X) : groundProfile(state, g.c, g.tab, hA, hB);
  g.profV = hver;
  return g.prof;
}
// Road surface height s along segment sid
export const segY = (state, sid, s) => profileAt(profileOf(state, sid), s);

// --------------------------------------------------------------- committing
// After any change: the index and the per-cell layers are rebuilt, and everyone is told.
export function commitRoads(state, { silent = false } = {}) {
  ver++;
  hver++;
  const X = rn(state);
  writeRaster(state, X, (s, along) => segY(state, s.id, along));
  if (!silent) bus.emit('network:changed', { layer: 'road' });
}

function addNode(state, x, z, elev = 0) {
  const R = state.roads;
  const n = { id: R.nextId++, x, z, elev, ctrl: '' };
  R.nodes.push(n);
  ver++;
  return n;
}

// Split segment sid at parameter t: the first part keeps the segment's id. Returns the new node.
export function splitSeg(state, sid, t) {
  const X = rn(state);
  const s = X.seg.get(sid), g = X.geo.get(sid);
  const [c1, c2] = splitCurve(g.c, t);
  const R = state.roads;
  const ground = groundAt(state, c1[6], c1[7]);
  const elev = s.br ? Math.max(0, segY(state, sid, sAtT(g.tab, t)) - Math.max(ground, state.seaLevel)) : 0;
  const n = addNode(state, c1[6], c1[7], elev);
  const s2 = { ...s, id: R.nextId++, a: n.id, b: s.b, k: [c2[2], c2[3], c2[4], c2[5]] };
  s.b = n.id;
  s.k = [c1[2], c1[3], c1[4], c1[5]];
  for (const key of ['toll', 'power']) {
    if (s[key] == null) continue;
    if (s[key] > t) { s2[key] = (s[key] - t) / (1 - t); delete s[key]; } else { s[key] = s[key] / t; delete s2[key]; }
  }
  R.segs.push(s2);
  ver++;
  return n;
}

// ------------------------------------------------------------------- planning
// What drawing a road from a to b would do, without doing it.
//   spec: { a, b, k (control points, or null for straight), type, bridge, anywhere, waterEnds }
//   a, b: { x, z, node?, seg? } (a point; a node it joins; or a segment it joins partway along)
// Returns { ok, reason, cost, len, c, pieces, points, demolish, bad }
//   pieces: the new segments, in order along the road ({ c, tab, br, prof, a, b (point indices) })
//   points: where they start and end ({ kind: 'node' | 'split' | 'new', ... })
export function planRoad(state, spec) {
  const X = rn(state);
  const def = ROADS[spec.type];
  const fail = (reason, extra = {}) => ({ ok: false, reason, cost: 0, len: 0, pieces: [], points: [], bad: [], ...extra });
  const A = resolveEnd(state, X, spec.a), B = resolveEnd(state, X, spec.b);
  if (A.kind === 'node' && B.kind === 'node' && A.id === B.id) return fail('Too short');
  const c = spec.k ? [A.x, A.z, spec.k[0], spec.k[1], spec.k[2], spec.k[3], B.x, B.z] : straightCurve(A.x, A.z, B.x, B.z);
  const tab = arcTable(c);
  const len = tab.len;
  if (len < MIN_LEN) return fail('Too short');
  const samples = sampleCurve(c, tab, 0.25);
  if (samples.some((p) => p.x < 0 || p.z < 0 || p.x > N || p.z > N)) return fail('Off the map');
  if (A.kind === 'node' && B.kind === 'node' && X.at.get(A.id).some((id) => { const s = X.seg.get(id); return (s.a === B.id || s.b === B.id) && Math.abs(X.geo.get(id).len - len) < 0.3; })) return fail('There is already a road here');
  for (const E of [A, B]) if (E.kind === 'split' && X.seg.get(E.seg).br) return fail('Roads can only join a bridge at its ends');

  // --- where it crosses other roads
  const near = segsNear(state, Math.min(...samples.map((p) => p.x)), Math.min(...samples.map((p) => p.z)), Math.max(...samples.map((p) => p.x)), Math.max(...samples.map((p) => p.z)), 1);
  const endSegs = new Set();
  for (const E of [A, B]) {
    if (E.kind === 'node') for (const id of X.at.get(E.id)) endSegs.add(id);
    if (E.kind === 'split') endSegs.add(E.seg);
  }
  const crossings = [];
  for (const id of near) {
    const g = X.geo.get(id);
    if (!g) continue;
    for (const x of curveCrossings(c, tab, g.c, g.tab, 0)) {
      const s = sAtT(tab, x.ta);
      // (where it starts or ends on that road, that's the end's own junction)
      if (endSegs.has(id) && (s < 0.35 || s > len - 0.35)) continue;
      const sb = sAtT(g.tab, x.tb), seg = X.seg.get(id);
      let at;
      if (sb < SNAP_NODE) at = { kind: 'node', id: seg.a };
      else if (g.len - sb < SNAP_NODE) at = { kind: 'node', id: seg.b };
      else at = { kind: 'split', seg: id, t: x.tb };
      if (at.kind === 'node') { const n = X.node.get(at.id); Object.assign(at, { x: n.x, z: n.z }); } else Object.assign(at, { x: x.x, z: x.z });
      crossings.push({ s, ta: x.ta, seg: id, sb, at, h: segY(state, id, sb), br: !!seg.br });
    }
  }
  // the same node reached through several of its roads counts once
  crossings.sort((p, q) => p.s - q.s);
  const xs = [];
  for (const x of crossings) {
    const prev = xs[xs.length - 1];
    if (prev && x.at.kind === 'node' && prev.at.kind === 'node' && prev.at.id === x.at.id) continue;
    if (prev && Math.abs(prev.s - x.s) < 0.05 && prev.at.kind === 'node' && x.at.kind === 'node' && prev.at.id === x.at.id) continue;
    xs.push(x);
  }

  // --- water: the stretches over it are raised (a bridge from bank to bank)
  const wet = samples.map((p) => waterAt(state, p.x, p.z));
  const spans = [];
  if (spec.bridge) spans.push([0, len]);
  else {
    for (let k = 0; k < samples.length; k++) {
      if (!wet[k]) continue;
      let e = k;
      while (e + 1 < samples.length && wet[e + 1]) e++;
      spans.push([Math.max(0, samples[k].s - 0.6), Math.min(len, samples[e].s + 0.6)]);
      k = e;
    }
    if ((wet[0] || wet[wet.length - 1]) && !spec.waterEnds) return fail('Start and end the road on land (it bridges the water in between)');
  }
  const merge = () => { for (let k = 1; k < spans.length; k++) if (spans[k][0] - spans[k - 1][1] < 2) { spans[k - 1][1] = Math.max(spans[k - 1][1], spans[k][1]); spans.splice(k--, 1); } };
  merge();
  // (a bridge too steep to reach its banks in time reaches further back over the land)
  const grow = spec._grow || spans.map(() => [0, 0]);
  spans.forEach((sp, j) => { if (grow[j]) { sp[0] = Math.max(0, sp[0] - grow[j][0]); sp[1] = Math.min(len, sp[1] + grow[j][1]); } });
  merge();
  for (const sp of spans) { if (sp[0] < MIN_LEN) sp[0] = 0; if (len - sp[1] < MIN_LEN) sp[1] = len; }

  // junctions along it: where it crosses a ground road off its bridges (raised parts pass over)
  const onSpan = (s) => spans.some(([a, b]) => s > a + 0.05 && s < b - 0.05);
  const junctions = xs.filter((x) => !onSpan(x.s));
  for (const x of xs) if (onSpan(x.s) && x.br) return fail('Crosses a bridge');
  // a bridge can't end right on a junction's doorstep: pull its ends back off them
  for (const sp of spans) {
    for (const j of junctions) {
      if (j.s > sp[0] - MIN_LEN && j.s <= sp[0]) sp[0] = Math.max(0, j.s);
      if (j.s < sp[1] + MIN_LEN && j.s >= sp[1]) sp[1] = Math.min(len, j.s);
    }
  }

  // --- the pieces between junctions and bridge ends
  const marks = [{ s: 0, end: A }, { s: len, end: B }];
  for (const j of junctions) marks.push({ s: j.s, end: j.at, cross: j });
  for (const [a, b] of spans) { marks.push({ s: a }); marks.push({ s: b }); }
  marks.sort((p, q) => p.s - q.s);
  const pts = [];
  for (const mk of marks) {
    const last = pts[pts.length - 1];
    if (last && mk.s - last.s < 1e-3) { if (mk.end && !last.end) last.end = mk.end; if (mk.cross) last.cross = mk.cross; continue; }
    pts.push({ ...mk });
  }
  for (let k = 1; k < pts.length; k++) if (pts[k].s - pts[k - 1].s < MIN_LEN - 1e-3) return fail(pts[k].cross || pts[k - 1].cross ? 'Too close to a junction' : 'Too short');
  // check the angles roads meet at
  for (const p of pts) {
    if (!p.end) continue;
    const t = tAtS(tab, p.s), d = bezTan(c, t);
    const outs = [];
    if (p.s > 1e-3) outs.push([-d[0], -d[1]]);
    if (p.s < len - 1e-3) outs.push(d);
    const others = [];
    if (p.end.kind === 'node') for (const id of X.at.get(p.end.id)) others.push(leaveDir(X, id, p.end.id));
    if (p.end.kind === 'split') { const g = X.geo.get(p.end.seg); const e = bezTan(g.c, p.end.t); others.push(e, [-e[0], -e[1]]); }
    for (const o of outs) for (const e of others) if (Math.acos(Math.max(-1, Math.min(1, o[0] * e[0] + o[1] * e[1]))) < MIN_ANGLE) return fail('Roads can\'t meet at such a sharp angle');
  }
  // heights where the pieces start and end
  for (const p of pts) {
    const e = p.end;
    const at = bez(c, tAtS(tab, p.s));
    if (e?.kind === 'node') p.h = nodeY(state, X.node.get(e.id));
    else if (e?.kind === 'split') p.h = segY(state, e.seg, sAtT(X.geo.get(e.seg).tab, e.t));
    else if (waterAt(state, at[0], at[1])) p.h = state.seaLevel + WATER_CLEARANCE;
    else p.h = groundAt(state, at[0], at[1]);
    p.x = at[0]; p.z = at[1];
  }
  const pieces = [];
  for (let k = 1; k < pts.length; k++) {
    const s0 = pts[k - 1].s, s1 = pts[k].s, mid = (s0 + s1) / 2;
    const br = spans.some(([a, b]) => mid > a && mid < b);
    const n = br ? 1 : Math.max(1, Math.ceil((s1 - s0) / MAX_SEG - 1e-6));
    if (br && s1 - s0 > MAX_BRIDGE) return fail(`Too long for a bridge (at most ${MAX_BRIDGE} cells)`);
    for (let j = 0; j < n; j++) pieces.push({ s0: s0 + ((s1 - s0) * j) / n, s1: s0 + ((s1 - s0) * (j + 1)) / n, br, pa: k - 1, pb: k, split: j });
  }
  // break points inside long ground stretches get their own nodes
  const P = [];
  const pointAt = (s) => {
    let p = pts.find((q) => Math.abs(q.s - s) < 1e-4);
    if (!p) { const at = bez(c, tAtS(tab, s)); p = { s, x: at[0], z: at[1], h: groundAt(state, at[0], at[1]) }; pts.push(p); }
    if (!P.includes(p)) P.push(p);
    return p;
  };
  const except = new Set(endSegs);
  for (const j of junctions) except.add(j.seg);
  let cost = 0;
  const demolish = new Set(), bad = [];
  for (const pc of pieces) {
    const pa = pointAt(pc.s0), pb = pointAt(pc.s1);
    const ta = tAtS(tab, pc.s0), tb = tAtS(tab, pc.s1);
    let sub = c;
    if (tb < 1 - 1e-9) sub = splitCurve(sub, tb)[0];
    if (ta > 1e-9) sub = splitCurve(sub, ta / tb)[1];
    sub[0] = pa.x; sub[1] = pa.z; sub[6] = pb.x; sub[7] = pb.z;
    const st = arcTable(sub);
    pc.c = sub; pc.tab = st; pc.a = pa; pc.b = pb;
    pc.prof = pc.br ? bridgeProfile(state, sub, st, pa.h, pb.h, except, X) : groundProfile(state, sub, st, pa.h, pb.h);
    if (pc.prof.steep && pc.br && !spec.bridge && (spec._tries || 0) < 16) {
      const j = spans.findIndex(([a, b]) => pc.s0 >= a - 1e-6 && pc.s1 <= b + 1e-6);
      if (j >= 0 && (spans[j][0] > 0 || spans[j][1] < len)) {
        const g2 = spans.map((_, k) => [...(grow[k] || [0, 0])]);
        const toStart = spans[j][0] > 0 && ((spec._tries || 0) % 2 === 0 || spans[j][1] >= len);
        g2[j][toStart ? 0 : 1] += 1;
        return planRoad(state, { ...spec, _grow: g2, _tries: (spec._tries || 0) + 1 });
      }
    }
    if (pc.prof.steep) return fail(pc.br ? 'Too steep: the bridge can\'t climb that high in time (start it further back)' : 'Too steep for a road', { pieces });
    cost += st.len * def.cost * (pc.br ? 3 : 1);
    // what's in the way
    pc.chain = chainCells(sub, st);
    const { cells } = pc.chain;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k];
      if (i < 0) continue;
      const x = i % N, y = (i / N) | 0;
      if (state.road[i] && (k < 2 || k > cells.length - 3)) continue; // the roads it joins
      const b = state.bld[i] && state.buildings.get(state.bld[i]);
      const inner = k > 0 && k < cells.length - 1;
      let blocked = !spec.anywhere && !isOwned(state, x, y);
      if (b && b.kind !== 'zone') blocked = true;
      if (state.power[i]) blocked = true;
      if (!pc.br && state.rail[i] && !state.railH[i]) blocked = true;
      if (!pc.br && !state.water[i] && cellSlope(state, x, y) > STEEP_CELL && !state.road[i]) blocked = true;
      if (!pc.br && state.water[i] && inner) blocked = true;
      if (blocked) bad.push([x, y]);
      else if (b && b.kind === 'zone' && (!pc.br || state.bridgeH[i] === 0)) demolish.add(b.id);
    }
  }
  // running along another road (not crossing it, not joining it)
  const stops = [0, len, ...junctions.map((j) => j.s)];
  for (const p of samples) {
    if (stops.some((s) => Math.abs(s - p.s) < 1.5)) continue;
    const q = nearestSeg(state, p.x, p.z, 0.45, (s) => !except.has(s.id));
    if (!q) continue;
    const here = pieces.find((pc) => p.s >= pc.s0 - 1e-6 && p.s <= pc.s1 + 1e-6);
    const h = here ? profileAt(here.prof, p.s - here.s0) : groundAt(state, p.x, p.z);
    if (Math.abs(h - segY(state, q.id, q.s)) < UNDER_CLEARANCE) return fail('Runs into another road', { pieces });
  }
  const plan = { ok: !bad.length, reason: bad.length ? 'Something is in the way (a building, railway, power line, steep slope or land you don\'t own)' : null, cost: Math.round(cost), len, c, tab, pieces, points: P, ends: [A, B], demolish: [...demolish], bad, type: spec.type, bridge: !!spec.bridge, spans };
  return plan;
}

// An end of a road being drawn: an existing node, a point partway along a segment, or new
function resolveEnd(state, X, p) {
  if (p.node != null && X.node.has(p.node)) { const n = X.node.get(p.node); return { kind: 'node', id: n.id, x: n.x, z: n.z }; }
  if (p.seg != null && X.seg.has(p.seg)) {
    const s = X.seg.get(p.seg), g = X.geo.get(p.seg);
    const q = nearestOnCurve(g.c, g.tab, p.x, p.z);
    if (q.s < SNAP_NODE) { const n = X.node.get(s.a); return { kind: 'node', id: n.id, x: n.x, z: n.z }; }
    if (g.len - q.s < SNAP_NODE) { const n = X.node.get(s.b); return { kind: 'node', id: n.id, x: n.x, z: n.z }; }
    return { kind: 'split', seg: p.seg, t: q.t, x: q.x, z: q.z };
  }
  const n = nearestNode(state, p.x, p.z, 0.05);
  if (n) return { kind: 'node', id: n.id, x: n.x, z: n.z };
  return { kind: 'new', x: p.x, z: p.z };
}

// --------------------------------------------------------------------- building
// Build a planned road. free: no cost (map generation). Returns { ok, segs } or { error }.
export function buildRoad(state, plan, { free = false, silent = false } = {}) {
  if (!plan.ok) return { error: plan.reason };
  if (!free && !spend(state, plan.cost, 'roads')) return { error: 'money' };
  for (const id of plan.demolish) if (state.buildings.has(id)) removeBuilding(state, id);
  // nodes for every point: existing ones, new ones, or splits of the roads it joins (several
  // splits of one road go from its far end back, so the first part keeps its id and shape)
  const splits = new Map();
  for (const p of plan.points) {
    const e = p.end;
    if (e?.kind === 'node') p.node = e.id;
    else if (e?.kind === 'split') { if (!splits.has(e.seg)) splits.set(e.seg, []); splits.get(e.seg).push(p); }
  }
  for (const [sid, list] of splits) {
    list.sort((p, q) => q.end.t - p.end.t);
    let scale = 1;
    for (const p of list) {
      const n = splitSeg(state, sid, p.end.t / scale);
      scale = p.end.t;
      p.node = n.id;
      p.x = n.x; p.z = n.z;
    }
  }
  for (const p of plan.points) {
    if (p.node != null) continue;
    const g = groundAt(state, p.x, p.z);
    const elev = p.h > Math.max(g, state.seaLevel) + 0.05 && (waterAt(state, p.x, p.z) || plan.bridge) ? p.h - Math.max(g, state.seaLevel) : 0;
    p.node = addNode(state, p.x, p.z, elev).id;
  }
  const R = state.roads, day = state.time?.day ?? 0;
  const made = [];
  for (const pc of plan.pieces) {
    const a = pc.a.node, b = pc.b.node;
    const na = R.nodes.find((n) => n.id === a), nb = R.nodes.find((n) => n.id === b);
    // (the curve's ends sit exactly on its nodes)
    const c = pc.c.slice();
    c[0] = na.x; c[1] = na.z; c[6] = nb.x; c[7] = nb.z;
    const s = { id: R.nextId++, a, b, type: plan.type, k: [c[2], c[3], c[4], c[5]], br: pc.br ? 1 : 0, upg: 0, cond: 1, day };
    R.segs.push(s);
    made.push(s.id);
  }
  ver++;
  // the land under it: zoning and trees cleared, the ground graded to the road
  for (const pc of plan.pieces) {
    if (pc.br) continue;
    for (const i of pc.chain.cells) {
      if (i < 0) continue;
      clearZoneCell(state, i);
      state.tree[i] = 0;
      state.forestMax[i] = 0;
    }
  }
  commitRoads(state, { silent: true });
  const r = gradeUnder(state, made);
  if (r) { recomputeWater(state, r.x0, r.y0, r.x1, r.y1); bus.emit('terrain:changed', r); }
  commitRoads(state, { silent });
  if (!free) bus.emit('xp', { amount: Math.max(1, Math.round(plan.len * 0.4)), reason: 'roads' });
  return { ok: true, segs: made };
}

// Grade the ground under these segments (and around them) to their surface: corners near a
// road are set to its height, those a little further out cut back down to just above it.
// Ground shared with buildings, water, railways, footpaths and pylons is left alone.
const BAND = 0.8, REACH = 1.75;
export function gradeUnder(state, sids) {
  const X = rn(state);
  const H = state.height;
  let x0 = N, z0 = N, x1 = 0, z1 = 0;
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const id of sids) {
    const s = X.seg.get(id), g = X.geo.get(id);
    if (!s || s.br || !g) continue;
    box[0] = Math.min(box[0], g.box[0]); box[1] = Math.min(box[1], g.box[1]); box[2] = Math.max(box[2], g.box[2]); box[3] = Math.max(box[3], g.box[3]);
  }
  if (box[0] > box[2]) return null;
  const keep = (x, y) => {
    if (!inBounds(x, y)) return false;
    const j = idx(x, y);
    return state.water[j] || state.bld[j] || state.rail[j] || state.path[j] || state.power[j];
  };
  const ground = [...segsNear(state, box[0], box[1], box[2], box[3], REACH + 1)].filter((id) => !X.seg.get(id).br);
  const targets = [];
  for (let cz = Math.max(0, Math.floor(box[1] - REACH)); cz <= Math.min(N, Math.ceil(box[3] + REACH)); cz++) {
    for (let cx = Math.max(0, Math.floor(box[0] - REACH)); cx <= Math.min(N, Math.ceil(box[2] + REACH)); cx++) {
      if (keep(cx - 1, cz - 1) || keep(cx, cz - 1) || keep(cx - 1, cz) || keep(cx, cz)) continue;
      let best = null;
      for (const id of ground) {
        const g = X.geo.get(id);
        if (cx < g.box[0] - REACH || cx > g.box[2] + REACH || cz < g.box[1] - REACH || cz > g.box[3] + REACH) continue;
        let bd = Infinity, bs = 0;
        for (const p of g.pts) { const d = (p.x - cx) ** 2 + (p.z - cz) ** 2; if (d < bd) { bd = d; bs = p.s; } }
        bd = Math.sqrt(bd);
        if (bd <= REACH && (!best || bd < best.d)) best = { d: bd, id, s: bs };
      }
      if (best) targets.push([cx, cz, best.d, segY(state, best.id, best.s)]);
    }
  }
  for (const [cx, cz, d, target] of targets) {
    const hi = hidx(cx, cz);
    const h = d <= BAND ? target : Math.min(H[hi], target + (d - BAND) * 0.15);
    if (Math.abs(h - H[hi]) < 1e-5) continue;
    H[hi] = h;
    x0 = Math.min(x0, cx); z0 = Math.min(z0, cz); x1 = Math.max(x1, cx); z1 = Math.max(z1, cz);
  }
  return x0 <= x1 ? { x0: Math.max(0, x0 - 1), y0: Math.max(0, z0 - 1), x1: Math.min(N - 1, x1), y1: Math.min(N - 1, z1) } : null;
}

// ------------------------------------------------------------------- changing
// What a segment is worth (what it cost to build)
export const segValue = (state, sid) => {
  const X = rn(state);
  const s = X.seg.get(sid);
  return s ? X.geo.get(sid).len * ROADS[s.type].cost * (s.br ? 3 : 1) : 0;
};

// Remove a segment (and any node it leaves with no roads). Returns { refund } or null.
export function removeSeg(state, sid, { pay = true, silent = false } = {}) {
  const X = rn(state);
  const s = X.seg.get(sid);
  if (!s || s.locked) return null;
  const r = pay ? refund(state, segValue(state, sid) * REFUND_RATE) : 0;
  const R = state.roads;
  // (wires that came down to its power connector come down with it)
  const cc = s.power != null ? connectorCell(state, s) : -1;
  R.segs = R.segs.filter((q) => q !== s);
  const used = new Set();
  for (const q of R.segs) { used.add(q.a); used.add(q.b); }
  R.nodes = R.nodes.filter((n) => used.has(n.id) || n.out);
  commitRoads(state, { silent });
  if (cc >= 0) dropSpansAt(state, [cc]);
  return { refund: r };
}

// The cell a segment's power connector stands on
export function connectorCell(state, s) {
  const X = rn(state);
  const g = X.geo.get(s.id);
  if (!g || s.power == null) return -1;
  if (!g.chain) g.chain = chainCells(g.c, g.tab);
  const k = cellAlong(g.chain, s.power * g.len);
  return k >= 0 ? g.chain.cells[k] : -1;
}

// Change a segment to another road type: what it costs (negative = a refund)
export function retypeCost(state, sid, type) {
  const X = rn(state);
  const s = X.seg.get(sid);
  if (!s || s.type === type) return 0;
  const len = X.geo.get(sid).len, k = s.br ? 3 : 1;
  return Math.round(Math.max(ROADS[type].cost * k * len - ROADS[s.type].cost * k * len * 0.5, ROADS[type].cost * k * len * 0.25));
}
export function retypeSeg(state, sid, type, { silent = false } = {}) {
  const X = rn(state);
  const s = X.seg.get(sid);
  if (!s || s.type === type || s.locked) return false;
  if (!spend(state, retypeCost(state, sid, type), 'roads')) return false;
  s.type = type;
  s.cond = 1;
  if (!ROADS[type].zonable) s.upg = (s.upg || 0) & ~1;
  commitRoads(state, { silent });
  return true;
}

// Turn a one-way road around
export function reverseSeg(state, sid) {
  const X = rn(state);
  const s = X.seg.get(sid);
  if (!s || s.locked) return false;
  [s.a, s.b] = [s.b, s.a];
  s.k = [s.k[2], s.k[3], s.k[0], s.k[1]];
  for (const key of ['toll', 'power']) if (s[key] != null) s[key] = 1 - s[key];
  commitRoads(state);
  return true;
}

// An upgrade set (or taken off) through a cell, for code that still thinks in cells: street
// trees, lights, barriers, bus lanes and tram tracks go on the whole road through the cell; a
// roundabout on the junction there; a toll booth or power connector at that point on the road.
const SEG_BITS = UPG.TREES | UPG.LIGHTS | UPG.BARRIER | UPG.BUSLANE | UPG.TRAM;
export function setCellUpgrade(state, i, bit, on, { silent = false } = {}) {
  const X = rn(state);
  const x = i % N, z = (i / N) | 0;
  if (bit === UPG.ROUNDABOUT) {
    const n = [...X.node.values()].find((nd) => Math.floor(nd.x) === x && Math.floor(nd.z) === z && (X.at.get(nd.id)?.length || 0) >= 3);
    if (!n) return false;
    n.ctrl = on ? 'roundabout' : '';
  } else {
    const s = segAtCell(state, i);
    if (!s) return false;
    if (bit & SEG_BITS) s.upg = on ? (s.upg || 0) | bit : (s.upg || 0) & ~bit;
    else {
      const key = bit === UPG.TOLL ? 'toll' : bit === UPG.POWER ? 'power' : null;
      if (!key) return false;
      if (on) { const g = X.geo.get(s.id); s[key] = nearestOnCurve(g.c, g.tab, x + 0.5, z + 0.5).s / g.len; } else delete s[key];
    }
  }
  commitRoads(state, { silent });
  return true;
}

// The segment under a cell (for code that still thinks in cells)
export const segAtCell = (state, i) => (state.roadSeg?.[i] ? rn(state).seg.get(state.roadSeg[i]) || null : null);

// Point on a segment s along it, and the direction there
export function pointOn(state, sid, s) {
  const g = rn(state).geo.get(sid);
  const t = tAtS(g.tab, s);
  return { p: bez(g.c, t), d: bezTan(g.c, t) };
}
export { sAtT, tAtS };
