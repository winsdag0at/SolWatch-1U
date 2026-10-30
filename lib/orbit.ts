// Candidate-orbit propagator for SolWatch-1U: circular sun-synchronous orbit
// with J2 nodal precession, spherical Earth, low-precision Sun ephemeris and
// a cylindrical Earth shadow. Accurate to a few km / ~1 min — enough for pass
// planning before a TLE exists. Swap for SGP4 once the satellite has a TLE.

export const RE = 6371; // km
const MU = 398600.4418; // km³/s²
const J2 = 1.08263e-3;
const RE_EQ = 6378.137;
export const SUN_RATE = (2 * Math.PI) / (365.2422 * 86400); // rad/s
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export interface OrbitConfig {
  id: string;
  label: string;
  altKm: number;
  incDeg: number | 'SSO';
  ltdnHours: number; // local time of descending node at epoch (fixed for SSO, drifts otherwise)
  minElDeg: number; // ground-station mask
}

export const ORBIT_OPTIONS: OrbitConfig[] = [
  { id: 'iss', label: 'ISS deployment · 51.6° · 420 km', altKm: 420, incDeg: 51.6, ltdnHours: 10.5, minElDeg: 10 },
  { id: 'sso1030', label: 'Sun-synchronous 10:30 · 500 km', altKm: 500, incDeg: 'SSO', ltdnHours: 10.5, minElDeg: 10 },
  { id: 'ssodd', label: 'Dawn-dusk SSO 06:00 · 500 km', altKm: 500, incDeg: 'SSO', ltdnHours: 6, minElDeg: 10 },
];

export const DEFAULT_ORBIT = ORBIT_OPTIONS[0];

export interface GeoPoint { lat: number; lon: number }

export interface Look { el: number; az: number; rangeKm: number }

export interface Pass {
  aos: number; los: number; tca: number; // ms
  maxEl: number;
  aosAz: number; losAz: number;
  daylight: boolean; // sun up at the ground station at TCA
  track: { t: number; el: number; az: number }[];
}

/** Inclination that makes the node precess with the mean Sun (circular orbit). */
export function ssoInclination(altKm: number) {
  const a = RE_EQ + altKm;
  const cosI = -(2 * SUN_RATE * Math.pow(a, 3.5)) / (3 * J2 * RE_EQ * RE_EQ * Math.sqrt(MU));
  return Math.acos(cosI) * R2D;
}

export const periodMin = (altKm: number) => (2 * Math.PI * Math.sqrt(Math.pow(RE_EQ + altKm, 3) / MU)) / 60;

const jd = (t: number) => t / 86_400_000 + 2440587.5;

export function gmstRad(t: number) {
  const d = jd(t) - 2451545.0;
  return (((280.46061837 + 360.98564736629 * d) % 360) + 360) % 360 * D2R;
}

/** Sun unit vector (ECI, equatorial) and right ascension. */
export function sunEci(t: number) {
  const n = jd(t) - 2451545.0;
  const L = (280.46 + 0.9856474 * n) * D2R;
  const g = (357.528 + 0.9856003 * n) * D2R;
  const lam = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;
  const v: [number, number, number] = [Math.cos(lam), Math.cos(eps) * Math.sin(lam), Math.sin(eps) * Math.sin(lam)];
  return { v, ra: Math.atan2(v[1], v[0]) };
}

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function ecefOf(p: GeoPoint, r = RE): [number, number, number] {
  const la = p.lat * D2R;
  const lo = p.lon * D2R;
  return [r * Math.cos(la) * Math.cos(lo), r * Math.cos(la) * Math.sin(lo), r * Math.sin(la)];
}

function eciToEcef(v: number[], t: number): [number, number, number] {
  const g = gmstRad(t);
  const c = Math.cos(g);
  const s = Math.sin(g);
  return [c * v[0] + s * v[1], -s * v[0] + c * v[1], v[2]];
}

export function lookAngles(satEcef: number[], gs: GeoPoint): Look {
  const g = ecefOf(gs);
  const rho = [satEcef[0] - g[0], satEcef[1] - g[1], satEcef[2] - g[2]];
  const range = Math.hypot(rho[0], rho[1], rho[2]);
  const la = gs.lat * D2R;
  const lo = gs.lon * D2R;
  const up = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  const east = [-Math.sin(lo), Math.cos(lo), 0];
  const north = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
  const el = Math.asin(dot(rho, up) / range) * R2D;
  const az = ((Math.atan2(dot(rho, east), dot(rho, north)) * R2D) + 360) % 360;
  return { el, az, rangeKm: range };
}

/** Sun elevation (deg) at a ground point. */
export function sunElevation(t: number, p: GeoPoint) {
  const s = eciToEcef(sunEci(t).v, t);
  const la = p.lat * D2R;
  const lo = p.lon * D2R;
  const up = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  return Math.asin(dot(s, up)) * R2D;
}

/** Slant range for a given elevation (spherical Earth). */
export function slantRangeKm(elDeg: number, altKm: number) {
  const e = elDeg * D2R;
  const r = RE + altKm;
  return Math.sqrt(r * r - Math.pow(RE * Math.cos(e), 2)) - RE * Math.sin(e);
}

/** Ground radius (km) of the visibility circle for a mask elevation. */
export function footprintRadiusKm(elDeg: number, altKm: number) {
  const e = elDeg * D2R;
  const lam = Math.acos((RE / (RE + altKm)) * Math.cos(e)) - e;
  return lam * RE;
}

export interface SatState {
  t: number;
  lat: number; lon: number;
  sunlit: boolean;
  argLatDeg: number; // 0 = ascending node
  ecef: [number, number, number];
}

export class OrbitModel {
  readonly incDeg: number;
  readonly periodMin: number;
  private n: number; // rad/s
  private raan0: number;
  private nodeRate: number;
  private u0 = 0;
  private raanOff = 0;

  constructor(readonly cfg: OrbitConfig, readonly epoch: number, readonly gs: GeoPoint) {
    this.incDeg = cfg.incDeg === 'SSO' ? ssoInclination(cfg.altKm) : cfg.incDeg;
    this.periodMin = periodMin(cfg.altKm);
    const a = RE_EQ + cfg.altKm;
    this.n = Math.sqrt(MU / (a * a * a));
    // J2 nodal precession (equals the Sun's mean motion for SSO)
    this.nodeRate = -1.5 * this.n * J2 * Math.pow(RE_EQ / a, 2) * Math.cos(this.incDeg * D2R);
    // ascending node is 12 h from the descending node
    const ltan = (cfg.ltdnHours + 12) % 24;
    this.raan0 = sunEci(epoch).ra + (ltan - 12) * 15 * D2R;
  }

  /**
   * Pick the in-orbit phase (and, for non-SSO orbits, the node — both depend
   * on the deployment date) so a good pass starts ~`leadMin` after `t`.
   * SSO geometry may make that impossible; the closest option is kept.
   */
  phaseForPassAt(t: number, leadMin: number) {
    const raans = this.cfg.incDeg === 'SSO' ? [0] : Array.from({ length: 36 }, (_, i) => i * 10);
    const uStep = this.cfg.incDeg === 'SSO' ? 1 : 3;
    let best = { u: 0, raan: 0, score: Infinity };
    for (const raan of raans) {
      this.raanOff = raan * D2R;
      for (let u = 0; u < 360; u += uStep) {
        this.u0 = u * D2R;
        for (let m = 0; m <= 90; m += 1) {
          const el = this.look(t + m * 60_000).el;
          if (el >= this.cfg.minElDeg) {
            // prefer a high pass near the requested time
            let peak = el;
            for (let k = 1; k < 8; k++) peak = Math.max(peak, this.look(t + (m + k) * 60_000).el);
            const score = Math.abs(m - leadMin) + (peak < 40 ? 30 : 0);
            if (score < best.score) best = { u, raan, score };
            break;
          }
        }
      }
    }
    this.u0 = best.u * D2R;
    this.raanOff = best.raan * D2R;
  }

  eci(t: number): [number, number, number] {
    const dt = (t - this.epoch) / 1000;
    const u = this.u0 + this.n * dt;
    const raan = this.raan0 + this.raanOff + this.nodeRate * dt;
    const i = this.incDeg * D2R;
    const r = RE + this.cfg.altKm;
    const cu = Math.cos(u);
    const su = Math.sin(u);
    const cO = Math.cos(raan);
    const sO = Math.sin(raan);
    return [r * (cO * cu - sO * su * Math.cos(i)), r * (sO * cu + cO * su * Math.cos(i)), r * su * Math.sin(i)];
  }

  state(t: number): SatState {
    const v = this.eci(t);
    const e = eciToEcef(v, t);
    const r = Math.hypot(e[0], e[1], e[2]);
    const s = sunEci(t).v;
    const d = dot(v, s);
    const perp = Math.hypot(v[0] - d * s[0], v[1] - d * s[1], v[2] - d * s[2]);
    const dt = (t - this.epoch) / 1000;
    const u = (((this.u0 + this.n * dt) * R2D) % 360 + 360) % 360;
    return {
      t,
      lat: Math.asin(e[2] / r) * R2D,
      lon: Math.atan2(e[1], e[0]) * R2D,
      sunlit: d > 0 || perp > RE,
      argLatDeg: u,
      ecef: e,
    };
  }

  look(t: number): Look {
    return lookAngles(eciToEcef(this.eci(t), t), this.gs);
  }

  /** Predict passes in [t0, t0 + hours]. */
  passes(t0: number, hours: number, stepS = 20): Pass[] {
    const out: Pass[] = [];
    const mask = this.cfg.minElDeg;
    let cur: Pass | null = null;
    let prevEl = this.look(t0).el;
    for (let t = t0; t <= t0 + hours * 3_600_000; t += stepS * 1000) {
      const l = this.look(t);
      if (l.el >= mask && !cur) {
        const frac = prevEl < mask ? (mask - prevEl) / (l.el - prevEl) : 0;
        cur = { aos: t - (1 - frac) * stepS * 1000, los: t, tca: t, maxEl: l.el, aosAz: l.az, losAz: l.az, daylight: false, track: [] };
      }
      if (cur) {
        if (l.el >= mask) {
          cur.track.push({ t, el: l.el, az: l.az });
          if (l.el > cur.maxEl) { cur.maxEl = l.el; cur.tca = t; }
          cur.los = t;
          cur.losAz = l.az;
        } else {
          const frac = (prevEl - mask) / (prevEl - l.el);
          cur.los = t - (1 - frac) * stepS * 1000;
          cur.daylight = sunElevation(cur.tca, this.gs) > 0;
          out.push(cur);
          cur = null;
        }
      }
      prevEl = l.el;
    }
    return out;
  }

  /** Ground track samples for map drawing. */
  track(t0: number, t1: number, stepS = 30): GeoPoint[] {
    const pts: GeoPoint[] = [];
    for (let t = t0; t <= t1; t += stepS * 1000) {
      const s = this.state(t);
      pts.push({ lat: s.lat, lon: s.lon });
    }
    return pts;
  }

  /** Minutes until the next sunlit/eclipse transition. */
  minsToSunChange(t: number) {
    const now = this.state(t).sunlit;
    for (let m = 1; m <= 120; m++) if (this.state(t + m * 60_000).sunlit !== now) return m;
    return null;
  }

  /** Sunlit fraction of one orbit starting at t (sampled each minute). */
  sunlitFraction(t: number) {
    const n = Math.round(this.periodMin);
    let lit = 0;
    for (let m = 0; m < n; m++) if (this.state(t + m * 60_000).sunlit) lit++;
    return lit / n;
  }
}
