// Development helper: lays out a small starter town so features can be tested quickly.
// Load with ?map=prairie&rich&demo
import { setZone } from '../sim/build.js';
import { planRoad, buildRoad, nearestNode } from '../sim/roadnet.js';
import { placeService } from '../sim/services.js';
import { SERVICES } from '../data/services.js';
import { TRANSPORT } from '../data/transport.js';
import { createLine } from '../sim/transit.js';
import { idx, N } from '../core/grid.js';

// The demo town was laid out on the old 144-cell map: shift it to this map's centre
const O = N / 2 - 72;

export function buildDemo(app) {
  const s = app.state;
  const instant = s.options.instantBuild;
  s.options.instantBuild = true; // the starter town is laid out finished
  // (an end next to the end of a road already there joins it, as roads on the grid did)
  const end = (x, z) => { const n = nearestNode(s, x + O + 0.5, z + O + 0.5, 1.05); return n ? { x: n.x, z: n.z, node: n.id } : { x: x + O + 0.5, z: z + O + 0.5 }; };
  const road = (x0, y0, x1, y1, t = 2) => {
    const plan = planRoad(s, { a: end(x0, y0), b: end(x1, y1), type: t });
    if (!plan.ok) console.warn('demo road', x0, y0, x1, y1, plan.reason);
    return plan.ok && buildRoad(s, plan);
  };
  road(53, 72, 80, 72); road(61, 58, 61, 88); road(70, 58, 70, 88, 4); road(53, 58, 80, 58); road(53, 88, 80, 88); road(80, 58, 80, 88);
  app.sim.refreshNetworks();
  const cells = [];
  for (let x = 54; x <= 79; x++) for (let y = 59; y <= 87; y++) cells.push([x, y]);
  const z = (f, id) => setZone(s, app.ctx.zonable, cells.filter(f).map(([x, y]) => [x + O, y + O]), id);
  z(([x, y]) => x < 61 && y > 72, 1);
  z(([x, y]) => x < 61 && y < 72, 3);
  z(([x, y]) => x > 61 && x < 70 && y > 72, 7);
  z(([x, y]) => x > 70 && y < 72, 9);
  z(([x, y]) => x > 70 && y > 72, 1);
  z(([x, y]) => x > 61 && x < 70 && y < 72 && y > 61, 10);
  const plop = (id, x0, y0, rot) => {
    x0 += O; y0 += O;
    const d = SERVICES[id] || TRANSPORT[id];
    const alongX = rot === 1 || rot === 3;
    const w = alongX ? d.w : d.d, h = alongX ? d.d : d.w;
    return placeService(s, app.ctx, d, x0, y0, x0 + w - 1, y0 + h - 1, rot);
  };
  plop('coal', 72, 89, 3);
  plop('landfill', 54, 89, 3);
  plop('clinic', 62, 59, 3);
  plop('elementary', 64, 59, 3);
  plop('park', 62, 85, 1);
  plop('firehouse', 58, 89, 3);
  plop('police', 60, 89, 3);
  // groundwater pumps wherever there is groundwater next to a road
  let pumps = 0;
  for (let y = 50; y < 95 && pumps < 2; y++) for (let x = 50; x < 95 && pumps < 2; x++) {
    if (s.groundwater[idx(x + O, y + O)] < 0.3) continue;
    for (const rot of [0, 1, 2, 3]) if (plop('gwpump', x, y, rot).building) { pumps++; break; }
  }
  plop('busdepot', 81, 60, 2);
  plop('roadmaint', 81, 64, 2);
  const line = createLine(s, app.ctx, 'bus', [idx(61 + O, 60 + O), idx(61 + O, 86 + O), idx(79 + O, 88 + O), idx(80 + O, 59 + O)]);
  for (const c of line.stops) s.stops[c] = { type: 'bus' };
  app.view.cam.lookFrom({ x: 88 + O, y: 38, z: 108 + O }, { x: 66 + O, y: 4, z: 74 + O });
  s.options.instantBuild = instant;
}
