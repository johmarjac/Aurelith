// Kampf. Zwei Arten, ein Ablauf.
//
// Nahkampf im Stil von Metin2: ein Schlag ist kein Zielangriff, sondern ein
// Bereich. Alles, was im Kegel vor der Figur und in Reichweite steht, wird
// getroffen und nimmt Schaden — daraus ergibt sich das ganze Spielgefühl, weil
// Positionierung und das Gruppieren von Gegnern zur eigentlichen Fertigkeit
// werden.
//
// Ablauf eines Schlags:
//   1. `tryStartSwing` prüft die Abklingzeit und setzt `swingTimer` auf die
//      Vorlaufzeit. Ab hier ist die Figur gebunden und langsam.
//   2. Der Tick zählt `swingTimer` herunter.
//   3. Bei Null ruft der Tick `resolveSwing` — erst jetzt entsteht Schaden.
//
// Die Vorlaufzeit ist der Grund, warum Ausweichen überhaupt möglich ist.
//
// Fernkampf geht denselben Weg, trifft aber genau eines: das nächste Ziel in
// Reichweite, ohne Rücksicht auf die Blickrichtung. Das ist Absicht — wer
// zielen muss, um überhaupt etwas zu treffen, spielt ein anderes Spiel. Die
// Figur dreht sich trotzdem zum Ziel, aber das macht der Client: er kennt die
// Welt aus den Snapshots und schickt die Blickrichtung als Teil der Eingabe
// mit. Der Server prüft nur die Entfernung — Zielen ist keine Autoritätsfrage.
//
// Der Schlag beginnt in beiden Fällen ohne Bedingung. Das ist wichtig für die
// Vorhersage: die Welt im Client enthält nur die eigene Figur, sie *kann* kein
// Ziel finden. Hinge der Beginn an einem Ziel, würde der Client den Schlag nie
// beginnen, die Verlangsamung während der Vorlaufzeit nicht mitrechnen und bei
// jedem Angriff gegen den Server driften.

#include <algorithm>

#include "aurelith/world.hpp"

namespace aur {
bool World::tryStartSwing(Entity& e) {
  if (!isAlive(e) || e.attackCooldown > 0.0f || e.swingTimer >= 0.0f) return false;
  e.swingTimer = e.attackWindupSec;
  e.attackCooldown = e.attackCooldownSec;
  e.state = kStateAttack;
  return true;
}

/** Nächstes lebendes Ziel in Reichweite, oder nichts. */
Entity* World::nearestHostile(Entity& attacker, float range) {
  Entity* best = nullptr;
  float bestDist = range;

  for (Entity& target : entities_) {
    if (!isHostile(attacker, target) || !isAlive(target)) continue;

    const float dx = target.x - attacker.x;
    const float dz = target.z - attacker.z;
    // Bis zur Hülle, nicht bis zum Mittelpunkt — ein dickes Monster ist eher
    // getroffen als ein dünnes an derselben Stelle.
    const float dist = std::sqrt(dx * dx + dz * dz) - target.radius;
    if (dist > bestDist) continue;

    bestDist = dist;
    best = &target;
  }
  return best;
}

void World::resolveRangedSwing(Entity& attacker) {
  Entity* target = nearestHostile(attacker, attacker.attackRange);
  if (target == nullptr) return;

  // Zum Ziel drehen. Auf dem Server ist das die Wahrheit, die per Snapshot bei
  // allen anderen ankommt; die eigene Figur hat sich über die Eingabe schon
  // gedreht. Ohne das schösse man auf dem Bildschirm der Mitspieler seitwärts.
  attacker.yaw = std::atan2(target->x - attacker.x, target->z - attacker.z);

  applyDamage(attacker, *target, kCombatRanged);
}

void World::resolveSwing(Entity& attacker) {
  if (!isAlive(attacker)) return;

  if (attacker.attackStyle == kAttackRanged) {
    resolveRangedSwing(attacker);
    return;
  }

  const float halfArc = attacker.attackArc * 0.5f;
  int hits = 0;

  // Über Indizes statt Referenzen laufen: `applyDamage` verändert nur
  // bestehende Einträge, aber die Absicht bleibt so auch dann klar, wenn
  // später Entities im Treffer entstehen.
  for (size_t i = 0; i < entities_.size() && hits < kMaxTargetsPerSwing; ++i) {
    Entity& target = entities_[i];
    if (!isHostile(attacker, target) || !isAlive(target)) continue;

    const float dx = target.x - attacker.x;
    const float dz = target.z - attacker.z;
    const float dist = std::sqrt(dx * dx + dz * dz);

    // Reichweite gilt bis zur Hülle des Ziels, nicht bis zu seinem Mittelpunkt.
    if (dist > attacker.attackRange + target.radius) continue;

    // Direkt am Körper klebende Gegner werden immer getroffen, sonst müsste
    // man sich exakt zu ihnen drehen, während sie einen bereits umringen.
    if (dist > attacker.radius + target.radius + 0.2f) {
      const float toTarget = std::atan2(dx, dz);
      if (std::fabs(angleDelta(attacker.yaw, toTarget)) > halfArc) continue;
    }

    applyDamage(attacker, target, kCombatNone);
    ++hits;
  }
}

void World::applyDamage(Entity& attacker, Entity& target, uint8_t extraFlags) {
  float damage = computeDamage(attacker.attackDamage, target.defense, rng_.next());

  uint8_t flags = extraFlags;
  // Die Aussicht gehört dem Angreifer, nicht dem Kampfcode. Die Vorgabewerte
  // stehen in `Entity` — wer nichts setzt, bekommt weiterhin 12 % und 1,75.
  if (rng_.next() < attacker.critChance) {
    damage = std::floor(damage * attacker.critMultiplier + 0.5f);
    flags |= kCombatCritical;
  }

  target.hp = std::max(0.0f, target.hp - damage);
  target.hitStun = kHitStunSeconds;

  // Ein angegriffenes Monster ohne Ziel schlägt zurück — auch friedliche.
  if (target.type == kEntityMonster && target.targetId == 0) {
    target.targetId = attacker.id;
  }

  const bool died = target.hp <= 0.0f;
  if (died) flags |= kCombatKilling;

  EventView hit{};
  hit.type = kEventHit;
  hit.flags = flags;
  hit.a = attacker.id;
  hit.b = target.id;
  hit.value = damage;
  hit.x = target.x;
  hit.y = target.y + target.height * 0.6f;
  hit.z = target.z;
  events_.push_back(hit);

  if (!died) return;

  target.state = kStateDead;
  target.targetId = 0;
  target.swingTimer = -1.0f;
  target.vx = 0.0f;
  target.vz = 0.0f;

  EventView death{};
  death.type = kEventDeath;
  death.a = target.id;
  death.b = attacker.id;
  death.x = target.x;
  death.y = target.y;
  death.z = target.z;
  events_.push_back(death);

  if (attacker.type == kEntityPlayer && target.type == kEntityMonster) {
    // Die Stufenabhängigkeit der Erfahrung rechnet TypeScript aus — sie ist
    // Balancing und gehört nicht in den Kern. Hier geht der Grundwert raus.
    EventView exp{};
    exp.type = kEventExp;
    exp.a = attacker.id;
    exp.b = target.id;
    exp.value = target.expReward;
    exp.value2 = std::floor(target.goldReward * (0.7f + rng_.next() * 0.6f) + 0.5f);
    if (exp.value2 < 1.0f) exp.value2 = 1.0f;
    events_.push_back(exp);
  }
}

}  // namespace aur
