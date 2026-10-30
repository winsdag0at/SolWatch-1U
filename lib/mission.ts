// Mission design budgets. Defaults are design estimates for a COTS 1U build —
// every value is editable on the Mission page and should be replaced with
// measured numbers as hardware is tested.

import { GROUND_STATION } from './farms';
import { DEFAULT_LINK, airtimeMs, linkBudget, type LinkConfig } from './link';
import { OrbitModel, periodMin, ssoInclination, type OrbitConfig } from './orbit';

export interface PowerRow { name: string; mA: number; duty: number; auto?: 'tx' } // duty 0..100 %
export interface MassRow { name: string; g: number }
export interface SolarCfg {
  cellAreaCm2: number; // per face
  faces: number;
  efficiency: number; // %
  chargeEff: number; // %
  battmAh: number;
  battV: number;
  busV: number;
}

export interface MissionCfg {
  link: LinkConfig;
  power: PowerRow[];
  solar: SolarCfg;
  mass: MassRow[];
}

export const DEFAULT_MISSION: MissionCfg = {
  link: DEFAULT_LINK,
  power: [
    { name: 'ESP32 OBC (CPU on, Wi-Fi/BT off)', mA: 45, duty: 100 },
    { name: 'SX1278 receive (listening for dew nodes)', mA: 12, duty: 100 },
    { name: 'SX1278 transmit @ 20 dBm (pass time)', mA: 120, duty: 1.5, auto: 'tx' },
    { name: 'ADS1115 ADC', mA: 0.15, duty: 100 },
    { name: '4 × TEMT6000 (daylight)', mA: 2, duty: 50 },
    { name: 'QMC5883L magnetometer', mA: 0.1, duty: 100 },
    { name: 'DS18B20 temperature (conversions)', mA: 1, duty: 10 },
    { name: 'INA219 power monitor', mA: 1, duty: 100 },
    { name: 'Regulator quiescent + losses', mA: 5, duty: 100 },
  ],
  solar: { cellAreaCm2: 60, faces: 5, efficiency: 18, chargeEff: 85, battmAh: 3000, battV: 3.7, busV: 3.3 },
  mass: [
    { name: '1U aluminium structure + side panels', g: 180 },
    { name: 'ESP32 module', g: 10 },
    { name: 'SX1278 module + deployable whip', g: 15 },
    { name: 'Payload: 4 × TEMT6000 + polarizers + baffle', g: 28 },
    { name: 'ADS1115, QMC5883L, DS18B20, INA219 boards', g: 11 },
    { name: '18650 Li-ion cell + holder', g: 57 },
    { name: 'Solar panels (5 faces)', g: 75 },
    { name: 'PCBs, wiring, connectors', g: 60 },
    { name: 'Fasteners', g: 25 },
  ],
};

export const SOLAR_CONSTANT = 1361; // W/m²
export const MASS_LIMIT_G = 1330; // CDS Rev 13 1U limit (Rev 14 allows 2.00 kg) — budget against the tighter one
export const MASS_CONTINGENCY = 0.2;
export const FARMS_N = 3;

export function powerBudget(c: MissionCfg, sunlitFrac: number, txDutyPct: number) {
  const rows = c.power.map((r) => {
    const duty = r.auto === 'tx' ? txDutyPct : r.duty;
    return { ...r, duty, avgmW: r.mA * c.solar.busV * (duty / 100) };
  });
  const loadW = rows.reduce((a, r) => a + r.avgmW, 0) / 1000;
  const txW = (c.power.find((r) => r.auto === 'tx')?.mA ?? 0) * c.solar.busV / 1000;
  // A tumbling cube shows on average (total covered area)/4 to the Sun.
  const projM2 = (c.solar.cellAreaCm2 * c.solar.faces) / 4 / 10_000;
  const genSunlitW = SOLAR_CONSTANT * projM2 * (c.solar.efficiency / 100) * (c.solar.chargeEff / 100);
  const genAvgW = genSunlitW * sunlitFrac;
  const battWh = (c.solar.battmAh / 1000) * c.solar.battV;
  return {
    rows, loadW, txW, genSunlitW, genAvgW, battWh,
    marginW: genAvgW - loadW,
  };
}

export function eclipseDod(battWh: number, loadW: number, eclipseMin: number) {
  return (100 * loadW * (eclipseMin / 60)) / battWh;
}

export function massBudget(rows: MassRow[]) {
  const total = rows.reduce((a, r) => a + r.g, 0);
  const withCont = total * (1 + MASS_CONTINGENCY);
  return { total, withCont, marginG: MASS_LIMIT_G - withCont };
}

export interface OrbitTrade {
  cfg: OrbitConfig;
  incDeg: number;
  periodMin: number;
  sunlitPct: number;
  eclipseMin: number;
  passesPerDay: number;
  dayPassesPerDay: number;
  predawnPerWeek: number;
  avgPassMin: number;
  maxGapH: number;
  usableMinPerDay: number; // pass minutes with positive link margin
  capacityPerDay: number; // S-size packets per day
}

/** Analyse a candidate orbit over `days` from `t0` for the ground station. */
export function analyseOrbit(cfg: OrbitConfig, link: LinkConfig, t0: number, days = 14): OrbitTrade {
  const m = new OrbitModel(cfg, t0, GROUND_STATION);
  const ps = m.passes(t0, days * 24, 30);
  const hour = (t: number) => (((t / 3_600_000 + 4) % 24) + 24) % 24;
  let gap = 0;
  for (let i = 1; i < ps.length; i++) gap = Math.max(gap, (ps[i].aos - ps[i - 1].los) / 3_600_000);
  let usable = 0;
  for (const p of ps) for (const s of p.track) if (linkBudget(link, s.el, cfg.altKm).margin >= 0) usable += 0.5; // 30 s samples
  const sunlit = m.sunlitFraction(t0);
  const per = periodMin(cfg.altKm);
  const usablePerDay = usable / days;
  return {
    cfg,
    incDeg: cfg.incDeg === 'SSO' ? ssoInclination(cfg.altKm) : cfg.incDeg,
    periodMin: per,
    sunlitPct: 100 * sunlit,
    eclipseMin: per * (1 - sunlit),
    passesPerDay: ps.length / days,
    dayPassesPerDay: ps.filter((p) => p.daylight).length / days,
    predawnPerWeek: (ps.filter((p) => hour(p.tca) >= 2 && hour(p.tca) < 6.4).length / days) * 7,
    avgPassMin: ps.length ? ps.reduce((a, p) => a + (p.los - p.aos), 0) / ps.length / 60_000 : 0,
    maxGapH: gap,
    usableMinPerDay: usablePerDay,
    capacityPerDay: (usablePerDay * 60_000) / airtimeMs(link.sBytes, link.sf, link.bwKHz),
  };
}

export function dataBudget(link: LinkConfig) {
  const sPerDay = FARMS_N * (1440 / link.sEveryMin);
  const nPerDay = FARMS_N * (1440 / link.nEveryMin);
  const bytes = sPerDay * link.sBytes + nPerDay * link.nBytes;
  const airS = airtimeMs(link.sBytes, link.sf, link.bwKHz);
  const airN = airtimeMs(link.nBytes, link.sf, link.bwKHz);
  const airMinPerDay = (sPerDay * airS + nPerDay * airN) / 60_000;
  return { sPerDay, nPerDay, packets: sPerDay + nPerDay, bytes, airS, airN, airMinPerDay };
}
