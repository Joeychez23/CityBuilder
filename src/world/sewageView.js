// Sewage you can see. Each sewage outlet (and treatment plant) gets a pipe out to the water
// and a brown gush where it pours in, with dirty froth churning around it. Out in the water:
// a plume of brown murk drifts with the current and fades, and lumps of raw sewage bob on
// the surface, floating downstream through all the water the outlet's sewage reaches (its
// plume, see sim/utilities.js). Treatment plants pour out much less, and it's greyer. The
// water itself is also tinted by pollution (terrainView), so you can see where it ends up.
import * as THREE from 'three';
import { N, idx, inBounds } from '../core/grid.js';
import { cellHeight } from '../sim/mapgen.js';

const CAP = 2200;    // murk and froth particles
const LUMPS = 700;   // floating lumps

export function createSewageView(view, state, ctx = null) {
  const group = new THREE.Group();
  view.scene.add(group);
  const pipeMat = new THREE.MeshStandardMaterial({ color: '#4d4a44', roughness: 0.6, metalness: 0.3 });
  const gushMat = new THREE.MeshStandardMaterial({ color: '#6b4d22', roughness: 0.3, transparent: true, opacity: 0.9 });
  const pipeGeo = new THREE.CylinderGeometry(0.11, 0.11, 1, 8).rotateZ(Math.PI / 2);
  const gushGeo = new THREE.CylinderGeometry(0.09, 0.16, 1, 8);

  // Murk and froth particles: tint 0 = raw brown, 1 = treated grey, 2 = dirty froth
  const pos = new Float32Array(CAP * 3), life = new Float32Array(CAP), size = new Float32Array(CAP), tint = new Float32Array(CAP);
  const vel = new Float32Array(CAP * 2);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aLife', new THREE.BufferAttribute(life, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uDpr: { value: 1 }, uScale: { value: 1 } },
    vertexShader: `
      attribute float aLife; attribute float aSize; attribute float aTint;
      uniform float uDpr; uniform float uScale;
      varying float vLife; varying float vTint;
      void main() {
        vLife = aLife; vTint = aTint;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float grow = aTint > 1.5 ? 0.7 + (1.0 - aLife) * 0.6 : 0.6 + (1.0 - aLife) * 1.4;
        gl_PointSize = aLife > 0.0 ? aSize * grow * uScale * 300.0 / -mv.z * uDpr : 0.0;
      }`,
    fragmentShader: `
      varying float vLife; varying float vTint;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float r = length(c);
        if (r > 0.5) discard;
        vec3 brown = mix(vec3(0.33, 0.23, 0.09), vec3(0.45, 0.43, 0.38), clamp(vTint, 0.0, 1.0));
        vec3 col = vTint > 1.5 ? vec3(0.86, 0.82, 0.68) : brown;
        float a = vTint > 1.5 ? smoothstep(0.5, 0.3, r) * vLife * 0.75 : smoothstep(0.5, 0.15, r) * vLife * 0.85;
        gl_FragColor = vec4(col, a);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 4;
  view.scene.add(points);

  // Floating lumps: squashed low-poly blobs in sewage browns, bobbing as they drift
  const lumpGeo = new THREE.IcosahedronGeometry(0.5, 0).scale(1, 0.55, 1);
  const lumpMat = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0 });
  const lumps = new THREE.InstancedMesh(lumpGeo, lumpMat, LUMPS);
  lumps.count = 0;
  lumps.frustumCulled = false;
  lumps.setColorAt(0, new THREE.Color('#fff'));
  view.scene.add(lumps);
  const L = Array.from({ length: LUMPS }, () => ({ x: 0, z: 0, vx: 0, vz: 0, life: 0, max: 1, s: 0.2, ph: 0, c: 0 }));
  const LUMP_COLORS = ['#5b3f1c', '#6e4b20', '#4a3317', '#7a5a2c', '#3e2c16'];
  let lumpNext = 0;

  let sources = []; // { x, y (water point), rate, tint, plume: [cells near the outlet first] }
  let next = 0;
  const sv = { dirty: true };
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), e = new THREE.Euler();
  const col = new THREE.Color();

  sv.rebuild = () => {
    for (const c of [...group.children]) group.remove(c);
    sources = [];
    for (const b of state.buildings.values()) {
      if (!b.def.sewage || !b.discharge || b.cons) continue;
      const treated = b.def.id === 'treatment';
      const [wx, wy] = b.discharge;
      const sx = (b.x0 + b.x1 + 1) / 2, sy = (b.y0 + b.y1 + 1) / 2;
      // pipe from the building's edge to the water's edge
      const tx = wx + 0.5, ty = wy + 0.5;
      const dx = tx - sx, dy = ty - sy;
      const len = Math.hypot(dx, dy);
      const ground = Math.max(cellHeight(state, Math.floor(sx), Math.floor(sy)), state.seaLevel) + 0.12;
      const pipe = new THREE.Mesh(pipeGeo, pipeMat);
      pipe.scale.set(Math.max(0.3, len - 0.3), 1, 1);
      pipe.position.set(sx + dx * 0.5, ground, sy + dy * 0.5);
      pipe.rotation.y = Math.atan2(-dy, dx);
      group.add(pipe);
      const flowing = (b.load || 0) > 1;
      if (flowing) {
        const gush = new THREE.Mesh(gushGeo, treated ? new THREE.MeshStandardMaterial({ color: '#8d8a7e', transparent: true, opacity: 0.8 }) : gushMat);
        const top = ground, bottom = state.seaLevel - 0.05;
        gush.scale.set(1, Math.max(0.1, top - bottom), 1);
        gush.position.set(tx - dx / Math.max(len, 1) * 0.4, (top + bottom) / 2, ty - dy / Math.max(len, 1) * 0.4);
        group.add(gush);
        // the water this outlet's sewage reaches, nearest first (lumps mostly float near it)
        const plumeSet = ctx?.sewagePlumes?.get(b);
        const plume = plumeSet ? [...plumeSet].sort((i, j) => Math.hypot((i % N) - wx, ((i / N) | 0) - wy) - Math.hypot((j % N) - wx, ((j / N) | 0) - wy)) : [];
        sources.push({ x: tx, y: ty, rate: Math.min(40, 4 + (b.load || 0) / 250) * (treated ? 0.25 : 1), tint: treated ? 0.85 : 0, treated, plume, load: b.load || 0 });
      }
    }
    sv.dirty = false;
  };

  function spawnLump(src, fx, fy) {
    const k = lumpNext++ % LUMPS;
    const o = L[k];
    // most start at the outlet; some appear further down the plume (already on their way)
    let x = src.x, z = src.y;
    if (src.plume.length && Math.random() < 0.55) {
      const n = Math.floor(Math.pow(Math.random(), 1.6) * src.plume.length);
      const c = src.plume[n];
      x = (c % N) + Math.random(); z = ((c / N) | 0) + Math.random();
    } else { x += (Math.random() - 0.5) * 0.6; z += (Math.random() - 0.5) * 0.6; }
    o.x = x; o.z = z;
    o.vx = fx * (0.18 + Math.random() * 0.12) + (Math.random() - 0.5) * 0.08;
    o.vz = fy * (0.18 + Math.random() * 0.12) + (Math.random() - 0.5) * 0.08;
    o.max = o.life = 9 + Math.random() * 9;
    o.s = (src.treated ? 0.09 : 0.13) + Math.random() * 0.12;
    o.ph = Math.random() * Math.PI * 2;
    o.c = src.treated ? -1 : Math.floor(Math.random() * LUMP_COLORS.length);
  }

  let t = 0;
  sv.update = (dt) => {
    if (sv.dirty) sv.rebuild();
    const speed = state.time.paused ? 0 : [0, 1, 1.6, 2.4][state.time.speed] || 1;
    t += dt;
    mat.uniforms.uDpr.value = view.renderer.getPixelRatio();
    mat.uniforms.uScale.value = window.innerHeight / 900;
    const [fx, fy] = state.flow || [0, 1];
    const step = dt * speed;
    // spawn murk, froth and lumps
    for (const src of sources) {
      src.acc = (src.acc || 0) + src.rate * step;
      while (src.acc >= 1) {
        src.acc -= 1;
        const k = next++ % CAP;
        const froth = Math.random() < (src.treated ? 0.15 : 0.35);
        pos[k * 3] = src.x + (Math.random() - 0.5) * (froth ? 0.8 : 0.4);
        pos[k * 3 + 1] = state.seaLevel + (froth ? 0.04 : 0.02);
        pos[k * 3 + 2] = src.y + (Math.random() - 0.5) * (froth ? 0.8 : 0.4);
        const a = Math.random() * Math.PI * 2;
        // froth churns around the outlet; murk drifts away with the current
        vel[k * 2] = froth ? Math.cos(a) * 0.25 : fx * 0.35 + Math.cos(a) * 0.18;
        vel[k * 2 + 1] = froth ? Math.sin(a) * 0.25 : fy * 0.35 + Math.sin(a) * 0.18;
        life[k] = froth ? 0.55 : 1;
        size[k] = froth ? 0.18 + Math.random() * 0.2 : 0.35 + Math.random() * 0.35;
        tint[k] = froth ? 2 : src.tint;
      }
      src.lumpAcc = (src.lumpAcc || 0) + step * Math.min(6, 0.6 + src.load / 1800) * (src.treated ? 0.2 : 1);
      while (src.lumpAcc >= 1) { src.lumpAcc -= 1; spawnLump(src, fx, fy); }
    }
    // drift & fade
    for (let k = 0; k < CAP; k++) {
      if (life[k] <= 0) continue;
      life[k] -= step / (tint[k] > 1.5 ? 2.5 : 9);
      if (life[k] <= 0) { life[k] = 0; continue; }
      pos[k * 3] += vel[k * 2] * step;
      pos[k * 3 + 2] += vel[k * 2 + 1] * step;
      vel[k * 2] *= 1 - step * 0.15;
      vel[k * 2 + 1] *= 1 - step * 0.15;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aLife.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.attributes.aTint.needsUpdate = true;
    // lumps float on: they bob, spin slowly, and sink when they reach the shore or fade out
    let n = 0;
    for (let k = 0; k < LUMPS; k++) {
      const o = L[k];
      if (o.life <= 0) continue;
      o.life -= step;
      o.x += o.vx * step; o.z += o.vz * step;
      const cx = Math.floor(o.x), cz = Math.floor(o.z);
      if (!inBounds(cx, cz) || !state.water[idx(cx, cz)]) o.life = Math.min(o.life, 0.6); // beached: sinks away
      if (o.life <= 0) continue;
      const fade = Math.min(1, o.life / 1.2, (o.max - o.life) / 0.8 + 0.2);
      const sink = (1 - fade) * 0.12;
      p.set(o.x, state.seaLevel - 0.02 + Math.sin(t * 2.2 + o.ph) * 0.025 - sink, o.z);
      e.set(Math.sin(t * 1.3 + o.ph) * 0.25, o.ph + t * 0.15, Math.cos(t * 1.1 + o.ph) * 0.2);
      q.setFromEuler(e);
      s.set(o.s, o.s * fade, o.s);
      lumps.setMatrixAt(n, m.compose(p, q, s));
      lumps.setColorAt(n, col.set(o.c < 0 ? '#8a857a' : LUMP_COLORS[o.c]));
      n++;
    }
    lumps.count = n;
    lumps.instanceMatrix.needsUpdate = true;
    if (lumps.instanceColor) lumps.instanceColor.needsUpdate = true;
  };
  sv.setVisible = (v) => { group.visible = v; points.visible = v; lumps.visible = v; };
  return sv;
}
