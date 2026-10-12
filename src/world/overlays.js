// Composes the per-cell ground overlay texture: zone paint, zonable grid while zoning,
// unowned map tiles, district tint, surfaces, and info-view heatmaps.
import * as THREE from 'three';
import { N, TILE, TILES, idx } from '../core/grid.js';
import { ZONES } from '../data/zones.js';

export const SURFACES = [null,
  { name: 'Concrete', color: '#b9b6ae' }, { name: 'Pavement', color: '#9d968a' }, { name: 'Grass', color: '#7fb35a' },
  { name: 'Sand', color: '#e2d3a3' }, { name: 'Tiles', color: '#c48a6a' }, { name: 'Gravel', color: '#8d8a83' }];
const surfRGB = SURFACES.map((s) => (s ? new THREE.Color(s.color).toArray().map((v) => v * 255) : null));

export function createOverlays(app) {
  const { state, terrain } = app;
  const ov = { zoneMode: false, districtMode: false, tileMode: false, heatFn: null, dirty: true, districtColors: {} };

  ov.setZoneMode = (on) => { ov.zoneMode = on; ov.dirty = true; app.zones?.setZoneMode(on); };
  ov.setDistrictMode = (on) => { ov.districtMode = on; ov.dirty = true; };
  ov.setTileMode = (on) => { ov.tileMode = on; ov.dirty = true; };

  ov.rebuild = () => {
    const d = terrain.overlayData;
    const dcol = {};
    for (const dist of state.districts) {
      const c = new THREE.Color(dist.color);
      dcol[dist.id] = [c.r * 255, c.g * 255, c.b * 255];
    }
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = idx(x, y);
        const o = i * 4;
        let r = 0, g = 0, b = 0, a = 0;
        const s = state.surface[i];
        if (s && surfRGB[s]) { [r, g, b] = surfRGB[s]; a = 230; }
        // (zone paint itself is drawn along the roads by world/zonesView.js)
        const z = state.zone[i];
        if (z && state.bld[i] && ZONES[z].cat === 'spec') {
          // fields / quarries around specialised industry
          const c = ZONES[z].key === 'spec_farm' ? [176, 160, 80] : ZONES[z].key === 'spec_forest' ? [96, 120, 60] : [120, 110, 100];
          [r, g, b] = c; a = 150;
        }
        if (ov.districtMode || ov.zoneMode === 'district') {
          const dc = dcol[state.district[i]];
          if (dc) { r = dc[0]; g = dc[1]; b = dc[2]; a = Math.max(a, 110); }
        } else if (state.district[i] && dcol[state.district[i]]) {
          // faint district border
          const dd = state.district[i];
          const edge = x === 0 || y === 0 || x === N - 1 || y === N - 1 ||
            state.district[i - 1] !== dd || state.district[i + 1] !== dd || state.district[i - N] !== dd || state.district[i + N] !== dd;
          if (edge) { [r, g, b] = dcol[dd]; a = 170; }
        }
        // Unowned map tiles are shaded; tile borders drawn faintly. (Not under the water, but
        // for buying tiles: the sea looks the same out past the map's edge, where nothing's
        // owned.)
        const t = ((y / TILE) | 0) * TILES + ((x / TILE) | 0);
        if (!state.tiles[t] && (ov.tileMode || !state.water[i])) {
          const k = ov.tileMode ? 0.55 : 0.32;
          r = r * (1 - k); g = g * (1 - k); b = b * (1 - k) + 10 * k; a = Math.max(a, 255 * k);
        }
        if ((ov.tileMode || ov.zoneMode) && (x % TILE === 0 || y % TILE === 0)) { r = 255; g = 255; b = 255; a = Math.max(a, 70); }
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
      }
    }
    terrain.overlayTex.needsUpdate = true;
    ov.dirty = false;
  };

  // Info-view heatmap: fn(i) -> [r, g, b, a] (0..255) or null
  ov.setHeat = (fn) => {
    ov.heatFn = fn;
    terrain.heat.visible = !!fn;
    if (fn) ov.updateHeat();
  };
  ov.updateHeat = () => {
    if (!ov.heatFn) return;
    const d = terrain.heatData;
    for (let i = 0; i < N * N; i++) {
      const c = ov.heatFn(i);
      const o = i * 4;
      if (c) { d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = c[3] ?? 170; }
      else d[o + 3] = 0;
    }
    terrain.heatTex.needsUpdate = true;
  };

  ov.update = () => { if (ov.dirty) ov.rebuild(); };
  return ov;
}

// Colour ramps for heatmaps: t in 0..1 -> [r, g, b]
export const RAMPS = {
  good: ['#ff4b3a', '#ffc548', '#4fd27a'],
  bad: ['#4fd27a', '#ffc548', '#ff4b3a'],
  heat: ['#2f6fdc', '#22c1c3', '#fde047', '#ef4444'],
  blue: ['#0b2545', '#3aa0ff', '#bfe6ff'],
  purple: ['#2b1055', '#7c3aed', '#f0abfc'],
  green: ['#203b1a', '#6bbf4a', '#d9f99d'],
};
const rampCache = {};
export function ramp(name, t) {
  const stops = rampCache[name] || (rampCache[name] = RAMPS[name].map((h) => new THREE.Color(h)));
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const k = Math.min(Math.floor(x), stops.length - 2);
  const f = x - k;
  const a = stops[k], b = stops[k + 1];
  return [(a.r + (b.r - a.r) * f) * 255, (a.g + (b.g - a.g) * f) * 255, (a.b + (b.b - a.b) * f) * 255];
}
export const rampCss = (name) => `linear-gradient(90deg, ${RAMPS[name].join(', ')})`;
