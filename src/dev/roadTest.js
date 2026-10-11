// Development helper: lays out roads that exercise the road network (junctions, a crossing,
// bends, curves, a bridge over water) next to the highway, and checks the network holds
// together. From the console: (await import('/src/dev/roadTest.js')).roadTest(city)
import { planRoad, buildRoad, rn } from '../sim/roadnet.js';

export function roadTest(app, { at = [116, 136] } = {}) {
  const s = app.state;
  const [X, Z] = at;
  const P = (x, z) => ({ x: X + x + 0.5, z: Z + z + 0.5 });
  const log = [];
  const go = (a, b, type = 2, k = null) => {
    const plan = planRoad(s, { a, b, type, k });
    log.push(`${plan.ok ? 'ok ' : 'NO '} (${a.x},${a.z})→(${b.x},${b.z}) ${plan.ok ? `₡${plan.cost} ${plan.pieces.length} piece(s)${plan.pieces.some((p) => p.br) ? ' + bridge' : ''}` : plan.reason}`);
    if (plan.ok) buildRoad(s, plan);
    return plan;
  };
  const end = s.roads.nodes.find((n) => !n.out && (rn(s).at.get(n.id) || []).length === 1 && Math.abs(n.z - (Z + 0.5)) < 0.01);
  if (end) go({ x: end.x, z: end.z, node: end.id }, P(0, -18), 4);   // the highway carries on north
  go(P(-12, -10), P(14, -10));                                        // a crossing
  go(P(-12, -10), P(-12, 10));                                        // a bend, then across the highway
  go(P(4, 4), P(16, 10), 2, [X + 8.5, Z + 4.5, X + 14.5, Z + 5.5]);  // a curve
  go(P(0, -4), P(8, -2));                                             // a T onto the avenue
  return { log, ...check(app) };
}

// Does the network hold together? Every segment's nodes exist, no node is left without a road
// (unless it's the outside connection), and the cells of each road are joined up.
export function check(app) {
  const s = app.state;
  const X = rn(s);
  const problems = [];
  for (const sg of X.seg.values()) for (const id of [sg.a, sg.b]) if (!X.node.has(id)) problems.push(`segment ${sg.id} lost node ${id}`);
  for (const n of X.node.values()) if (!(X.at.get(n.id) || []).length && !n.out) problems.push(`node ${n.id} has no road`);
  return { nodes: X.node.size, segs: X.seg.size, problems };
}

// Raised roads, overpasses and a tunnel, west of the town centre
export function roadTest2(app, { at = [96, 146] } = {}) {
  const s = app.state;
  const [X, Z] = at;
  const P = (x, z) => ({ x: X + x + 0.5, z: Z + z + 0.5 });
  const log = [];
  const go = (a, b, opts = {}) => {
    const plan = planRoad(s, { a, b, type: opts.type || 2, ...opts });
    log.push(`${plan.ok ? 'ok ' : 'NO '} ${opts.label || ''} ${plan.ok ? `₡${plan.cost} ${plan.pieces.map((p) => (p.tn ? 'T' : p.br ? 'B' : 'g')).join('')} over/under ${plan.overpasses}` : plan.reason}`);
    if (plan.ok) buildRoad(s, plan);
    return plan;
  };
  go(P(0, 4), P(30, 4), { label: 'ground road' });
  go(P(15, -6), P(15, 14), { bridge: true, label: 'bridge over it' });
  go(P(4, 20), P(4, 30), { label: 'ground road 2' });
  go(P(-6, 25), P(24, 25), { elev: 1.5, label: 'raised road over road 2' });
  go(P(9, 32), P(9, 42), { label: 'ground road 3' });
  go(P(0, 37), P(20, 37), { tunnel: true, label: 'tunnel under road 3' });
  go(P(20, 20), P(20, 30), { elev: 1.5, label: 'raised road meeting the raised road' });
  return { log, ...check(app) };
}
