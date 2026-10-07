// City-builder camera. It orbits a focus point that sits on the ground:
//  - wheel / trackpad pinch zooms toward the cursor (the spot under the cursor stays put),
//    and the view tilts a little toward a comfortable angle for that height as you zoom
//  - right drag rotates and tilts; a right click without dragging cancels the current tool
//  - middle drag, or left drag while no tool is active, grabs the ground and pans it, with
//    a little glide when you let go
//  - WASD / arrows pan, Q / E rotate, Z / X zoom, T / G tilt (Shift = faster)
//  - double click flies to that spot; Home flies back to the town centre
// Every move eases toward its goal, the focus stays on the map, and the camera never
// dips into a hillside.
import * as THREE from 'three';
import { N, clamp } from '../core/grid.js';
import { pickGround, heightAt } from './picking.js';

export const MIN_DIST = 5;
export const MAX_DIST = N * 1.9;
const MIN_PITCH = 0.16, MAX_PITCH = 1.48;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// The tilt that feels right at each height: low and cinematic up close, steeper from high up
const autoPitch = (d) => 0.42 + 0.66 * smoothstep(12, 340, d);

export function createCameraRig(view, canvas) {
  const cam = view.camera;
  const goal = { x: N / 2, z: N / 2, dist: 120, yaw: 0.65, pitch: 0.9 };
  const cur = { ...goal, y: 4 };
  const target = new THREE.Vector3(N / 2, 4, N / 2);
  const glide = { x: 0, z: 0 };
  const keys = view.keys;
  const rig = {
    target, goal,
    settings: { tiltWithZoom: true, edgeScroll: false },
    leftPans: () => false,       // set by the game: may a left drag pan right now?
    onRightClick: null,          // set by the game: cancel the active tool
    onDoubleClick: null,
    justPanned: false,           // the last left button press was a pan, not a click
    state: null,
  };
  let drag = null;
  const mouse = { x: -1, y: -1, inside: false };

  const ground = (x, z) => {
    const s = rig.state;
    if (!s) return 4;
    return Math.max(heightAt(s, x, z), s.seaLevel - 0.05);
  };
  // Where the cursor ray meets a level plane at height h (for grabbing the ground)
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(), hit = new THREE.Vector3();
  function onPlane(clientX, clientY, h) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    plane.set(new THREE.Vector3(0, 1, 0), -h);
    return ray.ray.intersectPlane(plane, hit) ? { x: hit.x, z: hit.z } : null;
  }
  function pick(clientX, clientY) {
    return rig.state ? pickGround(view, rig.state, clientX, clientY) : null;
  }

  function place() {
    const cp = Math.cos(cur.pitch);
    let px = cur.x + cur.dist * cp * Math.sin(cur.yaw);
    let pz = cur.z + cur.dist * cp * Math.cos(cur.yaw);
    let py = cur.y + cur.dist * Math.sin(cur.pitch);
    // never inside a hill: lift the camera above the ground under it (and a bit around it)
    const floor = Math.max(ground(px, pz), ground(px * 0.8 + cur.x * 0.2, pz * 0.8 + cur.z * 0.2)) + 1.2;
    if (py < floor) py = floor;
    cam.position.set(px, py, pz);
    target.set(cur.x, cur.y, cur.z);
    cam.lookAt(target);
    // The near clipping plane moves out as you zoom out (never past half the camera's height
    // above the ground): depth precision follows it, so road paint and kerbs a hair above the
    // asphalt and the ground don't flicker through each other from far away.
    const near = clamp(Math.min(cur.dist * 0.025, (py - ground(px, pz)) * 0.5), 0.3, 12);
    if (Math.abs(near - cam.near) > 0.02 * cam.near) { cam.near = near; cam.updateProjectionMatrix(); }
  }

  // ------------------------------------------------------------------ zoom
  function zoomBy(factor, clientX, clientY) {
    const d0 = goal.dist;
    const d1 = clamp(d0 * factor, MIN_DIST, MAX_DIST);
    if (d1 === d0) return;
    const p = clientX != null ? pick(clientX, clientY) : null;
    if (p) {
      // keep the spot under the cursor where it is
      const k = d1 / d0;
      goal.x = p.x + (goal.x - p.x) * k;
      goal.z = p.z + (goal.z - p.z) * k;
    }
    goal.dist = d1;
    if (rig.settings.tiltWithZoom) goal.pitch += (autoPitch(d1) - goal.pitch) * 0.22;
    clampGoal();
  }
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 32;
    else if (e.deltaMode === 2) dy *= 400;
    // pinch gestures arrive as ctrl+wheel with small deltas
    const speed = e.ctrlKey ? 0.012 : 0.0016;
    zoomBy(Math.exp(clamp(dy, -250, 250) * speed), e.clientX, e.clientY);
  }, { passive: false });

  // ------------------------------------------------------------------ dragging
  canvas.addEventListener('pointerdown', (e) => {
    if (drag) return;
    const pan = e.button === 1 || (e.button === 0 && rig.leftPans(e));
    const rotate = e.button === 2;
    if (!pan && !rotate) return;
    if (e.button === 1) e.preventDefault();
    const h = cur.y;
    drag = { mode: rotate ? 'rotate' : 'pan', button: e.button, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, h,
      grab: onPlane(e.clientX, e.clientY, h), t: performance.now(), trail: [] };
    glide.x = glide.z = 0;
    if (e.button === 0) rig.justPanned = false;
    canvas.setPointerCapture?.(e.pointerId);
  });
  window.addEventListener('pointermove', (e) => {
    mouse.x = e.clientX; mouse.y = e.clientY;
    mouse.inside = e.target === canvas;
    if (!drag) return;
    const dx = e.clientX - drag.lx, dy = e.clientY - drag.ly;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 5) drag.moved = true;
    drag.lx = e.clientX; drag.ly = e.clientY;
    if (!drag.moved) return;
    if (drag.mode === 'rotate') {
      goal.yaw -= dx * 0.0065;
      goal.pitch = clamp(goal.pitch + dy * 0.0045, MIN_PITCH, MAX_PITCH);
      return;
    }
    // grab: move the focus so the grabbed spot follows the cursor (no easing while held)
    const now = onPlane(e.clientX, e.clientY, drag.h);
    if (!drag.grab || !now) return;
    const mx = drag.grab.x - now.x, mz = drag.grab.z - now.z;
    goal.x += mx; goal.z += mz; cur.x += mx; cur.z += mz;
    clampGoal(); cur.x = goal.x; cur.z = goal.z;
    place();
    // remember the last ~120 ms of movement for the glide
    const t = performance.now();
    drag.t = t;
    drag.trail.push([t, goal.x, goal.z]);
    while (drag.trail.length > 2 && t - drag.trail[0][0] > 120) drag.trail.shift();
  });
  window.addEventListener('pointerup', (e) => {
    if (!drag || e.button !== drag.button) return;
    const d = drag;
    drag = null;
    if (d.mode === 'pan') {
      if (d.button === 0) rig.justPanned = d.moved;
      // let go while still moving: keep gliding for a moment (a flick)
      const tr = d.trail, now = performance.now();
      if (d.moved && tr.length >= 3 && now - d.t < 60) {
        const [t0, x0, z0] = tr[0], [t1, x1, z1] = tr[tr.length - 1];
        const span = Math.max(0.03, (t1 - t0) / 1000), cap = cur.dist * 2.2;
        let vx = (x1 - x0) / span, vz = (z1 - z0) / span;
        const v = Math.hypot(vx, vz);
        if (v > cap) { vx *= cap / v; vz *= cap / v; }
        glide.x = vx; glide.z = vz;
      }
    }
    if (d.mode === 'rotate' && !d.moved) rig.onRightClick?.(e);
  });
  canvas.addEventListener('dblclick', (e) => {
    if (e.button !== 0) return;
    const p = pick(e.clientX, e.clientY);
    if (!p || !rig.onDoubleClick?.(p)) return;
    rig.flyTo(p.x, p.z, { dist: Math.min(goal.dist, 70) });
  });
  window.addEventListener('blur', () => { drag = null; });

  function clampGoal() {
    goal.x = clamp(goal.x, 0, N);
    goal.z = clamp(goal.z, 0, N);
    goal.dist = clamp(goal.dist, MIN_DIST, MAX_DIST);
    goal.pitch = clamp(goal.pitch, MIN_PITCH, MAX_PITCH);
  }

  // ------------------------------------------------------------------ API
  rig.flyTo = (x, z, { dist, yaw, pitch } = {}) => {
    goal.x = x; goal.z = z;
    if (dist != null) goal.dist = dist;
    if (yaw != null) goal.yaw = cur.yaw + Math.atan2(Math.sin(yaw - cur.yaw), Math.cos(yaw - cur.yaw));
    if (pitch != null) goal.pitch = pitch;
    glide.x = glide.z = 0;
    clampGoal();
  };
  rig.setView = ({ x, z, dist, yaw, pitch }, instant = true) => {
    rig.flyTo(x ?? goal.x, z ?? goal.z, { dist, yaw, pitch });
    if (instant) { Object.assign(cur, goal); cur.y = ground(cur.x, cur.z); place(); }
  };
  // Point the camera from a position at a target (like lookAt), e.g. for scripted views
  rig.lookFrom = (from, at) => {
    const dx = from.x - at.x, dz = from.z - at.z, dy = from.y - at.y;
    const flat = Math.hypot(dx, dz);
    rig.setView({ x: at.x, z: at.z, dist: Math.hypot(flat, dy), yaw: Math.atan2(dx, dz), pitch: Math.atan2(dy, flat) });
  };
  rig.home = () => rig.flyTo(N / 2, N / 2, { dist: 120, pitch: 0.9 });
  rig.distance = () => cur.dist;

  rig.update = (dt) => {
    // keyboard
    const fast = keys.has('shift') ? 2.6 : 1;
    const fwd = [-Math.sin(cur.yaw), -Math.cos(cur.yaw)], right = [Math.cos(cur.yaw), -Math.sin(cur.yaw)];
    let mx = 0, mz = 0;
    if (keys.has('w') || keys.has('arrowup')) { mx += fwd[0]; mz += fwd[1]; }
    if (keys.has('s') || keys.has('arrowdown')) { mx -= fwd[0]; mz -= fwd[1]; }
    if (keys.has('d') || keys.has('arrowright')) { mx += right[0]; mz += right[1]; }
    if (keys.has('a') || keys.has('arrowleft')) { mx -= right[0]; mz -= right[1]; }
    // edge scrolling (optional): the cursor near the window edge pans that way
    if (rig.settings.edgeScroll && mouse.inside && !drag) {
      const m = 14, w = window.innerWidth, h = window.innerHeight;
      if (mouse.x < m) { mx -= right[0]; mz -= right[1]; }
      if (mouse.x > w - m) { mx += right[0]; mz += right[1]; }
      if (mouse.y < m) { mx += fwd[0]; mz += fwd[1]; }
      if (mouse.y > h - m) { mx -= fwd[0]; mz -= fwd[1]; }
    }
    if (mx || mz) {
      const len = Math.hypot(mx, mz), sp = goal.dist * 1.15 * dt * fast;
      goal.x += (mx / len) * sp; goal.z += (mz / len) * sp;
      glide.x = glide.z = 0;
    }
    const rot = (keys.has('q') ? 1 : 0) - (keys.has('e') ? 1 : 0);
    if (rot) goal.yaw += rot * dt * 1.7 * (keys.has('shift') ? 1.8 : 1);
    const zoom = (keys.has('x') || keys.has('-') ? 1 : 0) - (keys.has('z') || keys.has('=') || keys.has('+') ? 1 : 0);
    if (zoom) zoomBy(Math.exp(zoom * dt * 1.6 * fast));
    const tilt = (keys.has('t') ? 1 : 0) - (keys.has('g') ? 1 : 0);
    if (tilt) goal.pitch += tilt * dt * 0.9;
    // glide after a flick
    if (glide.x || glide.z) {
      goal.x += glide.x * dt; goal.z += glide.z * dt;
      const k = Math.exp(-dt * 5.5);
      glide.x *= k; glide.z *= k;
      if (Math.hypot(glide.x, glide.z) < 0.3) glide.x = glide.z = 0;
    }
    clampGoal();
    // ease toward the goal
    const k = 1 - Math.exp(-dt * 11);
    const panning = drag && drag.mode === 'pan';
    if (!panning) { cur.x += (goal.x - cur.x) * k; cur.z += (goal.z - cur.z) * k; }
    cur.dist += (goal.dist - cur.dist) * k;
    cur.yaw += (goal.yaw - cur.yaw) * k;
    cur.pitch += (goal.pitch - cur.pitch) * k;
    // the focus rides on the ground (smoothed, so hills don't make it jump)
    cur.y += (ground(cur.x, cur.z) - cur.y) * (1 - Math.exp(-dt * 6));
    place();
  };

  place();
  return rig;
}
