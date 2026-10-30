'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { GroundProcessor, STATE_INFO, type Packet } from '@/lib/ground';
import { FARMS, farmName } from '@/lib/farms';
import { SCENARIOS, Simulator } from '@/lib/sim';
import { DOLP_CLEAN, channelsFor, stokes, soilingIndex, dewPoint } from '@/lib/physics';
import { BUILT_IN_LIVE_URL, DEFAULT_LIVE, connectLive, extractPackets, type LiveConfig } from '@/lib/live';
import { ago, fmtClock, fmtDate, fmtTime, signed } from './format';
import { CH_COLORS } from './charts';
import { FlowDiagram } from './visuals';
import { Card, DewPanel, FarmCards, HealthPanel, OrbitPanel, PacketLog, PayloadPanel, type View } from './panels';
import { toCsv } from './csv';
import { MissionTab, useOrbitTrades } from './MissionTab';
import { LabTab, BENCH_DEFAULT, type BenchState } from './LabTab';
import { ImpactTab } from './ImpactTab';
import { useStored } from './ui';
import { DEFAULT_MISSION, powerBudget, type MissionCfg } from '@/lib/mission';
import { IMPACT_DEFAULTS, type ImpactInputs } from '@/lib/impact';
import { CAL } from '@/lib/physics';
import { DEFAULT_ORBIT, ORBIT_OPTIONS } from '@/lib/orbit';

type Tab = 'ops' | 'mission' | 'lab' | 'impact';
const TABS: { id: Tab; label: string }[] = [
  { id: 'ops', label: 'Operations' },
  { id: 'mission', label: 'Mission & budgets' },
  { id: 'lab', label: 'Lab validation' },
  { id: 'impact', label: 'Impact' },
];

type Mode = 'sim' | 'live';
type RangeKey = '1h' | '6h' | '24h' | 'all';
const RANGES: Record<RangeKey, number> = { '1h': 3_600_000, '6h': 6 * 3_600_000, '24h': 24 * 3_600_000, all: Infinity };
const FARM_IDS = FARMS.map((f) => f.id);
// Mission clock starts pre-dawn so dew build-up is visible straight away.
const SIM_START = Date.parse('2026-11-01T03:00:00+04:00');
const TICK_MS = 2500;

const SAMPLE_S = { type: 'S', farm: 'AlDhafra', t: '2026-11-01T06:30:00Z', i0: 2.59, i45: 1.41, i90: 0.23, i135: 1.41, heading: 123, batt: 3.95, solar: 5.6, temp: 24.1, current_mA: 185 };
const SAMPLE_N = { type: 'N', farm: 'AlDhafra', t: '2026-11-01T02:10:00Z', air_t: 19.5, rh: 88, glass_t: 16.0, wet_plate: 540 };

function loadLiveCfg(): LiveConfig {
  if (BUILT_IN_LIVE_URL) return DEFAULT_LIVE;
  try {
    const s = localStorage.getItem('solwatch.live');
    return s ? { ...DEFAULT_LIVE, ...JSON.parse(s) } : DEFAULT_LIVE;
  } catch {
    return DEFAULT_LIVE;
  }
}

function Logo() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden>
      <defs>
        <linearGradient id="lg" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stopColor="#38bdf8" /><stop offset="1" stopColor="#6366f1" /></linearGradient>
      </defs>
      <circle cx="31" cy="9" r="5" fill="#fbbf24" />
      <path d="M20 8 32 14v13l-12 6-12-6V14z" fill="url(#lg)" opacity=".9" />
      <path d="M20 8v25M8 14l12 6 12-6" stroke="#0b1220" strokeWidth="1.4" fill="none" />
      <path d="M3 18h5M32 18h5" stroke="#38bdf8" strokeWidth="2.5" />
    </svg>
  );
}

export default function Dashboard() {
  const [, render] = useReducer((x: number) => x + 1, 0);
  const simRef = useRef<{ ground: GroundProcessor; sim: Simulator } | null>(null);
  const liveRef = useRef<GroundProcessor>(new GroundProcessor(FARM_IDS));
  const [mode, setMode] = useState<Mode>('sim');
  const [playing, setPlaying] = useState(true);
  const [farmId, setFarmId] = useState(FARM_IDS[0]);
  const [rangeKey, setRangeKey] = useState<RangeKey>('24h');
  const [wall, setWall] = useState<number | null>(null);
  const [liveCfg, setLiveCfg] = useState<LiveConfig>(DEFAULT_LIVE);
  const [liveOn, setLiveOn] = useState(!!BUILT_IN_LIVE_URL); // auto-connect when the URL is baked in
  const [liveStatus, setLiveStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [paste, setPaste] = useState(JSON.stringify(SAMPLE_S));
  const [tab, setTabState] = useState<Tab>('ops');
  const [mission, setMission] = useStored<MissionCfg>('solwatch.mission', DEFAULT_MISSION);
  const [orbitSel, setOrbitSel] = useStored<{ id: string }>('solwatch.orbit', { id: DEFAULT_ORBIT.id });
  const [bench, setBench] = useStored<BenchState>('solwatch.bench', BENCH_DEFAULT);
  const [impact, setImpact] = useStored<ImpactInputs>('solwatch.impact', IMPACT_DEFAULTS);
  const [, setCalTick] = useState(0);

  const setTab = (t: Tab) => {
    setTabState(t);
    try { history.replaceState(null, '', t === 'ops' ? location.pathname : `#${t}`); } catch { /* ignore */ }
    window.scrollTo({ top: 0 });
  };
  useEffect(() => {
    const h = location.hash.slice(1) as Tab;
    if (TABS.some((t) => t.id === h)) setTabState(h);
    try {
      const c = JSON.parse(localStorage.getItem('solwatch.cal') ?? 'null');
      if (c) Object.assign(CAL, c);
    } catch { /* ignore */ }
  }, []);

  // init simulator with 24 h of history (client only — random data)
  useEffect(() => {
    const ground = new GroundProcessor(FARM_IDS);
    const sim = new Simulator(ground, SIM_START);
    sim.seed(24);
    simRef.current = { ground, sim };
    setLiveCfg(loadLiveCfg());
    setWall(Date.now());
    render();
  }, []);

  useEffect(() => {
    const id = setInterval(() => setWall(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (mode !== 'sim' || !playing) return;
    const id = setInterval(() => {
      simRef.current?.sim.tick();
      render();
    }, TICK_MS);
    return () => clearInterval(id);
  }, [mode, playing]);

  // keep the simulator's orbit, link and EPS model in sync with the Mission page
  useEffect(() => {
    const sim = simRef.current?.sim;
    if (!sim) return;
    const cfg = ORBIT_OPTIONS.find((o) => o.id === orbitSel.id) ?? DEFAULT_ORBIT;
    if (sim.orbitModel.cfg.id !== cfg.id) sim.setOrbit(cfg);
    sim.link = { ...mission.link };
    const pb = powerBudget(mission, sim.orbitModel.sunlitFraction(sim.t), 0);
    sim.power = { loadW: pb.loadW, txW: pb.txW, genSunlitW: pb.genSunlitW, battWh: pb.battWh, busV: mission.solar.busV };
    render();
  }, [mission, orbitSel, wall != null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live connection
  useEffect(() => {
    if (mode !== 'live' || !liveOn) return;
    const stop = connectLive(liveCfg, {
      onPackets: (pkts) => {
        pkts.forEach((p) => liveRef.current.ingest({ ...p, via: 'live' }, Date.now()));
        render();
      },
      onStatus: setLiveStatus,
    });
    return stop;
  }, [mode, liveOn, liveCfg]);

  // Console / ESP32-on-LAN test hook: window.solwatchIngest({...})
  useEffect(() => {
    (window as unknown as Record<string, unknown>).solwatchIngest = (body: unknown) => {
      const { pkts, errors } = extractPackets(body);
      pkts.forEach((p) => liveRef.current.ingest({ ...p, via: 'live' }, Date.now()));
      render();
      return { accepted: pkts.length, errors };
    };
  }, []);

  const s = simRef.current;
  const ground = mode === 'sim' ? s?.ground ?? null : liveRef.current;
  const sim = mode === 'sim' ? s?.sim ?? null : null;
  const now = mode === 'sim' ? sim?.t ?? SIM_START : wall ?? 0;

  // Sim objects are mutable, so the view is rebuilt on every render.
  let view: View | null = null;
  if (ground && wall != null) {
    let t0 = now - RANGES[rangeKey];
    if (!Number.isFinite(t0)) {
      const firsts = [...ground.farms.values()].flatMap((f) => [f.payload[0]?.t ?? now, f.dew[0]?.t ?? now]);
      t0 = Math.min(now, ...firsts);
      if (t0 >= now) t0 = now - 3_600_000;
    }
    view = { ground, sim, live: mode === 'live', now, range: [t0, now], farmId, orbit: sim ? sim.orbit() : null };
  }

  const exportCsv = useCallback(() => {
    if (!view) return;
    const csv = toCsv(view.ground, view.range, mode === 'sim');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `solwatch-1u_${mode}_${rangeKey}_${new Date(view.now).toISOString().slice(0, 16).replace(':', '')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [view, mode, rangeKey]);

  if (!view || !ground) {
    return <div className="boot"><Logo /><p>Initialising ground station…</p></div>;
  }

  // header status
  let status: { label: string; cls: string };
  if (sim) {
    const o = view.orbit!;
    status = o.inPass || sim.continuousLink ? { label: 'In pass', cls: 'ok' } : !o.sunlit ? { label: 'Eclipse', cls: 'ecl' } : { label: 'Out of contact', cls: 'off' };
  } else {
    const fresh = ground.lastRx != null && Date.now() - ground.lastRx < 90_000;
    const h = ground.health[ground.health.length - 1];
    status = fresh ? { label: 'In pass', cls: 'ok' } : h && h.solar < 0.3 ? { label: 'Eclipse', cls: 'ecl' } : { label: 'Out of contact', cls: 'off' };
  }

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <Logo />
          <div>
            <h1>SolWatch-1U <span>Mission Control</span></h1>
            <p>Polarimetric dust & dew intelligence for UAE desert solar farms</p>
          </div>
        </div>
        <div className="clocks" aria-live="off">
          <div><small>UTC</small><b className="mono">{fmtClock(wall!, 'UTC')}</b></div>
          <div><small>UAE (GST)</small><b className="mono">{fmtClock(wall!, 'Asia/Dubai')}</b></div>
          {sim && <div><small>Mission clock (sim)</small><b className="mono">{fmtTime(sim.t, true)}</b></div>}
        </div>
        <div className="status">
          <span className={`pill ${status.cls}`}><i />{status.label}</span>
          <small>
            Last packet:{' '}
            {ground.lastRx == null ? 'none' : sim ? `${fmtTime(ground.lastRx, true)} (${ago(sim.t - ground.lastRx).replace('0s ago', 'now')})` : ago(Date.now() - ground.lastRx)}
          </small>
        </div>
        <div className="mode" role="radiogroup" aria-label="Data mode">
          <button role="radio" aria-checked={mode === 'sim'} className={mode === 'sim' ? 'on' : ''} onClick={() => setMode('sim')}>Simulation</button>
          <button role="radio" aria-checked={mode === 'live'} className={mode === 'live' ? 'on' : ''} onClick={() => setMode('live')}>Live</button>
        </div>
      </header>

      <nav className="tabs" aria-label="Dashboard sections">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </nav>

      {tab === 'mission' && <MissionTab cfg={mission} setCfg={setMission} orbitId={orbitSel.id} setOrbitId={(id) => setOrbitSel({ id })} />}
      {tab === 'lab' && (
        <LabTab bench={bench} setBench={setBench} onApply={(dolpClean, k, source) => {
          Object.assign(CAL, { dolpClean, lossPerSI: k, source });
          try { localStorage.setItem('solwatch.cal', JSON.stringify(CAL)); } catch { /* ignore */ }
          setCalTick((x) => x + 1);
        }} />
      )}
      {tab === 'impact' && <ImpactWithOrbit mission={mission} orbitId={orbitSel.id} inputs={impact} setInputs={setImpact} />}

      {tab === 'ops' && <>
      {mode === 'sim' ? (
        <div className="banner sim" role="note">
          <b>SIMULATED DATA — Phase 1.</b> Every reading on this page is generated by an on-page physics model of SolWatch-1U, the dew nodes and the LoRa link. No flight hardware data is shown.
        </div>
      ) : (
        <div className="banner live" role="note">
          <b>LIVE MODE.</b> Showing only packets received from the ground station. {liveOn ? liveStatus?.msg : 'Not connected — configure the source below.'}
        </div>
      )}

      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Solar farm">
          {FARMS.map((f) => (
            <button key={f.id} role="tab" aria-selected={farmId === f.id} className={farmId === f.id ? 'on' : ''} onClick={() => setFarmId(f.id)}>
              <span className="dot" style={{ background: STATE_INFO[ground.farm(f.id).state].color }} />{f.short}
            </button>
          ))}
        </div>
        <div className="seg" role="tablist" aria-label="Chart time range">
          {(Object.keys(RANGES) as RangeKey[]).map((k) => (
            <button key={k} role="tab" aria-selected={rangeKey === k} className={rangeKey === k ? 'on' : ''} onClick={() => setRangeKey(k)}>{k === 'all' ? 'All' : k}</button>
          ))}
        </div>
        <button className="btn" onClick={exportCsv}>⬇ Export CSV</button>
      </div>

      <h2 className="section-h">Cleaning orders <small>{fmtDate(view.now)}</small></h2>
      <FarmCards v={view} onSelect={setFarmId} />

      {sim && <SimControls sim={sim} farmId={farmId} playing={playing} setPlaying={setPlaying} onChange={render} />}
      {mode === 'live' && (
        <LiveSetup cfg={liveCfg} on={liveOn} status={liveStatus} paste={paste} setPaste={setPaste}
          setCfg={(c) => { setLiveCfg(c); try { localStorage.setItem('solwatch.live', JSON.stringify(c)); } catch { /* ignore */ } }}
          setOn={setLiveOn}
          ingest={(body) => {
            const { pkts, errors } = extractPackets(body);
            pkts.forEach((p) => liveRef.current.ingest({ ...p, via: 'live' }, Date.now()));
            setLiveStatus(errors.length ? { ok: false, msg: errors.join('; ') } : { ok: true, msg: `Ingested ${pkts.length} packet(s)` });
            render();
          }} />
      )}

      <h2 className="section-h">Telemetry · {farmName(farmId)}</h2>
      <div className="grid">
        <PayloadPanel v={view} />
        <DewPanel v={view} />
        <HealthPanel v={view} />
        <OrbitPanel v={view} />
        <PacketLog v={view} />
      </div>

      <HowItConnects />
      </>}

      <footer className="foot">
        SolWatch-1U | Team Najm Innovators, Amity University Dubai | SatForge UAE 2026
        <small>SatForge UAE 2026 · Abu Dhabi University · UAE Space Agency · National Space Academy · SpacePoint · IEEE ADU</small>
      </footer>
    </div>
  );
}

function ImpactWithOrbit({ mission, orbitId, inputs, setInputs }: {
  mission: MissionCfg; orbitId: string; inputs: ImpactInputs; setInputs: (i: ImpactInputs) => void;
}) {
  const trades = useOrbitTrades(mission.link);
  const t = trades.find((x) => x.cfg.id === orbitId) ?? trades[0];
  return <ImpactTab inputs={inputs} setInputs={setInputs} predawnPct={Math.min(100, (100 * t.predawnPerWeek) / 7)} orbitLabel={t.cfg.label} />;
}

// ---- Simulation controls ---------------------------------------------------

function Slider({ label, value, min, max, step, unit, onChange, fmt = (v) => v.toFixed(1), id }: {
  label: string; value: number; min: number; max: number; step: number; unit?: string;
  onChange: (v: number) => void; fmt?: (v: number) => string; id: string;
}) {
  return (
    <div className="slider">
      <label htmlFor={id}>{label}<b className="mono">{fmt(value)}{unit}</b></label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function SimControls({ sim, farmId, playing, setPlaying, onChange }: {
  sim: Simulator; farmId: string; playing: boolean; setPlaying: (b: boolean) => void; onChange: () => void;
}) {
  const f = sim.farm(farmId);
  const set = (fn: () => void) => { fn(); onChange(); };
  const manual = (k: 'air' | 'rh' | 'glass') => (v: number) => set(() => { f.autoWeather = false; f[k] = v; });
  // Rotation-invariance demo: forward model at the current dust level
  const ch = channelsFor(2.82, DOLP_CLEAN * (1 - f.dust), sim.rotation);
  const st = stokes(...ch);
  const td = dewPoint(f.air, f.rh);

  return (
    <Card id="simctl" title="Simulation control" sub={`Sliders act on ${farmName(farmId)} and the satellite. A new packet set is generated every ${TICK_MS / 1000} s.`}
      right={<span className="tag sim">SIMULATED</span>} className="simctl">
      <div className="sim-row">
        <button className="btn primary" onClick={() => setPlaying(!playing)}>{playing ? '❚❚ Pause' : '▶ Auto-play'}</button>
        <button className="btn" onClick={() => set(() => sim.tick())}>Step +{sim.stepMin} min</button>
        <label className="check">
          Sim step
          <select value={sim.stepMin} onChange={(e) => set(() => { sim.stepMin = Number(e.target.value); })}>
            <option value={1}>1 min</option><option value={5}>5 min</option><option value={15}>15 min</option>
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={sim.continuousLink} onChange={(e) => set(() => { sim.continuousLink = e.target.checked; })} /> Continuous link (demo)</label>
        <label className="check"><input type="checkbox" checked={sim.autoCrew} onChange={(e) => set(() => { sim.autoCrew = e.target.checked; })} /> Crew follows orders</label>
        <label className="check"><input type="checkbox" checked={f.autoWeather} onChange={(e) => set(() => { f.autoWeather = e.target.checked; })} /> Auto weather (day/night)</label>
      </div>
      <div className="scen">
        <span className="muted">Load scenario for {FARMS.find((x) => x.id === farmId)?.short}:</span>
        {(Object.keys(SCENARIOS) as (keyof typeof SCENARIOS)[]).map((k) => (
          <button key={k} className="btn scen-b" style={{ ['--st' as string]: STATE_INFO[k].color }} onClick={() => set(() => sim.loadScenario(farmId, SCENARIOS[k]))}>
            {{ CLEAN: 'Clean', DRY_DUST: 'Dry dust', DEW_ONLY: 'Dew only', WET_DUST: 'Wet dust' }[k]}
          </button>
        ))}
      </div>
      <div className="sim-grid">
        <div className="sliders">
          <Slider id="s-dust" label="Dust level" value={f.dust} min={0} max={1} step={0.01} fmt={(v) => v.toFixed(2)} onChange={(v) => set(() => { f.dust = v; })} />
          <Slider id="s-rot" label="Satellite rotation" value={sim.rotation} min={0} max={180} step={1} unit="°" fmt={(v) => v.toFixed(0)} onChange={(v) => set(() => { sim.rotation = v; })} />
          <Slider id="s-air" label="Air temp" value={f.air} min={-10} max={60} step={0.5} unit=" °C" onChange={manual('air')} />
          <Slider id="s-rh" label="Humidity" value={f.rh} min={0} max={100} step={1} unit=" %" fmt={(v) => v.toFixed(0)} onChange={manual('rh')} />
          <Slider id="s-glass" label="Glass temp" value={f.glass} min={-10} max={60} step={0.5} unit=" °C" onChange={manual('glass')} />
          <Slider id="s-batt" label="Battery voltage" value={sim.battV} min={3.0} max={4.2} step={0.01} unit=" V" fmt={(v) => v.toFixed(2)} onChange={(v) => set(() => { sim.battV = v; })} />
          <p className="note">Dew point {td.toFixed(1)} °C → margin {signed(f.glass - td)} °C. Moving a weather slider switches that farm to manual weather.</p>
        </div>
        <div className="invariance" aria-live="polite">
          <h3>Rotation invariance check</h3>
          <p className="muted small">Clean-sun forward model at dust {f.dust.toFixed(2)}, rotation {sim.rotation.toFixed(0)}°. Drag rotation: raw channels change, DoLP & SI do not.</p>
          <div className="inv-ch">
            {ch.map((v, i) => (
              <div key={i} style={{ ['--c' as string]: CH_COLORS[i] }}>
                <small>I{[0, 45, 90, 135][i]}</small><b className="mono">{v.toFixed(2)} V</b>
                <span className="inv-bar"><i style={{ width: `${(v / 3.3) * 100}%` }} /></span>
              </div>
            ))}
          </div>
          <div className="inv-out">
            <div><small>DoLP</small><b className="mono">{st.dolp.toFixed(3)}</b></div>
            <div><small>AoLP</small><b className="mono">{st.aolp.toFixed(1)}°</b></div>
            <div><small>SI</small><b className="mono">{soilingIndex(st.dolp).toFixed(3)}</b></div>
          </div>
          <p className="muted small">
            Check: 2.59 / 1.41 / 0.23 / 1.41 V → DoLP {stokes(2.59, 1.41, 0.23, 1.41).dolp.toFixed(2)}, SI {soilingIndex(stokes(2.59, 1.41, 0.23, 1.41).dolp).toFixed(2)} ·
            1.83 / 1.41 / 0.99 / 1.41 V → DoLP {stokes(1.83, 1.41, 0.99, 1.41).dolp.toFixed(2)}, SI {soilingIndex(stokes(1.83, 1.41, 0.99, 1.41).dolp).toFixed(2)}
          </p>
        </div>
      </div>
    </Card>
  );
}

// ---- Live setup ------------------------------------------------------------

function LiveSetup({ cfg, setCfg, on, setOn, status, paste, setPaste, ingest }: {
  cfg: LiveConfig; setCfg: (c: LiveConfig) => void; on: boolean; setOn: (b: boolean) => void;
  status: { ok: boolean; msg: string } | null; paste: string; setPaste: (s: string) => void; ingest: (b: unknown) => void;
}) {
  const [draft, setDraft] = useState(cfg);
  useEffect(() => setDraft(cfg), [cfg]);
  return (
    <Card id="live" title="Live data source" sub="The ground-station ESP32 writes each packet to a cloud relay; this page reads it." right={<span className="tag live">LIVE</span>}>
      <div className="live-grid">
        <div className="form">
          <label>Source
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as LiveConfig['kind'] })}>
              <option value="firebase">Firebase Realtime Database (stream)</option>
              <option value="http">HTTP JSON endpoint (poll)</option>
              <option value="thingspeak">ThingSpeak channel feed (poll, JSON in field1)</option>
            </select>
          </label>
          <label>URL
            <input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} spellCheck={false}
              placeholder={draft.kind === 'thingspeak' ? 'https://api.thingspeak.com/channels/ID/feeds.json?results=50' : 'https://…'} />
          </label>
          {draft.kind !== 'firebase' && (
            <label>Poll every (s)
              <input type="number" min={1} value={draft.pollSec} onChange={(e) => setDraft({ ...draft, pollSec: Number(e.target.value) })} />
            </label>
          )}
          <div className="row gap">
            <button className="btn primary" onClick={() => { setCfg(draft); setOn(true); }}>{on ? 'Reconnect' : 'Connect'}</button>
            {on && <button className="btn" onClick={() => setOn(false)}>Disconnect</button>}
          </div>
          {status && <p className={`note ${status.ok ? 'ok' : 'err'}`}>{status.msg}</p>}
        </div>
        <div className="form">
          <label>Test: paste a packet (or array) and ingest
            <textarea rows={5} value={paste} onChange={(e) => setPaste(e.target.value)} spellCheck={false} className="mono" />
          </label>
          <div className="row gap">
            <button className="btn" onClick={() => { try { ingest(JSON.parse(paste)); } catch { ingest('not json'); } }}>Ingest</button>
            <button className="btn" onClick={() => ingest([SAMPLE_N, SAMPLE_S])}>Load example packets</button>
          </div>
          <p className="muted small">From the browser console you can also call <code>solwatchIngest({'{…}'})</code>.</p>
        </div>
      </div>
    </Card>
  );
}

// ---- How it connects ------------------------------------------------------------

const ESP32_SNIPPET = `// Ground station ESP32: forward each LoRa packet to Firebase RTDB
#include <WiFi.h>
#include <HTTPClient.h>
#include <LoRa.h>

const char* DB = "https://YOUR-PROJECT-default-rtdb.firebaseio.com/solwatch/packets.json";

void loop() {
  if (LoRa.parsePacket()) {
    String json = LoRa.readString();           // {"type":"S",...}
    json.remove(json.length() - 1);            // drop closing brace
    json += ",\\"rssi\\":" + String(LoRa.packetRssi())
          + ",\\"snr\\":"  + String(LoRa.packetSnr()) + "}";
    HTTPClient http;
    http.begin(DB);
    http.addHeader("Content-Type", "application/json");
    http.POST(json);                            // POST = append with push-ID
    http.end();
  }
}`;

function HowItConnects() {
  return (
    <section className="card span3 how" id="how" aria-labelledby="how-h">
      <header className="card-h"><div><h2 id="how-h">How it connects</h2><p className="card-sub">Sensors → ESP32 → LoRa → ground station → Wi-Fi → dashboard</p></div></header>
      <FlowDiagram />
      <ol className="steps">
        <li><b>Day — payload.</b> Four TEMT6000 sensors behind 0/45/90/135° polarizers measure sunlight reflected off panel glass; the ADS1115 digitises them (0–3.3 V, 4.7 kΩ load). Clean glass reflects strongly polarized light (DoLP ≈ 0.84); dust scatters it and destroys polarization.</li>
        <li><b>Night — dew nodes.</b> Farm nodes measure air temperature, RH, glass temperature and a wet-plate sensor and uplink over LoRa 433 MHz. The satellite stores them.</li>
        <li><b>Pass — downlink.</b> During each ground-station pass the ESP32 on-board computer downlinks “S” packets and relays stored “N” packets through the SX1278.</li>
        <li><b>Ground — decision.</b> The ground station computes Stokes parameters, Soiling Index and dew margin, applies dead bands and 3-reading persistence, and publishes the cleaning order over Wi-Fi.</li>
      </ol>
      <div className="formulas">
        <div><h3>Formulas</h3>
          <pre className="mono">{`S0 = (I0 + I45 + I90 + I135) / 2
S1 = I0 − I90      S2 = I45 − I135
DoLP = √(S1² + S2²) / S0
AoLP = ½·atan2(S2, S1)
SI   = clamp(1 − DoLP / 0.84, 0, 1)
γ  = ln(RH/100) + b·T/(c+T)   b=17.62, c=243.12 °C
Td = c·γ / (b − γ)
margin = T_glass − Td`}</pre>
        </div>
        <div><h3>Decision rules</h3>
          <pre className="mono">{`Dusty: SI > 0.30  (clears < 0.20)
Wet:   wet-plate > 500 OR margin < 0 °C
       (dry: wet-plate < 380 AND margin > 1 °C)
Each flag flips after 3 consecutive readings.
Wet glass → hold last dry-glass SI.

CLEAN     → No action
DRY DUST  → Dry brush / robotic clean now
DEW ONLY  → No action, do not dry-brush
WET DUST  → URGENT: clean before sunrise`}</pre>
        </div>
      </div>
      <div className="formulas">
        <div><h3>Packet format (JSON)</h3>
          <pre className="mono">{`// Day / housekeeping packet
${JSON.stringify(SAMPLE_S)}
// Night dew-node packet (relayed)
${JSON.stringify(SAMPLE_N)}
// Optional, added by ground station:
"rssi": -98, "snr": 7.5`}</pre>
          <p className="muted small">Units: channels V · heading ° · batt/solar V · temp °C · current mA · rh % · wet_plate raw ADC. <code>t</code> is the sample time in ISO-8601 UTC.</p>
        </div>
        <div><h3>Ground station → Firebase (ESP32)</h3>
          <pre className="mono">{ESP32_SNIPPET}</pre>
        </div>
      </div>
    </section>
  );
}
