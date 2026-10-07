// Seeded random numbers, so a map seed always produces the same terrain.
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    // mulberry32: tiny, fast, good enough for games
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), // inclusive
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
  };
}

// Shared unseeded-ish RNG for moment-to-moment simulation (fires, accidents, births...).
export const rng = makeRng(Date.now() & 0xffffffff);
