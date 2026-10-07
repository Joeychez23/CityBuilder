// Road types. Costs are per cell (8 m). lanes = lanes in each direction (a one-way road has
// all its lanes going one way). Capacity = vehicles per cell the road carries before it
// starts slowing down (junctions carry less, see sim/traffic.js). Every road also carries
// power lines and water pipes.
//
// The road hierarchy (cls): local streets reach the front doors of homes and small shops;
// collectors gather a neighbourhood's traffic and serve the big buildings; avenues (arterials)
// carry traffic across town; highways link the city to the world. What it means in the game:
//  - high-density buildings only grow beside a collector or bigger (zones.js `needs`)
//  - a local street joining a bigger road gives way (no lights), so the main road keeps
//    moving; where bigger roads meet there are traffic lights (see junctionKind in sim/traffic.js)
//  - every driveway onto an avenue slows its traffic a little (and onto a collector, less)
//  - drivers take the bigger roads for longer trips: local streets are slow
//  - the bigger the road, the more noise for the homes beside it
export const ROADS = {
  1: { id: 1, key: 'gravel', name: 'Gravel Road', cls: 'local', speed: 30, lanes: 1, capacity: 6, cost: 15, upkeep: 0.4, zonable: true, width: 0.62, color: '#9a8b72', noise: 0.6, milestone: 0,
    role: 'Country lane: cheap and slow. For farms, forestry and the edge of town.' },
  2: { id: 2, key: 'small', name: 'Small Road', cls: 'local', speed: 40, lanes: 1, capacity: 10, cost: 40, upkeep: 1, zonable: true, width: 0.7, color: '#4a4d55', noise: 1, milestone: 0,
    role: 'Local street for homes and small shops. Quiet, so homes along it are worth more, but it carries little traffic: join it to a bigger road, not straight to another neighbourhood.' },
  3: { id: 3, key: 'oneway', name: 'One-Way Road', cls: 'collector', speed: 40, lanes: 2, capacity: 12, cost: 40, upkeep: 1, zonable: true, width: 0.62, color: '#4f4a58', noise: 1, oneway: true, milestone: 0,
    role: 'Two lanes one way. A pair of one-way streets moves traffic through a busy centre and serves big buildings like a collector.' },
  4: { id: 4, key: 'medium', name: 'Medium Road', cls: 'collector', speed: 50, lanes: 2, capacity: 22, cost: 90, upkeep: 2.2, zonable: true, width: 0.86, color: '#3f4249', noise: 2, milestone: 2,
    role: 'Collector: gathers a neighbourhood\'s local streets and leads them to the avenues. High-density homes, shops and offices need one in front.' },
  5: { id: 5, key: 'large', name: 'Large Road', cls: 'arterial', speed: 60, lanes: 3, capacity: 36, cost: 160, upkeep: 3.6, zonable: true, width: 0.98, color: '#36383e', noise: 3, milestone: 5, devNode: 'roads_large',
    role: 'Avenue: carries the most traffic across town. Noisy for homes; best lined with shops and offices. Every side street and driveway on it slows it down, so join local streets to collectors instead.' },
  6: { id: 6, key: 'highway', name: 'Highway', cls: 'highway', speed: 100, lanes: 3, capacity: 48, cost: 250, upkeep: 4.5, zonable: false, width: 0.98, color: '#2e3036', noise: 4, milestone: 3, devNode: 'roads_highway',
    role: 'Fastest and biggest, with nothing built along it. Links the city to the outside and its far ends together; join avenues to it.' },
};

// Rank in the hierarchy and its name
export const ROAD_RANK = { local: 0, collector: 1, arterial: 2, highway: 3 };
export const CLASS_NAMES = { local: 'Local street', collector: 'Collector', arterial: 'Avenue', highway: 'Highway' };
export const rankOf = (t) => (t ? ROAD_RANK[ROADS[t].cls] : -1);

export const lanesText = (r) => (r.oneway ? `${r.lanes} lanes one way` : `${r.lanes} lane${r.lanes > 1 ? 's' : ''} each way`);

export const ROAD_LIST = Object.values(ROADS);

// Road upgrades, stored as a bitmask per road cell.
export const UPG = {
  TREES: 1,      // −noise, +land value
  LIGHTS: 2,     // −accidents at night, −crime
  BARRIER: 4,    // sound barrier (highways): big −noise
  BUSLANE: 8,    // buses ignore congestion
  TRAM: 16,      // tram tracks
  ROUNDABOUT: 32,// intersection without lights: better throughput
  TOLL: 64,      // toll booth: every vehicle that passes pays the toll
  POWER: 128,    // power connector: a transformer that feeds a power line into the road's network
};

export const UPGRADES = [
  { bit: UPG.TREES, key: 'trees', name: 'Street Trees', cost: 20, upkeep: 0.2, milestone: 1, desc: 'Trees along the street: less traffic noise and higher land value.' },
  { bit: UPG.LIGHTS, key: 'lights', name: 'Street Lighting', cost: 15, upkeep: 0.3, milestone: 1, desc: 'Street lights: fewer accidents at night and less crime. They go dark when the road is short of power.' },
  { bit: UPG.BARRIER, key: 'barrier', name: 'Sound Barrier', cost: 40, upkeep: 0.2, milestone: 3, highwayOnly: true, desc: 'A wall along a highway: much less traffic noise for the homes behind it.' },
  { bit: UPG.BUSLANE, key: 'buslane', name: 'Bus Lanes', cost: 25, upkeep: 0.2, milestone: 4, minRoad: 4, desc: 'A lane just for buses: they skip the traffic jams.' },
  { bit: UPG.TRAM, key: 'tram', name: 'Tram Tracks', cost: 60, upkeep: 0.6, milestone: 6, devNode: 'transit_tram', desc: 'Tracks in the road so tram lines can run along it.' },
  { bit: UPG.ROUNDABOUT, key: 'roundabout', name: 'Roundabout', cost: 300, upkeep: 1, milestone: 2, intersectionOnly: true, desc: 'Replaces the traffic lights at a junction: cars merge in when there is room, so it moves more traffic with less waiting.' },
  { bit: UPG.TOLL, key: 'toll', name: 'Toll Booth', cost: 2500, upkeep: 40, milestone: 0, single: true, noIntersection: true,
    desc: 'Every vehicle that passes pays the toll (set it in Economy → Services). Drivers avoid tolls when there is another way, and high tolls upset car owners.' },
  { bit: UPG.POWER, key: 'power', name: 'Power Connector', cost: 1500, upkeep: 6, milestone: 0, single: true,
    desc: 'A transformer on the roadside that feeds a power line into this road\'s network (roads carry power to every building beside them). Run a power line to it, or just end a power line on a road and one is added for you.' },
];

// One-way direction is stored per cell (0..3 = E,S,W,N), see DIRS in grid.js.
