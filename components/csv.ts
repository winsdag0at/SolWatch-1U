import { GroundProcessor } from '@/lib/ground';
import { dewPoint, soilingIndex, stokes } from '@/lib/physics';

const COLS = [
  'simulated', 'rx_utc', 't_utc', 'type', 'farm', 'via', 'rssi', 'snr',
  'i0', 'i45', 'i90', 'i135', 's0', 'dolp', 'aolp_deg', 'si_raw',
  'heading', 'batt', 'solar', 'temp', 'current_mA',
  'air_t', 'rh', 'glass_t', 'wet_plate', 'dew_point', 'dew_margin', 'state_after',
];

const esc = (v: unknown) => {
  if (v == null) return '';
  const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(g: GroundProcessor, [t0, t1]: [number, number], simulated: boolean) {
  const lines = [COLS.join(',')];
  for (const e of g.log) {
    const p = e.pkt;
    const ts = Date.parse(p.t);
    if (ts < t0 || ts > t1) continue;
    const row: Record<string, unknown> = {
      simulated: simulated ? 'SIMULATED' : 'live', rx_utc: new Date(e.rx).toISOString(), t_utc: p.t,
      type: p.type, farm: p.farm, via: p.via, rssi: p.rssi, snr: p.snr, state_after: e.farmState,
    };
    if (p.type === 'S') {
      const st = stokes(p.i0, p.i45, p.i90, p.i135);
      Object.assign(row, {
        i0: p.i0, i45: p.i45, i90: p.i90, i135: p.i135, s0: st.s0, dolp: st.dolp, aolp_deg: st.aolp,
        si_raw: soilingIndex(st.dolp), heading: p.heading, batt: p.batt, solar: p.solar, temp: p.temp, current_mA: p.current_mA,
      });
    } else {
      const td = dewPoint(p.air_t, p.rh);
      Object.assign(row, { air_t: p.air_t, rh: p.rh, glass_t: p.glass_t, wet_plate: p.wet_plate, dew_point: td, dew_margin: p.glass_t - td });
    }
    lines.push(COLS.map((c) => esc(row[c])).join(','));
  }
  return lines.join('\n');
}
