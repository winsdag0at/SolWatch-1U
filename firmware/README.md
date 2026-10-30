# SolWatch-1U firmware

Three ESP32 programs in one PlatformIO project:

| Program | Board | Does |
|---|---|---|
| `satellite` | CubeSat OBC (ESP32 + SX1278 + sensors) | Samples the 4-channel polarimeter and housekeeping every 10 s, stores dew-node uplinks, downlinks the store oldest-first over LoRa during a (simulated) pass |
| `groundstation` | ESP32 + SX1278 on Wi-Fi | Receives packets, timestamps them via NTP, adds RSSI/SNR, publishes JSON to Firebase |
| `dewnode` *(optional)* | ESP32 + SX1278 + DHT22 + DS18B20 + wet plate | Uplinks night dew readings to the satellite |

```
sensors → satellite ESP32 ──LoRa 433 MHz──▶ ground-station ESP32 ──Wi-Fi──▶ Firebase ──▶ dashboard (Live)
dew node ──LoRa──▶ satellite (stored) ──relayed at pass──▶ ground station
```

On air the packets are binary (26 bytes for S, 16 for N, defined in `include/solwatch_packet.h`), which keeps LoRa airtime short. The ground station converts them to the dashboard's JSON format.

## 1. Wiring

All boards: SX1278 (Ra-02) on VSPI. Pin numbers are set in `include/config.h`.

| SX1278 | ESP32 |
|---|---|
| SCK | 18 |
| MISO | 19 |
| MOSI | 23 |
| NSS | 5 |
| RST | 14 |
| DIO0 | 26 |
| 3.3V / GND | 3.3V / GND |

**Always attach the 433 MHz antenna before powering an SX1278.** Transmitting without one can damage the module.

**Satellite**

| Part | Connection |
|---|---|
| ADS1115 | I²C SDA 21, SCL 22, addr 0x48; A0..A3 ← TEMT6000 SIG behind 0°/45°/90°/135° polarizers |
| TEMT6000 × 4 | VCC 3.3 V, GND, SIG → ADS1115 A0..A3 |
| QMC5883L | I²C (0x0D) |
| INA219 | I²C (0x40); VIN+ ← battery +, VIN− → regulator input (measures battery voltage and system current) |
| DS18B20 | data → GPIO 4 with a 4.7 kΩ pull-up to 3.3 V |
| Solar panel | through a 2:1 resistor divider (e.g. 100 k / 100 k) → GPIO 35 |

**Dew node:** DHT22 → GPIO 27, DS18B20 taped to the glass → GPIO 4 (4.7 kΩ pull-up), wet-plate (rain-sensor) analog out → GPIO 34.

## 2. Firebase (once, ~10 minutes)

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and click **Add project**. Analytics is not needed.
2. **Build → Realtime Database → Create database.** Pick a location and start in **locked mode**.
3. **Build → Authentication → Get started → Email/Password → Enable.** Then **Users → Add user** for the ground station, e.g. `groundstation@yourteam.ae` with a long password. Copy the user's **UID**.
4. **Realtime Database → Rules:** paste the contents of [`database.rules.json`](database.rules.json), replace `REPLACE_WITH_GROUND_STATION_UID` with the UID, and click **Publish**. The rules give:
   - public read, so the dashboard and judges can see the data;
   - writes only from the ground-station account;
   - no editing or deleting existing packets;
   - a basic shape check on each packet.
5. **Project settings → General:** copy the **Web API key**. Copy the database URL from the Realtime Database page, e.g. `https://solwatch-1u-default-rtdb.firebaseio.com`.
6. Copy `include/secrets.example.h` to `include/secrets.h` and fill in Wi-Fi, API key, DB URL, email and password. `secrets.h` is git-ignored, so never commit it.

## 3. Flash

With [PlatformIO](https://platformio.org) (VS Code extension, or `pip install platformio`):

```bash
cd firmware
pio run -e groundstation -t upload && pio device monitor
pio run -e satellite -t upload && pio device monitor
pio run -e dewnode -t upload          # optional
```

**Arduino IDE instead:**
1. Install the libraries listed in `platformio.ini` from Library Manager.
2. Create a sketch per program and paste the matching `src/<program>/main.cpp` into the `.ino`.
3. Copy the `include/*.h` files (including your `secrets.h`) into the same sketch folder.
4. Board: *ESP32 Dev Module*.

## 4. Connect the dashboard

- **Quick test:** open the dashboard, switch to **Live**, choose *Firebase Realtime Database*, paste `<DB URL>/solwatch/packets` and click **Connect**.
- **For everyone (judges):** in Vercel → *Project → Settings → Environment Variables*, add `NEXT_PUBLIC_LIVE_URL` = `<DB URL>/solwatch/packets` and redeploy. Live mode then connects automatically for every visitor. Simulation stays the default view, and data is labelled LIVE vs SIMULATED.

## 5. What you should see

Ground-station serial monitor:

```
[firebase] signed in as groundstation@yourteam.ae (uid …)
[rx] {"type":"S","farm":"AlDhafra","t":"2026-11-03T08:14:05Z","seq":42,"i0":2.581,...,"rssi":-61,"snr":9.8}
[status] wifi up, rx 42, published 42, pending 0, rejected 0, dropped 0
```

Satellite: with `PASS_DEMO 1` it only transmits for 40 s of every 120 s. You'll see `[pass] AOS — 9 packets queued`, then a burst of stored packets arriving on the dashboard, which demonstrates store-and-forward. Set `PASS_DEMO 0` for continuous downlink.

**No LoRa modules on the day?** Set `DIRECT_WIFI 1` in `config.h` and flash the satellite with `secrets.h`. It then posts straight to Firebase over Wi-Fi.

## Notes and limits

- **Payload geometry:** point the payload at sunlight reflected from a glass sample at ~56° incidence (Brewster angle). Calibrate on the dashboard's *Lab validation* page.
- **Wet-plate scale:** most rain sensors read high when dry. `WET_PLATE_DRY_HIGH` inverts the reading so wetter means a larger value, on a 0–1023 scale. Check the 500 / 380 dashboard thresholds against your sensor wet and dry.
- **Compass:** calibrate the QMC5883L (library `calibrate` example) and set your offsets.
- **Packet times:** the satellite has no clock. Each packet carries its age in seconds, and the ground station stamps it with `t = receive time − age`.
- **TLS:** `firebase_rest.h` uses TLS without certificate checking, which is fine for a lab demo. Pin the Google Trust Services root CA before using it on an untrusted network.
- **Radio rules:** 433 MHz with low power is fine on the bench. A flight mission would coordinate an amateur-satellite frequency with IARU and TDRA.
