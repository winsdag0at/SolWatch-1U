#pragma once
// Minimal Firebase Realtime Database client over the REST API: Wi-Fi with
// reconnect, NTP time, email/password sign-in (ID token, re-issued before it
// expires) and POST (append with a push ID).

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <time.h>
#include "secrets.h"

class FirebaseRest {
 public:
  void begin() {
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    // TLS without certificate validation: telemetry is public, but a hostile
    // network could read the ID token. Pin the Google Trust Services root CA
    // (client.setCACert) before using this outside the lab.
    client_.setInsecure();
  }

  bool wifiUp() { return WiFi.status() == WL_CONNECTED; }

  /** True once NTP has set a plausible UTC clock. */
  bool timeValid() { return time(nullptr) > 1700000000; }

  time_t now() { return time(nullptr); }

  /** Keep Wi-Fi up; call often. */
  void loop() {
    if (wifiUp()) return;
    if (millis() - lastWifiTry_ > 10000) {
      lastWifiTry_ = millis();
      Serial.println(F("[wifi] reconnecting"));
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
  }

  /** Append one JSON object under `path` (e.g. "/solwatch/packets"). */
  bool post(const char *path, const char *json) {
    if (!wifiUp() || !ensureToken()) return false;
    String url = String(FIREBASE_DB_URL) + path + ".json?auth=" + token_;
    HTTPClient http;
    http.setTimeout(8000);
    if (!http.begin(client_, url)) return false;
    http.addHeader("Content-Type", "application/json");
    int code = http.POST((uint8_t *)json, strlen(json));
    if (code == 401) token_ = "";  // token rejected — sign in again next time
    if (code != 200) Serial.printf("[firebase] POST failed: HTTP %d %s\n", code, http.getString().c_str());
    http.end();
    return code == 200;
  }

 private:
  WiFiClientSecure client_;
  String token_;
  uint32_t tokenAt_ = 0;
  uint32_t lastWifiTry_ = 0;
  uint32_t lastAuthTry_ = 0;

  bool ensureToken() {
    // ID tokens last 1 h; refresh after 50 min
    if (token_.length() && millis() - tokenAt_ < 50UL * 60UL * 1000UL) return true;
    if (lastAuthTry_ && millis() - lastAuthTry_ < 15000) return false;  // back off
    lastAuthTry_ = millis();

    HTTPClient http;
    String url = String("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=") + FIREBASE_API_KEY;
    if (!http.begin(client_, url)) return false;
    http.addHeader("Content-Type", "application/json");
    JsonDocument req;
    req["email"] = FIREBASE_EMAIL;
    req["password"] = FIREBASE_PASSWORD;
    req["returnSecureToken"] = true;
    String body;
    serializeJson(req, body);
    int code = http.POST(body);
    String resp = http.getString();
    http.end();
    if (code != 200) {
      Serial.printf("[firebase] sign-in failed: HTTP %d %s\n", code, resp.c_str());
      return false;
    }
    JsonDocument doc;
    if (deserializeJson(doc, resp)) return false;
    token_ = doc["idToken"].as<String>();
    tokenAt_ = millis();
    Serial.printf("[firebase] signed in as %s (uid %s)\n", FIREBASE_EMAIL, doc["localId"].as<const char *>());
    return token_.length() > 0;
  }
};
