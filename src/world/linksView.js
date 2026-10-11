// Drawing the city's big links: railway tunnel portals (and the tunnels themselves while you look
// underground), the hyperloop's tube on its pylons with pods racing along it, and the towers
// and cables of suspension bridges.
import * as THREE from 'three';
import { N } from '../core/grid.js';
import { terrainAt, cellHeight } from '../sim/mapgen.js';
import { rn, segY } from '../sim/roadnet.js';
import { bez, tAtS } from '../sim/roadgeom.js';
import { ROADS } from '../data/roads.js';
import { hyperloopTube } from '../sim/regional.js';
import { bus } from '../core/events.js';

const unit = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);

function boxes(scene, cap, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.7, ...opts });
  const mesh = new THREE.InstancedMesh(unit, mat, cap);
  mesh.count = 0; mesh.frustumCulled = false; mesh.castShadow = !opts.transparent; mesh.receiveShadow = !opts.transparent;
  mesh.setColorAt(0, _c.set('#fff'));
  scene.add(mesh);
  let n = 0;
  return {
    mesh,
    reset() { n = 0; },
    // a box from its bottom centre, turned by ry about the vertical
    add(x, y, z, sx, sy, sz, ry, color) {
      if (n >= cap) return;
      _q.setFromAxisAngle(UP, ry); _p.set(x, y, z); _s.set(sx, sy, sz);
      mesh.setMatrixAt(n, _m.compose(_p, _q, _s)); mesh.setColorAt(n, _c.set(color)); n++;
    },
    // a beam from point a to point b, `t` thick
    beam(a, b, t, color) {
      if (n >= cap) return;
      const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const len = d.length();
      if (len < 1e-4) return;
      _q.setFromUnitVectors(X, d.clone().normalize());
      _p.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
      _s.set(len, t, t);
      // (the unit box sits on its base: shift it down half its thickness)
      const off = new THREE.Vector3(0, -t / 2, 0).applyQuaternion(_q);
      _p.add(off);
      mesh.setMatrixAt(n, _m.compose(_p, _q, _s)); mesh.setColorAt(n, _c.set(color)); n++;
    },
    done() { mesh.count = n; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; },
  };
}

export function createLinksView(view, state) {
  const scene = view.scene;
  const fixed = boxes(scene, 6000);                                         // portals, tube, towers, cables
  const below = boxes(scene, 400, { transparent: true, opacity: 0.6, depthTest: false, depthWrite: false }); // tunnels, seen underground
  below.mesh.renderOrder = 12;
  const moving = boxes(scene, 400);                                          // pods
  let dirty = true, underground = false;
  const lv = { set dirty(v) { dirty = v; } };
  for (const ev of ['tunnels:changed', 'landmarkbridges:changed', 'network:changed', 'terrain:changed']) bus.on(ev, () => { dirty = true; });
  bus.on('building:add', (b) => { if (b.def.hyperloop) dirty = true; });
  bus.on('building:remove', (b) => { if (b.def.hyperloop) dirty = true; });
  bus.on('construction:done', (b) => { if (b.def.hyperloop) dirty = true; });

  let tube = null;
  function rebuild() {
    dirty = false;
    fixed.reset(); below.reset();
    // --- tunnel portals: a concrete mouth facing the other end, and the bore underground
    for (const t of state.tunnels || []) {
      const ends = [t.a, t.b].map((i) => [(i % N) + 0.5, ((i / N) | 0) + 0.5, cellHeight(state, i % N, (i / N) | 0)]);
      for (let k = 0; k < 2; k++) {
        const [x, z, y] = ends[k], [ox, oz] = ends[1 - k];
        const ry = Math.atan2(-(oz - z), ox - x);
        const w = t.layer === 'rail' ? 0.5 : Math.max(0.6, (ROADS[t.type]?.width || 0.7) + 0.15);
        const dx = Math.cos(ry), dz = -Math.sin(ry);
        fixed.add(x + dx * 0.35, y - 0.05, z + dz * 0.35, 0.3, 0.62, w + 0.3, ry, '#a9a49a');
        fixed.add(x + dx * 0.36, y - 0.05, z + dz * 0.36, 0.31, 0.4, w - 0.05, ry, '#1d1f22');
        fixed.add(x + dx * 0.15, y + 0.5, z + dz * 0.15, 0.5, 0.08, w + 0.4, ry, '#8d877b');
      }
      const lo = Math.min(ends[0][2], ends[1][2]) - 0.7;
      below.beam([ends[0][0], lo, ends[0][1]], [ends[1][0], lo, ends[1][1]], 0.35, t.layer === 'rail' ? '#c9b79a' : '#ffb84f');
    }
    // --- the hyperloop's tube, on pylons, out to the map edge
    tube = null;
    const st = [...state.buildings.values()].find((b) => b.def.hyperloop && !b.cons);
    if (st) {
      const pts = hyperloopTube(st);
      let prevY = (st.baseY ?? 0) + 1.6;
      const P = pts.map(([x, z], k) => {
        const g = terrainAt(state, Math.min(N - 0.01, Math.max(0, x)), Math.min(N - 0.01, Math.max(0, z)));
        const y = Math.max(g + 1.6, Math.max(state.seaLevel + 1.6, prevY - 0.25));
        prevY = y;
        return [x, y, z, g];
      });
      for (let k = 1; k < P.length; k++) fixed.beam([P[k - 1][0], P[k - 1][1], P[k - 1][2]], [P[k][0], P[k][1], P[k][2]], 0.32, '#e9eef3');
      for (let k = 2; k < P.length; k += 4) fixed.add(P[k][0], Math.min(P[k][3], P[k][1]) - 0.2, P[k][2], 0.16, P[k][1] - Math.min(P[k][3], P[k][1]) + 0.05, 0.16, 0, '#b9c2cc');
      tube = P;
    }
    // --- suspension bridges: two towers each side, main cables sagging between, hangers
    for (const lb of state.landmarkBridges || []) {
      // (along the bridge's road, at its deck height)
      const X = rn(state), g = lb.seg != null && X.geo.get(lb.seg);
      if (!g) continue;
      const m = Math.max(8, Math.round(g.len));
      const pts = [];
      for (let k = 0; k <= m; k++) { const sa = (g.len * k) / m, p = bez(g.c, tAtS(g.tab, sa)); pts.push([p[0], segY(state, lb.seg, sa), p[1]]); }
      const n = pts.length - 1;
      const a = pts[0], b = pts[n];
      const len = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
      const ux = (b[0] - a[0]) / len, uz = (b[2] - a[2]) / len, px = -uz, pz = ux;
      const w = (ROADS[lb.type]?.width || 0.9) / 2 + 0.12;
      const k1 = Math.round(n * 0.24), k2 = Math.round(n * 0.76);
      const top = (k) => pts[k][1] + 4.2;
      const ry = Math.atan2(-uz, ux);
      for (const k of [k1, k2]) {
        const [x, y, z] = pts[k];
        for (const sd of [-1, 1]) fixed.add(x + px * w * sd, state.seaLevel - 0.3, z + pz * w * sd, 0.24, top(k) - state.seaLevel + 0.3, 0.24, ry, '#c8352b');
        fixed.add(x, top(k) - 0.4, z, 0.22, 0.2, w * 2 + 0.24, ry, '#c8352b');
        fixed.add(x, y - 0.35, z, 0.24, 0.2, w * 2 + 0.2, ry, '#c8352b');
      }
      // cable height along the span: up from the ends to the tower tops, sagging between them
      const cableAt = (k) => {
        if (k <= k1) return pts[0][1] + 0.3 + (top(k1) - pts[0][1] - 0.3) * (k / Math.max(1, k1)) ** 1.6;
        if (k >= k2) return pts[n][1] + 0.3 + (top(k2) - pts[n][1] - 0.3) * ((n - k) / Math.max(1, n - k2)) ** 1.6;
        const m = (k - k1) / (k2 - k1);
        return top(k1) + (top(k2) - top(k1)) * m - 3.4 * 4 * m * (1 - m) * 0.92;
      };
      for (const sd of [-1, 1]) {
        let prev = null;
        for (let k = 0; k <= n; k++) {
          const [x, y, z] = pts[k];
          const c = [x + px * w * sd, cableAt(k), z + pz * w * sd];
          if (prev) fixed.beam(prev, c, 0.07, '#c8352b');
          if (k > 0 && k < n && k !== k1 && k !== k2) fixed.add(c[0], y + 0.05, c[2], 0.03, Math.max(0.05, c[1] - y - 0.05), 0.03, ry, '#d8d8d8');
          prev = c;
        }
      }
    }
    fixed.done(); below.done();
  }

  let podT = 0;
  lv.update = (dt) => {
    if (dirty) rebuild();
    below.mesh.visible = underground;
    const mul = state.time.paused ? 0 : [0, 1, 2.5, 4][state.time.speed] || 1;
    moving.reset();
    // pods: one every so often, out to the edge and back
    if (tube && tube.length > 2) {
      podT += dt * mul * 0.6;
      for (let p = 0; p < 2; p++) {
        const f = ((podT + p * 0.5) % 1);
        const along = f < 0.5 ? f * 2 : 2 - f * 2;
        const L = tube.length - 1, k = Math.min(L - 1, Math.floor(along * L)), fr = along * L - k;
        const A = tube[k], B = tube[k + 1];
        const ry = Math.atan2(-(B[2] - A[2]), B[0] - A[0]);
        moving.add(A[0] + (B[0] - A[0]) * fr, A[1] + (B[1] - A[1]) * fr - 0.13, A[2] + (B[2] - A[2]) * fr, 0.7, 0.18, 0.2, ry, '#7fd3ff');
      }
    }
    moving.done();
  };
  lv.setUnderground = (on) => { underground = on; };
  return lv;
}
