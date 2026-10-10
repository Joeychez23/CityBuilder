// Terrain mesh (heightmap with vertex colours), the water surface, and a ground overlay
// mesh that shares the terrain's shape and shows zones, districts and info-view heatmaps.
import * as THREE from 'three';
import { N, HN, hidx, idx, clamp } from '../core/grid.js';

const C = (hex) => new THREE.Color(hex);
const PAL = {
  sand: C('#d8c99b'), mud: C('#8f8466'), grass: C('#6f9a4a'), grassDry: C('#a6a35f'), lush: C('#55893a'),
  rock: C('#857c70'), snow: C('#eef3f7'), polluted: C('#6b5a3a'), burnt: C('#3b3632'), fertile: C('#8fa64a'),
};

export function createTerrainView(view, state) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(HN * HN * 3);
  const col = new Float32Array(HN * HN * 3);
  const uv = new Float32Array(HN * HN * 2);
  for (let y = 0; y < HN; y++) {
    for (let x = 0; x < HN; x++) {
      const i = hidx(x, y);
      pos[i * 3] = x;
      pos[i * 3 + 2] = y;
      uv[i * 2] = x / N;
      uv[i * 2 + 1] = y / N;
    }
  }
  const index = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const a = hidx(x, y), b = hidx(x + 1, y), c = hidx(x, y + 1), d = hidx(x + 1, y + 1);
      index.push(a, c, b, b, c, d);
    }
  }
  geo.setIndex(index);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

  const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
  terrain.receiveShadow = true;
  view.scene.add(terrain);

  // Ground overlay: one RGBA texel per cell, drawn just above the terrain.
  const overlayData = new Uint8Array(N * N * 4);
  const overlayTex = new THREE.DataTexture(overlayData, N, N, THREE.RGBAFormat);
  overlayTex.magFilter = THREE.NearestFilter;
  overlayTex.minFilter = THREE.NearestFilter;
  overlayTex.needsUpdate = true;
  const overlay = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
    map: overlayTex, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  overlay.renderOrder = 1;
  view.scene.add(overlay);

  // Smooth heatmap version for info views (linear filtering looks nicer for pollution etc.)
  const heatData = new Uint8Array(N * N * 4);
  const heatTex = new THREE.DataTexture(heatData, N, N, THREE.RGBAFormat);
  heatTex.magFilter = THREE.LinearFilter;
  heatTex.minFilter = THREE.LinearFilter;
  const heat = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    map: heatTex, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  }));
  heat.renderOrder = 2;
  heat.visible = false;
  view.scene.add(heat);

  // Natural resources overlay (the map layers toggle), drawn above everything else on the ground
  const resData = new Uint8Array(N * N * 4);
  const resTex = new THREE.DataTexture(resData, N, N, THREE.RGBAFormat);
  resTex.magFilter = THREE.NearestFilter;
  resTex.minFilter = THREE.NearestFilter;
  const res = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    map: resTex, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  }));
  res.renderOrder = 3;
  res.visible = false;
  view.scene.add(res);

  // Water: a flat sheet at sea level, tinted by water pollution through one texel per cell
  // (centred on the cell, so a polluted cell is polluted right up to the shore)
  const wgeo = new THREE.PlaneGeometry(N, N);
  wgeo.rotateX(-Math.PI / 2);
  wgeo.translate(N / 2, 0, N / 2);
  const wuv = wgeo.attributes.uv;
  for (let i = 0; i < wuv.count; i++) wuv.setXY(i, wgeo.attributes.position.getX(i) / N, wgeo.attributes.position.getZ(i) / N);
  const wcol = new Uint8Array(N * N * 4);
  const waterTex = new THREE.DataTexture(wcol, N, N, THREE.RGBAFormat);
  waterTex.colorSpace = THREE.SRGBColorSpace;
  waterTex.magFilter = THREE.LinearFilter;
  waterTex.minFilter = THREE.LinearFilter;
  const water = new THREE.Mesh(wgeo, new THREE.MeshStandardMaterial({
    map: waterTex, transparent: true, opacity: 0.82, roughness: 0.15, metalness: 0.1,
  }));
  water.position.y = state.seaLevel - 0.05;
  water.receiveShadow = true;
  view.scene.add(water);

  // The world outside the playable map: a muted plane so the map reads as a slab of land.
  const outside = new THREE.Mesh(
    new THREE.RingGeometry(N * 0.5, N * 6, 4, 1, Math.PI / 4),
    new THREE.MeshStandardMaterial({ color: '#56664a', roughness: 1 }),
  );
  outside.rotation.x = -Math.PI / 2;
  outside.position.set(N / 2, state.seaLevel - 2, N / 2);
  outside.scale.set(Math.SQRT2, Math.SQRT2, 1);
  view.scene.add(outside);

  const tv = { terrain, overlay, overlayData, overlayTex, heat, heatData, heatTex, res, resData, resTex, water };

  tv.updateHeights = () => {
    const H = state.height;
    for (let i = 0; i < HN * HN; i++) pos[i * 3 + 1] = H[i];
    geo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    tv.updateColors();
  };

  // snowCover: 0..1 from the climate system; season: 'spring' | 'summer' | 'autumn' | 'winter'
  tv.updateColors = (snowCover = 0, season = 'summer', dry = 0.3) => {
    const H = state.height;
    const sea = state.seaLevel;
    const c = new THREE.Color();
    for (let y = 0; y < HN; y++) {
      for (let x = 0; x < HN; x++) {
        const vi = hidx(x, y);
        const ci = idx(Math.min(x, N - 1), Math.min(y, N - 1));
        const h = H[vi] - sea;
        const slope = Math.abs(H[hidx(Math.min(x + 1, N), y)] - H[vi]) + Math.abs(H[hidx(x, Math.min(y + 1, N))] - H[vi]);
        if (h < -0.1) c.copy(PAL.mud).lerp(PAL.sand, clamp(1 + h * 0.4, 0, 1));
        else if (h < 0.45) c.copy(PAL.sand);
        else {
          c.copy(PAL.grass).lerp(PAL.grassDry, clamp(dry * 0.9 + (season === 'autumn' ? 0.25 : 0), 0, 1));
          if (season === 'spring') c.lerp(PAL.lush, 0.4);
          if (state.fertile[ci] > 0) c.lerp(PAL.fertile, state.fertile[ci] * 0.35);
          c.lerp(PAL.rock, clamp((slope - 0.7) * 1.2 + (h - 13) * 0.15, 0, 1));
          const peakSnow = clamp((h - 17) * 0.25, 0, 1);
          c.lerp(PAL.snow, Math.max(peakSnow, snowCover * 0.9));
        }
        if (state.ground[ci] > 0.02) c.lerp(PAL.polluted, clamp(state.ground[ci], 0, 0.85));
        if (state.burnt[ci] > 0.02) c.lerp(PAL.burnt, clamp(state.burnt[ci], 0, 0.9));
        col[vi * 3] = c.r; col[vi * 3 + 1] = c.g; col[vi * 3 + 2] = c.b;
      }
    }
    geo.attributes.color.needsUpdate = true;
    tv.updateWaterColors();
  };

  // Polluted water turns murky green, then sewage brown; even a little shows
  const clean = C('#2f7fb3'), murky = C('#56704a'), sewage = C('#5c4527'), icy = C('#c7dbe8');
  tv.updateWaterColors = (freeze = 0) => {
    const W = state.water, P = state.waterPoll;
    const c = new THREE.Color(), rgb = { r: 0, g: 0, b: 0 };
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = idx(x, y);
        let wp = 0;
        if (W[i]) wp = P[i];
        else {
          // land: take on the water around it, so the shoreline (where the texture blends
          // into this cell) stays the colour of the water rather than fading back to blue
          let s = 0, n = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
            const j = idx(nx, ny);
            if (W[j]) { s += P[j]; n++; }
          }
          if (n) wp = s / n;
        }
        const t = clamp(Math.sqrt(Math.max(0, wp)) * 1.3, 0, 1);
        c.copy(clean).lerp(murky, clamp(t * 2, 0, 1)).lerp(sewage, clamp(t * 2 - 1, 0, 1)).lerp(icy, freeze * 0.5);
        c.getRGB(rgb, THREE.SRGBColorSpace);
        wcol[i * 4] = rgb.r * 255; wcol[i * 4 + 1] = rgb.g * 255; wcol[i * 4 + 2] = rgb.b * 255; wcol[i * 4 + 3] = 255;
      }
    }
    waterTex.needsUpdate = true;
  };

  tv.updateHeights();
  return tv;
}
