// Touch screens: marks the page (body.touch) when a finger is used, and while a tool is in
// hand shows a button that does what Esc or a right click does with a mouse (stop the road
// being drawn, or put the tool away), and one that hides the HUD (the top strip, the side
// rail, windows, notices and map layers) so more of the map shows while you build. The
// gestures themselves are in world/camera.js and the way tools wait for a second finger in
// ui/tools.js.
import { bus } from '../core/events.js';

export function initTouch(app) {
  const body = document.body;
  if (window.matchMedia?.('(hover: none) and (pointer: coarse)').matches) body.classList.add('touch');
  window.addEventListener('pointerdown', (e) => body.classList.toggle('touch', e.pointerType === 'touch'), true);

  const row = document.createElement('div');
  row.id = 'touch-btns';
  document.getElementById('ui').appendChild(row);
  // Hiding the HUD only lasts while a tool is in hand; the choice is kept for the next tool
  const hudBtn = document.createElement('button');
  hudBtn.id = 'touch-hud';
  const btn = document.createElement('button');
  btn.id = 'touch-cancel';
  row.append(hudBtn, btn);
  let hudOff = false;
  const sync = () => {
    const building = app.tools.current.kind !== 'select';
    btn.classList.toggle('open', building);
    btn.innerHTML = '<b>✕</b>Cancel';
    hudBtn.classList.toggle('open', building);
    hudBtn.innerHTML = hudOff ? '<b>▣</b>Show HUD' : '<b>▢</b>Hide HUD';
    body.classList.toggle('hud-off', building && hudOff);
  };
  btn.onclick = () => { app.tools.cancel(false); sync(); };
  hudBtn.onclick = () => { hudOff = !hudOff; sync(); };
  bus.on('tool:changed', sync);
  sync();
}
