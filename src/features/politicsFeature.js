// City politics and society (sim/politics.js, sim/society.js): approval and elections,
// petitions and government contracts, booms and recessions, rents and strikes, and the
// City Hall panel that shows them all.
import { registerPanel, row, meter, tabs } from '../ui/panels.js';
import { registerSystem, formatDate } from '../sim/simulation.js';
import { politicsOf, approvalDaily, approvalFactors, electionsOn, promiseDef, promiseMet, petitionProgress, petitionText, contractLabel, contractNow, contractDone, TERM_DAYS } from '../sim/politics.js';
import { cycleOf, cycleDaily, rentsDaily, strikesDaily } from '../sim/society.js';
import { INFO_VIEWS } from './infoViews.js';
import { ramp } from '../world/overlays.js';
import { money } from '../ui/tools.js';
import { N } from '../core/grid.js';

const css = ([r, g, b]) => `rgb(${r | 0},${g | 0},${b | 0})`;

registerPanel({
  key: 'politics', icon: '🗳️', title: 'City Hall', order: 6,
  desc: 'Your approval and the next election, residents\' petitions, government contracts, the economy, rents and strikes.',
  badge: (app) => !!app.state.strike || (electionsOn(app.state) && (politicsOf(app.state).nextElection - app.state.time.day) <= 7),
  render(app, body, st, rerender) {
    const s = app.state, ctx = app.ctx, p = politicsOf(s);
    body.innerHTML = '';
    const tab = tabs(body, st, [['approval', 'Approval'], ['asks', `Petitions & contracts (${p.petitions.length + p.contracts.length})`], ['society', 'Economy & society']], rerender);
    const el = document.createElement('div');
    el.style.paddingTop = '8px';
    body.appendChild(el);
    if (tab === 'approval') {
      const a = Math.round(p.approval);
      const left = p.nextElection - s.time.day;
      let html = `<div class="section-title">Approval ${a}%</div>${meter(a / 100, a >= 55 ? 'var(--good)' : a >= 45 ? 'var(--yellow)' : 'var(--bad)')}
        <div class="muted" style="font-size:11px;margin:3px 0">${p.target != null ? `Heading for ${Math.round(p.target)}%. ` : ''}Approval follows how happy people are, jobs, the city's finances and taxes, and what you've done for them lately.</div>`;
      html += approvalFactors(s, ctx).sort((x, y) => x[1] - y[1]).map(([k, v]) => row(k, `${v > 0 ? '+' : ''}${Math.round(v)}`, v > 0 ? 'good' : 'bad')).join('');
      html += '<div class="section-title">Elections</div>';
      if (!electionsOn(s)) html += '<div class="muted">Elections are off for this city (Game panel).</div>';
      else {
        html += row('Next election', `${formatDate(p.nextElection)} · ${left <= 0 ? 'today' : `in ${left} day${left === 1 ? '' : 's'}`}`, left <= 7 ? 'warn' : '')
          + row('Term', `${p.term} (every ${TERM_DAYS} days)`);
        if (p.council) html += `<div class="warn" style="font-size:11px;margin:4px 0">The opposition runs the council until ${formatDate(p.council.until)}: taxes no higher than 12%, service budgets cut, no new loans.</div>`;
        if (p.promise) {
          const d = promiseDef(p.promise.key), now = d.measure(s), ok = promiseMet(s, p.promise);
          html += `<div class="list-item"><div class="row"><b>Your promise: ${d.label}</b>${ok ? '<span class="good">on track</span>' : '<span class="warn">not yet</span>'}</div><div class="muted" style="font-size:11px">${d.detail} · now ${Math.round(now * 10) / 10}${d.unit || ''}, needs ${d.below ? '≤' : '≥'} ${Math.round(p.promise.goal * 10) / 10}${d.unit || ''}</div></div>`;
        } else if (left <= 7) html += '<div class="muted" style="font-size:11px">The campaign is on: you can make a promise on the mayor\'s desk.</div>';
        html += '<div class="muted" style="font-size:11px;margin:4px 0">Win with more than half the vote: the region rewards you. Lose, and you stay on as mayor but the opposition runs the council (lower taxes and budgets, no loans) until the next election. A promise kept wins votes; a broken one costs more.</div>';
        if (p.history.length) html += '<div class="section-title">Past elections</div>' + p.history.slice().reverse().slice(0, 6).map((h) => row(formatDate(h.day), `${h.won ? '✅ won' : '❌ lost'} · ${h.share}%${h.promise ? ` · promise ${h.kept ? 'kept' : 'broken'}` : ''}`)).join('');
      }
      el.innerHTML = html;
    } else if (tab === 'asks') {
      let html = '<div class="section-title">Petitions you took on</div>';
      html += p.petitions.length ? p.petitions.map((pt, k) => `<div class="list-item"><div class="row"><b>${pt.street}: ${petitionText(pt)}</b><button class="btn" data-pt="${k}">Show</button></div>${meter(petitionProgress(s, ctx, pt), 'var(--blue)')}<div class="muted" style="font-size:11px">${Math.max(0, pt.due - s.time.day)} days left · reward ₡${pt.reward.toLocaleString()} and +3 approval</div></div>`).join('')
        : '<div class="muted">None right now. Residents send petitions to the mayor\'s desk from time to time.</div>';
      html += '<div class="section-title">Government contracts</div>';
      html += p.contracts.length ? p.contracts.map((c) => {
        const now = contractNow(s, c), done = contractDone(s, c);
        const frac = c.goal === c.start ? (done ? 1 : 0) : Math.max(0, Math.min(1, (now - c.start) / (c.goal - c.start)));
        return `<div class="list-item"><div class="row"><b>${contractLabel(c)}</b><span class="muted num">${Math.max(0, c.due - s.time.day)} days left</span></div>${meter(frac, 'var(--good)')}<div class="muted" style="font-size:11px">Now ${Math.round(now * 10) / 10} · reward: ${c.reward === 'permit' ? 'an expansion permit' : money(c.reward)}</div></div>`;
      }).join('') : '<div class="muted">None right now. The national government sends offers to the mayor\'s desk now and then.</div>';
      el.innerHTML = html;
      el.querySelectorAll('[data-pt]').forEach((b) => (b.onclick = () => { const pt = p.petitions[+b.dataset.pt]; app.focusOn((pt.cell % N) + 0.5, Math.floor(pt.cell / N) + 0.5); }));
    } else {
      const E = cycleOf(s);
      let html = '<div class="section-title">The economy</div>';
      html += row('Now', E.phase === 'boom' ? '📈 a boom' : E.phase === 'recession' ? '📉 a recession' : 'steady', E.phase === 'recession' ? 'bad' : E.phase === 'boom' ? 'good' : '')
        + row('Business', `${Math.round((E.index - 1) * 100) >= 0 ? '+' : ''}${Math.round((E.index - 1) * 100)}% on normal`);
      if (E.phase !== 'normal') html += row('Lasts until about', formatDate(E.day + E.length));
      if (E.response) html += row('Your answer', { taxes: 'taxes up 3%', cuts: 'services cut to 85%', stimulus: 'borrowing to keep demand up', wait: 'riding it out' }[E.response]);
      html += '<div class="muted" style="font-size:11px;margin:4px 0">Booms and recessions come and go in the wider economy. In a boom companies earn more and tourists spend more; in a recession you choose how the city answers.</div>';
      html += '<div class="section-title">Rents</div>';
      const homes = [...s.buildings.values()].filter((b) => b.kind === 'zone' && b.def.cat === 'res');
      const hot = homes.filter((b) => (b.rentIndex ?? 1) > 1.25).length;
      const avg = homes.length ? homes.reduce((a, b) => a + (b.rentIndex ?? 1), 0) / homes.length : 1;
      html += row('Average rent', `${Math.round(avg * 100)}% of the going rate`, avg > 1.2 ? 'warn' : '') + row('Homes with rents 25%+ over', hot, hot ? 'warn' : '')
        + row('Priced out yesterday', `${s.stats.pricedOutToday || 0} left town · ${s.stats.movedCheaperToday || 0} moved somewhere cheaper`)
        + '<div class="muted" style="font-size:11px;margin:4px 0">Rents rise where a neighbourhood is popular and full, and households that can no longer pay move somewhere cheaper, or out of town. Low-rent housing keeps its rents; the Rent Control district policy caps them (but buildings level up more slowly). Map → Rents shows where.</div>';
      html += '<div class="section-title">Unions</div>';
      if (s.strike) html += row(`${s.strike.name}`, `on strike for ${s.strike.days} day${s.strike.days === 1 ? '' : 's'} · want ${s.strike.demand}%`, 'bad');
      const deals = Object.entries(s.deals || {});
      html += deals.map(([cat, d]) => row(`Deal: ${cat}`, `budget at ${d.budget}% until ${formatDate(d.until)}`)).join('');
      if (!s.strike && !deals.length) html += '<div class="muted">No strikes. Workers walk out when their service is squeezed: a budget well under 100%, or too few colleagues to share the work.</div>';
      el.innerHTML = html;
    }
  },
});

// Map → Rents: homes coloured by how far their rent is above the going rate
INFO_VIEWS.push({
  key: 'rents', icon: '🏷️', name: 'Rents', legend: ['bad', 'Going rate', 'Very high'],
  building: (s) => (b) => (b.kind === 'zone' && b.def.cat === 'res' ? css(ramp('bad', Math.max(0, Math.min(1, ((b.rentIndex ?? 1) - 0.95) / 0.8)))) : '#8d9097'),
  stats: (s) => row('Priced out yesterday', (s.stats.pricedOutToday || 0) + (s.stats.movedCheaperToday || 0)) + '<div class="muted">Rents rise in popular, full neighbourhoods. Rent control (a district policy) and low-rent housing hold them down.</div>',
});

export const politicsFeature = {
  init(app) {
    const { state, ctx } = app;
    politicsOf(state);
    cycleOf(state);
    registerSystem({ name: 'economy-cycle', every: 'day', run: cycleDaily });
    registerSystem({ name: 'rents', every: 'day', run: rentsDaily });
    registerSystem({ name: 'strikes', every: 'day', run: strikesDaily });
    registerSystem({ name: 'approval', every: 'dayEnd', run: approvalDaily });
    ctx.economy = { phase: state.economyCycle.phase, index: state.economyCycle.index };
  },
};
