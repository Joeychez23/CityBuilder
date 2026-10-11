// Bridge tool, for railways and footpaths: click where the bridge starts, then where it ends.
// The ends join whatever track or path is there (or become new ground-level pieces); the span
// between rises over water, valleys, roads and other tracks. Backspace picks a new start.
// (Road bridges are raised roads, drawn with the road tool's Bridge mode: see toolsRoad.js.)
import { registerTool, segButtons } from './tools.js';
import { bridgeHover, bridgeClick } from './bridgeSteps.js';

const KINDS = [['rail', 'Railway'], ['path', 'Footpath']];
const describe = (t) => (t.kindKey === 'rail' ? 'Railway bridge' : 'Footbridge');

registerTool('bridge', {
  enter(app, t) { t.kindKey = t.kindKey === 'path' ? 'path' : 'rail'; t.start = null; },
  exit(app) { app.preview.clearCells(); },
  options(app, t, el, rerender) {
    el.innerHTML = `<h4>🌉 ${describe(t)}</h4>`;
    segButtons(el, 'Carries', KINDS, t.kindKey, (v) => { t.kindKey = v; rerender(); });
    el.insertAdjacentHTML('beforeend', `<p class="muted">${t.start ? `Start set at (${t.start.cx}, ${t.start.cy}). Now click the <b>end point</b>. Backspace to restart.` : 'Click the <b>start point</b>: on the end of a track or path to connect to it, or on open land.'}
      The deck leaves each end level with the track and arches just high enough over water, valleys, and the roads or railways below. Both ends must be on land. Right click or Esc to pick a new start.</p>`);
  },
  hover(app, t, p) { bridgeHover(app, t, p, t.kindKey, null, describe(t)); },
  up(app, t, a, p) { bridgeClick(app, t, p, t.kindKey, null, describe(t)); },
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
