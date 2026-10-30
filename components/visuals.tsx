'use client';

import { FARMS, GROUND_STATION } from '@/lib/farms';
import { ORBIT_MIN, PASS_END, PASS_START, SUNLIT_MIN, type OrbitState } from '@/lib/sim';
import { STATE_INFO, type CleanState } from '@/lib/ground';

// ---- UAE schematic map ----------------------------------------------------

const LON0 = 51.3;
const LON1 = 56.7;
const LAT0 = 22.3;
const LAT1 = 26.5;
const W = 520;
const K = Math.cos((24.4 * Math.PI) / 180);
const H = Math.round((W * (LAT1 - LAT0)) / ((LON1 - LON0) * K));
const px = (lon: number, lat: number) => [((lon - LON0) / (LON1 - LON0)) * W, ((LAT1 - lat) / (LAT1 - LAT0)) * H] as const;

// Simplified outline (schematic, not survey-accurate)
const UAE: [number, number][] = [
  [51.58, 24.25], [51.8, 24.02], [52.1, 23.97], [52.58, 24.18], [53.0, 24.1], [53.55, 24.05], [54.1, 24.18],
  [54.4, 24.33], [54.62, 24.7], [55.0, 24.98], [55.3, 25.27], [55.52, 25.5], [55.75, 25.62], [55.95, 25.78],
  [56.08, 26.07], [56.2, 25.95], [56.27, 25.62], [56.37, 25.4], [56.37, 25.0], [56.35, 24.92], [56.05, 24.85],
  [55.95, 24.55], [55.8, 24.25], [55.77, 24.03], [55.5, 23.95], [55.2, 23.1], [55.22, 22.7], [55.0, 22.62],
  [52.58, 22.94],
];
const uaePath = UAE.map(([lo, la], i) => `${i ? 'L' : 'M'}${px(lo, la).map((v) => v.toFixed(1)).join(',')}`).join('') + 'Z';

const TRACK_A = px(52.0, 22.0);
const TRACK_B = px(56.9, 26.9);

export function UaeMap({ orbit, states, selected }: { orbit: OrbitState | null; states: Record<string, CleanState>; selected: string }) {
  const sat = orbit && orbit.inPass
    ? [TRACK_A[0] + (TRACK_B[0] - TRACK_A[0]) * orbit.passFrac, TRACK_A[1] + (TRACK_B[1] - TRACK_A[1]) * orbit.passFrac]
    : null;
  const gs = px(GROUND_STATION.lon, GROUND_STATION.lat);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="map" role="img" aria-label="Schematic map of the UAE showing solar farms, ground station and satellite pass">
      <defs>
        <pattern id="grid" width="26" height="26" patternUnits="userSpaceOnUse">
          <path d="M26 0H0V26" fill="none" stroke="var(--grid)" strokeWidth="1" />
        </pattern>
        <radialGradient id="foot">
          <stop offset="0" stopColor="var(--accent)" stopOpacity=".35" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width={W} height={H} fill="var(--sea)" />
      <rect width={W} height={H} fill="url(#grid)" />
      <path d={uaePath} fill="var(--land)" stroke="var(--land-edge)" strokeWidth={1.5} />
      <text x={px(53.2, 23.4)[0]} y={px(53.2, 23.4)[1]} className="map-l" opacity={0.5}>UNITED ARAB EMIRATES</text>
      <text x={px(52.2, 25.6)[0]} y={px(52.2, 25.6)[1]} className="map-l" opacity={0.4}>Arabian Gulf</text>
      <line x1={TRACK_A[0]} y1={TRACK_A[1]} x2={TRACK_B[0]} y2={TRACK_B[1]} stroke="var(--accent)" strokeDasharray="5 6" opacity={orbit?.inPass ? 0.9 : 0.35} />
      <text x={TRACK_B[0] - 140} y={TRACK_B[1] + 38} className="map-l" fill="var(--accent)" opacity={0.8}>ground track ↗</text>
      {sat && (
        <g>
          <circle cx={sat[0]} cy={sat[1]} r={95} fill="url(#foot)" />
          <line x1={sat[0]} y1={sat[1]} x2={gs[0]} y2={gs[1]} stroke="var(--clean)" strokeDasharray="2 4" />
          <rect x={sat[0] - 7} y={sat[1] - 7} width={14} height={14} fill="var(--text)" stroke="var(--accent)" strokeWidth={2} />
          <line x1={sat[0] - 18} y1={sat[1]} x2={sat[0] + 18} y2={sat[1]} stroke="var(--accent)" strokeWidth={3} />
          <text x={sat[0] + 14} y={sat[1] - 12} className="map-l" fill="var(--text)">SolWatch-1U</text>
        </g>
      )}
      <g>
        <path d={`M${gs[0]},${gs[1] - 12}l7,12h-14z`} fill="var(--clean)" />
        <text x={gs[0] - 8} y={gs[1] + 16} textAnchor="end" className="map-l">Ground station</text>
      </g>
      {FARMS.map((f) => {
        const [x, y] = px(f.lon, f.lat);
        const st = states[f.id] ?? 'CLEAN';
        return (
          <g key={f.id}>
            {f.id === selected && <circle cx={x} cy={y} r={13} fill="none" stroke="var(--text)" strokeWidth={1.5} />}
            <circle cx={x} cy={y} r={7} fill={STATE_INFO[st].color} stroke="var(--bg)" strokeWidth={2} />
            <text x={x + 14} y={y + 4} className="map-l" fill="var(--text)">{FARMS.find((g) => g.id === f.id)!.short}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ---- Orbit ring -------------------------------------------------------------

export function OrbitRing({ orbit, size = 170 }: { orbit: OrbitState | null; size?: number }) {
  const c = size / 2;
  const r = c - 14;
  const ang = (min: number) => (min / ORBIT_MIN) * 2 * Math.PI - Math.PI / 2;
  const p = (min: number, rr = r) => [c + rr * Math.cos(ang(min)), c + rr * Math.sin(ang(min))];
  const arc = (m0: number, m1: number, rr = r) => {
    const [x0, y0] = p(m0, rr);
    const [x1, y1] = p(m1, rr);
    const large = m1 - m0 > ORBIT_MIN / 2 ? 1 : 0;
    return `M${x0},${y0}A${rr},${rr} 0 ${large} 1 ${x1},${y1}`;
  };
  const sat = orbit ? p(orbit.phaseMin) : null;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Orbit diagram with sunlit, eclipse and ground pass arcs">
      <circle cx={c} cy={c} r={r * 0.48} fill="#0b3b66" />
      <path d={`M${c},${c - r * 0.48}A${r * 0.48},${r * 0.48} 0 0 0 ${c},${c + r * 0.48}Z`} fill="#000" opacity={0.45} />
      <path d={arc(0, SUNLIT_MIN)} stroke="var(--sun)" strokeWidth={5} fill="none" opacity={0.85} />
      <path d={arc(SUNLIT_MIN, ORBIT_MIN - 0.01)} stroke="#475569" strokeWidth={5} fill="none" />
      <path d={arc(PASS_START, PASS_END, r + 8)} stroke="var(--clean)" strokeWidth={3} fill="none" />
      {sat && <circle cx={sat[0]} cy={sat[1]} r={6} fill="var(--text)" stroke="var(--accent)" strokeWidth={2} style={{ transition: 'cx .8s, cy .8s' }} />}
      <text x={c} y={c + 4} textAnchor="middle" className="map-l" fill="var(--text)">{orbit ? `${orbit.phaseMin.toFixed(0)} / ${ORBIT_MIN} min` : '—'}</text>
    </svg>
  );
}

// ---- Data-flow diagram --------------------------------------------------------

export function FlowDiagram() {
  return (
    <div className="flow" aria-label="Data flow from sensors to dashboard">
      <div className="flow-lane">
        <div className="flow-node">
          <b>On-board sensors</b>
          <small>4× TEMT6000 + polarizers 0/45/90/135° → ADS1115 16-bit ADC</small>
          <small>QMC5883L magnetometer · DS18B20 temp · INA219 power · battery & solar V</small>
        </div>
        <span className="flow-arrow">I²C / 1-Wire →</span>
        <div className="flow-node"><b>ESP32 OBC</b><small>samples, packs “S” packets, stores relayed “N” packets</small></div>
        <span className="flow-arrow">SPI →</span>
        <div className="flow-node accent"><b>SX1278 LoRa</b><small>433 MHz downlink</small></div>
        <span className="flow-arrow">RF ⇢</span>
        <div className="flow-node"><b>Ground station ESP32</b><small>SX1278 RX, adds RSSI/SNR, runs cleaning decision</small></div>
        <span className="flow-arrow">Wi-Fi →</span>
        <div className="flow-node good"><b>This dashboard</b><small>via Firebase RTDB / HTTP JSON</small></div>
      </div>
      <div className="flow-lane sub">
        <div className="flow-node dew"><b>Ground dew nodes</b><small>air T, RH, glass T, wet-plate (at each farm, night)</small></div>
        <span className="flow-arrow">LoRa uplink ⇡</span>
        <div className="flow-node"><b>Satellite stores</b><small>store-and-forward buffer</small></div>
        <span className="flow-arrow">relayed at pass ⇢</span>
        <div className="flow-node"><b>Ground station</b><small>“N” packets</small></div>
      </div>
    </div>
  );
}
