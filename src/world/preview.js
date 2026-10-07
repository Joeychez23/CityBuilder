// Tool previews: highlighted cells, a ghost building box, and a coverage radius ring.
import * as THREE from 'three';
import { boxMatrix } from './instanced.js';
import { cellHeight } from '../sim/mapgen.js';
import { N } from '../core/grid.js';

export function createPreview(view, state) {
  const cap = 4096;
  const cellGeo = new THREE.BoxGeometry(1, 0.06, 1).translate(0, 0.03, 0);
  const cellMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false });
  const cells = new THREE.InstancedMesh(cellGeo, cellMat, cap);
  cells.count = 0;
  cells.frustumCulled = false;
  cells.renderOrder = 10;
  cells.setColorAt(0, new THREE.Color('#fff'));
  view.scene.add(cells);

  const ghost = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    new THREE.MeshBasicMaterial({ color: '#4fc3ff', transparent: true, opacity: 0.45, depthWrite: false }),
  );
  ghost.visible = false;
  ghost.renderOrder = 11;
  view.scene.add(ghost);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.97, 1, 96).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8, depthTest: false }),
  );
  ring.visible = false;
  ring.renderOrder = 12;
  view.scene.add(ring);

  const brush = new THREE.Mesh(
    new THREE.RingGeometry(0.9, 1, 64).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: '#ffe066', transparent: true, opacity: 0.9, depthTest: false }),
  );
  brush.visible = false;
  brush.renderOrder = 12;
  view.scene.add(brush);

  const select = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    new THREE.MeshBasicMaterial({ color: '#ffd84f', wireframe: true }),
  );
  select.visible = false;
  view.scene.add(select);

  const m = new THREE.Matrix4();
  const c = new THREE.Color();

  return {
    // list: [[x, y, color], ...]
    setCells(list) {
      const n = Math.min(list.length, cap);
      for (let k = 0; k < n; k++) {
        const [x, y, color, deckH] = list[k];
        const h = deckH ?? Math.max(cellHeight(state, x, y), state.water[y * N + x] ? state.seaLevel + 0.5 : -1);
        cells.setMatrixAt(k, boxMatrix(x + 0.5, h + 0.12, y + 0.5, 0.96, 1, 0.96, 0, m));
        cells.setColorAt(k, c.set(color));
      }
      cells.count = n;
      cells.instanceMatrix.needsUpdate = true;
      if (cells.instanceColor) cells.instanceColor.needsUpdate = true;
    },
    clearCells() { cells.count = 0; },
    setGhost(x0, y0, x1, y1, height, ok) {
      const cx = (x0 + x1 + 1) / 2, cz = (y0 + y1 + 1) / 2;
      ghost.position.set(cx, cellHeight(state, Math.floor(cx), Math.floor(cz)) - 0.2, cz);
      ghost.scale.set(x1 - x0 + 1, height + 0.2, y1 - y0 + 1);
      ghost.material.color.set(ok ? '#4fc3ff' : '#ff5a4f');
      ghost.visible = true;
    },
    hideGhost() { ghost.visible = false; },
    setRing(x, z, r, color = '#ffffff') {
      if (!r) { ring.visible = false; return; }
      ring.position.set(x, cellHeight(state, Math.floor(Math.min(x, N - 1)), Math.floor(Math.min(z, N - 1))) + 0.4, z);
      ring.scale.set(r, 1, r);
      ring.material.color.set(color);
      ring.visible = true;
    },
    setBrush(x, z, r) {
      if (!r) { brush.visible = false; return; }
      brush.position.set(x, cellHeight(state, Math.floor(Math.min(x, N - 1)), Math.floor(Math.min(z, N - 1))) + 0.5, z);
      brush.scale.set(r, 1, r);
      brush.visible = true;
    },
    setSelection(b) {
      if (!b) { select.visible = false; return; }
      select.position.set((b.x0 + b.x1 + 1) / 2, b.baseY - 0.1, (b.y0 + b.y1 + 1) / 2);
      select.scale.set(b.x1 - b.x0 + 1.1, (b.height || 1) + 0.3, b.y1 - b.y0 + 1.1);
      select.visible = true;
    },
  };
}
