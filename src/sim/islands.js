// Island maps: every map is an island, or a group of them, out in the open sea. Each map's
// shape (ISLANDS, by the map's `island` in data/maps.js) says how far in from the coast a
// point is and how high the ground stands inland; the coast gets a beach, and the sea floor
// shelves away from it, shallow at first (light water over sand and reefs), then deep.
// Rivers, lakes and inlets are cut in last.
//
// Positions: (fx, fy) are fractions of the map (0..1, 0.5 = the middle) and distances in from
// the coast are too (0.01 = about 10 cells); (u, v) are FEATURE units around the middle (see
// mapgen.js) for the lie of the land, so hills and rivers keep their size in cells.
import { N, clamp, lerp } from '../core/grid.js';
import { makeRng } from '../core/rng.js';

const MID = N / 2;
const FEATURE = 144;          // (as in mapgen.js)
export const MARGIN = 0.03;   // open sea at least this far in from the map edge, all round
const SHORE = 0.35;           // how deep the water is at the coastline
const DEEP = 2.9;             // the open sea (the sea floor stays above the bottom of the world)

const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
// Smooth maximum and minimum: unions and cuts of shapes without a crease where they meet
const smax = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + h * h * k * 0.25; };
const smin = (a, b, k) => -smax(-a, -b, k);

// How far inside an ellipse a point is (< 0: outside), roughly: centred on (cx, cy), with
// radii rx and ry, turned by `ang` (radians)
function ellipse(fx, fy, cx, cy, rx, ry, ang = 0) {
  const dx = fx - cx, dy = fy - cy, c = Math.cos(ang), s = Math.sin(ang);
  return (1 - Math.hypot((dx * c + dy * s) / rx, (dy * c - dx * s) / ry)) * Math.min(rx, ry);
}

// A line through some points (an inlet, a channel, a loch): the distance from a point to it
// and how far along it the nearest point is (0 at the first point, 1 at the last). Points
// further than `reach` from it all get `reach`, without measuring.
function line(pts, reach = 0.06) {
  const lens = [];
  let total = 0;
  for (let k = 1; k < pts.length; k++) { const l = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]); lens.push(l); total += l; }
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const box = [Math.min(...xs) - reach, Math.min(...ys) - reach, Math.max(...xs) + reach, Math.max(...ys) + reach];
  return (fx, fy) => {
    if (fx < box[0] || fy < box[1] || fx > box[2] || fy > box[3]) return [reach, 0];
    let best = reach, along = 0, run = 0;
    for (let k = 1; k < pts.length; k++) {
      const [ax, ay] = pts[k - 1], [bx, by] = pts[k], l = lens[k - 1];
      const t = clamp(((fx - ax) * (bx - ax) + (fy - ay) * (by - ay)) / (l * l), 0, 1);
      const d = Math.hypot(fx - ax - (bx - ax) * t, fy - ay - (by - ay) * t);
      if (d < best) { best = d; along = (run + l * t) / total; }
      run += l;
    }
    return [best, along];
  };
}

// A coast made natural: the shape is measured at a point moved about by noise (bays and
// headlands), and the distance in from it wobbles (coves and points). warp: how far the
// shape is pushed about; rag: how broken the coast is (1 usual, more for rocky ones).
function natural(n, fx, fy, k, shape, warp = 0.12, rag = 1) {
  const x = fx + n.fbm(fx * 2.2 + k * 7.3, fy * 2.2 + 1.7, 4) * warp;
  const y = fy + n.fbm(fx * 2.2 + 5.2, fy * 2.2 + k * 3.9, 4) * warp;
  return shape(x, y) + (n.fbm(fx * 7 + k, fy * 7 - k, 4) * 0.03 + n.fbm(fx * 26 + 3 * k, fy * 26, 3) * 0.008) * rag;
}
// The point moved about by noise, so a line through it wanders (channels, lochs, fjords): big
// bends and small wiggles, about `amp` (fractions of the map) at most
const wander = (n, fx, fy, amp, k) => [
  fx + (n.fbm(fx * 4 + k, fy * 4 + 2, 3) * 2 + n.fbm(fx * 12 + 5, fy * 12 + k, 2)) * amp,
  fy + (n.fbm(fx * 4 + 7, fy * 4 + k, 3) * 2 + n.fbm(fx * 12 + k, fy * 12 + 9, 2)) * amp,
];

// Rolling ground, 0..1
const rolling = (n, u, v, scale = 1.6, k = 0) => n.fbm(u * scale + 2 + k, v * scale + 5 + k, 5) * 0.55 + 0.5;
const bumps = (n, u, v) => n.fbm(u * 9 + 31, v * 9 + 17, 3);

// Small islands: [x, y, radius, angle] (fractions of the map), their shores a little ragged
function islets(n, fx, fy, list) {
  let d = -1;
  for (const [cx, cy, r, ang = 0] of list) {
    // (beyond this the sea floor around it is as deep as it gets anyway)
    if (Math.abs(fx - cx) > r + 0.25 || Math.abs(fy - cy) > r + 0.25) continue;
    let e = ellipse(fx, fy, cx, cy, r, r * 0.65, ang);
    if (e > -0.02) e += n.fbm(fx * 40, fy * 40, 3) * r * 0.25;
    d = Math.max(d, e);
  }
  return d;
}
// Islets scattered in a band around a point, away from a few others (e.g. the way the
// highway comes in): [x, y, radius] each
function scatter(seed, count, [cx, cy], r0, r1, size, avoid = []) {
  const r = makeRng(seed);
  const out = [];
  for (let tries = 0; out.length < count && tries < count * 50; tries++) {
    const a = r.next() * Math.PI * 2, d = r0 + (r1 - r0) * r.next();
    const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
    if (x < 0.05 || y < 0.05 || x > 0.95 || y > 0.95 || avoid.some(([ax, ay, ar]) => Math.hypot(x - ax, y - ay) < ar)) continue;
    out.push([x, y, size * (0.4 + r.next()), r.next() * 3]);
  }
  return out;
}
// (keep islets off the highway's way in from the west, and away from town)
const WAY_IN = [[0.1, 0.5, 0.1], [0.25, 0.5, 0.08], [0.5, 0.5, 0.1]];

// A river: it rises `src` cells upstream of the map's middle and meanders down to the sea
// toward `to`, `at` cells across from the middle (east or south of it: +). Returns the distance
// (FEATURE units) from (u, v) to its middle; near its source it's only a stream. Through town
// it runs straight, exactly `at` across, so it keeps clear of the highway's end and the
// railway (see data/maps.js).
function riverDist(n, R, u, v) {
  const ns = R.to === 'south' || R.to === 'north';
  const back = R.to === 'north' || R.to === 'west';
  const along = ns ? (back ? 1 - v : v) : (back ? 1 - u : u);
  const across = ns ? u : v;
  const a0 = 0.5 + (R.src ?? -1e4) / FEATURE;
  if (along < a0) return 9;
  const free = smooth(0.12, 0.55, Math.abs(along - 0.5));
  const c = 0.5 + (R.at || 0) / FEATURE + free * ((R.amp ?? 0.08) * Math.sin(along * Math.PI * (R.freq ?? 1.6) + (R.phase || 0))
    + 0.06 * n.fbm(along * 3, (R.at || 0) * 0.05 + 7, 3));
  return Math.abs(across - c) + (1 - smooth(a0, a0 + 0.5, along)) * 0.04;
}
// The river cut into the ground: a strip of low, flat land along it (`valley`: how far out
// from the river, FEATURE units), then the channel itself (out at sea it's deep enough)
function carveRiver(n, R, u, v, h, sea) {
  const d = riverDist(n, R, u, v);
  if (d > Math.max(0.06, R.valley || 0)) return h;
  if (R.valley) h = Math.min(h, lerp(sea + 0.7, h, smooth(R.valley * 0.3, R.valley, d)));
  return Math.min(h, lerp(sea - 1.2, h, smooth(0.012, 0.05, d)));
}
// Water inside a shape (e: how far inside it a point is, fractions of the map), with low,
// flat shores
function carveLake(h, e, sea, depth = 1.6) {
  if (e < -0.03) return h;
  h = Math.min(h, lerp(h, sea + 0.9, smooth(-0.03, -0.004, e)));
  return Math.min(h, lerp(h, sea - depth, smooth(-0.004, 0.008, e)));
}

// Each island: coast(fx, fy, u, v) how far in from the coast (< 0: out at sea); ground(fx, fy,
// u, v, d) how high the land stands (above the sea) d in from the coast; carve(fx, fy, u, v, h,
// sea) the water cut into it. shelf: how wide the shallow water off the coast is; beach: how
// wide the beach is; rise: how far inland the ground takes to reach its full height (small:
// cliffs); deep: how fast the sea floor drops away beyond the shelf (1 usual); relief: how much
// of the hills' height is kept around town and further out (see generateMap).
export const ISLANDS = {
  // A big green island of rolling hills that ring its coast, with peninsulas and bays in the
  // south-west; a river rises in the north and flows south through the lowlands and town
  emerald: (n) => {
    const river = { to: 'south', at: 8, src: -300, amp: 0.08, freq: 1.5, phase: 0.6, valley: 0.16 };
    const loughs = [[0.37, 0.36, 0.045, 0.025, 0.5], [0.66, 0.6, 0.05, 0.028, -0.3], [0.31, 0.6, 0.03, 0.02, 0.2]];
    const isles = [[0.07, 0.6, 0.02], [0.1, 0.68, 0.012], [0.93, 0.4, 0.016], [0.9, 0.87, 0.022, 1], [0.15, 0.12, 0.016], [0.62, 0.94, 0.013], [0.13, 0.86, 0.014]];
    const shape = (x, y) => {
      let d = ellipse(x, y, 0.5, 0.5, 0.34, 0.32, 0.3);
      d = smax(d, ellipse(x, y, 0.3, 0.28, 0.16, 0.12, -0.6), 0.05);
      d = smax(d, ellipse(x, y, 0.71, 0.28, 0.14, 0.1, 0.5), 0.05);
      d = smax(d, ellipse(x, y, 0.71, 0.73, 0.14, 0.1, 0.7), 0.05);
      d = smax(d, ellipse(x, y, 0.23, 0.72, 0.14, 0.035, -0.8), 0.03);
      d = smax(d, ellipse(x, y, 0.31, 0.81, 0.12, 0.03, -0.7), 0.03);
      return d;
    };
    return {
      shelf: 0.012, beach: 0.005, rise: 0.06, relief: [0.45, 0.9],
      coast: (fx, fy) => Math.max(natural(n, fx, fy, 1, shape, 0.15, 1 + smooth(0.5, 0.15, fx) * 1.5), islets(n, fx, fy, isles)),
      ground: (fx, fy, u, v, d) => 1 + rolling(n, u, v) * 3 + smooth(0.15, 0.03, d) * smooth(0, 0.02, d) * rolling(n, u, v, 2.6, 5) * 6 + bumps(n, u, v) * 0.5,
      carve(fx, fy, u, v, h, sea) {
        for (const [cx, cy, rx, ry, a] of loughs) h = carveLake(h, ellipse(fx, fy, cx, cy, rx, ry, a) + n.fbm(u * 3 + cx * 9, v * 3, 3) * 0.01, sea);
        return carveRiver(n, river, u, v, h, sea);
      },
    };
  },

  // Two islands side by side, a narrow strait between them right through town: the west one
  // bigger, hilly and wooded, the east one low and fertile, with a hooked cape round a bay
  twins: (n) => {
    const isles = [[0.5, 0.07, 0.018], [0.47, 0.93, 0.02], [0.06, 0.3, 0.014], [0.95, 0.68, 0.015], [0.55, 0.88, 0.012]];
    // (the two overlap a little in the middle, so the strait alone parts them there)
    const west = (x, y) => smax(smax(ellipse(x, y, 0.31, 0.5, 0.215, 0.37, 0.12), ellipse(x, y, 0.2, 0.28, 0.11, 0.08, -0.5), 0.04), ellipse(x, y, 0.21, 0.73, 0.11, 0.07, 0.6), 0.04);
    const east = (x, y) => {
      let d = smax(ellipse(x, y, 0.68, 0.52, 0.195, 0.34, -0.1), ellipse(x, y, 0.8, 0.26, 0.13, 0.065, -0.6), 0.04);
      return smin(d, -ellipse(x, y, 0.86, 0.47, 0.075, 0.12, 0.2), 0.03); // (the bay)
    };
    return {
      shelf: 0.01, beach: 0.005, rise: 0.05, relief: [0.5, 0.9],
      coast(fx, fy) {
        let d = Math.max(natural(n, fx, fy, 2, (x, y) => Math.max(west(x, y), east(x, y)), 0.09), islets(n, fx, fy, isles));
        const sx = 0.497 + 0.005 * Math.sin(fy * Math.PI * 4.5 + 2.2) + n.fbm(fy * 8, 3.3, 3) * 0.004;
        return Math.min(d, Math.abs(fx - sx) - 0.0065);
      },
      ground(fx, fy, u, v) {
        const base = rolling(n, u, v, 1.8, 3);
        return lerp(1.4 + base * 4 + n.ridged(u * 1.4 + 3, v * 1.4, 4) * 4 * smooth(0.45, 0.3, fx), 0.9 + base * 1.5, smooth(0.47, 0.53, fx)) + bumps(n, u, v) * 0.4;
      },
    };
  },

  // A ring of low, sandy land around a turquoise lagoon: thick in the west and south where
  // town is, broken into a chain of islets in the north-east where the lagoon opens to the sea,
  // with reefs all round. The highway hops in along a chain of keys from the west.
  lagoon: (n) => {
    const C = [0.6, 0.41];
    const keys = [[0.065, 0.5, 0.024], [0.145, 0.497, 0.022], [0.222, 0.503, 0.02]];
    const motus = scatter(77, 18, C, 0.34, 0.42, 0.014, [[0.15, 0.5, 0.13], [0.5, 0.5, 0.1]]);
    const gap = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    return {
      shelf: 0.045, beach: 0.012, rise: 0.05, deep: 0.6, relief: [0.6, 0.8],
      coast(fx, fy) {
        const x = fx + n.fbm(fx * 2.2 + 3, fy * 2.2, 4) * 0.035, y = fy + n.fbm(fx * 2.2, fy * 2.2 + 3, 4) * 0.035;
        const dx = x - C[0], dy = (y - C[1]) / 0.88;
        const r = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
        const wob = n.fbm(Math.cos(ang) * 1.6 + 5, Math.sin(ang) * 1.6 + 5, 3) * 0.07;
        // (the lagoon comes right up to town; the ring is widest beyond it, to the south-west)
        const inner = 0.122 + wob * 0.2, outer = inner + 0.16 + 0.07 * Math.max(0, Math.cos(ang - 2.4)) + wob * 0.5;
        let d = Math.min(outer - r, r - inner);
        // broken into islets in the north-east, with the main pass into the lagoon there
        const ne = smooth(1.0, 0.35, gap(ang, -0.75)) * smooth(0, 0.012, d);
        d -= ne * (0.012 + 0.012 * Math.abs(Math.sin(ang * 16 + n.fbm(r * 9, 1, 2) * 3)));
        d = Math.min(d, gap(ang, -0.75) * r - 0.018, gap(ang, 0.7) * r - 0.006);
        d += n.fbm(fx * 9, fy * 9, 3) * 0.008;
        return Math.max(d, islets(n, fx, fy, keys), islets(n, fx, fy, motus));
      },
      ground: (fx, fy, u, v) => 0.4 + rolling(n, u, v, 2.2, 7) * 1.3 + bumps(n, u, v) * 0.25,
      // (the lagoon is shallow, with a few deeper holes)
      carve: (fx, fy, u, v, h, sea) => (Math.hypot(fx - C[0], (fy - C[1]) / 0.88) < 0.19 ? Math.max(h, sea - 1.25 + n.fbm(u * 3 + 9, v * 3, 3) * 0.6) : h),
    };
  },

  // A rounded triangle of an island with a volcano towering over its north-east corner,
  // ridged and gullied down to the sea; its ash made the lowlands fertile. A stream comes down
  // from the hills north of town.
  volcano: (n) => {
    const V = [0.665, 0.335], R = 0.215;
    const stream = { to: 'south', at: 8, src: -170, amp: 0.06, freq: 1.8, phase: 2, valley: 0.12 };
    const isles = [[0.93, 0.13, 0.016], [0.08, 0.42, 0.018], [0.3, 0.93, 0.016], [0.88, 0.62, 0.012]];
    const shape = (x, y) => {
      let d = ellipse(x, y, 0.53, 0.5, 0.31, 0.29, 0.25);
      d = smax(d, ellipse(x, y, 0.26, 0.66, 0.16, 0.13, 0.6), 0.06);
      d = smax(d, ellipse(x, y, 0.64, 0.76, 0.15, 0.12, -0.3), 0.06);
      return smax(d, ellipse(x, y, V[0], V[1], 0.26, 0.25), 0.06);
    };
    return {
      shelf: 0.008, beach: 0.004, rise: 0.04, relief: [0.5, 1],
      coast: (fx, fy) => Math.max(natural(n, fx, fy, 4, shape, 0.1), islets(n, fx, fy, isles)),
      ground(fx, fy, u, v) {
        let h = 1 + rolling(n, u, v, 1.6, 4) * 2.4 + bumps(n, u, v) * 0.4;
        const r = Math.hypot(fx - V[0], fy - V[1]);
        if (r < R) {
          const t = 1 - r / R, ang = Math.atan2(fy - V[1], fx - V[0]);
          // ridges and gullies running down from the summit, deeper toward the foot
          const ribs = 1 + 0.16 * Math.sin(ang * 13 + n.fbm(r * 12, ang, 2) * 4) * smooth(0, 0.7, 1 - t);
          h += 27 * Math.pow(t, 1.5) * ribs - 10 * smooth(0.045, 0.018, r); // (and the crater)
        }
        return h;
      },
      carve: (fx, fy, u, v, h, sea) => carveRiver(n, stream, u, v, h, sea),
    };
  },

  // A rugged, snowy island of cliffs and peaks, its coast broken by skerries and cut by deep,
  // winding fjords; town sits at the head of the one from the east
  frost: (n) => {
    const fjords = [
      [line([[0.99, 0.44], [0.86, 0.47], [0.76, 0.445], [0.66, 0.47], [0.59, 0.49], [0.512, 0.503]]), 0.02, 0.008],
      [line([[0.01, 0.29], [0.13, 0.33], [0.22, 0.3], [0.3, 0.33], [0.36, 0.31]]), 0.017, 0.006],
      [line([[0.01, 0.74], [0.12, 0.7], [0.2, 0.71], [0.28, 0.66], [0.37, 0.64]]), 0.017, 0.006],
      [line([[0.71, 0.01], [0.69, 0.12], [0.73, 0.2], [0.69, 0.27], [0.66, 0.32]]), 0.016, 0.006],
      [line([[0.58, 0.99], [0.61, 0.87], [0.56, 0.79], [0.59, 0.7]]), 0.016, 0.006],
      [line([[0.19, 0.99], [0.25, 0.89], [0.23, 0.8], [0.27, 0.75]]), 0.014, 0.005],
      [line([[0.99, 0.79], [0.88, 0.76], [0.79, 0.68]]), 0.014, 0.005],
      [line([[0.3, 0.01], [0.33, 0.11], [0.3, 0.18]]), 0.013, 0.005],
    ];
    const skerries = scatter(55, 60, [0.5, 0.5], 0.37, 0.47, 0.009, WAY_IN);
    const shape = (x, y) => smax(smax(ellipse(x, y, 0.5, 0.5, 0.38, 0.36, 0.2), ellipse(x, y, 0.3, 0.7, 0.18, 0.13, 0.5), 0.05), ellipse(x, y, 0.7, 0.27, 0.17, 0.12, -0.3), 0.05);
    return {
      shelf: 0.004, beach: 0.0015, rise: 0.014, relief: [0.4, 0.9],
      coast(fx, fy) {
        let d = natural(n, fx, fy, 5, shape, 0.12, 2.2);
        const [wx, wy] = wander(n, fx, fy, 0.022, 5);
        for (const [at, w0, w1] of fjords) { const [dist, t] = at(wx, wy); d = Math.min(d, dist - lerp(w0, w1, t)); }
        return Math.max(d, islets(n, fx, fy, skerries));
      },
      ground: (fx, fy, u, v) => 3 + n.ridged(u * 1.2 + 4, v * 1.2 + 4, 5) * 14 + n.fbm(u * 1.6, v * 1.6, 4) * 3,
    };
  },

  // A desert island of stepped mesas and buttes behind red sea cliffs, sea stacks off them,
  // and a canyon river winding down through town to a bay on the south coast
  redrock: (n) => {
    const canyon = { to: 'south', at: 8, src: -330, amp: 0.1, freq: 1.3, phase: 1, valley: 0.07 };
    const stacks = scatter(31, 26, [0.5, 0.52], 0.38, 0.46, 0.008, WAY_IN);
    const shape = (x, y) => {
      let d = smax(ellipse(x, y, 0.5, 0.5, 0.39, 0.33, -0.3), ellipse(x, y, 0.36, 0.73, 0.17, 0.13, 0.4), 0.05);
      d = smax(d, ellipse(x, y, 0.75, 0.3, 0.13, 0.1, 0.8), 0.05);
      return smin(d, -ellipse(x, y, 0.43, 0.88, 0.07, 0.05), 0.03); // (the bay at the canyon's mouth)
    };
    return {
      shelf: 0.006, beach: 0.002, rise: 0.015, relief: [0.55, 1],
      coast: (fx, fy) => Math.max(natural(n, fx, fy, 6, shape, 0.12, 1.3), islets(n, fx, fy, stacks)),
      ground(fx, fy, u, v) {
        const m = rolling(n, u, v, 1.4, 6);
        const step = Math.floor(m * 4) / 4, frac = m * 4 - Math.floor(m * 4);
        return 1.2 + (step + smooth(0.6, 1, frac) * 0.25) * 9 + bumps(n, u, v) * 0.3;
      },
      carve: (fx, fy, u, v, h, sea) => carveRiver(n, canyon, u, v, h, sea),
    };
  },

  // Islands of every size scattered across the sea, the home island in the middle
  thousand: (n) => ({
    shelf: 0.01, beach: 0.004, rise: 0.035, deep: 1.6, relief: [0.5, 0.9],
    coast(fx, fy, u, v) {
      const dc = Math.hypot(fx - 0.5, fy - 0.5);
      const field = n.fbm(u * 0.8 + 3, v * 0.8 + 3, 5) + n.fbm(u * 2.4 + 9, v * 2.4 + 1, 3) * 0.2;
      // (the home island in the middle; the islands thin out toward the open sea at the edges)
      return (field + 0.36 * smooth(0.13, 0.03, dc) + 0.05 - 0.4 * smooth(0.33, 0.48, dc)) * 0.08;
    },
    ground: (fx, fy, u, v) => 1 + rolling(n, u, v, 1.7, 8) * 3.6 + bumps(n, u, v) * 0.5,
  }),

  // A long island lying east to west: wooded hills along its north shore, cut by harbour
  // bays; flat land sloping south to the beaches, a barrier island beyond them with a lagoon
  // behind; and two forks at its east end with a bay between them
  longkey: (n) => {
    const mid = (fx) => 0.5 + 0.03 * Math.sin((fx - 0.5) * Math.PI * 2.2);
    const half = (fx) => (0.105 + 0.028 * Math.sin(fx * Math.PI * 3.1 + 0.7)) * smooth(0, 0.11, fx - 0.045) * smooth(0, 0.08, 0.85 - fx);
    const gaps = [0.3, 0.46, 0.6, 0.72];
    const isles = [[0.3, 0.3, 0.016], [0.6, 0.27, 0.02], [0.2, 0.75, 0.014], [0.5, 0.78, 0.016]];
    const shape = (x, y) => {
      let d = half(x) - Math.abs(y - mid(x));
      // the forks: the north one longer
      d = smax(d, ellipse(x, y, 0.84, 0.43, 0.13, 0.03, -0.25), 0.03);
      d = smax(d, ellipse(x, y, 0.82, 0.585, 0.1, 0.035, 0.2), 0.03);
      // harbour bays along the north shore
      for (const [bx, rx, ry, a] of [[0.23, 0.022, 0.04, 0.3], [0.4, 0.016, 0.03, -0.2], [0.57, 0.03, 0.045, 0.4], [0.7, 0.014, 0.025, 0]]) d = smin(d, -ellipse(x, y, bx, mid(bx) - half(bx) + 0.012, rx, ry, a), 0.015);
      return d;
    };
    return {
      shelf: 0.02, beach: 0.008, rise: 0.03, relief: [0.5, 0.9],
      coast(fx, fy) {
        let d = natural(n, fx, fy, 8, shape, 0.06, 0.8);
        // the barrier island, broken by inlets
        const by = mid(fx) + half(fx) + 0.034;
        let bar = Math.min(0.007 - Math.abs(fy - by + n.fbm(fx * 9, 2, 2) * 0.006), fx - 0.15, 0.78 - fx);
        for (const g of gaps) bar = Math.min(bar, Math.abs(fx - g) - 0.008);
        return Math.max(d, bar, islets(n, fx, fy, isles));
      },
      ground(fx, fy, u, v) {
        const across = (fy - mid(fx)) / Math.max(0.03, half(fx)); // -1 at the north shore, 1 at the south
        return 0.7 + rolling(n, u, v, 1.6, 9) * 1.2 + smooth(0.4, -0.6, across) * (2 + rolling(n, u, v, 2.5, 2) * 5);
      },
    };
  },

  // An island with a big lake north of town and many small ones about it in the woods
  lakeisle: (n) => {
    const big = [0.47, 0.365, 0.17, 0.1, -0.15];
    const shape = (x, y) => smax(smax(ellipse(x, y, 0.5, 0.5, 0.37, 0.35, -0.25), ellipse(x, y, 0.25, 0.32, 0.15, 0.11, 0.5), 0.05), ellipse(x, y, 0.72, 0.72, 0.15, 0.12, -0.4), 0.05);
    return {
      shelf: 0.01, beach: 0.004, rise: 0.05, relief: [0.5, 0.85],
      coast: (fx, fy) => natural(n, fx, fy, 9, shape, 0.12, 1.2),
      ground: (fx, fy, u, v) => 1.5 + rolling(n, u, v, 1.6, 10) * 3 + bumps(n, u, v) * 0.5,
      carve(fx, fy, u, v, h, sea) {
        // (with a bay of it reaching down into town)
        h = carveLake(h, smax(ellipse(fx, fy, ...big), ellipse(fx, fy, 0.515, 0.468, 0.035, 0.022, 0.4), 0.015) + n.fbm(u * 2 + 5, v * 2 + 5, 3) * 0.014, sea);
        const lakes = n.fbm(u * 1.1 + 100, v * 1.1 + 100, 3);
        const dc = Math.hypot(fx - 0.5, fy - 0.5);
        return Math.min(h, lerp(h, sea - 1.5, smooth(-0.13, -0.28, lakes) * smooth(0.06, 0.12, dc)));
      },
    };
  },

  // A low, flat island built up by a river: it rises in the north and splits, again and again,
  // into channels that fan out to the south coast, where the land frays into mud flats
  deltaisle: (n) => {
    const A = [0.43, 0.3], B = [0.495, 0.58];
    const channels = [
      [line([[0.41, 0.1], [0.4, 0.2], A]), 0.007, 0.009],
      [line([A, [0.36, 0.42], [0.3, 0.55], [0.25, 0.7], [0.19, 0.84], [0.15, 0.98]]), 0.008, 0.012],
      [line([A, [0.47, 0.41], [0.497, 0.5], B]), 0.008, 0.009],
      [line([B, [0.43, 0.7], [0.4, 0.83], [0.37, 0.98]]), 0.007, 0.011],
      [line([B, [0.56, 0.68], [0.6, 0.82], [0.62, 0.98]]), 0.007, 0.011],
      [line([[0.425, 0.26], [0.56, 0.34], [0.67, 0.45], [0.74, 0.6], [0.78, 0.77], [0.81, 0.98]]), 0.007, 0.012],
      [line([[0.3, 0.55], [0.2, 0.58], [0.1, 0.62], [0.01, 0.63]]), 0.004, 0.008],
      [line([[0.74, 0.6], [0.84, 0.58], [0.99, 0.55]]), 0.004, 0.008],
    ];
    // (each mouth builds out a lobe of land)
    const lobes = [[0.17, 0.84], [0.39, 0.86], [0.61, 0.85], [0.8, 0.82]];
    const shape = (x, y) => {
      const dx = Math.abs(x - 0.5) / 0.4, dy = Math.abs(y - 0.46) / 0.36;
      let d = (1 - Math.pow(dx ** 2.6 + dy ** 2.6, 1 / 2.6)) * 0.38;
      for (const [cx, cy] of lobes) d = smax(d, ellipse(x, y, cx, cy, 0.08, 0.07), 0.03);
      return d;
    };
    return {
      shelf: 0.025, beach: 0.006, rise: 0.05, deep: 0.7, relief: [1, 1],
      coast: (fx, fy) => natural(n, fx, fy, 10, shape, 0.06, 1 + smooth(0.62, 0.85, fy) * 2),
      ground: (fx, fy, u, v) => 0.55 + rolling(n, u, v, 1.6, 11) * 0.9 + bumps(n, u, v) * 0.25 - smooth(0.6, 0.9, fy) * 0.35,
      carve(fx, fy, u, v, h, sea) {
        const [wx, wy] = wander(n, fx, fy, 0.016, 10);
        for (const [at, w0, w1] of channels) {
          const [d, t] = at(wx, wy);
          if (d < 0.03) h = Math.min(h, lerp(sea - 1, h, smooth(lerp(w0, w1, t) * 0.5, lerp(w0, w1, t) * 1.6, d)));
        }
        return h;
      },
    };
  },

  // Heather hills and ridges with a broken, rocky west coast, cut by long lochs that wind
  // from the south-west to the north-east; a sea loch reaches up to town
  highland: (n) => {
    const sealoch = line([[0.08, 0.83], [0.17, 0.75], [0.26, 0.71], [0.35, 0.62], [0.43, 0.57], [0.48, 0.535], [0.528, 0.505]]);
    const lochs = [
      line([[0.6, 0.38], [0.66, 0.33], [0.71, 0.3], [0.78, 0.24]]),
      line([[0.23, 0.36], [0.29, 0.31], [0.36, 0.25]]),
      line([[0.62, 0.74], [0.67, 0.69], [0.72, 0.65], [0.79, 0.62]]),
      line([[0.79, 0.53], [0.84, 0.48], [0.88, 0.45]]),
      line([[0.46, 0.84], [0.51, 0.8], [0.57, 0.77]]),
    ];
    const isles = scatter(23, 24, [0.5, 0.5], 0.38, 0.46, 0.012, WAY_IN).filter(([x]) => x < 0.5);
    const shape = (x, y) => smax(smax(ellipse(x, y, 0.52, 0.5, 0.37, 0.36, 0.5), ellipse(x, y, 0.28, 0.27, 0.13, 0.1, -0.5), 0.05), ellipse(x, y, 0.25, 0.72, 0.13, 0.08, 0.7), 0.05);
    return {
      shelf: 0.006, beach: 0.003, rise: 0.025, relief: [0.42, 0.9],
      coast(fx, fy) {
        const d = natural(n, fx, fy, 11, shape, 0.12, 1 + smooth(0.5, 0.2, fx) * 1.8);
        const [wx, wy] = wander(n, fx, fy, 0.02, 11);
        const [dist, t] = sealoch(wx, wy);
        return Math.max(Math.min(d, dist - lerp(0.02, 0.007, t)), islets(n, fx, fy, isles));
      },
      ground: (fx, fy, u, v) => 1.8 + rolling(n, u, v, 1.5, 12) * 4 + n.ridged(u * 1.3 + 8, v * 1.3 + 2, 5) * 4.5,
      carve(fx, fy, u, v, h, sea) {
        const [wx, wy] = wander(n, fx, fy, 0.02, 12);
        for (const at of lochs) { const [d, t] = at(wx, wy); h = carveLake(h, (0.008 + 0.01 * rolling(n, t * 6, d * 9, 1, 4)) * Math.sqrt(Math.sin(Math.PI * t)) - d, sea); }
        return h;
      },
    };
  },

  // A broad island of open, flat prairie filling most of the map, with a few big bays; one
  // river meanders down through town
  grand: (n) => {
    const river = { to: 'south', at: 8, src: -380, amp: 0.1, freq: 1.7, phase: 0.3, valley: 0.14 };
    const shape = (x, y) => {
      const dx = Math.abs(x - 0.5) / 0.44, dy = Math.abs(y - 0.5) / 0.43;
      let d = (1 - Math.cbrt(dx ** 3 + dy ** 3)) * 0.44;
      for (const [cx, cy, rx, ry] of [[0.08, 0.3, 0.09, 0.07], [0.9, 0.66, 0.1, 0.08], [0.66, 0.06, 0.08, 0.06], [0.3, 0.95, 0.09, 0.07]]) d = smin(d, -ellipse(x, y, cx, cy, rx, ry), 0.03);
      return d;
    };
    return {
      shelf: 0.012, beach: 0.006, rise: 0.06, relief: [0.75, 0.9],
      coast: (fx, fy) => natural(n, fx, fy, 12, shape, 0.08),
      ground: (fx, fy, u, v) => 1.1 + rolling(n, u, v, 1.6, 13) * 1.2 + bumps(n, u, v) * 0.3,
      carve: (fx, fy, u, v, h, sea) => carveRiver(n, river, u, v, h, sea),
    };
  },

  // Snowy peaks in two great massifs either side of a broad valley that winds down the
  // island; town is in the valley by its river, and the highway comes over a pass in the
  // western range
  peaks: (n) => {
    const river = { to: 'south', at: 8, src: -350, amp: 0.05, freq: 1.4, phase: 2.2, valley: 0.22 };
    const isles = [[0.08, 0.2, 0.016], [0.92, 0.8, 0.018], [0.5, 0.05, 0.012]];
    const shape = (x, y) => smax(ellipse(x, y, 0.5, 0.5, 0.38, 0.41, 0.1), ellipse(x, y, 0.7, 0.75, 0.16, 0.12, 0.6), 0.05);
    return {
      shelf: 0.006, beach: 0.003, rise: 0.02, relief: [0.65, 1],
      coast: (fx, fy) => Math.max(natural(n, fx, fy, 13, shape, 0.1, 1.4), islets(n, fx, fy, isles)),
      ground(fx, fy, u, v) {
        // (the valley winds down the middle and narrows and widens as it goes)
        const free = smooth(0.03, 0.12, Math.abs(fy - 0.5));
        const valley = 0.5 + free * (0.035 * Math.sin(fy * Math.PI * 2.4 + 0.5) + n.fbm(fy * 5, 7.7, 3) * 0.04);
        const across = Math.abs(fx - valley) - free * n.fbm(fy * 7, 3.3, 3) * 0.04 + n.fbm(fx * 8, fy * 8, 3) * 0.035;
        const wall = Math.pow(smooth(0.05, 0.26, across), 1.3);
        // peaks gathered into massifs, with lower foothills between them
        const massif = 0.35 + 0.65 * smooth(-0.25, 0.3, n.fbm(fx * 3.5 + 4, fy * 3.5 + 1, 4));
        // (a pass over the western range, for the highway)
        const pass = fx < 0.5 ? 1 - 0.6 * smooth(0.06 + n.fbm(fx * 9, 1.1, 2) * 0.03, 0, Math.abs(fy - 0.5)) : 1;
        return 1.4 + rolling(n, u, v, 1.6, 14) + wall * 25 * massif * (0.4 + n.ridged(u * 1.2 + 2, v * 1.2 + 2, 6) * 0.95) * pass;
      },
      carve: (fx, fy, u, v, h, sea) => carveRiver(n, river, u, v, h, sea),
    };
  },
};

// The ground (or the sea floor) of an island map: height(x, y, sea) at heightmap corner
// (x, y), and how much of the hills' height to keep (see generateMap)
export function makeIsland(map, noise) {
  const K = ISLANDS[map.island](noise);
  const shelf = K.shelf ?? 0.01, beach = K.beach ?? 0.005, rise = K.rise ?? 0.04, drop = 0.05 / (K.deep ?? 1);
  const height = (x, y, sea) => {
    const fx = x / N, fy = y / N;
    const u = 0.5 + (x - MID) / FEATURE, v = 0.5 + (y - MID) / FEATURE;
    // (the open sea all round the map's edge)
    const d = Math.min(K.coast(fx, fy, u, v), Math.min(fx, fy, 1 - fx, 1 - fy) - MARGIN);
    let h;
    if (d < 0) {
      // the sea floor: shallow off the coast, then the deep sea
      const off = -d;
      h = sea - SHORE - 0.65 * smooth(0, shelf, off) - (DEEP - 1) * smooth(shelf, shelf + drop, off) + noise.fbm(u * 2 + 50, v * 2 + 50, 3) * 0.25 * smooth(0, 0.02, off);
    } else {
      // the beach, then the land rising to its full height inland
      h = sea - SHORE + (SHORE + 0.4) * smooth(0, beach, d) + K.ground(fx, fy, u, v, d) * smooth(beach * 0.4, beach + rise, d);
    }
    if (K.carve) h = K.carve(fx, fy, u, v, h, sea);
    return Math.min(h, sea + 36);
  };
  return { height, relief: K.relief || [0.5, 0.9] };
}
