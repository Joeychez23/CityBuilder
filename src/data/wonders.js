// Late-game buildings: wonders and capital-city projects, big attractions, giant factories,
// and a few new utilities. Most are city services (see data/services.js for the fields);
// their effects on the rest of the city are worked out in sim/landmarks.js. The mega-mall
// and the skybridge towers are bought landmarks that work like grown buildings (homes,
// jobs, a business that pays tax), so they're zone buildings, like the signature buildings.
//
// Extra fields:
//   culture: city-wide well-being for everyone (opera, library...), capped in total
//   wellbeing + boostRadius: well-being near it (like a signature building)
//   attract: tourist draw ; leisure + radius: park coverage
//   longBuild: { days, perDay } built over many days, paid as it goes (the cathedral)
//   factory: { inputs, makes, price, perWorker } turns goods from the market into products
//   ring: radius of the particle collider's underground ring (cells)
import { registerDefs } from './registry.js';

// --- shape helpers (x along the road, z toward the road; sizes in cells) ---
const box = (x, z, w, d, h, color, y = 0, pool = 'body') => ({ pool, x, z, w, d, h, y, color });
const plain = (x, z, w, d, h, color, y = 0) => box(x, z, w, d, h, color, y, 'plain');
const cyl = (x, z, r, h, color, y = 0) => ({ pool: 'cyl', x, z, w: r * 2, d: r * 2, h, y, color });
const dome = (x, z, r, color, y = 0) => ({ pool: 'dome', x, z, w: r * 2, d: r * 2, h: r, y, color });
const shell = (x, z, w, d, h, color, y = 0) => ({ pool: 'dome', x, z, w, d, h, y, color });
const roof = (x, z, w, d, h, color, y, turn = false) => ({ pool: 'roof', x, z, w, d, h, y, color, turn });
const hip = (x, z, w, d, h, color, y) => ({ pool: 'hip', x, z, w, d, h, y, color });
const lawn = (w, d, color = '#7fb35a') => plain(0, 0, w, d, 0.06, color);
const trees = (pts, size = 0.5) => pts.flatMap(([x, z]) => [cyl(x, z, 0.04, 0.3, '#6b4f36'), dome(x, z, size / 2, '#4e8a35', 0.25)]);
const flag = (x, z, color, h = 1.2) => [cyl(x, z, 0.025, h, '#d8d8d8'), plain(x + 0.13, z, 0.24, 0.02, 0.15, color, h - 0.18)];
const CAR_COLORS = ['#c8352b', '#2f5fa8', '#e8e6e0', '#2b2d31', '#8a8f96', '#d9b23a', '#3d7a4a'];

// ------------------------------------------------------------------ city services
const W = [
  // ---- wonders: one of each, late in the game
  { id: 'opera', cat: 'landmarks', group: 'Wonders', name: 'Opera House', cost: 2200000, upkeep: 11000, w: 5, d: 4, unique: true, workers: 80, milestone: 13,
    culture: 4, wellbeing: 6, boostRadius: 30, attract: 16,
    desc: 'A night at the opera: +4 well-being for every citizen, +6 more nearby, and tourists come to see the shells on the skyline.',
    shape: [plain(0, 0, 4.9, 3.9, 0.35, '#cdb89a'), plain(0, 1.7, 3, 0.5, 0.2, '#d8c7ab'), box(-0.3, -0.25, 3.4, 1.7, 0.55, '#9cb6c8', 0.35),
      shell(-1.55, -0.25, 1.1, 1.7, 1.5, '#f6f4ee', 0.35), shell(-0.6, -0.25, 1.25, 1.95, 2.2, '#f2f0e8', 0.35), shell(0.35, -0.25, 1.05, 1.6, 1.6, '#f6f4ee', 0.35),
      shell(1.35, 0.55, 0.85, 1.2, 1.25, '#f2f0e8', 0.35), shell(1.95, 0.55, 0.7, 1, 0.9, '#f6f4ee', 0.35)] },
  { id: 'museum', cat: 'landmarks', group: 'Wonders', name: 'National Museum', cost: 1800000, upkeep: 9000, w: 4, d: 4, unique: true, workers: 60, milestone: 14,
    culture: 2, attract: 32, wellbeing: 3, boostRadius: 20,
    desc: 'The country\'s treasures under one dome: one of the biggest tourist draws there is (+32 attractiveness), and +2 well-being city-wide.',
    shape: [lawn(3.95, 3.95, '#7fae55'), plain(0, -0.15, 3.4, 2.7, 0.25, '#d8d2c2'), box(0, -0.35, 3.2, 1.9, 1.2, '#e8e2d2', 0.25),
      ...[-1.3, -0.87, -0.43, 0, 0.43, 0.87, 1.3].map((x) => cyl(x, 0.85, 0.08, 1.1, '#f2eee4', 0.25)),
      plain(0, 0.85, 3, 0.45, 0.12, '#ece6d8', 1.35), roof(0, 0.85, 3, 0.5, 0.35, '#e2dccb', 1.47), plain(0, 1.45, 2, 0.5, 0.12, '#d0c9b8'),
      cyl(0, -0.45, 0.75, 0.45, '#e8e2d2', 1.45), dome(0, -0.45, 0.75, '#7f9e9a', 1.9), cyl(0, -0.45, 0.08, 0.35, '#e8e2d2', 2.62)] },
  { id: 'weathertower', cat: 'landmarks', group: 'Wonders', name: 'Weather Control Tower', cost: 3500000, upkeep: 18000, w: 2, d: 2, unique: true, workers: 30, milestone: 18, powerUse: 25,
    weatherControl: true, attract: 8,
    desc: 'Seeds the clouds and breaks up storms before they form: lightning, hail, wildfires and tornadoes strike about a third as often, and heatwaves are milder. Uses 25 MW.',
    shape: [box(0, 0, 1.6, 1.6, 0.5, '#c9ced6'), cyl(0, 0, 0.18, 9, '#dfe4ea', 0.5), cyl(0, 0, 0.7, 0.08, '#5ab4e8', 3), cyl(0, 0, 0.58, 0.08, '#5ab4e8', 5.2),
      cyl(0, 0, 0.46, 0.08, '#5ab4e8', 7.3), dome(0, 0, 0.32, '#7fd3ff', 9.5), cyl(0, 0, 0.32, 0.05, '#7fd3ff', 9.45), plain(0.5, 0.5, 0.3, 0.3, 0.25, '#9aa3ad', 0.5)] },
  { id: 'ecodome', cat: 'landmarks', group: 'Wonders', name: 'Eco Dome', cost: 2800000, upkeep: 14000, w: 5, d: 5, unique: true, workers: 60, milestone: 15,
    cleansAir: 0.015, radius: 26, leisure: 1.5, attract: 18,
    desc: 'A rainforest under glass that scrubs the city\'s air: air pollution clears faster everywhere, and much faster nearby. Also a big park.',
    shape: [lawn(4.95, 4.95, '#6f9f4e'), plain(0, 1.9, 0.6, 1.2, 0.07, '#c9c2b2'), dome(-0.35, -0.35, 1.9, '#cfeaf0'), dome(1.5, 1.35, 0.85, '#d9f0f4'),
      ...trees([[-2.1, 1.9], [-1.3, 2.1], [2.1, -1.9], [2.1, -0.6], [-2.1, -2.1], [0.9, 2.1]], 0.55)] },
  { id: 'wtc', cat: 'landmarks', group: 'Wonders', name: 'World Trade Centre', cost: 3000000, upkeep: 12000, w: 3, d: 3, unique: true, workers: 300, milestone: 16,
    exportBoost: 0.15, officeBoost: 0.06, attract: 12,
    desc: 'Where the world comes to do business: everything the city exports sells for 15% more, offices work 6% better, and 300 skilled jobs.',
    shape: [plain(0, 0, 2.9, 2.9, 0.05, '#bdb8ae'), box(-0.55, -0.5, 1, 1, 11, '#8fa9c6'), box(0.65, 0.45, 0.9, 0.9, 9.6, '#9db6cf'),
      plain(-0.55, -0.5, 1.04, 1.04, 0.12, '#d8dde3', 11), plain(0.65, 0.45, 0.94, 0.94, 0.12, '#d8dde3', 9.6), cyl(-0.55, -0.5, 0.04, 2, '#dddddd', 11.1)] },
  { id: 'cathedral', cat: 'landmarks', group: 'Wonders', name: 'Grand Cathedral', cost: 400000, upkeep: 6000, w: 5, d: 4, unique: true, workers: 20, milestone: 15,
    longBuild: { days: 100, perDay: 9000 }, culture: 2, wellbeing: 4, boostRadius: 24, attract: 30,
    desc: 'Built by generations of craftsmen: it takes about 100 days, paid as it goes (₡63,000 a week). Visitors come to watch it rise even half-built, and more with every stage. It can\'t be rushed.',
    shape: [plain(0, 0, 4.95, 3.95, 0.05, '#c9c3b5'), box(0, -0.35, 1.4, 2.8, 1.6, '#d8cdb4'), roof(0, -0.35, 1.5, 2.9, 0.9, '#5a6368', 1.6, true),
      box(0, -0.75, 3, 0.95, 1.45, '#d8cdb4'), roof(0, -0.75, 3.1, 1.05, 0.8, '#5a6368', 1.45),
      box(-0.6, 1.1, 0.62, 0.62, 3, '#d1c5aa'), box(0.6, 1.1, 0.62, 0.62, 3, '#d1c5aa'), hip(-0.6, 1.1, 0.64, 0.64, 1.7, '#5a6368', 3), hip(0.6, 1.1, 0.64, 0.64, 1.7, '#5a6368', 3),
      box(0, -0.75, 0.6, 0.6, 0.7, '#d1c5aa', 2.25), hip(0, -0.75, 0.6, 0.6, 2.2, '#5a6368', 2.95), plain(0, 1.07, 0.42, 0.03, 0.42, '#4a6fb5', 1.1),
      ...[-1.9, 1.9].flatMap((x) => trees([[x, 1.5], [x, -1.6]], 0.5))] },
  { id: 'collider', cat: 'landmarks', group: 'Wonders', name: 'Particle Collider', cost: 6000000, upkeep: 24000, w: 4, d: 4, unique: true, workers: 150, milestone: 19, powerUse: 80,
    ring: 20, research: 2, attract: 20, officeBoost: 0.04, needsUniversity: true,
    desc: 'A 40-cell ring of magnets under the city (it passes under anything, but must be under your land). Needs a university and a huge 80 MW. +2 development points a week, +4% office output and scientists from around the world.',
    shape: [lawn(3.95, 3.95, '#7fae55'), box(-0.55, -0.55, 2.4, 2, 1, '#dfe4ea'), plain(-0.55, -0.55, 2.5, 2.1, 0.08, '#9aa3ad', 1), dome(1, 0.85, 0.75, '#e9eef3'),
      cyl(1.2, -1.15, 0.5, 0.14, '#7fd3ff'), plain(-1.2, 1.4, 1.2, 0.6, 0.5, '#b9c2cc')] },

  // ---- the capital
  { id: 'parliament', cat: 'landmarks', group: 'Capital city', name: 'Parliament', cost: 4000000, upkeep: 8000, w: 5, d: 4, unique: true, workers: 200, milestone: 17, needsCityHall: true,
    grant: 15000, interestCut: 1, attract: 16, wellbeing: 2, boostRadius: 24,
    desc: 'Make this the capital. The national government pays the city ₡105,000 a week, loans get 1% cheaper, and visitors tour the debating chamber. Needs a City Hall.',
    shape: [lawn(4.95, 3.95, '#7fae55'), box(0, -0.35, 4.4, 1.6, 1.1, '#d9cfb8'), roof(-1.45, -0.35, 1.55, 1.7, 0.4, '#6d7f86', 1.1), roof(1.45, -0.35, 1.55, 1.7, 0.4, '#6d7f86', 1.1),
      box(0, -0.35, 1.25, 1.65, 1.5, '#e2d9c3'), cyl(0, -0.35, 0.56, 0.5, '#e2d9c3', 1.5), dome(0, -0.35, 0.56, '#5f8f8a', 2), cyl(0, -0.35, 0.08, 0.5, '#e2d9c3', 2.55),
      box(2.0, 0.65, 0.46, 0.46, 3.2, '#d1c4a6'), hip(2.0, 0.65, 0.5, 0.5, 0.7, '#5a6368', 3.2), plain(2.0, 0.89, 0.22, 0.02, 0.22, '#f2efe6', 2.6),
      ...[-0.45, -0.15, 0.15, 0.45].map((x) => cyl(x, 0.55, 0.06, 1.1, '#f2eee4')), ...flag(-1.6, 1.5, '#c8352b', 1.4), ...flag(1.0, 1.5, '#2f5fa8', 1.4)] },
  { id: 'embassies', cat: 'landmarks', group: 'Capital city', name: 'Embassy Quarter', cost: 1500000, upkeep: 5000, w: 5, d: 5, unique: true, workers: 120, milestone: 17, needsParliament: true,
    attract: 14, wellbeing: 3, boostRadius: 20, officeDemand: 0.1,
    desc: 'Foreign missions in leafy grounds: diplomats\' families and international visitors (half again as many with an airport), more demand for offices, and safe, pleasant streets nearby. Needs the Parliament.',
    shape: [lawn(4.95, 4.95, '#7fae55'), ...[[-2.43, 0, 0.08, 4.9], [2.43, 0, 0.08, 4.9], [0, -2.43, 4.9, 0.08]].map(([x, z, w, d]) => plain(x, z, w, d, 0.22, '#c9c2b2')),
      ...[[-1.25, -1.2, '#efe6d6', '#c8352b'], [1.25, -1.2, '#e3e8ee', '#2f5fa8'], [-1.25, 1.0, '#e8dcc6', '#e7b33b'], [1.25, 1.0, '#f2efe6', '#46a35c']].flatMap(([x, z, wall, fc]) => [
        box(x, z, 1.4, 1, 0.8, wall), hip(x, z, 1.5, 1.1, 0.4, '#6a5f55', 0.8), ...flag(x + 0.5, z + 0.75, fc, 1.1)]),
      cyl(0, 0, 0.32, 0.12, '#9fc6e8'), plain(0, 1.9, 0.6, 1.2, 0.07, '#c9c2b2')] },
  { id: 'library', cat: 'landmarks', group: 'Capital city', name: 'National Library', cost: 1200000, upkeep: 6000, w: 4, d: 3, unique: true, workers: 70, milestone: 16,
    culture: 3, studyBoost: 1, attract: 6,
    desc: 'Millions of books and a reading garden: +3 well-being city-wide, and everyone studying at college or university finishes a day sooner.',
    shape: [plain(0, 0, 3.95, 2.95, 0.05, '#c9c3b5'), box(-0.35, -0.35, 3, 1.8, 0.9, '#e6e1d6'), box(0.15, -0.45, 2.2, 1.4, 0.8, '#cfd8de', 0.9),
      box(0.55, -0.55, 1.2, 1, 0.7, '#9db6c8', 1.7), plain(-0.35, 0.56, 2.6, 0.06, 0.7, '#8fb4cf', 0.1), ...trees([[-1.6, 1.15], [-0.8, 1.2], [1.4, 1.1]], 0.45)] },

  // ---- attractions
  { id: 'zoo', cat: 'landmarks', group: 'Attractions', name: 'City Zoo', cost: 600000, upkeep: 6500, w: 6, d: 5, unique: true, workers: 40, milestone: 8,
    leisure: 1.4, radius: 26, attract: 16, wellbeing: 3, boostRadius: 22, familyDraw: true,
    desc: 'Families come from all over the city: a big park, a tourist draw, and homes nearby are worth more (+3 well-being around it).',
    shape: [lawn(5.95, 4.95, '#86b862'), plain(-1.5, -1.1, 2.6, 2, 0.08, '#d8c384'), plain(1.5, -1.2, 1.9, 1.6, 0.085, '#4aa3d8'), plain(1.5, 1.1, 2, 1.4, 0.08, '#6f9f4e'),
      ...[[-2.1, -1.5], [-1.5, -0.7], [-0.8, -1.4]].map(([x, z]) => plain(x, z, 0.3, 0.16, 0.2, '#8d8a85')), ...[[-1.2, -1.6], [-0.6, -0.8]].map(([x, z]) => plain(x, z, 0.08, 0.08, 0.55, '#d9a441')),
      plain(1.3, -1.1, 0.2, 0.1, 0.08, '#2b2d31', 0.085), box(0, 2.05, 1.6, 0.6, 0.6, '#c49a6c'), roof(0, 2.05, 1.7, 0.7, 0.3, '#6b4f36', 0.6),
      plain(0, 0.4, 5.6, 0.3, 0.075, '#c9c2b2'), ...trees([[1.0, 0.9], [2.0, 1.4], [1.6, 0.7], [2.5, -0.3], [-2.6, 1.5], [-1.4, 1.2]], 0.6)] },
  { id: 'aquarium', cat: 'landmarks', group: 'Attractions', name: 'Aquarium', cost: 700000, upkeep: 6000, w: 4, d: 3, unique: true, workers: 45, milestone: 9, needsWater: true,
    leisure: 1.2, radius: 20, attract: 15, wellbeing: 2, boostRadius: 16, familyDraw: true,
    desc: 'Sharks, jellyfish and a tunnel under the tanks. Must be next to water. A tourist draw and a day out for families.',
    shape: [plain(0, 0, 3.95, 2.95, 0.05, '#c9c3b5'), box(-0.3, -0.15, 2.8, 1.8, 0.9, '#2f7fb3'), shell(-0.3, -0.15, 2.8, 1.6, 0.7, '#5fb8e0', 0.9),
      cyl(1.5, 0.8, 0.35, 0.6, '#7fd3ff'), cyl(1.5, -0.6, 0.3, 0.5, '#7fd3ff'), plain(-0.3, 0.8, 1.2, 0.05, 0.3, '#f2c94c', 0.5)] },
  { id: 'convention', cat: 'landmarks', group: 'Attractions', name: 'Convention Centre', cost: 900000, upkeep: 6000, w: 5, d: 4, unique: true, workers: 60, milestone: 9,
    delegates: 450, attract: 4,
    desc: 'Trade fairs and conferences Monday to Thursday: up to 450 business travellers a night who need hotel rooms (they come first), pay a registration fee and spend in the shops. More come to a city with lots of offices.',
    shape: [plain(0, 0, 4.95, 3.95, 0.05, '#bdb8ae'), box(0, -0.45, 4.6, 2.6, 1, '#d6dbe0'), roof(0, -0.45, 4.7, 2.7, 0.35, '#8a96a3', 1), plain(0, 0.86, 4.2, 0.08, 0.8, '#8fb4cf', 0.05),
      ...[-1.8, -0.9, 0, 0.9, 1.8].flatMap((x) => flag(x, 1.6, ['#c8352b', '#2f5fa8', '#e7b33b', '#46a35c', '#c05ac0'][Math.round(x / 0.9 + 2)], 1))] },
  { id: 'filmstudio', cat: 'landmarks', group: 'Attractions', name: 'Film Studio', cost: 800000, upkeep: 5000, w: 5, d: 5, unique: true, workers: 120, milestone: 11,
    studio: true, attract: 12,
    desc: 'Sound stages, a backlot and the big sign. Studio tours draw tourists, every production pays a location fee, and now and then a director asks to close a few of your streets for a day\'s shoot (the film draws tourists when it comes out).',
    shape: [plain(0, 0, 4.95, 4.95, 0.05, '#9a978f'), box(-1.5, -1.2, 1.6, 2.3, 1.2, '#d8d4cc'), roof(-1.5, -1.2, 1.7, 2.4, 0.3, '#bfb9ad', 1.2), box(0.4, -1.2, 1.6, 2.3, 1.2, '#e3dfd7'), roof(0.4, -1.2, 1.7, 2.4, 0.3, '#bfb9ad', 1.2),
      plain(1.75, 0.6, 0.6, 0.35, 0.7, '#c9a27a'), plain(2.05, 1.15, 0.45, 0.3, 0.55, '#8fb4cf'), plain(1.55, 1.6, 0.5, 0.3, 0.6, '#d8b9ae'), cyl(2.0, -1.6, 0.05, 1.1, '#888'), cyl(2.0, -1.6, 0.3, 0.45, '#b9b5ad', 1.1),
      ...[-2.05, -0.75].map((x) => plain(x, 1.85, 0.05, 0.05, 0.45, '#888')), ...[0, 1, 2, 3, 4, 5].map((k) => plain(-2.15 + k * 0.29, 1.85, 0.2, 0.05, 0.3, '#f4f4f4', 0.4))] },
  { id: 'casino', cat: 'landmarks', group: 'Attractions', name: 'Casino', cost: 350000, upkeep: 2000, w: 3, d: 3, workers: 50, milestone: 10,
    casino: true, attract: 8,
    desc: 'High income from the gaming licence (a quarter of the takings) and plenty of tourists, but more crime and lower well-being nearby. Casinos within about 100 m of each other form a strip: each one earns and draws a third more.',
    shape: [plain(0, 0, 2.9, 2.9, 0.05, '#3b3b44'), box(0, 0.1, 2.8, 2.2, 0.8, '#2b2b33'), box(0, -0.45, 1.6, 1.2, 4.2, '#c9a54a', 0.8),
      plain(0, 1.21, 2.6, 0.04, 0.16, '#ff3fa4', 0.55), plain(0, 0.16, 1.64, 0.04, 0.14, '#3fd0ff', 4.6), plain(0, -0.45, 1.64, 1.24, 0.1, '#ff3fa4', 5), cyl(0, 1.3, 0.3, 0.1, '#3fd0ff')] },

  // ---- big industry, run by the city: buys goods from the market and sells what it makes
  { id: 'carfactory', cat: 'landmarks', group: 'Giant industry', name: 'Car Factory', cost: 1500000, upkeep: 6000, w: 6, d: 5, unique: true, workers: 220, milestone: 13,
    factory: { inputs: { metals: 1, plastics: 0.5, electronics: 0.5 }, makes: 'cars', price: 400, perWorker: 0.25 }, pollution: { air: 0.4, noise: 0.6 },
    desc: 'Turns metals, plastics and electronics into cars for export (₡400 each): about 55 a day with every job filled. It buys from your own industry first, and imports what\'s missing.',
    shape: [plain(0, 0, 5.95, 4.95, 0.05, '#8d8a83'), box(-0.6, -1, 4.2, 2.4, 1, '#c4c8cc'), ...[-2, -0.6, 0.8].map((x) => roof(x, -1, 1.38, 2.4, 0.32, '#8d959c', 1)),
      box(2.2, -1.2, 1.2, 1.8, 1.3, '#d9dde1'), cyl(2.45, -1.75, 0.12, 2.3, '#9a958c'), plain(0, 1.45, 5.6, 1.6, 0.07, '#5a5d63')] },
  { id: 'shipyard', cat: 'landmarks', group: 'Giant industry', name: 'Shipyard', cost: 1800000, upkeep: 5000, w: 6, d: 4, unique: true, workers: 180, milestone: 14, needsWater: true,
    factory: { inputs: { metals: 600, electronics: 100 }, makes: 'ship', price: 95000, days: 6 }, pollution: { noise: 0.7 },
    desc: 'Builds a cargo ship on the slipway, then launches and sells it (₡95,000): about one every 6 days with every job filled. It needs 600 metals and 100 electronics per ship. Must be next to water.',
    shape: [plain(0, 0, 5.95, 3.95, 0.08, '#8d8a83'), plain(0, -0.55, 5.2, 1.5, 0.1, '#6c6a64', 0.08), ...[-2.65, 2.65].flatMap((x) => [plain(x, -1.35, 0.12, 0.12, 2.6, '#ffd300'), plain(x, 0.25, 0.12, 0.12, 2.6, '#ffd300')]),
      plain(-2.65, -0.55, 0.12, 1.7, 0.12, '#ffd300', 2.6), plain(2.65, -0.55, 0.12, 1.7, 0.12, '#ffd300', 2.6), plain(0, -0.55, 5.4, 0.16, 0.16, '#ffd300', 2.6), plain(0.8, -0.55, 0.4, 0.3, 0.25, '#55585e', 2.35),
      box(-1.8, 1.3, 2, 1, 0.9, '#b9b5ad'), box(1.2, 1.3, 1.6, 1, 0.7, '#a7a49b')] },

  // ---- utilities
  { id: 'desal', cat: 'water', name: 'Desalination Plant', cost: 600000, upkeep: 6000, w: 4, d: 3, water: 20000, needsWater: true, desal: true, workers: 20, milestone: 8, powerUse: 12,
    desc: 'Turns seawater (or any water) into clean drinking water: 20,000 m³ a day whatever is in the water it draws, but it uses 12 MW. Solves water on dry maps.',
    shape: [plain(0, 0, 3.95, 2.95, 0.05, '#bdb8ae'), box(-0.8, 0.25, 2.2, 1.4, 0.8, '#d9dfe6'), cyl(1.2, -0.6, 0.45, 0.7, '#e8eef4'), cyl(1.2, 0.6, 0.45, 0.7, '#e8eef4'),
      plain(0.3, -0.9, 1.6, 0.1, 0.1, '#3aa0ff', 0.3), plain(-0.8, -0.85, 2, 0.5, 0.35, '#9fb6c8')] },
  { id: 'carboncapture', cat: 'garbage', group: 'Pollution control', name: 'Carbon Capture Plant', cost: 500000, upkeep: 4000, w: 3, d: 3, radius: 32, scrubs: 0.15, workers: 12, milestone: 13, powerUse: 8,
    desc: 'Giant fans pull the smog out of the air within 256 m (it clears about seven times faster there) and slowly clean the ground under it. Uses 8 MW.',
    shape: [plain(0, 0, 2.9, 2.9, 0.05, '#9a978f'), box(0, -0.3, 2.6, 1.6, 1, '#5a6068'), ...[-0.85, 0, 0.85].map((x) => cyl(x, -0.3, 0.32, 0.1, '#2b2f35', 1)),
      cyl(1, 1.05, 0.3, 0.9, '#c9ced6'), plain(-0.6, 1.05, 1.2, 0.5, 0.4, '#8d959c')] },
];

// ------------------------------------------------------------- bought landmarks
// Big buildings you buy that then run like grown ones (residents, workers, a business)
const P = [
  { id: 'megamall', cat: 'com', name: 'Mega-Mall', product: 'retail', w: 6, d: 5, jobs: 420, cost: 1200000, milestone: 11, wellbeing: 1, radius: 14, attract: 14, mallPull: 30,
    desc: 'Hundreds of shops under one roof: 420 jobs, a tourist draw, and it sells more than any street of shops. But shops within 240 m lose a lot of their customers to it, and some may close.',
    effect: 'Draws shoppers from 240 m around (small shops there lose customers) · +14 attractiveness',
    shape: [plain(0, 1.5, 5.9, 1.8, 0.04, '#4f5359'), ...[-2.2, -1.4, -0.6, 0.6, 1.4, 2.2].flatMap((x, k) => [plain(x, 1.2, 0.3, 0.16, 0.12, CAR_COLORS[k % 7]), plain(x + 0.2, 1.8, 0.3, 0.16, 0.12, CAR_COLORS[(k + 3) % 7])]),
      box(0, -0.85, 5.6, 3, 1, '#e6e3dc'), shell(0, -0.85, 1.8, 1.8, 0.8, '#bfe0ef', 1), box(-2.2, -0.85, 1.2, 2.8, 1.3, '#c9c4b8'), box(2.2, -0.85, 1.2, 2.8, 1.3, '#d4d0c8'),
      plain(-2.2, 0.56, 1, 0.04, 0.25, '#e05a47', 0.85), plain(2.2, 0.56, 1, 0.04, 0.25, '#3f8fd0', 0.85), plain(0, 0.66, 1.4, 0.04, 0.25, '#e7b33b', 0.6)] },
  { id: 'skybridge', cat: 'res', name: 'Skybridge Towers', product: 'finance', w: 5, d: 5, hh: 360, jobs: 300, cost: 2500000, milestone: 14, wellbeing: 2, radius: 16, attract: 10, liveWork: true,
    desc: 'Four towers linked by skybridges high above the street: 360 homes and 300 office jobs. Residents take the jobs upstairs first, so a lot of them never drive to work.',
    effect: '360 homes and 300 office jobs · residents work upstairs first (fewer commutes) · +10 attractiveness',
    shape: [plain(0, 0, 4.95, 4.95, 0.05, '#bdb8ae'), box(-1.25, -1.25, 1.4, 1.4, 12, '#7d9cc4'), box(1.25, -1.25, 1.4, 1.4, 10.5, '#8aa7c9'), box(-1.25, 1.1, 1.4, 1.4, 9, '#a0b6cf'), box(1.25, 1.1, 1.4, 1.4, 11.5, '#6f8fb3'),
      plain(0, -1.25, 1.2, 0.42, 0.36, '#d8e2ea', 6.4), plain(-1.25, -0.08, 0.42, 1, 0.36, '#d8e2ea', 5.4), plain(1.25, -0.08, 0.42, 1, 0.36, '#d8e2ea', 8.1), plain(0, 1.1, 1.2, 0.42, 0.36, '#d8e2ea', 7.2),
      ...[[-1.25, -1.25, 12], [1.25, -1.25, 10.5], [-1.25, 1.1, 9], [1.25, 1.1, 11.5]].map(([x, z, h]) => plain(x, z, 1.44, 1.44, 0.14, '#e9eef3', h))] },
];

for (const p of P) {
  p.kind = 'zone';
  p.signature = true;   // a landmark: doesn't level up, isn't abandoned, draws tourists
  p.bought = true;      // ...but you buy it (signature buildings are free rewards)
  p.key = p.id;
  p.lots = [[p.w, p.d]];
  p.floors = 1; p.maxFloors = 1;
  p.edu = p.cat === 'res' ? [0.02, 0.08, 0.3, 0.35, 0.25] : [0.3, 0.3, 0.25, 0.1, 0.05];
  p.permanent = false;
}

export const WONDERS = W;
export const BOUGHT_LANDMARKS = P;
export const BOUGHT_BY_ID = Object.fromEntries(P.map((p) => [p.id, p]));
registerDefs('zone', BOUGHT_BY_ID);

// The car factory's yard fills with finished cars waiting for the transporters, and the
// shipyard's ship grows on the slipway: these parts are added to their shapes (see
// buildingsView). `b` is the building.
export function liveParts(b) {
  const out = [];
  if (b.def.id === 'carfactory') {
    const n = Math.min(32, Math.round(b.carsWaiting || 0));
    for (let k = 0; k < n; k++) {
      const row = Math.floor(k / 8), col = k % 8;
      out.push(plain(-2.3 + col * 0.66, 0.95 + row * 0.34, 0.34, 0.18, 0.12, CAR_COLORS[(k * 3 + row) % 7], 0.07));
    }
  }
  if (b.def.id === 'shipyard') {
    const p = Math.min(1, b.shipProgress || 0);
    if (p > 0.02) {
      const len = 1.2 + 3.6 * Math.min(1, p * 1.4);
      out.push(plain(-0.2 + (len - 4.8) / 2, -0.55, len, 1, 0.25 + 0.4 * Math.min(1, p * 1.6), '#5a6470', 0.18));
      if (p > 0.55) out.push(plain(-2.0, -0.55, 0.5, 0.95, 0.1, '#7a2633', 0.18));
      if (p > 0.7) out.push(plain(1.4, -0.55, 0.9, 0.7, 0.55, '#e8e8e8', 0.83));
      if (p > 0.85) out.push(cyl(1.25, -0.55, 0.14, 0.45, '#c8352b', 1.38));
      if (p > 0.6) for (let k = 0; k < Math.round((p - 0.6) * 12); k++) out.push(plain(-1.6 + k * 0.38, -0.55, 0.32, 0.6, 0.22, ['#c8352b', '#2f5fa8', '#e7b33b', '#46a35c'][k % 4], 0.83));
    }
  }
  return out;
}
