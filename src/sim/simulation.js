// The simulation clock. Real time is turned into game minutes; every STEP minutes the
// systems run. Systems declare how often they run (every step / hour / day).
import { bus } from '../core/events.js';
import { computeRoadNetwork } from './networks.js';
import { computeZonable } from './build.js';

export const STEP_MINUTES = 10;
// Game minutes per real second at each speed (0 = paused). One day = 12 min at 1×.
// The fastest (3) is only for skipping the night: in the morning it drops back to normal.
export const SPEEDS = [0, 2, 40, 96];
export const FASTEST = 3;

// ------------------------------------------------------------------ calendar
// time.day counts days since Thursday 1 January 2026. Budgets settle weekly, when
// Saturday ends; the date shown at the top is the real day of the month.
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const START_DAY = 90; // new cities are founded on Wednesday 1 April 2026
const EPOCH_YEAR = 2026;
const EPOCH_WEEKDAY = 4; // 1 Jan 2026 is a Thursday
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const monthDays = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m];

export function dateOf(day) {
  let d = Math.max(0, Math.floor(day));
  let year = EPOCH_YEAR;
  while (d >= (isLeap(year) ? 366 : 365)) { d -= isLeap(year) ? 366 : 365; year++; }
  const doy = d;
  let month = 0;
  while (d >= monthDays(year, month)) { d -= monthDays(year, month); month++; }
  return { year, month, dom: d + 1, weekday: (EPOCH_WEEKDAY + Math.floor(day)) % 7, doy, daysInMonth: monthDays(year, month) };
}
export const formatDate = (day, withWeekday = false) => {
  const d = dateOf(day);
  return `${withWeekday ? `${WEEKDAYS[d.weekday]} ` : ''}${d.dom} ${MONTHS[d.month]} ${d.year}`;
};
export const monthOf = (state) => dateOf(state.time.day).month;
export const yearOf = (state) => dateOf(state.time.day).year;
// Month as a fraction (0..12), for smooth seasonal curves
export function monthFloat(state) {
  const d = dateOf(state.time.day);
  return d.month + (d.dom - 1 + state.time.minutes / 1440) / d.daysInMonth;
}
// Days left in this budget week, counting today (Saturday = 1)
export const daysLeftInWeek = (state) => 7 - dateOf(state.time.day).weekday;
export const hourOf = (state) => state.time.minutes / 60;
// Night: 20:00 to 06:00
export const NIGHT_FROM = 20, NIGHT_TO = 6;
export const isNight = (state) => { const h = hourOf(state); return h >= NIGHT_FROM || h < NIGHT_TO; };
export function seasonOf(state) {
  const m = monthOf(state);
  return m < 2 || m === 11 ? 'winter' : m < 5 ? 'spring' : m < 8 ? 'summer' : 'autumn';
}

export function createContext() {
  return {
    net: { roadComp: new Int32Array(0), roadOutside: new Uint8Array(0) },
    zonable: null,
    fronts: null,
    frontsDirty: true,
    netDirty: true,
    stepCount: 0,
    coverage: {},
    views: null,
  };
}

// Systems are registered by the modules that implement them (see main.js). every: 'step',
// 'hour', 'day', 'dayEnd' (after all day systems) or 'week' (when Saturday ends).
const systems = [];
export function registerSystem(sys) {
  systems.push({ every: 'step', ...sys });
}

export function createSimulation(state, ctx) {
  let acc = 0;

  bus.on('network:changed', () => { ctx.netDirty = true; ctx.frontsDirty = true; });
  bus.on('zones:changed', () => { ctx.frontsDirty = true; });

  function refreshNetworks() {
    if (!ctx.netDirty) return;
    computeRoadNetwork(state, ctx);
    ctx.netStamp = (ctx.netStamp || 0) + 1; // invalidates cached building road access
    ctx.zonable = computeZonable(state);
    ctx.netDirty = false;
    bus.emit('network:recomputed');
  }

  function step() {
    refreshNetworks();
    const t = state.time;
    const prevHour = Math.floor(t.minutes / 60);
    t.minutes += STEP_MINUTES;
    let newDay = false;
    if (t.minutes >= 1440) {
      t.minutes -= 1440;
      t.day++;
      newDay = true;
    }
    const newHour = Math.floor(t.minutes / 60) !== prevHour;
    // The week closes when Saturday ends (the new day is a Sunday)
    const newWeek = newDay && dateOf(t.day).weekday === 0;
    ctx.stepCount++;
    // set ctx.profile = {} (e.g. from the console) to see how long each system takes, in ms
    const run = ctx.profile ? (s) => { const a = performance.now(); s.run(state, ctx); ctx.profile[s.name] = (ctx.profile[s.name] || 0) + performance.now() - a; } : (s) => s.run(state, ctx);
    for (const s of systems) {
      if (s.every === 'step' || (s.every === 'hour' && newHour) || (s.every === 'day' && newDay)) run(s);
    }
    // Book-keeping that must see everything the day's systems did
    if (newDay) for (const s of systems) if (s.every === 'dayEnd') run(s);
    if (newWeek) for (const s of systems) if (s.every === 'week') run(s);
    if (newDay) bus.emit('day', t.day);
    if (newWeek) bus.emit('week', t.day);
    bus.emit('step');
  }

  return {
    step,
    refreshNetworks,
    update(dtReal) {
      refreshNetworks();
      const t = state.time;
      if (t.paused || !t.speed) return;
      // (the fastest speed only skips the night: come the morning it's back to normal)
      const morning = () => { t.speed = 1; acc = 0; bus.emit('speed:morning'); };
      if (t.speed === FASTEST && !isNight(state)) morning();
      acc += Math.min(dtReal, 0.25) * SPEEDS[t.speed];
      let guard = 0;
      while (acc >= STEP_MINUTES && guard++ < 12) {
        acc -= STEP_MINUTES;
        step();
        if (t.speed === FASTEST && !isNight(state)) { morning(); break; }
      }
    },
  };
}
