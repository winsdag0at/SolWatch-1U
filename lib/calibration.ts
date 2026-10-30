// Bench validation of the polarimetric soiling method.

import { stokes, soilingIndex } from './physics';

export interface BenchRow {
  label: string;
  dust: number; // dust loading on the glass sample, g/m²
  rot: number; // payload rotation about the optical axis, deg
  i0: number; i45: number; i90: number; i135: number; // V
  isc: number; // reference PV cell short-circuit current, % of clean
}

export const BENCH_COLUMNS = ['label', 'dust_gm2', 'rot_deg', 'i0', 'i45', 'i90', 'i135', 'isc_pct'] as const;

/** Small deterministic PRNG so the example set is identical on every load. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

/**
 * EXAMPLE data generated from the design model plus sensor noise. It only
 * shows how the analysis works — replace it with real bench measurements.
 */
export function exampleBench(): BenchRow[] {
  const rnd = rng(42);
  const n = (s: number) => (rnd() + rnd() + rnd() - 1.5) * s;
  const row = (label: string, dust: number, rot: number): BenchRow => {
    const dolp = 0.84 * Math.exp(-dust / 3.2);
    const s0 = 2.82 * (1 - 0.02 * dust);
    const ch = [0, 45, 90, 135].map((th) => (s0 / 2) * (1 + dolp * Math.cos(((th - rot) * Math.PI) / 90)) + n(0.012));
    return {
      label, dust, rot,
      i0: +ch[0].toFixed(3), i45: +ch[1].toFixed(3), i90: +ch[2].toFixed(3), i135: +ch[3].toFixed(3),
      isc: +(100 - 4.1 * dust + 0.12 * dust * dust + n(0.5)).toFixed(1),
    };
  };
  return [
    row('Clean glass A', 0, 0), row('Clean glass B', 0, 0), row('Clean glass C', 0, 0), row('Clean glass D', 0, 0),
    row('Dust 0.5 g/m²', 0.5, 0), row('Dust 1 g/m²', 1, 0), row('Dust 2 g/m²', 2, 0), row('Dust 3 g/m²', 3, 0),
    row('Dust 4 g/m²', 4, 0), row('Dust 6 g/m²', 6, 0), row('Dust 8 g/m²', 8, 0),
    row('Rotation 30°', 2, 30), row('Rotation 60°', 2, 60), row('Rotation 90°', 2, 90), row('Rotation 120°', 2, 120),
  ];
}

export function analyseBench(rows: BenchRow[], dolpCleanRef?: number) {
  const pts = rows.map((r) => {
    const st = stokes(r.i0, r.i45, r.i90, r.i135);
    return { ...r, ...st, loss: 100 - r.isc };
  });
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const sd = (a: number[]) => {
    const m = mean(a);
    return a.length > 1 ? Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)) : NaN;
  };
  const clean = pts.filter((p) => p.dust === 0);
  const dolpClean = clean.length ? mean(clean.map((p) => p.dolp)) : dolpCleanRef ?? 0.84;
  const withSI = pts.map((p) => ({ ...p, si: soilingIndex(p.dolp, dolpClean) }));

  // transmission loss = k · SI (least squares through the origin)
  const sxy = withSI.reduce((a, p) => a + p.si * p.loss, 0);
  const sxx = withSI.reduce((a, p) => a + p.si * p.si, 0);
  const k = sxx > 0 ? sxy / sxx : NaN;
  const lm = mean(withSI.map((p) => p.loss));
  const ssTot = withSI.reduce((a, p) => a + (p.loss - lm) ** 2, 0);
  const ssRes = withSI.reduce((a, p) => a + (p.loss - k * p.si) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : NaN;

  // detection limit: 3σ of clean-glass SI over the low-dust SI slope
  const siNoise = sd(withSI.filter((p) => p.dust === 0).map((p) => p.si));
  const low = withSI.filter((p) => p.dust > 0 && p.dust <= 2 && p.rot === 0);
  const slope = low.length ? mean(low.map((p) => p.si / p.dust)) : NaN;
  const detectLimit = (3 * siNoise) / slope;

  // rotation invariance: DoLP spread across rotations of the same sample
  const rotSet = withSI.filter((p) => p.dust === 2);
  const rotSpread = rotSet.length > 1 ? Math.max(...rotSet.map((p) => p.dolp)) - Math.min(...rotSet.map((p) => p.dolp)) : NaN;
  const aolpErr = rotSet.length ? mean(rotSet.map((p) => Math.abs((((p.aolp - p.rot) % 180) + 270) % 180 - 90))) : NaN;

  return { pts: withSI, dolpClean, cleanSd: sd(clean.map((p) => p.dolp)), k, r2, siNoise, detectLimit, rotSpread, aolpErr, nClean: clean.length };
}

export function benchToCsv(rows: BenchRow[]) {
  return [BENCH_COLUMNS.join(','), ...rows.map((r) => [r.label, r.dust, r.rot, r.i0, r.i45, r.i90, r.i135, r.isc].join(','))].join('\n');
}

export function benchFromCsv(text: string): BenchRow[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (/label|dust/i.test(lines[0])) lines.shift();
  return lines.map((l, i) => {
    const c = l.split(',').map((x) => x.trim());
    if (c.length < 8) throw new Error(`line ${i + 1}: expected 8 columns`);
    const num = (j: number) => {
      const v = Number(c[j]);
      if (!Number.isFinite(v)) throw new Error(`line ${i + 1}: "${c[j]}" is not a number`);
      return v;
    };
    return { label: c[0], dust: num(1), rot: num(2), i0: num(3), i45: num(4), i90: num(5), i135: num(6), isc: num(7) };
  });
}
