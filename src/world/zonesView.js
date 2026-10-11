// Zoning drawn on the ground: each zone cell of the strips along the roads (sim/zoneblocks.js)
// is a square set square to its road, in its zone's colour, until a building stands on it.
// While you zone, the cells you could zone are shown faintly too, and a lot's front yard is
// paler with its outline darker. The zone tool's preview is drawn the same way on top. It's
// built in chunks of the map, so a building going up or a stroke of paint redraws only the
// chunks it's in.
import * as THREE from 'three';
import { N, clamp } from '../core/grid.js';
import { ZONES } from '../data/zones.js';
import { zoneLayout, zoneOf } from '../sim/zoneblocks.js';
import { plotOfCell } from '../sim/build.js';
import { terrainAt } from '../sim/mapgen.js';
import { bus } from '../core/events.js';

const LIFT = 0.05, HALF = 0.46;
const CH = 32, CN = Math.ceil(N / CH);
const rgb = {};
for (const z of Object.values(ZONES)) rgb[z.id] = new THREE.Color(z.color);
const WHITE = new THREE.Color('#ffffff');
const chunkAt = (x, z) => clamp(Math.floor(z / CH), 0, CN - 1) * CN + clamp(Math.floor(x / CH), 0, CN - 1);

export function createZonesView(view, state) {
  const material = (order) => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -order, side: THREE.DoubleSide });
  const mat = material(2), previewMat = material(4);
  const chunks = new Map(); // chunk -> mesh
  const sigs = new Map();   // chunk -> what was drawn in it (a number)
  // all: look at every chunk (redrawing those that changed); force: redraw every chunk
  let preview = null, all = true, force = true, buckets = null, bucketVer = -1;
  const dirty = new Set();
  const zv = { zoneMode: false, hidden: false };
  // (zv.dirty = true redraws everything)
  Object.defineProperty(zv, 'dirty', { get: () => all || force || dirty.size > 0, set: (v) => { if (v) force = true; } });
  const around = (x0, z0, x1, z1) => {
    for (let cz = clamp(Math.floor(z0 / CH), 0, CN - 1); cz <= clamp(Math.floor(z1 / CH), 0, CN - 1); cz++) {
      for (let cx = clamp(Math.floor(x0 / CH), 0, CN - 1); cx <= clamp(Math.floor(x1 / CH), 0, CN - 1); cx++) dirty.add(cz * CN + cx);
    }
  };
  bus.on('zones:layout', () => { all = true; });
  bus.on('terrain:changed', () => { force = true; });
  bus.on('zones:changed', (e) => { if (e?.cells) for (const c of e.cells) dirty.add(chunkAt(c.x, c.z)); else all = true; });
  for (const e of ['building:add', 'building:remove']) bus.on(e, (b) => around(b.x0 - 1, b.y0 - 1, b.x1 + 2, b.y1 + 2));
  zv.setZoneMode = (on) => { if (zv.zoneMode !== !!on) force = true; zv.zoneMode = !!on; };

  // Squares for zone cells: [cell, colour, alpha, inset][]
  function quads(items, lift) {
    const pos = new Float32Array(items.length * 12), col = new Float32Array(items.length * 16), index = new Uint32Array(items.length * 6);
    let p = 0, q = 0;
    for (let k = 0; k < items.length; k++) {
      const [c, color, a, inset = 0] = items[k];
      const h = HALF - inset;
      for (let j = 0; j < 4; j++) {
        const u = j === 0 || j === 3 ? -h : h, v = j < 2 ? -h : h;
        const x = c.x + c.tx * u + c.nx * v, z = c.z + c.tz * u + c.nz * v;
        pos[p++] = x; pos[p++] = terrainAt(state, x, z) + lift; pos[p++] = z;
        col[q++] = color.r; col[q++] = color.g; col[q++] = color.b; col[q++] = a;
      }
      const o = k * 4, i6 = k * 6;
      index[i6] = o; index[i6 + 1] = o + 1; index[i6 + 2] = o + 2; index[i6 + 3] = o; index[i6 + 4] = o + 2; index[i6 + 5] = o + 3;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    return g;
  }

  // What a chunk shows, as a number: where its cells are, their zones, which have buildings
  // on them and which are on lots
  function signature(cells, lotted) {
    let h = 2166136261;
    const mix = (v) => { h = Math.imul(h ^ v, 16777619); };
    for (const c of cells) {
      mix(Math.round(c.x * 64)); mix(Math.round(c.z * 64));
      mix(zoneOf(state, c) * 2 + (state.bld[c.g] ? 1 : 0));
      if (lotted.size) mix(lotted.get(`${c.seg}:${c.side}:${c.col}:${c.row}`) || 0);
    }
    return h >>> 0;
  }

  // One chunk's squares
  function buildChunk(cells) {
    const items = [];
    // (where the strips of crossing roads overlap, one square per spot)
    const drawn = new Set();
    const a = zv.zoneMode ? 0.75 : 0.5;
    for (const c of cells) {
      if (state.bld[c.g] || drawn.has(c.g)) continue;
      const z = zoneOf(state, c);
      if (!z) continue;
      drawn.add(c.g);
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
    if (zv.zoneMode) for (const c of cells) if (!state.bld[c.g] && !drawn.has(c.g)) { drawn.add(c.g); items.push([c, WHITE, 0.16, 0.04]); }
    if (!items.length) return null;
    const mesh = new THREE.Mesh(quads(items, LIFT), mat);
    mesh.renderOrder = 2;
    mesh.visible = !zv.hidden;
    view.scene.add(mesh);
    return mesh;
  }

  zv.rebuild = () => {
    const Z = zoneLayout(state);
    // the zone cells of each chunk (by where their middles are)
    if (bucketVer !== Z.ver || !buckets) {
      buckets = new Map();
      for (const c of Z.cells) { const k = chunkAt(c.x, c.z); let b = buckets.get(k); if (!b) buckets.set(k, (b = [])); b.push(c); }
      bucketVer = Z.ver;
      all = true;
    }
    const keys = all || force ? new Set([...buckets.keys(), ...chunks.keys(), ...sigs.keys()]) : new Set(dirty);
    const checkOnly = all && !force, touched = new Set(dirty);
    all = force = false;
    dirty.clear();
    // (cells laid out on a lot, and how deep its front yard is, for the signatures)
    const lotted = new Map();
    for (const p of state.plots || []) for (let j = 0; j < p.w; j++) for (let r = 0; r < p.d; r++) lotted.set(`${p.seg}:${p.side}:${p.col + j}:${r}`, (p.setback || 0) + 1);
    for (const k of keys) {
      const cells = buckets.get(k);
      const sig = cells ? signature(cells, lotted) : -1;
      if (checkOnly && !touched.has(k) && sigs.get(k) === sig) continue;
      sigs.set(k, sig);
      const old = chunks.get(k);
      if (old) { view.scene.remove(old); old.geometry.dispose(); chunks.delete(k); }
      const mesh = cells && buildChunk(cells);
      if (mesh) chunks.set(k, mesh);
    }
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
  zv.setHidden = (on) => { zv.hidden = !!on; for (const m of chunks.values()) m.visible = !zv.hidden; };
  return zv;
}
