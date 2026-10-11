// Draws every building with a handful of InstancedMeshes. A building is a list of "parts"
// (boxes, gable roofs, cylinders) generated from its zone/service definition and level.
import * as THREE from 'three';
import { InstancedPool, boxMatrix, unitBox, unitRoof } from './instanced.js';
import { THEMES } from '../data/maps.js';
import { makeRng } from '../core/rng.js';
import { storageCap } from '../sim/services.js';
import { cellHeight, terrainAt } from '../sim/mapgen.js';
import { bus } from '../core/events.js';
import { N, DIRS, hidx } from '../core/grid.js';
import { FLOOR, zoneParts } from './zoneStyles.js';
import { liveParts } from '../data/wonders.js';

export { FLOOR };

// Facing direction (towards the road) -> rotation so the building's front (+z) faces it
const FACING_RY = [Math.PI / 2, 0, -Math.PI / 2, Math.PI];

function windowMaterial(nightUniform) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.05 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = nightUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLit;\nvarying vec3 vWPos;\nvarying vec3 vWN;\nvarying float vLit;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 wpos4 = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
        vWPos = wpos4.xyz;
        vLit = aLit;
        vWN = normalize(mat3(modelMatrix * instanceMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight; varying vec3 vWPos; varying vec3 vWN; varying float vLit;
        float whash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float side = step(abs(vWN.y), 0.5);
        vec2 fc = vec2((abs(vWN.x) > 0.5 ? vWPos.z : vWPos.x) * 2.6, (vWPos.y - 0.12) * 2.63);
        vec2 wcell = floor(fc); vec2 wf = fract(fc);
        float win = side * step(0.22, wf.x) * step(wf.x, 0.78) * step(0.3, wf.y) * step(wf.y, 0.8);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.35 + vec3(0.06, 0.09, 0.13), win * 0.65);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float lit = step(0.42, whash(wcell + floor(vWPos.xz * 0.5) * 7.0));
        totalEmissiveRadiance += win * lit * vLit * uNight * vec3(1.0, 0.78, 0.42) * 1.25;`);
  };
  return mat;
}

export function createBuildingsView(view, state, servicesById) {
  const night = { value: 0 };
  const theme = THEMES[state.theme] || THEMES.eu;
  const scene = view.scene;
  const pools = {
    body: new InstancedPool(scene, unitBox, windowMaterial(night), 2048, { lit: true }),
    plain: new InstancedPool(scene, unitBox, new THREE.MeshStandardMaterial({ roughness: 0.85 }), 2048),
    roof: new InstancedPool(scene, unitRoof, new THREE.MeshStandardMaterial({ roughness: 0.8 }), 1024),
    cyl: new InstancedPool(scene, new THREE.CylinderGeometry(0.5, 0.5, 1, 12).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.2 }), 512),
    dome: new InstancedPool(scene, new THREE.SphereGeometry(0.5, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 2, 1), new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.3 }), 128),
    // a pyramid 1 × 1 at the base and 1 tall: hipped roofs, sunshades, spoil heaps
    hip: new InstancedPool(scene, new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true }), 512),
  };

  const bv = { pools, night, colorFn: null };
  const m = new THREE.Matrix4();

  // --- Part generators ---------------------------------------------------------------
  // Grown buildings: one of their zone's styles (see zoneStyles.js)
  const zonedParts = (b, def) => zoneParts(b, def, theme, state.theme);

  // Landfill: a dirt yard with a site office, and a garbage mound that grows as it fills
  // (it covers the whole yard, including land added by expansions)
  function landfillParts(b, def) {
    const W = b.w, D = b.d;
    const fill = Math.min(1, (b.stored || 0) / Math.max(1, storageCap(b)));
    const r = makeRng(b.seed);
    const P = [
      { pool: 'plain', x: 0, z: 0, w: W * 0.98, d: D * 0.98, h: 0.08, color: '#6f5f45' },
      { pool: 'body', x: -W * 0.32, z: D * 0.5 - 0.45, w: 0.9, d: 0.55, h: 0.5, color: '#bfb6a0' },
      { pool: 'plain', x: W * 0.15, z: D * 0.5 - 0.3, w: W * 0.5, d: 0.25, h: 0.1, color: '#55585e' },
    ];
    const mw = W * 0.86, md = Math.max(0.6, D - 1.2), mz = -0.5;
    // a terraced mound that rises (and spreads) as the landfill fills
    const total = 0.1 + fill * (0.7 + Math.sqrt(W * D) * 0.09);
    const layers = 3;
    let h = 0;
    for (let k = 0; k < layers; k++) {
      const sc = 1 - k * 0.24, lh = total / layers;
      P.push({ pool: 'plain', x: 0, z: mz, w: mw * sc * (0.75 + fill * 0.25), d: md * sc * (0.75 + fill * 0.25), h: lh, y: k ? h : 0, color: k === layers - 1 ? '#8a7659' : k ? '#7f6c51' : '#74634b' });
      h += lh;
    }
    if (fill > 0.05) P.push({ pool: 'plain', x: mw * 0.12, z: mz + md * 0.1, w: 0.28, d: 0.16, h: 0.14, y: h, color: '#ffd300' }); // bulldozer on the working face
    // bits of rubbish on top, more as it fills
    const bits = Math.round(fill * (8 + W * D * 0.4));
    for (let k = 0; k < bits; k++) {
      P.push({ pool: 'plain', x: r.range(-mw / 2.4, mw / 2.4), z: mz + r.range(-md / 2.6, md / 2.6), w: 0.14, d: 0.12, h: 0.08,
        y: h + 0.05, color: r.pick(['#c9c2b0', '#3f6fa8', '#b8483b', '#e7c34f', '#5f8f4e', '#dedad2']) });
    }
    if (fill >= 0.999) P.push({ pool: 'plain', x: W * 0.35, z: D * 0.5 - 0.3, w: 0.08, d: 0.08, h: 0.7, color: '#ff4b3a' });
    return P;
  }

  function serviceParts(b, def) {
    if (def.parts) return def.parts(b); // laid out to the size you drew (data/projects.js)
    // (the car factory's yard and the shipyard's slipway change as they work)
    if (def.shape) return [...def.shape, ...(def.factory ? liveParts(b) : [])].map((p) => ({ ...p, w: p.w * (p.rel ? b.w : 1), d: p.d * (p.rel ? b.d : 1) }));
    const h = (def.height || 2) * FLOOR;
    return [
      { pool: 'body', x: 0, z: 0, w: b.w * 0.85, d: b.d * 0.8, h, color: def.color || '#d8d4cc' },
      { pool: 'plain', x: 0, z: 0, w: b.w * 0.5, d: b.d * 0.4, h: 0.12, y: h, color: def.accent || '#999' },
    ];
  }

  // --- Public API ---------------------------------------------------------------------
  // A building site: dirt, a fence, the building rising in bare concrete inside scaffolding,
  // and a crane on the bigger jobs
  function siteParts(b, full) {
    const W = b.w, D = b.d;
    const k = b.cons.progress;
    const top = Math.max(0.2, ...full.map((p) => (p.y || 0) + p.h));
    const level = top * Math.min(1, Math.max(0, (k - 0.08) / 0.92));
    const P = [{ pool: 'plain', x: 0, z: 0, w: W * 0.98, d: D * 0.98, h: 0.05, color: '#8a7558' }];
    for (const p of full) {
      const y = p.y || 0;
      if (y >= level || p.h < 0.03) continue;
      P.push({ ...p, pool: 'plain', h: Math.min(p.h, level - y), color: k > 0.85 ? p.color : '#bdb7aa' });
    }
    // fence round the lot (a gap at the front for the trucks)
    const fh = 0.16, fc = '#f2a03d';
    P.push({ pool: 'plain', x: 0, z: -D * 0.47, w: W * 0.94, d: 0.03, h: fh, color: fc });
    P.push({ pool: 'plain', x: -W * 0.47, z: 0, w: 0.03, d: D * 0.94, h: fh, color: fc });
    P.push({ pool: 'plain', x: W * 0.47, z: 0, w: 0.03, d: D * 0.94, h: fh, color: fc });
    P.push({ pool: 'plain', x: -W * 0.3, z: D * 0.47, w: W * 0.34, d: 0.03, h: fh, color: fc });
    P.push({ pool: 'plain', x: W * 0.3, z: D * 0.47, w: W * 0.34, d: 0.03, h: fh, color: fc });
    if (level > 0.15 && k < 0.97) scaffold(P, full, W, D, level);
    if (k < 0.97 && (top > 1.4 || W * D >= 9)) crane(P, W, D, top);
    else if (k < 0.25) {
      // a little digger early on
      P.push({ pool: 'plain', x: W * 0.2, z: D * 0.15, w: 0.3, d: 0.18, h: 0.14, color: '#ffd300' });
    }
    return P;
  }

  // Scaffolding: poles at the corners of what's going up, with a deck every floor and a half
  function scaffold(P, full, W, D, level) {
    // around the tallest part (the main block, not a front lawn)
    const main = full.reduce((a, p) => ((p.y || 0) + p.h > (a.y || 0) + a.h ? p : a), full[0]);
    const sw = Math.min(W * 0.92, main.w + 0.1), sd = Math.min(D * 0.92, main.d + 0.1);
    const cx = main.x || 0, cz = main.z || 0;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) P.push({ pool: 'plain', x: cx + (sx * sw) / 2, z: cz + (sz * sd) / 2, w: 0.04, d: 0.04, h: level + 0.2, color: '#9aa1a8' });
    for (let y = FLOOR; y < level + 0.1; y += FLOOR * 1.5) {
      P.push({ pool: 'plain', x: cx, z: cz + sd / 2, w: sw, d: 0.05, h: 0.03, y, color: '#9aa1a8' });
      P.push({ pool: 'plain', x: cx, z: cz - sd / 2, w: sw, d: 0.05, h: 0.03, y, color: '#9aa1a8' });
    }
  }

  // Tower crane at a back corner
  function crane(P, W, D, top) {
    const mh = top + 1.1, cx = -W * 0.36, cz = -D * 0.36;
    P.push({ pool: 'plain', x: cx, z: cz, w: 0.12, d: 0.12, h: mh, color: '#ffd300' });
    P.push({ pool: 'plain', x: cx + W * 0.25, z: cz, w: W * 0.95, d: 0.08, h: 0.08, y: mh, color: '#ffd300' });
    P.push({ pool: 'plain', x: cx - W * 0.2, z: cz, w: 0.3, d: 0.2, h: 0.14, y: mh - 0.1, color: '#55585e' });
  }

  // Levelling up: the building stays open; its new floors rise in bare concrete inside
  // scaffolding (with a crane on tall ones) until the work is done
  function renoParts(b) {
    const before = partsFor({ ...b, reno: null });
    const after = partsFor({ ...b, reno: null, level: b.reno.to });
    const top = (P) => Math.max(0.2, ...P.map((p) => (p.y || 0) + p.h));
    const t0 = top(before), t1 = Math.max(t0 + 0.05, top(after));
    const k = b.reno.progress;
    const level = t0 + (t1 - t0) * Math.min(1, k / 0.85);
    const P = [];
    for (const p of after) {
      const y = p.y || 0;
      if (y >= level) continue;
      const h = Math.min(p.h, level - y);
      if (k >= 0.85 || y + h <= t0 + 0.01) { P.push({ ...p, h }); continue; }
      // the old part below, the new part above in concrete
      if (y < t0) P.push({ ...p, h: t0 - y });
      const ny = Math.max(y, t0);
      P.push({ ...p, y: ny, h: y + h - ny, color: '#bdb7aa' });
    }
    if (k < 0.97) {
      scaffold(P, after, b.w, b.d, level);
      if (t1 > 1.4 || b.w * b.d >= 9) crane(P, b.w, b.d, t1);
    }
    return P;
  }

  // The parts a building is drawn with, in its own frame (x along the road, z toward it)
  function partsFor(b) {
    if (b.cons) return siteParts(b, partsFor({ ...b, cons: null, reno: null }));
    if (b.reno) return renoParts(b);
    const def = b.def;
    let parts;
    if (b.kind === 'zone' && !def.shape) {
      // On a lot with a front yard the building stands back from the street: it's drawn on
      // the part of the lot behind the yard, and the yard gets a lawn (or a paved forecourt)
      // with a path out to the road
      const S = Math.min(b.setback || 0, b.d - 1);
      if (S > 0) {
        parts = zonedParts({ ...b, d: b.d - S }, def).map((pt) => ({ ...pt, z: pt.z - S / 2 }));
        const res = def.cat === 'res';
        parts.unshift({ pool: 'plain', x: 0, z: b.d / 2 - S / 2, w: b.w * 0.97, d: S * 0.97, h: 0.04, color: res ? '#7fae55' : '#9a978f' });
        parts.push({ pool: 'plain', x: b.w * (res ? 0.22 : 0), z: b.d / 2 - S / 2, w: res ? 0.18 : b.w * 0.5, d: S, h: 0.05, color: res ? '#c9c2b2' : '#6f6e6a' });
      } else parts = zonedParts(b, def);
    }
    else if (def.garbageRate && def.storage) parts = landfillParts(b, def);
    else parts = serviceParts(b, def);
    return parts;
  }

  // On sloping land a building stands on a stone foundation that reaches down to the lowest
  // ground under it, so it never floats on the downhill side
  function withBase(b, parts) {
    if (b.def.noBase) return parts; // (a beach lies on the ground as it is)
    const H = state.height;
    let lo = Infinity;
    if (b.cells) for (const i of b.cells) { const x = i % N, y = (i / N) | 0; lo = Math.min(lo, H[hidx(x, y)], H[hidx(x + 1, y)], H[hidx(x, y + 1)], H[hidx(x + 1, y + 1)]); }
    else for (let y = b.y0; y <= b.y1 + 1; y++) for (let x = b.x0; x <= b.x1 + 1; x++) lo = Math.min(lo, H[hidx(x, y)]);
    const drop = (b.baseY ?? 0) - lo;
    if (!(drop > 0.12)) return parts;
    return [{ pool: 'plain', x: 0, z: 0, w: b.w * 0.99, d: b.d * 0.99, h: drop + 0.02, y: -drop, color: '#8d877b' }, ...parts];
  }

  // Which way the building faces: turned to face its road (b.ang), or one of the four ways
  function facing(b) {
    return { ry: b.ang ?? FACING_RY[b.rot || 0], scale: 1 };
  }

  // World matrices for a building's parts
  function place(b, parts, cb) {
    const cx = b.cx ?? b.x0 + (b.x1 - b.x0 + 1) / 2;
    const cz = b.cz ?? b.y0 + (b.y1 - b.y0 + 1) / 2;
    const { ry, scale } = facing(b);
    const cos = Math.cos(ry), sin = Math.sin(ry);
    const baseY = b.baseY ?? 0;
    for (const p of parts) {
      // rotate the local offset (x along road, z towards the road) into world space
      const px = p.x * scale, pz = p.z * scale;
      const wx = cx + px * cos + pz * sin;
      const wz = cz - px * sin + pz * cos;
      // roofs sit a hair above the walls they cap, so their eaves never flicker against them;
      // `ground` parts stand on the terrain where they are (umbrellas down a sloping beach)
      const y = (p.ground ? terrainAt(state, wx, wz) : baseY) + (p.y || 0) + (p.pool === 'roof' || p.pool === 'hip' ? 0.006 : 0);
      // a turned part (a gable end to the street) is the same box a quarter turn round
      const sx = (p.turn ? p.d : p.w) * scale, sz = (p.turn ? p.w : p.d) * scale;
      boxMatrix(wx, y - (p.y ? 0 : 0.3), wz, sx, p.h + (p.y ? 0 : 0.3), sz, ry + (p.turn ? Math.PI / 2 : 0), m); // sink 0.3 so slopes don't show gaps
      cb(p, m);
    }
  }

  bv.add = (b) => {
    const parts = withBase(b, partsFor(b));
    b.vis = [];
    b.baseColors = [];
    place(b, parts, (p, mx) => {
      const color = b.abandoned ? '#77736d' : p.color;
      b.vis.push({ pool: pools[p.pool], handle: pools[p.pool].add(mx, color) });
      b.baseColors.push(p.color);
    });
    b.height = Math.max(...parts.map((p) => (p.y || 0) + p.h));
    b.litValue = undefined;
    if (bv.colorFn) bv.recolor(b);
  };

  // ------------------------------------------------------------- placement ghost
  // While placing a building: see-through copy of the real model where it would go, and an
  // arrow on the ground showing which side faces the road (its entrance)
  const ghost = new THREE.Group();
  ghost.visible = false;
  scene.add(ghost);
  const ghostOk = new THREE.MeshBasicMaterial({ color: '#8fd3ff', transparent: true, opacity: 0.55, depthWrite: false });
  const ghostBad = new THREE.MeshBasicMaterial({ color: '#ff5a4f', transparent: true, opacity: 0.5, depthWrite: false });
  const arrowGeo = new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(-0.32, -0.18), new THREE.Vector2(0.32, -0.18), new THREE.Vector2(0.32, 0.12), new THREE.Vector2(0.55, 0.12), new THREE.Vector2(0, 0.62), new THREE.Vector2(-0.55, 0.12), new THREE.Vector2(-0.32, 0.12)])).rotateX(-Math.PI / 2);
  const arrowMat = new THREE.MeshBasicMaterial({ color: '#ffd300', transparent: true, opacity: 0.95, depthTest: false });
  const arrow = new THREE.Mesh(arrowGeo, arrowMat);
  arrow.renderOrder = 13;
  scene.add(arrow);
  arrow.visible = false;
  let ghostKey = '';
  bv.showGhost = (def, [x0, y0, x1, y1], rot, ok, baseY, turned = null) => {
    const alongX = rot === 1 || rot === 3;
    const b = { kind: def.kind || 'service', def, type: def.id, x0, y0, x1, y1, rot, w: alongX ? x1 - x0 + 1 : y1 - y0 + 1, d: alongX ? y1 - y0 + 1 : x1 - x0 + 1, seed: 7, level: 1, baseY, households: [], stored: 0, ...(turned || {}) };
    const key = `${def.id}|${x0},${y0},${x1},${y1}|${rot}|${ok}|${baseY.toFixed(2)}|${turned ? `${turned.cx.toFixed(2)},${turned.cz.toFixed(2)},${turned.ang.toFixed(3)}` : ''}`;
    if (key !== ghostKey) {
      ghostKey = key;
      for (const c of [...ghost.children]) ghost.remove(c);
      place(b, withBase(b, partsFor(b)), (p, mx) => {
        const mesh = new THREE.Mesh(pools[p.pool].geometry, ok ? ghostOk : ghostBad);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(mx);
        mesh.renderOrder = 11;
        ghost.add(mesh);
      });
      // the arrow sits just outside the front edge, pointing at the road
      const [fx, fy] = turned ? [Math.sin(turned.ang), Math.cos(turned.ang)] : DIRS[rot];
      const cx = turned ? turned.cx + fx * (turned.d / 2 + 0.05) : (x0 + x1 + 1) / 2 + fx * ((x1 - x0 + 1) / 2 + 0.05);
      const cz = turned ? turned.cz + fy * (turned.d / 2 + 0.05) : (y0 + y1 + 1) / 2 + fy * ((y1 - y0 + 1) / 2 + 0.05);
      arrow.position.set(cx, baseY + 0.12, cz);
      arrow.rotation.set(0, Math.atan2(-fx, -fy), 0);
      arrowMat.color.set(ok ? '#ffd300' : '#ff5a4f');
    }
    ghost.visible = true;
    arrow.visible = true;
  };
  bv.hideGhost = () => { ghost.visible = false; arrow.visible = false; ghostKey = ''; };

  bv.remove = (b) => {
    if (!b.vis) return;
    for (const v of b.vis) v.pool.remove(v.handle);
    b.vis = null;
  };

  bv.refresh = (b) => { bv.remove(b); bv.add(b); };

  const tmp = new THREE.Color();
  bv.recolor = (b) => {
    if (!b.vis) return;
    const override = bv.colorFn ? bv.colorFn(b) : null;
    b.vis.forEach((v, k) => {
      let c = override || b.baseColors[k];
      if (!override && b.abandoned) c = '#77736d';
      if (!override && b.onFire) c = '#e2572b';
      v.pool.setColor(v.handle, tmp.set(c));
    });
  };

  bv.recolorAll = () => { for (const b of state.buildings.values()) bv.recolor(b); };
  bv.setColorFn = (fn) => { bv.colorFn = fn; bv.recolorAll(); };
  bv.rebuildAll = () => {
    for (const p of Object.values(pools)) p.clear();
    for (const b of state.buildings.values()) { b.vis = null; bv.add(b); }
  };
  // Lights out: a building short of power has dark windows at night. When a network only
  // gets part of the power it needs, a matching share of its buildings goes dark.
  const litFor = (b) => {
    if (!(b.powerUse > 0) || b.power >= 0.995) return 1;
    if (b.power <= 0.05) return 0;
    return ((b.id * 2654435761) >>> 0) / 4294967296 < b.power ? 1 : 0;
  };
  bv.refreshLights = () => {
    for (const b of state.buildings.values()) {
      const v = b.abandoned ? 0 : litFor(b);
      if (b.litValue === v || !b.vis) continue;
      b.litValue = v;
      for (const h of b.vis) h.pool.setLit(h.handle, v);
    }
  };
  // Rubble where a building was destroyed, until it's rebuilt
  let rubble = [];
  bv.syncRubble = () => {
    for (const h of rubble) h.pool.remove(h.handle);
    rubble = [];
    for (const r of state.rebuilds || []) {
      const rr = makeRng(r.x0 * 7919 + r.y0 * 31 + 3);
      // (on the cells it stood on: its rectangle, or the cells under it, turned to its road)
      const cells = r.cells || [];
      if (!r.cells) for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) cells.push(y * N + x);
      for (const i of cells) {
        const x = i % N, y = (i / N) | 0;
        const g = cellHeight(state, x, y);
        for (let k = 0; k < 3; k++) {
          const s = rr.range(0.18, 0.5);
          boxMatrix(x + rr.range(0.2, 0.8), g - 0.05, y + rr.range(0.2, 0.8), s, rr.range(0.08, 0.32), s * rr.range(0.6, 1.2), rr.range(0, 3), m);
          rubble.push({ pool: pools.plain, handle: pools.plain.add(m, rr.pick(['#8d877c', '#77736d', '#a39c90', '#5e5a54'])) });
        }
      }
    }
  };
  bus.on('rebuilds:changed', () => bv.syncRubble());
  bv.syncRubble();

  bv.setVisible = (v) => { for (const p of Object.values(pools)) p.visible = v; };
  bv.update = () => { night.value = view.nightFactor; };

  return bv;
}
