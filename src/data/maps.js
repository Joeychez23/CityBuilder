// Map presets. Each one picks an island, a climate and which outside connections exist.
// Everything is generated procedurally from the seed.
export const CLIMATES = {
  temperate: { name: 'Temperate', minT: 2, maxT: 28, rain: 0.35, snow: true, dryness: 0.4, wind: 0.6 },
  continental: { name: 'Continental', minT: -14, maxT: 26, rain: 0.3, snow: true, dryness: 0.45, wind: 0.5 },
  polar: { name: 'Polar', minT: -24, maxT: 15, rain: 0.25, snow: true, dryness: 0.3, wind: 0.8 },
  warm: { name: 'Warm', minT: 9, maxT: 34, rain: 0.25, snow: false, dryness: 0.6, wind: 0.5 },
  hot: { name: 'Arid', minT: 4, maxT: 38, rain: 0.12, snow: false, dryness: 0.85, wind: 0.6 },
};

// Every map is an island (or a group of them) out in the open sea: see sim/islands.js for
// each one's shape (`island`). Its starting area (the 3 × 3 tiles in the middle) has
// buildable land, water you can pump from and drain sewage into far enough apart, a little
// forest, patches of the map's main resources, the highway (in from the west over the sea),
// a rail stub (from `rail.side`, default the north, `rail.at` cells across from the middle)
// and the outside power line. flow: which way the water's current carries pollution.
// start: an extra lake or bay (cells from the centre) with a channel out to the sea;
// startResources: patches to add.
const ALL = { road: true, rail: true, ship: true, air: true };
export const MAPS = [
  { id: 'emerald', name: 'Emerald Isle', island: 'emerald', climate: 'temperate', theme: 'eu', seed: 1213, flow: [0, 1], rail: { at: -24 }, connections: ALL,
    resources: { fertile: 0.7, forest: 0.6, ore: 0.4, oil: 0.2, groundwater: 0.7 }, startResources: ['fertile', 'ore'],
    desc: 'A big green island of rolling hills. A river rises in the northern hills and flows south through town to the sea.' },
  { id: 'twins', name: 'Twin Sisters', island: 'twins', climate: 'warm', theme: 'na', seed: 2357, flow: [0, 1], rail: { at: 22 }, connections: ALL,
    resources: { fertile: 0.7, forest: 0.6, ore: 0.5, oil: 0.6, groundwater: 0.5 }, startResources: ['oil', 'forest'],
    desc: 'Two islands with a narrow strait between them, right through town (the current runs south). The highway lands on the hilly west island, the railway on the flat east one.' },
  { id: 'lagoon', name: 'Coral Lagoon', island: 'lagoon', climate: 'warm', theme: 'na', seed: 3469, flow: [1, 0], connections: { road: true, rail: false, ship: true, air: true },
    resources: { fertile: 0.4, forest: 0.35, ore: 0.05, oil: 0.4, groundwater: 0.25 }, startResources: ['fertile', 'oil'],
    desc: 'A ring of low, sandy land around a turquoise lagoon, with reefs all round. The highway hops in along a chain of keys; it\'s too far out for a railway.' },
  { id: 'volcano', name: 'Fire Mountain', island: 'volcano', climate: 'warm', theme: 'eu', seed: 4583, flow: [0, 1], rail: { at: -24 }, connections: ALL,
    resources: { fertile: 0.9, forest: 0.6, ore: 0.8, oil: 0.1, groundwater: 0.4 }, startResources: ['ore', 'fertile'],
    desc: 'A volcano towers over the north-east, ridged and gullied down to the sea; its ash made the lowlands fertile. A stream runs south through town.' },
  { id: 'frost', name: 'Frost Fjords', island: 'frost', climate: 'polar', theme: 'eu', seed: 5693, flow: [1, 0], connections: ALL,
    resources: { fertile: 0.3, forest: 0.8, ore: 0.7, oil: 0.4, groundwater: 0.6 }, startResources: ['ore', 'forest'],
    desc: 'A rugged, snowy island of cliffs and peaks cut by deep fjords. Town sits at the head of one that opens to the east (the current runs east). Windy and cold.' },
  { id: 'redrock', name: 'Red Rock Isle', island: 'redrock', climate: 'hot', theme: 'na', seed: 6793, flow: [0, 1], rail: { at: -24 }, connections: ALL,
    resources: { fertile: 0.2, forest: 0.1, ore: 0.8, oil: 1, groundwater: 0.3 }, startResources: ['oil', 'ore'],
    desc: 'A desert island of stepped mesas behind sea cliffs, with a canyon river winding south through town. Oil-rich and dry; watch for wildfires.' },
  { id: 'thousand', name: 'Thousand Isles', island: 'thousand', climate: 'temperate', theme: 'eu', seed: 7907, flow: [1, 0], connections: ALL,
    resources: { fertile: 0.6, forest: 0.7, ore: 0.3, oil: 0.2, groundwater: 0.6 }, start: { cx: 15, cy: -9, rx: 10, ry: 7, to: 'east', width: 3 }, startResources: ['fertile', 'ore'],
    desc: 'Islands of every size scattered across the sea: to grow, bridge over to the next one. A lagoon reaches into town (the current runs east).' },
  { id: 'longkey', name: 'Long Key', island: 'longkey', climate: 'warm', theme: 'na', seed: 8963, flow: [1, 0], rail: { side: 'east', at: -10 }, connections: ALL,
    resources: { fertile: 0.6, forest: 0.5, ore: 0.2, oil: 0.5, groundwater: 0.5 }, start: { cx: 6, cy: 15, rx: 9, ry: 6, to: 'south', width: 3 }, startResources: ['fertile', 'oil'],
    desc: 'A long, narrow island: wooded hills along the north shore, beaches and a barrier island to the south. The highway runs in along it from the west, the railway from the east.' },
  { id: 'lakeisle', name: 'Lake Isle', island: 'lakeisle', climate: 'continental', theme: 'eu', seed: 9029, flow: [0, 1], rail: { side: 'south', at: 10 }, connections: ALL,
    resources: { fertile: 0.6, forest: 0.9, ore: 0.3, oil: 0.1, groundwater: 0.9 }, startResources: ['fertile', 'ore'],
    desc: 'Cold winters, a big lake just north of town and dozens of small ones in the woods. Plenty of groundwater.' },
  { id: 'deltaisle', name: 'Delta Isles', island: 'deltaisle', climate: 'warm', theme: 'na', seed: 10093, flow: [0, 1], connections: ALL,
    resources: { fertile: 1, forest: 0.4, ore: 0.2, oil: 0.6, groundwater: 0.8 }, startResources: ['oil', 'fertile'],
    desc: 'Low, flat, fertile land where a river meets the sea, split by its channels (flowing south) into long strips. Watch the water pollution downstream.' },
  { id: 'highland', name: 'Highland Isle', island: 'highland', climate: 'temperate', theme: 'eu', seed: 11161, flow: [0, 1], connections: ALL,
    resources: { fertile: 0.5, forest: 0.9, ore: 0.6, oil: 0.2, groundwater: 0.7 }, startResources: ['ore', 'forest'],
    desc: 'Heather hills and ridges cut by long lochs, all running south-west to north-east. A sea loch reaches up to town. Rich in forests and ore.' },
  { id: 'grand', name: 'Prairie Isle', island: 'grand', climate: 'continental', theme: 'na', seed: 12251, flow: [0, 1], rail: { at: -24 }, connections: ALL,
    resources: { fertile: 1, forest: 0.3, ore: 0.4, oil: 0.8, groundwater: 0.6 }, startResources: ['oil', 'forest'],
    desc: 'A broad island of open, flat prairie filling most of the map, with one river meandering south through town. The easiest land to build on.' },
  { id: 'peaks', name: 'Glacier Peaks', island: 'peaks', climate: 'polar', theme: 'eu', seed: 13339, flow: [0, 1], rail: { at: -24 }, connections: ALL,
    resources: { fertile: 0.3, forest: 0.8, ore: 0.9, oil: 0.1, groundwater: 0.5 }, startResources: ['ore', 'fertile'],
    desc: 'Snowy peaks either side of a broad valley running down the island; town lies by the valley\'s river (flowing south). The highway comes in over a pass. Rich in ore.' },
];

// The maps from before every map became an island. New cities can't be founded on them, but
// cities that were still open: when one is moved onto a bigger map, its map is made again
// around it (see sim/save.js). Each picks a terrain style (sim/mapgen.js); river: where the
// style's river runs (fraction of the width).
export const LEGACY_MAPS = [
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

// A map by its id, whether it's a current one or an old one
export const mapById = (id) => MAPS.find((m) => m.id === id) || LEGACY_MAPS.find((m) => m.id === id) || null;

export const THEMES = {
  eu: { name: 'European', roof: 'pitched', palette: ['#e8d8c3', '#d9c2a5', '#f0e6d6', '#c9b49a', '#e3d1bd', '#bfa98f'], roofColors: ['#a4472d', '#8b3a2a', '#5a5f66', '#7a3b2e'] },
  na: { name: 'North American', roof: 'mixed', palette: ['#dedbd2', '#c7cdd4', '#e9e1cf', '#b9c1c9', '#d6cbb6', '#a9b3bb'], roofColors: ['#4b4f57', '#6a5f55', '#3c4148', '#7d7468'] },
};
