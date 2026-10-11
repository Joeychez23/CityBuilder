// Decisions on the mayor's desk: requests and choices that come up while the city runs (a
// film shoot that wants to close some streets...). Each kind registers what its options do;
// a decision left too long expires (with its default option, if it has one).
import { bus } from '../core/events.js';

const KINDS = {};
// def: { apply(state, ctx, d, choice) -> { msg, kind }, expire?(state, ctx, d) -> { msg, kind } }
export function registerDecision(kind, def) { KINDS[kind] = def; }

// d: { kind, icon, title, text, options: [{ label, detail }], expires (day), cell?, target?, data }
export function addDecision(state, d) {
  state.decisions = state.decisions || [];
  state.decisionSeq = (state.decisionSeq || 0) + 1;
  d.id = state.decisionSeq;
  d.day = state.time.day;
  state.decisions.push(d);
  bus.emit('decision:new', d);
  return d;
}

export const pendingDecisions = (state) => state.decisions || [];

export function decide(state, ctx, id, choice) {
  const d = (state.decisions || []).find((x) => x.id === id);
  if (!d) return null;
  state.decisions = state.decisions.filter((x) => x !== d);
  const r = KINDS[d.kind]?.apply(state, ctx, d, choice) || { msg: '', kind: 'info' };
  bus.emit('decision:done', { d, choice, result: r });
  return r;
}

// Daily: decisions nobody answered in time
export function expireDecisions(state, ctx) {
  for (const d of [...(state.decisions || [])]) {
    if (d.expires == null || state.time.day < d.expires) continue;
    if (d.defaultChoice != null) { const r = decide(state, ctx, d.id, d.defaultChoice); if (r?.msg) bus.emit('notify', { kind: r.kind || 'info', icon: d.icon, title: d.title, msg: `No answer in time: ${r.msg}` }); continue; }
    state.decisions = state.decisions.filter((x) => x !== d);
    const r = KINDS[d.kind]?.expire?.(state, ctx, d);
    bus.emit('notify', { kind: r?.kind || 'info', icon: d.icon, title: d.title, quiet: !r?.msg, msg: r?.msg || 'The request lapsed.' });
  }
}
