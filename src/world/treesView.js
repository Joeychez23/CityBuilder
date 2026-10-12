// Forests and street trees as InstancedMeshes (trunks, conifers and leafy canopies). Rebuilt
// when the tree layer changes; recoloured for the seasons.
import * as THREE from 'three';
import { N, idx } from '../core/grid.js';
import { UPG } from '../data/roads.js';
import { cellHeight } from '../sim/mapgen.js';
import { makeRng } from '../core/rng.js';
import { roadsideSpots } from '../sim/roadnet.js';

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

// The map is split into square chunks, each with its own meshes: chunks out of view aren't
// drawn, and when something changes only the chunks whose trees (or the ground under them)
// changed are rebuilt. Far from the camera a chunk draws only some of its trees (each
// chunk's trees are in a random order, so the first so many are spread all over it) and no
// trunks: a tree there is a pixel or two across.
const CH = 128;
const CN = Math.ceil(N / CH);
const FULL = 260; // trees closer than this are all drawn
const SPARSE = 0.15; // the share of them drawn far away

export function createTreesView(view, state) {
  // Low-poly on purpose: a big map has a couple of hundred thousand trees
  const trunkGeo = new THREE.CylinderGeometry(0.03, 0.05, 1, 4, 1, true).translate(0, 0.5, 0);
  const coneGeo = new THREE.ConeGeometry(0.5, 1, 6, 1, true).translate(0, 0.5, 0);
  const blobGeo = new THREE.IcosahedronGeometry(0.5, 0).translate(0, 0.5, 0);
  const mat = () => new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true });
  const mats = { trunk: mat(), cone: mat(), blob: mat() };
  mats.trunk.color.set('#6b4f36');
  let visible = true, castNear = true;
  const chunks = [];
  for (let cz = 0; cz < CN; cz++) {
    for (let cx = 0; cx < CN; cx++) {
      const x0 = cx * CH, y0 = cz * CH, x1 = Math.min(N, x0 + CH) - 1, y1 = Math.min(N, y0 + CH) - 1;
      chunks.push({ x0, y0, x1, y1, cap: 0, sig: -1, meshes: null, full: [0, 0, 0], share: 1 });
    }
  }
  // A chunk's meshes are sized to its forest: they're made again, bigger, when trees spread
  function allocate(ch, n) {
    if (ch.meshes) for (const im of ch.meshes) { view.scene.remove(im); im.dispose(); }
    ch.cap = n;
    const sphere = new THREE.Sphere(new THREE.Vector3((ch.x0 + ch.x1 + 1) / 2, 0, (ch.y0 + ch.y1 + 1) / 2), CH * 0.75 + 30);
    ch.meshes = [[trunkGeo, mats.trunk], [coneGeo, mats.cone], [blobGeo, mats.blob]].map(([g, mt], k) => {
      const im = new THREE.InstancedMesh(g, mt, n);
      im.castShadow = k > 0 && castNear; // trunks are too thin to cast a shadow worth drawing
      im.receiveShadow = true;
      im.boundingSphere = sphere; // (the chunk: it's culled when out of view)
      im.count = 0;
      im.visible = visible;
      im.setColorAt(0, new THREE.Color('#ffffff')); // allocate per-instance colours up front
      view.scene.add(im);
      return im;
    });
  }

  const tv = { dirty: true, season: 'summer', lastBuild: 0 };
  let force = true; // rebuild every chunk (the season changed)
  const c = new THREE.Color();
  const roadTreesAt = (i) => state.road[i] && (state.roadUpg[i] & UPG.TREES) && !state.water[i] && !state.bridgeH[i]; // no trees on bridges

  // What a chunk's trees look like, as a number: the forest's cells, and the ground and
  // roads under them
  function signature(ch) {
    let h = 2166136261;
    const mix = (v) => { h = Math.imul(h ^ v, 16777619); };
    for (let y = ch.y0; y <= ch.y1; y++) {
      for (let x = ch.x0; x <= ch.x1; x++) {
        const i = idx(x, y);
        const n = state.tree[i], rt = roadTreesAt(i);
        if (!n && !rt) continue;
        if (state.water[i] && !rt) continue;
        mix(i); mix(rt ? 4 + state.roadSeg[i] * 8 : n); mix(Math.round(cellHeight(state, x, y) * 64));
      }
    }
    return h >>> 0;
  }

  function buildChunk(ch) {
    let need = 0;
    for (let y = ch.y0; y <= ch.y1; y++) for (let x = ch.x0; x <= ch.x1; x++) { const i = idx(x, y); need += state.tree[i] * 2 + (roadTreesAt(i) ? 2 : 0); }
    if (!need && !ch.meshes) return;
    if (need > ch.cap) allocate(ch, Math.ceil(need * 1.25) + 64);
    const [trunks, cones, blobs] = ch.meshes;
    const cap = ch.cap;
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
    const conRatio = state.climate === 'polar' || state.climate === 'continental' ? 0.7 : state.climate === 'hot' ? 0.2 : 0.4;
    for (let y = ch.y0; y <= ch.y1; y++) {
      for (let x = ch.x0; x <= ch.x1; x++) {
        const i = idx(x, y);
        const n = state.tree[i];
        const roadTrees = roadTreesAt(i);
        if (!n && !roadTrees) continue;
        if (state.water[i] && !roadTrees) continue;
        const r = makeRng(i * 2654435761);
        const h = cellHeight(state, x, y);
        if (roadTrees) {
          for (const [tx, tz] of roadsideSpots(state, i, 0.5)) place(tx, tz, h, 0.45, false, r);
          continue;
        }
        for (let k = 0; k < n * 2; k++) {
          place(x + r.range(0.12, 0.88), y + r.range(0.12, 0.88), h - 0.05, r.range(0.55, 1.0), r.chance(conRatio), r);
        }
      }
    }
    shuffle(cones, nc, makeRng(ch.x0 * 31 + ch.y0));
    shuffle(blobs, nb, makeRng(ch.x0 * 17 + ch.y0 * 3));
    ch.full = [nt, nc, nb];
    ch.share = -1; // (counts set by the next update)
    for (const im of ch.meshes) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }

  // The first n trees of a mesh put in a random order
  function shuffle(im, n, r) {
    const M = im.instanceMatrix.array, C = im.instanceColor?.array;
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(r.next() * (i + 1));
      for (let k = 0; k < 16; k++) { const t = M[i * 16 + k]; M[i * 16 + k] = M[j * 16 + k]; M[j * 16 + k] = t; }
      if (C) for (let k = 0; k < 3; k++) { const t = C[i * 3 + k]; C[i * 3 + k] = C[j * 3 + k]; C[j * 3 + k] = t; }
    }
  }

  // Rebuild the chunks whose trees changed (all of them when the season turns)
  tv.rebuild = () => {
    for (const ch of chunks) {
      const sig = signature(ch);
      if (!force && sig === ch.sig) continue;
      ch.sig = sig;
      buildChunk(ch);
    }
    force = false;
    tv.dirty = false;
  };

  tv.setVisible = (v) => { visible = v; for (const ch of chunks) if (ch.meshes) for (const im of ch.meshes) im.visible = v; };
  tv.setSeason = (season) => {
    if (season !== tv.season) { tv.season = season; tv.dirty = true; force = true; }
  };

  tv.update = (now) => {
    // Throttle rebuilds: forests regrow cell by cell, no need to redraw every frame
    if (tv.dirty && now - tv.lastBuild > 400) { tv.rebuild(); tv.lastBuild = now; }
    // how many of each chunk's trees to draw, by how far away it is
    const cam = view.camera.position;
    for (const ch of chunks) {
      if (!ch.meshes) continue;
      const d = Math.hypot(cam.x - (ch.x0 + ch.x1 + 1) / 2, cam.y, cam.z - (ch.y0 + ch.y1 + 1) / 2) - CH * 0.5;
      const share = d < FULL ? 1 : Math.max(SPARSE, Math.round((FULL / d) ** 1.3 * 20) / 20);
      if (share === ch.share) continue;
      ch.share = share;
      const [trunks, cones, blobs] = ch.meshes;
      trunks.count = share === 1 ? ch.full[0] : 0;
      cones.count = Math.ceil(ch.full[1] * share);
      blobs.count = Math.ceil(ch.full[2] * share);
    }
    // Tree shadows are too small to see from high up, and they're the costliest thing to
    // draw into the shadow map, so they're only cast while zoomed in
    const near = view.camera.position.distanceTo(view.controls.target) < 230;
    if (castNear !== near) {
      castNear = near;
      for (const ch of chunks) if (ch.meshes) ch.meshes[1].castShadow = ch.meshes[2].castShadow = near;
    }
  };
  return tv;
}
