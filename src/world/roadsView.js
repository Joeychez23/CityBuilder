// Roads, drawn from the road network (sim/roadnet.js). Each segment is a strip along its
// curve: the kerb-and-pavement base (an embankment skirt on the ground, a deck on a bridge),
// the asphalt on top, and its lines. Where roads meet, their ends are cut back and the gap
// filled with one surface whose corners are rounded from one road's kerb to the next; a road
// that ends gets a round end. Raised roads get girders, railings and piers. Everything is
// built into one mesh, coloured per vertex, so info views can recolour each road.
import * as THREE from 'three';
import { N, clamp } from '../core/grid.js';
import { ROADS, UPG } from '../data/roads.js';
import { rn, segY, nodeY, leaveDir, groundAt, profileAt, openAt, nearestSeg } from '../sim/roadnet.js';
import { bez, bezTan, tAtS, arcTable } from '../sim/roadgeom.js';
import { chainCells } from '../sim/roadraster.js';
import { BRIDGE_STYLE } from './networksView.js';
import { roadWidth, asphaltWidth, laneOffset, tramLane, junctionLayout, edgeMeet, ROUND } from '../sim/lanes.js';

const LIFT = { base: 0.03, asphalt: 0.065, line: 0.078 };
const SKIRT = 0.4;
const col = new THREE.Color();
const BARRIER_C = new THREE.Color('#8fa3a8'), PORTAL_C = new THREE.Color('#a9a49a'), MOUTH_C = new THREE.Color('#1d1f22'), ROOF_C = new THREE.Color('#8d877b');
const PIER_C = new THREE.Color('#a29d93'), TRAM_C = new THREE.Color('#6b6157'), WHITE = new THREE.Color('#e8e8e8');

export { roadWidth, asphaltWidth };
const kerbColor = (def) => (def.key === 'highway' ? '#7d7f84' : def.key === 'gravel' ? '#9a8b72' : '#b8b5ae');
const lineColor = (def) => (def.oneway || def.key === 'highway' ? '#e8e8e8' : '#f1c94a');

// How far from the centre line the lines between lanes run (roads with more than one lane
// each way)
function laneOffsets(def) {
  const w = def.width * 0.41;
  const offs = [];
  if (def.oneway) { for (let k = 1; k < def.lanes; k++) { const o = -w + (2 * w * k) / def.lanes; if (Math.abs(o) > 0.01) offs.push(o); } }
  else for (let k = 1; k < def.lanes; k++) { const o = (w * k) / def.lanes; offs.push(o, -o); }
  return offs;
}

// Triangles with a colour per vertex
class Builder {
  constructor() { this.pos = []; this.col = []; this.idx = []; this.n = 0; }
  v(x, y, z, c) { this.pos.push(x, y, z); this.col.push(c.r, c.g, c.b); return this.n++; }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  // A box (cx, cz: centre; y0..y1; sx along the direction ry, sz across)
  box(cx, y0, cz, sx, y1, sz, ry, c) {
    const cs = Math.cos(ry), sn = Math.sin(ry);
    const P = (u, w) => [cx + u * cs - w * sn, cz + u * sn + w * cs];
    const corners = [P(-sx / 2, -sz / 2), P(sx / 2, -sz / 2), P(sx / 2, sz / 2), P(-sx / 2, sz / 2)];
    const lo = corners.map(([x, z]) => this.v(x, y0, z, c)), hi = corners.map(([x, z]) => this.v(x, y1, z, c));
    this.quad(hi[0], hi[1], hi[2], hi[3]);
    for (let k = 0; k < 4; k++) { const j = (k + 1) % 4; this.quad(lo[k], lo[j], hi[j], hi[k]); }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

export function createRoadsView(view, state) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
  // (lines are pulled toward the camera in the depth test so they never flicker into the asphalt)
  const lineMat = new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2, side: THREE.DoubleSide });
  let mesh = null, lines = null;
  const rv = { dirty: true, roadColorFn: null };
  let paint = []; // [first vertex, vertex count, seg id] of each piece of asphalt (for recolouring)

  function roadColor(sid) {
    const X = rn(state);
    const s = X.seg.get(sid);
    if (!s) return col.set('#444');
    const g = X.geo.get(sid);
    if (!g.chain) g.chain = chainCells(g.c, g.tab);
    const cells = g.chain.cells;
    const i = cells[cells.length >> 1] >= 0 ? cells[cells.length >> 1] : cells.find((c) => c >= 0) ?? 0;
    if (rv.roadColorFn) return col.set(rv.roadColorFn(i, s.type));
    col.set(ROADS[s.type].color);
    const cond = s.cond ?? state.roadCond[i] ?? 1;
    if (cond < 0.7) col.lerp(new THREE.Color('#8a8578'), (0.7 - cond) * 0.9);
    if (state.roadSnow[i] > 0.05) col.lerp(new THREE.Color('#f2f5f8'), clamp(state.roadSnow[i], 0, 0.9));
    if (state.accident[i] > 0) col.set('#d24a3a');
    const shut = state.closed?.[i];
    if (shut) col.set(shut === 1 ? '#f0a020' : shut === 2 ? '#6e5b47' : '#4f8fbf');
    return col;
  }

  // ------------------------------------------------------------- junctions
  // (laid out in sim/lanes.js: how far back each road is cut, and the junction's outline)
  // The junction surface at node n: a fan from the node through each road's cut-back kerbs,
  // with the corners between neighbouring roads rounded (half: kerb or asphalt half-width)
  function drawJunction(B, sh, half, y0, c, X) {
    const { n, ends } = sh;
    const h = nodeY(state, n) + y0;
    const centre = B.v(n.x, h, n.z, c);
    const ring = [];
    const at = (e, side, w) => {
      const g = X.geo.get(e.id), seg = X.seg.get(e.id);
      const along = seg.a === n.id ? e.trim : g.len - e.trim;
      const t = tAtS(g.tab, along);
      const p = bez(g.c, t), d = bezTan(g.c, t);
      if (seg.a !== n.id) { d[0] = -d[0]; d[1] = -d[1]; }
      return [p[0] - d[1] * side * w, segY(state, e.id, along) + y0, p[1] + d[0] * side * w];
    };
    const m = ends.length;
    for (let k = 0; k < m; k++) {
      const e = ends[k], f = ends[(k + 1) % m];
      const p0 = at(e, -1, half(e)), p1 = at(e, 1, half(e)), p2 = at(f, -1, half(f));
      ring.push(p0, p1);
      // a rounded corner from e's kerb to f's, with its control where the kerbs meet (in
      // front of the node between two roads, behind it round the outside of a bend)
      const x = edgeMeet(e, f, half(e), half(f)) || edgeMeet(e, f, half(e), half(f), true);
      if (x) {
        const qx = n.x + e.d[0] * x[0] - e.d[1] * half(e), qz = n.z + e.d[1] * x[0] + e.d[0] * half(e);
        for (let j = 1; j < 8; j++) {
          const t = j / 8, u = 1 - t;
          ring.push([u * u * p1[0] + 2 * u * t * qx + t * t * p2[0], u * p1[1] + t * p2[1], u * u * p1[2] + 2 * u * t * qz + t * t * p2[2]]);
        }
      }
    }
    const ids = ring.map(([x, y, z]) => B.v(x, y, z, c));
    for (let k = 0; k < ids.length; k++) B.tri(centre, ids[k], ids[(k + 1) % ids.length]);
    // the kerb's side down into the ground, all round
    if (y0 === LIFT.base) {
      const lo = ring.map(([x, y, z]) => B.v(x, y - SKIRT, z, c));
      const hi = ring.map(([x, y, z]) => B.v(x, y, z, c));
      for (let k = 0; k < ring.length; k++) { const j = (k + 1) % ring.length; B.quad(lo[k], lo[j], hi[j], hi[k]); }
    }
  }

  // A roundabout's island: a kerbed ring of grass in the middle of the junction
  const GRASS_C = new THREE.Color('#5f8f4a'), ISLAND_KERB = new THREE.Color('#c9c5bb');
  function drawIsland(B, n) {
    const h = nodeY(state, n) + LIFT.asphalt;
    for (const [r, top, c] of [[ROUND.island, 0.1, ISLAND_KERB], [ROUND.island - 0.05, 0.11, GRASS_C]]) {
      const centre = B.v(n.x, h + top, n.z, c);
      const hi = [], lo = [];
      for (let j = 0; j < 20; j++) {
        const a = (j / 20) * Math.PI * 2, x = n.x + Math.cos(a) * r, z = n.z + Math.sin(a) * r;
        hi.push(B.v(x, h + top, z, c)); lo.push(B.v(x, h - 0.02, z, c));
      }
      for (let j = 0; j < 20; j++) { const k = (j + 1) % 20; B.tri(centre, hi[k], hi[j]); B.quad(lo[j], lo[k], hi[k], hi[j]); }
    }
  }

  // A road that ends: a round end beyond its node
  function drawCap(B, sh, half, y0, c, X) {
    const { n, ends } = sh;
    const e = ends[0];
    const h = nodeY(state, n) + y0;
    const centre = B.v(n.x, h, n.z, c);
    const w = half(e), base = Math.atan2(-e.d[1], -e.d[0]);
    const pts = [];
    for (let j = 0; j <= 10; j++) {
      const a = base - Math.PI / 2 + (Math.PI * j) / 10;
      pts.push([n.x + Math.cos(a) * w, h, n.z + Math.sin(a) * w]);
    }
    const ids = pts.map(([x, y, z]) => B.v(x, y, z, c));
    for (let k = 0; k < ids.length - 1; k++) B.tri(centre, ids[k], ids[k + 1]);
    if (y0 === LIFT.base && !X.seg.get(e.id).br) {
      const lo = pts.map(([x, y, z]) => B.v(x, y - SKIRT, z, c));
      const hi = pts.map(([x, y, z]) => B.v(x, y, z, c));
      for (let k = 0; k < pts.length - 1; k++) B.quad(lo[k], lo[k + 1], hi[k + 1], hi[k]);
    }
  }

  // ------------------------------------------------------------- segments
  // Points along a segment between its cut-back ends: { x, z, nx, nz, h }
  function stations(X, sid, s0, s1) {
    const g = X.geo.get(sid);
    const straight = Math.abs(g.c[2] - (g.c[0] + (g.c[6] - g.c[0]) / 3)) + Math.abs(g.c[3] - (g.c[1] + (g.c[7] - g.c[1]) / 3)) < 1e-3;
    const step = straight ? 0.5 : 0.25;
    const n = Math.max(1, Math.ceil((s1 - s0) / step));
    const out = [];
    const p = [0, 0], d = [0, 0];
    for (let k = 0; k <= n; k++) {
      const s = s0 + ((s1 - s0) * k) / n;
      const t = tAtS(g.tab, s);
      bez(g.c, t, p); bezTan(g.c, t, d);
      out.push({ x: p[0], z: p[1], nx: -d[1], nz: d[0], dx: d[0], dz: d[1], h: segY(state, sid, s), s });
    }
    return out;
  }
  // A strip along the stations, `off` from the centre line, `w` wide, `lift` above the road
  // (skirt: sides that far down; dash: dashes this long, with gaps as long between them)
  function strip(B, st, off, w, lift, c, skirt = 0, dash = 0) {
    if (dash) {
      const s0 = st[0].s, s1 = st[st.length - 1].s;
      for (let d0 = Math.floor(s0 / (2 * dash)) * 2 * dash; d0 < s1; d0 += 2 * dash) {
        const a = Math.max(s0, d0), b = Math.min(s1, d0 + dash);
        if (b - a < 0.02) continue;
        strip(B, [stationAt(st, a), ...st.filter((p) => p.s > a && p.s < b), stationAt(st, b)], off, w, lift, c, skirt);
      }
      return;
    }
    let prev = null;
    for (let k = 0; k < st.length; k++) {
      const p = st[k];
      const l = [p.x + p.nx * (off + w / 2), p.h + lift, p.z + p.nz * (off + w / 2)];
      const r = [p.x + p.nx * (off - w / 2), p.h + lift, p.z + p.nz * (off - w / 2)];
      const cur = { l: B.v(...l, c), r: B.v(...r, c) };
      if (skirt) { cur.ll = B.v(l[0], l[1] - skirt, l[2], c); cur.rl = B.v(r[0], r[1] - skirt, r[2], c); cur.lh = B.v(...l, c); cur.rh = B.v(...r, c); }
      if (prev) {
        B.quad(prev.l, prev.r, cur.r, cur.l);
        if (skirt) { B.quad(prev.ll, cur.ll, cur.lh, prev.lh); B.quad(prev.rl, cur.rl, cur.rh, prev.rh); }
      }
      prev = cur;
    }
  }
  // A station part way along (between the two either side of distance s)
  function stationAt(st, s) {
    let k = 1;
    while (k < st.length - 1 && st[k].s < s) k++;
    const a = st[k - 1], b = st[k], f = (s - a.s) / Math.max(1e-9, b.s - a.s);
    const L = (u, v) => u + (v - u) * f;
    return { x: L(a.x, b.x), z: L(a.z, b.z), nx: L(a.nx, b.nx), nz: L(a.nz, b.nz), h: L(a.h, b.h), s };
  }

  // Girders, railings and piers under and along a raised road
  function drawBridge(B, X, s, st) {
    const def = ROADS[s.type];
    const S = BRIDGE_STYLE[def.cls] || BRIDGE_STYLE.local;
    const W = roadWidth(def);
    const gc = col.clone().set(S.girderC);
    strip(B, st, 0, W * S.girderW, -0.17, gc, S.girder);
    const rc = new THREE.Color(S.rail.c);
    for (const side of [-1, 1]) strip(B, st, side * (W / 2 - S.rail.w / 2), S.rail.w, LIFT.base + S.rail.h, rc, S.rail.h);
    // piers every few cells where the deck is up off the ground
    const g = X.geo.get(s.id);
    const pc = new THREE.Color(S.pierC);
    const every = S.every * 1.25;
    // (a suspension bridge hangs from its towers, drawn with the city's landmarks)
    for (let a = every / 2; a < g.len - 0.5 && s.style !== 'suspension'; a += every) {
      const t = tAtS(g.tab, a);
      const p = bez(g.c, t), d = bezTan(g.c, t);
      const h = segY(state, s.id, a);
      // not on a road passing underneath: the pier moves along a little, or is left out
      if (nearestSeg(state, p[0], p[1], roadWidth(def) * S.pierW / 2 + 0.55, (o) => o.id !== s.id && !o.br && !o.tn)) continue;
      const cx = Math.floor(p[0]), cz = Math.floor(p[1]);
      const wet = cx >= 0 && cz >= 0 && cx < N && cz < N && state.water[cz * N + cx];
      const below = wet ? state.seaLevel : groundAt(state, p[0], p[1]);
      if (h - below < 0.3) continue;
      const top = h - 0.17 - S.girder;
      const ry = Math.atan2(d[1], d[0]);
      B.box(p[0], below - (wet ? 2 : 0.2), p[1], S.pier, top, W * S.pierW, ry, pc);
      if (S.cap) B.box(p[0], top - 0.12, p[1], S.pier * 1.4, top, W * 0.94, ry, pc);
    }
  }

  // The stretches of a segment that are open to the sky (a tunnel's ends; all of any other)
  function openRanges(X, s, s0, s1) {
    if (!s.tn) return [[s0, s1]];
    const g = X.geo.get(s.id);
    let a = s0, b = s1;
    while (a < s1 && openAt(state, s.id, a)) a += 0.25;
    while (b > a && openAt(state, s.id, b)) b -= 0.25;
    const out = [];
    if (a > s0 + 0.05) out.push([s0, Math.min(s1, a + 0.3)]);
    if (b < s1 - 0.05) out.push([Math.max(s0, b - 0.3), s1]);
    g.portals = [a, b].filter((v, k) => (k ? v < s1 - 0.05 : v > s0 + 0.05) && v > s0 && v < s1);
    return out;
  }

  function drawSegment(B, X, s, trims) {
    const g = X.geo.get(s.id);
    const def = ROADS[s.type];
    const s0 = trims.get(`${s.id}:${s.a}`) || 0, s1 = g.len - (trims.get(`${s.id}:${s.b}`) || 0);
    if (s1 - s0 < 0.02) return;
    for (const [r0, r1] of openRanges(X, s, s0, s1)) {
      const st = stations(X, s.id, r0, r1);
      const kerb = col.clone().set(s.br ? (BRIDGE_STYLE[def.cls] || BRIDGE_STYLE.local).deck : kerbColor(def));
      strip(B, st, 0, roadWidth(def), LIFT.base, kerb, s.br ? 0.2 : SKIRT);
      const first = B.n;
      strip(B, st, 0, asphaltWidth(def), LIFT.asphalt, roadColor(s.id).clone());
      paint.push([first, B.n - first, s.id]);
      if (s.br) drawBridge(B, X, s, st);
      // a sound barrier along both sides of a highway
      if ((s.upg || 0) & UPG.BARRIER) for (const side of [-1, 1]) strip(B, st, side * (roadWidth(def) / 2 - 0.03), 0.05, LIFT.base + 0.45, BARRIER_C, 0.45);
      // a tunnel's approach runs down between retaining walls, up to the ground at its end
      if (s.tn) {
        const top = Math.max(nodeY(state, X.node.get(s.a)), nodeY(state, X.node.get(s.b)));
        const atEnd = r0 <= s0 + 0.01 ? st[0].h : st[st.length - 1].h;
        for (const side of [-1, 1]) wall(B, st, side * (roadWidth(def) / 2 + 0.04), (p) => Math.max(p.h + 0.1, Math.min(top, atEnd) + 0.05), PORTAL_C);
      }
    }
    if (s.tn) for (const a of g.portals || []) drawPortal(B, X, s, a);
  }

  // A wall along the stations, `off` from the centre line, from the road up to top(station)
  function wall(B, st, off, top, c) {
    let prev = null;
    for (const p of st) {
      const x = p.x + p.nx * off, z = p.z + p.nz * off;
      const cur = { lo: B.v(x, p.h - 0.1, z, c), hi: B.v(x, top(p), z, c) };
      if (prev) B.quad(prev.lo, cur.lo, cur.hi, prev.hi);
      prev = cur;
    }
  }

  // A tunnel's mouth: a concrete face across the road where it goes into the ground
  function drawPortal(B, X, s, a) {
    const g = X.geo.get(s.id), def = ROADS[s.type];
    const t = tAtS(g.tab, a), p = bez(g.c, t), d = bezTan(g.c, t);
    const h = segY(state, s.id, a), ry = Math.atan2(d[1], d[0]), w = roadWidth(def);
    const top = Math.max(h + 0.7, groundAt(state, p[0], p[1]) + 0.15);
    B.box(p[0], h - 0.1, p[1], 0.3, top, w + 0.34, ry, PORTAL_C);
    B.box(p[0] + d[0] * 0.01, h, p[1] + d[1] * 0.01, 0.32, h + 0.5, w - 0.06, ry, MOUTH_C);
    B.box(p[0], top - 0.1, p[1], 0.5, top, w + 0.44, ry, ROOF_C);
  }

  function drawLines(L, X, s, trims) {
    const g = X.geo.get(s.id);
    const def = ROADS[s.type];
    const s0 = trims.get(`${s.id}:${s.a}`) || 0, s1 = g.len - (trims.get(`${s.id}:${s.b}`) || 0);
    if (s1 - s0 < 0.1) return;
    for (const [r0, r1] of openRanges(X, s, s0, s1)) {
      const st = stations(X, s.id, r0, r1);
      if ((s.upg || 0) & UPG.TRAM) {
        const o = laneOffset(def, tramLane(def));
        for (const c of def.oneway ? [o] : [o, -o]) for (const r of [-0.065, 0.065]) strip(L, st, c + r, 0.025, LIFT.line + 0.004, TRAM_C);
      }
      if (def.key === 'gravel') continue;
      const lc = new THREE.Color(lineColor(def));
      // the centre line: dashed on local streets, solid on the rest (none on one-way roads)
      if (!def.oneway) strip(L, st, 0, 0.04, LIFT.line, lc, 0, def.cls === 'local' ? 0.25 : 0);
      for (const o of laneOffsets(def)) strip(L, st, o, 0.025, LIFT.line, WHITE, 0, 0.2);
    }
  }

  // Zebra crossings across each road coming into a busy junction, and a stop line across the
  // lanes coming in
  function drawCrossings(L, X, sh) {
    const { n, ends } = sh;
    if (ends.length < 3) return;
    const busy = n.ctrl === 'lights' || ends.filter((e) => e.def.cls !== 'local').length >= 2;
    if (!busy) return;
    for (const e of ends) {
      if (e.def.key === 'highway' || e.def.key === 'gravel') continue;
      const seg = X.seg.get(e.id), g = X.geo.get(e.id);
      const from = seg.a === n.id;
      const at = (a) => (from ? a : g.len - a);
      const aw = asphaltWidth(e.def);
      // stripes across the road, just out from the junction
      const s0 = e.trim + 0.06, s1 = e.trim + 0.3;
      if (s1 > g.len * 0.45) continue;
      const st = stations(X, e.id, Math.min(at(s0), at(s1)), Math.max(at(s0), at(s1)));
      for (let o = -aw / 2 + 0.05; o < aw / 2 - 0.03; o += 0.1) strip(L, st, o, 0.05, LIFT.line, WHITE);
      // the stop line, across the lanes coming in (on the right as you drive in)
      const sl = e.trim + 0.38;
      if (sl > g.len * 0.45) continue;
      const st2 = stations(X, e.id, Math.min(at(sl), at(sl + 0.04)), Math.max(at(sl), at(sl + 0.04)));
      const side = from ? -1 : 1;
      if (!e.def.oneway) strip(L, st2, side * aw / 4, aw / 2, LIFT.line, WHITE);
      else strip(L, st2, 0, aw, LIFT.line, WHITE);
    }
  }

  // The outside connection: the road carries on off the edge of the map
  function drawOutside(B, X, n) {
    const id = X.at.get(n.id)?.[0];
    if (id == null) return;
    const s = X.seg.get(id), def = ROADS[s.type];
    const d = leaveDir(X, id, n.id);
    const h = nodeY(state, n);
    const st = [0, 6].map((k) => ({ x: n.x - d[0] * k, z: n.z - d[1] * k, nx: d[1], nz: -d[0], h, s: k }));
    strip(B, st, 0, roadWidth(def), LIFT.base, col.clone().set(kerbColor(def)), SKIRT);
    const first = B.n;
    strip(B, st, 0, asphaltWidth(def), LIFT.asphalt, roadColor(id).clone());
    paint.push([first, B.n - first, id]);
  }

  // tunnels, seen while you look underground
  const tubeMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  let tubes = null, underground = false;
  rv.setUnderground = (on) => { underground = on; if (tubes) tubes.visible = on; };

  rv.rebuild = () => {
    for (const m of [mesh, lines, tubes]) if (m) { view.scene.remove(m); m.geometry.dispose(); }
    mesh = lines = tubes = null;
    paint = [];
    const X = rn(state);
    const B = new Builder(), L = new Builder();
    const { trims, shapes } = junctionLayout(state);
    for (const s of X.seg.values()) {
      if (!X.geo.has(s.id)) continue;
      drawSegment(B, X, s, trims);
      drawLines(L, X, s, trims);
    }
    const kerbHalf = (e) => e.w, asphaltHalf = (e) => e.a;
    for (const sh of shapes) {
      // the junction takes the colours of its biggest road
      const top = sh.ends.reduce((a, e) => (ROADS[X.seg.get(e.id).type].capacity > ROADS[X.seg.get(a.id).type].capacity ? e : a), sh.ends[0]);
      const def = ROADS[X.seg.get(top.id).type];
      const raised = sh.ends.every((e) => X.seg.get(e.id).br) || sh.n.elev > 0;
      const kerb = col.clone().set(raised ? (BRIDGE_STYLE[def.cls] || BRIDGE_STYLE.local).deck : kerbColor(def));
      const draw = sh.cap ? drawCap : drawJunction;
      // (the open end of a tunnel has nothing to draw: it's where the road goes underground)
      if (sh.ends.some((e) => X.seg.get(e.id).tn && !openAt(state, e.id, X.seg.get(e.id).a === sh.n.id ? 0.1 : X.geo.get(e.id).len - 0.1))) continue;
      draw(B, sh, kerbHalf, LIFT.base, kerb, X);
      const first = B.n;
      draw(B, sh, asphaltHalf, LIFT.asphalt, roadColor(top.id).clone(), X);
      paint.push([first, B.n - first, top.id]);
      if (!sh.cap && !sh.round) drawCrossings(L, X, sh);
      if (sh.round) drawIsland(B, sh.n);
      // a raised junction stands on a pier
      if (sh.n.elev > 0.3) {
        const g = Math.max(groundAt(state, sh.n.x, sh.n.z), state.seaLevel - 2);
        B.box(sh.n.x, g - 0.2, sh.n.z, 0.4, nodeY(state, sh.n) - 0.2, 0.4, 0, PIER_C);
      }
    }
    for (const n of X.node.values()) if (n.out) drawOutside(B, X, n);
    const T = new Builder(), tc = new THREE.Color('#ffb84f');
    for (const sg of X.seg.values()) {
      const g = X.geo.get(sg.id);
      if (!sg.tn || !g?.portals?.length) continue;
      const a = g.portals.length === 2 ? g.portals[0] : 0, b = g.portals.length === 2 ? g.portals[1] : g.len;
      if (b - a > 0.2) strip(T, stations(X, sg.id, a, b), 0, roadWidth(ROADS[sg.type]) * 0.8, 0.1, tc);
    }
    if (T.n) { tubes = new THREE.Mesh(T.geometry(), tubeMat); tubes.renderOrder = 12; tubes.visible = underground; view.scene.add(tubes); }
    if (B.n) {
      mesh = new THREE.Mesh(B.geometry(), mat);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      view.scene.add(mesh);
    }
    if (L.n) {
      lines = new THREE.Mesh(L.geometry(), lineMat);
      lines.renderOrder = 1;
      view.scene.add(lines);
    }
    rv.dirty = false;
  };

  // Cheap recolour of the asphalt only (traffic info view, snow, condition)
  rv.recolorRoads = () => {
    if (!mesh) return;
    const attr = mesh.geometry.getAttribute('color');
    for (const [first, count, sid] of paint) {
      const c = roadColor(sid);
      for (let k = first; k < first + count; k++) attr.setXYZ(k, c.r, c.g, c.b);
    }
    attr.needsUpdate = true;
  };
  rv.setRoadColorFn = (fn) => { rv.roadColorFn = fn; rv.recolorRoads(); };
  rv.setVisible = (v) => { if (mesh) mesh.visible = v; if (lines) lines.visible = v; };

  // ------------------------------------------------------------- tool ghost
  // The road a tool is about to build, see-through: items are
  //   { c (curve), prof ({ ss, hs } heights, or none: on the ground), w (width), color }
  //   { dot: [x, z], r, color } (a marker: where it snaps to)
  const ghostMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide });
  let ghost = null;
  rv.hideGhost = () => { if (ghost) { view.scene.remove(ghost); ghost.geometry.dispose(); ghost = null; } };
  rv.showGhost = (items) => {
    rv.hideGhost();
    const B = new Builder();
    const p = [0, 0], d = [0, 0];
    const ground = (x, z) => {
      const cx = Math.floor(x), cz = Math.floor(z);
      const wet = cx >= 0 && cz >= 0 && cx < N && cz < N && state.water[cz * N + cx];
      return wet ? Math.max(state.seaLevel, groundAt(state, x, z)) : groundAt(state, x, z);
    };
    for (const it of items) {
      const c = new THREE.Color(it.color || '#4fc3ff');
      if (it.dot) {
        const [x, z] = it.dot, r = it.r || 0.35, h = ground(x, z) + 0.2;
        const centre = B.v(x, h, z, c);
        const ring = [];
        for (let j = 0; j < 16; j++) ring.push(B.v(x + Math.cos((j / 16) * Math.PI * 2) * r, h, z + Math.sin((j / 16) * Math.PI * 2) * r, c));
        for (let j = 0; j < 16; j++) B.tri(centre, ring[j], ring[(j + 1) % 16]);
        continue;
      }
      const tab = arcTable(it.c);
      const n = Math.max(1, Math.ceil(tab.len / 0.25));
      const st = [];
      for (let k = 0; k <= n; k++) {
        const s = (tab.len * k) / n, t = tAtS(tab, s);
        bez(it.c, t, p); bezTan(it.c, t, d);
        st.push({ x: p[0], z: p[1], nx: -d[1], nz: d[0], h: it.prof ? profileAt(it.prof, s) : ground(p[0], p[1]), s });
      }
      strip(B, st, 0, it.w || 1, 0.14, c);
    }
    if (!B.n) return;
    ghost = new THREE.Mesh(B.geometry(), ghostMat);
    ghost.renderOrder = 10;
    view.scene.add(ghost);
  };
  rv.update = () => { if (rv.dirty) rv.rebuild(); };
  return rv;
}
