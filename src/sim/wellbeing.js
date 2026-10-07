// Health, well-being and happiness; crime; building level-up and abandonment.
// Happiness = average of health (physical) and well-being (mental & safety), as in CS2.
import { clamp } from '../core/grid.js';
import { rng } from '../core/rng.js';
import { centerIdx, isService } from './services.js';
import { AGE, logLife, leaveJob, leaveSchool, removeHousehold } from './citizens.js';
import { bus } from '../core/events.js';
import { hasPerk } from '../data/progression.js';
import { dispatch } from './emergency.js';
import { accessCell } from './traffic.js';
import { startRenovation } from './construction.js';

const districtOf = (state, b) => (b.district ? state.districts.find((d) => d.id === b.district) : null);

// Factors shared by everyone living in a building, kept for the inspector & info views.
// Each entry is [label, points, icon]. Well-being also has personal factors (job, taxes on
// their education level, how they get around), added per citizen below.
export const FACTOR_ICONS = {
  'No job': '💼', Taxes: '💸', 'Transport costs': '🎫', 'Industrial noise': '🏭', Noise: '🔊', Electricity: '⚡',
  Water: '💧', 'Sewage upstream of drinking water': '🤢', Police: '🚓', 'Fire & rescue': '🚒', Healthcare: '🏥', 'No police nearby': '🚓',
  'No fire station nearby': '🚒', 'No healthcare nearby': '🏥', 'No school for the kids': '🎒', Leisure: '🌳', Mail: '📮',
  Internet: '📡', 'Education access': '🎓', 'City hall': '🏛️', Welfare: '🤝', 'Air quality': '🌫️', Crime: '🚨',
  'Garbage & deathcare': '🗑️', 'Service fees': '🧾', Landmarks: '⭐', 'District policies': '📜', Home: '🏠',
  Wealth: '💰', Sick: '🤒', 'In jail': '🚔', Studying: '📚', 'No parking at work': '🅿️', 'Stuck in traffic': '🚦',
  'Air pollution': '🌫️', 'Ground pollution': '🟤', 'Polluted tap water': '☣️', 'Sewage backing up': '💩', 'Uncollected garbage': '🗑️', Parks: '🌳',
};

function buildingFactors(state, ctx, b) {
  const i = centerIdx(b);
  const cov = (k) => ctx.coverage[k]?.[i] || 0;
  const dist = districtOf(state, b);
  const air = state.air[i], ground = state.ground[i];
  const indNoise = ctx.indNoise?.[i] || 0;
  const otherNoise = Math.max(0, state.noise[i] - indNoise * 0.6);
  const pop = state.citizens.size;
  const health = [
    ['Base', 62],
    ['Healthcare', cov('health') * 22],
    ['Parks', Math.min(1, cov('leisure')) * 5],
    ['Air pollution', -air * 35],
    ['Ground pollution', -ground * 25],
    ['Polluted tap water', -(b.waterPolluted || 0) * 45],
    ['Sewage backing up', b.sewage < 0.7 ? -12 : 0],
    ['Uncollected garbage', (b.garbage || 0) > 4 ? -10 : 0],
  ];
  const feeOver = Math.max(0, state.fees.electricity / 0.2 - 1) + Math.max(0, state.fees.water / 0.3 - 1);
  // Once the town has grown a little, people expect basic services nearby
  const expects = pop > 150;
  const wb = [
    ['Base', 52],
    ['Electricity', (b.power - 1) * 30],
    ['Water', (b.water - 1) * 25 + (b.sewage - 1) * 15],
    ['Sewage upstream of drinking water', ctx.contaminatedWater?.has(b.waterComp) ? -14 : 0],
    ['Police', cov('police') * 7],
    ['No police nearby', expects && cov('police') < 0.1 ? -7 : 0],
    ['Fire & rescue', cov('fire') * 5],
    ['No fire station nearby', expects && cov('fire') < 0.1 ? -6 : 0],
    ['Healthcare', cov('health') * 3],
    ['No healthcare nearby', expects && cov('health') < 0.1 ? -6 : 0],
    ['Leisure', Math.min(1, cov('leisure')) * 8],
    ['Mail', cov('post') * 4 - ((b.mailOut || 0) > 30 ? 3 : 0)],
    ['Internet', Math.min(1, cov('telecom')) * 5],
    ['Education access', cov('education1') > 0.1 ? 2 : 0],
    ['City hall', cov('cityhall') * 3],
    ['Welfare', cov('welfare') * 2],
    ['Industrial noise', -Math.min(1.2, indNoise) * 42],
    ['Noise', -Math.min(1.2, otherNoise) * 12],
    ['Air quality', -air * 8],
    ['Crime', -(b.crime || 0) * 0.22],
    ['Garbage & deathcare', ((b.garbage || 0) > 4 ? -8 : 0) + ((b.dead || 0) > 0 ? -6 : 0)],
    ['Service fees', -feeOver * 6],
    ['Landmarks', ctx.sigBoost?.[i] || 0],
    ['District policies', (dist?.policies?.gated ? 5 : 0) + (dist?.policies?.speedBumps ? 1 : 0) + (dist?.policies?.heavyBan ? 1 : 0)],
    ['Home', b.def.key === 'res_low' ? 4 : b.def.key === 'res_high' || b.def.lowRent ? -2 : 0],
  ];
  return { health, wb };
}

const sum = (list) => list.reduce((a, [, v]) => a + v, 0);

// Tax a citizen pays on their wage (residential rate + their education level's adjustment)
const citizenTax = (state, c) => clamp(state.taxes.res + (state.taxes.resEdu[c.job ? c.jobLevel : c.edu] || 0), -10, 30);
export function taxFeeling(rate) {
  return rate > 10 ? -(rate - 10) * 1.6 - Math.max(0, rate - 15) * 2.2 : (10 - rate) * 0.4;
}

// Personal factors for one citizen: [label, points]
function personalFactors(state, ctx, c, hh) {
  const out = [['Wealth', clamp(hh.wealth / 4000, -3, 4) * 1.5]];
  const working = c.age >= AGE.adult && c.age < AGE.senior;
  if (working && !c.job && !c.school && !c.jail) out.push(['No job', -16 - Math.min(10, (c.jobless || 0) * 2)]);
  if (working || c.job) out.push(['Taxes', taxFeeling(citizenTax(state, c))]);
  if (c.job || c.school) {
    // what getting to work or school costs: car owners feel parking and tolls, the others
    // feel ticket prices (and taxi fares)
    const T = ctx.transportCost || { car: 0, transit: 0 };
    out.push(['Transport costs', -Math.min(16, Math.max(0, hh.car ? T.car : T.transit) * 1.2)]);
    // the lots near work were full: a walk from home (the further, the worse)
    if (c.noParking) out.push(['Walks to work (parking full)', -(2 + Math.min(7, (c.walkDist || 0) / 10))]);
    // jams on the streets around home or work make the daily commute miserable
    const jf = ctx.jamField;
    const work = jf && state.buildings.get(c.job || c.school);
    const home = jf && state.buildings.get(hh.home);
    if (work && home) {
      const at = (b) => { const a = accessCell(state, ctx, b); return a >= 0 ? jf[a] : 0; };
      const jam = Math.max(at(home), at(work));
      if (jam > 0.05) out.push(['Stuck in traffic', -jam * (hh.car && !c.noParking ? 12 : 6)]);
    }
  }
  if (c.sick) out.push(['Sick', -8]);
  if (c.school) out.push(['Studying', 2]);
  if (c.jail) out.push(['In jail', -15]);
  if (c.age >= AGE.school && c.age < AGE.teen && !c.school && state.citizens.size > 150) out.push(['No school for the kids', -5]);
  return out;
}

export function wellbeingDaily(state, ctx) {
  let hSum = 0, wSum = 0, n = 0, crimes = 0, arrests = 0;
  const jailCap = [...state.buildings.values()].reduce((a, b) => a + (isService(b) ? (b.def.cells || 0) + (b.def.prison || 0) : 0), 0);
  let jailed = 0;
  for (const c of state.citizens.values()) if (c.jail > 0) jailed++;
  // City-wide breakdown: points × people, for the happiness panel
  const agg = new Map();
  const tally = (label, v, people = 1) => {
    if (!v) return;
    const e = agg.get(label) || { sum: 0, hit: 0 };
    e.sum += v * people;
    if (Math.abs(v) >= 0.5) e.hit += people;
    agg.set(label, e);
  };
  const bands = [0, 0, 0, 0]; // angry, unhappy, content, happy

  for (const b of state.buildings.values()) {
    if (b.kind !== 'zone') continue;
    const f = buildingFactors(state, ctx, b);
    b.factors = f;
    const tH = clamp(sum(f.health), 0, 100);
    const tW = clamp(sum(f.wb), 0, 100);
    const i = centerIdx(b);
    let bh = 0, bn = 0, unwell = 0, unemployed = 0, adults = 0;
    const residents = (b.households || []).reduce((a, h) => a + (state.households.get(h)?.members.length || 0), 0);
    if (residents) for (const [k, v] of f.wb) if (k !== 'Base') tally(k, v, residents);
    const personalSum = new Map();

    for (const hid of b.households || []) {
      const hh = state.households.get(hid);
      if (!hh) continue;
      for (const cid of hh.members) {
        const c = state.citizens.get(cid);
        if (!c) continue;
        const working = c.age >= AGE.adult && c.age < AGE.senior;
        if (working) adults++;
        if (working && !c.job && !c.school && !c.jail) { unemployed++; c.jobless = (c.jobless || 0) + 1; } else c.jobless = 0;
        const pf = personalFactors(state, ctx, c, hh);
        let personal = 0;
        for (const [k, v] of pf) { personal += v; tally(k, v); personalSum.set(k, (personalSum.get(k) || 0) + v); }
        c.health += (tH - (c.age > 70 ? 8 : 0) - c.health) * 0.15;
        c.wellbeing += (clamp(tW + personal, 0, 100) - c.wellbeing) * 0.2;
        c.health = clamp(c.health, 0, 100);
        c.wellbeing = clamp(c.wellbeing, 0, 100);
        const happy = (c.health + c.wellbeing) / 2;
        bands[happy < 30 ? 0 : happy < 45 ? 1 : happy < 65 ? 2 : 3]++;
        bh += happy; bn++;
        hSum += c.health; wSum += c.wellbeing; n++;
        if (c.wellbeing < 30) unwell++;
        // Unhappy households eventually leave town
        if (happy < 22 && rng.chance(0.02)) { hh.leaving = true; }
      }
      if (hh.wealth < -2500) hh.leaving = true; // can't pay the rent
    }
    // the inspector shows the residents' average personal factors next to the building's
    b.personalFactors = bn ? [...personalSum].map(([k, v]) => [k, v / bn]) : [];
    // workplaces: happiness of their workers
    if (!bn && b.workers?.length) {
      for (const id of b.workers) { const c = state.citizens.get(id); if (c) { bh += (c.health + c.wellbeing) / 2; bn++; } }
    }
    b.happiness = bn ? bh / bn : null;

    // --- crime builds up where people are unwell and unemployed, police push it down
    const cov = (k) => ctx.coverage[k]?.[i] || 0;
    const dist = districtOf(state, b);
    const crimeIn = (bn ? (unwell / bn) * 8 + (adults ? (unemployed / adults) * 5 : 0) : 0.5) + (1 - state.landValue[i]) * 1.5 + (state.policies.cityPromotion ? 0.6 : 0);
    // without police nearby crime only fades slowly
    const crimeOut = cov('police') * 10 * (hasPerk(state, 'police_patrol') ? 1.2 : 1) + cov('cityhall') * 1 + (dist?.policies?.gated ? 2 : 0) + 1;
    b.crime = clamp((b.crime || 0) + crimeIn - crimeOut, 0, 100);

    levelAndAbandon(state, ctx, b, i);
  }

  // Households that decided to leave
  for (const hh of [...state.households.values()]) if (hh.leaving) removeHousehold(state, hh, 'moved away');

  // What people care about most, city-wide (average points per resident)
  const factors = [...agg].map(([name, e]) => ({ name, icon: FACTOR_ICONS[name] || '•', avg: n ? e.sum / n : 0, share: n ? e.hit / n : 0 }))
    .filter((f) => Math.abs(f.avg) >= 0.05).sort((a, b) => a.avg - b.avg);
  state.stats.happyFactors = factors;
  state.stats.happyBands = bands;
  const worst = factors[0];
  state.stats.topComplaint = worst && worst.avg <= -1 ? worst : null;
  state.stats.health = n ? hSum / n : null;
  state.stats.wellbeing = n ? wSum / n : null;
  state.stats.happiness = n ? (hSum + wSum) / 2 / n : null;
  state.stats.crimes = state.stats.crimesToday || 0;
  state.stats.arrests = state.stats.arrestsToday || 0;
  state.stats.crimesToday = 0;
  state.stats.arrestsToday = 0;
  state.stats.jailed = jailed;
  state.stats.jailCap = jailCap;
}

// Hourly: crimes happen where crime is high. Burglaries cost households money and shops
// lose stock; the police are called and arrest the offender if they arrive in time.
export function crimeHourly(state, ctx) {
  for (const b of state.buildings.values()) {
    if (b.kind !== 'zone' || (b.crime || 0) <= 50 || b.abandoned) continue;
    if (!rng.chance((b.crime - 50) / 900)) continue;
    state.stats.crimesToday = (state.stats.crimesToday || 0) + 1;
    b.crime *= 0.9;
    b.lastCrime = state.time.day;
    if (b.def.cat === 'res') for (const hid of b.households) { const hh = state.households.get(hid); if (hh) hh.wealth -= 150; }
    else b.stolen = (b.stolen || 0) + 300;
    const offender = findOffender(state, b) || findAnyOffender(state);
    if (offender) {
      offender.criminal = 1;
      logLife(state, offender, `Committed a crime at ${b.name || b.def.name}`);
    }
    const inc = dispatch(state, ctx, 'police', b, { offender: offender?.id });
    if (!inc && offender) logLife(state, offender, 'Got away: no police came');
  }
}

function findAnyOffender(state) {
  let k = 0;
  for (const c of state.citizens.values()) {
    if (++k > 400) break;
    if (!c.jail && c.age >= AGE.teen && c.wellbeing < 35) return c;
  }
  return null;
}

function findOffender(state, b) {
  for (const hid of b.households || []) {
    const hh = state.households.get(hid);
    for (const cid of hh?.members || []) {
      const c = state.citizens.get(cid);
      if (c && !c.jail && c.age >= AGE.teen && c.wellbeing < 40) return c;
    }
  }
  return null;
}

// What moves a grown building toward its next level each day, as [label, points] (also shown
// in the inspector). Homes level up when their residents are happy and well off on valuable
// land. Shops need customers and good land; factories need workers with more education as they
// grow; offices need educated workers, good land and internet. Every workplace needs to make a
// profit and have its jobs filled. Missing power, water or sewage stops it.
export const levelNeed = (b) => 30 + b.level * 25;
export function levelFactors(state, ctx, b) {
  const i = centerIdx(b);
  const lv = state.landValue[i] || 0;
  const cat = b.def.cat;
  const out = [];
  const problems = (b.power < 0.5 ? 1 : 0) + (b.water < 0.5 ? 1 : 0) + (b.sewage < 0.4 ? 1 : 0);
  if (cat === 'res') {
    out.push(['Happiness', ((b.happiness ?? 55) - 50) / 6]);
    out.push(['Land value', lv * 5]);
    out.push(['Wealth', clamp(avgWealth(state, b) / 5000, -1, 2)]);
  } else {
    const staffing = b.jobs ? (b.workerCount ?? b.workers.length) / b.jobs : 1;
    out.push(['Profit', b.profit == null ? 0 : b.profit > 0 ? 2.5 : -1.5]);
    out.push(['Jobs filled', (Math.min(1, staffing) - 0.6) * 4]);
    if (cat === 'com' || b.def.mixed) {
      out.push(['Customers', ((b.salesRatio ?? 0.5) - 0.55) * 5]);
      out.push(['Land value', lv * 4]);
    } else {
      // workers' average education against what this level of business needs
      let s = 0, n = 0;
      for (const id of b.workers) { const c = state.citizens.get(id); if (c) { s += c.edu; n++; } }
      s += (b.commuters || 0) * 1.2; n += b.commuters || 0;
      const edu = n ? s / n : 0;
      const want = cat === 'off' ? 1.6 + (b.level - 1) * 0.35 : 0.3 + (b.level - 1) * 0.4;
      out.push(['Educated workers', clamp((edu - want) * 2 + 1.5, -2, 3)]);
      out.push(['Land value', lv * (cat === 'off' ? 3 : 1.5)]);
      if (cat === 'off') out.push(['Internet', Math.min(1, ctx.coverage.telecom?.[i] || 0) * 2]);
    }
  }
  if (problems) out.push(['No power, water or sewage', -problems * 3]);
  return out;
}

function levelAndAbandon(state, ctx, b, i) {
  if (b.def.signature) return; // landmarks don't level up or get abandoned
  if (b.abandoned) {
    b.abandonedDays = (b.abandonedDays || 0) + 1;
    if (b.abandonedDays > 12) bus.emit('building:collapse', b); // the lot clears and can regrow
    return;
  }
  if (b.cons) return;
  const res = b.def.cat === 'res';
  const problems = (b.power < 0.5 ? 1 : 0) + (b.water < 0.5 ? 1 : 0) + (b.sewage < 0.4 ? 1 : 0);
  if (!b.reno) {
    const f = levelFactors(state, ctx, b);
    b.levelToday = f.reduce((a, [, v]) => a + v, 0);
    b.levelProgress = clamp(b.levelProgress + b.levelToday, -60, 1000);
    if (b.level < 5 && b.levelProgress >= levelNeed(b) && problems === 0) startRenovation(state, b);
  }
  if (!res) {
    const staffing = b.jobs ? b.workerCount / b.jobs : 1;
    b.understaffedDays = staffing < 0.25 && state.time.day - b.built > 4 ? (b.understaffedDays || 0) + 1 : 0;
    // a shop with hardly any customers for weeks closes down (the lot can regrow later)
    b.lowSalesDays = b.product === 'retail' && !b.def.mixed && (b.salesRatio ?? 1) < 0.3 ? (b.lowSalesDays || 0) + 1 : 0;
  }
  b.problemDays = problems ? (b.problemDays || 0) + 1 : 0;
  const unhappy = res && b.households.length && (b.happiness ?? 50) < 18;
  if (b.problemDays > 6 || (b.understaffedDays || 0) > 10 || (b.lowSalesDays || 0) > 20 || (unhappy && rng.chance(0.08))) abandon(state, b);
}

function avgWealth(state, b) {
  let s = 0, n = 0;
  for (const hid of b.households) { const hh = state.households.get(hid); if (hh) { s += hh.wealth; n++; } }
  return n ? s / n : 0;
}

export function abandon(state, b) {
  b.abandoned = true;
  b.abandonedDays = 0;
  for (const hid of [...(b.households || [])]) { const hh = state.households.get(hid); if (hh) removeHousehold(state, hh, 'building abandoned'); }
  for (const id of [...(b.workers || [])]) { const c = state.citizens.get(id); if (c) leaveJob(state, c); }
  b.workers = [];
  bus.emit('building:changed', b);
  const why = b.problemDays > 6 ? ' (no power or water)' : (b.lowSalesDays || 0) > 20 ? ' (not enough customers)' : (b.understaffedDays || 0) > 10 ? ' (no workers)' : '';
  bus.emit('notify', { kind: 'warn', icon: '🏚️', quiet: true, target: b.id, title: 'Building abandoned', msg: `${b.def.name} was abandoned${why}.` });
}
