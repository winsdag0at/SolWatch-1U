// Core SolWatch-1U formulas. Everything the ground station derives from the
// raw packets lives here so the simulator and Live mode share one definition.

/** Measured DoLP of clean panel glass (lab calibration). */
export const DOLP_CLEAN = 0.84;

/** Minimum S0 (V) for a payload reading to count — below this the farm is dark. */
export const S0_MIN_VALID = 0.5;

export const THRESH = {
  siDusty: 0.3, // set dusty above this
  siClear: 0.2, // clear dusty below this
  wetPlateSet: 500,
  wetPlateClear: 380,
  marginSet: 0, // °C, wet when margin < 0
  marginClear: 1, // °C, dry when margin > 1
  persistence: 3, // consecutive readings to change a flag
} as const;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface Stokes {
  s0: number;
  s1: number;
  s2: number;
  dolp: number;
  aolp: number; // degrees, -90..90
}

export function stokes(i0: number, i45: number, i90: number, i135: number): Stokes {
  const s0 = (i0 + i45 + i90 + i135) / 2;
  const s1 = i0 - i90;
  const s2 = i45 - i135;
  const dolp = s0 > 0 ? clamp(Math.sqrt(s1 * s1 + s2 * s2) / s0, 0, 1) : 0;
  const aolp = (0.5 * Math.atan2(s2, s1) * 180) / Math.PI;
  return { s0, s1, s2, dolp, aolp };
}

export function soilingIndex(dolp: number): number {
  return clamp(1 - dolp / DOLP_CLEAN, 0, 1);
}

/** Magnus dew point, b = 17.62, c = 243.12 °C. */
export function dewPoint(tC: number, rh: number): number {
  const b = 17.62;
  const c = 243.12;
  const gamma = Math.log(clamp(rh, 0.1, 100) / 100) + (b * tC) / (c + tC);
  return (c * gamma) / (b - gamma);
}

/** Inverse Magnus: relative humidity for a given air temperature and dew point. */
export function rhFromDewPoint(tC: number, td: number): number {
  const b = 17.62;
  const c = 243.12;
  return clamp(100 * Math.exp((b * td) / (c + td) - (b * tC) / (c + tC)), 1, 100);
}

/**
 * Forward model of the 4 polarizer channels (Malus' law for partially
 * polarized light): I(θ) = S0/2 · (1 + DoLP · cos 2(θ − AoLP)).
 */
export function channelsFor(s0: number, dolp: number, aolpDeg: number): [number, number, number, number] {
  return [0, 45, 90, 135].map((th) => {
    const r = ((th - aolpDeg) * Math.PI) / 90; // 2(θ − AoLP) in radians
    return clamp((s0 / 2) * (1 + dolp * Math.cos(r)), 0, 3.3);
  }) as [number, number, number, number];
}

/** TEMT6000 into 4.7 kΩ load at ~0.5 µA/lux → lux from channel voltage. */
export const voltsToLux = (v: number) => v / (4700 * 0.5e-6);

/** LiPo single cell open-circuit curve, V → %. */
const LIPO: [number, number][] = [
  [3.0, 0], [3.3, 5], [3.5, 15], [3.6, 30], [3.7, 48],
  [3.8, 62], [3.9, 75], [4.0, 85], [4.1, 94], [4.2, 100],
];

export function battPercent(v: number): number {
  if (v <= LIPO[0][0]) return 0;
  for (let i = 1; i < LIPO.length; i++) {
    const [v1, p1] = LIPO[i];
    const [v0, p0] = LIPO[i - 1];
    if (v <= v1) return p0 + ((v - v0) / (v1 - v0)) * (p1 - p0);
  }
  return 100;
}

export function battVoltsFromPercent(p: number): number {
  p = clamp(p, 0, 100);
  for (let i = 1; i < LIPO.length; i++) {
    const [v1, p1] = LIPO[i];
    const [v0, p0] = LIPO[i - 1];
    if (p <= p1) return v0 + ((p - p0) / (p1 - p0)) * (v1 - v0);
  }
  return 4.2;
}

/**
 * Cementing Risk Index (0–100): rises only when dust and moisture are present
 * together. Geometric mean so either factor at zero gives zero risk.
 */
export function cementingRisk(si: number, margin: number | null, wetPlate: number | null): number {
  const dust = clamp((si - 0.1) / 0.45, 0, 1);
  const wetFromPlate = wetPlate == null ? 0 : clamp((wetPlate - THRESH.wetPlateClear) / 220, 0, 1);
  const wetFromMargin = margin == null ? 0 : clamp((1.5 - margin) / 2.5, 0, 1);
  const wet = Math.max(wetFromPlate, wetFromMargin);
  return Math.round(100 * Math.sqrt(dust * wet));
}

/** Rough model of PV output lost to soiling, for context only. */
export const soilingLossPct = (si: number) => 30 * si;
