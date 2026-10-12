// Vehicles you can see. Cars, trucks, buses and service vehicles drive their routes over the
// road network in lanes (sim/lanes.js): along each road in the lane for their next turn (the
// kerb lane to turn right, the inside lane to turn left), and through each junction on a curve
// from the lane they came in on to the lane they leave on (round the island at a roundabout).
// They keep their distance from the vehicle in front and take turns at junctions: busy
// crossings have traffic lights that switch between the roads one way and the roads the other
// way, roundabouts let cars in while there's room, small junctions let one car through at a
// time, a side street gives way to the main road, and nobody drives into a junction whose
// exit is backed up. Where the simulation says a road carries more than it can, cars slow to a
// crawl, so queues build up behind bottlenecks and spill back along the roads leading in. A
// driver stuck in a queue, or about to join one, looks for another way and takes it when going
// round is quicker than waiting. Trains and subways run on their tracks as a locomotive and
// its carriages (or wagons), braking into each station; intercity trains come in from the
// outside railway to your stations and freight trains to your cargo terminals, one at a time
// on the main line. The occasional plane and ship visit. One InstancedMesh draws them all.
import * as THREE from 'three';
import { N, clamp, inBounds, idx } from '../core/grid.js';
import { ROADS, UPG } from '../data/roads.js';
import { LINE_TYPES } from '../data/transport.js';
import { getDeck, deckBetween } from '../sim/deck.js';
import { bus } from '../core/events.js';
import { lineRunning } from '../sim/transit.js';
import { linked } from '../sim/bridges.js';
import { jamFactor, rushFactor, makeEdgeCost, edgeCongestion } from '../sim/traffic.js';
import { astar } from '../sim/pathfind.js';
import { hourOf } from '../sim/simulation.js';
import { isJump } from '../sim/tunnels.js';
import { rn, segY } from '../sim/roadnet.js';
import { bez, bezTan, tAtS } from '../sim/roadgeom.js';
import { graph, findRoute, routeCost, pointAtCell, reverseEdge } from '../sim/roadgraph.js';
import { buildLegs, legPoint, junctionLayout, roadWidth, asphaltWidth } from '../sim/lanes.js';

const CAP = 1800;
const CAR_COLORS = ['#d9d9d9', '#3a3d42', '#b8302a', '#2f5ba8', '#e6e2d6', '#6b7b8c', '#2e6b46', '#c9a227', '#7a2f5a'];
const SIZES = {
  car: [0.34, 0.15, 0.18], taxi: [0.34, 0.15, 0.18], truck: [0.55, 0.26, 0.22], service: [0.45, 0.22, 0.2], emergency: [0.46, 0.2, 0.2],
  bus: [0.75, 0.26, 0.22], tram: [1.1, 0.26, 0.22], train: [1.6, 0.3, 0.26], subway: [1.4, 0.28, 0.24],
};
const SERVICE_COLORS = { garbage: '#4a8f3c', police: '#2a4fb5', health: '#f2f2f2', fire: '#d33a2c', comms: '#e7c34f', transport: '#e3a63a' };
// Emergency vehicles: body colour and the two colours their lights flash between
const SIREN = { fire: ['#d33a2c', '#ffd300', '#ff2a2a'], police: ['#2a4fb5', '#ff2a2a', '#2f6bff'], health: ['#f2f2f2', '#ff2a2a', '#f2f2f2'] };

// Driving: speeds in cells per second of "visual time" (real time × game speed)
const BASE_SPEED = 2.9;   // at 45 km/h
const HEADWAY = 0.4;      // seconds behind the car in front
const MIN_GAP = 0.06;     // cells between bumpers when stopped
const ACCEL = 2.5, BRAKE = 14;
const GIVE_UP = 25;       // a car stuck this long (gridlock) is taken off the map
const LOOK = 8;           // how far ahead (cells) a driver looks for the car in front
const DECIDE = 2.5;       // how close to a junction a driver decides whether to go or wait
// Traffic lights: a cycle of SIGNAL_CYCLE seconds, split between the two groups of roads by
// how much each carries, with a short all-red between
const SIGNAL_CYCLE = 7, ALL_RED = 0.05;
// Rerouting: a driver crawling this long (or seeing this many crawling cars just ahead) looks
// for another way, at most every REROUTE_EVERY seconds, and takes it when it saves a fifth of
// the time left. Each car crawling in a lane is about QUEUE_COST of route cost (≈ a second).
const REROUTE_WAIT = 1.2, QUEUE_AHEAD = 4, REROUTE_EVERY = 4, BETTER = 0.8, QUEUE_COST = 3;
const REROUTES_PER_FRAME = 4, SEARCHES_PER_FRAME = 6;
const CAN_REROUTE = new Set(['car', 'taxi', 'truck', 'service', 'emergency']);
const vehicleKind = (type) => (type === 'truck' ? 'truck' : type === 'service' || type === 'emergency' ? 'service' : type === 'bus' || type === 'tram' ? type : 'car');

// Trains: cars [length, parts], each part a box { x along the car, y up from its floor, l, h, w }.
// A train set has a driving end at each end, so it can set off back the way it came.
const RAIL_CAP = 700;          // instances kept for train cars on top of the road traffic
const CAR_GAP = 0.06;          // cells between cars
const RAIL_SPEED = 2.4;        // cells per second of visual time, × the line type's speed
const WINDOWS = '#232a32';
const cab = (body, stripe, len = 0.95) => ({ len, parts: [
  { l: len, h: 0.3, w: 0.25, color: body },
  { x: len * 0.3, y: 0.17, l: len * 0.26, h: 0.07, w: 0.256, color: WINDOWS },
  { x: len / 2 - 0.015, y: 0.03, l: 0.03, h: 0.13, w: 0.256, color: stripe },
] });
const coach = (body, stripe, len = 0.9) => ({ len, parts: [
  { l: len, h: 0.27, w: 0.24, color: body },
  { y: 0.14, l: len * 0.88, h: 0.07, w: 0.246, color: WINDOWS },
  { y: 0.05, l: len, h: 0.03, w: 0.246, color: stripe },
] });
const FREIGHT = ['#c0622f', '#2f6b8f', '#7a8a3a', '#9b2f2f', '#d9d4c8', '#e0a32e'];
function wagon() {
  const r = Math.random(), base = { l: 0.9, h: 0.06, w: 0.22, color: '#2b2b2e' };
  if (r < 0.55) return { len: 0.9, parts: [base, { y: 0.06, l: 0.84, h: 0.21, w: 0.24, color: FREIGHT[Math.floor(Math.random() * FREIGHT.length)] }] };
  if (r < 0.8) return { len: 0.9, parts: [base, { y: 0.06, l: 0.8, h: 0.18, w: 0.2, color: Math.random() < 0.5 ? '#3a3d42' : '#cfd2d4' }] };
  return { len: 0.9, parts: [base, { y: 0.06, l: 0.82, h: 0.15, w: 0.24, color: '#6b4e33' }] };
}
// The driving end at the back faces backwards
const ends = (front, middle, back) => [front, ...middle, { ...back, flip: true }];
function trainSet(kind, line) {
  if (kind === 'freight') return ends(cab('#2f5ba8', '#ffd300', 1), Array.from({ length: 8 }, wagon), cab('#2f5ba8', '#ffd300', 1));
  if (kind === 'intercity') return ends(cab('#b8302a', '#ffd300', 1), Array.from({ length: 5 }, () => coach('#e4e1d8', '#b8302a')), cab('#b8302a', '#ffd300', 1));
  const stripe = line?.color || LINE_TYPES[kind].color;
  if (kind === 'subway') return ends(cab('#a9b0b6', stripe, 0.9), [coach('#a9b0b6', stripe), coach('#a9b0b6', stripe)], cab('#a9b0b6', stripe, 0.9));
  return ends(cab(LINE_TYPES.train.color, stripe), [coach('#d8dadc', stripe), coach('#d8dadc', stripe)], cab(LINE_TYPES.train.color, stripe));
}
const setLength = (cars) => cars.reduce((a, car) => a + car.len + CAR_GAP, 0);
// Does the track turn back at path index s (the end of a line, or a stop on a dead end)?
function turnsBack(path, s) {
  const L = path.length - 1;
  if (L < 2) return false;
  if (s <= 0 || s >= L) return path[1] === path[L - 1];
  return path[s - 1] === path[s + 1];
}


export function createVehiclesView(view, state, ctx) {
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.3 });
  const mesh = new THREE.InstancedMesh(geo, mat, CAP + RAIL_CAP);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.setColorAt(0, new THREE.Color('#fff'));
  view.scene.add(mesh);

  // Traffic lights: a post at the stop line of each road into a signalled junction, its lamp
  // showing that road's light
  const lampMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshBasicMaterial(), 2048);
  lampMesh.count = 0;
  lampMesh.frustumCulled = false;
  lampMesh.setColorAt(0, new THREE.Color('#fff'));
  view.scene.add(lampMesh);
  const postMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: '#3a3c40', roughness: 0.7 }), 2048);
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
  const lineAgents = new Map(); // line id -> { version, parts, agents }
  const vv = { agents, visible: true, showUnderground: false, jams: 0, reroutes: 0 };
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const off = new THREE.Vector3(), euler = new THREE.Euler(), pf = { x: 0, y: 0, z: 0 }, pr = { x: 0, y: 0, z: 0 };
  const pt = { x: 0, y: 0, z: 0, hx: 1, hz: 0, dy: 0 };
  const c = new THREE.Color();

  // Trains ride on the same deck heights the railways are drawn with
  const surface = (i0, i1, f, type) => {
    const D = getDeck(state);
    if (type === 'subway') return D.ground[i0] * (1 - f) + D.ground[i1] * f;
    return deckBetween(D.rail, i0, i1, f);
  };

  // A vehicle on the roads, driving the routes in `parts` (see buildLegs in sim/lanes.js)
  function roadAgent(parts, extra) {
    const policy = extra.type === 'bus' ? 'kerb' : extra.type === 'tram' ? 'tram' : 'car';
    const pref = extra.type === 'truck' ? 0 : Math.floor(Math.random() * 3);
    const built = buildLegs(state, parts, { policy, pref, loop: !!extra.loop });
    if (!built?.legs.length) return null;
    return { legs: built.legs, starts: built.starts, k: 0, q: built.legs[0].q0, v: 0, wait: 0, policy, pref, route: parts.length === 1 ? parts[0] : null, len: (SIZES[extra.type] || SIZES.car)[0], ...extra };
  }
  // A trip handed over without its route (a route the simulation didn't keep): found again here
  let searches = 0;
  function partsFor(path, type) {
    if (path.parts) return path.parts;
    if (path.route) return [path.route];
    if (searches <= 0) return null;
    searches--;
    const cost = makeEdgeCost(state, ctx, vehicleKind(type));
    const L = path.length - 1;
    const A = pointAtCell(state, path[0]), B = pointAtCell(state, path[L]);
    if (!A || !B) return null;
    if (path[0] === path[L]) {
      const M = pointAtCell(state, path[L >> 1]);
      const r1 = M && findRoute(state, A, M, cost, { maxExpand: 8000 }), r2 = r1 && findRoute(state, M, A, cost, { maxExpand: 8000 });
      return r1 && r2 ? [r1, r2] : null;
    }
    const r = findRoute(state, A, B, cost, { maxExpand: 8000 });
    return r ? [r] : null;
  }
  // Where a vehicle pulls over beside the road in a cell (at the scene of a fire, an accident)
  function kerbSpot(cell) {
    const A = pointAtCell(state, cell);
    if (!A) return null;
    const X = rn(state), g = X.geo.get(A.seg), def = ROADS[X.seg.get(A.seg).type];
    const t = tAtS(g.tab, A.s), P = bez(g.c, t), d = bezTan(g.c, t);
    const o = asphaltWidth(def) / 2 - 0.1;
    return { x: P[0] - d[1] * o, y: segY(state, A.seg, A.s) + 0.07, z: P[1] + d[0] * o, hx: d[0], hz: d[1] };
  }

  // How many cars and trucks to show: grows with the population and follows the rush hours
  // (at every game speed the same picture, rather than more cars the slower time runs)
  vv.target = () => Math.min(CAP - 120, 50 + state.citizens.size * 0.35) * Math.min(1, rushFactor(hourOf(state)) / 1.3);
  bus.on('vehicle:spawn', ({ path, type, svc, siren, patrol, color: forced, onArrive, speed, owner, limit }) => {
    if (!path || path.length < 2) return;
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
    const parts = partsFor(path, type);
    const a = parts && roadAgent(parts, { type, color, flash, onArrive, factor, owner });
    // (pulling out where a car is already standing: it waits for the next time)
    if (!a || blocked(a)) { onArrive?.(); return; }
    agents.push(a);
  });
  function blocked(a) {
    const key = a.legs[0].key;
    for (const o of agents) if (o.legs && o.legs[o.k].key === key && Math.abs(o.q - a.q) < (o.len + a.len) / 2 + 0.05) return !a.flash;
    return false;
  }
  // A bulldozed depot or station takes its vehicles with it
  bus.on('building:remove', (b) => {
    for (let k = agents.length - 1; k >= 0; k--) if (agents[k].owner === b.id) agents.splice(k, 1);
  });
  // Fire engines and police cars stay at the scene, lights flashing, while they work
  bus.on('emergency:arrived', (inc) => {
    const at = kerbSpot(inc.path[inc.path.length - 1]);
    if (at) agents.push({ at, parked: true, v: 0, type: 'emergency', color: SIREN[inc.kind][0], flash: SIREN[inc.kind], until: () => inc.phase === 'scene' });
  });
  bus.on('accident', ({ cell }) => {
    const at = kerbSpot(cell);
    if (at) agents.push({ at, parked: true, v: 0, type: 'service', color: '#2a4fb5', life: 6 });
  });

  // ------------------------------------------------------------- junctions
  // The signalled junctions: when each one's cycle starts, and a post at each road into it
  let posts = [], sigDirty = true;
  const sigOffset = new Map();
  // A road changed under a vehicle's route: it leaves the map rather than drive over the gap
  let routesDirty = false;
  bus.on('network:changed', ({ layer } = {}) => { if (!layer || layer === 'road') { sigDirty = true; routesDirty = true; } });
  function dropBrokenRoutes() {
    routesDirty = false;
    const X = rn(state);
    const ok = (L) => (L.kind === 0 ? X.seg.has(L.seg) && Math.abs((X.geo.get(L.seg)?.len ?? -1) - L.slen) < 1e-6 : L.node < 0 || X.node.has(L.node));
    for (let k = agents.length - 1; k >= 0; k--) {
      const a = agents[k];
      if (!a.legs) continue;
      for (let j = a.k; j < a.legs.length; j++) if (!ok(a.legs[j])) { agents.splice(k, 1); a.onArrive?.(a); break; }
    }
  }
  function rebuildSignals() {
    sigDirty = false;
    const X = rn(state), Gr = graph(state), J = junctionLayout(state);
    posts = [];
    for (const sh of J.shapes) {
      const n = sh.n;
      if (sh.cap || (Gr.kind.get(n.id) || 0) !== 1) continue;
      sigOffset.set(n.id, (((n.id * 2654435761) >>> 0) / 4294967296) * SIGNAL_CYCLE);
      for (const e of sh.ends) {
        const seg = X.seg.get(e.id);
        // (a one-way road leaving the junction has no traffic coming in to stop)
        if (e.def.oneway && seg.a === n.id) continue;
        const w = roadWidth(e.def) / 2 - 0.05;
        const y = segY(state, e.id, seg.a === n.id ? e.trim : X.geo.get(e.id).len - e.trim);
        // at the stop line, on the right of the traffic coming in
        posts.push({ node: n.id, grp: J.grp.get(`${e.id}:${n.id}`) || 0, x: n.x + e.d[0] * e.trim + e.d[1] * w, y, z: n.z + e.d[1] * e.trim - e.d[0] * w });
      }
    }
    placeSignals();
  }
  // phase in 0..1 of a signalled junction's cycle
  const phase = (nid) => (((clock + (sigOffset.get(nid) || 0)) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE / SIGNAL_CYCLE;
  const splitOf = (nid) => junctionLayout(state).split.get(nid) ?? 0.5;
  function green(nid, grp) {
    const ph = phase(nid), sx = splitOf(nid);
    return grp === 0 ? ph > ALL_RED && ph < sx : ph > sx + ALL_RED;
  }
  function placeSignals() {
    let n = 0;
    for (const P of posts) {
      if (n >= 2040) break;
      postMesh.setMatrixAt(n, m.compose(p.set(P.x, P.y, P.z), q.identity(), s.set(0.04, 0.62, 0.04)));
      lampMesh.setMatrixAt(n, m.compose(p.set(P.x, P.y + 0.55, P.z), q.identity(), s.set(0.07, 0.09, 0.07)));
      n++;
    }
    postMesh.count = lampMesh.count = n;
    postMesh.instanceMatrix.needsUpdate = true;
    lampMesh.instanceMatrix.needsUpdate = true;
  }
  function colorSignals() {
    const RED = '#ff3b2f', GREEN = '#39e07a', AMBER = '#ffb300';
    let n = 0;
    for (const P of posts) {
      if (n >= 2040) break;
      const ph = phase(P.node), sx = splitOf(P.node);
      const end = P.grp === 0 ? sx : 1;
      lampMesh.setColorAt(n++, c.set(green(P.node, P.grp) ? (end - ph < 0.08 ? AMBER : GREEN) : RED));
    }
    if (lampMesh.instanceColor) lampMesh.instanceColor.needsUpdate = true;
  }

  // ------------------------------------------------------------- lines
  let clock = 0, rclock = 0; // driving time (follows the game speed) and real time (for flashing lights)
  // Where along its loop a line vehicle is (distance from the first stop)
  const loopDist = (a) => a.cum[a.k] + (a.q - a.legs[a.k].q0);
  function setLoopDist(a, d) {
    let k = 0;
    while (k < a.legs.length - 1 && a.cum[k + 1] <= d) k++;
    a.k = k;
    a.q = a.legs[k].q0 + Math.min(a.legs[k].len, d - a.cum[k]);
  }
  function syncLines() {
    const seen = new Set();
    for (const line of state.lines) {
      seen.add(line.id);
      const version = `${line.path?.length}-${line.vehicles}-${line.valid}-${line.stops.join(',')}`;
      const cur = lineAgents.get(line.id);
      if (cur && cur.version === version && cur.parts === line.parts) continue;
      const list = [];
      if (line.valid && line.path) {
        const n = Math.min(line.vehicles, 10);
        const road = line.type === 'bus' || line.type === 'tram';
        const color = line.type === 'bus' ? line.color : LINE_TYPES[line.type].color;
        const first = road && line.parts && roadAgent(line.parts, { type: line.type, color, loop: true });
        if (first) {
          // (the vehicles of a line share its legs)
          const cum = new Float64Array(first.legs.length + 1);
          for (let k = 0; k < first.legs.length; k++) cum[k + 1] = cum[k] + first.legs[k].len;
          const total = cum[first.legs.length];
          const stopD = first.starts.map((st) => cum[st.leg] + (st.q - first.legs[st.leg].q0));
          for (let k = 0; k < n; k++) {
            const a = { ...first, cum, total, stopD, factor: LINE_TYPES[line.type].speed, loop: true, line, pax: [], v: 0, wait: 0 };
            setLoopDist(a, (k / n) * total);
            list.push(a);
          }
        } else if (!road) {
          for (let k = 0; k < n; k++) {
            const a = { path: line.path, type: line.type, color, factor: LINE_TYPES[line.type].speed, loop: true, line, pax: [], t: (k / n) * (line.path.length - 1), v: 0 };
            a.cars = trainSet(line.type, line); a.setLen = setLength(a.cars); a.dwellTime = 1.2;
            list.push(a);
          }
        }
      }
      lineAgents.set(line.id, { version, parts: line.parts, agents: list });
    }
    for (const id of [...lineAgents.keys()]) if (!seen.has(id)) lineAgents.delete(id);
  }
  // A bus or tram drives on, and stops at each stop it comes to while riders get on and off
  function stepLineVehicle(a, dtv) {
    if (a.dwell > 0) { a.dwell -= dtv; return; }
    const before = loopDist(a);
    const moved = drive(a, dtv);
    a.wait = 0; // line vehicles never give up
    const after = before + moved;
    for (let si = 0; si < a.stopD.length; si++) {
      const d = a.stopD[si];
      // (round the end of the loop, the first stop again)
      const hit = (d > before + 1e-6 && d <= after + 1e-6) || (after >= a.total - 1e-6 && d + a.total > before + 1e-6 && d + a.total <= after + 1e-6);
      if (!hit) continue;
      setLoopDist(a, d);
      a.dwell = 0.6; a.v = 0;
      vv.onStop?.(a, a.line.stops[si], si);
      break;
    }
  }

  // ------------------------------------------------------------- drawing
  let n = 0;
  function place(a) {
    if (a.cars) { placeTrain(a); return; }
    if (n >= CAP) return;
    let pitch = 0;
    if (a.parked) Object.assign(pt, a.at);
    else {
      const L = a.legs[Math.min(a.k, a.legs.length - 1)];
      if (!legPoint(L, a.q, pt)) return; // (in a tunnel)
      pitch = Math.atan(pt.dy);
    }
    const [sl, sh, sw] = SIZES[a.type] || SIZES.car;
    q.setFromEuler(euler.set(0, Math.atan2(-pt.hz, pt.hx), pitch, 'YZX'));
    p.set(pt.x, pt.y, pt.z); s.set(sl, sh, sw);
    mesh.setMatrixAt(n, m.compose(p, q, s));
    mesh.setColorAt(n, c.set(a.flash && Math.floor(rclock * 5 + (a.phase || 0)) % 3 ? a.flash[1 + (Math.floor(rclock * 5) % 2)] : a.color));
    n++;
  }

  // Where on its track a train's path puts distance t (cells from the start): false when that's
  // off the line (a train still coming in from outside the map, or gone out of it)
  function railPoint(a, t, out) {
    const L = a.path.length - 1;
    if (L < 1) return false;
    if (a.loop) t = ((t % L) + L) % L;
    else if (t < 0 || t > L) return false;
    const k = Math.min(Math.floor(t), L - 1), f = t - k;
    const i0 = a.path[k], i1 = a.path[k + 1];
    if (isJump(i0, i1)) return false; // (in a tunnel)
    const x0 = i0 % N, z0 = (i0 / N) | 0;
    out.x = x0 + 0.5 + ((i1 % N) - x0) * f;
    out.z = z0 + 0.5 + (((i1 / N) | 0) - z0) * f;
    out.y = surface(i0, i1, f, a.type);
    return true;
  }

  // Each car sits on two bogies on the track, so it cuts the corners and tilts up the ramps
  function placeTrain(a) {
    if (a.type === 'subway' && !vv.showUnderground) return;
    const lift = a.type === 'subway' ? 0.2 : 0.1;
    let back = 0;
    for (const car of a.cars) {
      const mid = a.t - back - car.len / 2;
      back += car.len + CAR_GAP;
      if (!railPoint(a, mid + car.len * 0.4, pf) || !railPoint(a, mid - car.len * 0.4, pr)) continue;
      let fx = pf.x - pr.x, fz = pf.z - pr.z;
      const run = Math.hypot(fx, fz);
      if (run < 1e-4) continue;
      fx /= run; fz /= run;
      q.setFromEuler(euler.set(0, Math.atan2(-fz, fx), Math.atan2(pf.y - pr.y, run), 'YZX'));
      const cx = (pf.x + pr.x) / 2, cy = (pf.y + pr.y) / 2 + lift, cz = (pf.z + pr.z) / 2;
      const dir = car.flip ? -1 : 1;
      for (const part of car.parts) {
        if (n >= CAP + RAIL_CAP) return;
        off.set((part.x || 0) * dir, part.y || 0, 0).applyQuaternion(q);
        p.set(cx + off.x, cy + off.y, cz + off.z);
        s.set(part.l, part.h, part.w);
        mesh.setMatrixAt(n, m.compose(p, q, s));
        mesh.setColorAt(n, c.set(part.color));
        n++;
      }
    }
  }

  // A train pulls away from a stop and brakes into the next, waits there, and where the track
  // turns back sets off the other way with its back end leading
  function stepRail(a, dtv) {
    const L = a.path.length - 1;
    const stops = a.line ? a.line.stopIndex || [] : a.stopsAt;
    if (a.dwell > 0) {
      a.dwell -= dtv;
      if (a.dwell > 0) return;
      if (turnsBack(a.path, a.at) && a.at + a.setLen < L) {
        a.t = a.at + a.setLen;
        a.cars.reverse();
        for (const car of a.cars) car.flip = !car.flip;
      }
      a.departT = a.t;
      return;
    }
    let next = a.loop ? L : Infinity;
    for (const x of stops) if (x > a.t + 1e-6) { next = Math.min(next, x); break; }
    const ease = Math.min(clamp(0.25 + (a.t - (a.departT ?? -1e9)) / 5, 0.25, 1), clamp(0.15 + (next - a.t) / 5, 0.15, 1));
    a.t += dtv * RAIL_SPEED * (a.factor ?? 1) * ease;
    if (a.t >= next) {
      const at = a.loop && next === L ? 0 : next;
      a.t = at; a.at = at;
      a.dwell = a.dwellTime ?? 0.6;
      if (a.line) { const si = stops.indexOf(at); if (si >= 0) vv.onStop?.(a, a.line.stops[si], si); }
    }
    if (!a.loop && a.t - a.setLen > L) a.done = true;
  }

  // Intercity and freight trains: from the outside railway to the far end of a station's (or
  // cargo terminal's) platform and back out again, taking turns. Where they can go is worked
  // out each time one sets off; one whose station or track is taken away leaves the map.
  const trips = vv.trips = [];
  let railGap = 3, railTurn = 0, railCheck = false;
  bus.on('network:changed', ({ layer } = {}) => { if (!layer || layer === 'rail') railCheck = true; });
  const railStop = (b) => b.def.id === 'trainstation' || b.def.id === 'cargotrain';
  bus.on('building:remove', (b) => {
    if (railStop(b)) for (let k = trips.length - 1; k >= 0; k--) if (trips[k].dest === b.id) trips.splice(k, 1);
  });
  function findRailDests() {
    const out = [];
    const pass = (i) => state.rail[i] > 0;
    const cost = (f, t, d) => (linked(state, 'rail', f, t, d) ? 1 : Infinity);
    const gates = state.connections.filter((c) => c.type === 'rail' && inBounds(c.x, c.y) && state.rail[idx(c.x, c.y)]).map((c) => idx(c.x, c.y));
    for (const b of state.buildings.values()) {
      if (!railStop(b) || b.cons) continue;
      const side = [];
      for (let y = b.y0 - 1; y <= b.y1 + 1; y++) for (let x = b.x0 - 1; x <= b.x1 + 1; x++) {
        const outX = x < b.x0 || x > b.x1, outY = y < b.y0 || y > b.y1;
        if (outX === outY || !inBounds(x, y) || !state.rail[idx(x, y)]) continue; // the sides, not the corners
        side.push(idx(x, y));
      }
      let best = null;
      for (const g of gates) {
        const paths = side.map((cell) => astar(g, cell, pass, cost, 1, 40000)).filter(Boolean);
        if (!paths.length) continue;
        const shortest = Math.min(...paths.map((pa) => pa.length));
        const reach = Math.max(b.x1 - b.x0, b.y1 - b.y0) + 2;
        // stop at the far end of the platform: the last of its cells the train comes to
        const pa = paths.filter((x) => x.length <= shortest + reach).sort((u, v) => v.length - u.length)[0];
        if (!best || pa.length < best.length) best = pa;
      }
      if (best && best.length > 2) out.push({ id: b.id, kind: b.def.id === 'cargotrain' ? 'freight' : 'intercity', path: best });
    }
    return out;
  }
  function runTrips(dtv) {
    if (railCheck) {
      railCheck = false;
      for (let k = trips.length - 1; k >= 0; k--) if (trips[k].path.some((i) => !state.rail[i])) trips.splice(k, 1);
    }
    for (let k = trips.length - 1; k >= 0; k--) {
      const a = trips[k];
      stepRail(a, dtv);
      if (a.done) { trips.splice(k, 1); railGap = 6; }
    }
    if (trips.length || (railGap -= dtv) > 0) return;
    railGap = 3;
    const dests = findRailDests();
    if (!dests.length) return;
    const d = dests[railTurn++ % dests.length];
    // in to the platform, and back out the way it came
    const path = d.path.concat(d.path.slice(0, -1).reverse());
    const cars = trainSet(d.kind);
    trips.push({ type: 'train', path, t: 0, loop: false, cars, setLen: setLength(cars), stopsAt: [d.path.length - 1], dwellTime: d.kind === 'freight' ? 5 : 3, factor: LINE_TYPES.train.speed, dest: d.id });
  }

  // ------------------------------------------------------------- driving
  // Who is on which lane of which road (and on which curve through which junction), nose to
  // tail; how many are inside each junction, by group; how many are crawling along each lane
  // (and, at each junction, how long the first car waiting at each group's stop lines has waited)
  // (and who is going round each roundabout)
  const occ = new Map(), jOcc = new Map(), crawl = new Map(), jWait = new Map(), ring = new Map();
  function buildOccupancy(all) {
    occ.clear();
    jOcc.clear();
    crawl.clear();
    jWait.clear();
    ring.clear();
    for (const a of all) {
      if (!a.legs || a.parked) continue;
      const L = a.legs[a.k];
      if (!L) continue;
      let list = occ.get(L.key);
      if (!list) occ.set(L.key, (list = []));
      list.push(a);
      if (L.kind === 1 && L.jk) { const jk = L.node * 2 + L.grp; jOcc.set(jk, (jOcc.get(jk) || 0) + 1); }
      if (L.round) { let r = ring.get(L.node); if (!r) ring.set(L.node, (r = [])); r.push(a); }
      if (a.v < 0.6) crawl.set(L.key, (crawl.get(L.key) || 0) + 1);
      const M = L.kind === 0 && L.q1 - a.q < 0.7 && nextLeg(a, a.k + 1);
      if (M && M.kind === 1 && M.jk) { const jk = M.node * 2 + M.grp; if (a.wait > (jWait.get(jk) || 0)) jWait.set(jk, a.wait); }
    }
    for (const list of occ.values()) {
      list.sort((u, w) => u.q - w.q);
      for (let r = 0; r < list.length; r++) list[r]._idx = r;
    }
  }
  // the first vehicle at or past station q on a lane (other than me)
  const firstFrom = (list, from, me) => { for (const o of list) if (o !== me && o.q >= from) return o; return null; };
  const nextLeg = (a, j) => (j < a.legs.length ? a.legs[j] : a.loop ? a.legs[j - a.legs.length] : null);

  // How far this vehicle can go before it has to stop (cells)
  function room(a) {
    const L = a.legs[a.k];
    let gap = Infinity;
    const list = occ.get(L.key);
    const lead = list?.[a._idx + 1];
    if (lead) gap = lead.q - a.q - (lead.len + a.len) / 2;
    else {
      let dist = L.q1 - a.q;
      for (let j = a.k + 1; dist < LOOK; j++) {
        const M = nextLeg(a, j);
        if (!M || j > a.k + 6) break;
        const l2 = occ.get(M.key);
        const o = l2 && firstFrom(l2, M.q0 - 0.3, a);
        if (o) { gap = dist + (o.q - M.q0) - (o.len + a.len) / 2; break; }
        dist += M.len;
      }
    }
    // a junction ahead: wait at the stop line unless it's our turn
    const M = nextLeg(a, a.k + 1);
    if (L.kind === 0 && M && M.kind === 1 && M.jk && !a.flash) {
      const remain = L.q1 - a.q;
      if (remain < DECIDE) {
        // traffic going the same way as us (in its own lanes) doesn't get in our way: what we
        // take turns with is the traffic crossing it
        const same = jOcc.get(M.node * 2 + M.grp) || 0, cross = jOcc.get(M.node * 2 + 1 - M.grp) || 0;
        const inside = same + cross;
        // (taking turns: whoever has waited longest at the junction goes first)
        const wMine = jWait.get(M.node * 2 + M.grp) || 0, wCross = jWait.get(M.node * 2 + 1 - M.grp) || 0;
        const theirTurn = wCross > 1.5 && wCross > wMine + 1;
        let stop;
        if (M.jk === 1) stop = !green(M.node, M.grp);
        else if (M.round) stop = ringNear(a, M);
        else if (M.jk === 2) stop = inside >= 3 || (theirTurn && cross >= 1);
        else if (M.jk === 5 && M.minor) stop = inside >= 1;
        else if (M.jk === 3) stop = cross >= 1 || same >= 2 || theirTurn;
        else stop = cross >= 2 || (cross >= 1 && same >= 2) || (theirTurn && cross >= 1);
        // (squeezed between two junctions: keep moving, or both would wait for each other)
        if (stop && M.jk !== 1 && L.len < 0.8 && a.k > 0) stop = false;
        // don't block the box: if the way out is backed up, wait
        const O = nextLeg(a, a.k + 2);
        if (!stop && O) {
          const ol = occ.get(O.key);
          const o = ol && firstFrom(ol, O.q0 - 0.3, a);
          if (o && o.q - O.q0 < o.len / 2 + a.len + 0.15 && o.v < 0.3) stop = true;
        }
        if (stop) gap = Math.min(gap, remain - a.len / 2 - 0.05);
      }
    }
    return gap;
  }

  // A roundabout: give way to anyone going round who is about to pass where we'd join
  const ringPt = { x: 0, y: 0, z: 0, hx: 1, hz: 0, dy: 0 };
  function ringNear(a, M) {
    const list = ring.get(M.node);
    if (!list) return false;
    const x0 = M.P[0], z0 = M.P[2];
    for (const o of list) {
      const L = o.legs[o.k];
      if (o.q > L.len - 0.3) continue; // (leaving the ring)
      legPoint(L, o.q, ringPt);
      const dx = x0 - ringPt.x, dz = z0 - ringPt.z, d = Math.hypot(dx, dz);
      // close, and heading this way
      if (d < 1.1 && (d < 0.45 || dx * ringPt.hx + dz * ringPt.hz > 0)) return true;
    }
    return false;
  }

  // how full each road is, each way (worked out once a frame)
  const ratio = new Map();
  function speedCap(a, L) {
    let v = (L.spd / 45) * BASE_SPEED * (a.factor ?? 1);
    if (L.kind !== 0) return Math.max(v, 0.05);
    // the simulation's congestion: over-capacity roads crawl (sirens push through)
    let r = ratio.get(L.eid);
    if (r == null) { const e = graph(state).edges.get(L.eid); r = e ? edgeCongestion(state, ctx, e) : 0; ratio.set(L.eid, r); }
    const busLane = (a.type === 'bus' || a.type === 'tram') && (rn(state).seg.get(L.seg)?.upg || 0) & UPG.BUSLANE;
    if (!busLane) v /= jamFactor(a.flash ? r * 0.4 : r);
    if (!a.flash && ctx.segAccident?.has(L.seg)) v *= 0.15;
    return Math.max(v, 0.05);
  }

  // ------------------------------------------------------------- rerouting
  let rerouteBudget = 0;
  // cars crawling along a road (any lane), as route cost
  const queueOn = (eid) => { let k = 0; for (let l = 0; l < 4; l++) k += crawl.get(eid * 4 + l) || 0; return k; };
  function queuedAhead(a) {
    let k = 0;
    for (let j = a.k + 1; j < Math.min(a.legs.length, a.k + 4); j++) if (a.legs[j].kind === 0) k += queueOn(a.legs[j].eid);
    return k;
  }
  // Plan again from the end of the road it's on (where it can still turn) to the same
  // destination, counting the queues it can see, and switch if that's clearly quicker
  function reroute(a) {
    const L = a.legs[a.k];
    if (L.kind !== 0 || !a.route) return;
    let ri = 0;
    for (let j = 0; j < a.k; j++) if (a.legs[j].kind === 0) ri++;
    const edges = a.route.edges;
    if (ri + 2 >= edges.length || edges[ri] !== L.eid) return;
    rerouteBudget--;
    const Gr = graph(state), e = Gr.edges.get(L.eid);
    if (!e) return;
    const base = makeEdgeCost(state, ctx, vehicleKind(a.type));
    const back = reverseEdge(e.id);
    const cost = { unit: (x) => base.unit(x) + (queueOn(x.id) * QUEUE_COST) / x.def.lanes / Math.max(1, x.len), turn: base.turn, ok: (x) => x.id !== back && base.ok(x) };
    const A = { seg: e.seg, s: e.d > 0 ? e.len : 0 };
    const now = routeCost(state, { edges: edges.slice(ri), from: A, to: a.route.to }, cost);
    const alt = findRoute(state, A, a.route.to, cost, { maxExpand: 8000 });
    if (!alt || alt.edges[0] !== e.id || !(alt.cost < now * BETTER)) return;
    const built = buildLegs(state, [{ edges: alt.edges, from: A, to: a.route.to }], { policy: a.policy, pref: a.pref, firstLeg: L });
    if (!built) return;
    a.legs = a.legs.slice(0, a.k).concat(built.legs);
    a.route = { edges: edges.slice(0, ri).concat(alt.edges), from: a.route.from, to: a.route.to };
    a.rerouted = (a.rerouted || 0) + 1;
    vv.reroutes++;
  }
  function considerReroute(a) {
    if (!CAN_REROUTE.has(a.type) || a.flash || rerouteBudget <= 0 || clock < (a.nextLook || 0)) return;
    const moved = a.k !== a.lookK;
    a.lookK = a.k;
    if (!(a.wait > REROUTE_WAIT || (moved && queuedAhead(a) >= QUEUE_AHEAD))) return;
    a.nextLook = clock + REROUTE_EVERY;
    reroute(a);
  }

  // Speed up, slow down or stop for what's ahead, and move along the legs. Returns how far it went.
  function drive(a, dtv) {
    const vmax = speedCap(a, a.legs[a.k]);
    const gap = room(a);
    const safe = Math.max(0, (gap - MIN_GAP) / HEADWAY);
    const target = Math.min(vmax, safe);
    a.v = Math.max(0, a.v + clamp(target - a.v, -BRAKE * dtv, ACCEL * dtv));
    if (a.v * dtv > Math.max(0, gap - MIN_GAP)) a.v = Math.max(0, gap - MIN_GAP) / Math.max(dtv, 1e-6);
    let dist = a.v * dtv, moved = 0;
    while (dist > 1e-6) {
      const L = a.legs[a.k];
      const rem = L.q1 - a.q;
      if (dist < rem) { a.q += dist; moved += dist; break; }
      dist -= rem; moved += rem;
      if (a.k + 1 < a.legs.length) { a.k++; a.q = a.legs[a.k].q0; }
      else if (a.loop) { a.k = 0; a.q = a.legs[0].q0; }
      else { a.q = L.q1; a.done = true; break; }
    }
    if (a.v < 0.05) a.wait += dtv; else a.wait = 0;
    return moved;
  }


  let planeT = -1, shipT = -1, extrasTimer = 0, lightTimer = 0;
  vv.update = (dt) => {
    const speedMul = state.time.paused ? 0 : [0, 1, 1.6, 2.4][state.time.speed];
    const dtv = Math.min(dt, 0.1) * speedMul;
    clock += dtv;
    rclock += dt;
    searches = SEARCHES_PER_FRAME;
    ratio.clear();
    if (sigDirty) rebuildSignals();
    if (routesDirty) dropBrokenRoutes();
    syncLines();
    const lines = [];
    for (const { agents: list } of lineAgents.values()) for (const a of list) if (lineRunning(state, a.line)) lines.push(a);
    const all = agents.concat(lines);
    if (dtv > 0) buildOccupancy(all);
    n = 0;
    let stuck = 0;
    rerouteBudget = REROUTES_PER_FRAME;
    for (let k = agents.length - 1; k >= 0; k--) {
      const a = agents[k];
      if (a.life != null) { a.life -= dtv; if (a.life <= 0) { agents.splice(k, 1); continue; } }
      if (a.until) { if (!a.until()) { agents.splice(k, 1); continue; } place(a); continue; }
      if (dtv > 0 && !a.parked) { considerReroute(a); drive(a, dtv); }
      if (a.done || a.wait > GIVE_UP) { agents.splice(k, 1); a.onArrive?.(a); continue; }
      if (a.wait > 1.5) stuck++;
      place(a);
    }
    vv.jams = stuck;
    for (const a of lines) {
      if (dtv > 0) { if (a.cars) stepRail(a, dtv); else stepLineVehicle(a, dtv); }
      place(a);
    }
    if (dtv > 0) runTrips(dtv);
    for (const a of trips) place(a);
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
      // (it comes in from the open sea at the map edge nearest the harbour)
      const [sx, sz] = [[0, tz], [N, tz], [tx, 0], [tx, N]].reduce((a, b) => (Math.hypot(b[0] - tx, b[1] - tz) < Math.hypot(a[0] - tx, a[1] - tz) ? b : a));
      ship.position.set(sx + (tx - sx) * fr, state.seaLevel - 0.1, sz + (tz - sz) * fr);
      ship.rotation.y = Math.atan2(-(tz - sz), tx - sx);
      ship.visible = true;
      if (shipT > 1.2) { shipT = -1; ship.visible = false; }
    }
  };
  vv.count = () => agents.length;
  vv.setVisible = (v) => { mesh.visible = v; lampMesh.visible = postMesh.visible = v; };
  return vv;
}
