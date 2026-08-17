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

  // Sperrzonen zuerst: vier Vergleiche, und sie ersparen im Zweifel alles
  // Teurere darunter.
  if (zoneSperrt(nx, nz, false)) return false;

  /*
   * Die Neigung gilt dem **Gelände**.
   *
   * Wer auf einem schwebenden Felsen steht, geht über eine ebene Scheibe. Was
   * zwanzig Meter darunter für ein Hang ist, hat damit nichts zu tun — ohne
   * diese Unterscheidung wäre ein Felsen über einer Klippe oben unbegehbar.
   */
  bool aufPlattform = false;
  bodenHoehe(nx, nz, e.y, &aufPlattform);
  if (!aufPlattform && terrainSlopeDeg(nx, nz, terrain_) > kMaxWalkableSlopeDeg) return false;

  // Props auflösen: aus jedem überlappenden Kreis herausschieben.
  for (const Collider& c : colliders_) {
    /*
     * Wer über der Oberkante ist, ist darüber hinweg.
     *
     * Vorher galt jeder Kreis über die ganze Höhe der Welt: ein Zaunfeld von
     * anderthalb Metern hielt auch den auf, der zwei Meter darüber flog. Man
     * konnte springen, so hoch man wollte, und blieb am Zaun hängen — die
     * Sorte Fehler, die sich wie ein kaputtes Spiel anfühlt.
     *
     * `e.y` ist die Höhe der **Füsse**. Genau das ist gemeint: darüber ist man
     * hinweg, darunter stösst man an.
     */
    if (e.y >= c.obenY) continue;
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
  // Und in der Sperrzone: ein Prop dicht an ihrer Kante schöbe sonst hinein.
  if (zoneSperrt(nx, nz, false)) return false;
  bodenHoehe(nx, nz, e.y, &aufPlattform);
  if (!aufPlattform && terrainSlopeDeg(nx, nz, terrain_) > kMaxWalkableSlopeDeg) return false;

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

  /*
   * Wer springt, hängt nicht am Boden. Ohne diese Bedingung zöge die
   * waagerechte Bewegung die Figur im selben Schritt wieder herunter, und der
   * Sprung wäre ein Zucken.
   *
   * Und wer über eine Kante läuft, **fällt**, statt hinunterzuspringen: das
   * ist der Unterschied zwischen einem schwebenden Felsen, den man verlassen
   * kann, und einem, der einen unten wieder ausspuckt. Ein Meter Schwelle,
   * damit gewöhnliches Gelände nicht darunter fällt — bei der steilsten noch
   * begehbaren Neigung sind es keine vierzig Zentimeter je Schritt.
   */
  if (!e.airborne) {
    const float boden = bodenHoehe(e.x, e.z, e.y);
    if (boden < e.y - kAbsatzHoehe) {
      e.airborne = true;
      e.vy = 0.0f;
    } else {
      e.y = boden;
    }
  }
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
   * sich dorthin. In der Luft sagt sie, **wie die Figur liegt**: W hebt die
   * Nase und S senkt sie, A und D drehen den Kurs, und der Schub trägt sie in
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
    if (!e.airborne) e.y = bodenHoehe(e.x, e.z, e.y);
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
  /*
   * In der Luft wird **nicht** geschlagen.
   *
   * Die Angriffstaste kommt hier an und wird nicht gelesen — das ist Absicht
   * und nicht das Vergessen von vorhin: wer auf einem Besen sitzt, hat keine
   * Hand frei und keinen Stand. Anvisieren bleibt möglich, denn das ist kein
   * Kampf, sondern eine Frage: wie stark ist das da unten.
   *
   * Im Kern und nicht nur im Client, obwohl der die Taste ohnehin zurückhält:
   * die Regel gehört dorthin, wo sie für alle gilt. Ein Client, der sie nicht
   * kennt, soll damit nichts erreichen.
   */

  /*
   * --- Lage: W/S kippen die Nase, A/D drehen den Kurs.
   *
   * `moveZ` kommt roh vom Steuerknüppel und ist **nicht** in Weltachsen
   * gedreht — in der Luft gibt es keine Richtung, in die man laufen wollte,
   * nur eine Nase, die man hebt oder senkt.
   *
   * Vorzeichen: **W hebt die Nase**, S senkt sie. Wie am Steuerknüppel eines
   * Flugzeugs — drücken heisst hinunter, ziehen heisst hinauf. Hier stand
   * einmal das Gegenteil, weil W am Boden „vorwärts" heisst und vorwärts nach
   * unten zu kippen naheliegend schien; in der Luft liest es sich anders herum.
   */
  e.pitch += moveZ * kFlugNickRate * dt;
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
  const float vorX = e.x;
  const float vorZ = e.z;
  float nx = clampToMap(e.x + std::sin(e.yaw) * cosP * e.tempo * dt, terrain_);
  float nz = clampToMap(e.z + std::cos(e.yaw) * cosP * e.tempo * dt, terrain_);

  /*
   * Sperrzonen gelten auch in der Luft — und zwar mit ihrer eigenen Flagge.
   *
   * Achsenweise nachversucht wie am Boden (`moveWithCollision`): wer schräg
   * gegen eine Sperre fliegt, gleitet an ihr entlang, statt davorzukleben. Ohne
   * das stünde man an der Kartengrenze fest und müsste rückwärts wieder
   * herausdrehen, was auf einem Fluggerät eine halbe Minute dauert.
   */
  if (zoneSperrt(nx, nz, true)) {
    if (!zoneSperrt(nx, e.z, true)) {
      nz = e.z;
    } else if (!zoneSperrt(e.x, nz, true)) {
      nx = e.x;
    } else {
      nx = e.x;
      nz = e.z;
    }
  }
  e.x = nx;
  e.z = nz;

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
  // Aus dem **tatsächlichen** Weg und nicht aus der Absicht: an einer Sperre
  // entlang ist die eine Achse null, und ein Client, der die Absicht gemeldet
  // bekäme, zeichnete eine Figur, die gegen die Wand rennt.
  e.vx = dt > 0.0f ? (e.x - vorX) / dt : 0.0f;
  e.vz = dt > 0.0f ? (e.z - vorZ) / dt : 0.0f;
  // Dieselbe Zahl, mit der eben die Höhe gerechnet wurde — nicht die
  // ungedeckelte: sonst meldete der Kern ein Steigen, das nicht stattfindet.
  e.vy = steigen;
  e.state = e.tempo > 0.05f ? kStateMove : kStateIdle;
}

}  // namespace aur
