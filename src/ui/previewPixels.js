// A map seen from above, S × S pixels (RGBA): water, land shaded by height, forest, the
// pre-built roads, railway and power line
import { N, idx } from '../core/grid.js';
import { cellHeight } from '../sim/mapgen.js';

export function previewPixels(st, S) {
  const data = new Uint8ClampedArray(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const cx = Math.floor((x / S) * N), cy = Math.floor((y / S) * N);
      const i = idx(cx, cy);
      const h = cellHeight(st, cx, cy) - st.seaLevel;
      let r, gg, b;
      if (st.water[i]) { r = 40; gg = 110 + h * 10; b = 170 + h * 8; }
      else if (st.power[i]) { r = 255; gg = 211; b = 0; }
      else if (st.road[i] || st.rail[i]) { r = 60; gg = 60; b = 66; }
      else {
        const t = Math.min(1, h / 18);
        r = 100 + t * 130; gg = 150 + t * 80 + (st.tree[i] ? -30 : 0); b = 80 + t * 150;
        if (st.tree[i]) { r -= 40; b -= 20; }
      }
      const o = (y * S + x) * 4;
      data[o] = r; data[o + 1] = gg; data[o + 2] = b; data[o + 3] = 255;
    }
  }
  return data;
}
