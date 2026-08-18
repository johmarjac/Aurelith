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
  world.addCollider(0.0f, 5.0f, 2.0f, 0.0f);
  world.spawnPlayer(testPlayer(1, 0.0f, 0.0f));

  for (int i = 0; i < aur::kTickRate * 2; ++i) {
    world.applyInput(1, 0.0f, 1.0f, 0.0f, 0u, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  const aur::Entity* p = world.find(1);
  const float d = aur::dist2D(p->x, p->z, 0.0f, 5.0f);
  check(d >= 2.0f + 0.45f - 0.05f, "Spieler steckt nicht im Prop");
}

/**
 * Über einen Zaun springt man, über eine Säule nicht.
 *
 * Der Kreis eines Props galt bis zu dieser Prüfung über die **ganze Höhe der
 * Welt**: man konnte springen, so hoch man wollte, und blieb am Zaunfeld
 * hängen. Beide Hälften stehen hier, und die zweite ist die wichtigere — eine
 * Fassung, die einen einfach durch alles hindurchspringen lässt, bestünde die
 * erste Prüfung genauso.
 */
void testSpringUeberProp() {
  std::printf("Über niedrige Props springt man hinweg\n");

  // Ein Zaunfeld: 1,15 m hoch, Kreis 0,85 m — dieselben Zahlen wie in
  // PROP_KOLLISION.
  auto laufMitSprung = [](float propHoehe) {
    aur::MobRegistry mobs;
    aur::World world(1u, flatTerrain(), &mobs);
    world.addCollider(0.0f, 5.0f, 0.85f, propHoehe);
    world.spawnPlayer(testPlayer(1, 0.0f, 0.0f));

    for (int i = 0; i < aur::kTickRate * 3; ++i) {
      // Erst laufen, dann kurz vor dem Prop abspringen. Der Absprung liegt
      // deutlich davor: wer erst an der Kante drückt, ist beim Scheitel längst
      // dagegengelaufen.
      const aur::Entity* p = world.find(1);
      const bool absprung = p != nullptr && p->z > 2.6f && p->z < 3.4f;
      world.applyInput(1, 0.0f, 1.0f, 0.0f, absprung ? aur::kButtonJump : 0u,
                       aur::kTickSeconds);
      world.step(aur::kTickSeconds);
    }
    const aur::Entity* p = world.find(1);
    return p != nullptr ? p->z : 0.0f;
  };

  const float ueberZaun = laufMitSprung(1.15f);
  check(ueberZaun > 6.0f, "über das Zaunfeld hinweg");
  std::printf("     z = %.2f\n", static_cast<double>(ueberZaun));

  // Die Gegenprobe: eine Säule reicht bis in den Himmel (Höhe 0 heisst genau
  // das), und an der bleibt derselbe Sprung hängen.
  const float anDerSaeule = laufMitSprung(0.0f);
  check(anDerSaeule < 4.5f, "und an der Säule bleibt man stehen");
  std::printf("     z = %.2f\n", static_cast<double>(anDerSaeule));
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

  /*
   * Scheitelhöhe: v²/(2g) bei 8,6 und 22 sind 1,68 Meter. Grosszügige Grenzen,
   * weil die Schrittweite den Scheitel nicht genau trifft — aber eng genug,
   * dass ein Faktor daneben auffällt.
   *
   * Die untere Grenze ist zugleich eine Aussage über das Spiel und nicht nur
   * über die Physik: unter 1,25 m käme man über kein Zaunfeld mehr, und genau
   * dafür ist der Sprung angehoben worden.
   */
  check(hoechste - boden > 1.25f && hoechste - boden < 2.1f,
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

  /*
   * --- Und wer über ihm steht, wird nicht bemerkt ---------------------------
   *
   * Der Fall aus dem Spiel: eine Horde Keiler stand unter einem schwebenden
   * Felsen und griff jemanden an, der sechsundzwanzig Meter darüber auf dem
   * Felsen stand. Auf der Karte war er neben ihnen, also nahm ihn `dist2D`
   * wahr — und weil die Verfolgung dieselbe flache Zahl nahm, hielt sich das
   * Monster auch noch für in Reichweite.
   *
   * Geprüft wird auf derselben Stelle, an der es eben noch geklappt hat: nur
   * die Höhe ändert sich. Damit kann das Ergebnis an nichts anderem liegen.
   */
  {
    aur::World hoch(11u, flatTerrain(), &mobs);
    hoch.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
    hoch.spawnMob(10, aggressive, 0.0f, 3.0f, -1, aur::kNoSpawner);
    const float grund = hoch.find(1)->y;

    // Erst die Gegenprobe am Boden: dieselbe Stelle, dieselbe Entfernung.
    hoch.step(aur::kTickSeconds);
    check(hoch.find(10)->targetId == 1, "am Boden nimmt es ihn wahr");
    const float unten = hoch.find(1)->hp;
    for (int i = 0; i < 60; ++i) hoch.step(aur::kTickSeconds);
    check(hoch.find(1)->hp < unten, "und schlägt auch zu");

    /*
     * Und jetzt hinauf. Ein **echter** Felsen und keine gesetzte Höhe: eine
     * Figur, die einfach nach oben geschrieben wird, fällt im nächsten Tick
     * wieder herunter, und die Prüfung mässe dann etwas ganz anderes. Genau
     * daran ist die erste Fassung dieser Zeilen gescheitert.
     */
    hoch.addPlattform(0.0f, 0.0f, 6.0f, grund + 26.0f);
    hoch.find(1)->y = grund + 26.0f;
    hoch.find(1)->airborne = false;
    hoch.find(10)->targetId = 0;
    for (int i = 0; i < 5; ++i) hoch.step(aur::kTickSeconds);
    check(std::fabs(hoch.find(1)->y - (grund + 26.0f)) < 1e-2f, "die Figur bleibt oben stehen");
    check(hoch.find(10)->targetId == 0, "sechsundzwanzig Meter höher nimmt es ihn nicht wahr");

    /*
     * Und es trifft ihn auch nicht. Das war die zweite Hälfte der Meldung:
     * ohne die Höhe in der Reichweite hielte sich das Monster für am Ziel und
     * liesse den Vorlauf anlaufen — der Schlag käme an, obwohl niemand da ist.
     */
    const float oben = hoch.find(1)->hp;
    hoch.find(10)->targetId = 1;
    for (int i = 0; i < 60; ++i) hoch.step(aur::kTickSeconds);
    check(hoch.find(1)->hp >= oben - 1e-3f, "und trifft ihn auch nicht");

    /*
     * Und es **schiebt** ihn auch nicht.
     *
     * Die weiche Trennung hielt die beiden für ineinanderstehend — auf der
     * Karte taten sie das ja — und drückte die Figur oben Schritt für Schritt
     * über die Fläche, bis sie über die Kante fiel. Im Spiel sah das aus wie
     * eine Figur, die von selbst wegrutscht.
     */
    hoch.find(10)->targetId = 0;
    // Ein Stück versetzt und nicht auf dieselbe Stelle: die Trennung lässt
    // genau übereinanderliegende Mittelpunkte aus, weil sie dafür keine
    // Richtung hätte. Auf der Stelle prüfte dieser Abschnitt gar nichts —
    // seine Gegenprobe blieb grün, als die Regel wieder entfernt wurde.
    hoch.find(10)->x = hoch.find(1)->x;
    hoch.find(10)->z = hoch.find(1)->z + 0.1f;
    const float vorX = hoch.find(1)->x;
    const float vorZ = hoch.find(1)->z;
    for (int i = 0; i < 40; ++i) hoch.step(aur::kTickSeconds);
    check(aur::dist2D(hoch.find(1)->x, hoch.find(1)->z, vorX, vorZ) < 0.05f,
          "und schiebt ihn auch nicht vom Felsen");

    /*
     * Und unten, Bauch an Bauch, ebenso wenig: durch Monster läuft man
     * hindurch.
     *
     * Hier stand einmal die Gegenprobe „auf gleicher Höhe schiebt es sehr
     * wohl". Das war richtig, solange sich alles trennte — und genau daran
     * lag der zweite gemeldete Fehler: eine Horde, die sich um eine Figur
     * schliesst, schob sie vor sich her, und wer angegriffen wurde, hatte
     * seinen eigenen Standort nicht mehr in der Hand. Ein einzelner Schritt
     * genügt für die Prüfung; die Trennung wirkt sofort und nicht über die
     * Zeit.
     */
    hoch.find(1)->y = grund;
    hoch.find(1)->airborne = false;
    hoch.find(10)->x = hoch.find(1)->x;
    hoch.find(10)->z = hoch.find(1)->z + 0.1f;
    const float engX = hoch.find(1)->x;
    const float engZ = hoch.find(1)->z;
    hoch.step(aur::kTickSeconds);
    check(aur::dist2D(hoch.find(1)->x, hoch.find(1)->z, engX, engZ) < 0.05f,
          "und auf gleicher Höhe genauso wenig");
  }

  /*
   * --- Gegenprobe: unter ihresgleichen trennen sie sich sehr wohl -----------
   *
   * Ohne diesen Abschnitt wären die beiden Zeilen oben auch dann grün, wenn es
   * die weiche Trennung gar nicht mehr gäbe — und dann stünde eine ganze
   * Gruppe Keiler auf einem Punkt und sähe aus wie ein einziges Wesen.
   *
   * Ohne Spieler in der Welt: zwei angriffslustige Monster mit einem Ziel
   * liefen beide darauf zu, und die Bewegung läge über dem, was hier gemessen
   * werden soll.
   */
  {
    aur::World eng(11u, flatTerrain(), &mobs);
    eng.spawnMob(20, aggressive, 0.0f, 0.0f, -1, aur::kNoSpawner);
    eng.spawnMob(21, aggressive, 0.0f, 0.1f, -1, aur::kNoSpawner);
    const float vorher =
        aur::dist2D(eng.find(20)->x, eng.find(20)->z, eng.find(21)->x, eng.find(21)->z);
    eng.step(aur::kTickSeconds);
    const float nachher =
        aur::dist2D(eng.find(20)->x, eng.find(20)->z, eng.find(21)->x, eng.find(21)->z);
    check(nachher > vorher + 0.05f, "Monster untereinander trennen sich weiterhin");

    /*
     * Und auch unter ihresgleichen zählt die Höhe. Sonst wäre die Regel, die
     * den Keiler unter dem Felsen betrifft, nach der Änderung von oben gar
     * nicht mehr geprüft — sie greift jetzt nur noch zwischen Gleichen.
     */
    const float grund = eng.find(20)->y;
    eng.addPlattform(0.0f, 0.0f, 6.0f, grund + 26.0f);
    eng.find(20)->x = 0.0f;
    eng.find(20)->z = 0.0f;
    eng.find(20)->y = grund + 26.0f;
    eng.find(20)->airborne = false;
    eng.find(21)->x = 0.0f;
    eng.find(21)->z = 0.1f;
    const float weitVorher =
        aur::dist2D(eng.find(20)->x, eng.find(20)->z, eng.find(21)->x, eng.find(21)->z);
    eng.step(aur::kTickSeconds);
    const float weitNachher =
        aur::dist2D(eng.find(20)->x, eng.find(20)->z, eng.find(21)->x, eng.find(21)->z);
    check(std::fabs(weitNachher - weitVorher) < 0.05f,
          "sechsundzwanzig Meter höher dagegen nicht");
  }
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
  check(sizeof(aur::EntityView) == 60, "EntityView ist 60 Byte groß");
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

  /*
   * `begehbar` — die Frage, die der Server beim Absteigen stellt.
   *
   * Nicht „wie steil ist es hier", sondern „trägt es jemanden, der einfach
   * hingestellt wird". Die Schwelle ist dieselbe wie in `tryStep`, und genau
   * deshalb steht sie im Kern: der Server hat keine eigene Zahl dafür.
   *
   * Zehn Meter über hundertachtundzwanzig sind viereinhalb Grad und tragen.
   * Für die Gegenprobe muss derselbe Hang steil werden — sonst prüfte das hier
   * nur, dass die Funktion irgendetwas zurückgibt.
   */
  check(world.begehbar(64.0f, 0.0f), "der sanfte Hang trägt");
  data[centre] = static_cast<int16_t>(200.0f * aur::kSculptUnit);
  check(world.slopeAt(64.0f, 0.0f) > aur::kMaxWalkableSlopeDeg, "aufgesteilt ist er unbegehbar");
  check(!world.begehbar(64.0f, 0.0f), "und dann trägt er nicht mehr");
  // Und die Ebene daneben trägt weiterhin: die Absage gilt dem Hang, nicht der
  // ganzen Karte.
  check(world.begehbar(256.0f, 0.0f), "die Ebene daneben trägt trotzdem");
  data[centre] = static_cast<int16_t>(10.0f * aur::kSculptUnit);

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

void testFliegen() {
  std::printf("Fliegen\n");
  aur::MobRegistry mobs;
  aur::World world(9u, flatTerrain(), &mobs);
  world.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
  aur::Entity* p = world.find(1);
  const float boden = p->y;

  const uint32_t keine = 0u;
  const uint32_t schub = aur::kButtonSchub;

  world.setFlying(1, true, 12.0f, 6.0f, 20.0f);
  check(p->flying, "nach dem Aufsteigen fliegt die Figur");
  check(p->y > boden, "und hebt dabei ab");
  check(!p->schub && p->tempo == 0.0f, "aber ohne Schub und ohne Tempo");

  /*
   * Ohne Schub steht sie. Eine Sekunde lang, damit ein Fehler von einem
   * Zehntel je Schritt auffiele.
   */
  const float stand = p->y;
  const float standX = p->x;
  for (int i = 0; i < 20; ++i) {
    world.applyInput(1, 0.0f, 0.0f, 0.0f, keine, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  check(std::fabs(p->y - stand) < 1e-3f, "ohne Schub bleibt sie stehen");
  check(std::fabs(p->x - standX) < 1e-3f, "und bewegt sich auch nicht vom Fleck");

  // --- Der Schub schaltet um, und er fährt an ------------------------------
  world.applyInput(1, 0.0f, 0.0f, 0.0f, schub, aur::kTickSeconds);
  world.step(aur::kTickSeconds);
  check(p->schub, "das Schubbit schaltet ihn ein");
  /*
   * Die Rampe ist der Punkt: nach einem Schritt darf noch lange nicht das
   * volle Tempo stehen. Ohne diese Prüfung ginge ein Kern durch, in dem der
   * Schub sofort steht — und genau das sollte er nicht.
   */
  check(p->tempo > 0.0f && p->tempo < 12.0f * 0.2f, "und fährt langsam an");

  for (int i = 0; i < 80; ++i) {
    world.applyInput(1, 0.0f, 0.0f, 0.0f, schub, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  check(std::fabs(p->tempo - 12.0f) < 0.01f, "nach vier Sekunden liegt das volle Tempo an");
  check(p->z > standX + 10.0f, "und sie ist waagerecht davongeflogen");
  check(std::fabs(p->y - stand) < 0.05f, "waagerecht heisst: ohne Höhe zu gewinnen");

  // --- Die Nase steuert die Höhe -------------------------------------------
  //
  // W hebt sie (moveZ = +1), S senkt sie — wie am Steuerknüppel: ziehen hebt.
  // Eine halbe Sekunde reicht für einen deutlichen Winkel.
  const float vorSteig = p->y;
  for (int i = 0; i < 10; ++i) {
    world.applyInput(1, 0.0f, 1.0f, 0.0f, schub, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  check(p->pitch > 0.3f, "W hebt die Nase");
  for (int i = 0; i < 40; ++i) {
    world.applyInput(1, 0.0f, 0.0f, 0.0f, schub, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  check(p->y > vorSteig + 3.0f, "und mit gehobener Nase steigt sie");

  // Die Gegenprobe: S senkt sie wieder.
  const float oben = p->y;
  for (int i = 0; i < 30; ++i) {
    world.applyInput(1, 0.0f, -1.0f, 0.0f, schub, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  check(p->pitch < 0.0f, "S senkt die Nase");
  for (int i = 0; i < 40; ++i) {
    world.applyInput(1, 0.0f, 0.0f, 0.0f, schub, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  check(p->y < oben, "und dann geht es wieder hinunter");

  // Steiler als der Anschlag wird es nicht — sonst überschlägt sich die Figur.
  for (int i = 0; i < 200; ++i) {
    world.applyInput(1, 0.0f, 1.0f, 0.0f, schub, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  check(p->pitch <= aur::kFlugNickMax + 1e-4f, "die Nase kippt nicht über den Anschlag");

  // --- Drehen: D nach rechts, also zu kleineren Winkeln ---------------------
  const float vorKurve = p->yaw;
  for (int i = 0; i < 10; ++i) {
    world.applyInput(1, 1.0f, 0.0f, 0.0f, schub, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  check(p->yaw < vorKurve, "D dreht nach rechts");

  // --- Und ohne das Bit rollt er aus ---------------------------------------
  world.applyInput(1, 0.0f, 0.0f, 0.0f, keine, aur::kTickSeconds);
  world.step(aur::kTickSeconds);
  check(!p->schub, "ohne Bit läuft der Schub nicht mehr");
  check(p->tempo > 1.0f, "und er rollt aus, statt zu stehen");
  for (int i = 0; i < 60; ++i) {
    world.applyInput(1, 0.0f, 0.0f, 0.0f, keine, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  check(p->tempo == 0.0f, "nach der Rampe steht sie");

  // --- Das Steigen ist gedeckelt -------------------------------------------
  //
  // Bei voll gehobener Nase und vollem Tempo gäbe die Lage rund elf Meter je
  // Sekunde her; das Gerät gibt sechs. Ohne die Deckelung wäre `steig` aus der
  // Inhaltsdatei eine Zahl ohne Wirkung, und das schnellste Gerät wäre
  // automatisch auch das beste beim Steigen.
  //
  // Vorübergehend unter einer hohen Decke, sonst prüfte diese Stelle die
  // Höhenbegrenzung statt der Steigrate.
  world.setFlying(1, true, 12.0f, 6.0f, 200.0f);
  for (int i = 0; i < 100; ++i) {
    world.applyInput(1, 0.0f, 1.0f, 0.0f, schub, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  const float vorDeckel = p->y;
  for (int i = 0; i < 20; ++i) {
    world.applyInput(1, 0.0f, 0.0f, 0.0f, schub, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  check(std::fabs((p->y - vorDeckel) - 6.0f) < 0.2f,
        "steil und schnell steigt sie trotzdem nur mit dem Wert des Geräts");

  // --- Boden und Decke ------------------------------------------------------
  world.setFlying(1, true, 12.0f, 6.0f, 20.0f);
  for (int i = 0; i < 400; ++i) {
    world.applyInput(1, 0.0f, 1.0f, 0.0f, schub, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  check(p->y <= boden + 20.0f + 1e-3f, "über die Decke des Geräts steigt sie nicht");

  for (int i = 0; i < 600; ++i) {
    world.applyInput(1, 0.0f, -1.0f, 0.0f, schub, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  check(p->y >= boden + aur::kFlugMindesthoehe - 1e-3f, "und in den Boden sinkt sie nicht");

  /*
   * --- Vom Gerät aus wird nicht geschlagen ---------------------------------
   *
   * Anvisieren ja, schlagen nein: wer auf einem Besen sitzt, hat keine Hand
   * frei und keinen Stand. Das Ziel bleibt trotzdem wählbar — es ist eine
   * Frage („wie stark ist das da unten") und kein Kampf.
   *
   * Mit Gegenprobe, sonst ginge auch ein Kern durch, der überhaupt nicht mehr
   * zuschlägt: dieselbe Lage, dasselbe Ziel, nur ohne Gerät.
   */
  {
    aur::MobRegistry mobs2;
    const uint32_t art = registerTestMob(mobs2, false);

    aur::World inDerLuft(21u, flatTerrain(), &mobs2);
    inDerLuft.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
    inDerLuft.spawnMob(10, art, 0.0f, 2.0f, -1, aur::kNoSpawner);
    inDerLuft.setFlying(1, true, 12.0f, 6.0f, 40.0f);
    inDerLuft.setTarget(1, 10);
    check(inDerLuft.find(1)->targetId == 10, "auf dem Gerät lässt sich anvisieren");
    inDerLuft.applyInput(1, 0.0f, 0.0f, 0.0f, aur::kButtonAttack, aur::kTickSeconds);
    check(inDerLuft.find(1)->swingTimer < 0.0f, "aber der Schlag beginnt gar nicht erst");
    for (int i = 0; i < 8; ++i) inDerLuft.step(aur::kTickSeconds);
    check(inDerLuft.find(10)->hp == 100.0f, "und das Monster bleibt unversehrt");

    aur::World amBoden(23u, flatTerrain(), &mobs2);
    amBoden.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
    amBoden.spawnMob(10, art, 0.0f, 2.0f, -1, aur::kNoSpawner);
    amBoden.setTarget(1, 10);
    amBoden.applyInput(1, 0.0f, 0.0f, 0.0f, aur::kButtonAttack, aur::kTickSeconds);
    for (int i = 0; i < 8; ++i) amBoden.step(aur::kTickSeconds);
    check(amBoden.find(10)->hp < 100.0f, "abgestiegen trifft derselbe Schlag");
  }

  /*
   * --- Und niemand nimmt einen wahr, der auf einem Gerät sitzt -------------
   *
   * Der Kampf ist in **beide** Richtungen zu. Vorher war nur der Schlag von
   * oben verhindert: der Keiler rannte weiter unter der Figur her, kam nie an,
   * gab nie auf — und weil „im Kampf" am Verfolger hängt, lief die
   * Regeneration nie wieder an.
   *
   * Drei Fragen, und alle drei hängen an derselben Regel in `isHostile`:
   * bemerkt er einen überhaupt, lässt er ein bereits gefasstes Ziel wieder
   * los, und trifft sein Schlag. Die Gegenprobe steht darunter: dieselbe Lage
   * ohne Gerät, und der Keiler tut alles drei.
   */
  {
    aur::MobRegistry mobs2;
    const uint32_t art = registerTestMob(mobs2, true);

    aur::World inDerLuft(24u, flatTerrain(), &mobs2);
    inDerLuft.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
    inDerLuft.spawnMob(10, art, 0.0f, 3.0f, -1, aur::kNoSpawner);
    // Knapp über dem Boden: es ist das Gerät, das schützt, und nicht die Höhe.
    // Ohne diese Zusatzbedingung wäre tief fliegen ein Weg, Monster im Kreis
    // zu führen, ohne je getroffen zu werden.
    inDerLuft.setFlying(1, true, 12.0f, 6.0f, 40.0f);
    for (int i = 0; i < 40; ++i) inDerLuft.step(aur::kTickSeconds);
    check(inDerLuft.find(10)->targetId == 0, "auf dem Gerät wird man nicht bemerkt");
    check(inDerLuft.find(1)->hp == inDerLuft.find(1)->maxHp,
          "und bleibt unversehrt");

    // Wer mitten in der Verfolgung aufsteigt, wird fallengelassen.
    aur::World aufgestiegen(25u, flatTerrain(), &mobs2);
    aufgestiegen.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
    aufgestiegen.spawnMob(10, art, 0.0f, 3.0f, -1, aur::kNoSpawner);
    for (int i = 0; i < 10; ++i) aufgestiegen.step(aur::kTickSeconds);
    check(aufgestiegen.find(10)->targetId == 1, "am Boden fasst er das Ziel");
    aufgestiegen.setFlying(1, true, 12.0f, 6.0f, 40.0f);
    aufgestiegen.step(aur::kTickSeconds);
    check(aufgestiegen.find(10)->targetId == 0, "beim Aufsteigen lässt er es fallen");

    // Die Gegenprobe: ohne Gerät jagt und trifft derselbe Keiler.
    aur::World amBoden(26u, flatTerrain(), &mobs2);
    amBoden.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
    amBoden.spawnMob(10, art, 0.0f, 3.0f, -1, aur::kNoSpawner);
    for (int i = 0; i < 40; ++i) amBoden.step(aur::kTickSeconds);
    check(amBoden.find(10)->targetId == 1, "am Boden wird man sehr wohl bemerkt");
    check(amBoden.find(1)->hp < amBoden.find(1)->maxHp, "und auch getroffen");
  }

  /*
   * --- Die Höhe zählt bei der Reichweite -----------------------------------
   *
   * Auch wenn vom Gerät aus niemand schlägt: die Monster schlagen sehr wohl,
   * und sie messen mit derselben Rechnung. Ohne den Höhenanteil träfe eines
   * einen Spieler, der dreissig Meter über ihm schwebt — die Entfernung auf
   * der Karte ist dann nämlich null.
   *
   * Geprüft mit einem Angreifer, der ganz gewöhnlich zuschlägt und dem nur die
   * Höhe gegeben wurde: die Rechnung sitzt in `resolveSwing` und gilt für alle.
   */
  {
    aur::MobRegistry mobs2;
    const uint32_t art = registerTestMob(mobs2, false);
    aur::World hoch(22u, flatTerrain(), &mobs2);
    hoch.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
    hoch.spawnMob(10, art, 0.0f, 2.0f, -1, aur::kNoSpawner);
    hoch.find(1)->y += 30.0f;
    hoch.find(1)->airborne = true;
    hoch.setTarget(1, 10);
    hoch.applyInput(1, 0.0f, 0.0f, 0.0f, aur::kButtonAttack, aur::kTickSeconds);
    for (int i = 0; i < 8; ++i) hoch.step(aur::kTickSeconds);
    check(hoch.find(10)->hp == 100.0f, "aus dreissig Metern Höhe trifft niemand");
  }

  /*
   * --- Versetzt heisst nicht gelandet --------------------------------------
   *
   * `teleport` ist nicht nur das Tor: mit demselben Aufruf korrigiert sich die
   * Vorhersage im Client, und zwar jedes Mal, wenn ein Paket fehlt. Landete
   * die Figur dabei, fiele mit `airborne` die Begrenzung im Tick weg — und die
   * Nase nach unten trüge sie anschliessend durch das Gelände hindurch. Genau
   * das war zu sehen.
   */
  // Lange genug, dass die Nase aus dem Sturzflug des letzten Abschnitts wieder
  // nach oben zeigt und die Figur Höhe gewinnt.
  world.setFlying(1, true, 12.0f, 6.0f, 20.0f);
  for (int i = 0; i < 90; ++i) {
    world.applyInput(1, 0.0f, 1.0f, 0.0f, schub, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  const float vorVersatz = p->y - boden;
  check(vorVersatz > aur::kFlugMindesthoehe + 1.0f, "vor dem Versatz steht sie in der Luft");

  // Derselbe Aufruf kommt nach jedem Ausrüstungswechsel. Ein Ring darf keine
  // Figur mitten im Flug waagerecht stellen.
  const float nase = p->pitch;
  const float fahrt = p->tempo;
  world.setFlying(1, true, 12.0f, 6.0f, 20.0f);
  check(p->pitch == nase && p->tempo == fahrt, "ein zweites Aufsteigen ändert die Lage nicht");
  world.teleport(1, 5.0f, 5.0f, 0.0f);
  check(p->airborne, "wer fliegt, bleibt nach einem Versatz in der Luft");

  /*
   * --- Wer absteigt, fällt — und wird nicht abgesetzt ----------------------
   *
   * Der Fehler war von aussen nicht zu erklären: aus vierzig Metern abgestiegen
   * stand die Figur im nächsten Augenblick unten, als hätte jemand sie
   * hingestellt. Der Sturz begann sehr wohl, aber die nächste Korrektur der
   * Vorhersage kam zwei Ticks später — und `versetze` stellte damals jeden auf
   * das Gelände, der nicht **flog**. Dass er gerade fiel, zählte nicht.
   *
   * Deshalb steht hier beides: der Sturz selbst, und dass ein Versatz mitten
   * darin ihn nicht beendet. Die Gegenprobe zum Versatz ist der Abschnitt
   * darunter — wer am Boden steht, bleibt beim Versetzen am Boden.
   */
  {
    aur::World fall(27u, flatTerrain(), &mobs);
    fall.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
    aur::Entity* f = fall.find(1);
    const float grund = f->y;
    fall.setFlying(1, true, 12.0f, 6.0f, 60.0f);
    f->y = grund + 40.0f;

    fall.setFlying(1, false, 0.0f, 0.0f, 0.0f);
    check(f->airborne, "nach dem Absteigen hängt sie nicht am Boden");
    check(std::fabs(f->y - (grund + 40.0f)) < 1e-3f, "und steht noch dort, wo sie abstieg");

    // Zwei Ticks fallen, dann ein Versatz — genau die Reihenfolge, in der die
    // Vorhersage sich korrigiert.
    fall.step(aur::kTickSeconds);
    fall.step(aur::kTickSeconds);
    const float nachZwei = f->y;
    check(nachZwei < grund + 40.0f && nachZwei > grund + 39.0f,
          "sie fängt an zu fallen, statt hinunterzuspringen");

    fall.teleport(1, 1.0f, 1.0f, 0.0f);
    check(std::fabs(f->y - nachZwei) < 1e-3f, "und ein Versatz setzt sie dabei nicht ab");

    // Und der Rest des Weges dauert: vierzig Meter sind bei dieser Schwerkraft
    // keine halbe Sekunde. Ohne diese Zeile ginge auch ein Kern durch, der
    // nach dem zweiten Tick doch noch springt.
    for (int i = 0; i < 20; ++i) fall.step(aur::kTickSeconds);
    check(f->y > grund + 20.0f, "nach einer Sekunde ist sie noch lange nicht unten");
    for (int i = 0; i < 200; ++i) fall.step(aur::kTickSeconds);
    check(!f->airborne && std::fabs(f->y - grund) < 1e-3f, "irgendwann kommt sie an");

    // Gegenprobe: wer am Boden steht, wird von einem Versatz auch dorthin
    // gesetzt. Sonst genügte ein `airborne = true` überall, und niemand
    // landete je wieder.
    fall.teleport(1, -3.0f, -3.0f, 0.0f);
    check(!f->airborne && std::fabs(f->y - grund) < 1e-3f,
          "am Boden bleibt ein Versatz am Boden");
  }
  checkNear(p->y - boden, vorVersatz, 0.1f, "und behält seine Höhe über dem Gelände");

  // Und die Begrenzung wirkt danach weiter.
  for (int i = 0; i < 200; ++i) {
    world.applyInput(1, 0.0f, -1.0f, 0.0f, schub, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  check(p->y >= boden + aur::kFlugMindesthoehe - 1e-3f,
        "durch das Gelände geht es auch nach einem Versatz nicht");

  /*
   * Absteigen heisst fallen.
   *
   * Die Gegenprobe zum Stehen in der Luft: dieselbe Figur, dieselbe Höhe, nur
   * ohne Gerät — und jetzt zieht die Schwerkraft. Ohne diese Prüfung ginge ein
   * Kern durch, in dem `setFlying(false)` schlicht nichts tut.
   */
  world.setFlying(1, true, 12.0f, 6.0f, 20.0f);
  for (int i = 0; i < 60; ++i) {
    world.applyInput(1, 0.0f, 1.0f, 0.0f, schub, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  const float hoch = p->y;
  check(hoch > boden + 5.0f, "vor dem Absteigen steht sie hoch genug");

  world.setFlying(1, false, 0.0f, 0.0f, 0.0f);
  check(!p->flying, "nach dem Absteigen fliegt sie nicht mehr");
  for (int i = 0; i < 100; ++i) {
    world.applyInput(1, 0.0f, 0.0f, 0.0f, keine, aur::kTickSeconds);
    world.step(aur::kTickSeconds);
  }
  check(p->y < hoch - 1.0f, "und fällt");
  check(std::fabs(p->y - boden) < 1e-3f, "bis auf den Boden");
  check(!p->airborne, "wo sie dann auch steht");
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

/**
 * Sperrzonen und schwebende Felsen.
 *
 * Beides ist Weltgeometrie, die von aussen kommt, und beides entscheidet der
 * Kern — also rechnen Client und Server dieselbe Grenze. Eine Sperre, die nur
 * der Server kennt, sähe im Bild wie ein Gummiband aus.
 */
void testZonenUndPlattformen() {
  std::printf("Sperrzonen und schwebende Felsen\n");
  aur::MobRegistry mobs;

  // --- Eine Zone, die nur den Fussweg sperrt ------------------------------
  {
    aur::World welt(31u, flatTerrain(), &mobs);
    welt.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
    aur::Entity* p = welt.find(1);
    // Ein Streifen quer vor der Figur, ab z = 10.
    welt.addZone(0.0f, 40.0f, 200.0f, 30.0f, true, false);

    for (int i = 0; i < 120; ++i) {
      welt.applyInput(1, 0.0f, 1.0f, 0.0f, 0u, aur::kTickSeconds);
      welt.step(aur::kTickSeconds);
    }
    check(p->z < 10.0f + 1e-2f, "zu Fuss endet der Weg an der Sperre");

    // Gegenprobe: dieselbe Zone, dieselbe Strecke — ohne Sperre läuft sie
    // durch. Ohne diese Zeile ginge auch ein Kern durch, in dem sich niemand
    // mehr bewegt.
    aur::World frei(32u, flatTerrain(), &mobs);
    frei.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
    for (int i = 0; i < 120; ++i) {
      frei.applyInput(1, 0.0f, 1.0f, 0.0f, 0u, aur::kTickSeconds);
      frei.step(aur::kTickSeconds);
    }
    check(frei.find(1)->z > 20.0f, "ohne Sperre läuft sie einfach weiter");
  }

  // --- Und eine, die nur den Flug sperrt ----------------------------------
  {
    aur::World welt(33u, flatTerrain(), &mobs);
    welt.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
    aur::Entity* p = welt.find(1);
    welt.addZone(0.0f, 40.0f, 200.0f, 30.0f, false, true);

    // Zu Fuss geht es hindurch — die Flagge gilt nur für die Luft.
    for (int i = 0; i < 120; ++i) {
      welt.applyInput(1, 0.0f, 1.0f, 0.0f, 0u, aur::kTickSeconds);
      welt.step(aur::kTickSeconds);
    }
    check(p->z > 20.0f, "eine reine Flugsperre hält niemanden zu Fuss auf");

    welt.teleport(1, 0.0f, -20.0f, 0.0f);
    welt.setFlying(1, true, 12.0f, 6.0f, 40.0f);
    for (int i = 0; i < 200; ++i) {
      welt.applyInput(1, 0.0f, 0.0f, 0.0f, aur::kButtonSchub, aur::kTickSeconds);
      welt.step(aur::kTickSeconds);
    }
    check(p->z < 10.0f + 1e-2f, "in der Luft endet der Kurs an derselben Sperre");
  }

  // --- Der schwebende Felsen ----------------------------------------------
  //
  // Drei Fragen, und alle drei hängen an `bodenHoehe`: fällt man darauf,
  // trägt er einen, und kommt man unter ihm hindurch?
  {
    aur::World welt(34u, flatTerrain(), &mobs);
    welt.spawnPlayer(testPlayer(1, 0.0f, 0.0f));
    aur::Entity* p = welt.find(1);
    const float grund = p->y;
    welt.addPlattform(0.0f, 0.0f, 12.0f, grund + 20.0f);

    // Von oben fallen: die Figur kommt auf dem Felsen an und nicht am Boden.
    p->y = grund + 30.0f;
    p->airborne = true;
    p->vy = 0.0f;
    for (int i = 0; i < 100; ++i) welt.step(aur::kTickSeconds);
    check(!p->airborne && std::fabs(p->y - (grund + 20.0f)) < 1e-2f,
          "wer darauf fällt, landet oben");

    // Und läuft dort herum, ohne herunterzurutschen.
    for (int i = 0; i < 20; ++i) {
      welt.applyInput(1, 0.0f, 1.0f, 0.0f, 0u, aur::kTickSeconds);
      welt.step(aur::kTickSeconds);
    }
    check(std::fabs(p->y - (grund + 20.0f)) < 1e-2f, "und geht oben darüber");

    /*
     * Über die Kante hinaus: **fallen**, nicht hinunterspringen.
     *
     * Der Unterschied ist der ganze Sinn der Sache. Ohne ihn stünde man einen
     * Schritt nach dem Rand zwanzig Meter tiefer im Gras, als hätte jemand
     * einen hingestellt — dieselbe Sorte Fehler wie beim Absteigen vom
     * Fluggerät.
     */
    int schritte = 0;
    while (std::sqrt(p->x * p->x + p->z * p->z) < 13.0f && schritte < 400) {
      welt.applyInput(1, 0.0f, 1.0f, 0.0f, 0u, aur::kTickSeconds);
      welt.step(aur::kTickSeconds);
      schritte++;
    }
    check(p->airborne && p->y > grund + 15.0f, "über die Kante hinaus fällt sie");
    for (int i = 0; i < 200; ++i) welt.step(aur::kTickSeconds);
    check(!p->airborne && std::fabs(p->y - grund) < 1e-2f, "und kommt unten an");

    // Die Gegenprobe zum Bezug auf `vonY`: wer unter dem Felsen steht, wird
    // nicht zu ihm hochgezogen. Ohne diese Bedingung wäre der Raum darunter
    // unbetretbar — und man käme nie wieder herunter.
    welt.teleport(1, 0.0f, 0.0f, 0.0f);
    check(std::fabs(p->y - grund) < 1e-2f, "darunter steht sie auf dem Gelände");

    /*
     * Und dieselbe Frage über die Brücke: `bodenUnter`.
     *
     * Der Zeichner braucht sie, um „am Boden" von „in der Luft" zu
     * unterscheiden, und er hatte dafür `heightAt` benutzt — das kennt nur das
     * Gelände. Auf dem Felsen war die Figur damit zwanzig Meter über dem Boden
     * und zog die Beine an: man lief darüber, und es sah aus wie Schweben.
     *
     * Drei Antworten, und die zweite und dritte sind die Gegenproben zur
     * ersten. Ohne sie wäre auch eine Fassung grün, die immer die Plattform
     * nimmt — und die machte den Raum darunter unbegehbar.
     */
    check(std::fabs(welt.bodenUnter(0.0f, 0.0f, grund + 20.0f) - (grund + 20.0f)) < 1e-2f,
          "von oben gefragt ist der Felsen der Boden");
    check(std::fabs(welt.bodenUnter(0.0f, 0.0f, grund) - grund) < 1e-2f,
          "von unten gefragt das Gelände");
    check(std::fabs(welt.bodenUnter(30.0f, 0.0f, grund + 20.0f) - grund) < 1e-2f,
          "und neben dem Felsen ebenfalls das Gelände");
  }
}

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
  testSpringUeberProp();
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
  testFliegen();
  testRegeneration();
  testMoveSpeedFromStats();
  testAreaAttack();
  testCritProfile();
  testWandering();
  testZonenUndPlattformen();

  std::printf("\n%d Prüfungen, %d fehlgeschlagen\n", g_checks, g_failures);
  return g_failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
