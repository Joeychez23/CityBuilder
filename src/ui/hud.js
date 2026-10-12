// Top bar, laid out like a signage strip: city mark and name, funds with this week's
// projection, population, the happiness meter, power, the date (day of the month and the
// weekday the budget settles on), weather, demand, milestone and the notification bell.
import { WEEKDAYS, MONTHS, dateOf, seasonOf, hourOf, isNight, FASTEST } from '../sim/simulation.js';
import { projection } from '../sim/economy.js';
import { money } from './tools.js';
import { tipHtml } from './hovertips.js';

const WEATHER_ICON = { clear: '☀️', cloudy: '⛅', overcast: '☁️', rain: '🌧️', storm: '⛈️', snow: '🌨️', fog: '🌫️', hail: '🌨️' };
const pad = (n) => String(n).padStart(2, '0');
const signed = (v) => `${v >= 0 ? '+' : '−'}${money(Math.abs(v))}`;

export function createHud(app) {
  const el = document.getElementById('hud');
  el.innerHTML = `
    <div class="hud-mark" data-open="settings" title="Game menu"><span class="hud-logo" id="h-logo"></span><span class="hud-name" id="h-name"></span></div>
    <div class="hud-item clickable" data-open="economy" title="Budget: paid every Saturday night">
      <span class="label"><i>01</i> Funds</span><span class="value" id="h-money"></span><span class="sub" id="h-week"></span></div>
    <div class="hud-item clickable" data-open="stats">
      <span class="label"><i>02</i> Population</span><span class="value" id="h-pop">0</span><span class="sub" id="h-pop-d"></span></div>
    <div class="hud-item clickable hud-happy" data-open="happiness">
      <span class="label"><i>03</i> Happiness</span><span class="value"><b id="h-happy">–</b><span class="segs" id="h-happy-bar"></span></span><span class="sub" id="h-happy-why"></span></div>
    <div class="hud-item clickable" data-open="power">
      <span class="label"><i>04</i> Power</span><span class="value" id="h-power">–</span><span class="sub" id="h-power-sub"></span></div>
    <div class="hud-item hud-date">
      <span class="label" id="h-weekday"></span><span class="value" id="h-date"></span>
      <span class="sub"><span id="h-time"></span><span class="speed-btns" id="h-speed"></span></span></div>
    <div class="hud-item hud-weather"><span class="label">Weather</span><span class="value" id="h-weather"></span><span class="sub" id="h-season"></span></div>
    <div class="hud-item clickable" data-open="demand"><span class="label">Demand</span><div class="demand" id="h-demand"></div></div>
    <div class="hud-item clickable hud-xp" data-open="progression"><span class="label" id="h-ms"></span><span class="value" id="h-xp"></span><div class="xpbar"><i id="h-xpbar"></i></div></div>
    <button class="hud-bell" id="h-bell" data-open="notices" title="Notifications"><span>🔔</span><b id="h-bell-n">0</b></button>
  `;
  el.querySelectorAll('[data-open]').forEach((n) => n.addEventListener('click', () => app.panels?.toggle(n.dataset.open)));
  // hover tips for the strip
  const TIPS = {
    settings: ['Game menu', 'Save, load, graphics and camera settings, and the main menu.'],
    economy: ['Funds', 'Your money, and how this week is going: taxes and upkeep build up and are paid when Saturday ends. Click for the budget.'],
    stats: ['Population', 'People living in the city, and how many moved in or out today. Click for details.'],
    happiness: ['Happiness', 'How content residents are (health and well-being), and their biggest complaint. Click to see every factor.'],
    power: ['Power', 'Electricity needed right now against what is available. Click for the networks, and to show the power grid.'],
    demand: ['Demand', 'What the city wants more of: housing (low, medium, high density), commercial, industrial and office. Zone what is high.'],
    progression: ['Milestone', 'Experience towards the next milestone: it unlocks new buildings and gives money and expansion permits.'],
    notices: ['Notifications', 'Problems that need fixing (red ones first) and the news.'],
  };
  el.querySelectorAll('[data-open]').forEach((n) => { const t = TIPS[n.dataset.open]; if (t) { n.dataset.tip = tipHtml(t[0], t[1]); n.removeAttribute('title'); } });
  el.querySelector('.hud-date').dataset.tip = tipHtml('Date & time', 'The day of the month; budgets are paid every Saturday night. The buttons pause and set the speed (Space pauses, 1–3 set the speed). The fastest only skips the night (20:00 to 06:00): in the morning it goes back to normal speed.');

  const $ = (id) => el.querySelector(`#${id}`);
  const speedEl = $('h-speed');
  const speeds = [['❚❚', 0], ['▶', 1], ['▶▶', 2], ['▶▶▶', 3]];
  speedEl.innerHTML = speeds.map(([t, v]) => `<button data-s="${v}" data-tip="${['Pause (Space)', 'Normal speed (1)', 'Fast (2)', 'Fastest (3): skips the night, 20:00 to 06:00, then back to normal speed'][v]}">${t}</button>`).join('');
  speedEl.querySelectorAll('button').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); app.setSpeed(+b.dataset.s); }));
  $('h-happy-bar').innerHTML = '<i></i>'.repeat(10);

  const bars = [['resLow', 'L', 'var(--res)'], ['resMed', 'M', 'var(--res)'], ['resHigh', 'H', 'var(--res)'], ['com', 'C', 'var(--com)'], ['ind', 'I', 'var(--ind)'], ['off', 'O', 'var(--off)']];
  $('h-demand').innerHTML = bars.map(([k, t]) => `<div><div class="bar"><i id="d-${k}"></i></div><div class="tag">${t}</div></div>`).join('');

  const hud = {};
  // One line across the top: on a narrow window the extras (weather, milestone) go first,
  // then the numbering and the happiness note
  hud.fit = () => {
    el.classList.remove('slim', 'slimmer');
    const wraps = () => el.lastElementChild.offsetTop > el.firstElementChild.offsetTop + 6;
    if (wraps()) el.classList.add('slim');
    if (wraps()) el.classList.add('slimmer');
  };
  window.addEventListener('resize', () => hud.fit());
  hud.update = () => {
    const s = app.state;
    // Keep panels below the HUD and menus above the toolbar, whatever the window width (in
    // the interface's own units: it may be zoomed by the Interface size setting)
    const z = app.uiScale || 1;
    const hudBottom = el.getBoundingClientRect().bottom + 8;
    document.getElementById('ui').style.setProperty('--hud-h', `${hudBottom / z}px`);
    const tb = document.getElementById('toolbar').getBoundingClientRect();
    document.getElementById('ui').style.setProperty('--toolbar-h', `${(window.innerHeight - tb.top + 8) / z}px`);
    $('h-name').textContent = s.cityName;
    $('h-logo').textContent = (s.cityName.trim()[0] || 'C').toUpperCase();

    $('h-money').textContent = s.options.unlimitedMoney ? '∞' : money(s.money);
    $('h-money').className = `value ${s.money < 0 ? 'bad' : ''}`;
    const P = projection(s);
    const day = dateOf(s.time.day);
    $('h-week').innerHTML = `<span class="${P.net >= 0 ? 'good' : 'bad'}">${signed(P.net)}</span> by Sat${P.daysLeft === 1 ? ' night' : ''}`;
    $('h-week').parentElement.title = `This week so far, projected to Saturday night. Paid out in ${P.daysLeft} day${P.daysLeft === 1 ? '' : 's'}.\nBalance after Saturday: ${money(P.endMoney)}`;

    const pop = s.stats.population || 0;
    $('h-pop').textContent = pop.toLocaleString();
    const dp = s.stats.popDelta || 0;
    $('h-pop-d').innerHTML = dp ? `<span class="${dp > 0 ? 'good' : 'bad'}">${dp > 0 ? '+' : ''}${dp}</span> today` : 'steady';

    const h = s.stats.happiness;
    $('h-happy').textContent = h == null ? '–' : `${Math.round(h)}%`;
    const lit = h == null ? 0 : Math.round(h / 10);
    $('h-happy-bar').querySelectorAll('i').forEach((seg, k) => {
      seg.className = k < lit ? (h > 65 ? 'on good' : h > 45 ? 'on warn' : 'on bad') : '';
    });
    const top = s.stats.topComplaint;
    $('h-happy-why').textContent = h == null ? 'no residents yet' : top ? `${top.icon} ${top.name}` : 'no complaints';

    const u = s.stats.utilities || {};
    const need = u.consumed || 0, have = (u.produced || 0) + (u.imported || 0) + (u.batteryOut || 0);
    $('h-power').innerHTML = `${need.toFixed(1)}<small> / ${have.toFixed(1)} MW</small>`;
    const short = need > have + 0.05 || (u.unpowered || 0) > 0;
    $('h-power').className = `value ${short ? 'bad' : ''}`;
    $('h-power-sub').innerHTML = short ? '<span class="bad">shortage</span>' : need ? `${Math.round((need / Math.max(have, 0.01)) * 100)}% used` : 'no demand';

    $('h-weekday').textContent = `${WEEKDAYS[day.weekday]}${day.weekday === 6 ? ' · pay day' : ''}`;
    $('h-date').textContent = `${pad(day.dom)} ${MONTHS[day.month]} ${day.year}`;
    const mins = s.time.minutes;
    $('h-time').textContent = `${pad(Math.floor(mins / 60))}:${pad(Math.floor(mins % 60))}`;
    const night = isNight(s);
    speedEl.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', +b.dataset.s === (s.time.paused ? 0 : s.time.speed));
      if (+b.dataset.s === FASTEST) b.classList.toggle('locked', !night); // (night only)
    });
    const w = s.weather;
    const dark = hourOf(s) < 6 || hourOf(s) >= 20;
    const icon = dark && (w.kind === 'clear' || w.kind === 'cloudy') ? (w.kind === 'clear' ? '🌙' : '☁️') : WEATHER_ICON[w.kind] || '☀️';
    $('h-weather').textContent = `${icon} ${Math.round(w.temp)}°C`;
    $('h-season').textContent = seasonOf(s);
    for (const [k, , c] of bars) {
      const v = Math.max(0, Math.min(1, s.demand[k] || 0));
      const bar = $(`d-${k}`);
      bar.style.height = `${v * 100}%`;
      bar.style.background = c;
    }
    const p = app.progressInfo?.() || { name: 'Founding', xp: s.progression.xp, need: 100, frac: 0 };
    $('h-ms').textContent = p.name;
    $('h-xp').textContent = `${Math.floor(p.xp)} / ${p.need} XP`;
    $('h-xpbar').style.width = `${Math.min(100, p.frac * 100)}%`;

    if ((hud.fits = (hud.fits || 0) + 1) % 8 === 1) hud.fit();
    const n = app.notices?.active.size || 0;
    const severe = app.notices ? [...app.notices.active.values()].some((x) => x.kind === 'bad') : false;
    $('h-bell-n').textContent = n;
    $('h-bell').className = `hud-bell ${n ? (severe ? 'alert' : 'warn') : ''}`;
  };
  return hud;
}
