// Start screen: pick a map (with a generated preview), name the city, choose options.
import { MAPS, CLIMATES } from '../data/maps.js';
import { createState } from '../core/state.js';
import { generateMap, cellHeight, applyCustomMap, START_TILE_MIN } from '../sim/mapgen.js';
import { N, idx, TILE } from '../core/grid.js';
import { MAPS_KEY } from '../sim/save.js';
import { accountStatus, renderAuthForm, renderCityList, esc } from './accountUI.js';
import { setToken } from '../net/api.js';
import { DIFFICULTIES, DIFFICULTY_KEYS, difficultyRows } from '../data/difficulty.js';

export function customMaps() {
  try {
    return JSON.parse(localStorage.getItem(MAPS_KEY) || '[]').map((m) => {
      const base = MAPS.find((b) => b.id === m.base) || MAPS[0];
      return { ...base, id: m.id, name: m.name, custom: m, desc: `Custom map based on ${base.name}.` };
    });
  } catch { return []; }
}

function drawPreview(canvas, map) {
  const st = createState(map);
  generateMap(st, map);
  if (map.custom) applyCustomMap(st, map.custom);
  const S = 136;
  canvas.width = S; canvas.height = S;
  const g = canvas.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const cx = Math.floor((x / S) * N), cy = Math.floor((y / S) * N);
      const i = idx(cx, cy);
      const h = cellHeight(st, cx, cy) - st.seaLevel;
      let r, gg, b;
      if (st.water[i]) { r = 40; gg = 110 + h * 10; b = 170 + h * 8; }
      else if (st.power[i]) { r = 255; gg = 211; b = 0; }
      else if (st.road[i] || st.rail[i]) { r = 60; gg = 60; b = 66; }
      else {
        const t = Math.min(1, h / 18);
        r = 100 + t * 130; gg = 150 + t * 80 + (st.tree[i] ? -30 : 0); b = 80 + t * 150;
        if (st.tree[i]) { r -= 40; b -= 20; }
      }
      const o = (y * S + x) * 4;
      img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // starting area outline (the 3 × 3 tiles in the middle)
  const a = (START_TILE_MIN * TILE / N) * S, w = (3 * TILE / N) * S;
  g.strokeStyle = '#ffd300';
  g.lineWidth = 1.5;
  g.strokeRect(a, a, w, w);
}

export function showMenu({ onNew, onContinue, onLoadFile, onLoadCloud, hasSave }) {
  const el = document.getElementById('menu');
  el.classList.remove('hidden');
  let chosen = MAPS[0];
  el.innerHTML = `
    <nav class="menu-nav"><span class="mark">C</span><span class="title">CityBuilder</span><span class="spec t-spec">CityBuilder // three.js</span></nav>
    <div class="menu-box">
      <div class="menu-hero">
        <h1 id="m-title">CityBuilder</h1>
        <p class="motto">Zone it, power it,<br><em>keep it moving</em></p>
      </div>

      <div class="board-head"><span class="n">01</span><h2>Choose a map</h2><span class="connector"></span><span class="spec t-spec">${MAPS.length} regions</span></div>
      <div class="map-grid" id="maps"></div>

      <div class="board-head"><span class="n">02</span><h2>Found your city</h2><span class="connector"></span><span class="spec t-spec">Options</span></div>
      <div class="menu-difficulty">
        <div class="md-head"><b>Difficulty</b><div class="md-seg" id="m-diff">${DIFFICULTY_KEYS.map((k) => `<button data-d="${k}" class="${k === 'normal' ? 'on' : ''}">${DIFFICULTIES[k].name}</button>`).join('')}</div></div>
        <div class="md-info" id="m-diff-info"></div>
      </div>
      <div class="menu-options">
        <label>City name <input type="text" id="m-name" value="New Harbor" maxlength="24"></label>
        <label><span>Natural disasters<small>Fires, storms, tornadoes</small></span><input type="checkbox" id="m-dis" checked></label>
        <label><span>Beginner's guide<small>Step-by-step goals</small></span><input type="checkbox" id="m-tut" checked></label>
        <label><span>Unlimited money<small>Sandbox</small></span><input type="checkbox" id="m-money"></label>
        <label><span>Unlock everything<small>Sandbox</small></span><input type="checkbox" id="m-unlock"></label>
        <label><span>Whole map from the start<small>Off: start on 9 tiles, buy more</small></span><input type="checkbox" id="m-tiles"></label>
        <label><span>Instant construction<small>Sandbox: buildings appear finished</small></span><input type="checkbox" id="m-instant"></label>
      </div>
      <div class="menu-actions">
        <button class="btn primary" id="m-new">Found city</button>
        ${hasSave ? '<button class="btn" id="m-cont">Continue saved city</button>' : ''}
        <button class="btn" id="m-file">Load from file…</button>
        <input type="file" id="m-fileinput" accept=".json,.city" hidden>
      </div>
      <div id="m-legacy" class="menu-legacy" hidden></div>

      <div class="board-head"><span class="n">03</span><h2>Your account</h2><span class="connector"></span><span class="spec t-spec">Cloud saves</span></div>
      <div id="m-account" class="menu-account muted">Checking…</div>
      <div class="menu-keys">
        Controls: wheel zooms toward the cursor · <b>left drag</b> (no tool) or middle drag pans · <b>right drag</b> rotates & tilts · double click flies there ·
        <b>WASD</b>/arrows pan · <b>Q/E</b> rotate · <b>Z/X</b> zoom · <b>T/G</b> tilt · <b>Home</b> back to town ·
        <b>Esc</b> or right click cancels a tool · <b>Space</b> pause · <b>1–3</b> speed · <b>R</b> rotate building · <b>V</b> resources · <b>P</b> photo mode
      </div>
      <div class="menu-keys menu-touch">
        Touch: <b>one finger</b> pans (or uses the tool in hand) · <b>two fingers</b> pan, pinch to zoom and twist to rotate · <b>three fingers</b> up and down tilt ·
        <b>double tap</b> flies there · <b>hold</b> a button to see what it does · <b>✕ Cancel</b> (bottom right) stops a tool
      </div>
    </div>`;
  let difficulty = 'normal';
  const diffInfo = () => {
    const d = DIFFICULTIES[difficulty];
    el.querySelector('#m-diff-info').innerHTML = `<span>${d.blurb}</span>${difficultyRows(d).map(([k, v]) => `<span class="md-row">${k} <b>${v}</b></span>`).join('')}`;
  };
  el.querySelectorAll('#m-diff [data-d]').forEach((b) => (b.onclick = () => {
    difficulty = b.dataset.d;
    el.querySelectorAll('#m-diff [data-d]').forEach((x) => x.classList.toggle('on', x === b));
    diffInfo();
  }));
  diffInfo();
  const grid = el.querySelector('#maps');
  const allMaps = [...MAPS, ...customMaps()];
  for (const map of allMaps) {
    const card = document.createElement('button');
    card.className = 'map-card';
    if (map === chosen) card.classList.add('on');
    const cl = CLIMATES[map.climate];
    const conn = Object.entries(map.connections).filter(([, v]) => v).map(([k]) => ({ road: '🛣️', rail: '🚆', ship: '🚢', air: '✈️' })[k]).join(' ');
    const no = String(allMaps.indexOf(map) + 1).padStart(2, '0');
    card.innerHTML = `<canvas></canvas><div class="mc-head"><b>${map.name}</b><span class="t-spec">${no}</span></div><div class="t-spec">${cl.name} · ${cl.minT}…${cl.maxT}°C · ${conn}</div><div class="desc">${map.desc}</div>`;
    card.onclick = () => {
      chosen = map;
      grid.querySelectorAll('.map-card').forEach((c) => c.classList.remove('on'));
      card.classList.add('on');
    };
    grid.appendChild(card);
    // Generate previews lazily (one at a time) so the menu appears instantly
    setTimeout(() => drawPreview(card.querySelector('canvas'), map), 40 + allMaps.indexOf(map) * 60);
  }
  el.querySelector('#m-new').onclick = () => {
    el.classList.add('hidden');
    onNew(chosen, {
      cityName: el.querySelector('#m-name').value.trim() || 'New City',
      difficulty,
      disasters: el.querySelector('#m-dis').checked,
      unlimitedMoney: el.querySelector('#m-money').checked,
      unlockAll: el.querySelector('#m-unlock').checked,
      tutorial: el.querySelector('#m-tut').checked,
      allTiles: el.querySelector('#m-tiles').checked,
      instantBuild: el.querySelector('#m-instant').checked,
    });
  };
  el.querySelector('#m-cont')?.addEventListener('click', () => { el.classList.add('hidden'); onContinue(); });
  // cities from before the road network update: kept, and downloadable (sim/legacy.js)
  import('../sim/legacy.js').then(async ({ listLegacy, downloadLegacy }) => {
    const list = (await listLegacy()).sort((a, b) => b.keptAt - a.keptAt);
    if (!list.length) return;
    const box = el.querySelector('#m-legacy');
    box.hidden = false;
    box.innerHTML = `<p class="muted">Roads are now drawn freely, as points joined by curves, instead of on the grid. ${list.length === 1 ? 'This city was' : 'These cities were'} built with grid roads and can't be opened in this version, but ${list.length === 1 ? 'it has' : 'they have'} been kept safe:</p>`
      + list.map((r, k) => `<div class="row"><span><b>${esc(r.name)}</b> <span class="muted">· kept ${new Date(r.keptAt).toLocaleDateString()}</span></span><button class="btn" data-k="${k}">Download</button></div>`).join('');
    box.querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => downloadLegacy(list[+b.dataset.k])));
  }).catch(() => {});
  const acc = el.querySelector('#m-account');
  const drawAccount = async () => {
    const status = await accountStatus();
    if (!status.available) {
      acc.innerHTML = `Accounts are offline (${esc(status.reason)}) — cities still save in this browser.`;
      return;
    }
    if (!status.user) {
      acc.innerHTML = '<div style="max-width:320px" data-auth></div>';
      renderAuthForm(acc.querySelector('[data-auth]'), drawAccount);
      return;
    }
    acc.innerHTML = `<div class="row" style="max-width:520px"><span>Signed in as <b>${esc(status.user.name || status.user.email)}</b></span><button class="btn" data-out>Sign out</button></div><div data-list style="max-width:520px;margin-top:6px"></div>`;
    acc.querySelector('[data-out]').onclick = () => { setToken(null); drawAccount(); };
    renderCityList(acc.querySelector('[data-list]'), { onLoad: (city) => { el.classList.add('hidden'); onLoadCloud(city); } });
  };
  drawAccount();
  const fi = el.querySelector('#m-fileinput');
  el.querySelector('#m-file').onclick = () => fi.click();
  fi.onchange = async () => {
    const f = fi.files[0];
    if (!f) return;
    el.classList.add('hidden');
    onLoadFile(await f.text());
  };
}
