// Curve geometry for the road network (sim/roadnet.js). A road segment is a cubic Bézier in
// the ground plane, in world units (one unit = one cell, x east, z south). Straight roads
// have their two control points at the thirds; a curve drawn through a bend point has them
// from that quadratic curve. Everything else (lanes, kerbs, zoning strips, the cells a road
// covers) is measured off the curve by distance along it.

// Point and direction on the curve at parameter t (0..1)
export function bez(c, t, out = [0, 0]) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  out[0] = a * c[0] + b * c[2] + d * c[4] + e * c[6];
  out[1] = a * c[1] + b * c[3] + d * c[5] + e * c[7];
  return out;
}
export function bezTan(c, t, out = [0, 0]) {
  const u = 1 - t;
  let x = 3 * u * u * (c[2] - c[0]) + 6 * u * t * (c[4] - c[2]) + 3 * t * t * (c[6] - c[4]);
  let z = 3 * u * u * (c[3] - c[1]) + 6 * u * t * (c[5] - c[3]) + 3 * t * t * (c[7] - c[5]);
  const l = Math.hypot(x, z);
  if (l < 1e-9) { x = c[6] - c[0]; z = c[7] - c[1]; }
  const k = Math.hypot(x, z) || 1;
  out[0] = x / k; out[1] = z / k;
  return out;
}

// The control polygon of a segment: [ax, az, c1x, c1z, c2x, c2z, bx, bz]
export const straightCurve = (ax, az, bx, bz) => [ax, az, ax + (bx - ax) / 3, az + (bz - az) / 3, ax + (2 * (bx - ax)) / 3, az + (2 * (bz - az)) / 3, bx, bz];
// A curve through a bend point q (as a quadratic Bézier, raised to a cubic)
export const quadCurve = (ax, az, qx, qz, bx, bz) => [ax, az, ax + (2 / 3) * (qx - ax), az + (2 / 3) * (qz - az), bx + (2 / 3) * (qx - bx), bz + (2 / 3) * (qz - bz), bx, bz];
export const isStraight = (c) => {
  const dx = c[6] - c[0], dz = c[7] - c[1], l = Math.hypot(dx, dz) || 1;
  const off = (x, z) => Math.abs((x - c[0]) * dz - (z - c[1]) * dx) / l;
  return off(c[2], c[3]) < 1e-3 && off(c[4], c[5]) < 1e-3;
};

// Split a curve at t into two curves (de Casteljau)
export function splitCurve(c, t) {
  const L = (p, q) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  const p0 = [c[0], c[1]], p1 = [c[2], c[3]], p2 = [c[4], c[5]], p3 = [c[6], c[7]];
  const a = L(p0, p1), b = L(p1, p2), d = L(p2, p3), e = L(a, b), f = L(b, d), g = L(e, f);
  return [[...p0, ...a, ...e, ...g], [...g, ...f, ...d, ...p3]];
}

// Arc-length table: samples at even parameter steps with the distance along at each
export function arcTable(c, steps = 0) {
  const chord = Math.hypot(c[6] - c[0], c[7] - c[1]) + Math.hypot(c[2] - c[0], c[3] - c[1]) * 0.5 + Math.hypot(c[6] - c[4], c[7] - c[5]) * 0.5;
  const n = steps || Math.max(8, Math.ceil(chord * 6));
  const ts = new Float32Array(n + 1), ss = new Float32Array(n + 1);
  const p = [0, 0];
  let px = c[0], pz = c[1], s = 0;
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    bez(c, t, p);
    s += Math.hypot(p[0] - px, p[1] - pz);
    px = p[0]; pz = p[1];
    ts[k] = t; ss[k] = s;
  }
  return { ts, ss, len: s };
}
// Parameter t at distance s along the curve
export function tAtS(tab, s) {
  const { ts, ss } = tab;
  if (s <= 0) return 0;
  if (s >= tab.len) return 1;
  let lo = 0, hi = ss.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ss[m] < s) lo = m; else hi = m; }
  const f = (s - ss[lo]) / Math.max(1e-9, ss[hi] - ss[lo]);
  return ts[lo] + (ts[hi] - ts[lo]) * f;
}
// Distance along the curve at parameter t
export function sAtT(tab, t) {
  const { ts, ss } = tab;
  if (t <= 0) return 0;
  if (t >= 1) return tab.len;
  const n = ts.length - 1, k = Math.min(n - 1, Math.floor(t * n));
  const f = (t - ts[k]) / Math.max(1e-9, ts[k + 1] - ts[k]);
  return ss[k] + (ss[k + 1] - ss[k]) * f;
}

// Points every `step` units along the curve: { x, z, tx, tz, s, t }[] (always both ends)
export function sampleCurve(c, tab, step) {
  const n = Math.max(1, Math.ceil(tab.len / step));
  const out = [];
  const p = [0, 0], d = [0, 0];
  for (let k = 0; k <= n; k++) {
    const s = (tab.len * k) / n;
    const t = tAtS(tab, s);
    bez(c, t, p); bezTan(c, t, d);
    out.push({ x: p[0], z: p[1], tx: d[0], tz: d[1], s, t });
  }
  return out;
}

// Nearest point on the curve to (px, pz): { t, s, x, z, d }
export function nearestOnCurve(c, tab, px, pz) {
  const n = Math.max(8, Math.ceil(tab.len * 2));
  const p = [0, 0];
  let bt = 0, bd = Infinity;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    bez(c, t, p);
    const d = (p[0] - px) ** 2 + (p[1] - pz) ** 2;
    if (d < bd) { bd = d; bt = t; }
  }
  // refine by halving the bracket around the best sample
  let lo = Math.max(0, bt - 1 / n), hi = Math.min(1, bt + 1 / n);
  for (let it = 0; it < 24; it++) {
    const t1 = lo + (hi - lo) / 3, t2 = hi - (hi - lo) / 3;
    bez(c, t1, p); const d1 = (p[0] - px) ** 2 + (p[1] - pz) ** 2;
    bez(c, t2, p); const d2 = (p[0] - px) ** 2 + (p[1] - pz) ** 2;
    if (d1 < d2) hi = t2; else lo = t1;
  }
  const t = (lo + hi) / 2;
  bez(c, t, p);
  return { t, s: sAtT(tab, t), x: p[0], z: p[1], d: Math.hypot(p[0] - px, p[1] - pz) };
}

// Where two curves cross: [{ ta, tb, x, z }] (from their sampled polylines, then refined)
export function curveCrossings(ca, taba, cb, tabb, ends = 0.02) {
  const A = sampleCurve(ca, taba, 0.25), B = sampleCurve(cb, tabb, 0.25);
  // quick reject on bounding boxes
  const box = (S) => S.reduce((b, p) => [Math.min(b[0], p.x), Math.min(b[1], p.z), Math.max(b[2], p.x), Math.max(b[3], p.z)], [Infinity, Infinity, -Infinity, -Infinity]);
  const ba = box(A), bb = box(B);
  if (ba[0] > bb[2] + 0.01 || bb[0] > ba[2] + 0.01 || ba[1] > bb[3] + 0.01 || bb[1] > ba[3] + 0.01) return [];
  const out = [];
  for (let i = 1; i < A.length; i++) {
    const a0 = A[i - 1], a1 = A[i];
    for (let j = 1; j < B.length; j++) {
      const b0 = B[j - 1], b1 = B[j];
      const r = segX(a0.x, a0.z, a1.x, a1.z, b0.x, b0.z, b1.x, b1.z);
      if (!r) continue;
      let ta = a0.t + (a1.t - a0.t) * r[0], tb = b0.t + (b1.t - b0.t) * r[1];
      // a few Newton steps on the curves themselves
      const pa = [0, 0], pb = [0, 0], da = [0, 0], db = [0, 0];
      for (let it = 0; it < 6; it++) {
        bez(ca, ta, pa); bez(cb, tb, pb);
        const ex = pb[0] - pa[0], ez = pb[1] - pa[1];
        if (Math.abs(ex) + Math.abs(ez) < 1e-7) break;
        // derivatives (unnormalised, by finite difference)
        const h = 1e-4;
        bez(ca, Math.min(1, ta + h), da); bez(cb, Math.min(1, tb + h), db);
        const ax = (da[0] - pa[0]) / h, az = (da[1] - pa[1]) / h, bx = (db[0] - pb[0]) / h, bz = (db[1] - pb[1]) / h;
        const den = ax * -bz - az * -bx;
        if (Math.abs(den) < 1e-9) break;
        const dta = (ex * -bz - ez * -bx) / den, dtb = (ax * ez - az * ex) / den;
        ta = Math.min(1, Math.max(0, ta + dta)); tb = Math.min(1, Math.max(0, tb + dtb));
      }
      if (ta < ends || ta > 1 - ends) continue;
      bez(ca, ta, pa);
      if (out.some((o) => Math.hypot(o.x - pa[0], o.z - pa[1]) < 0.2)) continue;
      out.push({ ta, tb, x: pa[0], z: pa[1] });
    }
  }
  return out.sort((p, q) => p.ta - q.ta);
}

// Two line pieces crossing: [fraction along the first, fraction along the second] or null
export function segX(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = cx - ax, qz = cz - az;
  const t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
  // (a little slack, so a road ending exactly on the other line still counts as crossing it)
  const e = 1e-7;
  return t >= -e && t <= 1 + e && u >= -e && u <= 1 + e ? [Math.min(1, Math.max(0, t)), Math.min(1, Math.max(0, u))] : null;
}
