// Touch screens: marks the page (body.touch) when a finger is used, and while a tool is in
// hand shows a button that does what Esc or a right click does with a mouse (stop the road
// being drawn, or put the tool away). The gestures themselves are in world/camera.js and the
// way tools wait for a second finger in ui/tools.js.
import { bus } from '../core/events.js';

export function initTouch(app) {
  const body = document.body;
  if (window.matchMedia?.('(hover: none) and (pointer: coarse)').matches) body.classList.add('touch');
  window.addEventListener('pointerdown', (e) => body.classList.toggle('touch', e.pointerType === 'touch'), true);

  const btn = document.createElement('button');
  btn.id = 'touch-cancel';
  document.getElementById('ui').appendChild(btn);
  const sync = () => {
    const kind = app.tools.current.kind;
    btn.classList.toggle('open', kind !== 'select');
    btn.innerHTML = '<b>✕</b>Cancel';
  };
  btn.onclick = () => { app.tools.cancel(false); sync(); };
  bus.on('tool:changed', sync);
  sync();
}
