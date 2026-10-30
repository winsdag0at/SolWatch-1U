// SolWatch-1U ground station (ESP32 + SX1278).
// Receives downlinked packets, timestamps them from NTP, adds RSSI/SNR and
// publishes JSON to Firebase for the dashboard. Packets are buffered while
// Wi-Fi or Firebase is unavailable.

#include <Arduino.h>
#include "config.h"
#include "solwatch_packet.h"
#include "lora_link.h"
#include "firebase_rest.h"

FirebaseRest firebase;

// ---- outbound JSON buffer ---------------------------------------------------------
static const uint8_t OUT_LEN = 60;
char outbox[OUT_LEN][360];
uint8_t outHead = 0;
uint8_t outCount = 0;
uint32_t received = 0, published = 0, rejected = 0, outDropped = 0;

void push(const char *json) {
  if (outCount == OUT_LEN) {
    outHead = (outHead + 1) % OUT_LEN;
    outCount--;
    outDropped++;
  }
  strncpy(outbox[(outHead + outCount) % OUT_LEN], json, sizeof(outbox[0]) - 1);
  outCount++;
}

// Recent (type, farm, seq) to drop duplicates if a packet is heard twice.
uint32_t recent[32];
uint8_t recentIdx = 0;
bool seen(const uint8_t *buf) {
  uint32_t key = ((uint32_t)buf[0] << 24) | ((uint32_t)buf[1] << 16) | (buf[2] | (buf[3] << 8));
  for (uint32_t k : recent) if (k == key) return true;
  recent[recentIdx++ % 32] = key;
  return false;
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println(F("\nSolWatch-1U ground station"));
  if (!loraBegin()) {
    Serial.println(F("SX1278 not found — check wiring"));
    while (true) delay(1000);
  }
  firebase.begin();
  Serial.print(F("Waiting for Wi-Fi + NTP"));
  for (int i = 0; i < 60 && !(firebase.wifiUp() && firebase.timeValid()); i++) {
    Serial.print('.');
    delay(500);
  }
  Serial.println(firebase.timeValid() ? F(" ok") : F(" not yet (will keep trying)"));
}

void loop() {
  firebase.loop();

  uint8_t buf[MAX_PACKET + 4];
  size_t n = loraReceive(buf, sizeof(buf));
  if (n) {
    if (buf[0] == PKT_N_UPLINK) {
      // dew node talking to the satellite — not for us
    } else if (!firebase.timeValid()) {
      Serial.println(F("[rx] packet dropped: no UTC time yet"));
    } else if (!seen(buf)) {
      char json[360];
      if (packetToJson(buf, n, firebase.now(), true, LoRa.packetRssi(), LoRa.packetSnr(), json, sizeof(json))) {
        received++;
        Serial.printf("[rx] %s\n", json);
        push(json);
      } else {
        rejected++;
        Serial.printf("[rx] rejected %u-byte packet type 0x%02X\n", (unsigned)n, buf[0]);
      }
    }
  }

  // publish one buffered packet per loop so reception isn't blocked for long
  static uint32_t lastPost = 0;
  if (outCount && millis() - lastPost > 200) {
    lastPost = millis();
    if (firebase.post("/solwatch/packets", outbox[outHead])) {
      outHead = (outHead + 1) % OUT_LEN;
      outCount--;
      published++;
    }
  }

  static uint32_t lastLog = 0;
  if (millis() - lastLog > 15000) {
    lastLog = millis();
    Serial.printf("[status] wifi %s, rx %lu, published %lu, pending %u, rejected %lu, dropped %lu\n",
                  firebase.wifiUp() ? "up" : "DOWN", (unsigned long)received, (unsigned long)published, outCount,
                  (unsigned long)rejected, (unsigned long)outDropped);
  }
}
