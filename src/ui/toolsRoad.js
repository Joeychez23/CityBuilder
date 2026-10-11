// The road tool. Roads are drawn as curves between points (sim/roadnet.js):
//   Straight  click where it starts, then where it ends (it snaps to the grid's directions,
//             45°, and along or square to the road you start from; Shift: 15° steps)
//   Curved    click where it starts, then where it bends, then where it ends
//   Freeform  each piece carries on smoothly from the last: click where it ends
//   Grid      a whole grid of roads: a corner, the first side, then how far it reaches
//   Bridge    a raised road from point to point, arching over whatever is between
//   Upgrade   click roads to rebuild them as this type (a one-way road of this type turns round)
// Ends snap onto nodes and onto roads (a road joined partway along is split there, making a
// junction), and with Snap to grid on, onto the middle of cells. Roads that cross get a
// junction where they cross; water on the way is bridged by itself. Each road keeps going
// from where the last one ended; right click or Esc stops.
import { ROADS, CLASS_NAMES, lanesText } from '../data/roads.js';
import { registerTool, money, segButtons, slider } from './tools.js';
import { planRoad, buildRoad, nearestNode, nearestSeg, rn, leaveDir, retypeSeg, retypeCost, reverseSeg } from '../sim/roadnet.js';
import { quadCurve, straightCurve, bezTan, isStraight } from '../sim/roadgeom.js';
import { gridLayout } from '../sim/roadsegs.js';
import { roadWidth } from '../world/roadsView.js';
import { canAfford } from '../sim/build.js';

const MODES = [
  ['straight', 'Straight', 'A straight road: click where it starts, then where it ends. It snaps to the grid\'s directions, 45°, and along or square to the road you start from (Shift: 15° steps).'],
  ['curve', 'Curved', 'A curve: click where it starts, then where it bends, then where it ends.'],
  ['free', 'Freeform', 'Each piece carries on smoothly from the last one: just click where it goes next.'],
  ['grid', 'Grid', 'A whole grid of roads: click a corner, then where the first side ends, then how far the grid reaches.'],
  ['bridge', 'Bridge', 'A raised road from one point to another: it arches over water, valleys, roads and railways below.'],
  ['upgrade', 'Upgrade', 'Click roads (or drag along them) to rebuild them as this type. Clicking a one-way road of this type turns it round.'],
];
const TIPS = {
  straight: 'Click where the road starts, then where it ends. Keep clicking to carry on; right click or Esc to stop.',
  curve: 'Click where the road starts, then where it bends, then where it ends.',
  free: 'Click where the road starts, then where each piece ends: it bends smoothly on from the last piece.',
  grid: 'Click a corner, then click where the first side ends, then click how far the grid reaches. Right click goes back a step.',
  bridge: 'Click where the bridge starts, then where it ends. It leaves each end level with the road and arches over what\'s below.',
  upgrade: 'Click a road to rebuild it as this type, or drag along several.',
};
const SNAP_NODE = 0.8, SNAP_SEG = 0.6, ANGLE_SNAP = (5 * Math.PI) / 180;
const deg = (a) => Math.round((((a * 180) / Math.PI) % 360 + 360) % 360);
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

// A point you're pointing at, snapped: onto a node, onto a road, or onto the middle of a cell
function snapPoint(app, t, x, z, e) {
  const s = app.state;
  const n = nearestNode(s, x, z, SNAP_NODE);
  if (n) return { x: n.x, z: n.z, node: n.id };
  const q = nearestSeg(s, x, z, SNAP_SEG);
  if (q) return { x: q.x, z: q.z, seg: q.id };
  if (t.snapGrid !== false && !e?.altKey) return { x: Math.floor(x) + 0.5, z: Math.floor(z) + 0.5 };
  return { x, z };
}

// Directions worth snapping to from a point: along and square to the roads there
function roadDirsAt(app, A) {
  const X = rn(app.state);
  const out = [];
  if (A.node != null) for (const id of X.at.get(A.node) || []) { const d = leaveDir(X, id, A.node); out.push(Math.atan2(d[1], d[0])); }
  if (A.seg != null && X.geo.has(A.seg)) {
    const q = nearestSeg(app.state, A.x, A.z, 0.2, (sg) => sg.id === A.seg);
    if (q) { const d = bezTan(X.geo.get(A.seg).c, q.t); out.push(Math.atan2(d[1], d[0])); }
  }
  return out;
}

// Where a straight road from A ends if you point at (x, z)
function snapEnd(app, t, A, x, z, e) {
  const s = app.state;
  // pointing at a node or a road: go there
  const n = nearestNode(s, x, z, SNAP_NODE, (nd) => nd.id !== A.node);
  if (n) return { x: n.x, z: n.z, node: n.id };
  const dx = x - A.x, dz = z - A.z, len = Math.hypot(dx, dz);
  if (len < 0.3) return { x, z };
  const ang = Math.atan2(dz, dx);
  let a = null, onGrid = false;
  if (e?.shiftKey) { a = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12); onGrid = Math.abs(angDiff(a, Math.round(a / (Math.PI / 4)) * (Math.PI / 4))) < 1e-6; }
  else {
    let best = ANGLE_SNAP;
    for (let k = 0; k < 8; k++) { const c = (k * Math.PI) / 4, d = Math.abs(angDiff(ang, c)); if (d < best) { best = d; a = c; onGrid = true; } }
    for (const r of roadDirsAt(app, A)) for (let k = 0; k < 4; k++) { const c = r + (k * Math.PI) / 2, d = Math.abs(angDiff(ang, c)); if (d < best) { best = d; a = c; onGrid = false; } }
  }
  let end;
  const grid = t.snapGrid !== false && !e?.altKey;
  if (a != null) {
    const ux = Math.cos(a), uz = Math.sin(a);
    let L = len * Math.cos(angDiff(ang, a));
    if (grid) {
      const diag = onGrid && Math.abs(ux) > 0.1 && Math.abs(uz) > 0.1;
      L = diag ? Math.max(1, Math.round(L / Math.SQRT2)) * Math.SQRT2 : Math.max(1, Math.round(L));
    }
    end = { x: A.x + ux * L, z: A.z + uz * L };
    if (grid && onGrid) { end.x = Math.round(end.x - 0.5) + 0.5; end.z = Math.round(end.z - 0.5) + 0.5; }
  } else end = grid ? { x: Math.floor(x) + 0.5, z: Math.floor(z) + 0.5 } : { x, z };
  // ending on a road: join it there
  const q = nearestSeg(s, end.x, end.z, SNAP_SEG * 0.75, (sg) => sg.id !== A.seg);
  if (q && !(A.node != null && (rn(s).seg.get(q.id).a === A.node || rn(s).seg.get(q.id).b === A.node))) return { x: q.x, z: q.z, seg: q.id };
  const m = nearestNode(s, end.x, end.z, 0.3, (nd) => nd.id !== A.node);
  if (m) return { x: m.x, z: m.z, node: m.id };
  return end;
}

// The bend of a freeform piece from A (leaving in direction T) to B: a curve that sets off
// along T and turns toward B
function freeBend(A, T, B) {
  const vx = B.x - A.x, vz = B.z - A.z, L2 = vx * vx + vz * vz, dot = vx * T[0] + vz * T[1];
  if (dot < 0.05 * Math.sqrt(L2)) return null;
  const k = Math.min(L2 / (2 * dot), 0.9 * Math.sqrt(L2));
  return [A.x + T[0] * k, A.z + T[1] * k];
}

registerTool('road', {
  options(app, t, el, rerender) {
    const r = ROADS[t.type];
    el.innerHTML = `<h4>${r.name}</h4><div class="road-class"><b>${CLASS_NAMES[r.cls]}</b> · ${lanesText(r)} · ${r.speed} km/h<br><span class="muted">${r.role}</span></div>`;
    segButtons(el, 'Mode', MODES, t.mode || 'straight', (v) => { t.mode = v; this.reset(app, t); rerender(); });
    segButtons(el, 'Snap to grid', [['on', 'On', 'Points snap to the middle of cells and lengths to whole cells.'], ['off', 'Off', 'Anywhere (holding Alt does the same).']], t.snapGrid === false ? 'off' : 'on', (v) => { t.snapGrid = v === 'on'; rerender(); });
    if (t.mode === 'grid') slider(el, `Block size: ${t.spacing || 6} cells (${(t.spacing || 6) * 8} m)`, 4, 12, 1, t.spacing || 6, (v) => { t.spacing = v; rerender(); });
    const mode = t.mode || 'straight';
    const step = mode === 'grid' ? (t.gB ? 'Step 3 of 3: click how far the grid reaches.' : t.gA ? 'Step 2 of 3: click where the first side ends.' : 'Step 1 of 3: click a corner.')
      : mode === 'curve' && t.start ? (t.bend ? 'Click where the curve ends.' : 'Click where it bends.') : '';
    const across = mode !== 'upgrade' && mode !== 'bridge' ? ' Across water it builds a bridge by itself.' : '';
    el.insertAdjacentHTML('beforeend', `<p class="muted">${TIPS[mode]}${across}${r.oneway ? ' One-way: it runs from where you start toward where you end.' : ''}</p>${step ? `<p><b>${step}</b></p>` : ''}`);
  },
  reset(app, t) {
    t.start = t.bend = t.dir = t.gA = t.gB = null;
    app.roads?.hideGhost();
    app.preview.clearCells();
  },
  enter(app, t) { this.reset(app, t); },
  exit(app, t) { this.reset(app, t); },
  cancel(app, t) {
    if (t.gB) t.gB = null;
    else if (t.gA) t.gA = null;
    else if (t.bend) t.bend = null;
    else if (t.start) t.start = t.dir = null;
    else return false;
    app.roads.hideGhost();
    app.preview.clearCells();
    app.tools.renderOptions();
    return true;
  },

  // ---- planning what the pointer would build
  // The road from t.start to the point p (or null): { plan, spec, end }
  planTo(app, t, p, e) {
    const mode = t.mode || 'straight';
    const A = t.start;
    if (!A) return null;
    if (mode === 'curve' && !t.bend) return null;
    const B = mode === 'straight' || mode === 'bridge' ? snapEnd(app, t, A, p.x, p.z, e) : snapPoint(app, t, p.x, p.z, e);
    let k = null;
    if (mode === 'curve') {
      const c = quadCurve(A.x, A.z, t.bend[0], t.bend[1], B.x, B.z);
      k = [c[2], c[3], c[4], c[5]];
    } else if (mode === 'free' && t.dir) {
      const q = freeBend(A, t.dir, B);
      if (q) { const c = quadCurve(A.x, A.z, q[0], q[1], B.x, B.z); k = [c[2], c[3], c[4], c[5]]; }
    }
    const spec = { a: A, b: B, k, type: t.type, bridge: mode === 'bridge' };
    return { plan: planRoad(app.state, spec), spec, end: B };
  },
  showPlan(app, t, r) {
    const { plan, spec, end } = r;
    const def = ROADS[t.type], w = roadWidth(def);
    const items = [];
    if (plan.pieces?.length && plan.pieces[0].c) for (const pc of plan.pieces) items.push({ c: pc.c, prof: pc.prof, w, color: !plan.ok ? '#ff4a3a' : pc.br ? '#b9a8ff' : '#4fc3ff' });
    else {
      const A = spec.a, B = spec.b;
      const c = spec.k ? [A.x, A.z, ...spec.k, B.x, B.z] : straightCurve(A.x, A.z, B.x, B.z);
      items.push({ c, w, color: '#ff4a3a' });
    }
    items.push({ dot: [end.x, end.z], r: 0.28, color: end.node != null || end.seg != null ? '#ffffff' : '#4fc3ff' });
    if (t.mode === 'curve' && t.bend) items.push({ dot: t.bend, r: 0.2, color: '#ffd84f' });
    app.roads.showGhost(items);
    app.preview.setCells((plan.bad || []).map(([x, y]) => [x, y, '#ff4a3a']));
    const len = plan.len || Math.hypot(end.x - spec.a.x, end.z - spec.a.z);
    const ang = deg(Math.atan2(end.z - spec.a.z, end.x - spec.a.x));
    const afford = canAfford(app.state, plan.cost);
    const spans = (plan.pieces || []).filter((pc) => pc.br && plan.ok);
    const joins = (plan.points || []).filter((q) => q.end && (q.end.kind === 'split' || q.end.kind === 'node')).length;
    app.tools.showTip(plan.ok
      ? `${Math.round(len * 8)} m · ${spec.k && !isStraight([spec.a.x, spec.a.z, ...spec.k, end.x, end.z]) ? 'curved' : `${ang}°`} · <span class="${afford ? '' : 'bad'}">${money(plan.cost)}</span>`
        + `${spans.length ? `<br>🌉 ${spans.length === 1 ? 'A bridge' : `${spans.length} bridges`} (${spans.map((pc) => Math.round(pc.tab.len * 8)).join(', ')} m)` : ''}`
        + `${joins ? `<br><span class="muted">${joins} junction${joins === 1 ? '' : 's'}</span>` : ''}`
      : `<span class="bad">${plan.reason}</span>`);
  },

  // ---- grid
  gridFor(app, t, p, e) {
    if (!t.gA) return null;
    const onGrid = t.gB ? t.gridLocked : !e?.shiftKey;
    const lay = gridLayout(t.gA, t.gB || [Math.floor(p.x), Math.floor(p.z)], t.gB ? [Math.floor(p.x), Math.floor(p.z)] : null, t.spacing || 6, onGrid);
    return lay;
  },
  gridHover(app, t, p, e) {
    const def = ROADS[t.type], w = roadWidth(def);
    if (!t.gA) {
      app.roads.showGhost([{ dot: [Math.floor(p.x) + 0.5, Math.floor(p.z) + 0.5], r: 0.3 }]);
      app.tools.showTip(`<b>Road grid</b> · ${def.name}<br><span class="muted">Click a corner of the grid</span>`);
      return;
    }
    const lay = this.gridFor(app, t, p, e);
    if (!lay) return;
    let cost = 0, bad = 0;
    const items = [];
    for (const [a, b] of lay.lines) {
      const plan = planRoad(app.state, { a: { x: a[0] + 0.5, z: a[1] + 0.5 }, b: { x: b[0] + 0.5, z: b[1] + 0.5 }, type: t.type });
      items.push({ c: straightCurve(a[0] + 0.5, a[1] + 0.5, b[0] + 0.5, b[1] + 0.5), w, color: plan.ok ? '#4fc3ff' : '#ff4a3a' });
      if (plan.ok) cost += plan.cost; else bad++;
    }
    app.roads.showGhost(items);
    const afford = canAfford(app.state, cost);
    app.tools.showTip(`${t.gB ? `${lay.cols} × ${lay.rows} block${lay.cols * lay.rows === 1 ? '' : 's'} · ` : ''}${Math.round(lay.len * 8)}${lay.depth ? ` × ${Math.round(lay.depth * 8)}` : ''} m · ${lay.angle ? `turned ${lay.angle}°` : 'on the grid'} · <span class="${afford ? '' : 'bad'}">~${money(cost)}</span>`
      + `<br><span class="muted">${t.gB ? 'Click to build the grid' : 'Click where the first side ends · Shift: any angle'}</span>`
      + `${bad ? `<br><span class="bad">${bad} of its roads can't be built as they are</span>` : ''}`);
  },
  gridClick(app, t, p, e) {
    if (!t.gA) { t.gA = [Math.floor(p.x), Math.floor(p.z)]; app.tools.renderOptions(); this.gridHover(app, t, p, e); return; }
    const lay = this.gridFor(app, t, p, e);
    if (!lay) return;
    if (!t.gB) { t.gB = lay.lines[0][1]; t.gridLocked = !e?.shiftKey; app.tools.renderOptions(); this.gridHover(app, t, p, e); return; }
    let built = 0, failed = 0, money0 = false;
    for (const [a, b] of lay.lines) {
      const plan = planRoad(app.state, { a: { x: a[0] + 0.5, z: a[1] + 0.5 }, b: { x: b[0] + 0.5, z: b[1] + 0.5 }, type: t.type });
      const res = plan.ok ? buildRoad(app.state, plan) : { error: plan.reason };
      if (res.error === 'money') money0 = true;
      if (res.error) failed++; else built++;
    }
    if (failed) app.toast(money0 ? 'Ran out of money' : `${failed} of the grid's roads couldn't be built (water, a steep slope, a railway, a building or another road in the way)`, 'warn', `Built ${built} road${built === 1 ? '' : 's'}`);
    t.gA = t.gB = null;
    app.tools.renderOptions();
    this.gridHover(app, t, p, e);
  },

  // ---- upgrade
  upgradeAt(app, t, p, apply) {
    const s = app.state;
    const q = nearestSeg(s, p.x, p.z, 0.7);
    if (!q) { app.roads.hideGhost(); app.tools.showTip('<span class="muted">Point at a road</span>'); return; }
    const X = rn(s), seg = X.seg.get(q.id), g = X.geo.get(q.id);
    const def = ROADS[t.type];
    const flip = seg.type === t.type && def.oneway;
    const cost = flip ? 0 : retypeCost(s, q.id, t.type);
    app.roads.showGhost([{ c: g.c, w: roadWidth(def), color: seg.locked ? '#ff4a3a' : seg.type === t.type && !flip ? '#ffffff' : '#4fc3ff' }]);
    if (!apply) {
      app.tools.showTip(seg.locked ? '<span class="bad">The outside connection can\'t be changed</span>'
        : flip ? `Turn this one-way road round` : seg.type === t.type ? `<span class="muted">Already a ${def.name}</span>`
          : `${ROADS[seg.type].name} → ${def.name} · ${Math.round(g.len * 8)} m · <span class="${canAfford(s, cost) ? '' : 'bad'}">${money(cost)}</span>`);
      return;
    }
    if (t.stroke?.has(q.id)) return;
    t.stroke?.add(q.id);
    if (seg.locked) return;
    if (flip) { reverseSeg(s, q.id); return; }
    if (seg.type === t.type) return;
    if (!retypeSeg(s, q.id, t.type)) app.toast('Not enough money', 'bad');
  },

  // ---- pointer
  hover(app, t, p, e) {
    const mode = t.mode || 'straight';
    if (mode === 'grid') { this.gridHover(app, t, p, e); return; }
    if (mode === 'upgrade') { this.upgradeAt(app, t, p, false); return; }
    if (!t.start) {
      const A = snapPoint(app, t, p.x, p.z, e);
      app.roads.showGhost([{ dot: [A.x, A.z], r: 0.3, color: A.node != null || A.seg != null ? '#ffffff' : '#4fc3ff' }]);
      const def = ROADS[t.type];
      app.tools.showTip(`${def.name} · ${money(def.cost)} / cell · ${def.speed} km/h<br><span class="muted">Click where the ${mode === 'bridge' ? 'bridge' : 'road'} starts</span>`);
      return;
    }
    if (mode === 'curve' && !t.bend) {
      const q = snapPoint(app, t, p.x, p.z, e);
      app.roads.showGhost([{ c: straightCurve(t.start.x, t.start.z, q.x, q.z), w: 0.15, color: '#ffd84f' }, { dot: [q.x, q.z], r: 0.2, color: '#ffd84f' }]);
      app.tools.showTip('<span class="muted">Click where the road bends</span>');
      return;
    }
    const r = this.planTo(app, t, p, e);
    if (r) this.showPlan(app, t, r);
  },
  down(app, t) { t.stroke = new Set(); },
  drag(app, t, a, b, e) {
    if ((t.mode || 'straight') === 'upgrade') { this.upgradeAt(app, t, b, true); this.upgradeAt(app, t, b, false); return; }
    this.hover(app, t, b, e);
  },
  up(app, t, a, b, e) {
    const mode = t.mode || 'straight';
    t.stroke = null;
    if (mode === 'grid') { this.gridClick(app, t, b, e); return; }
    if (mode === 'upgrade') { this.upgradeAt(app, t, b, false); return; }
    const dragged = Math.hypot(a.x - b.x, a.z - b.z) > 0.6;
    if (!t.start) {
      t.start = snapPoint(app, t, a.x, a.z, e);
      t.dir = null;
      // pressing at one point and letting go at another builds that piece in one go
      if (!dragged || mode === 'curve') { app.tools.renderOptions(); this.hover(app, t, b, e); return; }
    }
    if (mode === 'curve' && !t.bend) {
      const q = snapPoint(app, t, b.x, b.z, e);
      if (Math.hypot(q.x - t.start.x, q.z - t.start.z) < 0.5) return;
      t.bend = [q.x, q.z];
      app.tools.renderOptions();
      this.hover(app, t, b, e);
      return;
    }
    const r = this.planTo(app, t, b, e);
    if (!r) return;
    if (!r.plan.ok) { app.toast(r.plan.reason, 'bad', "Can't build here"); return; }
    const res = buildRoad(app.state, r.plan);
    if (res.error === 'money') { app.toast('Not enough money', 'bad'); return; }
    if (res.error) { app.toast(res.error, 'bad', "Can't build here"); return; }
    const spans = r.plan.pieces.filter((pc) => pc.br);
    if (spans.length && mode !== 'bridge') app.toast(`${spans.map((pc) => Math.round(pc.tab.len * 8)).join(', ')} m over the water`, 'good', `🌉 ${ROADS[t.type].name} bridge built`);
    // carry on from the end of this piece (in the direction it was going)
    const X = rn(app.state);
    const endNode = nearestNode(app.state, r.end.x, r.end.z, 0.05);
    const lastSeg = res.segs[res.segs.length - 1];
    let dir = null;
    if (lastSeg != null && X.geo.has(lastSeg)) { const d = bezTan(X.geo.get(lastSeg).c, 1); dir = [d[0], d[1]]; }
    t.start = endNode ? { x: endNode.x, z: endNode.z, node: endNode.id } : { x: r.end.x, z: r.end.z };
    t.dir = dir;
    t.bend = null;
    app.tools.renderOptions();
    this.hover(app, t, b, e);
  },
});
