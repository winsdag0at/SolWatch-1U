// SolWatch-1U farm dew node (ESP32 + SX1278).
// Measures air temperature/humidity, panel-glass temperature and a wet-plate
// sensor, and uplinks an 'n' packet to the satellite for store-and-forward.

#include <Arduino.h>
#include <DHT.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include "config.h"
#include "solwatch_packet.h"
#include "lora_link.h"

DHT dht(PIN_DHT, DHT22);
OneWire oneWire(PIN_ONEWIRE);
DallasTemperature glassProbe(&oneWire);
uint16_t seq = 0;

uint16_t readWetPlate() {
  // average a few readings; scale 12-bit ADC to 0..1023, wetter = larger
  uint32_t sum = 0;
  for (int i = 0; i < 8; i++) sum += analogRead(PIN_WET_PLATE_ADC);
  uint16_t v = (sum / 8) >> 2;
  return WET_PLATE_DRY_HIGH ? 1023 - v : v;
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println(F("\nSolWatch-1U dew node"));
  dht.begin();
  glassProbe.begin();
  analogSetPinAttenuation(PIN_WET_PLATE_ADC, ADC_11db);
  if (!loraBegin()) {
    Serial.println(F("SX1278 not found — check wiring"));
    while (true) delay(1000);
  }
}

void loop() {
  static uint32_t last = 0;
  if (last && millis() - last < DEW_SAMPLE_MS) return;
  last = millis();

  float air = dht.readTemperature();
  float rh = dht.readHumidity();
  glassProbe.requestTemperatures();
  float glass = glassProbe.getTempCByIndex(0);
  if (isnan(air) || isnan(rh) || glass == DEVICE_DISCONNECTED_C) {
    Serial.println(F("[sample] sensor read failed — skipping"));
    return;
  }

  NPacketBin p = {};
  p.type = PKT_N_UPLINK;
  p.farm = DEW_FARM_INDEX;
  p.seq = seq++;
  p.age_s = 0;
  p.air_c100 = clampI16(air * 100);
  p.rh_d10 = clampU16(rh * 10);
  p.glass_c100 = clampI16(glass * 100);
  p.wet_plate = readWetPlate();

  bool ok = loraSend((uint8_t *)&p, sizeof(p));
  Serial.printf("[uplink] air %.1f C, RH %.0f%%, glass %.1f C, wet %u -> %s\n", air, rh, glass, p.wet_plate, ok ? "sent" : "FAILED");
}
