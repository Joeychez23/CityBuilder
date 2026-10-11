// Wonders, the capital, attractions and giant industry: their systems (sim/landmarks.js),
// road closures, and the particle collider's ring, shown under the city when you select the
// collider or look underground.
import * as THREE from 'three';
import { registerSystem } from '../sim/simulation.js';
import { scanLandmarks, landmarksDaily } from '../sim/landmarks.js';
import { closuresHourly } from '../sim/closures.js';
import { bus } from '../core/events.js';

export const landmarksFeature = {
  init(app) {
    const { state, ctx, view } = app;
    registerSystem({ name: 'landmarks', every: 'hour', run: scanLandmarks });
    registerSystem({ name: 'landmarks-day', every: 'day', run: landmarksDaily });
    registerSystem({ name: 'closures', every: 'hour', run: closuresHourly });
    scanLandmarks(state, ctx);
    let soon = false;
    bus.on('services:changed', () => { if (!soon) { soon = true; setTimeout(() => { soon = false; scanLandmarks(state, ctx); }, 300); } });
    bus.on('roads:closed', () => { app.networks.dirty = true; });

    // --- the collider's ring
    const mat = new THREE.MeshBasicMaterial({ color: '#7fd3ff', transparent: true, opacity: 0.6, depthTest: false, depthWrite: false });
    let mesh = null, selected = false, underground = false;
    const collider = () => [...state.buildings.values()].find((b) => b.def.ring);
    function sync() {
      const b = collider();
      if (mesh) { view.scene.remove(mesh); mesh.geometry.dispose(); mesh = null; }
      if (!b) return;
      mesh = new THREE.Mesh(new THREE.TorusGeometry(b.def.ring, 0.16, 6, 180).rotateX(Math.PI / 2), mat);
      mesh.position.set((b.x0 + b.x1 + 1) / 2, (b.baseY ?? 0) + 0.12, (b.y0 + b.y1 + 1) / 2);
      mesh.renderOrder = 12;
      view.scene.add(mesh);
      show();
    }
    const show = () => { if (mesh) mesh.visible = selected || underground; };
    bus.on('building:add', (b) => { if (b.def.ring) sync(); });
    bus.on('building:remove', (b) => { if (b.def.ring) setTimeout(sync, 0); });
    bus.on('select', (sel) => { const b = collider(); selected = !!(b && sel?.id === b.id); show(); });
    const setHint = app.setLayerHint;
    app.setLayerHint = (layer, on) => { setHint(layer, on); if (layer === 'subway') { underground = on; show(); } };
    sync();
  },
};
