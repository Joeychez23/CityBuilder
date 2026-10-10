// "Plop" tool: place a single service/transport/signature building. You see the real
// building, see-through, with an arrow on the ground at its entrance. It snaps up against
// the nearest road (within a couple of cells of the cursor) and turns to face it; R / Shift+R
// (or the arrows in the tool box) turn it yourself, which keeps that direction until you
// switch "Face the road" back on.
import { registerTool, money, segButtons } from './tools.js';
import { N, idx, inBounds, DIRS } from '../core/grid.js';
import { placeService, serviceBlocker, isService } from '../sim/services.js';
import { footprintFree } from '../sim/build.js';
import { cellHeight } from '../sim/mapgen.js';
import { perWeek } from '../sim/economy.js';
import { parkReach } from '../sim/parking.js';
import { sewagePlume, intakeCell, flowNames } from '../sim/utilities.js';

// Footprint rectangle for a w×d building centred on (cx, cy) facing `rot`
export function plopRect(def, cx, cy, rot) {
  const alongX = rot === 1 || rot === 3;
  const sx = alongX ? def.w : def.d, sy = alongX ? def.d : def.w;
  const x0 = cx - Math.floor((sx - 1) / 2), y0 = cy - Math.floor((sy - 1) / 2);
  return [x0, y0, x0 + sx - 1, y0 + sy - 1];
}

// Does the side of the rectangle in direction `rot` touch a road?
function frontHasRoad(state, [x0, y0, x1, y1], rot) {
  const [dx, dy] = DIRS[rot];
  const cells = [];
  if (dx) for (let y = y0; y <= y1; y++) cells.push([dx > 0 ? x1 + 1 : x0 - 1, y]);
  else for (let x = x0; x <= x1; x++) cells.push([x, dy > 0 ? y1 + 1 : y0 - 1]);
  return cells.some(([x, y]) => inBounds(x, y) && state.road[idx(x, y)] && !state.bridgeH[idx(x, y)]);
}

// Sewage flows downstream. While placing a sewage outlet or treatment plant, the water its
// sewage would reach is shaded brown (red if a pump draws from it); while placing a surface
// water pump, the existing sewage plumes are shaded so the intake can stay upstream of them.
function sewagePreview(state, ctx, def, x0, y0, x1, y1) {
  const surfacePump = def.water && def.needs !== 'groundwater';
  if (!def.sewage && !surfacePump) return null;
  const F = flowNames(state);
  const flow = `water flows ${F.down} ${F.arrow}`;
  const cand = { def, x0, y0, x1, y1 };
  if (def.sewage) {
    const plume = sewagePlume(state, cand);
    if (!plume) return null;
    const hit = [...state.buildings.values()].find((b) => isService(b) && plume.has(intakeCell(state, b) ?? -1));
    return { cells: [...plume], bad: !!hit, text: hit
      ? `🤢 Upstream of ${hit.name || hit.def.name}: its sewage would reach the pump and residents will be upset (${flow})`
      : `Its sewage drifts ${F.down} ${F.arrow} through the brown water: keep pumps out of it` };
  }
  const intake = intakeCell(state, cand);
  const cells = [];
  let hit = null;
  for (const [b, plume] of ctx.sewagePlumes || []) {
    if (!state.buildings.has(b.id)) continue;
    for (const c of plume) cells.push(c);
    if (intake != null && plume.has(intake)) hit = b;
  }
  return { cells, bad: !!hit, intake, text: hit
    ? `🤢 Downstream of ${hit.name || hit.def.name}: it would pump up sewage and residents will be upset`
    : cells.length ? `Keep the intake out of the brown water: sewage drifts ${F.down} ${F.arrow}` : `Put sewage outlets downstream (${F.down}) of pumps: ${flow}` };
}

const SIDES = ['east', 'south', 'west', 'north'];

// Where the building goes for a cursor cell. With auto on, it looks a couple of cells around
// the cursor for a spot whose front is flush against a road (free spots first, then the
// fewest turns away from the direction you picked, then the closest to the cursor).
export function bestPlacement(state, def, cx, cy, preferRot, auto = true) {
  if (!auto) return { rot: preferRot, rect: plopRect(def, cx, cy, preferRot), snapped: false };
  let best = null;
  for (let r = 0; r < 4; r++) {
    const rot = (preferRot + r) % 4;
    for (let oy = -2; oy <= 2; oy++) {
      for (let ox = -2; ox <= 2; ox++) {
        const rect = plopRect(def, cx + ox, cy + oy, rot);
        if (!frontHasRoad(state, rect, rot)) continue;
        const free = footprintFree(state, ...rect);
        const score = (free ? 0 : 10) + (r === 0 ? 0 : r === 2 ? 1.4 : 0.9) + Math.hypot(ox, oy) * 0.7;
        if (!best || score < best.score) best = { rot, rect, score, snapped: true };
      }
    }
  }
  return best || { rot: preferRot, rect: plopRect(def, cx, cy, preferRot), snapped: false };
}

registerTool('plop', {
  options(app, t, el, rerender) {
    const d = t.def;
    const auto = t.auto !== false;
    el.innerHTML = `<h4>${d.name}</h4><div class="muted">${d.desc || ''}</div>
      <div class="row"><span class="k">Cost</span><span>${money(d.cost)}</span></div>
      <div class="row"><span class="k">Upkeep</span><span>${money(perWeek(d.upkeep || 0))}/wk</span></div>
      ${d.radius ? `<div class="row"><span class="k">Range</span><span>${d.radius * 8} m</span></div>` : ''}
      ${d.rooms ? `<div class="row"><span class="k">Rooms</span><span>${d.rooms} · ${money(d.roomRate)} a night</span></div>` : ''}
      ${d.deathRate ? `<div class="row"><span class="k">Handles</span><span>${d.deathRate} deceased a day</span></div>` : ''}
      ${d.parking ? `<div class="row"><span class="k">Holds</span><span>${d.parking} cars · drivers walk up to ${parkReach(d) * 8} m</span></div>` : ''}
      <div class="section-title">Facing</div>
      <div class="rot-row"><button class="btn" data-r="-1" title="Turn left (Shift+R)">⟲</button><span>Entrance faces <b>${SIDES[t.place?.rot ?? t.rot ?? 1]}</b></span><button class="btn" data-r="1" title="Turn right (R)">⟳</button></div>`;
    segButtons(el, null, [[true, 'Face the road'], [false, 'Keep my turn']], auto, (v) => { t.auto = v; rerender(); });
    el.insertAdjacentHTML('beforeend', `<p class="muted">${auto ? 'It snaps against the nearest road and turns its entrance (the yellow arrow) to face it.' : 'It stays turned the way you set it. Its entrance (the yellow arrow) needs a road.'} R / Shift+R turn it.</p>`);
    el.querySelectorAll('[data-r]').forEach((b) => (b.onclick = () => this.turn(app, t, +b.dataset.r)));
  },
  enter(app, t) { t.auto = t.auto ?? true; },
  turn(app, t, by) {
    t.rot = (((t.place?.rot ?? t.rot ?? 1) + by) % 4 + 4) % 4;
    t.auto = false; // turning it yourself keeps that direction
    if (app.tools.hover) this.hover(app, t, app.tools.hover);
    app.tools.renderOptions();
  },
  hover(app, t, p) {
    const { state, ctx } = app;
    const before = t.place?.rot;
    const place = bestPlacement(state, t.def, p.cx, p.cy, t.rot ?? 1, t.auto !== false);
    t.place = place;
    const [x0, y0, x1, y1] = place.rect;
    const reason = (t.blocker || serviceBlocker)(state, ctx, t.def, x0, y0, x1, y1, place.rot);
    const afford = state.options.unlimitedMoney || state.money >= t.def.cost;
    const cx = Math.min(N - 1, Math.max(0, Math.floor((x0 + x1 + 1) / 2))), cy = Math.min(N - 1, Math.max(0, Math.floor((y0 + y1 + 1) / 2)));
    app.buildings.showGhost(t.def, place.rect, place.rot, !reason && afford, cellHeight(state, cx, cy));
    if (before !== place.rot) app.tools.renderOptions();
    const ring = t.def.radius || (t.def.parking && parkReach(t.def));
    if (ring) app.preview.setRing((x0 + x1 + 1) / 2, (y0 + y1 + 1) / 2, ring, '#ffffff');
    const sew = sewagePreview(state, ctx, t.def, x0, y0, x1, y1);
    if (sew) {
      const shade = sew.bad ? '#ff4b3a' : '#8a5a2b';
      const cells = sew.cells.slice(0, 4000).map((i) => [i % N, (i / N) | 0, shade, state.seaLevel - 0.08]);
      if (sew.intake != null) cells.push([sew.intake % N, (sew.intake / N) | 0, sew.bad ? '#ff4b3a' : '#3aa0ff', state.seaLevel - 0.04]);
      app.preview.setCells(cells);
    }
    app.tools.showTip(`<b>${t.def.name}</b> · ${money(t.def.cost)}${reason ? `<br><span class="bad">${reason}</span>` : !afford ? '<br><span class="bad">Not enough money</span>' : ''}${sew?.text ? `<br><span class="${sew.bad ? 'bad' : 'muted'}">${sew.text}</span>` : ''}`);
  },
  up(app, t, a, b) {
    if (!t.place) return;
    const [x0, y0, x1, y1] = t.place.rect;
    const res = (t.place_fn || placeService)(app.state, app.ctx, t.def, x0, y0, x1, y1, t.place.rot);
    if (res.error) app.toast(res.error, 'bad');
    else if (t.once) app.tools.set({ kind: 'select' });
    this.hover(app, t, b);
  },
  key(app, t, e) {
    if (e.key === 'r' || e.key === 'R') this.turn(app, t, e.shiftKey ? -1 : 1);
  },
  exit(app) { app.buildings.hideGhost(); app.preview.hideGhost(); app.preview.setRing(0, 0, 0); app.preview.clearCells(); },
});
