// Achievements: one for each kind of goal in the original game's list, with our own names
// and targets scaled to this smaller map. Checked once a day (and on some events).
import { registerPanel, meter } from '../ui/panels.js';
import { registerSystem } from '../sim/simulation.js';
import { CITY_POLICIES } from '../data/policies.js';
import { SERVICE_LIST } from '../data/services.js';
import { TRANSPORT_LIST } from '../data/transport.js';
import { SIGNATURES } from '../data/signatures.js';
import { INFO_VIEWS } from './infoViews.js';
import { CLIMATES } from '../data/maps.js';
import { TILES } from '../core/grid.js';
import { AGE } from '../sim/citizens.js';
import { bus } from '../core/events.js';

const pop = (s) => s.citizens.size;
const count = (s, f) => { let n = 0; for (const b of s.buildings.values()) if (f(b)) n++; return n; };
const ratio = (v, target) => Math.min(1, v / target);

// progress(s, ctx) -> 0..1 ; done when it reaches 1
export const ACHIEVEMENTS = [
  { key: 'firststeps', name: 'First Steps', desc: 'Zone land, and supply water and electricity', progress: (s) => (count(s, (b) => b.kind === 'zone') > 0) / 3 + (count(s, (b) => b.def.water) > 0) / 3 + (count(s, (b) => b.def.power) > 0) / 3 },
  { key: 'bedside', name: 'Bedside Manner', desc: 'Treat 6,000 patients', progress: (s) => ratio(s.counters.treated, 6000) },
  { key: 'smiles', name: 'Smiles All Round', desc: '1,000+ citizens and 75% average happiness', progress: (s) => Math.min(ratio(pop(s), 1000), ratio(s.stats.happiness || 0, 75)) },
  { key: 'grumpy', name: 'Grumpytown', desc: '1,000+ citizens and happiness at 25% or less', progress: (s) => (pop(s) >= 1000 && (s.stats.happiness ?? 100) <= 25 ? 1 : 0) },
  { key: 'wonk', name: 'Policy Wonk', desc: 'Have 5 city policies active at once', progress: (s) => ratio(CITY_POLICIES.filter((p) => s.policies[p.key]).length, 5) },
  { key: 'cartographer', name: 'Cartographer', desc: 'Save a custom map from the map editor', progress: (s) => ratio(s.counters.mapsCreated || 0, 1) },
  { key: 'maker', name: 'Maker', desc: 'Create a building in the asset editor', progress: (s) => ratio(s.counters.assetsCreated || 0, 1) },
  { key: 'greenthumb', name: 'Green Thumb', desc: 'Plant 100 trees', progress: (s) => ratio(s.counters.treesPlanted, 100) },
  { key: 'pioneer', name: 'Pioneer', desc: 'Own 25 map tiles', progress: (s) => (s.options.allTiles ? 0 : ratio(s.tiles.reduce((a, v) => a + v, 0), 25)) },
  { key: 'manifest', name: 'Manifest Destiny', desc: 'Own every map tile', progress: (s) => (s.options.allTiles ? 0 : ratio(s.tiles.reduce((a, v) => a + v, 0), TILES * TILES)) },
  { key: 'localrule', name: 'Local Rule', desc: 'Give a district a policy', progress: (s) => (s.counters.districtPolicy ? 1 : 0) },
  { key: 'patchwork', name: 'Patchwork', desc: '10 districts, each with at least one policy', progress: (s) => ratio(s.districts.filter((d) => Object.values(d.policies).some(Boolean)).length, 10) },
  { key: 'neighbourly', name: 'Neighbourhood Service', desc: 'Restrict a service building to a district', progress: (s) => (s.counters.districtService && s.districts.length ? 1 : 0) },
  { key: 'yearround', name: 'Through the Year', desc: 'See all four seasons in a snowy climate', progress: (s) => (CLIMATES[s.climate].snow ? ratio((s.counters.seasonsSeen || []).length, 4) : 0) },
  { key: 'ticket', name: 'Ticket to Ride', desc: 'Run 10 active transport lines', progress: (s) => ratio(s.stats.activeLines || 0, 10) },
  { key: 'transitweb', name: 'Transit Web', desc: 'Run 25 active transport lines', progress: (s) => ratio(s.stats.activeLines || 0, 25) },
  { key: 'ranger', name: 'Park Ranger', desc: 'Build 10 parks', progress: (s) => ratio(count(s, (b) => b.def.cat === 'parks'), 10) },
  { key: 'collector', name: 'Collector', desc: 'Unlock every service and transport building', progress: (s, ctx, app) => { const all = [...SERVICE_LIST, ...TRANSPORT_LIST]; return all.filter((d) => !app.lockReason(d)).length / all.length; } },
  { key: 'fullhouse', name: 'Full House', desc: 'Unlock all services through milestones (milestone 12)', progress: (s) => ratio(s.progression.milestone, 12) },
  { key: 'landmark', name: 'Landmark', desc: 'Build 5 signature buildings', progress: (s) => ratio(count(s, (b) => b.def.signature), 5) },
  { key: 'skyline', name: 'Skyline Architect', desc: 'Build all 10 signature buildings', progress: (s) => ratio(count(s, (b) => b.def.signature), SIGNATURES.length) },
  { key: 'oneofeach', name: 'One of a Kind', desc: 'Build every unique building', progress: (s) => { const u = [...SERVICE_LIST, ...TRANSPORT_LIST].filter((d) => d.unique); return u.filter((d) => count(s, (b) => b.def === d)).length / u.length; } },
  { key: 'upinsmoke', name: 'Up in Smoke', desc: 'Live through a forest fire', progress: (s) => (s.counters.forestFire ? 1 : 0) },
  { key: 'twister', name: 'Twister', desc: 'Live through a tornado', progress: (s) => (s.counters.tornado ? 1 : 0) },
  { key: 'hail', name: 'Dented Roofs', desc: 'Live through a hail storm', progress: (s) => (s.counters.hail ? 1 : 0) },
  { key: 'postcard', name: 'Postcard City', desc: '1,000+ citizens and attractiveness 90', progress: (s) => Math.min(ratio(pop(s), 1000), ratio(s.stats.attractiveness || 0, 90)) },
  { key: 'bigleague', name: 'Big League', desc: 'Reach 25,000 citizens', progress: (s) => ratio(pop(s), 25000) },
  { key: 'cheese', name: 'Say Cheese', desc: 'Take a picture in photo mode', progress: (s) => ratio(s.counters.photo, 1) },
  { key: 'demolition', name: 'Demolition Crew', desc: 'Bulldoze 250 buildings', progress: (s) => ratio(s.counters.bulldozed, 250) },
  { key: 'mixeduse', name: 'Mixed Economy', desc: 'Have residential, commercial, industrial and office buildings', progress: (s) => ['res', 'com', 'ind', 'off'].filter((c) => count(s, (b) => b.kind === 'zone' && b.def.cat === c)).length / 4 },
  { key: 'deeppockets', name: 'Deep Pockets', desc: 'Owe ₡200,000 or more in loans', progress: (s) => ratio(s.loan, 200000) },
  { key: 'inspector', name: 'Inspector General', desc: 'Open every info view', progress: (s) => ratio(s.counters.infoViews.length, INFO_VIEWS.length) },
  { key: 'endofroad', name: 'End of the Road', desc: 'Reach the final milestone', progress: (s) => ratio(s.progression.milestone, 20) },
  { key: 'valedictorians', name: 'Valedictorians', desc: '15% of adults hold a university degree', progress: (s) => { let a = 0, u = 0; for (const c of s.citizens.values()) if (c.age >= AGE.adult) { a++; if (c.edu >= 4) u++; } return a > 100 ? ratio(u / a, 0.15) : 0; } },
  { key: 'wheelsup', name: 'Wheels Up', desc: 'Build an airport', progress: (s) => (count(s, (b) => b.def.id === 'airport') ? 1 : 0) },
  { key: 'touristtrap', name: 'Tourist Trap', desc: 'Welcome 6,000 tourist visits', progress: (s) => ratio(s.counters.tourists, 6000) },
  { key: 'lifestory', name: 'Life Story', desc: 'Follow a citizen for 25 years until the end of their life', progress: (s) => (s.counters.followedLife ? 1 : 0) },
  { key: 'cleanenergy', name: 'Clean Energy', desc: 'Power a city of 500+ only with wind, solar and geothermal', progress: (s) => {
    if (pop(s) < 500) return 0;
    const dirty = count(s, (b) => b.def.power && !['windmill', 'solar', 'geothermal'].includes(b.def.id)) + count(s, (b) => b.def.burns);
    const u = s.stats.utilities || {};
    return !dirty && (u.imported || 0) < 0.1 && (u.produced || 0) >= (u.consumed || 1) ? 1 : 0;
  } },
];

registerPanel({
  key: 'achievements', icon: '🎖️', title: 'Achievements', order: 70,
  render(app, body) {
    const s = app.state;
    const done = ACHIEVEMENTS.filter((a) => s.achievements[a.key] != null).length;
    const sandbox = s.options.unlimitedMoney || s.options.unlockAll;
    body.innerHTML = `<div class="muted" style="margin-bottom:8px">${done} / ${ACHIEVEMENTS.length} unlocked${sandbox ? ' · <span class="warn">disabled in sandbox games (unlimited money / unlock all)</span>' : ''}</div>` +
      ACHIEVEMENTS.map((a) => {
        const got = s.achievements[a.key] != null;
        const p = got ? 1 : Math.max(0, Math.min(1, a.progress(s, app.ctx, app) || 0));
        return `<div class="list-item ${got ? 'done' : ''}"><div class="row"><b>${got ? '🏅' : '🔒'} ${a.name}</b><span class="muted num">${Math.round(p * 100)}%</span></div>
          <div class="muted" style="font-size:11.5px">${a.desc}</div>${got ? '' : meter(p)}</div>`;
      }).join('');
  },
});

export const achievementsFeature = {
  init(app) {
    const s = app.state;
    // Like the original, achievements are off in sandbox games (unlimited money / unlock all)
    const sandbox = () => s.options.unlimitedMoney || s.options.unlockAll;
    const check = () => {
      if (sandbox()) return;
      for (const a of ACHIEVEMENTS) {
        if (s.achievements[a.key] != null) continue;
        let p = 0;
        try { p = a.progress(s, app.ctx, app); } catch { p = 0; }
        if (p >= 1) {
          s.achievements[a.key] = s.time.day;
          app.toast(a.desc, 'good', `🏅 Achievement: ${a.name}`);
        }
      }
    };
    app.checkAchievements = check;
    registerSystem({ name: 'achievements', every: 'day', run: check });
    for (const ev of ['milestone', 'signatures:changed', 'photo', 'districts:changed', 'panel:open']) bus.on(ev, () => setTimeout(check, 50));
  },
};
