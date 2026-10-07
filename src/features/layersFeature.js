// Map layers: a strip of toggles at the bottom left. "Resources" paints where the natural
// resources are (fertile land, forest, ore, oil, groundwater) with a legend you can filter;
// the other toggles hide map assets (trees, buildings, traffic, power lines, problem icons)
// so the ground is easy to read. Choices are remembered in this browser.
import { N, idx, TILE, TILES } from '../core/grid.js';
import { bus } from '../core/events.js';

const KEY = 'gridlock-layers';
export const RESOURCE_LAYERS = [
  { key: 'ore', name: 'Ore', color: [47, 85, 255], icon: '⛏️', amount: (s, i) => s.ore[i] },
  { key: 'oil', name: 'Oil', color: [255, 91, 46], icon: '🛢️', amount: (s, i) => s.oil[i] },
  { key: 'fertile', name: 'Fertile land', color: [255, 211, 0], icon: '🌾', amount: (s, i) => s.fertile[i] },
  { key: 'forest', name: 'Forest (forestry)', color: [63, 191, 90], icon: '🌲', amount: (s, i) => (s.forestMax[i] ? 0.4 + s.tree[i] * 0.2 : 0) },
  { key: 'groundwater', name: 'Groundwater', color: [54, 209, 255], icon: '💧', amount: (s, i) => (s.groundwater[i] > 0.15 ? s.groundwater[i] : 0) },
];
const ASSETS = [
  ['resources', '⛏️', 'Resources'],
  ['grid', '⚡', 'Power grid'],
  ['trees', '🌲', 'Trees'],
  ['buildings', '🏢', 'Buildings'],
  ['traffic', '🚗', 'Traffic'],
  ['power', '🔌', 'Power lines'],
  ['icons', '⚠️', 'Alerts'],
];
const TIPS = {
  resources: 'Show where the natural resources are (V)',
  grid: 'Show which roads and buildings are connected to power, and whether they get enough',
};

export const layersFeature = {
  init(app) {
    const { state } = app;
    const L = { resources: false, trees: true, buildings: true, traffic: true, power: true, icons: true, show: { ore: true, oil: true, fertile: true, forest: true, groundwater: true }, peek: null };
    try { Object.assign(L, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* storage unavailable */ }
    L.peek = null;
    app.layers = L;

    const bar = document.createElement('div');
    bar.id = 'layers';
    document.getElementById('ui').appendChild(bar);
    const legend = document.createElement('div');
    legend.id = 'res-legend';
    document.getElementById('ui').appendChild(legend);

    const save = () => { try { const { peek, dismissed, ...keep } = L; localStorage.setItem(KEY, JSON.stringify(keep)); } catch { /* ignore */ } };
    const resourcesOn = () => L.resources || !!L.peek;

    function paint() {
      const d = app.terrain.resData;
      const only = L.peek ? new Set([L.peek]) : null;
      const shown = RESOURCE_LAYERS.filter((r) => (only ? only.has(r.key) : L.show[r.key]));
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const i = idx(x, y);
          const o = i * 4;
          d[o + 3] = 0;
          if (state.water[i]) continue;
          for (const r of shown) {
            const v = r.amount(state, i);
            if (v <= 0.05) continue;
            // groundwater is drawn as a checker so it reads as "under the ground"
            if (r.key === 'groundwater' && (x + y) % 2) break;
            d[o] = r.color[0]; d[o + 1] = r.color[1]; d[o + 2] = r.color[2];
            d[o + 3] = 95 + Math.min(1, v) * 140;
            break;
          }
        }
      }
      app.terrain.resTex.needsUpdate = true;
    }

    function counts() {
      const out = {};
      for (const r of RESOURCE_LAYERS) out[r.key] = { owned: 0, all: 0 };
      for (let i = 0; i < N * N; i++) {
        if (state.water[i]) continue;
        const x = i % N, y = (i / N) | 0;
        const owned = state.tiles[((y / TILE) | 0) * TILES + ((x / TILE) | 0)];
        for (const r of RESOURCE_LAYERS) {
          if (r.amount(state, i) <= 0.05) continue;
          out[r.key].all++;
          if (owned) out[r.key].owned++;
        }
      }
      return out;
    }

    function renderLegend() {
      const on = resourcesOn();
      legend.classList.toggle('open', on);
      if (!on) return;
      const c = counts();
      const ha = (n) => `${((n * 64) / 10000).toFixed(1)} ha`;
      legend.innerHTML = `<button class="box-close" title="Hide resources (V)">✕</button><b>${L.peek ? 'Forest resource' : 'Natural resources'}</b>
        ${RESOURCE_LAYERS.filter((r) => !L.peek || r.key === L.peek).map((r) => `<label class="res-row ${L.show[r.key] || L.peek ? '' : 'off'}">
          <input type="checkbox" data-r="${r.key}" ${L.show[r.key] || L.peek ? 'checked' : ''} ${L.peek ? 'disabled' : ''}>
          <i style="background:rgb(${r.color.join(',')})"></i><span>${r.name}</span><em>${ha(c[r.key].owned)} <small>/ ${ha(c[r.key].all)}</small></em></label>`).join('')}
        <div class="res-note">Area on your land / on the whole map. Specialized industry needs its resource under the lot; clearing forest removes the forestry resource.</div>`;
      legend.querySelectorAll('[data-r]').forEach((cb) => (cb.onchange = () => { L.show[cb.dataset.r] = cb.checked; save(); apply(); }));
      legend.querySelector('.box-close').onclick = () => {
        // closing it while a tool shows a resource hides it until that tool is put away
        if (L.peek) { L.dismissed = L.peek; L.peek = null; }
        L.resources = false;
        save();
        apply();
      };
    }

    function apply() {
      app.terrain.res.visible = resourcesOn();
      if (resourcesOn()) paint();
      renderLegend();
      app.trees.setVisible(L.trees);
      app.buildings.setVisible(L.buildings);
      app.power.setVisible(L.power);
      app.icons.visible = L.icons;
      bar.querySelectorAll('[data-l]').forEach((b) => b.classList.toggle('on', b.dataset.l === 'grid' ? app.infoViews?.current?.key === 'electricity' : !!L[b.dataset.l]));
    }
    app.applyLayers = apply;
    // Tools can show one resource while they're active (e.g. the clear-trees tool shows forest)
    app.peekResource = (key) => {
      if (!key) L.dismissed = null;
      else if (key === L.dismissed) return;
      if ((key || null) === L.peek) return;
      L.peek = key || null;
      apply();
    };

    bar.innerHTML = `<span class="layers-title t-spec">Map</span>${ASSETS.map(([k, ico, name]) => `<button data-l="${k}" data-tip="${TIPS[k] || `Show or hide ${name.toLowerCase()}`}"><span>${ico}</span>${name}</button>`).join('')}`;
    bar.querySelectorAll('[data-l]').forEach((b) => (b.onclick = () => {
      if (b.dataset.l === 'grid') { app.setPowerView(app.infoViews.current?.key !== 'electricity'); apply(); return; }
      L[b.dataset.l] = !L[b.dataset.l]; save(); apply();
    }));
    bus.on('infoview:changed', () => apply());
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'v' || e.key === 'V') { L.resources = !L.resources; save(); apply(); }
    });

    // Resources change as they're mined, forests regrow or get cleared, and land is bought
    let pending = false;
    const refresh = () => {
      if (!resourcesOn() || pending) return;
      pending = true;
      setTimeout(() => { pending = false; if (resourcesOn()) { paint(); renderLegend(); } }, 250);
    };
    bus.on('trees:changed', refresh);
    bus.on('day', refresh);
    bus.on('tiles:changed', refresh);
    apply();
  },
};
