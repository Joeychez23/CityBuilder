// Time-lapse: watch the city grow from its first road to today in under a minute. The
// camera circles slowly overhead while roads and buildings appear in the order they were
// built (each building remembers the day it was finished; roads, the day they were laid,
// state.roadDay, estimated for roads older than that from the buildings along them). The
// simulation is paused meanwhile, and everything is put back as it was afterwards.
import { registerSystem, formatDate } from '../sim/simulation.js';
import { N, DIRS, inBounds, idx } from '../core/grid.js';
import { bus } from '../core/events.js';

// Roads laid before the city kept their dates: guess from the buildings along them (a road
// is at least as old as the oldest building beside it), then along the road network
function estimateRoadDays(state, first) {
  const D = state.roadDay;
  const guess = new Uint16Array(N * N);
  for (const b of state.buildings.values()) {
    const day = Math.max(first, Math.floor(b.built ?? first));
    for (let y = b.y0 - 2; y <= b.y1 + 2; y++) for (let x = b.x0 - 2; x <= b.x1 + 2; x++) {
      if (!inBounds(x, y)) continue;
      const i = idx(x, y);
      if (state.road[i] && !D[i] && (!guess[i] || day < guess[i])) guess[i] = day;
    }
  }
  // spread along the roads: a road with no date takes its neighbour's
  const queue = [];
  for (let i = 0; i < N * N; i++) if (state.road[i] && (D[i] || guess[i])) queue.push(i);
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q], x = i % N, y = (i / N) | 0, v = D[i] || guess[i];
    for (const [dx, dy] of DIRS) {
      const j = idx(x + dx, y + dy);
      if (!inBounds(x + dx, y + dy) || !state.road[j] || D[j] || guess[j]) continue;
      guess[j] = v;
      queue.push(j);
    }
  }
  return guess;
}

export const timelapseFeature = {
  init(app) {
    const { state, view } = app;
    if (!state.roadDay || state.roadDay.length !== N * N) state.roadDay = new Uint16Array(N * N);
    // a city from before roads kept their dates: date the roads it has now once, from the
    // buildings along them
    if (!state.roadDayInit) {
      const days = [...state.buildings.values()].map((b) => b.built ?? 0).filter((d) => d > 0);
      const first = Math.min(state.history?.[0]?.day ?? state.time.day, ...days, state.time.day) - 1;
      const guess = estimateRoadDays(state, Math.max(1, first));
      for (let i = 0; i < N * N; i++) if (state.road[i] && !state.roadDay[i]) state.roadDay[i] = guess[i] || Math.max(1, first);
      state.roadDayInit = true;
    }
    // roads remember the day they were laid (from now on)
    bus.on('network:changed', ({ layer } = {}) => {
      if (layer !== 'road' || app.timelapse?.on) return;
      const day = Math.max(1, state.time.day);
      for (let i = 0; i < N * N; i++) if (state.road[i] && !state.roadDay[i]) state.roadDay[i] = day;
    });
    registerSystem({ name: 'road-days', every: 'day', run: (s) => { for (let i = 0; i < N * N; i++) if (s.road[i] && !s.roadDay[i]) s.roadDay[i] = Math.max(1, s.time.day - 1); else if (!s.road[i] && s.roadDay[i]) s.roadDay[i] = 0; } });

    const bar = document.createElement('div');
    bar.id = 'timelapse-bar';
    bar.innerHTML = `<div class="tl-date"><b data-date></b><span data-pop></span></div>
      <input type="range" min="0" max="1000" value="0" data-scrub>
      <div class="tl-buttons"><button class="btn" data-play>⏸</button><button class="btn" data-speed>1×</button><button class="btn" data-orbit>⟲ Orbit</button><button class="btn primary" data-exit>✕ Done</button></div>`;
    document.body.appendChild(bar);
    const T = app.timelapse = { on: false };

    T.start = () => {
      if (T.on) return;
      app.tools.set({ kind: 'select' });
      app.panels.closeAll();
      const days = [...state.buildings.values()].map((b) => b.built ?? 0).filter((d) => d > 0);
      const first = Math.min(state.history?.[0]?.day ?? state.time.day, ...days, state.time.day) - 1;
      const last = state.time.day;
      if (last - first < 2) { app.toast('Your city is too young for a time-lapse: come back once it has grown a little.', 'info'); return; }
      const guess = estimateRoadDays(state, first);
      Object.assign(T, {
        on: true, first, last, t: 0, playing: true, speed: 1, orbit: true,
        dur: Math.min(60, Math.max(20, (last - first) * 0.18)),
        road: state.road.slice(), zone: state.zone.slice(), roadDays: state.roadDay.map((d, i) => d || guess[i] || first),
        wasPaused: state.time.paused, shown: new Set(state.buildings.keys()), lastRoadDay: -1, roadTimer: 0,
      });
      state.time.paused = true;
      state.zone.fill(0);
      app.overlays.dirty = true;
      document.body.classList.add('photo', 'timelapse');
      // a high view over the middle of town to start from
      let sx = 0, sz = 0, n = 0;
      for (const b of state.buildings.values()) { sx += (b.x0 + b.x1) / 2; sz += (b.y0 + b.y1) / 2; n++; }
      T.cx = n ? sx / n : N / 2; T.cz = n ? sz / n : N / 2;
      view.cam.setView({ x: T.cx, z: T.cz, dist: 150, yaw: 0.6, pitch: 0.95 });
      T.apply(true);
    };
    T.stop = () => {
      if (!T.on) return;
      T.on = false;
      state.road.set(T.road);
      state.zone.set(T.zone);
      for (const b of state.buildings.values()) if (!T.shown.has(b.id)) { app.buildings.add(b); T.shown.add(b.id); }
      app.networks.dirty = true;
      app.overlays.dirty = true;
      state.time.paused = T.wasPaused;
      document.body.classList.remove('photo', 'timelapse');
    };
    // show what was there on the replay's day
    T.apply = (force) => {
      const day = T.first + (T.last - T.first) * T.t;
      for (const b of state.buildings.values()) {
        const there = (b.built ?? T.first) <= day;
        if (there && !T.shown.has(b.id)) { app.buildings.add(b); T.shown.add(b.id); }
        else if (!there && T.shown.has(b.id)) { app.buildings.remove(b); T.shown.delete(b.id); }
      }
      const rd = Math.floor(day);
      if (force || (rd !== T.lastRoadDay && T.roadTimer > 0.2)) {
        T.lastRoadDay = rd; T.roadTimer = 0;
        for (let i = 0; i < N * N; i++) state.road[i] = T.road[i] && T.roadDays[i] <= day ? T.road[i] : 0;
        app.networks.dirty = true;
      }
      // the date and how many lived here then
      bar.querySelector('[data-date]').textContent = formatDate(day);
      const h = (state.history || []).find((x) => x.day >= rd) || state.history?.[state.history.length - 1];
      bar.querySelector('[data-pop]').textContent = T.t >= 1 ? `${state.citizens.size.toLocaleString()} people today` : h ? `${h.pop.toLocaleString()} people` : '';
      bar.querySelector('[data-scrub]').value = Math.round(T.t * 1000);
    };

    bar.querySelector('[data-exit]').onclick = () => T.stop();
    bar.querySelector('[data-play]').onclick = (e) => { T.playing = !T.playing; if (T.t >= 1 && T.playing) T.t = 0; e.target.textContent = T.playing ? '⏸' : '▶'; };
    bar.querySelector('[data-speed]').onclick = (e) => { T.speed = T.speed === 1 ? 2 : T.speed === 2 ? 0.5 : 1; e.target.textContent = `${T.speed}×`; };
    bar.querySelector('[data-orbit]').onclick = (e) => { T.orbit = !T.orbit; e.target.classList.toggle('on', T.orbit); };
    bar.querySelector('[data-scrub]').oninput = (e) => { T.t = +e.target.value / 1000; T.roadTimer = 1; T.apply(true); };
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && T.on) T.stop(); });
    bus.on('escape', () => T.stop());
  },
  frame(app, dt) {
    const T = app.timelapse;
    if (!T?.on) return;
    T.roadTimer += dt;
    if (T.playing && T.t < 1) {
      T.t = Math.min(1, T.t + (dt * T.speed) / T.dur);
      T.apply(false);
      if (T.t >= 1) { T.playing = false; document.querySelector('#timelapse-bar [data-play]').textContent = '▶'; T.roadTimer = 1; T.apply(true); }
    }
    if (T.orbit) {
      const g = app.view.cam.goal;
      if (g) g.yaw += dt * 0.06;
    }
  },
};
