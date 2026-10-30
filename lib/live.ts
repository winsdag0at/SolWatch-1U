// Live mode: pull ground-station packets from a cloud relay. The ground
// station ESP32 writes each received LoRa packet (as JSON) to one of these;
// the dashboard is a static page, so it reads rather than receives POSTs.

import { Packet, validatePacket } from './ground';

export type LiveKind = 'firebase' | 'http' | 'thingspeak';

export interface LiveConfig {
  kind: LiveKind;
  url: string;
  pollSec: number;
}

export const DEFAULT_LIVE: LiveConfig = {
  kind: 'firebase',
  url: 'https://YOUR-PROJECT-default-rtdb.firebaseio.com/solwatch/packets',
  pollSec: 3,
};

export interface LiveHandlers {
  onPackets: (pkts: Packet[]) => void;
  onStatus: (s: { ok: boolean; msg: string }) => void;
}

/** Accepts a packet, an array of packets, a Firebase push-ID map, or a ThingSpeak feed. */
export function extractPackets(body: unknown): { pkts: Packet[]; errors: string[] } {
  const pkts: Packet[] = [];
  const errors: string[] = [];
  const visit = (v: unknown) => {
    if (v == null) return;
    if (typeof v === 'string') {
      try { visit(JSON.parse(v)); } catch { errors.push('unparseable string field'); }
      return;
    }
    if (Array.isArray(v)) return v.forEach(visit);
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (Array.isArray(o.feeds)) return o.feeds.forEach((f: Record<string, unknown>) => visit(f.field1));
      if ('type' in o) {
        try { pkts.push(validatePacket(o)); } catch (e) { errors.push((e as Error).message); }
        return;
      }
      Object.values(o).forEach(visit); // Firebase {pushId: packet}
    }
  };
  visit(body);
  return { pkts, errors };
}

const key = (p: Packet) => `${p.type}|${p.farm}|${p.t}`;

export function connectLive(cfg: LiveConfig, h: LiveHandlers): () => void {
  const seen = new Set<string>();
  const deliver = (body: unknown) => {
    const { pkts, errors } = extractPackets(body);
    const fresh = pkts.filter((p) => !seen.has(key(p)));
    fresh.forEach((p) => seen.add(key(p)));
    fresh.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    if (fresh.length) h.onPackets(fresh);
    if (errors.length) h.onStatus({ ok: false, msg: `Rejected ${errors.length} packet(s): ${errors[0]}` });
    else if (fresh.length) h.onStatus({ ok: true, msg: `Received ${fresh.length} packet(s)` });
  };

  const base = cfg.url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) {
    h.onStatus({ ok: false, msg: 'Enter an http(s) URL' });
    return () => {};
  }

  if (cfg.kind === 'firebase' && typeof EventSource !== 'undefined') {
    // Firebase RTDB REST streaming (Server-Sent Events)
    const url = base.endsWith('.json') ? base : `${base}.json`;
    const es = new EventSource(url);
    h.onStatus({ ok: true, msg: `Connecting to ${url} …` });
    const onData = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(ev.data) as { path: string; data: unknown };
        deliver(msg.data);
      } catch {
        h.onStatus({ ok: false, msg: 'Bad stream event' });
      }
    };
    es.addEventListener('put', onData as EventListener);
    es.addEventListener('patch', onData as EventListener);
    es.onopen = () => h.onStatus({ ok: true, msg: 'Stream open — waiting for packets' });
    es.onerror = () => h.onStatus({ ok: false, msg: 'Stream error (check URL / database rules) — retrying' });
    return () => es.close();
  }

  // HTTP JSON / ThingSpeak polling
  let stopped = false;
  const poll = async () => {
    try {
      const res = await fetch(base, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      deliver(await res.json());
    } catch (e) {
      h.onStatus({ ok: false, msg: `Poll failed: ${(e as Error).message}` });
    }
  };
  poll();
  h.onStatus({ ok: true, msg: `Polling every ${cfg.pollSec}s` });
  const id = setInterval(() => !stopped && poll(), Math.max(1, cfg.pollSec) * 1000);
  return () => {
    stopped = true;
    clearInterval(id);
  };
}
