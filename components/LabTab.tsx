'use client';

import { useMemo, useState } from 'react';
import { Card } from './panels';
import { CH_COLORS } from './charts';
import { Num, Pill, Scatter, Stat } from './ui';
import { analyseBench, benchFromCsv, benchToCsv, exampleBench, type BenchRow } from '@/lib/calibration';
import { CAL, DOLP_CLEAN, THRESH } from '@/lib/physics';

export interface BenchState { rows: BenchRow[]; example: boolean }
export const BENCH_DEFAULT: BenchState = { rows: exampleBench(), example: true };

export function LabTab({ bench, setBench, onApply }: {
  bench: BenchState; setBench: (b: BenchState) => void; onApply: (dolpClean: number, k: number, source: string) => void;
}) {
  const [csv, setCsv] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const a = useMemo(() => analyseBench(bench.rows), [bench.rows]);
  const edit = (i: number, k: keyof BenchRow, v: number | string) =>
    setBench({ example: false, rows: bench.rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)) });
  const applied = CAL.source !== 'design default';
  const siThreshLoss = THRESH.siDusty * a.k;

  const download = () => {
    const blob = new Blob([benchToCsv(bench.rows)], { type: 'text/csv' });
    const el = document.createElement('a');
    el.href = URL.createObjectURL(blob);
    el.download = 'solwatch-bench-data.csv';
    el.click();
    URL.revokeObjectURL(el.href);
  };

  return (
    <div className="tabpage">
      {bench.example ? (
        <div className="banner sim" role="note">
          <b>EXAMPLE BENCH DATA.</b> The table below is generated from the design model with sensor noise to show how the analysis works.
          It is <b>not a measurement</b>. Paste or type your own bench readings to validate SolWatch with real data.
        </div>
      ) : (
        <div className="banner live" role="note"><b>TEAM BENCH DATA.</b> Analysis below uses the measurements entered on this page (saved in this browser).</div>
      )}

      <Card id="procedure" title="Bench test procedure" sub="Validates MR-1 (soiling resolution) and PL-2 (rotation invariance) before flight" className="span3">
        <ol className="steps">
          <li><b>Setup.</b> Lamp or direct sunlight onto a PV-glass coupon at ~56° incidence (Brewster angle for n ≈ 1.5, where reflected light is most polarized). Point the SolWatch payload (4 × TEMT6000 behind 0/45/90/135° film polarizers, ADS1115) at the specular reflection.</li>
          <li><b>Clean reference.</b> Record ≥ 4 readings of the clean coupon → clean-glass DoLP and the SI noise floor.</li>
          <li><b>Dust series.</b> Sieve local desert dust onto the coupon in weighed steps (0.5–8 g/m²). At each step record the 4 channels and the short-circuit current of a reference PV cell placed behind the glass (as % of clean).</li>
          <li><b>Rotation.</b> At one dust level rotate the payload 0–120° about its optical axis: DoLP must stay constant while AoLP follows the rotation.</li>
          <li><b>Fit & apply.</b> The page fits clean DoLP and the loss-per-SI slope; “Apply calibration” loads them into the decision engine.</li>
        </ol>
      </Card>

      <div className="grid">
        <Card id="results" title="Calibration results" sub={`${bench.rows.length} readings · ${a.nClean} clean`} className="span3">
          <div className="tiles five">
            <Stat label="Clean-glass DoLP" value={a.dolpClean.toFixed(3)} hint={`±${(a.cleanSd || 0).toFixed(3)} · design ${DOLP_CLEAN}`} />
            <Stat label="PV loss per unit SI" value={Number.isFinite(a.k) ? a.k.toFixed(1) : '—'} unit=" %" hint={`R² ${Number.isFinite(a.r2) ? a.r2.toFixed(3) : '—'}`} />
            <Stat label="SI noise (1σ, clean)" value={Number.isFinite(a.siNoise) ? a.siNoise.toFixed(3) : '—'} tone={a.siNoise <= 0.05 / 3 ? 'var(--clean)' : 'var(--dust)'} hint="MR-1 needs 3σ ≤ 0.05" />
            <Stat label="Min. detectable dust" value={Number.isFinite(a.detectLimit) ? a.detectLimit.toFixed(2) : '—'} unit=" g/m²" hint="3σ / SI slope" />
            <Stat label="DoLP spread vs rotation" value={Number.isFinite(a.rotSpread) ? a.rotSpread.toFixed(3) : '—'} tone={a.rotSpread <= 0.03 ? 'var(--clean)' : 'var(--dust)'} hint={`AoLP error ${Number.isFinite(a.aolpErr) ? a.aolpErr.toFixed(1) : '—'}°`} />
          </div>
          <div className="row gap">
            <button className="btn primary" disabled={!Number.isFinite(a.k)}
              onClick={() => onApply(a.dolpClean, a.k, bench.example ? 'example bench data' : 'team bench data')}>Apply calibration to decision engine</button>
            <span className="note">
              Active: clean DoLP {CAL.dolpClean.toFixed(3)}, loss {CAL.lossPerSI.toFixed(1)} %/SI — {applied ? <Pill s={bench.example ? 'warn' : 'ok'} text={CAL.source} /> : <Pill s="pending" text="design default" />}
            </span>
          </div>
          {Number.isFinite(a.k) && (
            <p className="note">
              With this fit, the DRY DUST threshold SI {THRESH.siDusty} corresponds to ≈ {siThreshLoss.toFixed(1)} % PV loss. UAE plants typically clean to stay under ~3 %
              — a calibrated threshold near SI {(3 / a.k).toFixed(2)} would match that.
            </p>
          )}
        </Card>

        <Card id="si-dust" title="Soiling Index vs dust loading" sub="Rotation 0° readings">
          <Scatter ariaLabel="Soiling index against dust loading" xLabel="Dust (g/m²)" yLabel="SI"
            pts={a.pts.filter((p) => p.rot === 0).map((p) => ({ x: p.dust, y: p.si, label: p.label }))} />
        </Card>
        <Card id="loss-si" title="PV loss vs Soiling Index" sub="Reference-cell Isc loss; dashed = fitted slope">
          <Scatter ariaLabel="PV transmission loss against soiling index" xLabel="Soiling Index" yLabel="Loss (%)" fit={(x) => a.k * x}
            pts={a.pts.map((p) => ({ x: p.si, y: p.loss, color: p.rot === 0 ? 'var(--dust)' : 'var(--accent)', label: p.label }))} />
        </Card>
        <Card id="rot" title="Rotation invariance" sub="Same sample, payload rotated">
          <Scatter ariaLabel="DoLP and AoLP against rotation" xLabel="Rotation (°)" yLabel="DoLP" yMin={0}
            pts={a.pts.filter((p) => p.dust === 2).map((p) => ({ x: p.rot, y: p.dolp, color: 'var(--clean)', label: `${p.label}: AoLP ${p.aolp.toFixed(1)}°` }))} />
        </Card>

        <Card id="bench" title="Bench readings" sub="Edit cells, add rows or paste CSV. Saved in this browser." className="span3"
          right={
            <div className="row gap">
              <button className="btn sm" onClick={() => setBench({ example: false, rows: [...bench.rows, { label: `Reading ${bench.rows.length + 1}`, dust: 0, rot: 0, i0: 0, i45: 0, i90: 0, i135: 0, isc: 100 }] })}>+ Row</button>
              <button className="btn sm" onClick={() => { setCsv(benchToCsv(bench.rows)); setErr(null); }}>Paste CSV</button>
              <button className="btn sm" onClick={download}>⬇ CSV</button>
              <button className="btn sm" onClick={() => setBench(BENCH_DEFAULT)}>Reset to example</button>
            </div>
          }>
          {csv != null && (
            <div className="form">
              <textarea className="mono" rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} spellCheck={false}
                aria-label="Bench data CSV: label,dust_gm2,rot_deg,i0,i45,i90,i135,isc_pct" />
              <div className="row gap">
                <button className="btn primary" onClick={() => {
                  try { setBench({ example: false, rows: benchFromCsv(csv) }); setCsv(null); setErr(null); } catch (e) { setErr((e as Error).message); }
                }}>Load CSV</button>
                <button className="btn" onClick={() => setCsv(null)}>Cancel</button>
                <span className="muted small">Columns: label, dust_gm2, rot_deg, i0, i45, i90, i135, isc_pct</span>
              </div>
              {err && <p className="note err">{err}</p>}
            </div>
          )}
          <div className="tablewrap">
            <table className="dtable bench">
              <thead>
                <tr>
                  <th>Label</th><th>Dust g/m²</th><th>Rot °</th>
                  {['I0', 'I45', 'I90', 'I135'].map((h, i) => <th key={h} style={{ color: CH_COLORS[i] }}>{h} V</th>)}
                  <th>Isc %</th><th>DoLP</th><th>AoLP</th><th>SI</th><th>Loss %</th><th />
                </tr>
              </thead>
              <tbody>
                {bench.rows.map((r, i) => {
                  const p = a.pts[i];
                  return (
                    <tr key={i}>
                      <td><input className="txt" aria-label="Label" value={r.label} onChange={(e) => edit(i, 'label', e.target.value)} /></td>
                      {(['dust', 'rot', 'i0', 'i45', 'i90', 'i135', 'isc'] as const).map((k) => (
                        <td key={k}><Num label={k} value={r[k]} width={k.startsWith('i') ? 80 : 64} onChange={(v) => edit(i, k, v)} /></td>
                      ))}
                      <td className="mono">{p.dolp.toFixed(3)}</td>
                      <td className="mono">{p.aolp.toFixed(1)}°</td>
                      <td className="mono">{p.si.toFixed(3)}</td>
                      <td className="mono">{p.loss.toFixed(1)}</td>
                      <td><button className="btn sm ghost" aria-label={`Delete ${r.label}`} onClick={() => setBench({ example: false, rows: bench.rows.filter((_, j) => j !== i) })}>✕</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
