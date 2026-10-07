// Registers the core city simulation (citizens, companies, demand, environment, economy)
// and keeps entities consistent when buildings disappear.
import { registerSystem } from '../sim/simulation.js';
import { moveInHourly, matchJobsHourly, citizensDaily, householdFinances, removeHousehold } from '../sim/citizens.js';
import { wellbeingDaily } from '../sim/wellbeing.js';
import { companiesDaily, tourismDaily, assignProduct } from '../sim/companies.js';
import { computeDemand } from '../sim/demand.js';
import { pollutionHourly, landValueDaily, natureDaily } from '../sim/environment.js';
import { dailyCosts, rollDay, closeWeek } from '../sim/economy.js';
import { removeBuilding } from '../sim/build.js';
import { bus } from '../core/events.js';
import { constructionStep } from '../sim/construction.js';

export const cityFeature = {
  init(app) {
    const { state, ctx } = app;
    registerSystem({ name: 'construction', every: 'step', run: constructionStep });
    bus.on('rebuilds:changed', () => { ctx.reservedDirty = true; });
    bus.on('construction:done', (b) => {
      if (b.kind === 'zone' && !b.def.signature) return;
      bus.emit('notify', { kind: 'good', icon: '🏗️', title: 'Construction finished', target: b.id, msg: `${b.name || b.def.name} is open.` });
    });
    registerSystem({ name: 'move-in', every: 'hour', run: moveInHourly });
    registerSystem({ name: 'jobs', every: 'hour', run: matchJobsHourly });
    registerSystem({ name: 'pollution', every: 'hour', run: pollutionHourly });
    registerSystem({ name: 'demand', every: 'hour', run: computeDemand });
    registerSystem({ name: 'citizens', every: 'day', run: citizensDaily });
    registerSystem({ name: 'finances', every: 'day', run: householdFinances });
    registerSystem({ name: 'companies', every: 'day', run: companiesDaily });
    registerSystem({ name: 'tourism', every: 'day', run: tourismDaily });
    registerSystem({ name: 'wellbeing', every: 'day', run: wellbeingDaily });
    registerSystem({ name: 'landvalue', every: 'day', run: landValueDaily });
    registerSystem({ name: 'nature', every: 'day', run: (s) => { if (natureDaily(s)) bus.emit('trees:changed'); } });
    registerSystem({ name: 'economy', every: 'day', run: dailyCosts });
    registerSystem({ name: 'roll-day', every: 'dayEnd', run: rollDay });
    registerSystem({ name: 'close-week', every: 'week', run: closeWeek });

    bus.on('building:add', (b) => {
      if (b.kind === 'zone' && b.def.cat !== 'res') assignProduct(state, b);
      if (b.kind === 'zone' && b.def.mixed) assignProduct(state, b);
    });
    // When a building goes away, its households leave town and its workers/students lose their place
    bus.on('building:remove', (b) => {
      for (const hid of b.households || []) { const hh = state.households.get(hid); if (hh) removeHousehold(state, hh, 'home demolished'); }
      for (const id of b.workers || []) { const c = state.citizens.get(id); if (c && c.job === b.id) c.job = 0; }
      if (b.def.eduLevel) for (const c of state.citizens.values()) if (c.school === b.id) c.school = 0;
    });
    // Abandoned buildings eventually collapse, freeing the lot for new growth
    bus.on('building:collapse', (b) => removeBuilding(state, b.id));

    computeDemand(state, ctx);
  },
};
