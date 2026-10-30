// Phase 1 simulator: a small physics model of the satellite, the four-channel
// polarimeter, the farm dew nodes and the LoRa store-and-forward link.
// Every packet it produces is SIMULATED and flagged as such in the UI.

import { FARMS, GROUND_STATION } from './farms';
import {
  DOLP_CLEAN, channelsFor, clamp, rhFromDewPoint, battPercent, battVoltsFromPercent, dewPoint,
} from './physics';
import { GroundProcessor, NPacket, Packet, SPacket } from './ground';
import { DEFAULT_ORBIT, OrbitModel, type OrbitConfig, type Pass } from './orbit';
import { DEFAULT_LINK, airtimeMs, linkBudget, type LinkConfig } from './link';

const MIN = 60_000;
const S0_NOMINAL = 2.82; // V, gives the 2.59/1.41/0.23/1.41 clean reading

export interface FarmSim {
  id: string;
  dust: number; // 0..1 true soiling on glass
  autoWeather: boolean;
  air: number; rh: number; glass: number;
  // per-site climate (Nov, UAE)
  baseAir: number; tdBase: number;
  dustRate: number; // soiling per minute
  dirtyMin: number; // minutes the farm has shown a "clean now" order
  crewDelay: number; // minutes until the crew acts on a DRY DUST order
}

export interface Scenario {
  dust: number; air: number; rh: number; glass: number;
}

export const SCENARIOS: Record<'CLEAN' | 'DRY_DUST' | 'DEW_ONLY' | 'WET_DUST', Scenario> = {
  CLEAN: { dust: 0.03, air: 31, rh: 35, glass: 44 },
  DRY_DUST: { dust: 0.62, air: 33, rh: 30, glass: 47 },
  DEW_ONLY: { dust: 0.05, air: 19.5, rh: 88, glass: 16 },
  WET_DUST: { dust: 0.6, air: 19.5, rh: 90, glass: 16 },
};

const gauss = () => {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const r = (v: number, d: number) => Number(v.toFixed(d));

/** Local (UAE, UTC+4) decimal hour. */
export const uaeHour = (t: number) => (((t / 3_600_000 + 4) % 24) + 24) % 24;

/** Sun elevation factor 0..1 at the farms (Nov: sunrise ~06:25, sunset ~17:35). */
export function sunFactor(t: number) {
  const h = uaeHour(t);
  const rise = 6.42;
  const set = 17.58;
  if (h <= rise || h >= set) return 0;
  return Math.sin((Math.PI * (h - rise)) / (set - rise));
}

export interface OrbitState {
  t: number;
  lat: number; lon: number;
  sunlit: boolean;
  inPass: boolean; // above the ground-station mask
  elevation: number; az: number; rangeKm: number; // look angles from the GS
  marginDb: number | null; // link margin when above the mask
  phaseMin: number; // minutes since ascending node
  periodMin: number;
  minsToPass: number;
  minsToSunChange: number | null;
  currentPass: Pass | null;
  nextPass: Pass | null;
  orbitNo: number;
}

export class Simulator {
  t: number;
  epoch: number;
  stepMin = 5;
  rotation = 30; // deg, satellite roll relative to the glass plane of incidence
  spin = 120; // slow tumble → magnetometer heading
  soc = 72; // battery %
  tempInt = 18;
  continuousLink = false;
  autoCrew = true;
  farms: FarmSim[];
  store: Packet[] = [];
  storeCap = 4000; // packets the OBC flash buffer holds
  relayed = 0;
  generated = 0;
  dropped = 0;
  link: LinkConfig = { ...DEFAULT_LINK };
  /** EPS model, kept in sync with the Mission page power budget. */
  power = { loadW: 0.21, txW: 0.4, genSunlitW: 1.5, battWh: 11.1, busV: 3.3 };
  orbitModel!: OrbitModel;
  private passCache: { from: number; to: number; passes: Pass[] } = { from: 0, to: 0, passes: [] };

  constructor(public ground: GroundProcessor, startT: number, orbitCfg: OrbitConfig = DEFAULT_ORBIT) {
    this.t = startT;
    this.epoch = startT;
    this.setOrbit(orbitCfg, 12);
    const init: Record<string, [number, number, number, number]> = {
      // dust, baseAir, dew-point base, dust rate (inland sites soil faster)
      AlDhafra: [0.08, 26, 17.6, 0.00016],
      NoorAbuDhabi: [0.14, 25.5, 16.8, 0.00022],
      MBRSolarPark: [0.22, 26.5, 15.2, 0.0003],
    };
    this.farms = FARMS.map((f) => {
      const [dust, baseAir, tdBase, dustRate] = init[f.id];
      return { id: f.id, dust, autoWeather: true, air: 25, rh: 50, glass: 25, baseAir, tdBase, dustRate, dirtyMin: 0, crewDelay: 180 };
    });
    this.farms.forEach((f) => this.weather(f));
  }

  farm(id: string) {
    return this.farms.find((f) => f.id === id)!;
  }

  /**
   * Switch the candidate orbit. The in-orbit phase (and node for non-SSO
   * orbits) depends on the launch date, so it is chosen to give a pass
   * shortly after `t` — real pass times need the TLE after deployment.
   */
  setOrbit(cfg: OrbitConfig, leadMin = 10) {
    this.orbitModel = new OrbitModel(cfg, this.epoch, GROUND_STATION);
    this.orbitModel.phaseForPassAt(this.t, leadMin);
    this.passCache = { from: 0, to: 0, passes: [] };
  }

  passes(): Pass[] {
    if (this.t < this.passCache.from || this.t > this.passCache.to - 20 * 3_600_000) {
      const from = this.t - 30 * 3_600_000;
      this.passCache = { from, to: this.t + 30 * 3_600_000, passes: this.orbitModel.passes(from, 60) };
    }
    return this.passCache.passes;
  }

  orbit(t = this.t): OrbitState {
    const m = this.orbitModel;
    const st = m.state(t);
    const look = m.look(t);
    const inPass = look.el >= m.cfg.minElDeg;
    const ps = this.passes();
    const currentPass = ps.find((p) => p.aos <= t && p.los >= t) ?? null;
    const nextPass = ps.find((p) => p.aos > t) ?? null;
    return {
      t,
      lat: st.lat, lon: st.lon,
      sunlit: st.sunlit,
      inPass,
      elevation: look.el, az: look.az, rangeKm: look.rangeKm,
      marginDb: inPass ? linkBudget(this.link, look.el, m.cfg.altKm).margin : null,
      phaseMin: (st.argLatDeg / 360) * m.periodMin,
      periodMin: m.periodMin,
      minsToPass: inPass ? 0 : nextPass ? (nextPass.aos - t) / MIN : Infinity,
      minsToSunChange: m.minsToSunChange(t),
      currentPass,
      nextPass,
      orbitNo: Math.floor((t - this.epoch) / (m.periodMin * MIN)) + 1,
    };
  }

  private profCache: { key: number; sunlit: boolean[]; visible: boolean[] } | null = null;

  /** Per-minute sunlit / GS-visible flags for the current revolution (from the ascending node). */
  revolution() {
    const o = this.orbit();
    const start = this.t - o.phaseMin * MIN;
    const key = Math.round(start / MIN);
    if (this.profCache?.key !== key) {
      const m = this.orbitModel;
      const n = Math.ceil(m.periodMin);
      const sunlit: boolean[] = [];
      const visible: boolean[] = [];
      for (let i = 0; i < n; i++) {
        const t = start + i * MIN;
        sunlit.push(m.state(t).sunlit);
        visible.push(m.look(t).el >= m.cfg.minElDeg);
      }
      this.profCache = { key, sunlit, visible };
    }
    return this.profCache;
  }

  get battV() {
    return battVoltsFromPercent(this.soc);
  }
  set battV(v: number) {
    this.soc = battPercent(v);
  }

  /** Diurnal climate model; manual mode just adds sensor noise to slider values. */
  private weather(f: FarmSim) {
    if (!f.autoWeather) return;
    const h = uaeHour(this.t);
    const sun = sunFactor(this.t);
    const air = f.baseAir + 6.5 * Math.cos((2 * Math.PI * (h - 14.5)) / 24);
    const td = f.tdBase - 2 * sun + 0.4 * Math.sin((2 * Math.PI * h) / 7);
    // Night: glass radiates to the clear desert sky and runs ~3 °C below air.
    // Day: sun heats the glass well above air.
    const glass = air - 3.1 * (1 - sun) + 17 * sun;
    f.air = clamp(air, -10, 60);
    f.rh = rhFromDewPoint(air, td);
    f.glass = clamp(glass, -10, 60);
  }

  private makeS(f: FarmSim, o: Pick<OrbitState, 'sunlit' | 'inPass'>, opts: { forceDay?: boolean; forceDry?: boolean } = {}): SPacket {
    const sun = opts.forceDay ? 1 : sunFactor(this.t);
    const margin = f.glass - dewPoint(f.air, f.rh);
    const wetGlass = !opts.forceDry && margin < 0.3;
    const s0 = sun > 0 ? S0_NOMINAL * (0.25 + 0.75 * Math.sqrt(sun)) * (1 - 0.08 * f.dust) * (1 + 0.015 * gauss()) : 0.01;
    // Dust scatters and depolarizes; a water film gives erratic polarization.
    let dolp = DOLP_CLEAN * (1 - f.dust) + 0.008 * gauss();
    if (wetGlass) dolp = clamp(0.35 + 0.45 * Math.random(), 0, 1);
    const ch = channelsFor(s0, clamp(dolp, 0, 1), this.rotation).map((v) => clamp(v + 0.004 * gauss(), 0, 3.3));
    const solar = o.sunlit ? clamp(5.1 + 0.6 * Math.abs(Math.cos((this.spin * Math.PI) / 180)) + 0.05 * gauss(), 0, 6) : 0;
    const pw = this.power;
    const current = (1000 * (pw.loadW + (o.inPass ? pw.txW : 0))) / pw.busV + 3 * gauss();
    return {
      type: 'S', farm: f.id, t: new Date(this.t).toISOString(),
      i0: r(ch[0], 3), i45: r(ch[1], 3), i90: r(ch[2], 3), i135: r(ch[3], 3),
      heading: Math.round((this.spin + this.rotation) % 360),
      batt: r(this.battV + 0.005 * gauss(), 3), solar: r(solar, 2), temp: r(this.tempInt + 0.1 * gauss(), 1),
      current_mA: Math.round(current),
    };
  }

  private makeN(f: FarmSim): NPacket {
    const margin = f.glass - dewPoint(f.air, f.rh);
    const wet = clamp(300 + 115 * (1.6 - margin) + 8 * gauss(), 220, 980);
    return {
      type: 'N', farm: f.id, t: new Date(this.t).toISOString(),
      air_t: r(f.air + 0.1 * gauss(), 1), rh: r(clamp(f.rh + 0.6 * gauss(), 1, 100), 1),
      glass_t: r(f.glass + 0.1 * gauss(), 1), wet_plate: Math.round(wet),
    };
  }

  /** RSSI/SNR from the link budget at an elevation, with fading noise. */
  private linkMeta(elDeg: number) {
    const b = linkBudget(this.link, Math.max(elDeg, 1), this.orbitModel.cfg.altKm);
    return { rssi: Math.round(b.rssi + 1.5 * gauss()), snr: r(b.snr + 1 * gauss(), 1) };
  }

  /** Advance the mission clock by one step and generate/route packets. */
  tick() {
    const prev = this.t;
    this.t += this.stepMin * MIN;
    const o = this.orbit();
    const dt = this.stepMin;

    // spacecraft energy balance (transmitting during passes costs extra)
    const pw = this.power;
    const netW = (o.sunlit ? pw.genSunlitW : 0) - pw.loadW - (o.inPass ? pw.txW : 0);
    this.soc = clamp(this.soc + (100 * netW * (dt / 60)) / pw.battWh, 3, 100);
    const tTarget = o.sunlit ? 31 : 4;
    this.tempInt += (tTarget - this.tempInt) * (1 - Math.exp(-dt / 25));
    this.spin = (this.spin + 2.2 * dt + 360) % 360;

    const crossed = (every: number) => Math.floor(this.t / (every * MIN)) > Math.floor(prev / (every * MIN));
    const out: Packet[] = [];
    for (const f of this.farms) {
      this.weather(f);
      // dust settles continuously, plus occasional afternoon wind events
      f.dust = clamp(f.dust + f.dustRate * dt * (0.5 + Math.random()), 0, 1);
      const h = uaeHour(this.t);
      if (h > 10 && h < 17 && Math.random() < 0.0008 * dt) this.dustEvent(f);
      if (this.autoCrew) this.crew(f, h, dt);
      if (crossed(this.link.sEveryMin)) out.push(this.makeS(f, o));
      if (crossed(this.link.nEveryMin)) out.push(this.makeN(f));
    }
    this.route(out, prev);
  }

  dustEvent(f: FarmSim, amount = 0.18 + 0.2 * Math.random()) {
    f.dust = clamp(f.dust + amount, 0, 1);
  }

  /** Farm crew acting on the dashboard's orders. */
  private crew(f: FarmSim, h: number, dt: number) {
    const st = this.ground.farm(f.id).state;
    if (st !== 'DRY_DUST' && st !== 'WET_DUST') {
      f.dirtyMin = 0;
      return;
    }
    if (f.dirtyMin === 0) f.crewDelay = 120 + 180 * Math.random();
    f.dirtyMin += dt;
    // wet dust: pre-dawn shift cleans before sunrise; dry dust: robots after a delay
    const act = st === 'WET_DUST' ? h >= 4.75 && h < 6.4 && f.dirtyMin >= 30 : f.dirtyMin >= f.crewDelay;
    if (act) {
      f.dust = 0.02 + 0.02 * Math.random();
      f.dirtyMin = 0;
    }
  }

  /**
   * Everything goes into the on-board store; during a pass the store is
   * downlinked oldest-first, limited by LoRa airtime in the minutes where the
   * link margin is positive.
   */
  private route(pkts: Packet[], prev: number) {
    this.generated += pkts.length;
    const fresh = new Set(pkts);
    this.store.push(...pkts);
    if (this.store.length > this.storeCap) this.dropped += this.store.splice(0, this.store.length - this.storeCap).length;

    let budgetMs = 0;
    let bestEl = -90;
    if (this.continuousLink) {
      budgetMs = Infinity;
      bestEl = 45;
    } else {
      const m = this.orbitModel;
      for (let t = prev + MIN; t <= this.t; t += MIN) {
        const el = m.look(t).el;
        if (el < m.cfg.minElDeg) continue;
        if (linkBudget(this.link, el, m.cfg.altKm).margin < 0) continue;
        budgetMs += MIN;
        bestEl = Math.max(bestEl, el);
      }
    }
    if (budgetMs <= 0 || !this.store.length) return;

    const meta = this.linkMeta(bestEl);
    const air = { S: airtimeMs(this.link.sBytes, this.link.sf, this.link.bwKHz), N: airtimeMs(this.link.nBytes, this.link.sf, this.link.bwKHz) };
    let n = 0;
    for (const p of this.store) {
      const cost = air[p.type];
      if (cost > budgetMs) break;
      budgetMs -= cost;
      n++;
      const via = p.type === 'N' ? 'relay' : fresh.has(p) ? 'direct' : 'store&fwd';
      if (via !== 'direct') this.relayed++;
      this.ground.ingest({ ...p, ...meta, via }, this.t);
    }
    this.store.splice(0, n);
  }

  /**
   * Load a scenario for one farm: sets the sliders and feeds the ground
   * station a 3-reading dry-glass payload sequence followed by 3 dew-node
   * readings so the persistence filter settles immediately.
   */
  loadScenario(farmId: string, sc: Scenario) {
    const f = this.farm(farmId);
    f.autoWeather = false;
    f.dust = sc.dust;
    this.ground.resetFarm(farmId);
    // queued on-board readings for this farm are superseded by the scenario
    this.store = this.store.filter((p) => p.farm !== farmId);
    const o = this.orbit();
    const meta = this.linkMeta(Math.max(o.elevation, 40));
    const inject = (p: Packet) => this.ground.ingest({ ...p, ...meta, via: 'scenario' }, this.t);
    // The mission clock is not advanced, so pass windows are never skipped.
    // Dry-glass daylight readings first (dust is observed before the dew forms)…
    Object.assign(f, { air: 32, rh: 30, glass: 46 });
    for (let i = 0; i < 3; i++) {
      inject(this.makeS(f, o, { forceDay: true, forceDry: true }));
      inject(this.makeN(f));
    }
    // …then the scenario's dew-node conditions, then payload under those conditions.
    Object.assign(f, { air: sc.air, rh: sc.rh, glass: sc.glass });
    for (let i = 0; i < 3; i++) inject(this.makeN(f));
    inject(this.makeS(f, o, { forceDay: true }));
    f.dirtyMin = 0;
  }

  /** Run the model silently so charts open with history. */
  seed(hours: number) {
    const steps = Math.round((hours * 60) / this.stepMin);
    this.t -= steps * this.stepMin * MIN;
    const noor = this.farm('NoorAbuDhabi');
    for (let i = 0; i < steps; i++) {
      // scripted afternoon dust event so the opening view shows a WET DUST alert
      if (i === steps - Math.round((12 * 60) / this.stepMin)) this.dustEvent(noor, 0.3);
      this.tick();
    }
  }
}
