'use client';

import { useMemo, useState } from 'react';
import { Card } from './panels';
import { LineChart } from './charts';
import { Field, Num, Pill, Stat, type Status } from './ui';
import { ORBIT_OPTIONS } from '@/lib/orbit';
import { bitRate, linkBudget, sensitivityDbm, type LinkConfig } from '@/lib/link';
import {
  MASS_CONTINGENCY, MASS_LIMIT_G, analyseOrbit, dataBudget, eclipseDod, massBudget, powerBudget,
  type MissionCfg, type OrbitTrade,
} from '@/lib/mission';

const T0 = Date.parse('2026-11-01T00:00:00+04:00');

const tradeCache = new Map<string, OrbitTrade[]>();

/** 60-day analysis of every candidate orbit (cached per link configuration). */
export function useOrbitTrades(link: LinkConfig) {
  return useMemo(() => {
    const key = JSON.stringify(link);
    let t = tradeCache.get(key);
    if (!t) {
      t = ORBIT_OPTIONS.map((o) => analyseOrbit(o, link, T0, 60));
      tradeCache.set(key, t);
    }
    return t;
  }, [link]);
}

export function MissionTab({ cfg, setCfg, orbitId, setOrbitId }: {
  cfg: MissionCfg; setCfg: (c: MissionCfg) => void; orbitId: string; setOrbitId: (id: string) => void;
}) {
  const trades = useOrbitTrades(cfg.link);
  const [elev, setElev] = useState(10);
  const trade = trades.find((t) => t.cfg.id === orbitId) ?? trades[0];
  const orbit = trade.cfg;
  const link = cfg.link;
  const setLink = (p: Partial<LinkConfig>) => setCfg({ ...cfg, link: { ...link, ...p } });

  const lb = linkBudget(link, elev, orbit.altKm);
  const lb10 = linkBudget(link, orbit.minElDeg, orbit.altKm);
  const data = dataBudget(link);
  const capPerDayMin = trade.usableMinPerDay;
  const dataUse = (100 * data.airMinPerDay) / Math.max(capPerDayMin, 1e-6);
  const txDuty = (100 * Math.min(data.airMinPerDay, capPerDayMin)) / 1440;
  const pb = powerBudget(cfg, trade.sunlitPct / 100, txDuty);
  const dod = eclipseDod(pb.battWh, pb.loadW + pb.txW * 0.25, trade.eclipseMin);
  const mb = massBudget(cfg.mass);

  const marginSeries = useMemo(() => {
    const pts = [];
    for (let e = 0; e <= 90; e += 2) pts.push({ t: T0 + e * 60_000, v: linkBudget(link, e, orbit.altKm).margin });
    return pts;
  }, [link, orbit.altKm]);

  const st = (ok: boolean, warn = false): Status => (ok ? 'ok' : warn ? 'warn' : 'fail');
  const reqs: { id: string; text: string; verify: string; status: Status; note: string }[] = [
    { id: 'MR-1', text: 'Detect panel soiling with SI resolution ≤ 0.05', verify: 'Test (bench)', status: 'pending', note: 'Lab validation page — needs real bench data' },
    { id: 'MR-2', text: 'Distinguish clean / dry dust / dew / wet dust and issue a cleaning order', verify: 'Demonstration', status: 'sim', note: 'Operations page, scenario buttons' },
    { id: 'MR-3', text: 'WET DUST alert reaches the farm before sunrise', verify: 'Analysis', status: st(trade.predawnPerWeek >= 3.5, trade.predawnPerWeek >= 1), note: `${trade.predawnPerWeek.toFixed(1)} pre-dawn passes/week in this orbit` },
    { id: 'PL-1', text: '4 polarizer channels 0/45/90/135°, 16-bit ADC', verify: 'Inspection', status: 'pending', note: 'ADS1115 single-ended, 4 × TEMT6000' },
    { id: 'PL-2', text: 'DoLP and SI independent of satellite roll', verify: 'Analysis + test', status: 'sim', note: 'Rotation check (Operations) and bench rotation rows' },
    { id: 'COM-1', text: `LoRa link margin ≥ ${link.requiredMarginDb} dB at ${orbit.minElDeg}° elevation`, verify: 'Analysis', status: st(lb10.margin >= link.requiredMarginDb, lb10.margin >= 0), note: `${lb10.margin.toFixed(1)} dB at ${orbit.minElDeg}°` },
    { id: 'COM-2', text: 'Daily downlink capacity ≥ data generated', verify: 'Analysis', status: st(dataUse <= 80, dataUse <= 100), note: `${dataUse.toFixed(0)} % of usable pass time` },
    { id: 'EPS-1', text: 'Positive orbit-average power balance', verify: 'Analysis', status: st(pb.marginW > 0.1, pb.marginW > 0), note: `${pb.marginW >= 0 ? '+' : ''}${pb.marginW.toFixed(2)} W` },
    { id: 'EPS-2', text: 'Battery depth of discharge per eclipse ≤ 20 %', verify: 'Analysis', status: st(dod <= 20, dod <= 30), note: `${dod.toFixed(1)} %` },
    { id: 'STR-1', text: `Mass incl. ${MASS_CONTINGENCY * 100}% contingency ≤ ${MASS_LIMIT_G} g`, verify: 'Inspection (weigh)', status: st(mb.marginG > 0), note: `${mb.withCont.toFixed(0)} g` },
    { id: 'STR-2', text: 'Envelope 100 × 100 × 113.5 mm (CubeSat Design Spec.)', verify: 'Inspection', status: 'pending', note: 'measure the built structure' },
    { id: 'GS-1', text: 'Dashboard labels simulated data and works offline', verify: 'Inspection', status: 'ok', note: 'SIMULATED tags, service worker' },
  ];

  return (
    <div className="tabpage">
      <Card id="objectives" title="Mission objectives" sub="SolWatch-1U — orbital dust & dew intelligence for UAE solar farms" className="span3">
        <div className="two">
          <div>
            <h3 className="h3">Objectives</h3>
            <ol className="steps">
              <li><b>O1 · Soiling from orbit.</b> Measure the degree of linear polarization of sunlight reflected off PV glass and convert it to a Soiling Index.</li>
              <li><b>O2 · Night dew data.</b> Collect dew-node readings from each farm over LoRa 433 MHz and relay them (store-and-forward).</li>
              <li><b>O3 · Actionable orders.</b> Deliver one of four cleaning orders per farm, telling crews <i>when</i> and <i>how</i> to clean.</li>
              <li><b>S1 · Low-cost bus.</b> Demonstrate a COTS ESP32 + SX1278 1U platform built by students.</li>
            </ol>
          </div>
          <div>
            <h3 className="h3">Success criteria</h3>
            <ul className="crit">
              <li><b>Minimum</b> One valid daylight polarimetric reading over a farm and one relayed dew packet per day.</li>
              <li><b>Full</b> Bench-calibrated SI within ±0.05; daily cleaning orders for three farms.</li>
              <li><b>Extended</b> WET DUST alert delivered before sunrise on most dew nights (orbit-dependent — see trade study).</li>
            </ul>
            <h3 className="h3">Concept of operations</h3>
            <div className="conops">
              <span><b>Day</b> payload samples every {link.sEveryMin} min</span>
              <span><b>Night</b> dew nodes uplink every {link.nEveryMin} min</span>
              <span><b>Pass</b> downlink store, oldest first</span>
              <span><b>Ground</b> decide & publish order</span>
            </div>
          </div>
        </div>
      </Card>

      <Card id="trade" title="Orbit trade study" sub="Propagated over 60 days (a full drift cycle for inclined orbits) for the Abu Dhabi ground station. Pick the orbit the simulator uses." className="span3">
        <div className="tablewrap">
          <table className="dtable">
            <thead>
              <tr><th>Orbit</th><th>i</th><th>Period</th><th>Sunlit</th><th>Passes/day</th><th>Daylight passes/day</th><th>Pre-dawn passes/wk</th><th>Avg pass</th><th>Longest gap</th><th>Downlink/day</th><th /></tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.cfg.id} className={t.cfg.id === orbitId ? 'sel' : ''}>
                  <td><b>{t.cfg.label}</b></td>
                  <td className="mono">{t.incDeg.toFixed(1)}°</td>
                  <td className="mono">{t.periodMin.toFixed(1)} min</td>
                  <td className="mono">{t.sunlitPct.toFixed(0)}%</td>
                  <td className="mono">{t.passesPerDay.toFixed(1)}</td>
                  <td className="mono">{t.dayPassesPerDay.toFixed(1)}</td>
                  <td className="mono" style={{ color: t.predawnPerWeek >= 3.5 ? 'var(--clean)' : t.predawnPerWeek >= 1 ? 'var(--dust)' : 'var(--wetdust)' }}>{t.predawnPerWeek.toFixed(1)}</td>
                  <td className="mono">{t.avgPassMin.toFixed(1)} min</td>
                  <td className="mono">{t.maxGapH.toFixed(1)} h</td>
                  <td className="mono">{Math.round(t.capacityPerDay)} pkts</td>
                  <td>{t.cfg.id === orbitId ? <Pill s="ok" text="In use" /> : <button className="btn sm" onClick={() => setOrbitId(t.cfg.id)}>Use</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">
          <b>Finding:</b> a 10:30 sun-synchronous orbit only passes the UAE around 10–11 am and 9–11 pm, so dew that forms 01:00–06:00 is reported
          after sunrise — too late for the WET DUST order. ISS-deployed orbits drift through all local times (some pre-dawn passes); a dawn-dusk orbit
          passes near 06:00 every day and is permanently sunlit, but its daylight passes come with a low Sun.
        </p>
      </Card>

      <div className="grid">
        <Card id="linkbudget" title="Link budget" sub={`SX1278 · ${link.freqMHz} MHz · ${orbit.altKm} km`} className="span2">
          <div className="two">
            <div className="form-grid">
              <Field label="TX power" hint="dBm"><Num label="TX power" value={link.txDbm} onChange={(v) => setLink({ txDbm: v })} max={20} /></Field>
              <Field label="Spreading factor">
                <select value={link.sf} onChange={(e) => setLink({ sf: Number(e.target.value) as LinkConfig['sf'] })}>
                  {[7, 8, 9, 10, 11, 12].map((s) => <option key={s} value={s}>SF{s} ({sensitivityDbm(s, link.bwKHz).toFixed(1)} dBm)</option>)}
                </select>
              </Field>
              <Field label="Bandwidth" hint="kHz">
                <select value={link.bwKHz} onChange={(e) => setLink({ bwKHz: Number(e.target.value) })}>
                  {[62.5, 125, 250].map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </Field>
              <Field label="Sat antenna" hint="dBi"><Num label="Satellite antenna gain" value={link.satGainDbi} onChange={(v) => setLink({ satGainDbi: v })} /></Field>
              <Field label="GS antenna" hint="dBi"><Num label="Ground antenna gain" value={link.gsGainDbi} onChange={(v) => setLink({ gsGainDbi: v })} /></Field>
              <Field label="Cable loss" hint="dB"><Num label="Cable loss" value={link.cableLossDb} onChange={(v) => setLink({ cableLossDb: v })} /></Field>
              <Field label="Polarization loss" hint="dB"><Num label="Polarization loss" value={link.polLossDb} onChange={(v) => setLink({ polLossDb: v })} /></Field>
              <Field label="Atmos. + pointing" hint="dB"><Num label="Atmospheric and pointing loss" value={link.atmLossDb + link.pointingLossDb} onChange={(v) => setLink({ atmLossDb: v / 2, pointingLossDb: v / 2 })} /></Field>
              <Field label="Required margin" hint="dB"><Num label="Required margin" value={link.requiredMarginDb} onChange={(v) => setLink({ requiredMarginDb: v })} /></Field>
            </div>
            <div>
              <div className="slider">
                <label htmlFor="elev">Elevation<b className="mono">{elev}°</b></label>
                <input id="elev" type="range" min={orbit.minElDeg} max={90} value={elev} onChange={(e) => setElev(Number(e.target.value))} />
              </div>
              <table className="dtable budget">
                <tbody>
                  {lb.lines.map((l) => (
                    <tr key={l.label} className={l.label === 'Link margin' ? 'total' : ''}>
                      <td>{l.label}</td>
                      <td className="mono num-r">{l.value.toFixed(l.unit === 'km' ? 0 : 1)} {l.unit}</td>
                      <td>{l.note && <Pill s={l.note === 'OK' ? 'ok' : l.note === 'thin' ? 'warn' : 'fail'} text={l.note} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="note small">Bit rate {bitRate(link.sf, link.bwKHz).toFixed(0)} bit/s. 433 MHz short-range-device rules limit ground use; a flight mission would coordinate an amateur-satellite frequency (435–438 MHz) through IARU and TDRA.</p>
            </div>
          </div>
          <LineChart ariaLabel="Link margin versus elevation" range={[T0, T0 + 90 * 60_000]} height={150} showNight={false}
            xFmt={(t) => `${Math.round((t - T0) / 60_000)}°`} tipFmt={(t) => `Elevation ${Math.round((t - T0) / 60_000)}°`}
            yFmt={(v) => v.toFixed(0)} thresholds={[{ v: link.requiredMarginDb, label: `required ${link.requiredMarginDb} dB`, color: 'var(--dust)' }, { v: 0, label: '0 dB', color: 'var(--wetdust)' }]}
            series={[{ label: 'Link margin (dB) vs elevation 0–90°', color: 'var(--accent)', unit: ' dB', points: marginSeries }]} />
        </Card>

        <Card id="databudget" title="Data budget" sub="Binary-packed packets on air; the ground station converts to JSON">
          <div className="form-grid">
            <Field label="S packet" hint="bytes"><Num label="S packet bytes" value={link.sBytes} onChange={(v) => setLink({ sBytes: v })} /></Field>
            <Field label="N packet" hint="bytes"><Num label="N packet bytes" value={link.nBytes} onChange={(v) => setLink({ nBytes: v })} /></Field>
            <Field label="S every" hint="min"><Num label="S interval" value={link.sEveryMin} onChange={(v) => setLink({ sEveryMin: Math.max(1, v) })} /></Field>
            <Field label="N every" hint="min"><Num label="N interval" value={link.nEveryMin} onChange={(v) => setLink({ nEveryMin: Math.max(1, v) })} /></Field>
          </div>
          <div className="tiles">
            <Stat label="Generated / day" value={String(Math.round(data.packets))} unit=" pkts" hint={`${(data.bytes / 1024).toFixed(1)} kB`} />
            <Stat label="Airtime needed" value={data.airMinPerDay.toFixed(1)} unit=" min/day" hint={`S ${data.airS.toFixed(0)} ms · N ${data.airN.toFixed(0)} ms`} />
            <Stat label="Usable pass time" value={capPerDayMin.toFixed(1)} unit=" min/day" hint="margin ≥ 0 dB" />
            <Stat label="Utilisation" value={dataUse.toFixed(0)} unit=" %" tone={dataUse <= 80 ? 'var(--clean)' : dataUse <= 100 ? 'var(--dust)' : 'var(--wetdust)'} hint={dataUse > 100 ? 'backlog grows' : 'fits'} />
          </div>
          <p className="note small">JSON as shown in the packet log is ~170 bytes and would need ~7× the airtime — pack fields as binary on the satellite.</p>
        </Card>

        <Card id="power" title="Power budget" sub={`Orbit-average · ${orbit.label}`} className="span2">
          <div className="tablewrap">
            <table className="dtable">
              <thead><tr><th>Load</th><th>Current (mA)</th><th>Duty (%)</th><th className="num-r">Avg (mW)</th></tr></thead>
              <tbody>
                {pb.rows.map((r, i) => (
                  <tr key={r.name}>
                    <td>{r.name}</td>
                    <td><Num label={`${r.name} current`} value={r.mA} onChange={(v) => setCfg({ ...cfg, power: cfg.power.map((x, j) => (j === i ? { ...x, mA: v } : x)) })} /></td>
                    <td>{r.auto ? <span className="mono muted">{r.duty.toFixed(2)} (from passes)</span>
                      : <Num label={`${r.name} duty`} value={r.duty} min={0} max={100} onChange={(v) => setCfg({ ...cfg, power: cfg.power.map((x, j) => (j === i ? { ...x, duty: v } : x)) })} />}</td>
                    <td className="mono num-r">{r.avgmW.toFixed(1)}</td>
                  </tr>
                ))}
                <tr className="total"><td>Total load @ {cfg.solar.busV} V</td><td /><td /><td className="mono num-r">{(pb.loadW * 1000).toFixed(0)}</td></tr>
              </tbody>
            </table>
          </div>
          <div className="form-grid">
            <Field label="Cell area / face" hint="cm²"><Num label="Cell area per face" value={cfg.solar.cellAreaCm2} onChange={(v) => setCfg({ ...cfg, solar: { ...cfg.solar, cellAreaCm2: v } })} /></Field>
            <Field label="Faces with cells"><Num label="Faces with cells" value={cfg.solar.faces} min={1} max={6} onChange={(v) => setCfg({ ...cfg, solar: { ...cfg.solar, faces: v } })} /></Field>
            <Field label="Cell efficiency" hint="%"><Num label="Cell efficiency" value={cfg.solar.efficiency} onChange={(v) => setCfg({ ...cfg, solar: { ...cfg.solar, efficiency: v } })} /></Field>
            <Field label="Charge efficiency" hint="%"><Num label="Charge efficiency" value={cfg.solar.chargeEff} onChange={(v) => setCfg({ ...cfg, solar: { ...cfg.solar, chargeEff: v } })} /></Field>
            <Field label="Battery" hint="mAh"><Num label="Battery capacity" value={cfg.solar.battmAh} onChange={(v) => setCfg({ ...cfg, solar: { ...cfg.solar, battmAh: v } })} /></Field>
          </div>
          <div className="tiles four">
            <Stat label="Generation (sunlit)" value={pb.genSunlitW.toFixed(2)} unit=" W" hint="tumbling: ¼ of cell area faces the Sun" />
            <Stat label="Orbit-average gen." value={pb.genAvgW.toFixed(2)} unit=" W" hint={`${trade.sunlitPct.toFixed(0)}% sunlit`} />
            <Stat label="Power margin" value={`${pb.marginW >= 0 ? '+' : ''}${pb.marginW.toFixed(2)}`} unit=" W" tone={pb.marginW > 0.1 ? 'var(--clean)' : pb.marginW > 0 ? 'var(--dust)' : 'var(--wetdust)'} />
            <Stat label="Eclipse DoD" value={dod.toFixed(1)} unit=" %" hint={`${trade.eclipseMin.toFixed(0)} min eclipse · ${pb.battWh.toFixed(1)} Wh`} tone={dod <= 20 ? 'var(--clean)' : 'var(--dust)'} />
          </div>
        </Card>

        <Card id="mass" title="Mass budget" sub={`Limit ${MASS_LIMIT_G} g (CDS Rev 13; Rev 14 allows 2.0 kg)`}>
          <div className="tablewrap">
            <table className="dtable">
              <thead><tr><th>Item</th><th className="num-r">g</th></tr></thead>
              <tbody>
                {cfg.mass.map((r, i) => (
                  <tr key={r.name}>
                    <td>{r.name}</td>
                    <td className="num-r"><Num label={`${r.name} mass`} value={r.g} width={70} onChange={(v) => setCfg({ ...cfg, mass: cfg.mass.map((x, j) => (j === i ? { ...x, g: v } : x)) })} /></td>
                  </tr>
                ))}
                <tr><td>Subtotal</td><td className="mono num-r">{mb.total.toFixed(0)}</td></tr>
                <tr><td>+ {MASS_CONTINGENCY * 100}% contingency</td><td className="mono num-r">{mb.withCont.toFixed(0)}</td></tr>
                <tr className="total"><td>Margin to limit</td><td className="mono num-r" style={{ color: mb.marginG > 0 ? 'var(--clean)' : 'var(--wetdust)' }}>{mb.marginG.toFixed(0)}</td></tr>
              </tbody>
            </table>
          </div>
          <p className="note small">Estimates — replace with weighed values.</p>
        </Card>
      </div>

      <Card id="reqs" title="Requirements & verification" sub="Each requirement traced to how it is verified and where it shows on this dashboard" className="span3">
        <div className="tablewrap">
          <table className="dtable">
            <thead><tr><th>ID</th><th>Requirement</th><th>Verification</th><th>Status</th><th>Evidence</th></tr></thead>
            <tbody>
              {reqs.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.id}</td><td>{r.text}</td><td className="muted">{r.verify}</td>
                  <td><Pill s={r.status} /></td><td className="muted">{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="note center">All budget values are design estimates and are saved in this browser. Replace them with measured values as hardware is tested.</p>
    </div>
  );
}
