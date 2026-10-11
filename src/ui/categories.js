// Toolbar categories for roads, zoning, landscaping and the bulldozer.
import { registerCategory } from './toolbar.js';
import { ROAD_LIST, UPGRADES, lanesText, CLASS_NAMES } from '../data/roads.js';
import { perWeek } from '../sim/economy.js';
import { ZONE_LIST } from '../data/zones.js';
import { SURFACES } from '../world/overlays.js';
import { money } from './tools.js';
import './toolsBridge.js';
import './toolsTunnel.js';

registerCategory({
  key: 'roads', icon: '🛣️', name: 'Roads', order: 10,
  items: (app) => [
    ...ROAD_LIST.map((r) => ({
      group: 'Roads', name: r.name, color: r.color,
      meta: `${CLASS_NAMES[r.cls]} · ${money(r.cost)}/cell · ${r.speed} km/h`,
      desc: `${r.role} ${r.oneway ? 'Traffic only goes the way you draw it.' : ''}`,
      tipRows: [['Class', CLASS_NAMES[r.cls]], ['Lanes', lanesText(r)], ['Speed', `${r.speed} km/h`], ['Carries', `about ${r.capacity} vehicles per cell`], ['Cost', `${money(r.cost)} per cell`], ['Upkeep', `${money(perWeek(r.upkeep))}/wk per cell`]],
      tool: { kind: 'road', type: r.id, mode: 'straight' },
      isActive: (t) => t.kind === 'road' && t.type === r.id,
      locked: () => app.lockReason(r),
    })),
    ...UPGRADES.map((u) => ({
      group: 'Road upgrades', name: u.name, color: u.bit === 128 ? '#4f7a52' : '#8fa3a8',
      meta: u.single || u.intersectionOnly ? `${money(u.cost)} each · click a road` : `${money(u.cost)}/cell · click or drag on roads`,
      desc: u.desc,
      tool: { kind: 'upgrade', bit: u.bit, key: u.key },
      isActive: (t) => t.kind === 'upgrade' && t.bit === u.bit,
      locked: () => app.lockReason(u),
    })),
    { group: 'Bridges', name: 'Road bridge', color: '#bdb9b0', meta: 'Any road type · click start, then end', desc: 'A raised road from one point to another: it leaves each end level with the road and arches over water, valleys, tracks and other roads below. Bigger roads get sturdier bridges. (Every road tool has this as its Bridge mode, and roads you draw across water get their bridges by themselves.)',
      tool: { kind: 'road', type: 2, mode: 'bridge', style: null }, isActive: (t) => t.kind === 'road' && t.mode === 'bridge' && t.style !== 'suspension' },
    { group: 'Bridges', name: 'Railway bridge', color: '#bdb9b0', meta: '₡120/cell span · click start, then end', tool: { kind: 'bridge', kindKey: 'rail' }, isActive: (t) => t.kind === 'bridge' && t.kindKey === 'rail' },
    { group: 'Bridges', name: 'Suspension bridge', color: '#c8352b', meta: 'A landmark over open water · 10+ cells', desc: 'A road bridge with tall towers and cables, for a long crossing over open water. It costs twice an ordinary bridge plus ₡300,000, and it\'s a landmark: +15 attractiveness, and well-being in the neighbourhoods at either end.',
      tool: { kind: 'road', type: 4, mode: 'bridge', style: 'suspension' }, isActive: (t) => t.kind === 'road' && t.mode === 'bridge' && t.style === 'suspension', locked: () => app.lockReason({ milestone: 13 }) },
    { group: 'Tunnels', name: 'Road tunnel', color: '#ffb84f', meta: '₡490+/cell · end to end', desc: 'A road that runs underground between two points, under hills, rivers or the middle of town (up to 512 m). Nothing above it is touched; traffic takes it when it\'s quicker, so it\'s how you can take away a jammed road above it. (Every road tool has this as its Tunnel mode.)',
      tool: { kind: 'road', type: 2, mode: 'tunnel' }, isActive: (t) => t.kind === 'road' && t.mode === 'tunnel', locked: () => app.lockReason({ milestone: 11 }) },
    { group: 'Bridges', name: 'Footbridge', color: '#d9cfb5', meta: '₡24/cell span', tool: { kind: 'bridge', kindKey: 'path' }, isActive: (t) => t.kind === 'bridge' && t.kindKey === 'path' },
    { group: 'Pedestrian', name: 'Footpath', color: '#e3d6b4', meta: '₡8/cell', tool: { kind: 'layer', layer: 'path', label: 'Footpath' }, isActive: (t) => t.layer === 'path' },
  ],
});

registerCategory({
  key: 'zones', icon: '🏘️', name: 'Zoning', order: 20,
  items: (app) => [
    ...ZONE_LIST.map((z) => ({
      group: { res: 'Residential', com: 'Commercial', ind: 'Industrial', off: 'Office', spec: 'Specialized industry' }[z.cat],
      name: z.name, color: z.color,
      meta: z.cat === 'spec' ? `Needs ${z.resource === 'fertile' ? 'fertile land' : z.resource}` : z.cat === 'res' ? `${z.hh} households/cell` : `${z.jobs} jobs/cell`,
      desc: z.desc,
      tipRows: [[z.cat === 'res' ? 'Homes' : 'Jobs', z.cat === 'res' ? `${z.hh} households per cell` : `${z.jobs} per cell`], ['Floors', `${z.floors}–${z.maxFloors}`], ['Lots', z.lots.map(([w, d]) => `${w}×${d}`).join(', ') + ' cells (or your own with Lots)']],
      tool: { kind: 'zone', zone: z.id },
      isActive: (t) => t.kind === 'zone' && t.zone === z.id,
      locked: () => app.lockReason(z),
    })),
    { group: 'Tools', name: 'Remove zoning', color: '#ff6b5a', meta: 'Paint, drag or fill to clear zones', tool: { kind: 'zone', zone: 0, size: 1 }, isActive: (t) => t.kind === 'zone' && !t.zone },
  ],
});

registerCategory({
  key: 'landscaping', icon: '⛰️', name: 'Landscaping', order: 85,
  items: (app) => [
    { group: 'Terrain', name: 'Raise / lower', color: '#a08a6a', meta: 'Shift terrain', tool: { kind: 'terraform', mode: 'raise' }, isActive: (t) => t.kind === 'terraform' && t.mode !== 'level' && t.mode !== 'smooth' },
    { group: 'Terrain', name: 'Level', color: '#a08a6a', meta: 'Flatten to clicked height', tool: { kind: 'terraform', mode: 'level' }, isActive: (t) => t.kind === 'terraform' && t.mode === 'level' },
    { group: 'Terrain', name: 'Soften', color: '#a08a6a', meta: 'Smooth bumps', tool: { kind: 'terraform', mode: 'smooth' }, isActive: (t) => t.kind === 'terraform' && t.mode === 'smooth' },
    { group: 'Vegetation', name: 'Plant trees', color: '#4e8a35', meta: '₡10 each · brush', tool: { kind: 'tree', mode: 'plant' }, isActive: (t) => t.kind === 'tree' && t.mode !== 'remove' },
    { group: 'Vegetation', name: 'Clear trees', color: '#8a6440', meta: '₡4/cell · removes the forest resource', desc: 'Cut down trees with a brush. The forestry resource under them is removed too.', tool: { kind: 'tree', mode: 'remove', size: 1 }, isActive: (t) => t.kind === 'tree' && t.mode === 'remove' },
    ...SURFACES.filter(Boolean).map((s, k) => ({
      group: 'Surfaces', name: s.name, color: s.color, meta: '₡5/cell · decorative',
      tool: { kind: 'surface', surface: k + 1 }, isActive: (t) => t.kind === 'surface' && t.surface === k + 1,
    })),
    { group: 'Surfaces', name: 'Clear surface', color: '#555', meta: 'Remove paint', tool: { kind: 'surface', surface: 0 }, isActive: (t) => t.kind === 'surface' && !t.surface },
  ],
});

registerCategory({
  key: 'bulldoze', icon: '🚜', name: 'Bulldoze', order: 99,
  direct: (app) => app.tools.set({ kind: 'bulldoze', filter: 'all' }),
  toolKind: 'bulldoze',
});
