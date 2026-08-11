// Natives Testprogramm für den Kern.
//
// Kein Testframework — das wäre eine Abhängigkeit für etwas, das mit zwanzig
// Zeilen auskommt. Wichtig ist nur, dass diese Prüfungen ohne Emscripten
// laufen: sie geben in Sekunden Rückmeldung, wo der wasm-Weg Minuten braucht.

#include <cmath>
#include <cstdio>
#include <cstdlib>

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
  def.attackArc = aur::kPi;
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
  p.attackArc = 2.67f;
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

void testAreaSwingHitsEveryone() {
  std::printf("Flächenschlag trifft alles in Reichweite\n");
  aur::MobRegistry mobs;
  const uint32_t mobIndex = registerTestMob(mobs, false);
  aur::World world(7u, flatTerrain(), &mobs);
  world.spawnPlayer(testPlayer(1, 0.0f, 0.0f));

  // Drei Ziele vor der Figur, eines dahinter.
  world.spawnMob(10, mobIndex, -1.2f, 2.0f, -1, aur::kNoSpawner);
  world.spawnMob(11, mobIndex, 0.0f, 2.2f, -1, aur::kNoSpawner);
  world.spawnMob(12, mobIndex, 1.2f, 2.0f, -1, aur::kNoSpawner);
  world.spawnMob(13, mobIndex, 0.0f, -2.5f, -1, aur::kNoSpawner);

  // Blick nach +Z, Angriffstaste halten, bis der Schlag aufgelöst ist.
  world.applyInput(1, 0.0f, 0.0f, 0.0f, aur::kButtonAttack, aur::kTickSeconds);
  for (int i = 0; i < 6; ++i) {
    world.step(aur::kTickSeconds);
  }

  check(world.find(10)->hp < 100.0f, "linkes Ziel getroffen");
  check(world.find(11)->hp < 100.0f, "mittleres Ziel getroffen");
  check(world.find(12)->hp < 100.0f, "rechtes Ziel getroffen");
  check(world.find(13)->hp == 100.0f, "Ziel hinter der Figur nicht getroffen");

  // Ein friedliches Monster schlägt nach einem Treffer zurück.
  check(world.find(11)->targetId == 1, "getroffenes Monster nimmt den Angreifer ins Visier");
}

void testWindupDelaysDamage() {
  std::printf("Vorlaufzeit verzögert den Schaden\n");
  aur::MobRegistry mobs;
  const uint32_t mobIndex = registerTestMob(mobs, false);
  aur::World world(3u, flatTerrain(), &mobs);
  world.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
  world.spawnMob(10, mobIndex, 0.0f, 2.0f, -1, aur::kNoSpawner);

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

  // Respawn nach einer Sekunde plus etwas Reserve.
  for (int i = 0; i < aur::kTickRate + 4; ++i) world.step(aur::kTickSeconds);
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

}  // namespace

int main() {
  std::printf("Aurelith-Kern — native Prüfungen\n\n");

  testMovement();
  testCollider();
  testAreaSwingHitsEveryone();
  testWindupDelaysDamage();
  testAggroAndLeash();
  testDeathAndRespawn();
  testDeterminism();
  testEntityViewLayout();

  std::printf("\n%d Prüfungen, %d fehlgeschlagen\n", g_checks, g_failures);
  return g_failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
