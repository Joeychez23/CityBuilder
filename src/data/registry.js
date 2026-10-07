// Look up a building definition by kind + type id (used when loading saves and by mods).
import { ZONES } from './zones.js';

const defs = { zone: { ...ZONES }, service: {}, signature: {} }; // copy: signatures add to zones

export function registerDefs(kind, map) {
  Object.assign(defs[kind] || (defs[kind] = {}), map);
}
export const defFor = (kind, type) => defs[kind]?.[type];
export const allDefs = (kind) => Object.values(defs[kind] || {});
