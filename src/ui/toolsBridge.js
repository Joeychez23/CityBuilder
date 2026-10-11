// Bridge tool: click where the bridge starts, then where it ends. The ends join whatever
// road, railway or path is there (or become new ground-level pieces); the span between
// rises over water, valleys and other tracks. Backspace picks a new start point.
// A road bridge carries the road type you choose; starting on a road picks that road's type
// (until you choose one yourself). Each road's own tool has a Bridge mode that does the same
// (see bridgeSteps.js), and roads drawn across water get their bridges by themselves.
import { registerTool, segButtons } from './tools.js';
import { ROAD_LIST, ROADS, CLASS_NAMES } from '../data/roads.js';
import { idx } from '../core/grid.js';
import { bridgeHover, bridgeClick } from './bridgeSteps.js';

const KINDS = (app) => [
  ...ROAD_LIST.filter((r) => !app.lockReason(r)).map((r) => [`road:${r.id}`, r.name.replace(' Road', ''), `${r.name} bridge: ${CLASS_NAMES[r.cls].toLowerCase()}, ${r.lanes} lane${r.lanes > 1 ? 's' : ''}${r.oneway ? ' one way' : ' each way'}`]),
  ['rail', 'Railway'], ['path', 'Footpath'],
];
const parseKind = (k) => (k.startsWith('road:') ? { layer: 'road', type: +k.slice(5) } : { layer: k, type: null });

function describe(t) {
  const { layer, type } = parseKind(t.kindKey);
  return layer === 'road' ? `${ROADS[type].name} bridge` : layer === 'rail' ? 'Railway bridge' : 'Footbridge';
}

registerTool('bridge', {
  enter(app, t) { t.kindKey = t.kindKey || 'road:2'; t.start = null; },
  exit(app) { app.preview.clearCells(); },
  options(app, t, el, rerender) {
    el.innerHTML = `<h4>🌉 ${describe(t)}</h4>`;
    segButtons(el, 'Carries', KINDS(app), t.kindKey, (v) => { t.kindKey = v; t.picked = true; rerender(); });
    const road = parseKind(t.kindKey).layer === 'road';
    if (road) segButtons(el, 'Style', [['plain', 'Ordinary'], ['landmark', 'Suspension (landmark)']], t.style || 'plain', (v) => { t.style = v; rerender(); });
    if (road && t.style === 'landmark') el.insertAdjacentHTML('beforeend', '<p class="muted">A suspension bridge with tall towers and cables, for a long crossing over open water (at least 10 cells). It costs twice an ordinary bridge plus ₡300,000, and it\'s a landmark: visitors come to see it, and the neighbourhoods at either end feel the lift.</p>');
    el.insertAdjacentHTML('beforeend', `<p class="muted">${t.start ? `Start set at (${t.start.cx}, ${t.start.cy}). Now click the <b>end point</b>. Backspace to restart.` : `Click the <b>start point</b>: on a road end to connect to it${road && !t.picked ? ' (the bridge takes that road\'s type)' : ''}, or on open land.`}
      The deck leaves each end level with the road and arches just high enough over water, valleys, and railways or roads below. Bigger roads get sturdier bridges.${road ? ' Road bridges can cross at any angle (they snap straight near the grid and 45°). Roads you draw across water get bridges by themselves.' : ''} Both ends must be on land. Right click or Esc to pick a new start.</p>`);
  },
  hover(app, t, p) {
    const { layer, type } = parseKind(t.kindKey);
    bridgeHover(app, t, p, layer, type, describe(t));
  },
  up(app, t, a, p) {
    const s = app.state;
    // starting on a road: the bridge carries that road (unless you've chosen a type yourself)
    if (!t.start && !t.picked && t.kindKey.startsWith('road:') && s.road[idx(p.cx, p.cy)] && !s.bridgeH[idx(p.cx, p.cy)]) t.kindKey = `road:${s.road[idx(p.cx, p.cy)]}`;
    const { layer, type } = parseKind(t.kindKey);
    if (layer !== 'road') t.style = 'plain';
    bridgeClick(app, t, p, layer, type, describe(t));
  },
  key(app, t, e) {
    if (e.key === 'Backspace') { t.start = null; app.tools.renderOptions(); app.preview.clearCells(); }
  },
  cancel(app, t) {
    if (!t.start) return false;
    t.start = null;
    app.tools.renderOptions();
    app.preview.clearCells();
    return true;
  },
});
