// Game & meta: save/load/autosave, settings, photo mode, the beginner's guide and the
// citizen life-path viewer.
import { registerPanel, row } from '../ui/panels.js';
import { registerSystem, formatDate } from '../sim/simulation.js';
import { pack } from '../sim/save.js';
import { putSave } from '../sim/store.js';
import { saveToRegion } from '../sim/region.js';
import { EDU_NAMES, ZONES } from '../data/zones.js';
import { ageGroup, AGE } from '../sim/citizens.js';
import { bus } from '../core/events.js';
import { DIFFICULTIES, DIFFICULTY_KEYS, difficultyOf, difficultyRows } from '../data/difficulty.js';

function download(name, href) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function saveLocal(app, quiet) {
  // (a city in a region is kept in the region's store too: sim/region.js)
  if (app.state.region) saveToRegion(app.state).catch(() => {});
  try {
    const text = await pack(app.state);
    await putSave(text);
    if (!quiet) app.toast(`Saved (${Math.round(text.length / 1024)} KB)`, 'good');
    return true;
  } catch (e) {
    app.toast('Browser storage is full or blocked. Use "Export to file" instead.', 'bad', 'Save failed');
    return false;
  }
}

// ---------------------------------------------------------------- settings panel
registerPanel({
  key: 'settings', icon: '⚙️', title: 'Game', order: 90,
  render(app, body, st, rerender) {
    const s = app.state;
    const o = app.settings;
    body.innerHTML = `
      <div class="section-title">City</div>
      <label class="row"><span class="k">Name</span><input type="text" value="${s.cityName}" data-name></label>
      ${row('Map', `${s.mapName} (${s.climate})`)}${row('Today', formatDate(s.time.day, true))}
      <label class="row"><span class="k">Difficulty</span><select data-diff>${DIFFICULTY_KEYS.map((k) => `<option value="${k}" ${DIFFICULTIES[k] === difficultyOf(s) ? 'selected' : ''}>${DIFFICULTIES[k].name}</option>`).join('')}</select></label>
      <label class="row"><span class="k">Elections</span><input type="checkbox" data-elections ${s.options.elections === false ? '' : 'checked'}></label>
      <label class="row"><span class="k">Long-term climate change</span><input type="checkbox" data-climate ${s.options.climateChange === false ? '' : 'checked'}></label>
      <div class="muted" style="font-size:11px;margin:-2px 0 4px">${difficultyOf(s).blurb} ${difficultyRows(difficultyOf(s)).slice(1).map(([k, v]) => `${k} ${v}`).join(' · ')}${difficultyOf(s) === DIFFICULTIES.normal ? '' : '.'} Changing it doesn't touch the money you have.</div>
      <div class="section-title">Save</div>
      <div class="grid2"><button class="btn primary" data-a="save">💾 Save in browser</button><button class="btn" data-a="export">⬇ Export to file</button>
      <button class="btn" data-a="account" style="grid-column:span 2">👤 Account & cloud saves</button></div>
      <label class="row"><span class="k">Autosave every day</span><input type="checkbox" data-o="autosave" ${o.autosave ? 'checked' : ''}></label>
      <div class="section-title">Interface</div>
      <label class="row"><span class="k">Interface size</span><select data-ui>${UI_SIZES.map(([v, n]) => `<option value="${v}" ${v === (o.uiScale || 0.9) ? 'selected' : ''}>${n} (${Math.round(v * 100)}%)</option>`).join('')}</select></label>
      <div class="section-title">Graphics</div>
      <label class="row"><span class="k">Shadows</span><input type="checkbox" data-o="shadows" ${o.shadows ? 'checked' : ''}></label>
      <label class="row"><span class="k">Weather effects</span><input type="checkbox" data-o="weatherFx" ${o.weatherFx ? 'checked' : ''}></label>
      <label class="row"><span class="k">Show vehicles</span><input type="checkbox" data-o="vehicles" ${o.vehicles ? 'checked' : ''}></label>
      <div class="section-title">Camera</div>
      <label class="row"><span class="k">Tilt as you zoom</span><input type="checkbox" data-o="tiltWithZoom" ${o.tiltWithZoom ? 'checked' : ''}></label>
      <label class="row"><span class="k">Pan at the screen edge</span><input type="checkbox" data-o="edgeScroll" ${o.edgeScroll ? 'checked' : ''}></label>
      <div class="section-title">More</div>
      <div class="grid2"><button class="btn" data-a="photo">📷 Photo mode (P)</button><button class="btn" data-a="timelapse">🎞 Time-lapse</button><button class="btn" data-a="guide">📘 Beginner's guide</button>
      <button class="btn" data-a="editor">🛠 Editors & mods</button><button class="btn" data-a="menu">🏠 Main menu</button></div>
      <div class="muted" style="font-size:11px;margin-top:8px">Camera: wheel zooms toward the cursor · left drag (no tool) or middle drag pans · right drag rotates & tilts · double click flies there · WASD/arrows pan · Q/E rotate · Z/X zoom · T/G tilt · Home: back to town · Shift: faster<br>Tools: right click or Esc cancels · R rotates a building · Space pause · 1–3 speed · V resources · P photo mode</div>
      ${document.body.classList.contains('touch') ? '<div class="muted" style="font-size:11px;margin-top:6px">Touch: one finger pans (or uses the tool in hand) · two fingers pan, pinch to zoom and twist to rotate · three fingers up and down tilt · double tap flies there · hold a button to see what it does · ✕ Cancel (bottom right) stops a tool</div>' : ''}`;
    body.querySelector('[data-name]').onchange = (e) => { s.cityName = e.target.value || s.cityName; };
    body.querySelector('[data-diff]').onchange = (e) => {
      s.options.difficulty = e.target.value;
      app.toast(`Difficulty: ${DIFFICULTIES[e.target.value].name}`, 'info');
      rerender();
    };
    body.querySelector('[data-climate]').onchange = (e) => { s.options.climateChange = e.target.checked; rerender(); };
    body.querySelector('[data-elections]').onchange = (e) => { s.options.elections = e.target.checked; if (!e.target.checked && s.politics) s.politics.council = null; rerender(); };
    body.querySelector('[data-a="save"]').onclick = () => saveLocal(app);
    body.querySelector('[data-a="export"]').onclick = async () => {
      const text = await pack(s);
      download(`${s.cityName.replace(/\W+/g, '_')}.city`, URL.createObjectURL(new Blob([text], { type: 'text/plain' })));
    };
    body.querySelector('[data-a="photo"]').onclick = () => app.photoMode(true);
    body.querySelector('[data-a="timelapse"]').onclick = () => app.timelapse?.start();
    body.querySelector('[data-a="account"]').onclick = () => app.panels.open('account');
    body.querySelector('[data-a="guide"]').onclick = () => app.panels.open('guide');
    body.querySelector('[data-a="editor"]').onclick = () => app.panels.open('editors');
    body.querySelector('[data-a="menu"]').onclick = async () => {
      if (confirm('Save and return to the main menu?')) { await saveLocal(app, true); location.href = location.pathname; }
    };
    body.querySelectorAll('[data-o]').forEach((c) => (c.onchange = () => { o[c.dataset.o] = c.checked; app.applySettings(); }));
    body.querySelector('[data-ui]').onchange = (e) => { o.uiScale = +e.target.value; app.applyUiScale(); app.saveSettings(); };
  },
});

// Interface size: the whole interface (bars, menus, windows) is zoomed by this much
export const UI_SIZES = [[0.8, 'Small'], [0.9, 'Medium'], [1, 'Large'], [1.15, 'Extra large']];

// ---------------------------------------------------------------- beginner's guide
const GUIDE = [
  { t: 'Connect a road to the highway', tip: 'Roads → Small Road. Click the end of the highway, then click inside your land (curve it with the Curved mode).', done: (s, ctx) => { let n = 0; for (let i = 0; i < s.road.length; i++) if (s.road[i] && s.road[i] !== 6 && ctx.net.roadOutside[ctx.net.roadComp[i]]) n++; return n > 5; } },
  { t: 'Zone residential land', tip: 'Zoning → Low Density Housing, then click next to your road (Fill mode).', done: (s) => [...s.zone].some((z) => ZONES[z]?.cat === 'res') },
  { t: 'Zone commercial and industrial land', tip: 'Shops need customers, factories need workers. Keep industry a few blocks from homes: factory noise upsets residents.', done: (s) => [...s.zone].some((z) => ZONES[z]?.cat === 'com') && [...s.zone].some((z) => ZONES[z]?.cat === 'ind') },
  { t: 'Get electricity to your roads', tip: 'Build a power plant next to a road (it feeds the roads it touches; roads carry power to every building beside them), or run a Power Line from the outside power line (pylons at the map edge) and end it on one of your roads: a Power Connector is added there. Map → ⚡ Power grid shows what is connected.', done: (s, ctx) => (ctx.elecNets || []).some((n) => n.hasSource && n.demand > 0) },
  { t: 'Supply water and handle sewage', tip: 'Water → a pump next to clean water, and a sewage outlet downstream of it. Sewage drifts with the current (the placement preview shades where it goes); sewage upstream of a pump upsets everyone who drinks that water.', done: (s) => [...s.buildings.values()].some((b) => b.def.water) && [...s.buildings.values()].some((b) => b.def.sewage) },
  { t: 'Build a landfill', tip: 'Garbage → Landfill, then drag out an area next to a road: the bigger it is, the more it holds and the more garbage trucks it sends out. When it gets full, drag more area along its side.', done: (s) => [...s.buildings.values()].some((b) => b.def.garbageRate) },
  { t: 'Give workers somewhere to park', tip: 'Transport → Parking Lot, within a short walk of shops and offices. Drivers with nowhere to park can\'t get to work.', done: (s) => [...s.buildings.values()].some((b) => b.def.parking) },
  { t: 'Reach 100 citizens', tip: 'Watch the demand bars (top). Green = housing demand.', done: (s) => s.citizens.size >= 100 },
  { t: 'Check the weekly budget', tip: 'Open Economy (💰). Taxes and upkeep are paid together when Saturday ends; the top bar shows this week\'s projection.', done: (s, ctx, app) => app.panels.isOpen('economy') || s.counters.sawEconomy },
  { t: 'Reach your first milestone', tip: 'XP comes from population, happiness and building. Milestones unlock new buildings and give expansion permits.', done: (s) => s.progression.milestone >= 1 },
  { t: 'Add healthcare, schools, fire and police', tip: 'Once the town grows, people get upset without them nearby. Fire engines and police cars drive to emergencies, so cover every neighbourhood.', done: (s) => ['health', 'education', 'fire', 'police'].every((c) => [...s.buildings.values()].some((b) => b.def.cat === c)) },
  { t: 'See what makes people happy', tip: 'Click the happiness meter in the top bar: jobs, taxes, transport costs and factory noise matter most.', done: (s, ctx, app) => app.panels.isOpen('happiness') || s.counters.sawHappiness },
  { t: 'Spend a development point', tip: 'Progression (🏆) → Development. Perks and advanced buildings.', done: (s) => s.progression.dev.length > 0 },
  { t: 'Buy a new map tile', tip: 'Map Tiles in the toolbar. Costs money and an expansion permit. Press V (or the Map → Resources toggle) to see where the resources are first.', done: (s) => s.options.allTiles || (s.counters.tilesBought || 0) > 0 },
  { t: 'Create a bus line', tip: 'Transport → Bus Depot, then Bus line: click roads to add stops, click the first stop to finish. Riders walk to the stops.', done: (s) => s.lines.length > 0 },
  { t: 'Put a toll booth on a busy road', tip: 'Roads → Toll Booth. Every vehicle through it pays; set the toll in Economy → Services.', done: (s) => s.roadUpg.some((u) => u & 64) },
];

registerPanel({
  key: 'guide', icon: '📘', title: "Beginner's Guide", order: 2,
  render(app, body) {
    const s = app.state;
    if (app.panels.isOpen('economy')) s.counters.sawEconomy = true;
    let firstOpen = true;
    body.innerHTML = GUIDE.map((g, k) => {
      const done = g.done(s, app.ctx, app);
      const current = !done && firstOpen;
      if (current) firstOpen = false;
      return `<div class="list-item ${done ? 'done' : ''}" style="${current ? 'border-color:var(--accent)' : ''}"><b>${done ? '✅' : current ? '👉' : '⬜'} ${k + 1}. ${g.t}</b>${done ? '' : `<div class="muted" style="font-size:11.5px">${g.tip}</div>`}</div>`;
    }).join('');
  },
});

// ---------------------------------------------------------------- citizen viewer
registerPanel({
  key: 'citizen', icon: '🧑', title: 'Citizen', order: 3, rail: false,
  render(app, body, st) {
    const s = app.state;
    const id = st.args?.id;
    const c = s.citizens.get(id);
    if (!c) {
      body.innerHTML = `<div class="muted">This citizen is no longer in the city.</div>${st.lastLog ? `<div class="section-title">Life path</div>${st.lastLog}` : ''}
        <button class="btn" data-a="newborn" style="margin-top:8px">Follow a newborn</button>`;
    } else {
      const hh = s.households.get(c.hh);
      const home = hh && s.buildings.get(hh.home);
      const job = c.job && s.buildings.get(c.job);
      const school = c.school && s.buildings.get(c.school);
      const following = s.followCitizen === c.id;
      const log = (c.log || []).slice().reverse().map((e) => `<div class="row"><span>${e.text}</span><span class="muted num">age ${Math.max(0, Math.floor(c.age - (s.time.day - e.day)))}</span></div>`).join('');
      st.lastLog = log;
      body.innerHTML = `<h3 style="margin:0 0 6px">Citizen #${c.id}</h3>
        ${row('Age', `${Math.floor(c.age)} (${ageGroup(c.age)})`)}${row('Education', EDU_NAMES[c.edu])}
        ${row('Health', `${Math.round(c.health)}%${c.sick ? ' · sick' : ''}`)}${row('Well-being', `${Math.round(c.wellbeing)}%`)}
        ${row('Home', home ? home.name || home.def.name : 'Homeless')}${row('Household wealth', hh ? `₡${Math.round(hh.wealth).toLocaleString()}` : '–')}
        ${row('Work', job ? job.name || job.def.name : c.outsideJob ? 'In a neighbouring city (hyperloop)' : c.age >= AGE.adult && c.age < AGE.senior ? 'Unemployed' : '–')}${row('School', school ? school.def.name : '–')}
        ${c.jail ? row('Status', '<span class="bad">In jail</span>') : ''}
        <div style="display:flex;gap:6px;margin:8px 0"><button class="btn ${following ? '' : 'primary'}" data-a="follow">${following ? 'Stop following' : '👣 Follow'}</button><button class="btn" data-a="home">Go to home</button><button class="btn" data-a="newborn">Follow a newborn</button></div>
        <div class="section-title">Life path</div>${log || '<div class="muted">Nothing yet.</div>'}`;
      body.querySelector('[data-a="follow"]').onclick = () => {
        if (following) s.followCitizen = 0;
        else { s.followCitizen = c.id; s.followStart = s.time.day; }
        app.panels.refresh('citizen');
      };
      body.querySelector('[data-a="home"]').onclick = () => home && app.focusOn((home.x0 + home.x1) / 2, (home.y0 + home.y1) / 2);
    }
    body.querySelector('[data-a="newborn"]')?.addEventListener('click', () => {
      const babies = [...s.citizens.values()].filter((x) => x.age < 2);
      if (!babies.length) { app.toast('No newborns right now', 'warn'); return; }
      const b = babies[Math.floor(Math.random() * babies.length)];
      s.followCitizen = b.id; s.followStart = s.time.day;
      st.args = { id: b.id };
      app.panels.refresh('citizen');
    });
  },
});

export const metaFeature = {
  init(app, isNew) {
    const s = app.state;
    app.settings = { autosave: true, cloudAutosave: false, shadows: true, weatherFx: true, vehicles: true, tiltWithZoom: true, edgeScroll: false, uiScale: 0.9 };
    try { Object.assign(app.settings, JSON.parse(localStorage.getItem('gridlock-settings') || '{}')); } catch { /* storage unavailable */ }
    app.saveSettings = () => { try { localStorage.setItem('gridlock-settings', JSON.stringify(app.settings)); } catch { /* ignore */ } };
    app.applyUiScale = () => {
      const z = app.settings.uiScale || 0.9;
      app.uiScale = z;
      const ui = document.getElementById('ui');
      ui.style.zoom = z;
      ui.style.setProperty('--z', z);
      app.hud?.update?.();
      app.hud?.fit?.();
      app.toolbar?.resize?.();
    };
    app.applyUiScale();
    app.applySettings = () => {
      app.view.renderer.shadowMap.enabled = app.settings.shadows;
      app.view.sun.castShadow = app.settings.shadows;
      app.view.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
      app.fxEnabled = app.settings.weatherFx;
      app.vehiclesEnabled = app.settings.vehicles;
      app.view.cam.settings.tiltWithZoom = app.settings.tiltWithZoom;
      app.view.cam.settings.edgeScroll = app.settings.edgeScroll;
      try { localStorage.setItem('gridlock-settings', JSON.stringify(app.settings)); } catch { /* ignore */ }
    };
    app.applySettings();

    app.focusOn = (x, z, dist) => app.view.cam.flyTo(x, z, { dist: dist ?? Math.min(app.view.cam.goal.dist, 90) });

    // Photo mode: hide the UI, keep the camera, save a PNG
    const bar = document.createElement('div');
    bar.id = 'photo-bar';
    bar.innerHTML = '<button class="btn primary" data-a="shot">📸 Save picture</button><button class="btn" data-a="exit">Exit photo mode</button>';
    document.body.appendChild(bar);
    app.photoMode = (on) => {
      document.body.classList.toggle('photo', on);
      app.tools.set({ kind: 'select' });
    };
    bar.querySelector('[data-a="exit"]').onclick = () => app.photoMode(false);
    bar.querySelector('[data-a="shot"]').onclick = () => {
      app.view.renderer.render(app.view.scene, app.view.camera);
      download(`${s.cityName.replace(/\W+/g, '_')}_${s.time.day}.png`, app.view.renderer.domElement.toDataURL('image/png'));
      s.counters.photo++;
      bus.emit('photo');
    };
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'p' || e.key === 'P') app.photoMode(!document.body.classList.contains('photo'));
      if (e.key === 'Escape' && document.body.classList.contains('photo')) app.photoMode(false);
    });

    // Following a citizen: the camera keeps their home in view; finishing a whole life counts
    bus.on('follow:ended', ({ citizen, reason }) => {
      if (reason === 'died' && s.time.day - (s.followStart ?? s.time.day) >= 25) s.counters.followedLife = true;
      app.toast(`Citizen #${citizen.id} ${reason === 'died' ? 'passed away' : 'left the city'}.`, 'info', '👣 Life path ended');
      s.followCitizen = 0;
      app.panels.refresh('citizen');
    });

    // Autosave when a day ends, at most every couple of minutes, when the browser has a moment
    // (packing a big city takes a while, so it shouldn't land in the middle of a busy frame)
    let lastSave = performance.now();
    // (test cities started from the URL, ?map=..., never overwrite your saved city)
    const testCity = new URLSearchParams(location.search).has('map');
    registerSystem({ name: 'autosave', every: 'dayEnd', run: () => {
      if (testCity || !app.settings.autosave || performance.now() - lastSave < 120000) return;
      lastSave = performance.now();
      const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 50));
      idle(() => saveLocal(app, true), { timeout: 4000 });
    } });
    if (isNew && s.options.tutorial) setTimeout(() => app.panels.open('guide'), 400);
    bus.on('panel:open', (k) => { if (k === 'economy') s.counters.sawEconomy = true; if (k === 'happiness') s.counters.sawHappiness = true; });
  },
};

