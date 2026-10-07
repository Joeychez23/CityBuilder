// Vehicles you can see. Cars, trucks, buses and service vehicles drive their routes in lanes
// (one, two or three each way depending on the road), keep their distance from the vehicle
// in front, and take turns at junctions: busy crossings have traffic lights that switch
// between the two directions, roundabouts let cars in while there's room, small junctions
// let one car through at a time, and nobody drives into a junction whose exit is backed up.
// Where the simulation says a road carries more than it can, cars slow to a crawl, so queues
// build up behind bottlenecks and spill back along the roads leading in. Trains and subways
// run on their tracks; the occasional plane and ship visit. One InstancedMesh draws them all.
import * as THREE from 'three';
import { N, clamp, DIRS, inBounds, idx } from '../core/grid.js';
import { ROADS, UPG, rankOf } from '../data/roads.js';
import { LINE_TYPES } from '../data/transport.js';
import { getDeck, deckBetween } from '../sim/deck.js';
import { bus } from '../core/events.js';
import { lineRunning } from '../sim/transit.js';
import { roadPathPoints } from '../sim/roadsegs.js';
import { roadMasks } from '../sim/bridges.js';
import { congestion, jamFactor, junctionKind, rushFactor } from '../sim/traffic.js';
import { hourOf } from '../sim/simulation.js';

const CAP = 1800;
const CAR_COLORS = ['#d9d9d9', '#3a3d42', '#b8302a', '#2f5ba8', '#e6e2d6', '#6b7b8c', '#2e6b46', '#c9a227', '#7a2f5a'];
const SIZES = {
  car: [0.34, 0.15, 0.18], taxi: [0.34, 0.15, 0.18], truck: [0.55, 0.26, 0.22], service: [0.45, 0.22, 0.2], emergency: [0.46, 0.2, 0.2],
  bus: [0.75, 0.26, 0.22], tram: [1.1, 0.26, 0.22], train: [1.6, 0.3, 0.26], subway: [1.4, 0.28, 0.24],
};
const SERVICE_COLORS = { garbage: '#4a8f3c', police: '#2a4fb5', health: '#f2f2f2', fire: '#d33a2c', comms: '#e7c34f', transport: '#e3a63a' };
// Emergency vehicles: body colour and the two colours their lights flash between
const SIREN = { fire: ['#d33a2c', '#ffd300', '#ff2a2a'], police: ['#2a4fb5', '#ff2a2a', '#2f6bff'], health: ['#f2f2f2', '#ff2a2a', '#f2f2f2'] };
const ON_ROADS = new Set(['car', 'taxi', 'truck', 'service', 'emergency', 'bus', 'tram']);

// Driving: speeds in cells per second of "visual time" (real time × game speed)
const BASE_SPEED = 2.9;   // at 45 km/h
const HEADWAY = 0.4;      // seconds behind the car in front
const MIN_GAP = 0.06;     // cells between bumpers when stopped
const ACCEL = 2.5, BRAKE = 14;
const GIVE_UP = 25;       // a car stuck this long (gridlock) is taken off the map
// Traffic lights: a cycle of SIGNAL_CYCLE seconds, split between the two directions by how
// much each road carries, with a short all-red between
const SIGNAL_CYCLE = 7, ALL_RED = 0.05;

const dirOf = (a, b) => (b === a + 1 ? 0 : b === a + N ? 1 : b === a - 1 ? 2 : 3);

export function createVehiclesView(view, state) {
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.3 });
  const mesh = new THREE.InstancedMesh(geo, mat, CAP);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.setColorAt(0, new THREE.Color('#fff'));
  view.scene.add(mesh);

  // Traffic light heads: two posts per signalled junction, each with a lamp for each direction
  const lampMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshBasicMaterial(), 2048);
  lampMesh.count = 0;
  lampMesh.frustumCulled = false;
  lampMesh.setColorAt(0, new THREE.Color('#fff'));
  view.scene.add(lampMesh);
  const postMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: '#3a3c40', roughness: 0.7 }), 1024);
  postMesh.count = 0;
  postMesh.frustumCulled = false;
  view.scene.add(postMesh);

  // Plane + ship (simple shapes)
  const plane = new THREE.Group();
  const fus = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.18, 3, 8).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#f4f6f8' }));
  const wing = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 3), new THREE.MeshStandardMaterial({ color: '#d6dbe0' }));
  plane.add(fus, wing);
  plane.visible = false;
  view.scene.add(plane);
  const ship = new THREE.Mesh(new THREE.BoxGeometry(3, 0.6, 1).translate(0, 0.3, 0), new THREE.MeshStandardMaterial({ color: '#c7472f' }));
  ship.visible = false;
  view.scene.add(ship);

  const agents = [];
  const lineAgents = new Map(); // line id -> { version, agents }
  const vv = { agents, visible: true, showUnderground: false, jams: 0 };
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();

  // Vehicles ride on the same deck heights the roads and rails are drawn with
  const surface = (i0, i1, f, type) => {
    const D = getDeck(state);
    if (type === 'subway') return D.ground[i0] * (1 - f) + D.ground[i1] * f;
    return deckBetween(type === 'train' ? D.rail : D.road, i0, i1, f);
  };

  function makeAgent(path, extra) {
    const onRoad = ON_ROADS.has(extra.type);
    const pts = onRoad ? roadPathPoints(state, path) : path.map((i) => [(i % N) + 0.5, ((i / N) | 0) + 0.5]);
    const L = path.length - 1;
    const seg = new Float32Array(Math.max(1, L));
    for (let k = 0; k < L; k++) seg[k] = Math.max(0.05, Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]));
    const big = extra.type === 'truck' || extra.type === 'bus' || extra.type === 'tram';
    return { path, pts, seg, t: 0, v: 0, wait: 0, lane: big ? 0 : Math.floor(Math.random() * 3), onRoad, len: (SIZES[extra.type] || SIZES.car)[0], ...extra };
  }

  // How many cars and trucks to show: grows with the population and follows the rush hours
  // (at every game speed the same picture, rather than more cars the slower time runs)
  vv.target = () => Math.min(CAP - 120, 50 + state.citizens.size * 0.35) * Math.min(1, rushFactor(hourOf(state)) / 1.3);
  bus.on('vehicle:spawn', ({ path, type, svc, siren, patrol, color: forced, onArrive, speed, owner, limit }) => {
    if (path.length < 2) return;
    // a depot shows no more of its vehicles than it has (see showTruck in sim/garbage.js)
    if (owner != null && limit != null) {
      let mine = 0;
      for (const a of agents) if (a.owner === owner && !a.parked) mine++;
      if (mine >= limit) { onArrive?.(); return; }
    }
    // emergencies and services always get through; ordinary traffic waits for room
    const ordinary = type === 'car' || type === 'taxi' || type === 'truck';
    if (agents.length >= (type === 'emergency' ? CAP - 10 : CAP - 120) || (ordinary && agents.length >= vv.target())) { onArrive?.(); return; }
    let color = forced || CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)];
    if (type === 'truck') color = Math.random() < 0.5 ? '#e08a2e' : '#e9e9e9';
    if (type === 'taxi') color = '#f1c232';
    if (type === 'service') color = svc?.deathRate ? '#222222' : SERVICE_COLORS[svc?.cat] || '#999';
    let flash = null;
    if (type === 'emergency') {
      const kind = siren || (svc?.engines ? 'fire' : svc?.patrol ? 'police' : 'health');
      color = SIREN[kind][0];
      if (siren) flash = SIREN[kind];
    }
    const factor = speed ?? (type === 'emergency' ? (siren ? 1.6 : patrol ? 0.7 : 1.05) : type === 'truck' ? 0.85 : 0.9 + Math.random() * 0.2);
    agents.push(makeAgent(path, { type, color, flash, onArrive, factor, owner }));
  });
  // A bulldozed depot or station takes its vehicles with it
  bus.on('building:remove', (b) => {
    for (let k = agents.length - 1; k >= 0; k--) if (agents[k].owner === b.id) agents.splice(k, 1);
  });
  // Fire engines and police cars stay at the scene, lights flashing, while they work
  bus.on('emergency:arrived', (inc) => {
    const end = inc.path[inc.path.length - 1];
    agents.push({ path: [end, end], t: 0, v: 0, type: 'emergency', color: SIREN[inc.kind][0], flash: SIREN[inc.kind], parked: true, until: () => inc.phase === 'scene' });
  });
  bus.on('accident', ({ cell }) => {
    agents.push({ path: [cell, cell], t: 0, v: 0, type: 'service', color: '#2a4fb5', parked: true, life: 6 });
  });

  // ------------------------------------------------------------- junctions
  // kind per cell (see junctionKind), and for traffic lights how the cycle is split
  let J = new Uint8Array(N * N), splitX = new Float32Array(N * N), offset = new Float32Array(N * N);
  let signals = [];
  let jDirty = true;
  // A road removed under a vehicle's route: it leaves the map rather than driving over the gap
  let routesDirty = false;
  bus.on('network:changed', () => { jDirty = true; routesDirty = true; });
  function dropBrokenRoutes() {
    routesDirty = false;
    for (let k = agents.length - 1; k >= 0; k--) {
      const a = agents[k];
      if (!a.onRoad || a.parked) continue;
      for (let j = Math.floor(a.t); j < a.path.length; j++) {
        if (!state.road[a.path[j]]) { agents.splice(k, 1); a.onArrive?.(a); break; }
      }
    }
  }
  function rebuildJunctions() {
    J = new Uint8Array(N * N);
    signals = [];
    for (let i = 0; i < N * N; i++) {
      if (!state.road[i]) continue;
      const k = junctionKind(state, i);
      if (!k) continue;
      J[i] = k;
      if (k !== 1) continue;
      // green time follows how much each direction's roads can carry
      const x = i % N, y = (i / N) | 0;
      const links = roadMasks(state)[i];
      const capOf = (d) => (links & (1 << d) ? ROADS[state.road[idx(x + DIRS[d][0], y + DIRS[d][1])]].capacity : 0);
      const cx = Math.max(capOf(0), capOf(2)), cz = Math.max(capOf(1), capOf(3));
      splitX[i] = clamp(cx / Math.max(1, cx + cz), 0.3, 0.7);
      offset[i] = (((i * 2654435761) >>> 0) / 4294967296) * SIGNAL_CYCLE;
      signals.push(i);
    }
    jDirty = false;
    placeSignals();
  }
  // phase in 0..1 of a signalled junction's cycle; X = the east-west road has green
  const phase = (i) => (((clock + offset[i]) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE / SIGNAL_CYCLE;
  function green(i, d) {
    const ph = phase(i), sx = splitX[i];
    return d === 0 || d === 2 ? ph > ALL_RED && ph < sx : ph > sx + ALL_RED;
  }

  function placeSignals() {
    const D = getDeck(state);
    let n = 0, lamps = 0;
    for (const i of signals) {
      if (n >= 1000) break;
      const x = i % N, y = (i / N) | 0, h = D.road.center[i];
      for (const [ox, oz] of [[0.06, 0.06], [0.94, 0.94]]) {
        postMesh.setMatrixAt(n++, m.compose(p.set(x + ox, h, y + oz), q.identity(), s.set(0.04, 0.62, 0.04)));
        for (const [lx, lz] of [[0.07, 0], [0, 0.07]]) {
          if (lamps >= 2040) break;
          lampMesh.setMatrixAt(lamps++, m.compose(p.set(x + ox + (ox < 0.5 ? lx : -lx), h + 0.55, y + oz + (oz < 0.5 ? lz : -lz)), q.identity(), s.set(0.06, 0.08, 0.06)));
        }
      }
    }
    postMesh.count = n;
    lampMesh.count = lamps;
    postMesh.instanceMatrix.needsUpdate = true;
    lampMesh.instanceMatrix.needsUpdate = true;
  }
  function colorSignals() {
    let lamps = 0;
    const RED = '#ff3b2f', GREEN = '#39e07a', AMBER = '#ffb300';
    for (const i of signals) {
      if (lamps >= 2040) break;
      const ph = phase(i), sx = splitX[i];
      const xs = ph > ALL_RED && ph < sx ? (sx - ph < 0.08 ? AMBER : GREEN) : RED;
      const zs = ph > sx + ALL_RED ? (1 - ph < 0.08 ? AMBER : GREEN) : RED;
      // each post has a lamp facing the east-west road and one facing the north-south road
      for (let k = 0; k < 2; k++) { lampMesh.setColorAt(lamps++, c.set(xs)); lampMesh.setColorAt(lamps++, c.set(zs)); }
    }
    if (lampMesh.instanceColor) lampMesh.instanceColor.needsUpdate = true;
  }

  // ------------------------------------------------------------- lanes
  const lanesAt = (cell) => { const t = state.road[cell]; return t ? ROADS[t].lanes : 1; };
  const laneOn = (a, k) => Math.min(a.lane, lanesAt(a.path[Math.min(k + 1, a.path.length - 1)]) - 1);
  const edgeKey = (a, b, lane) => (a * 4 + dirOf(a, b)) * 4 + lane;
  // how far right of the road's centre line a lane runs (lane 0 is next to the kerb)
  function laneOffset(a, cell) {
    const t = state.road[cell];
    if (!t || !a.onRoad) return a.type === 'tram' ? 0 : 0.17;
    const def = ROADS[t];
    const lanes = def.lanes, lane = Math.min(a.lane, lanes - 1);
    const w = def.width * 0.41;
    if (def.oneway) return -w + (2 * w * (lanes - lane - 0.5)) / lanes;
    return (w * (lanes - lane - 0.5)) / lanes + 0.02;
  }

  function speedCap(a, cell) {
    const t = state.road[cell];
    let v = (t ? ROADS[t].speed / 45 : 0.8) * BASE_SPEED * (a.factor ?? 1);
    if (!t) return v;
    // the simulation's congestion: over-capacity roads crawl (sirens push through)
    const r = congestion(state, cell);
    const busLane = (a.type === 'bus' || a.type === 'tram') && state.roadUpg[cell] & UPG.BUSLANE;
    if (!busLane) v /= jamFactor(a.flash ? r * 0.4 : r);
    if (state.accident[cell] > 0 && !a.flash) v *= 0.15;
    return Math.max(v, 0.05);
  }

  let clock = 0, rclock = 0; // driving time (follows the game speed) and real time (for flashing lights)
  const occ = new Map();
  const jOcc = new Map();

  function syncLines() {
    const seen = new Set();
    for (const line of state.lines) {
      seen.add(line.id);
      const version = `${line.path?.length}-${line.vehicles}-${line.valid}-${line.stops.join(',')}`;
      const cur = lineAgents.get(line.id);
      if (cur && cur.version === version) continue;
      const list = [];
      if (line.valid && line.path) {
        const n = Math.min(line.vehicles, 10);
        for (let k = 0; k < n; k++) {
          const a = makeAgent(line.path, { type: line.type, color: line.type === 'bus' ? line.color : LINE_TYPES[line.type].color, factor: LINE_TYPES[line.type].speed, loop: true, line, pax: [] });
          a.t = (k / n) * (line.path.length - 1);
          a.lane = 0;
          list.push(a);
        }
      }
      lineAgents.set(line.id, { version, agents: list });
    }
    for (const id of [...lineAgents.keys()]) if (!seen.has(id)) lineAgents.delete(id);
  }

  // ------------------------------------------------------------- drawing
  let n = 0;
  function place(a) {
    if (n >= CAP) return;
    const L = a.path.length - 1;
    const k = Math.min(Math.floor(a.t), Math.max(0, L - 1));
    const f = L ? a.t - k : 0;
    const i0 = a.path[k], i1 = a.path[Math.min(k + 1, L)];
    const P0 = a.pts?.[k], P1 = a.pts?.[Math.min(k + 1, L)];
    const x0 = P0 ? P0[0] : (i0 % N) + 0.5, z0 = P0 ? P0[1] : ((i0 / N) | 0) + 0.5;
    const x1 = P1 ? P1[0] : (i1 % N) + 0.5, z1 = P1 ? P1[1] : ((i1 / N) | 0) + 0.5;
    let fx = x1 - x0, fz = z1 - z0;
    const len = Math.hypot(fx, fz);
    if (len > 1e-6) { fx /= len; fz /= len; a.hx = fx; a.hz = fz; } else { fx = a.hx ?? 1; fz = a.hz ?? 0; }
    const rail = a.type === 'train' || a.type === 'subway';
    const lane = rail ? 0 : a.parked ? 0.32 : laneOffset(a, f < 0.5 ? i0 : i1);
    const x = x0 + (x1 - x0) * f - fz * lane;
    const z = z0 + (z1 - z0) * f + fx * lane;
    const underground = a.type === 'subway';
    if (underground && !vv.showUnderground) return;
    const y = surface(i0, i1, f, a.type) + (underground ? 0.2 : 0.1);
    const [sl, sh, sw] = SIZES[a.type] || SIZES.car;
    q.setFromAxisAngle(up, Math.atan2(-fz, fx));
    p.set(x, y, z); s.set(sl, sh, sw);
    mesh.setMatrixAt(n, m.compose(p, q, s));
    mesh.setColorAt(n, c.set(a.flash && Math.floor(rclock * 5 + (a.phase || 0)) % 3 ? a.flash[1 + (Math.floor(rclock * 5) % 2)] : a.color));
    n++;
  }

  // ------------------------------------------------------------- driving
  // Who is on which lane of which stretch, nose to tail; and how many are inside each junction
  function buildOccupancy(all) {
    occ.clear();
    jOcc.clear();
    for (const a of all) {
      if (!a.onRoad || a.parked) continue;
      const L = a.path.length - 1;
      const k = Math.floor(a.t);
      if (k >= L) continue;
      const f = a.t - k;
      a._f = f;
      a._key = edgeKey(a.path[k], a.path[k + 1], laneOn(a, k));
      let list = occ.get(a._key);
      if (!list) occ.set(a._key, (list = []));
      list.push(a);
      const inJ = f > 0.5 ? a.path[k + 1] : a.path[k];
      if (J[inJ]) jOcc.set(inJ, (jOcc.get(inJ) || 0) + 1);
    }
    for (const list of occ.values()) {
      list.sort((u, w) => u._f - w._f);
      for (let r = 0; r < list.length; r++) list[r]._idx = r;
    }
  }

  // How far this vehicle can go before it has to stop (cells)
  function room(a) {
    const L = a.path.length - 1;
    const k = Math.floor(a.t);
    if (k >= L) return Infinity;
    const f = a.t - k, len = a.seg[k];
    let gap = Infinity;
    const list = occ.get(a._key);
    const lead = list?.[a._idx + 1];
    if (lead) gap = (lead._f - f) * len - (lead.len + a.len) / 2;
    else if (k + 1 < L) {
      const l2 = occ.get(edgeKey(a.path[k + 1], a.path[k + 2], laneOn(a, k + 1)));
      if (l2?.length && l2[0] !== a) gap = (1 - f) * len + l2[0]._f * a.seg[k + 1] - (l2[0].len + a.len) / 2;
    }
    // a junction ahead: wait at the stop line unless it's our turn
    const jc = a.path[k + 1];
    const kind = J[jc];
    if (kind && f < 0.5 && !a.flash) {
      const d = dirOf(a.path[k], jc);
      const inside = jOcc.get(jc) || 0;
      // (at a priority junction the side street waits for a gap; the main road carries on)
      const yieldHere = kind === 3 || (kind === 5 && rankOf(state.road[a.path[k]]) < rankOf(state.road[jc]));
      let stop = kind === 1 ? !green(jc, d) : kind === 2 ? inside >= 2 : yieldHere ? inside >= 1 : inside >= 3;
      // don't block the box: if the way out is backed up, wait
      if (!stop && k + 2 <= L) {
        const out = occ.get(edgeKey(jc, a.path[k + 2], laneOn(a, k + 1)));
        if (out?.length && out[0] !== a && out[0]._f < 0.55 && out[0].v < 0.3) stop = true;
      }
      if (stop) gap = Math.min(gap, (0.5 - 0.12 - f) * len - a.len / 2);
    }
    return gap;
  }

  function drive(a, dtv) {
    const L = a.path.length - 1;
    const k = Math.floor(a.t);
    const f = a.t - k;
    const cell = f < 0.5 ? a.path[k] : a.path[Math.min(k + 1, L)];
    const vmax = speedCap(a, cell);
    const gap = room(a);
    const safe = Math.max(0, (gap - MIN_GAP) / HEADWAY);
    const target = Math.min(vmax, safe);
    a.v = Math.max(0, a.v + clamp(target - a.v, -BRAKE * dtv, ACCEL * dtv));
    if (a.v * dtv > Math.max(0, gap - MIN_GAP)) a.v = Math.max(0, gap - MIN_GAP) / Math.max(dtv, 1e-6);
    let dist = a.v * dtv;
    while (dist > 1e-6 && a.t < L) {
      const kk = Math.floor(a.t);
      const rem = (1 - (a.t - kk)) * a.seg[kk];
      if (dist < rem) { a.t += dist / a.seg[kk]; dist = 0; } else { a.t = kk + 1; dist -= rem; }
    }
    if (a.v < 0.05) a.wait += dtv; else a.wait = 0;
  }

  let planeT = -1, shipT = -1, extrasTimer = 0, lightTimer = 0;
  vv.update = (dt) => {
    const speedMul = state.time.paused ? 0 : [0, 1, 1.6, 2.4][state.time.speed];
    const dtv = Math.min(dt, 0.1) * speedMul;
    clock += dtv;
    rclock += dt;
    if (jDirty) rebuildJunctions();
    if (routesDirty) dropBrokenRoutes();
    syncLines();
    const lines = [];
    for (const { agents: list } of lineAgents.values()) for (const a of list) if (lineRunning(state, a.line)) lines.push(a);
    const all = agents.concat(lines);
    if (dtv > 0) buildOccupancy(all);
    n = 0;
    let stuck = 0;
    for (let k = agents.length - 1; k >= 0; k--) {
      const a = agents[k];
      if (a.life != null) { a.life -= dtv; if (a.life <= 0) { agents.splice(k, 1); continue; } }
      if (a.until) { if (!a.until()) { agents.splice(k, 1); continue; } place(a); continue; }
      if (dtv > 0) {
        if (a.onRoad) drive(a, dtv);
        else a.t += dtv * 3.2 * (a.factor ?? 1) * 0.9;
      }
      if (a.t >= a.path.length - 1 || a.wait > GIVE_UP) { agents.splice(k, 1); a.onArrive?.(a); continue; }
      if (a.wait > 1.5) stuck++;
      place(a);
    }
    vv.jams = stuck;
    for (const a of lines) {
      if (dtv > 0) {
        // dwell at stops while riders get on and off
        if (a.dwell > 0) { a.dwell -= dtv; place(a); continue; }
        const before = a.t;
        if (a.onRoad) drive(a, dtv); else a.t += dtv * 2.4 * (a.factor ?? 1);
        a.wait = 0; // line vehicles never give up
        const si = a.line.stopIndex?.findIndex((x) => x > before && x <= a.t);
        if (si != null && si >= 0) { a.t = a.line.stopIndex[si]; a.dwell = 0.6; a.v = 0; vv.onStop?.(a, a.line.stops[si], si); }
        if (a.t >= a.path.length - 1) {
          a.t = 0; a.v = 0;
          if (a.line.stopIndex?.[0] === 0) { a.dwell = 0.6; vv.onStop?.(a, a.line.stops[0], 0); }
        }
      }
      place(a);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    lightTimer += dt;
    if (lightTimer > 0.15) { lightTimer = 0; colorSignals(); }

    // planes land at the airport; ships sail to the harbor
    extrasTimer += dt * speedMul;
    const airport = [...state.buildings.values()].find((b) => b.def.id === 'airport');
    if (airport && planeT < 0 && extrasTimer > 6) { planeT = 0; extrasTimer = 0; }
    if (planeT >= 0 && airport) {
      planeT += dt * speedMul * 0.08;
      const tx = (airport.x0 + airport.x1) / 2, tz = (airport.y0 + airport.y1) / 2;
      const sx = tx - 160, sz = tz - 40;
      const fr = clamp(planeT, 0, 1);
      plane.position.set(sx + (tx - sx) * fr, airport.baseY + 1 + (1 - fr) * 30, sz + (tz - sz) * fr);
      plane.rotation.y = Math.atan2(-(tz - sz), tx - sx);
      plane.visible = true;
      if (planeT > 1.05) { planeT = -1; plane.visible = false; }
    }
    const harbor = [...state.buildings.values()].find((b) => b.def.id === 'harbor' || b.def.id === 'cargoharbor');
    const lane = state.connections.find((kk) => kk.type === 'ship');
    if (harbor && lane && shipT < 0 && extrasTimer > 3) shipT = 0;
    if (shipT >= 0 && harbor && lane) {
      shipT += dt * speedMul * 0.05;
      const fr = clamp(shipT, 0, 1);
      const tx = (harbor.x0 + harbor.x1) / 2, tz = (harbor.y0 + harbor.y1) / 2;
      ship.position.set(lane.x + (tx - lane.x) * fr, state.seaLevel - 0.1, lane.y + (tz - lane.y) * fr);
      ship.rotation.y = Math.atan2(-(tz - lane.y), tx - lane.x);
      ship.visible = true;
      if (shipT > 1.2) { shipT = -1; ship.visible = false; }
    }
  };
  vv.count = () => agents.length;
  vv.setVisible = (v) => { mesh.visible = v; lampMesh.visible = postMesh.visible = v; };
  return vv;
}
