// A growable pool of instances on one InstancedMesh: add() returns a handle, remove()
// swaps the last instance into the hole. One draw call no matter how many buildings.
import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _c = new THREE.Color();

export class InstancedPool {
  // lit: give every instance an `aLit` value (0..1) the material's shader can read, e.g. to
  // switch a building's windows off during a blackout
  constructor(scene, geometry, material, capacity = 1024, { shadows = true, lit = false } = {}) {
    this.scene = scene;
    this.geometry = lit ? geometry.clone() : geometry;
    this.material = material;
    this.capacity = capacity;
    this.count = 0;
    this.owners = [];          // slot -> handle object
    this.shadows = shadows;
    this.lit = lit;
    this.mesh = this.#makeMesh(capacity);
  }

  #makeMesh(capacity) {
    if (this.lit) {
      const old = this.litAttr;
      this.litAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1);
      this.litAttr.setUsage(THREE.DynamicDrawUsage);
      if (old) this.litAttr.array.set(old.array.subarray(0, Math.min(old.count, capacity)));
      this.geometry.setAttribute('aLit', this.litAttr);
    }
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    mesh.count = this.count;
    mesh.castShadow = this.shadows;
    mesh.receiveShadow = this.shadows;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, _c.set('#ffffff')); // allocates instanceColor
    this.scene.add(mesh);
    return mesh;
  }

  #grow() {
    const old = this.mesh;
    this.capacity *= 2;
    this.mesh = this.#makeMesh(this.capacity);
    for (let i = 0; i < this.count; i++) {
      old.getMatrixAt(i, _m);
      this.mesh.setMatrixAt(i, _m);
      old.getColorAt(i, _c);
      this.mesh.setColorAt(i, _c);
    }
    this.mesh.visible = old.visible;
    this.scene.remove(old);
    old.dispose();
  }

  add(matrix, color) {
    if (this.count >= this.capacity) this.#grow();
    const slot = this.count++;
    const handle = { slot };
    this.owners[slot] = handle;
    this.mesh.setMatrixAt(slot, matrix);
    this.mesh.setColorAt(slot, _c.set(color));
    if (this.lit) { this.litAttr.array[slot] = 1; this.litAttr.needsUpdate = true; }
    this.mesh.count = this.count;
    this.#dirty();
    return handle;
  }

  remove(handle) {
    if (!handle || handle.slot < 0) return;
    const last = this.count - 1;
    const slot = handle.slot;
    if (slot !== last) {
      this.mesh.getMatrixAt(last, _m);
      this.mesh.setMatrixAt(slot, _m);
      this.mesh.getColorAt(last, _c);
      this.mesh.setColorAt(slot, _c);
      if (this.lit) { this.litAttr.array[slot] = this.litAttr.array[last]; this.litAttr.needsUpdate = true; }
      const moved = this.owners[last];
      moved.slot = slot;
      this.owners[slot] = moved;
    }
    this.owners.length = last;
    handle.slot = -1;
    this.count = last;
    this.mesh.count = this.count;
    this.#dirty();
  }

  setColor(handle, color) {
    if (!handle || handle.slot < 0) return;
    this.mesh.setColorAt(handle.slot, typeof color === 'string' ? _c.set(color) : color);
    this.mesh.instanceColor.needsUpdate = true;
  }

  setLit(handle, v) {
    if (!this.lit || !handle || handle.slot < 0 || this.litAttr.array[handle.slot] === v) return;
    this.litAttr.array[handle.slot] = v;
    this.litAttr.needsUpdate = true;
  }

  setMatrix(handle, matrix) {
    if (!handle || handle.slot < 0) return;
    this.mesh.setMatrixAt(handle.slot, matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    for (const h of this.owners) if (h) h.slot = -1;
    this.owners.length = 0;
    this.count = 0;
    this.mesh.count = 0;
  }

  set visible(v) { this.mesh.visible = v; }

  #dirty() {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// Helper: matrix for a box of size (sx, sy, sz) whose bottom-centre is at (x, y, z), rotated by ry.
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
export function boxMatrix(x, y, z, sx, sy, sz, ry = 0, out = new THREE.Matrix4()) {
  _p.set(x, y, z);
  _q.setFromAxisAngle(_up, ry);
  _s.set(sx, sy, sz);
  return out.compose(_p, _q, _s);
}

// Unit geometries with their origin at the bottom centre, so scale.y = height.
export const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
export const unitRoof = (() => {
  // A gable roof: triangular prism along X, 1 wide, 1 deep, 1 tall
  const g = new THREE.BufferGeometry();
  const v = [
    -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 1, 0, -0.5, 1, 0, // back slope
    0.5, 0, 0.5, -0.5, 0, 0.5, -0.5, 1, 0, 0.5, 1, 0,   // front slope
    -0.5, 0, 0.5, -0.5, 0, -0.5, -0.5, 1, 0,           // left gable
    0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 1, 0,              // right gable
  ];
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setIndex([0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6, 8, 10, 9, 11, 13, 12]);
  g.computeVertexNormals();
  return g;
})();
