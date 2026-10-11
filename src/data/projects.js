// Projects you lay out on the map: Central Park, beaches and the boardwalk (drawn as areas),
// a theme park (a gate, then rides inside the grounds around it) and water taxi piers. Their
// workings are in sim/projects.js.
//
// Area fields: area { min, max, shore? } cells across · perCell / upkeepPerCell · scale(cells)
// gives the coverage radius, attractiveness and well-being reach for the size drawn.
// parts(b) draws them for the size they were laid out at (see world/buildingsView.js).
import { makeRng } from '../core/rng.js';

const box = (x, z, w, d, h, color, y = 0, pool = 'body') => ({ pool, x, z, w, d, h, y, color });
const plain = (x, z, w, d, h, color, y = 0) => box(x, z, w, d, h, color, y, 'plain');
const cyl = (x, z, r, h, color, y = 0) => ({ pool: 'cyl', x, z, w: r * 2, d: r * 2, h, y, color });
const dome = (x, z, r, color, y = 0) => ({ pool: 'dome', x, z, w: r * 2, d: r * 2, h: r, y, color });
const shell = (x, z, w, d, h, color, y = 0) => ({ pool: 'dome', x, z, w, d, h, y, color });
const roof = (x, z, w, d, h, color, y, turn = false) => ({ pool: 'roof', x, z, w, d, h, y, color, turn });
const hip = (x, z, w, d, h, color, y) => ({ pool: 'hip', x, z, w, d, h, y, color });
const tree = (x, z, s, color = '#4e8a35') => [cyl(x, z, 0.04, 0.3, '#6b4f36'), dome(x, z, s / 2, color, 0.25)];
const flag = (x, z, color, h = 1) => [cyl(x, z, 0.025, h, '#d8d8d8'), plain(x + 0.12, z, 0.22, 0.02, 0.14, color, h - 0.16)];
export const PARK_REACH = 18; // cells from the theme park gate a ride may stand
const BRIGHT = ['#e05a47', '#3f8fd0', '#f2c94c', '#46a35c', '#c05ac0', '#f08a3c', '#3fd0c8'];
const GREENS = ['#4e8a35', '#5a9a3e', '#46802f', '#3f7a33', '#6aa84a'];

// --- Central Park: lawns, woods, a lake and paths, sized to the area drawn
function parkParts(b) {
  const W = b.w, D = b.d, r = makeRng(b.seed || 7);
  const P = [plain(0, 0, W * 0.995, D * 0.995, 0.06, '#7fb35a')];
  const lx = r.range(-W * 0.1, W * 0.1), lz = r.range(-D * 0.12, D * 0.02), lw = W * 0.38, ld = D * 0.32;
  const water = '#3f8fd0';
  P.push(plain(lx, lz, lw, ld, 0.08, water), plain(lx, lz, lw * 0.78, ld * 1.28, 0.08, water), plain(lx, lz, lw * 1.14, ld * 0.66, 0.08, water));
  P.push(plain(lx + lw * 0.18, lz - ld * 0.1, lw * 0.16, ld * 0.2, 0.12, '#6f9f4e')); // a little island
  const path = '#d6cdb9';
  P.push(plain(0, D / 2 - 0.25, W * 0.97, 0.2, 0.075, path));                    // promenade by the road
  P.push(plain(lx, (lz + ld * 0.64 + D / 2) / 2, 0.18, D / 2 - lz - ld * 0.6, 0.075, path)); // to the lake
  P.push(plain(lx, lz, lw * 1.42, 0.16, 0.074, path), plain(lx, lz, 0.16, ld * 1.55, 0.074, path)); // round the lake
  P.push(plain(-W / 2 + 0.6, 0, 0.16, D * 0.9, 0.075, path), plain(W / 2 - 0.6, 0, 0.16, D * 0.9, 0.075, path));
  P.push(cyl(lx - lw * 0.7, lz + ld * 0.7, 0.32, 0.25, '#e8e1d0'), shell(lx - lw * 0.7, lz + ld * 0.7, 0.75, 0.75, 0.3, '#5f8f8a', 0.55)); // bandstand
  const n = Math.min(130, Math.round(W * D * 0.5));
  for (let k = 0; k < n; k++) {
    const x = r.range(-W / 2 + 0.35, W / 2 - 0.35), z = r.range(-D / 2 + 0.35, D / 2 - 0.65);
    if (((x - lx) / (lw * 0.75)) ** 2 + ((z - lz) / (ld * 0.85)) ** 2 < 1) continue; // not in the lake
    if (Math.abs(x - lx) < 0.25 || Math.abs(Math.abs(x) - (W / 2 - 0.6)) < 0.2) continue; // not on a path
    P.push(...tree(x, z, r.range(0.45, 0.8), GREENS[k % GREENS.length]));
  }
  return P;
}

// --- a beach: sand, umbrellas and towels, a lifeguard's chair
// (the sand is painted on the ground itself: sim/projects.js; these parts follow the slope)
function beachParts(b) {
  const W = b.w, D = b.d, r = makeRng(b.seed || 7);
  const P = [];
  const n = Math.min(40, Math.round(W * D * 0.7));
  for (let k = 0; k < n; k++) {
    const x = r.range(-W / 2 + 0.3, W / 2 - 0.3), z = r.range(-D / 2 + 0.3, D / 2 - 0.3), c = BRIGHT[k % BRIGHT.length];
    if (k % 3 === 2) { P.push(plain(x, z, 0.14, 0.26, 0.03, c, 0.01)); continue; }
    P.push(cyl(x, z, 0.018, 0.32, '#e8e8e8', 0.01), hip(x, z, 0.36, 0.36, 0.12, c, 0.3), plain(x + 0.16, z + 0.05, 0.13, 0.25, 0.03, BRIGHT[(k + 3) % BRIGHT.length], 0.01));
  }
  P.push(plain(W * 0.3, 0, 0.05, 0.05, 0.55, '#e8e8e8'), plain(W * 0.3, 0, 0.3, 0.25, 0.06, '#e05a47', 0.55), plain(W * 0.3, 0, 0.32, 0.27, 0.04, '#f2f2f2', 0.75));
  return P.map((p) => ({ ...p, ground: true }));
}

// --- the boardwalk: a raised wooden promenade with kiosks, lamps and benches
function boardwalkParts(b) {
  const W = b.w, D = b.d, r = makeRng(b.seed || 7);
  const P = [plain(0, 0, W * 0.995, D * 0.995, 0.14, '#a8835a'), ...[-1, 1].map((s) => plain(0, s * (D / 2 - 0.04), W * 0.99, 0.04, 0.32, '#e8e1d0', 0.14))];
  for (let x = -W / 2 + 1; x < W / 2 - 0.5; x += 2.4) {
    const c = BRIGHT[Math.floor(r.range(0, BRIGHT.length))];
    P.push(box(x, -D * 0.22, 0.7, Math.min(0.55, D * 0.4), 0.42, '#f2efe6', 0.14), roof(x, -D * 0.22, 0.8, Math.min(0.6, D * 0.45), 0.18, c, 0.56), plain(x, -D * 0.22 + Math.min(0.28, D * 0.2), 0.6, 0.03, 0.08, c, 0.4));
  }
  for (let x = -W / 2 + 0.4; x < W / 2; x += 1.6) P.push(cyl(x, D * 0.32, 0.025, 0.55, '#3a3d42', 0.14), plain(x, D * 0.32, 0.12, 0.12, 0.06, '#ffe9a8', 0.69));
  return P;
}

// --- theme park rides
const ride = (cap, appeal) => ({ capacity: cap, appeal });
function coasterParts() {
  const P = [plain(0, 0, 4.9, 2.9, 0.05, '#c9c3b5'), box(-1.9, 1.1, 0.8, 0.5, 0.4, '#e05a47')];
  // a loop of track on stilts: up the lift hill, a big drop, a few bumps
  const pts = 44;
  for (let k = 0; k < pts; k++) {
    const t = (k / pts) * Math.PI * 2;
    const x = Math.cos(t) * 2.05, z = Math.sin(t) * 1.15;
    const h = 0.35 + Math.max(0, Math.sin(t * 1 + 0.6)) * 2.3 + Math.max(0, Math.sin(t * 3)) * 0.6;
    P.push(plain(x, z, 0.06, 0.06, h, '#d8d8d8'), plain(x, z, 0.26, 0.26, 0.07, '#e05a47', h));
  }
  for (let k = 0; k < 4; k++) P.push(plain(-2.05 + k * 0.05, -0.3 - k * 0.24, 0.24, 0.2, 0.14, '#3f8fd0', 0.42 + k * 0.4));
  return P;
}
const RIDES = [
  { id: 'carousel', name: 'Carousel', cost: 60000, upkeep: 400, w: 2, d: 2, workers: 3, ride: ride(900, 2),
    desc: 'Painted horses going round and round: gentle fun for families.',
    shape: [plain(0, 0, 1.95, 1.95, 0.05, '#c9c3b5'), cyl(0, 0, 0.85, 0.12, '#e8d8b0', 0.05), cyl(0, 0, 0.07, 0.9, '#f2c94c', 0.17), shell(0, 0, 1.85, 1.85, 0.4, '#e05a47', 0.85),
      ...[0, 1, 2, 3, 4, 5].map((k) => plain(Math.cos(k) * 0.6, Math.sin(k) * 0.6, 0.12, 0.25, 0.22, BRIGHT[k], 0.3))] },
  { id: 'bumpercars', name: 'Bumper Cars', cost: 70000, upkeep: 450, w: 2, d: 2, workers: 3, ride: ride(700, 2),
    desc: 'A crowd-pleaser for all ages.',
    shape: [plain(0, 0, 1.95, 1.95, 0.06, '#5a5d63'), ...[[-0.85, -0.85], [0.85, -0.85], [-0.85, 0.85], [0.85, 0.85]].map(([x, z]) => plain(x, z, 0.06, 0.06, 0.75, '#d8d8d8')),
      plain(0, 0, 1.95, 1.95, 0.08, '#3f8fd0', 0.75), plain(0, 0, 1.95, 0.3, 0.1, '#f2c94c', 0.75), ...[[-0.5, -0.3], [0.2, 0.4], [0.5, -0.5], [-0.3, 0.55]].map(([x, z], k) => plain(x, z, 0.24, 0.18, 0.12, BRIGHT[k + 1], 0.06))] },
  { id: 'hauntedhouse', name: 'Haunted House', cost: 90000, upkeep: 500, w: 2, d: 2, workers: 4, ride: ride(800, 3),
    desc: 'Creaking floors and things that go bump in the dark.',
    shape: [plain(0, 0, 1.95, 1.95, 0.05, '#8a8f6a'), box(0, -0.2, 1.4, 1.1, 0.9, '#4a3f55'), hip(0, -0.2, 1.5, 1.2, 0.7, '#2b2533', 0.9), box(0.55, -0.55, 0.4, 0.4, 1.6, '#4a3f55'), hip(0.55, -0.55, 0.45, 0.45, 0.6, '#2b2533', 1.6),
      ...[[-0.6, 0.7], [-0.2, 0.75], [0.3, 0.7]].map(([x, z]) => plain(x, z, 0.12, 0.05, 0.16, '#a9a9a3'))] },
  { id: 'logflume', name: 'Log Flume', cost: 180000, upkeep: 900, w: 3, d: 4, workers: 6, ride: ride(1200, 4),
    desc: 'Hollowed-out logs down a water chute, and a big splash at the bottom.',
    shape: [plain(0, 0, 2.95, 3.95, 0.05, '#7fb35a'), hip(-0.6, -0.9, 1.6, 1.8, 1.6, '#8d7a62', 0.05), ...[0, 1, 2, 3, 4].map((k) => plain(0.95, -1.6 + k * 0.62, 0.32, 0.64, 0.1, '#3fa0d8', 1.5 - k * 0.32)),
      plain(0, 1.5, 2.2, 0.32, 0.1, '#3fa0d8', 0.06), plain(-1.1, 0.5, 0.32, 2, 0.1, '#3fa0d8', 0.06), ...[[0.95, -0.7], [-0.4, 1.5]].map(([x, z]) => plain(x, z, 0.18, 0.4, 0.12, '#7a5a3a', 0.4)),
      ...[0, 1, 2, 3].map((k) => plain(0.95, -1.6 + k * 0.62, 0.05, 0.05, 1.5 - k * 0.32, '#8d877b'))] },
  { id: 'droptower', name: 'Drop Tower', cost: 150000, upkeep: 700, w: 2, d: 2, workers: 3, ride: ride(600, 4),
    desc: 'Up 60 metres, a moment\'s pause, then straight down. Seen from all over town.',
    shape: [plain(0, 0, 1.95, 1.95, 0.05, '#c9c3b5'), box(0, 0, 0.8, 0.8, 0.3, '#3f8fd0'), cyl(0, 0, 0.16, 5, '#d8d8d8', 0.3), cyl(0, 0, 0.45, 0.18, '#e05a47', 3.2), cyl(0, 0, 0.25, 0.25, '#f2c94c', 5.3)] },
  { id: 'rollercoaster', name: 'Roller Coaster', cost: 350000, upkeep: 1500, w: 5, d: 3, workers: 8, ride: ride(1600, 6),
    desc: 'The big one: a lift hill, a screaming drop and the longest queue in the park.', shape: coasterParts() },
];
for (const r of RIDES) {
  r.cat = 'landmarks'; r.group = 'Theme park'; r.milestone = 10; r.inPark = true; r.pollution = { noise: 0.25 };
  r.desc += ` Rides go inside the grounds, within ${PARK_REACH * 8} m of the Theme Park Gate (no road needed). ${r.ride.capacity} riders a day.`;
}

export const PROJECTS = [
  { id: 'centralpark', cat: 'parks', group: 'Grand parks', name: 'Central Park', cost: 50000, perCell: 1400, upkeep: 300, upkeepPerCell: 22, w: 8, d: 8, area: { min: 6, max: 24 },
    leisure: 1.6, radius: 18, attract: 6, wellbeing: 5, boostRadius: 16, workers: 12, milestone: 8, parts: parkParts,
    scale: (cells) => ({ radius: Math.round(12 + Math.sqrt(cells) * 0.9), attract: Math.min(30, Math.round(4 + cells / 18)), boostRadius: Math.round(10 + Math.sqrt(cells) * 0.8) }),
    desc: 'Draw a huge park with woods, a lake and paths: the bigger it is, the further its leisure reaches and the more it raises land value and well-being around it (+5). A tourist draw once it\'s big.' },
  { id: 'beach', cat: 'parks', group: 'Waterfront', name: 'Beach', cost: 15000, perCell: 600, upkeep: 100, upkeepPerCell: 8, w: 4, d: 3, area: { min: 2, max: 20, shore: true },
    leisure: 1.1, radius: 12, attract: 4, seasonal: true, workers: 4, milestone: 5, parts: beachParts, noBase: true, sand: true, powerUse: 0, waterUse: 0,
    scale: (cells) => ({ radius: Math.round(8 + Math.sqrt(cells) * 0.8), attract: Math.min(22, Math.round(2 + cells / 5)) }),
    desc: 'Draw sand along the coast or a lakeshore (it has to touch the water, with a road within 3 cells). Packed in summer, and a big tourist draw then; quiet in winter.' },
  { id: 'boardwalk', cat: 'parks', group: 'Waterfront', name: 'Boardwalk', cost: 20000, perCell: 1100, upkeep: 150, upkeepPerCell: 14, w: 6, d: 1, area: { min: 1, max: 24, shore: true, strip: true },
    leisure: 0.8, radius: 10, attract: 3, seasonal: true, promenade: true, workers: 10, milestone: 5, parts: boardwalkParts, powerUse: 0, waterUse: 0,
    scale: (cells) => ({ radius: Math.round(7 + Math.sqrt(cells)), attract: Math.min(16, Math.round(2 + cells / 3)) }),
    desc: 'Draw a wooden promenade along the water (1 or 2 cells wide), lined with kiosks. Its shops do a roaring trade with summer visitors (they pay the city), and it draws tourists to the seafront.' },
  { id: 'themepark', cat: 'landmarks', group: 'Theme park', name: 'Theme Park Gate', cost: 400000, upkeep: 3000, w: 3, d: 2, unique: true, themeGate: true, workers: 30, milestone: 10,
    desc: `The entrance to your theme park, where tickets are sold. Lay out rides in the grounds around it (within ${PARK_REACH * 8} m): every ride adds to the fun and to what the park can take. Too few rides for the crowds and the queues grow until people stay away.`,
    shape: [plain(0, 0, 2.95, 1.95, 0.05, '#c9c3b5'), box(-1.1, 0.3, 0.6, 0.6, 1.4, '#e05a47'), box(1.1, 0.3, 0.6, 0.6, 1.4, '#e05a47'), hip(-1.1, 0.3, 0.65, 0.65, 0.5, '#f2c94c', 1.4), hip(1.1, 0.3, 0.65, 0.65, 0.5, '#f2c94c', 1.4),
      plain(0, 0.3, 1.7, 0.2, 0.32, '#3f8fd0', 1.05), box(-0.5, 0.75, 0.35, 0.3, 0.4, '#f2efe6'), box(0.5, 0.75, 0.35, 0.3, 0.4, '#f2efe6'), ...flag(-1.1, 0.3, '#46a35c', 2.2), ...flag(1.1, 0.3, '#c05ac0', 2.2)] },
  ...RIDES,
];
for (const p of PROJECTS) if (!p.cat) p.cat = 'parks';

// (a transport building: added to the transport list in data/transport.js)
export const PIER = { id: 'waterpier', name: 'Water Taxi Pier', cost: 25000, upkeep: 400, w: 1, d: 2, needsWater: true, waterTaxi: true, workers: 3, milestone: 9,
    desc: 'Water taxis run between the piers on the same stretch of water (a canal, river, lake or bay): people near one pier going to somewhere near another take the boat instead of driving. Build at least two.',
    shape: [plain(0, -0.2, 0.95, 1.5, 0.12, '#a8835a'), box(0, 0.45, 0.6, 0.4, 0.4, '#3f8fd0'), roof(0, 0.45, 0.7, 0.5, 0.18, '#f2efe6', 0.4), cyl(0.35, -0.85, 0.04, 0.4, '#ddd')] };

