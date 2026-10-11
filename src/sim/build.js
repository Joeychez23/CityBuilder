// Everything that changes what's on the map: roads, zones, buildings, bulldozing.
// Tools call plan*() for a preview (validity + cost) and then apply it.
import { N, TILE, TILES, idx, inBounds, DIRS, hidx, clamp, lerp } from '../core/grid.js';
import { ROADS, UPG, UPGRADES } from '../data/roads.js';
import { ZONES } from '../data/zones.js';
import { cellHeight, cellSlope, recomputeWater } from './mapgen.js';
import { newId } from '../core/state.js';
import { bus } from '../core/events.js';
import { makeRng } from '../core/rng.js';
import { gradeCells, cornerTouches } from './grade.js';
import { clearBridgeCell, pruneBridges } from './bridges.js';
import { removePylon, pylonValue, dropSpansAt } from './power.js';
import { maxSlopeAt } from './projects.js';
import { segAtCell, segValue, removeSeg } from './roadnet.js';
import { zoneLayout, zoneOf, paintCells, cellsOnGrid, cellOf, zonableGrid } from './zoneblocks.js';

export const MAX_BUILD_SLOPE = 1.3; // height change across one cell (~10 m over 8 m): anything less is buildable

export const isOwned = (state, x, y) => inBounds(x, y) && state.tiles[((y / TILE) | 0) * TILES + ((x / TILE) | 0)] === 1;

// Something is built on cell i: its zoning (and any lot laid out over it) goes
export function clearZoneCell(state, i) {
  const Z = zoneLayout(state, { stale: true });
  const cells = cellsOnGrid(Z, [i]).filter((c) => zoneOf(state, c));
  for (const c of cells) { const p = plotOfCell(state, c); if (p) dissolvePlot(state, p.id); }
  if (cells.length) paintCells(state, cells, 0);
  state.zone[i] = 0;
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
// Zoning is painted on the zone strips along the roads (sim/zoneblocks.js). A zone cell takes
// a zone if the land is yours and suits it (farms need fertile land, mines ore...).

// The grid of how far each cell is from a road you can zone beside (see zonableGrid)
export function computeZonable(state) {
  return zonableGrid(state);
}

// Can this zone cell be painted with this zone?
export function canZoneStrip(state, c, zoneId) {
  const i = c.g, x = i % N, y = (i / N) | 0;
  if (!isOwned(state, x, y)) return false;
  const b = state.bld[i] && state.buildings.get(state.bld[i]);
  if (b && (b.kind !== 'zone' || b.def.signature)) return false;
  const def = ZONES[zoneId];
  if (def && def.resource && def.resource !== 'forest' && state[def.resource][i] <= 0) return false;
  if (def && def.resource === 'forest' && !state.forestMax[i]) return false;
  return true;
}
// (by grid cell, for code that thinks in cells: any zone cell over it)
export function canZoneCell(state, zonable, x, y, zoneId) {
  const cells = cellsOnGrid(zoneLayout(state), [idx(x, y)]);
  return cells.some((c) => canZoneStrip(state, c, zoneId));
}

// Paint zone cells with a zone (0 to unzone them). A building on a cell whose zone changes
// no longer fits and is removed, and a lot laid out over it is undone.
export function zoneCells(state, cells, zoneId) {
  const change = [];
  for (const c of cells) {
    if (zoneId && !canZoneStrip(state, c, zoneId)) continue;
    if (zoneOf(state, c) === zoneId) continue;
    change.push(c);
  }
  for (const c of change) {
    const b = state.bld[c.g] && state.buildings.get(state.bld[c.g]);
    if (b && b.kind === 'zone') removeBuilding(state, b.id);
    const p = plotOfCell(state, c);
    if (p) dissolvePlot(state, p.id);
  }
  const n = paintCells(state, change, zoneId);
  if (n) bus.emit('zones:changed', { count: n, cells: change });
  return n;
}
// (by grid cells: the zone cells over them)
export function setZone(state, zonable, gridCells, zoneId) {
  return zoneCells(state, cellsOnGrid(zoneLayout(state), gridCells.map(([x, y]) => idx(x, y))), zoneId);
}

// ------------------------------------------------------------------------- lots
// Lots ("plots") are zoned areas you lay out yourself along a strip: a set width along the
// road and depth away from it, with a front yard (setback) between the street and the
// building. A building grows on the whole lot, set back from the road by the yard.
//   { id, seg, side, col, w, d, setback, zone }: columns col.. col + w - 1, rows 0.. d - 1
export function plotCells(state, p) {
  const Z = zoneLayout(state);
  const out = [];
  for (let j = 0; j < p.w; j++) for (let r = 0; r < p.d; r++) {
    const c = cellOf(Z, p.seg, p.side, p.col + j, r);
    if (!c) return null;
    out.push(c);
  }
  return out;
}
export function plotOfCell(state, c) {
  for (const p of state.plots || []) if (p.seg === c.seg && p.side === c.side && c.col >= p.col && c.col < p.col + p.w && c.row < p.d) return p;
  return null;
}

export function dissolvePlot(state, id) {
  state.plots = (state.plots || []).filter((q) => q.id !== id);
  bus.emit('zones:changed', { count: 0 });
}

// Can a lot go on these zone cells? (null = yes, else the reason)
export function plotBlocker(state, lot, zoneId) {
  const cells = plotCells(state, lot);
  if (!cells) return 'No room for the lot here (something is in the way, or it runs off the zone strip)';
  for (const c of cells) {
    if (!isOwned(state, c.g % N, (c.g / N) | 0)) return 'Not your land';
    if (zoneId && !canZoneStrip(state, c, zoneId)) return 'Not zonable here';
  }
  return null;
}

// Lay out a lot, replacing any lots it overlaps (and the buildings on them)
export function placePlot(state, lot, setback, zoneId) {
  const cells = plotCells(state, lot);
  if (!cells) return null;
  const gone = new Set();
  for (const c of cells) {
    const p = plotOfCell(state, c);
    if (p) gone.add(p);
    const b = state.bld[c.g] && state.buildings.get(state.bld[c.g]);
    if (b && b.kind === 'zone') removeBuilding(state, b.id);
  }
  for (const p of gone) {
    for (const c of plotCells(state, p) || []) {
      const b = state.bld[c.g] && state.buildings.get(state.bld[c.g]);
      if (b && b.kind === 'zone') removeBuilding(state, b.id);
    }
    dissolvePlot(state, p.id);
  }
  paintCells(state, cells, 0);
  zoneCells(state, cells, zoneId);
  const plot = { id: newId(state), seg: lot.seg, side: lot.side, col: lot.col, w: lot.w, d: lot.d, setback, zone: zoneId };
  state.plots.push(plot);
  bus.emit('zones:changed', { count: cells.length });
  return plot;
}

// A building on zone cells (a lot along a strip): turned to face the road, in the middle of
// its cells; on the grid it holds the cells those zone cells stand over
export function stripBuilding(state, kind, def, cells, w, d, extra = {}) {
  let cx = 0, cz = 0, fx = 0, fz = 0;
  for (const c of cells) { cx += c.x; cz += c.z; fx -= c.nx; fz -= c.nz; }
  cx /= cells.length; cz /= cells.length;
  const fl = Math.hypot(fx, fz) || 1;
  fx /= fl; fz /= fl;
  const grid = [...new Set(cells.flatMap((c) => c.gs))];
  let x0 = N, y0 = N, x1 = -1, y1 = -1;
  for (const i of grid) { const x = i % N, y = (i / N) | 0; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const rot = Math.abs(fx) > Math.abs(fz) ? (fx > 0 ? 0 : 2) : fz > 0 ? 1 : 3;
  const first = cells.reduce((a, c) => (c.col < a.col ? c : a), cells[0]);
  const front = frontRoadCell(state, cx + fx * (d / 2 + 0.6), cz + fz * (d / 2 + 0.6));
  return createBuilding(state, kind, def, x0, y0, x1, y1, rot, { cells: grid, ang: Math.atan2(fx, fz), cx, cz, w, d, blk: { seg: first.seg, side: first.side, col: first.col }, front, ...extra });
}
// The road cell nearest a point (where a building's driveway meets the road)
function frontRoadCell(state, x, z) {
  let best = -1, bd = Infinity;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const gx = Math.floor(x) + dx, gz = Math.floor(z) + dz;
    if (!inBounds(gx, gz) || !state.road[idx(gx, gz)] || state.bridgeH[idx(gx, gz)]) continue;
    const dd = (gx + 0.5 - x) ** 2 + (gz + 0.5 - z) ** 2;
    if (dd < bd) { bd = dd; best = idx(gx, gz); }
  }
  return best;
}

// ------------------------------------------------------------------------ buildings
// Create a building on the rectangle x0..x1, y0..y1. rot = direction its front faces.
export function createBuilding(state, kind, def, x0, y0, x1, y1, rot, extra = {}) {
  const id = newId(state);
  let maxH = -Infinity;
  // (a building turned to face a road at an angle holds just the cells under it: extra.cells)
  for (const i of extra.cells || rectCells(x0, y0, x1, y1)) {
    const x = i % N, y = (i / N) | 0;
    state.bld[i] = id;
    state.tree[i] = 0;
    if (kind !== 'zone' && !def.keepZone) clearZoneCell(state, i);
    maxH = Math.max(maxH, cellHeight(state, x, y));
    levelCell(state, x, y, 0.35);
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
  const cells = bldCells(b);
  for (const i of cells) if (state.bld[i] === id) state.bld[i] = 0;
  // wires that ran to a power plant come down with it
  if (b.def.power || b.def.battery) dropSpansAt(state, cells);
  state.buildings.delete(id);
  if (bulldozed) state.counters.bulldozed++;
  bus.emit('building:remove', b);
}

const rectCells = (x0, y0, x1, y1) => { const out = []; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(idx(x, y)); return out; };
// The grid cells a building stands on (its rectangle; or, turned to face a road at an angle,
// the cells under it)
export const bldCells = (b) => b.cells || rectCells(b.x0, b.y0, b.x1, b.y1);
export function buildingCells(b) {
  return bldCells(b).map((i) => [i % N, (i / N) | 0]);
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
