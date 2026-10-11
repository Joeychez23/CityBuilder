// Terrain mesh (heightmap with vertex colours), the water surface, and ground overlay
// meshes that share the terrain's shape and show districts, info-view heatmaps and resources.
import * as THREE from 'three';
import { N, hidx, idx, clamp } from '../core/grid.js';

const C = (hex) => new THREE.Color(hex);
const PAL = {
  sand: C('#d8c99b'), mud: C('#8f8466'), grass: C('#6f9a4a'), grassDry: C('#a6a35f'), lush: C('#55893a'),
  rock: C('#857c70'), snow: C('#eef3f7'), polluted: C('#6b5a3a'), burnt: C('#3b3632'), fertile: C('#8fa64a'),
};

// The ground is drawn in square chunks of the map, so a change to the terrain (a road graded
// in, a canal dug) rebuilds only the chunks it touches, and chunks out of view aren't drawn.
const CH = 64;
const CN = Math.ceil(N / CH);

export function createTerrainView(view, state) {
  // one geometry per chunk, its corners from (x0, y0) to (x1, y1)
  const chunks = [];
  for (let cy = 0; cy < CN; cy++) {
    for (let cx = 0; cx < CN; cx++) {
      const x0 = cx * CH, y0 = cy * CH, x1 = Math.min(N, x0 + CH), y1 = Math.min(N, y0 + CH);
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      const pos = new Float32Array(w * h * 3), nrm = new Float32Array(w * h * 3);
      const col = new Float32Array(w * h * 3), uv = new Float32Array(w * h * 2);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = y * w + x;
          pos[v * 3] = x0 + x; pos[v * 3 + 2] = y0 + y;
          uv[v * 2] = (x0 + x) / N; uv[v * 2 + 1] = (y0 + y) / N;
        }
      }
      const index = new Uint16Array((w - 1) * (h - 1) * 6);
      let k = 0;
      for (let y = 0; y < h - 1; y++) {
        for (let x = 0; x < w - 1; x++) {
          const a = y * w + x, b = a + 1, c = a + w, d = c + 1;
          index[k++] = a; index[k++] = c; index[k++] = b; index[k++] = b; index[k++] = c; index[k++] = d;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setIndex(new THREE.BufferAttribute(index, 1));
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      chunks.push({ x0, y0, x1, y1, w, geo, pos, nrm, col });
    }
  }
  // a group of one mesh per chunk, all with this material
  const layer = (material, order = 0) => {
    const g = new THREE.Group();
    for (const c of chunks) { const m = new THREE.Mesh(c.geo, material); m.renderOrder = order; g.add(m); }
    view.scene.add(g);
    return g;
  };
  const terrain = layer(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
  for (const m of terrain.children) m.receiveShadow = true;

  // Ground overlay: one RGBA texel per cell, drawn just above the terrain.
  const overlayData = new Uint8Array(N * N * 4);
  const overlayTex = new THREE.DataTexture(overlayData, N, N, THREE.RGBAFormat);
  overlayTex.magFilter = THREE.NearestFilter;
  overlayTex.minFilter = THREE.NearestFilter;
  overlayTex.needsUpdate = true;
  const overlay = layer(new THREE.MeshLambertMaterial({
    map: overlayTex, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }), 1);

  // Smooth heatmap version for info views (linear filtering looks nicer for pollution etc.)
  const heatData = new Uint8Array(N * N * 4);
  const heatTex = new THREE.DataTexture(heatData, N, N, THREE.RGBAFormat);
  heatTex.magFilter = THREE.LinearFilter;
  heatTex.minFilter = THREE.LinearFilter;
  const heat = layer(new THREE.MeshBasicMaterial({
    map: heatTex, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  }), 2);
  heat.visible = false;

  // Natural resources overlay (the map layers toggle), drawn above everything else on the ground
  const resData = new Uint8Array(N * N * 4);
  const resTex = new THREE.DataTexture(resData, N, N, THREE.RGBAFormat);
  resTex.magFilter = THREE.NearestFilter;
  resTex.minFilter = THREE.NearestFilter;
  const res = layer(new THREE.MeshBasicMaterial({
    map: resTex, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  }), 3);
  res.visible = false;

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

  // The look the ground was last coloured with (season, snow, how dry), which chunks redrawn
  // after a terrain change keep
  const look = { snowCover: 0, season: 'summer', dry: 0.3, freeze: 0 };
  const P = Object.fromEntries(Object.entries(PAL).map(([k, c]) => [k, [c.r, c.g, c.b]]));
  // the chunks a box of corners (inclusive) touches, each with its part of the box
  const parts = (x0, y0, x1, y1) => chunks.filter((c) => c.x1 >= x0 && c.x0 <= x1 && c.y1 >= y0 && c.y0 <= y1)
    .map((c) => [c, Math.max(x0, c.x0), Math.max(y0, c.y0), Math.min(x1, c.x1), Math.min(y1, c.y1)]);
  // A box of cells (all of them if none) as a box of corners, grown by one: a corner's normal
  // and colour depend on the corners beside it
  const corners = (box) => (box ? [Math.max(0, box.x0 - 1), Math.max(0, box.y0 - 1), Math.min(N, box.x1 + 2), Math.min(N, box.y1 + 2)] : [0, 0, N, N]);

  // Heights, normals and colours of the ground in a box of cells { x0, y0, x1, y1 } (the
  // whole map if none), and the water's colour there
  tv.updateHeights = (box) => {
    water.position.y = state.seaLevel - 0.05; // (the sea can rise: sim/hazards.js)
    const H = state.height;
    const [x0, y0, x1, y1] = corners(box);
    for (const [c, ax, ay, bx, by] of parts(x0, y0, x1, y1)) {
      for (let y = ay; y <= by; y++) {
        const yu = Math.max(y - 1, 0), yd = Math.min(y + 1, N);
        for (let x = ax; x <= bx; x++) {
          const v = ((y - c.y0) * c.w + x - c.x0) * 3;
          const xl = Math.max(x - 1, 0), xr = Math.min(x + 1, N);
          c.pos[v + 1] = H[hidx(x, y)];
          // the normal, from how steep the ground is across the corner
          const sx = (H[hidx(xr, y)] - H[hidx(xl, y)]) / (xr - xl), sz = (H[hidx(x, yd)] - H[hidx(x, yu)]) / (yd - yu);
          const k = 1 / Math.sqrt(sx * sx + 1 + sz * sz);
          c.nrm[v] = -sx * k; c.nrm[v + 1] = k; c.nrm[v + 2] = -sz * k;
        }
      }
      c.geo.attributes.position.needsUpdate = true;
      c.geo.attributes.normal.needsUpdate = true;
      c.geo.computeBoundingSphere();
    }
    paint(x0, y0, x1, y1);
    tv.updateWaterColors(look.freeze, box);
  };

  // Ground colours in a box of corners: sand and mud by the water, grass by the season, rock
  // on steep slopes and high up, snow on the peaks (and everywhere in a snowy winter),
  // darkened where the ground is polluted or burnt
  function paint(x0, y0, x1, y1) {
    const H = state.height, sea = state.seaLevel;
    const { fertile, ground, burnt } = state;
    const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    let grass = mix(P.grass, P.grassDry, clamp(look.dry * 0.9 + (look.season === 'autumn' ? 0.25 : 0), 0, 1));
    if (look.season === 'spring') grass = mix(grass, P.lush, 0.4);
    const snowAll = look.snowCover * 0.9;
    const [mudR, mudG, mudB] = P.mud, [sandR, sandG, sandB] = P.sand, [fR, fG, fB] = P.fertile, [rR, rG, rB] = P.rock;
    const [sR, sG, sB] = P.snow, [pR, pG, pB] = P.polluted, [bR, bG, bB] = P.burnt;
    for (const [c, ax, ay, bx, by] of parts(x0, y0, x1, y1)) {
      const col = c.col;
      for (let y = ay; y <= by; y++) {
        for (let x = ax; x <= bx; x++) {
          const vi = hidx(x, y);
          const ci = idx(Math.min(x, N - 1), Math.min(y, N - 1));
          const h = H[vi] - sea;
          let r, g, b;
          if (h < -0.1) { const t = clamp(1 + h * 0.4, 0, 1); r = mudR + (sandR - mudR) * t; g = mudG + (sandG - mudG) * t; b = mudB + (sandB - mudB) * t; }
          else if (h < 0.45) { r = sandR; g = sandG; b = sandB; }
          else {
            [r, g, b] = grass;
            const f = fertile[ci];
            if (f > 0) { const t = f * 0.35; r += (fR - r) * t; g += (fG - g) * t; b += (fB - b) * t; }
            const slope = Math.abs(H[hidx(Math.min(x + 1, N), y)] - H[vi]) + Math.abs(H[hidx(x, Math.min(y + 1, N))] - H[vi]);
            const rock = clamp((slope - 0.7) * 1.2 + (h - 13) * 0.15, 0, 1);
            if (rock > 0) { r += (rR - r) * rock; g += (rG - g) * rock; b += (rB - b) * rock; }
            const snow = Math.max(clamp((h - 17) * 0.25, 0, 1), snowAll);
            if (snow > 0) { r += (sR - r) * snow; g += (sG - g) * snow; b += (sB - b) * snow; }
          }
          if (ground[ci] > 0.02) { const t = clamp(ground[ci], 0, 0.85); r += (pR - r) * t; g += (pG - g) * t; b += (pB - b) * t; }
          if (burnt[ci] > 0.02) { const t = clamp(burnt[ci], 0, 0.9); r += (bR - r) * t; g += (bG - g) * t; b += (bB - b) * t; }
          const v = ((y - c.y0) * c.w + x - c.x0) * 3;
          col[v] = r; col[v + 1] = g; col[v + 2] = b;
        }
      }
      c.geo.attributes.color.needsUpdate = true;
    }
  }

  // The whole ground's colours. snowCover: 0..1 from the climate system; season: 'spring' |
  // 'summer' | 'autumn' | 'winter'
  tv.updateColors = (snowCover = 0, season = 'summer', dry = 0.3) => {
    Object.assign(look, { snowCover, season, dry });
    paint(0, 0, N, N);
  };

  // Polluted water turns murky green, then sewage brown; even a little shows. (The colours
  // for each amount are worked out once for each amount of ice.)
  const clean = C('#2f7fb3'), murky = C('#56704a'), sewage = C('#5c4527'), icy = C('#c7dbe8');
  let lut = null, lutFreeze = -1;
  const waterLut = (freeze) => {
    if (lut && lutFreeze === freeze) return lut;
    lut = new Uint8Array(256 * 3);
    const c = new THREE.Color(), rgb = { r: 0, g: 0, b: 0 };
    for (let k = 0; k < 256; k++) {
      const t = k / 255;
      c.copy(clean).lerp(murky, clamp(t * 2, 0, 1)).lerp(sewage, clamp(t * 2 - 1, 0, 1)).lerp(icy, freeze * 0.5);
      c.getRGB(rgb, THREE.SRGBColorSpace);
      lut[k * 3] = rgb.r * 255; lut[k * 3 + 1] = rgb.g * 255; lut[k * 3 + 2] = rgb.b * 255;
    }
    lutFreeze = freeze;
    return lut;
  };
  // (in a box of cells, or everywhere)
  tv.updateWaterColors = (freeze = 0, box = null) => {
    look.freeze = freeze;
    const L = waterLut(freeze);
    const W = state.water, Pw = state.waterPoll;
    const x0 = box ? Math.max(0, box.x0 - 1) : 0, y0 = box ? Math.max(0, box.y0 - 1) : 0;
    const x1 = box ? Math.min(N - 1, box.x1 + 1) : N - 1, y1 = box ? Math.min(N - 1, box.y1 + 1) : N - 1;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = idx(x, y);
        let wp = 0;
        if (W[i]) wp = Pw[i];
        else {
          // land: take on the water around it, so the shoreline (where the texture blends
          // into this cell) stays the colour of the water rather than fading back to blue
          let s = 0, n = 0;
          for (let ny = Math.max(0, y - 1); ny <= Math.min(N - 1, y + 1); ny++) {
            for (let nx = Math.max(0, x - 1); nx <= Math.min(N - 1, x + 1); nx++) {
              const j = idx(nx, ny);
              if (W[j]) { s += Pw[j]; n++; }
            }
          }
          if (n) wp = s / n;
        }
        const k = Math.round(clamp(Math.sqrt(Math.max(0, wp)) * 1.3, 0, 1) * 255) * 3;
        wcol[i * 4] = L[k]; wcol[i * 4 + 1] = L[k + 1]; wcol[i * 4 + 2] = L[k + 2]; wcol[i * 4 + 3] = 255;
      }
    }
    waterTex.needsUpdate = true;
  };

  tv.updateHeights();
  return tv;
}
