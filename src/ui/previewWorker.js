// The start screen's map previews, made in a worker so the menu stays responsive (making a
// whole map takes a moment). Message: { id, map, S } -> { id, pixels } (S × S RGBA).
import { createState } from '../core/state.js';
import { generateMap, applyCustomMap } from '../sim/mapgen.js';
import { previewPixels } from './previewPixels.js';

self.onmessage = ({ data: { id, map, S } }) => {
  const st = createState(map);
  generateMap(st, map);
  if (map.custom) applyCustomMap(st, map.custom);
  const pixels = previewPixels(st, S);
  self.postMessage({ id, pixels }, [pixels.buffer]);
};
