// Weather and disaster effects: rain streaks, snowflakes, flames on burning buildings and
// forests, lightning flashes and the tornado funnel. All follow the camera's focus.
import * as THREE from 'three';
import { N, idx } from '../core/grid.js';
import { cellHeight } from '../sim/mapgen.js';
import { bus } from '../core/events.js';

const DROPS = 3500;

export function createFx(view, state, ctx) {
  // --- precipitation: one LineSegments for rain, one Points cloud for snow
  const rainGeo = new THREE.BufferGeometry();
  const rainPos = new Float32Array(DROPS * 6);
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: '#a9c4e0', transparent: true, opacity: 0.5 }));
  rain.frustumCulled = false;
  view.scene.add(rain);
  const snowGeo = new THREE.BufferGeometry();
  const snowPos = new Float32Array(DROPS * 3);
  snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
  const snow = new THREE.Points(snowGeo, new THREE.PointsMaterial({ color: '#ffffff', size: 0.18, transparent: true, opacity: 0.9 }));
  snow.frustumCulled = false;
  view.scene.add(snow);
  const seeds = new Float32Array(DROPS * 3).map(() => Math.random());

  // --- flames
  const flameGeo = new THREE.ConeGeometry(0.35, 1, 6).translate(0, 0.5, 0);
  const flames = new THREE.InstancedMesh(flameGeo, new THREE.MeshBasicMaterial({ color: '#ff7a2a', transparent: true, opacity: 0.85 }), 800);
  flames.count = 0;
  flames.frustumCulled = false;
  view.scene.add(flames);
  const fireLight = new THREE.PointLight('#ff8a3a', 0, 30, 1.5);
  view.scene.add(fireLight);

  // --- tornado funnel
  const funnel = new THREE.Mesh(
    new THREE.CylinderGeometry(3, 0.4, 22, 18, 6, true).translate(0, 11, 0),
    new THREE.MeshStandardMaterial({ color: '#7d7a72', transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
  );
  funnel.visible = false;
  view.scene.add(funnel);

  let flash = 0;
  bus.on('lightning', () => { flash = 0.25; });

  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  let t = 0;

  return {
    update(dt, weatherOn = true) {
      t += dt;
      const w = state.weather;
      rain.visible = snow.visible = weatherOn;
      const target = view.controls.target;
      const R = 70;
      // rain
      const nr = Math.floor(DROPS * Math.min(1, w.rain));
      for (let k = 0; k < DROPS; k++) {
        const o = k * 6;
        if (k >= nr) { rainPos[o + 1] = rainPos[o + 4] = -100; continue; }
        const x = target.x + (seeds[k * 3] - 0.5) * R * 2;
        const z = target.z + (seeds[k * 3 + 1] - 0.5) * R * 2;
        const y = 40 - ((seeds[k * 3 + 2] * 40 + t * 30) % 40);
        const wx = (ctx.windDir?.[0] || 0) * w.wind * 0.6, wz = (ctx.windDir?.[1] || 0) * w.wind * 0.6;
        rainPos[o] = x; rainPos[o + 1] = y; rainPos[o + 2] = z;
        rainPos[o + 3] = x + wx; rainPos[o + 4] = y + 1.2; rainPos[o + 5] = z + wz;
      }
      rainGeo.attributes.position.needsUpdate = true;
      // snow
      const ns = Math.floor(DROPS * Math.min(1, w.snow));
      for (let k = 0; k < DROPS; k++) {
        const o = k * 3;
        if (k >= ns) { snowPos[o + 1] = -100; continue; }
        snowPos[o] = target.x + (seeds[o] - 0.5) * R * 2 + Math.sin(t + k) * 0.6;
        snowPos[o + 1] = 40 - ((seeds[o + 2] * 40 + t * 3) % 40);
        snowPos[o + 2] = target.z + (seeds[o + 1] - 0.5) * R * 2 + Math.cos(t * 0.7 + k) * 0.6;
      }
      snowGeo.attributes.position.needsUpdate = true;

      // flames on burning buildings and forest cells
      let n = 0;
      let fx = 0, fz = 0;
      const flick = () => 0.75 + Math.sin(t * 14 + n) * 0.25;
      for (const b of state.buildings.values()) {
        if (!b.onFire || n > 780) continue;
        const cx = (b.x0 + b.x1 + 1) / 2, cz = (b.y0 + b.y1 + 1) / 2;
        for (let k = 0; k < 3; k++) {
          p.set(cx + Math.sin(k * 2.1) * 0.4, b.baseY + (b.height || 1) * 0.6, cz + Math.cos(k * 2.1) * 0.4);
          s.set(1, 1.2 * flick(), 1);
          flames.setMatrixAt(n++, m.compose(p, q, s));
        }
        fx = cx; fz = cz;
      }
      if (ctx.burning) {
        for (const i of ctx.burning) {
          if (n > 790) break;
          const x = i % N, y = (i / N) | 0;
          p.set(x + 0.5, cellHeight(state, x, y), y + 0.5);
          s.set(1.2, 1.4 * flick(), 1.2);
          flames.setMatrixAt(n++, m.compose(p, q, s));
          fx = x; fz = y;
        }
      }
      flames.count = n;
      flames.instanceMatrix.needsUpdate = true;
      fireLight.intensity = n ? 30 + Math.sin(t * 20) * 8 : 0;
      if (n) fireLight.position.set(fx, cellHeight(state, Math.min(N - 1, Math.floor(fx)), Math.min(N - 1, Math.floor(fz))) + 3, fz);

      // tornado
      const tor = ctx.tornado;
      funnel.visible = !!tor;
      if (tor) {
        const x = Math.max(0, Math.min(N - 1, Math.floor(tor.x))), y = Math.max(0, Math.min(N - 1, Math.floor(tor.y)));
        funnel.position.set(tor.x, cellHeight(state, x, y), tor.y);
        funnel.rotation.y += dt * 8;
        funnel.scale.set(1 + Math.sin(t * 3) * 0.1, 1, 1 + Math.cos(t * 3) * 0.1);
      }

      // lightning flash brightens the scene briefly
      if (flash > 0) {
        flash -= dt;
        view.hemi.intensity += 2.5 * Math.max(0, flash) * 4;
      }
    },
    idx,
  };
}
