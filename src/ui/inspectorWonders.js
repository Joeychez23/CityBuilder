// Inspector rows for the wonders, attractions and giant factories (data/wonders.js)
import { row, meter, pct } from './panels.js';
import { money } from './tools.js';
import { perWeek } from '../sim/economy.js';
import { beachWeather, DEFAULT_TICKET, WATER_TAXI_FARE } from '../sim/projects.js';
import { PARK_REACH } from '../data/projects.js';

export function wonderHtml(app, b) {
  const s = app.state, ctx = app.ctx, d = b.def;
  let h = '';
  if (b.missing) h += `<div class="bad" style="font-size:11px;margin:3px 0">Not running: it needs ${b.missing}.</div>`;
  if (d.culture) h += row('Culture', `+${(d.culture * Math.min(1, b.efficiency ?? 1)).toFixed(1)} well-being city-wide`, 'good');
  if (d.wellbeing && d.boostRadius) h += row('Nearby', `+${d.wellbeing} well-being within ${d.boostRadius * 8} m`, 'good');
  if (d.weatherControl) h += row('Storms, hail & tornadoes', 'about a third as often', 'good');
  if (d.cleansAir) h += row('City air', 'clears faster everywhere', 'good');
  if (d.scrubs) h += row('Smog nearby', 'pulled out of the air', 'good');
  if (d.exportBoost) h += row('Export prices', `+${Math.round(d.exportBoost * 100)}%`, 'good');
  if (d.officeBoost) h += row('Office output', `+${Math.round(d.officeBoost * 100)}%`, 'good');
  if (d.grant) h += row('Government grant', `${money(perWeek(b.grantToday ?? d.grant))}/wk`, 'good') + row('Loan interest', `−${d.interestCut}%`, 'good');
  if (d.studyBoost) h += row('College & university', 'a day shorter', 'good');
  if (d.research) h += row('Development points', `+${d.research} a week`, 'good');
  if (d.ring) h += row('Ring', `${d.ring * 2} cells across, under the city`);
  if (d.attract) h += row('Attractiveness', `+${Math.round(d.attract * (b.efficiency ?? 1) * (d.casino ? 1 + 0.33 * Math.min(2, b.stripMates || 0) : 1))}`);
  if (d.delegates) {
    const wd = (s.time.day + 4) % 7;
    h += row('Delegates last night', `${b.delegatesToday || 0}${b.delegatesWanted > (b.delegatesToday || 0) ? ` of ${b.delegatesWanted} (short of hotel rooms)` : ''}`, b.delegatesWanted > (b.delegatesToday || 0) ? 'warn' : '')
      + row('Fees', `${money((b.delegatesToday || 0) * 60)} a day`) + `<div class="muted" style="font-size:11px">Conferences run Monday to Thursday${wd >= 1 && wd <= 4 ? '' : ' (none on today)'}. Delegates need hotel rooms, and more come to a city with lots of offices.</div>`;
  }
  if (d.casino) {
    h += row('Gamblers yesterday', b.gamblers ?? '–') + row('Gaming licence', `${money(b.licence || 0)} a day`, 'good');
    h += row('Casino strip', b.stripMates ? `${b.stripMates + 1} casinos together · +${Math.round(Math.min(2, b.stripMates) * 33)}%` : 'on its own (build another within 100 m)');
    h += '<div class="muted" style="font-size:11px">Crime rises and well-being falls in the streets around it.</div>';
  }
  if (d.studio) {
    h += row('Location fees', `${money(b.filmIncome || 0)} a day`);
    if (s.filmBuzz && s.filmBuzz.until > s.time.day) h += row('Now showing', `"${s.filmBuzz.film}" · +12 attractiveness`, 'good');
  }
  const f = d.factory;
  if (f?.makes === 'cars') {
    h += row('Cars made yesterday', `${Math.round(b.made || 0)}`) + row('Sales', `${money(b.factoryIncome || 0)} a day`, 'good') + row('Parts bought', `${money(b.inputCost || 0)} a day`);
    h += row('Needs per car', Object.entries(f.inputs).map(([r, k]) => `${k} ${r}`).join(', '));
  }
  if (f?.makes === 'ship') {
    h += `<div class="section-title">Ship no. ${(b.shipsLaunched || 0) + 1} on the slipway</div>${meter(b.shipProgress || 0, 'var(--blue)')}`
      + row('Built', pct(b.shipProgress || 0)) + row('Sells for', money(f.price)) + row('Ships launched', b.shipsLaunched || 0) + row('Materials', `${money(b.inputCost || 0)} a day`);
  }
  if (b.shortInputs) h += '<div class="warn" style="font-size:11px">Short of materials: the city doesn\'t make enough and it can\'t import the rest (it needs a road to the highway).</div>';
  return h + projectHtml(app, b);
}

// Parks and beaches you drew, the theme park, water taxi piers and the hyperloop
function projectHtml(app, b) {
  const s = app.state, ctx = app.ctx, d = b.def;
  let h = '';
  if (d.area && d.parts) {
    h += row('Size', `${b.x1 - b.x0 + 1} × ${b.y1 - b.y0 + 1} cells`) + row('Leisure reaches', `${(b.radius || d.radius) * 8} m`);
    if (d.seasonal) {
      const sun = beachWeather(s);
      h += row('Beach weather', sun > 1 ? 'perfect' : sun > 0.6 ? 'good' : sun > 0.3 ? 'cool' : 'too cold', sun < 0.3 ? 'warn' : 'good')
        + row('Draws', `+${Math.round((b.attract ?? d.attract) * sun)} attractiveness (up to +${Math.round((b.attract ?? d.attract) * 1.4)} in summer)`);
    } else h += row('Draws', `+${b.attract ?? d.attract} attractiveness`);
    if (b.boostRadius) h += row('Nearby', `+${d.wellbeing} well-being within ${b.boostRadius * 8} m`, 'good');
    if (d.promenade) h += row('Kiosk customers', `${b.customers ?? 0} yesterday`) + row('Kiosks earned', `${money(b.kioskIncome || 0)} a day`, 'good');
  }
  if (d.themeGate) {
    const q = b.queue || 0;
    h += `<div class="section-title">🎢 The park</div>`
      + row('Visitors yesterday', b.visitors ?? '–') + row('Rides', `${b.rides || 0} · ${(b.capacity || 0).toLocaleString()} riders a day`)
      + row('Queues', b.rides ? (q < 0.5 ? 'short' : `about ${q < 1 ? Math.round(q * 60) + ' min' : q.toFixed(1) + ' h'}`) : '–', q > 1.5 ? 'bad' : q > 1 ? 'warn' : '')
      + (b.turnedAway > 5 ? row('Stayed away', `${b.turnedAway} (the queues)`, 'warn') : '')
      + row('Tickets', `${money(b.ticketIncome || 0)} a day`, 'good')
      + `<label class="row"><span class="k">Ticket price</span><span style="display:flex;gap:6px;align-items:center"><input type="range" min="5" max="80" step="5" value="${b.ticket ?? DEFAULT_TICKET}" data-ticket style="width:110px"><b class="num">${money(b.ticket ?? DEFAULT_TICKET)}</b></span></label>`
      + `<div class="muted" style="font-size:11px">Lay out rides within ${PARK_REACH * 8} m of the gate (Landmarks → Theme park). More rides of different kinds make it more fun; when the queues pass an hour and a half, people stay away. Dearer tickets earn more from fewer visitors.</div>`;
    if (!b.rides) h += '<div class="warn" style="font-size:11px">No rides yet: nobody comes.</div>';
  }
  if (d.ride) h += row('Riders yesterday', b.riders ?? 0) + row('Takes', `${d.ride.capacity} riders a day`) + row('Fun', '★'.repeat(d.ride.appeal));
  if (d.waterTaxi) {
    const mine = (ctx.taxiRoutes || []).filter((r) => r.a === b.id || r.b === b.id);
    h += row('Water taxi routes', mine.length || 'none yet') + row('Riders yesterday', mine.reduce((a, r) => a + (r.ridersYesterday || 0), 0)) + row('Fare', money(WATER_TAXI_FARE));
    if (!mine.length) h += '<div class="muted" style="font-size:11px">Build another pier on the same water: the boats run between them.</div>';
  }
  if (d.hyperloop) h += row('Residents working elsewhere', `${b.riders || 0} / ${b.seats ?? d.seats}`) + row('Skilled commuters in', `+${Math.round((ctx.hyperloop?.commuterBoost || 0) * 100)}% of open jobs`, 'good');
  return h;
}

// Controls in those rows
export function wireWonder(app, b, body) {
  const t = body.querySelector('[data-ticket]');
  if (t) t.oninput = () => { b.ticket = +t.value; t.nextElementSibling.textContent = money(b.ticket); };
}
