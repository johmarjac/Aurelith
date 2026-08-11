// Deterministische Mathematik des Kerns.
//
// Der ganze Punkt der Hybrid-Architektur hängt an dieser Datei: Client und
// Server führen dieselbe wasm-Binärdatei aus, also liefern diese Funktionen
// auf beiden Seiten bitgleiche Ergebnisse. Sobald hier etwas plattformabhängig
// wird — eine libm-Funktion des Hosts, ein Zufallsgenerator aus der Umgebung —
// ist diese Zusicherung weg.

#pragma once

#include <cmath>
#include <cstdint>

namespace aur {

constexpr float kPi = 3.14159265358979323846f;
constexpr float kTau = kPi * 2.0f;

inline float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

inline float lerpf(float a, float b, float t) {
  return a + (b - a) * t;
}

// Kürzester Weg zwischen zwei Winkeln, Ergebnis in (-PI, PI].
inline float angleDelta(float from, float to) {
  float d = std::fmod(to - from, kTau);
  if (d > kPi) d -= kTau;
  if (d < -kPi) d += kTau;
  return d;
}

inline float dist2D(float ax, float az, float bx, float bz) {
  const float dx = bx - ax;
  const float dz = bz - az;
  return std::sqrt(dx * dx + dz * dz);
}

// mulberry32 — derselbe Generator wie zuvor in TypeScript, damit erzeugte
// Welten über den Sprachwechsel hinweg gleich aussehen.
class Rng {
 public:
  explicit Rng(uint32_t seed = 1u) : state_(seed) {}

  void reseed(uint32_t seed) { state_ = seed; }

  float next() {
    state_ += 0x6d2b79f5u;
    uint32_t t = state_;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + (t ^ (t >> 7)) * (t | 61u);
    return static_cast<float>((t ^ (t >> 14)) >> 8) / 16777216.0f;
  }

  // Gleichverteilt in [lo, hi).
  float range(float lo, float hi) { return lo + next() * (hi - lo); }

 private:
  uint32_t state_;
};

// Ortsfester Hash — Grundlage des Value-Noise. Muss reine Ganzzahlarithmetik
// bleiben, sonst driftet das Terrain.
inline float hash2D(int32_t xi, int32_t zi, uint32_t seed) {
  uint32_t h = seed ^ (static_cast<uint32_t>(xi) * 0x27d4eb2du) ^
               (static_cast<uint32_t>(zi) * 0x165667b1u);
  h = (h ^ (h >> 15)) * 0x85ebca6bu;
  h = (h ^ (h >> 13)) * 0xc2b2ae35u;
  h ^= h >> 16;
  return static_cast<float>(h >> 8) / 16777216.0f;
}

inline float smoothstep01(float t) {
  return t * t * (3.0f - 2.0f * t);
}

inline float valueNoise2D(float x, float z, uint32_t seed) {
  const float fx = std::floor(x);
  const float fz = std::floor(z);
  const int32_t xi = static_cast<int32_t>(fx);
  const int32_t zi = static_cast<int32_t>(fz);
  const float tx = smoothstep01(x - fx);
  const float tz = smoothstep01(z - fz);

  const float a = hash2D(xi, zi, seed);
  const float b = hash2D(xi + 1, zi, seed);
  const float c = hash2D(xi, zi + 1, seed);
  const float d = hash2D(xi + 1, zi + 1, seed);

  return lerpf(lerpf(a, b, tx), lerpf(c, d, tx), tz);
}

inline float fbm2D(float x, float z, uint32_t seed, int octaves) {
  float sum = 0.0f;
  float amp = 1.0f;
  float norm = 0.0f;
  float freq = 1.0f;
  for (int i = 0; i < octaves; ++i) {
    sum += valueNoise2D(x * freq, z * freq, seed + static_cast<uint32_t>(i) * 0x9e3779b9u) * amp;
    norm += amp;
    amp *= 0.5f;
    freq *= 2.0f;
  }
  return sum / norm;
}

}  // namespace aur
