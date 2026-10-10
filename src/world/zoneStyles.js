// What grown (zoned) buildings look like. Every zone has a few styles; which one a building
// gets comes from its seed, so it keeps its style as it levels up and when the city is loaded
// again. The map's theme makes some styles more common than others (pitched roofs in Europe,
// hipped roofs and front porches in North America...).
//
// A building is a list of parts in its own frame: x along the road (−w/2..w/2), z toward the
// road (the front of the lot is z = +d/2), y up from the ground. Pools: body (walls with
// windows), plain (no windows), roof (a gable, ridge along x; `turn` puts the ridge along z,
// gable end to the street), hip (a pyramid roof), cyl, dome.
import { makeRng } from '../core/rng.js';

export const FLOOR = 0.38; // height of one storey in world units (~3 m)

const BRICK = ['#9c5a43', '#a8654a', '#8e4f3b', '#b07457', '#7f4a3a'];
const MODERN = ['#f2f0eb', '#e6e3dc', '#d4d0c8', '#3f4349', '#c9c4b8'];
const WOOD = ['#a8835a', '#8f6b47', '#b8946a'];
const CONCRETE = ['#b9b5ad', '#a7a49b', '#c4c0b6', '#9fa3a6'];
const PASTEL = ['#d9c6a8', '#c6d3d9', '#d8b9ae', '#c8d4bd', '#e2d6b8'];
const GLASS = ['#7d9cc4', '#6f8fb3', '#8aa7c9', '#a0b6cf', '#5f7f9f', '#9db8c8'];
const SIGNS = ['#e05a47', '#3f8fd0', '#e7b33b', '#46a35c', '#c05ac0', '#f08a3c'];
const CARS = ['#c8352b', '#2f5fa8', '#e8e6e0', '#2b2d31', '#8a8f96', '#d9b23a', '#3d7a4a'];
const SHOPFRONT = ['#8fb4cf', '#a9c6d6', '#c9d6dc'];
const SLATE = '#5a5f66', TAR = '#55585e', TRIM = '#efe9dd', PLANT = '#8b8f96', HEDGE = '#4f7f3a', GARDEN = '#6f9f4e';

// [name, weight in Europe, weight in North America, draw(c)]
const STYLES = {
  res_low: [
    ['Cottage', 1, 0.8, ({ W, D, r, lvl, H, wall, roofC, B, S, G }) => {
      const w = W * r.range(0.6, 0.78), d = D * r.range(0.38, 0.5);
      B(0, D * 0.12, w, d, H, wall);
      G(0, D * 0.12, w + 0.08, d + 0.1, 0.32, H, roofC);
      if (lvl >= 2) S(W * 0.32, -D * 0.2, 0.25, 0.25, 0.2, '#7a7f86'); // shed/garage
    }],
    ['Front-gable house', 0.8, 1.3, ({ W, D, r, lvl, H, wall, roofC, B, S, G }) => {
      const w = Math.min(W * 0.62, 0.62 + (W - 1) * 0.25), d = D * r.range(0.42, 0.52);
      const x = W > 1 ? -W * 0.14 : 0, z = D * 0.06;
      B(x, z, w, d, H, wall);
      G(x, z, w + 0.08, d + 0.1, 0.4, H, roofC, true);
      // a porch across the front: deck, two posts and a little roof
      const pz = z + d / 2 + 0.1;
      S(x, pz, w * 0.85, 0.2, 0.05, '#a58b6b');
      for (const s of [-1, 1]) S(x + s * w * 0.38, pz + 0.07, 0.03, 0.03, FLOOR * 0.8, TRIM);
      S(x, pz, w * 0.9, 0.22, 0.03, roofC, FLOOR * 0.8);
      if (W > 1 && lvl >= 2) {
        // a garage beside it, with its driveway out to the street
        const gd = d * 0.7, gz = z - 0.05, front = gz + gd / 2;
        S(W * 0.3, gz, W * 0.28, gd, FLOOR * 0.75, wall);
        S(W * 0.3, gz, W * 0.3, gd + 0.04, 0.04, TAR, FLOOR * 0.75);
        S(W * 0.3, (front + D / 2) / 2, W * 0.2, D / 2 - front, 0.03, '#a9a69e');
      }
    }],
    ['Bungalow', 0.7, 1.3, ({ W, D, r, H, wall, roofC, B, S, Hp }) => {
      const w = W * r.range(0.7, 0.84), d = D * r.range(0.4, 0.5), z = D * 0.1;
      B(0, z, w, d, H, wall);
      Hp(0, z, w + 0.14, d + 0.14, 0.3, H, roofC);
      S(w * 0.28, z - d * 0.15, 0.1, 0.1, 0.42, '#8d6e5a', H); // chimney
      S(0, z + d / 2 + 0.02, 0.14, 0.04, 0.24, '#6b4f3a'); // front door
    }],
    ['Modern house', 0.9, 1, ({ W, D, r, lvl, fl, H, B, S }) => {
      const c1 = r.pick(MODERN), c2 = r.pick(WOOD), z = D * 0.08;
      B(-W * 0.1, z, W * 0.5, D * 0.4, H, c1);
      S(-W * 0.1, z, W * 0.54, D * 0.44, 0.04, TAR, H);
      // the second volume is a storey taller (or lower) than the first
      const h2 = fl === 1 ? H + FLOOR * 0.55 : H - FLOOR * 0.5;
      B(W * 0.2, z - D * 0.06, W * 0.34, D * 0.32, h2, c2);
      S(W * 0.2, z - D * 0.06, W * 0.37, D * 0.35, 0.04, TAR, h2);
      if (lvl >= 3 && W > 1) S(-W * 0.2, -D * 0.3, W * 0.34, D * 0.16, 0.03, '#4fb3e0'); // swimming pool
    }],
    ['Farmhouse', 1.2, 0.8, ({ W, D, r, H, wall, roofC, B, G }) => {
      const w = W * r.range(0.58, 0.72), d = D * 0.3, x = -W * 0.06, z = D * 0.16;
      B(x, z, w, d, H, wall);
      G(x, z, w + 0.06, d + 0.08, 0.3, H, roofC);
      // a wing at the back, its own gable at right angles
      const ww = Math.max(0.3, W * 0.24), wd = D * 0.34;
      const wx = x + w / 2 - ww / 2, wz = z - d / 2 - wd / 2 + 0.04;
      B(wx, wz, ww, wd, H, wall);
      G(wx, wz, ww + 0.06, wd + 0.04, 0.3, H, roofC, true);
    }],
  ],
  res_row: [
    ['Terrace', 1, 1, ({ W, D, h, wall, roofC, B, G }) => {
      const w = W * 0.96, d = D * 0.55;
      B(0, D * 0.18, w, d, h, wall);
      G(0, D * 0.18, w + 0.02, d + 0.08, 0.3, h, roofC);
    }],
    ['Brick townhouse', 0.9, 1.2, ({ W, D, r, h, B, S }) => {
      const w = W * 0.96, d = D * 0.55, z = D * 0.18;
      B(0, z, w, d, h, r.pick(BRICK));
      S(0, z, w + 0.02, d + 0.03, 0.07, TRIM, h); // cornice
      S(0, z + d / 2 + 0.08, W * 0.3, 0.16, 0.07, '#c9c2b2'); // front steps
      S(W * 0.25, z - d * 0.2, 0.08, 0.14, 0.2, '#8d6e5a', h); // chimney
    }],
    ['Canal house', 1.3, 0.4, ({ W, D, r, fl, wall, roofC, B, G }) => {
      const hh = (fl + 0.3) * FLOOR, w = W * 0.92, d = D * 0.55, z = D * 0.18;
      B(0, z, w, d, hh, r.chance(0.5) ? r.pick(BRICK) : wall);
      G(0, z, w + 0.02, d + 0.04, 0.55, hh, roofC, true); // tall gable to the street
    }],
    ['Bay-window terrace', 1, 1, ({ W, D, h, wall, roofC, B, G }) => {
      const w = W * 0.96, d = D * 0.5, z = D * 0.14;
      B(0, z, w, d, h, wall);
      B(-W * 0.2, z + d / 2 + 0.08, W * 0.38, 0.16, h - FLOOR * 0.3, '#f1ece2');
      G(0, z, w + 0.02, d + 0.08, 0.3, h, roofC);
    }],
    ['Mansard terrace', 1.1, 0.7, ({ W, D, fl, wall, B, Hp }) => {
      const hh = Math.max(1, fl - 1) * FLOOR, w = W * 0.96, d = D * 0.55, z = D * 0.18;
      B(0, z, w, d, hh, wall);
      B(0, z, w * 0.9, d * 0.86, FLOOR * 0.8, SLATE, hh); // the top floor tucked into the roof
      Hp(0, z, w * 0.9, d * 0.86, 0.16, hh + FLOOR * 0.8, SLATE);
    }],
  ],
  res_med: [
    ['Apartment block', 1, 1, ({ W, D, r, fl, h, wall, roofC, pitched, B, S, G }) => {
      const w = W * r.range(0.72, 0.88), d = D * r.range(0.6, 0.78);
      B(0, D * 0.05, w, d, h, wall);
      if (pitched && fl <= 5) G(0, D * 0.05, w + 0.06, d + 0.06, 0.35, h, roofC);
      else S(w * 0.2, 0, w * 0.3, d * 0.3, 0.25, PLANT, h);
    }],
    ['Balcony block', 1, 1, ({ W, D, r, fl, h, wall, B, S }) => {
      const w = W * r.range(0.72, 0.86), d = D * r.range(0.55, 0.7), z = D * 0.05;
      B(0, z, w, d, h, wall);
      const rail = r.pick(['#e8e4dc', '#9aa3ab', '#c96f4a']);
      for (let f = 1; f < fl; f++) S(0, z + d / 2 + 0.07, w * 0.86, 0.14, 0.05, rail, f * FLOOR);
      S(0, z, w + 0.03, d + 0.03, 0.05, TAR, h);
      S(-w * 0.25, z - d * 0.1, w * 0.18, d * 0.22, 0.28, PLANT, h); // stair and lift house
    }],
    ['Courtyard block', 1.1, 0.8, ({ W, D, h, wall, roofC, pitched, B, S, G }) => {
      const ww = W * 0.3, d = D * 0.82, bd = D * 0.26;
      for (const s of [-1, 1]) {
        B(s * W * 0.32, 0, ww, d, h, wall);
        if (pitched) G(s * W * 0.32, 0, ww + 0.05, d + 0.04, 0.3, h, roofC, true);
      }
      B(0, -D * 0.28, W * 0.36, bd, h, wall);
      if (pitched) G(0, -D * 0.28, W * 0.36, bd + 0.05, 0.3, h, roofC);
      S(0, D * 0.08, W * 0.3, D * 0.4, 0.04, '#7fae55'); // the garden in the courtyard
    }],
    ['Stepped block', 0.9, 1, ({ W, D, r, h, wall, B, S }) => {
      const w = W * r.range(0.74, 0.86), z0 = D * 0.32, d0 = D * 0.3, low = Math.max(FLOOR, h - FLOOR * 2);
      B(0, z0, w, d0, low, wall);
      B(0, z0 - d0 / 2 - D * 0.18, w, D * 0.36, h, wall);
      S(0, z0, w * 0.9, d0 * 0.8, 0.08, GARDEN, low); // roof garden on the step
    }],
    ['Mansard apartments', 1.2, 0.6, ({ W, D, r, fl, wall, B, S, Hp }) => {
      const w = W * r.range(0.74, 0.88), d = D * r.range(0.58, 0.72), z = D * 0.05, hh = Math.max(1, fl - 1) * FLOOR;
      B(0, z, w, d, hh, wall);
      B(0, z, w * 0.92, d * 0.88, FLOOR * 0.85, SLATE, hh);
      Hp(0, z, w * 0.92, d * 0.88, 0.2, hh + FLOOR * 0.85, SLATE);
      for (const s of [-1, 1]) S(s * w * 0.3, z, 0.1, 0.16, 0.36, '#8d6e5a', hh + FLOOR * 0.6); // chimneys
    }],
  ],
  res_lowrent: [
    ['Housing block', 1, 1, ({ W, D, r, fl, h, roofC, pitched, B, S, G }) => {
      const w = W * r.range(0.72, 0.88), d = D * r.range(0.6, 0.78);
      B(0, D * 0.05, w, d, h, r.pick(['#b9ad98', '#a7a49b', '#c2b8a3']));
      if (pitched && fl <= 5) G(0, D * 0.05, w + 0.06, d + 0.06, 0.35, h, roofC);
      else S(w * 0.2, 0, w * 0.3, d * 0.3, 0.25, PLANT, h);
    }],
    ['Stair-tower slab', 1, 1, ({ W, D, r, h, B, S }) => {
      const w = W * 0.88, d = D * r.range(0.42, 0.52), z = D * 0.08;
      B(0, z, w, d, h, r.pick(CONCRETE));
      for (const s of [-1, 1]) B(s * w * 0.28, z + d / 2 + 0.09, 0.24, 0.18, h + FLOOR * 0.5, '#8f8c85');
      S(0, z, w + 0.03, d + 0.03, 0.05, TAR, h);
    }],
    ['Gallery block', 1, 1, ({ W, D, r, fl, h, B, S }) => {
      const w = W * 0.86, d = D * r.range(0.45, 0.55), z = D * 0.05;
      B(0, z, w, d, h, r.pick(PASTEL));
      // open access decks along the front, one per floor, and the stairs at the end
      for (let f = 1; f < fl; f++) S(0, z + d / 2 + 0.08, w, 0.16, 0.04, '#d6d2c8', f * FLOOR);
      B(w * 0.42, z + d / 2 + 0.12, 0.2, 0.24, h + FLOOR * 0.3, '#9a968e');
    }],
    ['Twin blocks', 1, 1, ({ W, D, r, h, B, S }) => {
      const d = D * r.range(0.5, 0.62), z = D * 0.05, col = r.pick([...CONCRETE, ...PASTEL]);
      const h2 = Math.max(FLOOR * 3, h - FLOOR * r.int(0, 2));
      B(-W * 0.24, z, W * 0.4, d, h, col);
      B(W * 0.24, z, W * 0.4, d, h2, col);
      S(-W * 0.24, z, W * 0.42, d + 0.02, 0.05, TAR, h);
      S(W * 0.24, z, W * 0.42, d + 0.02, 0.05, TAR, h2);
    }],
  ],
  res_high: [
    ['Apartment tower', 1, 1, ({ W, D, r, h, wall, B, S }) => {
      const w = W * r.range(0.72, 0.88), d = D * r.range(0.6, 0.78);
      B(0, 0, W * 0.92, D * 0.85, FLOOR * 1.4, '#b7b2a8');
      B(0, D * 0.05, w, d, h, wall);
      S(w * 0.2, 0, w * 0.3, d * 0.3, 0.25, PLANT, h);
    }],
    ['Wedding-cake tower', 1, 1, ({ W, D, r, h, wall, B, C }) => {
      const w = W * r.range(0.62, 0.74), d = D * r.range(0.5, 0.62);
      const h1 = h * 0.6, h2 = h * 0.28, h3 = h * 0.12;
      B(0, 0, W * 0.92, D * 0.85, FLOOR * 1.4, '#b7b2a8');
      B(0, 0, w, d, h1, wall);
      B(0, 0, w * 0.78, d * 0.78, h2, wall, h1);
      B(0, 0, w * 0.56, d * 0.56, h3, wall, h1 + h2);
      C(0, 0, 0.06, 0.6, '#c9ccd1', h);
    }],
    ['Twin towers', 1, 1, ({ W, D, r, h, wall, B, S }) => {
      const w = W * 0.36, d = D * r.range(0.45, 0.6);
      B(0, 0, W * 0.92, D * 0.85, FLOOR * 1.6, '#b7b2a8');
      B(-W * 0.23, 0, w, d, h, wall);
      B(W * 0.23, 0, w, d, h * r.range(0.7, 0.9), wall);
      S(0, 0, W * 0.12, 0.3, FLOOR, '#a9c3db', h * 0.55); // sky bridge
    }],
    ['Cross tower', 1, 1, ({ W, D, r, h, wall, B, S }) => {
      const w = W * r.range(0.66, 0.8), d = D * r.range(0.6, 0.72);
      B(0, 0, W * 0.92, D * 0.85, FLOOR * 1.4, '#b7b2a8');
      B(0, 0, w, d * 0.42, h, wall);
      B(0, 0, w * 0.42, d, h, wall);
      S(0, 0, w * 0.3, d * 0.3, 0.35, PLANT, h);
    }],
    ['Balcony tower', 1, 1, ({ W, D, r, fl, h, wall, B, S }) => {
      const w = W * r.range(0.6, 0.72), d = D * r.range(0.5, 0.62);
      B(0, 0, W * 0.92, D * 0.85, FLOOR * 1.4, '#b7b2a8');
      B(0, 0, w, d, h, wall);
      for (let f = 2; f < fl; f += 2) S(0, 0, w + 0.12, d + 0.12, 0.04, '#e8e4dc', f * FLOOR); // balconies all round
      S(0, 0, w * 0.5, d * 0.5, 0.3, PLANT, h);
    }],
  ],
  // High-rise apartments: skyscrapers on 3×3 to 4×4 lots, on a podium of lobbies and shops
  res_tower: [
    ['Slender tower', 1, 1, ({ W, D, r, fl, h, wall, B, S, C }) => {
      const w = W * r.range(0.5, 0.6), d = D * r.range(0.45, 0.55), z = -D * 0.05;
      B(0, D * 0.12, W * 0.9, D * 0.62, FLOOR * 2, '#c2bdb2');
      B(0, z, w, d, h, wall);
      for (let f = 3; f < fl; f += 3) S(0, z, w + 0.1, d + 0.1, 0.04, '#ece8df', f * FLOOR); // balconies
      S(0, z, w * 0.6, d * 0.6, 0.45, '#9a9da3', h); // plant room
      C(w * 0.25, z, 0.05, 0.9, '#c9ccd1', h + 0.45); // mast
    }],
    ['Stepped tower', 1, 1, ({ W, D, r, h, wall, B, S }) => {
      const w = W * r.range(0.62, 0.72), d = D * r.range(0.55, 0.65);
      B(0, 0, W * 0.92, D * 0.85, FLOOR * 1.6, '#b7b2a8');
      B(0, 0, w, d, h * 0.5, wall);
      B(-w * 0.08, -d * 0.06, w * 0.78, d * 0.78, h * 0.3, wall, h * 0.5);
      B(-w * 0.14, -d * 0.1, w * 0.54, d * 0.54, h * 0.2, wall, h * 0.8);
      S(w * 0.3, d * 0.3, w * 0.3, d * 0.3, 0.12, GARDEN, h * 0.5); // terraces
      S(w * 0.2, d * 0.22, w * 0.22, d * 0.22, 0.12, GARDEN, h * 0.8);
    }],
    ['Twin residential towers', 1, 1, ({ W, D, r, h, wall, B, S }) => {
      const w = W * 0.34, d = D * r.range(0.42, 0.52), z = -D * 0.04;
      B(0, D * 0.05, W * 0.92, D * 0.8, FLOOR * 2, '#bdb8ad');
      B(-W * 0.24, z, w, d, h, wall);
      B(W * 0.24, z, w, d, h * r.range(0.72, 0.9), wall);
      S(0, z, W * 0.16, 0.34, FLOOR * 1.2, '#a9c3db', h * 0.6); // sky bridge
      S(-W * 0.24, z, w * 0.5, d * 0.5, 0.35, PLANT, h);
    }],
    ['Glass condo tower', 0.9, 1.2, ({ W, D, r, fl, h, B, S }) => {
      const glass = r.pick(GLASS), frame = r.pick(['#e9e6df', '#d8d4cc', '#3f4349']);
      const w = W * r.range(0.55, 0.66), d = D * r.range(0.5, 0.6);
      B(0, D * 0.1, W * 0.9, D * 0.7, FLOOR * 1.8, '#cfc9bd');
      B(0, 0, w, d, h, glass);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) S((sx * w) / 2, (sz * d) / 2, 0.08, 0.08, h + 0.1, frame); // corner columns
      for (let f = 4; f < fl; f += 4) S(0, 0, w + 0.04, d + 0.04, 0.06, frame, f * FLOOR);
      S(0, 0, w + 0.06, d + 0.06, 0.12, frame, h);
    }],
    ['Garden-roof tower', 1.1, 0.9, ({ W, D, r, h, wall, B, S, C, Dm }) => {
      const w = W * r.range(0.5, 0.6), d = D * r.range(0.42, 0.52), top = FLOOR * 2.4;
      B(0, D * 0.15, W * 0.92, D * 0.6, top, wall);
      S(0, D * 0.15, W * 0.92, D * 0.6, 0.06, GARDEN, top); // green roof on the podium
      for (const x of [W * 0.25, W * 0.36]) { C(x, D * 0.3, 0.06, 0.25, '#6b4f36', top); Dm(x, D * 0.3, 0.42, 0.32, '#4e8a35', top + 0.2); }
      B(-W * 0.12, -D * 0.18, w, d, h, wall);
      S(-W * 0.12, -D * 0.18, w * 0.7, d * 0.7, 0.1, GARDEN, h); // roof garden
      S(-W * 0.12, -D * 0.18, w + 0.06, d + 0.06, 0.08, '#e8e4dc', h - 0.08);
    }],
  ],
  res_mixed: [
    ['Shop & flats', 1, 1, ({ W, D, r, fl, wall, B, S }) => {
      const w = W * 0.9, d = D * 0.75;
      B(0, D * 0.1, w, d, FLOOR * 1.1, '#8fb4cf');
      B(0, D * 0.05, w * 0.92, d * 0.9, (fl - 1) * FLOOR, wall, FLOOR * 1.1);
      S(0, D * 0.1 + d / 2 + 0.05, w * 0.95, 0.12, 0.06, r.pick(['#d0583f', '#3f8fd0', '#41a35b']), FLOOR * 0.9);
    }],
    ['Corner shop & flats', 1, 1, ({ W, D, r, fl, roofC, B, S, Hp }) => {
      const w = W * 0.88, d = D * 0.7, z = D * 0.1, up = (fl - 1) * FLOOR, g = FLOOR * 1.15;
      B(0, z, w, d, g, r.pick(SHOPFRONT));
      B(0, z, w, d, up, r.pick(BRICK), g);
      S(0, z, w + 0.04, d + 0.04, 0.05, TRIM, g); // band between the shop and the flats
      Hp(0, z, w + 0.04, d + 0.04, 0.35, g + up, roofC);
      S(0, z + d / 2 + 0.06, w * 0.6, 0.12, 0.05, r.pick(SIGNS), FLOOR * 0.9);
    }],
    ['Arcade', 1, 0.8, ({ W, D, fl, wall, B, S }) => {
      const w = W * 0.9, d = D * 0.72, z = D * 0.08, g = FLOOR * 1.1, up = (fl - 1) * FLOOR;
      B(0, z - 0.1, w, d - 0.2, g, '#8fb4cf'); // shopfronts set back behind the arcade
      for (let k = 0; k < 4; k++) S(-w / 2 + 0.05 + (k * (w - 0.1)) / 3, z + d / 2 - 0.05, 0.07, 0.07, g, TRIM);
      B(0, z, w, d, up, wall, g);
      S(0, z, w + 0.03, d + 0.03, 0.06, TRIM, g + up);
    }],
    ['Gabled shophouses', 1.2, 0.8, ({ W, D, r, fl, theme, roofC, B, S, G }) => {
      const w = W * 0.9, d = D * 0.7, z = D * 0.1, g = FLOOR * 1.1, up = (fl - 1) * FLOOR;
      B(0, z, w, d, g, r.pick(SHOPFRONT));
      const n = W > 1 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const x = (k - (n - 1) / 2) * (w / n);
        B(x, z, w / n - 0.02, d, up, r.pick(theme.palette), g);
        G(x, z, w / n, d + 0.04, 0.45, g + up, roofC, true);
      }
      S(0, z + d / 2 + 0.06, w * 0.95, 0.12, 0.05, r.pick(SIGNS), FLOOR * 0.9);
    }],
  ],
  com_low: [
    ['Corner shop', 1, 1, ({ W, D, r, fl, B, S }) => {
      const w = W * 0.86, d = D * 0.6, top = fl * FLOOR + 0.1;
      B(0, D * 0.15, w, d, top, r.pick(['#d9d2c4', '#c3d3e0', '#e2cfc0', '#cfd8c2']));
      S(0, D * 0.15 + d / 2 + 0.06, w * 0.9, 0.14, 0.05, r.pick(['#e05a47', '#3f8fd0', '#e7b33b', '#46a35c']), FLOOR * 0.85);
      S(0, D * 0.15, w * 0.9, 0.05, 0.18, '#f4f1ea', top);
    }],
    ['Strip mall', 0.7, 1.4, ({ W, D, r, fl, B, S }) => {
      const top = Math.max(1, fl - 1) * FLOOR + 0.12, w = W * 0.92, d = D * 0.42, z = -D * 0.22;
      B(0, z, w, d, top, r.pick(['#e2d6c2', '#d6d0c6', '#cfc3ae']));
      S(0, z + d / 2 + 0.1, w, 0.2, 0.04, '#f4f1ea', FLOOR * 0.85); // canopy along the front
      const n = Math.max(2, Math.round(W * 1.5));
      for (let k = 0; k < n; k++) S(-w / 2 + ((k + 0.5) * w) / n, z + d / 2 + 0.01, (w / n) * 0.7, 0.04, 0.12, r.pick(SIGNS), top - 0.16);
      // the car park out front
      S(0, D * 0.24, w, D * 0.46, 0.03, '#5d5f63');
      for (let k = 0; k <= n; k++) if (r.chance(0.65)) S(-w / 2 + ((k + 0.5) * w) / (n + 1), D * 0.2, 0.15, 0.3, 0.1, r.pick(CARS));
    }],
    ['Old-town shop', 1.3, 0.6, ({ W, D, r, H, wall, roofC, B, S, G }) => {
      const w = W * 0.84, d = D * 0.55, z = D * 0.16;
      B(0, z, w, d, H, wall);
      G(0, z, w + 0.04, d + 0.06, 0.42, H, roofC, W === 1); // a narrow shop shows its gable to the street
      S(0, z + d / 2 + 0.02, w * 0.8, 0.04, FLOOR * 0.55, '#2f3a44', 0.06); // shop window
      S(w * 0.3, z + d / 2 + 0.12, 0.04, 0.2, 0.14, r.pick(SIGNS), H * 0.62); // hanging sign
    }],
    ['Café', 1.2, 0.8, ({ W, D, r, H, B, S, C, Hp }) => {
      const w = W * 0.8, d = D * 0.42, z = -D * 0.08;
      B(0, z, w, d, H, r.pick(['#f0e6d6', '#e7d9c4', '#d9e4e0', '#f2dcd0']));
      S(0, z + d / 2 + 0.06, w * 0.95, 0.14, 0.05, r.pick(SIGNS), FLOOR * 0.85);
      // a terrace out front with sunshades
      const tz = z + d / 2 + D * 0.15, col = r.pick(SIGNS), n = W > 1 ? 3 : 2;
      S(0, tz, w, D * 0.26, 0.03, '#c9b8a0');
      for (let k = 0; k < n; k++) {
        const x = -w / 2 + ((k + 0.5) * w) / n;
        C(x, tz, 0.03, 0.3, '#dddddd');
        Hp(x, tz, 0.36, 0.36, 0.1, 0.3, col);
      }
    }],
    ['Two-storey store', 1, 1.1, ({ W, D, r, fl, B, S }) => {
      const top = Math.max(2, fl) * FLOOR + 0.1, w = W * 0.86, d = D * 0.58, z = D * 0.14, sign = r.pick(SIGNS);
      B(0, z, w, d, top, r.pick(['#d9d2c4', '#c3d3e0', '#e2cfc0', ...BRICK]));
      S(0, z, w + 0.03, d + 0.03, 0.06, TRIM, top);
      S(0, z + d / 2 + 0.06, w * 0.92, 0.12, 0.05, sign, FLOOR * 0.85);
      S(0, z + d * 0.3, w * 0.7, 0.05, 0.3, sign, top + 0.05); // a big sign standing on the roof
    }],
  ],
  com_high: [
    ['Glass tower', 1, 1, ({ W, D, r, fl, h, B }) => {
      const glass = r.pick(['#9fb9d1', '#c8c2b5', '#aebfd0']);
      const w = W * r.range(0.65, 0.85), d = D * r.range(0.55, 0.75);
      B(0, 0, W * 0.92, D * 0.88, FLOOR * 1.5, '#cfc9bd');
      B(0, 0, w, d, h, glass);
      if (fl > 8) B(0, 0, w * 0.7, d * 0.7, h * 0.25, glass, h);
    }],
    ['Shopping mall', 1, 1.2, ({ W, D, r, fl, B, S, Dm }) => {
      const top = Math.max(2, fl * 0.45) * FLOOR + 0.2, w = W * 0.92, d = D * 0.82, z = -D * 0.04;
      B(0, z, w, d, top, r.pick(['#e2dccf', '#d4cec2', '#cfd6dc']));
      S(0, z, w * 0.95, d * 0.95, 0.05, TAR, top);
      Dm(0, z, Math.min(w, d) * 0.4, 0.5, '#a9c3db', top); // glass dome over the atrium
      S(0, z + d / 2 + 0.03, w * 0.5, 0.05, 0.22, r.pick(SIGNS), top - 0.3); // its name on the front
      // cars parked on the roof
      for (let k = 0; k < 6; k++) if (r.chance(0.6)) S((k < 3 ? -1 : 1) * w * 0.36, z + ((k % 3) - 1) * d * 0.25, 0.15, 0.3, 0.1, r.pick(CARS), top + 0.05);
    }],
    ['Department store', 1, 1, ({ W, D, r, fl, B, S }) => {
      const top = fl * FLOOR * 0.7 + FLOOR, w = W * 0.88, d = D * 0.78, band = r.pick(SIGNS);
      const col = r.pick(['#d8cfc0', '#c9c2b5', '#e0d6c6']);
      B(0, 0, w, d, top, col);
      for (let y = FLOOR * 1.2; y < top - 0.2; y += FLOOR * 2) S(0, 0, w + 0.03, d + 0.03, 0.06, band, y); // coloured bands
      B(0, -d * 0.1, w * 0.6, d * 0.5, FLOOR * 2, col, top); // set-back top floors
      S(0, -d * 0.1 + d * 0.25 + 0.02, w * 0.4, 0.04, 0.3, band, top + FLOOR * 0.6);
    }],
    ['Hotel tower', 1, 1, ({ W, D, r, h, B, S }) => {
      const w = W * r.range(0.7, 0.85), d = D * r.range(0.34, 0.42), z = -D * 0.1;
      B(0, 0, W * 0.92, D * 0.88, FLOOR * 1.5, '#cfc9bd');
      B(0, z, w, d, h, r.pick(['#e6e0d4', '#d4dbe2', '#c8bba6']));
      S(0, z, w + 0.05, d + 0.05, 0.12, TRIM, h);
      S(0, z + d / 2 + 0.03, w * 0.5, 0.05, 0.35, r.pick(SIGNS), h - 0.45); // its name near the top
      S(0, D * 0.44 + 0.08, W * 0.3, 0.2, 0.04, TRIM, FLOOR * 0.9); // entrance canopy
    }],
  ],
  off_low: [
    ['Glass office', 1, 1, ({ W, D, r, fl, h, B }) => {
      const glass = r.pick(['#7d9cc4', '#6f8fb3', '#8aa7c9', '#a0b6cf']);
      const w = W * r.range(0.65, 0.85), d = D * r.range(0.55, 0.75);
      B(0, 0, W * 0.92, D * 0.88, FLOOR * 1.5, '#cfc9bd');
      B(0, 0, w, d, h, glass);
      if (fl > 8) B(0, 0, w * 0.7, d * 0.7, h * 0.25, glass, h);
    }],
    ['Brick office', 1.2, 1, ({ W, D, r, h, B, S }) => {
      const w = W * r.range(0.72, 0.86), d = D * r.range(0.58, 0.7), z = D * 0.05;
      B(0, z, w, d, h, r.pick(BRICK));
      S(0, z, w + 0.04, d + 0.04, 0.08, TRIM, h);
      S(0, z + d / 2 + 0.1, w * 0.3, 0.2, 0.04, TRIM, FLOOR * 0.85); // entrance canopy
      S(w * 0.2, z - d * 0.1, w * 0.25, d * 0.25, 0.22, PLANT, h + 0.08);
    }],
    ['Office pavilions', 0.9, 1.1, ({ W, D, r, h, B }) => {
      B(-W * 0.22, D * 0.12, W * 0.42, D * 0.45, h, r.pick(GLASS));
      B(W * 0.2, -D * 0.16, W * 0.46, D * 0.44, Math.max(FLOOR * 2, h - FLOOR), r.pick(MODERN));
    }],
    ['Stepped glass office', 1, 1, ({ W, D, r, h, B, S }) => {
      const glass = r.pick(GLASS), w = W * r.range(0.72, 0.84), d = D * r.range(0.6, 0.72);
      B(0, 0, w, d, h * 0.6, glass);
      B(0, -d * 0.12, w * 0.72, d * 0.66, h * 0.4, glass, h * 0.6);
      S(0, d * 0.355, w * 0.9, d * 0.26, 0.06, GARDEN, h * 0.6); // roof terrace
    }],
  ],
  off_high: [
    ['Glass skyscraper', 1, 1, ({ W, D, r, fl, h, B }) => {
      const glass = r.pick(['#7d9cc4', '#6f8fb3', '#8aa7c9', '#a0b6cf']);
      const w = W * r.range(0.65, 0.85), d = D * r.range(0.55, 0.75);
      B(0, 0, W * 0.92, D * 0.88, FLOOR * 1.5, '#cfc9bd');
      B(0, 0, w, d, h, glass);
      if (fl > 8) B(0, 0, w * 0.7, d * 0.7, h * 0.25, glass, h);
    }],
    ['Art-deco setback', 1, 1.2, ({ W, D, r, h, B, Hp, C }) => {
      const col = r.pick(['#d8cbb0', '#c9bfa8', '#bfb6a4', '#a9b3bb']);
      const w = W * r.range(0.62, 0.72), d = D * r.range(0.55, 0.65), cap = h * 0.06 + 0.3;
      B(0, 0, W * 0.92, D * 0.88, FLOOR * 1.8, col);
      B(0, 0, w, d, h * 0.55, col);
      B(0, 0, w * 0.76, d * 0.76, h * 0.25, col, h * 0.55);
      B(0, 0, w * 0.5, d * 0.5, h * 0.12, col, h * 0.8);
      Hp(0, 0, w * 0.5, d * 0.5, cap, h * 0.92, '#9a9da3');
      C(0, 0, 0.05, 0.9, '#c9ccd1', h * 0.92 + cap - 0.1); // spire
    }],
    ['Twin slabs', 1, 1, ({ W, D, r, h, B, S }) => {
      const glass = r.pick(GLASS);
      B(0, 0, W * 0.92, D * 0.88, FLOOR * 1.5, '#cfc9bd');
      B(-W * 0.22, 0, W * 0.36, D * r.range(0.6, 0.72), h, glass);
      B(W * 0.22, 0, W * 0.36, D * r.range(0.6, 0.72), h * r.range(0.65, 0.85), glass);
      S(-W * 0.22, 0, W * 0.2, D * 0.2, 0.3, PLANT, h);
    }],
    ['Crowned tower', 1, 1, ({ W, D, r, h, B, Hp, C }) => {
      const w = W * r.range(0.6, 0.72), d = D * r.range(0.55, 0.66), crown = Math.min(w, d) * 0.9;
      B(0, 0, W * 0.92, D * 0.88, FLOOR * 1.5, '#cfc9bd');
      B(0, 0, w, d, h, r.pick(GLASS));
      Hp(0, 0, w, d, crown, h, r.pick(['#3c4148', '#6f8fb3', '#c9ccd1']));
      C(0, 0, 0.05, 0.8, '#c9ccd1', h + crown - 0.1);
    }],
    ['Offset tower', 1, 1, ({ W, D, r, h, B, S }) => {
      B(0, 0, W * 0.92, D * 0.88, FLOOR * 1.5, '#cfc9bd');
      B(-W * 0.1, -D * 0.08, W * 0.5, D * 0.5, h, r.pick(GLASS));
      B(W * 0.14, D * 0.1, W * 0.44, D * 0.44, h * r.range(0.6, 0.8), r.pick(GLASS));
      S(-W * 0.1, -D * 0.08, W * 0.25, D * 0.25, 0.35, PLANT, h);
    }],
  ],
  ind: [
    ['Factory', 1, 1, ({ W, D, r, lvl, fl, S, G, C }) => {
      const w = W * 0.85, d = D * 0.6, top = fl * FLOOR + 0.2;
      S(0, -D * 0.05, w, d, top, r.pick(['#c9bfa8', '#b8b4ab', '#c7b48f', '#a8adb3']));
      G(0, -D * 0.05, w + 0.06, d + 0.06, 0.18, top, '#7b7f86');
      C(W * 0.3, D * 0.3, 0.18, 1.2 + lvl * 0.15, '#8d6e5a'); // chimney
      if (r.chance(0.6)) C(-W * 0.28, D * 0.32, 0.5, 0.5, '#d8d6d0');
    }],
    ['Sawtooth factory', 1, 1, ({ W, D, r, lvl, H, B, S, G, C }) => {
      const w = W * 0.86, d = D * 0.62, z = -D * 0.1;
      S(0, z, w, d, H, r.pick(['#c9bfa8', '#b8b4ab', '#a8adb3', '#b9a58a']));
      const n = Math.max(2, Math.round(d / 0.55));
      for (let k = 0; k < n; k++) G(0, z - d / 2 + ((k + 0.5) * d) / n, w + 0.04, d / n, 0.26, H, k % 2 ? '#8d9298' : '#9aa0a6');
      B(W * 0.28, D * 0.36, W * 0.3, D * 0.2, FLOOR * 1.2, '#d8d4cc'); // office at the front
      C(-W * 0.32, D * 0.34, 0.16, 1 + lvl * 0.15, '#8d6e5a');
    }],
    ['Warehouse', 1, 1.2, ({ W, D, r, fl, S }) => {
      const top = Math.max(2, fl) * FLOOR + 0.25, w = W * 0.9, d = D * 0.58, z = -D * 0.16;
      S(0, z, w, d, top, r.pick(['#d6d3cc', '#b9c1c9', '#c7b48f', '#9fa8b0']));
      S(0, z, w + 0.03, d + 0.03, 0.05, '#7b7f86', top);
      const doors = Math.max(2, Math.round(w / 0.5));
      for (let k = 0; k < doors; k++) S(-w / 2 + ((k + 0.5) * w) / doors, z + d / 2 + 0.01, (w / doors) * 0.6, 0.03, FLOOR * 0.9, '#5d6168');
      // the yard, with trucks backed up to the loading doors
      S(0, D * 0.3, w, D * 0.36, 0.03, '#6f6e6a');
      for (let k = 0; k < doors; k++) {
        if (!r.chance(0.4)) continue;
        const x = -w / 2 + ((k + 0.5) * w) / doors;
        S(x, z + d / 2 + 0.28, 0.2, 0.5, 0.24, '#e8e6e0'); // trailer
        S(x, z + d / 2 + 0.6, 0.18, 0.16, 0.2, r.pick(CARS)); // cab
      }
    }],
    ['Tank plant', 1, 1, ({ W, D, r, fl, B, S, C }) => {
      S(-W * 0.25, D * 0.28, W * 0.36, D * 0.3, FLOOR * 1.6, '#c9bfa8'); // process building
      B(W * 0.28, D * 0.34, W * 0.3, D * 0.22, FLOOR * 1.3, '#d8d4cc'); // offices
      const tank = r.pick(['#d8d6d0', '#c9ccd1', '#e3ddd0']), n = W >= 3 ? 3 : 2;
      for (let k = 0; k < n; k++) C(-W * 0.3 + (k * W * 0.6) / (n - 1), -D * 0.2, r.range(0.55, 0.8), 0.6 + fl * 0.18 + r.range(0, 0.3), tank);
      S(0, -D * 0.2 + 0.48, W * 0.7, 0.06, 0.06, '#8d6e5a', 0.55); // pipe rack
    }],
    ['Workshop yard', 1, 1, ({ W, D, r, H, B, S, G }) => {
      const w = W * 0.5, d = D * 0.5, x = -W * 0.2, z = -D * 0.15;
      S(x, z, w, d, H, r.pick(['#b8b4ab', '#c7b48f', '#a8adb3']));
      G(x, z, w + 0.06, d + 0.06, 0.28, H, '#7b7f86', true);
      B(x, z + d / 2 + 0.14, w * 0.6, 0.28, FLOOR, '#d8d4cc'); // office
      // shipping containers in the yard, some stacked two high
      const cols = ['#c8352b', '#2f5fa8', '#d98a2b', '#3d7a4a', '#8a8f96'];
      for (let k = 0; k < 3; k++) {
        const cz = -D * 0.35 + k * 0.34;
        S(W * 0.25, cz, 0.72, 0.3, 0.3, r.pick(cols));
        if (r.chance(0.5)) S(W * 0.25, cz, 0.72, 0.3, 0.3, r.pick(cols), 0.3);
      }
    }],
  ],
  // Large industry: plants on lots of up to 5 × 5
  ind_large: [
    ['Steel mill', 1, 1, ({ W, D, r, lvl, fl, H, S, G, C, Dm }) => {
      const z = -D * 0.12, w = W * 0.9, d = D * 0.5, top = H + 0.3;
      S(0, z, w, d, top, r.pick(['#8d8f93', '#9a8f84', '#7f868d']));
      const n = Math.max(3, Math.round(w / 0.7));
      for (let k = 0; k < n; k++) G(-w / 2 + ((k + 0.5) * w) / n, z, w / n + 0.02, d + 0.04, 0.3, top, k % 2 ? '#6f7378' : '#7b7f86', true);
      const fh = 1.4 + fl * 0.2;
      C(-W * 0.3, D * 0.28, 0.9, fh, '#5d5650'); // blast furnace
      Dm(-W * 0.3, D * 0.28, 0.9, 0.35, '#4d4842', fh);
      for (let k = 0; k < (lvl > 2 ? 3 : 2); k++) C(W * (-0.02 + k * 0.12), D * 0.32, 0.22, 2.4 + lvl * 0.25, '#8d6e5a'); // chimneys
      S(-W * 0.12, D * 0.28, W * 0.36, 0.12, 0.12, '#55585e', fh * 0.8); // conveyor to the furnace
      S(W * 0.36, D * 0.3, W * 0.15, D * 0.24, 0.22, '#2f2f30'); // coal heap
    }],
    ['Refinery', 1, 1, ({ W, D, r, lvl, fl, B, S, C }) => {
      S(0, 0, W * 0.94, D * 0.94, 0.03, '#77766f'); // concrete yard
      const tank = r.pick(['#d8d6d0', '#c9ccd1', '#e3ddd0']);
      const cols = 3;
      for (let a = 0; a < cols; a++) for (let b = 0; b < 2; b++) C(-W * 0.32 + (a * W * 0.38) / (cols - 1), -D * 0.28 + b * 0.95, 0.8, 0.55 + r.range(0, 0.25), tank);
      for (let k = 0; k < (lvl >= 3 ? 3 : 2); k++) C(W * (0.2 + k * 0.1), D * 0.05, 0.22 + k * 0.04, 2.2 + fl * 0.35 - k * 0.3, '#b9bcc0'); // distillation columns
      S(W * 0.27, D * 0.05, W * 0.38, 0.08, 0.08, '#8d6e5a', 0.9); // pipe racks
      S(W * 0.27, -D * 0.18, 0.08, D * 0.46, 0.08, '#8d6e5a', 0.7);
      const fh = 3 + lvl * 0.3;
      C(W * 0.42, -D * 0.38, 0.08, fh, '#9a9da3'); // flare stack
      S(W * 0.42, -D * 0.38, 0.12, 0.12, 0.14, '#ff8a3c', fh);
      B(-W * 0.3, D * 0.38, W * 0.3, D * 0.16, FLOOR * 1.5, '#d8d4cc'); // control building
    }],
    ['Assembly plant', 1, 1.2, ({ W, D, r, H, B, S, C }) => {
      const z = -D * 0.15, w = W * 0.88, d = D * 0.58, top = H + 0.25;
      S(0, z, w, d, top, r.pick(['#d6d3cc', '#c9ccd1', '#b9c1c9']));
      S(0, z, w + 0.03, d + 0.03, 0.05, '#7b7f86', top);
      const vents = Math.max(2, Math.round(w / 0.9));
      for (let k = 0; k < vents; k++) S(-w / 2 + ((k + 0.5) * w) / vents, z, 0.3, d * 0.8, 0.12, '#9aa0a6', top + 0.05);
      B(-W * 0.3, D * 0.3, W * 0.3, D * 0.22, FLOOR * 2.2, '#e6e3dc'); // offices
      // the yard out front, with finished cars in rows
      S(W * 0.18, D * 0.33, W * 0.5, D * 0.28, 0.03, '#5f6064');
      for (let a = 0; a < 6; a++) for (let b = 0; b < 2; b++) if (r.chance(0.75)) S(W * (0.18 - 0.21 + a * 0.084), D * (0.27 + b * 0.12), 0.11, 0.2, 0.09, r.pick(CARS), 0.03);
      C(W * 0.38, z - d * 0.3, 0.2, top + 1.2, '#9a9da3');
    }],
    ['Distribution centre', 1, 1.2, ({ W, D, r, fl, S }) => {
      const top = Math.max(2, fl) * FLOOR + 0.35, w = W * 0.92, d = D * 0.55, z = -D * 0.18;
      S(0, z, w, d, top, r.pick(['#d6d3cc', '#b9c1c9', '#9fa8b0', '#c7b48f']));
      S(0, z, w + 0.03, d + 0.03, 0.05, '#7b7f86', top);
      S(0, z + d / 2 + 0.01, w, 0.02, 0.07, r.pick(SIGNS), top - 0.25); // the company's stripe
      const doors = Math.max(4, Math.round(w / 0.42));
      for (let k = 0; k < doors; k++) S(-w / 2 + ((k + 0.5) * w) / doors, z + d / 2 + 0.01, (w / doors) * 0.62, 0.03, FLOOR * 0.9, '#5d6168');
      S(0, D * 0.27, w, D * 0.42, 0.03, '#6f6e6a'); // truck yard
      for (let k = 0; k < doors; k++) {
        if (!r.chance(0.5)) continue;
        const x = -w / 2 + ((k + 0.5) * w) / doors;
        S(x, z + d / 2 + 0.3, 0.2, 0.55, 0.25, '#e8e6e0'); // trailer
        S(x, z + d / 2 + 0.65, 0.18, 0.16, 0.21, r.pick(CARS)); // cab
      }
    }],
    ['Chemical works', 1, 1, ({ W, D, r, lvl, H, B, S, C, Dm }) => {
      S(-W * 0.22, -D * 0.2, W * 0.46, D * 0.46, H + 0.2, r.pick(['#c9bfa8', '#b8b4ab', '#a8adb3']));
      B(W * 0.3, D * 0.35, W * 0.3, D * 0.2, FLOOR * 1.6, '#d8d4cc'); // offices
      for (let k = 0; k < 2; k++) { const x = W * (0.12 + k * 0.22); C(x, -D * 0.28, 0.7, 0.35, '#cfd2d6'); Dm(x, -D * 0.28, 0.7, 0.35, '#e3e5e8', 0.35); } // gas holders
      C(-W * 0.3, D * 0.28, 1, 1.3 + lvl * 0.15, '#c4c0b6'); // cooling tower
      C(W * 0.42, D * 0.02, 0.16, 2.2 + lvl * 0.25, '#8d6e5a'); // stack
      S(0, -D * 0.05, W * 0.6, 0.06, 0.06, '#8d6e5a', 0.8); // pipes
    }],
  ],
  spec_farm: [
    ['Barn', 1, 1, ({ W, D, B, G, C }) => {
      B(-W * 0.25, D * 0.25, 0.9, 0.6, 0.45, '#a3423a');
      G(-W * 0.25, D * 0.25, 0.95, 0.68, 0.3, 0.45, '#5d5f63');
      C(W * 0.05, D * 0.3, 0.35, 0.9, '#c9ccd1');
    }],
    ['Barn & silos', 1, 1.2, ({ W, D, B, S, G, C, Dm }) => {
      B(-W * 0.2, D * 0.22, 0.7, 1.0, 0.55, '#a3423a');
      G(-W * 0.2, D * 0.22, 0.76, 1.06, 0.42, 0.55, '#5d5f63', true);
      for (let k = 0; k < 2; k++) {
        C(W * 0.12 + k * 0.45, D * 0.3, 0.38, 1.1, '#c9ccd1');
        Dm(W * 0.12 + k * 0.45, D * 0.3, 0.38, 0.2, '#9aa0a6', 1.1);
      }
      S(W * 0.2, -D * 0.2, 0.2, 0.35, 0.18, '#3d7a4a'); // tractor
    }],
    ['Greenhouses', 1.2, 0.8, ({ W, D, wall, roofC, B, S, G }) => {
      B(-W * 0.3, D * 0.3, 0.7, 0.5, FLOOR * 1.2, wall); // farmhouse
      G(-W * 0.3, D * 0.3, 0.76, 0.56, 0.28, FLOOR * 1.2, roofC);
      const n = W >= 4 ? 4 : 3;
      for (let k = 0; k < n; k++) {
        const x = -W * 0.36 + (k * W * 0.72) / (n - 1);
        S(x, -D * 0.18, 0.45, D * 0.5, 0.22, '#d6e8e0');
        G(x, -D * 0.18, 0.47, D * 0.5, 0.16, 0.22, '#e6f2ee', true);
      }
    }],
    ['Crop farm', 1, 1, ({ W, D, B, S, G }) => {
      const rows = Math.max(4, Math.round(W * 2));
      for (let k = 0; k < rows; k++) S(-W * 0.45 + ((k + 0.5) * W * 0.9) / rows, -D * 0.12, ((W * 0.9) / rows) * 0.8, D * 0.66, 0.05, k % 2 ? '#b9a043' : '#6f9f3e');
      B(W * 0.3, D * 0.36, 0.6, 0.45, FLOOR, '#c9b9a0');
      G(W * 0.3, D * 0.36, 0.64, 0.5, 0.25, FLOOR, '#5d5f63');
      S(-W * 0.2, D * 0.36, 0.2, 0.3, 0.16, '#3d7a4a'); // tractor
    }],
  ],
  spec_forest: [
    ['Sawmill', 1, 1, ({ D, S }) => {
      S(0, D * 0.25, 1.2, 0.6, 0.4, '#7d6a4f');
      for (let k = 0; k < 4; k++) S(-0.9 + k * 0.5, -D * 0.15, 0.2, 1.4, 0.2, '#8a6440'); // log piles
    }],
    ['Log cabin camp', 1, 1, ({ W, D, r, B, S, G }) => {
      B(-W * 0.22, D * 0.25, 0.8, 0.5, FLOOR * 1.1, '#8a6440');
      G(-W * 0.22, D * 0.25, 0.86, 0.58, 0.3, FLOOR * 1.1, '#5a4a3a');
      for (let k = 0; k < 3; k++) S(W * 0.2 + (k - 1) * 0.3, -D * 0.2, 0.22, 1.0, 0.22 + r.range(0, 0.12), '#8a6440');
      S(W * 0.3, D * 0.3, 0.22, 0.55, 0.22, '#3d5a3a'); // logging truck
    }],
    ['Lumber yard', 1, 1, ({ W, D, S, G }) => {
      const top = FLOOR * 1.3 + 0.1;
      S(0, -D * 0.15, W * 0.6, D * 0.38, top, '#9a8a70'); // mill shed
      G(0, -D * 0.15, W * 0.62, D * 0.4, 0.2, top, '#7b7f86');
      // a gantry crane over the stacks of planks
      for (const s of [-1, 1]) S(s * W * 0.4, D * 0.25, 0.06, 0.06, 1.0, '#d9b23a');
      S(0, D * 0.25, W * 0.84, 0.08, 0.08, '#d9b23a', 1.0);
      for (let k = 0; k < 3; k++) S(-W * 0.25 + k * W * 0.25, D * 0.25, W * 0.18, 0.5, 0.18 + k * 0.05, '#d8c49a');
    }],
  ],
  spec_ore: [
    ['Mine works', 1, 1, ({ W, D, S, C }) => {
      S(0, D * 0.2, 1.4, 0.7, 0.6, '#6b6e73');
      S(W * 0.25, -D * 0.15, 0.3, 1.2, 0.9, '#4f5257');
      C(-W * 0.3, -D * 0.2, 0.8, 0.35, '#5e5148');
    }],
    ['Headframe mine', 1, 1, ({ W, D, S, Hp }) => {
      // the winding tower over the shaft, its winding house and the spoil heap
      for (const s of [-1, 1]) S(-W * 0.2 + s * 0.18, -D * 0.05, 0.06, 0.06, 1.6, '#6b6e73');
      S(-W * 0.2, -D * 0.05, 0.5, 0.3, 0.16, '#4f5257', 1.6);
      S(-W * 0.2, D * 0.25, 0.9, 0.5, 0.55, '#7d7a72');
      Hp(W * 0.25, -D * 0.2, W * 0.36, D * 0.4, 0.7, 0, '#5e5148');
    }],
    ['Open pit', 1, 1, ({ W, D, S }) => {
      // terraces stepping down into the pit, a crusher, and a conveyor to it
      const cols = ['#8a7d6b', '#6f6457', '#55504a'];
      for (let k = 0; k < 3; k++) S(-W * 0.08, -D * 0.12, W * (0.8 - k * 0.22), D * (0.62 - k * 0.17), 0.05 + k * 0.01, cols[k]);
      S(W * 0.32, D * 0.32, 0.5, 0.4, 0.6, '#6b6e73');
      S(W * 0.15, D * 0.15, 0.08, D * 0.35, 0.05, '#3f4246', 0.45);
      S(-W * 0.1, D * 0.3, 0.22, 0.34, 0.2, '#d9b23a'); // haul truck
    }],
  ],
  spec_oil: [
    ['Oil well', 1, 1, ({ W, D, S, C }) => {
      C(-W * 0.25, D * 0.2, 0.8, 0.7, '#d6d3cc');
      S(W * 0.2, -D * 0.15, 0.15, 0.6, 0.5, '#333333');
      S(W * 0.2, -D * 0.15, 0.12, 0.9, 0.1, '#c94c32', 0.5);
    }],
    ['Pumpjacks', 1, 1, ({ W, D, S }) => {
      const n = W >= 4 ? 4 : 3;
      for (let k = 0; k < n; k++) {
        const x = -W * 0.32 + (k * W * 0.64) / (n - 1), z = (k % 2 ? -0.2 : 0.2) * D;
        S(x, z, 0.3, 0.5, 0.12, '#55585e'); // skid
        S(x, z, 0.06, 0.06, 0.45, '#333333'); // post
        S(x, z, 0.08, 0.7, 0.08, '#c94c32', 0.45); // walking beam
        S(x, z + 0.33, 0.1, 0.1, 0.18, '#c94c32', 0.32); // horse head
      }
      S(0, D * 0.38, 0.6, 0.35, 0.3, '#d6d3cc');
    }],
    ['Tank farm', 1, 1, ({ W, D, r, S, C }) => {
      for (let k = 0; k < 3; k++) C(-W * 0.3 + k * W * 0.3, -D * 0.15, 0.7, 0.55 + r.range(0, 0.2), '#e3ddd0');
      S(0, D * 0.12, W * 0.7, 0.05, 0.05, '#8d6e5a', 0.3); // pipeline
      S(-W * 0.2, D * 0.32, 0.5, 0.35, 0.3, '#d6d3cc');
      C(W * 0.38, D * 0.3, 0.08, 1.6, '#8a8f96'); // flare stack
      S(W * 0.38, D * 0.3, 0.1, 0.1, 0.12, '#ff8a3c', 1.6);
    }],
  ],
};

// Which style a building of this zone gets (the same every time for the same seed)
function styleOf(def, seed, themeKey) {
  const list = STYLES[def.key];
  if (!list) return null;
  const col = themeKey === 'na' ? 2 : 1;
  const total = list.reduce((s, st) => s + st[col], 0);
  let t = makeRng((seed ^ 0x5bd1e995) >>> 0).next() * total;
  for (const st of list) if ((t -= st[col]) < 0) return st;
  return list[list.length - 1];
}

export const zoneStyleName = (b, themeKey) => styleOf(b.def, b.seed, themeKey)?.[0] || null;

export function zoneParts(b, def, theme, themeKey) {
  const r = makeRng(b.seed);
  const W = b.w, D = b.d;
  const lvl = b.level || 1;
  const growth = (def.maxFloors - def.floors) / 4;
  const fl = Math.max(1, Math.round(def.floors + (lvl - 1) * growth * r.range(0.6, 1.1)));
  const wall = r.pick(theme.palette);
  const roofC = r.pick(theme.roofColors);
  const pitched = theme.roof === 'pitched' || r.chance(0.5);
  const P = [];
  const c = {
    W, D, r, lvl, theme, wall, roofC, pitched,
    fl: def.key === 'res_low' ? (lvl >= 3 ? 2 : 1) : fl,
    B: (x, z, w, d, h, color, y = 0) => P.push({ pool: 'body', x, z, w, d, h, y, color }),
    S: (x, z, w, d, h, color, y = 0) => P.push({ pool: 'plain', x, z, w, d, h, y, color }),
    G: (x, z, w, d, h, y, color, turn = false) => P.push({ pool: 'roof', x, z, w, d, h, y, color, turn }),
    Hp: (x, z, w, d, h, y, color) => P.push({ pool: 'hip', x, z, w, d, h, y, color }),
    C: (x, z, w, h, color, y = 0) => P.push({ pool: 'cyl', x, z, w, d: w, h, y, color }),
    Dm: (x, z, w, h, color, y = 0) => P.push({ pool: 'dome', x, z, w, d: w, h, y, color }),
  };
  c.h = c.fl * FLOOR;          // walls of fl storeys
  c.H = c.fl * FLOOR + 0.1;    // ...on a low plinth (houses, shops, sheds)
  const style = styleOf(def, b.seed, themeKey);
  if (style) style[3](c);
  else c.B(0, 0, W * 0.8, D * 0.7, c.h, wall);
  // houses: some gardens have hedges down the sides
  if (def.key === 'res_low' && r.chance(0.35)) for (const s of [-1, 1]) c.S(s * W * 0.46, -D * 0.05, 0.06, D * 0.8, 0.1, HEDGE);
  return P;
}
