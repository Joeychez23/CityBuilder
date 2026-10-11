// Zone demand (the R/C/I/O bars). Each value is 0..1 and comes with a list of factors so the
// UI can explain *why* demand is high or low.
import { clamp } from '../core/grid.js';
import { AGE } from './citizens.js';

// Booms bring businesses in, recessions keep them away (the stimulus props them up)
const economyPull = (ctx) => (ctx.economy ? (ctx.economy.index - 1) * 1.2 + (ctx.stimulus ? 0.06 : 0) : 0);

export function computeDemand(state, ctx) {
  const s = state.stats;
  let hhCap = { low: 0, med: 0, high: 0 }, hhUsed = { low: 0, med: 0, high: 0 };
  let jobs = 0, workers = 0, comCap = 0, indJobs = 0, offJobs = 0;
  for (const b of state.buildings.values()) {
    if (b.kind !== 'zone' || b.abandoned) continue;
    const k = b.def.key;
    if (b.def.cat === 'res') {
      const band = k === 'res_low' ? 'low' : k === 'res_row' || k === 'res_med' ? 'med' : 'high';
      hhCap[band] += b.hhCap || 0;
      hhUsed[band] += b.households.length;
    }
    jobs += b.jobs || 0;
    workers += b.workers?.length || 0;
    if (b.def.cat === 'com') comCap += b.jobs;
    if (b.def.cat === 'ind' || b.def.cat === 'spec') indJobs += b.jobs;
    if (b.def.cat === 'off') offJobs += b.jobs;
  }
  let adults = 0, unemployed = 0, eduUnemployed = 0, lowEduUnemployed = 0, overqualified = 0;
  for (const c of state.citizens.values()) {
    if (c.age < AGE.adult || c.age >= AGE.senior || c.jail) continue;
    adults++;
    if (!c.job && !c.school && !c.outsideJob) { unemployed++; if (c.edu >= 2) eduUnemployed++; else lowEduUnemployed++; }
    else if (c.job && c.edu >= 2 && c.edu > c.jobLevel + 1) overqualified++;
  }
  const pop = state.citizens.size;
  const unemployment = adults ? unemployed / adults : 0;
  const openJobs = Math.max(0, jobs - workers);
  const happy = s.happiness ?? 60;
  const T = state.taxes;
  const tax = (r) => (10 - r) * 0.025; // 10% is neutral

  // Residential: jobs to fill and a pleasant city pull people in; vacancy and unemployment push back
  const vacancy = (cap, used) => (cap ? (cap - used) / cap : 0);
  const f = {
    base: pop < 300 ? 0.45 : 0.15,
    jobs: clamp(openJobs / Math.max(40, pop * 0.25), 0, 1) * 0.45,
    unemployment: -unemployment * 1.2,
    happiness: (happy - 55) / 100,
    taxes: tax(T.res),
    services: (s.utilities?.unpowered || 0) + (s.utilities?.dry || 0) > 10 ? -0.15 : 0,
  };
  const res = clamp(Object.values(f).reduce((a, c) => a + c, 0), 0, 1);
  const resLow = clamp(res * 0.95 - vacancy(hhCap.low, hhUsed.low) * 1.5, 0, 1);
  const resMed = clamp(res * (pop > 400 ? 0.9 : 0.55) - vacancy(hhCap.med, hhUsed.med) * 1.2, 0, 1);
  const resHigh = clamp(res * (pop > 1500 ? 0.85 : pop > 600 ? 0.45 : 0.2) - vacancy(hhCap.high, hhUsed.high) * 1.0, 0, 1);

  // Commercial: shoppers' spending vs shop capacity
  const spend = s.retailDemand || pop * 9;
  const cap = s.retailCapacity || comCap * 1200;
  const fc = {
    base: 0.06,
    customers: clamp((spend - cap) / Math.max(400, spend), -0.5, 0.8) * 0.7,
    workforce: unemployed > 10 ? 0.08 : -0.05,
    taxes: tax(T.com),
    tourists: clamp((s.tourists || 0) / 2000, 0, 0.2),
    economy: economyPull(ctx),
  };
  const com = clamp(Object.values(fc).reduce((a, c) => a + c, 0), 0, 1);

  // Industrial: goods needed by shops + workers looking for jobs
  const m = state.market || {};
  const goodsImported = ['food', 'paper', 'metals', 'plastics', 'electronics'].reduce((a, g) => a + (m[g]?.imported || 0), 0);
  const fi = {
    base: pop < 300 ? 0.35 : 0.1,
    goods: clamp(goodsImported / 300, 0, 0.45),
    workforce: clamp(lowEduUnemployed / Math.max(20, adults * 0.08), 0, 1) * 0.3,
    jobsBalance: indJobs > pop * 0.3 ? -0.2 : 0,
    taxes: tax(T.ind),
    economy: economyPull(ctx),
  };
  const ind = clamp(Object.values(fi).reduce((a, c) => a + c, 0), 0, 1);

  // Office: educated people without jobs, and universities
  const fo = {
    base: 0.02,
    educated: clamp(eduUnemployed / Math.max(15, adults * 0.06), 0, 1) * 0.5,
    overqualified: clamp(overqualified / Math.max(20, adults * 0.15), 0, 1) * 0.35,
    university: ctx.hasUniversity ? 0.12 : 0,
    landmarks: ctx.wonders?.officeDemand || 0,
    jobsBalance: offJobs > pop * 0.25 ? -0.2 : 0,
    taxes: tax(T.off),
    economy: economyPull(ctx),
  };
  const off = clamp(Object.values(fo).reduce((a, c) => a + c, 0), 0, 1);

  state.demand = { res, resLow, resMed, resHigh, com, ind, off, factors: { res: f, com: fc, ind: fi, off: fo } };
  s.population = pop;
  s.households = state.households.size;
  s.jobs = jobs;
  s.workers = workers;
  s.unemployment = unemployment;
  s.adults = adults;
  s.housing = hhCap.low + hhCap.med + hhCap.high;
}
