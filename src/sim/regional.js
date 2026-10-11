// The city's links to the neighbouring cities: the hyperloop.
import { N, idx, clamp, inBounds } from '../core/grid.js';
import { center, serviceEfficiency } from './services.js';
import { AGE } from './citizens.js';

// ----------------------------------------------------------------- hyperloop
export const hyperloopOf = (state) => { for (const b of state.buildings.values()) if (b.def.hyperloop && !b.cons) return b; return null; };

// Daily: residents without work here take jobs in the neighbouring cities (as many as the
// pods have seats for); they go back to looking here if the station closes
// (neighbour cities you founded, sim/region.js, have open jobs your residents drive to)
export function hyperloopDaily(state, ctx) {
  const st = hyperloopOf(state);
  const eff = st ? clamp(serviceEfficiency(state, st), 0, 1) : 0;
  const nbr = ctx.region?.offer ? Math.round(Math.min(3000, ctx.region.offer.jobs) * 0.5) : 0;
  const seats = (st ? Math.round(st.def.seats * eff) : 0) + nbr;
  let riders = 0;
  for (const c of state.citizens.values()) if (c.outsideJob) { if (riders < seats && !c.job && c.age < AGE.senior) riders++; else c.outsideJob = false; }
  if (riders < seats) {
    for (const c of state.citizens.values()) {
      if (riders >= seats) break;
      if (c.outsideJob || c.job || c.school || c.jail || c.age < AGE.adult || c.age >= AGE.senior || c.edu < 1) continue;
      c.outsideJob = true;
      riders++;
    }
  }
  ctx.hyperloop = st ? { eff, seats, riders, commuterBoost: 0.25 * eff } : null;
  if (st) { st.riders = Math.min(riders, Math.round(st.def.seats * eff)); st.seats = Math.round(st.def.seats * eff); }
  state.stats.neighbourJobs = Math.max(0, riders - (st ? Math.round(st.def.seats * eff) : 0));
  state.stats.hyperloopRiders = riders;
}

// The tube runs from the station straight out to the nearest map edge, on pylons
export function hyperloopTube(b) {
  const [cx, cy] = center(b);
  const opts = [[cx, 0, -1], [N - 1 - cx, 0, 1], [cy, 1, -1], [N - 1 - cy, 1, 1]].sort((p, q) => p[0] - q[0]);
  const [len, axis, sign] = opts[0];
  const pts = [];
  for (let k = 0; k <= len + 2; k++) {
    const x = axis === 0 ? cx + sign * k : cx, y = axis === 1 ? cy + sign * k : cy;
    pts.push([x + 0.5, y + 0.5, inBounds(x, y) ? idx(x, y) : -1]);
  }
  return pts;
}
