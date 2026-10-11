// Railway tunnels: bored under hills, rivers or the middle of town, a tunnel joins two
// stretches of track on the surface. It's an underground link between its two portals: trains
// go in at one and come out at the other, and nothing above it is touched.
// state.tunnels: [{ id, layer: 'rail', a, b (portal cells), len }]
// (Road tunnels are roads of the network that run underground: see sim/roadnet.js.)
import { N, idx, inBounds } from '../core/grid.js';
import { isOwned, spend } from './build.js';
import { bus } from '../core/events.js';

export const TUNNEL_MAX = 64;  // cells between portals
export const TUNNEL_COST = 700; // per cell, plus the track's own cost
const xy = (i) => [i % N, (i / N) | 0];
export const tunnelLength = (a, b) => { const [ax, ay] = xy(a), [bx, by] = xy(b); return Math.hypot(bx - ax, by - ay); };

export function planTunnel(state, layer, a, b) {
  const net = state.rail, raised = state.railH;
  const plan = { layer, a, b, len: tunnelLength(a, b), cost: 0, reason: null, type: 0 };
  const [ax, ay] = xy(a), [bx, by] = xy(b);
  for (const [i, x, y] of [[a, ax, ay], [b, bx, by]]) {
    if (!inBounds(x, y) || !isOwned(state, x, y)) { plan.reason = 'Both portals must be on your land'; return plan; }
    if (!net[i] || raised[i]) { plan.reason = 'Start and end on railway track (not on a bridge)'; return plan; }
    if ((state.tunnels || []).some((t) => t.a === i || t.b === i)) { plan.reason = 'A tunnel already starts there'; return plan; }
  }
  if (plan.len < 4) { plan.reason = 'Too short: a tunnel is at least 4 cells long'; return plan; }
  if (plan.len > TUNNEL_MAX) { plan.reason = `Too long: at most ${TUNNEL_MAX} cells`; return plan; }
  plan.cost = Math.round(plan.len * (TUNNEL_COST + 120));
  return plan;
}

export function buildTunnel(state, plan) {
  if (plan.reason) return { error: plan.reason };
  if (!spend(state, plan.cost, 'tunnels')) return { error: 'Not enough money' };
  state.tunnels = state.tunnels || [];
  state.tunnelSeq = (state.tunnelSeq || 0) + 1;
  const t = { id: state.tunnelSeq, layer: plan.layer, a: plan.a, b: plan.b, type: plan.type, len: plan.len, cost: plan.cost };
  state.tunnels.push(t);
  bus.emit('network:changed', { layer: plan.layer });
  bus.emit('tunnels:changed');
  bus.emit('xp', { amount: Math.round(plan.len), reason: 'tunnel' });
  return { tunnel: t };
}

// A tunnel whose portal lost its track closes; true if any did
export function pruneTunnels(state) {
  const before = (state.tunnels || []).length;
  state.tunnels = (state.tunnels || []).filter((t) => t.layer === 'rail' && state.rail[t.a] && state.rail[t.b]);
  if (state.tunnels.length !== before) { bus.emit('tunnels:changed'); return true; }
  return false;
}

// For routing: links between cells that aren't side by side, cell -> [[cell, cost]]: the two
// portals of each railway tunnel. Cached until
// the tunnels or the network change.
let cache = { rail: null, key: '' };
let netVersion = 0;
bus.on('network:changed', () => { netVersion++; });
export function jumpLinks(state, layer) {
  const key = netVersion + JSON.stringify((state.tunnels || []).map((t) => [t.id, t.a, t.b]));
  if (cache.key !== key || cache.state !== state) cache = { rail: undefined, key, state };
  if (cache[layer] !== undefined) return cache[layer];
  const m = new Map();
  const add = (a, b, c) => { if (!m.has(a)) m.set(a, []); m.get(a).push([b, c]); };
  for (const t of state.tunnels || []) {
    if (t.layer !== layer) continue;
    const c = t.len * 0.8;
    add(t.a, t.b, c);
    add(t.b, t.a, c);
  }
  cache[layer] = m.size ? m : null;
  return cache[layer];
}

// Are two neighbouring cells in a path really a jump through a tunnel?
export const isJump = (i, j) => { const dx = Math.abs((i % N) - (j % N)), dy = Math.abs(((i / N) | 0) - ((j / N) | 0)); return dx + dy > 1; };

// Network components joined through tunnels and underpasses (union-find on component labels)
export function joinThroughLinks(state, layer, comp, count) {
  const links = jumpLinks(state, layer);
  if (!links) return;
  const parent = Array.from({ length: count }, (_, k) => k);
  const find = (k) => { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
  for (const [a, list] of links) for (const [b] of list) { const p = comp[a], q = comp[b]; if (p >= 0 && q >= 0) parent[find(p)] = find(q); }
  for (let i = 0; i < comp.length; i++) if (comp[i] >= 0) comp[i] = find(comp[i]);
}

