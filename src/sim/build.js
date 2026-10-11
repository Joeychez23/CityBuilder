// Everything that changes what's on the map: roads, zones, buildings, bulldozing.
// Tools call plan*() for a preview (validity + cost) and then apply it.
import { N, TILE, TILES, idx, inBounds, DIRS, hidx, clamp, lerp } from '../core/grid.js';
import { ROADS, UPG, UPGRADES } from '../data/roads.js';
import { ZONES, ZONE_DEPTH } from '../data/zones.js';
import { cellHeight, cellSlope, recomputeWater } from './mapgen.js';
import { newId } from '../core/state.js';
import { bus } from '../core/events.js';
import { makeRng } from '../core/rng.js';
import { gradeCells, cornerTouches } from './grade.js';
import { clearBridgeCell, pruneBridges } from './bridges.js';
import { removePylon, pylonValue, dropSpansAt } from './power.js';
import { maxSlopeAt } from './projects.js';
import { segAtCell, segValue, removeSeg } from './roadnet.js';

export const MAX_BUILD_SLOPE = 1.3; // height change across one cell (~10 m over 8 m): anything less is buildable

export const isOwned = (state, x, y) => inBounds(x, y) && state.tiles[((y / TILE) | 0) * TILES + ((x / TILE) | 0)] === 1;

// Something is built on cell i: its zoning (and any lot laid out over it) goes
export function clearZoneCell(state, i) {
  state.zone[i] = 0;
  if (state.plot[i]) dissolvePlot(state, state.plot[i]);
}

// Undo (sim/undo.js) listens in on what a change spends, refunds, removes and alters
export const changeHooks = { spend: null, refund: null, removing: null, modifying: null };

export function spend(state, amount, category = 'construction') {
  if (state.options.unlimitedMoney) return true;
  if (state.money < amount) return false;
  state.money -= amount;
  state.stats.spentToday = (state.stats.spentToday || 0) + amount;
  changeHooks.spend?.(amount);
  bus.emit('money', { amount: -amount, category });
  return true;
}

export const canAfford = (state, amount) => state.options.unlimitedMoney || state.money >= amount;

// (roads: see sim/roadnet.js)

// Pull a cell's four corners toward their average so buildings sit flat. Corners shared
// with roads, rails or paths are left alone: those are graded to the network's surface.
export function levelCell(state, x, y, t) {
  const h = cellHeight(state, x, y);
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    if (cornerTouches(state, x + dx, y + dy, (j) => state.road[j] || state.rail[j] || state.path[j])) continue;
    const i = hidx(x + dx, y + dy);
    state.height[i] = lerp(state.height[i], h, t);
  }
}

// Cut and fill the terrain under newly built network pieces, then refresh water & terrain
function regrade(state, layer, cells) {
  const r = gradeCells(state, layer, cells);
  if (!r) return;
  recomputeWater(state, r.x0, r.y0, r.x1, r.y1);
  bus.emit('terrain:changed', r);
}

// Generic single-layer networks: rail, subway, power lines, pipes, footpaths.
export const LAYER_COST = { rail: 120, subway: 300, power: 12, pipe: 10, path: 8 };

export function planLayer(state, layer, cells) {
  const ok = [], bad = [];
  let cost = 0, water = 0;
  for (const [x, y] of cells) {
    const i = idx(x, y);
    const b = state.bld[i] && state.buildings.get(state.bld[i]);
    const blockedByRoad = (layer === 'rail' || layer === 'path') && ((state.road[i] && !state.bridgeH[i]) || state.power[i]);
    if ((layer === 'rail' || layer === 'path') && state.water[i]) { bad.push([x, y]); water++; continue; }
    const blocked = !isOwned(state, x, y) || blockedByRoad || (layer !== 'subway' && layer !== 'pipe' && b && b.kind !== 'zone' && !b.def?.[layer + 'Ok']);
    if (blocked) { bad.push([x, y]); continue; }
    ok.push([x, y]);
    if (!state[layer][i]) cost += LAYER_COST[layer];
  }
  return { ok, bad, water, cost };
}

export function placeLayer(state, layer, cells) {
  const plan = planLayer(state, layer, cells);
  if (!plan.ok.length || !spend(state, plan.cost, layer)) return null;
  for (const [x, y] of plan.ok) {
    const i = idx(x, y);
    state[layer][i] = 1;
    if (layer === 'rail' || layer === 'path') {
      if (state.bld[i]) removeBuilding(state, state.bld[i]);
      clearZoneCell(state, i);
      state.tree[i] = 0;
      state.forestMax[i] = 0; // (or the forest grows back over the track)
    }
  }
  if (layer === 'rail' || layer === 'path') regrade(state, state[layer], plan.ok);
  bus.emit('network:changed', { layer });
  return plan;
}

// --------------------------------------------------------------------------- zoning
// A cell can be zoned if it's land, owned, not too steep, and within ZONE_DEPTH cells
// (walking over land) of a road that allows zoning.
export function computeZonable(state) {
  const dist = new Uint8Array(N * N).fill(255);
  const queue = [];
  for (let i = 0; i < N * N; i++) {
    const t = state.road[i];
    if (t && ROADS[t].zonable && !state.water[i] && !state.bridgeH[i]) { dist[i] = 0; queue.push(i); }
  }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const x = i % N, y = (i / N) | 0;
    if (dist[i] >= ZONE_DEPTH) continue;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const j = idx(nx, ny);
      if (dist[j] !== 255 || state.road[j] || state.water[j] || state.rail[j]) continue;
      dist[j] = dist[i] + 1;
      queue.push(j);
    }
  }
  return dist; // 1..6 = zonable depth; 0 = road; 255 = not zonable
}

export function canZoneCell(state, zonable, x, y, zoneId) {
  const i = idx(x, y);
  if (!isOwned(state, x, y) || zonable[i] === 0 || zonable[i] > ZONE_DEPTH || state.power[i]) return false;
  if (cellSlope(state, x, y) > maxSlopeAt(state, x, y)) return false;
  const b = state.bld[i] && state.buildings.get(state.bld[i]);
  if (b && (b.kind !== 'zone' || b.def.signature)) return false;
  const def = ZONES[zoneId];
  if (def && def.resource && def.resource !== 'forest' && state[def.resource][i] <= 0) return false;
  if (def && def.resource === 'forest' && !state.forestMax[i]) return false;
  return true;
}

export function setZone(state, zonable, cells, zoneId) {
  let n = 0;
  for (const [x, y] of cells) {
    if (zoneId && !canZoneCell(state, zonable, x, y, zoneId)) continue;
    const i = idx(x, y);
    if (!zoneId && !state.zone[i]) continue;
    if (state.zone[i] === zoneId) continue;
    // A building on a cell whose zone changes no longer fits and is removed
    if (state.bld[i]) {
      const b = state.buildings.get(state.bld[i]);
      if (b && b.kind === 'zone') removeBuilding(state, b.id);
    }
    // ...and a lot laid out over it is undone (its other cells keep their zone)
    if (state.plot[i]) dissolvePlot(state, state.plot[i]);
    state.zone[i] = zoneId;
    n++;
  }
  if (n) bus.emit('zones:changed', { count: n });
  return n;
}

// ------------------------------------------------------------------------- lots
// Lots ("plots") are zoned areas you lay out yourself: a set width along the road and depth
// away from it, with a front yard (setback) between the street and the building. A building
// grows on the whole lot, set back from the road by the yard.
export function plotsAt(state, x0, y0, x1, y1) {
  const ids = new Set();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inBounds(x, y) && state.plot[idx(x, y)]) ids.add(state.plot[idx(x, y)]);
  return ids;
}

export function dissolvePlot(state, id) {
  const p = state.plots.find((q) => q.id === id);
  if (p) {
    for (let y = p.y0; y <= p.y1; y++) for (let x = p.x0; x <= p.x1; x++) if (state.plot[idx(x, y)] === id) state.plot[idx(x, y)] = 0;
    state.plots = state.plots.filter((q) => q !== p);
  } else {
    for (let i = 0; i < state.plot.length; i++) if (state.plot[i] === id) state.plot[i] = 0;
  }
  bus.emit('zones:changed', { count: 0 });
}

// Can a lot go on this rectangle? (null = yes, else the reason)
export function plotBlocker(state, zonable, rect, zoneId) {
  const [x0, y0, x1, y1] = rect;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!inBounds(x, y) || !isOwned(state, x, y)) return 'Not your land';
      const i = idx(x, y);
      if (state.road[i] || state.water[i] || state.rail[i] || state.power[i]) return 'Something is in the way';
      if (zonable[i] === 0 || zonable[i] > ZONE_DEPTH) return `Too far from the road (lots reach ${ZONE_DEPTH} cells)`;
      if (zoneId && !canZoneCell(state, zonable, x, y, zoneId)) return 'Not zonable here';
    }
  }
  return null;
}

// Lay out a lot: zone its cells, replacing any lots it overlaps. rot = side facing the road.
export function placePlot(state, zonable, rect, rot, setback, zoneId) {
  const [x0, y0, x1, y1] = rect;
  for (const id of plotsAt(state, x0, y0, x1, y1)) {
    const old = state.plots.find((q) => q.id === id);
    if (old) for (let y = old.y0; y <= old.y1; y++) for (let x = old.x0; x <= old.x1; x++) {
      const b = state.bld[idx(x, y)] && state.buildings.get(state.bld[idx(x, y)]);
      if (b && b.kind === 'zone') removeBuilding(state, b.id);
    }
    dissolvePlot(state, id);
  }
  const cells = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.push([x, y]);
  // buildings standing on the lot don't fit it any more
  for (const [x, y] of cells) {
    const b = state.bld[idx(x, y)] && state.buildings.get(state.bld[idx(x, y)]);
    if (b && b.kind === 'zone') removeBuilding(state, b.id);
  }
  for (const [x, y] of cells) state.zone[idx(x, y)] = 0;
  setZone(state, zonable, cells, zoneId);
  const id = newId(state);
  for (const [x, y] of cells) state.plot[idx(x, y)] = id;
  const plot = { id, x0, y0, x1, y1, rot, setback, zone: zoneId };
  state.plots.push(plot);
  bus.emit('zones:changed', { count: cells.length });
  return plot;
}

// ------------------------------------------------------------------------ buildings
// Create a building on the rectangle x0..x1, y0..y1. rot = direction its front faces.
export function createBuilding(state, kind, def, x0, y0, x1, y1, rot, extra = {}) {
  const id = newId(state);
  let maxH = -Infinity;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = idx(x, y);
      state.bld[i] = id;
      state.tree[i] = 0;
      if (kind !== 'zone' && !def.keepZone) clearZoneCell(state, i);
      maxH = Math.max(maxH, cellHeight(state, x, y));
      levelCell(state, x, y, 0.35);
    }
  }
  const alongX = rot === 1 || rot === 3; // road runs along x when the building faces N/S
  const b = {
    id, kind, type: def.id, def,
    x0, y0, x1, y1, rot,
    w: alongX ? x1 - x0 + 1 : y1 - y0 + 1,
    d: alongX ? y1 - y0 + 1 : x1 - x0 + 1,
    baseY: maxH,
    level: 1,
    seed: (id * 2654435761) >>> 0,
    built: state.time.day,
    // utility & service status (filled in by the simulation)
    power: 1, water: 1, sewage: 1, garbage: 0, crime: 0, mail: 0, fireHazard: 0,
    onFire: 0, abandoned: false, condition: 1, levelProgress: 0,
    households: [], workers: [], jobs: 0, jobsEdu: [0, 0, 0, 0, 0],
    efficiency: 1, district: state.district[idx(x0, y0)],
    ...extra,
  };
  state.buildings.set(id, b);
  bus.emit('building:add', b);
  return b;
}

export function removeBuilding(state, id, { bulldozed = false } = {}) {
  const b = state.buildings.get(id);
  if (!b) return;
  changeHooks.removing?.(state, b);
  const cells = [];
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      const i = idx(x, y);
      if (state.bld[i] === id) state.bld[i] = 0;
      cells.push(i);
    }
  }
  // wires that ran to a power plant come down with it
  if (b.def.power || b.def.battery) dropSpansAt(state, cells);
  state.buildings.delete(id);
  if (bulldozed) state.counters.bulldozed++;
  bus.emit('building:remove', b);
}

export function buildingCells(b) {
  const cells = [];
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) cells.push([x, y]);
  return cells;
}

// Footprint of a w × d building whose front cell row touches the road on side `rot`.
// (ax, ay) is the front-left cell. Returns [x0, y0, x1, y1].
export function footprint(ax, ay, w, d, rot) {
  // The road lies in direction `rot` from the front row; the lot extends the other way.
  const [fx, fy] = DIRS[rot];
  const bx = -fx, by = -fy;                 // back direction
  const sx = fy === 0 ? 0 : 1, sy = fy === 0 ? 1 : 0; // sideways (along the road)
  const xs = [ax, ax + sx * (w - 1) + bx * (d - 1)];
  const ys = [ay, ay + sy * (w - 1) + by * (d - 1)];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// Check a footprint is free land (optionally all painted with one zone).
export function footprintFree(state, x0, y0, x1, y1, zoneId = 0, allowZoneBuildings = false) {
  return !footprintBlocker(state, x0, y0, x1, y1, zoneId, allowZoneBuildings);
}

// Why a footprint can't be built on (null = it can). Sloping land is fine (the building gets
// a foundation on the downhill side); only cliffs are too steep.
export function footprintBlocker(state, x0, y0, x1, y1, zoneId = 0, allowZoneBuildings = false) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!isOwned(state, x, y)) return inBounds(x, y) ? 'Not your land (buy the map tile first)' : 'Off the map';
      const i = idx(x, y);
      if (state.water[i]) return 'Can\'t build on water';
      if (state.road[i] || state.rail[i] || state.power[i]) return 'A road, railway or power line is in the way';
      if (state.bld[i]) {
        const b = state.buildings.get(state.bld[i]);
        if (!allowZoneBuildings || !b || b.kind !== 'zone') return 'Another building is in the way';
      }
      if (zoneId && state.zone[i] !== zoneId) return 'Not zoned for it';
      if (cellSlope(state, x, y) > maxSlopeAt(state, x, y)) return 'Too steep here';
    }
  }
  return null;
}

// ------------------------------------------------------------------------ refunds
// Demolishing something you paid for gives back part of its price. Zoned buildings were
// never bought, so they refund nothing.
export const REFUND_RATE = 0.5;

export function refund(state, amount) {
  amount = Math.round(amount);
  if (amount <= 0) return 0;
  state.money += amount;
  state.ledger.income.refunds = (state.ledger.income.refunds || 0) + amount;
  changeHooks.refund?.(amount);
  return amount;
}

export const buildingValue = (b) => (b.kind === 'zone' || b.def.free ? 0 : b.def.cost || 0);

// What a network piece on cell i cost to build (bridge spans cost triple)
export function networkValue(state, layer, i) {
  if (layer === 'road') {
    const t = state.road[i];
    if (!t) return 0;
    let v = ROADS[t].cost * (state.bridgeH[i] ? 3 : 1);
    for (const u of UPGRADES) if (state.roadUpg[i] & u.bit) v += u.cost;
    return v;
  }
  if (layer === 'power') return state.power[i] ? pylonValue(state, i) : 0;
  if (!state[layer]?.[i]) return 0;
  const raised = (layer === 'rail' && state.railH[i]) || (layer === 'path' && state.pathH[i]);
  return LAYER_COST[layer] * (raised ? 3 : 1);
}

// Demolish a building and refund it. Returns the refund.
export function demolishBuilding(state, b) {
  const r = refund(state, buildingValue(b) * REFUND_RATE);
  removeBuilding(state, b.id, { bulldozed: true });
  return r;
}

// What bulldozing this cell would remove and give back (without doing it). A road goes a
// segment at a time (from one junction or bend to the next): { seg } says which.
export function bulldozePreview(state, x, y, layers = ['building', 'road', 'rail', 'power', 'pipe', 'path', 'subway']) {
  const i = idx(x, y);
  if (layers.includes('building') && state.bld[i]) {
    const b = state.buildings.get(state.bld[i]);
    if (b && !b.def.permanent) return { what: b.name || b.def.name, refund: Math.round(buildingValue(b) * REFUND_RATE), building: b };
  }
  for (const layer of layers) {
    if (layer === 'building' || !state[layer]?.[i]) continue;
    if (layer === 'road') {
      const s = segAtCell(state, i);
      if (!s || s.locked) continue;
      return { what: 'road', refund: Math.round(segValue(state, s.id) * REFUND_RATE), seg: s.id };
    }
    return { what: layer, refund: Math.round(networkValue(state, layer, i) * REFUND_RATE) };
  }
  return null;
}

// What goes with a road cell when it's removed: its upgrades (a Power Connector takes its
// wires down with it) and junction mark
export function clearRoadCell(state, i) {
  const connector = state.roadUpg[i] & UPG.POWER;
  state.roadUpg[i] = 0;
  state.roadNode[i] = 0;
  if (connector) dropSpansAt(state, [i]);
}

// Bulldoze whatever is on a cell (building first, then networks; a road a segment at a time).
// Returns { removed, refund } or null when there was nothing to remove.
export function bulldozeCell(state, x, y, layers = ['building', 'road', 'rail', 'power', 'pipe', 'path', 'subway']) {
  const i = idx(x, y);
  if (layers.includes('building') && state.bld[i]) {
    const b = state.buildings.get(state.bld[i]);
    if (b && !b.def.permanent) return { removed: 'building', refund: demolishBuilding(state, b) };
  }
  for (const layer of layers) {
    if (layer === 'building') continue;
    if (!state[layer]?.[i]) continue;
    if (layer === 'road') {
      const s = segAtCell(state, i);
      if (!s || s.locked) return null; // (the outside connection stays)
      const r = removeSeg(state, s.id);
      return r ? { removed: 'road', refund: r.refund } : null;
    }
    if (layer === 'rail' && y === 0) return null;
    if (layer === 'power') {
      if (state.connections.some((c) => c.type === 'power' && idx(c.x, c.y) === i)) return null; // keep the outside power line's end
      return { removed: 'power', refund: removePylon(state, i) };
    }
    let r = refund(state, networkValue(state, layer, i) * REFUND_RATE);
    state[layer][i] = 0;
    if (layer === 'rail' || layer === 'path') {
      clearBridgeCell(state, layer, i);
      r += pruneBridges(state, layer); // spans that lost an end come down too (and refund)
    }
    bus.emit('network:changed', { layer });
    return { removed: layer, refund: r };
  }
  return null;
}

// ------------------------------------------------------------------------- trees
export const CLEAR_TREE_COST = 4; // per cell with trees or forest

// What clearing these cells would do: trees cut, forest resource removed, cost
export function planClearTrees(state, cells) {
  let trees = 0, forest = 0, cost = 0;
  for (const [x, y] of cells) {
    const i = idx(x, y);
    if (!isOwned(state, x, y) || state.water[i]) continue;
    if (state.tree[i]) trees++;
    if (state.forestMax[i]) forest++;
    if (state.tree[i] || state.forestMax[i]) cost += CLEAR_TREE_COST;
  }
  return { trees, forest, cost };
}

// Cut the trees and remove the forest resource (forestry can't grow there and the forest
// won't regrow). Returns what was done, or null if there wasn't enough money.
export function clearTrees(state, cells) {
  const plan = planClearTrees(state, cells);
  if (!plan.cost) return plan;
  if (!spend(state, plan.cost, 'trees')) return null;
  for (const [x, y] of cells) {
    const i = idx(x, y);
    if (!isOwned(state, x, y) || state.water[i]) continue;
    state.tree[i] = 0;
    state.forestMax[i] = 0;
  }
  state.counters.treesCleared = (state.counters.treesCleared || 0) + plan.trees;
  bus.emit('trees:changed');
  return plan;
}

// ------------------------------------------------------------------------- terrain
// Cells covered by a terrain brush centred on cell (cx, cy). Radius 0 = just that cell.
export function brushCells(cx, cy, radius) {
  const out = [];
  const r = radius + 0.01;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (inBounds(x, y) && Math.hypot(x - cx, y - cy) <= r) out.push([x, y]);
    }
  }
  return out;
}

// Cell-based terrain brush. Level moves every covered corner straight toward targetH (the
// height of the cell you first clicked) until it's exactly flat; raise/lower/soften fade out
// toward the brush edge. Ground under roads, rails, paths, pylons and buildings is protected.
export function terraform(state, cx, cy, radius, mode, strength, targetH) {
  const corners = new Map(); // corner index -> weight
  for (const [x, y] of brushCells(cx, cy, radius)) {
    if (!isOwned(state, x, y)) continue;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const kx = x + dx, ky = y + dy;
      if (cornerTouches(state, kx, ky, (j) => state.bld[j] || state.road[j] || state.rail[j] || state.path[j] || state.power[j])) continue;
      const d = Math.hypot(kx - (cx + 0.5), ky - (cy + 0.5));
      const w = mode === 'level' ? 1 : clamp(1 - (d / (radius + 1.2)) ** 2, 0.15, 1);
      const hi = hidx(kx, ky);
      corners.set(hi, Math.max(corners.get(hi) || 0, w));
    }
  }
  let changed = false;
  const H = state.height;
  const before = mode === 'smooth' ? Float32Array.from(H) : null;
  for (const [hi, w] of corners) {
    const h = H[hi];
    let nh = h;
    if (mode === 'raise') nh = h + strength * w;
    else if (mode === 'lower') nh = h - strength * w;
    else if (mode === 'level') nh = h + clamp(targetH - h, -strength * 3, strength * 3);
    else if (mode === 'smooth') {
      const x = hi % (N + 1), y = (hi / (N + 1)) | 0;
      let sum = 0, cnt = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const xx = x + ox, yy = y + oy;
        if (xx < 0 || yy < 0 || xx > N || yy > N) continue;
        sum += before[hidx(xx, yy)]; cnt++;
      }
      nh = lerp(h, sum / cnt, clamp(strength * 2 * w, 0, 1));
    }
    nh = clamp(nh, 0, 40);
    if (nh !== h) { H[hi] = nh; changed = true; }
  }
  if (changed) {
    const r = Math.ceil(radius) + 2;
    const x0 = Math.max(0, cx - r), y0 = Math.max(0, cy - r);
    const x1 = Math.min(N - 1, cx + r), y1 = Math.min(N - 1, cy + r);
    recomputeWater(state, x0, y0, x1, y1);
    bus.emit('terrain:changed', { x0, y0, x1, y1 });
  }
  return changed;
}

export const randomFor = (b) => makeRng(b.seed);
