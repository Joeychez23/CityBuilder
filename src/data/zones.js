// Zone types. A building grows on a lot of w (along the road) × d (away from the road)
// cells that are all painted with the same zone.
// needsRoad = the smallest class of road it grows beside (see the road hierarchy in roads.js)
// hh   = households per cell at level 1 (residential)
// jobs = workplaces per cell at level 1 (commercial / industrial / office)
// edu  = share of jobs per education level [uneducated, elementary, high school, college, university]
export const ZONES = {
  1: { id: 1, key: 'res_low', name: 'Low Density Housing', cat: 'res', color: '#6fd36b', lots: [[1, 2], [2, 2]], floors: 1, hh: 0.5, maxFloors: 2, rent: 1.25, family: 0.8, milestone: 0 },
  2: { id: 2, key: 'res_row', name: 'Row Housing', cat: 'res', color: '#4fbf73', lots: [[1, 2]], floors: 2, hh: 1, maxFloors: 3, rent: 1.0, family: 0.6, milestone: 1 },
  3: { id: 3, key: 'res_med', name: 'Medium Density Housing', cat: 'res', color: '#2fa35a', lots: [[2, 2], [2, 3]], floors: 3, hh: 3, maxFloors: 5, rent: 0.85, family: 0.45, milestone: 2 },
  4: { id: 4, key: 'res_high', name: 'High Density Housing', cat: 'res', needsRoad: 'collector', color: '#1d7f45', lots: [[2, 3], [3, 3]], floors: 7, hh: 7, maxFloors: 20, rent: 0.7, family: 0.25, milestone: 7 },
  5: { id: 5, key: 'res_mixed', name: 'Mixed Housing', cat: 'res', needsRoad: 'collector', color: '#58c0a6', lots: [[2, 2]], floors: 4, hh: 2.5, jobs: 1.5, maxFloors: 7, rent: 0.8, family: 0.35, milestone: 5, mixed: true },
  6: { id: 6, key: 'res_lowrent', name: 'Low Rent Housing', cat: 'res', needsRoad: 'collector', color: '#96b84f', lots: [[2, 3]], floors: 5, hh: 6, maxFloors: 8, rent: 0.45, family: 0.5, milestone: 4, lowRent: true },
  7: { id: 7, key: 'com_low', name: 'Low Density Commercial', cat: 'com', color: '#4aa8ff', lots: [[1, 2], [2, 2]], floors: 1, jobs: 3, maxFloors: 3, edu: [0.4, 0.35, 0.2, 0.05, 0], milestone: 0 },
  8: { id: 8, key: 'com_high', name: 'High Density Commercial', cat: 'com', needsRoad: 'collector', color: '#2a6fdb', lots: [[2, 3], [3, 3]], floors: 5, jobs: 7, maxFloors: 16, edu: [0.2, 0.35, 0.3, 0.12, 0.03], milestone: 6 },
  9: { id: 9, key: 'ind', name: 'Industrial', cat: 'ind', color: '#f0c43c', lots: [[2, 3], [3, 3]], floors: 2, jobs: 4, maxFloors: 4, edu: [0.5, 0.3, 0.15, 0.05, 0], milestone: 0 },
  10: { id: 10, key: 'off_low', name: 'Low Density Office', cat: 'off', color: '#c08cff', lots: [[2, 2]], floors: 3, jobs: 6, maxFloors: 5, edu: [0.05, 0.15, 0.35, 0.3, 0.15], milestone: 3 },
  11: { id: 11, key: 'off_high', name: 'High Density Office', cat: 'off', needsRoad: 'collector', color: '#8e52e0', lots: [[2, 3], [3, 3]], floors: 9, jobs: 14, maxFloors: 30, edu: [0.02, 0.08, 0.3, 0.35, 0.25], milestone: 8 },
  12: { id: 12, key: 'spec_farm', name: 'Agriculture', cat: 'spec', resource: 'fertile', product: 'grain', color: '#c9a65a', lots: [[3, 3], [4, 4]], floors: 1, jobs: 1, maxFloors: 1, edu: [0.7, 0.25, 0.05, 0, 0], milestone: 2 },
  13: { id: 13, key: 'spec_forest', name: 'Forestry', cat: 'spec', resource: 'forest', product: 'wood', color: '#5b8a3a', lots: [[3, 3]], floors: 1, jobs: 1.2, maxFloors: 1, edu: [0.7, 0.25, 0.05, 0, 0], milestone: 2 },
  14: { id: 14, key: 'spec_ore', name: 'Ore Mining', cat: 'spec', resource: 'ore', product: 'ore', color: '#7f8fa8', lots: [[3, 3]], floors: 2, jobs: 1.6, maxFloors: 2, edu: [0.6, 0.3, 0.1, 0, 0], milestone: 2 },
  15: { id: 15, key: 'spec_oil', name: 'Oil Extraction', cat: 'spec', resource: 'oil', product: 'oil', color: '#3b3b3b', lots: [[3, 3]], floors: 2, jobs: 1.6, maxFloors: 2, edu: [0.5, 0.3, 0.15, 0.05, 0], milestone: 2 },
  // (order: where it sits in the zoning menu, among its kind)
  16: { id: 16, key: 'res_tower', name: 'High-Rise Apartments', cat: 'res', needsRoad: 'collector', color: '#14603a', lots: [[3, 3], [3, 4], [4, 4]], floors: 16, hh: 12, maxFloors: 44, rent: 0.75, family: 0.2, milestone: 9, order: 4.5 },
  // pollute: × the pollution and noise of ordinary industry per cell; output: × what each worker makes;
  // fallbackLots: tried only when none of its lots fit
  17: { id: 17, key: 'ind_large', name: 'Large Industry', cat: 'ind', needsRoad: 'collector', color: '#d9a21b', lots: [[4, 4], [4, 5], [5, 5]], fallbackLots: [[3, 4]], floors: 2, jobs: 5, maxFloors: 5, edu: [0.45, 0.3, 0.17, 0.07, 0.01], pollute: 1.25, output: 1.2, milestone: 6, order: 9.5 },
};

// What each zone grows (shown when you hover it in the menu)
const ZONE_DESC = {
  res_low: 'Detached houses with gardens. Families like them, but they house few people per street.',
  res_row: 'Terraced houses sharing their walls: more homes per street than detached houses.',
  res_med: 'Small apartment blocks: many homes on each lot.',
  res_high: 'Apartment towers: the most homes per cell. People there expect good services nearby.',
  res_mixed: 'Shops on the ground floor and homes above, so people live and shop in the same block.',
  res_lowrent: 'Cheap apartments for households on low incomes (a welfare office nearby helps them).',
  res_tower: 'Skyscraper apartments on big lots: by far the most homes per cell. They need a lot of people wanting to move in, and their residents expect good services and transit nearby.',
  com_low: 'Small shops and services along the street. They need customers living nearby, workers and parking.',
  com_high: 'Malls and big stores: many jobs, and they need lots of customers and parking.',
  ind: 'Factories and warehouses: plenty of jobs, but noisy and polluting. Keep them a few blocks from homes.',
  ind_large: 'Steel mills, refineries, assembly plants and distribution centres on lots of up to 5 × 5: more jobs per cell and more made by each worker, but even dirtier and louder than ordinary industry. Give it room and a good road for the trucks.',
  off_low: 'Small offices: clean jobs for well-educated workers.',
  off_high: 'Office towers: many jobs for well-educated workers.',
  spec_farm: 'Farms on fertile land (press V to see where it is).',
  spec_forest: 'Forestry in the forest (clearing trees removes this resource).',
  spec_ore: 'Mines on ore deposits.',
  spec_oil: 'Oil wells on oil deposits.',
};
for (const z of Object.values(ZONES)) z.desc = ZONE_DESC[z.key] + (z.needsRoad ? ' Grows only beside a Medium Road, One-Way Road or bigger (not on local streets).' : '');

const CAT_ORDER = { res: 0, com: 1, ind: 2, off: 3, spec: 4 };
export const ZONE_LIST = Object.values(ZONES).sort((a, b) => CAT_ORDER[a.cat] - CAT_ORDER[b.cat] || (a.order ?? a.id) - (b.order ?? b.id));
export const ZONE_DEPTH = 6; // zone cells reach up to 6 cells away from a road

// Default job education mix for mixed-use buildings' shops.
export const MIXED_EDU = [0.35, 0.35, 0.2, 0.1, 0];

// Education levels (shared by citizens and workplaces)
export const EDU_NAMES = ['Uneducated', 'Poorly educated', 'Educated', 'Well educated', 'Highly educated'];
export const WAGES = [1500, 1800, 2100, 2400, 2700]; // per day, by education level
