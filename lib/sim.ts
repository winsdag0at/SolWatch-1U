// Phase 1 simulator: a small physics model of the satellite, the four-channel
// polarimeter, the farm dew nodes and the LoRa store-and-forward link.
// Every packet it produces is SIMULATED and flagged as such in the UI.

import { FARMS } from './farms';
import {
  DOLP_CLEAN, channelsFor, clamp, rhFromDewPoint, battPercent, battVoltsFromPercent, dewPoint,
} from './physics';
import { GroundProcessor, NPacket, Packet, SPacket } from './ground';

export const ORBIT_MIN = 95;
export const SUNLIT_MIN = 60;
// Ground-station visibility per orbit. Compressed for the demo (a real LEO
// pass over one station is ~8–10 min, 2–4 times a day).
export const PASS_START = 38;
export const PASS_END = 68;

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
  phaseMin: number; // 0..95
  sunlit: boolean;
  inPass: boolean;
  passFrac: number; // 0..1 progress through pass, -1 when not in pass
  elevation: number; // deg
  minsToPass: number;
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
  relayed = 0;
  generated = 0;

  constructor(public ground: GroundProcessor, startT: number) {
    this.t = startT;
    this.epoch = startT - 17 * MIN;
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

  orbit(t = this.t): OrbitState {
    const totalMin = (t - this.epoch) / MIN;
    const phaseMin = ((totalMin % ORBIT_MIN) + ORBIT_MIN) % ORBIT_MIN;
    const inPass = phaseMin >= PASS_START && phaseMin <= PASS_END;
    const passFrac = inPass ? (phaseMin - PASS_START) / (PASS_END - PASS_START) : -1;
    const minsToPass = inPass ? 0 : (PASS_START - phaseMin + ORBIT_MIN) % ORBIT_MIN;
    return {
      phaseMin,
      sunlit: phaseMin < SUNLIT_MIN,
      inPass,
      passFrac,
      elevation: inPass ? 5 + 80 * Math.sin(Math.PI * passFrac) : 0,
      minsToPass,
      orbitNo: Math.floor(totalMin / ORBIT_MIN) + 1,
    };
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

  private makeS(f: FarmSim, o: OrbitState, opts: { forceDay?: boolean; forceDry?: boolean } = {}): SPacket {
    const sun = opts.forceDay ? 1 : sunFactor(this.t);
    const margin = f.glass - dewPoint(f.air, f.rh);
    const wetGlass = !opts.forceDry && margin < 0.3;
    const s0 = sun > 0 ? S0_NOMINAL * (0.25 + 0.75 * Math.sqrt(sun)) * (1 - 0.08 * f.dust) * (1 + 0.015 * gauss()) : 0.01;
    // Dust scatters and depolarizes; a water film gives erratic polarization.
    let dolp = DOLP_CLEAN * (1 - f.dust) + 0.008 * gauss();
    if (wetGlass) dolp = clamp(0.35 + 0.45 * Math.random(), 0, 1);
    const ch = channelsFor(s0, clamp(dolp, 0, 1), this.rotation).map((v) => clamp(v + 0.004 * gauss(), 0, 3.3));
    const solar = o.sunlit ? clamp(5.1 + 0.6 * Math.abs(Math.cos((this.spin * Math.PI) / 180)) + 0.05 * gauss(), 0, 6) : 0;
    const current = 118 + (o.inPass ? 92 : 0) + (sun > 0 ? 14 : 0) + 6 * gauss();
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

  private linkMeta(o: OrbitState) {
    const el = this.continuousLink && !o.inPass ? 35 : o.elevation;
    const rssi = -122 + 0.42 * el + 2 * gauss();
    const snr = -9 + 0.2 * el + 1 * gauss();
    return { rssi: Math.round(rssi), snr: r(snr, 1) };
  }

  /** Advance the mission clock by one step and generate/route packets. */
  tick() {
    this.t += this.stepMin * MIN;
    const o = this.orbit();
    const dt = this.stepMin;

    // spacecraft
    this.soc = clamp(this.soc + (o.sunlit ? 0.32 : -0.48) * dt + (o.inPass ? -0.08 * dt : 0), 3, 100);
    const tTarget = o.sunlit ? 31 : 4;
    this.tempInt += (tTarget - this.tempInt) * (1 - Math.exp(-dt / 25));
    this.spin = (this.spin + 2.2 * dt + 360) % 360;

    const out: Packet[] = [];
    for (const f of this.farms) {
      this.weather(f);
      // dust settles continuously, plus occasional afternoon wind events
      f.dust = clamp(f.dust + f.dustRate * dt * (0.5 + Math.random()), 0, 1);
      const h = uaeHour(this.t);
      if (h > 10 && h < 17 && Math.random() < 0.0008 * dt) this.dustEvent(f);
      if (this.autoCrew) this.crew(f, h, dt);
      out.push(this.makeS(f, o), this.makeN(f));
    }
    this.route(out, o);
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

  private route(pkts: Packet[], o: OrbitState) {
    this.generated += pkts.length;
    const linkUp = o.inPass || this.continuousLink;
    if (!linkUp) {
      this.store.push(...pkts.map((p) => ({ ...p, via: 'store&fwd' as const })));
      if (this.store.length > 1500) this.store.splice(0, this.store.length - 1500);
      return;
    }
    const meta = this.linkMeta(o);
    // dump the on-board store first (oldest first), then live packets
    if (this.store.length) {
      for (const p of this.store) this.ground.ingest({ ...p, ...meta }, this.t);
      this.relayed += this.store.length;
      this.store = [];
    }
    for (const p of pkts) {
      const via = p.type === 'N' ? 'relay' : 'direct';
      if (via === 'relay') this.relayed++;
      this.ground.ingest({ ...p, ...meta, via }, this.t);
    }
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
    const o = this.orbit();
    const meta = this.linkMeta({ ...o, elevation: Math.max(o.elevation, 40) });
    // dry-glass daylight readings first (dust is observed before the dew forms)
    Object.assign(f, { air: 32, rh: 30, glass: 46 });
    for (let i = 0; i < 3; i++) {
      this.t += MIN;
      this.ground.ingest({ ...this.makeS(f, o, { forceDay: true, forceDry: true }), ...meta, via: 'scenario' }, this.t);
      this.ground.ingest({ ...this.makeN(f), ...meta, via: 'scenario' }, this.t);
    }
    // then the scenario's dew-node conditions, then payload under those conditions
    Object.assign(f, { air: sc.air, rh: sc.rh, glass: sc.glass });
    for (let i = 0; i < 3; i++) {
      this.t += MIN;
      this.ground.ingest({ ...this.makeN(f), ...meta, via: 'scenario' }, this.t);
    }
    this.t += MIN;
    this.ground.ingest({ ...this.makeS(f, o, { forceDay: true }), ...meta, via: 'scenario' }, this.t);
    f.dirtyMin = 0;
  }

  /** Run the model silently so charts open with history. */
  seed(hours: number) {
    const steps = Math.round((hours * 60) / this.stepMin);
    this.t -= steps * this.stepMin * MIN;
    this.epoch -= steps * this.stepMin * MIN;
    const noor = this.farm('NoorAbuDhabi');
    for (let i = 0; i < steps; i++) {
      // scripted afternoon dust event so the opening view shows a WET DUST alert
      if (i === steps - Math.round((12 * 60) / this.stepMin)) this.dustEvent(noor, 0.3);
      this.tick();
    }
  }
}
