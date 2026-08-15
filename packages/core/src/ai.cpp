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

// Bezugspunkt eines Wesens — warum es einer für alle ist, steht an der
// Deklaration in `world.hpp`.
void World::homeOf(const Entity& e, float& x, float& z, float& radius) const {
  const Spawner* feld =
      e.spawnerIndex < spawners_.size() ? &spawners_[e.spawnerIndex] : nullptr;
  x = feld != nullptr ? feld->x : e.homeX;
  z = feld != nullptr ? feld->z : e.homeZ;
  radius = e.wanderRadius > 0.0f ? e.wanderRadius
                                 : (feld != nullptr ? feld->radius : 0.0f);
}

/**
 * Umherwandern im eigenen Feld.
 *
 * Der Ablauf ist ein Zweitakter: eine Weile zu einem Punkt laufen, dann eine
 * Weile stehen, dann von vorn. Das Ziel wird **gleichverteilt in der
 * Kreisfläche** um den Feldmittelpunkt gezogen — die Wurzel im Radius ist der
 * Grund dafür; ohne sie drängte sich alles in der Mitte.
 *
 * Der Mittelpunkt ist der des Feldes und nicht der eigene Erscheinungsort.
 * Sonst dürfte ein Monster, das am Rand des Feldes erschienen ist, um seinen
 * Rand herum wandern und käme auf den doppelten Abstand vom Feld — genau das,
 * was ein Wanderradius verhindern soll.
 */
void World::wander(Entity& e, float dt) {
  float mitteX = 0.0f;
  float mitteZ = 0.0f;
  float radius = 0.0f;
  homeOf(e, mitteX, mitteZ, radius);

  if (radius <= 0.0f || e.moveSpeed <= 0.0f) {
    e.vx = 0.0f;
    e.vz = 0.0f;
    if (e.state != kStateAttack) e.state = kStateIdle;
    return;
  }

  e.wanderTimer -= dt;

  // Ausserhalb des Feldes hat das Wandern Vorrang vor der Pause: der Weg
  // zurück ist das nächste Ziel, und zwar sofort. Ohne das bliebe ein Monster,
  // das gerade von der Leine zurückgekommen ist, zehn Sekunden draussen stehen.
  const float weg = dist2D(e.x, e.z, mitteX, mitteZ);
  if (weg > radius) {
    e.wanderWalking = true;
    e.wanderX = mitteX;
    e.wanderZ = mitteZ;
    if (e.wanderTimer <= 0.0f) e.wanderTimer = kWanderWalkMax;
  }

  if (e.wanderTimer <= 0.0f) {
    if (e.wanderWalking) {
      e.wanderWalking = false;
      e.wanderTimer = kWanderRest;
    } else {
      const float winkel = rng_.next() * kTau;
      const float r = std::sqrt(rng_.next()) * radius;
      e.wanderX = mitteX + std::cos(winkel) * r;
      e.wanderZ = mitteZ + std::sin(winkel) * r;
      e.wanderWalking = true;
      e.wanderTimer = kWanderWalkMin + rng_.next() * (kWanderWalkMax - kWanderWalkMin);
    }
  }

  if (!e.wanderWalking) {
    e.vx = 0.0f;
    e.vz = 0.0f;
    if (e.state != kStateAttack) e.state = kStateIdle;
    return;
  }

  // Angekommen, bevor die Zeit um war: dann fängt die Pause eben früher an.
  // Ein Monster, das auf der Stelle „läuft", ist schlimmer als eines, das
  // steht.
  if (dist2D(e.x, e.z, e.wanderX, e.wanderZ) <= kWanderArrive) {
    e.wanderWalking = false;
    e.wanderTimer = kWanderRest;
    e.vx = 0.0f;
    e.vz = 0.0f;
    if (e.state != kStateAttack) e.state = kStateIdle;
    return;
  }

  moveTowards(e, e.wanderX, e.wanderZ, dt, kWanderSpeedFactor);
  e.state = kStateMove;
}

void World::updateMonsterAi(Entity& e, float dt) {
  if (e.type != kEntityMonster || !isAlive(e)) return;

  // Gemessen wird vom Feld und nicht vom eigenen Erscheinungsort — derselbe
  // Bezugspunkt, den auch das Umherwandern nimmt. Siehe `homeOf`.
  float heimX = 0.0f;
  float heimZ = 0.0f;
  float heimRadius = 0.0f;
  homeOf(e, heimX, heimZ, heimRadius);
  const float homeDist = dist2D(e.x, e.z, heimX, heimZ);

  // An der Leine: Ziel fallenlassen, zurücklaufen, dabei heilen.
  if (homeDist > e.leashRange) {
    e.targetId = 0;
    e.hp = std::min(e.maxHp, e.hp + e.maxHp * kLeashRegenPerSecond * dt);
    moveTowards(e, heimX, heimZ, dt, 1.35f);
    e.state = kStateMove;
    return;
  }

  Entity* target = e.targetId != 0 ? find(e.targetId) : nullptr;
  if (target != nullptr && (!isAlive(*target) || !isCombatant(*target))) {
    target = nullptr;
    e.targetId = 0;
  }
  // Ziel zu weit vom eigenen Zuhause entfernt — es hat sich herausgezogen.
  if (target != nullptr &&
      dist2D(target->x, target->z, heimX, heimZ) > e.leashRange * 1.25f) {
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
    wander(e, dt);
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

/**
 * Ein Begleiter läuft zu seinem Ziel und bleibt dort stehen.
 *
 * Das ist das ganze Verhalten im Kern. Ob das Ziel gerade der Mensch ist oder
 * ein Haufen Beute, ob abgebrochen wird, weil man zu weit gelaufen ist, und ob
 * das Tier irgendwo festhängt — all das entscheidet der Server und setzt je
 * Tick einen Punkt. Er kennt Beutel und Beute; der Kern kennt Gelände und
 * Hindernisse, und genau das steuert er bei.
 *
 * Der Ankunftsabstand kommt mit dem Ziel. Beim Folgen ist er der Abstand, den
 * das Tier zum Menschen hält — ohne ihn liefe es in ihn hinein und zappelte
 * dort, weil jeder Schritt des Menschen es wieder danebenstellt.
 */
void World::updatePetAi(Entity& e, float dt) {
  const float dist = dist2D(e.x, e.z, e.goalX, e.goalZ);
  if (dist <= e.goalArrive || e.moveSpeed <= 0.0f) {
    e.vx = 0.0f;
    e.vz = 0.0f;
    e.state = kStateIdle;
    return;
  }

  moveTowards(e, e.goalX, e.goalZ, dt, 1.0f);
  e.state = kStateMove;
}

}  // namespace aur
