'use client';

import { useMemo } from 'react';
import { Card } from './panels';
import { LineChart } from './charts';
import { Field, Num, Stat } from './ui';
import { IMPACT_DEFAULTS, USD_AED, runImpact, type ImpactInputs } from '@/lib/impact';
import { CAL } from '@/lib/physics';

const PRESETS: { id: string; label: string; capacityMWp: number; tariffUSD: number }[] = [
  { id: 'dhafra', label: 'Al Dhafra PV2 (2 GW)', capacityMWp: 2000, tariffUSD: 0.0132 },
  { id: 'noor', label: 'Noor Abu Dhabi (1.177 GW)', capacityMWp: 1177, tariffUSD: 0.0242 },
];

const YEAR0 = Date.UTC(2027, 0, 1);
const DAY = 86_400_000;

const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });
const dayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const fmtMoney = (usd: number) => {
  const aed = usd * USD_AED;
  return Math.abs(aed) >= 1e6 ? `AED ${(aed / 1e6).toFixed(2)} M` : `AED ${Math.round(aed / 1000)} k`;
};

export function ImpactTab({ inputs, setInputs, predawnPct, orbitLabel }: {
  inputs: ImpactInputs; setInputs: (i: ImpactInputs) => void; predawnPct: number; orbitLabel: string;
}) {
  const p = inputs;
  const set = (patch: Partial<ImpactInputs>) => setInputs({ ...p, ...patch });
  const r = useMemo(() => runImpact(p), [p]);
  const pools = r.waterSavedM3 / 2500;
  const sens = useMemo(() => [0.75, 1, 1.5, 2, 3].map((trig) => ({ trig, res: runImpact({ ...p, triggerPct: trig }) })), [p]);

  const row = (label: string, key: keyof ImpactInputs, hint: React.ReactNode, step: number | 'any' = 'any') => (
    <Field label={label} hint={hint}><Num label={label} value={p[key]} step={step} onChange={(v) => set({ [key]: v } as Partial<ImpactInputs>)} /></Field>
  );

  return (
    <div className="tabpage">
      <div className="banner sim" role="note">
        <b>MODEL ESTIMATE.</b> A one-year simulation of soiling at one plant under two cleaning strategies with the same dust and dew history.
        Sourced inputs are marked; everything else is an assumption you can change.
      </div>

      <div className="grid">
        <Card id="impact-sum" title="Annual impact" sub={`${PRESETS.find((x) => x.capacityMWp === p.capacityMWp)?.label ?? `${p.capacityMWp} MWp plant`} · ${r.annualGWh.toFixed(0)} GWh/yr · ${r.areaKm2.toFixed(1)} km² of modules`} className="span3">
          <div className="tiles four">
            <Stat label="Water saved" value={(r.waterSavedM3 / 1000).toFixed(0)} unit=" k m³/yr" tone="var(--dew)" hint={`≈ ${pools.toFixed(0)} Olympic pools`} />
            <Stat label="Energy recovered" value={r.energyRecoveredGWh.toFixed(1)} unit=" GWh/yr" tone={r.energyRecoveredGWh >= 0 ? 'var(--clean)' : 'var(--wetdust)'} hint={r.energyRecoveredGWh >= 0 ? 'less soiling loss' : 'more loss than the schedule'} />
            <Stat label="Revenue recovered" value={fmtMoney(r.revenueRecoveredUSD)} tone={r.revenueRecoveredUSD >= 0 ? 'var(--clean)' : 'var(--wetdust)'} hint={`at $${p.tariffUSD}/kWh`} />
            <Stat label="Cementation nights" value={`${r.base.cementNights} → ${r.sw.cementNights}`} hint="dust + dew crust events" />
          </div>
          <div className="tablewrap">
            <table className="dtable">
              <thead><tr><th>Strategy</th><th>Mean soiling loss</th><th>Energy lost</th><th>Revenue lost</th><th>Water</th><th>Wet washes</th><th>Dry cleans</th></tr></thead>
              <tbody>
                {[r.base, r.sw].map((s) => (
                  <tr key={s.name}>
                    <td><b>{s.name}</b></td>
                    <td className="mono">{s.meanLossPct.toFixed(2)} %</td>
                    <td className="mono">{s.energyLostGWh.toFixed(1)} GWh</td>
                    <td className="mono">{fmtMoney(s.revenueLostUSD)}</td>
                    <td className="mono">{(s.waterM3 / 1000).toFixed(0)} k m³</td>
                    <td className="mono">{s.wetWashes}</td>
                    <td className="mono">{s.dryCleans}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <LineChart ariaLabel="Daily soiling loss over one year for both strategies" range={[YEAR0, YEAR0 + 364 * DAY]} showNight={false} height={190}
            yFmt={(v) => `${v.toFixed(1)}`} yMin={0} xFmt={(t) => monthFmt.format(t)} tipFmt={(t) => `Day ${Math.round((t - YEAR0) / DAY) + 1} · ${dayFmt.format(t)}`}
            series={[
              { label: 'Fixed schedule — soiling loss %', color: '#94a3b8', unit: ' %', points: r.base.daily.map((v, d) => ({ t: YEAR0 + d * DAY, v })) },
              { label: 'SolWatch-guided — soiling loss %', color: 'var(--accent)', unit: ' %', points: r.sw.daily.map((v, d) => ({ t: YEAR0 + d * DAY, v })) },
            ]} />
          <p className="note small">Not modelled: cost of operating dry-cleaning robots or crews, and glass abrasion. Dry cleans assume waterless robots or brushing are available on site.</p>
        </Card>

        <Card id="impact-sens" title="Sensitivity to the cleaning trigger" sub="Where SolWatch pays off" className="span2">
          <div className="tablewrap">
            <table className="dtable">
              <thead><tr><th>Dry-clean trigger (loss)</th><th>≈ SI</th><th>Energy recovered</th><th>Water saved</th><th>Dry cleans/yr</th></tr></thead>
              <tbody>
                {sens.map(({ trig, res }) => (
                  <tr key={trig} className={trig === p.triggerPct ? 'sel' : ''}>
                    <td className="mono">{trig} %</td>
                    <td className="mono">{(trig / CAL.lossPerSI).toFixed(3)}</td>
                    <td className="mono" style={{ color: res.energyRecoveredGWh >= 0 ? 'var(--clean)' : 'var(--wetdust)' }}>{res.energyRecoveredGWh.toFixed(1)} GWh</td>
                    <td className="mono">{(res.waterSavedM3 / 1000).toFixed(0)} k m³</td>
                    <td className="mono">{res.sw.dryCleans}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">
            SolWatch saves almost all wash water at any trigger, but only beats a {p.baselineWashesPerYear}-wash schedule on energy when it triggers early (low SI).
            That needs the bench-measured SI noise floor to be small — see Lab validation. SI uses the active calibration ({CAL.lossPerSI.toFixed(1)} % loss per SI).
          </p>
        </Card>

        <Card id="impact-inputs" title="Inputs" sub="Sourced values cited below">
          <div className="row gap wrap">
            {PRESETS.map((x) => (
              <button key={x.id} className={`btn sm ${p.capacityMWp === x.capacityMWp ? 'primary' : ''}`} onClick={() => set({ capacityMWp: x.capacityMWp, tariffUSD: x.tariffUSD })}>{x.label}</button>
            ))}
            <button className="btn sm" onClick={() => setInputs({ ...IMPACT_DEFAULTS, predawnAlertPct: Math.round(predawnPct) })}>Reset</button>
          </div>
          <div className="form-grid">
            {row('Capacity', 'capacityMWp', 'MWp [1]')}
            {row('Tariff', 'tariffUSD', 'USD/kWh [2]')}
            {row('Specific yield', 'yieldKWhPerKWp', 'kWh/kWp·yr (assumed)')}
            {row('Module efficiency', 'moduleEffPct', '% (assumed)')}
            {row('Soiling rate', 'soilingPctPerDay', '%/day [3]')}
            {row('Dust storms', 'stormsPerYear', '/yr (assumed)')}
            {row('Storm loss', 'stormLossPct', '% each (assumed)')}
            {row('Dew nights Nov–Mar', 'dewWinterPct', '% (assumed)')}
            {row('Dew nights Apr–Oct', 'dewSummerPct', '% (assumed)')}
            {row('Water per wash', 'waterLPerM2', 'L/m² [4]')}
            {row('Scheduled washes', 'baselineWashesPerYear', '/yr [3]')}
            {row('SolWatch trigger', 'triggerPct', '% loss')}
            {row('Detection delay', 'detectDelayDays', 'days (revisit)')}
            {row('Pre-dawn alerts', 'predawnAlertPct', <>% of dew nights · orbit gives {predawnPct.toFixed(0)}%</>)}
            {row('Cementing above', 'cementThresholdPct', '% loss (assumed)')}
            {row('Share that cements', 'cementFracPct', '% (assumed)')}
          </div>
          <p className="note small">Pre-dawn alert share comes from the orbit trade ({orbitLabel}).</p>
          <ol className="refs">
            <li>Capacity: Al Dhafra 2 GW, Noor Abu Dhabi 1,177 MW — <a href="https://www.pv-tech.org/news/edf-jinkopower-and-partners-close-financing-for-2gw-solar-project-in-abu-dhabi" target="_blank" rel="noreferrer">PV Tech</a></li>
            <li>Tariffs: Al Dhafra $0.0132/kWh at financial close; Noor $0.0242/kWh — <a href="https://www.pv-tech.org/news/abu-dhabi-claims-new-record-low-solar-tariff-of-us0.0135-kwh-for-2gw-al-dha" target="_blank" rel="noreferrer">PV Tech</a></li>
            <li>Soiling 0.1–1 %/day in dry climates; UAE plants cleaned ~40–45×/yr to keep losses under 3 % — <a href="https://www.pv-tech.org/features/pv-soiling-in-dry-climates-causes-impacts-and-solutions" target="_blank" rel="noreferrer">PV Tech</a></li>
            <li>~1 L/m² for a semi-automated wet cleaner in the UAE — <a href="https://pveurope.eu/planning/cleaning-desert-race-against-sand" target="_blank" rel="noreferrer">pv Europe</a></li>
          </ol>
        </Card>
      </div>
    </div>
  );
}
