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

  // Wer springt, hängt nicht am Boden. Ohne diese Bedingung zöge die
  // waagerechte Bewegung die Figur im selben Schritt wieder herunter, und der
  // Sprung wäre ein Zucken.
  if (!e.airborne) e.y = terrainHeight(e.x, e.z, terrain_);
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

  /*
   * Fliegen ist Fliegen und nicht Laufen in der Luft.
   *
   * Am Boden sagt die Eingabe, **wohin** es gehen soll, und die Figur dreht
   * sich dorthin. In der Luft sagt sie, **wie die Figur liegt**: W und S
   * kippen die Nase, A und D drehen den Kurs, und der Schub trägt sie in
   * genau die Richtung, in die sie zeigt. Deshalb wird die Blickrichtung hier
   * fortgeschrieben statt übernommen — der Wert aus der Eingabe stammt von der
   * Kamera und hätte in der Luft nichts zu suchen.
   */
  if (e.flying) {
    updateFlight(e, moveX, moveZ, buttons, dt);
    return;
  }

  e.yaw = yaw;

  // Der Schlag wird vor der Bewegung ausgelöst: die Vorlaufzeit bremst damit
  // noch im selben Schritt, in dem sie beginnt.
  if ((buttons & kButtonAttack) != 0u) {
    tryStartSwing(e);
  }

  // Der Absprung — mehr nicht. Die Flugbahn rechnet der Tick, und zwar für
  // alle: eine Eingabe kann ausbleiben (verlorenes Paket, Fenster im
  // Hintergrund), und eine Figur, deren Schwerkraft an ihrer Eingabe hängt,
  // bliebe dann in der Luft stehen.
  if ((buttons & kButtonJump) != 0u && !e.airborne) {
    e.vy = kJumpSpeed;
    e.airborne = true;
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
    if (!e.airborne) e.y = terrainHeight(e.x, e.z, terrain_);
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

/**
 * Ein Schritt in der Luft: Lage ändern, Schub schalten, sich bewegen.
 *
 * Die Reihenfolge ist die eines Fluggeräts und nicht die einer Figur: erst
 * liegt man irgendwie, dann trägt einen der Schub dorthin. Wer sie umdreht,
 * fliegt einen Tick lang in die alte Richtung — bei einer engen Kurve sieht
 * man das.
 */
void World::updateFlight(Entity& e, float moveX, float moveZ, uint32_t buttons, float dt) {
  // --- Lage: W/S kippen die Nase, A/D drehen den Kurs.
  //
  // `moveZ` kommt roh vom Steuerknüppel und ist **nicht** in Weltachsen
  // gedreht — in der Luft gibt es keine Richtung, in die man laufen wollte,
  // nur eine Nase, die man hebt oder senkt.
  e.pitch -= moveZ * kFlugNickRate * dt;
  if (e.pitch > kFlugNickMax) e.pitch = kFlugNickMax;
  if (e.pitch < -kFlugNickMax) e.pitch = -kFlugNickMax;
  /*
   * Vorzeichen: D dreht nach rechts.
   *
   * Die Blickrichtung zeigt entlang (sin yaw, cos yaw), und bildschirmrechts
   * liegt damit bei (−cos yaw, sin yaw) — ein **kleinerer** Winkel. Wer hier
   * addiert, dreht mit D nach links, und das merkt man erst in der Luft.
   */
  e.yaw -= moveX * kFlugGierRate * dt;

  // --- Schub: das Bit sagt, ob er läuft.
  //
  // Umgeschaltet wird an der Tastatur — hier steht nur das Ergebnis. Warum,
  // steht bei `kButtonSchub`: nachgespielte Eingaben dürfen nichts kippen.
  e.schub = (buttons & kButtonSchub) != 0u;

  // --- Tempo: anfahren und ausrollen, beides über dieselbe Rampe.
  const float ziel = e.schub ? e.flightSpeed : 0.0f;
  const float schritt = (e.flightSpeed / kFlugRampeSek) * dt;
  if (e.tempo < ziel) e.tempo = std::min(ziel, e.tempo + schritt);
  else if (e.tempo > ziel) e.tempo = std::max(ziel, e.tempo - schritt);

  const float cosP = std::cos(e.pitch);
  e.x = clampToMap(e.x + std::sin(e.yaw) * cosP * e.tempo * dt, terrain_);
  e.z = clampToMap(e.z + std::cos(e.yaw) * cosP * e.tempo * dt, terrain_);

  /*
   * Steigen ist gedeckelt — daher kommt der Unterschied zwischen den Geräten.
   *
   * Ohne die Grenze wäre `steig` aus der Inhaltsdatei eine Zahl, die nirgends
   * mehr ankommt: die Höhe folgte allein aus Nase und Tempo, und das schnellste
   * Gerät wäre zugleich das beste beim Steigen. Mit ihr stimmt, was am
   * Sturmbrett steht — schnell geradeaus, träge beim Steigen.
   *
   * Nur nach **oben** gedeckelt: hinunter hilft die Schwerkraft, und ein
   * Sturzflug, der sich an dieselbe Zahl hält wie das Steigen, wäre keiner.
   */
  float steigen = std::sin(e.pitch) * e.tempo;
  if (steigen > e.climbSpeed) steigen = e.climbSpeed;
  e.y += steigen * dt;

  // Der Tick begrenzt gleich noch auf Boden und Decke; hier steht nur die
  // Bewegung. `vy` ist dabei reine Auskunft für den Client — die Höhe rechnet
  // diese Zeile, nicht die Schwerkraft.
  e.vx = std::sin(e.yaw) * cosP * e.tempo;
  e.vz = std::cos(e.yaw) * cosP * e.tempo;
  // Dieselbe Zahl, mit der eben die Höhe gerechnet wurde — nicht die
  // ungedeckelte: sonst meldete der Kern ein Steigen, das nicht stattfindet.
  e.vy = steigen;
  e.state = e.tempo > 0.05f ? kStateMove : kStateIdle;
}

}  // namespace aur
