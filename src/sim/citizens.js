// Citizens and households: moving in and out, ageing, births and deaths, schooling, jobs.
// One in-game day is one year of a citizen's life (lives are compressed; the budget is weekly).
import { ZONES, WAGES } from '../data/zones.js';
import { specIs } from './specialisations.js';
import { newId } from '../core/state.js';
import { rng } from '../core/rng.js';
import { clamp, idx } from '../core/grid.js';
import { isService, center, covAt, serviceEfficiency } from './services.js';
import { buildingRoadComp } from './networks.js';
import { bus } from '../core/events.js';
import { hasPerk } from '../data/progression.js';
import { earn } from './economy.js';

export const AGE = { school: 6, teen: 13, adult: 18, senior: 65 };
export const ageGroup = (a) => (a < AGE.teen ? 'child' : a < AGE.adult ? 'teen' : a < AGE.senior ? 'adult' : 'senior');
const STUDY_DAYS = [0, 5, 4, 3, 4]; // days enrolled to finish each education level

export function logLife(state, c, text) {
  if (!c.log) c.log = [];
  c.log.push({ day: state.time.day, text });
  if (c.log.length > 30) c.log.shift();
}

// Road component each building's driveway connects to (cached; refreshed on network change)
export function accessComp(state, ctx, b) {
  if (b.compStamp !== ctx.netStamp) {
    b.comp = buildingRoadComp(state, ctx, b)?.comp ?? -1;
    b.compStamp = ctx.netStamp;
  }
  return b.comp;
}

function newCitizen(state, hh, age, edu) {
  const id = newId(state);
  const c = { id, hh: hh.id, age, edu, job: 0, jobLevel: 0, school: 0, studyLevel: 0, studyDays: 0, health: 70 + rng.next() * 25, wellbeing: 60 + rng.next() * 15, sick: 0, criminal: 0, jail: 0 };
  state.citizens.set(id, c);
  hh.members.push(id);
  return c;
}

// --------------------------------------------------------------------- moving in
function immigrantEdu(state) {
  // Newcomers roughly follow the city's open jobs, with a universal baseline
  const open = state.stats.openJobsEdu || [1, 1, 1, 1, 1];
  const tot = open.reduce((a, c) => a + c, 0) || 1;
  // (a Tech Hub draws more highly educated people)
  const base = state.districts.some((d) => d.spec === 'tech') ? [0.15, 0.25, 0.28, 0.2, 0.12] : [0.2, 0.3, 0.28, 0.16, 0.06];
  const w = base.map((v, k) => v * 0.55 + (open[k] / tot) * 0.45);
  let r = rng.next() * w.reduce((a, c) => a + c, 0);
  for (let k = 0; k < 5; k++) { r -= w[k]; if (r <= 0) return k; }
  return 2;
}

export function moveInHousehold(state, ctx, home) {
  const def = home.def;
  const id = newId(state);
  const hh = { id, home: home.id, members: [], wealth: 0, income: 0, rent: 0, since: state.time.day, car: rng.chance(0.75) };
  state.households.set(id, hh);
  home.households.push(id);
  const family = rng.chance(def.family ?? 0.5);
  const edu = immigrantEdu(state);
  if (family) {
    const a = 26 + rng.int(0, 16);
    newCitizen(state, hh, a, edu);
    if (rng.chance(0.85)) newCitizen(state, hh, a + rng.int(-3, 3), clamp(edu + rng.int(-1, 1), 0, 4));
    const kids = rng.int(1, 3);
    for (let k = 0; k < kids; k++) {
      const age = rng.int(0, 16);
      newCitizen(state, hh, age, age >= AGE.teen ? 1 : 0);
    }
  } else if (rng.chance(0.15)) {
    newCitizen(state, hh, 65 + rng.int(0, 12), edu);
    if (rng.chance(0.5)) newCitizen(state, hh, 65 + rng.int(0, 12), edu);
  } else {
    newCitizen(state, hh, 19 + rng.int(0, 14), edu);
    if (rng.chance(0.35)) newCitizen(state, hh, 19 + rng.int(0, 14), clamp(edu + rng.int(-1, 1), 0, 4));
  }
  hh.wealth = 2500 + edu * 2500 + rng.next() * 6000;
  for (const cid of hh.members) logLife(state, state.citizens.get(cid), `Moved into ${home.name || def.name}`);
  return hh;
}

export function removeHousehold(state, hh, reason) {
  const home = state.buildings.get(hh.home);
  if (home) home.households = home.households.filter((h) => h !== hh.id);
  for (const cid of hh.members) {
    const c = state.citizens.get(cid);
    if (!c) continue;
    leaveJob(state, c);
    leaveSchool(state, c);
    if (state.followCitizen === c.id) bus.emit('follow:ended', { citizen: c, reason });
    state.citizens.delete(cid);
  }
  state.households.delete(hh.id);
  state.stats.movedOutToday = (state.stats.movedOutToday || 0) + 1;
}

export function leaveJob(state, c) {
  if (!c.job) return;
  const w = state.buildings.get(c.job);
  if (w) w.workers = w.workers.filter((x) => x !== c.id);
  c.job = 0;
}
export function leaveSchool(state, c) {
  if (!c.school) return;
  const s = state.buildings.get(c.school);
  if (s) s.studentCount = Math.max(0, (s.studentCount || 0) - 1);
  c.school = 0;
}

// Hourly: a few households move in if there's free housing and residential demand.
export function moveInHourly(state, ctx) {
  const d = state.demand.res;
  if (d <= 0.02) return;
  const homes = [];
  for (const b of state.buildings.values()) {
    if (b.kind !== 'zone' || b.def.cat !== 'res' || b.abandoned || b.onFire) continue;
    const free = (b.hhCap || 0) - b.households.length;
    if (free <= 0) continue;
    const comp = accessComp(state, ctx, b);
    if (comp < 0 || !ctx.net.roadOutside[comp]) continue;
    homes.push(b);
  }
  if (!homes.length) return;
  const n = Math.min(homes.length, Math.ceil(d * 5 + homes.length * 0.05 * d));
  for (let k = 0; k < n; k++) {
    // prefer homes with good land value
    const a = homes[Math.floor(rng.next() * homes.length)], b = homes[Math.floor(rng.next() * homes.length)];
    const home = state.landValue[idx(...center(a))] >= state.landValue[idx(...center(b))] ? a : b;
    if (home.households.length >= home.hhCap) continue;
    moveInHousehold(state, ctx, home);
    state.stats.movedInToday = (state.stats.movedInToday || 0) + 1;
  }
}

// ---------------------------------------------------------------------- jobs
export function matchJobsHourly(state, ctx) {
  const places = [];
  const openEdu = [0, 0, 0, 0, 0];
  for (const b of state.buildings.values()) {
    if (!b.jobs || b.abandoned) continue;
    if (b.workers.length >= b.jobs) continue;
    const comp = accessComp(state, ctx, b);
    if (comp < 0) continue;
    b.workersByLevel = [0, 0, 0, 0, 0];
    for (const id of b.workers) { const w = state.citizens.get(id); if (w) b.workersByLevel[w.jobLevel]++; }
    places.push(b);
    for (let k = 0; k < 5; k++) openEdu[k] += Math.max(0, b.jobsEdu[k] - b.workersByLevel[k]);
  }
  state.stats.openJobsEdu = openEdu;
  if (!places.length) return;
  let budget = 400;
  for (const c of state.citizens.values()) {
    if (budget <= 0) break;
    if (c.job || c.school || c.jail || c.outsideJob || c.age < AGE.teen || c.age >= AGE.senior) continue;
    if (c.age < AGE.adult && rng.chance(0.7)) continue; // most teens are not job-hunting
    budget--;
    const hh = state.households.get(c.hh);
    const home = hh && state.buildings.get(hh.home);
    if (!home) continue;
    const comp = accessComp(state, ctx, home);
    let best = null, bestLevel = -1, bestDist = 1e9;
    const [hx, hy] = center(home);
    // live-work towers: residents take the jobs upstairs first
    if (home.def.liveWork && home.jobs > home.workers.length && home.workersByLevel) {
      for (let lv = c.edu; lv >= 0; lv--) if (home.jobsEdu[lv] - home.workersByLevel[lv] > 0) { best = home; bestLevel = lv; bestDist = 0; break; }
    }
    for (let t = 0; t < 10 && !best; t++) {
      const b = places[Math.floor(rng.next() * places.length)];
      if (b.comp !== comp || b.workers.length >= b.jobs) continue;
      for (let lv = c.edu; lv >= 0; lv--) {
        if (b.jobsEdu[lv] - b.workersByLevel[lv] <= 0) continue;
        const [bx, by] = center(b);
        const dist = Math.abs(bx - hx) + Math.abs(by - hy);
        if (lv > bestLevel || (lv === bestLevel && dist < bestDist)) { best = b; bestLevel = lv; bestDist = dist; }
        break;
      }
    }
    if (!best) continue;
    c.job = best.id;
    c.jobLevel = bestLevel;
    best.workers.push(c.id);
    best.workersByLevel[bestLevel]++;
    logLife(state, c, `Started working at ${best.name || best.def.name}`);
  }
}

// ------------------------------------------------------------------- schools
function schoolFor(state, ctx, c, home, level) {
  const comp = accessComp(state, ctx, home);
  const [hx, hy] = center(home);
  let best = null, bestD = 1e9;
  for (const s of state.buildings.values()) {
    if (!isService(s) || s.def.eduLevel !== level) continue;
    const cap = s.def.students * clamp(serviceEfficiency(state, s), 0.5, 1.5);
    if ((s.studentCount || 0) >= cap) continue;
    if (accessComp(state, ctx, s) !== comp) continue;
    const [sx, sy] = center(s);
    const d = Math.hypot(sx - hx, sy - hy);
    if (!s.def.cityWide && d > s.def.radius) continue;
    if (d < bestD) { best = s; bestD = d; }
  }
  return best;
}

function educationDaily(state, ctx, c, home) {
  if (c.jail) return;
  // graduate?
  if (c.school) {
    const s = state.buildings.get(c.school);
    if (!s) { c.school = 0; return; }
    c.studyDays++;
    // (the National Library takes another day off college and university)
    // (and living in a University Town another)
    if (c.studyDays >= STUDY_DAYS[c.studyLevel] - (c.studyLevel >= 3 && hasPerk(state, 'edu_scholarships') ? 1 : 0) - (c.studyLevel >= 3 ? (ctx.wonders?.studyBoost || 0) + (specIs(ctx, home, 'campus') >= 1 ? 1 : 0) : 0)) {
      c.edu = Math.max(c.edu, c.studyLevel);
      logLife(state, c, `Graduated from ${s.def.name}`);
      leaveSchool(state, c);
      state.stats.graduatedToday = (state.stats.graduatedToday || 0) + 1;
    }
    return;
  }
  let level = 0;
  if (c.age >= AGE.school && c.age < AGE.teen && c.edu < 1) level = 1;
  else if (c.age >= AGE.teen && c.age < AGE.adult && c.edu === 1) level = 2;
  else if (c.age >= AGE.adult && c.age < 30 && c.edu === 2 && rng.chance(0.5)) level = 3;
  else if (c.age >= AGE.adult && c.age < 34 && c.edu === 3 && rng.chance(0.45)) level = 4;
  if (!level) return;
  const s = schoolFor(state, ctx, c, home, level);
  if (!s) return;
  if (c.job && level >= 3) leaveJob(state, c);
  c.school = s.id;
  c.studyLevel = level;
  c.studyDays = 0;
  s.studentCount = (s.studentCount || 0) + 1;
  logLife(state, c, `Enrolled at ${s.def.name}`);
}

// ---------------------------------------------------------------- daily life
export function citizensDaily(state, ctx) {
  let births = 0, deaths = 0, sickNow = 0, treated = 0;
  const pop = state.citizens.size;
  // Hospital capacity per building for today
  for (const b of state.buildings.values()) if (isService(b) && b.def.patients) b.patientsToday = 0;
  const healthProviders = [...state.buildings.values()].filter((b) => isService(b) && b.def.patients);

  for (const hh of [...state.households.values()]) {
    const home = state.buildings.get(hh.home);
    if (!home) { removeHousehold(state, hh, 'homeless'); continue; }
    let adults = 0;
    for (const cid of [...hh.members]) {
      const c = state.citizens.get(cid);
      if (!c) continue;
      const before = ageGroup(c.age);
      c.age += 1;
      const after = ageGroup(c.age);
      if (before !== after) {
        if (after === 'senior') { leaveJob(state, c); logLife(state, c, 'Retired'); }
        else logLife(state, c, `Became ${after === 'teen' ? 'a teenager' : 'an adult'}`);
      }
      if (c.jail > 0) { c.jail--; if (!c.jail) logLife(state, c, 'Released from prison'); }
      educationDaily(state, ctx, c, home);

      // Sickness and treatment
      if (!c.sick && rng.chance(((100 - c.health) / 100) * 0.05 + (c.age > 70 ? 0.02 + (ctx.heatwave ? 0.04 : 0) : 0))) c.sick = 1; // (a heatwave is hard on the old)
      if (c.sick) {
        sickNow++;
        const p = healthProviders.find((h) => (h.patientsToday || 0) < h.def.patients * (h.efficiency || 1) &&
          Math.hypot(center(h)[0] - center(home)[0], center(h)[1] - center(home)[1]) <= h.def.radius);
        if (p) {
          p.patientsToday++;
          c.sick = 0; c.health = Math.min(100, c.health + 12); treated++;
          state.counters.treated++;
          earn(state, 'fees', state.fees.healthcare * 0.25);
          logLife(state, c, `Treated at ${p.def.name}`);
        } else {
          c.sick++;
          c.health = Math.max(0, c.health - 3);
        }
      }

      // Death: old age, or untreated illness
      const oldAge = c.age > AGE.senior ? (c.age - AGE.senior) * 0.006 + (c.age > 90 ? 0.2 : 0) : 0;
      const illness = c.sick > 4 ? 0.04 * (1 - c.health / 100) : 0;
      if (rng.chance(oldAge + illness + (c.health < 10 ? 0.03 : 0))) {
        logLife(state, c, `Passed away at age ${Math.floor(c.age)}`);
        if (state.followCitizen === c.id) bus.emit('follow:ended', { citizen: c, reason: 'died' });
        leaveJob(state, c); leaveSchool(state, c);
        hh.members = hh.members.filter((m) => m !== cid);
        state.citizens.delete(cid);
        home.dead = (home.dead || 0) + 1;
        deaths++;
        continue;
      }
      if (c.age >= AGE.adult && c.age < 46) adults++;
    }
    if (!hh.members.length) { removeHousehold(state, hh, 'empty'); continue; }

    // Births: couples in homes that aren't crowded
    const happy = home.happiness ?? 60;
    if (adults >= 2 && hh.members.length < 6 && rng.chance(0.05 * (happy / 70))) {
      const baby = newCitizen(state, hh, 0, 0);
      logLife(state, baby, `Born in ${home.name || home.def.name}`);
      births++;
    }
  }
  state.stats.births = births;
  state.stats.deaths = deaths;
  state.stats.sick = sickNow;
  state.stats.treated = treated;
  state.stats.popDelta = state.citizens.size - pop;
}

// Monthly household finances: wages in, rent + spending + fees out, taxes to the city.
export function householdFinances(state, ctx) {
  let resTax = 0, spending = 0;
  const T = state.taxes;
  for (const hh of state.households.values()) {
    const home = state.buildings.get(hh.home);
    if (!home) continue;
    let income = 0;
    for (const cid of hh.members) {
      const c = state.citizens.get(cid);
      if (!c) continue;
      if (c.job) {
        const wage = WAGES[c.jobLevel] * 0.25; // scaled to this map's economy
        const rate = clamp(T.res + (T.resEdu[c.jobLevel] || 0), -10, 30) / 100;
        const tax = wage * rate;
        income += wage - tax;
        resTax += tax;
      } else if (c.outsideJob) {
        // works in a neighbouring city (hyperloop): paid there, taxed here
        const wage = WAGES[Math.min(4, c.edu)] * 0.25, tax = wage * clamp(T.res, -10, 30) / 100;
        income += wage - tax;
        resTax += tax;
      } else if (c.age >= AGE.senior) income += 160; // pension
    }
    const covWelfare = covAt(ctx, 'welfare', home);
    if (hh.wealth < 1500 && covWelfare > 0.2) income += 120 * covWelfare;
    const lv = state.landValue[idx(...center(home))] || 0;
    // (rents rise where the neighbourhood is popular: sim/society.js)
    const rent = (40 + lv * 160) * (ZONES[home.type]?.rent ?? 1) * (1 + (home.level - 1) * 0.25) * (home.def.lowRent ? 0.55 : 1) * (home.rentIndex ?? 1);
    const spend = Math.max(0, income * 0.35 + hh.wealth * 0.01);
    hh.income = income;
    hh.rent = rent;
    hh.wealth += income - rent - spend;
    spending += spend;
    home.rentCollected = (home.rentCollected || 0) + rent;
  }
  earn(state, 'resTax', resTax);
  state.stats.consumerSpending = spending;
}
