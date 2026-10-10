// Transport buildings: depots, stations, cargo terminals, the airport, road maintenance.
// Bus & tram stops are not buildings; they're markers on road cells (state.stops).
import { registerDefs } from './registry.js';

const box = (x, z, w, d, h, color, y = 0, pool = 'body') => ({ pool, x, z, w, d, h, y, color });
const plain = (x, z, w, d, h, color, y = 0) => box(x, z, w, d, h, color, y, 'plain');
const cyl = (x, z, r, h, color, y = 0) => ({ pool: 'cyl', x, z, w: r * 2, d: r * 2, h, y, color });
const roof = (x, z, w, d, h, color, y) => ({ pool: 'roof', x, z, w, d, h, y, color });
// A multi-storey car park `cells` wide: a deck every 0.55 up to `levels` parking levels
// (the stalls are laid out to match in world/peopleView.js STALLS)
function garageShape(cells, levels) {
  const W = cells - 0.2, e = W / 2 - 0.1, top = (levels - 1) * 0.55;
  const posts = cells > 3 ? [-e, -e / 3, e / 3, e] : [-e, e];
  const P = [box(0, 0, W, W, 0.25, '#9a9893')];
  for (let k = 1; k < levels; k++) P.push(plain(0, 0, W, W, 0.08, '#b5b2ab', k * 0.55));
  for (const x of posts) for (const z of posts) if (Math.abs(x) === e || Math.abs(z) === e) P.push(plain(x, z, 0.18, 0.18, top + 0.1, '#8b8984'));
  P.push(plain(0, W / 2 + 0.02, cells * 0.27, 0.05, 0.4, '#2f55ff', 0.3)); // the blue P sign over the entrance
  return P;
}

const T = [
  { id: 'roadmaint', name: 'Road Maintenance Depot', cost: 30000, upkeep: 1500, w: 2, d: 2, radius: 45, roadMaint: true, workers: 8, milestone: 1,
    desc: 'Repairs worn roads and plows snow nearby.', shape: [box(0, 0.2, 1.7, 1.2, 0.7, '#e3a63a'), plain(0, -0.7, 1.6, 0.5, 0.1, '#55585e')] },
  { id: 'parking', name: 'Parking Lot', cost: 6000, upkeep: 120, w: 2, d: 2, parking: 40, parkReach: 10, milestone: 0,
    desc: 'Workplaces need parking: drivers park here and walk up to 80 m to work. It holds 40 cars; when it\'s full, the drivers left over walk to work from home. Earns the parking fee.',
    // two rows of stalls either side of an aisle (the cars are parked in them by drawParked in world/peopleView.js)
    shape: [plain(0, 0, 1.94, 1.94, 0.06, '#4f5359'), ...[-0.66, 0.66].flatMap((z) => Array.from({ length: 9 }, (_, k) => plain(-0.96 + k * 0.24, z, 0.02, 0.5, 0.07, '#e8e8e8'))), ...[-0.4, 0.4].map((z) => plain(0, z, 1.92, 0.02, 0.07, '#e8e8e8'))] },
  // garages: a parking deck on every storey, with cars on the ground floor and the open roof too
  { id: 'garage', name: 'Parking Garage', cost: 45000, upkeep: 600, w: 3, d: 3, parking: 360, parkReach: 16, milestone: 3,
    desc: 'Six storeys of parking (360 cars) for shopping and office streets: drivers walk up to 128 m to work. When it\'s full, the drivers left over walk to work from home.',
    shape: garageShape(3, 6) },
  { id: 'garage_large', name: 'Large Parking Garage', cost: 110000, upkeep: 1400, w: 4, d: 4, parking: 900, parkReach: 22, milestone: 6,
    desc: 'Eight storeys of parking (900 cars) to serve a whole downtown: drivers walk up to 176 m to work. When it\'s full, the drivers left over walk to work from home.',
    shape: garageShape(4, 8) },
  { id: 'busdepot', name: 'Bus Depot', cost: 45000, upkeep: 2200, w: 3, d: 2, vehicles: 12, mode: 'bus', workers: 15, milestone: 3,
    desc: 'Home of the bus fleet. Needed before bus lines can run.', shape: [box(0, 0.1, 2.8, 1.6, 0.8, '#3f8fd0'), roof(0, 0.1, 2.9, 1.7, 0.2, '#2b5f8c', 0.8)] },
  { id: 'taxidepot', name: 'Taxi Depot', cost: 30000, upkeep: 1500, w: 2, d: 2, vehicles: 10, mode: 'taxi', workers: 12, milestone: 4,
    desc: 'Taxis serve households without a car.', shape: [box(0, 0.1, 1.7, 1.4, 0.6, '#e7c34f')] },
  { id: 'tramdepot', name: 'Tram Depot', cost: 90000, upkeep: 3500, w: 3, d: 3, vehicles: 8, mode: 'tram', workers: 18, milestone: 6, devNode: 'transit_tram',
    desc: 'Home of the trams. Trams run on roads with tram tracks.', shape: [box(0, 0.3, 2.8, 2, 1, '#c94c4c'), roof(0, 0.3, 2.9, 2.1, 0.3, '#7b2f2f', 1)] },
  { id: 'trainstation', name: 'Train Station', cost: 160000, upkeep: 5000, w: 4, d: 2, mode: 'train', station: true, needsRail: true, workers: 20, milestone: 5, devNode: 'transit_train',
    desc: 'Passenger trains. Connect the railway to the outside for intercity travel and tourists.', shape: [box(0, 0.3, 3.8, 1.2, 1, '#c9b79a'), roof(0, 0.3, 3.9, 1.3, 0.4, '#5d5f63', 1), plain(0, -0.6, 3.8, 0.6, 0.15, '#9b9690')] },
  { id: 'cargotrain', name: 'Cargo Train Terminal', cost: 220000, upkeep: 6000, w: 4, d: 3, cargo: 1500, needsRail: true, workers: 25, milestone: 7, devNode: 'transit_cargo',
    desc: 'Moves goods by rail: cheaper imports/exports and fewer trucks.', shape: [box(-0.8, 0.5, 2, 1.4, 1.2, '#8d7a62'), ...[0.6, 1.2].map((x) => box(x, -0.6, 0.5, 1.2, 0.5, '#c0622f', 0, 'plain'))] },
  { id: 'subwaystation', name: 'Subway Station', cost: 120000, upkeep: 3500, w: 2, d: 2, mode: 'subway', station: true, workers: 10, milestone: 8, devNode: 'transit_subway',
    desc: 'Underground stations. Connect them with subway tunnels.', shape: [plain(0, 0, 1.6, 1.6, 0.1, '#c9c3b5'), box(0, 0.4, 0.8, 0.5, 0.45, '#5b5b9f')] },
  { id: 'harbor', name: 'Passenger Harbor', cost: 260000, upkeep: 7000, w: 4, d: 3, mode: 'ship', station: true, needsWater: true, needsShip: true, workers: 20, milestone: 8, devNode: 'transit_ship',
    desc: 'Ferries and cruise ships bring tourists. Needs the sea lane.', shape: [plain(0, -0.5, 3.8, 1.8, 0.3, '#9a958c'), box(-0.6, 0.6, 2, 1, 0.9, '#e8e1d0')] },
  { id: 'cargoharbor', name: 'Cargo Harbor', cost: 420000, upkeep: 9000, w: 5, d: 4, cargo: 3000, needsWater: true, needsShip: true, workers: 35, milestone: 9, devNode: 'transit_cargo',
    desc: 'Ships move large amounts of goods. Needs the sea lane.', shape: [plain(0, -0.6, 4.8, 2.6, 0.3, '#8d8a83'), cyl(-1.5, 0.8, 0.12, 2.6, '#e0a030'), ...[[0, 0.9], [1.2, 0.9]].map(([x, z]) => box(x, z, 0.9, 0.5, 0.5, '#2f7fb3', 0, 'plain'))] },
  { id: 'airport', name: 'Airport', cost: 1200000, upkeep: 22000, w: 8, d: 5, mode: 'air', station: true, cargo: 800, unique: true, workers: 120, milestone: 10, devNode: 'transit_air',
    pollution: { noise: 1.6 }, desc: 'Flights to the world: lots of tourists and some air cargo. Very loud.',
    shape: [plain(0, -0.8, 7.8, 1, 0.08, '#4c4f55'), box(-2, 1.3, 3, 1.4, 1, '#d4d8dd'), cyl(2.5, 1.5, 0.25, 2.4, '#e9ecef'), box(2.5, 1.5, 0.8, 0.8, 0.4, '#5f8fbf', 2.4)] },
];

export const TRANSPORT = {};
for (const t of T) {
  t.kind = 'transport';
  t.cat = 'transport';
  t.color = '#4fc3ff';
  TRANSPORT[t.id] = t;
}
export const TRANSPORT_LIST = T;
registerDefs('transport', TRANSPORT);

// Line types: what network they run on and what they need
export const LINE_TYPES = {
  bus: { name: 'Bus', network: 'road', depot: 'busdepot', capacity: 40, upkeep: 400, speed: 1, color: '#3f8fd0', stopRadius: 7, milestone: 3 },
  tram: { name: 'Tram', network: 'tram', depot: 'tramdepot', capacity: 90, upkeep: 650, speed: 1.1, color: '#c94c4c', stopRadius: 8, milestone: 6, devNode: 'transit_tram' },
  train: { name: 'Train', network: 'rail', station: 'trainstation', capacity: 220, upkeep: 1400, speed: 2, color: '#8d6e5a', stopRadius: 12, milestone: 5, devNode: 'transit_train' },
  subway: { name: 'Subway', network: 'subway', station: 'subwaystation', capacity: 160, upkeep: 1100, speed: 1.8, color: '#7c5bd6', stopRadius: 11, milestone: 8, devNode: 'transit_subway' },
};
