// Road upgrade tool and decorative surface painting.
import { registerTool, segButtons, slider, money } from './tools.js';
import { idx, lCells, forRadius, DIRS, inBounds } from '../core/grid.js';
import { UPGRADES, UPG, ROADS } from '../data/roads.js';
import { spend, isOwned } from '../sim/build.js';
import { bus } from '../core/events.js';
import { lineCells, snapEnd, onDiagonal } from '../sim/roadsegs.js';
import { dropSpansAt } from '../sim/power.js';
import { roadLinks } from '../sim/bridges.js';

// Roads this cell connects to (3 or more = a junction)
const roadNeighbours = (state, x, y) => roadLinks(state, idx(x, y));

export function upgradeAllowed(state, x, y, u) {
  const i = idx(x, y);
  const t = state.road[i];
  if (!t) return false;
  if (u.highwayOnly && ROADS[t].key !== 'highway') return false;
  if (u.bit === UPG.TREES && ROADS[t].key === 'highway') return false;
  if (u.minRoad && (t < u.minRoad || ROADS[t].key === 'highway')) return false;
  if (u.intersectionOnly && roadNeighbours(state, x, y) < 3) return false;
  if (u.noIntersection && roadNeighbours(state, x, y) >= 3) return false;
  // one booth per stretch: no toll booth right next to another
  if (u.single) for (const [dx, dy] of DIRS) { const nx = x + dx, ny = y + dy; if (inBounds(nx, ny) && state.roadUpg[idx(nx, ny)] & u.bit) return false; }
  if (u.bit === UPG.TOLL && state.bridgeH[idx(x, y)]) return false;
  // gantries, tram tracks and barriers are built along the grid
  if ((u.bit === UPG.TOLL || u.bit === UPG.TRAM || u.bit === UPG.BARRIER) && onDiagonal(state, idx(x, y))) return false;
  return true;
}

registerTool('upgrade', {
  options(app, t, el, rerender) {
    const u = UPGRADES.find((k) => k.bit === t.bit);
    el.innerHTML = `<h4>${u.name}</h4>`;
    segButtons(el, 'Mode', [['add', 'Add'], ['remove', 'Remove']], t.mode || 'add', (v) => { t.mode = v; rerender(); });
    el.insertAdjacentHTML('beforeend', `<p class="muted">${money(u.cost)} ${u.single ? 'each' : 'per cell'}.${u.intersectionOnly ? ' Click an intersection.' : u.single ? ' Click a road (not a junction).' : ' Drag along roads.'}${u.desc ? ` ${u.desc}` : ''}</p>`);
  },
  cells(app, t, a, b) {
    if (UPGRADES.find((k) => k.bit === t.bit)?.single) return [[b.cx, b.cy]];
    // drag along a road: straight at any angle (it snaps to the grid and to 45°)
    const [ex, ey] = snapEnd(a.cx, a.cy, b.cx, b.cy);
    return lineCells(a.cx, a.cy, ex, ey);
  },
  hover(app, t, p) { this.drag(app, t, p, p); },
  drag(app, t, a, b) {
    const u = UPGRADES.find((k) => k.bit === t.bit);
    app.preview.setCells(this.cells(app, t, a, b).map(([x, y]) => [x, y, upgradeAllowed(app.state, x, y, u) ? '#4fc3ff' : '#ff4a3a']));
  },
  up(app, t, a, b) {
    const s = app.state;
    const u = UPGRADES.find((k) => k.bit === t.bit);
    let n = 0;
    for (const [x, y] of this.cells(app, t, a, b)) {
      if (!upgradeAllowed(s, x, y, u)) continue;
      const i = idx(x, y);
      if ((t.mode || 'add') === 'add') {
        if (s.roadUpg[i] & u.bit) continue;
        if (!spend(s, u.cost, 'roads')) { app.toast('Not enough money', 'bad'); break; }
        s.roadUpg[i] |= u.bit;
      } else {
        s.roadUpg[i] &= ~u.bit;
        if (u.bit === UPG.POWER) dropSpansAt(s, [i]);
      }
      n++;
    }
    if (n) { bus.emit('network:changed', { layer: 'road' }); bus.emit('trees:changed'); }
    app.preview.clearCells();
  },
});

registerTool('surface', {
  options(app, t, el) {
    el.innerHTML = '<h4>Surface paint</h4>';
    slider(el, 'Brush size', 0, 5, 1, t.size ?? 1, (v) => { t.size = v; });
  },
  hover(app, t, p) { app.preview.setBrush(p.cx + 0.5, p.cy + 0.5, (t.size ?? 1) + 0.5); },
  drag(app, t, a, b) {
    app.preview.setBrush(b.cx + 0.5, b.cy + 0.5, (t.size ?? 1) + 0.5);
    const s = app.state;
    let n = 0;
    forRadius(b.cx + 0.5, b.cy + 0.5, (t.size ?? 1) + 0.5, (x, y) => {
      const i = idx(x, y);
      if (!isOwned(s, x, y) || s.water[i] || s.surface[i] === t.surface) return;
      if (t.surface && !spend(s, 5, 'landscaping')) return;
      s.surface[i] = t.surface;
      n++;
    });
    if (n) app.overlays.dirty = true;
  },
});
