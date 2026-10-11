// The wider economy, rents and the unions:
//  - booms and recessions come in waves: business does better or worse, and in a recession
//    you choose how the city answers (raise taxes, cut services, borrow and spend, or wait)
//  - rents rise where a neighbourhood is popular and push poorer households out (to cheaper
//    homes in town if there are any, else out of town); rent control holds them down
//  - workers in a city service go on strike when they're squeezed, until you meet them
import { clamp } from '../core/grid.js';
import { rng } from '../core/rng.js';
import { isService, center } from './services.js';
import { addDecision, registerDecision } from './decisions.js';
import { takeLoan, loanLimit } from './economy.js';
import { boostApproval } from './politics.js';
import { SERVICE_CATS } from '../data/services.js';
import { bus } from '../core/events.js';
import { idx } from '../core/grid.js';

// ---------------------------------------------------------------- the cycle
// state.economyCycle = { phase: 'normal' | 'boom' | 'recession', day, length, next, index, response }
export function cycleOf(state) {
  if (!state.economyCycle) state.economyCycle = { phase: 'normal', day: 0, length: 0, next: state.time.day + 25 + rng.int(0, 20), index: 1, response: null };
  return state.economyCycle;
}
// How business is going: 1 normal, up to about 1.12 in a boom, down to 0.85 in a recession
export const businessIndex = (state) => state.economyCycle?.index ?? 1;

export function cycleDaily(state, ctx) {
  const E = cycleOf(state);
  const day = state.time.day;
  if (E.phase === 'normal' && day >= E.next && state.citizens.size > 800) {
    const bust = rng.chance(0.55);
    E.phase = bust ? 'recession' : 'boom';
    E.day = day; E.length = 14 + rng.int(0, 14);
    bus.emit('notify', { kind: bust ? 'bad' : 'good', icon: bust ? '📉' : '📈', title: bust ? 'Recession' : 'Economic boom',
      msg: bust ? 'The wider economy has turned down: businesses earn less, some cut jobs, fewer tourists spend. Decide how the city answers on the mayor\'s desk.' : 'Business is booming across the region: companies earn more, more tourists come and spend, and taxes bring in more.' });
    state.journal.push({ day, kind: 'budget', text: bust ? 'A recession began' : 'An economic boom began' });
    if (bust) offerResponse(state);
  } else if (E.phase !== 'normal' && day >= E.day + E.length) {
    endPhase(state, E);
  }
  // the index eases in and out of each phase
  const want = E.phase === 'boom' ? 1.12 : E.phase === 'recession' ? 0.85 : 1;
  E.index += (want - E.index) * 0.25;
  ctx.economy = { phase: E.phase, index: E.index };
  // borrowing to spend: the stimulus props up demand while the recession lasts
  ctx.stimulus = E.phase === 'recession' && E.response === 'stimulus';
}

function endPhase(state, E) {
  const was = E.phase;
  // whatever you chose for the recession is undone
  if (E.response === 'taxes' && E.saved) for (const [k, v] of Object.entries(E.saved.taxes)) state.taxes[k] = Math.min(state.taxes[k], v);
  if (E.response === 'cuts' && E.saved) for (const [k, v] of Object.entries(E.saved.budgets)) state.budgets[k] = v;
  E.phase = 'normal'; E.response = null; E.saved = null;
  E.next = state.time.day + 30 + rng.int(0, 30);
  state.journal.push({ day: state.time.day, kind: 'budget', text: was === 'boom' ? 'The boom levelled off' : 'The recession ended' });
  bus.emit('notify', { kind: 'info', icon: was === 'boom' ? '📈' : '📉', title: was === 'boom' ? 'The boom is over' : 'The recession is over', msg: was === 'boom' ? 'Business is back to normal.' : 'Business is picking up again. Taxes and budgets you changed for it are back where they were.' });
}

function offerResponse(state) {
  const loan = Math.max(0, Math.min(Math.round(loanLimit(state) * 0.25 / 1000) * 1000, loanLimit(state) - state.loan));
  addDecision(state, {
    kind: 'recession', icon: '📉', title: 'Recession: how will the city answer?',
    text: 'Tax income is falling and businesses are struggling. Whatever you choose lasts until the recession ends.',
    data: { loan }, expires: state.time.day + 3, defaultChoice: 3,
    options: [
      { label: 'Raise taxes to balance the books', detail: '+3% on every tax · approval −5' },
      { label: 'Cut service budgets', detail: 'Every service to 85% · approval −3' },
      { label: loan ? `Borrow and spend (₡${loan.toLocaleString()})` : 'Borrow and spend (no room to borrow)', detail: 'A loan to keep demand up · approval +2 · debt' },
      { label: 'Ride it out', detail: 'Change nothing · approval −2' },
    ],
  });
}
registerDecision('recession', {
  apply(state, ctx, d, choice) {
    const E = cycleOf(state);
    if (E.phase !== 'recession') return { msg: 'The recession is already over.', kind: 'info' };
    if (choice === 0) {
      E.response = 'taxes'; E.saved = { taxes: { ...state.taxes, resEdu: undefined } };
      delete E.saved.taxes.resEdu;
      for (const k of ['res', 'com', 'ind', 'off']) state.taxes[k] = Math.min(30, state.taxes[k] + 3);
      boostApproval(state, -5, E.length, 'Recession tax rise');
      return { msg: 'Taxes are up 3% until the recession ends.', kind: 'info' };
    }
    if (choice === 1) {
      E.response = 'cuts'; E.saved = { budgets: {} };
      for (const k of Object.keys(SERVICE_CATS)) { E.saved.budgets[k] = state.budgets[k] ?? 100; state.budgets[k] = Math.min(state.budgets[k] ?? 100, 85); }
      ctx.servicesDirty = true;
      boostApproval(state, -3, E.length, 'Recession cuts');
      return { msg: 'Every service runs on 85% until the recession ends (watch for strikes).', kind: 'info' };
    }
    if (choice === 2) {
      const got = takeLoan(state, d.data.loan);
      if (!got) return { msg: 'There was no room to borrow: nothing changes.', kind: 'warn' };
      E.response = 'stimulus';
      boostApproval(state, 2, E.length, 'Stimulus');
      return { msg: `Borrowed ₡${got.toLocaleString()} to keep the city's businesses going: demand holds up until the recession ends.`, kind: 'good' };
    }
    E.response = 'wait';
    boostApproval(state, -2, E.length, 'Recession');
    return { msg: 'You ride it out.', kind: 'info' };
  },
});

// ------------------------------------------------------------------- rents
// Each home's rent index (1 = the going rate) creeps up while the neighbourhood is in demand
// and short of space, and eases down when homes stand empty. Low-rent housing doesn't take
// part; rent control in a district caps it.
export const RENT_CONTROL_CAP = 1.15;
export function rentsDaily(state) {
  const demand = state.demand?.res ?? 0.3;
  let pushed = 0, moved = 0;
  // vacant homes, cheapest first (for households priced out to move into)
  const vacant = [];
  for (const b of state.buildings.values()) {
    if (b.kind !== 'zone' || b.def.cat !== 'res' || b.abandoned || b.cons || !(b.hhCap > b.households.length)) continue;
    vacant.push(b);
  }
  for (const b of state.buildings.values()) {
    if (b.kind !== 'zone' || b.def.cat !== 'res' || b.abandoned) continue;
    if (b.def.lowRent || b.def.signature) { b.rentIndex = 1; continue; }
    const lv = state.landValue[idx(...center(b))] || 0;
    const full = b.hhCap ? b.households.length / b.hhCap : 0;
    const control = b.district && state.districts.find((d) => d.id === b.district)?.policies?.rentControl;
    let r = b.rentIndex ?? 1;
    if (full > 0.92 && demand > 0.25 && lv > 0.45) r *= 1 + 0.004 + (lv - 0.45) * 0.02 + (demand - 0.25) * 0.01;
    else if (full < 0.7) r *= 0.99;
    r = clamp(r, 0.8, control ? RENT_CONTROL_CAP : 2.5);
    b.rentIndex = r;
    if (r < 1.25) continue;
    // households whose income no longer covers the rent leave, or find somewhere cheaper
    for (const hid of [...b.households]) {
      const hh = state.households.get(hid);
      if (!hh || hh.rent <= 0 || hh.income > hh.rent * 1.35 || hh.wealth > hh.rent * 8) continue;
      if (!rng.chance(0.15)) continue;
      const cheaper = vacant.find((v) => v !== b && v.households.length < v.hhCap && (v.rentIndex ?? 1) * (v.def.lowRent ? 0.55 : 1) < r * 0.8);
      if (cheaper) {
        b.households = b.households.filter((h) => h !== hid);
        cheaper.households.push(hid);
        hh.home = cheaper.id;
        moved++;
      } else {
        hh.leaving = true;
        hh.pricedOut = true;
        pushed++;
      }
    }
  }
  state.stats.pricedOutToday = pushed;
  state.stats.movedCheaperToday = moved;
  state.stats.pricedOutWeek = (state.stats.pricedOutWeek || 0) + pushed + moved;
}
export const rentFactor = (b) => b.rentIndex ?? 1;

// ------------------------------------------------------------------- strikes
// state.strike = { cat, name, days, demand (budget %), since } ; state.deals = { cat: until }
const UNIONS = {
  garbage: 'Garbage collectors', health: 'Hospital staff', fire: 'Firefighters', police: 'Police officers', education: 'Teachers', transport: 'Transit workers',
};
export const strikeOn = (state, cat) => state.strike?.cat === cat;

export function strikesDaily(state, ctx) {
  const st = state.strike;
  state.deals = state.deals || {};
  if (st) {
    st.days++;
    // they go back to work after a while anyway (but they'll remember)
    if (st.days >= 10) {
      state.strike = null;
      state.grudges = { ...(state.grudges || {}), [st.cat]: state.time.day + 20 };
      bus.emit('notify', { kind: 'info', icon: '🪧', title: `${st.name} back at work`, msg: 'The strike has fizzled out without a deal. They\'ll be quicker to walk out again.' });
      bus.emit('services:changed');
    }
    return;
  }
  // a deal you broke (budget cut back below what you agreed): they walk out at once
  for (const [cat, deal] of Object.entries(state.deals)) {
    if (deal.until <= state.time.day) { delete state.deals[cat]; continue; }
    if ((state.budgets[cat] ?? 100) < deal.budget) { startStrike(state, cat, deal.budget + 5, true); return; }
  }
  if (state.citizens.size < 1500) return;
  for (const cat of Object.keys(UNIONS)) {
    const staff = [...state.buildings.values()].filter((b) => isService(b) && b.def.cat === cat && b.def.workers);
    if (staff.length < 2) continue;
    const budget = state.budgets[cat] ?? 100;
    const short = staff.reduce((a, b) => a + Math.max(0, b.def.workers - (b.staff ?? b.def.workers)), 0) / staff.reduce((a, b) => a + b.def.workers, 0);
    // squeezed: a low budget, too few colleagues to share the work, a recession
    let risk = Math.max(0, (95 - budget) / 100) * 0.08 + Math.max(0, short - 0.25) * 0.05 + (ctx.economy?.phase === 'recession' ? 0.004 : 0);
    if ((state.grudges?.[cat] || 0) > state.time.day) risk *= 2;
    if (state.deals[cat]) risk = 0;
    if (rng.chance(risk)) { startStrike(state, cat, Math.min(130, Math.max(105, budget + 15)), false); return; }
  }
}

function startStrike(state, cat, demand, broken) {
  const name = UNIONS[cat];
  state.strike = { cat, name, days: 0, demand: Math.round(demand / 5) * 5, since: state.time.day };
  bus.emit('services:changed');
  state.journal.push({ day: state.time.day, kind: 'policy', text: `${name} went on strike` });
  addDecision(state, {
    kind: 'strike', icon: '🪧', title: `${name} on strike!`,
    text: `${broken ? 'You cut their budget below what you agreed. ' : ''}${name} have walked out: the service barely runs until you meet their demand — the ${SERVICE_CATS[cat]?.name || cat} budget at ${state.strike.demand}% for the next 4 weeks.`,
    data: { cat }, expires: state.time.day + 9,
    options: [{ label: `Agree: budget to ${state.strike.demand}%`, detail: 'They go straight back to work · keep it there for 4 weeks' }, { label: 'Refuse', detail: 'The strike goes on (it fizzles out in about 10 days) · approval falls' }],
  });
}
registerDecision('strike', {
  apply(state, ctx, d, choice) {
    const st = state.strike;
    if (!st || st.cat !== d.data.cat) return { msg: 'They are already back at work.', kind: 'info' };
    if (choice !== 0) { boostApproval(state, -3, 14, 'Strikes'); return { msg: 'The strike goes on.', kind: 'warn' }; }
    state.budgets[st.cat] = Math.max(state.budgets[st.cat] ?? 100, st.demand);
    state.deals = state.deals || {};
    state.deals[st.cat] = { budget: st.demand, until: state.time.day + 28 };
    state.strike = null;
    ctx.servicesDirty = true;
    bus.emit('services:changed');
    return { msg: `Deal done: ${st.name} are back at work, on ${st.demand}% for four weeks.`, kind: 'good' };
  },
});
