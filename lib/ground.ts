// Ground-station processing: validates packets, derives Stokes / dew values and
// runs the 4-state cleaning decision with dead bands and 3-reading persistence.

import {
  THRESH, S0_MIN_VALID, stokes, soilingIndex, dewPoint, cementingRisk, battPercent,
} from './physics';

export interface SPacket {
  type: 'S';
  farm: string;
  t: string; // ISO sample time
  i0: number; i45: number; i90: number; i135: number;
  heading: number; batt: number; solar: number; temp: number; current_mA: number;
  rssi?: number; snr?: number; via?: Via;
}

export interface NPacket {
  type: 'N';
  farm: string;
  t: string;
  air_t: number; rh: number; glass_t: number; wet_plate: number;
  rssi?: number; snr?: number; via?: Via;
}

export type Packet = SPacket | NPacket;
export type Via = 'direct' | 'relay' | 'store&fwd' | 'scenario' | 'live';
export type CleanState = 'CLEAN' | 'DRY_DUST' | 'DEW_ONLY' | 'WET_DUST';

export const STATE_INFO: Record<CleanState, { label: string; action: string; color: string; icon: string }> = {
  CLEAN: { label: 'CLEAN', action: 'No action', color: 'var(--clean)', icon: '✓' },
  DRY_DUST: { label: 'DRY DUST', action: 'Dry brush / robotic clean now', color: 'var(--dust)', icon: '◌' },
  DEW_ONLY: { label: 'DEW ONLY', action: 'No action — dew will evaporate. Do not dry-brush.', color: 'var(--dew)', icon: '💧' },
  WET_DUST: { label: 'WET DUST', action: 'URGENT: clean before sunrise — cementation risk', color: 'var(--wetdust)', icon: '⚠' },
};

export interface PayloadPoint {
  t: number; i0: number; i45: number; i90: number; i135: number;
  s0: number; dolp: number; aolp: number;
  valid: boolean; siRaw: number | null; siHeld: number | null; wet: boolean;
}
export interface DewPoint {
  t: number; air: number; rh: number; glass: number; td: number; margin: number; wetPlate: number;
}
export interface StatePoint { t: number; state: CleanState; cri: number; si: number | null }
export interface HealthPoint {
  t: number; batt: number; battPct: number; solar: number; current: number; power: number; temp: number; heading: number;
}

export interface FarmGround {
  id: string;
  dusty: boolean; dustCount: number;
  wet: boolean; wetCount: number;
  heldSI: number | null;
  lastPayload: PayloadPoint | null;
  lastDew: DewPoint | null;
  state: CleanState; stateSince: number | null;
  cri: number;
  payload: PayloadPoint[];
  dew: DewPoint[];
  states: StatePoint[];
}

export interface LogEntry { id: number; rx: number; pkt: Packet; raw: string; farmState: CleanState }

const MAX_SERIES = 1200;
const MAX_LOG = 600;

const push = <T,>(arr: T[], v: T, max = MAX_SERIES) => {
  arr.push(v);
  if (arr.length > max) arr.splice(0, arr.length - max);
};

function newFarm(id: string): FarmGround {
  return {
    id, dusty: false, dustCount: 0, wet: false, wetCount: 0, heldSI: null,
    lastPayload: null, lastDew: null, state: 'CLEAN', stateSince: null, cri: 0,
    payload: [], dew: [], states: [],
  };
}

/** Flag with persistence: needs N consecutive readings past the dead band to flip. */
function persist(flag: boolean, count: number, setCond: boolean, clearCond: boolean): [boolean, number] {
  const cond = flag ? clearCond : setCond;
  const n = cond ? count + 1 : 0;
  return n >= THRESH.persistence ? [!flag, 0] : [flag, n];
}

export function validatePacket(p: unknown): Packet {
  if (!p || typeof p !== 'object') throw new Error('packet is not an object');
  const o = p as Record<string, unknown>;
  const num = (k: string) => {
    const v = Number(o[k]);
    if (!Number.isFinite(v)) throw new Error(`field "${k}" missing or not a number`);
    return v;
  };
  if (typeof o.farm !== 'string' || !o.farm) throw new Error('field "farm" missing');
  if (typeof o.t !== 'string' || Number.isNaN(Date.parse(o.t))) throw new Error('field "t" must be an ISO time');
  const extra = {
    ...(o.rssi != null ? { rssi: Number(o.rssi) } : {}),
    ...(o.snr != null ? { snr: Number(o.snr) } : {}),
  };
  if (o.type === 'S') {
    return {
      type: 'S', farm: o.farm, t: o.t,
      i0: num('i0'), i45: num('i45'), i90: num('i90'), i135: num('i135'),
      heading: num('heading'), batt: num('batt'), solar: num('solar'), temp: num('temp'),
      current_mA: num('current_mA'), ...extra,
    };
  }
  if (o.type === 'N') {
    return {
      type: 'N', farm: o.farm, t: o.t,
      air_t: num('air_t'), rh: num('rh'), glass_t: num('glass_t'), wet_plate: num('wet_plate'), ...extra,
    };
  }
  throw new Error('field "type" must be "S" or "N"');
}

export class GroundProcessor {
  farms = new Map<string, FarmGround>();
  health: HealthPoint[] = [];
  log: LogEntry[] = [];
  lastRx: number | null = null;
  lastLink: { rssi: number; snr: number; t: number } | null = null;
  received = 0;
  private logId = 0;

  constructor(farmIds: string[]) {
    farmIds.forEach((id) => this.farms.set(id, newFarm(id)));
  }

  farm(id: string): FarmGround {
    let f = this.farms.get(id);
    if (!f) {
      f = newFarm(id);
      this.farms.set(id, f);
    }
    return f;
  }

  resetFarm(id: string) {
    const old = this.farm(id);
    const f = newFarm(id);
    // keep chart history, reset decision memory only
    f.payload = old.payload; f.dew = old.dew; f.states = old.states;
    this.farms.set(id, f);
  }

  /** Process one packet. `rx` = time the ground station received it (ms). */
  ingest(pkt: Packet, rx: number) {
    const f = this.farm(pkt.farm);
    const t = Date.parse(pkt.t);
    this.received++;
    this.lastRx = rx;
    if (pkt.rssi != null && pkt.snr != null) this.lastLink = { rssi: pkt.rssi, snr: pkt.snr, t: rx };

    if (pkt.type === 'S') this.ingestS(f, pkt, t);
    else this.ingestN(f, pkt, t);

    this.decide(f, t);
    push(this.log, { id: ++this.logId, rx, pkt, raw: JSON.stringify(stripMeta(pkt)), farmState: f.state }, MAX_LOG);
  }

  private ingestS(f: FarmGround, p: SPacket, t: number) {
    const st = stokes(p.i0, p.i45, p.i90, p.i135);
    const valid = st.s0 >= S0_MIN_VALID;
    const si = valid ? soilingIndex(st.dolp) : null;
    // Polarization is unreliable on wet glass: keep the last dry-glass SI.
    if (si != null && !f.wet) {
      f.heldSI = si;
      [f.dusty, f.dustCount] = persist(f.dusty, f.dustCount, si > THRESH.siDusty, si < THRESH.siClear);
    }
    const pt: PayloadPoint = {
      t, i0: p.i0, i45: p.i45, i90: p.i90, i135: p.i135,
      s0: st.s0, dolp: st.dolp, aolp: st.aolp, valid, siRaw: si, siHeld: f.heldSI, wet: f.wet,
    };
    f.lastPayload = pt;
    push(f.payload, pt);

    const last = this.health[this.health.length - 1];
    if (!last || t > last.t) {
      push(this.health, {
        t, batt: p.batt, battPct: battPercent(p.batt), solar: p.solar, current: p.current_mA,
        power: p.batt * p.current_mA, temp: p.temp, heading: ((p.heading % 360) + 360) % 360,
      });
    }
  }

  private ingestN(f: FarmGround, p: NPacket, t: number) {
    const td = dewPoint(p.air_t, p.rh);
    const margin = p.glass_t - td;
    const setWet = p.wet_plate > THRESH.wetPlateSet || margin < THRESH.marginSet;
    const clearWet = p.wet_plate < THRESH.wetPlateClear && margin > THRESH.marginClear;
    [f.wet, f.wetCount] = persist(f.wet, f.wetCount, setWet, clearWet);
    const pt: DewPoint = { t, air: p.air_t, rh: p.rh, glass: p.glass_t, td, margin, wetPlate: p.wet_plate };
    f.lastDew = pt;
    push(f.dew, pt);
  }

  private decide(f: FarmGround, t: number) {
    const state: CleanState = f.dusty ? (f.wet ? 'WET_DUST' : 'DRY_DUST') : f.wet ? 'DEW_ONLY' : 'CLEAN';
    if (state !== f.state || f.stateSince == null) f.stateSince = t;
    f.state = state;
    f.cri = cementingRisk(f.heldSI ?? 0, f.lastDew?.margin ?? null, f.lastDew?.wetPlate ?? null);
    const last = f.states[f.states.length - 1];
    if (!last || t >= last.t) push(f.states, { t, state, cri: f.cri, si: f.heldSI });
  }
}

function stripMeta(p: Packet) {
  const { via: _via, ...rest } = p;
  return rest;
}

const fmt = (v: number, d = 2) => v.toFixed(d);
const signed = (v: number, d = 1) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d);

/** Human-readable reason for the current cleaning order. */
export function explain(f: FarmGround): { reason: string; pending: string | null } {
  const si = f.heldSI;
  const d = f.lastDew;
  const siTxt = si == null ? 'SI n/a (no daylight reading yet)' : `SI ${fmt(si)}${f.wet ? ' (held — last dry-glass reading)' : ''}`;
  const dewTxt = d ? `dew margin ${signed(d.margin)} °C, wet-plate ${Math.round(d.wetPlate)}` : 'no dew-node data yet';
  let reason: string;
  switch (f.state) {
    case 'CLEAN':
      reason = `${siTxt} below ${THRESH.siDusty}, no confirmed dew (${dewTxt}).`;
      break;
    case 'DRY_DUST':
      reason = `${siTxt} above ${THRESH.siDusty} for ${THRESH.persistence}+ readings; glass dry (${dewTxt}). Dry cleaning is safe and saves water.`;
      break;
    case 'DEW_ONLY':
      reason = `Dew on glass (${dewTxt}); ${siTxt} is low. Sun will evaporate it — brushing wet glass smears.`;
      break;
    case 'WET_DUST':
      reason = `${siTxt} plus dew (${dewTxt}). Dust + dew dries into a hard cemented crust after sunrise.`;
      break;
  }
  const pend: string[] = [];
  if (f.dustCount > 0) pend.push(`${f.dusty ? 'dust clearing' : 'dust rising'} ${f.dustCount}/${THRESH.persistence}`);
  if (f.wetCount > 0) pend.push(`${f.wet ? 'drying' : 'wetting'} ${f.wetCount}/${THRESH.persistence}`);
  return { reason, pending: pend.length ? `Pending change: ${pend.join(', ')}` : null };
}
