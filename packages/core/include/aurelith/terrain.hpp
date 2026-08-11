// Höhenfeld.
//
// Dieselbe Funktion versorgt Kollision, KI-Wegfindung und das Netz, das der
// Renderer zeichnet. Genau deshalb liegt sie im Kern und nicht im Client: der
// sichtbare Boden und der Boden, auf dem der Server einen stehen lässt, sind
// per Konstruktion derselbe.

#pragma once

#include "aurelith/math.hpp"
#include "aurelith/types.hpp"

namespace aur {

inline float terrainHeight(float x, float z, const TerrainDef& t) {
  const float f = t.featureScale;

  // Grundrelief: weite, sanfte Hügel.
  const float base = fbm2D(x * f, z * f, t.seed, 4) * 2.0f - 1.0f;

  // Bergrücken: aufgestellter Betrag ergibt Grate statt Kuppen.
  const float ridgeRaw = valueNoise2D(x * f * 2.7f, z * f * 2.7f, t.seed ^ 0x51ed270bu) * 2.0f - 1.0f;
  const float ridge = 1.0f - std::fabs(ridgeRaw);

  // Feindetail, damit ebene Flächen nicht spiegelglatt wirken.
  const float detail = fbm2D(x * f * 8.0f, z * f * 8.0f, t.seed ^ 0x2545f491u, 2) * 2.0f - 1.0f;

  float h = base * 0.75f + (ridge - 0.5f) * 0.5f + detail * 0.08f;

  // Zum Rand hin absenken, damit die Map optisch endet statt abzureißen.
  const float half = t.size * 0.5f;
  const float edge = (std::fabs(x) > std::fabs(z) ? std::fabs(x) : std::fabs(z)) / half;
  const float falloff = 1.0f - clampf((edge - 0.82f) / 0.18f, 0.0f, 1.0f);
  h *= falloff * falloff;

  return h * t.heightScale;
}

struct TerrainNormal {
  float x, y, z;
};

inline TerrainNormal terrainNormal(float x, float z, const TerrainDef& t) {
  const float e = t.cellSize * 0.5f;
  const float hl = terrainHeight(x - e, z, t);
  const float hr = terrainHeight(x + e, z, t);
  const float hd = terrainHeight(x, z - e, t);
  const float hu = terrainHeight(x, z + e, t);

  const float nx = hl - hr;
  const float nz = hd - hu;
  const float ny = 2.0f * e;
  float len = std::sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-6f) len = 1.0f;
  return {nx / len, ny / len, nz / len};
}

// Steigung in Grad. Die Bewegung nutzt sie, um Klippen unbegehbar zu machen.
inline float terrainSlopeDeg(float x, float z, const TerrainDef& t) {
  const TerrainNormal n = terrainNormal(x, z, t);
  return std::acos(clampf(n.y, -1.0f, 1.0f)) * (180.0f / kPi);
}

inline float clampToMap(float v, const TerrainDef& t) {
  const float limit = t.size * 0.5f - 2.0f;
  return clampf(v, -limit, limit);
}

}  // namespace aur
