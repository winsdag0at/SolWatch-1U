'use client';

import { FARMS, GROUND_STATION } from '@/lib/farms';
import type { OrbitState } from '@/lib/sim';
import type { GeoPoint, Pass } from '@/lib/orbit';
import { STATE_INFO, type CleanState } from '@/lib/ground';
import { fmtTime } from './format';

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

const inView = ([x, y]: readonly [number, number]) => x >= 0 && x <= W && y >= 0 && y <= H;

/** Circle of `km` radius around a point, as an SVG path (equirectangular approx). */
function circlePath(c: GeoPoint, km: number) {
  const pts: string[] = [];
  for (let i = 0; i <= 72; i++) {
    const a = (i / 72) * 2 * Math.PI;
    const lat = c.lat + (km / 111.2) * Math.cos(a);
    const lon = c.lon + (km / (111.2 * Math.cos((c.lat * Math.PI) / 180))) * Math.sin(a);
    pts.push(px(lon, lat).map((v) => v.toFixed(1)).join(','));
  }
  return `M${pts.join('L')}Z`;
}

export function UaeMap({ orbit, track, footprintKm, states, selected }: {
  orbit: OrbitState | null; track: GeoPoint[]; footprintKm: number; states: Record<string, CleanState>; selected: string;
}) {
  const gs = px(GROUND_STATION.lon, GROUND_STATION.lat);
  const sat = orbit ? px(orbit.lon, orbit.lat) : null;
  // split the ground track where it wraps around the antimeridian
  const segs: string[] = [];
  let d = '';
  track.forEach((p, i) => {
    if (i && Math.abs(p.lon - track[i - 1].lon) > 180) { segs.push(d); d = ''; }
    d += `${d ? 'L' : 'M'}${px(p.lon, p.lat).map((v) => v.toFixed(1)).join(',')}`;
  });
  segs.push(d);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="map" role="img" aria-label="Map of the UAE with solar farms, ground station, satellite ground track and visibility circle">
      <defs>
        <pattern id="grid" width="26" height="26" patternUnits="userSpaceOnUse">
          <path d="M26 0H0V26" fill="none" stroke="var(--grid)" strokeWidth="1" />
        </pattern>
        <clipPath id="mapclip"><rect width={W} height={H} /></clipPath>
      </defs>
      <rect width={W} height={H} fill="var(--sea)" />
      <rect width={W} height={H} fill="url(#grid)" />
      <path d={uaePath} fill="var(--land)" stroke="var(--land-edge)" strokeWidth={1.5} />
      <text x={px(53.2, 23.4)[0]} y={px(53.2, 23.4)[1]} className="map-l" opacity={0.5}>UNITED ARAB EMIRATES</text>
      <text x={px(52.2, 25.6)[0]} y={px(52.2, 25.6)[1]} className="map-l" opacity={0.4}>Arabian Gulf</text>
      <g clipPath="url(#mapclip)">
        {orbit && (
          <path d={circlePath({ lat: orbit.lat, lon: orbit.lon }, footprintKm)} fill={orbit.inPass ? 'rgba(56,189,248,.10)' : 'rgba(148,163,184,.06)'}
            stroke="var(--accent)" strokeOpacity={orbit.inPass ? 0.7 : 0.25} strokeDasharray="3 5" />
        )}
        {segs.map((sd, i) => <path key={i} d={sd} fill="none" stroke="var(--accent)" strokeDasharray="5 6" opacity={0.75} />)}
        {sat && orbit?.inPass && <line x1={sat[0]} y1={sat[1]} x2={gs[0]} y2={gs[1]} stroke="var(--clean)" strokeDasharray="2 4" />}
        {sat && inView(sat) && (
          <g>
            <rect x={sat[0] - 7} y={sat[1] - 7} width={14} height={14} fill="var(--text)" stroke="var(--accent)" strokeWidth={2} />
            <line x1={sat[0] - 18} y1={sat[1]} x2={sat[0] + 18} y2={sat[1]} stroke="var(--accent)" strokeWidth={3} />
            <text x={sat[0] + 14} y={sat[1] - 12} className="map-l" fill="var(--text)">SolWatch-1U</text>
          </g>
        )}
      </g>
      {orbit && sat && !inView(sat) && (
        <text x={8} y={H - 10} className="map-l" fill="var(--muted)">
          Satellite now at {orbit.lat.toFixed(1)}°, {orbit.lon.toFixed(1)}° — {Math.round(orbit.rangeKm)} km from GS
        </text>
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
            <text x={x + 14} y={y + 4} className="map-l" fill="var(--text)">{f.short}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ---- Orbit ring -------------------------------------------------------------

/** One revolution from the ascending node; `sunlit`/`visible` are per-minute samples. */
export function OrbitRing({ orbit, sunlit, visible, size = 170 }: { orbit: OrbitState | null; sunlit: boolean[]; visible: boolean[]; size?: number }) {
  const c = size / 2;
  const r = c - 14;
  const P = orbit?.periodMin ?? 95;
  const ang = (min: number) => (min / P) * 2 * Math.PI - Math.PI / 2;
  const p = (min: number, rr = r) => [c + rr * Math.cos(ang(min)), c + rr * Math.sin(ang(min))];
  const arc = (m0: number, m1: number, rr = r) => {
    const [x0, y0] = p(m0, rr);
    const [x1, y1] = p(m1, rr);
    const large = m1 - m0 > P / 2 ? 1 : 0;
    return `M${x0},${y0}A${rr},${rr} 0 ${large} 1 ${x1},${y1}`;
  };
  const runs = (flags: boolean[]) => {
    const out: [number, number, boolean][] = [];
    flags.forEach((f, i) => {
      const last = out[out.length - 1];
      if (last && last[2] === f) last[1] = i + 1;
      else out.push([i, i + 1, f]);
    });
    return out;
  };
  const sat = orbit ? p(orbit.phaseMin) : null;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Orbit diagram with sunlit, eclipse and ground-station visibility arcs">
      <circle cx={c} cy={c} r={r * 0.48} fill="#0b3b66" />
      {runs(sunlit).map(([a, b, lit], i) => (
        <path key={i} d={arc(a, Math.min(b, P - 0.01))} stroke={lit ? 'var(--sun)' : '#475569'} strokeWidth={5} fill="none" opacity={lit ? 0.85 : 1} />
      ))}
      {runs(visible).filter(([, , v]) => v).map(([a, b], i) => (
        <path key={i} d={arc(a, Math.max(b, a + 0.5), r + 8)} stroke="var(--clean)" strokeWidth={3} fill="none" />
      ))}
      <text x={c} y={14} textAnchor="middle" className="map-l" fontSize={10}>▲ asc. node</text>
      {sat && <circle cx={sat[0]} cy={sat[1]} r={6} fill="var(--text)" stroke="var(--accent)" strokeWidth={2} />}
      <text x={c} y={c + 4} textAnchor="middle" className="map-l" fill="var(--text)">{orbit ? `${orbit.phaseMin.toFixed(0)} / ${P.toFixed(1)} min` : '—'}</text>
    </svg>
  );
}

/** Azimuth/elevation polar plot of a pass as seen from the ground station. */
export function SkyPlot({ pass, now, size = 170 }: { pass: Pass | null; now: { az: number; el: number } | null; size?: number }) {
  const c = size / 2;
  const R = c - 16;
  const xy = (az: number, el: number) => {
    const rr = R * (1 - el / 90);
    const a = (az * Math.PI) / 180;
    return [c + rr * Math.sin(a), c - rr * Math.cos(a)];
  };
  const d = pass?.track.map((p, i) => `${i ? 'L' : 'M'}${xy(p.az, p.el).map((v) => v.toFixed(1)).join(',')}`).join('') ?? '';
  const start = pass?.track[0];
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Sky plot of the satellite pass seen from the ground station">
      {[0, 30, 60].map((el) => <circle key={el} cx={c} cy={c} r={R * (1 - el / 90)} fill="none" stroke="var(--grid)" />)}
      <line x1={c} y1={c - R} x2={c} y2={c + R} stroke="var(--grid)" />
      <line x1={c - R} y1={c} x2={c + R} y2={c} stroke="var(--grid)" />
      {(['N', 'E', 'S', 'W'] as const).map((l, i) => {
        const [x, y] = xy(i * 90, -12);
        return <text key={l} x={x} y={y + 4} textAnchor="middle" className="compass-l" fill={l === 'N' ? 'var(--wetdust)' : 'var(--muted)'}>{l}</text>;
      })}
      <text x={c + 3} y={c - R * (2 / 3) - 2} className="map-l" fontSize={9}>30°</text>
      <text x={c + 3} y={c - R * (1 / 3) - 2} className="map-l" fontSize={9}>60°</text>
      {d && <path d={d} fill="none" stroke="var(--accent)" strokeWidth={2.5} strokeLinecap="round" />}
      {start && (() => { const [x, y] = xy(start.az, start.el); return <circle cx={x} cy={y} r={3.5} fill="var(--clean)" />; })()}
      {now && now.el > 0 && (() => { const [x, y] = xy(now.az, now.el); return <rect x={x - 5} y={y - 5} width={10} height={10} fill="var(--text)" stroke="var(--accent)" strokeWidth={2} />; })()}
      {pass && <text x={c} y={size - 2} textAnchor="middle" className="map-l" fontSize={10}>{fmtTime(pass.aos)}–{fmtTime(pass.los)} · max {pass.maxEl.toFixed(0)}°</text>}
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
