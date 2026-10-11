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
import { roadsideSpots, roadLevel } from '../sim/roadnet.js';
import { POLE_H } from './powerView.js';
import { union, roadBox, layerBox } from '../sim/extent.js';

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
export const BRIDGE_STYLE = {
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

  // Layers without bridges (subway, pipes) just follow the ground
  let groundL = null;
  function groundLayer(ground) {
    if (groundL && groundL.center === ground && groundL.box === groundBox) return groundL;
    const edge = new Float32Array(N * N * 4);
    // (only where there are subway tunnels or pipes)
    const [x0, y0, x1, y1] = groundBox || [0, 0, -1, -1];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = idx(x, y);
        for (let d = 0; d < 4; d++) {
          const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
          edge[i * 4 + d] = inBounds(nx, ny) ? (ground[i] + ground[idx(nx, ny)]) / 2 : ground[i];
        }
      }
    }
    groundL = { center: ground, edge, box: groundBox };
    return groundL;
  }
  let groundBox = null;

  // Bridge structure: girders under the deck, piers to the ground, railings on both sides,
  // and an abutment where the deck lands on the road at either end. Road bridges are built
  // for the road they carry (st, see BRIDGE_STYLE): light steel for local streets, deeper
  // concrete for collectors, box girders with lamps and wider piers for avenues and highways.
  function drawBridge(L, ground, x, y, mask, width, raisedLayer, abutMask = mask, st = BRIDGE_STYLE.track) {
    const i = idx(x, y);
    const h = L.center[i];
    const cx = x + 0.5, cz = y + 0.5;
    const below = ground[i];
    // a road running under the deck keeps its piers out of the way: they stand either side of it
    const roadAt = (j) => j >= 0 && state.road[j] && !state.bridgeH[j];
    const overRoad = roadAt(i);
    const besideRoad = !overRoad && [0, 1, 2, 3].some((d) => (mask & (1 << d)) && inBounds(x + DIRS[d][0], y + DIRS[d][1]) && roadAt(idx(x + DIRS[d][0], y + DIRS[d][1])));
    if (!overRoad && ((x + y) % st.every === 0 || besideRoad) && h - below > 0.3) {
      // a pier: thin along the deck, wide across it (with a cap beam under big decks)
      const bed = below - (state.water[i] ? 2 : 0.2);
      const top = h - 0.17 - st.girder;
      const across = width * st.pierW;
      const px = cx, pz = cz, ry = (mask & 5) !== 0 ? 0 : Math.PI / 2; // east-west deck: no turn
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

  nv.rebuild = () => {
    for (const p of Object.values(pools)) p.clear();
    lamps.clear();
    const D = getDeck(state);
    const RL = D.rail, P = D.path;
    const under = union(layerBox(state, 'subway'), layerBox(state, 'pipe'));
    if (String(under) !== String(groundBox)) groundBox = under;
    const G = groundLayer(D.ground);
    // (the part of the map with roads, railways, footpaths, subway tunnels or pipes)
    const box = union(union(roadBox(state), layerBox(state, 'rail')), union(layerBox(state, 'path'), under));
    const [bx0, by0, bx1, by1] = box || [0, 0, -1, -1];
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const i = idx(x, y);
        const type = state.road[i];
        if (type) {
          // (roads themselves are drawn by world/roadsView.js: here, what stands beside them)
          const h = roadLevel(state, i);
          if (state.roadUpg[i] & UPG.LIGHTS) {
            const [[lx, lz]] = roadsideSpots(state, i);
            pools.lampPost.add(boxMatrix(lx, h, lz, 0.05, 0.75, 0.05, 0, m), '#555');
            lamps.set(i, pools.lamp.add(boxMatrix(lx + 0.04, h + 0.7, lz + 0.04, 0.14, 0.07, 0.14, 0, m), '#5a5a5a'));
          }
          if (state.roadUpg[i] & UPG.POWER) {
            // Power Connector: a pole the wires come down to, and a green transformer box
            const [[px, pz]] = roadsideSpots(state, i, 0.46);
            pools.pole.add(boxMatrix(px, h, pz, 0.05, POLE_H, 0.05, 0, m), '#7a7d82');
            pools.pole.add(boxMatrix(px, h + POLE_H - 0.07, pz, 0.32, 0.04, 0.05, 0, m), '#7a7d82');
            pools.pillar.add(boxMatrix(px, h, pz, 0.24, 0.3, 0.24, 0, m), '#4f7a52');
            pools.pillar.add(boxMatrix(px, h + 0.3, pz, 0.12, 0.08, 0.12, 0, m), '#ffd300');
          }
          if (state.roadUpg[i] & UPG.TOLL) {
            // toll booth beside the road
            const [[px, pz], [qx, qz]] = roadsideSpots(state, i, 0.47);
            for (const [bx, bz] of [[px, pz], [qx, qz]]) {
              pools.pillar.add(boxMatrix(bx, h, bz, 0.06, 0.95, 0.06, 0, m), '#d9d6cf');
              pools.pillar.add(boxMatrix(bx, h, bz, 0.16, 0.3, 0.16, 0, m), '#f5f5f0');
              pools.pillar.add(boxMatrix(bx, h + 0.86, bz, 0.14, 0.14, 0.14, 0, m), '#ffd300');
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
      const y0 = roadLevel(state, i);
      const color = state.stops[key].type === 'tram' ? '#c94c4c' : '#3f8fd0';
      const [, [px, pz]] = roadsideSpots(state, i, 0.46);
      pools.pole.add(boxMatrix(px, y0, pz, 0.04, 0.55, 0.04, 0, m), '#cfcfcf');
      pools.pole.add(boxMatrix(px, y0 + 0.45, pz, 0.16, 0.14, 0.04, 0, m), color);
    }
    pools.subway.visible = nv.showSubway;
    pools.pipe.visible = nv.showPipes;
    nv.dirty = false;
  };

  // (roads are recoloured by world/roadsView.js)
  nv.recolorRoads = () => {};

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
