// Roads, rails, subway tunnels, power lines, water pipes and footpaths. Each network cell
// is drawn as an optional centre pad plus an "arm" toward every connected neighbour. Arm
// heights come from sim/deck.js: neighbours share the same edge height (so pieces always
// meet) and ground pieces never dip below the terrain. Raised cells are drawn as bridges, with
// any road passing under one drawn on the ground beneath it.
import * as THREE from 'three';
import { N, idx, DIRS, inBounds, clamp } from '../core/grid.js';
import { InstancedPool, boxMatrix, unitBox } from './instanced.js';
import { ROADS, UPG } from '../data/roads.js';
import { getDeck } from '../sim/deck.js';
import { segIndex, clipToCell, segPoint, segParam, roadsideSpots, crossingIn } from '../sim/roadsegs.js';
import { POLE_H } from './powerView.js';

const m = new THREE.Matrix4();
const col = new THREE.Color();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3();
const unitDisc = new THREE.CylinderGeometry(0.5, 0.5, 1, 24).translate(0, 0.5, 0);

// A slab whose top surface runs from A to B: width across, thickness below the surface.
function slabMatrix(ax, ay, az, bx, by, bz, width, thick, out = m) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const plan = Math.hypot(dx, dz) || 1e-6;
  const len = Math.hypot(plan, dy);
  _e.set(0, Math.atan2(-dz, dx), Math.atan2(dy, plan), 'YZX');
  _q.setFromEuler(_e);
  _up.set(0, 1, 0).applyQuaternion(_q);
  _p.set((ax + bx) / 2 - _up.x * thick, (ay + by) / 2 - _up.y * thick, (az + bz) / 2 - _up.z * thick);
  _s.set(len, thick, width);
  return out.compose(_p, _q, _s);
}

// What a bridge looks like, by what it carries (road bridges by the road's class)
//   deck: kerb/deck colour · girder: depth under the deck (girderW: its width, girderC colour)
//   pier: thickness along the deck (pierW: width across it), every: a pier every n cells,
//   cap: a cap beam on top of each pier · rail: parapet width, height, colour · lamps
const BRIDGE_STYLE = {
  track: { deck: '#bdb9b0', girder: 0.16, girderW: 0.7, girderC: '#8f8a82', pier: 0.26, pierW: 0.55, pierC: '#a29d93', every: 2, rail: { w: 0.04, h: 0.16, c: '#d9d6cf' } },
  local: { deck: '#c4c0b7', girder: 0.11, girderW: 0.62, girderC: '#6f7f8c', pier: 0.15, pierW: 0.5, pierC: '#8e959b', every: 2, rail: { w: 0.03, h: 0.15, c: '#8d9aa4' } },
  collector: { deck: '#bdb9b0', girder: 0.18, girderW: 0.74, girderC: '#8f8a82', pier: 0.24, pierW: 0.6, pierC: '#a29d93', every: 2, rail: { w: 0.05, h: 0.13, c: '#d1cdc4' } },
  arterial: { deck: '#b3afa6', girder: 0.26, girderW: 0.84, girderC: '#8a857c', pier: 0.3, pierW: 0.66, pierC: '#9b968c', every: 2, cap: true, rail: { w: 0.07, h: 0.16, c: '#cfcac0' }, lamps: true },
  highway: { deck: '#aaa69d', girder: 0.34, girderW: 0.9, girderC: '#7f7a72', pier: 0.36, pierW: 0.7, pierC: '#948f86', every: 3, cap: true, rail: { w: 0.08, h: 0.2, c: '#c9c4ba' }, lamps: true },
};

export function createNetworksView(view, state) {
  const scene = view.scene;
  const flat = () => new THREE.MeshStandardMaterial({ roughness: 0.9 });
  const pools = {
    sidewalk: new InstancedPool(scene, unitBox, flat(), 4096, { shadows: false }),
    asphalt: new InstancedPool(scene, unitBox, flat(), 8192, { shadows: false }),
    // (pulled toward the camera in the depth test so paint never flickers into the asphalt)
    marking: new InstancedPool(scene, unitBox, new THREE.MeshBasicMaterial({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }), 2048, { shadows: false }),
    pillar: new InstancedPool(scene, unitBox, flat(), 512),
    girder: new InstancedPool(scene, unitBox, flat(), 1024),
    railing: new InstancedPool(scene, unitBox, flat(), 1024, { shadows: false }),
    rail: new InstancedPool(scene, unitBox, flat(), 2048, { shadows: false }),
    subway: new InstancedPool(scene, unitBox, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthTest: false }), 1024, { shadows: false }),
    pole: new InstancedPool(scene, unitBox, flat(), 1024),
    pipe: new InstancedPool(scene, unitBox, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8, depthTest: false }), 2048, { shadows: false }),
    path: new InstancedPool(scene, unitBox, flat(), 1024, { shadows: false }),
    lamp: new InstancedPool(scene, unitBox, new THREE.MeshBasicMaterial(), 1024, { shadows: false }),
    lampPost: new InstancedPool(scene, unitBox, flat(), 1024),
    // round joints where roads at an angle bend, cross or end
    jointKerb: new InstancedPool(scene, unitDisc, flat(), 512, { shadows: false }),
    jointAsphalt: new InstancedPool(scene, unitDisc, flat(), 512, { shadows: false }),
  };
  pools.subway.mesh.renderOrder = 5;
  pools.pipe.mesh.renderOrder = 5;

  const nv = { pools, dirty: true, roadColorFn: null, showSubway: false, showPipes: false };
  const roadArms = new Map(); // cell index -> asphalt handles (for recolouring)
  const underArms = new Map(); // cell index -> [handles, road type, cell it's coloured like] of a road under a bridge
  const roadJoints = new Map(); // cell index -> round joint handles (for recolouring)
  const segArms = new Map();    // cell index -> [handle, road type] of roads at an angle of another type
  const lamps = new Map();    // cell index -> lamp head handle (lit at night if the road has power)

  // Plain neighbour mask for layers without bridges (subway, pipes, power)
  function simpleLinks(layer, x, y) {
    let mask = 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
      if (inBounds(nx, ny) && layer[idx(nx, ny)]) mask |= 1 << d;
    }
    return mask;
  }

  // Pad + arms using a layer's centre/edge heights. lift = top above the surface.
  // pad: false = no centre pad (a diagonal road passes through instead)
  function drawCross(pool, L, x, y, mask, width, thick, lift, color, handles, pad = true) {
    const i = idx(x, y);
    const cx = x + 0.5, cz = y + 0.5;
    const h = L.center[i] + lift;
    const add = (mx) => { const hd = pool.add(mx, color); if (handles) handles.push(hd); };
    // Straight pieces are just their two arms; junctions, bends and ends get a flat pad
    if (pad && mask !== 5 && mask !== 10) add(boxMatrix(cx, h - thick, cz, width, thick, width, 0, m));
    for (let d = 0; d < 4; d++) {
      if (!(mask & (1 << d))) continue;
      const [dx, dz] = DIRS[d];
      add(slabMatrix(cx, h, cz, cx + dx * 0.51, L.edge[i * 4 + d] + lift, cz + dz * 0.51, width, thick));
    }
  }

  // Height along a road at an angle: one profile for its whole length, through the deck
  // heights of the cells it really runs through (cells it only grazes at a corner, and
  // stretches that were bulldozed, are left out). Every piece of it is cut from that
  // profile, so on hills the pieces meet without steps; at its ends and junctions it passes
  // through the cell's centre height, where the pad or round joint is.
  let profiles = new Map();
  function profileOf(L, s) {
    let p = profiles.get(s);
    if (p) return p;
    const SG = segIndex(state);
    const order = SG.orderOf.get(s);
    const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) || 1;
    const pts = [];
    const has = (i) => state.road[i] && order?.has(i);
    for (const [x, y] of SG.cellsOf.get(s) || []) {
      if (!inBounds(x, y) || !has(idx(x, y))) continue;
      // where it crosses another road at an angle, it passes through the crossing point at
      // the same height as the other road
      const others = SG.byCell.get(idx(x, y));
      const cross = others.length > 1 ? crossingIn(others, x, y) : null;
      if (cross?.at.has(s)) { pts.push([cross.at.get(s), L.center[idx(x, y)]]); continue; }
      const c = clipToCell(s, x, y);
      if (!c || (c[1] - c[0]) * len < 0.2) continue;
      const t = Math.min(c[1], Math.max(c[0], segParam(s, x + 0.5, y + 0.5)));
      pts.push([t, L.center[idx(x, y)]]);
    }
    const ia = inBounds(s.a[0], s.a[1]) ? idx(s.a[0], s.a[1]) : -1, ib = inBounds(s.b[0], s.b[1]) ? idx(s.b[0], s.b[1]) : -1;
    if (ia >= 0 && has(ia)) pts.push([0, L.center[ia]]);
    if (ib >= 0 && has(ib)) pts.push([1, L.center[ib]]);
    pts.sort((u, v) => u[0] - v[0]);
    // (the heights are already smoothed along the road, see sim/deck.js)
    p = { ts: pts.map((q) => q[0]), hs: pts.map((q) => q[1]) };
    profiles.set(s, p);
    return p;
  }
  function profileAt(p, t) {
    const { ts, hs } = p;
    if (!ts.length) return 0;
    if (t <= ts[0]) return hs[0];
    for (let k = 1; k < ts.length; k++) {
      if (t <= ts[k]) { const f = (t - ts[k - 1]) / Math.max(1e-9, ts[k] - ts[k - 1]); return hs[k - 1] + (hs[k] - hs[k - 1]) * f; }
    }
    return hs[hs.length - 1];
  }

  // The piece of a diagonal road inside cell (x, y): a slab along its line from where it
  // enters the cell to where it leaves, bent where the line passes nearest the cell's middle,
  // following the road's height profile
  // off: shift sideways from the line (railings along a bridge at an angle)
  // range: only the part between these parameters (a road that ends in this cell)
  function drawDiagonal(pool, L, s, x, y, width, thick, lift, color, handles, off = 0, range = null) {
    let c = clipToCell(s, x, y);
    if (c && range) c = [Math.max(c[0], range[0]), Math.min(c[1], range[1])];
    if (!c || c[1] - c[0] < 1e-6) return;
    const sl = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) || 1;
    const ox = (-(s.b[1] - s.a[1]) / sl) * off, oz = ((s.b[0] - s.a[0]) / sl) * off;
    const add = (mx) => { const hd = pool.add(mx, color); if (handles) handles.push(hd); };
    const prof = profileOf(L, s);
    const len = sl;
    const tm = Math.min(c[1], Math.max(c[0], segParam(s, x + 0.5, y + 0.5)));
    // split at the point nearest the cell's middle (skipping slivers shorter than 0.02 cells)
    const ts = [c[0]];
    for (const t of [tm, c[1]]) if ((t - ts[ts.length - 1]) * len > 0.02) ts.push(t);
    if (ts.length < 2) return;
    const over = 0.025 / len; // overlap a hair so neighbouring pieces never show a seam
    for (let k = 1; k < ts.length; k++) {
      const t0 = Math.max(0, ts[k - 1] - over), t1 = Math.min(1, ts[k] + over);
      const [ax, az] = segPoint(s, t0), [bx, bz] = segPoint(s, t1);
      add(slabMatrix(ax + ox, profileAt(prof, t0) + lift, az + oz, bx + ox, profileAt(prof, t1) + lift, bz + oz, width, thick));
    }
  }

  // Layers without bridges (subway, pipes) just follow the ground
  let groundL = null;
  function groundLayer(ground) {
    if (groundL && groundL.center === ground) return groundL;
    const edge = new Float32Array(N * N * 4);
    for (let i = 0; i < N * N; i++) {
      const x = i % N, y = (i / N) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
        edge[i * 4 + d] = inBounds(nx, ny) ? (ground[i] + ground[idx(nx, ny)]) / 2 : ground[i];
      }
    }
    groundL = { center: ground, edge };
    return groundL;
  }

  // Bridge structure: girders under the deck, piers to the ground, railings on both sides,
  // and an abutment where the deck lands on the road at either end. Road bridges are built
  // for the road they carry (st, see BRIDGE_STYLE): light steel for local streets, deeper
  // concrete for collectors, box girders with lamps and wider piers for avenues and highways.
  // diag: { sg } for a bridge at an angle (its piers stand on its line, turned square to it)
  function drawBridge(L, ground, x, y, mask, width, raisedLayer, abutMask = mask, st = BRIDGE_STYLE.track, diag = null) {
    const i = idx(x, y);
    const h = L.center[i];
    const cx = x + 0.5, cz = y + 0.5;
    const below = ground[i];
    // a road running under the deck keeps its piers out of the way: they stand either side of it
    const overRoad = !!state.underRoad?.[i];
    const besideRoad = !overRoad && raisedLayer === state.bridgeH && [0, 1, 2, 3].some((d) => (mask & (1 << d)) && inBounds(x + DIRS[d][0], y + DIRS[d][1]) && state.underRoad?.[idx(x + DIRS[d][0], y + DIRS[d][1])]);
    if (!overRoad && ((x + y) % st.every === 0 || besideRoad) && h - below > 0.3) {
      // a pier: thin along the deck, wide across it (with a cap beam under big decks)
      const bed = below - (state.water[i] ? 2 : 0.2);
      const top = h - 0.17 - st.girder;
      const across = width * st.pierW;
      let px = cx, pz = cz, ry = (mask & 5) !== 0 ? 0 : Math.PI / 2; // east-west deck: no turn
      if (diag) {
        const s = diag.sg;
        [px, pz] = segPoint(s, segParam(s, cx, cz));
        ry = Math.atan2(-(s.b[1] - s.a[1]), s.b[0] - s.a[0]);
      }
      pools.pillar.add(boxMatrix(px, bed, pz, st.pier, Math.max(0.05, top - bed), across, ry, m), st.pierC);
      if (st.cap) pools.pillar.add(boxMatrix(px, top - 0.12, pz, st.pier * 1.4, 0.12, width * 0.94, ry, m), st.pierC);
    }
    for (let d = 0; d < 4; d++) {
      const [dx, dz] = DIRS[d];
      const he = L.edge[i * 4 + d];
      const j = inBounds(x + dx, y + dz) ? idx(x + dx, y + dz) : -1;
      if ((abutMask & (1 << d)) && raisedLayer && j >= 0 && !raisedLayer[j]) {
        // abutment: a concrete wall under the end of the deck, down into the bank
        const foot = Math.min(below, ground[j]) - 0.4;
        const ax = cx + dx * 0.5, az = cz + dz * 0.5;
        pools.pillar.add(boxMatrix(ax, foot, az, dx ? 0.22 : width * 1.05, Math.max(0.1, he - 0.18 - foot), dx ? width * 1.05 : 0.22, 0, m), '#b3aea4');
      }
      if (!(mask & (1 << d))) continue;
      pools.girder.add(slabMatrix(cx, h - 0.17, cz, cx + dx * 0.51, he - 0.17, cz + dz * 0.51, width * st.girderW, st.girder), st.girderC);
      for (const side of [-1, 1]) {
        const ox = -dz * side * (width / 2 - st.rail.w / 2), oz = dx * side * (width / 2 - st.rail.w / 2);
        pools.railing.add(slabMatrix(cx + ox, h + st.rail.h, cz + oz, cx + dx * 0.51 + ox, he + st.rail.h, cz + dz * 0.51 + oz, st.rail.w, st.rail.h), st.rail.c);
      }
    }
  }

  // A road passing under a bridge: a straight piece on the ground below the deck, coloured
  // like the road beside it (its traffic is counted there)
  function drawUnder(U, x, y, i) {
    const type = state.underRoad[i], def = ROADS[type], um = U.masks[i];
    const like = um & 3 ? idx(x + (um & 1 ? 1 : 0), y + (um & 2 ? 1 : 0)) : idx(x - (um & 4 ? 1 : 0), y - (um & 8 ? 1 : 0));
    const handles = [];
    drawCross(pools.sidewalk, U, x, y, um, 1, 0.4, 0.03, def.key === 'highway' ? '#7d7f84' : '#b8b5ae', null);
    drawCross(pools.asphalt, U, x, y, um, def.width * 0.82, 0.1, 0.065, roadColor(like, type), handles);
    underArms.set(i, [handles, type, like]);
    if (def.key === 'gravel') return;
    drawCross(pools.marking, U, x, y, um, 0.04, 0.02, 0.075, def.oneway || def.key === 'highway' ? '#e8e8e8' : '#f1c94a');
    if (def.lanes < 2) return;
    const alongZ = (um & 10) !== 0, hc = U.center[i] + 0.075;
    for (let d = 0; d < 4; d++) {
      if (!(um & (1 << d))) continue;
      const [dx, dz] = DIRS[d];
      const he = hc + (U.edge[i * 4 + d] - U.center[i]) * (0.17 / 0.51);
      for (const o of laneOffsets(def)) {
        const ox = alongZ ? o : 0, oz = alongZ ? 0 : o;
        pools.marking.add(slabMatrix(x + 0.5 + ox, hc, y + 0.5 + oz, x + 0.5 + ox + dx * 0.17, he, y + 0.5 + oz + dz * 0.17, 0.03, 0.02), '#e8e8e8');
      }
    }
  }

  function roadColor(i, type) {
    if (nv.roadColorFn) return nv.roadColorFn(i, type);
    col.set(ROADS[type].color);
    const cond = state.roadCond[i];
    if (cond < 0.7) col.lerp(new THREE.Color('#8a8578'), (0.7 - cond) * 0.9);
    if (state.roadSnow[i] > 0.05) col.lerp(new THREE.Color('#f2f5f8'), clamp(state.roadSnow[i], 0, 0.9));
    if (state.accident[i] > 0) col.set('#d24a3a');
    // closed: a film shoot (orange), broken by an earthquake (rubble brown), under water (blue)
    const shut = state.closed?.[i];
    if (shut) col.set(shut === 1 ? '#f0a020' : shut === 2 ? '#6e5b47' : '#4f8fbf');
    return col.getHex();
  }

  // How far from the centre line the lane lines run (roads with more than one lane each way)
  function laneOffsets(def) {
    const w = def.width * 0.41;
    const offs = [];
    if (def.oneway) { for (let k = 1; k < def.lanes; k++) { const o = -w + (2 * w * k) / def.lanes; if (Math.abs(o) > 0.01) offs.push(o); } }
    else for (let k = 1; k < def.lanes; k++) { const o = (w * k) / def.lanes; offs.push(o, -o); }
    return offs;
  }

  // The road type of a road at an angle: the type most of its cells have (the cells where it
  // crosses another road take that road's type, so they don't count)
  let segTypes = new Map();
  function segTypeOf(SG, sg) {
    if (segTypes.has(sg)) return segTypes.get(sg);
    const count = new Map();
    for (const i of SG.orderOf.get(sg)?.keys() || []) {
      const t = state.road[i];
      if (!t || SG.byCell.get(i).length > 1 || state.roadNode[i]) continue;
      count.set(t, (count.get(t) || 0) + 1);
    }
    let best = 0, n = 0;
    for (const [t, c] of count) if (c > n) { best = t; n = c; }
    segTypes.set(sg, best);
    return best;
  }

  // Has the road at an angle been bulldozed right beside cell i (back or on along its
  // staircase, through any cells it only grazes at a corner)? Then it ends in this cell.
  function looseEnd(SG, sg, i, step) {
    const order = SG.orderOf.get(sg), cells = SG.cellsOf.get(sg);
    let k = order?.get(i);
    if (k == null) return false;
    const len = Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]);
    for (let n = 0; n < 3; n++) {
      k += step;
      const nb = cells[k];
      if (!nb || !inBounds(nb[0], nb[1])) return false;
      const j = idx(nb[0], nb[1]);
      if (!state.road[j] || !order.has(j)) return true;
      const c = clipToCell(sg, nb[0], nb[1]);
      if (c && (c[1] - c[0]) * len > 0.15) return false; // the road carries on through it
    }
    return false;
  }

  nv.rebuild = () => {
    for (const p of Object.values(pools)) p.clear();
    profiles = new Map();
    segTypes = new Map();
    roadArms.clear();
    underArms.clear();
    segArms.clear();
    roadJoints.clear();
    lamps.clear();
    const D = getDeck(state);
    const R = D.road, RL = D.rail, P = D.path;
    const G = groundLayer(D.ground);
    const SG = segIndex(state);
    // Cells of roads at an angle: the grid arms toward other roads joining there (ext), and
    // how many of those roads really run through (not just touching a corner)
    const cellInfo = new Map();
    for (const [i, segs] of SG.byCell) {
      const type = state.road[i];
      if (!type) continue;
      const x = i % N, y = (i / N) | 0;
      let ext = R.masks[i];
      if (x === 0 && type === 6) ext |= 4;
      for (let d = 0; d < 4; d++) if (SG.internal.has(i * 4 + d)) ext &= ~(1 << d);
      const through = segs.filter((sg) => { const c = clipToCell(sg, x, y); return c && (c[1] - c[0]) * Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]) > 0.05; }).length;
      cellInfo.set(i, { ext, through });
    }
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = idx(x, y);
        const type = state.road[i];
        if (type) {
          const def = ROADS[type];
          let mask = R.masks[i];
          if (x === 0 && type === 6) mask |= 4; // outside connection runs off the map edge
          const handles = [];
          const raised = state.bridgeH[i] > 0;
          const st = raised ? BRIDGE_STYLE[def.cls] : null;
          const h = R.center[i];
          // Diagonal roads through this cell draw their own straight piece; the grid arms
          // between cells on the same diagonal are left out
          const segs = SG.byCell.get(i);
          const info = segs ? cellInfo.get(i) : null;
          const ext = info ? info.ext : mask;
          const through = info ? info.through : 0;
          // grid pieces get a square pad at junctions, bends and ends; where roads at an angle
          // bend, cross or end on their own, a round joint fills the gap between them
          const pad = !segs || ext !== 0;
          const joint = segs && !pad && through > 0 && SG.ends.has(i);
          const junction = ext !== 0 && segs ? true : through > 1;
          const kerb = raised ? st.deck : def.key === 'highway' ? '#7d7f84' : '#b8b5ae';
          const thick = raised ? 0.2 : 0.4;
          const asphalt = roadColor(i, type);
          // a round joint (kerb and asphalt discs) centred on (px, pz) at height hc
          const roundJoint = (px, hc, pz) => {
            pools.jointKerb.add(boxMatrix(px, hc + 0.03 - thick, pz, 1, thick, 1, 0, m), kerb);
            const hd = pools.jointAsphalt.add(boxMatrix(px, hc + 0.065 - 0.1, pz, def.width * 0.82, 0.1, def.width * 0.82, 0, m), asphalt);
            if (!roadJoints.has(i)) roadJoints.set(i, []);
            roadJoints.get(i).push(hd);
          };
          // the kerb layer doubles as an embankment on slopes and the deck on bridges
          drawCross(pools.sidewalk, R, x, y, ext, 1, thick, 0.03, kerb, null, pad);
          drawCross(pools.asphalt, R, x, y, ext, def.width * 0.82, 0.1, 0.065, asphalt, handles, pad);
          if (joint) roundJoint(x + 0.5, h, y + 0.5);
          const lineC = def.oneway || def.key === 'highway' ? '#e8e8e8' : '#f1c94a';
          // where the road was bulldozed right beside this cell it ends here, in the middle
          // of the cell, with a rounded end
          const ranges = new Map();
          if (segs) {
            for (const sg of segs) {
              const back = looseEnd(SG, sg, i, -1), fwd = looseEnd(SG, sg, i, 1);
              let range = null;
              const c = (back || fwd) && clipToCell(sg, x, y);
              if (c) {
                const tm = Math.min(c[1], Math.max(c[0], segParam(sg, x + 0.5, y + 0.5)));
                range = [back ? tm : 0, fwd ? tm : 1];
                const [px, pz] = segPoint(sg, tm);
                roundJoint(px, profileAt(profileOf(R, sg), tm), pz);
              }
              ranges.set(sg, range);
              // a road at an angle keeps its own width and colour through the cells it shares
              // with the roads it crosses
              const st2 = segTypeOf(SG, sg) || type;
              const sdef = ROADS[st2];
              const own = st2 === type ? handles : [];
              drawDiagonal(pools.sidewalk, R, sg, x, y, 1, thick, 0.03, kerb, null, 0, range);
              drawDiagonal(pools.asphalt, R, sg, x, y, sdef.width * 0.82, 0.1, 0.065, st2 === type ? asphalt : roadColor(i, st2), own, 0, range);
              if (st2 !== type) { if (!segArms.has(i)) segArms.set(i, []); for (const hd of own) segArms.get(i).push([hd, st2]); }
              // no centre line painted across a junction
              if (sdef.key !== 'gravel' && !junction) drawDiagonal(pools.marking, R, sg, x, y, 0.04, 0.02, 0.075, sdef.oneway || sdef.key === 'highway' ? '#e8e8e8' : '#f1c94a', null, 0, range);
              // lane lines along roads with more than one lane each way
              if (sdef.lanes > 1 && !junction) for (const o of laneOffsets(sdef)) drawDiagonal(pools.marking, R, sg, x, y, 0.025, 0.02, 0.076, '#e8e8e8', null, o, range);
              if (raised) {
                // a bridge at an angle: girder under the deck, railings either side
                drawDiagonal(pools.girder, R, sg, x, y, st.girderW, st.girder, -0.17, st.girderC, null, 0, range);
                for (const side of [-0.5 + st.rail.w / 2, 0.5 - st.rail.w / 2]) drawDiagonal(pools.railing, R, sg, x, y, st.rail.w, st.rail.h, st.rail.h, st.rail.c, null, side, range);
              }
            }
          }
          roadArms.set(i, handles);
          if (raised) drawBridge(R, D.ground, x, y, segs ? ext : mask, 1, state.bridgeH, mask, st, segs && !ext ? { sg: segs[0] } : null);
          if (raised && state.underRoad[i] && R.under) drawUnder(R.under, x, y, i);
          const straightX = ext === 5 || ext === 1 || ext === 4;
          const straightZ = ext === 10 || ext === 2 || ext === 8;
          if ((straightX || straightZ) && def.key !== 'gravel') drawCross(pools.marking, R, x, y, ext, 0.04, 0.02, 0.075, lineC);
          // lane lines on roads with more than one lane each way, dashed on the grid (each
          // dash follows the slope of the road)
          if (def.lanes > 1 && (straightX || straightZ)) {
            const hc = h + 0.075;
            for (let d = 0; d < 4; d++) {
              if (!(ext & (1 << d))) continue;
              const [dx, dz] = DIRS[d];
              const he = hc + (R.edge[i * 4 + d] - h) * (0.17 / 0.51);
              for (const o of laneOffsets(def)) {
                const ox = straightZ ? o : 0, oz = straightZ ? 0 : o;
                pools.marking.add(slabMatrix(x + 0.5 + ox, hc, y + 0.5 + oz, x + 0.5 + ox + dx * 0.17, he, y + 0.5 + oz + dz * 0.17, 0.03, 0.02), '#e8e8e8');
              }
            }
          }
          if (raised && st.lamps && (x + y) % 2 === 0) {
            // street lamps along big bridges
            const alongX = (mask & 5) !== 0;
            const [[lx, lz], [rx, rz]] = segs ? roadsideSpots(state, i, 0.45) : alongX ? [[x + 0.5, y + 0.06], [x + 0.5, y + 0.94]] : [[x + 0.06, y + 0.5], [x + 0.94, y + 0.5]];
            const [px, pz] = (x + y) % 4 === 0 ? [lx, lz] : [rx, rz];
            pools.lampPost.add(boxMatrix(px, h + 0.03, pz, 0.045, 0.7, 0.045, 0, m), '#6b6e73');
            pools.lampPost.add(boxMatrix(px, h + 0.7, pz, 0.12, 0.05, 0.12, 0, m), '#e8e2c8');
          }
          if (state.roadUpg[i] & UPG.LIGHTS) {
            const [[lx, lz]] = roadsideSpots(state, i);
            pools.lampPost.add(boxMatrix(lx, h, lz, 0.05, 0.75, 0.05, 0, m), '#555');
            lamps.set(i, pools.lamp.add(boxMatrix(lx + (segs ? 0 : 0.04), h + 0.7, lz + (segs ? 0 : 0.04), 0.14, 0.07, 0.14, 0, m), '#5a5a5a'));
          }
          if (state.roadUpg[i] & UPG.POWER) {
            // Power Connector: a pole the wires come down to, and a green transformer box
            const [[px, pz]] = roadsideSpots(state, i, 0.46);
            pools.pole.add(boxMatrix(px, h, pz, 0.05, POLE_H, 0.05, 0, m), '#7a7d82');
            pools.pole.add(boxMatrix(px, h + POLE_H - 0.07, pz, 0.32, 0.04, 0.05, 0, m), '#7a7d82');
            pools.pillar.add(boxMatrix(px, h, pz, 0.24, 0.3, 0.24, 0, m), '#4f7a52');
            pools.pillar.add(boxMatrix(px, h + 0.3, pz, 0.12, 0.08, 0.12, 0, m), '#ffd300');
          }
          if (state.roadUpg[i] & UPG.BARRIER) {
            for (const d of [1, 3]) {
              if (mask & (1 << d)) continue;
              pools.pillar.add(boxMatrix(x + 0.5, h, y + 0.5 + DIRS[d][1] * 0.47, 1, 0.45, 0.05, 0, m), '#8fa3a8');
            }
            for (const d of [0, 2]) {
              if (mask & (1 << d)) continue;
              pools.pillar.add(boxMatrix(x + 0.5 + DIRS[d][0] * 0.47, h, y + 0.5, 0.05, 0.45, 1, 0, m), '#8fa3a8');
            }
          }
          if (state.roadUpg[i] & UPG.TOLL) {
            // toll gantry across the road: two posts, a yellow beam and a booth on each side
            const alongX = straightX || (!straightZ && (mask & 5));
            const across = (o) => (alongX ? [x + 0.5, y + 0.5 + o] : [x + 0.5 + o, y + 0.5]);
            for (const o of [-0.47, 0.47]) {
              const [px, pz] = across(o);
              pools.pillar.add(boxMatrix(px, h, pz, 0.06, 0.95, 0.06, 0, m), '#d9d6cf');
            }
            const [bx, bz] = across(0);
            pools.pillar.add(boxMatrix(bx, h + 0.86, bz, alongX ? 0.1 : 1, 0.14, alongX ? 1 : 0.1, 0, m), '#ffd300');
            pools.pillar.add(boxMatrix(bx, h + 0.86, bz, alongX ? 0.11 : 0.34, 0.1, alongX ? 0.34 : 0.11, 0, m), '#2f55ff');
            for (const o of [-0.3, 0.3]) {
              const [px, pz] = across(o);
              pools.pillar.add(boxMatrix(px, h, pz, alongX ? 0.2 : 0.12, 0.3, alongX ? 0.12 : 0.2, 0, m), '#f5f5f0');
            }
          }
          if (state.roadUpg[i] & UPG.TRAM) {
            for (const off of [-0.12, 0.12]) {
              pools.rail.add(boxMatrix(x + 0.5 + (straightZ ? off : 0), h + 0.07, y + 0.5 + (straightZ ? 0 : off), straightZ ? 0.03 : 1, 0.03, straightZ ? 1 : 0.03, 0, m), '#6b6157');
            }
          }
        }
        if (state.rail[i]) {
          const mask = RL.masks[i] | (y === 0 ? 8 : 0);
          const raised = state.railH[i] > 0;
          drawCross(pools.rail, RL, x, y, mask, 0.6, raised ? 0.2 : 0.35, 0.03, '#7a6f62');
          drawCross(pools.rail, RL, x, y, mask, 0.3, 0.05, 0.07, '#3e3a36');
          if (raised) drawBridge(RL, D.ground, x, y, mask, 0.6, state.railH);
        }
        if (state.subway[i]) drawCross(pools.subway, G, x, y, simpleLinks(state.subway, x, y), 0.3, 0.08, 0.2, '#b06be0');
        if (state.pipe[i]) drawCross(pools.pipe, G, x, y, simpleLinks(state.pipe, x, y), 0.14, 0.08, 0.15, '#3aa0ff');
        if (state.path[i]) {
          const mask = P.masks[i];
          const raised = state.pathH[i] > 0;
          drawCross(pools.path, P, x, y, mask, 0.3, raised ? 0.12 : 0.2, 0.04, '#d9cfb5');
          if (raised) drawBridge(P, D.ground, x, y, mask, 0.32, state.pathH);
        }
      }
    }
    // Bus & tram stops: a pole with a coloured sign at the kerb
    for (const key of Object.keys(state.stops)) {
      const i = +key;
      const y0 = R.center[i];
      const color = state.stops[key].type === 'tram' ? '#c94c4c' : '#3f8fd0';
      const [, [px, pz]] = roadsideSpots(state, i, 0.46);
      pools.pole.add(boxMatrix(px, y0, pz, 0.04, 0.55, 0.04, 0, m), '#cfcfcf');
      pools.pole.add(boxMatrix(px, y0 + 0.45, pz, 0.16, 0.14, 0.04, 0, m), color);
    }
    pools.subway.visible = nv.showSubway;
    pools.pipe.visible = nv.showPipes;
    nv.dirty = false;
  };

  // Cheap recolour of the asphalt only (traffic info view, snow, condition)
  nv.recolorRoads = () => {
    for (const [i, handles] of roadArms) {
      const c = roadColor(i, state.road[i]);
      for (const h of handles) pools.asphalt.setColor(h, col.set(c));
    }
    for (const [i, hs] of roadJoints) { const c = roadColor(i, state.road[i]); for (const h of hs) pools.jointAsphalt.setColor(h, col.set(c)); }
    for (const [, [hs, t, like]] of underArms) { const c = roadColor(like, t); for (const h of hs) pools.asphalt.setColor(h, col.set(c)); }
    for (const [i, list] of segArms) for (const [h, t] of list) pools.asphalt.setColor(h, col.set(roadColor(i, t)));
  };

  // Street lights glow at night, unless their road network is short of power
  let lampCtx = null, lampNight = -1;
  nv.refreshLamps = (ctx) => {
    if (ctx) lampCtx = ctx;
    const night = view.nightFactor > 0.35;
    lampNight = night;
    const ratio = new Map();
    for (const n of lampCtx?.elecNets || []) ratio.set(n.comp, n.ratio);
    for (const [i, h] of lamps) {
      const k = lampCtx?.elecComp?.[i] ?? -1;
      const r = ratio.get(k) ?? (lampCtx?.elecSourced?.has(k) ? 1 : 0);
      const on = night && ((i * 2654435761) >>> 0) / 4294967296 < r;
      pools.lamp.setColor(h, col.set(on ? '#ffe9a8' : night ? '#262626' : '#6a6a6a'));
    }
  };
  nv.setRoadColorFn = (fn) => { nv.roadColorFn = fn; nv.recolorRoads(); };
  nv.setLayerVisibility = ({ subway, pipes }) => {
    nv.showSubway = !!subway;
    nv.showPipes = !!pipes;
    pools.subway.visible = nv.showSubway;
    pools.pipe.visible = nv.showPipes;
  };
  nv.update = () => {
    if (nv.dirty) { nv.rebuild(); nv.refreshLamps(); }
    if ((view.nightFactor > 0.35) !== lampNight) nv.refreshLamps();
  };
  return nv;
}
