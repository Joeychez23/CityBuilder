// Renderer, camera (with the city-builder camera rig), lights and the day/night sky.
import * as THREE from 'three';
import { N, clamp } from '../core/grid.js';
import { createCameraRig } from './camera.js';

const DAY_SKY = new THREE.Color('#9fc7ea');
const DUSK_SKY = new THREE.Color('#e7a274');
const NIGHT_SKY = new THREE.Color('#1c2a47');
const STORM_SKY = new THREE.Color('#5d6670');

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = DAY_SKY.clone();
  scene.fog = new THREE.Fog(DAY_SKY.clone(), 160, 420);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.3, 3000);

  const hemi = new THREE.HemisphereLight('#cfe6ff', '#5a6b46', 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff4e0', 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera;
  sc.left = -100; sc.right = 100; sc.top = 100; sc.bottom = -100; sc.near = 1; sc.far = 600;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  sun.target.position.set(N / 2, 0, N / 2);

  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey) return;
    keys.add(e.key.toLowerCase());
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());

  const view = { renderer, scene, camera, sun, hemi, keys, nightFactor: 0 };
  const rig = createCameraRig(view, canvas);
  view.cam = rig;
  // Older code reads controls.target (the point the camera looks at)
  const controls = { target: rig.target, update() {} };
  view.controls = controls;

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // Camera movement (keys, easing, glide) happens in the rig
  view.updateKeys = (dt) => rig.update(dt);

  // Sun path, sky colour and light levels from the time of day (0..24) and the weather.
  view.updateSky = (hour, weather, season) => {
    const dayAngle = ((hour - 6) / 12) * Math.PI; // 0 at 6:00, π at 18:00
    const elev = Math.sin(dayAngle);              // >0 = sun above horizon
    const az = dayAngle + 0.6;
    const r = 220;
    // The shadow map covers what the camera looks at, more tightly when zoomed in. Its centre
    // snaps to whole shadow texels so shadows don't shimmer while the camera moves.
    const t = controls.target;
    const dist = camera.position.distanceTo(t);
    const half = clamp(dist * 0.95, 36, 260);
    const texel = (half * 2) / sun.shadow.mapSize.x;
    const fx = Math.round(t.x / texel) * texel, fz = Math.round(t.z / texel) * texel;
    if (Math.abs(sc.right - half) > half * 0.08) {
      sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
      sc.updateProjectionMatrix();
    }
    sun.target.position.set(fx, 0, fz);
    sun.position.set(fx + Math.cos(az) * r, Math.max(elev, 0.12) * r * 0.9 + 10, fz + Math.sin(az) * r * 0.6 - 40);

    const day = clamp(elev * 3, 0, 1);
    const dusk = clamp(1 - Math.abs(elev) * 4, 0, 1) * (elev > -0.25 ? 1 : 0);
    const gloom = clamp(weather.cloud * 0.6 + weather.storm * 0.4 + weather.rain * 0.3, 0, 0.85);
    view.nightFactor = 1 - day;

    const sky = NIGHT_SKY.clone().lerp(DAY_SKY, day).lerp(DUSK_SKY, dusk * 0.55).lerp(STORM_SKY, gloom * day * 0.8);
    if (season === 'winter') sky.lerp(new THREE.Color('#c9d4de'), 0.15 * day);
    scene.background.copy(sky);
    scene.fog.color.copy(sky);
    // Fog starts beyond what you're looking at, so zooming out never hides the city
    const thick = 1 - Math.min(0.85, weather.fog * 0.75 + weather.rain * 0.25);
    scene.fog.near = Math.max(20, (dist * 1.1 + 120) * thick);
    scene.fog.far = Math.max(140, (dist * 2.6 + 420) * thick);

    // At night the "sun" becomes a bright blue moonlight and the sky light stays strong, so
    // the city is easy to read and lit windows still stand out
    sun.intensity = (0.95 + day * 1.6) * (1 - gloom * 0.5);
    sun.color.set(day > 0.4 ? '#fff4e0' : elev > 0 ? '#ffc58a' : '#b4c4ff');
    hemi.intensity = 1.05 - gloom * 0.15;
    hemi.color.set(day > 0.2 ? '#cfe6ff' : '#9fb3ea');
    hemi.groundColor.set(day > 0.2 ? '#5a6b46' : '#465373');
    renderer.toneMappingExposure = 1.05 + (1 - day) * 0.15;
  };

  return view;
}
