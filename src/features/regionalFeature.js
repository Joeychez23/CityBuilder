// The city's big links (sim/regional.js, tunnels.js, landmarkBridges.js): the hyperloop's
// commuters each day, suspension bridges kept in step with the road network, and the
// drawing of tunnels, the tube and bridge towers (world/linksView.js).
import { registerSystem } from '../sim/simulation.js';
import { hyperloopDaily } from '../sim/regional.js';
import { pruneLandmarkBridges } from '../sim/landmarkBridges.js';
import { createLinksView } from '../world/linksView.js';
import { bus } from '../core/events.js';

export const regionalFeature = {
  init(app) {
    const { state, ctx, view } = app;
    registerSystem({ name: 'hyperloop', every: 'day', run: hyperloopDaily });
    hyperloopDaily(state, ctx);
    bus.on('network:changed', () => pruneLandmarkBridges(state));
    app.links = createLinksView(view, state);
    // the tunnels show while you look underground, or bore one
    let hint = false, boring = false;
    const sync = () => app.links.setUnderground(hint || boring);
    const setHint = app.setLayerHint;
    app.setLayerHint = (layer, on) => { setHint(layer, on); if (layer === 'subway') { hint = on; sync(); } };
    bus.on('tool:changed', (t) => { boring = t?.kind === 'tunnel'; sync(); });
  },
  frame(app, dt) { app.links.update(dt); },
};
