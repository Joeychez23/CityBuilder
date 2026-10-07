// Hover tips for the interface: any element with a data-tip attribute (HTML) shows a small
// card explaining it after a short pause, placed beside the element and kept on screen.
// Used by the toolbar, the build menus, the HUD, the panel rail, the map strip and the tool
// options, so hovering anything tells you what it does.
const DELAY = 280;

export function initHoverTips() {
  const tip = document.createElement('div');
  tip.id = 'uitip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let target = null, timer = 0;

  const hide = () => { clearTimeout(timer); target = null; tip.classList.remove('show'); };
  function show(el) {
    const html = el.dataset.tip;
    if (!html || !document.body.contains(el)) return;
    tip.innerHTML = html;
    tip.classList.add('show');
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    // prefer above (for the toolbar and menus), then below, then beside
    let x = r.left + r.width / 2 - w / 2, y = r.top - h - 8;
    if (y < 6) y = r.bottom + 8;
    if (el.closest('#left-rail')) { x = r.right + 8; y = r.top + r.height / 2 - h / 2; }
    x = Math.max(6, Math.min(vw - w - 6, x));
    y = Math.max(6, Math.min(vh - h - 6, y));
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el === target) return;
    hide();
    if (!el) return;
    target = el;
    timer = setTimeout(() => { if (target === el) show(el); }, DELAY);
  });
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('wheel', hide, { passive: true });
  window.addEventListener('blur', hide);
  // the element may be re-rendered under the mouse: hide if it's gone
  setInterval(() => { if (target && !document.body.contains(target)) hide(); }, 400);
}

// Helper for building tip HTML: a title, a description and optional rows of [label, value]
export function tipHtml(title, desc, rows = [], foot = '') {
  return `<b>${title}</b>${desc ? `<p>${desc}</p>` : ''}${rows.length ? `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : ''}${foot ? `<em>${foot}</em>` : ''}`;
}
