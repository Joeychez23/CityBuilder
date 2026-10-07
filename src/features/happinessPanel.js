// Happiness panel (opened from the meter in the top bar): how happy the city is, how many
// people are happy or angry, and what they're complaining about, city-wide, with what to do.
import { registerPanel, row, meter } from '../ui/panels.js';
import { taxFeeling } from '../sim/wellbeing.js';

const MOOD = (h) => (h >= 65 ? ['Happy', 'good'] : h >= 45 ? ['Content', 'warn'] : h >= 30 ? ['Unhappy', 'bad'] : ['Angry', 'bad']);
const FIX = {
  'No job': 'Zone shops, industry or offices so people can find work.',
  Taxes: 'Taxes above 10% upset people; the more you charge their education level, the angrier they get.',
  'Transport costs': 'Lower ticket prices, parking fees or road tolls.',
  'Industrial noise': 'Keep homes a few blocks from industry, or plant trees between them.',
  Noise: 'Busy roads are loud: trees and sound barriers help.',
  Electricity: 'Build power plants or batteries, or connect to the outside power line.',
  Water: 'Build pumps and sewage handling on the same network.',
  'Sewage upstream of drinking water': 'Sewage flows downstream: keep outlets downstream of every water pump (or treat the sewage).',
  'No police nearby': 'Build police stations so every neighbourhood is covered.',
  'No fire station nearby': 'Build fire houses so every neighbourhood is covered.',
  'No healthcare nearby': 'Build clinics or a hospital.',
  'No school for the kids': 'Build elementary schools near homes.',
  Crime: 'More police coverage and jobs lower crime.',
  'Garbage & deathcare': 'Landfills or incinerators, and a cemetery.',
  'Service fees': 'Electricity and water fees above default upset people.',
  'No parking at work': 'Build parking lots near shops, offices and industry.',
  Wealth: 'Jobs with better wages make households richer.',
  Sick: 'Healthcare treats sick people.',
};

registerPanel({
  key: 'happiness', icon: '😊', title: 'Happiness', order: 15, rail: false,
  render(app, body) {
    const s = app.state;
    const S = s.stats;
    if (S.happiness == null) { body.innerHTML = '<div class="muted">Nobody lives here yet.</div>'; return; }
    const [mood, cls] = MOOD(S.happiness);
    const B = S.happyBands || [0, 0, 0, 0];
    const tot = B.reduce((a, c) => a + c, 0) || 1;
    const seg = (n, color, label) => (n ? `<i style="flex:${n};background:${color}" title="${label}: ${n}"></i>` : '');
    let html = `<div class="bigstat"><b class="${cls}">${Math.round(S.happiness)}%</b><span>${mood}<br>health ${Math.round(S.health ?? 0)}% · well-being ${Math.round(S.wellbeing ?? 0)}%</span></div>
      <div class="mood-bar">${seg(B[3], 'var(--good)', 'Happy')}${seg(B[2], 'var(--yellow)', 'Content')}${seg(B[1], '#ff8a3a', 'Unhappy')}${seg(B[0], 'var(--bad)', 'Angry')}</div>
      <div class="mood-keys"><span><i style="background:var(--good)"></i>Happy ${Math.round((B[3] / tot) * 100)}%</span><span><i style="background:var(--yellow)"></i>Content ${Math.round((B[2] / tot) * 100)}%</span><span><i style="background:#ff8a3a"></i>Unhappy ${Math.round((B[1] / tot) * 100)}%</span><span><i style="background:var(--bad)"></i>Angry ${Math.round((B[0] / tot) * 100)}%</span></div>
      <div class="section-title">Complaints</div>`;
    const F = S.happyFactors || [];
    const bad = F.filter((f) => f.avg < -0.2);
    const good = F.filter((f) => f.avg > 0.2).reverse();
    const item = (f) => `<div class="factor"><span class="ico">${f.icon}</span><span>${f.name}<span class="why">${Math.round(f.share * 100)}% of residents${f.avg < 0 && FIX[f.name] ? ` · ${FIX[f.name]}` : ''}</span></span><span class="v ${f.avg < 0 ? 'bad' : 'good'}">${f.avg > 0 ? '+' : ''}${f.avg.toFixed(1)}</span></div>`;
    html += bad.length ? bad.map(item).join('') : '<div class="muted">No complaints. Nice work.</div>';
    html += '<div class="section-title">What people like</div>' + (good.length ? good.slice(0, 8).map(item).join('') : '<div class="muted">Nothing stands out yet.</div>');
    const T = S.transportCost || {};
    html += `<div class="section-title">Pressure points</div>
      ${row('Unemployment', `${Math.round((S.unemployment || 0) * 100)}%`, (S.unemployment || 0) > 0.1 ? 'bad' : '')}
      ${row('Residential tax', `${s.taxes.res}% (${taxFeeling(s.taxes.res) >= 0 ? '+' : ''}${taxFeeling(s.taxes.res).toFixed(1)})`, s.taxes.res > 12 ? 'bad' : '')}
      ${row('Car costs (parking, tolls)', T.car > 0.5 ? `<span class="bad">high</span>` : 'normal')}
      ${row('Transit fares', T.transit > 0.5 ? `<span class="bad">high</span>` : 'normal')}
      <div class="muted" style="font-size:11px;margin-top:6px">Points are the average effect on each resident's well-being (out of 100). Happiness is the average of health and well-being. Very unhappy households move away.</div>`;
    body.innerHTML = html;
  },
});

export const happinessPanel = {};
