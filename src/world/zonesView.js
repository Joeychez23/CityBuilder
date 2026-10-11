// Zoning drawn on the ground: each zone cell of the strips along the roads (sim/zoneblocks.js)
// is a square set square to its road, in its zone's colour, until a building stands on it.
// While you zone, the cells you could zone are shown faintly too, and a lot's front yard is
// paler with its outline darker. The zone tool's preview is drawn the same way on top.
import * as THREE from 'three';
import { ZONES } from '../data/zones.js';
import { zoneLayout, zoneOf } from '../sim/zoneblocks.js';
import { plotOfCell } from '../sim/build.js';
import { terrainAt } from '../sim/mapgen.js';
import { bus } from '../core/events.js';

const LIFT = 0.05, HALF = 0.46;
const rgb = {};
for (const z of Object.values(ZONES)) rgb[z.id] = new THREE.Color(z.color);
const WHITE = new THREE.Color('#ffffff');

export function createZonesView(view, state) {
  const material = (order) => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -order, side: THREE.DoubleSide });
  const mat = material(2), previewMat = material(4);
  let mesh = null, preview = null;
  const zv = { dirty: true, zoneMode: false };
  for (const e of ['zones:changed', 'zones:layout', 'building:add', 'building:remove', 'terrain:changed']) bus.on(e, () => { zv.dirty = true; });
  zv.setZoneMode = (on) => { zv.zoneMode = !!on; zv.dirty = true; };

  // Squares for zone cells: [cell, colour, alpha, inset][]
  function quads(items, lift) {
    const pos = new Float32Array(items.length * 12), col = new Float32Array(items.length * 16), index = [];
    items.forEach(([c, color, a, inset = 0], k) => {
      const h = HALF - inset;
      const corners = [[-h, -h], [h, -h], [h, h], [-h, h]];
      corners.forEach(([u, v], j) => {
        const x = c.x + c.tx * u + c.nx * v, z = c.z + c.tz * u + c.nz * v;
        pos.set([x, terrainAt(state, x, z) + lift, z], k * 12 + j * 3);
        col.set([color.r, color.g, color.b, a], k * 16 + j * 4);
      });
      const o = k * 4;
      index.push(o, o + 1, o + 2, o, o + 2, o + 3);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    g.setIndex(index);
    return g;
  }

  zv.rebuild = () => {
    if (mesh) { view.scene.remove(mesh); mesh.geometry.dispose(); mesh = null; }
    const Z = zoneLayout(state);
    const items = [];
    // (where the strips of crossing roads overlap, one square per spot)
    const drawn = new Set();
    for (const c of Z.cells) {
      if (state.bld[c.g] || drawn.has(c.g)) continue;
      const z = zoneOf(state, c);
      if (!z) continue;
      drawn.add(c.g);
      const a = zv.zoneMode ? 0.75 : 0.5;
      const p = plotOfCell(state, c);
      if (p) {
        // a lot: its front yard paler, its outline darker
        const color = c.row < (p.setback || 0) ? rgb[z].clone().lerp(WHITE, 0.55) : rgb[z];
        if (c.col === p.col || c.col === p.col + p.w - 1 || c.row === p.d - 1) items.push([c, color.clone().multiplyScalar(0.6), 0.85]);
        items.push([c, color, a, 0.07]);
        continue;
      }
      items.push([c, rgb[z], a, 0.02]);
    }
    // while zoning: the cells you could zone, faintly
    if (zv.zoneMode) for (const c of Z.cells) if (!state.bld[c.g] && !drawn.has(c.g)) { drawn.add(c.g); items.push([c, WHITE, 0.16, 0.04]); }
    if (items.length) {
      mesh = new THREE.Mesh(quads(items, LIFT), mat);
      mesh.renderOrder = 2;
      view.scene.add(mesh);
    }
    zv.dirty = false;
  };

  // The zone tool's preview: these cells in this colour (cells: zone cells, or [cell, colour])
  zv.preview = (cells, color) => {
    zv.clearPreview();
    if (!cells.length) return;
    const c0 = new THREE.Color(color);
    preview = new THREE.Mesh(quads(cells.map((c) => (Array.isArray(c) ? [c[0], new THREE.Color(c[1]), 0.85] : [c, c0, 0.85])), LIFT + 0.02), previewMat);
    preview.renderOrder = 3;
    view.scene.add(preview);
  };
  zv.clearPreview = () => { if (preview) { view.scene.remove(preview); preview.geometry.dispose(); preview = null; } };
  zv.update = () => { if (zv.dirty) zv.rebuild(); };
  return zv;
}
