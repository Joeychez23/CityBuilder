// The mayor's desk: requests and choices waiting for an answer (sim/decisions.js). A new one
// pops up as a toast; the 📨 on the left rail lights up while any are waiting.
import { registerPanel } from '../ui/panels.js';
import { registerSystem } from '../sim/simulation.js';
import { pendingDecisions, decide, expireDecisions } from '../sim/decisions.js';
import { bus } from '../core/events.js';
import { N } from '../core/grid.js';

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

registerPanel({
  key: 'desk', icon: '📨', title: "Mayor's Desk", order: 3,
  desc: 'Requests and decisions waiting for you: film shoots, strikes, petitions, offers...',
  badge: (app) => pendingDecisions(app.state).length > 0,
  render(app, body, st, rerender) {
    const s = app.state;
    const list = pendingDecisions(s);
    body.innerHTML = list.length ? '' : '<div class="muted">Nothing waiting for you. Requests and decisions turn up here as the city grows.</div>';
    for (const d of list) {
      const left = d.expires != null ? d.expires - s.time.day : null;
      const el = document.createElement('div');
      el.className = 'list-item desk-item';
      el.innerHTML = `<div class="row"><b>${d.icon || '📨'} ${esc(d.title)}</b>${left != null ? `<span class="muted num">${left <= 0 ? 'today' : `${left} day${left === 1 ? '' : 's'} left`}</span>` : ''}</div>
        <div class="muted" style="font-size:11.5px;margin:3px 0 6px">${esc(d.text)}</div>
        <div class="desk-options">${d.options.map((o, k) => `<button class="btn ${k === 0 ? 'primary' : ''}" data-k="${k}">${esc(o.label)}${o.detail ? `<span>${esc(o.detail)}</span>` : ''}</button>`).join('')}</div>
        ${d.cell != null || d.target != null ? '<button class="btn" data-go style="margin-top:4px">Show where</button>' : ''}`;
      el.querySelectorAll('[data-k]').forEach((btn) => (btn.onclick = () => {
        const r = decide(s, app.ctx, d.id, +btn.dataset.k);
        if (r?.msg) app.toast(esc(r.msg), r.kind || 'info', `${d.icon || '📨'} ${esc(d.title)}`);
        rerender();
        app.panels.renderRail();
      }));
      el.querySelector('[data-go]')?.addEventListener('click', () => {
        const b = d.target != null ? s.buildings.get(d.target) : null;
        if (b) app.focusOn((b.x0 + b.x1 + 1) / 2, (b.y0 + b.y1 + 1) / 2);
        else app.focusOn((d.cell % N) + 0.5, Math.floor(d.cell / N) + 0.5);
      });
      body.appendChild(el);
    }
  },
});

export const deskFeature = {
  init(app) {
    registerSystem({ name: 'decisions', every: 'day', run: expireDecisions });
    bus.on('decision:new', (d) => {
      app.toast(`${esc(d.text)}<div style="margin-top:6px"><button class="btn primary" data-open-panel="desk">Decide…</button></div>`, 'info', `${d.icon || '📨'} ${esc(d.title)}`);
      app.panels.renderRail();
      app.panels.refresh('desk');
    });
    bus.on('decision:done', () => app.panels.renderRail());
    // buttons in toasts and elsewhere that open a panel
    document.addEventListener('click', (e) => {
      const t = e.target.closest?.('[data-open-panel]');
      if (t) app.panels.open(t.dataset.openPanel);
    });
  },
};
