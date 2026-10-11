// The whole city lives in one plain object. Big per-cell layers are typed arrays
// (fast + easy to save); entities (buildings, households, citizens) live in Maps.
import { N, HN, TILES } from './grid.js';
import { DIFFICULTIES } from '../data/difficulty.js';

const NN = N * N;
const f32 = () => new Float32Array(NN);
const u8 = () => new Uint8Array(NN);

// Typed-array layers that get saved. Derived layers (coverage, demand maps...) are rebuilt.
export const SAVED_LAYERS = [
  'height', 'water', 'zone', 'bld', 'district',
  'rail', 'subway', 'power', 'pipe', 'path', 'tree', 'surface',
  'fertile', 'ore', 'oil', 'groundwater', 'gwPollution', 'forestMax',
  'air', 'ground', 'noise', 'waterPoll', 'landValue', 'burnt',
  'railH', 'railDir', 'pathH', 'pathDir', 'canal',
];
// Per-cell road layers worked out from the road network (sim/roadraster.js): never saved
export const ROAD_RASTER = ['road', 'roadSeg', 'roadDir', 'roadUpg', 'roadCond', 'bridgeH', 'bridgeDir', 'underRoad', 'underDir', 'roadNode', 'roadDay', 'roadLinks'];

export function createState(map, options = {}) {
  return {
    version: 9, // 9: roads are a network of nodes and segments (sim/roadnet.js). Cities from
                //    before it (grid roads) can't be opened: see LegacyCityError in sim/save.js
    cityName: options.cityName || 'New City',
    mapId: map.id,
    mapName: map.name,
    climate: map.climate,
    theme: map.theme,
    seed: map.seed,
    connectionsAvailable: { ...map.connections },
    options: {
      difficulty: DIFFICULTIES[options.difficulty] ? options.difficulty : 'normal', // see data/difficulty.js
      disasters: options.disasters ?? true,
      unlimitedMoney: options.unlimitedMoney ?? false,
      unlockAll: options.unlockAll ?? false,
      tutorial: options.tutorial ?? true,
      allTiles: options.allTiles ?? false, // own the whole map from the start (off: 9 tiles, buy more)
      instantBuild: options.instantBuild ?? false, // sandbox: buildings appear finished (no construction)
    },

    // --- Time: day counts from Thu 1 Jan 2026 (see dateOf in sim/simulation.js). New cities
    // start on Wed 1 April 2026; budgets settle every week when Saturday ends.
    time: { minutes: 7 * 60, day: 90, speed: 1, paused: false },

    // --- Terrain
    height: new Float32Array(HN * HN),
    seaLevel: 3,
    water: u8(),            // 1 = water cell (derived from height, saved for speed)
    flow: [1, 0],           // dominant water current, used to carry water pollution

    // --- Networks
    // Roads: nodes joined by segments (sim/roadnet.js). The per-cell road layers below are
    // worked out from them (sim/roadraster.js) for everything that works cell by cell.
    roads: { nodes: [], segs: [], nextId: 1 },
    road: u8(),             // road type id on the cell (0 = none)
    roadSeg: new Int32Array(NN), // the road segment on the cell
    roadDir: u8(),          // one-way direction (0..3)
    roadUpg: u8(),          // upgrade bitmask (UPG in data/roads.js)
    roadCond: new Float32Array(NN).fill(1), // 1 = perfect, 0 = crumbling
    roadSnow: f32(),
    roadVol: f32(),         // smoothed traffic volume (vehicles / cell)
    accident: f32(),        // >0 = blocked by an accident for this many minutes
    closed: u8(),           // road closed: 1 film shoot, 2 earthquake damage, 3 flooded (see sim/closures.js)
    closures: [],
    rail: u8(),
    subway: u8(),
    power: u8(),            // power pylons (1 = pylon on this cell)
    powerSpans: [],         // overhead wires: [cellA, cellB] pairs between pylons
    roadSegs: [],           // (no longer used: grid roads at an angle)
    roadDay: new Uint16Array(NN), // the day each road cell was laid (for the time-lapse)
    roadNode: u8(),         // (no longer used)
    pipe: u8(),             // standalone water pipes
    canal: u8(),            // 1 = a canal you dug (sim/projects.js)
    path: u8(),             // pedestrian paths
    // Raised roads: deck height over the cell (0 = on the ground). (bridgeDir, underRoad and
    // underDir are no longer used by roads: they stay empty)
    bridgeH: f32(), bridgeDir: u8(),
    underRoad: u8(), underDir: u8(),
    railH: f32(), railDir: u8(),
    pathH: f32(), pathDir: u8(),

    // --- Land use
    zone: u8(),
    bld: new Int32Array(NN), // building id on the cell (0 = none)
    plot: new Int32Array(NN), // lot id on the cell (0 = none), see plots below
    district: u8(),          // district id (0 = none)
    tree: u8(),              // 0..3 tree density
    surface: u8(),           // decorative surface paint
    burnt: f32(),            // forest-fire scars

    // --- Natural resources (0..1 amounts per cell)
    fertile: f32(),
    ore: f32(),
    oil: f32(),
    groundwater: f32(),
    gwPollution: f32(),
    forestMax: f32(),        // where forests naturally regrow

    // --- Pollution & land value
    air: f32(),
    ground: f32(),
    noise: f32(),
    waterPoll: f32(),
    landValue: f32(),

    // --- Map tiles (purchasable areas)
    tiles: new Uint8Array(TILES * TILES),

    // --- Entities
    buildings: new Map(),
    households: new Map(),
    citizens: new Map(),
    nextId: 1,

    // --- Economy
    money: options.unlimitedMoney ? 1e12 : (DIFFICULTIES[options.difficulty] || DIFFICULTIES.normal).money,
    loan: 0,
    taxes: { res: 10, com: 10, ind: 10, off: 10, resEdu: [0, 0, 0, 0, 0] },
    fees: { electricity: 0.2, water: 0.3, garbage: 1, healthcare: 100, education: 100, parking: 10, taxiFare: 0, toll: 3 },
    budgets: {}, // per service category, 50..150 (%)
    ledger: newLedger(),       // this week's income and costs so far (paid when Saturday ends)
    lastLedger: newLedger(),   // last week's statement
    today: newLedger(),        // today's share of the ledger (for projections)
    rates: newLedger(),        // smoothed amount per day, per ledger line (for projections)
    weekly: [],                // weekly statements for the budget charts
    market: {},                // goods stockpiles + import/export counters
    history: [],               // daily snapshots for charts

    // --- Systems
    stats: {},
    demand: { res: 0.5, resLow: 0.5, resMed: 0.3, resHigh: 0.1, com: 0.3, ind: 0.4, off: 0.1 },
    progression: { xp: 0, milestone: 0, devPoints: 0, permits: 0, dev: [], milestoneSeen: 0 },
    policies: {},              // city-wide policy key -> true / value
    districts: [],             // { id, name, color, policies: {} }
    plots: [],                 // zoned lots you laid out: { id, x0, y0, x1, y1, rot, setback, zone }
    lines: [],                 // public transport lines
    stops: {},                 // road cell index -> { type: 'bus' | 'tram', name }
    connections: [],           // outside connections { type, x, y, dir }
    weather: { temp: 15, cloud: 0.3, rain: 0, snow: 0, wind: 0.5, fog: 0, storm: 0, kind: 'clear' },
    events: [],                // active disasters/incidents
    journal: [],               // event journal entries
    decisions: [],             // requests waiting on the mayor's desk (sim/decisions.js)
    achievements: {},          // key -> day unlocked
    counters: { bulldozed: 0, treesPlanted: 0, treated: 0, tourists: 0, infoViews: [], photo: 0, followedLife: 0, signatures: 0 },
    unlockedSignatures: [],
    customAssets: [],          // asset-editor buildings and data mods
    cloudId: null,             // id of this city's copy in your account, if saved there
    followCitizen: 0,
    tutorialStep: 0,
  };
}

export function newLedger() {
  return {
    income: { resTax: 0, comTax: 0, indTax: 0, offTax: 0, fees: 0, transit: 0, parking: 0, tolls: 0, hotels: 0, conventions: 0, casino: 0, film: 0, factories: 0, grants: 0, themepark: 0, promenade: 0, regional: 0, exports: 0, subsidy: 0, refunds: 0 },
    expense: { services: 0, roads: 0, loanInterest: 0, imports: 0, supplies: 0, projects: 0, policies: 0, transit: 0 },
  };
}

export function newId(state) {
  return state.nextId++;
}
