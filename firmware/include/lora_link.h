#pragma once
// SX1278 setup shared by all three boards.

#include <Arduino.h>
#include <SPI.h>
#include <LoRa.h>
#include "config.h"

inline bool loraBegin() {
  SPI.begin(PIN_LORA_SCK, PIN_LORA_MISO, PIN_LORA_MOSI, PIN_LORA_SS);
  LoRa.setPins(PIN_LORA_SS, PIN_LORA_RST, PIN_LORA_DIO0);
  if (!LoRa.begin(LORA_FREQ_HZ)) return false;
  LoRa.setSpreadingFactor(LORA_SF);
  LoRa.setSignalBandwidth(LORA_BW_HZ);
  LoRa.setCodingRate4(LORA_CR_DENOM);
  LoRa.setTxPower(LORA_TX_DBM);
  LoRa.setSyncWord(LORA_SYNC_WORD);
  LoRa.enableCrc();
  return true;
}

inline bool loraSend(const uint8_t *buf, size_t len) {
  if (!LoRa.beginPacket()) return false;
  LoRa.write(buf, len);
  return LoRa.endPacket() == 1;  // blocking until sent
}

/** Read a waiting packet into buf; returns its length (0 if none or too long). */
inline size_t loraReceive(uint8_t *buf, size_t cap) {
  int size = LoRa.parsePacket();
  if (size <= 0) return 0;
  if ((size_t)size > cap) {
    while (LoRa.available()) LoRa.read();
    return 0;
  }
  size_t n = 0;
  while (LoRa.available() && n < cap) buf[n++] = (uint8_t)LoRa.read();
  return n;
}
