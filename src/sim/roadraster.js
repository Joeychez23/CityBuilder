// The road network on the hidden grid. Roads are curves between nodes (sim/roadnet.js), but
// much of the city still works cell by cell: power and water carried by roads, pollution and
// noise, what blocks a building, overlays. So every time the network changes, the cells each
// road passes through are worked out again (an unbroken 4-connected chain of cells along its
// line) and written into the per-cell layers those systems read:
//   state.road     road type on the cell (0 = none)        state.roadSeg  segment id
//   state.bridgeH  deck height where a raised road passes   state.roadUpg  the road's upgrades
//   state.roadCond condition
// None of these are saved: they're rebuilt from the network. (Routing, traffic and the
// vehicles you see run on the network itself: sim/roadgraph.js, sim/lanes.js.)
import { N, idx, inBounds } from '../core/grid.js';
import { ROADS, UPG, rankOf } from '../data/roads.js';
import { bez, tAtS } from './roadgeom.js';
import { union, roadBox } from './extent.js';

const NN = N * N;
const SEG_UPG = UPG.TREES | UPG.LIGHTS | UPG.BARRIER | UPG.BUSLANE | UPG.TRAM;

// The cells a curve passes through, in order, every one sharing an edge with the next:
// { cells: Int32Array, ss: Float32Array (distance along the curve at the middle of each) }
export function chainCells(c, tab) {
  const step = 0.05;
  const n = Math.max(2, Math.ceil(tab.len / step));
  const cells = [], ss = [];
  const p = [0, 0], q = [0, 0];
  let px = -1, pz = -1, ps = 0, first = 0;
  const close = () => { if (cells.length) ss[ss.length - 1] = (first + ps) / 2; };
  const add = (x, z, s) => { close(); cells.push(inBounds(x, z) ? idx(x, z) : -1); ss.push(s); first = s; px = x; pz = z; };
  for (let k = 0; k <= n; k++) {
    const s = (tab.len * k) / n;
    bez(c, tAtS(tab, s), p);
    const x = Math.floor(p[0]), z = Math.floor(p[1]);
    if (k === 0) { add(x, z, s); ps = s; continue; }
    if (x === px && z === pz) { ps = s; continue; }
    if (Math.abs(x - px) + Math.abs(z - pz) > 1) {
      // passed across a corner: take whichever side cell the line was nearer
      bez(c, tAtS(tab, (ps + s) / 2), q);
      const fx = Math.floor(q[0]), fz = Math.floor(q[1]);
      if (fx === x && fz === pz) add(x, pz, (ps + s) / 2);
      else add(px, z, (ps + s) / 2);
    }
    add(x, z, s);
    ps = s;
  }
  close();
  return { cells: Int32Array.from(cells), ss: Float32Array.from(ss) };
}

// Write the network into the per-cell layers. X: the network index (rn() in roadnet.js);
// heightAt(seg, s): a raised road's deck height s along it; openAt(seg, s): whether a road
// is open to the sky there (not inside a tunnel: nothing's on the surface there).
// (the part of the map each city's roads were last written over)
const written = new WeakMap();
export function writeRaster(state, X, heightAt, openAt = () => true) {
  const S = state;
  if (!S.roadSeg || S.roadSeg.length !== NN) S.roadSeg = new Int32Array(NN);
  const before = written.get(S) || [0, 0, N - 1, N - 1], now = roadBox(S);
  written.set(S, now);
  // (each cell of a box, row by row)
  const each = (b, fn) => { if (b) for (let y = b[1]; y <= b[3]; y++) for (let i = y * N + b[0], e = y * N + b[2]; i <= e; i++) fn(i); };
  // a road's wear is kept by its cells meanwhile (sim/traffic.js): bring it back to the road
  const sum = new Map();
  each(before, (i) => {
    const id = S.roadSeg[i];
    if (!id || !S.road[i]) return;
    const e = sum.get(id) || [0, 0];
    e[0] += S.roadCond[i]; e[1]++;
    sum.set(id, e);
  });
  for (const [id, [c, n]] of sum) { const s = X.seg.get(id); if (s) s.cond = c / n; }

  const was = S.road.slice();
  S.road.fill(0); S.roadSeg.fill(0); S.roadUpg.fill(0); S.bridgeH.fill(0);
  const ground = new Uint8Array(NN);
  const nodeCell = (n) => (inBounds(Math.floor(n.x), Math.floor(n.z)) ? idx(Math.floor(n.x), Math.floor(n.z)) : -1);
  // ground roads first, so a raised one passing over a ground road leaves it on its cells
  const order = [...X.seg.values()].sort((a, b) => (a.br ? 1 : 0) - (b.br ? 1 : 0));
  for (const s of order) {
    const g = X.geo.get(s.id);
    if (!g.chain) g.chain = chainCells(g.c, g.tab);
    const { cells, ss } = g.chain;
    const ends = new Set([nodeCell(X.node.get(s.a)), nodeCell(X.node.get(s.b))]);
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k];
      if (i < 0) continue;
      // (inside a tunnel: nothing on the surface)
      if (s.tn && !ends.has(i) && !openAt(s, ss[k])) continue;
      const raised = s.br && !ends.has(i) && !ground[i];
      if (!raised) ground[i] = 1;
      if (!S.road[i] || (!raised && S.bridgeH[i]) || rankOf(s.type) > rankOf(S.road[i])) {
        S.road[i] = s.type;
        S.roadSeg[i] = s.id;
        if (!was[i]) S.roadCond[i] = s.cond ?? 1;
      }
      if (raised) S.bridgeH[i] = Math.max(S.bridgeH[i], heightAt(s, ss[k]));
      else S.bridgeH[i] = 0;
      S.roadUpg[i] |= (s.upg || 0) & SEG_UPG;
    }
    // toll booths and power connectors stand at a point along the road
    for (const [key, bit] of [['toll', UPG.TOLL], ['power', UPG.POWER]]) {
      if (s[key] == null) continue;
      const k = cellAlong(g.chain, s[key] * g.len);
      if (k >= 0) S.roadUpg[cells[k]] |= bit;
    }
  }
  for (const n of X.node.values()) {
    const i = nodeCell(n);
    if (i < 0 || !S.road[i]) continue;
    if (n.ctrl === 'roundabout') S.roadUpg[i] |= UPG.ROUNDABOUT;
  }
  each(union(before, now), (i) => { if (!S.road[i]) { S.roadVol[i] = 0; S.roadCond[i] = 1; } });
}

// The chain cell nearest distance s along the road
export function cellAlong(chain, s) {
  const { cells, ss } = chain;
  let best = -1, bd = Infinity;
  for (let k = 0; k < cells.length; k++) {
    if (cells[k] < 0) continue;
    const d = Math.abs(ss[k] - s);
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}
