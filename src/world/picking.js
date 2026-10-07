// Screen position -> terrain point, by marching the camera ray over the heightmap.
// Much cheaper than raycasting the 40k-triangle terrain mesh on every mouse move.
import * as THREE from 'three';
import { N, HN, clamp } from '../core/grid.js';
import { terrainAt } from '../sim/mapgen.js';

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();

// (the same triangles the terrain mesh is drawn with, so picks land on what you see)
export const heightAt = (state, x, z) => terrainAt(state, clamp(x, 0, N - 0.001), clamp(z, 0, N - 0.001));

export function pickGround(view, state, clientX, clientY) {
  const rect = view.renderer.domElement.getBoundingClientRect();
  ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  ray.setFromCamera(ndc, view.camera);
  const o = ray.ray.origin, d = ray.ray.direction;
  if (d.y >= 0) return null;
  // Start where the ray crosses the highest possible terrain, then step forward.
  let t = Math.max(0, (42 - o.y) / d.y);
  const step = 0.25;
  let prevT = t;
  for (let k = 0; k < 4000; k++) {
    const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
    const ground = Math.max(heightAt(state, x, z), state.seaLevel - 0.05);
    if (y <= ground) {
      // refine between prevT and t
      let lo = prevT, hi = t;
      for (let r = 0; r < 8; r++) {
        const mid = (lo + hi) / 2;
        const mx = o.x + d.x * mid, mz = o.z + d.z * mid;
        if (o.y + d.y * mid <= Math.max(heightAt(state, mx, mz), state.seaLevel - 0.05)) hi = mid; else lo = mid;
      }
      const px = o.x + d.x * hi, pz = o.z + d.z * hi;
      if (px < 0 || pz < 0 || px >= N || pz >= N) return null;
      return { x: px, z: pz, y: o.y + d.y * hi, cx: Math.floor(px), cy: Math.floor(pz) };
    }
    prevT = t;
    t += step;
    if (y < -5) break;
  }
  return null;
}

// Raycast against building meshes would need per-instance lookups; instead buildings are
// picked by the cell under the cursor (state.bld), which is exact for a grid city.
export { HN };
