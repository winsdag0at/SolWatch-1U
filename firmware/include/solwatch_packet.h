#pragma once
// SolWatch-1U on-air packet format (binary, little-endian) and the JSON the
// ground station publishes for the dashboard. Binary packing keeps LoRa
// airtime short: 26 bytes for S, 16 for N, instead of ~170 bytes of JSON.

#include <Arduino.h>
#include <time.h>

static const char *const FARM_IDS[] = {"AlDhafra", "NoorAbuDhabi", "MBRSolarPark"};
static const uint8_t FARM_COUNT = sizeof(FARM_IDS) / sizeof(FARM_IDS[0]);

enum : uint8_t {
  PKT_S = 'S',        // satellite payload + housekeeping, downlink
  PKT_N = 'N',        // dew-node reading relayed by the satellite, downlink
  PKT_N_UPLINK = 'n', // dew node → satellite (ignored by the ground station)
};

struct __attribute__((packed)) SPacketBin {
  uint8_t type;        // 'S'
  uint8_t farm;        // index into FARM_IDS
  uint16_t seq;
  uint32_t age_s;      // seconds between sampling and transmission
  uint16_t ch_mV[4];   // polarizer channels 0/45/90/135°
  uint16_t heading_d10;// heading × 10 (0..3599)
  uint16_t batt_mV;
  uint16_t solar_mV;
  int16_t temp_c100;   // internal temperature × 100
  int16_t current_mA;
};

struct __attribute__((packed)) NPacketBin {
  uint8_t type;        // 'N' (relayed) or 'n' (uplink)
  uint8_t farm;
  uint16_t seq;
  uint32_t age_s;
  int16_t air_c100;
  uint16_t rh_d10;
  int16_t glass_c100;
  uint16_t wet_plate;
};

static_assert(sizeof(SPacketBin) == 26, "S packet must be 26 bytes");
static_assert(sizeof(NPacketBin) == 16, "N packet must be 16 bytes");

static const size_t MAX_PACKET = sizeof(SPacketBin);

inline uint16_t clampU16(float v) { return v < 0 ? 0 : v > 65535 ? 65535 : (uint16_t)lroundf(v); }
inline int16_t clampI16(float v) { return v < -32768 ? -32768 : v > 32767 ? 32767 : (int16_t)lroundf(v); }

/** UTC epoch seconds → "2026-11-01T06:30:00Z". */
inline void isoTime(time_t t, char *out, size_t n) {
  struct tm tmv;
  gmtime_r(&t, &tmv);
  strftime(out, n, "%Y-%m-%dT%H:%M:%SZ", &tmv);
}

/**
 * Decode a downlinked packet into the dashboard JSON contract.
 * `rxEpoch` is the UTC receive time; the sample time is rxEpoch − age_s.
 * Returns the JSON length, or 0 if the packet is not a valid S/N downlink.
 */
inline size_t packetToJson(const uint8_t *buf, size_t len, time_t rxEpoch, bool withLink, int rssi, float snr,
                           char *out, size_t outLen) {
  if (len < 1) return 0;
  char t[24];
  char link[40] = "";
  if (withLink) snprintf(link, sizeof(link), ",\"rssi\":%d,\"snr\":%.1f", rssi, snr);

  if (buf[0] == PKT_S && len == sizeof(SPacketBin)) {
    SPacketBin p;
    memcpy(&p, buf, sizeof(p));
    if (p.farm >= FARM_COUNT) return 0;
    isoTime(rxEpoch - (time_t)p.age_s, t, sizeof(t));
    int n = snprintf(out, outLen,
      "{\"type\":\"S\",\"farm\":\"%s\",\"t\":\"%s\",\"seq\":%u,"
      "\"i0\":%.3f,\"i45\":%.3f,\"i90\":%.3f,\"i135\":%.3f,"
      "\"heading\":%.1f,\"batt\":%.3f,\"solar\":%.2f,\"temp\":%.2f,\"current_mA\":%d%s}",
      FARM_IDS[p.farm], t, p.seq,
      p.ch_mV[0] / 1000.0, p.ch_mV[1] / 1000.0, p.ch_mV[2] / 1000.0, p.ch_mV[3] / 1000.0,
      p.heading_d10 / 10.0, p.batt_mV / 1000.0, p.solar_mV / 1000.0, p.temp_c100 / 100.0, p.current_mA, link);
    return n > 0 && (size_t)n < outLen ? n : 0;
  }
  if (buf[0] == PKT_N && len == sizeof(NPacketBin)) {
    NPacketBin p;
    memcpy(&p, buf, sizeof(p));
    if (p.farm >= FARM_COUNT) return 0;
    isoTime(rxEpoch - (time_t)p.age_s, t, sizeof(t));
    int n = snprintf(out, outLen,
      "{\"type\":\"N\",\"farm\":\"%s\",\"t\":\"%s\",\"seq\":%u,"
      "\"air_t\":%.2f,\"rh\":%.1f,\"glass_t\":%.2f,\"wet_plate\":%u%s}",
      FARM_IDS[p.farm], t, p.seq, p.air_c100 / 100.0, p.rh_d10 / 10.0, p.glass_c100 / 100.0, p.wet_plate, link);
    return n > 0 && (size_t)n < outLen ? n : 0;
  }
  return 0;
}
