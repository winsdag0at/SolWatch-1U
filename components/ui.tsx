'use client';

import { useEffect, useState } from 'react';
import { useWidth } from './charts';

/** Numeric input that keeps a local draft so typing "0." or "" doesn't fight the parser. */
export function Num({ value, onChange, step = 'any', min, max, width = 84, label }: {
  value: number; onChange: (v: number) => void; step?: number | 'any'; min?: number; max?: number; width?: number; label: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    if (Number(draft) !== value) setDraft(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input className="num mono" type="number" inputMode="decimal" aria-label={label} style={{ width }} step={step} min={min} max={max}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        const v = Number(e.target.value);
        if (e.target.value !== '' && Number.isFinite(v)) onChange(v);
      }} />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}{hint && <small>{hint}</small>}</span>
      {children}
    </label>
  );
}

export function Stat({ label, value, unit, tone, hint }: { label: string; value: string; unit?: string; tone?: string; hint?: React.ReactNode }) {
  return (
    <div className="tile" style={tone ? { ['--tone' as string]: tone } : undefined}>
      <small>{label}</small>
      <b className="mono">{value}<span>{unit}</span></b>
      {hint && <em>{hint}</em>}
    </div>
  );
}

export type Status = 'ok' | 'warn' | 'fail' | 'pending' | 'sim';
const STATUS_TXT: Record<Status, string> = { ok: 'Meets', warn: 'Marginal', fail: 'Fails', pending: 'Pending hardware', sim: 'Simulated' };
export function Pill({ s, text }: { s: Status; text?: string }) {
  return <span className={`spill ${s}`}>{text ?? STATUS_TXT[s]}</span>;
}

export interface ScatterPt { x: number; y: number; color?: string; label?: string }

export function Scatter({ pts, xLabel, yLabel, fit, height = 220, xMin = 0, yMin = 0, ariaLabel }: {
  pts: ScatterPt[]; xLabel: string; yLabel: string; fit?: (x: number) => number; height?: number; xMin?: number; yMin?: number; ariaLabel: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(400);
  const pad = { l: 46, r: 12, t: 10, b: 36 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const xMax = Math.max(xMin + 1e-6, ...xs) * 1.08;
  const yMax = Math.max(yMin + 1e-6, ...ys, ...(fit ? [fit(xMax)] : [])) * 1.08;
  const x = (v: number) => pad.l + ((v - xMin) / (xMax - xMin)) * iw;
  const y = (v: number) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * ih;
  const ticks = (lo: number, hi: number) => Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
  const fmt = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2));
  return (
    <div ref={ref} className="chart" role="img" aria-label={ariaLabel}>
      <svg width={width} height={height}>
        {ticks(yMin, yMax).map((v, i) => (
          <g key={i}>
            <line x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
            <text x={pad.l - 6} y={y(v) + 3} textAnchor="end" className="axis">{fmt(v)}</text>
          </g>
        ))}
        {ticks(xMin, xMax).map((v, i) => (
          <text key={i} x={x(v)} y={pad.t + ih + 14} textAnchor="middle" className="axis">{fmt(v)}</text>
        ))}
        <text x={pad.l + iw / 2} y={height - 4} textAnchor="middle" className="axis" fill="var(--text)">{xLabel}</text>
        <text transform={`translate(11 ${pad.t + ih / 2}) rotate(-90)`} textAnchor="middle" className="axis" fill="var(--text)">{yLabel}</text>
        {fit && <line x1={x(xMin)} y1={y(fit(xMin))} x2={x(xMax)} y2={y(fit(xMax))} stroke="var(--accent)" strokeDasharray="5 4" strokeWidth={1.5} />}
        {pts.map((p, i) => (
          <circle key={i} cx={x(p.x)} cy={y(p.y)} r={4.5} fill={p.color ?? 'var(--accent)'} stroke="var(--panel)" strokeWidth={1.5}>
            {p.label && <title>{p.label}</title>}
          </circle>
        ))}
      </svg>
    </div>
  );
}

/** localStorage-backed state; falls back silently when storage is unavailable. */
export function useStored<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(initial);
  useEffect(() => {
    try {
      const s = localStorage.getItem(key);
      if (s) setV({ ...initial, ...JSON.parse(s) });
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = (next: T) => {
    setV(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* ignore */ }
  };
  return [v, set] as const;
}
