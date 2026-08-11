// Monster-Verhalten. Bewusst schlicht: wahrnehmen, verfolgen, zuschlagen, an
// der Leine zurückkehren. Alles Weitere — Gruppenverhalten, Fähigkeiten, Bosse
// mit Phasen — setzt darauf auf, ohne dass diese vier Zustände sich ändern
// müssten.

#include <algorithm>

#include "aurelith/world.hpp"

namespace aur {
namespace {

// Abstand, den ein Monster zum Ziel halten will — knapp innerhalb der Reichweite.
constexpr float kPreferredGap = 0.35f;
// Regeneration beim Rückweg, Anteil der maximalen Lebenspunkte je Sekunde.
constexpr float kLeashRegenPerSecond = 0.25f;

}  // namespace

void World::updateMonsterAi(Entity& e, float dt) {
  if (e.type != kEntityMonster || !isAlive(e)) return;

  const float homeDist = dist2D(e.x, e.z, e.homeX, e.homeZ);

  // An der Leine: Ziel fallenlassen, zurücklaufen, dabei heilen.
  if (homeDist > e.leashRange) {
    e.targetId = 0;
    e.hp = std::min(e.maxHp, e.hp + e.maxHp * kLeashRegenPerSecond * dt);
    moveTowards(e, e.homeX, e.homeZ, dt, 1.35f);
    e.state = kStateMove;
    return;
  }

  Entity* target = e.targetId != 0 ? find(e.targetId) : nullptr;
  if (target != nullptr && (!isAlive(*target) || target->type == kEntityNpc)) {
    target = nullptr;
    e.targetId = 0;
  }
  // Ziel zu weit vom eigenen Zuhause entfernt — es hat sich herausgezogen.
  if (target != nullptr &&
      dist2D(target->x, target->z, e.homeX, e.homeZ) > e.leashRange * 1.25f) {
    target = nullptr;
    e.targetId = 0;
  }

  if (target == nullptr && e.aggroRange > 0.0f) {
    float bestDist = e.aggroRange;
    Entity* best = nullptr;
    for (Entity& other : entities_) {
      if (other.type != kEntityPlayer || !isAlive(other)) continue;
      const float d = dist2D(e.x, e.z, other.x, other.z);
      if (d < bestDist) {
        bestDist = d;
        best = &other;
      }
    }
    if (best != nullptr) {
      target = best;
      e.targetId = best->id;
    }
  }

  if (target == nullptr) {
    // Kein Ziel: zurück zum Standort, sonst stehenbleiben.
    if (homeDist > 1.5f) {
      moveTowards(e, e.homeX, e.homeZ, dt, 0.6f);
      e.state = kStateMove;
    } else {
      e.vx = 0.0f;
      e.vz = 0.0f;
      if (e.state != kStateAttack) e.state = kStateIdle;
    }
    return;
  }

  const float dist = dist2D(e.x, e.z, target->x, target->z);
  const float reach = e.attackRange + target->radius;

  if (dist > reach - kPreferredGap) {
    moveTowards(e, target->x, target->z, dt, 1.0f);
    if (e.state != kStateAttack) e.state = kStateMove;
    return;
  }

  // In Reichweite: zum Ziel drehen und zuschlagen, sobald die Abklingzeit lässt.
  e.vx = 0.0f;
  e.vz = 0.0f;
  e.yaw = std::atan2(target->x - e.x, target->z - e.z);
  if (!tryStartSwing(e) && e.state != kStateAttack) {
    e.state = kStateIdle;
  }
}

}  // namespace aur
