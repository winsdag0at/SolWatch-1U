// SolWatch-1U on-board computer (ESP32).
// Samples the polarimetric payload and housekeeping sensors, stores dew-node
// uplinks, and downlinks everything oldest-first over LoRa during a pass.

#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_ADS1X15.h>
#include <Adafruit_INA219.h>
#include <QMC5883LCompass.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include "config.h"
#include "solwatch_packet.h"
#include "lora_link.h"
#if DIRECT_WIFI
#include "firebase_rest.h"
FirebaseRest firebase;
#endif

Adafruit_ADS1115 ads;
Adafruit_INA219 ina;
QMC5883LCompass compass;
OneWire oneWire(PIN_ONEWIRE);
DallasTemperature ds18(&oneWire);

bool haveAds = false;
bool haveIna = false;
bool haveLora = false;

// ---- store-and-forward queue ------------------------------------------------------
struct QueueItem {
  uint32_t sampledMs;
  uint8_t len;
  uint8_t data[MAX_PACKET];
};
QueueItem queue[SAT_QUEUE_LEN];
uint16_t qHead = 0;  // oldest
uint16_t qCount = 0;
uint32_t dropped = 0;
uint32_t relayed = 0;
uint16_t seq = 0;

void enqueue(const void *pkt, uint8_t len, uint32_t sampledMs) {
  if (qCount == SAT_QUEUE_LEN) {  // full: drop the oldest
    qHead = (qHead + 1) % SAT_QUEUE_LEN;
    qCount--;
    dropped++;
  }
  QueueItem &it = queue[(qHead + qCount) % SAT_QUEUE_LEN];
  it.sampledMs = sampledMs;
  it.len = len;
  memcpy(it.data, pkt, len);
  qCount++;
}

// ---- sensors ------------------------------------------------------------------------
SPacketBin sample() {
  SPacketBin p = {};
  p.type = PKT_S;
  p.farm = SAT_FARM_INDEX;
  p.seq = seq++;

  for (uint8_t ch = 0; ch < 4; ch++) {
    float v = haveAds ? ads.computeVolts(ads.readADC_SingleEnded(ch)) : 0;
    p.ch_mV[ch] = clampU16(v * 1000);
  }

  compass.read();
  int az = compass.getAzimuth();
  p.heading_d10 = clampU16(((az % 360) + 360) % 360 * 10);

  // INA219 sits between the battery and the regulator: bus voltage = battery
  if (haveIna) {
    p.batt_mV = clampU16(ina.getBusVoltage_V() * 1000);
    p.current_mA = clampI16(ina.getCurrent_mA());
  }
  p.solar_mV = clampU16(analogReadMilliVolts(PIN_SOLAR_ADC) * SOLAR_DIVIDER);

  ds18.requestTemperatures();
  float t = ds18.getTempCByIndex(0);
  p.temp_c100 = t == DEVICE_DISCONNECTED_C ? INT16_MIN : clampI16(t * 100);
  return p;
}

bool linkWindow() {
#if PASS_DEMO
  return (millis() / 1000) % PASS_PERIOD_S < PASS_WINDOW_S;
#else
  return true;
#endif
}

// ---- downlink ---------------------------------------------------------------------------
void downlinkOne() {
  QueueItem &it = queue[qHead];
  uint32_t age = (millis() - it.sampledMs) / 1000;
  memcpy(it.data + 4, &age, sizeof(age));  // age_s sits at byte 4 in both formats
  bool ok = false;
#if DIRECT_WIFI
  if (firebase.timeValid()) {
    char json[360];
    if (packetToJson(it.data, it.len, firebase.now(), false, 0, 0, json, sizeof(json))) ok = firebase.post("/solwatch/packets", json);
  }
#else
  ok = haveLora && loraSend(it.data, it.len);
#endif
  if (!ok) return;  // keep it queued, retry later
  if (it.data[0] == PKT_N) relayed++;
  qHead = (qHead + 1) % SAT_QUEUE_LEN;
  qCount--;
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println(F("\nSolWatch-1U OBC booting"));
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);

  ads.setGain(GAIN_ONE);  // ±4.096 V range covers the 0–3.3 V TEMT6000 outputs
  haveAds = ads.begin();
  haveIna = ina.begin();
  compass.init();
  ds18.begin();
  ds18.setResolution(10);
  analogSetPinAttenuation(PIN_SOLAR_ADC, ADC_11db);
  Serial.printf("ADS1115 %s, INA219 %s, DS18B20 x%d\n", haveAds ? "ok" : "MISSING", haveIna ? "ok" : "MISSING", ds18.getDeviceCount());

  haveLora = loraBegin();
  Serial.printf("SX1278 %s\n", haveLora ? "ok" : "MISSING");
#if DIRECT_WIFI
  firebase.begin();
  Serial.println(F("DIRECT_WIFI: posting straight to Firebase"));
#endif
}

void loop() {
  static uint32_t lastSample = 0;
  static uint32_t lastTx = 0;
  static uint32_t lastLog = 0;
  static bool wasInWindow = false;

#if DIRECT_WIFI
  firebase.loop();
#endif

  // store dew-node uplinks for relay
  uint8_t buf[MAX_PACKET + 4];
  size_t n = haveLora ? loraReceive(buf, sizeof(buf)) : 0;
  if (n == sizeof(NPacketBin) && buf[0] == PKT_N_UPLINK) {
    buf[0] = PKT_N;
    enqueue(buf, n, millis());
    Serial.printf("[uplink] dew packet from farm %u stored (RSSI %d)\n", buf[1], LoRa.packetRssi());
  }

  if (millis() - lastSample >= SAT_SAMPLE_MS || lastSample == 0) {
    lastSample = millis();
    SPacketBin p = sample();
    enqueue(&p, sizeof(p), lastSample);
    Serial.printf("[sample] I = %u/%u/%u/%u mV, hdg %.1f, batt %u mV, %d mA\n",
                  p.ch_mV[0], p.ch_mV[1], p.ch_mV[2], p.ch_mV[3], p.heading_d10 / 10.0, p.batt_mV, p.current_mA);
  }

  bool inWindow = linkWindow();
  if (inWindow != wasInWindow) {
    Serial.printf(inWindow ? "[pass] AOS — %u packets queued\n" : "[pass] LOS — %u packets left\n", qCount);
    wasInWindow = inWindow;
  }
  if (inWindow && qCount && millis() - lastTx >= SAT_TX_GAP_MS) {
    lastTx = millis();
    downlinkOne();
  }

  if (millis() - lastLog > 15000) {
    lastLog = millis();
    Serial.printf("[status] queued %u, relayed %lu, dropped %lu, %s\n", qCount, (unsigned long)relayed, (unsigned long)dropped,
                  inWindow ? "IN PASS" : "out of contact");
  }
}
