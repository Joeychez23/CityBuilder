// 2D gradient noise (Perlin-style) plus fractal Brownian motion, all seeded.
import { makeRng } from './rng.js';

export function makeNoise(seed) {
  const r = makeRng(seed);
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r.next() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const grad = (h, x, y) => {
    switch (h & 7) {
      case 0: return x + y;
      case 1: return -x + y;
      case 2: return x - y;
      case 3: return -x - y;
      case 4: return x;
      case 5: return -x;
      case 6: return y;
      default: return -y;
    }
  };
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;

  // Returns roughly -1..1
  function noise2(x, y) {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);
    const aa = perm[perm[xi] + yi];
    const ab = perm[perm[xi] + yi + 1];
    const ba = perm[perm[xi + 1] + yi];
    const bb = perm[perm[xi + 1] + yi + 1];
    return lerp(
      lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u),
      lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u),
      v,
    ) * 0.9;
  }

  // Layers of noise at doubling frequency: big hills + medium bumps + small detail.
  function fbm(x, y, octaves = 5, lacunarity = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * noise2(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  // Ridged noise: sharp mountain crests.
  function ridged(x, y, octaves = 5) {
    let amp = 0.5, freq = 1, sum = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(noise2(x * freq, y * freq));
      sum += n * n * amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum;
  }

  return { noise2, fbm, ridged };
}
