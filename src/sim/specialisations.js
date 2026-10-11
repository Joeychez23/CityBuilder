// District specialisations. Once a district has grown into one (enough of the right
// buildings), you can declare it a Financial District, Tech Hub, University Town or
// Entertainment District, each with its own bonus there. One per district.
import { clamp } from '../core/grid.js';
import { isService } from './services.js';
import { bus } from '../core/events.js';

// d: the district's numbers (see districtNumbers)
export const SPECIALISATIONS = [
  { key: 'finance', name: 'Financial District', icon: '🏦',
    req: '12 office buildings, 4 of them at level 3 or higher', progress: (d) => Math.min(d.offices / 12, d.offices3 / 4),
    effect: 'Offices here work 15% better and land is worth more; banks, brokers and head offices crowd in.' },
  { key: 'tech', name: 'Tech Hub', icon: '💻',
    req: '8 office buildings and a university or research centre in the city', progress: (d, c) => Math.min(d.offices / 8, c.science ? 1 : 0.5),
    effect: 'Offices here turn to software and work 12% better, and the city draws more highly educated newcomers.' },
  { key: 'campus', name: 'University Town', icon: '🎓',
    req: 'A college or university in the district and 400 residents', progress: (d) => Math.min(d.higherEd ? 1 : 0, d.residents / 400),
    effect: 'Students who live here finish their studies a day sooner, and residents enjoy the buzz (+3 well-being); shops do well.' },
  { key: 'fun', name: 'Entertainment District', icon: '🎭',
    req: '10 shops and 2 attractions (parks, landmarks, hotels, the stadium...)', progress: (d) => Math.min(d.shops / 10, d.attractions / 2),
    effect: 'Shops here get a quarter more customers, hotels are more popular, and the district draws tourists (+8 attractiveness). It\'s noisier at night.' },
];
export const specDef = (k) => SPECIALISATIONS.find((s) => s.key === k);

export function districtNumbers(state, ctx) {
  const by = new Map();
  for (const d of state.districts) by.set(d.id, { offices: 0, offices3: 0, shops: 0, attractions: 0, residents: 0, higherEd: false });
  for (const b of state.buildings.values()) {
    const n = b.district && by.get(b.district);
    if (!n || b.cons) continue;
    if (b.kind === 'zone') {
      if (b.def.cat === 'off') { n.offices++; if (b.level >= 3) n.offices3++; }
      if (b.def.cat === 'com' || b.def.mixed) n.shops++;
      for (const hid of b.households || []) n.residents += state.households.get(hid)?.members.length || 0;
      if (b.def.signature && b.def.attract) n.attractions++;
    } else if (isService(b)) {
      if (b.def.leisure || b.def.attract || b.def.rooms || b.def.themeGate) n.attractions++;
      if (b.def.eduLevel >= 3) n.higherEd = true;
    }
  }
  const city = { science: [...state.buildings.values()].some((b) => isService(b) && (b.def.eduLevel === 4 || b.def.research)) };
  return { by, city };
}

// Daily: progress toward each specialisation (and news when a district qualifies)
export function specialisationsDaily(state, ctx) {
  const { by, city } = districtNumbers(state, ctx);
  ctx.districtSpecs = new Map();
  for (const d of state.districts) {
    const n = by.get(d.id);
    d.specProgress = {};
    for (const s of SPECIALISATIONS) {
      const p = clamp(s.progress(n, city), 0, 1);
      d.specProgress[s.key] = p;
      if (p >= 1 && !(d.specReady || []).includes(s.key)) {
        d.specReady = [...(d.specReady || []), s.key];
        if (!d.spec) bus.emit('notify', { kind: 'good', icon: s.icon, title: `${d.name} could be a ${s.name}`, msg: `${d.name} qualifies: declare it a ${s.name} in the Districts panel. ${s.effect}` });
      }
    }
    // a district that no longer qualifies keeps its title, but its bonus fades until it does again
    if (d.spec) ctx.districtSpecs.set(d.id, { key: d.spec, strength: d.specProgress[d.spec] >= 1 ? 1 : 0.5 });
  }
}

// The bonus for a building's district (null if none)
export const specAt = (ctx, b) => (b.district ? ctx.districtSpecs?.get(b.district) : null);
export const specIs = (ctx, b, key) => { const s = specAt(ctx, b); return s && s.key === key ? s.strength : 0; };
