// Forests and street trees as two InstancedMeshes (trunks + canopies). Rebuilt when the
// tree layer changes; recoloured for the seasons.
import * as THREE from 'three';
import { N, idx } from '../core/grid.js';
import { UPG } from '../data/roads.js';
import { cellHeight } from '../sim/mapgen.js';
import { makeRng } from '../core/rng.js';
import { roadsideSpots } from '../sim/roadsegs.js';

const m = new THREE.Matrix4();
const q = new THREE.Quaternion();
const p = new THREE.Vector3();
const s = new THREE.Vector3();

const SEASON_LEAF = {
  spring: ['#6fae4a', '#7dbb55', '#5f9f43'],
  summer: ['#4e8a35', '#5a9640', '#447d2e'],
  autumn: ['#c9822f', '#b9562c', '#d6a23a', '#7d8f34'],
  winter: ['#dfe7ea', '#cfd8d9', '#9aa69f'],
};

export function createTreesView(view, state) {
  // Low-poly on purpose: a big map has a couple of hundred thousand trees
  const trunkGeo = new THREE.CylinderGeometry(0.03, 0.05, 1, 4, 1, true).translate(0, 0.5, 0);
  const coneGeo = new THREE.ConeGeometry(0.5, 1, 6, 1, true).translate(0, 0.5, 0);
  const blobGeo = new THREE.IcosahedronGeometry(0.5, 0).translate(0, 0.5, 0);
  const mat = () => new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true });
  const mats = { trunk: mat(), cone: mat(), blob: mat() };
  mats.trunk.color.set('#6b4f36');
  let cap = 0, trunks, cones, blobs, visible = true;
  // The meshes are sized to the forest: they're rebuilt bigger when trees spread
  function allocate(n) {
    for (const im of [trunks, cones, blobs]) if (im) { view.scene.remove(im); im.dispose(); }
    cap = n;
    trunks = new THREE.InstancedMesh(trunkGeo, mats.trunk, cap);
    cones = new THREE.InstancedMesh(coneGeo, mats.cone, cap);
    blobs = new THREE.InstancedMesh(blobGeo, mats.blob, cap);
    for (const im of [trunks, cones, blobs]) {
      im.castShadow = im !== trunks; // trunks are too thin to cast a shadow worth drawing
      im.receiveShadow = true;
      im.frustumCulled = false;
      im.count = 0;
      im.visible = visible;
      im.setColorAt(0, new THREE.Color('#ffffff')); // allocate per-instance colours up front
      view.scene.add(im);
    }
  }
  allocate(20000);

  const tv = { dirty: true, season: 'summer', lastBuild: 0 };
  const c = new THREE.Color();

  tv.rebuild = () => {
    let need = 0;
    for (let i = 0; i < N * N; i++) need += state.tree[i] * 2 + (state.road[i] && state.roadUpg[i] & UPG.TREES ? 2 : 0);
    if (need > cap) allocate(Math.ceil(need * 1.25));
    let nt = 0, nc = 0, nb = 0;
    const leaf = SEASON_LEAF[tv.season];
    const snowy = tv.season === 'winter';
    const place = (x, z, h, size, conifer, r) => {
      if (nt >= cap) return;
      p.set(x, h, z); q.identity(); s.set(size, size * 0.55, size);
      trunks.setMatrixAt(nt++, m.compose(p, q, s));
      p.y = h + size * 0.35;
      if (conifer) {
        s.set(size * 0.9, size * 1.5, size * 0.9);
        cones.setMatrixAt(nc, m.compose(p, q, s));
        cones.setColorAt(nc++, c.set(snowy ? r.pick(['#d6e0dc', '#4a6b45']) : r.pick(['#2f5e34', '#3b6b3a', '#2a5530'])));
      } else {
        if (snowy && r.chance(0.6)) return; // bare deciduous trees in winter
        s.set(size, size * 0.95, size);
        blobs.setMatrixAt(nb, m.compose(p, q, s));
        blobs.setColorAt(nb++, c.set(r.pick(leaf)));
      }
    };
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = idx(x, y);
        const n = state.tree[i];
        const roadTrees = state.road[i] && (state.roadUpg[i] & UPG.TREES) && !state.water[i]; // no trees on bridges
        if (!n && !roadTrees) continue;
        if (state.water[i] && !roadTrees) continue;
        const r = makeRng(i * 2654435761);
        const h = cellHeight(state, x, y);
        if (roadTrees) {
          for (const [tx, tz] of roadsideSpots(state, i, 0.5)) place(tx, tz, h, 0.45, false, r);
          continue;
        }
        const conRatio = state.climate === 'polar' || state.climate === 'continental' ? 0.7 : state.climate === 'hot' ? 0.2 : 0.4;
        for (let k = 0; k < n * 2; k++) {
          place(x + r.range(0.12, 0.88), y + r.range(0.12, 0.88), h - 0.05, r.range(0.55, 1.0), r.chance(conRatio), r);
        }
      }
    }
    trunks.count = nt; cones.count = nc; blobs.count = nb;
    for (const im of [trunks, cones, blobs]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
    tv.dirty = false;
  };

  tv.setVisible = (v) => { visible = v; for (const im of [trunks, cones, blobs]) im.visible = v; };
  tv.setSeason = (season) => {
    if (season !== tv.season) { tv.season = season; tv.dirty = true; }
  };

  tv.update = (now) => {
    // Throttle rebuilds: forests regrow cell by cell, no need to redraw every frame
    if (tv.dirty && now - tv.lastBuild > 400) { tv.rebuild(); tv.lastBuild = now; }
    // Tree shadows are too small to see from high up, and they're the costliest thing to
    // draw into the shadow map, so they're only cast while zoomed in
    const near = view.camera.position.distanceTo(view.controls.target) < 230;
    if (cones.castShadow !== near) cones.castShadow = blobs.castShadow = near;
  };
  return tv;
}
