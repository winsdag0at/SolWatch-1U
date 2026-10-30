'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtTime } from './format';

export function useWidth<T extends HTMLElement>(initial = 600) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export interface Series {
  label: string;
  color: string;
  points: { t: number; v: number | null }[];
  dashed?: boolean;
  area?: boolean;
  unit?: string;
}

export interface Threshold { v: number; label: string; color: string }

/** Night periods at the farms (Nov: 17:35 → 06:25 UAE). */
export function nightBands(t0: number, t1: number) {
  const out: { from: number; to: number }[] = [];
  const day = 86_400_000;
  // UAE midnight in UTC ms
  const startDay = Math.floor((t0 + 4 * 3_600_000) / day) * day - 4 * 3_600_000 - day;
  for (let d = startDay; d < t1; d += day) {
    const from = d + 17.58 * 3_600_000;
    const to = d + day + 6.42 * 3_600_000;
    if (to > t0 && from < t1) out.push({ from: Math.max(from, t0), to: Math.min(to, t1) });
  }
  return out;
}

export function LineChart({
  series, height = 190, yMin, yMax, yFmt = (v: number) => v.toFixed(2), thresholds = [], range, showNight = true, ariaLabel,
  xFmt = (t: number) => fmtTime(t), tipFmt = (t: number) => `${fmtTime(t, true)} UAE`,
}: {
  series: Series[];
  height?: number;
  yMin?: number;
  yMax?: number;
  yFmt?: (v: number) => string;
  thresholds?: Threshold[];
  range: [number, number];
  showNight?: boolean;
  ariaLabel: string;
  xFmt?: (t: number) => string;
  tipFmt?: (t: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 44, r: 12, t: 10, b: 24 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const [t0, t1] = range;

  const [lo, hi] = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    series.forEach((s) => s.points.forEach((p) => {
      if (p.v == null || p.t < t0) return;
      lo = Math.min(lo, p.v);
      hi = Math.max(hi, p.v);
    }));
    thresholds.forEach((th) => { lo = Math.min(lo, th.v); hi = Math.max(hi, th.v); });
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
    const m = (hi - lo) * 0.08;
    return [yMin ?? lo - m, yMax ?? hi + m];
  }, [series, thresholds, yMin, yMax, t0]);

  const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * iw;
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * ih;

  const paths = series.map((s) => {
    let d = '';
    let pen = false;
    let first: number | null = null;
    let lastX = 0;
    for (const p of s.points) {
      if (p.t < t0 || p.t > t1) continue;
      if (p.v == null) { pen = false; continue; }
      const px = x(p.t);
      d += `${pen ? 'L' : 'M'}${px.toFixed(1)},${y(p.v).toFixed(1)}`;
      if (first == null) first = px;
      lastX = px;
      pen = true;
    }
    const area = s.area && first != null ? `${d}L${lastX.toFixed(1)},${pad.t + ih}L${first.toFixed(1)},${pad.t + ih}Z` : null;
    return { d, area };
  });

  const ticksY = 4;
  const yTicks = Array.from({ length: ticksY + 1 }, (_, i) => lo + ((hi - lo) * i) / ticksY);
  const xTickCount = Math.max(2, Math.floor(iw / 90));
  const xTicks = Array.from({ length: xTickCount + 1 }, (_, i) => t0 + ((t1 - t0) * i) / xTickCount);

  const hoverT = hover == null ? null : t0 + ((hover - pad.l) / iw) * (t1 - t0);
  const nearest = (s: Series) => {
    if (hoverT == null) return null;
    let best: { t: number; v: number | null } | null = null;
    for (const p of s.points) {
      if (p.t < t0 || p.t > t1) continue;
      if (!best || Math.abs(p.t - hoverT) < Math.abs(best.t - hoverT)) best = p;
    }
    return best;
  };
  const hoverVals = hoverT == null ? [] : series.map((s) => ({ s, p: nearest(s) }));
  const hoverAt = hoverVals.find((h) => h.p)?.p?.t ?? null;

  return (
    <div ref={ref} className="chart" role="img" aria-label={ariaLabel}>
      <div className="legend">
        {series.map((s) => (
          <span key={s.label}>
            <i style={{ background: s.color, opacity: s.dashed ? 0.6 : 1 }} />
            {s.label}
          </span>
        ))}
      </div>
      <svg
        width={width}
        height={height}
        onPointerMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = e.clientX - r.left;
          setHover(px >= pad.l && px <= width - pad.r ? px : null);
        }}
        onPointerLeave={() => setHover(null)}
      >
        {showNight && nightBands(t0, t1).map((b, i) => (
          <rect key={i} x={x(b.from)} y={pad.t} width={Math.max(0, x(b.to) - x(b.from))} height={ih} fill="var(--night)" />
        ))}
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
            <text x={pad.l - 6} y={y(v) + 3} textAnchor="end" className="axis">{yFmt(v)}</text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} x={x(t)} y={height - 6} textAnchor={i === 0 ? 'start' : i === xTickCount ? 'end' : 'middle'} className="axis">
            {xFmt(t)}
          </text>
        ))}
        {thresholds.map((th) => (
          <g key={th.label}>
            <line x1={pad.l} x2={width - pad.r} y1={y(th.v)} y2={y(th.v)} stroke={th.color} strokeDasharray="4 4" strokeWidth={1.2} />
            <text x={width - pad.r - 2} y={y(th.v) - 4} textAnchor="end" className="axis" fill={th.color}>{th.label}</text>
          </g>
        ))}
        {paths.map((p, i) => (
          <g key={i}>
            {p.area && <path d={p.area} fill={series[i].color} opacity={0.12} />}
            <path d={p.d} fill="none" stroke={series[i].color} strokeWidth={series[i].dashed ? 1.4 : 2}
              strokeDasharray={series[i].dashed ? '3 3' : undefined} strokeLinejoin="round" strokeLinecap="round" />
          </g>
        ))}
        {hoverAt != null && (
          <g>
            <line x1={x(hoverAt)} x2={x(hoverAt)} y1={pad.t} y2={pad.t + ih} stroke="var(--muted)" strokeDasharray="2 3" />
            {hoverVals.map(({ s, p }) => p && p.v != null && (
              <circle key={s.label} cx={x(p.t)} cy={y(p.v)} r={3.5} fill={s.color} stroke="var(--panel)" strokeWidth={1.5} />
            ))}
          </g>
        )}
      </svg>
      {hoverAt != null && (
        <div className="tip" style={{ left: Math.min(Math.max(x(hoverAt) + 10, 0), width - 170) }}>
          <b>{tipFmt(hoverAt)}</b>
          {hoverVals.map(({ s, p }) => (
            <div key={s.label}><i style={{ background: s.color }} />{s.label}: {p?.v == null ? '—' : yFmt(p.v)}{s.unit ?? ''}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Semicircular gauge. zones: [upTo, color][] in value units. */
export function Gauge({
  value, min = 0, max = 1, zones, label, display, marker, size = 170,
}: {
  value: number | null;
  min?: number;
  max?: number;
  zones: [number, string][];
  label: string;
  display: string;
  marker?: { v: number; label: string };
  size?: number;
}) {
  const w = size;
  const h = size * 0.62;
  const cx = w / 2;
  const cy = h - 8;
  const rad = w / 2 - 12;
  const ang = (v: number) => Math.PI * (1 - (Math.min(max, Math.max(min, v)) - min) / (max - min));
  const pt = (a: number, rr = rad) => [cx + rr * Math.cos(a), cy - rr * Math.sin(a)];
  const arc = (a0: number, a1: number) => {
    const [x0, y0] = pt(a0);
    const [x1, y1] = pt(a1);
    return `M${x0},${y0} A${rad},${rad} 0 0 1 ${x1},${y1}`;
  };
  let prev = min;
  const segs = zones.map(([upTo, color]) => {
    const s = { d: arc(ang(prev), ang(upTo)), color };
    prev = upTo;
    return s;
  });
  const a = value == null ? null : ang(value);
  return (
    <figure className="gauge" aria-label={`${label}: ${display}`}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        <path d={arc(Math.PI, 0)} stroke="var(--grid)" strokeWidth={12} fill="none" />
        {segs.map((s, i) => <path key={i} d={s.d} stroke={s.color} strokeWidth={12} fill="none" opacity={0.85} />)}
        {marker && (() => {
          const [x0, y0] = pt(ang(marker.v), rad - 10);
          const [x1, y1] = pt(ang(marker.v), rad + 9);
          return <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="var(--text)" strokeWidth={2} />;
        })()}
        {a != null && (() => {
          const [nx, ny] = pt(a, rad - 16);
          return (
            <g style={{ transition: 'all .6s' }}>
              <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="var(--text)" strokeWidth={3} strokeLinecap="round" />
              <circle cx={cx} cy={cy} r={6} fill="var(--text)" />
            </g>
          );
        })()}
      </svg>
      <figcaption>
        <span className="gauge-val">{display}</span>
        <span className="gauge-label">{label}{marker ? ` · ▏${marker.label}` : ''}</span>
      </figcaption>
    </figure>
  );
}

export function Compass({ heading, size = 150 }: { heading: number | null; size?: number }) {
  const c = size / 2;
  const r = c - 8;
  const ticks = Array.from({ length: 36 }, (_, i) => i * 10);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Heading ${heading ?? 'unknown'} degrees`}>
      <circle cx={c} cy={c} r={r} fill="var(--panel2)" stroke="var(--border)" strokeWidth={2} />
      {ticks.map((d) => {
        const a = ((d - 90) * Math.PI) / 180;
        const len = d % 90 === 0 ? 10 : d % 30 === 0 ? 7 : 4;
        return (
          <line key={d} x1={c + (r - len) * Math.cos(a)} y1={c + (r - len) * Math.sin(a)} x2={c + r * Math.cos(a)} y2={c + r * Math.sin(a)}
            stroke={d % 90 === 0 ? 'var(--text)' : 'var(--muted)'} strokeWidth={d % 90 === 0 ? 2 : 1} />
        );
      })}
      {(['N', 'E', 'S', 'W'] as const).map((l, i) => {
        const a = ((i * 90 - 90) * Math.PI) / 180;
        return (
          <text key={l} x={c + (r - 22) * Math.cos(a)} y={c + (r - 22) * Math.sin(a) + 4} textAnchor="middle"
            className="compass-l" fill={l === 'N' ? 'var(--wetdust)' : 'var(--muted)'}>{l}</text>
        );
      })}
      {heading != null && (
        <g style={{ transform: `rotate(${heading}deg)`, transformOrigin: `${c}px ${c}px`, transition: 'transform .8s ease' }}>
          <polygon points={`${c},${c - r + 14} ${c - 7},${c} ${c + 7},${c}`} fill="var(--accent)" />
          <polygon points={`${c},${c + r - 14} ${c - 7},${c} ${c + 7},${c}`} fill="var(--muted)" opacity={0.5} />
        </g>
      )}
      <circle cx={c} cy={c} r={4} fill="var(--text)" />
    </svg>
  );
}

export const CH_COLORS = ['#a78bfa', '#22d3ee', '#f472b6', '#a3e635'];

export function ChannelBars({ values, max = 3.3 }: { values: number[] | null; max?: number }) {
  const labels = ['0°', '45°', '90°', '135°'];
  return (
    <div className="bars" role="group" aria-label="Polarizer channel voltages">
      {labels.map((l, i) => {
        const v = values?.[i] ?? 0;
        return (
          <div className="bar" key={l}>
            <div className="bar-track">
              <div className="bar-fill" style={{ height: `${(v / max) * 100}%`, background: CH_COLORS[i] }} />
            </div>
            <div className="bar-v mono">{values ? v.toFixed(2) : '—'}<small> V</small></div>
            <div className="bar-l">I<sub>{l.replace('°', '')}</sub> <span className="muted">{l}</span></div>
          </div>
        );
      })}
    </div>
  );
}

export function Meter({ value, max = 100, color, label }: { value: number; max?: number; color: string; label: string }) {
  return (
    <div className="meter" role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
      <div className="meter-fill" style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: color }} />
    </div>
  );
}
