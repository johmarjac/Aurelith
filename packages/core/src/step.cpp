// Der Tick.
//
// Eine Funktion, zwei Aufrufer: der Server treibt damit die autoritative Welt,
// der Client dieselbe Funktion über eine Welt, die nur seine eigene Figur
// enthält. Beide führen dieselbe wasm-Binärdatei aus.
//
// Die Reihenfolge ist Vertrag:
//   1. Zeitgeber herunterzählen, fällige Schläge auflösen, Sprünge fortführen
//   2. Monster entscheiden
//   3. Überlappungen auflösen
//   4. Regeneration
//   5. Respawn

#include <algorithm>

#include "aurelith/world.hpp"

namespace aur {

void World::advanceTimers(Entity& e, float dt) {
  if (e.attackCooldown > 0.0f) e.attackCooldown = std::max(0.0f, e.attackCooldown - dt);
  if (e.hitStun > 0.0f) e.hitStun = std::max(0.0f, e.hitStun - dt);

  if (e.swingTimer >= 0.0f) {
    e.swingTimer -= dt;
    if (e.swingTimer < 0.0f) {
      e.swingTimer = -1.0f;
      resolveSwing(e);
      if (e.state == kStateAttack) e.state = kStateIdle;
    }
  }
}

/**
 * Die Flugbahn eines Sprungs — je Tick, für jeden, der in der Luft ist.
 *
 * Im Tick und nicht in `applyInput`: der Tick läuft immer, eine Eingabe nicht.
 * Bliebe die Schwerkraft an der Eingabe hängen, stünde eine Figur mit
 * abgerissener Verbindung im Bild der anderen für immer in der Luft.
 *
 * Gelandet wird, sobald der Boden erreicht ist — und danach gilt wieder die
 * Höhe des Geländes, auch wenn es sich unter der Figur geändert hat.
 */
void World::advanceJump(Entity& e, float dt) {
  if (!e.airborne) return;

  if (!isAlive(e)) {
    // Wer in der Luft stirbt, fällt nicht weiter — der Körper bleibt liegen,
    // wo der Kern ihn zuletzt hatte. Alles andere wäre eine Leiche, die noch
    // eine Sekunde lang durch die Landschaft segelt.
    e.airborne = false;
    e.vy = 0.0f;
    e.y = terrainHeight(e.x, e.z, terrain_);
    return;
  }

  e.y += e.vy * dt;
  e.vy -= kGravity * dt;

  const float boden = terrainHeight(e.x, e.z, terrain_);
  if (e.y <= boden) {
    e.y = boden;
    e.vy = 0.0f;
    e.airborne = false;
  }
}

void World::resolveOverlaps() {
  if (entities_.size() > static_cast<size_t>(kSeparationEntityLimit)) return;

  // Weiche Trennung zweier sich überlappender Entities. Verhindert Stapel.
  for (size_t i = 0; i < entities_.size(); ++i) {
    Entity& a = entities_[i];
    if (a.type == kEntityNpc || !isAlive(a)) continue;

    for (size_t j = i + 1; j < entities_.size(); ++j) {
      Entity& b = entities_[j];
      if (b.type == kEntityNpc || !isAlive(b)) continue;

      const float dx = b.x - a.x;
      const float dz = b.z - a.z;
      const float minDist = a.radius + b.radius;
      const float d2 = dx * dx + dz * dz;
      if (d2 >= minDist * minDist || d2 < 1e-8f) continue;

      const float d = std::sqrt(d2);
      const float push = (minDist - d) * 0.5f;
      const float ux = dx / d;
      const float uz = dz / d;

      a.x = clampToMap(a.x - ux * push, terrain_);
      a.z = clampToMap(a.z - uz * push, terrain_);
      b.x = clampToMap(b.x + ux * push, terrain_);
      b.z = clampToMap(b.z + uz * push, terrain_);
      // Wer springt, behält seine Höhe: die Trennung schiebt waagerecht.
      if (!a.airborne) a.y = terrainHeight(a.x, a.z, terrain_);
      if (!b.airborne) b.y = terrainHeight(b.x, b.z, terrain_);
    }
  }
}

void World::regenerate(float dt) {
  for (Entity& e : entities_) {
    if (!isAlive(e) || e.type == kEntityNpc) continue;
    // Im Kampf heilt niemand. Was „im Kampf" heisst, unterscheidet sich seit
    // dem Zielsystem nach Art des Wesens: ein Monster mit Ziel *jagt*, ein
    // Spieler mit Ziel hat nur jemanden angeklickt. Die Auswahl bleibt nach
    // dem Kampf stehen — hinge die Regeneration daran, heilte ein Spieler
    // nie wieder, bis er irgendwo ins Leere klickt.
    const bool inCombat = e.hitStun > 0.0f || e.swingTimer >= 0.0f ||
                          e.attackCooldown > 0.0f ||
                          (e.type == kEntityMonster && e.targetId != 0);
    if (inCombat) continue;

    if (e.hp < e.maxHp) e.hp = std::min(e.maxHp, e.hp + e.maxHp * kOutOfCombatRegen * dt);
    if (e.mp < e.maxMp) e.mp = std::min(e.maxMp, e.mp + e.maxMp * kOutOfCombatRegen * dt);
  }
}

void World::respawnMonster(Entity& e) {
  const Spawner* spawner =
      e.spawnerIndex < spawners_.size() ? &spawners_[e.spawnerIndex] : nullptr;

  // Etwas versetzt zum Ursprung, damit ein leergeräumter Spawner nicht jedes
  // Mal exakt dasselbe Bild ergibt.
  if (spawner != nullptr) {
    const float angle = rng_.next() * kTau;
    const float r = std::sqrt(rng_.next()) * spawner->radius;
    e.homeX = spawner->x + std::cos(angle) * r;
    e.homeZ = spawner->z + std::sin(angle) * r;
  }

  e.x = clampToMap(e.homeX, terrain_);
  e.z = clampToMap(e.homeZ, terrain_);
  e.y = terrainHeight(e.x, e.z, terrain_);
  e.yaw = rng_.next() * kTau;
  e.hp = e.maxHp;
  e.mp = e.maxMp;
  e.state = kStateIdle;
  e.targetId = 0;
  e.airborne = false;
  e.vy = 0.0f;
  // Frisch erschienen wird erst einmal gestanden — sonst setzt sich ein
  // ganzer Schwung gleichzeitig in Bewegung, weil alle im selben Takt
  // erscheinen. Die Pause ist unterschiedlich lang, aus demselben Grund: wer
  // zusammen erlegt wurde, erscheint zusammen wieder.
  e.wanderWalking = false;
  e.wanderTimer = rng_.next() * kWanderRest;
  e.swingTimer = -1.0f;
  e.attackCooldown = 0.0f;
  e.hitStun = 0.0f;
  e.respawnTick = 0;
  e.vx = 0.0f;
  e.vz = 0.0f;

  EventView ev{};
  ev.type = kEventSpawn;
  ev.a = e.id;
  ev.x = e.x;
  ev.y = e.y;
  ev.z = e.z;
  events_.push_back(ev);
}

void World::handleRespawns() {
  for (Entity& e : entities_) {
    if (e.type != kEntityMonster || e.state != kStateDead) continue;

    // Erster Tick nach dem Tod: Zeitpunkt festlegen.
    if (e.respawnTick == 0) {
      const Spawner* spawner =
          e.spawnerIndex < spawners_.size() ? &spawners_[e.spawnerIndex] : nullptr;
      const float respawnSec = spawner != nullptr ? spawner->respawnSec : 12.0f;
      uint32_t delay = static_cast<uint32_t>(respawnSec * static_cast<float>(kTickRate));
      if (delay < 1u) delay = 1u;
      e.respawnTick = tick_ + delay;
      continue;
    }

    if (tick_ < e.respawnTick) continue;
    respawnMonster(e);
  }
}

void World::step(float dt) {
  ++tick_;

  for (Entity& e : entities_) {
    advanceTimers(e, dt);
    advanceJump(e, dt);
  }

  for (size_t i = 0; i < entities_.size(); ++i) {
    if (entities_[i].type == kEntityMonster) updateMonsterAi(entities_[i], dt);
  }

  resolveOverlaps();
  regenerate(dt);
  handleRespawns();
}

}  // namespace aur
