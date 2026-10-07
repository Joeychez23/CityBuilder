// The Undo button over the toolbar: the last change you can still take back, what it was and
// how long is left to take it back (a minute). Ctrl+Z (⌘Z on a Mac) does the same; pressing
// it again goes on back through the changes before it.
import { bus } from '../core/events.js';
import { money } from './tools.js';
import { tipHtml } from './hovertips.js';
import { UNDO_SECONDS } from '../sim/undo.js';

export function createUndoBar(app) {
  const el = document.createElement('div');
  el.id = 'undo';
  el.innerHTML = '<button><span class="undo-ico">↶</span><span class="undo-k">Undo</span><span class="undo-what"></span><span class="undo-more"></span><span class="undo-left"></span></button><i class="undo-bar"></i>';
  document.getElementById('ui').appendChild(el);
  const what = el.querySelector('.undo-what'), more = el.querySelector('.undo-more'), left = el.querySelector('.undo-left'), bar = el.querySelector('.undo-bar');
  const btn = el.querySelector('button');
  btn.dataset.tip = tipHtml('↶ Undo', `Take back the last thing you built or removed: everything it cost is paid back (and a refund you got for it is paid back too). Each change can be undone for ${UNDO_SECONDS} seconds; press again to go further back.`, [], 'Click, or Ctrl+Z (⌘Z)');

  function render() {
    const st = app.undo.top();
    el.classList.toggle('open', !!st);
    if (!st) return;
    what.textContent = st.label;
    const n = app.undo.count() - 1;
    more.textContent = n > 0 ? `+${n}` : '';
    more.style.display = n > 0 ? '' : 'none';
    const s = app.undo.secondsLeft(st);
    left.textContent = `${s}s`;
    bar.style.width = `${(s / UNDO_SECONDS) * 100}%`;
  }

  function undo() {
    const reason = app.undo.blocker();
    if (reason) {
      const none = reason === 'Nothing to undo';
      app.toast(none ? `Nothing to undo: what you build or remove can be taken back for ${UNDO_SECONDS} seconds.` : reason, none ? 'info' : 'bad', '↶ Undo');
      return;
    }
    const st = app.undo.undo();
    if (!st) return;
    // the tool starts over (a road being drawn on from where the undone one ended...)
    app.tools.set({ ...app.tools.current });
    const back = st.spent - st.refunded;
    app.toast(`${st.label}${back > 0 ? ` · <span class="good">+${money(back)}</span> back` : back < 0 ? ` · the ${money(-back)} refund was paid back` : ''}`, 'good', '↶ Undone');
    render();
  }

  btn.onclick = undo;
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  });
  bus.on('undo:changed', render);
  setInterval(render, 500);
  render();
  return { render, undo };
}
