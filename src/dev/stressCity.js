// Development helper: a bigger town (roads, zones, power, water, garbage, parking) grown for
// a week, for testing traffic and performance. Load with ?map=prairie&rich&unlock&alltiles&stress
import { setZone } from '../sim/build.js';
import { planRoad, buildRoad } from '../sim/roadnet.js';

// A straight road between the middles of two cells
function placeRoadLine(s, a, b, type) {
  const plan = planRoad(s, { a: { x: a[0] + 0.5, z: a[1] + 0.5 }, b: { x: b[0] + 0.5, z: b[1] + 0.5 }, type });
  if (!plan.ok) { console.warn('stress road', a, b, plan.reason); return null; }
  return buildRoad(s, plan);
}
import { placeService } from '../sim/services.js';
import { SERVICES } from '../data/services.js';
import { TRANSPORT } from '../data/transport.js';
import { idx, N } from '../core/grid.js';

export function buildStress(app, { days = 7, size = 49, spacing = 7, road = 4 } = {}) {
  const s = app.state;
  const instant = s.options.instantBuild;
  s.options.instantBuild = true;
  const C = N / 2;
  const X0 = C - 36, X1 = X0 + size - 1 + 1, Y0 = C - 24, Y1 = Y0 + size - 1 + 1;
  for (let x = X0; x <= X1; x += spacing) placeRoadLine(s, [x, Y0], [x, Y1], road);
  for (let y = Y0; y <= Y1; y += spacing) placeRoadLine(s, [X0, y], [X1, y], road);
  placeRoadLine(s, [X0, C], [C - 20, C], 4);
  placeRoadLine(s, [X0, Y1 + 6], [X1, Y1 + 6], 4);
  placeRoadLine(s, [X0, Y1], [X0, Y1 + 6], 4);
  app.sim.refreshNetworks();
  const cells = [];
  for (let x = X0; x <= X1; x++) for (let y = Y0; y <= Y1; y++) cells.push([x, y]);
  const midY = Y0 + Math.round(size * 0.57);
  const zone = (f, id) => setZone(s, app.ctx.zonable, cells.filter(f), id);
  zone(([, y]) => y < midY, 1);
  zone(([x, y]) => y >= midY && x < X0 + 24, 3);
  zone(([x, y]) => y >= midY && x >= X0 + 24 && x < X0 + 38, 7);
  zone(([x, y]) => y >= midY && x >= X0 + 38, 9);
  const plop = (id, x0, y0, rot) => {
    const d = SERVICES[id] || TRANSPORT[id];
    const alongX = rot === 1 || rot === 3;
    const w = alongX ? d.w : d.d, h = alongX ? d.d : d.w;
    return placeService(s, app.ctx, d, x0, y0, x0 + w - 1, y0 + h - 1, rot);
  };
  plop('coal', X0 + 2, Y1 + 7, 3); plop('coal', X0 + 8, Y1 + 7, 3);
  plop('landfill', X0 + 14, Y1 + 7, 3); plop('landfill', X0 + 20, Y1 + 7, 3);
  for (let k = 0; k < 4; k++) plop('gwpump', X0 + 26 + k * 3, Y1 + 7, 3);
  // a sewage outlet on the nearest water to the east
  let xr = X1 + 1;
  while (xr < N - 1 && !s.water[idx(xr, midY + 3)]) xr++;
  if (xr < N - 3) {
    placeRoadLine(s, [X1, midY + 3], [xr - 3, midY + 3], 4);
    app.sim.refreshNetworks();
    // at the end of the road and beside it (sharing an edge with the road)
    for (const [x, y, r] of [[xr - 2, midY + 3, 2], [xr - 3, midY + 2, 1], [xr - 3, midY + 4, 3]]) plop('outlet', x, y, r);
  }
  for (let k = 0; k < 6; k++) plop('parking', X0 + 25 + (k % 3) * 7, midY + 1 + Math.floor(k / 3) * 7, 3);
  plop('clinic', X0 + 1, Y0 + 1, 1); plop('firehouse', X0 + 8, Y0 + 1, 1); plop('police', X0 + 15, Y0 + 1, 1); plop('elementary', X0 + 22, Y0 + 1, 1);
  for (let d = 0; d < days * 144; d++) app.sim.step();
  // vehicles spawned while the week ran without frames would all start at once
  app.vehicles.agents.length = 0;
  app.view.cam.setView({ x: (X0 + X1) / 2, z: (Y0 + Y1) / 2, dist: 70, yaw: 0.6, pitch: 0.95 });
  s.options.instantBuild = instant;
  return { pop: s.citizens.size, buildings: s.buildings.size };
}
