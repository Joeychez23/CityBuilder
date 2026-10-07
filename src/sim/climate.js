// Seasons, temperature, and an hourly weather model: clouds, rain, snow, fog,
// thunderstorms and hail, plus wind. Weather feeds power output, heating, pollution,
// tourism, fire risk and road snow.
import { CLIMATES } from '../data/maps.js';
import { clamp } from '../core/grid.js';
import { monthOf, monthFloat, hourOf, seasonOf } from './simulation.js';
import { rng } from '../core/rng.js';
import { bus } from '../core/events.js';

// month may be fractional; whole numbers give the mid-month mean
export function monthlyMean(cl, month) {
  // coldest mid-January, warmest mid-July
  return (cl.minT + cl.maxT) / 2 - ((cl.maxT - cl.minT) / 2) * Math.cos(((month + 0.5) / 12) * Math.PI * 2);
}

export function weatherHourly(state, ctx) {
  const cl = CLIMATES[state.climate];
  const w = state.weather;
  const month = monthOf(state);
  const h = hourOf(state);
  // Temperature: seasonal mean + daily swing + a slowly wandering anomaly
  ctx.tempAnomaly = clamp((ctx.tempAnomaly || 0) + (rng.next() - 0.5) * 0.8, -5, 5);
  const target = monthlyMean(cl, monthFloat(state) - 0.5) + 4 * Math.sin(((h - 9) / 24) * Math.PI * 2) + ctx.tempAnomaly - w.cloud * 2;
  w.temp += (target - w.temp) * 0.35;

  // Clouds wander; precipitation needs clouds
  ctx.cloudTarget = clamp((ctx.cloudTarget ?? 0.3) + (rng.next() - 0.5) * 0.25 + (cl.rain - 0.3) * 0.05, 0, 1);
  w.cloud += (ctx.cloudTarget - w.cloud) * 0.3;
  const wet = w.cloud > 0.6 && rng.next() < cl.rain * 1.6;
  const precip = wet ? clamp((w.cloud - 0.55) * 2.4, 0, 1) : Math.max(0, (w.rain + w.snow) - 0.25);
  const cold = w.temp < 0.5;
  w.rain = cold ? 0 : precip;
  w.snow = cold && cl.snow !== false ? precip : 0;
  if (cold && cl.snow === false) w.rain = precip * 0.5;
  // Thunderstorms: warm and very cloudy; hail: cool storms
  w.storm = w.cloud > 0.85 && w.rain > 0.5 && w.temp > 14 ? clamp(w.storm + 0.4, 0, 1) : Math.max(0, w.storm - 0.35);
  w.hail = w.cloud > 0.8 && w.temp > 0 && w.temp < 12 && w.rain > 0.4 && rng.chance(0.03) ? 1 : 0;
  // Fog on cool, calm, damp mornings
  const morning = h > 4 && h < 10;
  w.fog = morning && w.wind < 0.35 && w.temp < 14 && w.cloud > 0.35 && (month >= 8 || month <= 3) ? clamp(w.fog + 0.25, 0, 1) : Math.max(0, w.fog - 0.2);
  // Wind: random walk around the climate's mean, direction drifts
  w.wind = clamp(w.wind + (rng.next() - 0.5) * 0.25 + (cl.wind - w.wind) * 0.1 + w.storm * 0.2, 0, 1.5);
  ctx.windAngle = (ctx.windAngle ?? 0.4) + (rng.next() - 0.5) * 0.2;
  ctx.windDir = [Math.cos(ctx.windAngle), Math.sin(ctx.windAngle)];

  // Dryness drives wildfire risk: heat and sun dry the land, rain wets it
  ctx.dryness = clamp((ctx.dryness ?? cl.dryness) + (w.temp > 20 ? 0.01 : 0) + (w.cloud < 0.3 ? 0.006 : 0) - w.rain * 0.08 - w.snow * 0.05, 0, 1);
  // Snow cover on the ground (for terrain colour)
  ctx.snowCover = clamp((ctx.snowCover || 0) + w.snow * 0.08 - (w.temp > 1 ? 0.04 + w.temp * 0.004 : 0), 0, 1);

  w.kind = w.hail ? 'hail' : w.storm > 0.3 ? 'storm' : w.snow > 0.1 ? 'snow' : w.rain > 0.1 ? 'rain' : w.fog > 0.4 ? 'fog' : w.cloud > 0.75 ? 'overcast' : w.cloud > 0.4 ? 'cloudy' : 'clear';
  if (w.kind !== ctx.lastKind) {
    ctx.lastKind = w.kind;
    bus.emit('weather', w);
  }
  if (w.hail) bus.emit('hail');
  // Track the seasons seen in a snowy climate (achievement "Four Seasons")
  if (cl.snow) {
    const seen = new Set(state.counters.seasonsSeen || []);
    seen.add(seasonOf(state));
    state.counters.seasonsSeen = [...seen];
  }
}
