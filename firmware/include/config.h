#pragma once
// Shared configuration for the SolWatch-1U satellite, ground station and dew node.

// ---- LoRa (must match on every board) ----------------------------------------
#define LORA_FREQ_HZ    433E6
#define LORA_SF         9      // bench demo; the flight link budget assumes SF11
#define LORA_BW_HZ      125E3
#define LORA_CR_DENOM   5      // coding rate 4/5
#define LORA_TX_DBM     17     // SX1278 PA_BOOST, 2..20 dBm
#define LORA_SYNC_WORD  0x5A   // private network, ignores other LoRa traffic

// SX1278 module wiring (VSPI)
#define PIN_LORA_SCK    18
#define PIN_LORA_MISO   19
#define PIN_LORA_MOSI   23
#define PIN_LORA_SS      5
#define PIN_LORA_RST    14
#define PIN_LORA_DIO0   26

// ---- I2C / sensors -----------------------------------------------------------------
#define PIN_I2C_SDA     21
#define PIN_I2C_SCL     22
#define PIN_ONEWIRE      4     // DS18B20 data (4.7 kΩ pull-up to 3.3 V)
#define PIN_SOLAR_ADC   35     // solar panel voltage through a 2:1 divider
#define SOLAR_DIVIDER   2.0f

// ---- Satellite ---------------------------------------------------------------------
#define SAT_FARM_INDEX      0       // farm the payload is pointed at (see FARM_IDS)
#define SAT_SAMPLE_MS       10000   // payload + housekeeping sample period
#define SAT_QUEUE_LEN       400     // store-and-forward buffer (packets)
#define SAT_TX_GAP_MS       150     // pause between downlinked packets
// Pass demo: only downlink inside a window so the store-and-forward behaviour
// is visible on the bench. Set PASS_DEMO 0 to transmit continuously.
#define PASS_DEMO           1
#define PASS_PERIOD_S       120
#define PASS_WINDOW_S       40
// Fallback: satellite posts straight to Firebase over Wi-Fi (no LoRa needed).
#define DIRECT_WIFI         0

// ---- Dew node ---------------------------------------------------------------------
#define DEW_FARM_INDEX      0
#define DEW_SAMPLE_MS       15000
#define PIN_DHT             27      // DHT22 air temperature / humidity
#define PIN_WET_PLATE_ADC   34      // rain / leaf-wetness plate analog output
#define WET_PLATE_DRY_HIGH  1       // most plates read HIGH when dry; inverted so wetter = larger
