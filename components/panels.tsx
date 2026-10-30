'use client';

import { useState } from 'react';
import { ChannelBars, Compass, Gauge, LineChart, Meter, CH_COLORS } from './charts';
import { OrbitRing, UaeMap } from './visuals';
import { ago, fmtTime, signed } from './format';
import { DOLP_CLEAN, THRESH, soilingLossPct, battPercent } from '@/lib/physics';
import { GroundProcessor, STATE_INFO, explain, type CleanState, type FarmGround } from '@/lib/ground';
import { FARMS, farmShort } from '@/lib/farms';
import { ORBIT_MIN, SUNLIT_MIN, type OrbitState, type Simulator } from '@/lib/sim';

export interface View {
  ground: GroundProcessor;
  sim: Simulator | null;
  live: boolean;
  now: number; // mission "now" (sim clock or wall clock)
  range: [number, number];
  farmId: string;
  orbit: OrbitState | null;
}

const inRange = <T extends { t: number }>(arr: T[], [t0, t1]: [number, number]) => arr.filter((p) => p.t >= t0 && p.t <= t1);

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Card({ title, sub, children, className = '', right, id }: {
  title: string; sub?: string; children: React.ReactNode; className?: string; right?: React.ReactNode; id?: string;
}) {
  return (
    <section className={`card ${className}`} id={id} aria-labelledby={id ? `${id}-h` : undefined}>
      <header className="card-h">
        <div>
          <h2 id={id ? `${id}-h` : undefined}>{title}</h2>
          {sub && <p className="card-sub">{sub}</p>}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

export function SimTag({ live }: { live: boolean }) {
  return live ? <span className="tag live">LIVE</span> : <span className="tag sim">SIMULATED</span>;
}

// ---- 2. Cleaning orders -------------------------------------------------------

function StateStrip({ f, range }: { f: FarmGround; range: [number, number] }) {
  const pts = f.states.filter((p) => p.t <= range[1]);
  const [t0, t1] = range;
  const segs: { from: number; to: number; state: CleanState }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const from = Math.max(pts[i].t, t0);
    const to = Math.min(pts[i + 1]?.t ?? t1, t1);
    if (to <= t0 || to <= from) continue;
    const last = segs[segs.length - 1];
    if (last && last.state === pts[i].state) last.to = to;
    else segs.push({ from, to, state: pts[i].state });
  }
  return (
    <div className="strip" aria-label="State history over selected time range">
      {segs.map((s, i) => (
        <span key={i} title={`${STATE_INFO[s.state].label} ${fmtTime(s.from)}–${fmtTime(s.to)}`}
          style={{ left: `${((s.from - t0) / (t1 - t0)) * 100}%`, width: `${((s.to - s.from) / (t1 - t0)) * 100}%`, background: STATE_INFO[s.state].color }} />
      ))}
    </div>
  );
}

export function FarmCards({ v, onSelect }: { v: View; onSelect: (id: string) => void }) {
  const ids = [...new Set([...FARMS.map((f) => f.id), ...v.ground.farms.keys()])];
  return (
    <div className="orders">
      {ids.map((id) => {
        const f = v.ground.farm(id);
        const info = STATE_INFO[f.state];
        const hasData = f.payload.length + f.dew.length > 0;
        const { reason, pending } = explain(f);
        const si = f.heldSI;
        return (
          <button key={id} className={`order ${v.farmId === id ? 'sel' : ''} st-${f.state}`} onClick={() => onSelect(id)}
            style={{ ['--st' as string]: info.color }} aria-pressed={v.farmId === id}>
            <div className="order-top">
              <span className="order-farm">{FARMS.find((x) => x.id === id)?.name ?? id}</span>
              <SimTag live={v.live} />
            </div>
            {hasData ? (
              <>
                <div className="order-state"><span className="order-icon" aria-hidden>{info.icon}</span>{info.label}</div>
                <div className="order-action">{info.action}</div>
                <p className="order-reason">{reason}</p>
                {pending && <p className="order-pending">{pending}</p>}
                <div className="order-metrics">
                  <div><small>Soiling index</small><b className="mono">{si == null ? '—' : si.toFixed(2)}</b></div>
                  <div><small>Dew margin</small><b className="mono">{f.lastDew ? `${signed(f.lastDew.margin)}°C` : '—'}</b></div>
                  <div><small>Est. PV loss</small><b className="mono">{si == null ? '—' : `${soilingLossPct(si).toFixed(0)}%`}</b></div>
                </div>
                <div className="cri">
                  <div className="cri-l"><small>Cementing risk</small><b className="mono">{f.cri}/100</b></div>
                  <Meter value={f.cri} color={f.cri > 60 ? 'var(--wetdust)' : f.cri > 30 ? 'var(--dust)' : 'var(--clean)'} label="Cementing risk index" />
                </div>
                <StateStrip f={f} range={v.range} />
                <div className="order-foot">State since {f.stateSince ? fmtTime(f.stateSince, true) : '—'} UAE</div>
              </>
            ) : (
              <Empty>Waiting for packets from this farm…</Empty>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---- 3. Payload ---------------------------------------------------------------

export function PayloadPanel({ v }: { v: View }) {
  const f = v.ground.farm(v.farmId);
  const last = f.lastPayload;
  const lastValid = [...f.payload].reverse().find((p) => p.valid) ?? null;
  const pts = inRange(f.payload, v.range);
  return (
    <Card id="payload" title="Polarimetric payload" sub={`4 × TEMT6000 behind 0/45/90/135° polarizers · ADS1115 · ${farmShort(v.farmId)}`} right={<SimTag live={v.live} />} className="span2">
      {!last ? <Empty>No payload packets yet.</Empty> : (
        <>
          <div className="payload-top">
            <div>
              <ChannelBars values={[last.i0, last.i45, last.i90, last.i135]} />
              <p className="note">
                S0 = {last.s0.toFixed(2)} V ·{' '}
                {last.valid ? (last.wet ? 'glass wet → SI held at last dry reading' : 'valid daylight reading')
                  : 'farm dark — payload idle, SI held'}
              </p>
            </div>
            <Gauge value={lastValid?.dolp ?? null} zones={[[0.3, 'var(--wetdust)'], [0.6, 'var(--dust)'], [1, 'var(--clean)']]}
              label="DoLP" display={lastValid ? lastValid.dolp.toFixed(2) : '—'} marker={{ v: DOLP_CLEAN, label: `clean ${DOLP_CLEAN}` }} />
            <Gauge value={f.heldSI} zones={[[THRESH.siClear, 'var(--clean)'], [THRESH.siDusty, '#facc15'], [1, 'var(--dust)']]}
              label="Soiling index" display={f.heldSI == null ? '—' : f.heldSI.toFixed(2)} />
            <div className="aolp">
              <svg width={92} height={92} viewBox="0 0 92 92" aria-label={`Angle of linear polarization ${lastValid?.aolp.toFixed(0)} degrees`}>
                <circle cx={46} cy={46} r={40} fill="none" stroke="var(--grid)" strokeWidth={2} />
                <line x1={6} y1={46} x2={86} y2={46} stroke="var(--grid)" />
                {lastValid && (
                  <line x1={46 - 38 * Math.cos((lastValid.aolp * Math.PI) / 180)} y1={46 + 38 * Math.sin((lastValid.aolp * Math.PI) / 180)}
                    x2={46 + 38 * Math.cos((lastValid.aolp * Math.PI) / 180)} y2={46 - 38 * Math.sin((lastValid.aolp * Math.PI) / 180)}
                    stroke="var(--accent)" strokeWidth={3} strokeLinecap="round" style={{ transition: 'all .6s' }} />
                )}
              </svg>
              <div className="gauge-val">{lastValid ? `${lastValid.aolp.toFixed(1)}°` : '—'}</div>
              <div className="gauge-label">AoLP</div>
            </div>
          </div>
          <LineChart ariaLabel="Soiling index over time" range={v.range} yMin={0} yMax={1}
            thresholds={[{ v: THRESH.siDusty, label: 'dusty > 0.30', color: 'var(--dust)' }, { v: THRESH.siClear, label: 'clear < 0.20', color: 'var(--clean)' }]}
            series={[
              { label: 'SI used (held when wet/dark)', color: 'var(--accent)', points: pts.map((p) => ({ t: p.t, v: p.siHeld })), area: true },
              { label: 'SI raw', color: '#94a3b8', dashed: true, points: pts.map((p) => ({ t: p.t, v: p.siRaw })) },
            ]} />
          <LineChart ariaLabel="Channel voltages over time" range={v.range} height={150} yMin={0} yMax={3.3} yFmt={(x) => x.toFixed(1)}
            series={(['i0', 'i45', 'i90', 'i135'] as const).map((k, i) => ({
              label: `I${k.slice(1)}`, color: CH_COLORS[i], unit: ' V', points: pts.map((p) => ({ t: p.t, v: p[k] })),
            }))} />
        </>
      )}
    </Card>
  );
}

// ---- 4. Dew -------------------------------------------------------------------

function Tile({ label, value, unit, tone, hint }: { label: string; value: string; unit?: string; tone?: string; hint?: string }) {
  return (
    <div className="tile" style={tone ? { ['--tone' as string]: tone } : undefined}>
      <small>{label}</small>
      <b className="mono">{value}<span>{unit}</span></b>
      {hint && <em>{hint}</em>}
    </div>
  );
}

export function DewPanel({ v }: { v: View }) {
  const f = v.ground.farm(v.farmId);
  const d = f.lastDew;
  const pts = inRange(f.dew, v.range);
  const mTone = !d ? undefined : d.margin < 0 ? 'var(--dew)' : d.margin < 1 ? '#facc15' : 'var(--clean)';
  return (
    <Card id="dew" title="Dew panel" sub={`Ground dew node · relayed via satellite · ${farmShort(v.farmId)}`} right={<SimTag live={v.live} />}>
      {!d ? <Empty>No dew-node packets yet.</Empty> : (
        <>
          <div className="tiles">
            <Tile label="Air temp" value={d.air.toFixed(1)} unit="°C" />
            <Tile label="Humidity" value={d.rh.toFixed(0)} unit="%" />
            <Tile label="Glass temp" value={d.glass.toFixed(1)} unit="°C" />
            <Tile label="Dew point" value={d.td.toFixed(1)} unit="°C" hint="Magnus" />
            <Tile label="Dew margin" value={signed(d.margin)} unit="°C" tone={mTone} hint={d.margin < 0 ? 'dew forming' : d.margin < 1 ? 'near dew' : 'dry'} />
            <Tile label="Wet-plate" value={String(Math.round(d.wetPlate))} tone={d.wetPlate > THRESH.wetPlateSet ? 'var(--dew)' : undefined}
              hint={`wet > ${THRESH.wetPlateSet}`} />
          </div>
          <LineChart ariaLabel="Air, glass and dew point temperatures over time" range={v.range} yFmt={(x) => x.toFixed(0)}
            series={[
              { label: 'Air', color: '#fb923c', unit: ' °C', points: pts.map((p) => ({ t: p.t, v: p.air })) },
              { label: 'Glass', color: '#e2e8f0', unit: ' °C', points: pts.map((p) => ({ t: p.t, v: p.glass })) },
              { label: 'Dew point', color: 'var(--dew)', unit: ' °C', dashed: true, points: pts.map((p) => ({ t: p.t, v: p.td })) },
            ]} />
          <LineChart ariaLabel="Dew margin over time" height={140} range={v.range} yFmt={(x) => x.toFixed(0)}
            thresholds={[{ v: 0, label: 'dew 0 °C', color: 'var(--dew)' }]}
            series={[{ label: 'Dew margin', color: '#facc15', unit: ' °C', area: true, points: pts.map((p) => ({ t: p.t, v: p.margin })) }]} />
          <LineChart ariaLabel="Wet-plate reading over time" height={130} range={v.range} yFmt={(x) => x.toFixed(0)}
            thresholds={[{ v: THRESH.wetPlateSet, label: 'wet 500', color: 'var(--dew)' }, { v: THRESH.wetPlateClear, label: 'dry 380', color: 'var(--clean)' }]}
            series={[{ label: 'Wet-plate', color: '#818cf8', points: pts.map((p) => ({ t: p.t, v: p.wetPlate })) }]} />
        </>
      )}
    </Card>
  );
}

// ---- 5. Health ------------------------------------------------------------------

export function HealthPanel({ v }: { v: View }) {
  const h = v.ground.health[v.ground.health.length - 1];
  const pts = inRange(v.ground.health, v.range);
  const sunlit = v.orbit ? v.orbit.sunlit : h ? h.solar > 0.5 : null;
  return (
    <Card id="health" title="Satellite health" sub="INA219 · DS18B20 · QMC5883L · EPS" right={<SimTag live={v.live} />}>
      {!h ? <Empty>No housekeeping yet.</Empty> : (
        <>
          <div className="health-top">
            <div className="health-grid">
              <div className="hcell">
                <small>Battery</small>
                <b className="mono">{h.batt.toFixed(2)}<span> V</span></b>
                <Meter value={battPercent(h.batt)} color={h.batt < 3.4 ? 'var(--wetdust)' : h.batt < 3.7 ? 'var(--dust)' : 'var(--clean)'} label="Battery charge" />
                <em>{battPercent(h.batt).toFixed(0)}%</em>
              </div>
              <div className="hcell"><small>Solar array</small><b className="mono">{h.solar.toFixed(2)}<span> V</span></b><em>0–6 V</em></div>
              <div className="hcell"><small>Bus current</small><b className="mono">{h.current.toFixed(0)}<span> mA</span></b><em>INA219</em></div>
              <div className="hcell"><small>Power draw</small><b className="mono">{(h.power / 1000).toFixed(2)}<span> W</span></b><em>{h.power.toFixed(0)} mW</em></div>
              <div className="hcell"><small>Internal temp</small><b className="mono">{h.temp.toFixed(1)}<span> °C</span></b><em>DS18B20</em></div>
              <div className="hcell">
                <small>Illumination</small>
                <b className={sunlit ? 'sunlit' : 'eclipse'}>{sunlit ? '☀ Sunlit' : '● Eclipse'}</b>
                <em>
                  {v.orbit
                    ? `${Math.round((v.orbit.sunlit ? SUNLIT_MIN : ORBIT_MIN) - v.orbit.phaseMin)} min to ${v.orbit.sunlit ? 'eclipse' : 'sunlight'}`
                    : 'from solar V'}
                </em>
              </div>
            </div>
            <div className="compass">
              <Compass heading={h.heading} />
              <div className="gauge-val mono">{h.heading.toFixed(0).padStart(3, '0')}°</div>
              <div className="gauge-label">Heading (QMC5883L)</div>
            </div>
          </div>
          <LineChart ariaLabel="Battery and solar voltage over time" range={v.range} height={150} yMin={0} yMax={6} yFmt={(x) => x.toFixed(1)} showNight={false}
            series={[
              { label: 'Battery V', color: 'var(--clean)', unit: ' V', points: pts.map((p) => ({ t: p.t, v: p.batt })) },
              { label: 'Solar V', color: 'var(--sun)', unit: ' V', points: pts.map((p) => ({ t: p.t, v: p.solar })) },
            ]} />
        </>
      )}
    </Card>
  );
}

// ---- 6. Orbit & link -------------------------------------------------------------

export function OrbitPanel({ v }: { v: View }) {
  const states = Object.fromEntries([...v.ground.farms.values()].map((f) => [f.id, f.state])) as Record<string, CleanState>;
  const link = v.ground.lastLink;
  const linkFresh = link && (v.orbit ? v.orbit.inPass || v.sim?.continuousLink : v.now - link.t < 90_000);
  const o = v.orbit;
  return (
    <Card id="orbit" title="Orbit & link" sub={v.live ? 'Live: orbit position needs TLE propagation (not in Phase 1)' : '~95 min orbit · ~60 min sunlit · ~15 orbits/day'} right={<SimTag live={v.live} />} className="span2">
      <div className="orbit-wrap">
        <UaeMap orbit={o} states={states} selected={v.farmId} />
        <div className="orbit-side">
          <OrbitRing orbit={o} />
          <div className="orbit-legend">
            <span><i style={{ background: 'var(--sun)' }} />Sunlit</span>
            <span><i style={{ background: '#475569' }} />Eclipse</span>
            <span><i style={{ background: 'var(--clean)' }} />GS pass</span>
          </div>
          {o && (
            <p className="note">
              Orbit #{o.orbitNo} · {o.inPass ? `In pass, elevation ${o.elevation.toFixed(0)}°` : `Next pass in ${Math.round(o.minsToPass)} min`}
              {v.sim?.continuousLink && ' · continuous-link demo ON'}
            </p>
          )}
          <p className="note small">Pass schedule compressed for the demo (real LEO: 2–4 passes/day of ~8 min).</p>
        </div>
      </div>
      <div className="link-grid">
        <Tile label="LoRa RSSI" value={linkFresh && link ? String(link.rssi) : '—'} unit=" dBm" tone={linkFresh ? 'var(--clean)' : undefined} hint="433 MHz SX1278" />
        <Tile label="SNR" value={linkFresh && link ? link.snr.toFixed(1) : '—'} unit=" dB" />
        <Tile label="Packets received" value={String(v.ground.received)} hint="at ground station" />
        <Tile label="Stored on board" value={String(v.sim?.store.length ?? '—')} hint="awaiting pass" tone={v.sim?.store.length ? 'var(--dust)' : undefined} />
        <Tile label="Relayed" value={String(v.sim?.relayed ?? '—')} hint="store-and-forward" />
      </div>
    </Card>
  );
}

// ---- 7. Packet log ------------------------------------------------------------------

export function PacketLog({ v }: { v: View }) {
  const [onlyFarm, setOnlyFarm] = useState(false);
  const rows = v.ground.log.filter((e) => !onlyFarm || e.pkt.farm === v.farmId).slice(-80).reverse();
  return (
    <Card id="log" title="Packet log" sub="Raw packets as received by the ground station (newest first)" className="span3"
      right={
        <div className="row gap">
          <label className="check"><input type="checkbox" checked={onlyFarm} onChange={(e) => setOnlyFarm(e.target.checked)} /> {farmShort(v.farmId)} only</label>
          <SimTag live={v.live} />
        </div>
      }>
      {!rows.length ? <Empty>No packets yet.</Empty> : (
        <div className="log">
          <table>
            <thead>
              <tr><th>Rx (UAE)</th><th>Sampled</th><th>Type</th><th>Farm</th><th>Via</th><th>RSSI</th><th>State</th><th>Raw JSON</th></tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td className="mono">{fmtTime(e.rx)}</td>
                  <td className="mono">{fmtTime(Date.parse(e.pkt.t))}</td>
                  <td><span className={`ptype ${e.pkt.type}`}>{e.pkt.type}</span></td>
                  <td>{farmShort(e.pkt.farm)}</td>
                  <td className="muted">{e.pkt.via ?? '—'}</td>
                  <td className="mono">{e.pkt.rssi ?? '—'}</td>
                  <td><span className="dot" style={{ background: STATE_INFO[e.farmState].color }} />{STATE_INFO[e.farmState].label}</td>
                  <td className="mono raw">{v.live ? '' : '[SIM] '}{e.raw}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {v.ground.lastRx && <p className="note">Last packet {v.live ? ago(Date.now() - v.ground.lastRx) : `${fmtTime(v.ground.lastRx, true)} UAE (mission clock)`}</p>}
    </Card>
  );
}
