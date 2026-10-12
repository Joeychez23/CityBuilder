// The region (sim/region.js): found a neighbour city next door, switch between the cities,
// and see what they do for each other (spare power, commuters, jobs, trade).
import { registerPanel, row } from '../ui/panels.js';
import { registerSystem, formatDate } from '../sim/simulation.js';
import { getRegion, putRegion, putCity, saveToRegion, neighbourOffer, regionalTradeDaily, snapshot } from '../sim/region.js';
import { createState } from '../core/state.js';
import { generateMap } from '../sim/mapgen.js';
import { pack } from '../sim/save.js';
import { putSave } from '../sim/store.js';
import { MAPS, CLIMATES } from '../data/maps.js';
import { money } from '../ui/tools.js';
import { clamp } from '../core/grid.js';

export const REGION_LOAD = 'gridlock-region-load';
const SIDES = { north: 'North', east: 'East', south: 'South', west: 'West' };
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function goTo(app, cityId) {
  const s = app.state;
  app.toast('Saving this city…', 'info');
  await saveToRegion(s);
  await putSave(await pack(s)).catch(() => {}); // (storage full: the region copy is enough)
  sessionStorage.setItem(REGION_LOAD, cityId);
  location.href = location.pathname;
}

async function foundNeighbour(app, { name, mapId, side }) {
  const s = app.state;
  if (!s.region) s.region = { id: `r${Date.now().toString(36)}`, cityId: `c${Date.now().toString(36)}`, side: 'home' };
  const region = await saveToRegion(s);
  const map = MAPS.find((m) => m.id === mapId) || MAPS[0];
  const fresh = createState(map, { cityName: name, difficulty: s.options.difficulty, disasters: s.options.disasters, tutorial: false, unlimitedMoney: s.options.unlimitedMoney, unlockAll: s.options.unlockAll, allTiles: s.options.allTiles });
  generateMap(fresh, map);
  if (fresh.options.allTiles) fresh.tiles.fill(1);
  const id = `c${(Date.now() + 1).toString(36)}`;
  fresh.region = { id: s.region.id, cityId: id, side };
  fresh.options.elections = s.options.elections;
  fresh.options.climateChange = s.options.climateChange;
  await putCity(id, await pack(fresh));
  region.cities.push({ id, name, mapId, side, snapshot: snapshot(fresh), savedAt: Date.now() });
  await putRegion(region);
  await goTo(app, id);
}

registerPanel({
  key: 'region', icon: '🌐', title: 'Region', order: 7,
  desc: 'Your city and its neighbours: found a second city next door that shares power, commuters and trade with this one, and switch between them.',
  render(app, body, st, rerender) {
    const s = app.state, R = app.ctx.region;
    let html = '';
    if (!s.region || !R?.region || R.region.cities.length < 2) {
      html += `<div class="muted" style="margin-bottom:8px">This city stands alone. Found a neighbour city next door: you build it up yourself, one city at a time, and the two help each other. Spare power flows between them, people out of work in one fill jobs in the other, and goods one makes the other buys.</div>`;
    } else {
      html += '<div class="section-title">The region</div>';
      for (const c of R.region.cities) {
        const me = c.id === s.region.cityId, sn = c.snapshot || {};
        html += `<div class="list-item"><div class="row"><b>${me ? '📍 ' : ''}${esc(c.name)}</b><span class="muted">${SIDES[c.side] || 'Home'}${c.side && c.side !== 'home' ? ' of the first city' : ''}</span></div>
          <div class="muted" style="font-size:11px">${(sn.pop || 0).toLocaleString()} people · ${sn.powerSpare ? `${sn.powerSpare} MW spare` : sn.powerShort ? `${sn.powerShort} MW short` : 'power balanced'} · ${sn.jobless || 0} looking for work · ${sn.openJobs || 0} open jobs${sn.day ? ` · last played ${formatDate(sn.day)}` : ''}</div>
          ${me ? '<div class="muted" style="font-size:11px">You are here.</div>' : `<button class="btn primary" data-visit="${c.id}" style="margin-top:4px">Go to ${esc(c.name)}</button>`}</div>`;
      }
      const o = R.offer;
      html += '<div class="section-title">What the neighbours do for this city</div>'
        + row('Spare power you can draw', `${o.powerSpare} MW (cheaper than from the grid)`) + row('Their power shortfall', `${o.powerShort} MW (they buy your spare at a good price)`)
        + row('Commuters coming in', `about ${Math.round((R.commuterBoost || 0) * 100)}% more of your open jobs filled`) + row('Your residents working there', s.stats.neighbourJobs || 0)
        + row('Regional trade', `${money(R.tradeGain || 0)} a day`, 'good')
        + '<div class="muted" style="font-size:11px">Only the city you\'re in runs; the others wait as you left them, and what they offer is from when you last played them. Power needs the outside power line, commuters and trade need the highway.</div>';
    }
    const others = (R?.region?.cities || []).length;
    if (others < 4) {
      const cl = CLIMATES[s.climate];
      html += `<div class="section-title">Found a neighbour city</div>
        <label class="row"><span class="k">Name</span><input type="text" data-name value="${esc(`New ${s.cityName.split(' ')[0]}`)}" style="width:150px"></label>
        <label class="row"><span class="k">Next door to the</span><select data-side>${Object.entries(SIDES).filter(([k]) => !(R?.region?.cities || []).some((c) => c.side === k)).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label class="row"><span class="k">Land</span><select data-map>${MAPS.map((m) => `<option value="${m.id}" ${m.climate === s.climate ? '' : ''}>${m.name} (${CLIMATES[m.climate].name})</option>`).join('')}</select></label>
        <div class="muted" style="font-size:11px;margin:4px 0">${cl ? `This city's climate is ${cl.name.toLowerCase()}; pick land that suits.` : ''} The new city starts from scratch with the usual starting money. This city is saved first, and you can come back to it at any time.</div>
        <button class="btn primary" data-found>🏗 Found it and go there</button>`;
    }
    body.innerHTML = html;
    body.querySelectorAll('[data-visit]').forEach((b) => (b.onclick = () => { if (confirm('Save this city and go to the neighbour?')) goTo(app, b.dataset.visit); }));
    body.querySelector('[data-found]')?.addEventListener('click', () => {
      const name = body.querySelector('[data-name]').value.trim() || 'New Town';
      const side = body.querySelector('[data-side]').value, mapId = body.querySelector('[data-map]').value;
      if (!confirm(`Save ${s.cityName} and found ${name}?`)) return;
      foundNeighbour(app, { name, mapId, side }).catch((e) => app.toast(`Couldn't found the city: ${e.message}`, 'bad'));
    });
  },
});

export const regionFeature = {
  init(app) {
    const { state, ctx } = app;
    ctx.region = null;
    registerSystem({ name: 'regional-trade', every: 'day', run: regionalTradeDaily });
    // commuters from the neighbours fill a share of the open jobs
    registerSystem({ name: 'region', every: 'day', run: (s, c) => {
      if (!c.region?.offer) return;
      const open = (s.stats.openJobsEdu || []).reduce((a, v) => a + v, 0);
      c.region.commuterBoost = open > 0 ? clamp(c.region.offer.workers / Math.max(200, open), 0, 0.35) : 0;
    } });
    if (!state.region) return;
    getRegion(state.region.id).then((region) => {
      if (!region) return;
      ctx.region = { region, offer: neighbourOffer(region, state.region.cityId), commuterBoost: 0 };
      const open = (state.stats.openJobsEdu || []).reduce((a, v) => a + v, 0);
      ctx.region.commuterBoost = open > 0 ? clamp(ctx.region.offer.workers / Math.max(200, open), 0, 0.35) : 0;
      app.panels.refresh('region');
    }).catch(() => { /* no database in this browser */ });
  },
};
