// Entry point: start menu -> build the world views, UI and simulation -> game loop.
import '@fontsource-variable/saira/wdth.css';
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '@fontsource/instrument-serif/latin-400.css';
import { createState } from './core/state.js';
import { bus } from './core/events.js';
import { generateMap, applyCustomMap, addPowerConnection, recomputeWater, bridgeConnections } from './sim/mapgen.js';
import { gradeAlongSegment } from './sim/grade.js';
import { isOwned } from './sim/build.js';
import { bridgeWaterRuns, migrateRoadNodes } from './sim/bridges.js';
import { createScene } from './world/scene.js';
import { N } from './core/grid.js';
import { createTerrainView } from './world/terrainView.js';
import { createBuildingsView } from './world/buildingsView.js';
import { createNetworksView } from './world/networksView.js';
import { createTreesView } from './world/treesView.js';
import { createOverlays } from './world/overlays.js';
import { createPreview } from './world/preview.js';
import { createPowerView } from './world/powerView.js';
import { migratePowerLines, addLegacyConnectors } from './sim/power.js';
import { createSimulation, createContext, registerSystem, hourOf, seasonOf } from './sim/simulation.js';
import { growthStep } from './sim/growth.js';
import { createTools } from './ui/tools.js';
import './ui/toolsExtra.js';
import './ui/toolsPower.js';
import './ui/categories.js';
import { createHud } from './ui/hud.js';
import { createToolbar } from './ui/toolbar.js';
import { createUndoBar } from './ui/undoBar.js';
import { createUndo } from './sim/undo.js';
import { createPanels } from './ui/panels.js';
import { initHoverTips } from './ui/hovertips.js';
import { initTouch } from './ui/touch.js';
import { showMenu } from './ui/menu.js';
import { MAPS } from './data/maps.js';
import { features } from './features.js';
import { SAVE_KEY } from './sim/save.js';
import { PENDING_LOAD, PENDING_CLOUD } from './features/accountFeature.js';

const canvas = document.getElementById('scene');
const view = createScene(canvas);

registerSystem({ name: 'growth', every: 'step', run: growthStep });

function startGame(state, isNew) {
  const ctx = createContext();
  const app = { state, ctx, view };
  window.city = app; // handy for debugging and for mods (see features/modding)
  view.cam.state = state;
  view.cam.setView({ x: N / 2, z: N / 2, dist: 120, yaw: 0.65, pitch: 0.9 });

  app.terrain = createTerrainView(view, state);
  app.buildings = createBuildingsView(view, state);
  app.networks = createNetworksView(view, state);
  app.trees = createTreesView(view, state);
  app.overlays = createOverlays(app);
  app.preview = createPreview(view, state);
  app.power = createPowerView(view, state);
  if (!isNew) {
    for (const layer of ['road', 'rail', 'path']) bridgeWaterRuns(state, layer);
    migratePowerLines(state);
    addPowerConnection(state); // older cities get the outside power line too
    if ((state.version || 2) < 3) { addLegacyConnectors(state); state.version = 3; }
    if (state.version < 4) { migrateRoadNodes(state); state.version = 4; }
    if (state.version < 5) {
      for (const sg of state.roadSegs || []) gradeAlongSegment(state, sg);
      recomputeWater(state);
      app.terrain.updateHeights();
      state.version = 5;
    }
    if (state.version < 6) {
      // road off your land is now kept up by the region: it starts out mended
      for (let i = 0; i < N * N; i++) if (state.road[i] && !isOwned(state, i % N, (i / N) | 0)) state.roadCond[i] = 1;
      // the old flat bridges on the outside highway and railway, with a sudden ramp at each
      // end, are rebuilt like the player's own (any that already meet that are kept)
      if (bridgeConnections(state, { onlyBad: true })) {
        recomputeWater(state);
        app.terrain.updateHeights();
        bus.emit('network:changed', { layer: 'road' });
        bus.emit('network:changed', { layer: 'rail' });
      }
      state.version = 6;
    }
    if (state.version < 7) {
      // forest used to grow back over railway track and footpaths: clear it off them
      let cleared = 0;
      for (let i = 0; i < N * N; i++) {
        if (!state.rail[i] && !state.path[i]) continue;
        if (state.tree[i]) cleared++;
        state.tree[i] = 0;
        state.forestMax[i] = 0;
      }
      if (cleared) bus.emit('trees:changed');
      state.version = 7;
    }
  }
  app.sim = createSimulation(state, ctx);
  app.sim.refreshNetworks();
  app.undo = createUndo(state);

  app.toast = (msg, kind = 'info', title = '') => {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.innerHTML = `<button class="box-close" title="Dismiss">✕</button>${title ? `<b>${title}</b>` : ''}${msg}`;
    t.querySelector('.box-close').onclick = () => t.remove();
    const box = document.getElementById('toasts');
    box.appendChild(t);
    // a few at a time: the oldest make way
    while (box.children.length > 3) box.firstElementChild.remove();
    setTimeout(() => t.remove(), kind === 'bad' ? 5000 : 4000);
  };
  app.setSpeed = (s) => {
    if (s === 0) state.time.paused = !state.time.paused;
    else { state.time.speed = s; state.time.paused = false; }
  };
  // Replaced by the progression feature; until then only milestone numbers are checked.
  app.lockReason = (def) => (state.options.unlockAll || !def.milestone || def.milestone <= state.progression.milestone ? null : `Milestone ${def.milestone}`);

  // Underground layers (pipes, subway) are shown while a related tool or info view is active
  const layerHints = new Set();
  app.setLayerHint = (layer, on) => {
    if (!layer) return;
    if (on) layerHints.add(layer); else layerHints.delete(layer);
    app.networks.setLayerVisibility({ subway: layerHints.has('subway'), pipes: layerHints.has('pipe') });
    if (app.vehicles) app.vehicles.showUnderground = layerHints.has('subway');
  };
  app.tools = createTools(app);
  initHoverTips();
  initTouch(app);
  app.hud = createHud(app);
  app.panels = createPanels(app);

  // Feature modules (services, economy, citizens, traffic...) hook in here.
  for (const f of features) f.init?.(app, isNew);
  app.toolbar = createToolbar(app);
  app.undoBar = createUndoBar(app);

  // --- world events -> views
  for (const b of state.buildings.values()) app.buildings.add(b);
  const plant = (b) => b.def.power || b.def.battery;
  bus.on('building:add', (b) => { app.buildings.add(b); app.overlays.dirty = true; if (plant(b)) app.power.dirty = true; });
  bus.on('building:remove', (b) => { app.buildings.remove(b); app.overlays.dirty = true; if (plant(b)) app.power.dirty = true; });
  bus.on('building:changed', (b) => { app.buildings.refresh(b); if (plant(b)) app.power.dirty = true; });
  bus.on('network:changed', () => { app.networks.dirty = true; app.trees.dirty = true; app.overlays.dirty = true; app.power.dirty = true; });
  bus.on('network:recomputed', () => { app.overlays.dirty = true; });
  bus.on('zones:changed', () => { app.overlays.dirty = true; });
  bus.on('trees:changed', () => { app.trees.dirty = true; });
  let terrainDirty = false;
  bus.on('terrain:changed', () => { terrainDirty = true; });

  // --- keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === ' ') { e.preventDefault(); app.setSpeed(0); }
    if (e.key === '1' || e.key === '2' || e.key === '3') app.setSpeed(+e.key);
    if (e.key === 'Home') view.cam.home();
  });

  let last = performance.now();
  let hudTimer = 0, panelTimer = 0, terrainTimer = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    view.updateKeys(dt);
    app.tools.frame(dt);
    app.sim.update(dt);
    for (const f of features) f.frame?.(app, dt, now);

    terrainTimer += dt;
    if (terrainDirty && terrainTimer > 0.08) {
      terrainTimer = 0;
      terrainDirty = false;
      app.terrain.updateHeights();
      app.features?.climate?.recolorTerrain?.();
      app.networks.dirty = true;
      app.power.dirty = true;
      app.trees.dirty = true;
      app.overlays.dirty = true;
      app.ctx.netDirty = true;
    }
    view.updateSky(hourOf(state), state.weather, seasonOf(state));
    app.trees.setSeason(seasonOf(state));
    app.buildings.update();
    app.networks.update();
    app.power.update();
    app.trees.update(now);
    app.overlays.update();

    hudTimer += dt;
    if (hudTimer > 0.25) { hudTimer = 0; app.hud.update(); }
    panelTimer += dt;
    if (panelTimer > 1) { panelTimer = 0; app.panels.refreshAll(); }

    view.renderer.render(view.scene, view.camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  bus.emit('game:started', app);
  return app;
}

function newGame(map, options) {
  const state = createState(map, options);
  generateMap(state, map);
  if (map.custom) applyCustomMap(state, map.custom);
  if (state.options.allTiles) state.tiles.fill(1);
  startGame(state, true);
}

const hasSave = (() => { try { return !!localStorage.getItem(SAVE_KEY); } catch { return false; } })();

async function loadFrom(text, cloudId = null) {
  const { unpack } = await import('./sim/save.js');
  try {
    const state = await unpack(text);
    if (cloudId) state.cloudId = cloudId;
    startGame(state, false);
  } catch (err) {
    console.error(err);
    alert(`Couldn't load that city: ${err.message}`);
    location.reload();
  }
}

// ?map=<id> skips the menu (useful while developing)
const params = new URLSearchParams(location.search);
const quick = MAPS.find((m) => m.id === params.get('map'));
// A city picked from your account arrives through sessionStorage (see accountFeature)
let pending = null;
try {
  pending = sessionStorage.getItem(PENDING_LOAD);
  if (pending) {
    const cloudId = sessionStorage.getItem(PENDING_CLOUD);
    sessionStorage.removeItem(PENDING_LOAD);
    sessionStorage.removeItem(PENDING_CLOUD);
    document.getElementById('menu').classList.add('hidden');
    loadFrom(pending, cloudId);
  }
} catch { /* storage blocked: fall through to the menu */ }
if (pending) {
  // loading a city from your account
} else if (quick) {
  document.getElementById('menu').classList.add('hidden');
  newGame(quick, { cityName: 'Test City', unlimitedMoney: params.has('rich'), unlockAll: params.has('unlock'), allTiles: params.has('alltiles'), instantBuild: params.has('instant'), tutorial: false });
  if (params.has('demo')) import('./dev/demoCity.js').then((m) => m.buildDemo(window.city));
  if (params.has('stress')) import('./dev/stressCity.js').then((m) => { window.__stress = m.buildStress(window.city, { days: +params.get('stress') || 7, road: +params.get('road') || 4 }); });
} else {
  showMenu({
    hasSave,
    onNew: newGame,
    onContinue: () => loadFrom(localStorage.getItem(SAVE_KEY)),
    onLoadFile: loadFrom,
    onLoadCloud: (city) => loadFrom(city.data, city.id),
  });
}
