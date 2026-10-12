// Editors & modding: save the current terrain as a custom map, design simple buildings in
// the asset editor, and load data-only mods (JSON building definitions). Scripting is
// available through window.city in the browser console.
import { registerPanel } from '../ui/panels.js';
import { registerCategory } from '../ui/toolbar.js';
import { registerDefs, defFor } from '../data/registry.js';
import { SERVICE_CATS } from '../data/services.js';
import { serialize } from '../sim/save.js';
import { addCustomMap } from '../sim/store.js';
import { money } from '../ui/tools.js';
import { bus } from '../core/events.js';

// Fields a mod/asset may set on a service building definition (everything else is ignored)
const ALLOWED = ['name', 'cat', 'cost', 'upkeep', 'w', 'd', 'radius', 'leisure', 'attract', 'power', 'water', 'sewage', 'health', 'patients',
  'engines', 'patrol', 'cells', 'mail', 'net', 'students', 'eduLevel', 'garbageRate', 'storage', 'deathRate', 'workers', 'height', 'color', 'accent', 'desc', 'pollution', 'milestone'];

export function buildAssetDef(spec) {
  const def = { id: spec.id, kind: 'service', custom: true };
  for (const k of ALLOWED) if (spec[k] !== undefined) def[k] = spec[k];
  def.cat = SERVICE_CATS[def.cat] ? def.cat : 'parks';
  def.w = Math.max(1, Math.min(6, Math.round(def.w || 1)));
  def.d = Math.max(1, Math.min(6, Math.round(def.d || 1)));
  def.cost = Math.max(0, +def.cost || 0);
  def.upkeep = Math.max(0, +def.upkeep || 0);
  def.name = String(def.name || 'Custom building').slice(0, 40);
  if (spec.shapeKind) {
    const h = Math.max(0.2, (spec.floors || 1) * 0.38);
    const body = { pool: 'body', x: 0, z: 0, w: def.w * 0.85, d: def.d * 0.8, h, y: 0, color: spec.wall || '#d8d4cc' };
    const top = spec.shapeKind === 'gable' ? { pool: 'roof', x: 0, z: 0, w: def.w * 0.9, d: def.d * 0.85, h: 0.45, y: h, color: spec.roof || '#8b3a2a' }
      : spec.shapeKind === 'dome' ? { pool: 'dome', x: 0, z: 0, w: Math.min(def.w, def.d) * 0.7, d: Math.min(def.w, def.d) * 0.7, h: Math.min(def.w, def.d) * 0.35, y: h, color: spec.roof || '#7fa8b8' }
        : { pool: 'plain', x: 0, z: 0, w: def.w * 0.6, d: def.d * 0.5, h: 0.12, y: h, color: spec.roof || '#888' };
    def.shape = [body, top];
    if (spec.lawn) def.shape.unshift({ pool: 'plain', x: 0, z: 0, w: def.w * 0.98, d: def.d * 0.98, h: 0.06, y: 0, color: '#7fb35a' });
  }
  return def;
}

export function registerCustom(state, spec, source) {
  const def = buildAssetDef(spec);
  registerDefs('service', { [def.id]: def });
  if (!state.customAssets) state.customAssets = [];
  if (!state.customAssets.some((a) => a.id === spec.id)) state.customAssets.push({ ...spec, source });
  bus.emit('unlocks:changed');
  return def;
}

registerPanel({
  key: 'editors', icon: '🛠', title: 'Editors & Mods', order: 95, rail: false,
  render(app, body, st, rerender) {
    const s = app.state;
    body.innerHTML = `
      <div class="section-title">Map editor</div>
      <div class="muted" style="font-size:11.5px">Shape the land with Landscaping (raise, lower, level, soften, trees), then save it as a new map. It appears on the start screen.</div>
      <label class="row"><span class="k">Map name</span><input type="text" data-map value="${s.cityName} Terrain"></label>
      <button class="btn" data-a="savemap">🗺 Save terrain as map</button>

      <div class="section-title">Asset editor</div>
      <div class="grid2">
        <label>Name <input type="text" data-f="name" value="My Landmark"></label>
        <label>Category <select data-f="cat">${Object.entries(SERVICE_CATS).filter(([k]) => k !== 'transport').map(([k, c]) => `<option value="${k}" ${k === 'parks' ? 'selected' : ''}>${c.name}</option>`).join('')}</select></label>
        <label>Width <input type="number" data-f="w" min="1" max="6" value="2"></label>
        <label>Depth <input type="number" data-f="d" min="1" max="6" value="2"></label>
        <label>Floors <input type="number" data-f="floors" min="1" max="30" value="3"></label>
        <label>Roof <select data-f="shapeKind"><option value="flat">Flat</option><option value="gable">Gable</option><option value="dome">Dome</option></select></label>
        <label>Wall <input type="color" data-f="wall" value="#d9c9a8"></label>
        <label>Roof colour <input type="color" data-f="roof" value="#7fa8b8"></label>
        <label>Leisure (0–2) <input type="number" data-f="leisure" min="0" max="2" step="0.1" value="0.8"></label>
        <label>Attractiveness <input type="number" data-f="attract" min="0" max="20" value="4"></label>
      </div>
      <label class="row"><span class="k">Lawn around it</span><input type="checkbox" data-f="lawn" checked></label>
      <button class="btn primary" data-a="asset">✨ Create asset</button>
      ${(s.customAssets || []).length ? `<div class="muted" style="margin-top:6px">Your assets (in the toolbar under Custom): ${s.customAssets.map((a) => a.name).join(', ')}</div>` : ''}

      <div class="section-title">Mods (data)</div>
      <div class="muted" style="font-size:11.5px">Paste a JSON array of building definitions, e.g.<br><code>[{"id":"mod_solar_farm","name":"Solar Farm","cat":"electricity","power":25,"cost":90000,"upkeep":1500,"w":3,"d":3,"color":"#2e4a7a"}]</code></div>
      <textarea data-mod rows="4" style="width:100%;margin:6px 0"></textarea>
      <button class="btn" data-a="mod">📦 Load mod</button>
      <div class="section-title">Scripting</div>
      <div class="muted" style="font-size:11.5px">Open the browser console: <code>city.state</code> is the whole city, <code>city.toast('hi')</code> shows a message, and <code>city.registerSystem({ every: 'day', run(state) {...} })</code> adds your own simulation logic.</div>`;

    body.querySelector('[data-a="savemap"]').onclick = () => {
      const name = body.querySelector('[data-map]').value.trim() || 'Custom map';
      const data = JSON.parse(serialize(s));
      const keep = ['height', 'fertile', 'ore', 'oil', 'groundwater', 'forestMax', 'tree', 'water'];
      const map = { id: `custom_${Date.now()}`, name, base: s.mapId, climate: s.climate, theme: s.theme, layers: Object.fromEntries(keep.map((k) => [k, data[k]])) };
      addCustomMap(map).then(() => {
        s.counters.mapsCreated = (s.counters.mapsCreated || 0) + 1;
        app.toast(`"${name}" is now on the start screen.`, 'good', 'Map saved');
        app.checkAchievements?.();
      }, () => app.toast('Could not save the map (browser storage full?)', 'bad'));
    };
    body.querySelector('[data-a="asset"]').onclick = () => {
      const spec = { id: `custom_${Date.now()}` };
      body.querySelectorAll('[data-f]').forEach((el) => {
        const k = el.dataset.f;
        spec[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? +el.value : el.value;
      });
      spec.radius = spec.leisure > 0 ? 6 + spec.w * 2 : 0;
      spec.cost = Math.round((spec.w * spec.d * 2500 + spec.floors * 800 + spec.attract * 1500) / 500) * 500;
      spec.upkeep = Math.round(spec.cost * 0.03);
      spec.height = spec.floors;
      spec.desc = 'Made in the asset editor';
      registerCustom(s, spec, 'editor');
      s.counters.assetsCreated = (s.counters.assetsCreated || 0) + 1;
      app.toast(`${spec.name} (${money(spec.cost)}) is in the Custom menu.`, 'good', 'Asset created');
      app.checkAchievements?.();
      rerender();
    };
    body.querySelector('[data-a="mod"]').onclick = () => {
      try {
        const list = JSON.parse(body.querySelector('[data-mod]').value);
        if (!Array.isArray(list)) throw new Error('Expected a JSON array');
        let n = 0;
        for (const spec of list) {
          if (!spec || typeof spec.id !== 'string' || !/^[\w-]{3,40}$/.test(spec.id)) continue;
          registerCustom(s, { ...spec, id: spec.id.startsWith('mod_') ? spec.id : `mod_${spec.id}` }, 'mod');
          n++;
        }
        app.toast(`Loaded ${n} building${n === 1 ? '' : 's'} into the Custom menu`, 'good', 'Mod loaded');
        rerender();
      } catch (e) { app.toast(e.message, 'bad', 'Mod error'); }
    };
  },
});

export const editorsFeature = {
  init(app) {
    const s = app.state;
    for (const spec of s.customAssets || []) registerDefs('service', { [spec.id]: buildAssetDef(spec) });
    registerCategory({
      key: 'custom', icon: '🧱', name: 'Custom', order: 82,
      items: () => {
        const list = (s.customAssets || []).map((spec) => {
          const def = buildAssetDef(spec);
          return { group: spec.source === 'mod' ? 'Mods' : 'Your assets', name: def.name, color: SERVICE_CATS[def.cat]?.color, meta: `${money(def.cost)} · ${SERVICE_CATS[def.cat]?.name}`,
            tool: { kind: 'plop', def: defFor('service', def.id) || def }, isActive: (t) => t.kind === 'plop' && t.def.id === def.id };
        });
        return [...list, { group: 'Create', name: 'Open the editors', color: '#888', meta: 'Asset editor, map editor, mods', onPick: (a) => a.panels.open('editors') }];
      },
    });
    app.registerSystem = (sys) => import('../sim/simulation.js').then((m) => m.registerSystem(sys));
  },
};

