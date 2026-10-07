// Problem icons floating above buildings (needs power, water, garbage pickup, parking,
// landfill full, fire...). Up to three per building, side by side, most urgent first. One
// Points object with an emoji atlas; each point picks its icon with an atlas index and its
// place in the row with a slot. The icons bob gently and always face the camera.
import * as THREE from 'three';
import { ISSUE_ICONS } from '../sim/problems.js';

const KEYS = Object.keys(ISSUE_ICONS);
const CELL = 64, COLS = 4;
const CAP = 4500;
const PER_BUILDING = 3;
// Issues worth a red badge vs. an amber one
const SEVERE = new Set(['fire', 'power', 'water', 'full', 'abandoned', 'noroad']);

function atlas() {
  const rows = Math.ceil(KEYS.length / COLS);
  const c = document.createElement('canvas');
  c.width = CELL * COLS; c.height = CELL * rows;
  const g = c.getContext('2d');
  g.textAlign = 'center'; g.textBaseline = 'middle';
  KEYS.forEach((k, n) => {
    const x = (n % COLS) * CELL + CELL / 2, y = Math.floor(n / COLS) * CELL + CELL / 2;
    // square signage plate with a coloured border, like the UI tabs
    g.fillStyle = SEVERE.has(k) ? '#ff4b3a' : '#ffd300';
    g.fillRect(x - 30, y - 30, 60, 60);
    g.fillStyle = '#f5f5f0';
    g.fillRect(x - 25, y - 25, 50, 50);
    g.font = '36px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
    g.fillStyle = '#1b1c1e';
    g.fillText(ISSUE_ICONS[k], x, y + 2);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, rows };
}

export function createIconsView(view, state) {
  const { tex, rows } = atlas();
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(CAP * 3);
  const icon = new Float32Array(CAP);
  const phase = new Float32Array(CAP);
  const slot = new Float32Array(CAP * 2); // place in the row, and how many in the row
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aIcon', new THREE.BufferAttribute(icon, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geo.setAttribute('aSlot', new THREE.BufferAttribute(slot, 2));
  geo.setDrawRange(0, 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: tex }, uTime: { value: 0 }, uScale: { value: 1 }, uDpr: { value: 1 }, uCols: { value: COLS }, uRows: { value: rows }, uView: { value: new THREE.Vector2(1, 1) } },
    transparent: true, depthTest: false, depthWrite: false,
    vertexShader: `
      attribute float aIcon; attribute float aPhase; attribute vec2 aSlot;
      uniform float uTime; uniform float uScale; uniform float uDpr; uniform vec2 uView;
      varying float vIcon;
      void main() {
        vIcon = aIcon;
        vec3 p = position + vec3(0.0, sin(uTime * 2.4 + aPhase) * 0.15, 0.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float size = clamp(uScale * 520.0 / -mv.z, 22.0, 46.0) * uDpr;
        gl_PointSize = size;
        // several icons on one building sit side by side on screen
        float dx = (aSlot.x - (aSlot.y - 1.0) * 0.5) * size * 1.06;
        gl_Position.x += dx / uView.x * 2.0 * gl_Position.w;
      }`,
    fragmentShader: `
      uniform sampler2D uTex; uniform float uCols; uniform float uRows;
      varying float vIcon;
      void main() {
        float col = mod(vIcon, uCols), row = floor(vIcon / uCols);
        vec2 uv = vec2((col + gl_PointCoord.x) / uCols, 1.0 - (row + gl_PointCoord.y) / uRows);
        vec4 c = texture2D(uTex, uv);
        if (c.a < 0.05) discard;
        gl_FragColor = c;
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 30;
  view.scene.add(points);

  const iv = { visible: true, dirty: true };
  iv.rebuild = () => {
    let n = 0;
    for (const b of state.buildings.values()) {
      const list = b.issues;
      if (!list?.length) continue;
      // the most urgent first (issues come sorted), up to three side by side
      const show = list.slice(0, PER_BUILDING);
      for (let s = 0; s < show.length; s++) {
        if (n >= CAP) break;
        pos[n * 3] = (b.x0 + b.x1 + 1) / 2;
        pos[n * 3 + 1] = (b.baseY ?? 0) + (b.height || 1) + 0.55;
        pos[n * 3 + 2] = (b.y0 + b.y1 + 1) / 2;
        icon[n] = KEYS.indexOf(show[s]);
        phase[n] = (b.id % 17) * 0.37;
        slot[n * 2] = s; slot[n * 2 + 1] = show.length;
        n++;
      }
    }
    geo.setDrawRange(0, n);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aIcon.needsUpdate = true;
    geo.attributes.aPhase.needsUpdate = true;
    geo.attributes.aSlot.needsUpdate = true;
    iv.dirty = false;
  };
  iv.update = (now) => {
    if (iv.dirty) iv.rebuild();
    mat.uniforms.uTime.value = now / 1000;
    mat.uniforms.uScale.value = window.innerHeight / 900;
    mat.uniforms.uDpr.value = view.renderer.getPixelRatio();
    view.renderer.getDrawingBufferSize(mat.uniforms.uView.value);
    points.visible = iv.visible;
  };
  return iv;
}
