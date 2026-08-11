// Bewegung.
//
// Die empfindlichste Stelle des Kerns: dieselbe Funktion treibt die Figur auf
// dem Server und die vorhergesagte Figur im Client. Jede Abweichung zeigt sich
// sofort als Ruckeln beim Zurücksetzen.
//
// Deshalb greift hier nichts auf Zufall oder eine Zeitquelle zu — nur auf
// `entity`, `dt` und die Welt.

#include <algorithm>

#include "aurelith/world.hpp"

namespace aur {

bool World::tryStep(Entity& e, float dx, float dz) {
  float nx = clampToMap(e.x + dx, terrain_);
  float nz = clampToMap(e.z + dz, terrain_);

  if (terrainSlopeDeg(nx, nz, terrain_) > kMaxWalkableSlopeDeg) return false;

  // Props auflösen: aus jedem überlappenden Kreis herausschieben.
  for (const Collider& c : colliders_) {
    const float cdx = nx - c.x;
    const float cdz = nz - c.z;
    const float minDist = c.radius + e.radius;
    const float d2 = cdx * cdx + cdz * cdz;
    if (d2 >= minDist * minDist) continue;

    const float d = std::sqrt(d2);
    if (d < 1e-4f) {
      // Exakt im Mittelpunkt — eine feste Richtung wählen, damit das Ergebnis
      // reproduzierbar bleibt.
      nx = c.x + minDist;
      continue;
    }
    nx = c.x + (cdx / d) * minDist;
    nz = c.z + (cdz / d) * minDist;
  }

  nx = clampToMap(nx, terrain_);
  nz = clampToMap(nz, terrain_);

  // Nach dem Herausschieben nochmals prüfen — sonst landet man in der Klippe.
  if (terrainSlopeDeg(nx, nz, terrain_) > kMaxWalkableSlopeDeg) return false;

  e.x = nx;
  e.z = nz;
  return true;
}

void World::moveWithCollision(Entity& e, float dx, float dz, float* outDx, float* outDz) {
  const float startX = e.x;
  const float startZ = e.z;

  if (!tryStep(e, dx, dz)) {
    // Blockierte Achsen einzeln nachversuchen, damit man an Wänden entlang
    // gleitet statt hängenzubleiben.
    const bool slidX = dx != 0.0f && tryStep(e, dx, 0.0f);
    if (!slidX && dz != 0.0f) tryStep(e, 0.0f, dz);
  }

  e.y = terrainHeight(e.x, e.z, terrain_);
  if (outDx != nullptr) *outDx = e.x - startX;
  if (outDz != nullptr) *outDz = e.z - startZ;
}

void World::moveTowards(Entity& e, float targetX, float targetZ, float dt, float speedFactor) {
  const float dx = targetX - e.x;
  const float dz = targetZ - e.z;
  const float d = std::sqrt(dx * dx + dz * dz);
  if (d < 1e-3f) {
    e.vx = 0.0f;
    e.vz = 0.0f;
    return;
  }

  float speed = e.moveSpeed * speedFactor;
  if (e.swingTimer >= 0.0f) speed *= kWindupSpeedFactor;
  else if (e.hitStun > 0.0f) speed *= kHitStunSpeedFactor;

  const float step = std::min(d, speed * dt);
  float movedX = 0.0f;
  float movedZ = 0.0f;
  moveWithCollision(e, (dx / d) * step, (dz / d) * step, &movedX, &movedZ);

  e.yaw = std::atan2(dx, dz);
  e.vx = dt > 0.0f ? movedX / dt : 0.0f;
  e.vz = dt > 0.0f ? movedZ / dt : 0.0f;
}

void World::applyInput(uint32_t id, float moveX, float moveZ, float yaw, uint32_t buttons,
                       float dt) {
  Entity* ep = find(id);
  if (ep == nullptr) return;
  Entity& e = *ep;

  if (!isAlive(e)) {
    e.vx = 0.0f;
    e.vz = 0.0f;
    return;
  }

  e.yaw = yaw;

  // Der Schlag wird vor der Bewegung ausgelöst: die Vorlaufzeit bremst damit
  // noch im selben Schritt, in dem sie beginnt.
  if ((buttons & kButtonAttack) != 0u) {
    tryStartSwing(e);
  }

  float mx = moveX;
  float mz = moveZ;
  const float len = std::sqrt(mx * mx + mz * mz);
  if (len > 1.0f) {
    mx /= len;
    mz /= len;
  }
  const float intensity = std::min(1.0f, len);

  float speed = e.moveSpeed * intensity;
  if (e.swingTimer >= 0.0f) speed *= kWindupSpeedFactor;
  else if (e.hitStun > 0.0f) speed *= kHitStunSpeedFactor;

  if (speed <= 1e-4f || intensity < 1e-3f) {
    e.vx = 0.0f;
    e.vz = 0.0f;
    if (e.state == kStateMove) e.state = kStateIdle;
    e.y = terrainHeight(e.x, e.z, terrain_);
    return;
  }

  float movedX = 0.0f;
  float movedZ = 0.0f;
  moveWithCollision(e, mx * speed * dt, mz * speed * dt, &movedX, &movedZ);

  e.vx = dt > 0.0f ? movedX / dt : 0.0f;
  e.vz = dt > 0.0f ? movedZ / dt : 0.0f;
  if (e.state != kStateAttack) {
    e.state = (movedX != 0.0f || movedZ != 0.0f) ? kStateMove : kStateIdle;
  }
}

}  // namespace aur
