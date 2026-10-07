// Map presets. Each one picks a terrain style, a climate and which outside connections
// exist. Everything is generated procedurally from the seed.
export const CLIMATES = {
  temperate: { name: 'Temperate', minT: 2, maxT: 28, rain: 0.35, snow: true, dryness: 0.4, wind: 0.6 },
  continental: { name: 'Continental', minT: -14, maxT: 26, rain: 0.3, snow: true, dryness: 0.45, wind: 0.5 },
  polar: { name: 'Polar', minT: -24, maxT: 15, rain: 0.25, snow: true, dryness: 0.3, wind: 0.8 },
  warm: { name: 'Warm', minT: 9, maxT: 34, rain: 0.25, snow: false, dryness: 0.6, wind: 0.5 },
  hot: { name: 'Arid', minT: 4, maxT: 38, rain: 0.12, snow: false, dryness: 0.85, wind: 0.6 },
};

// Every map's starting area (the 3 × 3 tiles in the middle) has buildable land, water you
// can pump from and drain sewage into far enough apart, a little forest, patches of the map's
// main resources, the highway, a rail stub and the outside power line.
// river: where the style's river runs (fraction of the width); start: an extra lake or bay
// (cells from the centre) with a channel to the map edge; startResources: patches to add.
export const MAPS = [
  { id: 'isles', name: 'Emerald Isles', style: 'archipelago', climate: 'temperate', theme: 'eu', seed: 1107, connections: { road: true, rail: true, ship: true, air: true },
    resources: { fertile: 0.6, forest: 0.7, ore: 0.3, oil: 0.2, groundwater: 0.6 }, start: { cx: 15, cy: -9, rx: 10, ry: 7, to: 'east', width: 3 }, startResources: ['fertile', 'ore'],
    desc: 'Islands linked by bridges. A lagoon cuts into the home island; the current runs east. Little flat land.' },
  { id: 'highlands', name: 'Heather Highlands', style: 'highlands', climate: 'temperate', theme: 'eu', seed: 2291, connections: { road: true, rail: true, ship: true, air: true },
    resources: { fertile: 0.5, forest: 0.9, ore: 0.6, oil: 0.2, groundwater: 0.7 }, river: { offset: 0.4 }, startResources: ['ore', 'forest'],
    desc: 'Rolling hills with a river winding through town (it flows south). Rich in forests and ore.' },
  { id: 'lakes', name: 'Thousand Lakes', style: 'lakeland', climate: 'continental', theme: 'eu', seed: 3343, connections: { road: true, rail: true, ship: false, air: true },
    resources: { fertile: 0.6, forest: 0.9, ore: 0.3, oil: 0.1, groundwater: 0.9 }, start: { cx: 9, cy: 4, rx: 11, ry: 8, to: 'south', width: 2 }, startResources: ['fertile', 'ore'],
    desc: 'Cold winters, a lake in town draining south, plenty of groundwater. No sea access.' },
  { id: 'alpine', name: 'Alpine Valley', style: 'mountain', climate: 'polar', theme: 'eu', seed: 4517, connections: { road: true, rail: true, ship: false, air: true },
    resources: { fertile: 0.3, forest: 0.8, ore: 0.9, oil: 0.1, groundwater: 0.5 }, river: { offset: 0.57 }, startResources: ['ore', 'fertile'],
    desc: 'A narrow valley between snowy peaks, a mountain river running south through it. Rich ore.' },
  { id: 'delta', name: 'Delta Lowlands', style: 'delta', climate: 'warm', theme: 'na', seed: 5651, connections: { road: true, rail: true, ship: true, air: true },
    resources: { fertile: 1, forest: 0.4, ore: 0.2, oil: 0.6, groundwater: 0.8 }, startResources: ['oil', 'fertile'],
    desc: 'Flat fertile land split by river channels flowing south. Watch the water pollution downstream.' },
  { id: 'coast', name: 'Sunny Coast', style: 'peninsula', climate: 'warm', theme: 'na', seed: 6781, connections: { road: true, rail: true, ship: true, air: true },
    resources: { fertile: 0.5, forest: 0.5, ore: 0.3, oil: 0.7, groundwater: 0.4 }, start: { cx: -4, cy: 13, rx: 9, ry: 6, to: 'east', width: 3 }, startResources: ['oil', 'fertile'],
    desc: 'A peninsula with sea on three sides and a bay reaching into town (the current runs south). Warm and oil-rich.' },
  { id: 'prairie', name: 'Open Prairie', style: 'plains', climate: 'continental', theme: 'na', seed: 7919, connections: { road: true, rail: true, ship: false, air: true },
    resources: { fertile: 1, forest: 0.3, ore: 0.4, oil: 0.8, groundwater: 0.6 }, river: { offset: 0.6 }, startResources: ['oil', 'forest'],
    desc: 'Wide open flatland with one river through town, flowing south. Easy to build on.' },
  { id: 'mesa', name: 'Red Mesa', style: 'mesa', climate: 'hot', theme: 'na', seed: 8803, connections: { road: true, rail: true, ship: false, air: true },
    resources: { fertile: 0.2, forest: 0.1, ore: 0.8, oil: 1, groundwater: 0.3 }, river: { offset: 0.58, amp: 0.1 }, startResources: ['oil', 'ore'],
    desc: 'Hot, dry plateaus cut by a canyon river (flowing south). Wildfires and scarce water.' },
  { id: 'fjords', name: 'Northern Fjords', style: 'fjords', climate: 'polar', theme: 'eu', seed: 9161, connections: { road: true, rail: true, ship: true, air: true },
    resources: { fertile: 0.3, forest: 0.8, ore: 0.6, oil: 0.4, groundwater: 0.6 }, start: { cx: -6, cy: -11, rx: 9, ry: 6, to: 'east', width: 3 }, startResources: ['ore', 'forest'],
    desc: 'Deep sea inlets between steep cliffs, one reaching into town (the current runs east). Windy.' },
];

export const THEMES = {
  eu: { name: 'European', roof: 'pitched', palette: ['#e8d8c3', '#d9c2a5', '#f0e6d6', '#c9b49a', '#e3d1bd', '#bfa98f'], roofColors: ['#a4472d', '#8b3a2a', '#5a5f66', '#7a3b2e'] },
  na: { name: 'North American', roof: 'mixed', palette: ['#dedbd2', '#c7cdd4', '#e9e1cf', '#b9c1c9', '#d6cbb6', '#a9b3bb'], roofColors: ['#4b4f57', '#6a5f55', '#3c4148', '#7d7468'] },
};
