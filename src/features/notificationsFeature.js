// Notification center. Two kinds of notices:
//  - problems: ongoing conditions from sim/problems.js (landfill full, power shortage...).
//    They stay in the list until fixed, and the buildings involved get a floating icon.
//  - events: one-off news sent with bus.emit('notify', ...) (fires, abandoned buildings...).
// New notices also pop up as toasts. The 🔔 in the top bar shows how many problems are open.
import { registerPanel, tabs } from '../ui/panels.js';
import { registerSystem, formatDate } from '../sim/simulation.js';
import { computeProblems } from '../sim/problems.js';
import { createIconsView } from '../world/iconsView.js';
import { bus } from '../core/events.js';
import { N } from '../core/grid.js';

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ORDER = { bad: 0, warn: 1, info: 2, good: 3 };

function stamp(state) {
  const m = state.time.minutes;
  return `${formatDate(state.time.day)} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
}

function focusTarget(app, n) {
  const s = app.state;
  const b = n.target != null ? s.buildings.get(n.target) : null;
  if (b) {
    app.focusOn((b.x0 + b.x1 + 1) / 2, (b.y0 + b.y1 + 1) / 2);
    bus.emit('select', { type: 'building', id: b.id });
  } else if (n.cell != null) {
    app.focusOn((n.cell % N) + 0.5, Math.floor(n.cell / N) + 0.5);
  }
}

registerPanel({
  key: 'notices', icon: '🔔', title: 'Notifications', order: 0,
  badge: (app) => app.notices?.active.size > 0,
  render(app, body, st, rerender) {
    const nc = app.notices;
    body.innerHTML = '';
    const tab = tabs(body, st, [['problems', `Problems (${nc.active.size})`], ['log', 'News']], rerender);
    const el = document.createElement('div');
    el.className = 'notice-list';
    body.appendChild(el);
    const list = tab === 'problems'
      ? [...nc.active.values()].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || b.since - a.since)
      : nc.log.slice().reverse();
    if (!list.length) {
      el.innerHTML = `<div class="muted">${tab === 'problems' ? 'Nothing needs your attention right now.' : 'No news yet.'}</div>`;
      return;
    }
    for (const n of list.slice(0, 80)) {
      const item = document.createElement('div');
      item.className = `notice ${n.kind}${n.resolved ? ' resolved' : ''}`;
      item.innerHTML = `<span class="notice-icon">${n.icon || 'ℹ️'}</span>
        <span class="notice-text"><b>${esc(n.title)}</b><span>${esc(n.msg)}</span><i>${n.resolved ? 'Fixed · ' : ''}${n.when}</i></span>
        ${n.target != null || n.cell != null ? '<button class="btn" data-go>Show</button>' : ''}`;
      item.querySelector('[data-go]')?.addEventListener('click', () => focusTarget(app, n));
      el.appendChild(item);
    }
  },
});

export const notificationsFeature = {
  init(app) {
    const { state, ctx } = app;
    const nc = { active: new Map(), log: [], seen: new Set() };
    app.notices = nc;
    app.icons = createIconsView(app.view, state);

    const log = (n) => {
      nc.log.push(n);
      if (nc.log.length > 120) nc.log.shift();
    };
    // One-off events
    bus.on('notify', ({ kind = 'info', title = '', msg = '', icon, target, cell, quiet }) => {
      const n = { kind, title, msg, icon: icon || { bad: '⛔', warn: '⚠️', good: '✅', info: 'ℹ️' }[kind], target, cell, when: stamp(state) };
      log(n);
      if (!quiet) app.toast(esc(msg), kind, `${n.icon} ${esc(title)}`);
      app.panels.refresh('notices');
    });

    const update = () => {
      const found = computeProblems(state, ctx);
      const keys = new Set();
      for (const p of found) {
        keys.add(p.key);
        const old = nc.active.get(p.key);
        if (old) { Object.assign(old, p); continue; }
        const n = { ...p, since: state.time.day * 1440 + state.time.minutes, when: stamp(state) };
        nc.active.set(p.key, n);
        log(n);
        // Toast new problems; a problem that keeps coming and going only toasts once a day
        const tag = `${p.key}@${state.time.day}`;
        if (!nc.seen.has(tag)) { nc.seen.add(tag); app.toast(esc(p.msg), p.kind, `${p.icon} ${esc(p.title)}`); }
      }
      for (const [k, n] of nc.active) {
        if (keys.has(k)) continue;
        nc.active.delete(k);
        log({ ...n, resolved: true, kind: 'good', when: stamp(state) });
      }
      if (nc.seen.size > 500) nc.seen.clear();
      app.icons.dirty = true;
      app.panels.refresh('notices');
      app.panels.renderRail();
    };
    nc.update = update;
    registerSystem({ name: 'problems', every: 'hour', run: update });
    // React quickly when the player fixes or breaks something
    let pending = false;
    const soon = () => { if (!pending) { pending = true; setTimeout(() => { pending = false; update(); }, 600); } };
    bus.on('building:add', soon);
    bus.on('building:remove', soon);
    bus.on('building:changed', soon);
    bus.on('network:recomputed', soon);
    setTimeout(update, 500);
  },
  frame(app, dt, now) { app.icons.update(now); },
};
