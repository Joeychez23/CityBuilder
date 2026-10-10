// Companies in commercial, industrial, office and specialized-industry buildings.
// Each day they produce or sell, buy inputs locally or import them, export surplus,
// pay wages and rent, and the city taxes their profit.
import { RESOURCES, RAW, GOODS, IMMATERIAL, RETAIL_MIX } from '../data/resources.js';
import { WAGES } from '../data/zones.js';
import { N, clamp, idx } from '../core/grid.js';
import { rng } from '../core/rng.js';
import { centerIdx, covAt, isService } from './services.js';
import { accessComp } from './citizens.js';
import { earn, charge } from './economy.js';

const WAGE_SCALE = 0.25;
// What one worker turns out in a day at full efficiency (units of the company's product), and
// what a shop worker can sell. Set so that a company with its jobs filled, power, water, and
// customers or inputs makes a modest profit: short of workers, customers or power it loses
// money. (Wages are WAGES × WAGE_SCALE, about ₡375–675 a day.)
const PER_WORKER = { spec: 26, ind: 22, off: 10, retail: 1400 };
const IMPORT_MARKUP = 1.1;   // raw materials and goods bought from outside cost a bit more
const SHOP_BUY = 0.55;       // shops buy their stock at this share of the price (imports: SHOP_IMPORT)
const SHOP_IMPORT = 0.65;

export function ensureMarket(state) {
  const m = state.market;
  for (const k of Object.keys(RESOURCES)) {
    if (!m[k]) m[k] = { stock: 0, produced: 0, consumed: 0, imported: 0, exported: 0 };
  }
  return m;
}

// Pick what a newly grown company makes
export function assignProduct(state, b) {
  const cat = b.def.cat;
  if (b.def.signature && b.def.product) b.product = b.def.product;
  else if (cat === 'spec') b.product = b.def.product;
  else if (cat === 'off') b.product = IMMATERIAL[Math.floor(rng.next() * IMMATERIAL.length)];
  else if (cat === 'com' || b.def.mixed) b.product = 'retail';
  else if (cat === 'ind') {
    // Favour goods whose raw materials the city already produces
    const m = ensureMarket(state);
    const weights = GOODS.map((g) => {
      const inputs = Object.keys(RESOURCES[g].inputs);
      return 1 + inputs.reduce((a, r) => a + Math.min(3, (m[r].produced || 0) / 20), 0);
    });
    let r = rng.next() * weights.reduce((a, c) => a + c, 0);
    b.product = GOODS[weights.findIndex((w) => (r -= w) <= 0)] || 'food';
  }
  b.companyWealth = 2000;
}

function resourceUnder(state, b) {
  const layer = b.def.resource === 'forest' ? state.forestMax : state[b.def.resource];
  let s = 0, n = 0;
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) { s += layer[idx(x, y)]; n++; }
  return s / n;
}
function depleteUnder(state, b, amount) {
  const layer = state[b.def.resource];
  if (!layer || b.def.resource === 'fertile') return; // fertile land is renewable
  const cells = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) {
    const i = idx(x, y);
    layer[i] = Math.max(0, layer[i] - amount / cells);
  }
}

export function companiesDaily(state, ctx) {
  const m = ensureMarket(state);
  for (const k of Object.keys(m)) { if (m[k] && typeof m[k] === 'object') { m[k].produced = 0; m[k].consumed = 0; m[k].imported = 0; m[k].exported = 0; } }
  const T = state.taxes;
  const outsideOK = (b) => { const c = accessComp(state, ctx, b); return c >= 0 && ctx.net.roadOutside[c]; };
  const cargoBoost = 1 + Math.min(0.25, (ctx.cargoCapacity || 0) / 4000); // cargo terminals make trade cheaper
  let comTax = 0, indTax = 0, offTax = 0;
  const companies = [];
  let retailCapacity = 0;
  const pollutionFilters = state.policies.pollutionManagement;

  for (const b of state.buildings.values()) {
    if (b.kind !== 'zone' || b.abandoned) continue;
    if (!b.product) assignProduct(state, b);
    if (!b.product) continue;
    // Outside commuters fill some of the open jobs
    const open = Math.max(0, b.jobs - b.workers.length);
    b.commuters = outsideOK(b) ? Math.floor(open * 0.35) : 0;
    b.workerCount = b.workers.length + b.commuters;
    const staffing = b.jobs ? b.workerCount / b.jobs : 0;
    // Education match: workers at their job level count fully
    const edu = b.workers.length ? b.workers.reduce((a, id) => a + ((state.citizens.get(id)?.edu ?? 0) >= (state.citizens.get(id)?.jobLevel ?? 0) ? 1 : 0.7), 0) / b.workers.length : 0.8;
    let eff = clamp(staffing, 0, 1) * edu * (0.3 + 0.7 * b.power) * (0.4 + 0.6 * b.water) * (1 + (b.level - 1) * 0.12);
    if (b.def.cat === 'off') eff *= 0.85 + Math.min(1, covAt(ctx, 'telecom', b)) * 0.25 + (ctx.centralBank ? 0.08 : 0);
    if (b.def.cat === 'com') eff *= 0.9 + Math.min(1, covAt(ctx, 'telecom', b)) * 0.15;
    // workers who found the lots full walk in late; commuters from other cities don't come
    eff *= 1 - 0.12 * (b.parkWalk || 0) - 0.4 * (b.parkLost || 0);
    b.efficiency = eff;
    companies.push(b);
    if (b.product === 'retail') retailCapacity += b.workerCount * PER_WORKER.retail * eff;
  }

  // --- production
  for (const b of companies) {
    b.revenue = 0; b.costs = 0;
    const p = b.product;
    if (b.def.cat === 'spec') {
      const res = resourceUnder(state, b);
      const out = b.workerCount * PER_WORKER.spec * b.efficiency * clamp(res * 1.3, 0.15, 1.2);
      m[p].stock += out; m[p].produced += out;
      depleteUnder(state, b, out * 0.00008);
      b.output = out;
    } else if (b.def.cat === 'ind') {
      const want = b.workerCount * PER_WORKER.ind * b.efficiency * (b.def.output || 1);
      let made = want;
      for (const [r, k] of Object.entries(RESOURCES[p].inputs)) {
        const need = want * k;
        const local = Math.min(m[r].stock, need);
        m[r].stock -= local; m[r].consumed += local;
        const imp = need - local;
        if (imp > 0) {
          if (outsideOK(b)) { m[r].imported += imp; b.costs += imp * RESOURCES[r].price * IMPORT_MARKUP / cargoBoost; }
          else made = Math.min(made, local / k);
        }
        b.costs += local * RESOURCES[r].price;
      }
      m[p].stock += made; m[p].produced += made;
      b.output = made;
      if (pollutionFilters) b.costs += made * 1.5;
    } else if (b.def.cat === 'off') {
      const out = b.workerCount * PER_WORKER.off * b.efficiency;
      m[p].stock += out; m[p].produced += out;
      b.output = out;
    }
  }

  // --- retail: citizens' and tourists' spending is shared by shops by capacity
  const spending = (state.stats.consumerSpending || 0) + (state.stats.touristSpending || 0);
  const salesTotal = Math.min(spending, retailCapacity);
  for (const b of companies) {
    if (b.product !== 'retail') continue;
    const cap = b.workerCount * PER_WORKER.retail * b.efficiency;
    const sales = retailCapacity > 0 ? (cap / retailCapacity) * salesTotal : 0;
    b.revenue += sales;
    b.salesRatio = cap > 0 ? sales / cap : 0; // how busy the shop is (customers vs what it could sell)
    // stock the shelves: goods mix, local first, else imported
    for (const [g, share] of Object.entries(RETAIL_MIX)) {
      const units = (sales * share) / RESOURCES[g].price;
      const local = Math.min(m[g].stock, units);
      m[g].stock -= local; m[g].consumed += local;
      b.costs += local * RESOURCES[g].price * SHOP_BUY;
      const imp = units - local;
      if (imp > 0) { m[g].imported += imp; b.costs += imp * RESOURCES[g].price * SHOP_IMPORT / cargoBoost; }
    }
    b.output = sales;
  }
  state.stats.retailCapacity = retailCapacity;
  state.stats.retailDemand = spending;

  // --- offices sell to local companies first, the rest is exported
  const b2b = companies.length * 30;
  for (const g of IMMATERIAL) {
    const local = Math.min(m[g].stock, b2b / IMMATERIAL.length);
    m[g].consumed += local; m[g].stock -= local;
  }

  // --- exports: keep a small buffer of each resource, sell the rest outside
  let exportIncome = 0;
  const connected = state.connections.some((c) => c.type === 'road');
  for (const k of Object.keys(RESOURCES)) {
    const buffer = RAW.includes(k) ? 40 : 25;
    if (m[k].stock > buffer && connected) {
      const ex = m[k].stock - buffer;
      m[k].stock = buffer;
      m[k].exported += ex;
      exportIncome += ex * RESOURCES[k].price * 0.85 * cargoBoost;
    }
  }
  // Producers sell everything they make (to local companies, or for export) at the going
  // price; a cargo terminal gets exports out cheaper
  for (const b of companies) {
    if (b.product === 'retail') continue;
    b.revenue += (b.output || 0) * RESOURCES[b.product].price * (b.def.cat === 'off' ? 1 : 0.97 + (cargoBoost - 1) * 0.2);
  }

  // --- wages, rent, profit, tax
  for (const b of companies) {
    let wages = 0;
    for (const id of b.workers) { const c = state.citizens.get(id); if (c) wages += WAGES[c.jobLevel] * WAGE_SCALE; }
    wages += b.commuters * WAGES[1] * WAGE_SCALE;
    const lv = state.landValue[centerIdx(b)] || 0;
    const rent = (30 + lv * 120) * (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * 0.25 * (1 + (b.level - 1) * 0.2);
    b.costs += wages + rent + (b.stolen || 0);
    b.stolen = 0;
    b.profit = b.revenue - b.costs;
    const cat = b.def.cat === 'spec' ? 'ind' : b.def.mixed ? 'com' : b.def.cat;
    const rate = clamp(T[cat] ?? 10, -10, 30) / 100;
    const tax = b.profit > 0 ? b.profit * rate : b.profit < 0 && rate < 0 ? 0 : 0;
    b.profit -= tax;
    b.companyWealth = (b.companyWealth || 0) + b.profit * 0.2;
    if (cat === 'com') comTax += tax; else if (cat === 'ind') indTax += tax; else offTax += tax;
    // Negative tax rates are subsidies paid by the city
    if (rate < 0) {
      const sub = Math.abs(rate) * Math.max(0, b.revenue) * 0.3;
      b.profit += sub;
      if (cat === 'com') comTax -= sub; else if (cat === 'ind') indTax -= sub; else offTax -= sub;
    }
  }
  earn(state, 'comTax', comTax);
  earn(state, 'indTax', indTax);
  earn(state, 'offTax', offTax);
  state.stats.exportIncome = exportIncome;
  state.stats.companies = companies.length;
  state.stats.profitable = companies.filter((b) => b.profit > 0).length;
}

// How much guests like staying at this hotel (about 0.4..1.6): parks and leisure around it,
// landmarks within a short trip, a good neighbourhood, and for a resort the water.
export function hotelAppeal(state, ctx, h, sights) {
  const i = centerIdx(h);
  const [hx, hy] = [(h.x0 + h.x1) / 2, (h.y0 + h.y1) / 2];
  let near = 0;
  for (const [x, y, a] of sights) {
    const d = Math.hypot(x - hx, y - hy);
    if (d < 45) near += a * (1 - d / 45);
  }
  let water = 0;
  if (h.def.resort) {
    for (let y = h.y0 - 4; y <= h.y1 + 4 && !water; y++) for (let x = h.x0 - 4; x <= h.x1 + 4; x++) {
      if (x >= 0 && y >= 0 && x < N && y < N && state.water[y * N + x]) { water = 1; break; }
    }
  }
  return 0.4 + 0.35 * Math.min(1, ctx.coverage.leisure?.[i] || 0) + 0.45 * Math.min(1, near / 20) + 0.2 * (state.landValue[i] || 0) + 0.25 * water;
}

const STAY = 1.2;      // visitors who'd stay the night for every day visitor, when there are rooms
const GUEST_SHOPS = 30; // what a hotel guest spends in the shops a day (a day visitor: 22)

// Tourism: attractiveness from parks, landmarks and signature buildings, multiplied by how
// easy the city is to reach (highway, train, ship, plane). Tourists spend at shops.
// Hotels add guests who stay the night on top of the day visitors: they pay for the room
// (the city runs the hotels) and spend more in the shops.
export function tourismDaily(state, ctx) {
  let attract = 0;
  const sights = [];
  const hotels = [];
  for (const b of state.buildings.values()) {
    const a = isService(b) && b.def.attract ? b.def.attract * (b.efficiency ?? 1) : b.def.signature && !b.cons ? b.def.attract || 5 : 0;
    if (a) { attract += a; sights.push([(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, a]); }
    if (isService(b) && b.def.rooms) hotels.push(b);
  }
  const leisureAvg = (() => {
    const g = ctx.coverage.leisure; if (!g) return 0;
    let s = 0; for (let i = 0; i < g.length; i += 7) s += Math.min(1, g[i]); return s / (g.length / 7);
  })();
  attract = attract * (state.policies.cityPromotion ? 1.25 : 1) + leisureAvg * 20;
  const access = 0.5 + (ctx.transitAccess?.rail ? 0.3 : 0) + (ctx.transitAccess?.ship ? 0.2 : 0) + (ctx.transitAccess?.air ? 0.5 : 0);
  const pop = state.citizens.size;
  const tourists = Math.round(Math.min(pop * 0.4 + 30, attract * 6) * access * (state.weather.rain > 0.5 ? 0.7 : 1));
  const visitors = pop > 50 ? tourists : 0;

  // Hotel guests go to the hotels they like best first, as many as each has rooms open
  let rooms = 0;
  for (const h of hotels) {
    h.appeal = hotelAppeal(state, ctx, h, sights);
    h.roomsOpen = Math.round(h.def.rooms * clamp(h.efficiency ?? 1, 0, 1));
    h.guests = 0;
    rooms += h.roomsOpen;
  }
  let left = Math.round(visitors * STAY);
  const wanted = left;
  for (let pass = 0; pass < 4 && left > 0; pass++) {
    const open = hotels.filter((h) => h.guests < h.roomsOpen);
    const weight = open.reduce((a, h) => a + h.roomsOpen * h.appeal, 0);
    if (!weight) break;
    let placed = 0;
    for (const h of open) {
      const n = Math.min(h.roomsOpen - h.guests, Math.round((left * h.roomsOpen * h.appeal) / weight), left - placed);
      h.guests += n;
      placed += n;
    }
    if (!placed) {
      // too few left to share out: the best-liked hotel with room takes them
      const best = open.reduce((a, h) => (h.appeal > a.appeal ? h : a));
      placed = Math.min(left, best.roomsOpen - best.guests);
      best.guests += placed;
    }
    left -= placed;
  }
  let guests = 0, roomIncome = 0;
  for (const h of hotels) {
    h.occupancy = h.def.rooms ? h.guests / h.def.rooms : 0;
    h.roomIncome = h.guests * h.def.roomRate;
    guests += h.guests;
    roomIncome += h.roomIncome;
  }
  earn(state, 'hotels', roomIncome);

  state.stats.attractiveness = Math.round(Math.min(100, attract));
  state.stats.dayVisitors = visitors;
  state.stats.hotelGuests = guests;
  state.stats.hotelRooms = rooms;
  state.stats.hotelWanted = wanted; // guests who'd have stayed, rooms or not
  state.stats.tourists = visitors + guests;
  state.stats.touristSpending = visitors * 22 + guests * GUEST_SHOPS;
  state.counters.tourists += state.stats.tourists;
  if (state.policies.cityPromotion) charge(state, 'policies', 3000);
}
