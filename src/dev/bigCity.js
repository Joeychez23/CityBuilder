// Development helper: a big road network for timing (about 2,000 to 3,000 road segments). On
// a flattened, cleared square of the map it lays a grid of small roads every `spacing` cells
// with collectors every sixth, two curved avenues across it, and zones the land along them.
// From the console: (await import('/src/dev/bigCity.js')).bigCity(city), then timeIt(city).
import { planRoad, buildRoad, commitRoads, rn } from '../sim/roadnet.js';
import { recomputeWater, terrainAt } from '../sim/mapgen.js';
import { bus } from '../core/events.js';
import { N, HN } from '../core/grid.js';
import { zoneLayout, zonesDirty } from '../sim/zoneblocks.js';
import { zoneCells } from '../sim/build.js';
import { graph, findRoute } from '../sim/roadgraph.js';
import { makeEdgeCost } from '../sim/traffic.js';
import { buildLegs } from '../sim/lanes.js';

export function bigCity(app, { x0 = 40, z0 = 40, size = 192, spacing = 6, zone = true } = {}) {
  const s = app.state;
  s.options.instantBuild = true;
  // a flat, empty site
  const h = terrainAt(s, x0, z0);
  for (let z = z0 - 3; z <= z0 + size + 4; z++) for (let x = x0 - 3; x <= x0 + size + 4; x++) s.height[z * HN + x] = h;
  for (let z = z0 - 3; z <= z0 + size + 3; z++) for (let x = x0 - 3; x <= x0 + size + 3; x++) {
    const i = z * N + x;
    s.water[i] = 0; s.power[i] = 0; s.rail[i] = 0; s.tree[i] = 0; s.forestMax[i] = 0; s.path[i] = 0;
  }
  s.powerSpans = [];
  recomputeWater(s);
  bus.emit('terrain:changed', { x0: 0, y0: 0, x1: N - 1, y1: N - 1 });
  bus.emit('network:changed', {});
  const log = { ok: 0, refused: {} };
  const go = (a, b, type, k = null) => {
    const plan = planRoad(s, { a: { x: a[0] + 0.5, z: a[1] + 0.5 }, b: { x: b[0] + 0.5, z: b[1] + 0.5 }, type, k });
    if (plan.ok) { buildRoad(s, plan, { silent: true }); log.ok++; } else log.refused[plan.reason] = (log.refused[plan.reason] || 0) + 1;
  };
  const t0 = performance.now();
  for (let x = x0; x <= x0 + size; x += spacing) go([x, z0], [x, z0 + size], (x - x0) % (spacing * 6) === 0 ? 4 : 2);
  for (let z = z0; z <= z0 + size; z += spacing) go([x0, z], [x0 + size, z], (z - z0) % (spacing * 6) === 0 ? 4 : 2);
  // two curved avenues across the grid
  const q = size / 4;
  go([x0 + 3, z0 + size - 3], [x0 + size - 3, z0 + 3], 5, [x0 + q, z0 + q + 0.5, x0 + 3 * q, z0 + 3 * q + 0.5]);
  go([x0 + 3, z0 + 3.5], [x0 + size - 3, z0 + size - 3.5], 5, [x0 + 2 * q, z0 + 0.5, x0 + 2 * q, z0 + size + 0.5]);
  commitRoads(s);
  log.buildMs = Math.round(performance.now() - t0);
  if (zone) {
    const Z = zoneLayout(s);
    const cells = Z.cells.filter((c) => c.x > x0 && c.x < x0 + size && c.z > z0 && c.z < z0 + size);
    zoneCells(s, cells.filter((c) => c.row < 3 && (c.seg + c.side) % 3 === 0), 1);
    zoneCells(s, cells.filter((c) => c.row < 3 && (c.seg + c.side) % 3 === 1), 7);
    zoneCells(s, cells.filter((c) => c.row < 3 && (c.seg + c.side) % 3 === 2), 3);
  }
  log.segs = s.roads.segs.length;
  log.nodes = s.roads.nodes.length;
  return log;
}

// How long the road network's parts take, in milliseconds
export function timeIt(app) {
  const s = app.state;
  const time = (f, n = 1) => { const t0 = performance.now(); for (let k = 0; k < n; k++) f(); return +((performance.now() - t0) / n).toFixed(1); };
  const out = {};
  out.commit = time(() => commitRoads(s, { silent: true }));
  out.graph = time(() => { commitRoads(s, { silent: true }); graph(s); }) - out.commit;
  out.roadsAll = time(() => { app.roads.setFilter(app.roads.filter || null); app.roads.rebuild(); });
  out.roadsNone = time(() => app.roads.rebuild());
  out.zones = time(() => { zonesDirty(); zoneLayout(s); });
  out.zonesView = time(() => { app.zones.dirty = true; app.zones.rebuild(); });
  const X = rn(s);
  const segs = [...X.seg.values()];
  const cost = makeEdgeCost(s, app.ctx, 'car');
  const pick = () => segs[Math.floor(Math.random() * segs.length)].id;
  out.route = time(() => findRoute(s, { seg: pick(), s: 0.5 }, { seg: pick(), s: 0.5 }, cost), 50);
  out.routeLegs = time(() => { const r = findRoute(s, { seg: pick(), s: 0.5 }, { seg: pick(), s: 0.5 }, cost); if (r) buildLegs(s, [r]); }, 30);
  out.step = time(() => app.sim.step(), 20);
  out.vehicles = time(() => app.vehicles.update(1 / 60), 20);
  out.segs = segs.length;
  return out;
}
