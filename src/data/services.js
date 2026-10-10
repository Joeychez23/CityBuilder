// City service buildings. Distances are in cells (1 cell = 8 m), upkeep per day (the UI shows
// it per week). power: MW produced ; water/sewage: m³ per day handled ; capacity: people/tonnes.
// Numbers are scaled for a ~1 km² playable map, so they're not 1:1 with CS2.
import { registerDefs } from './registry.js';

// --- shape helpers (x along the road, z toward the road; sizes in cells) ---
const box = (x, z, w, d, h, color, y = 0, pool = 'body') => ({ pool, x, z, w, d, h, y, color });
const plain = (x, z, w, d, h, color, y = 0) => box(x, z, w, d, h, color, y, 'plain');
const cyl = (x, z, r, h, color, y = 0) => ({ pool: 'cyl', x, z, w: r * 2, d: r * 2, h, y, color });
const dome = (x, z, r, color, y) => ({ pool: 'dome', x, z, w: r * 2, d: r * 2, h: r, y, color });
const roof = (x, z, w, d, h, color, y) => ({ pool: 'roof', x, z, w, d, h, y, color });
const trees = (pts, size = 0.5) => pts.flatMap(([x, z]) => [cyl(x, z, 0.04, 0.3, '#6b4f36'), dome(x, z, size / 2, '#4e8a35', 0.25)]);
const lawn = (w, d, color = '#7fb35a') => plain(0, 0, w, d, 0.06, color);

export const SERVICE_CATS = {
  electricity: { name: 'Electricity', icon: '⚡', color: '#ffd34f', order: 30 },
  water: { name: 'Water & Sewage', icon: '💧', color: '#3aa0ff', order: 31 },
  garbage: { name: 'Garbage', icon: '🗑️', color: '#a3825a', order: 32 },
  health: { name: 'Healthcare & Deathcare', icon: '🏥', color: '#ff6b81', order: 33 },
  fire: { name: 'Fire & Rescue', icon: '🚒', color: '#ff7a3d', order: 34 },
  police: { name: 'Police & Administration', icon: '🚓', color: '#5b8cff', order: 35 },
  education: { name: 'Education & Research', icon: '🎓', color: '#ffb84f', order: 36 },
  parks: { name: 'Parks & Recreation', icon: '🌳', color: '#5fd38a', order: 37 },
  comms: { name: 'Communications', icon: '📡', color: '#b07cff', order: 38 },
  transport: { name: 'Transportation', icon: '🚌', color: '#4fc3ff', order: 40 },
};

const S = [
  // ------------------------------------------------------------- electricity
  { id: 'windmill', cat: 'electricity', name: 'Wind Turbine', cost: 8500, upkeep: 250, w: 1, d: 1, power: 2, wind: true, workers: 0, milestone: 0,
    desc: 'Clean but weak. Output follows the wind.', shape: [cyl(0, 0, 0.08, 3.2, '#e9eef2'), plain(0, 0.12, 0.12, 0.14, 0.12, '#dfe5ea', 3.1), plain(0, 0.2, 0.05, 0.02, 1.6, '#f4f6f8', 2.4)] },
  { id: 'coal', cat: 'electricity', name: 'Coal Power Plant', cost: 100000, upkeep: 4500, w: 4, d: 4, power: 30, workers: 30, milestone: 0,
    pollution: { air: 1.2, ground: 0.5, noise: 0.6 }, desc: 'Cheap, reliable, very polluting.',
    shape: [box(0, 0.4, 3.4, 2.2, 1.6, '#8d8378'), plain(-0.9, -1.2, 0.6, 0.6, 0.15, '#2b2b2b'), cyl(0.9, -1, 0.3, 4, '#a49a90'), cyl(1.6, -1, 0.3, 4, '#a49a90'), roof(0, 0.4, 3.4, 2.2, 0.4, '#5d5f63', 1.6)] },
  { id: 'gas', cat: 'electricity', name: 'Gas Power Plant', cost: 300000, upkeep: 9000, w: 4, d: 3, power: 80, workers: 25, milestone: 4, devNode: 'power_gas',
    pollution: { air: 0.6, noise: 0.5 }, desc: 'Strong, moderate pollution.',
    shape: [box(0, 0.3, 3.4, 1.8, 1.2, '#b9b6ae'), cyl(1.2, -0.9, 0.35, 1, '#e3e1db'), cyl(0.3, -0.9, 0.35, 1, '#e3e1db'), cyl(-1.3, -0.7, 0.15, 2.8, '#c9c6bf')] },
  { id: 'solar', cat: 'electricity', name: 'Solar Power Station', cost: 220000, upkeep: 3500, w: 4, d: 4, power: 40, solar: true, workers: 6, milestone: 5, devNode: 'power_solar',
    desc: 'Clean. Only produces in daylight; clouds reduce output.',
    shape: [lawn(3.8, 3.8, '#9aa98a'), ...[-1.2, 0, 1.2].flatMap((x) => [-1.1, 0, 1.1].map((z) => plain(x, z, 1, 0.8, 0.25, '#2e4a7a', 0.15)))] },
  { id: 'geothermal', cat: 'electricity', name: 'Geothermal Plant', cost: 420000, upkeep: 7000, w: 3, d: 3, power: 70, needs: 'groundwater', workers: 20, milestone: 8, devNode: 'power_geo',
    desc: 'Clean, steady power. Must be built on groundwater.',
    shape: [box(0, 0.4, 2.6, 1.6, 1, '#c8c2b0'), cyl(-0.7, -0.8, 0.45, 1.6, '#e4e2dd'), cyl(0.6, -0.8, 0.45, 1.6, '#e4e2dd')] },
  { id: 'nuclear', cat: 'electricity', name: 'Nuclear Power Plant', cost: 2400000, upkeep: 32000, w: 6, d: 5, power: 400, workers: 90, milestone: 12, devNode: 'power_nuclear', needsWater: true,
    pollution: { noise: 0.4 }, desc: 'Huge clean output. Needs water nearby for cooling.',
    shape: [box(0.8, 0.8, 3, 2, 1.6, '#c9ccd1'), dome(-1.6, 0.8, 0.9, '#d9dcdf', 1.2), cyl(-1.4, -1.5, 1, 3.4, '#bfc3c7'), cyl(1.4, -1.5, 1, 3.4, '#bfc3c7'), cyl(-1.6, 0.8, 0.9, 1.2, '#d9dcdf')] },
  { id: 'battery', cat: 'electricity', name: 'Emergency Battery', cost: 60000, upkeep: 1200, w: 2, d: 2, battery: 60, workers: 2, milestone: 3, devNode: 'power_battery',
    desc: 'Stores surplus power and discharges it when demand exceeds supply.',
    shape: [plain(-0.4, 0, 0.6, 1.6, 0.6, '#5b6670'), plain(0.4, 0, 0.6, 1.6, 0.6, '#5b6670')] },

  // ------------------------------------------------------------- water & sewage
  { id: 'pump', cat: 'water', name: 'Water Pumping Station', cost: 30000, upkeep: 1500, w: 2, d: 2, water: 9000, needsWater: true, workers: 4, milestone: 0,
    desc: 'Pumps surface water. Place it next to clean water, upstream of any sewage outlet.',
    shape: [box(0, 0.3, 1.6, 1, 0.6, '#d9d4c5'), cyl(0, -0.5, 0.35, 0.4, '#3aa0ff')] },
  { id: 'gwpump', cat: 'water', name: 'Groundwater Pump', cost: 25000, upkeep: 1300, w: 2, d: 2, water: 6000, needs: 'groundwater', workers: 3, milestone: 0,
    desc: 'Pumps groundwater. Watch out for ground pollution seeping in.',
    shape: [box(0, 0.3, 1.4, 1, 0.5, '#d2cbbb'), cyl(0, -0.5, 0.3, 0.6, '#7bb6e8')] },
  { id: 'tower', cat: 'water', name: 'Water Tower', cost: 18000, upkeep: 800, w: 1, d: 1, water: 2500, needs: 'groundwater', workers: 1, milestone: 1,
    desc: 'Small groundwater supply that fits anywhere.',
    shape: [cyl(0, 0, 0.07, 1.6, '#8c8c8c'), cyl(0, 0, 0.42, 0.6, '#9fc6e8', 1.5)] },
  { id: 'outlet', cat: 'water', name: 'Sewage Outlet', cost: 15000, upkeep: 600, w: 1, d: 1, sewage: 9000, needsWater: true, workers: 1, milestone: 0,
    pollution: { water: 2.5 }, desc: 'Pours raw sewage into the water, where the current carries it downstream. Keep it downstream of every water pump, or residents get upset.',
    shape: [plain(0, 0, 0.8, 0.8, 0.3, '#6e6a5e'), cyl(0, -0.3, 0.2, 0.3, '#4c473d')] },
  { id: 'treatment', cat: 'water', name: 'Wastewater Treatment Plant', cost: 140000, upkeep: 5000, w: 4, d: 3, sewage: 24000, needsWater: true, workers: 15, milestone: 4, devNode: 'water_treatment',
    pollution: { water: 0.4, noise: 0.2 }, desc: 'Cleans 85% of sewage before release.',
    shape: [box(-1, 0.6, 1.6, 1, 0.6, '#cfc9b9'), cyl(0.4, -0.4, 0.6, 0.35, '#6c8f7a'), cyl(1.4, -0.4, 0.6, 0.35, '#6c8f7a'), cyl(1.4, 0.7, 0.45, 0.35, '#6c8f7a')] },

  // ------------------------------------------------------------- garbage
  // A landfill is an area you draw, like zoning: the bigger it is, the more it holds (and the
  // more garbage trucks it runs). cost/upkeep are the base; perCell/upkeepPerCell per cell.
  { id: 'landfill', cat: 'garbage', name: 'Landfill', cost: 10000, perCell: 1800, upkeep: 300, upkeepPerCell: 75, w: 4, d: 4, area: { min: 3, max: 16 },
    radius: 34, garbageRate: 140, storage: 3000, storagePerCell: 190, workers: 8, milestone: 0,
    pollution: { ground: 0.8, noise: 0.3 }, desc: 'Draw it as an area next to a road: the bigger it is, the more garbage it holds and the more trucks it sends out. Drag more area next to it to make it bigger.',
    shape: [plain(0, -0.3, 3.6, 2.8, 0.5, '#7e6a4f'), plain(0.6, -0.5, 1.6, 1.4, 0.4, '#8b7a5f', 0.5), box(-1.3, 1.4, 1, 0.6, 0.5, '#bfb6a0')] },
  { id: 'incinerator', cat: 'garbage', name: 'Incineration Plant', cost: 260000, upkeep: 8000, w: 4, d: 3, radius: 48, garbageRate: 380, burns: true, trucks: 6, workers: 20, milestone: 5, devNode: 'garbage_incinerator',
    pollution: { air: 0.7, noise: 0.3 }, desc: 'Its trucks collect garbage, which it burns to make electricity. Never fills up.',
    shape: [box(0, 0.4, 3.2, 1.6, 1.4, '#9b8f80'), cyl(1.2, -0.8, 0.3, 3.2, '#776c60')] },
  { id: 'recycling', cat: 'garbage', name: 'Recycling Center', cost: 120000, upkeep: 4000, w: 3, d: 3, radius: 40, garbageRate: 220, recycles: true, trucks: 5, workers: 14, milestone: 6, devNode: 'garbage_recycling',
    pollution: { noise: 0.3 }, desc: 'Its trucks collect garbage, which it turns into raw materials for industry.',
    shape: [box(0, 0.3, 2.6, 1.8, 1, '#79a36a'), plain(-0.6, -1, 1, 0.6, 0.4, '#5f7d52')] },

  // ------------------------------------------------------------- health & deathcare
  { id: 'clinic', cat: 'health', name: 'Medical Clinic', cost: 30000, upkeep: 2500, w: 2, d: 2, radius: 22, patients: 40, health: 1, workers: 10, milestone: 1,
    desc: 'Treats sick citizens nearby and improves health.', shape: [box(0, 0.1, 1.6, 1.4, 0.8, '#eef0f2'), plain(0, 0.85, 0.5, 0.06, 0.3, '#e04a4a', 0.4)] },
  { id: 'hospital', cat: 'health', name: 'Hospital', cost: 260000, upkeep: 12000, w: 4, d: 3, radius: 44, patients: 320, health: 2, workers: 70, milestone: 6, devNode: 'health_hospital',
    desc: 'Large capacity and a strong health bonus. Has an ambulance fleet.', shape: [box(0, 0.3, 3.4, 2, 2.3, '#f2f3f5'), box(-1, -0.6, 1.2, 1, 3.4, '#e7e9ec'), plain(0, 1.32, 0.8, 0.06, 0.4, '#e04a4a', 1.4)] },
  { id: 'cemetery', cat: 'health', name: 'Cemetery', cost: 25000, upkeep: 1200, w: 3, d: 3, radius: 36, deathRate: 30, storage: 900, workers: 4, milestone: 1,
    desc: 'Hearses collect the deceased. Fills up over time.',
    shape: [lawn(2.8, 2.8, '#6d9a52'), ...[-0.8, 0, 0.8].flatMap((x) => [-0.6, 0.2].map((z) => plain(x, z, 0.12, 0.05, 0.2, '#bfc2c6'))), ...trees([[-1.1, 1], [1.1, 1]])] },
  { id: 'crematorium', cat: 'health', name: 'Crematorium', cost: 90000, upkeep: 3000, w: 2, d: 3, radius: 64, deathRate: 320, workers: 10, milestone: 5, devNode: 'health_crematorium',
    pollution: { air: 0.2 }, desc: 'Processes the deceased without filling up. One serves a town of about 20,000; its hearses are done by morning.', shape: [box(0, 0.4, 1.6, 1.8, 1, '#c9c2b6'), cyl(0.5, -0.9, 0.15, 1.8, '#8d857a')] },

  // ------------------------------------------------------------- fire & rescue
  { id: 'firehouse', cat: 'fire', name: 'Fire House', cost: 40000, upkeep: 2000, w: 2, d: 2, radius: 26, engines: 3, workers: 12, milestone: 1,
    desc: 'Reduces fire hazard and puts out fires nearby.', shape: [box(0, 0.1, 1.7, 1.5, 0.9, '#c8483b'), plain(0, 0.86, 1.2, 0.04, 0.55, '#3a3a3a')] },
  { id: 'firestation', cat: 'fire', name: 'Fire Station', cost: 180000, upkeep: 8000, w: 3, d: 3, radius: 46, engines: 8, workers: 35, milestone: 6, devNode: 'fire_station',
    desc: 'Big coverage and many engines.', shape: [box(0, 0.3, 2.6, 2, 1.1, '#c8483b'), box(-0.9, -0.9, 0.6, 0.6, 2.3, '#a63a30')] },
  { id: 'firewatch', cat: 'fire', name: 'Firewatch Tower', cost: 12000, upkeep: 500, w: 1, d: 1, radius: 30, forestWatch: true, workers: 1, milestone: 3,
    desc: 'Spots forest fires early so they spread less.', shape: [cyl(0, 0, 0.1, 2.2, '#7a5a3a'), box(0, 0, 0.6, 0.6, 0.4, '#b2875a', 2.2), roof(0, 0, 0.7, 0.7, 0.25, '#5b3c26', 2.6)] },
  { id: 'helidepot', cat: 'fire', name: 'Firefighting Helicopter Depot', cost: 140000, upkeep: 6000, w: 3, d: 3, radius: 80, engines: 3, heli: true, workers: 15, milestone: 8, devNode: 'fire_heli',
    desc: 'Helicopters fight forest fires and fires anywhere in range.', shape: [plain(0, 0, 2.6, 2.6, 0.1, '#5e6670'), box(-0.8, 0.8, 1, 0.8, 0.6, '#c8483b'), cyl(0.5, -0.4, 0.5, 0.05, '#ffffff', 0.1)] },
  { id: 'shelter', cat: 'fire', name: 'Emergency Shelter', cost: 50000, upkeep: 1500, w: 2, d: 2, radius: 30, shelter: 400, workers: 3, milestone: 7, devNode: 'disaster_shelter',
    desc: 'Citizens nearby take cover during disasters.', shape: [box(0, 0, 1.6, 1.6, 0.5, '#8d9a8a'), dome(0, 0, 0.6, '#9fae9b', 0.5)] },
  { id: 'warning', cat: 'fire', name: 'Early Disaster Warning System', cost: 120000, upkeep: 2500, w: 2, d: 2, unique: true, warning: true, workers: 4, milestone: 9, devNode: 'disaster_warning',
    desc: 'Warns citizens about incoming disasters city-wide so they can evacuate.', shape: [box(0, 0, 1.2, 1.2, 0.6, '#d8d4cc'), cyl(0, 0, 0.06, 2.4, '#999'), dome(0, 0, 0.35, '#e8e8e8', 2.4)] },

  // ------------------------------------------------------------- police & administration
  { id: 'police', cat: 'police', name: 'Police Station', cost: 40000, upkeep: 2200, w: 2, d: 2, radius: 26, cells: 20, patrol: 1, workers: 14, milestone: 1,
    desc: 'Lowers crime and catches criminals nearby.', shape: [box(0, 0.1, 1.7, 1.5, 1, '#4a6fb5'), plain(0, 0.86, 1.6, 0.04, 0.12, '#ffffff', 0.7)] },
  { id: 'policehq', cat: 'police', name: 'Police Headquarters', cost: 220000, upkeep: 9000, w: 3, d: 3, radius: 50, cells: 120, patrol: 2, workers: 50, milestone: 7, devNode: 'police_hq',
    desc: 'Large coverage and holding cells.', shape: [box(0, 0.3, 2.6, 2, 2.4, '#3f5f9f'), box(0, -0.8, 1.4, 0.8, 3.2, '#4a6fb5')] },
  { id: 'prison', cat: 'police', name: 'Prison', cost: 260000, upkeep: 9000, w: 4, d: 4, prison: 600, workers: 40, milestone: 8, devNode: 'police_prison',
    desc: 'Holds convicted criminals so they are off the streets.', shape: [lawn(3.6, 3.6, '#8f948f'), box(0, 0, 2.2, 2.2, 1.2, '#9a9a94'), ...[[-1.7, 0], [1.7, 0]].map(([x]) => plain(x, 0, 0.1, 3.6, 0.6, '#6c6c66')), ...[-1.7, 1.7].map((z) => plain(0, z, 3.6, 0.1, 0.6, '#6c6c66'))] },
  { id: 'cityhall', cat: 'police', name: 'City Hall', cost: 150000, upkeep: 6000, w: 3, d: 3, unique: true, cityHall: true, radius: 30, workers: 30, milestone: 3,
    desc: 'Lowers loan interest by 1%, raises well-being nearby and reduces crime city-wide a little.',
    shape: [box(0, 0.2, 2.6, 1.8, 1.5, '#e8e1d0'), dome(0, 0.2, 0.7, '#7fa8b8', 1.5), ...[-0.9, -0.3, 0.3, 0.9].map((x) => cyl(x, 1.1, 0.1, 1.4, '#f4efe2'))] },
  { id: 'welfare', cat: 'police', name: 'Welfare Office', cost: 35000, upkeep: 2500, w: 2, d: 2, radius: 30, welfare: true, workers: 8, milestone: 4,
    desc: 'Improves well-being of poor households nearby.', shape: [box(0, 0, 1.6, 1.4, 1, '#d9c9a8'), plain(0, 0.72, 1, 0.04, 0.2, '#5fa36a', 0.6)] },
  { id: 'bank', cat: 'police', name: 'Central Bank', cost: 600000, upkeep: 10000, w: 3, d: 3, unique: true, centralBank: true, workers: 40, milestone: 10, devNode: 'admin_bank',
    desc: 'Lowers loan interest by 2% and boosts office efficiency.', shape: [box(0, 0.2, 2.6, 2, 2.2, '#d8d2c2'), roof(0, 0.2, 2.7, 2.1, 0.5, '#b9b19c', 2.2), ...[-0.9, -0.3, 0.3, 0.9].map((x) => cyl(x, 1.15, 0.1, 2.1, '#efe9da'))] },

  // ------------------------------------------------------------- education
  { id: 'elementary', cat: 'education', name: 'Elementary School', cost: 50000, upkeep: 2500, w: 3, d: 2, radius: 30, students: 300, eduLevel: 1, workers: 15, milestone: 1,
    desc: 'Children learn here (education level 1).', shape: [box(0, 0.2, 2.6, 1.2, 0.8, '#c4795a'), roof(0, 0.2, 2.7, 1.3, 0.35, '#5d5f63', 0.8)] },
  { id: 'highschool', cat: 'education', name: 'High School', cost: 140000, upkeep: 5000, w: 3, d: 3, radius: 40, students: 500, eduLevel: 2, workers: 30, milestone: 4,
    desc: 'Teens study here (education level 2).', shape: [box(0, 0.3, 2.6, 1.8, 1.2, '#b9694c'), lawn(2.8, 0.8, '#6f9f4e')] },
  { id: 'college', cat: 'education', name: 'College', cost: 400000, upkeep: 11000, w: 4, d: 3, students: 900, eduLevel: 3, cityWide: true, workers: 60, milestone: 7, devNode: 'edu_college',
    desc: 'City-wide. Adults study here (education level 3).', shape: [box(0, 0.3, 3.4, 1.8, 1.6, '#c99b74'), box(-1.2, -0.8, 1, 0.8, 2.2, '#bb8a63')] },
  { id: 'university', cat: 'education', name: 'University', cost: 900000, upkeep: 20000, w: 5, d: 4, students: 1500, eduLevel: 4, cityWide: true, workers: 100, milestone: 9, devNode: 'edu_university',
    desc: 'City-wide. Highest education (level 4). Boosts office demand.',
    shape: [box(0, 0.6, 4.4, 1.8, 1.8, '#d8c8a8'), dome(0, 0.6, 0.9, '#5f7f8f', 1.8), box(-1.6, -1.1, 1, 1, 2.6, '#cbb894'), lawn(4.6, 3.6, '#6f9f4e')] },
  { id: 'research', cat: 'education', name: 'Research Center', cost: 500000, upkeep: 15000, w: 3, d: 3, research: true, unique: true, workers: 60, milestone: 10, devNode: 'edu_research',
    desc: 'Grants +1 development point every week.', shape: [box(0, 0, 2.6, 2.6, 1.4, '#cfd8e3'), dome(0, 0, 0.9, '#e9eef3', 1.4)] },

  // ------------------------------------------------------------- parks & recreation
  { id: 'pocketpark', cat: 'parks', name: 'Pocket Park', cost: 4000, upkeep: 200, w: 1, d: 1, radius: 7, leisure: 0.5, attract: 1, milestone: 0,
    desc: 'Tiny green space.', shape: [lawn(0.95, 0.95), ...trees([[0.2, 0.2], [-0.25, -0.2]], 0.45)] },
  { id: 'playground', cat: 'parks', name: 'Playground', cost: 9000, upkeep: 350, w: 2, d: 1, radius: 9, leisure: 0.7, attract: 1, family: true, milestone: 1,
    desc: 'Families love it.', shape: [lawn(1.9, 0.95, '#c8b77a'), plain(-0.4, 0, 0.4, 0.3, 0.3, '#e05a47'), plain(0.4, 0, 0.3, 0.3, 0.45, '#3f8fd0')] },
  { id: 'plaza', cat: 'parks', name: 'Town Plaza', cost: 14000, upkeep: 450, w: 2, d: 2, radius: 10, leisure: 0.7, attract: 2, milestone: 2,
    desc: 'Paved square with a fountain.', shape: [lawn(1.9, 1.9, '#c9c3b5'), cyl(0, 0, 0.35, 0.15, '#9fc6e8'), ...trees([[-0.7, -0.7], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7]], 0.4)] },
  { id: 'park', cat: 'parks', name: 'Town Park', cost: 22000, upkeep: 700, w: 3, d: 3, radius: 13, leisure: 1, attract: 3, milestone: 2,
    desc: 'A big park with trees and a pond.', shape: [lawn(2.9, 2.9), cyl(0.5, -0.4, 0.6, 0.04, '#3aa0ff'), ...trees([[-1, -1], [-1, 0.2], [-0.2, 1], [1, 1], [0.9, -1.1], [-0.4, -0.3]], 0.6)] },
  { id: 'sports', cat: 'parks', name: 'Sports Field', cost: 45000, upkeep: 1500, w: 4, d: 3, radius: 16, leisure: 1.2, attract: 4, milestone: 4,
    desc: 'Team sports for the neighbourhood.', shape: [lawn(3.9, 2.9, '#5fae4a'), plain(0, 0, 2.8, 1.8, 0.07, '#7fc35a'), plain(-1.5, 0, 0.1, 0.6, 0.4, '#ffffff'), plain(1.5, 0, 0.1, 0.6, 0.4, '#ffffff')] },
  { id: 'garden', cat: 'parks', name: 'Botanical Garden', cost: 160000, upkeep: 4500, w: 4, d: 4, radius: 22, leisure: 1.4, attract: 12, unique: true, milestone: 7,
    desc: 'A city landmark that draws tourists.', shape: [lawn(3.9, 3.9, '#6fae4a'), dome(0, 0, 1.2, '#cfe8f0', 0), ...trees([[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4], [0, 1.6], [0, -1.6]], 0.55)] },
  { id: 'stadium', cat: 'parks', name: 'Stadium', cost: 700000, upkeep: 14000, w: 6, d: 5, radius: 30, leisure: 1.5, attract: 25, unique: true, milestone: 11,
    pollution: { noise: 0.8 }, desc: 'Huge tourist magnet. Loud on game days.',
    shape: [cyl(0, 0, 2.4, 1.4, '#cfd2d6'), cyl(0, 0, 1.9, 1.45, '#5fae4a'), plain(0, 0, 0.1, 0.1, 0.01, '#fff', 1.45)] },
  { id: 'wheel', cat: 'parks', name: 'Ferris Wheel', cost: 260000, upkeep: 6000, w: 3, d: 2, radius: 18, leisure: 1.2, attract: 15, unique: true, milestone: 9,
    desc: 'An attraction that boosts tourism.', shape: [lawn(2.9, 1.9, '#c9c3b5'), cyl(0, 0, 1.4, 0.15, '#e05a47', 1.6), cyl(0, 0, 0.08, 1.6, '#888')] },

  // Hotels: tourists who can stay the night come on top of the day visitors, spend more in
  // the shops and pay for their room (see tourismDaily in sim/companies.js). Guests pick the
  // hotels near parks and landmarks first; a resort also likes a view of the water.
  { id: 'motel', cat: 'parks', group: 'Hotels', name: 'Motel', cost: 50000, upkeep: 800, w: 2, d: 2, rooms: 40, roomRate: 35, workers: 6, waterUse: 120, milestone: 2,
    desc: 'Cheap rooms by the road. Tourists who have somewhere to stay come on top of the day visitors, spend more in the shops and pay for their room.',
    shape: [plain(0, 0, 1.95, 1.95, 0.04, '#6f7174'), box(0, -0.5, 1.8, 0.75, 0.62, '#ead8b4'), plain(0, -0.08, 1.8, 0.12, 0.04, '#8a5a3c', 0.31), roof(0, -0.5, 1.9, 0.85, 0.22, '#9c4f2e', 0.62),
      ...[-0.6, -0.2, 0.2].map((x) => plain(x, 0.45, 0.03, 0.5, 0.01, '#e8e8e8', 0.04)), cyl(0.82, 0.78, 0.03, 0.9, '#5a5a5a'), plain(0.82, 0.78, 0.06, 0.42, 0.22, '#e8473a', 0.8)] },
  { id: 'hotel', cat: 'parks', group: 'Hotels', name: 'Hotel', cost: 240000, upkeep: 3500, w: 3, d: 3, rooms: 150, roomRate: 60, workers: 30, waterUse: 450, milestone: 4,
    desc: 'A city hotel tower. Guests fill it when there are parks and landmarks to see nearby.',
    shape: [plain(0, 0, 2.9, 2.9, 0.05, '#bdb6aa'), box(0, 0.15, 2.7, 2, 0.7, '#d9cfbf'), plain(0, 1.3, 1.3, 0.5, 0.06, '#7a2633', 0.55),
      box(0, -0.25, 1.9, 1.3, 4.4, '#9cb8c8', 0.7), plain(0, -0.25, 2, 1.4, 0.15, '#e9e4da', 5.1), plain(0, 0.42, 1.1, 0.05, 0.3, '#f2c94c', 4.7)] },
  { id: 'resort', cat: 'parks', group: 'Hotels', name: 'Resort Hotel', cost: 900000, upkeep: 10000, w: 4, d: 4, rooms: 280, roomRate: 110, resort: true, workers: 70, waterUse: 900, milestone: 7,
    desc: 'Luxury rooms around a pool: the dearest stay in town. Best beside the water, parks and landmarks.',
    shape: [lawn(3.95, 3.95, '#86b862'), box(-0.5, -1.15, 2.8, 1.2, 2.2, '#f2ece0'), plain(-0.5, -1.15, 2.9, 1.3, 0.1, '#c9b48a', 2.2), box(1.35, 0.1, 1.1, 2.4, 1.4, '#f2ece0'), plain(1.35, 0.1, 1.2, 2.5, 0.1, '#c9b48a', 1.4),
      plain(-0.55, 0.45, 2.1, 1.3, 0.03, '#e7dcc4', 0.06), plain(-0.55, 0.45, 1.7, 0.9, 0.02, '#3cc4e6', 0.08), ...[-1.25, -0.85, -0.45, -0.05].map((x) => plain(x, 1.02, 0.14, 0.24, 0.05, '#ffffff', 0.09)),
      plain(0.3, 1.75, 1.2, 0.4, 0.02, '#bdb6aa', 0.06), ...trees([[-1.75, 1.6], [-1.75, 0.3], [-0.2, 1.6], [0.95, 1.65]], 0.5)] },

  // ------------------------------------------------------------- communications
  { id: 'postoffice', cat: 'comms', name: 'Post Office', cost: 25000, upkeep: 1500, w: 2, d: 2, radius: 28, mail: 900, workers: 8, milestone: 2,
    desc: 'Collects and delivers mail nearby.', shape: [box(0, 0.1, 1.6, 1.4, 0.9, '#e7c34f'), plain(0, 0.82, 1.2, 0.04, 0.2, '#2f5ba8', 0.6)] },
  { id: 'sorting', cat: 'comms', name: 'Post Sorting Facility', cost: 150000, upkeep: 5000, w: 4, d: 3, radius: 60, mail: 4000, workers: 30, milestone: 6, devNode: 'comms_sorting',
    desc: 'Handles mail for a large area.', shape: [box(0, 0.3, 3.4, 1.8, 1.2, '#d9b54a'), plain(0, -1.1, 3, 0.6, 0.3, '#5e6670')] },
  { id: 'radiomast', cat: 'comms', name: 'Radio Mast', cost: 12000, upkeep: 600, w: 1, d: 1, radius: 24, net: 400, workers: 1, milestone: 2,
    desc: 'Internet for nearby buildings.', shape: [cyl(0, 0, 0.05, 2.6, '#d24a3a'), plain(0, 0, 0.3, 0.3, 0.2, '#9a9a9a')] },
  { id: 'telecom', cat: 'comms', name: 'Telecom Tower', cost: 120000, upkeep: 3500, w: 2, d: 2, radius: 55, net: 3000, workers: 6, milestone: 6, devNode: 'comms_telecom',
    desc: 'High-capacity internet over a wide area.', shape: [cyl(0, 0, 0.18, 5.5, '#e9e9e9'), cyl(0, 0, 0.45, 0.4, '#d24a3a', 4.4), plain(0, 0, 1.2, 1.2, 0.3, '#9a9a9a')] },
];

export const SERVICES = {};
for (const s of S) {
  s.kind = 'service';
  SERVICES[s.id] = s;
}
export const SERVICE_LIST = S;
registerDefs('service', SERVICES);

// Road maintenance lives with transport; transport buildings are added in data/transport.js.
