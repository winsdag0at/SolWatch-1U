# SolWatch-1U — Mission Control Dashboard

Ground-station dashboard for **SolWatch-1U**, a 1U CubeSat that detects dust and dew on UAE desert solar-panel glass and tells farm crews *when* and *how* to clean.
SatForge UAE 2026 · Team Najm Innovators, Amity University Dubai.

> **Phase 1: all data in Simulation mode is SIMULATED** and is labelled that way throughout the UI, in the packet log (`[SIM]`) and in CSV exports (`simulated` column).

## Run

```bash
npm install
npm run dev            # http://localhost:3000
npm run build          # static export → ./out
```

### Docker

```bash
docker compose up -d --build   # http://localhost:3000
```

`Dockerfile` is multi-stage: Node 20 builds the static export, then nginx serves `out/` (config in `nginx.conf`).

## Public link

The site is a static export (`output: 'export'`), so any static host works:

- **Vercel** — import the repo, no config needed.
- **Netlify** — build `npm run build`, publish `out`.
- **GitHub Pages** — build with `NEXT_PUBLIC_BASE_PATH=/<repo-name> npm run build` and publish `out/`.

A service worker caches the page after the first visit, so Simulation mode keeps working offline.

## Pages

| Tab | What it shows |
|---|---|
| **Operations** | Cleaning orders, payload, dew, health, orbit & link (real propagated passes, sky plot), packet log, simulation controls, Live mode |
| **Mission & budgets** | Objectives, success criteria, orbit trade study (60-day propagation), link / data / power / mass budgets, requirements traceability |
| **Lab validation** | Bench-test procedure and an editable/CSV table of readings; fits clean-glass DoLP and PV-loss-per-SI and applies them to the decision engine. Ships with clearly labelled EXAMPLE data |
| **Impact** | One-year model of fixed wet-wash schedule vs SolWatch-guided cleaning: water saved, energy and revenue recovered, trigger sensitivity, cited inputs |

Budget, bench and impact inputs are saved in the browser (localStorage).

## Structure

| Path | Purpose |
|---|---|
| `lib/physics.ts` | Stokes / DoLP / AoLP, Soiling Index, Magnus dew point, channel forward model, battery curve, Cementing Risk Index |
| `lib/ground.ts` | Packet validation and the 4-state cleaning decision (dead bands, 3-reading persistence, SI hold on wet glass) |
| `lib/sim.ts` | Simulator: diurnal weather, dust build-up and wind events, EPS/thermal model, LoRa store-and-forward limited by real pass time and airtime |
| `lib/orbit.ts` | Circular-orbit propagator (J2 node precession, Sun ephemeris, Earth shadow), look angles, pass prediction |
| `lib/link.ts` | LoRa link budget (SX1278 sensitivity), time-on-air |
| `lib/mission.ts` | Power, mass, data budgets and orbit trade analysis |
| `lib/calibration.ts` | Bench-data analysis: clean DoLP, loss-per-SI fit, detection limit, rotation invariance |
| `lib/impact.ts` | Annual cleaning-strategy model |
| `lib/live.ts` | Live connectors: Firebase RTDB stream, HTTP JSON poll, ThingSpeak feed |
| `components/` | Dashboard UI and the hand-built SVG charts (no chart library) |

## Live mode: data contract

The ground-station ESP32 appends each received LoRa packet to a cloud relay, and the dashboard reads from it. A static page cannot accept a POST, so the relay sits in between.

```json
{"type":"S","farm":"AlDhafra","t":"2026-11-01T06:30:00Z","i0":2.59,"i45":1.41,"i90":0.23,"i135":1.41,"heading":123,"batt":3.95,"solar":5.6,"temp":24.1,"current_mA":185}
{"type":"N","farm":"AlDhafra","t":"2026-11-01T02:10:00Z","air_t":19.5,"rh":88,"glass_t":16.0,"wet_plate":540}
```

Optional fields added by the ground station: `"rssi"` (dBm), `"snr"` (dB). Farm IDs: `AlDhafra`, `NoorAbuDhabi`, `MBRSolarPark`. Unknown IDs are accepted and appear as additional farms.

**Firebase (recommended):** the ESP32 `POST`s to `https://<project>-default-rtdb.firebaseio.com/solwatch/packets.json`. In the dashboard, choose *Live → Firebase* and enter `https://<project>-default-rtdb.firebaseio.com/solwatch/packets`. The database rules must allow public read on that path.

**HTTP JSON:** any URL that returns one packet, an array of packets, or a `{id: packet}` map.
**ThingSpeak:** put the packet JSON string in `field1` and use the channel `feeds.json` URL.

For testing, Live mode has a paste box, and the console exposes `solwatchIngest(packet)`.
