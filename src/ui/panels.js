// Side panels (economy, progression, info views, the inspector...). Panels register themselves
// with an icon for the left rail; the open panel re-renders about once a second.
// The right side of the screen shows one window at a time: opening a panel closes the one
// that was open, and puts away a tool whose options window was showing there (and picking
// such a tool closes the panel, see tools.set).
import { bus } from '../core/events.js';
import { tipHtml } from './hovertips.js';

const PANEL_TIPS = {
  notices: 'Problems that need fixing (and where), and the news. The bell in the top bar counts open problems.',
  guide: 'Step-by-step goals for building your first town.',
  progression: 'Milestones (they unlock new buildings, money and expansion permits) and perks to spend development points on.',
  economy: 'The weekly budget, taxes, service budgets and fees, loans and trade.',
  stats: 'Population, jobs, health, crime, ages and education, with charts.',
  info: 'Colour the map to see one thing at a time: traffic, power, water, pollution, land value, coverage of each service...',
  transport: 'Traffic flow, parking and your transit lines: vehicles, tickets and when they run.',
  journal: 'The weather and climate, fire danger and everything that has happened.',
  districts: 'Districts you painted and their policies.',
  policies: 'City-wide policies and what they cost.',
  achievements: 'Goals you have reached and the ones still to go.',
  account: 'Sign in to keep your cities in the cloud.',
  settings: 'Save and load, graphics, camera settings and the main menu.',
};

const registry = [];
export function registerPanel(p) {
  // p: { key, icon, title, order, rail?: bool, render(app, body, panelState), wide? }
  registry.push(p);
  registry.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}

export function createPanels(app) {
  const root = document.getElementById('panels');
  const rail = document.getElementById('left-rail');
  const open = new Map(); // key -> { el, body, st }

  function renderRail() {
    rail.innerHTML = '';
    for (const p of registry) {
      if (p.rail === false) continue;
      const b = document.createElement('button');
      b.innerHTML = p.icon;
      b.dataset.tip = tipHtml(p.title, p.desc || PANEL_TIPS[p.key] || '', [], open.has(p.key) ? 'Click to close' : 'Click to open');
      if (open.has(p.key)) b.classList.add('on');
      if (p.badge?.(app)) b.insertAdjacentHTML('beforeend', '<span class="badge"></span>');
      b.onclick = () => panels.toggle(p.key);
      rail.appendChild(b);
    }
  }

  const panels = {
    open(key, args) {
      const p = registry.find((r) => r.key === key);
      if (!p) return;
      if (open.has(key)) {
        const o = open.get(key);
        if (args) { o.st.args = args; panels.refresh(key); }
        return;
      }
      // one window on the right at a time
      for (const k of [...open.keys()]) panels.close(k);
      if (app.tools?.hasOptions(app.tools.current.kind)) app.tools.set({ kind: 'select' });
      const el = document.createElement('div');
      el.className = 'panel crop';
      const no = String(registry.indexOf(p) + 1).padStart(2, '0');
      el.innerHTML = `<header><span class="p-num">${no}</span><h3>${p.title}</h3><span class="connector"></span><button title="Close">✕</button></header><div class="body"></div>`;
      el.querySelector('header button').onclick = () => panels.close(key);
      root.appendChild(el);
      const st = { args, tab: null };
      open.set(key, { el, body: el.querySelector('.body'), st, p });
      panels.refresh(key);
      p.onOpen?.(app, st);
      renderRail();
      bus.emit('panel:open', key);
    },
    close(key) {
      const o = open.get(key);
      if (!o) return;
      o.p.onClose?.(app, o.st);
      o.el.remove();
      open.delete(key);
      renderRail();
    },
    toggle(key, args) { if (open.has(key)) panels.close(key); else panels.open(key, args); },
    closeAll() { for (const k of [...open.keys()]) panels.close(k); },
    isOpen: (key) => open.has(key),
    refresh(key) {
      const o = open.get(key);
      if (!o) return;
      // Don't clobber a control the user is interacting with
      if (o.el.contains(document.activeElement) && document.activeElement.matches('input, select, textarea')) return;
      const scroll = o.body.scrollTop;
      o.p.render(app, o.body, o.st, () => panels.refresh(key));
      o.body.scrollTop = scroll;
    },
    refreshAll() { for (const k of open.keys()) if (!open.get(k).p.static) panels.refresh(k); },
    renderRail,
  };

  bus.on('escape', () => { for (const k of [...open.keys()]) if (open.get(k).p.closeOnEscape) panels.close(k); });
  renderRail();
  return panels;
}

// Small HTML helpers shared by panels
export const row = (k, v, cls = '') => `<div class="row"><span class="k">${k}</span><span class="num ${cls}">${v}</span></div>`;
export const meter = (frac, color = 'var(--accent)') => `<div class="meter"><i style="width:${Math.max(0, Math.min(1, frac)) * 100}%;background:${color}"></i></div>`;
export const pct = (v) => `${Math.round(v * 100)}%`;

export function tabs(body, st, list, rerender) {
  if (!st.tab) st.tab = list[0][0];
  const wrap = document.createElement('div');
  wrap.className = 'tabs';
  for (const [k, label] of list) {
    const b = document.createElement('button');
    b.textContent = label;
    if (st.tab === k) b.classList.add('on');
    b.onclick = () => { st.tab = k; rerender(); };
    wrap.appendChild(b);
  }
  body.appendChild(wrap);
  return st.tab;
}

// Tiny line chart on a canvas: series = [{ values, color, label }]
export function lineChart(canvas, series, { min = null, max = null } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 320, h = canvas.clientHeight || 120;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  const all = series.flatMap((s) => s.values);
  if (!all.length) return;
  const lo = min ?? Math.min(...all), hi = max ?? Math.max(...all, lo + 1);
  g.strokeStyle = 'rgba(255,255,255,0.07)';
  for (let k = 1; k < 4; k++) { g.beginPath(); g.moveTo(0, (h * k) / 4); g.lineTo(w, (h * k) / 4); g.stroke(); }
  for (const s of series) {
    g.strokeStyle = s.color; g.lineWidth = 2; g.beginPath();
    s.values.forEach((v, k) => {
      const x = (k / Math.max(1, s.values.length - 1)) * (w - 8) + 4;
      const y = h - 6 - ((v - lo) / (hi - lo || 1)) * (h - 12);
      if (k) g.lineTo(x, y); else g.moveTo(x, y);
    });
    g.stroke();
  }
  g.fillStyle = 'rgba(245,245,240,0.6)'; g.font = '10px "IBM Plex Mono", monospace';
  g.fillText(Math.round(hi).toLocaleString(), 4, 11);
  g.fillText(Math.round(lo).toLocaleString(), 4, h - 3);
}
