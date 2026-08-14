// Natives Testprogramm für den Kern.
//
// Kein Testframework — das wäre eine Abhängigkeit für etwas, das mit zwanzig
// Zeilen auskommt. Wichtig ist nur, dass diese Prüfungen ohne Emscripten
// laufen: sie geben in Sekunden Rückmeldung, wo der wasm-Weg Minuten braucht.

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <utility>

#include "aurelith/world.hpp"

namespace {

int g_failures = 0;
int g_checks = 0;

void check(bool ok, const char* what) {
  ++g_checks;
  if (!ok) {
    ++g_failures;
    std::printf("  FEHLGESCHLAGEN: %s\n", what);
  }
}

void checkNear(float actual, float expected, float tolerance, const char* what) {
  ++g_checks;
  if (std::fabs(actual - expected) > tolerance) {
    ++g_failures;
    std::printf("  FEHLGESCHLAGEN: %s (ist %.4f, erwartet %.4f ± %.4f)\n", what, actual, expected,
                tolerance);
  }
}

aur::TerrainDef flatTerrain() {
  aur::TerrainDef t;
  t.size = 512.0f;
  t.cellSize = 4.0f;
  t.seed = 1234u;
  // Höhenskala Null macht das Gelände eben — so testet die Bewegung sich
  // selbst und nicht das Höhenfeld.
  t.heightScale = 0.0f;
  t.featureScale = 0.012f;
  return t;
}

uint32_t registerTestMob(aur::MobRegistry& mobs, bool aggressive) {
  aur::MobDef def;
  def.maxHp = 100.0f;
  def.attackDamage = 10.0f;
  def.defense = 0.0f;
  def.moveSpeed = 4.0f;
  def.aggroRange = aggressive ? 15.0f : 0.0f;
  def.leashRange = 50.0f;
  def.attackRange = 2.0f;
  def.attackCooldownSec = 1.0f;
  def.attackWindupSec = 0.2f;
  def.radius = 0.6f;
  def.height = 1.6f;
  def.expReward = 25.0f;
  def.goldReward = 5.0f;
  def.level = 1;
  def.aggressive = aggressive ? 1u : 0u;
  return mobs.add(def);
}

aur::PlayerSpawn testPlayer(uint32_t id, float x, float z) {
  aur::PlayerSpawn p;
  p.id = id;
  p.level = 1;
  p.x = x;
  p.z = z;
  p.yaw = 0.0f;
  p.maxHp = 200.0f;
  p.hp = 200.0f;
  p.maxMp = 50.0f;
  p.mp = 50.0f;
  p.attackDamage = 20.0f;
  p.defense = 5.0f;
  p.moveSpeed = 6.0f;
  p.attackRange = 3.0f;
  p.attackCooldownSec = 0.62f;
  p.attackWindupSec = 0.15f;
  p.radius = 0.45f;
  p.height = 1.8f;
  return p;
}

// --- Einzelne Prüfungen ----------------------------------------------------

void testMovement() {
  std::printf("Bewegung\n");
  aur::MobRegistry mobs;
  aur::World world(1u, flatTerrain(), &mobs);
  world.spawnPlayer(testPlayer(1, 0.0f, 0.0f));

  // Eine Sekunde geradeaus bei Tempo 6 sollte 6 Einheiten ergeben.
  for (int i = 0; i < aur::kTickRate; ++i) {
    world.applyInput(1, 0.0f, 1.0f, 0.0f, 0u, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  const aur::Entity* p = world.find(1);
  check(p != nullptr, "Spieler existiert");
  checkNear(p->z, 6.0f, 0.15f, "eine Sekunde Lauf ergibt sechs Einheiten");
  checkNear(p->x, 0.0f, 0.001f, "keine seitliche Drift");

  // Diagonale Eingabe darf nicht schneller sein als gerade Eingabe.
  aur::World world2(1u, flatTerrain(), &mobs);
  world2.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
  for (int i = 0; i < aur::kTickRate; ++i) {
    world2.applyInput(1, 1.0f, 1.0f, 0.0f, 0u, aur::kTickSeconds);
    world2.step(aur::kTickSeconds);
  }
  const aur::Entity* p2 = world2.find(1);
  const float travelled = std::sqrt(p2->x * p2->x + p2->z * p2->z);
  checkNear(travelled, 6.0f, 0.15f, "diagonal ist nicht schneller als gerade");
}

void testCollider() {
  std::printf("Kollision mit Props\n");
  aur::MobRegistry mobs;
  aur::World world(1u, flatTerrain(), &mobs);
  world.addCollider(0.0f, 5.0f, 2.0f);
  world.spawnPlayer(testPlayer(1, 0.0f, 0.0f));

  for (int i = 0; i < aur::kTickRate * 2; ++i) {
    world.applyInput(1, 0.0f, 1.0f, 0.0f, 0u, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  const aur::Entity* p = world.find(1);
  const float d = aur::dist2D(p->x, p->z, 0.0f, 5.0f);
  check(d >= 2.0f + 0.45f - 0.05f, "Spieler steckt nicht im Prop");
}

void testSwingHitsOnlyTarget() {
  std::printf("Ein Schlag trifft das anvisierte Ziel — und nur das\n");
  aur::MobRegistry mobs;
  const uint32_t mobIndex = registerTestMob(mobs, false);
  aur::World world(7u, flatTerrain(), &mobs);
  world.spawnPlayer(testPlayer(1, 0.0f, 0.0f));

  // Drei Ziele dicht vor der Figur — alle in Reichweite, alle im Blickfeld.
  // Genau der Aufbau, der früher alle drei auf einmal getroffen hätte.
  world.spawnMob(10, mobIndex, -1.2f, 2.0f, -1, aur::kNoSpawner);
  world.spawnMob(11, mobIndex, 0.0f, 2.2f, -1, aur::kNoSpawner);
  world.spawnMob(12, mobIndex, 1.2f, 2.0f, -1, aur::kNoSpawner);

  world.setTarget(1, 11);
  world.applyInput(1, 0.0f, 0.0f, 0.0f, aur::kButtonAttack, aur::kTickSeconds);
  for (int i = 0; i < 6; ++i) {
    world.step(aur::kTickSeconds);
  }

  check(world.find(11)->hp < 100.0f, "das anvisierte Ziel nimmt Schaden");
  check(world.find(10)->hp == 100.0f, "der Nachbar links bleibt unversehrt");
  check(world.find(12)->hp == 100.0f, "der Nachbar rechts auch");

  // Ein friedliches Monster schlägt nach einem Treffer zurück.
  check(world.find(11)->targetId == 1, "getroffenes Monster nimmt den Angreifer ins Visier");

  // Die Blickrichtung entscheidet nichts mehr: wer sein Ziel anvisiert hat,
  // trifft es auch mit dem Rücken zu ihm — der Kern dreht die Figur beim
  // Auflösen dorthin. Ohne diese Prüfung wäre nicht zu sehen, ob der Kegel
  // wirklich weg ist oder nur weit geworden.
  aur::World hinten(8u, flatTerrain(), &mobs);
  hinten.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
  hinten.spawnMob(10, mobIndex, 0.0f, 2.0f, -1, aur::kNoSpawner);
  hinten.setTarget(1, 10);
  hinten.applyInput(1, 0.0f, 0.0f, aur::kPi, aur::kButtonAttack, aur::kTickSeconds);
  for (int i = 0; i < 6; ++i) hinten.step(aur::kTickSeconds);
  check(hinten.find(10)->hp < 100.0f, "auch mit abgewandtem Blick");
  checkNear(hinten.find(1)->yaw, 0.0f, 0.01f, "und die Figur dreht sich zum Ziel");

  // Ohne Auswahl geht der Schlag ins Leere — der Vorlauf läuft trotzdem an,
  // sonst rechnete die Vorhersage im Client ein anderes Tempo als der Server.
  aur::World blind(9u, flatTerrain(), &mobs);
  blind.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
  blind.spawnMob(10, mobIndex, 0.0f, 2.0f, -1, aur::kNoSpawner);
  blind.applyInput(1, 0.0f, 0.0f, 0.0f, aur::kButtonAttack, aur::kTickSeconds);
  check(blind.find(1)->swingTimer >= 0.0f, "der Schlag beginnt auch ohne Auswahl");
  for (int i = 0; i < 6; ++i) blind.step(aur::kTickSeconds);
  check(blind.find(10)->hp == 100.0f, "trifft aber niemanden");

  // Und ausser Reichweite ebenfalls nicht: die Entfernung wird beim Auflösen
  // geprüft und nicht beim Beginn — wer während des Vorlaufs wegläuft, ist
  // davongekommen.
  aur::World weit(10u, flatTerrain(), &mobs);
  weit.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
  weit.spawnMob(10, mobIndex, 0.0f, 9.0f, -1, aur::kNoSpawner);
  weit.setTarget(1, 10);
  weit.applyInput(1, 0.0f, 0.0f, 0.0f, aur::kButtonAttack, aur::kTickSeconds);
  for (int i = 0; i < 6; ++i) weit.step(aur::kTickSeconds);
  check(weit.find(10)->hp == 100.0f, "ein Ziel ausser Reichweite bleibt unversehrt");
}

void testJump() {
  std::printf("Springen\n");
  aur::MobRegistry mobs;
  aur::World world(17u, flatTerrain(), &mobs);
  world.spawnPlayer(testPlayer(1, 0.0f, 0.0f));

  const aur::Entity* p = world.find(1);
  const float boden = p->y;

  // Ein Tick mit gedrückter Sprungtaste: die Figur muss abheben.
  world.applyInput(1, 0.0f, 0.0f, 0.0f, aur::kButtonJump, aur::kTickSeconds);
  world.step(aur::kTickSeconds);
  check(p->y > boden, "die Figur hebt ab");
  check(p->airborne, "und gilt als in der Luft");

  // Die Taste bleibt gedrückt. In der Luft darf daraus **kein** zweiter Stoss
  // werden — sonst stiege die Figur, solange jemand die Taste hält.
  //
  // Geprüft wird an der senkrechten Geschwindigkeit und nicht an der Höhe: sie
  // fällt unter Schwerkraft stetig, und jeder Stoss wäre ein Sprung nach oben
  // in dieser Zahl. Über die Höhe wäre derselbe Fehler nicht von einem zweiten
  // Sprung *nach der Landung* zu unterscheiden — und der ist erlaubt.
  float hoechste = p->y;
  float vorigeSteigung = p->vy;
  bool zweiterStoss = false;
  for (int i = 0; i < 12; ++i) {
    world.applyInput(1, 0.0f, 0.0f, 0.0f, aur::kButtonJump, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
    if (!p->airborne) break;
    if (p->vy > vorigeSteigung + 0.01f) zweiterStoss = true;
    vorigeSteigung = p->vy;
    hoechste = std::max(hoechste, p->y);
  }
  check(!zweiterStoss, "eine gehaltene Taste stösst in der Luft nicht nach");

  // Scheitelhöhe: v²/(2g) bei 7,2 und 22 sind 1,18 Meter. Grosszügige Grenzen,
  // weil die Schrittweite den Scheitel nicht genau trifft — aber eng genug,
  // dass ein Faktor daneben auffällt.
  check(hoechste - boden > 0.8f && hoechste - boden < 1.5f,
        "die Sprunghöhe liegt im erwarteten Bereich");

  // Und am Ende steht sie wieder am Boden, mit stehender Höhe.
  for (int i = 0; i < aur::kTickRate; ++i) world.step(aur::kTickSeconds);
  check(!p->airborne, "sie landet wieder");
  checkNear(p->y, boden, 0.001f, "und steht auf derselben Höhe wie vorher");

  // Ohne Sprungtaste passiert nichts. Die Gegenprobe zur ersten Zeile: ohne
  // sie prüfte sie nur, dass die Figur überhaupt eine Höhe hat.
  aur::World ruhig(18u, flatTerrain(), &mobs);
  ruhig.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
  const aur::Entity* q = ruhig.find(1);
  const float ruheBoden = q->y;
  for (int i = 0; i < 10; ++i) {
    ruhig.applyInput(1, 0.0f, 1.0f, 0.0f, 0u, aur::kTickSeconds);
    ruhig.step(aur::kTickSeconds);
  }
  check(!q->airborne, "ohne Sprungtaste bleibt sie am Boden");
  checkNear(q->y, ruheBoden, 0.001f, "auch beim Laufen");

  // Waagerecht bewegen darf man sich im Sprung — sonst bliebe die Figur in der
  // Luft stehen, sobald man springt.
  aur::World weit(19u, flatTerrain(), &mobs);
  weit.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
  const aur::Entity* r = weit.find(1);
  weit.applyInput(1, 0.0f, 1.0f, 0.0f, aur::kButtonJump, aur::kTickSeconds);
  weit.step(aur::kTickSeconds);
  const float z0 = r->z;
  for (int i = 0; i < 6; ++i) {
    weit.applyInput(1, 0.0f, 1.0f, 0.0f, 0u, aur::kTickSeconds);
    weit.step(aur::kTickSeconds);
  }
  check(r->z > z0 + 0.5f, "im Sprung kommt man vorwärts");
}

void testWindupDelaysDamage() {
  std::printf("Vorlaufzeit verzögert den Schaden\n");
  aur::MobRegistry mobs;
  const uint32_t mobIndex = registerTestMob(mobs, false);
  aur::World world(3u, flatTerrain(), &mobs);
  world.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
  world.spawnMob(10, mobIndex, 0.0f, 2.0f, -1, aur::kNoSpawner);
  world.setTarget(1, 10);

  world.applyInput(1, 0.0f, 0.0f, 0.0f, aur::kButtonAttack, aur::kTickSeconds);
  check(world.find(1)->swingTimer >= 0.0f, "Schlag läuft an");
  check(world.find(10)->hp == 100.0f, "noch kein Schaden im Moment des Auslösens");

  // Vorlaufzeit 0,15 s bei 50 ms Tick: nach zwei Ticks noch nichts, nach vier
  // ist der Treffer durch.
  world.step(aur::kTickSeconds);
  world.step(aur::kTickSeconds);
  check(world.find(10)->hp == 100.0f, "während der Vorlaufzeit kein Schaden");

  world.step(aur::kTickSeconds);
  world.step(aur::kTickSeconds);
  check(world.find(10)->hp < 100.0f, "nach der Vorlaufzeit trifft der Schlag");
}

void testAggroAndLeash() {
  std::printf("Wahrnehmung und Leine\n");
  aur::MobRegistry mobs;
  const uint32_t aggressive = registerTestMob(mobs, true);
  aur::World world(11u, flatTerrain(), &mobs);
  world.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
  world.spawnMob(10, aggressive, 0.0f, 10.0f, -1, aur::kNoSpawner);

  world.step(aur::kTickSeconds);
  check(world.find(10)->targetId == 1, "Monster nimmt Spieler in Reichweite wahr");

  const float startDist = aur::dist2D(world.find(10)->x, world.find(10)->z, 0.0f, 0.0f);
  for (int i = 0; i < aur::kTickRate; ++i) world.step(aur::kTickSeconds);
  const float endDist = aur::dist2D(world.find(10)->x, world.find(10)->z, 0.0f, 0.0f);
  check(endDist < startDist, "Monster nähert sich dem Ziel");
}

void testDeathAndRespawn() {
  std::printf("Tod und Wiederkehr\n");
  aur::MobRegistry mobs;
  const uint32_t mobIndex = registerTestMob(mobs, false);
  aur::World world(5u, flatTerrain(), &mobs);

  aur::Spawner spawner;
  spawner.x = 0.0f;
  spawner.z = 3.0f;
  spawner.radius = 1.0f;
  spawner.respawnSec = 1.0f;
  spawner.mobIndex = mobIndex;
  const uint32_t spawnerIndex = world.addSpawner(spawner);

  aur::PlayerSpawn strong = testPlayer(1, 0.0f, 0.0f);
  strong.attackDamage = 500.0f;
  world.spawnPlayer(strong);
  world.spawnMob(10, mobIndex, 0.0f, 2.0f, -1, spawnerIndex);
  world.setTarget(1, 10);

  bool sawDeath = false;
  bool sawExp = false;
  for (int i = 0; i < 8; ++i) {
    world.applyInput(1, 0.0f, 0.0f, 0.0f, aur::kButtonAttack, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
    for (size_t e = 0; e < world.eventCount(); ++e) {
      const aur::EventView& ev = world.events()[e];
      if (ev.type == aur::kEventDeath) sawDeath = true;
      if (ev.type == aur::kEventExp) sawExp = true;
    }
    world.clearEvents();
  }
  check(sawDeath, "Todesereignis gemeldet");
  check(sawExp, "Erfahrungsereignis gemeldet");
  check(world.find(10)->state == aur::kStateDead, "Monster ist tot");

  // Respawn nach einer Sekunde — plus Reserve für die Streuung: die Zeit
  // schwankt um ±20 %, im schlechtesten Fall sind es also 1,2 Sekunden.
  for (int i = 0; i < aur::kTickRate * 2; ++i) world.step(aur::kTickSeconds);
  check(world.find(10)->state != aur::kStateDead, "Monster kehrt zurück");
  checkNear(world.find(10)->hp, 100.0f, 0.01f, "Rückkehr mit vollen Lebenspunkten");
}

void testDeterminism() {
  std::printf("Reproduzierbarkeit\n");
  aur::MobRegistry mobs;
  const uint32_t mobIndex = registerTestMob(mobs, true);

  auto run = [&](float* outX, float* outZ, float* outHp) {
    aur::World world(42u, flatTerrain(), &mobs);
    world.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
    for (int i = 0; i < 5; ++i) {
      world.spawnMob(100 + static_cast<uint32_t>(i), mobIndex, static_cast<float>(i) - 2.0f, 4.0f,
                     -1, aur::kNoSpawner);
    }
    world.setTarget(1, 102);
    for (int i = 0; i < 200; ++i) {
      const float phase = static_cast<float>(i) * 0.05f;
      world.applyInput(1, std::sin(phase), std::cos(phase), phase, aur::kButtonAttack,
                       aur::kTickSeconds);
      world.step(aur::kTickSeconds);
      world.clearEvents();
    }
    const aur::Entity* p = world.find(1);
    *outX = p->x;
    *outZ = p->z;
    *outHp = p->hp;
  };

  float x1, z1, hp1, x2, z2, hp2;
  run(&x1, &z1, &hp1);
  run(&x2, &z2, &hp2);

  // Bitgleich, nicht nur ähnlich — das ist die Eigenschaft, auf der die
  // Prediction im Client aufsetzt.
  check(x1 == x2 && z1 == z2 && hp1 == hp2, "zwei gleiche Läufe ergeben denselben Zustand");
}

void testEntityViewLayout() {
  std::printf("Layout der Sichtstrukturen\n");
  check(sizeof(aur::EntityView) == 56, "EntityView ist 56 Byte groß");
  check(sizeof(aur::EventView) == 32, "EventView ist 32 Byte groß");

  aur::MobRegistry mobs;
  aur::World world(1u, flatTerrain(), &mobs);
  world.spawnPlayer(testPlayer(7, 1.5f, -2.5f));
  const aur::EntityView* view = world.buildView();
  check(world.viewCount() == 1, "genau ein Eintrag in der Sicht");
  check(view != nullptr && view[0].id == 7u, "Kennung landet in der Sicht");
  checkNear(view[0].x, 1.5f, 0.001f, "Position landet in der Sicht");
}

// ---------------------------------------------------------------------------
// Von Hand geformte Höhen
// ---------------------------------------------------------------------------

void testSculpt() {
  std::printf("Geformtes Gelände\n");

  aur::MobRegistry mobs;
  aur::World world(1u, flatTerrain(), &mobs);

  checkNear(world.heightAt(0.0f, 0.0f), 0.0f, 0.001f, "ohne Feld bleibt das Gelände, wie es war");

  // Ein Gitter mit fünf Stützpunkten je Kante über 512 Einheiten: ein
  // Stützpunkt alle 128 Einheiten, der mittlere liegt auf (0, 0).
  const int n = 5;
  world.resizeSculpt(n);
  check(world.sculptResolution() == n, "Feld angelegt");

  int16_t* data = world.sculptData();
  check(data != nullptr, "Feld hat Speicher");

  // Zehn Meter auf den mittleren Stützpunkt.
  const int centre = 2 * n + 2;
  data[centre] = static_cast<int16_t>(10.0f * aur::kSculptUnit);

  checkNear(world.heightAt(0.0f, 0.0f), 10.0f, 0.01f, "Mitte wird angehoben");
  checkNear(world.heightAt(128.0f, 0.0f), 0.0f, 0.01f, "Nachbarstützpunkt bleibt liegen");
  checkNear(world.heightAt(64.0f, 0.0f), 5.0f, 0.01f, "dazwischen wird interpoliert");

  // Die Steigung muss mitwandern, sonst laufen Figuren durch den neuen Hügel
  // hindurch, statt an ihm hochzugehen oder abzuprallen.
  check(world.slopeAt(64.0f, 0.0f) > 1.0f, "der neue Hang hat eine Steigung");

  // Und der Boden unter einer Figur muss derselbe sein.
  world.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
  world.applyInput(1, 0.0f, 0.0f, 0.0f, 0u, aur::kTickSeconds);
  checkNear(world.find(1)->y, 10.0f, 0.01f, "die Figur steht auf dem geformten Boden");

  // Abschalten stellt den alten Zustand her — das braucht der Editor beim
  // Wechsel auf eine Karte ohne Feld.
  world.resizeSculpt(0);
  checkNear(world.heightAt(0.0f, 0.0f), 0.0f, 0.001f, "abgeschaltet ist wieder rein prozedural");
}

// ---------------------------------------------------------------------------
// Fernkampf
// ---------------------------------------------------------------------------

void testRangedAttack() {
  std::printf("Fernkampf\n");

  aur::MobRegistry mobs;
  const uint32_t mobIndex = registerTestMob(mobs, false);
  aur::World world(13u, flatTerrain(), &mobs);

  aur::PlayerSpawn archer = testPlayer(1, 0.0f, 0.0f);
  archer.attackStyle = 1u;   // Fernkampf
  archer.attackRange = 18.0f;
  world.spawnPlayer(archer);

  // Eines nah, eines weiter weg, eines weit ausserhalb der Reichweite.
  world.spawnMob(10, mobIndex, 0.0f, 12.0f, -1, aur::kNoSpawner);
  world.spawnMob(11, mobIndex, 0.0f, 16.0f, -1, aur::kNoSpawner);
  world.spawnMob(12, mobIndex, 0.0f, -30.0f, -1, aur::kNoSpawner);

  // Anvisiert wird das **entferntere** der beiden. Ein Kern, der sich das
  // nächste heraussucht, fiele hier auf — und genau das tat er einmal.
  world.setTarget(1, 11);
  // Blick nach Sueden — die Richtung darf beim Fernkampf keine Rolle spielen.
  world.applyInput(1, 0.0f, 0.0f, aur::kPi, aur::kButtonAttack, aur::kTickSeconds);
  for (int i = 0; i < 6; ++i) world.step(aur::kTickSeconds);

  check(world.find(11)->hp < 100.0f, "das anvisierte Ziel wird getroffen");
  check(world.find(10)->hp == 100.0f, "das naehere bleibt unversehrt");
  check(world.find(12)->hp == 100.0f, "ausserhalb der Reichweite passiert nichts");

  // Und die Figur hat sich dorthin gedreht.
  checkNear(world.find(1)->yaw, 0.0f, 0.01f, "die Figur dreht sich zum Ziel");

  // Ein Ziel jenseits der Reichweite bleibt unversehrt, auch wenn es
  // anvisiert ist — sonst wäre die Reichweite einer Fernwaffe nur Zierde.
  aur::World fern(14u, flatTerrain(), &mobs);
  aur::PlayerSpawn kurz = testPlayer(1, 0.0f, 0.0f);
  kurz.attackStyle = 1u;
  kurz.attackRange = 18.0f;
  fern.spawnPlayer(kurz);
  fern.spawnMob(10, mobIndex, 0.0f, 25.0f, -1, aur::kNoSpawner);
  fern.setTarget(1, 10);
  fern.applyInput(1, 0.0f, 0.0f, 0.0f, aur::kButtonAttack, aur::kTickSeconds);
  check(fern.find(1)->swingTimer >= 0.0f, "der Schlag beginnt auch ausser Reichweite");
  for (int i = 0; i < 6; ++i) fern.step(aur::kTickSeconds);
  check(fern.find(10)->hp == 100.0f, "trifft aber nicht");

  // Der Unterschied zum Nahkampf ist die Flagge am Treffer: der Client
  // zeichnet daraufhin einen Pfeil. Ohne sie schlüge ein Bogen auf zwölf
  // Metern ohne sichtbaren Grund zu.
  aur::World pfeil(15u, flatTerrain(), &mobs);
  aur::PlayerSpawn schuetze = testPlayer(1, 0.0f, 0.0f);
  schuetze.attackStyle = 1u;
  schuetze.attackRange = 18.0f;
  pfeil.spawnPlayer(schuetze);
  pfeil.spawnMob(10, mobIndex, 0.0f, 12.0f, -1, aur::kNoSpawner);
  pfeil.setTarget(1, 10);
  pfeil.applyInput(1, 0.0f, 0.0f, 0.0f, aur::kButtonAttack, aur::kTickSeconds);
  bool geflogen = false;
  for (int i = 0; i < 6; ++i) {
    pfeil.step(aur::kTickSeconds);
    for (size_t e = 0; e < pfeil.eventCount(); ++e) {
      const aur::EventView& ev = pfeil.events()[e];
      if (ev.type == aur::kEventHit && (ev.flags & aur::kCombatRanged) != 0) geflogen = true;
    }
    pfeil.clearEvents();
  }
  check(geflogen, "ein Fernkampftreffer wird als solcher gemeldet");
}

/**
 * Heilen, Tempo und kritische Treffer — die drei Werte, die bis eben von
 * aussen nicht erreichbar waren.
 */
void testHeal() {
  std::printf("Heilen\n");
  aur::MobRegistry mobs;
  aur::World world(3u, flatTerrain(), &mobs);
  world.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
  world.setPlayerStats(1, 1, 100.0f, 50.0f, 10.0f, 0.0f, 6.0f, 0.0f, 0.0f);

  aur::Entity* p = world.find(1);
  p->hp = 40.0f;
  p->mp = 10.0f;

  const float ersteHeilung = world.heal(1, 25.0f, 0.0f);
  check(ersteHeilung == 25.0f, "Heilung meldet, was ankam");
  check(p->hp == 65.0f, "Leben ist gestiegen");

  // Über das Maximum hinaus wird nur der Rest gutgeschrieben. Genau daran
  // entscheidet der Server, ob ein Trank verbraucht wird.
  const float rest = world.heal(1, 100.0f, 0.0f);
  check(rest == 35.0f, "über das Maximum hinaus zählt nur der Rest");
  check(p->hp == 100.0f, "und das Maximum wird nicht überschritten");
  check(world.heal(1, 50.0f, 0.0f) == 0.0f, "auf voller Gesundheit kommt nichts an");

  check(world.heal(1, 0.0f, 20.0f) == 20.0f, "Mana wird genauso aufgefüllt");

  // Eine tote Figur heilt niemand. Wiederbeleben ist ein anderer Weg.
  p->hp = 0.0f;
  p->state = aur::kStateDead;
  check(world.heal(1, 50.0f, 0.0f) == 0.0f, "eine tote Figur wird nicht geheilt");
  check(p->hp == 0.0f, "und bleibt bei null");

  check(world.heal(999, 10.0f, 0.0f) == 0.0f, "eine erfundene Kennung heilt nichts");
}

/*
 * Regeneration — und wann sie schweigt.
 *
 * Zwei Aussagen, und die zweite ist die eigentliche: ohne die Eigenschaft
 * heilt niemand, und mit ihr heilt niemand, solange ein Monster hinter ihm her
 * ist. „Im Kampf" hing früher an den eigenen Merkern (Trefferpause, Schlag,
 * Abklingzeit); die laufen eine Sekunde nach dem letzten Schlag ab, und wer
 * dann neben einem angreifenden Keiler stand, heilte munter weiter.
 */
/**
 * Mana ausgeben — Prüfen und Abziehen in einem Zug.
 *
 * Der Anlass: der Server führte eine eigene Kopie des Manastands, prüfte
 * gegen sie und zog von ihr ab. Der Kern regenerierte derweil die andere. Wer
 * eine Fertigkeit anklickte, sah nichts passieren, weil die Kopie seit dem
 * Laden auf null stand — während der Kern längst vollen Balken hatte.
 */
void testVerbrauchtMp() {
  std::printf("Mana ausgeben\n");
  aur::MobRegistry mobs;
  aur::World world(4u, flatTerrain(), &mobs);
  world.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
  world.setPlayerStats(1, 1, 100.0f, 50.0f, 10.0f, 0.0f, 6.0f, 0.0f, 0.0f);

  aur::Entity* p = world.find(1);
  p->mp = 30.0f;

  check(world.verbrauchtMp(1, 10.0f), "genug Mana wird ausgegeben");
  check(p->mp == 20.0f, "und der Stand sinkt genau um die Kosten");

  // Die Gegenprobe, auf die es ankommt: zu teuer heisst **nichts** abziehen.
  // Ein Abzug, der scheitert und trotzdem etwas kostet, wäre schlimmer als
  // gar keine Prüfung.
  check(!world.verbrauchtMp(1, 25.0f), "zu wenig Mana wird abgelehnt");
  check(p->mp == 20.0f, "und dabei nichts abgezogen");

  check(world.verbrauchtMp(1, 20.0f), "genau der Reststand geht noch");
  check(p->mp == 0.0f, "und leert den Balken");

  // Kostenlos geht immer — auch bei leerem Balken. Eine Fertigkeit ohne
  // Kosten an null Mana scheitern zu lassen erwartet niemand.
  check(world.verbrauchtMp(1, 0.0f), "was nichts kostet, geht auch ohne Mana");

  p->state = aur::kStateDead;
  check(!world.verbrauchtMp(1, 1.0f), "eine tote Figur gibt nichts aus");
  check(!world.verbrauchtMp(999, 1.0f), "eine erfundene Kennung auch nicht");
}

void testRegeneration() {
  std::printf("Regeneration\n");
  aur::MobRegistry mobs;
  const uint32_t aggressive = registerTestMob(mobs, true);
  aur::World world(23u, flatTerrain(), &mobs);
  world.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
  world.setPlayerStats(1, 1, 100.0f, 50.0f, 10.0f, 0.0f, 6.0f, 0.0f, 0.0f);

  aur::Entity* p = world.find(1);
  p->hp = 40.0f;
  p->mp = 10.0f;

  // Ohne Eigenschaft passiert eine Sekunde lang nichts.
  for (int i = 0; i < aur::kTickRate; ++i) world.step(aur::kTickSeconds);
  check(p->hp == 40.0f, "ohne Eigenschaft heilt niemand von selbst");
  check(p->mp == 10.0f, "und Mana kommt auch nicht wieder");

  // Mit Eigenschaft: zwei Leben je Sekunde, eine Sekunde lang.
  world.setPlayerStats(1, 1, 100.0f, 50.0f, 10.0f, 0.0f, 6.0f, 2.0f, 1.0f);
  p = world.find(1);
  const float vorher = p->hp;
  for (int i = 0; i < aur::kTickRate; ++i) world.step(aur::kTickSeconds);
  check(p->hp > vorher + 1.5f && p->hp < vorher + 2.5f, "mit Eigenschaft kommt sie an");

  // Und jetzt ein Monster, das ihn jagt: ab hier steht die Heilung still,
  // obwohl der Spieler selbst gar nichts tut.
  world.spawnMob(10, aggressive, 0.0f, 3.0f, -1, aur::kNoSpawner);
  world.step(aur::kTickSeconds);
  check(world.find(10)->targetId == 1, "das Monster hat den Spieler im Blick");

  p = world.find(1);
  p->hp = 40.0f;
  const float imKampf = p->hp;
  for (int i = 0; i < aur::kTickRate; ++i) world.step(aur::kTickSeconds);
  check(world.find(1)->hp <= imKampf, "wer gejagt wird, heilt nicht");

  // Gegenprobe: ohne Verfolger läuft sie sofort wieder an. Ohne diese Zeile
  // wüsste man nicht, ob die Heilung *steht* oder überhaupt nicht mehr geht.
  world.removeEntity(10);
  p = world.find(1);
  const float nachher = p->hp;
  for (int i = 0; i < aur::kTickRate; ++i) world.step(aur::kTickSeconds);
  check(world.find(1)->hp > nachher, "ohne Verfolger geht es weiter");
}

void testMoveSpeedFromStats() {
  std::printf("Tempo aus den Werten\n");
  aur::MobRegistry mobs;
  aur::World world(4u, flatTerrain(), &mobs);
  world.spawnPlayer(testPlayer(1, 0.0f, 0.0f));

  // Langsam laufen, Strecke messen; schnell laufen, Strecke messen.
  world.setPlayerStats(1, 1, 100.0f, 0.0f, 10.0f, 0.0f, 2.0f, 0.0f, 0.0f);
  for (int i = 0; i < 20; ++i) {
    world.applyInput(1, 0.0f, 1.0f, 0.0f, 0u, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  const float langsam = world.find(1)->z;

  world.teleport(1, 0.0f, 0.0f, 0.0f);
  world.setPlayerStats(1, 1, 100.0f, 0.0f, 10.0f, 0.0f, 8.0f, 0.0f, 0.0f);
  for (int i = 0; i < 20; ++i) {
    world.applyInput(1, 0.0f, 1.0f, 0.0f, 0u, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  const float schnell = world.find(1)->z;

  check(schnell > langsam * 2.0f, "höheres Tempo bringt die Figur deutlich weiter");
}

void testAreaAttack() {
  std::printf("Flächenschlag einer Fertigkeit\n");
  aur::MobRegistry mobs;
  const uint32_t mobIndex = registerTestMob(mobs, false);
  aur::World world(11u, flatTerrain(), &mobs);
  world.spawnPlayer(testPlayer(1, 0.0f, 0.0f));

  // Zwei im Kreis, einer weit draussen. Der Weite ist die Gegenprobe: ohne
  // ihn liesse sich nicht unterscheiden, ob der Radius wirkt oder ob der
  // Schlag einfach alles trifft, was auf der Karte steht.
  world.spawnMob(10, mobIndex, 0.0f, 1.5f, -1, aur::kNoSpawner);
  world.spawnMob(11, mobIndex, -2.0f, 0.5f, -1, aur::kNoSpawner);
  world.spawnMob(12, mobIndex, 0.0f, 12.0f, -1, aur::kNoSpawner);

  // Niemand ist anvisiert — genau das ist der Unterschied zum Schlag.
  world.areaAttack(1, 3.6f, 1.0f);

  check(world.find(10)->hp < 100.0f, "der Nahe nimmt Schaden");
  check(world.find(11)->hp < 100.0f, "der Zweite im Kreis auch");
  check(world.find(12)->hp == 100.0f, "der Weite bleibt unversehrt");
  check(world.find(1)->targetId == 0, "und das ganz ohne Zielauswahl");

  // Der Faktor rechnet auf den Angriffswert und nicht auf das Ergebnis: zwei
  // Läufe mit demselben Zufall, einmal doppelt so stark.
  auto schaden = [&](float faktor) {
    aur::World w(12u, flatTerrain(), &mobs);
    w.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
    w.setCritProfile(1, 0.0f, 1.0f);
    w.spawnMob(10, mobIndex, 0.0f, 1.0f, -1, aur::kNoSpawner);
    w.areaAttack(1, 3.6f, faktor);
    return 100.0f - w.find(10)->hp;
  };
  check(schaden(2.0f) > schaden(1.0f), "ein höherer Faktor tut mehr weh");
}

void testCritProfile() {
  std::printf("Kritische Treffer\n");
  aur::MobRegistry mobs;
  const uint32_t mobIndex = registerTestMob(mobs, false);

  // Zweimal derselbe Ablauf, nur die Kritwerte unterscheiden sich. Ohne Krit
  // darf kein Treffer als kritisch gemeldet werden, mit sicherem Krit jeder.
  auto zaehleKrits = [&](float chance, float mult) {
    aur::World world(9u, flatTerrain(), &mobs);
    world.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
    world.setCritProfile(1, chance, mult);
    world.spawnMob(10, mobIndex, 0.0f, 2.0f, -1, aur::kNoSpawner);
    world.setTarget(1, 10);

    int krits = 0;
    int treffer = 0;
    for (int runde = 0; runde < 40; ++runde) {
      world.applyInput(1, 0.0f, 0.0f, 0.0f, aur::kButtonAttack, aur::kTickSeconds);
      world.step(aur::kTickSeconds);
      for (size_t e = 0; e < world.eventCount(); ++e) {
        const aur::EventView& ev = world.events()[e];
        // Nur die eigenen Schläge zählen. Das Monster schlägt zurück, und
        // seine Treffer tragen die Vorgabe-Kritchance — sie mitzuzählen hat
        // diese Prüfung beim ersten Lauf zu Recht scheitern lassen.
        if (ev.type != aur::kEventHit || ev.a != 1) continue;
        ++treffer;
        if ((ev.flags & aur::kCombatCritical) != 0) ++krits;
      }
      world.clearEvents();
      // Das Monster am Leben halten, damit weiter zugeschlagen wird.
      aur::Entity* ziel = world.find(10);
      if (ziel != nullptr) ziel->hp = ziel->maxHp;
    }
    return std::pair<int, int>{treffer, krits};
  };

  const auto ohne = zaehleKrits(0.0f, 2.0f);
  const auto mit = zaehleKrits(1.0f, 2.0f);

  check(ohne.first > 0, "es wurde überhaupt getroffen");
  check(ohne.second == 0, "ohne Aussicht gibt es keinen kritischen Treffer");
  check(mit.second == mit.first, "mit voller Aussicht ist jeder Treffer kritisch");
}

}  // namespace

void testWandering() {
  std::printf("Umherwandern\n");
  aur::MobRegistry mobs;
  // Friedlich: ein wahrnehmendes Monster liefe zum Spieler und nicht umher.
  const uint32_t mobIndex = registerTestMob(mobs, false);
  aur::World world(23u, flatTerrain(), &mobs);

  aur::Spawner spawner;
  spawner.x = 5.0f;
  spawner.z = -4.0f;
  spawner.radius = 6.0f;
  spawner.respawnSec = 60.0f;
  spawner.mobIndex = mobIndex;
  const uint32_t spawnerIndex = world.addSpawner(spawner);

  world.spawnMob(10, mobIndex, spawner.x + 1.0f, spawner.z, -1, spawnerIndex);

  const aur::Entity* e = world.find(10);
  float maxDist = 0.0f;
  int schritte = 0;   // Takte mit Bewegung
  int stehend = 0;    // Takte ohne
  // Sechzig Sekunden: genug für mehrere Runden aus Wandern und Pause.
  for (int i = 0; i < aur::kTickRate * 60; ++i) {
    world.step(aur::kTickSeconds);
    const float d = aur::dist2D(e->x, e->z, spawner.x, spawner.z);
    if (d > maxDist) maxDist = d;
    if (e->vx != 0.0f || e->vz != 0.0f) ++schritte;
    else ++stehend;
  }

  check(schritte > 0, "das Monster setzt sich in Bewegung");
  check(stehend > 0, "und bleibt zwischendurch stehen");
  // Beides in nennenswertem Umfang — ein einzelner Takt Bewegung wäre kein
  // Wandern, sondern ein Zucken.
  check(schritte > aur::kTickRate * 5, "es wandert über mehrere Sekunden");
  check(stehend > aur::kTickRate * 5, "und rastet über mehrere Sekunden");
  // Der Wanderradius ist die eigentliche Zusage. Ein Zehntel Toleranz für den
  // Schritt, mit dem es die Grenze überquert.
  check(maxDist <= spawner.radius * 1.1f, "es bleibt in seinem Feld");

  // Gegenprobe: ohne Spawner gibt es kein Feld, und dann wandert nichts.
  // Ohne sie zeigten die Prüfungen oben nur, dass sich überhaupt etwas regt.
  world.spawnMob(11, mobIndex, -20.0f, -20.0f, -1, aur::kNoSpawner);
  const aur::Entity* allein = world.find(11);
  const float x0 = allein->x;
  const float z0 = allein->z;
  for (int i = 0; i < aur::kTickRate * 30; ++i) world.step(aur::kTickSeconds);
  check(aur::dist2D(allein->x, allein->z, x0, z0) < 0.01f,
        "ein Monster ohne Feld bleibt stehen");

  // Kein Gleichschritt: ein Feld erscheint im selben Takt, darf sich aber
  // nicht im selben Takt in Bewegung setzen. Geprüft wird der erste Takt mit
  // Bewegung je Monster — sind die alle gleich, marschiert die Wiese.
  aur::World feld(77u, flatTerrain(), &mobs);
  const uint32_t feldIndex = feld.addSpawner(spawner);
  for (uint32_t i = 0; i < 6u; ++i) {
    feld.spawnMob(100u + i, mobIndex, spawner.x + static_cast<float>(i) * 0.5f, spawner.z,
                  -1, feldIndex);
  }

  int ersterZug[6] = {-1, -1, -1, -1, -1, -1};
  for (int i = 0; i < aur::kTickRate * 20; ++i) {
    feld.step(aur::kTickSeconds);
    for (uint32_t k = 0; k < 6u; ++k) {
      const aur::Entity* m = feld.find(100u + k);
      if (ersterZug[k] < 0 && (m->vx != 0.0f || m->vz != 0.0f)) ersterZug[k] = i;
    }
  }

  int verschieden = 0;
  for (uint32_t k = 0; k < 6u; ++k) {
    bool neu = ersterZug[k] >= 0;
    for (uint32_t j = 0; j < k; ++j) {
      if (ersterZug[j] == ersterZug[k]) neu = false;
    }
    if (neu) ++verschieden;
  }
  check(verschieden >= 4, "ein Feld setzt sich nicht im Gleichschritt in Bewegung");

  // --- Leine und Wanderradius ziehen nicht gegeneinander --------------------
  //
  // Der Fall, der beides gegeneinanderstellt: ein Feld, das weiter reicht als
  // die Leine des Wesens darin. Ein Wanderziel am Feldrand liegt dann
  // ausserhalb der Leine — das Monster liefe los, würde auf halbem Weg
  // zurückgerissen, liefe wieder los, und das für immer. Sichtbar wird das an
  // zweierlei: es käme weiter hinaus als die Leine reicht, und es täte das im
  // Leinentempo, das dreimal so schnell ist wie ein Spaziergang.
  aur::MobDef eng;
  eng.maxHp = 100.0f;
  eng.moveSpeed = 4.0f;
  eng.aggroRange = 0.0f;
  eng.leashRange = 8.0f;
  eng.attackRange = 2.0f;
  eng.attackCooldownSec = 1.0f;
  eng.radius = 0.6f;
  eng.height = 1.6f;
  eng.level = 1;
  const uint32_t engIndex = mobs.add(eng);

  aur::Spawner weit;
  weit.x = 0.0f;
  weit.z = 0.0f;
  weit.radius = 12.0f;  // grösser als die Leine
  weit.respawnSec = 60.0f;
  weit.mobIndex = engIndex;

  aur::World knapp(31u, flatTerrain(), &mobs);
  const uint32_t weitIndex = knapp.addSpawner(weit);
  // Innerhalb der Leine erschienen — sonst holt sie es zuerst einmal
  // zurück, und gemessen wäre der Heimweg statt des Wanderns.
  knapp.spawnMob(20, engIndex, 7.0f, 0.0f, -1, weitIndex);

  const aur::Entity* rand = knapp.find(20);
  float weiteste = 0.0f;
  float schnellste = 0.0f;
  for (int i = 0; i < aur::kTickRate * 120; ++i) {
    knapp.step(aur::kTickSeconds);
    weiteste = std::max(weiteste, aur::dist2D(rand->x, rand->z, weit.x, weit.z));
    schnellste = std::max(schnellste, std::sqrt(rand->vx * rand->vx + rand->vz * rand->vz));
  }
  // Der Wanderradius ist auf die Leine gekürzt, nicht auf den Feldradius.
  check(weiteste <= eng.leashRange * 1.1f,
        "ein Feld grösser als die Leine schränkt das Wandern ein");
  check(schnellste <= eng.moveSpeed * (aur::kWanderSpeedFactor + 0.05f),
        "und niemand wird dabei ins Leinentempo gerissen");
}

int main() {
  std::printf("Aurelith-Kern — native Prüfungen\n\n");

  testMovement();
  testCollider();
  testSwingHitsOnlyTarget();
  testJump();
  testWindupDelaysDamage();
  testAggroAndLeash();
  testDeathAndRespawn();
  testDeterminism();
  testEntityViewLayout();
  testSculpt();
  testRangedAttack();
  testHeal();
  testVerbrauchtMp();
  testRegeneration();
  testMoveSpeedFromStats();
  testAreaAttack();
  testCritProfile();
  testWandering();

  std::printf("\n%d Prüfungen, %d fehlgeschlagen\n", g_checks, g_failures);
  return g_failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
