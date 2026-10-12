// Climate & disasters: hourly weather, seasonal terrain colours, fires, hail, tornadoes,
// and the event journal panel.
import { registerSystem, seasonOf, MONTHS, monthFloat, formatDate } from '../sim/simulation.js';
import { weatherHourly, monthlyMean } from '../sim/climate.js';
import { fireRiskDaily, firesHourly, hailHourly, tornadoStep, startTornado, igniteCell } from '../sim/disasters.js';
import { createFx } from '../world/fxView.js';
import { registerPanel, row } from '../ui/panels.js';
import { CLIMATES } from '../data/maps.js';
import { bus } from '../core/events.js';
import { N } from '../core/grid.js';
import { earthquake, startSurge, startHeatwave } from '../sim/hazards.js';

const ICON = { budget: '💰', fire: '🔥', forestfire: '🌲🔥', destroyed: '💥', hail: '🌨️', tornado: '🌪️', accident: '🚗💥', milestone: '🏆', policy: '📜', crime: '🚔', info: 'ℹ️', quake: '🫨', flood: '🌊', heat: '🌡️', climate: '🌍' };

registerPanel({
  key: 'journal', icon: '📰', title: 'Event Journal & Climate', order: 60,
  render(app, body) {
    const s = app.state;
    const cl = CLIMATES[s.climate];
    const w = s.weather;
    const months = MONTHS.map((m, k) => `${m} ${Math.round(monthlyMean(cl, k))}°`).join(' · ');
    let html = `<div class="section-title">Climate: ${cl.name}</div>
      ${row('Now', `${w.kind} · ${w.temp.toFixed(1)}°C`)}${row('Clouds / wind', `${Math.round(w.cloud * 100)}% / ${Math.round(w.wind * 100)}%`)}
      ${row('Rain / snow', `${Math.round(w.rain * 100)}% / ${Math.round(w.snow * 100)}%`)}
      ${row('Fire danger (dryness)', `${Math.round((app.ctx.dryness || 0) * 100)}%`, (app.ctx.dryness || 0) > 0.7 ? 'bad' : '')}
      ${row('Snow on the ground', `${Math.round((app.ctx.snowCover || 0) * 100)}%`)}
      <div class="muted" style="font-size:11px;margin:4px 0">${months}</div>
      <div class="muted" style="font-size:11px">Cold and heat raise power use for heating & cooling. Clouds cut solar output; wind drives turbines. Rain cleans the air; snow needs road maintenance.</div>`;
    const C = s.climateChange, ctx = app.ctx;
    if (ctx.heatwave) html += row('Heatwave', `${ctx.heatwave.days} more day${ctx.heatwave.days === 1 ? '' : 's'} · +${ctx.heatwave.boost} °C`, 'bad');
    if (ctx.surge) html += row('Storm surge', `the sea is ${Math.round(ctx.surge.rise * 8)} m up · ${ctx.surge.cells.length} cells of your land flooded`, 'bad');
    const broken = (s.closures || []).filter((c) => c.why === 'quake').reduce((a, c) => a + c.cells.length, 0);
    if (broken) html += row('Earthquake damage', `${broken} road and pipe cells still broken`, 'warn');
    html += '<div class="section-title">Long-term climate</div>';
    if (s.options.climateChange === false) html += '<div class="muted" style="font-size:11px">Climate change is off for this city (Game panel).</div>';
    else html += row('Warming since the city was founded', `+${(C?.warming || 0).toFixed(2)} °C`, (C?.warming || 0) > 1 ? 'bad' : (C?.warming || 0) > 0.5 ? 'warn' : '')
      + (s.connectionsAvailable.ship ? row('Sea level', `+${((C?.seaRise || 0) * 8).toFixed(1)} m`, (C?.seaRise || 0) > 0 ? 'bad' : '') : '')
      + `<div class="muted" style="font-size:11px">The city's smog builds up in the atmosphere over the years and warms the region: hotter summers, more heatwaves${s.connectionsAvailable.ship ? ' and, once it passes a degree, a slowly rising sea' : ''}. Clean power, carbon capture, the Eco Dome and trees slow it; a cleaner city lets it ease off again.</div>`;
    if (s.options.unlimitedMoney || s.options.unlockAll) {
      html += `<div class="section-title">Sandbox</div><div class="grid2"><button class="btn" data-x="tornado">Spawn tornado</button><button class="btn" data-x="fire">Start forest fire</button>
        <button class="btn" data-x="quake">Earthquake</button><button class="btn" data-x="heat">Heatwave</button>${s.connectionsAvailable.ship ? '<button class="btn" data-x="surge">Storm surge</button>' : ''}</div>`;
    }
    html += '<div class="section-title">Event journal</div>';
    const items = [...s.journal].reverse().slice(0, 60);
    html += items.length ? items.map((e) => `<div class="row"><span>${ICON[e.kind] || '•'} ${e.text}</span><span class="muted num">${formatDate(e.day)}</span></div>`).join('') : '<div class="muted">Nothing has happened yet.</div>';
    body.innerHTML = html;
    body.querySelector('[data-x="tornado"]')?.addEventListener('click', () => startTornado(s, app.ctx));
    body.querySelector('[data-x="quake"]')?.addEventListener('click', () => { const c = app.view.cam.cur || app.view.controls.target; earthquake(s, app.ctx, Math.floor(c.x), Math.floor(c.z), 5.5 + Math.random()); });
    body.querySelector('[data-x="heat"]')?.addEventListener('click', () => startHeatwave(s, app.ctx));
    body.querySelector('[data-x="surge"]')?.addEventListener('click', () => startSurge(s, app.ctx, 0.9));
    body.querySelector('[data-x="fire"]')?.addEventListener('click', () => {
      for (let k = 0; k < 400; k++) { const i = Math.floor(Math.random() * N * N); if (s.tree[i] >= 2) { igniteCell(s, app.ctx, i, 'sandbox'); break; } }
    });
  },
});

export const climateFeature = {
  init(app) {
    const { state, ctx } = app;
    registerSystem({ name: 'weather', every: 'hour', run: weatherHourly });
    registerSystem({ name: 'fire-risk', every: 'day', run: fireRiskDaily });
    registerSystem({ name: 'fires', every: 'hour', run: firesHourly });
    registerSystem({ name: 'hail', every: 'hour', run: (s, c) => { hailHourly(s, c); if (!s.weather.hail) c.hailNotified = false; } });
    registerSystem({ name: 'tornado', every: 'step', run: tornadoStep });
    app.fx = createFx(app.view, state, ctx);
    // Start with the season's typical weather
    const cl = CLIMATES[state.climate];
    state.weather.temp = monthlyMean(cl, monthFloat(state) - 0.5);
    ctx.dryness = cl.dryness * 0.6;

    let lastKey = '';
    app.features = app.features || {};
    app.features.climate = {
      recolorTerrain: () => {
        const season = seasonOf(state);
        const dry = cl.dryness * 0.7 + (ctx.dryness || 0) * 0.3;
        app.terrain.updateColors(ctx.snowCover || 0, season, dry);
        app.terrain.updateWaterColors(cl.snow && (ctx.snowCover || 0) > 0.6 && state.weather.temp < -6 ? 1 : 0);
      },
    };
    bus.on('step', () => {
      // Recolour the ground when the season, snow cover or pollution changes noticeably
      const key = `${seasonOf(state)}-${Math.round((ctx.snowCover || 0) * 5)}-${Math.floor(state.time.day)}-${Math.floor(state.time.minutes / 360)}`;
      if (key !== lastKey) { lastKey = key; app.features.climate.recolorTerrain(); }
    });
    app.features.climate.recolorTerrain();
  },
  frame(app, dt) { app.fx.update(dt, app.fxEnabled !== false); },
};
