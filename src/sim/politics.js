// City politics: your approval rating, elections with campaign promises, residents'
// petitions, and contracts the national government offers. Most of it reaches you as
// decisions on the mayor's desk (sim/decisions.js).
//
// state.politics = { approval, nextElection, term, promise, council, petitions, contracts,
//   boosts: [{ amount, until, why }], history }
import { idx, clamp } from '../core/grid.js';
import { rng } from '../core/rng.js';
import { center } from './services.js';
import { SERVICE_CATS } from '../data/services.js';
import { addDecision, registerDecision } from './decisions.js';
import { earn } from './economy.js';
import { bus } from '../core/events.js';
import { formatDate } from './simulation.js';

export const TERM_DAYS = 56;      // an election every 8 weeks
const CAMPAIGN_DAYS = 7;          // the campaign starts a week before
export const COUNCIL_TAX_CAP = 12; // an opposition council won't let taxes go above this

export function politicsOf(state) {
  if (!state.politics) state.politics = { approval: 60, nextElection: state.time.day + 28, term: 1, promise: null, council: null, petitions: [], contracts: [], boosts: [], history: [] };
  return state.politics;
}
export const electionsOn = (state) => state.options.elections !== false;
const P = politicsOf;

// A short-lived lift (or dent) in approval
export function boostApproval(state, amount, days, why) {
  P(state).boosts.push({ amount, until: state.time.day + days, why });
}

// What approval is made of today: [label, points]
export function approvalFactors(state, ctx) {
  const s = state.stats;
  const p = P(state);
  const out = [];
  out.push(['Happiness', ((s.happiness ?? 60) - 50) * 0.8]);
  out.push(['Jobs', -clamp(((s.unemployment || 0) - 0.04) * 250, -6, 25)]);
  out.push(['City finances', state.money < 0 ? -10 : (s.weeklyBalance || 0) < 0 ? -3 : 3]);
  out.push(['Taxes', -Math.max(0, (state.taxes.res - 10) * 1.5)]);
  if (ctx.economy?.phase === 'recession') out.push(['The recession', -6]);
  if (ctx.economy?.phase === 'boom') out.push(['The boom', 4]);
  if (state.strike) out.push([`${state.strike.name} on strike`, -8]);
  const B = {};
  for (const b of p.boosts) if (b.until > state.time.day) B[b.why] = (B[b.why] || 0) + b.amount;
  for (const [k, v] of Object.entries(B)) out.push([k, v]);
  return out.filter(([, v]) => Math.abs(v) >= 0.5);
}

export function approvalDaily(state, ctx) {
  const p = P(state);
  p.boosts = p.boosts.filter((b) => b.until > state.time.day);
  const target = clamp(55 + approvalFactors(state, ctx).reduce((a, [, v]) => a + v, 0), 0, 100);
  p.approval = clamp(p.approval + (target - p.approval) * 0.2, 0, 100);
  p.target = target;
  if (electionsOn(state)) electionsDaily(state, ctx);
  petitionsDaily(state, ctx);
  contractsDaily(state, ctx);
  // an opposition council keeps taxes down
  if (p.council) for (const k of ['res', 'com', 'ind', 'off']) state.taxes[k] = Math.min(state.taxes[k], COUNCIL_TAX_CAP);
  if (p.council && p.council.until <= state.time.day) {
    p.council = null;
    bus.emit('notify', { kind: 'good', icon: '🏛️', title: 'The council is yours again', msg: 'The opposition\'s term is over: taxes and loans are back in your hands.' });
  }
  state.stats.approval = Math.round(p.approval);
}

// ---------------------------------------------------------------- elections
// Promises you can campaign on, picked from what the city needs most. Each has a measure
// and a target to reach by the next election.
const PROMISES = [
  { key: 'traffic', label: 'Fix the traffic', detail: 'Traffic flowing at 85% or better on election day', measure: (s) => (s.stats.trafficFlow ?? 1) * 100, goal: () => 85, need: (s) => (s.stats.trafficFlow ?? 1) < 0.85, unit: '%' },
  { key: 'jobs', label: 'More jobs', detail: 'Unemployment under 5% on election day', measure: (s) => (s.stats.unemployment || 0) * 100, goal: () => 5, below: true, need: (s) => (s.stats.unemployment || 0) > 0.05, unit: '%' },
  { key: 'crime', label: 'Safer streets', detail: 'Half the crimes a day there are now', measure: (s) => s.stats.crimes || 0, goal: (s) => Math.floor((s.stats.crimes || 0) / 2), below: true, need: (s) => (s.stats.crimes || 0) >= 4 },
  { key: 'air', label: 'Clean the air', detail: 'A quarter less smog over the city', measure: (s) => smogLevel(s), goal: (s) => smogLevel(s) * 0.75, below: true, need: (s) => smogLevel(s) > 30 },
  { key: 'health', label: 'Better healthcare', detail: 'Average health of 72 or more', measure: (s) => s.stats.health ?? 0, goal: () => 72, need: (s) => (s.stats.health ?? 0) < 72 },
  { key: 'growth', label: 'Grow the city', detail: 'A tenth more people by election day', measure: (s) => s.citizens.size, goal: (s) => Math.round(s.citizens.size * 1.1), need: () => true },
  { key: 'taxes', label: 'Lower taxes', detail: 'Residential tax two points lower than now', measure: (s) => s.taxes.res, goal: (s) => s.taxes.res - 2, below: true, need: (s) => s.taxes.res >= 9 },
  { key: 'happy', label: 'A happier city', detail: 'Happiness of 70% or more', measure: (s) => s.stats.happiness ?? 0, goal: () => 70, need: (s) => (s.stats.happiness ?? 0) < 70 },
];
function smogLevel(state) { let a = 0; for (let i = 0; i < state.air.length; i += 7) a += state.air[i]; return Math.round(a); }
export const promiseDef = (key) => PROMISES.find((p) => p.key === key);
export function promiseMet(state, pr) {
  const d = promiseDef(pr.key), v = d.measure(state);
  return d.below ? v <= pr.goal : v >= pr.goal;
}

function electionsDaily(state, ctx) {
  const p = P(state);
  const day = state.time.day;
  if (!p.campaigned && day >= p.nextElection - CAMPAIGN_DAYS) {
    p.campaigned = true;
    const pool = PROMISES.filter((d) => d.need(state));
    const pick = [];
    while (pick.length < 3 && pool.length) pick.push(pool.splice(rng.int(0, pool.length - 1), 1)[0]);
    addDecision(state, {
      kind: 'campaign', icon: '🗳️', title: `Election campaign: vote on ${formatDate(p.nextElection)}`,
      text: `Your approval is ${Math.round(p.approval)}%. Make a promise to win votes now; keep it by election day and the voters reward you, break it and they won't forget.`,
      data: { keys: pick.map((d) => d.key), goals: pick.map((d) => d.goal(state)) }, expires: p.nextElection - 1, defaultChoice: pick.length,
      options: [...pick.map((d) => ({ label: `Promise: ${d.label}`, detail: d.detail })), { label: 'No promises', detail: 'Run on your record' }],
    });
  }
  if (day >= p.nextElection) holdElection(state, ctx);
}

registerDecision('campaign', {
  apply(state, ctx, d, choice) {
    const p = P(state);
    const key = d.data.keys[choice];
    if (!key) return { msg: 'You run on your record.', kind: 'info' };
    p.promise = { key, goal: d.data.goals[choice], made: state.time.day };
    boostApproval(state, 6, CAMPAIGN_DAYS + 1, 'Campaign promise');
    return { msg: `"${promiseDef(key).label}" — the crowds cheer. Keep it by election day.`, kind: 'good' };
  },
});

function holdElection(state, ctx) {
  const p = P(state);
  let share = p.approval + rng.range(-4, 4);
  let promiseNote = '';
  if (p.promise) {
    const kept = promiseMet(state, p.promise);
    share += kept ? 6 : -10;
    promiseNote = kept ? ` You kept your promise ("${promiseDef(p.promise.key).label}").` : ` You broke your promise ("${promiseDef(p.promise.key).label}").`;
    boostApproval(state, kept ? 5 : -8, 21, kept ? 'Promise kept' : 'Promise broken');
  }
  share = clamp(share, 5, 95);
  const won = share >= 50;
  p.history.push({ day: state.time.day, share: Math.round(share), won, promise: p.promise?.key || null, kept: p.promise ? promiseMet(state, p.promise) : null });
  if (p.history.length > 30) p.history.shift();
  p.promise = null;
  p.campaigned = false;
  p.nextElection = state.time.day + TERM_DAYS;
  p.term++;
  state.journal.push({ day: state.time.day, kind: 'policy', text: `Election: ${won ? 're-elected' : 'the opposition won the council'} with ${Math.round(won ? share : 100 - share)}% of the vote` });
  if (won) {
    const prize = Math.round(Math.max(20000, (state.stats.weeklyIncome || 0) * 0.05));
    earn(state, 'grants', prize);
    state.progression.devPoints++;
    boostApproval(state, 3, 14, 'Fresh mandate');
    bus.emit('notify', { kind: 'good', icon: '🗳️', title: `Re-elected with ${Math.round(share)}%`, msg: `The voters back you for another term.${promiseNote} The regional government sends ₡${prize.toLocaleString()} and you get a development point.` });
  } else {
    p.council = { until: p.nextElection, since: state.time.day };
    // the new council cuts spending straight away
    for (const k of Object.keys(SERVICE_CATS)) state.budgets[k] = Math.min(state.budgets[k] ?? 100, 90);
    for (const k of ['res', 'com', 'ind', 'off']) state.taxes[k] = Math.min(state.taxes[k], COUNCIL_TAX_CAP);
    bus.emit('notify', { kind: 'bad', icon: '🗳️', title: `Election lost (${Math.round(share)}%)`, msg: `You stay on as mayor, but the opposition now runs the council until the next election:${promiseNote} service budgets cut to 90% at most, taxes no higher than ${COUNCIL_TAX_CAP}%, and no new loans.` });
  }
  bus.emit('election', { won, share });
}

// ---------------------------------------------------------------- petitions
// Residents ask for something near them; get it done before the deadline for their thanks.
const ASKS = [
  { key: 'park', what: 'a park nearby', cov: 'leisure', min: 0.35, icon: '🌳' },
  { key: 'transit', what: 'a bus or tram stop nearby', cov: 'transit', min: 0.3, icon: '🚏' },
  { key: 'police', what: 'police patrols nearby', cov: 'police', min: 0.3, icon: '🚓' },
  { key: 'health', what: 'a clinic nearby', cov: 'health', min: 0.3, icon: '🏥' },
  { key: 'school', what: 'a school for their children', cov: 'education1', min: 0.3, icon: '🎒' },
  { key: 'internet', what: 'decent internet', cov: 'telecom', min: 0.4, icon: '📡' },
  { key: 'quiet', what: 'quieter streets', noise: 0.35, icon: '🔇' },
];
const askDef = (k) => ASKS.find((a) => a.key === k);
const covAtCell = (state, ctx, a, i) => (a.cov === 'transit' ? ctx.transitCov?.[i] || 0 : ctx.coverage[a.cov]?.[i] || 0);
const askMet = (state, ctx, a, i) => (a.noise ? state.noise[i] < a.noise : covAtCell(state, ctx, a, i) >= a.min);

function streetName(state, b) {
  const NAMES = ['Elm', 'Maple', 'Oak', 'Birch', 'Willow', 'Cedar', 'Chestnut', 'Linden', 'Poplar', 'Ash', 'Rowan', 'Hazel', 'Juniper', 'Larch'];
  const KINDS = ['Street', 'Road', 'Avenue', 'Lane', 'Way', 'Crescent'];
  return `${NAMES[(b.x0 * 7 + b.y0 * 13) % NAMES.length]} ${KINDS[(b.x0 + b.y0) % KINDS.length]}`;
}

function petitionsDaily(state, ctx) {
  const p = P(state);
  // check the ones you took on
  for (const pt of [...p.petitions]) {
    const a = askDef(pt.key);
    if (askMet(state, ctx, a, pt.cell)) {
      p.petitions = p.petitions.filter((x) => x !== pt);
      boostApproval(state, 3, 21, 'Petitions answered');
      earn(state, 'grants', pt.reward);
      bus.emit('xp', { amount: 25, reason: 'petition' });
      bus.emit('notify', { kind: 'good', icon: a.icon, title: 'Petition answered', cell: pt.cell, msg: `Residents of ${pt.street} got ${a.what}. They're telling everyone (+3 approval, ₡${pt.reward.toLocaleString()} from the neighbourhood fund).` });
    } else if (state.time.day >= pt.due) {
      p.petitions = p.petitions.filter((x) => x !== pt);
      boostApproval(state, -3, 21, 'Petitions ignored');
      bus.emit('notify', { kind: 'warn', icon: a.icon, title: 'Petition not met', cell: pt.cell, msg: `Residents of ${pt.street} are still waiting for ${a.what}.` });
    }
  }
  // a new one now and then
  if (state.citizens.size < 300 || p.petitions.length >= 3 || (state.decisions || []).some((d) => d.kind === 'petition')) return;
  if (state.time.day < (p.nextPetition ?? state.time.day + 2)) { p.nextPetition = p.nextPetition ?? state.time.day + 2; return; }
  p.nextPetition = state.time.day + 3 + rng.int(0, 3);
  const homes = [...state.buildings.values()].filter((b) => b.kind === 'zone' && b.def.cat === 'res' && b.households.length >= 2 && !b.def.signature);
  for (let tries = 0; tries < 20; tries++) {
    const b = homes[rng.int(0, homes.length - 1)];
    if (!b) return;
    const i = idx(...center(b));
    const lacking = ASKS.filter((a) => !askMet(state, ctx, a, i) && !(a.key === 'school' && !(b.def.family > 0.3 || b.def.key === 'res_low')));
    if (!lacking.length) continue;
    const a = lacking[rng.int(0, lacking.length - 1)];
    const street = streetName(state, b);
    const reward = 5000 + Math.round(state.citizens.size * 0.5);
    addDecision(state, {
      kind: 'petition', icon: a.icon, title: `Petition from ${street}`,
      text: `${b.households.length * 2 + rng.int(5, 40)} residents of ${street} signed a petition asking for ${a.what}. Take it on and get it done within 14 days for their thanks.`,
      cell: i, target: b.id, data: { key: a.key, cell: i, street, reward }, expires: state.time.day + 3,
      options: [{ label: 'We\'ll get it done', detail: `+3 approval and ₡${reward.toLocaleString()} when it's done (14 days)` }, { label: 'Not now', detail: '−1 approval' }],
    });
    return;
  }
}
registerDecision('petition', {
  apply(state, ctx, d, choice) {
    if (choice !== 0) { boostApproval(state, -1, 14, 'Petitions ignored'); return { msg: 'The residents are disappointed.', kind: 'info' }; }
    P(state).petitions.push({ ...d.data, due: state.time.day + 14, since: state.time.day });
    return { msg: `Promised: ${askDef(d.data.key).what} for ${d.data.street}. See the City Hall panel for how it's going.`, kind: 'good' };
  },
  expire(state) { boostApproval(state, -1, 14, 'Petitions ignored'); return { msg: 'Nobody answered the petition.', kind: 'info' }; },
});
export const petitionProgress = (state, ctx, pt) => {
  const a = askDef(pt.key);
  return a.noise ? clamp((1 - state.noise[pt.cell]) / (1 - a.noise), 0, 1) : clamp(covAtCell(state, ctx, a, pt.cell) / a.min, 0, 1);
};
export const petitionText = (pt) => askDef(pt.key).what;

// ---------------------------------------------------------------- contracts
// Goals the national government will pay for: money, or an expansion permit
const CONTRACTS = [
  { key: 'pop', label: (g) => `Reach ${g.toLocaleString()} citizens`, measure: (s) => s.citizens.size, goal: (s) => Math.round(s.citizens.size * 1.12 / 100) * 100 + 100 },
  { key: 'smog', label: (g) => `Cut the smog to ${g}`, measure: (s) => smogLevel(s), goal: (s) => Math.round(smogLevel(s) * 0.7), below: true, ok: (s) => smogLevel(s) > 40 },
  { key: 'unemp', label: (g) => `Unemployment under ${g}%`, measure: (s) => Math.round((s.stats.unemployment || 0) * 1000) / 10, goal: () => 4, below: true, ok: (s) => (s.stats.unemployment || 0) > 0.05 },
  { key: 'tourists', label: (g) => `${g.toLocaleString()} tourists in a day`, measure: (s) => s.stats.tourists || 0, goal: (s) => Math.round(Math.max(300, (s.stats.tourists || 0) * 1.4) / 50) * 50 },
  { key: 'happy', label: (g) => `Happiness of ${g}%`, measure: (s) => Math.round(s.stats.happiness ?? 0), goal: (s) => Math.min(90, Math.round((s.stats.happiness ?? 50) + 6)) },
  { key: 'transit', label: (g) => `${g.toLocaleString()} transit riders a day`, measure: (s) => s.stats.transitRiders || 0, goal: (s) => Math.round(Math.max(200, (s.stats.transitRiders || 0) * 1.5) / 50) * 50 },
  { key: 'trees', label: (g) => `Plant ${g} more trees`, measure: (s) => s.counters.treesPlanted || 0, goal: (s) => (s.counters.treesPlanted || 0) + 150, delta: true },
];
const contractDef = (k) => CONTRACTS.find((c) => c.key === k);
export const contractLabel = (c) => contractDef(c.key).label(c.goal);
export const contractNow = (state, c) => contractDef(c.key).measure(state);
export const contractDone = (state, c) => { const d = contractDef(c.key), v = d.measure(state); return d.below ? v <= c.goal : v >= c.goal; };

function contractsDaily(state, ctx) {
  const p = P(state);
  for (const c of [...p.contracts]) {
    if (contractDone(state, c)) {
      p.contracts = p.contracts.filter((x) => x !== c);
      if (c.reward === 'permit') state.progression.permits++;
      else earn(state, 'grants', c.reward);
      boostApproval(state, 2, 14, 'Contracts delivered');
      bus.emit('notify', { kind: 'good', icon: '📜', title: 'Contract delivered', msg: `${contractLabel(c)}: done. ${c.reward === 'permit' ? 'The government grants an expansion permit.' : `The government pays ₡${c.reward.toLocaleString()}.`}` });
    } else if (state.time.day >= c.due) {
      p.contracts = p.contracts.filter((x) => x !== c);
      bus.emit('notify', { kind: 'warn', icon: '📜', title: 'Contract missed', msg: `${contractLabel(c)}: time ran out. No harm done, but no reward either.` });
    }
  }
  if (state.citizens.size < 500 || p.contracts.length >= 2 || (state.decisions || []).some((d) => d.kind === 'contract')) return;
  if (state.time.day < (p.nextContract ?? state.time.day + 5)) { p.nextContract = p.nextContract ?? state.time.day + 5; return; }
  p.nextContract = state.time.day + 8 + rng.int(0, 6);
  const pool = CONTRACTS.filter((c) => !c.ok || c.ok(state)).filter((c) => !p.contracts.some((x) => x.key === c.key));
  const d = pool[rng.int(0, pool.length - 1)];
  if (!d) return;
  const goal = d.goal(state);
  const days = 20 + rng.int(0, 10);
  const permit = rng.chance(0.3);
  const reward = permit ? 'permit' : Math.round((40000 + state.citizens.size * 4) / 1000) * 1000;
  addDecision(state, {
    kind: 'contract', icon: '📜', title: 'An offer from the national government',
    text: `${d.label(goal)} within ${days} days, and ${permit ? 'the government will grant you an expansion permit (another map tile)' : `the government will pay ₡${reward.toLocaleString()}`}. Now: ${d.measure(state).toLocaleString()}.`,
    data: { key: d.key, goal, days, reward }, expires: state.time.day + 3,
    options: [{ label: 'Accept the contract', detail: permit ? 'Reward: an expansion permit' : `Reward: ₡${reward.toLocaleString()}` }, { label: 'Decline', detail: 'No penalty' }],
  });
}
registerDecision('contract', {
  apply(state, ctx, d, choice) {
    if (choice !== 0) return { msg: 'You turned the offer down.', kind: 'info' };
    P(state).contracts.push({ key: d.data.key, goal: d.data.goal, reward: d.data.reward, due: state.time.day + d.data.days, since: state.time.day, start: contractDef(d.data.key).measure(state) });
    return { msg: `Contract signed: ${contractDef(d.data.key).label(d.data.goal)}.`, kind: 'good' };
  },
});

export const councilBlocks = (state) => !!state.politics?.council;
