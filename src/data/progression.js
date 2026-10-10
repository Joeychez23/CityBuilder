// Milestones (20 levels of city growth) and the development tree.
// XP comes from population, happiness and building things. Each milestone pays money,
// development points and expansion permits (for map tiles: the map has 17 × 17 of them),
// and raises the loan limit.
export const MILESTONES = [
  { name: 'Founding', xp: 0, money: 0, dev: 0, permits: 0, loan: 100000 },
  { name: 'Hamlet', xp: 100, money: 25000, dev: 1, permits: 2, loan: 150000, unlocks: 'Healthcare, fire, police, schools, row housing, road upgrades' },
  { name: 'Small Village', xp: 260, money: 30000, dev: 2, permits: 2, loan: 250000, unlocks: 'Medium density, specialized industry, medium roads, parks, motels, post, radio' },
  { name: 'Village', xp: 520, money: 40000, dev: 2, permits: 2, loan: 400000, unlocks: 'Offices, highways, City Hall, buses, firewatch, batteries' },
  { name: 'Large Village', xp: 900, money: 50000, dev: 3, permits: 2, loan: 600000, unlocks: 'Low-rent housing, welfare, high school, hotels, taxis, bus lanes' },
  { name: 'Small Town', xp: 1400, money: 60000, dev: 3, permits: 4, loan: 800000, unlocks: 'Mixed housing, trains, pollution management' },
  { name: 'Town', xp: 2100, money: 75000, dev: 4, permits: 4, loan: 1100000, unlocks: 'High density commercial, large industry, trams, large parking garages, pre-release programs' },
  { name: 'Busy Town', xp: 3000, money: 90000, dev: 4, permits: 4, loan: 1500000, unlocks: 'High density housing, garden, resort hotels, cargo trains, city promotion' },
  { name: 'Large Town', xp: 4200, money: 110000, dev: 5, permits: 4, loan: 2000000, unlocks: 'High density office, subway, harbors, high-speed highways' },
  { name: 'Small City', xp: 5600, money: 130000, dev: 6, permits: 6, loan: 2600000, unlocks: 'University, high-rise apartments, Ferris wheel, cargo harbor, warning system' },
  { name: 'City', xp: 7300, money: 150000, dev: 7, permits: 6, loan: 3300000, unlocks: 'Central bank, research center, airport' },
  { name: 'Busy City', xp: 9300, money: 175000, dev: 8, permits: 6, loan: 4200000, unlocks: 'Stadium' },
  { name: 'Large City', xp: 11800, money: 200000, dev: 10, permits: 8, loan: 5200000, unlocks: 'Nuclear power, combustion engine ban' },
  { name: 'Big City', xp: 14800, money: 225000, dev: 12, permits: 8, loan: 6500000 },
  { name: 'Grand City', xp: 18500, money: 250000, dev: 14, permits: 8, loan: 8000000 },
  { name: 'Metropolis', xp: 23000, money: 300000, dev: 16, permits: 10, loan: 10000000 },
  { name: 'Thriving Metropolis', xp: 28500, money: 340000, dev: 18, permits: 10, loan: 12500000 },
  { name: 'Capital', xp: 35000, money: 380000, dev: 22, permits: 10, loan: 15500000 },
  { name: 'Megacity', xp: 43000, money: 420000, dev: 25, permits: 12, loan: 19000000 },
  { name: 'Global City', xp: 52000, money: 460000, dev: 28, permits: 12, loan: 22500000 },
  { name: 'Megalopolis', xp: 63000, money: 500000, dev: 30, permits: 16, loan: 26100000 },
];

// Development tree: tier costs 1 / 2 / 4 / 8 points. `requires` = node keys needed first.
// Nodes either unlock buildings (referenced by devNode in data files) or grant perks.
export const DEV_TREE = {
  Electricity: [
    { key: 'power_battery', name: 'Emergency Batteries', tier: 1, milestone: 3 },
    { key: 'power_efficiency', name: 'Efficient Turbines', tier: 1, perk: '+10% power plant output', milestone: 2 },
    { key: 'power_gas', name: 'Gas Power', tier: 2, requires: ['power_efficiency'], milestone: 4 },
    { key: 'power_solar', name: 'Solar Power', tier: 2, requires: ['power_efficiency'], milestone: 5 },
    { key: 'power_geo', name: 'Geothermal Power', tier: 3, requires: ['power_solar'], milestone: 8 },
    { key: 'power_nuclear', name: 'Nuclear Power', tier: 4, requires: ['power_gas'], milestone: 12 },
  ],
  'Water & Garbage': [
    { key: 'water_efficiency', name: 'High-Capacity Pumps', tier: 1, perk: '+15% water pumped', milestone: 2 },
    { key: 'water_treatment', name: 'Wastewater Treatment', tier: 2, requires: ['water_efficiency'], milestone: 4 },
    { key: 'garbage_trucks', name: 'Bigger Garbage Trucks', tier: 1, perk: '+20% garbage collection', milestone: 2 },
    { key: 'garbage_incinerator', name: 'Incineration', tier: 2, requires: ['garbage_trucks'], milestone: 5 },
    { key: 'garbage_recycling', name: 'Recycling', tier: 3, requires: ['garbage_incinerator'], milestone: 6 },
  ],
  'Health & Safety': [
    { key: 'health_research', name: 'Medical Research', tier: 1, perk: '+15% healthcare effect', milestone: 2 },
    { key: 'health_hospital', name: 'Hospitals', tier: 2, requires: ['health_research'], milestone: 6 },
    { key: 'health_crematorium', name: 'Crematoriums', tier: 2, milestone: 5 },
    { key: 'fire_station', name: 'Fire Stations', tier: 2, milestone: 6 },
    { key: 'fire_heli', name: 'Firefighting Helicopters', tier: 3, requires: ['fire_station'], milestone: 8 },
    { key: 'disaster_shelter', name: 'Emergency Shelters', tier: 2, milestone: 7 },
    { key: 'disaster_warning', name: 'Early Warning System', tier: 4, requires: ['disaster_shelter'], milestone: 9 },
    { key: 'police_patrol', name: 'Community Policing', tier: 1, perk: '+20% crime reduction', milestone: 2 },
    { key: 'police_hq', name: 'Police Headquarters', tier: 2, requires: ['police_patrol'], milestone: 7 },
    { key: 'police_prison', name: 'Prisons', tier: 3, requires: ['police_hq'], milestone: 8 },
    { key: 'admin_bank', name: 'Central Bank', tier: 4, milestone: 10 },
  ],
  'Education & Comms': [
    { key: 'edu_scholarships', name: 'Scholarships', tier: 1, perk: 'Faster studies', milestone: 2 },
    { key: 'edu_college', name: 'Colleges', tier: 2, requires: ['edu_scholarships'], milestone: 7 },
    { key: 'edu_university', name: 'Universities', tier: 3, requires: ['edu_college'], milestone: 9 },
    { key: 'edu_research', name: 'Research Center', tier: 4, requires: ['edu_university'], milestone: 10 },
    { key: 'comms_fiber', name: 'Fiber Optics', tier: 1, perk: '+25% telecom range', milestone: 2 },
    { key: 'comms_telecom', name: 'Telecom Towers', tier: 2, requires: ['comms_fiber'], milestone: 6 },
    { key: 'comms_sorting', name: 'Mail Sorting', tier: 2, milestone: 6 },
    { key: 'parks_care', name: 'Park Rangers', tier: 1, perk: '+15% leisure', milestone: 2 },
  ],
  'Roads & Transport': [
    { key: 'roads_asphalt', name: 'Durable Asphalt', tier: 1, perk: '−40% road wear', milestone: 1 },
    { key: 'roads_highway', name: 'Highways', tier: 1, milestone: 3 },
    { key: 'roads_large', name: 'Large Roads', tier: 2, milestone: 5 },
    { key: 'transit_priority', name: 'Transit Priority', tier: 1, perk: 'Transit is more attractive', milestone: 3 },
    { key: 'transit_train', name: 'Passenger Trains', tier: 2, milestone: 5 },
    { key: 'transit_tram', name: 'Trams', tier: 2, requires: ['transit_priority'], milestone: 6 },
    { key: 'transit_cargo', name: 'Cargo Transport', tier: 2, milestone: 7 },
    { key: 'transit_subway', name: 'Subway', tier: 3, requires: ['transit_train'], milestone: 8 },
    { key: 'transit_ship', name: 'Harbors', tier: 3, milestone: 8 },
    { key: 'transit_air', name: 'Airport', tier: 4, milestone: 10 },
  ],
};
export const TIER_COST = { 1: 1, 2: 2, 3: 4, 4: 8 };
export const DEV_NODES = Object.values(DEV_TREE).flat();

export const hasPerk = (state, key) => state.options.unlockAll || state.progression.dev.includes(key);
