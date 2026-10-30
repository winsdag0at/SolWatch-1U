#pragma once
// Copy to secrets.h (git-ignored) and fill in. Needed by the ground station,
// and by the satellite only when DIRECT_WIFI is 1.

#define WIFI_SSID          "your-wifi"
#define WIFI_PASSWORD      "your-wifi-password"

// Firebase console → Project settings → General → Web API key
#define FIREBASE_API_KEY   "AIza..."
// Realtime Database URL, no trailing slash
#define FIREBASE_DB_URL    "https://your-project-default-rtdb.firebaseio.com"
// Email/password user created for the ground station (Authentication → Users)
#define FIREBASE_EMAIL     "groundstation@example.com"
#define FIREBASE_PASSWORD  "choose-a-long-password"
