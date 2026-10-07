// Power pylons (tapered lattice-style towers with a cross-arm) and sagging overhead wires.
// Wires run between pylons and to their "terminals": the pole of a Power Connector on a road,
// or the side of a power plant. A pylon standing right next to a connector or a plant gets a
// short drop wire to it, so you can always see where a line plugs in. Also draws the power
// line tool's preview.
import * as THREE from 'three';
import { N, idx, DIRS, inBounds } from '../core/grid.js';
import { cellHeight } from '../sim/mapgen.js';
import { hasConnector, isPowerBuilding } from '../sim/power.js';
import { roadsideSpots } from '../sim/roadsegs.js';
import { getDeck } from '../sim/deck.js';

export const PYLON_H = 2.6; // tall enough to carry wires over roads and low buildings
export const POLE_H = 1.15; // a Power Connector's pole
const ARM = 0.42;           // half-length of the cross-arm

export function createPowerView(view, state) {
  const towerGeo = new THREE.CylinderGeometry(0.05, 0.2, PYLON_H, 4, 1).translate(0, PYLON_H / 2, 0).rotateY(Math.PI / 4);
  const armGeo = new THREE.BoxGeometry(ARM * 2, 0.05, 0.06).translate(0, PYLON_H - 0.25, 0);
  const mat = new THREE.MeshStandardMaterial({ color: '#b4bcc4', metalness: 0.25, roughness: 0.55 });
  const towers = new THREE.InstancedMesh(towerGeo, mat, 2048);
  const arms = new THREE.InstancedMesh(armGeo, mat, 2048);
  for (const im of [towers, arms]) { im.count = 0; im.castShadow = true; im.frustumCulled = false; view.scene.add(im); }

  const wireMat = new THREE.LineBasicMaterial({ color: '#2a2d31' });
  const wires = new THREE.LineSegments(new THREE.BufferGeometry(), wireMat);
  wires.frustumCulled = false;
  view.scene.add(wires);

  const previewMat = new THREE.LineBasicMaterial({ color: '#ffd34f', transparent: true, opacity: 0.9, depthTest: false });
  const preview = new THREE.LineSegments(new THREE.BufferGeometry(), previewMat);
  preview.frustumCulled = false;
  preview.renderOrder = 20;
  view.scene.add(preview);
  const ghostTowers = new THREE.InstancedMesh(towerGeo, new THREE.MeshBasicMaterial({ color: '#ffd34f', transparent: true, opacity: 0.5, depthWrite: false }), 64);
  ghostTowers.count = 0;
  ghostTowers.frustumCulled = false;
  view.scene.add(ghostTowers);

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  const base = (i) => { const x = i % N, y = (i / N) | 0; return [x + 0.5, cellHeight(state, x, y), y + 0.5]; };

  // Where wires attach at a node: a pylon's arm tips and top; the top of a Power Connector's
  // pole; a point on the side of a power plant facing the wire
  function attach(i, toward) {
    if (state.power[i] || !(hasConnector(state, i) || state.bld[i])) {
      const [x, y, z] = base(i);
      return { x, z, low: y + PYLON_H - 0.25, top: y + PYLON_H, arm: ARM };
    }
    if (hasConnector(state, i)) {
      const [[px, pz]] = roadsideSpots(state, i, 0.46);
      const h = getDeck(state).road.center[i] + POLE_H;
      return { x: px, z: pz, low: h - 0.05, top: h, arm: 0.14 };
    }
    const b = state.buildings.get(state.bld[i]);
    const [x, , z] = base(i);
    // step from the cell's middle toward the other end of the wire, to the building's edge
    let tx = x, tz = z;
    if (toward) {
      const dx = toward[0] - x, dz = toward[1] - z, l = Math.hypot(dx, dz) || 1;
      tx = Math.min(b.x1 + 1, Math.max(b.x0, x + (dx / l) * 0.45));
      tz = Math.min(b.y1 + 1, Math.max(b.y0, z + (dz / l) * 0.45));
    }
    const h = (b.baseY ?? 0) + Math.max(0.6, (b.height || 1) * 0.7);
    return { x: tx, z: tz, low: h - 0.05, top: h, arm: 0.18 };
  }

  // Three wires per span: one on each arm tip and one on top, sagging in the middle
  function spanSegments(a, b, out) {
    const [ax0, , az0] = base(a), [bx0, , bz0] = base(b);
    const A = attach(a, [bx0, bz0]), B = attach(b, [ax0, az0]);
    const dx = B.x - A.x, dz = B.z - A.z;
    const len = Math.hypot(dx, dz) || 1;
    const px = -dz / len, pz = dx / len; // across the span
    const sag = 0.04 * len + 0.05;
    for (const [side, top] of [[-1, false], [1, false], [0, true]]) {
      const SEG = 8;
      const ya = top ? A.top : A.low, yb = top ? B.top : B.low;
      for (let k = 0; k < SEG; k++) {
        for (const t of [k / SEG, (k + 1) / SEG]) {
          const off = side * (A.arm + (B.arm - A.arm) * t);
          out.push(A.x + dx * t + px * off, ya + (yb - ya) * t - sag * 4 * t * (1 - t), A.z + dz * t + pz * off);
        }
      }
    }
  }

  // Pylons standing right next to a connector or a plant they feed from: a short drop wire
  function dropSegments(out) {
    for (let i = 0; i < N * N; i++) {
      if (!state.power[i]) continue;
      const x = i % N, y = (i / N) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        const j = idx(nx, ny);
        const plant = isPowerBuilding(state.bld[j] && state.buildings.get(state.bld[j]));
        if (!hasConnector(state, j) && !plant) continue;
        if (state.powerSpans.some(([a, b]) => (a === i && b === j) || (a === j && b === i))) continue;
        spanSegments(i, j, out);
      }
    }
  }

  const pv = { dirty: true };
  pv.rebuild = () => {
    // arm direction per pylon: average of its spans' directions
    const dir = new Map();
    for (const [a, b] of state.powerSpans) {
      const [ax, , az] = base(a), [bx, , bz] = base(b);
      const ang = Math.atan2(-(bz - az), bx - ax);
      for (const i of [a, b]) if (!dir.has(i)) dir.set(i, ang);
    }
    let n = 0;
    for (let i = 0; i < N * N; i++) {
      if (!state.power[i]) continue;
      const [x, y, z] = base(i);
      // the cross-arm runs across the line, so rotate by the span angle + 90°
      q.setFromAxisAngle(up, (dir.get(i) ?? 0) + Math.PI / 2);
      p.set(x, y - 0.05, z);
      m.compose(p, q, one);
      towers.setMatrixAt(n, m);
      arms.setMatrixAt(n, m);
      n++;
    }
    towers.count = arms.count = n;
    towers.instanceMatrix.needsUpdate = arms.instanceMatrix.needsUpdate = true;
    const pts = [];
    for (const [a, b] of state.powerSpans) spanSegments(a, b, pts);
    dropSegments(pts);
    wires.geometry.dispose();
    wires.geometry = new THREE.BufferGeometry();
    wires.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    pv.dirty = false;
  };

  // chain: pylon cell indices in order; newCells: which of them would be new pylons
  pv.setPreview = (chain, newCells = [], ok = true) => {
    previewMat.color.set(ok ? '#ffd34f' : '#ff5a4f');
    const pts = [];
    for (let k = 1; k < (chain?.length || 0); k++) spanSegments(chain[k - 1], chain[k], pts);
    preview.geometry.dispose();
    preview.geometry = new THREE.BufferGeometry();
    preview.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    ghostTowers.count = 0;
    for (const i of newCells.slice(0, 64)) {
      const [x, y, z] = base(i);
      p.set(x, y - 0.05, z);
      ghostTowers.setMatrixAt(ghostTowers.count++, m.compose(p, q.identity(), one));
    }
    ghostTowers.instanceMatrix.needsUpdate = true;
  };
  pv.clearPreview = () => pv.setPreview([], []);

  pv.setVisible = (v) => { towers.visible = arms.visible = wires.visible = v; };
  pv.update = () => { if (pv.dirty) pv.rebuild(); };
  return pv;
}
