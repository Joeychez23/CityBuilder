// Problems: ongoing conditions the player should fix (a full landfill, a power shortage,
// sewage next to drinking water...). Checks run every hour; each one adds problems with a
// stable key, so the notification center can tell new problems from old ones and drop the
// ones that got fixed. Buildings also get a list of issues, drawn as icons above them.
import { isService, centerIdx, storageCap } from './services.js';
import { projection } from './economy.js';
import { flowNames } from './utilities.js';

const checks = [];
// fn(state, ctx, add) — call add({ key, kind: 'bad' | 'warn' | 'info', icon, title, msg, target? })
export function registerProblems(fn) { checks.push(fn); }

// Icons for building issues (also used by the notification center)
export const ISSUE_ICONS = {
  power: '⚡', water: '💧', sewage: '💩', garbage: '🗑️', dead: '⚰️', fire: '🔥', crime: '🚨', full: '⛔',
  parking: '🅿️', lotfull: '🅿️', abandoned: '🏚️', noroad: '🚧', polluted: '☣️', sick: '🤒', staff: '👷', customers: '🛍️', supplies: '📦', needs: '🔒',
};
// What each icon means, for tooltips and the inspector
export const ISSUE_TEXT = {
  power: 'Needs power', water: 'Needs water', sewage: 'Sewage backing up', garbage: 'Garbage not collected', dead: 'Waiting for a hearse',
  fire: 'On fire', crime: 'High crime', full: 'Full', parking: 'Not enough parking: some workers walk to work', lotfull: 'Full: more drivers wanted to park here (they walk to work instead)', abandoned: 'Abandoned',
  noroad: 'No road access', polluted: 'Polluted tap water', sick: 'Sick residents', staff: 'Short of staff',
  customers: 'Not enough customers (too many shops for the people nearby)',
  supplies: 'Short of the goods it makes things from (link it to the highway to import them)', needs: 'Missing something it needs to run',
};
// Most urgent first: a building shows up to three icons above it
const ISSUE_ORDER = ['fire', 'noroad', 'needs', 'power', 'water', 'sewage', 'garbage', 'parking', 'full', 'lotfull', 'polluted', 'dead', 'crime', 'staff', 'supplies', 'customers', 'abandoned'];

// The deceased in it have waited most of a morning for a hearse
const deadWaiting = (b) => (b.dead || 0) >= 1 && (b.deadHours || 0) >= 8;

export function buildingIssues(state, ctx, b) {
  const out = [];
  if (b.cons) return out; // a building site has nothing to complain about yet
  if (b.onFire) out.push('fire');
  if (b.abandoned) { out.push('abandoned'); return out; }
  // anything people use (or would use, once someone moves in) that it isn't getting
  const lives = (b.powerUse || 0) > 0 || (b.waterUse || 0) > 0 || (b.households?.length || 0) > 0 || (b.workerCount || b.workers?.length || 0) > 0;
  if (lives && b.power < 0.95) out.push('power');
  if (lives && b.water < 0.9) out.push('water');
  else if (lives && b.sewage < 0.9) out.push('sewage');
  if ((b.waterPolluted || 0) > 0.3) out.push('polluted');
  // garbage: more than a couple of days' worth waiting, or none collected nearby at all
  const perDay = (b.garbageRate || 0) * 24;
  const g = b.garbage || 0;
  if ((g > 0.8 && g > perDay * 2.5) || (g > 0.4 && (ctx.coverage.garbage?.[centerIdx(b)] || 0) < 0.05)) out.push('garbage');
  if (deadWaiting(b)) out.push('dead');
  if ((b.crime || 0) > 65) out.push('crime');
  if (b.def.storage && (b.stored || 0) >= storageCap(b) - 0.5) out.push('full');
  if (b.parkingShort > 0.15 && (b.parkingNeed || 0) >= 1) out.push('parking');
  if (b.def.parking && (b.turnedAway || 0) > 0 && (b.used || 0) >= (b.spaces || 0)) out.push('lotfull');
  if (b.roadAccess === false || (b.kind === 'zone' && b.comp === -1 && b.compStamp === ctx.netStamp)) out.push('noroad');
  if (isService(b) && b.def.workers && (b.staff ?? b.def.workers) < b.def.workers * 0.4) out.push('staff');
  if (isService(b) && b.shortInputs) out.push('supplies');
  if (isService(b) && b.missing) out.push('needs');
  // grown workplaces: jobs nobody fills, shops nobody shops at (once they've been open a while)
  const open = state.time.day - (b.built ?? state.time.day) > 3;
  if (b.kind === 'zone' && !b.def.signature && open && b.jobs >= 2 && (b.workerCount ?? b.workers.length) < b.jobs * 0.4) out.push('staff');
  if (b.product === 'retail' && !b.def.mixed && open && b.salesRatio != null && b.salesRatio < 0.35) out.push('customers');
  return out.sort((x, y) => ISSUE_ORDER.indexOf(x) - ISSUE_ORDER.indexOf(y));
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const worst = (list, score) => list.reduce((a, b) => (score(b) > score(a) ? b : a), list[0]);

// Built-in checks. Feature stages register more with registerProblems().
registerProblems((state, ctx, add) => {
  const B = [...state.buildings.values()];
  if (state.money < 0 && !state.options.unlimitedMoney) {
    add({ key: 'money', kind: 'bad', icon: '💸', title: 'Out of money', msg: 'The city is in the red. Raise taxes, cut service budgets or take a loan before Saturday\'s bills.' });
  } else if (!state.options.unlimitedMoney && state.history.length > 2) {
    const p = projection(state);
    if (p.endMoney < 0) add({ key: 'money-week', kind: 'warn', icon: '📉', title: 'Heading into the red', msg: `At this rate the city will be ₡${Math.round(-p.endMoney).toLocaleString()} short when the week is paid on Saturday.` });
  }
  const u = state.stats.utilities || {};
  for (const n of ctx.elecNets || []) {
    if (!n.demand || n.ratio >= 0.995) continue;
    const mw = (v) => (v < 1 ? `${Math.round(v * 1000)} kW` : `${v.toFixed(1)} MW`);
    if (!n.hasSource) add({ key: `power-nosource:${n.sample}`, kind: 'bad', icon: '🔌', title: 'No power source', msg: `${plural(n.buildings, 'building')} on a network with no power plant (needs ${mw(n.demand)}). Run a power line from a plant or the outside power line.`, target: n.sample });
    else add({ key: `power-short:${n.sample}`, kind: 'bad', icon: '⚡', title: 'Not enough power', msg: `A network needs ${mw(n.demand)} but only gets ${mw(n.demand * n.ratio)}. Lights go out at night. Build power plants or batteries, or connect to the outside power line.`, target: n.sample });
  }
  const dry = B.filter((b) => (b.waterUse || 0) > 0 && b.water < 0.6);
  if (dry.length) add({ key: 'water', kind: 'bad', icon: '💧', title: 'Water shortage', msg: `${plural(dry.length, 'building')} without enough water. Build pumps or connect them with pipes or roads.`, target: dry[0].id });
  const backed = B.filter((b) => (b.waterUse || 0) > 0 && b.water >= 0.6 && b.sewage < 0.6);
  if (backed.length) add({ key: 'sewage', kind: 'bad', icon: '💩', title: 'Sewage backing up', msg: `${plural(backed.length, 'building')} can't get rid of sewage. Build a sewage outlet or treatment plant on the same network.`, target: backed[0].id });
  if ((u.pollutedWater || 0) > 0) {
    const p = B.filter((b) => (b.waterPolluted || 0) > 0.3);
    if (p.length) add({ key: 'polluted-water', kind: 'bad', icon: '☣️', title: 'Polluted tap water', msg: `${plural(p.length, 'building')} get dirty tap water. Move pumps upstream of sewage outlets, or treat the sewage.`, target: p[0].id });
  }
  const F = flowNames(state);
  for (const n of ctx.sewageUpstream || []) {
    const pump = state.buildings.get(n.pump), out = state.buildings.get(n.outlet);
    if (!pump || !out) continue;
    const pn = pump.name || pump.def.name, on = out.name || out.def.name;
    const where = n.close ? `${on} pours sewage out right beside ${pn}'s intake` : `${on} pours sewage into the water ${Math.round(n.along * 8)} m upstream of ${pn}, and the current (${F.down} ${F.arrow}) carries it to the intake`;
    add({ key: `sewage-upstream:${n.pump}`, kind: 'bad', icon: '🤢', title: 'Sewage upstream of drinking water', msg: `${where}. Residents on that water network are upset. Move the outlet downstream (${F.down}) of the pump or the pump upstream (${F.up}), or treat the sewage.`, target: n.pump });
  }
  const garbage = B.filter((b) => (b.garbage || 0) > 6);
  if (garbage.length) add({ key: 'garbage', kind: garbage.length > 10 ? 'bad' : 'warn', icon: '🗑️', title: 'Garbage piling up', msg: `${plural(garbage.length, 'building')} waiting for the garbage truck. Lay out a landfill nearby (or make yours bigger: bigger landfills run more trucks), or add an incinerator, and check the trucks can drive there.`, target: worst(garbage, (b) => b.garbage).id });
  for (const b of B) {
    if (!b.def.storage) continue;
    const cap = storageCap(b);
    const fill = (b.stored || 0) / cap;
    const what = b.def.garbageRate ? 'Landfill' : 'Cemetery';
    if (fill >= 0.999) add({ key: `full:${b.id}`, kind: 'bad', icon: '⛔', title: `${what} full`, msg: `${b.name || b.def.name} is full and its trucks have stopped. ${b.def.garbageRate ? 'Drag more landfill area along one of its sides, or lay out a new one.' : 'Build another, or a crematorium.'}`, target: b.id });
    else if (fill >= 0.85) add({ key: `nearly:${b.id}`, kind: 'warn', icon: '⚠️', title: `${what} almost full`, msg: `${b.name || b.def.name} is ${Math.round(fill * 100)}% full.${b.def.garbageRate ? ' Drag more landfill area along one of its sides to make it bigger.' : ''}`, target: b.id });
  }
  const dead = B.filter(deadWaiting);
  if (dead.length) add({ key: 'deathcare', kind: 'warn', icon: '⚰️', title: 'Deceased not collected', msg: `${plural(dead.length, 'building')} waiting for a hearse. Build a cemetery or crematorium.`, target: dead[0].id });
  for (const b of B) if (b.onFire) add({ key: `fire:${b.id}`, kind: 'bad', icon: '🔥', title: 'Building on fire', msg: `${b.name || b.def.name} is burning.${(ctx.coverage.fire?.[centerIdx(b)] || 0) < 0.15 ? ' No fire station covers it!' : ' Fire engines are on the way.'}`, target: b.id });
  const crime = B.filter((b) => (b.crime || 0) > 65);
  if (crime.length) add({ key: 'crime', kind: crime.length > 6 ? 'bad' : 'warn', icon: '🚨', title: 'High crime', msg: `${plural(crime.length, 'building')} with a lot of crime. Build police stations nearby.`, target: worst(crime, (b) => b.crime).id });
  if ((state.stats.jailCap || 0) > 0 && (state.stats.jailed || 0) >= state.stats.jailCap) add({ key: 'jail', kind: 'warn', icon: '🚔', title: 'Jails are full', msg: 'Police can\'t hold anyone else. Build a bigger police station or a prison.' });
  const abandoned = B.filter((b) => b.abandoned);
  if (abandoned.length) add({ key: 'abandoned', kind: 'warn', icon: '🏚️', title: 'Abandoned buildings', msg: `${plural(abandoned.length, 'building')} abandoned. Check their power, water and how happy people were.`, target: abandoned[0].id });
  const un = state.stats.unemployment || 0;
  if (un > 0.12 && (state.stats.adults || 0) > 30) add({ key: 'jobs', kind: un > 0.2 ? 'bad' : 'warn', icon: '💼', title: 'High unemployment', msg: `${Math.round(un * 100)}% of adults have no job. Zone commercial, industrial or offices.` });
  const jam = state.stats.worstJam;
  if (((state.stats.trafficFlow ?? 1) < 0.6 || (jam && jam.ratio > 1.5)) && state.citizens.size > 150) {
    add({ key: 'traffic', kind: (state.stats.trafficFlow ?? 1) < 0.45 ? 'bad' : 'warn', icon: '🚦', title: 'Traffic backing up', cell: jam?.cell,
      msg: `Traffic flow is ${Math.round((state.stats.trafficFlow ?? 1) * 100)}%${jam ? ` and the worst spot carries ${Math.round(jam.ratio * 100)}% of what it can` : ''}. Upgrade busy roads to ones with more lanes, put roundabouts on busy junctions, add another route or public transport.` });
  }
  const parking = B.filter((b) => b.parkingShort > 0.25 && b.parkingNeed >= 2);
  if (parking.length) {
    const P = state.stats.parking || {};
    const lost = Math.max(0, (P.carsWithoutSpace || 0) - (P.walking || 0));
    add({ key: 'parking', kind: parking.length > 5 ? 'bad' : 'warn', icon: '🅿️', title: 'Workplaces need parking', msg: `${plural(parking.length, 'workplace')} ${parking.length === 1 ? 'is' : 'are'} short of parking: ${plural(P.walking || 0, 'driver')} walk${(P.walking || 0) === 1 ? 's' : ''} to work from home instead${P.fullLots ? ` (${plural(P.fullLots, 'lot')} full)` : ''}${lost ? `, and ${plural(lost, 'commuter')} from other cities can't come in` : ''}. Build parking lots within a short walk of shops, offices and industry.`, target: worst(parking, (b) => b.parkingNeed - b.parkingGot).id });
  }
  const unstaffed = B.filter((b) => isService(b) && b.def.workers && (b.staff ?? b.def.workers) < b.def.workers * 0.4);
  if (unstaffed.length) add({ key: 'staff', kind: 'warn', icon: '👷', title: 'Services short of staff', msg: `${plural(unstaffed.length, 'service building')} can't find enough workers and run slowly.`, target: unstaffed[0].id });
});

// Run all checks: returns the problems and sets b.issues on every building
export function computeProblems(state, ctx) {
  for (const b of state.buildings.values()) b.issues = buildingIssues(state, ctx, b);
  const out = [];
  const add = (p) => out.push(p);
  for (const fn of checks) fn(state, ctx, add);
  return out;
}
