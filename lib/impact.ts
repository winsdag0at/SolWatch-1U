// One-year cleaning-strategy model: fixed wet-wash schedule vs SolWatch-guided
// cleaning. Deliberately simple and fully parameterised — every input is shown
// on the Impact page with its source or marked as an assumption.

export interface ImpactInputs {
  capacityMWp: number;
  yieldKWhPerKWp: number; // annual specific yield
  tariffUSD: number; // per kWh
  moduleEffPct: number; // for module area
  soilingPctPerDay: number;
  stormsPerYear: number;
  stormLossPct: number;
  dewWinterPct: number; // share of nights with dew, Nov–Mar
  dewSummerPct: number; // Apr–Oct
  cementThresholdPct: number; // soiling above which dew cements part of the dust
  cementFracPct: number; // share of loose dust that cements on such a night
  waterLPerM2: number; // per wet wash
  baselineWashesPerYear: number;
  triggerPct: number; // SolWatch dry-clean trigger (soiling loss)
  detectDelayDays: number; // satellite revisit / reporting delay
  predawnAlertPct: number; // share of dew nights a pre-dawn pass delivers the alert
  cementWashPct: number; // cemented loss that justifies a wet wash
}

export const USD_AED = 3.6725;

export const IMPACT_DEFAULTS: ImpactInputs = {
  capacityMWp: 2000,
  yieldKWhPerKWp: 1800,
  tariffUSD: 0.0132,
  moduleEffPct: 21,
  soilingPctPerDay: 0.3,
  stormsPerYear: 6,
  stormLossPct: 4,
  dewWinterPct: 45,
  dewSummerPct: 10,
  cementThresholdPct: 1.0,
  cementFracPct: 30,
  waterLPerM2: 1.0,
  baselineWashesPerYear: 40,
  triggerPct: 1.5,
  detectDelayDays: 1,
  predawnAlertPct: 15,
  cementWashPct: 1.5,
};

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

export interface StrategyResult {
  name: string;
  meanLossPct: number;
  energyLostGWh: number;
  revenueLostUSD: number;
  waterM3: number;
  wetWashes: number;
  dryCleans: number;
  cementNights: number;
  daily: number[]; // soiling loss % per day
}

export function runImpact(p: ImpactInputs, seed = 7) {
  const days = 365;
  const r = rng(seed);
  // shared weather/dust realisation for both strategies
  const growth = Array.from({ length: days }, () => p.soilingPctPerDay * (0.5 + r()));
  const storm = Array.from({ length: days }, () => (r() < p.stormsPerYear / days ? p.stormLossPct * (0.5 + r()) : 0));
  const dew = Array.from({ length: days }, (_, d) => {
    const month = Math.floor((d / days) * 12); // Jan = 0
    const winter = month <= 2 || month >= 10;
    return r() < (winter ? p.dewWinterPct : p.dewSummerPct) / 100;
  });
  const alertDraw = Array.from({ length: days }, () => r());

  const areaM2 = (p.capacityMWp * 1e6) / (1000 * (p.moduleEffPct / 100));
  const dailyKWh = (p.capacityMWp * 1000 * p.yieldKWhPerKWp) / days;
  const washM3 = (areaM2 * p.waterLPerM2) / 1000;

  const simulate = (name: string, policy: 'baseline' | 'solwatch'): StrategyResult => {
    let loose = 0;
    let cem = 0;
    let water = 0;
    let wet = 0;
    let dry = 0;
    let cementNights = 0;
    let lostKWh = 0;
    const daily: number[] = [];
    const seen: number[] = []; // what the ground station knows (loose + cemented)
    const period = days / Math.max(1, p.baselineWashesPerYear);
    let nextWash = period;
    for (let d = 0; d < days; d++) {
      loose += growth[d] + storm[d];
      const total = Math.min(100, loose + cem);
      daily.push(total);
      seen.push(total);
      lostKWh += (dailyKWh * total) / 100;

      if (policy === 'baseline') {
        if (d + 1 >= nextWash) {
          loose = 0; cem = 0; water += washM3; wet++;
          nextWash += period;
        }
      } else {
        const known = seen[d - p.detectDelayDays] ?? 0;
        if (cem >= p.cementWashPct && known >= p.cementWashPct) {
          loose = 0; cem = 0; water += washM3; wet++;
        } else if (known >= p.triggerPct && loose > 0.2) {
          loose = 0; dry++; // waterless robotic / dry-brush clean
        }
      }

      // night: dew cements part of the loose dust unless SolWatch alerts in time
      if (dew[d] && loose > p.cementThresholdPct) {
        const alerted = policy === 'solwatch' && alertDraw[d] < p.predawnAlertPct / 100;
        if (alerted) {
          loose = 0; dry++; // urgent clean before the crust sets
        } else {
          const x = (loose * p.cementFracPct) / 100;
          loose -= x; cem += x; cementNights++;
        }
      }
    }
    const meanLossPct = daily.reduce((a, b) => a + b, 0) / days;
    return {
      name, meanLossPct, daily, waterM3: water, wetWashes: wet, dryCleans: dry, cementNights,
      energyLostGWh: lostKWh / 1e6, revenueLostUSD: lostKWh * p.tariffUSD,
    };
  };

  const base = simulate('Fixed wet-wash schedule', 'baseline');
  const sw = simulate('SolWatch-guided', 'solwatch');
  return {
    areaKm2: areaM2 / 1e6, washM3, annualGWh: (dailyKWh * days) / 1e6,
    base, sw,
    energyRecoveredGWh: base.energyLostGWh - sw.energyLostGWh,
    revenueRecoveredUSD: base.revenueLostUSD - sw.revenueLostUSD,
    waterSavedM3: base.waterM3 - sw.waterM3,
  };
}
