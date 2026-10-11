// The city budget. Taxes, fees and costs build up in this week's ledger as they happen and
// are paid out together when Saturday ends. Until then the HUD shows a projection that moves
// with the city (it's re-estimated every hour). Construction, refunds and loans are paid at
// once. Also: daily upkeep, loans and interest, the government subsidy, and the charts.
import { ROADS, UPGRADES, UPG } from '../data/roads.js';
import { rn } from './roadnet.js';
import { newLedger } from '../core/state.js';
import { isService, buildingUpkeep } from './services.js';
import { clamp } from '../core/grid.js';
import { bus } from '../core/events.js';
import { dateOf, daysLeftInWeek, formatDate } from './simulation.js';
import { difficultyOf } from '../data/difficulty.js';

export const BASE_INTEREST = 6; // % per year
export const DAYS_PER_WEEK = 7;
export const perWeek = (perDay) => perDay * DAYS_PER_WEEK;

// Ledger lines that were already paid when they happened (not settled again on Saturday)
const PAID_AT_ONCE = new Set(['refunds']);
// Ledger lines booked once a day (the rest trickle in every hour or step)
const DAILY = new Set(['resTax', 'comTax', 'indTax', 'offTax', 'subsidy', 'transit', 'hotels', 'conventions', 'casino', 'film', 'factories', 'grants', 'themepark', 'promenade', 'regional', 'services', 'roads', 'loanInterest', 'policies', 'supplies', 'projects']);

const ensure = (state) => {
  if (!state.today) state.today = newLedger();
  if (!state.rates) state.rates = newLedger();
  if (!state.weekly) state.weekly = [];
};

// Income and costs owed this week. Positive amounts only make sense, but negative ones
// (e.g. subsidies paid through negative taxes) are allowed.
// Tax income is scaled by the difficulty (data/difficulty.js)
const TAXES = new Set(['resTax', 'comTax', 'indTax', 'offTax']);
export function earn(state, key, amount) {
  if (!amount) return;
  ensure(state);
  if (TAXES.has(key)) amount *= difficultyOf(state).income;
  state.ledger.income[key] = (state.ledger.income[key] || 0) + amount;
  state.today.income[key] = (state.today.income[key] || 0) + amount;
}
export function charge(state, key, amount) {
  if (!amount) return;
  ensure(state);
  state.ledger.expense[key] = (state.ledger.expense[key] || 0) + amount;
  state.today.expense[key] = (state.today.expense[key] || 0) + amount;
}

export function interestRate(state, ctx) {
  let r = BASE_INTEREST + difficultyOf(state).interest;
  if (ctx.cityHall) r -= 1;
  if (ctx.centralBank) r -= 2;
  r -= ctx.wonders?.interestCut || 0; // the capital's Parliament
  if (state.money < 0) r += 4;
  return clamp(r, 2.3, 20);
}

export function loanLimit(state) {
  // grows with milestones (see progression); before that, a modest starter limit
  return state.progression.loanLimit ?? 100000;
}

export function takeLoan(state, amount) {
  if (state.politics?.council) return 0; // an opposition council won't let you borrow
  const room = loanLimit(state) - state.loan;
  const a = Math.min(amount, room);
  if (a <= 0) return 0;
  state.loan += a;
  state.money += a;
  return a;
}
export function repayLoan(state, amount) {
  const a = Math.min(amount, state.loan, Math.max(0, state.money));
  state.loan -= a;
  state.money -= a;
  return a;
}

// Daily: service and road upkeep, loan interest and the subsidy go on this week's bill
export function dailyCosts(state, ctx) {
  ensure(state);
  let services = 0;
  ctx.cityHall = false; ctx.centralBank = false; ctx.hasUniversity = false;
  const byCat = {};
  for (const b of state.buildings.values()) {
    if (!isService(b) || !b.def.upkeep) continue;
    const budget = (state.budgets[b.def.cat] ?? 100) / 100;
    const cost = buildingUpkeep(b) * budget;
    services += cost;
    byCat[b.def.cat] = (byCat[b.def.cat] || 0) + cost;
    if (b.def.cityHall) ctx.cityHall = true;
    if (b.def.centralBank) ctx.centralBank = true;
    if (b.def.eduLevel === 4) ctx.hasUniversity = true;
  }
  // roads: by their length (8 m a cell), with what's along them; booths, connectors and
  // roundabouts each
  let roads = 0;
  const X = rn(state);
  const each = (bit) => UPGRADES.find((up) => up.bit === bit).upkeep;
  for (const sg of X.seg.values()) {
    const g = X.geo.get(sg.id);
    if (!g) continue;
    let per = ROADS[sg.type].upkeep;
    for (const up of UPGRADES) if ((sg.upg || 0) & up.bit && !up.single && !up.intersectionOnly) per += up.upkeep;
    roads += per * g.len;
    if (sg.toll != null) roads += each(UPG.TOLL);
    if (sg.power != null) roads += each(UPG.POWER);
  }
  for (const n of X.node.values()) if (n.ctrl === 'roundabout') roads += each(UPG.ROUNDABOUT);
  const rate = interestRate(state, ctx);
  const interest = (state.loan * rate) / 100 / 365;
  // The government subsidy shrinks as the city earns its own money
  const T = state.today.income;
  const own = T.resTax + T.comTax + T.indTax + T.offTax + T.fees;
  const subsidy = Math.max(0, 9000 - own * 0.4) * difficultyOf(state).subsidy;

  charge(state, 'services', services);
  charge(state, 'roads', roads);
  charge(state, 'loanInterest', interest);
  earn(state, 'subsidy', subsidy);
  state.stats.serviceCostByCat = byCat; // per day
  state.stats.interestRate = rate;
}

const sum = (o, skip) => Object.entries(o).reduce((a, [k, v]) => a + (skip?.has(k) ? 0 : v || 0), 0);

// After every day: learn the per-day rate of each ledger line, keep a daily snapshot
export function rollDay(state) {
  ensure(state);
  const T = state.today, R = state.rates;
  for (const side of ['income', 'expense']) {
    for (const [k, v] of Object.entries(T[side])) {
      R[side][k] = R[side][k] == null || !state.history.length ? v : R[side][k] * 0.5 + v * 0.5;
    }
  }
  const income = sum(T.income, PAID_AT_ONCE), expense = sum(T.expense);
  state.stats.dailyIncome = income;
  state.stats.dailyExpense = expense;
  state.history.push({
    day: state.time.day - 1,
    money: Math.round(state.money),
    pop: state.citizens.size,
    income: Math.round(income),
    expense: Math.round(expense),
    happiness: Math.round(state.stats.happiness ?? 0),
    jobs: state.stats.jobs || 0,
    unemployment: Math.round((state.stats.unemployment || 0) * 1000) / 10,
    tourists: state.stats.tourists || 0,
    traffic: Math.round((state.stats.trafficFlow ?? 1) * 100),
    power: Math.round((state.stats.utilities?.consumed || 0) * 10) / 10,
    crime: state.stats.crimes || 0,
  });
  if (state.history.length > 400) state.history.shift();
  state.today = newLedger();
}

// When Saturday ends: pay this week's income and costs, start a new week
export function closeWeek(state) {
  ensure(state);
  const L = state.ledger;
  const income = sum(L.income, PAID_AT_ONCE), expense = sum(L.expense);
  const net = income - expense;
  state.money += net;
  state.stats.weeklyIncome = income;
  state.stats.weeklyExpense = expense;
  state.stats.weeklyBalance = net;
  state.lastLedger = L;
  state.ledger = newLedger();
  const ended = state.time.day - 1;
  state.weekly.push({ day: ended, income: Math.round(income), expense: Math.round(expense), net: Math.round(net), money: Math.round(state.money) });
  if (state.weekly.length > 160) state.weekly.shift();
  state.journal.push({ day: ended, kind: 'budget', text: `Week ending ${formatDate(ended)}: ${net >= 0 ? '+' : '−'}₡${Math.abs(Math.round(net)).toLocaleString()}` });
  bus.emit('budget:week', { income, expense, net });
  if (state.options.unlimitedMoney) state.money = Math.max(state.money, 1e12);
}

// What this week will most likely add up to when Saturday ends. Lines paid once a day
// still have the rest of this week's payments to come; the others trickle in, so the rest
// of today is estimated from how fast they're coming in right now.
export function projection(state) {
  ensure(state);
  const L = state.ledger, T = state.today, R = state.rates;
  const f = state.time.minutes / 1440;
  const left = daysLeftInWeek(state);
  const out = { income: {}, expense: {} };
  for (const side of ['income', 'expense']) {
    for (const k of Object.keys(L[side])) {
      if (side === 'income' && PAID_AT_ONCE.has(k)) { out[side][k] = L[side][k] || 0; continue; }
      const rate = R[side][k] || 0;
      const soFar = L[side][k] || 0;
      if (DAILY.has(k)) out[side][k] = soFar + rate * left;
      else {
        const live = f > 0.08 ? (T[side][k] || 0) / f : rate;
        const blended = rate ? rate * (1 - f * 0.6) + live * f * 0.6 : live;
        out[side][k] = soFar + blended * Math.max(0, left - f);
      }
    }
  }
  out.income.total = sum(out.income, PAID_AT_ONCE);
  out.expense.total = sum(out.expense);
  out.net = out.income.total - out.expense.total;
  out.endMoney = state.money + out.net;
  out.daysLeft = left;
  out.weekday = dateOf(state.time.day).weekday;
  return out;
}
