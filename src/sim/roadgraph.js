// The road network as a graph, for routing and traffic. Every segment is one edge each way it
// can be driven (a one-way road only from its first node to its second); edges meet at nodes.
// Trips start and end at points along roads ("access points": { seg, s }, s the distance
// along the segment), not at nodes. Routes are found with A* over the edges, so a route
// never turns straight back the way it came at a junction (only at a dead end).
//
// Junction kinds (by node), as the roads meeting there decide (see junctionKindOf):
//   0 none (two roads or fewer), 1 traffic lights, 2 roundabout, 3 give way (small roads:
//   one car at a time), 4 merge (highways, one-way roads), 5 priority (a local street joins a
//   bigger through road and gives way to it: the main road keeps most of its flow)
import { N, idx, inBounds } from '../core/grid.js';
import { ROADS, rankOf } from '../data/roads.js';
import { rn, openAt } from './roadnet.js';
import { chainCells } from './roadraster.js';
import { nearestOnCurve, bezTan } from './roadgeom.js';

export const eidOf = (sid, d) => sid * 2 + (d > 0 ? 0 : 1);
export const segOfEdge = (eid) => eid >> 1;
export const reverseEdge = (eid) => eid ^ 1;

let G = null;
// The graph (rebuilt whenever the road network changes)
export function graph(state) {
  const X = rn(state);
  if (G && G.X === X) return G;
  const edges = new Map(), out = new Map(), inc = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const s of X.seg.values()) {
    const g = X.geo.get(s.id);
    if (!g) continue;
    const def = ROADS[s.type];
    for (const d of def.oneway ? [1] : [1, -1]) {
      const e = { id: eidOf(s.id, d), seg: s.id, d, from: d > 0 ? s.a : s.b, to: d > 0 ? s.b : s.a, len: g.len, def };
      edges.set(e.id, e);
      push(out, e.from, e.id);
      push(inc, e.to, e.id);
    }
  }
  const kind = new Map(), nodeCell = new Map(), cellNode = new Map();
  for (const n of X.node.values()) {
    kind.set(n.id, junctionKindOf(X, n));
    const cx = Math.floor(n.x), cz = Math.floor(n.z);
    if (inBounds(cx, cz)) {
      const i = idx(cx, cz);
      nodeCell.set(n.id, i);
      // (a cell with several nodes in it: the busiest junction speaks for it)
      const prev = cellNode.get(i);
      if (prev == null || (X.at.get(n.id)?.length || 0) > (X.at.get(prev)?.length || 0)) cellNode.set(i, n.id);
    }
  }
  // connected parts of the network (any way round: one-way roads still join their ends)
  const parent = new Map();
  const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  for (const n of X.node.values()) parent.set(n.id, n.id);
  for (const s of X.seg.values()) if (parent.has(s.a) && parent.has(s.b)) parent.set(find(s.a), find(s.b));
  const comp = new Map(), ids = new Map();
  for (const n of X.node.values()) {
    const r = find(n.id);
    if (!ids.has(r)) ids.set(r, ids.size);
    comp.set(n.id, ids.get(r));
  }
  G = { X, edges, out, inc, kind, nodeCell, cellNode, comp, compCount: ids.size };
  return G;
}

// How the junction at node n is controlled
function junctionKindOf(X, n) {
  const segs = (X.at.get(n.id) || []).map((id) => X.seg.get(id)).filter(Boolean);
  if (n.ctrl === 'roundabout' && segs.length >= 3) return 2;
  if (n.ctrl === 'lights' && segs.length >= 3) return 1;
  if (n.ctrl === 'stop' && segs.length >= 3) return 3;
  if (segs.length < 3) return 0;
  const defs = segs.map((s) => ROADS[s.type]);
  if (defs.some((d) => d.key === 'highway')) return 4;
  if (defs.every((d) => d.oneway)) return 4;
  let top = -1, topCount = 0, big = 0;
  for (const d of defs) {
    const r = rankOf(d.id);
    if (r > top) { top = r; topCount = 1; } else if (r === top) topCount++;
    big = Math.max(big, d.capacity);
  }
  const sideMax = Math.max(-1, ...defs.map((d) => rankOf(d.id)).filter((r) => r < top));
  // a collector or bigger runs straight through and only local streets join it from the side
  if (topCount === 2 && top > 0 && sideMax === 0) {
    const tops = segs.filter((s) => rankOf(s.type) === top).map((s) => leave(X, s, n.id));
    if (tops[0][0] * tops[1][0] + tops[0][1] * tops[1][1] < -0.7) return 5;
  }
  return big <= 10 ? 3 : 1;
}
const leave = (X, s, nid) => { const d = bezTan(X.geo.get(s.id).c, s.a === nid ? 0 : 1); return s.a === nid ? d : [-d[0], -d[1]]; };

// --------------------------------------------------------------- access points
// The point on a road nearest the middle of a cell (a cell with a road, or next to one)
export function pointAtCell(state, i) {
  if (i == null || i < 0) return null;
  const X = rn(state);
  const sid = state.roadSeg?.[i];
  const s = sid && X.seg.get(sid);
  if (!s) return null;
  const g = X.geo.get(sid);
  const q = nearestOnCurve(g.c, g.tab, (i % N) + 0.5, ((i / N) | 0) + 0.5);
  return { seg: sid, s: q.s, cell: i };
}

// --------------------------------------------------------------------- A*
// Binary heap of [f, key]
class Heap {
  constructor() { this.f = []; this.k = []; }
  get size() { return this.f.length; }
  push(f, k) {
    const F = this.f, K = this.k;
    let i = F.length;
    F.push(f); K.push(k);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (F[p] <= F[i]) break;
      [F[p], F[i]] = [F[i], F[p]]; [K[p], K[i]] = [K[i], K[p]];
      i = p;
    }
  }
  pop() {
    const F = this.f, K = this.k;
    const top = K[0], last = F.length - 1;
    if (last > 0) {
      F[0] = F[last]; K[0] = K[last];
      F.pop(); K.pop();
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < F.length && F[l] < F[m]) m = l;
        if (r < F.length && F[r] < F[m]) m = r;
        if (m === i) break;
        [F[m], F[i]] = [F[i], F[m]]; [K[m], K[i]] = [K[i], K[m]];
        i = m;
      }
    } else { F.pop(); K.pop(); }
    return top;
  }
}

// A route from access point A to access point B. cost: { unit(edge) (cost per cell along it),
// turn(prev edge, edge) (cost of the junction between them), ok(edge) }. minUnit: the least
// unit cost there is (keeps the search admissible). Returns { edges, from, to, cost } (edges:
// the directed edges driven, in order; the first and last only partly) or null.
export function findRoute(state, A, B, cost, { minUnit = 0.4, maxExpand = 40000 } = {}) {
  if (!A || !B) return null;
  const Gr = graph(state);
  const X = Gr.X;
  const sa = X.seg.get(A.seg), sb = X.seg.get(B.seg);
  if (!sa || !sb) return null;
  const gB = X.geo.get(B.seg);
  const bp = gB.pts[Math.min(gB.pts.length - 1, Math.round((B.s / gB.len) * (gB.pts.length - 1)))];
  const nodeH = (nid) => { const n = X.node.get(nid); return Math.hypot(n.x - bp.x, n.z - bp.z) * minUnit; };
  const g = new Map(), came = new Map(), closed = new Set();
  const heap = new Heap();
  const GOAL = -1;
  let best = Infinity, bestFrom = null;
  // straight there along the same road
  if (A.seg === B.seg) {
    for (const d of ROADS[sa.type].oneway ? [1] : [1, -1]) {
      if ((d > 0 && B.s >= A.s) || (d < 0 && B.s <= A.s)) {
        const e = Gr.edges.get(eidOf(A.seg, d));
        if (e && cost.ok(e)) { const c = Math.abs(B.s - A.s) * cost.unit(e); if (c < best) { best = c; bestFrom = { direct: e.id }; } }
      }
    }
  }
  // out of the start point to either end of its road
  for (const d of [1, -1]) {
    const e = Gr.edges.get(eidOf(A.seg, d));
    if (!e || !cost.ok(e)) continue;
    const c = (d > 0 ? e.len - A.s : A.s) * cost.unit(e);
    if (c < (g.get(e.id) ?? Infinity)) { g.set(e.id, c); came.set(e.id, null); heap.push(c + nodeH(e.to), e.id); }
  }
  let expanded = 0;
  while (heap.size) {
    const key = heap.pop();
    if (key === GOAL) break;
    if (closed.has(key)) continue;
    closed.add(key);
    const gk = g.get(key);
    if (gk >= best) break;
    if (++expanded > maxExpand) break;
    const e = Gr.edges.get(key);
    const outs = Gr.out.get(e.to) || [];
    // (turning back the way it came only where the road ends)
    const deadEnd = outs.every((o) => (o >> 1) === e.seg);
    for (const o of outs) {
      if ((o >> 1) === e.seg && !deadEnd) continue;
      const e2 = Gr.edges.get(o);
      if (!cost.ok(e2)) continue;
      const turn = cost.turn(e, e2);
      if (!(turn < Infinity)) continue;
      // the end of the trip is along this road
      if (e2.seg === B.seg) {
        const c = gk + turn + (e2.d > 0 ? B.s : e2.len - B.s) * cost.unit(e2);
        if (c < best) { best = c; bestFrom = { last: e2.id, prev: key }; heap.push(c, GOAL); }
      }
      const c = gk + turn + e2.len * cost.unit(e2);
      if (c < (g.get(o) ?? Infinity)) { g.set(o, c); came.set(o, key); heap.push(c + nodeH(e2.to), o); }
    }
  }
  if (!bestFrom) return null;
  if (bestFrom.direct != null) return { edges: [bestFrom.direct], from: A, to: B, cost: best };
  const list = [bestFrom.last];
  for (let k = bestFrom.prev; k != null; k = came.get(k)) list.push(k);
  list.reverse();
  return { edges: list, from: A, to: B, cost: best };
}

// What a route found earlier costs now (by the same cost functions)
export function routeCost(state, r, cost) {
  const Gr = graph(state);
  let c = 0;
  for (let k = 0; k < r.edges.length; k++) {
    const e = Gr.edges.get(r.edges[k]);
    if (!e || !cost.ok(e)) return Infinity;
    let len = e.len;
    if (r.edges.length === 1) len = Math.abs(r.to.s - r.from.s);
    else if (k === 0) len = e.d > 0 ? e.len - r.from.s : r.from.s;
    else if (k === r.edges.length - 1) len = e.d > 0 ? r.to.s : e.len - r.to.s;
    if (k > 0) c += cost.turn(Gr.edges.get(r.edges[k - 1]), e);
    c += len * cost.unit(e);
  }
  return c;
}

// The cells a route drives through, in order (for code that thinks in cells). Inside a tunnel
// the route jumps from one open end to the other.
export function routeCells(state, r) {
  const Gr = graph(state);
  const X = Gr.X;
  const cells = [];
  const add = (i) => { if (i >= 0 && cells[cells.length - 1] !== i) cells.push(i); };
  for (let k = 0; k < r.edges.length; k++) {
    const e = Gr.edges.get(r.edges[k]);
    if (!e) continue;
    const g = X.geo.get(e.seg), s = X.seg.get(e.seg);
    if (!g.chain) g.chain = chainCells(g.c, g.tab);
    const { cells: ch, ss } = g.chain;
    let a = 0, b = g.len;
    if (k === 0) { if (e.d > 0) a = r.from.s; else b = r.from.s; }
    if (k === r.edges.length - 1) { if (e.d > 0) b = r.to.s; else a = r.to.s; }
    const pick = [];
    for (let j = 0; j < ch.length; j++) if (ss[j] >= a - 0.5 && ss[j] <= b + 0.5 && (!s.tn || openAt(state, e.seg, ss[j]))) pick.push(ch[j]);
    if (e.d < 0) pick.reverse();
    for (const i of pick) add(i);
  }
  if (!cells.length && r.from.cell != null) cells.push(r.from.cell);
  return cells;
}
