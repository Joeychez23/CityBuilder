// Economy panel (budget, taxes, service budgets & fees, loans, trade), demand breakdown
// and city statistics.
import { registerPanel, row, meter, pct, tabs, lineChart } from '../ui/panels.js';
import { money } from '../ui/tools.js';
import { SERVICE_CATS } from '../data/services.js';
import { RESOURCES } from '../data/resources.js';
import { EDU_NAMES } from '../data/zones.js';
import { takeLoan, repayLoan, loanLimit, interestRate, projection, perWeek } from '../sim/economy.js';
import { WEEKDAYS, formatDate } from '../sim/simulation.js';
import { AGE } from '../sim/citizens.js';
import '../ui/inspector.js';
import { COUNCIL_TAX_CAP } from '../sim/politics.js';

const LABELS = {
  resTax: 'Residential tax', comTax: 'Commercial tax', indTax: 'Industrial tax', offTax: 'Office tax', fees: 'Service fees',
  transit: 'Public transport fares', exports: 'Utility exports', subsidy: 'Government subsidy', parking: 'Parking fees', tolls: 'Road tolls', hotels: 'Hotel rooms', conventions: 'Convention fees', casino: 'Gaming licences', film: 'Film studio fees', factories: 'City factories (sales)', grants: 'National government grant', themepark: 'Theme park tickets', promenade: 'Boardwalk kiosks', regional: 'Regional trade', refunds: 'Demolition refunds (paid at once)',
  services: 'Service upkeep', roads: 'Road upkeep', loanInterest: 'Loan interest', imports: 'Imported utilities & services', supplies: 'Factory supplies', projects: 'Grand projects (building)', policies: 'Policies', transitCost: 'Transit',
};

function slider(body, label, min, max, step, value, fmt, onChange) {
  const wrap = document.createElement('label');
  wrap.className = 'row';
  wrap.innerHTML = `<span class="k">${label}</span><span style="display:flex;gap:6px;align-items:center"><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" style="width:120px"><b class="num" style="width:48px;text-align:right">${fmt(value)}</b></span>`;
  const input = wrap.querySelector('input');
  input.oninput = () => { wrap.querySelector('b').textContent = fmt(+input.value); onChange(+input.value); };
  body.appendChild(wrap);
}

registerPanel({
  key: 'economy', icon: '💰', title: 'Economy', order: 10,
  render(app, body, st, rerender) {
    const s = app.state;
    body.innerHTML = '';
    const tab = tabs(body, st, [['budget', 'Budget'], ['taxes', 'Taxes'], ['services', 'Services'], ['loans', 'Loans'], ['trade', 'Trade']], rerender);
    const el = document.createElement('div');
    el.style.paddingTop = '8px';
    body.appendChild(el);
    const L = s.lastLedger, cur = s.ledger;
    if (tab === 'budget') {
      const P = projection(s);
      const sign = (v) => `${v >= 0 ? '+' : '−'}${money(Math.abs(v))}`;
      const left = P.daysLeft === 1 ? 'tonight (end of Saturday)' : `in ${P.daysLeft} days (end of Saturday)`;
      const lines = (side) => Object.keys(cur[side]).filter((k) => (cur[side][k] || P[side][k] || L[side][k])).map((k) =>
        `<div class="ledger-row"><span class="k">${LABELS[k] || k}</span><span class="num">${money(cur[side][k] || 0)}</span><span class="num proj">${money(P[side][k] || 0)}</span><span class="num muted">${money(L[side][k] || 0)}</span></div>`).join('');
      el.innerHTML = `${row('Balance now', money(s.money), s.money < 0 ? 'bad' : '')}
        ${row('This week, projected', sign(P.net), P.net >= 0 ? 'good' : 'bad')}
        ${row('Balance after Saturday', money(P.endMoney), P.endMoney < 0 ? 'bad' : '')}
        ${row('Last week', sign(s.stats.weeklyBalance || 0), (s.stats.weeklyBalance || 0) >= 0 ? 'good' : 'bad')}
        <div class="muted" style="font-size:11px;margin:4px 0">Taxes, fees and upkeep build up during the week and are paid ${left}. The projection is re-estimated every hour from how the city is doing right now.</div>
        <div class="ledger-row head"><span>Income</span><span>So far</span><span>Projected</span><span>Last week</span></div>${lines('income')}
        <div class="ledger-row total"><span>Total income</span><span class="num">${money(Object.entries(cur.income).reduce((a, [k, v]) => a + (k === 'refunds' ? 0 : v), 0))}</span><span class="num proj">${money(P.income.total)}</span><span class="num muted">${money(s.stats.weeklyIncome || 0)}</span></div>
        <div class="ledger-row head"><span>Expenses</span><span>So far</span><span>Projected</span><span>Last week</span></div>${lines('expense')}
        <div class="ledger-row total"><span>Total expenses</span><span class="num">${money(Object.values(cur.expense).reduce((a, v) => a + v, 0))}</span><span class="num proj">${money(P.expense.total)}</span><span class="num muted">${money(s.stats.weeklyExpense || 0)}</span></div>
        <div class="section-title">Money, week by week</div><canvas class="chart"></canvas>
        <div class="section-title">Weekly income vs expenses</div><canvas class="chart"></canvas>`;
      const [c1, c2] = el.querySelectorAll('canvas');
      const w = s.weekly.slice(-30);
      lineChart(c1, [{ values: w.map((x) => x.money), color: '#2f55ff' }]);
      lineChart(c2, [{ values: w.map((x) => x.income), color: '#5fd38a' }, { values: w.map((x) => x.expense), color: '#ff6b5a' }]);
    } else if (tab === 'taxes') {
      el.innerHTML = `<div class="muted">10% is neutral. Higher taxes earn more but lower demand and well-being; negative rates subsidise.</div>${s.politics?.council ? `<div class="warn" style="font-size:11px;margin-top:4px">The opposition council won't let taxes go above ${COUNCIL_TAX_CAP}% until the next election.</div>` : ''}<div class="section-title">By zone</div>`;
      for (const [k, name] of [['res', 'Residential'], ['com', 'Commercial'], ['ind', 'Industrial'], ['off', 'Office']]) {
        slider(el, name, -10, s.politics?.council ? COUNCIL_TAX_CAP : 30, 1, s.taxes[k], (v) => `${v}%`, (v) => { s.taxes[k] = v; });
      }
      el.insertAdjacentHTML('beforeend', '<div class="section-title">Residential adjustment by education</div>');
      EDU_NAMES.forEach((n, k) => slider(el, n, -5, 5, 1, s.taxes.resEdu[k], (v) => `${v > 0 ? '+' : ''}${v}%`, (v) => { s.taxes.resEdu[k] = v; }));
    } else if (tab === 'services') {
      el.innerHTML = '<div class="muted">Budget changes efficiency, coverage and upkeep (50–150%).</div><div class="section-title">Service budgets</div>';
      for (const [k, c] of Object.entries(SERVICE_CATS)) {
        slider(el, `${c.icon} ${c.name}`, 50, 150, 5, s.budgets[k] ?? 100, (v) => `${v}%`, (v) => { s.budgets[k] = v; app.ctx.servicesDirty = true; });
        el.insertAdjacentHTML('beforeend', `<div class="row" style="margin-top:-4px"><span class="k" style="font-size:11px">upkeep</span><span class="muted num" style="font-size:11px">${money(perWeek(s.stats.serviceCostByCat?.[k] || 0))}/wk</span></div>`);
      }
      el.insertAdjacentHTML('beforeend', '<div class="section-title">Service fees</div>');
      slider(el, 'Electricity (per kWh)', 0.05, 0.6, 0.01, s.fees.electricity, (v) => `₡${v.toFixed(2)}`, (v) => { s.fees.electricity = v; });
      slider(el, 'Water (per m³)', 0.05, 0.9, 0.01, s.fees.water, (v) => `₡${v.toFixed(2)}`, (v) => { s.fees.water = v; });
      slider(el, 'Healthcare (per visit)', 0, 300, 10, s.fees.healthcare, (v) => `₡${v}`, (v) => { s.fees.healthcare = v; });
      slider(el, 'Parking (per hour)', 0, 50, 1, s.fees.parking, (v) => `₡${v}`, (v) => { s.fees.parking = v; });
      slider(el, 'Road toll (per vehicle)', 0, 20, 1, s.fees.toll ?? 3, (v) => `₡${v}`, (v) => { s.fees.toll = v; });
      el.insertAdjacentHTML('beforeend', `<div class="row" style="margin-top:-4px"><span class="k" style="font-size:11px">toll booths</span><span class="muted num" style="font-size:11px">${app.ctx.tollBooths || 0} · ${money(s.lastLedger.income.tolls || 0)} last week</span></div>`);
      el.insertAdjacentHTML('beforeend', '<div class="muted" style="margin-top:6px">Fees above default reduce consumption but hurt well-being.</div>');
    } else if (tab === 'loans') {
      const lim = loanLimit(s);
      el.innerHTML = `${row('Current loan', money(s.loan))}${row('Loan limit', money(lim))}${row('Interest rate', `${interestRate(s, app.ctx).toFixed(1)}% / year`)}
        ${row('Interest per week', money(perWeek((s.loan * interestRate(s, app.ctx)) / 100 / 365)))}
        <div class="muted" style="margin:6px 0">City Hall lowers interest by 1%, Central Bank by 2%. Milestones raise the limit.</div>${s.politics?.council ? '<div class="warn" style="font-size:11px;margin:4px 0">The opposition council won\'t let you borrow until the next election.</div>' : ''}
        <div class="grid2"><button class="btn" data-a="b50">Borrow ₡50,000</button><button class="btn" data-a="b250">Borrow ₡250,000</button>
        <button class="btn" data-a="r50">Repay ₡50,000</button><button class="btn" data-a="rall">Repay all</button></div>`;
      el.querySelectorAll('button').forEach((b) => (b.onclick = () => {
        const a = b.dataset.a;
        if (a === 'b50') takeLoan(s, 50000);
        if (a === 'b250') takeLoan(s, 250000);
        if (a === 'r50') repayLoan(s, 50000);
        if (a === 'rall') repayLoan(s, s.loan);
        rerender();
      }));
    } else if (tab === 'trade') {
      const u = s.stats.utilities || {};
      el.innerHTML = `<div class="section-title">Utilities</div>
        ${row('Electricity produced', `${(u.produced || 0).toFixed(1)} MW`)}${row('Electricity used', `${(u.consumed || 0).toFixed(1)} MW`)}
        ${row('Imported / exported', `${(u.imported || 0).toFixed(1)} / ${(u.exported || 0).toFixed(1)} MW`)}
        ${row('Battery charge', `${(u.battery || 0).toFixed(0)} / ${u.batteryCap || 0} MWh`)}
        ${row('Water pumped / used', `${Math.round(u.waterProduced || 0).toLocaleString()} / ${Math.round(u.waterConsumed || 0).toLocaleString()} m³`)}
        ${row('Sewage treated / produced', `${Math.round(u.sewageTreated || 0).toLocaleString()} / ${Math.round(u.sewageProduced || 0).toLocaleString()} m³`)}
        <div class="section-title">Goods (units per day)</div>
        <div class="row muted" style="font-size:11px"><span>Resource</span><span>made · used · import · export</span></div>
        ${Object.entries(RESOURCES).map(([k, r]) => { const m = s.market[k] || {}; return row(`${r.icon} ${r.name}`, `${Math.round(m.produced || 0)} · ${Math.round(m.consumed || 0)} · ${Math.round(m.imported || 0)} · ${Math.round(m.exported || 0)}`); }).join('')}
        ${row('Export revenue (companies)', money(s.stats.exportIncome || 0))}`;
    }
  },
});

registerPanel({
  key: 'demand', icon: '📊', title: 'Demand', order: 12, rail: false,
  render(app, body) {
    const d = app.state.demand;
    const names = { res: 'Residential', com: 'Commercial', ind: 'Industrial', off: 'Office' };
    body.innerHTML = Object.entries(names).map(([k, n]) => `
      <div class="section-title">${n} · ${pct(d[k])}</div>${meter(d[k], `var(--${k})`)}
      ${Object.entries(d.factors?.[k] || {}).map(([f, v]) => row(f, `${v >= 0 ? '+' : ''}${Math.round(v * 100)}`, v > 0.01 ? 'good' : v < -0.01 ? 'bad' : 'muted')).join('')}`).join('') +
      `<div class="section-title">Residential by density</div>${row('Low', pct(d.resLow))}${row('Medium', pct(d.resMed))}${row('High', pct(d.resHigh))}`;
  },
});

registerPanel({
  key: 'stats', icon: '👥', title: 'Population & Citizens', order: 14,
  render(app, body, st, rerender) {
    const s = app.state;
    body.innerHTML = '';
    const tab = tabs(body, st, [['overview', 'Overview'], ['ages', 'Age & education'], ['charts', 'Charts']], rerender);
    const el = document.createElement('div');
    el.style.paddingTop = '8px';
    body.appendChild(el);
    const S = s.stats;
    if (tab === 'overview') {
      el.innerHTML = `${row('Population', (S.population || 0).toLocaleString())}${row('Households', (S.households || 0).toLocaleString())}
        ${row('Housing capacity', (S.housing || 0).toLocaleString())}
        ${row('Jobs (filled)', `${(S.jobs || 0).toLocaleString()} (${(S.workers || 0).toLocaleString()})`)}
        ${row('Unemployment', pct(S.unemployment || 0), (S.unemployment || 0) > 0.12 ? 'bad' : '')}
        ${row('Births / deaths today', `${S.births || 0} / ${S.deaths || 0}`)}
        ${row('Sick (treated today)', `${S.sick || 0} (${S.treated || 0})`)}
        ${row('Crimes / arrests today', `${S.crimes || 0} / ${S.arrests || 0}`)}${row('Jailed', `${S.jailed || 0} / ${S.jailCap || 0}`)}
        ${row('Tourists today', (S.tourists || 0).toLocaleString())}${row('Attractiveness', S.attractiveness ?? 0)}
        <div class="section-title">Happiness ${Math.round(S.happiness ?? 0)}%</div>${meter((S.happiness ?? 0) / 100, 'var(--good)')}
        ${row('Health', `${Math.round(S.health ?? 0)}%`)}${row('Well-being', `${Math.round(S.wellbeing ?? 0)}%`)}`;
    } else if (tab === 'ages') {
      const ages = { Children: 0, Teens: 0, Adults: 0, Seniors: 0 };
      const edu = [0, 0, 0, 0, 0];
      let students = 0;
      for (const c of s.citizens.values()) {
        if (c.age < AGE.teen) ages.Children++; else if (c.age < AGE.adult) ages.Teens++; else if (c.age < AGE.senior) ages.Adults++; else ages.Seniors++;
        if (c.age >= AGE.adult) edu[c.edu]++;
        if (c.school) students++;
      }
      const tot = s.citizens.size || 1;
      const adults = edu.reduce((a, c) => a + c, 0) || 1;
      el.innerHTML = '<div class="section-title">Age groups</div>' +
        Object.entries(ages).map(([k, v]) => `<div class="row"><span class="k" style="width:80px">${k}</span>${meter(v / tot)}<span class="num" style="width:50px;text-align:right">${v}</span></div>`).join('') +
        '<div class="section-title">Education (adults)</div>' +
        EDU_NAMES.map((n, k) => `<div class="row"><span class="k" style="width:110px">${n}</span>${meter(edu[k] / adults, '#ffb84f')}<span class="num" style="width:50px;text-align:right">${edu[k]}</span></div>`).join('') +
        row('Students', students);
    } else {
      el.innerHTML = '<div class="section-title">Population</div><canvas class="chart"></canvas><div class="section-title">Happiness</div><canvas class="chart"></canvas><div class="section-title">Unemployment %</div><canvas class="chart"></canvas>';
      const cs = el.querySelectorAll('canvas');
      const h = s.history.slice(-60);
      lineChart(cs[0], [{ values: h.map((x) => x.pop), color: '#5fd36b' }]);
      lineChart(cs[1], [{ values: h.map((x) => x.happiness), color: '#ffd34f' }], { min: 0, max: 100 });
      lineChart(cs[2], [{ values: h.map((x) => x.unemployment), color: '#ff6b5a' }], { min: 0 });
    }
  },
});

export const economyPanels = {};
