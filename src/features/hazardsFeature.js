// Earthquakes, storm surges, heatwaves and the long-term climate (sim/hazards.js): their
// systems, the flood water you see over low ground, and the ground shaking in a quake.
import * as THREE from 'three';
import { registerSystem } from '../sim/simulation.js';
import { earthquakeHourly, quakeRepairsHourly, surgeHourly, heatwaveDaily, climateDaily } from '../sim/hazards.js';
import { N } from '../core/grid.js';
import { bus } from '../core/events.js';

export const hazardsFeature = {
  init(app) {
    const { state, ctx, view } = app;
    registerSystem({ name: 'earthquakes', every: 'hour', run: earthquakeHourly });
    registerSystem({ name: 'quake-repairs', every: 'hour', run: quakeRepairsHourly });
    registerSystem({ name: 'storm-surge', every: 'hour', run: surgeHourly });
    registerSystem({ name: 'heatwaves', every: 'day', run: heatwaveDaily });
    registerSystem({ name: 'climate-change', every: 'day', run: climateDaily });

    // flood water: a sheet over every flooded cell, at the height the sea came up to
    const geo = new THREE.BoxGeometry(1, 0.04, 1);
    const mat = new THREE.MeshStandardMaterial({ color: '#4f7fa8', transparent: true, opacity: 0.78, roughness: 0.2, metalness: 0.1 });
    let flood = null;
    bus.on('surge', (s) => {
      if (flood) { view.scene.remove(flood); flood.dispose(); flood = null; }
      if (!s?.cells.length) return;
      flood = new THREE.InstancedMesh(geo, mat, s.cells.length);
      const m = new THREE.Matrix4();
      s.cells.forEach((i, k) => flood.setMatrixAt(k, m.makeTranslation((i % N) + 0.5, s.level, ((i / N) | 0) + 0.5)));
      flood.instanceMatrix.needsUpdate = true;
      view.scene.add(flood);
    });
    // (a city loaded during a surge has it end at once: the surge isn't saved)
    for (const b of state.buildings.values()) b.flooded = false;
    if ((state.closures || []).some((c) => c.why === 'flood')) state.closures = state.closures.filter((c) => c.why !== 'flood');

    bus.on('sea:changed', () => { app.terrain.updateHeights(); app.features?.climate?.recolorTerrain?.(); });
    // the ground shakes
    app.shake = 0;
    bus.on('quake', ({ mag }) => { app.shake = Math.max(app.shake, (mag - 4) * 1.2); });
  },
  frame(app, dt) {
    if (app.shake > 0) {
      const c = app.view.camera, a = Math.min(1, app.shake) * 0.35;
      c.position.x += (Math.random() - 0.5) * a; c.position.y += (Math.random() - 0.5) * a * 0.6; c.position.z += (Math.random() - 0.5) * a;
      app.shake = Math.max(0, app.shake - dt * 0.9);
    }
  },
};
