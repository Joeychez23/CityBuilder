// City-wide and district policies. Effects are applied by the systems that read them
// (traffic, pollution, utilities, wellbeing, transit...). cost = ₡ per day (shown per week).
export const CITY_POLICIES = [
  { key: 'taxiMinFare', name: 'Taxi Minimum Fare', cost: 0, milestone: 4, desc: 'A minimum charge for every taxi ride: more fare income, fewer riders.' },
  { key: 'importServices', name: 'Import City Services', cost: 1500, milestone: 2, desc: 'Neighbouring cities cover police, health, deathcare, garbage and fire gaps — for a fee per call.' },
  { key: 'preRelease', name: 'Pre-Release Programs', cost: 2000, milestone: 6, desc: 'Prisoners get education before release: shorter sentences and less re-offending.' },
  { key: 'pollutionManagement', name: 'Advanced Pollution Management', cost: 0, milestone: 5, desc: 'Industrial filters cut pollution by 30%, but industry produces more garbage and pays more.' },
  { key: 'cityPromotion', name: 'City Promotion', cost: 3000, milestone: 7, desc: 'Advertising raises attractiveness and tourism — and a little crime.' },
  { key: 'highSpeedHighways', name: 'High-Speed Highways', cost: 0, milestone: 8, desc: 'No speed limits on highways: faster flow, more noise and accidents.' },
];

export const DISTRICT_POLICIES = [
  { key: 'energyAwareness', name: 'Energy Consumption Awareness', cost: 300, desc: 'Citizens save 5% electricity.' },
  { key: 'recycling', name: 'Recycling', cost: 400, desc: '20% less garbage, but recycling takes citizens\' time.' },
  { key: 'parkingFee', name: 'Roadside Parking Fee', cost: 0, value: true, min: 1, max: 50, desc: 'Charge for street parking (₡1–50). Earns money and nudges people to transit.' },
  { key: 'speedBumps', name: 'Speed Bumps', cost: 200, desc: 'Slower traffic: fewer accidents and less noise.' },
  { key: 'heavyBan', name: 'Heavy Traffic Ban', cost: 0, desc: 'Trucks avoid the district: less noise and pollution, longer deliveries.' },
  { key: 'gated', name: 'Gated Community', cost: 500, desc: 'Only residents and workers may enter: better well-being, less crime, no through traffic.' },
  { key: 'combustionBan', name: 'Combustion Engine Ban', cost: 300, milestone: 12, desc: 'Fuel-burning vehicles are banned except for locals: far less air pollution.' },
];

export const DISTRICT_COLORS = ['#ff9f43', '#54a0ff', '#5f27cd', '#1dd1a1', '#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3', '#00d2d3', '#c8d6e5'];
