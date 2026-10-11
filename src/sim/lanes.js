// Lanes: where the vehicles you see drive on the road network. Traffic keeps to the right.
//
// Junctions: where roads meet, each road is cut back from the node (the "trim") and the gap
// is one junction surface (drawn by world/roadsView.js, laid out here so the vehicles stop at
// the same line the road is drawn to). A roundabout cuts its roads back further, round an
// island. At a junction the roads coming in are split into two groups by the way they point
// (the traffic lights switch between the groups; traffic in one group doesn't cross the other).
//
// A trip is a list of legs: along a road in one lane (an edge leg), then through a junction
// on a curve from the lane it came in on to the lane it leaves on (a junction leg), and so on.
// Positions along an edge leg are "stations": the distance along that road from the junction
// it starts at, so every vehicle on the same lane of the same road can be compared. A vehicle
// picks its lane by its next turn: the kerb lane to turn right, the inside lane to turn left
// (and changes lanes in the middle of the road). Buses keep to the kerb; trams run on their
// tracks in the inside lane.
import { ROADS, rankOf } from '../data/roads.js';
import { clamp } from '../core/grid.js';
import { rn, segY, leaveDir, openAt } from './roadnet.js';
import { bez, bezTan, tAtS } from './roadgeom.js';
import { graph } from './roadgraph.js';

// The kerb-to-kerb width of a road and of its asphalt
export const roadWidth = (def) => (def.key === 'gravel' ? 0.8 : 1);
export const asphaltWidth = (def) => def.width * 0.82;
// How far right of the road's centre line a lane runs, for traffic going the way it's driven
// (lane 0 is the kerb lane; a one-way road's lanes span the whole road)
export function laneOffset(def, lane) {
  const w = def.width * 0.41, L = def.lanes, l = Math.min(lane, L - 1);
  return def.oneway ? -w + (2 * w * (L - l - 0.5)) / L : (w * (L - l - 0.5)) / L + 0.02;
}
export const tramLane = (def) => def.lanes - 1;
// A roundabout: its island's radius, the radius its traffic drives round at, and how far its
// roads are cut back
export const ROUND = { island: 0.4, ring: 0.68, trim: 1.12 };

// ------------------------------------------------------------- junction layout
// For each node: how far back each road meeting there is cut (by segment end), and the
// outline of the junction surface between them. Roads are taken anticlockwise round the
// node; between each road and the next, their facing kerbs meet (if the gap between them is
// less than a half turn), and that's how far both are cut back.
//   trims: `${seg}:${node}` -> distance cut back; shapes: [{ n, ends, cap, round }]
//   grp: `${seg}:${node}` -> 0 or 1 (which way it points); split: node -> share of a traffic
//   light's cycle the first group gets; round: nodes that are roundabouts
export function junctionLayout(state) {
  const X = rn(state);
  if (X.jl) return X.jl;
  const trims = new Map(), shapes = [], grp = new Map(), split = new Map(), round = new Set();
  for (const n of X.node.values()) {
    const ends = (X.at.get(n.id) || []).filter((id) => X.geo.has(id)).map((id) => {
      const d = leaveDir(X, id, n.id);
      const def = ROADS[X.seg.get(id).type];
      return { id, d, ang: Math.atan2(d[1], d[0]), w: roadWidth(def) / 2, a: asphaltWidth(def) / 2, def, trim: 0 };
    });
    if (!ends.length) continue;
    ends.sort((p, q) => p.ang - q.ang);
    if (ends.length === 1) { shapes.push({ n, ends, cap: true }); continue; }
    // a road carrying straight on through (two pieces in line) needs no junction
    if (ends.length === 2 && ends[0].d[0] * ends[1].d[0] + ends[0].d[1] * ends[1].d[1] < -0.996) continue;
    const m = ends.length;
    for (let k = 0; k < m; k++) {
      const e = ends[k], f = ends[(k + 1) % m];
      const x = edgeMeet(e, f, e.w, f.w);
      if (!x) continue;
      e.trim = Math.max(e.trim, x[0]);
      f.trim = Math.max(f.trim, x[1]);
    }
    const isRound = n.ctrl === 'roundabout' && m >= 3;
    for (const e of ends) {
      const most = Math.min(3, X.geo.get(e.id).len * 0.45);
      e.trim = clamp(e.trim + 0.08, m > 2 ? e.w * 0.9 : 0.05, most);
      if (isRound) e.trim = Math.max(e.trim, Math.min(ROUND.trim, most));
      trims.set(`${e.id}:${n.id}`, e.trim);
    }
    if (isRound) round.add(n.id);
    if (m >= 3) groups(n, ends, grp, split);
    shapes.push({ n, ends, round: isRound });
  }
  X.jl = { trims, shapes, grp, split, round };
  return X.jl;
}

// The roads into a junction in two groups: those in line with its biggest road, and the rest
function groups(n, ends, grp, split) {
  let main = ends[0];
  for (const e of ends) if (e.def.capacity > main.def.capacity) main = e;
  const along = (e) => Math.abs(e.d[0] * main.d[0] + e.d[1] * main.d[1]);
  const g = ends.map((e) => (along(e) >= 0.6 ? 0 : 1));
  if (!g.includes(1)) {
    let k = 0;
    ends.forEach((e, j) => { if (along(e) < along(ends[k]) || ends[k] === main) k = j; });
    g[k] = 1;
  }
  let c0 = 0, c1 = 0;
  ends.forEach((e, j) => {
    grp.set(`${e.id}:${n.id}`, g[j]);
    if (g[j]) c1 = Math.max(c1, e.def.capacity); else c0 = Math.max(c0, e.def.capacity);
  });
  split.set(n.id, clamp(c0 / Math.max(1, c0 + c1), 0.3, 0.7));
}

// The anticlockwise gap from end e round to end f (radians, 0..2π)
const gap = (e, f) => { let a = f.ang - e.ang; while (a <= 1e-6) a += Math.PI * 2; return a; };
// Where e's left kerb (the side toward f) meets f's right kerb: distances along each
// ([te, tf]), or null where the gap between them is a half turn or more (outside: for the
// outside of a bend, where those kerbs meet behind the node, at negative distances)
export function edgeMeet(e, f, we, wf, outside = false) {
  const g = gap(e, f);
  if (!outside && g > Math.PI - 0.05) return null;
  if (outside && (g < Math.PI + 0.05 || g > Math.PI * 2 - 0.2)) return null;
  // n + e.d t + we (-e.dz, e.dx) = n + f.d u - wf (-f.dz, f.dx)
  const ox = we * -e.d[1] + wf * -f.d[1], oz = we * e.d[0] + wf * f.d[0];
  // e.d t - f.d u = -o
  const det = e.d[0] * -f.d[1] - e.d[1] * -f.d[0];
  if (Math.abs(det) < 1e-6) return null;
  const t = (-ox * -f.d[1] - -oz * -f.d[0]) / det, u = (e.d[0] * -oz - e.d[1] * -ox) / det;
  if (outside) return Math.abs(t) < 4 && Math.abs(u) < 4 ? [t, u] : null;
  if (t < -0.01 || u < -0.01 || t > 6 || u > 6) return null;
  return [Math.max(0, t), Math.max(0, u)];
}

// ------------------------------------------------------------- legs
const STEP = 0.35;   // spacing of the points along an edge leg
const LIFT = 0.07;   // vehicles sit this far above the road's level (on the asphalt)
const station = (e, s) => (e.d > 0 ? s : e.len - s);
const smooth = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

// The stations of an edge between the junctions at its ends
function span(X, J, e) {
  const a = J.trims.get(`${e.seg}:${e.from}`) || 0, b = J.trims.get(`${e.seg}:${e.to}`) || 0;
  return [a, Math.max(a, e.len - b)];
}

// Along an edge from station q0 to q1, moving over from lane laneIn to laneOut on the way
function edgeLeg(state, X, e, q0, q1, laneIn, laneOut) {
  const g = X.geo.get(e.seg), sg = X.seg.get(e.seg);
  const def = e.def, len = Math.max(0, q1 - q0);
  const n = Math.max(2, Math.ceil(len / STEP) + 1);
  const P = new Float32Array(n * 3), H = sg.tn ? new Uint8Array(n) : null;
  const oIn = laneOffset(def, laneIn), oOut = laneOffset(def, laneOut);
  const p = [0, 0], d = [0, 0];
  const t0 = [0, 0], t1 = [0, 0];
  for (let j = 0; j < n; j++) {
    const q = q0 + (len * j) / (n - 1);
    const s = e.d > 0 ? q : e.len - q;
    const t = tAtS(g.tab, s);
    bez(g.c, t, p); bezTan(g.c, t, d);
    const dx = d[0] * e.d, dz = d[1] * e.d;
    // (a short stretch is driven in the lane it leaves in)
    const o = len < 1.5 ? oOut : oIn + (oOut - oIn) * smooth(((j / (n - 1)) - 0.3) / 0.4);
    P[j * 3] = p[0] - dz * o; P[j * 3 + 1] = segY(state, e.seg, s) + LIFT; P[j * 3 + 2] = p[1] + dx * o;
    if (H) H[j] = openAt(state, e.seg, s) ? 0 : 1;
    if (j === 0) { t0[0] = dx; t0[1] = dz; }
    if (j === n - 1) { t1[0] = dx; t1[1] = dz; }
  }
  return { kind: 0, key: e.id * 4 + laneOut, eid: e.id, seg: e.seg, slen: e.len, q0, q1, len, n, P, H, t0, t1, lane: laneOut, def, spd: def.speed };
}

// A curve from the end of one leg to the start of the next (the U-turns too)
function curveLeg(A, B, key, extra) {
  const ax = A.P[A.n * 3 - 3], ay = A.P[A.n * 3 - 2], az = A.P[A.n * 3 - 1];
  const bx = B.P[0], by = B.P[1], bz = B.P[2];
  const dist = Math.hypot(bx - ax, bz - az);
  const dot = A.t1[0] * B.t0[0] + A.t1[1] * B.t0[1];
  // handles: a third of the way when straight on, rounder when turning, a loop for a U-turn
  const k = dot > 0.97 ? dist / 3 : dot < -0.7 ? Math.max(0.45, dist * 0.9) : clamp(dist * 0.55, 0.12, 2);
  const c = [ax, az, ax + A.t1[0] * k, az + A.t1[1] * k, bx - B.t0[0] * k, bz - B.t0[1] * k, bx, bz];
  const n = Math.max(3, Math.ceil((dist + k) / 0.15) + 1);
  const pts = [];
  const p = [0, 0];
  for (let j = 0; j < n; j++) { const t = j / (n - 1); bez(c, t, p); pts.push(p[0], ay + (by - ay) * t, p[1]); }
  return finishCurve(pts, A, B, key, extra);
}

// Round a roundabout's island (anticlockwise as seen on the map, keeping it on the left)
function roundLeg(node, A, B, key, extra) {
  const ax = A.P[A.n * 3 - 3], ay = A.P[A.n * 3 - 2], az = A.P[A.n * 3 - 1];
  const bx = B.P[0], by = B.P[1], bz = B.P[2];
  const ra = Math.hypot(ax - node.x, az - node.z), rb = Math.hypot(bx - node.x, bz - node.z);
  const a0 = Math.atan2(az - node.z, ax - node.x);
  let a1 = Math.atan2(bz - node.z, bx - node.x);
  // round the way the traffic goes (decreasing angle), at least a little way
  while (a1 > a0 - 0.35) a1 -= Math.PI * 2;
  const sweep = a0 - a1;
  const fe = Math.min(0.45, 0.9 / sweep);
  const n = Math.max(6, Math.ceil((sweep * ROUND.ring) / 0.12) + 1);
  const pts = [];
  for (let j = 0; j < n; j++) {
    const f = j / (n - 1), a = a0 - sweep * f;
    const r = ROUND.ring + (ra - ROUND.ring) * Math.max(0, 1 - f / fe) ** 2 + (rb - ROUND.ring) * Math.max(0, 1 - (1 - f) / fe) ** 2;
    pts.push(node.x + Math.cos(a) * r, ay + (by - ay) * f, node.z + Math.sin(a) * r);
  }
  return finishCurve(pts, A, B, key, extra);
}

function finishCurve(pts, A, B, key, extra) {
  const n = pts.length / 3;
  let len = 0;
  for (let j = 1; j < n; j++) len += Math.hypot(pts[j * 3] - pts[j * 3 - 3], pts[j * 3 + 1] - pts[j * 3 - 2], pts[j * 3 + 2] - pts[j * 3 - 1]);
  // (points evenly spaced by distance, so a vehicle moves along it at an even speed)
  const P = resample(pts, n, len);
  return { kind: 1, key, q0: 0, q1: len, len, n: P.length / 3, P, H: null, t0: A.t1, t1: B.t0, spd: Math.min(A.spd, B.spd), ...extra };
}
function resample(pts, n, len) {
  const m = Math.max(2, Math.ceil(len / 0.12) + 1);
  const out = new Float32Array(m * 3);
  let j = 1, acc = 0;
  for (let k = 0; k < m; k++) {
    const want = (len * k) / (m - 1);
    while (j < n - 1) {
      const d = Math.hypot(pts[j * 3] - pts[j * 3 - 3], pts[j * 3 + 1] - pts[j * 3 - 2], pts[j * 3 + 2] - pts[j * 3 - 1]);
      if (acc + d >= want) break;
      acc += d; j++;
    }
    const d = Math.hypot(pts[j * 3] - pts[j * 3 - 3], pts[j * 3 + 1] - pts[j * 3 - 2], pts[j * 3 + 2] - pts[j * 3 - 1]) || 1;
    const f = clamp((want - acc) / d, 0, 1);
    for (let c = 0; c < 3; c++) out[k * 3 + c] = pts[j * 3 - 3 + c] + (pts[j * 3 + c] - pts[j * 3 - 3 + c]) * f;
  }
  return out;
}

// Which way a vehicle turns going from one edge onto the next: 'r', 'l', 's' (straight on) or
// 'u' (back the way it came)
function turnOf(t1, t0) {
  const dot = t1[0] * t0[0] + t1[1] * t0[1], cross = t1[0] * t0[1] - t1[1] * t0[0];
  if (dot < -0.7) return 'u';
  return cross > 0.35 ? 'r' : cross < -0.35 ? 'l' : 's';
}
function tangentAt(X, e, q) {
  const g = X.geo.get(e.seg);
  const d = bezTan(g.c, tAtS(g.tab, e.d > 0 ? q : e.len - q));
  return [d[0] * e.d, d[1] * e.d];
}

// Edge legs reused between vehicles (whole stretches between junctions)
let cache = { X: null, legs: new Map() };

// The legs of a trip. parts: routes from findRoute ({ edges, from: { seg, s }, to }), one
// after another (a bus line's stops: each part starts where the last one ended).
//   policy: 'car' (lane by the turns ahead), 'kerb' (buses), 'tram'; pref: the lane a car
//   likes on a straight road; loop: back round to the start at the end (a line); firstLeg:
//   the leg a vehicle is already on, along the first road (a driver changing their route)
// Returns { legs, starts } (starts[k]: the leg and station where part k begins) or null.
export function buildLegs(state, parts, { policy = 'car', pref = 0, loop = false, firstLeg = null } = {}) {
  const X = rn(state), Gr = graph(state), J = junctionLayout(state);
  if (cache.X !== X) cache = { X, legs: new Map() };
  // the stretches of road, in order
  const runs = [];
  for (let pi = 0; pi < parts.length; pi++) {
    const p = parts[pi];
    if (!p?.edges?.length) return null;
    for (let k = 0; k < p.edges.length; k++) {
      const e = Gr.edges.get(p.edges[k]);
      if (!e) return null;
      const [lo, hi] = span(X, J, e);
      let q0 = lo, q1 = hi;
      if (k === 0) q0 = clamp(station(e, p.from.s), lo, hi);
      if (k === p.edges.length - 1) q1 = clamp(station(e, p.to.s), q0, hi);
      runs.push({ e, q0, q1, pi, full: q0 === lo && q1 === hi, t0: tangentAt(X, e, q0), t1: tangentAt(X, e, q1) });
    }
  }
  if (!runs.length) return null;
  // how each run joins the next: the same road on ('=', a bus stop part way along), a turn at
  // a junction ('r', 'l', 's', 'u'), or a U-turn in the road ('m')
  const join = (r, s) => {
    if (s.e.id === r.e.id && Math.abs(s.q0 - r.q1) < 1e-4) return '=';
    const atNode = r.e.to === s.e.from && r.q1 >= span(X, J, r.e)[1] - 1e-4 && s.q0 <= span(X, J, s.e)[0] + 1e-4;
    return atNode ? turnOf(r.t1, s.t0) : 'm';
  };
  const J2 = runs.map((r, k) => (k < runs.length - 1 ? join(r, runs[k + 1]) : loop ? join(r, runs[0]) : 'end'));
  // lanes: in, and out (by the turn ahead)
  const lanesIn = [], lanesOut = [];
  const pick = (def, turn, cur) => {
    if (policy === 'kerb') return 0;
    if (policy === 'tram') return tramLane(def);
    const L = def.lanes;
    if (L === 1 || turn === 'r' || turn === 'end') return 0;
    if (turn === 'l' || turn === 'u' || turn === 'm') return L - 1;
    return Math.min(cur, L - 1);
  };
  let cur = pref;
  for (let k = 0; k < runs.length; k++) {
    const def = runs[k].e.def;
    const before = k ? J2[k - 1] : loop ? J2[runs.length - 1] : 'start';
    let lin;
    if (policy !== 'car') lin = pick(def, 's', 0);
    else if (before === 'start') lin = 0;
    else if (before === '=') lin = lanesOut[k - 1] ?? 0;
    else if (before === 'r') lin = 0;
    else if (before === 'l' || before === 'u' || before === 'm') lin = def.lanes - 1;
    else lin = Math.min(cur, def.lanes - 1);
    lanesIn.push(lin);
    const out = k === 0 && firstLeg ? firstLeg.lane : J2[k] === '=' ? lin : pick(def, J2[k], cur);
    lanesOut.push(out);
    if (J2[k] === 's' && policy === 'car') cur = out;
  }
  // the edge legs, then the curves joining them
  const edgeLegs = runs.map((r, k) => {
    if (k === 0 && firstLeg) return firstLeg;
    const ck = r.full ? `${r.e.id}:${lanesIn[k]}:${lanesOut[k]}` : null;
    let leg = ck && cache.legs.get(ck);
    if (!leg) { leg = edgeLeg(state, X, r.e, r.q0, r.q1, lanesIn[k], lanesOut[k]); if (ck) cache.legs.set(ck, leg); }
    return leg;
  });
  const legs = [], starts = [];
  const between = (k, A, B) => {
    const turn = J2[k];
    if (turn === '=') return null;
    const r = runs[k];
    if (turn === 'm') return curveLeg(A, B, `m${A.key}:${B.key}`, { node: -1, jk: 0, grp: 0, spd: 15 });
    const node = r.e.to, jk = Gr.kind.get(node) || 0;
    const top = Math.max(...(X.at.get(node) || []).map((id) => rankOf(X.seg.get(id).type)));
    const extra = { node, jk, grp: J.grp.get(`${r.e.seg}:${node}`) || 0, minor: rankOf(r.e.def.id) < top };
    const key = `${node}:${A.key}>${B.key}`;
    if (J.round.has(node)) return roundLeg(X.node.get(node), A, B, key, { ...extra, round: true, spd: Math.min(A.spd, B.spd, 25) });
    const leg = curveLeg(A, B, key, extra);
    if (turn !== 's') leg.spd = Math.min(leg.spd, turn === 'u' ? 12 : 30);
    return leg;
  };
  for (let k = 0; k < runs.length; k++) {
    if (k === 0 || runs[k].pi !== runs[k - 1].pi) starts[runs[k].pi] = { leg: legs.length, q: runs[k].q0 };
    legs.push(edgeLegs[k]);
    if (k < runs.length - 1 || loop) {
      const c = between(k, edgeLegs[k], edgeLegs[(k + 1) % runs.length]);
      if (c) legs.push(c);
    }
  }
  return { legs, starts };
}

// The point at station q along a leg: writes x, y, z and the heading (hx, hz) into out;
// returns false where it's out of sight (inside a tunnel)
export function legPoint(leg, q, out) {
  const u = leg.len > 1e-6 ? clamp((q - leg.q0) / leg.len, 0, 1) * (leg.n - 1) : 0;
  const j = Math.min(Math.floor(u), leg.n - 2), f = u - j;
  const P = leg.P;
  const a = j * 3, b = a + 3;
  out.x = P[a] + (P[b] - P[a]) * f;
  out.y = P[a + 1] + (P[b + 1] - P[a + 1]) * f;
  out.z = P[a + 2] + (P[b + 2] - P[a + 2]) * f;
  const dx = P[b] - P[a], dz = P[b + 2] - P[a + 2], l = Math.hypot(dx, dz);
  if (l > 1e-5) { out.hx = dx / l; out.hz = dz / l; out.dy = (P[b + 1] - P[a + 1]) / l; }
  else { out.hx = leg.t0[0]; out.hz = leg.t0[1]; out.dy = 0; }
  return !(leg.H && (leg.H[j] || leg.H[j + 1]));
}
