# CityBuilder

A city builder written with three.js and Vite.

```bash
npm install
npm run dev
```

Open the URL Vite prints, pick a map and found your city. You start with the 9 tiles in the
middle of a 17 × 17 tile map and buy more with money and expansion permits (or tick "Whole
map from the start"). The UI uses the Interactive-Portfolio's signage style and fonts.
Hovering anything in the interface explains what it does. The right side of the screen shows
one window at a time (the tool you're using, the building you clicked, or a panel), and
Game → Interface size makes the whole interface smaller or bigger. Whatever you build or
remove can be undone for a minute afterwards (the Undo button over the toolbar, or Ctrl+Z).

**Controls**

| Input | Action |
|-------|--------|
| Mouse wheel / trackpad pinch | Zoom toward the cursor (the view tilts to suit the height) |
| Left drag (no tool), middle drag | Grab the ground and pan (flick it to glide) |
| Right drag | Rotate and tilt |
| Double click | Fly to that spot |
| WASD / arrows · Q / E · Z / X · T / G | Pan · rotate · zoom · tilt (Shift = faster) |
| Home | Back to the town centre |
| Left click | Use the active tool |
| Right click or Esc | Stop what the tool is doing (a road being drawn, a line...), then put it away |
| Ctrl+Z (⌘Z) | Undo the last thing you built or removed (each change can be undone for a minute) |
| R / Shift+R | Turn a building before placing it |
| Space · 1 / 2 / 3 | Pause · game speed |
| V | Show natural resources |
| P | Photo mode |

**Accounts (optional)**

Cities built always save in the browser. To also save them to an account, run the API server.
It uses the same MongoDB setup as Tone-Radar: `MONGODB_URI` (without a database name) plus
`MONGODB_DB`. You can point it at the same cluster with a different database name.

```bash
npm run install:all
cp server/.env.example server/.env   # then fill in MONGODB_URI and JWT_SECRET
npm run server                       # API on http://localhost:5070
npm run dev                          # the game; /api is proxied to the server
```

Sign in from the start screen or the 👤 panel in game. From there you can save a city to
your account, save a copy, turn on autosave to the account, and load or delete saved
cities. `npm test` runs the API tests against a temporary in-memory MongoDB. In production,
`npm run build` and then `npm run server` serves the game and the API together.

**Dev shortcuts**

Add these to the URL to skip the start screen:

- `?map=prairie`: start a new city on that map (use any map id from `src/data/maps.js`)
- `&rich`: unlimited money
- `&unlock`: everything unlocked
- `&demo`: lay out a small starter town
- `&stress=7`: grow a bigger test town for that many days (`&road=2` builds it with small roads)
- Big road networks for timing: in the console, `(await import('/src/dev/bigCity.js')).bigCity(city)` lays
  out about 2,000 road segments, and `timeIt(city)` from the same module times the network's parts
- `&alltiles`: own the whole map
- `&instant`: buildings appear finished (no construction)

## Feature coverage (by wiki section)

| Wiki section | What's implemented | Where |
|---|---|---|
| **Getting started** | Beginner's guide: a checklist that checks itself off, plus tips | `features/metaFeature.js` |
| **Notifications** | A notification center (🔔 in the top bar) listing open problems until they're fixed (landfill full, power shortage, no power source, sewage near drinking water, parking, garbage, crime, fires, unemployment, traffic backing up, the budget heading into the red...) plus a news log; new ones pop up as toasts. Every building that needs something shows it: up to three icons side by side over it (needs power, water, sewage, garbage pickup, parking, a road...), and hovering the building lists them in words | `sim/problems.js`, `features/notificationsFeature.js`, `world/iconsView.js` |
| **Progression** | 20 milestones (XP from population, happiness and building) with money, development points, expansion permits and loan limits. Buildings, roads and transport unlock by themselves at their milestone (marked NEW in the menus); development points buy perks | `data/progression.js`, `features/progressionFeature.js` |
| **Zoning** | Residential (low, row, medium, high, mixed, low-rent), commercial (low, high), industrial, office (low, high), and specialized industry (farming, forestry, ore, oil) that only works on matching resources. Zoning runs in strips along each road, 6 cells deep on each side and set square to the road, curves included: cells that would overlap a road, water, a railway, a pylon, a footpath or a building you placed are left out, roads facing each other share the land between them, and the strips of crossing roads overlap in the corners until a building takes the land. The paint is kept with each road and moves with it when the road is split or redrawn. Rectangle, paint, lots and fill tools (the mode you pick is kept). Lots: choose the lot width and depth and a front yard, and drag along a road (or on it, for both sides); the building grows on the whole lot, set back behind a lawn or forecourt. Fill only changes the one patch you click. Buildings grow on the strips, turned to face their road. High-density homes, shops and offices only grow beside a collector (Medium or One-Way Road) or bigger. Buildings level up from 1 to 5: homes with happy, well-off residents on valuable land; shops with customers and good land; factories with better-educated workers; offices with educated workers, land value and internet; every workplace needs a profit and its jobs filled. The inspector shows what adds or takes level points each day | `data/zones.js`, `sim/zoneblocks.js`, `sim/growth.js`, `world/zonesView.js`, `ui/tools.js` |
| **Construction** | Nothing appears finished: new buildings go up on a building site (fence, scaffolding, a crane on big jobs, builders' trucks) over some game hours, and only start working (or take residents) when done. A building that levels up is extended: scaffolding and new floors go up while it stays open. City services can be rushed for a quarter of their price | `sim/construction.js`, `world/buildingsView.js` |
| **Services** | Electricity: roads carry power to every building beside them and power plants feed the roads they touch. Power lines (pylons, wires spanning up to 8 cells over roads, water and buildings) run from a plant, a pylon or the outside power line, and feed a road only through a Power Connector (a roadside transformer; end a line on a road to add one). Wires visibly attach to plants and connector poles. The ⚡ Power grid view (Map strip, power panel, or while drawing lines) colours every road and building powered, short, or without power. Buildings short of power go dark at night. Water & sewage: sewage outlets pour into the water and the sewage drifts downstream with the current, turning the water brown, with froth at the outlet and lumps of sewage floating downstream; a pump downstream of an outlet, within its plume, upsets everyone on its network. Garbage: landfills are drawn as an area (bigger holds more and runs more trucks; drag along a side to grow one), and garbage trucks drive out to collect, nearest full bins first. Also healthcare & deathcare, fire & rescue, police & administration, education, parks, post and telecom. Coverage radii, capacities, staffing, budgets (50–150%), and service fees | `data/services.js`, `sim/services.js`, `sim/utilities.js`, `sim/power.js`, `sim/garbage.js`, `features/powerPanel.js`, `world/sewageView.js` |
| **Emergencies** | Fire engines, police cars and ambulances drive from their station to the incident with lights flashing. Fires are only fought once an engine arrives; police arrest offenders on the scene (faster response, likelier arrest); each station has a limited number of vehicles and a reach. Police patrol their neighbourhood. Crime costs households and shops money, and uncovered areas get more fires and crime | `sim/emergency.js`, `sim/disasters.js`, `sim/wellbeing.js` |
| **Policies** | 6 city-wide policies, 7 district policies, and a parking fee on individual buildings | `data/policies.js`, `features/governanceFeature.js` |
| **Traffic** | Trips (commutes, shopping, trucks, service vehicles, tourists) routed with A* over the road network: each road is an edge each way it can be driven, and a route never turns straight back except at a dead end. Roads have 1–3 lanes each way and carry more the more lanes they have; junctions carry less (traffic lights where bigger roads meet, give-way junctions where a local street joins a bigger road or on small roads, roundabouts that flow better, highway merges), and every driveway onto an avenue slows it a little. Over capacity, queues back up onto the roads leading in. Cars you see drive in lanes along the curves, pick their lane for the next turn, swing through junctions on curves from lane to lane (round the island at a roundabout), keep their distance, stop at red lights, take turns at give-way junctions, give way to traffic on a roundabout and won't block a junction, so backups are visible; stuck drivers look for another way. Jams near home or work upset commuters. Also accidents, parking fees, mode choice (walk, transit, taxi, car), a traffic flow score and toll booths | `sim/roadgraph.js`, `sim/traffic.js`, `sim/lanes.js`, `world/vehiclesView.js` |
| **People & parking** | Pedestrians (small upright blocks) walk the pavements to work and home at rush hour and to parks and shops in between. Bus and tram riders walk to a stop, wait, board, ride, get off and walk on. Drivers park in Parking Lots and Garages within a short walk of work: a lot holds as many cars as it has spaces, and its stalls fill with cars through the morning and empty in the evening. When the lots near work are full, the drivers left over leave the car at home and walk to work (and arrive late and unhappier), and commuters from other cities can't come in; full lots show a 🅿️ icon and say how many drivers they turned away. How many people and cars you see grows with the city, and most are picked from around where you're looking | `world/peopleView.js`, `sim/parking.js` |
| **Info views** | All 33 views: heatmaps, building colors and road colors, each with a legend and statistics | `features/infoViews.js` |
| **Roads** | Gravel, small, one-way, medium, large and highway, with lane markings, in a hierarchy: local streets (quiet, slow, for homes), collectors (lead neighbourhoods to the main roads and serve big buildings), avenues (carry the most traffic, noisy) and highways (no buildings). Roads are a network of points joined by curved segments, at any angle. The road tool draws Straight roads (snapping to the grid's directions, 45° and along or square to the road you start from; Shift for 15° steps), Curved ones (start, bend, end), Freeform ones that carry on smoothly from the last piece, a whole Grid of roads, Bridges and Tunnels; it snaps to the ends and middles of other roads, and Page Up / Page Down raise the road you're drawing. Where two roads cross at the same height they meet in a junction (cut back and filled with one surface, rounded at the corners, with zebra crossings and stop lines at busy ones); a raised road passes over a road below it, and a tunnel under it. A road drawn across water gets a bridge of its own type by itself. Bridges arch over what's below with level ends; bigger roads get sturdier bridges, and suspension bridges are landmarks. Tunnels dig out their approaches between retaining walls and show as tubes when you look underground. Ground roads follow the land with a smooth, gentle profile, and the ground under them is graded. Upgrades: trees, lighting, sound barriers, bus lanes, tram tracks (a track each way), roundabouts, toll booths and Power Connectors. Road wear and snow, handled by road maintenance depots; upkeep goes by each road's length | `data/roads.js`, `sim/roadnet.js`, `sim/roadgeom.js`, `sim/roadraster.js`, `world/roadsView.js`, `ui/toolsRoad.js` |
| **Transportation** | Bus, tram, train and subway lines: click stops, set vehicle counts, ticket prices and when they run (all day, daytime, rush hours or night: a line only costs upkeep for the hours it runs), and see usage. Also taxis, cargo train and harbor terminals, airport, passenger harbor, and outside connections by road, rail, sea and air | `sim/transit.js`, `data/transport.js`, `features/transportFeature.js` |
| **Placing buildings** | A see-through copy of the real building shows where it goes, with an arrow at its entrance. It snaps up against the nearest road and turns to face it, at the road's own angle beside a road at an angle; R / Shift+R or the arrows turn it yourself (it then keeps your direction). Sloping land is fine: the building stands on a stone foundation on the downhill side (only cliffs are too steep), and if it can't go somewhere you're told why | `ui/toolsPlop.js`, `world/buildingsView.js` |
| **Service buildings** | 59 buildings (48 services and 11 transport): power plants, pumps, schools, hospitals, depots, stations and others | `data/services.js`, `data/transport.js` |
| **Signature buildings** | 10 unique landmarks unlocked by how the city grows. Free to place, once each. They give a well-being bonus nearby and add attractiveness | `data/signatures.js`, `features/signatureFeature.js` |
| **Landscaping** | Raise, lower, level and soften terrain with a tile-based brush (down to a single tile; Level flattens to the height of the tile you first click). Plant trees, or clear them with a brush (this also removes the forestry resource). Decorative surfaces. Footpaths | `sim/build.js` (`terraform`, `clearTrees`), `ui/tools.js` |
| **Citizens** | Individual citizens in households: age groups, 5 education levels, schooling, jobs, wealth, health, well-being, births, deaths, illness, crime and prison, moving in and out, and a followable life path. Happiness reacts to having no job, taxes on their education level, transport costs (tickets, parking, tolls), industrial noise and missing police, fire, healthcare or schools; the happiness meter opens a city-wide breakdown of complaints | `sim/citizens.js`, `sim/wellbeing.js`, `features/happinessPanel.js` |
| **Economy** | A real calendar (the top bar shows the weekday and day of the month). Taxes, fees and upkeep build up during the week and are paid together when Saturday ends; until then the top bar and budget show a projection that moves with the city. Taxes by zone and by education level, loans and interest, government subsidy, road tolls, production chains (raw → goods → retail, plus office goods), imports and exports. Companies make a profit when they have their workers, power and water, and inputs or customers (and pay tax on it); too many shops for the people nearby lose money and eventually close | `sim/economy.js`, `sim/companies.js`, `data/resources.js` |
| **Climate** | Seasons, temperature, clouds, rain, snow, fog, storms, hail and wind. Weather affects heating and cooling demand, solar and wind output, tourism and fire risk. Snow cover and seasonal tree colors | `sim/climate.js`, `world/fxView.js` |
| **Disasters** | Building fires, forest fires (lightning and drought), hail, and tornadoes. Firewatch towers, firefighting helicopters, emergency shelters and an early warning system. Destroyed buildings leave rubble and are rebuilt where they stood (insurance pays half for city services). Event journal | `sim/disasters.js`, `sim/construction.js` |
| **Natural resources** | Fertile land, forest, ore, oil and groundwater. Renewable vs. finite, depletion, and damage from pollution. The Map strip (bottom left, or V) paints where each resource is with a legend of how much you own; it can also hide trees, buildings, traffic, power lines and alerts | `sim/mapgen.js`, `sim/environment.js`, `features/layersFeature.js` |
| **Pollution** | Air (drifts with the wind, washed out by rain), ground, noise (with industrial noise tracked on its own), water (flows with the current) and groundwater, with effects on health, land value and trees | `sim/environment.js` |
| **Maps** | 9 procedurally generated maps, 272 × 272 cells (about 2.2 km), with different terrain styles, climates, themes and outside connections (highway, rail, sea, air and an outside power line). The land is mostly gentle and buildable; the hills and mountains rise toward the map edges, and the incoming highway follows the lie of the land. Every starting area has a river, lake or bay with room for pumps upstream of sewage outlets, thinner forest, and patches of the map's main resources. 289 purchasable tiles. Custom maps saved from the map editor | `data/maps.js`, `sim/mapgen.js`, `sim/save.js` |
| **Camera** | Zoom toward the cursor, grab-and-glide panning, rotate and tilt, double-click to fly somewhere, never dips into hills; optional edge panning | `world/camera.js` |
| **Undo & bulldozer** | The last 20 things you built or removed can be undone for a minute each (the Undo button over the toolbar shows what and how long is left; Ctrl+Z), most recent first: everything it cost is paid back, the land and terrain go back as they were, and houses you knocked down come back with their residents. The bulldozer removes one thing per click (a whole building, or one piece of road or line) and whatever you drag across, or switch it to Area for a rectangle; it can be limited to buildings, roads & lines, zoning or trees | `sim/undo.js`, `ui/undoBar.js`, `ui/tools.js` |
| **Interface** | One window on the right at a time: the options of the tool you're using, the building you clicked, or a panel; opening one closes the other. The build menu stays open while you use it ("Less" shrinks it to one row, and it remembers). An Interface size setting (Small, Medium, Large, Extra large); the top bar keeps to one line and the toolbar turns to icons on narrow windows | `ui/panels.js`, `ui/toolbar.js`, `ui/hud.js`, `features/metaFeature.js` |
| **Modding** | Data-only mods (paste a JSON list of building definitions), an asset editor, a map editor, and a `window.city` scripting API | `features/editorsFeature.js` |
| **Achievements** | 38 achievements, one for each goal type on the wiki's list, with original names and targets scaled to this map | `features/achievementsFeature.js` |
| Other | Save and load (gzip in localStorage, export/import a file, or your account via the API server; cities from before the road network are kept for download), autosave, photo mode, graphics settings, demolition refunds (50% of what you paid) | `features/metaFeature.js`, `features/accountFeature.js`, `server/` |

Not implemented: the wiki's non-game pages (tutorial videos, community guides, developer
diaries, patch notes, DLC).

## Simplifications

- **A hidden grid under the roads.** Roads, routing, traffic, vehicles and zoning run on
  the road network itself, but terrain, pollution, land value, water, power carried by
  roads and buildings' footprints stay on the map's 8 m grid: each road is also written
  onto the cells it passes through, and a building turned to face its road holds the grid
  cells under it. Railways, footpaths, pipes, power lines and the subway are still laid
  cell by cell.
- **Old cities.** Cities from before the road network can't be opened: they're kept (never
  deleted) and listed on the start screen with a download button.
- **Scaled numbers.** The map is 272 × 272 cells (about 2.2 km across), so coverage radii,
  capacities and prices are scaled to fit. They aren't CS2's numbers.
- **Sampled traffic.** Each routed trip stands for many real ones, and the vehicles you see
  are a sample of them (they still queue and back up where the roads are full).
- **Compressed lives.** The calendar is real (days, weeks, months), but a citizen ages a
  year every day so a city sees generations come and go.
- **Representative people.** The pedestrians, riders and parked cars you see follow the
  simulation's choices (who walks, rides or drives, and where they park) but are a sample,
  not every citizen. Parking is worked out once a day: how full each lot is during the day
  follows a workday curve rather than each car's arrival.
- **Undo is short.** Undo keeps the last 20 changes for a minute each, in memory only (not
  in saves). What the city did in between makes way: buildings that grew on zoning you take
  back are removed with it.

## How it's organised

- `src/core`: the state object, the grid, noise, random numbers and the event bus.
- `src/sim`: the simulation. Systems run every step (10 game minutes), every hour, or every
  day.
- `src/world`: three.js rendering. Almost everything uses instanced meshes; roads and zoning
  are built in chunks of the map, so a change redraws only the chunks it touches.
- `src/ui`: HUD, toolbar, tools and panels.
- `src/features`: each feature registers its systems, panels, tools and menus here.
- `src/data`: buildings, roads, zones, maps, policies, milestones and achievements as plain
  data.
- `server/`: the Express + Mongoose account API (users, saved cities), structured like
  Tone-Radar's server.
