// Signature buildings: track unlock progress, let the player place each one once, and
// spread their well-being bonus over the surrounding area.
import { SIGNATURES } from '../data/signatures.js';
import { registerCategory } from '../ui/toolbar.js';
import { registerSystem } from '../sim/simulation.js';
import { createBuilding, footprintBlocker } from '../sim/build.js';
import { touchesGroundRoad, center } from '../sim/services.js';
import { updateCapacity } from '../sim/growth.js';
import { startConstruction } from '../sim/construction.js';
import { N, idx, forRadius } from '../core/grid.js';
import { bus } from '../core/events.js';

// Numbers the unlock conditions look at
function cityStats(state, ctx) {
  const zoneCells = {};
  for (let i = 0; i < state.zone.length; i++) {
    const z = state.zone[i];
    if (!z) continue;
    const key = ['', 'res_low', 'res_row', 'res_med', 'res_high', 'res_mixed', 'res_lowrent'][z];
    if (key) zoneCells[key] = (zoneCells[key] || 0) + 1;
  }
  const catCount = { res: 0, com: 0, ind: 0, off: 0 };
  const levelCount = { res_high3: 0, com_high4: 0 };
  for (const b of state.buildings.values()) {
    if (b.kind !== 'zone' || b.def.signature) continue;
    if (catCount[b.def.cat] != null) catCount[b.def.cat]++;
    if (b.def.key === 'res_high' && b.level >= 3) levelCount.res_high3++;
    if (b.def.key === 'com_high' && b.level >= 4) levelCount.com_high4++;
  }
  const produced = {};
  for (const [k, v] of Object.entries(state.market)) if (v && typeof v === 'object') produced[k] = v.produced || 0;
  return {
    zoneCells: new Proxy(zoneCells, { get: (o, k) => o[k] || 0 }), catCount, levelCount, produced,
    population: state.citizens.size, happiness: state.stats.happiness || 0, hasUniversity: !!ctx.hasUniversity,
  };
}

export const builtSignature = (state, def) => [...state.buildings.values()].some((b) => b.def === def);

function signatureBlocker(state, ctx, def, x0, y0, x1, y1) {
  if (!state.unlockedSignatures.includes(def.id) && !state.options.unlockAll) return `Locked: ${def.req}`;
  if (builtSignature(state, def)) return 'Already built (one per city)';
  const blocked = footprintBlocker(state, x0, y0, x1, y1);
  if (blocked) return blocked;
  if (!touchesGroundRoad(state, x0, y0, x1, y1)) return 'Needs a road next to it';
  return null;
}

function placeSignature(state, ctx, def, x0, y0, x1, y1, rot) {
  const reason = signatureBlocker(state, ctx, def, x0, y0, x1, y1);
  if (reason) return { error: reason };
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) state.zone[idx(x, y)] = 0;
  const b = createBuilding(state, 'zone', def, x0, y0, x1, y1, rot, { level: 5 });
  b.level = 5;
  b.name = def.name;
  updateCapacity(b);
  startConstruction(state, b);
  state.counters.signatures = (state.counters.signatures || 0) + 1;
  state.journal.push({ day: state.time.day, kind: 'milestone', text: `Built ${def.name}` });
  bus.emit('xp', { amount: 60, reason: 'signature' });
  bus.emit('signatures:changed');
  return { building: b };
}

export function computeSigBoost(state, ctx) {
  const g = ctx.sigBoost || (ctx.sigBoost = new Float32Array(N * N));
  g.fill(0);
  for (const b of state.buildings.values()) {
    if (!b.def.signature || b.cons) continue;
    const [cx, cy] = center(b);
    forRadius(cx + 0.5, cy + 0.5, b.def.radius, (x, y, d) => {
      const i = idx(x, y);
      g[i] = Math.max(g[i], b.def.wellbeing * (1 - (d / b.def.radius) * 0.5));
    });
  }
}

export const signatureFeature = {
  init(app) {
    const { state, ctx } = app;
    registerSystem({
      name: 'signatures', every: 'day', run: () => {
        const st = cityStats(state, ctx);
        ctx.signatureProgress = {};
        for (const def of SIGNATURES) {
          const p = Math.max(0, Math.min(1, def.check(st) || 0));
          ctx.signatureProgress[def.id] = p;
          if (p >= 1 && !state.unlockedSignatures.includes(def.id)) {
            state.unlockedSignatures.push(def.id);
            app.toast(`${def.name} can now be built for free from the Signature menu.`, 'good', '★ Signature building unlocked');
            bus.emit('unlocks:changed');
          }
        }
        computeSigBoost(state, ctx);
      },
    });
    bus.on('signatures:changed', () => computeSigBoost(state, ctx));
    bus.on('building:remove', (b) => { if (b.def.signature) computeSigBoost(state, ctx); });
    bus.on('construction:done', (b) => { if (b.def.signature) computeSigBoost(state, ctx); });
    computeSigBoost(state, ctx);

    registerCategory({
      key: 'signature', icon: '★', name: 'Signature', order: 80,
      items: () => SIGNATURES.map((def) => ({
        group: { res: 'Residential', com: 'Commercial', ind: 'Industrial', off: 'Office' }[def.cat],
        name: def.name, color: '#d4af37',
        meta: builtSignature(state, def) ? '✓ Built' : state.unlockedSignatures.includes(def.id) || state.options.unlockAll ? 'Free · ready to build' : `${Math.round((ctx.signatureProgress?.[def.id] || 0) * 100)}% · ${def.req}`,
        desc: def.desc,
        tool: { kind: 'plop', def, blocker: signatureBlocker, place_fn: placeSignature, once: true },
        isActive: (t) => t.kind === 'plop' && t.def === def,
        locked: () => (builtSignature(state, def) ? 'Already built' : state.unlockedSignatures.includes(def.id) || state.options.unlockAll ? null : def.req),
      })),
    });
  },
};
