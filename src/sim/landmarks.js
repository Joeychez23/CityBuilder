// Wonders, the capital, big attractions and giant industry (data/wonders.js): what they do
// to the rest of the city. Every hour the working ones are listed in ctx.wonders, which the
// other systems read (disasters, pollution, exports, offices, interest, well-being...);
// once a day the factories make things, the casinos and studio pay up, the capital gets
// its grant, and the cathedral's builders are paid.
import { N, idx, forRadius, inBounds } from '../core/grid.js';
import { isService, center, serviceEfficiency, touchesGroundRoad } from './services.js';
import { createBuilding, footprintBlocker, spend, isOwned } from './build.js';
import { updateCapacity } from './growth.js';
import { startConstruction } from './construction.js';
import { ensureMarket } from './companies.js';
import { accessComp } from './citizens.js';
import { earn, charge } from './economy.js';
import { RESOURCES } from '../data/resources.js';
import { bus } from '../core/events.js';
import { rng } from '../core/rng.js';
import { addDecision, registerDecision } from './decisions.js';
import { closeRoads } from './closures.js';
import { rideBlocker, beachWeather } from './projects.js';

const IMPORT_MARKUP = 1.1;
const CULTURE_CAP = 8;          // well-being from culture, city-wide, at most
const STRIP_REACH = 13;         // casinos this close (cells) form a strip
const working = (b) => isService(b) && (b.efficiency ?? 1) > 0.15;

// Does the particle collider's ring fit under your land?
export function ringCells(cx, cy, r) {
  const out = [];
  for (let k = 0; k < 160; k++) {
    const a = (k / 160) * Math.PI * 2;
    out.push([Math.floor(cx + Math.cos(a) * r), Math.floor(cy + Math.sin(a) * r)]);
  }
  return out;
}
export function ringBlocker(state, def, x0, y0, x1, y1) {
  const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
  for (const [x, y] of ringCells(cx, cy, def.ring)) {
    if (!inBounds(x, y)) return 'The ring would run off the map';
    if (!isOwned(state, x, y)) return `The ring (${def.ring * 2} cells across) must be under your land`;
  }
  return null;
}

// Extra placement rules for the wonders (serviceBlocker calls this)
export function landmarkBlocker(state, def, x0, y0, x1, y1) {
  const has = (f) => [...state.buildings.values()].some((b) => b.def[f] && !b.cons);
  if (def.needsCityHall && !has('cityHall')) return 'Needs a City Hall first';
  if (def.needsParliament && ![...state.buildings.values()].some((b) => b.def.id === 'parliament')) return 'Needs the Parliament first';
  if (def.ring) return ringBlocker(state, def, x0, y0, x1, y1);
  if (def.inPark) return rideBlocker(state, def, x0, y0, x1, y1);
  return null;
}

// Hourly: which wonders are working, and the grids they spread
export function scanLandmarks(state, ctx) {
  ctx.hasUniversity = [...state.buildings.values()].some((b) => b.def.eduLevel === 4 && !b.cons);
  const W = {
    culture: 0, weatherControl: false, exportBoost: 0, officeBoost: 0, officeDemand: 0, interestCut: 0, studyBoost: 0,
    airCleaners: [], casinos: [], parliament: null, studio: null, convention: null, collider: null, research: 0,
  };
  const vice = ctx.vice || (ctx.vice = new Float32Array(N * N));
  vice.fill(0);
  for (const b of state.buildings.values()) {
    const d = b.def;
    if (b.kind !== 'service' || b.cons) continue;
    if (!(d.culture || d.weatherControl || d.exportBoost || d.officeBoost || d.officeDemand || d.grant || d.studyBoost || d.cleansAir || d.scrubs ||
      d.casino || d.studio || d.delegates || d.ring || d.factory)) continue;
    let eff = serviceEfficiency(state, b);
    if (d.needsUniversity && !ctx.hasUniversity) { eff = 0; b.missing = 'a university'; } else b.missing = null;
    b.efficiency = eff;
    if (eff <= 0.15) continue;
    const k = Math.min(1, eff);
    if (d.culture) W.culture += d.culture * k;
    if (d.weatherControl) W.weatherControl = true;
    if (d.exportBoost) W.exportBoost = Math.max(W.exportBoost, d.exportBoost * k);
    if (d.officeBoost) W.officeBoost += d.officeBoost * k;
    if (d.officeDemand) W.officeDemand += d.officeDemand * k;
    if (d.interestCut) W.interestCut = d.interestCut;
    if (d.studyBoost) W.studyBoost = d.studyBoost;
    if (d.cleansAir || d.scrubs) W.airCleaners.push(b);
    if (d.grant) W.parliament = b;
    if (d.studio) W.studio = b;
    if (d.delegates) W.convention = b;
    if (d.ring) { W.collider = b; W.research += d.research || 0; }
    if (d.casino) {
      W.casinos.push(b);
      const [cx, cy] = center(b);
      forRadius(cx + 0.5, cy + 0.5, 14, (x, y, dist) => { const i = idx(x, y); vice[i] = Math.max(vice[i], k * (1 - dist / 14)); });
    }
  }
  W.culture = Math.min(CULTURE_CAP, W.culture);
  // casinos near one another form a strip
  for (const c of W.casinos) {
    const [x, y] = center(c);
    c.stripMates = W.casinos.filter((o) => o !== c && Math.hypot(center(o)[0] - x, center(o)[1] - y) <= STRIP_REACH).length;
  }
  ctx.wonders = W;
}

// Hourly, after the pollution has spread: the Eco Dome clears air everywhere (and a lot
// nearby), carbon capture plants pull the smog out around them and clean the ground slowly
export function cleanAir(state, ctx) {
  const list = ctx.wonders?.airCleaners;
  if (!list?.length) return;
  const air = state.air, ground = state.ground;
  for (const b of list) {
    const d = b.def, k = Math.min(1, b.efficiency ?? 1);
    const [cx, cy] = center(b);
    if (d.cleansAir) {
      const keep = 1 - d.cleansAir * k;
      for (let i = 0; i < air.length; i++) if (air[i] > 0) air[i] *= keep;
    }
    const r = d.radius;
    const strength = (d.scrubs || 0.1) * k;
    forRadius(cx + 0.5, cy + 0.5, r, (x, y, dist) => {
      const i = idx(x, y);
      air[i] *= 1 - strength * (1 - (dist / r) * 0.5);
      if (d.scrubs && dist < r * 0.5) ground[i] *= 1 - 0.004 * k;
    });
  }
}

// ----------------------------------------------------------------- daily
// Buy what a factory needs: from the city's own stockpiles first, then imported (if the
// highway reaches it). Returns the share of the order it got (0..1) and books the cost.
function buyInputs(state, ctx, b, inputs, units) {
  const m = ensureMarket(state);
  const c = accessComp(state, ctx, b);
  const outside = c >= 0 && ctx.net.roadOutside[c];
  let got = 1, cost = 0;
  for (const [r, per] of Object.entries(inputs)) {
    const need = per * units;
    const local = Math.min(m[r].stock, need);
    const imp = outside ? need - local : 0;
    if (need > 0) got = Math.min(got, (local + imp) / need);
  }
  for (const [r, per] of Object.entries(inputs)) {
    const need = per * units * got;
    const local = Math.min(m[r].stock, need);
    m[r].stock -= local; m[r].consumed += local;
    const imp = need - local;
    m[r].imported += imp;
    cost += local * RESOURCES[r].price + imp * RESOURCES[r].price * IMPORT_MARKUP;
  }
  charge(state, 'supplies', cost);
  return { got, cost, outside };
}

export function factoriesDaily(state, ctx) {
  for (const b of state.buildings.values()) {
    const f = b.def.factory;
    if (!f || !isService(b)) continue;
    const eff = Math.min(1.2, serviceEfficiency(state, b));
    b.efficiency = eff;
    if (f.makes === 'cars') {
      const want = b.def.workers * f.perWorker * eff;
      const { got, cost } = buyInputs(state, ctx, b, f.inputs, want);
      const cars = want * got;
      const income = cars * f.price;
      earn(state, 'factories', income);
      b.made = cars; b.factoryIncome = income; b.inputCost = cost; b.shortInputs = got < 0.98;
      const shown = Math.round(cars * 0.5);
      if (Math.round(b.carsWaiting || 0) !== shown) { b.carsWaiting = shown; bus.emit('building:changed', b); }
    } else if (f.makes === 'ship') {
      const step = eff / f.days;
      const { got, cost } = buyInputs(state, ctx, b, f.inputs, step);
      b.shortInputs = got < 0.98;
      b.inputCost = cost;
      const before = Math.floor((b.shipProgress || 0) * 10);
      b.shipProgress = (b.shipProgress || 0) + step * got;
      if (b.shipProgress >= 1) {
        b.shipProgress = 0;
        b.shipsLaunched = (b.shipsLaunched || 0) + 1;
        earn(state, 'factories', f.price);
        state.journal.push({ day: state.time.day, kind: 'info', text: `${b.name || b.def.name} launched ship no. ${b.shipsLaunched}` });
        bus.emit('notify', { kind: 'good', icon: '🚢', title: 'Ship launched', target: b.id, msg: `Ship no. ${b.shipsLaunched} slid down the slipway and was sold for ₡${f.price.toLocaleString()}.` });
        bus.emit('building:changed', b);
      } else if (Math.floor(b.shipProgress * 10) !== before) bus.emit('building:changed', b);
    }
  }
}

// Gamblers: some tourists and a few residents. The city takes a quarter of the takings.
const TAKINGS = 60, LICENCE = 0.25;
function casinosDaily(state, ctx) {
  const list = ctx.wonders?.casinos || [];
  if (!list.length) return;
  const players = (state.stats.tourists || 0) * 0.25 + state.citizens.size * 0.012;
  const weights = list.map((c) => Math.min(1, c.efficiency ?? 1) * (1 + 0.33 * Math.min(2, c.stripMates || 0)));
  const total = weights.reduce((a, v) => a + v, 0) || 1;
  let licence = 0;
  list.forEach((c, k) => {
    const n = Math.min(900 * weights[k], players * (weights[k] / total) * (1 + 0.33 * Math.min(2, c.stripMates || 0)));
    c.gamblers = Math.round(n);
    c.licence = n * TAKINGS * LICENCE;
    licence += c.licence;
  });
  earn(state, 'casino', licence);
}

// The film studio: a fee for every production, and now and then a shoot on your streets
function studioDaily(state, ctx) {
  const b = ctx.wonders?.studio;
  if (!b) return;
  const k = Math.min(1, b.efficiency ?? 1);
  earn(state, 'film', 2500 * k);
  b.filmIncome = 2500 * k;
  const pending = (state.decisions || []).some((d) => d.kind === 'filmShoot');
  if (pending || state.time.day < (b.nextShoot ?? state.time.day + 3)) { b.nextShoot = b.nextShoot ?? state.time.day + 3; return; }
  b.nextShoot = state.time.day + 8 + rng.int(0, 6);
  const cells = shootStreet(state, b);
  if (!cells) return;
  const titles = ['Gridlock', 'The Last Commute', 'Rush Hour Romance', 'Neon Avenue', 'Concrete Hearts', 'The Getaway', 'Midnight at the Junction', 'Detour'];
  const film = titles[rng.int(0, titles.length - 1)];
  addDecision(state, {
    kind: 'filmShoot', icon: '🎬', title: `Film shoot: "${film}"`,
    text: `The director of "${film}" wants to close ${cells.length} cells of road near ${b.name || b.def.name} for a day of filming. The studio pays a location fee, and the film brings tourists when it comes out.`,
    cell: cells[0], data: { cells, film, fee: 30000 }, expires: state.time.day + 2,
    options: [{ label: 'Close the streets (+₡30,000)', detail: 'Roads closed for 24 hours · +12 attractiveness for a week' }, { label: 'Not this time', detail: 'Traffic keeps moving' }],
  });
}

// A short stretch of street (no highways or avenues) not far from the studio, for a shoot
const shootable = (state, i) => { const t = state.road[i]; return t && t <= 4 && !state.bridgeH[i] && !state.closed[i]; };
function shootStreet(state, b) {
  const [cx, cy] = center(b);
  const cand = [];
  forRadius(cx + 0.5, cy + 0.5, 24, (x, y, d) => { const i = idx(x, y); if (d > 4 && isOwned(state, x, y) && shootable(state, i)) cand.push(i); });
  if (!cand.length) return null;
  let best = null;
  for (let tries = 0; tries < 12; tries++) {
    const cells = [cand[rng.int(0, cand.length - 1)]];
    // follow the street (straight on where it can) for up to 6 cells
    let dir = null;
    for (let k = 0; k < 5; k++) {
      const cur = cells[cells.length - 1], x = cur % N, y = (cur / N) | 0;
      const ways = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => { const j = idx(x + dx, y + dy); return inBounds(x + dx, y + dy) && shootable(state, j) && !cells.includes(j); });
      if (!ways.length) break;
      const w = ways.find(([dx, dy]) => dir && dx === dir[0] && dy === dir[1]) || ways[0];
      dir = w;
      cells.push(idx(x + w[0], y + w[1]));
    }
    if (!best || cells.length > best.length) best = cells;
    if (best.length >= 6) break;
  }
  return best.length >= 3 ? best : null;
}

registerDecision('filmShoot', {
  apply(state, ctx, d, choice) {
    if (choice !== 0) return { msg: 'The director found another town for the shoot.', kind: 'info' };
    closeRoads(state, d.data.cells, 24 * 60, 'film');
    earn(state, 'film', d.data.fee);
    state.filmBuzz = { until: state.time.day + 8, film: d.data.film };
    state.journal.push({ day: state.time.day, kind: 'info', text: `Streets closed for the shoot of "${d.data.film}"` });
    return { msg: `Cameras are rolling: the street is closed for a day. "${d.data.film}" comes out next week.`, kind: 'good' };
  },
});

function capitalDaily(state, ctx) {
  const p = ctx.wonders?.parliament;
  if (!p) return;
  const grant = p.def.grant * Math.min(1, p.efficiency ?? 1);
  earn(state, 'grants', grant);
  p.grantToday = grant;
}

// The cathedral is paid for as it rises (unless the work is paused)
function longBuildsDaily(state) {
  for (const b of state.buildings.values()) {
    const lb = b.def.longBuild;
    if (!lb || !b.cons || b.cons.paused) continue;
    charge(state, 'projects', lb.perDay);
  }
}

// (the factories run with the companies, before the city's surplus goods are exported)
export function landmarksDaily(state, ctx) {
  casinosDaily(state, ctx);
  studioDaily(state, ctx);
  capitalDaily(state, ctx);
  longBuildsDaily(state, ctx);
}

// How much a landmark draws tourists today (wonders under construction for a long time,
// like the cathedral, draw some while they rise)
export function landmarkAttract(state, ctx, b) {
  const d = b.def;
  if (b.cons) return d.longBuild && d.attract && !b.cons.paused ? d.attract * (0.15 + 0.6 * b.cons.progress) : 0;
  if (d.themeGate) return b.parkAttract || 0;
  // (areas you drew draw as many as their size allows: b.attract; beaches mostly in summer)
  let a = (b.attract ?? d.attract) * (b.efficiency ?? 1);
  if (d.seasonal) a *= beachWeather(state);
  if (d.casino) a *= 1 + 0.33 * Math.min(2, b.stripMates || 0);
  if (d.id === 'embassies' && ctx.transitAccess?.air) a *= 1.5;
  return a;
}

// ------------------------------------------------------------- bought landmarks
// The mega-mall and the skybridge towers: bought, then they run like grown buildings
export function boughtBlocker(state, ctx, def, x0, y0, x1, y1) {
  if ([...state.buildings.values()].some((b) => b.def === def)) return 'Only one per city';
  const blocked = footprintBlocker(state, x0, y0, x1, y1);
  if (blocked) return blocked;
  if (!touchesGroundRoad(state, x0, y0, x1, y1)) return 'Needs a road next to it';
  return null;
}

export function placeBought(state, ctx, def, x0, y0, x1, y1, rot) {
  const reason = boughtBlocker(state, ctx, def, x0, y0, x1, y1);
  if (reason) return { error: reason };
  if (!spend(state, def.cost, 'landmarks')) return { error: 'Not enough money' };
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) state.zone[idx(x, y)] = 0;
  const b = createBuilding(state, 'zone', def, x0, y0, x1, y1, rot, { level: 5 });
  b.level = 5;
  b.name = def.name;
  updateCapacity(b);
  startConstruction(state, b);
  state.journal.push({ day: state.time.day, kind: 'milestone', text: `Built ${def.name}` });
  bus.emit('xp', { amount: Math.round(def.cost / 4000), reason: 'landmark' });
  bus.emit('signatures:changed');
  return { building: b };
}

// Retail near the mega-mall: how much of a shop's trade the mall takes (0..0.55)
export function mallPull(malls, b) {
  let pull = 0;
  const [x, y] = center(b);
  for (const m of malls) {
    if (m === b) continue;
    const [mx, my] = center(m);
    const d = Math.hypot(x - mx, y - my), R = m.def.mallPull;
    if (d < R) pull = Math.max(pull, 0.55 * (1 - (d / R) ** 2 * 0.6));
  }
  return pull;
}
