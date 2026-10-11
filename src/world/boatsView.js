// Water taxis you can see: little boats shuttling along each route between two piers
// (routes and their paths over the water come from sim/projects.js).
import * as THREE from 'three';
import { N } from '../core/grid.js';
import { bus } from '../core/events.js';

const CAP = 64;
const SPEED = 1.6; // cells per second at 1×

export function createBoatsView(view, state) {
  const mk = (geo, color) => {
    const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.5 }), CAP);
    m.count = 0; m.frustumCulled = false; m.castShadow = true;
    view.scene.add(m);
    return m;
  };
  const hull = mk(new THREE.BoxGeometry(0.5, 0.12, 0.22).translate(0, 0.06, 0), '#f2f2f2');
  const cabin = mk(new THREE.BoxGeometry(0.2, 0.12, 0.16).translate(-0.04, 0.18, 0), '#2f7fb3');
  let boats = [];
  bus.on('watertaxi:routes', (routes) => {
    boats = [];
    for (const r of routes) {
      const n = Math.min(3, 1 + Math.floor(r.path.length / 45));
      for (let k = 0; k < n && boats.length < CAP; k++) boats.push({ path: r.path, t: (k / n) * (r.path.length - 1), dir: k % 2 ? -1 : 1, wait: 0 });
    }
  });
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
  const at = (path, t) => { const i = path[Math.max(0, Math.min(path.length - 1, Math.round(t)))]; return [(i % N) + 0.5, ((i / N) | 0) + 0.5]; };
  return {
    update(dt) {
      const mul = state.time.paused ? 0 : [0, 1, 2.5, 4][state.time.speed] || 1;
      let n = 0;
      for (const b of boats) {
        const L = b.path.length - 1;
        if (L < 1) continue;
        if (b.wait > 0) b.wait -= dt * mul;
        else {
          b.t += b.dir * SPEED * dt * mul;
          if (b.t >= L) { b.t = L; b.dir = -1; b.wait = 1.5; }
          if (b.t <= 0) { b.t = 0; b.dir = 1; b.wait = 1.5; }
        }
        // between two cells of the path, eased along
        const t0 = Math.floor(b.t), f = b.t - t0;
        const [ax, az] = at(b.path, t0), [bx, bz] = at(b.path, t0 + 1);
        const x = ax + (bx - ax) * f, z = az + (bz - az) * f;
        const [lx, lz] = at(b.path, b.t + b.dir * 2);
        q.setFromAxisAngle(up, Math.atan2(-(lz - z), lx - x));
        p.set(x, state.seaLevel - 0.06, z);
        m.compose(p, q, s);
        hull.setMatrixAt(n, m);
        cabin.setMatrixAt(n, m);
        n++;
      }
      hull.count = cabin.count = n;
      hull.instanceMatrix.needsUpdate = cabin.instanceMatrix.needsUpdate = true;
    },
  };
}
