// Signature buildings: unique zoned landmarks unlocked by how the city grows. They're free
// to place (once each), count as normal homes/workplaces, raise well-being nearby and
// attract tourists. `check(stats)` returns progress 0..1 toward unlocking.
import { registerDefs } from './registry.js';

const box = (x, z, w, d, h, color, y = 0, pool = 'body') => ({ pool, x, z, w, d, h, y, color });
const cyl = (x, z, r, h, color, y = 0) => ({ pool: 'cyl', x, z, w: r * 2, d: r * 2, h, y, color });
const dome = (x, z, r, color, y) => ({ pool: 'dome', x, z, w: r * 2, d: r * 2, h: r, y, color });
const roof = (x, z, w, d, h, color, y) => ({ pool: 'roof', x, z, w, d, h, y, color });
const lawn = (w, d, color = '#7fb35a') => box(0, 0, w, d, 0.06, color, 0, 'plain');

export const SIGNATURES = [
  { id: 'sig_villa', name: 'Lakeview Villa', cat: 'res', w: 3, d: 3, hh: 4, wellbeing: 4, radius: 14, attract: 4,
    req: 'Zone 150 cells of low density housing', check: (s) => s.zoneCells.res_low / 150,
    shape: [lawn(2.9, 2.9), box(0, 0.3, 2, 1.4, 0.8, '#f1ebe0'), roof(0, 0.3, 2.1, 1.5, 0.45, '#8b3a2a', 0.8), cyl(0.9, -0.9, 0.35, 0.05, '#3aa0ff')] },
  { id: 'sig_terraces', name: 'Garden Terraces', cat: 'res', w: 3, d: 2, hh: 16, wellbeing: 3, radius: 12, attract: 3,
    req: 'Zone 120 cells of row housing', check: (s) => s.zoneCells.res_row / 120,
    shape: [box(0, 0, 2.8, 1.6, 0.8, '#e4d3b8'), box(0, -0.15, 2.4, 1.2, 0.7, '#e9dcc4', 0.8), box(0, -0.3, 2, 0.8, 0.6, '#efe4d0', 1.5), lawn(2.9, 1.9, '#6f9f4e')] },
  { id: 'sig_skyline', name: 'Skyline Residences', cat: 'res', w: 3, d: 3, hh: 120, wellbeing: 2, radius: 16, attract: 8,
    req: '15 high density housing buildings at level 3+', check: (s) => s.levelCount.res_high3 / 15,
    shape: [box(0, 0, 2.6, 2.6, 0.6, '#b9b4aa'), box(-0.4, -0.3, 1.2, 1.2, 9, '#a9c3db'), box(0.6, 0.5, 1, 1, 6.5, '#b8cfe3')] },
  { id: 'sig_coop', name: 'Harmony Co-op', cat: 'res', w: 3, d: 2, hh: 40, wellbeing: 5, radius: 12, attract: 2,
    req: 'Zone 80 cells of low-rent housing and reach 60% happiness', check: (s) => Math.min(s.zoneCells.res_lowrent / 80, (s.happiness || 0) / 60),
    shape: [box(0, 0, 2.8, 1.6, 2.4, '#c9a27a'), box(0, 0, 2.9, 1.7, 0.15, '#5fae4a', 2.4)] },
  { id: 'sig_bazaar', name: 'Grand Bazaar', cat: 'com', w: 3, d: 3, jobs: 60, wellbeing: 2, radius: 14, attract: 10,
    req: '30 commercial buildings', check: (s) => s.catCount.com / 30,
    shape: [box(0, 0, 2.8, 2.8, 1, '#e3c08f'), dome(0, 0, 1, '#2f8f8f', 1), cyl(1.2, 1.2, 0.15, 2.4, '#e3c08f'), cyl(-1.2, 1.2, 0.15, 2.4, '#e3c08f')] },
  { id: 'sig_fashion', name: 'Fashion Plaza', cat: 'com', w: 3, d: 3, jobs: 90, wellbeing: 1, radius: 14, attract: 14,
    req: '10 high density commercial buildings at level 4+', check: (s) => s.levelCount.com_high4 / 10,
    shape: [box(0, 0, 2.8, 2.8, 1.4, '#e8e8ec'), box(0, 0, 2, 2, 3.2, '#d1b3e6', 1.4), box(0, 0, 2.9, 0.1, 0.4, '#d4af37', 1.4)] },
  { id: 'sig_agri', name: 'Agri Co-op Headquarters', cat: 'ind', product: 'food', w: 3, d: 3, jobs: 50, wellbeing: 1, radius: 10, attract: 3,
    req: 'Produce 400 grain in a day', check: (s) => (s.produced.grain || 0) / 400,
    shape: [box(-0.4, 0.4, 2, 1.4, 1, '#a3423a'), roof(-0.4, 0.4, 2.1, 1.5, 0.6, '#5d5f63', 1), cyl(1, -0.8, 0.4, 2, '#c9ccd1'), cyl(0.2, -0.9, 0.35, 1.6, '#c9ccd1')] },
  { id: 'sig_steel', name: 'Riverside Steel Works', cat: 'ind', product: 'metals', w: 4, d: 3, jobs: 90, wellbeing: 0, radius: 10, attract: 2,
    req: 'Produce 300 metals in a day', check: (s) => (s.produced.metals || 0) / 300,
    shape: [box(0, 0.3, 3.6, 1.8, 1.6, '#6e6a66'), cyl(1.2, -0.9, 0.3, 4.5, '#5a5552'), cyl(0.2, -0.9, 0.3, 4.5, '#5a5552'), cyl(-0.8, -0.9, 0.3, 4.5, '#5a5552')] },
  { id: 'sig_campus', name: 'Innovation Campus', cat: 'off', product: 'software', w: 4, d: 3, jobs: 140, wellbeing: 3, radius: 14, attract: 8,
    req: '15 office buildings and a university', check: (s) => Math.min(s.catCount.off / 15, s.hasUniversity ? 1 : 0.5),
    shape: [lawn(3.9, 2.9, '#6f9f4e'), box(-0.9, 0.3, 1.6, 1.6, 2.6, '#9fc0dd'), box(0.9, -0.3, 1.6, 1.4, 1.8, '#c4d8ea'), dome(0.9, -0.3, 0.6, '#e9eef3', 1.8)] },
  { id: 'sig_tower', name: 'Meridian Tower', cat: 'off', product: 'finance', w: 3, d: 3, jobs: 220, wellbeing: 2, radius: 18, attract: 18,
    req: 'Reach 8,000 population', check: (s) => s.population / 8000,
    shape: [box(0, 0, 2.6, 2.6, 1, '#cfc9bd'), box(0, 0, 1.8, 1.8, 13, '#7d9cc4'), box(0, 0, 1.2, 1.2, 2, '#9fb9d1', 13), cyl(0, 0, 0.05, 2.5, '#ddd', 15)] },
];

export const SIGNATURE_BY_ID = {};
for (const s of SIGNATURES) {
  s.kind = 'zone';
  s.signature = true;
  s.key = s.id;
  s.permanent = false;
  s.lots = [[s.w, s.d]];
  s.floors = 1; s.maxFloors = 1;
  s.edu = s.cat === 'off' ? [0.02, 0.08, 0.3, 0.35, 0.25] : [0.3, 0.3, 0.25, 0.1, 0.05];
  s.cost = 0;
  s.free = true;
  s.desc = `${s.req}. +${s.wellbeing} well-being nearby, +${s.attract} attractiveness.`;
  s.effect = `+${s.wellbeing} well-being within ${s.radius * 8} m · +${s.attract} attractiveness`;
  SIGNATURE_BY_ID[s.id] = s;
}
registerDefs('zone', SIGNATURE_BY_ID);
