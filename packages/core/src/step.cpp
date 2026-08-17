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

  /*
   * Fliegen ist kein langer Sprung.
   *
   * Keine Schwerkraft, kein Landen — wer die Tasten loslässt, steht in der
   * Luft. Nach unten begrenzt das Gelände (samt einem Handbreit Luft darunter,
   * damit die Figur nicht im Hang steckt), nach oben die Decke des Geräts.
   */
  if (e.flying && isAlive(e)) {
    // Die Höhe rechnet `updateFlight` aus Lage und Schub; hier wird nur noch
    // begrenzt. Zwei Stellen, die dieselbe Höhe fortschreiben, wären genau die
    // doppelte Buchführung, die in diesem Kern nirgends steht.
    // Über `bodenHoehe` und nicht über das Gelände: ein schwebender Felsen ist
    // Boden, sobald man über ihm ist. Damit fliegt niemand durch ihn hindurch,
    // und wer darüber absteigt, landet oben statt zwanzig Meter tiefer.
    const float boden = bodenHoehe(e.x, e.z, e.y);
    const float unten = boden + kFlugMindesthoehe;
    const float oben = boden + e.ceiling;
    if (e.y < unten) {
      e.y = unten;
      if (e.vy < 0.0f) e.vy = 0.0f;
    } else if (e.y > oben) {
      e.y = oben;
      if (e.vy > 0.0f) e.vy = 0.0f;
    }
    return;
  }

  if (!isAlive(e)) {
    // Wer in der Luft stirbt, fällt nicht weiter — der Körper bleibt liegen,
    // wo der Kern ihn zuletzt hatte. Alles andere wäre eine Leiche, die noch
    // eine Sekunde lang durch die Landschaft segelt.
    e.airborne = false;
    e.vy = 0.0f;
    e.y = bodenHoehe(e.x, e.z, e.y);
    return;
  }

  /*
   * Gefragt wird von der Höhe **vor** dem Schritt aus.
   *
   * Ein Fallender überschiesst die Fläche innerhalb eines Schritts: aus dreissig
   * Metern ist er dort schon über zwanzig Meter je Sekunde schnell, also gut
   * einen Meter je Tick. Fragt man von der Höhe **nach** dem Schritt, liegt die
   * Fläche plötzlich über einem, `bodenHoehe` lässt sie deshalb weg — und die
   * Figur fällt durch den schwebenden Felsen hindurch bis auf das Gelände.
   * Genau das war zu sehen.
   */
  const float vorY = e.y;
  e.y += e.vy * dt;
  e.vy -= kGravity * dt;

  const float boden = bodenHoehe(e.x, e.z, vorY);
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
    if (!isCombatant(a) || !isAlive(a)) continue;

    for (size_t j = i + 1; j < entities_.size(); ++j) {
      Entity& b = entities_[j];
      if (!isCombatant(b) || !isAlive(b)) continue;

      /*
       * Nur wer sich auch in der **Höhe** überschneidet, steht im Weg.
       *
       * Diese Zeile fehlte, und die Folge war grotesk: ein Keiler unter einem
       * schwebenden Felsen schob die Figur, die sechsundzwanzig Meter darüber
       * stand, über die Fläche — Schritt für Schritt, bis sie über die Kante
       * fiel. Auf der Karte standen die beiden ja ineinander.
       *
       * Dieselbe Rechnung wie in `abstandRaum`: jeder reicht von `y` bis
       * `y + height`, und überschneiden sich die Bereiche nicht, geht der eine
       * über oder unter dem anderen hindurch. Wer jemandem auf dem Kopf steht,
       * schiebt ihn damit auch nicht mehr zur Seite.
       */
      if (std::max(a.y, b.y) >= std::min(a.y + a.height, b.y + b.height)) continue;

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
      if (!a.airborne) a.y = bodenHoehe(a.x, a.z, a.y);
      if (!b.airborne) b.y = bodenHoehe(b.x, b.z, b.y);
    }
  }
}

/*
 * Wer ist im Kampf?
 *
 * **Ein Spieler ist im Kampf, solange irgendein Monster ihn jagt.** Das ist
 * die ganze Regel, und sie ist absichtlich so kurz.
 *
 * Vorher hing es an drei Merkern der eigenen Figur — Trefferpause, laufender
 * Schlag, laufende Abklingzeit. Die sind nach dem letzten Schlag in einer
 * Sekunde alle abgelaufen, und wer neben einem Keiler stand, der ihn gerade
 * anfiel, heilte munter weiter, solange er selbst nicht zuschlug. „Im Kampf"
 * heisst aber nicht „ich schlage gerade", sondern „mir will jemand ans
 * Leder" — und das steht am Verfolger und nicht am Verfolgten.
 *
 * Für ein Monster bleibt es umgekehrt: es ist im Kampf, wenn es selbst ein
 * Ziel hat. Ein Monster klickt niemanden versehentlich an.
 */
bool World::inCombat(const Entity& e) const {
  if (e.type == kEntityMonster) return e.targetId != 0;

  for (const Entity& anderer : entities_) {
    if (anderer.type != kEntityMonster || !isAlive(anderer)) continue;
    if (anderer.targetId == e.id) return true;
  }
  return false;
}

void World::regenerate(float dt) {
  for (Entity& e : entities_) {
    if (!isAlive(e) || !isCombatant(e)) continue;
    // Ohne Eigenschaft keine Regeneration. Der häufigste Fall, und er kostet
    // damit auch nichts — die Suche nach Verfolgern läuft gar nicht erst an.
    if (e.hpRegen <= 0.0f && e.mpRegen <= 0.0f) continue;
    if (inCombat(e)) continue;

    if (e.hp < e.maxHp) e.hp = std::min(e.maxHp, e.hp + e.hpRegen * dt);
    if (e.mp < e.maxMp) e.mp = std::min(e.maxMp, e.mp + e.mpRegen * dt);
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
      const float respawnSec = spawner != nullptr ? spawner->respawnSec : kDefaultRespawnSec;
      // Gestreut um den Vorgabewert — siehe `kRespawnSpread`.
      const float gestreut =
          respawnSec * (1.0f - kRespawnSpread + rng_.next() * kRespawnSpread * 2.0f);
      uint32_t delay = static_cast<uint32_t>(gestreut * static_cast<float>(kTickRate));
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
    else if (entities_[i].type == kEntityPet) updatePetAi(entities_[i], dt);
  }

  resolveOverlaps();
  regenerate(dt);
  handleRespawns();
}

}  // namespace aur
