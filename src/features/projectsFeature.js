// Projects you lay out (sim/projects.js): the theme park, the boardwalk's kiosks and the
// water taxis run every day; the boats are drawn every frame.
import { registerSystem } from '../sim/simulation.js';
import { themeParkDaily, boardwalksDaily, waterTaxisDaily, waterTaxiRoutes, clearSand } from '../sim/projects.js';
import { createBoatsView } from '../world/boatsView.js';
import { bus } from '../core/events.js';

export const projectsFeature = {
  init(app) {
    const { state, ctx, view } = app;
    registerSystem({ name: 'theme-park', every: 'day', run: themeParkDaily });
    registerSystem({ name: 'boardwalks', every: 'day', run: boardwalksDaily });
    registerSystem({ name: 'water-taxis', every: 'day', run: waterTaxisDaily });
    app.boats = createBoatsView(view, state);
    const routes = () => setTimeout(() => waterTaxiRoutes(state, ctx), 0);
    bus.on('building:add', (b) => { if (b.def.waterTaxi) routes(); });
    bus.on('building:remove', (b) => { if (b.def.waterTaxi) routes(); });
    bus.on('construction:done', (b) => { if (b.def.waterTaxi) routes(); });
    bus.on('canal:changed', routes);
    bus.on('building:remove', (b) => { if (b.def.sand) clearSand(state, b); });
    bus.on('surface:changed', () => { app.overlays.dirty = true; });
    routes();
  },
  frame(app, dt) { app.boats.update(dt); },
};
