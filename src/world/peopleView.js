// People you can see. Citizens with jobs commute at rush hour the way the simulation says
// they travel (sim/parking.js commuteMode):
//  - walkers go from their front door along the pavements to work, and back in the evening;
//  - bus riders walk to a stop, wait there, board the next bus of their line, ride it, get
//    off at the stop nearest their destination and walk the rest of the way;
//  - drivers walk out to a car, drive to a parking lot near work (or the workplace's own
//    yard), park, and walk from the lot to the door; parked cars fill the lots by day. When
//    the lots near work are full, the drivers left over walk all the way from home instead.
// Off-peak, people stroll to parks and shops. Pedestrians are small upright blocks.
// How many you see grows with the city (there's no ceiling below the hard cap), and most of
// them are picked from around where the camera is looking, so a big city stays busy on screen.
import * as THREE from 'three';
import { N, idx } from '../core/grid.js';
import { astar } from '../sim/pathfind.js';
import { accessCell, route } from '../sim/traffic.js';
import { commuteMode, occupancyAt } from '../sim/parking.js';
import { getDeck } from '../sim/deck.js';
import { hourOf } from '../sim/simulation.js';
import { center } from '../sim/services.js';
import { makeRng } from '../core/rng.js';
import { bus } from '../core/events.js';
import { ROADS } from '../data/roads.js';
import { rn, segY, pointOn, roadsideSpots } from '../sim/roadnet.js';
import { pointAtCell } from '../sim/roadgraph.js';
import { roadWidth, asphaltWidth } from '../sim/lanes.js';

const CAP = 1600;
const FACING_RY = [Math.PI / 2, 0, -Math.PI / 2, Math.PI]; // as buildings are turned (world/buildingsView.js)
const PARK_CAP = 12000;
const SHIRTS = ['#e8e4da', '#2f55ff', '#ffd300', '#d24a3a', '#3fa45b', '#1b1c1e', '#8a5ad8', '#f08a3c', '#5bb8d6', '#c9c2b0'];
const CAR_COLORS = ['#d9d9d9', '#3a3d42', '#b8302a', '#2f5ba8', '#e6e2d6', '#6b7b8c', '#2e6b46', '#c9a227', '#7a2f5a'];
const walkable = (state) => (i) => state.road[i] > 0 || state.path[i] > 0;

export function createPeopleView(app) {
  const { view, state, ctx } = app;
  const geo = new THREE.BoxGeometry(0.075, 0.24, 0.075).translate(0, 0.12, 0);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.75 }), CAP);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.setColorAt(0, new THREE.Color('#fff'));
  view.scene.add(mesh);
  const parked = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.3 }), PARK_CAP);
  parked.count = 0;
  parked.frustumCulled = false;
  parked.castShadow = true;
  parked.setColorAt(0, new THREE.Color('#fff'));
  view.scene.add(parked);

  const walkers = [];          // { pts: [[x, y, z]], t, speed, color, then }
  const waiting = new Map();   // stop cell -> riders [{ line, to, dest, color, since }]
  const pv = { walkers, waiting, visible: true };
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  let pathBudget = 0, spawnAcc = 0, poolAge = 99, parkTimer = 0;
  let pool = { workers: [], homes: [], spots: [], nearWorkers: [], nearHomes: [] };

  const surfaceAt = (i) => {
    const D = getDeck(state);
    if (state.road[i]) { const r = roadPoint(i); if (r) return r.y; }
    if (state.path[i]) return D.path.center[i] + 0.05;
    return D.ground[i];
  };
  // Beside a road cell: the point on its road nearest the cell, the road's direction there, its
  // level, and how far out from its middle the pavement runs
  function roadPoint(i) {
    const A = pointAtCell(state, i);
    if (!A) return null;
    const { p, d } = pointOn(state, A.seg, A.s);
    const def = ROADS[rn(state).seg.get(A.seg).type];
    return { x: p[0], z: p[1], dx: d[0], dz: d[1], y: segY(state, A.seg, A.s) + 0.035, w: (roadWidth(def) + asphaltWidth(def)) / 4 };
  }

  // A walking route as points on the pavement (on the right of the way they walk, or the
  // left: side), from door to door
  function walkPoints(from, to, doorA, doorB, side) {
    let cells;
    if (from === to) cells = [from];
    else {
      if (pathBudget <= 0) return null;
      pathBudget--;
      cells = astar(from, to, walkable(state), () => 1, 1, 9000);
    }
    if (!cells) return null;
    const pts = [];
    if (doorA) pts.push(doorA);
    // along the pavement beside the road (footpaths down their middle)
    const road = cells.map((i) => (state.road[i] ? roadPoint(i) : null));
    const at = (k) => road[k] || { x: (cells[k] % N) + 0.5, z: ((cells[k] / N) | 0) + 0.5 };
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k], r = road[k];
      if (!r) { pts.push([(i % N) + 0.5, surfaceAt(i), ((i / N) | 0) + 0.5]); continue; }
      // which way along the road they're walking, and so which pavement is on their right
      const a = at(Math.max(0, k - 1)), b = at(Math.min(cells.length - 1, k + 1));
      const along = (b.x - a.x) * r.dx + (b.z - a.z) * r.dz >= 0 ? 1 : -1;
      const o = r.w * side * along;
      pts.push([r.x - r.dz * o, r.y, r.z + r.dx * o]);
    }
    if (doorB) pts.push(doorB);
    return pts;
  }

  // Where someone steps out of (or into) a building: its edge, facing its road
  function door(b, access) {
    const [cx, cy] = center(b);
    const ax = access % N + 0.5, az = ((access / N) | 0) + 0.5;
    const bx = (b.x0 + b.x1 + 1) / 2, bz = (b.y0 + b.y1 + 1) / 2;
    const dx = ax - bx, dz = az - bz, l = Math.hypot(dx, dz) || 1;
    const hx = Math.abs(b.x1 - b.x0 + 1) / 2, hz = Math.abs(b.y1 - b.y0 + 1) / 2;
    const r = Math.min(hx / Math.max(Math.abs(dx / l), 0.01), hz / Math.max(Math.abs(dz / l), 0.01));
    return [bx + (dx / l) * r * 0.98, (b.baseY ?? surfaceAt(idx(cx, cy))) + 0.02, bz + (dz / l) * r * 0.98];
  }

  function walk(fromB, fromCell, toB, toCell, color, then = null) {
    if (walkers.length >= CAP) return false;
    const a = fromCell ?? accessCell(state, ctx, fromB), b = toCell ?? accessCell(state, ctx, toB);
    if (a < 0 || b < 0) return false;
    const side = Math.random() < 0.5 ? 1 : -1;
    const pts = walkPoints(a, b, fromB ? door(fromB, a) : null, toB ? door(toB, b) : null, side);
    if (!pts || pts.length < 2) return false;
    walkers.push({ pts, t: 0, speed: 0.75 + Math.random() * 0.35, color, then });
    return true;
  }

  function drive(fromCell, toCell, color, onArrive) {
    if (fromCell < 0 || toCell < 0 || fromCell === toCell) { onArrive?.(); return true; }
    ctx.routeBudget = Math.max(ctx.routeBudget || 0, 0) + 1;
    const path = route(state, ctx, fromCell, toCell, 'car');
    if (!path) return false;
    bus.emit('vehicle:spawn', { path, type: 'car', color, onArrive });
    return true;
  }

  // Someone heading out: to work (morning), home (evening), or for a stroll
  function startTrip(c, toWork) {
    const md = commuteMode(state, ctx, c);
    if (md.mode === 'none') return;
    const from = toWork ? md.home : md.work, to = toWork ? md.work : md.home;
    const color = SHIRTS[c.id % SHIRTS.length];
    if (md.mode === 'walk') { walk(from, null, to, null, color); return; }
    if (md.mode === 'bus') {
      const [stopFrom, stopTo] = toWork ? [md.a, md.b] : [md.b, md.a];
      walk(from, null, null, stopFrom, color, () => {
        const list = waiting.get(stopFrom) || [];
        if (list.length < 40) list.push({ line: md.line.id, to: stopTo, dest: to.id, color, since: performance.now() });
        waiting.set(stopFrom, list);
      });
      return;
    }
    // drivers: the lot near work if they have one, else the workplace's own yard
    const lot = md.lot;
    const parkCell = lot ? accessCell(state, ctx, lot) : accessCell(state, ctx, md.work);
    const carColor = CAR_COLORS[c.hh % CAR_COLORS.length];
    if (toWork) {
      // out of the front door, drive, park, walk to work
      drive(accessCell(state, ctx, md.home), parkCell, carColor, () => { if (lot) walk(lot, parkCell, md.work, null, color); else walk(null, parkCell, md.work, null, color); });
    } else {
      // walk back to the car, then drive home
      const go = () => drive(parkCell, accessCell(state, ctx, md.home), carColor);
      if (!(lot ? walk(md.work, null, lot, parkCell, color, go) : (go(), true))) go();
    }
  }

  function stroll() {
    const homes = pool.nearHomes.length && Math.random() < 0.75 ? pool.nearHomes : pool.homes, spots = pool.spots;
    if (!homes.length || !spots.length) return;
    const h = homes[Math.floor(Math.random() * homes.length)];
    const [hx, hy] = center(h);
    for (let k = 0; k < 6; k++) {
      const t = spots[Math.floor(Math.random() * spots.length)];
      const [tx, ty] = center(t);
      if (Math.abs(tx - hx) + Math.abs(ty - hy) > 16) continue;
      // half head out, half head home again
      if (Math.random() < 0.5) walk(h, null, t, null, SHIRTS[Math.floor(Math.random() * SHIRTS.length)]);
      else walk(t, null, h, null, SHIRTS[Math.floor(Math.random() * SHIRTS.length)]);
      return;
    }
  }

  function refreshPool() {
    const workers = [], homes = [], spots = [], nearWorkers = [], nearHomes = [];
    // what the camera is looking at (a bit more than the visible area)
    const t = view.controls.target;
    const R = Math.max(28, view.camera.position.distanceTo(t) * 0.85);
    const near = (b) => b && Math.abs((b.x0 + b.x1) / 2 - t.x) < R && Math.abs((b.y0 + b.y1) / 2 - t.z) < R;
    for (const b of state.buildings.values()) {
      if (b.kind === 'zone' && b.def.cat === 'res' && b.households.length) { homes.push(b); if (near(b)) nearHomes.push(b); }
      if (b.def.leisure || b.product === 'retail') spots.push(b);
    }
    for (const c of state.citizens.values()) {
      if (!c.job || c.jail) continue;
      workers.push(c);
      if (near(state.buildings.get(c.job)) || near(state.buildings.get(state.households.get(c.hh)?.home))) nearWorkers.push(c);
    }
    pool = { workers, homes, spots, nearWorkers, nearHomes };
    poolAge = 0;
  }

  // Buses and trams: riders get off at their stop and walk on; those waiting get on
  pv.onStop = (vehicle, stopCell) => {
    vehicle.pax = vehicle.pax || [];
    const off = vehicle.pax.filter((r) => r.to === stopCell);
    vehicle.pax = vehicle.pax.filter((r) => r.to !== stopCell);
    for (const r of off) {
      const dest = state.buildings.get(r.dest);
      if (dest) walk(null, stopCell, dest, null, r.color);
    }
    const list = waiting.get(stopCell);
    if (!list?.length) return;
    const stay = [];
    for (const r of list) {
      if (r.line === vehicle.line.id && vehicle.pax.length < 40) vehicle.pax.push(r);
      else stay.push(r);
    }
    if (stay.length) waiting.set(stopCell, stay); else waiting.delete(stopCell);
  };

  function rushRate(h) {
    return 0.25 + 2.2 * Math.exp(-((h - 7.6) ** 2) / 1.1) + 2.0 * Math.exp(-((h - 17.4) ** 2) / 1.3) + 0.5 * Math.exp(-((h - 13) ** 2) / 5) - (h < 5 ? 0.2 : 0);
  }

  // Parked cars: each lot holds the cars of the drivers who park there (b.used of its spaces,
  // see sim/parking.js), arriving through the morning and leaving in the evening. Each car
  // drawn stands in a stall: two rows either side of the aisle on a lot, four rows on every
  // floor of a garage. A full lot is full of cars all day.
  const STALLS = {
    parking: { levels: [0.07], rows: [-0.66, 0.66], from: -0.84, n: 8 },
    garage: { levels: [0.25, 0.63, 1.18, 1.73, 2.28, 2.83], rows: [-1.0, -0.48, 0.48, 1.0], from: -1.2, n: 11 },
    garage_large: { levels: [0.25, 0.63, 1.18, 1.73, 2.28, 2.83, 3.38, 3.93], rows: [-1.5, -0.98, -0.26, 0.26, 0.98, 1.5], from: -1.68, n: 15 },
  };
  function drawParked() {
    const h = hourOf(state);
    let n = 0;
    for (const b of state.buildings.values()) {
      if (!b.def.parking || b.cons) continue;
      const fill = b.spaces ? Math.min(1, (b.used || 0) / b.spaces) * occupancyAt(h) : 0;
      if (fill <= 0) continue;
      const L = STALLS[b.def.id] || STALLS.parking;
      const ry = FACING_RY[b.rot || 0], cos = Math.cos(ry), sin = Math.sin(ry);
      const cx = (b.x0 + b.x1 + 1) / 2, cz = (b.y0 + b.y1 + 1) / 2, base = b.baseY ?? 0;
      const slots = [];
      for (const lv of L.levels) for (const rz of L.rows) for (let k = 0; k < L.n; k++) slots.push([L.from + k * 0.24, lv, rz]);
      const r = makeRng(b.id * 7 + 1);
      const take = Math.round(slots.length * fill);
      // the stalls fill in a scattered order (the same every time), as cars come and go
      const order = slots.map((_, k) => k).sort((u, v) => ((u * 7919 + b.id) % 97) - ((v * 7919 + b.id) % 97));
      q.setFromAxisAngle(up, ry);
      for (let k = 0; k < take && n < PARK_CAP; k++) {
        const [lx, ly, lz] = slots[order[k]];
        p.set(cx + lx * cos + lz * sin, base + ly, cz - lx * sin + lz * cos);
        s.set(0.17, 0.14, 0.32); // nose to the aisle
        parked.setMatrixAt(n, m.compose(p, q, s));
        parked.setColorAt(n, col.set(CAR_COLORS[Math.floor(r.next() * CAR_COLORS.length)]));
        n++;
      }
    }
    parked.count = n;
    parked.instanceMatrix.needsUpdate = true;
    if (parked.instanceColor) parked.instanceColor.needsUpdate = true;
  }

  pv.update = (dt) => {
    const speedMul = state.time.paused ? 0 : [0, 1, 1.6, 2.4][state.time.speed] || 1;
    pathBudget = 10;
    poolAge += dt;
    if (poolAge > 3) refreshPool();
    const h = hourOf(state);
    const pop = state.citizens.size;
    // --- spawn: the rate keeps growing with the population (the cap is what's on screen)
    if (speedMul > 0 && pop > 0) {
      const target = Math.min(CAP, 30 + pop * 0.22) * Math.min(1, rushRate(h) / 1.6);
      spawnAcc += dt * speedMul * rushRate(h) * (1 + pop / 60);
      let guard = 0;
      while (spawnAcc >= 1 && guard++ < 14) {
        spawnAcc -= 1;
        if (walkers.length > target) break;
        const morning = h >= 5.5 && h < 10, evening = h >= 15.5 && h < 20;
        if ((morning || evening) && pool.workers.length && Math.random() < 0.85) {
          const list = pool.nearWorkers.length && Math.random() < 0.75 ? pool.nearWorkers : pool.workers;
          startTrip(list[Math.floor(Math.random() * list.length)], morning);
        } else stroll();
      }
      spawnAcc = Math.min(spawnAcc, 6);
    }
    // --- move
    let n = 0;
    for (let k = walkers.length - 1; k >= 0; k--) {
      const w = walkers[k];
      w.t += dt * speedMul * 0.9 * w.speed;
      if (w.t >= w.pts.length - 1) {
        walkers.splice(k, 1);
        w.then?.();
        continue;
      }
      if (n >= CAP) continue;
      const j = Math.floor(w.t), f = w.t - j;
      const a = w.pts[j], b = w.pts[j + 1];
      p.set(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
      q.setFromAxisAngle(up, Math.atan2(-(b[2] - a[2]), b[0] - a[0]));
      // a little bob in the step
      p.y += Math.abs(Math.sin(w.t * 9)) * 0.015;
      mesh.setMatrixAt(n, m.compose(p, q, s.set(1, 1, 1)));
      mesh.setColorAt(n, col.set(w.color));
      n++;
    }
    // --- people waiting at stops, in a small crowd by the pole
    const now = performance.now();
    for (const [cell, list] of waiting) {
      for (let k = list.length - 1; k >= 0; k--) {
        const r = list[k];
        // nobody waits forever: after a while they give up and walk
        if (now - r.since > 45000 / Math.max(0.5, speedMul || 1)) {
          list.splice(k, 1);
          const dest = state.buildings.get(r.dest);
          if (dest) walk(null, cell, dest, null, r.color);
          continue;
        }
        if (n >= CAP) continue;
        const [sx, sz] = roadsideSpots(state, cell, 0.5)[1];
        const x = sx + 0.15 - (k % 4) * 0.1, z = sz + 0.1 - Math.floor(k / 4) * 0.1;
        p.set(x, surfaceAt(cell), z);
        q.identity();
        mesh.setMatrixAt(n, m.compose(p, q, s.set(1, 1, 1)));
        mesh.setColorAt(n, col.set(r.color));
        n++;
      }
      if (!list.length) waiting.delete(cell);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    parkTimer += dt;
    if (parkTimer > 1) { parkTimer = 0; drawParked(); }
  };
  pv.setVisible = (v) => { mesh.visible = v; parked.visible = v; };
  pv.count = () => walkers.length + [...waiting.values()].reduce((a, l) => a + l.length, 0);
  bus.on('building:remove', () => { poolAge = 99; });
  return pv;
}

