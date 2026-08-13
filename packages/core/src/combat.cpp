// Kampf. Ein Schlag, ein Ziel.
//
// Angegriffen wird, was anvisiert ist — `targetId`. Nichts anderes. Wer nicht
// anvisiert ist, nimmt keinen Schaden, auch wenn er direkt daneben steht.
//
// Das war einmal anders: der Nahkampf traf alles im Kegel vor der Figur, wie
// bei Metin2. Das Spielgefühl, das daraus entstand, war ein anderes als das
// gewollte — bei Flyff sucht man sich einen Gegner aus, und der Kampf gilt
// diesem einen. Ein Kegel und eine Zielauswahl nebeneinander wären zwei
// Antworten auf dieselbe Frage: „wen trifft dieser Schlag?"
//
// Ablauf eines Schlags:
//   1. `tryStartSwing` prüft die Abklingzeit und setzt `swingTimer` auf die
//      Vorlaufzeit. Ab hier ist die Figur gebunden und langsam.
//   2. Der Tick zählt `swingTimer` herunter.
//   3. Bei Null ruft der Tick `resolveSwing` — erst jetzt entsteht Schaden.
//
// Die Vorlaufzeit ist der Grund, warum Ausweichen überhaupt möglich ist: wer
// während des Vorlaufs aus der Reichweite läuft, wird nicht getroffen. Die
// Entfernung wird deshalb erst beim Auflösen geprüft und nicht beim Beginn.
//
// Nah- und Fernkampf unterscheiden sich nur noch in der Reichweite und im
// Bild: der Fernkampftreffer bekommt eine Flagge, damit der Client einen Pfeil
// zeichnet.
//
// Der Schlag beginnt ohne jede Bedingung. Das ist wichtig für die Vorhersage:
// die Welt im Client enthält nur die eigene Figur, sie *kann* kein Ziel
// finden. Hinge der Beginn an einem Ziel, würde der Client den Schlag nie
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

void World::resolveSwing(Entity& attacker) {
  if (!isAlive(attacker)) return;

  // Ohne Ziel geht der Schlag ins Leere. Kein Ersatzziel in der Nähe: wer
  // hilfsweise das nächstbeste träfe, hätte wieder zwei Wahrheiten darüber,
  // wen man angreift — die Auswahl des Spielers und die Suche des Kerns.
  Entity* target = attacker.targetId != 0 ? find(attacker.targetId) : nullptr;
  if (target == nullptr || !isHostile(attacker, *target) || !isAlive(*target)) return;

  const float dx = target->x - attacker.x;
  const float dz = target->z - attacker.z;
  // Bis zur Hülle, nicht bis zum Mittelpunkt — ein dickes Monster ist eher
  // getroffen als ein dünnes an derselben Stelle.
  const float dist = std::sqrt(dx * dx + dz * dz) - target->radius;
  if (dist > attacker.attackRange) return;

  // Zum Ziel drehen. Auf dem Server ist das die Wahrheit, die per Snapshot bei
  // allen anderen ankommt; die eigene Figur hat sich über die Eingabe schon
  // gedreht. Ohne das schlüge man auf dem Bildschirm der Mitspieler seitwärts.
  attacker.yaw = std::atan2(dx, dz);

  applyDamage(attacker, *target,
              attacker.attackStyle == kAttackRanged ? kCombatRanged : kCombatNone);
}

void World::applyDamage(Entity& attacker, Entity& target, uint8_t extraFlags,
                        float damageFactor) {
  float damage =
      computeDamage(attacker.attackDamage * damageFactor, target.defense, rng_.next());

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

/**
 * Der Flächenschlag einer Fertigkeit.
 *
 * Bewusst **ohne** Zielauswahl: das ist der ganze Unterschied zum
 * gewöhnlichen Schlag. Wer wirbelt, trifft, was um ihn herum steht, und ob er
 * jemanden anvisiert hat, spielt keine Rolle.
 *
 * Gemessen wird bis zur Hülle des Ziels, wie überall sonst — ein dickes
 * Monster am Rand des Kreises ist getroffen, ein dünnes an derselben Stelle
 * nicht.
 */
void World::areaAttack(uint32_t id, float radius, float damageFactor) {
  Entity* attacker = find(id);
  if (attacker == nullptr || !isAlive(*attacker)) return;

  int hits = 0;
  // Über Indizes: `applyDamage` legt keine Entities an, aber die Absicht
  // bleibt so auch dann klar, wenn eines Tages etwas im Treffer entsteht.
  for (size_t i = 0; i < entities_.size() && hits < kMaxAreaTargets; ++i) {
    Entity& target = entities_[i];
    if (!isHostile(*attacker, target) || !isAlive(target)) continue;

    const float dx = target.x - attacker->x;
    const float dz = target.z - attacker->z;
    const float dist = std::sqrt(dx * dx + dz * dz) - target.radius;
    if (dist > radius) continue;

    applyDamage(*attacker, target, kCombatSkill, damageFactor);
    ++hits;
  }
}

}  // namespace aur
