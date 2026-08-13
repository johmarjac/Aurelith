// Datentypen des Kerns.
//
// Zwei Sorten von Strukturen leben hier nebeneinander:
//
//   * `Entity`, `MobDef`, `Spawner` — interner Zustand, den nur C++ sieht.
//   * `EntityView`, `EventView` — gepackte Zeilen, die JavaScript direkt aus
//     dem wasm-Heap liest. Ihre Feldreihenfolge ist Vertrag mit der
//     TypeScript-Seite; wer hier etwas verschiebt, muss `coreLayout.ts`
//     mitziehen.
//
// Der Grund für die zweite Sorte: ein Aufruf über die Brücke pro Entity und
// Frame wäre der teuerste Weg, den man wählen kann. Stattdessen füllt der Kern
// einen zusammenhängenden Puffer, und JS legt eine Sicht darüber.

#pragma once

#include <cstdint>

namespace aur {

constexpr int kTickRate = 20;
constexpr float kTickSeconds = 1.0f / static_cast<float>(kTickRate);

// Steiler als das wird nicht mehr begangen.
constexpr float kMaxWalkableSlopeDeg = 52.0f;

// --- Springen --------------------------------------------------------------
//
// Beide Zahlen liegen deutlich über der Wirklichkeit, und das ist Absicht: mit
// 9,81 m/s² schwebt eine Figur, die gut einen Meter hoch springt, fast eine
// Sekunde lang durch die Luft, und das fühlt sich an wie auf dem Mond. 22 und
// 7,2 ergeben 1,18 Meter Scheitelhöhe in 0,65 Sekunden — hoch genug, dass man
// den Sprung sieht, kurz genug, dass er die Steuerung nicht anhält.
constexpr float kGravity = 22.0f;
constexpr float kJumpSpeed = 7.2f;

// Höchstzahl der Ziele eines Flächenangriffs. Deckelt den schlimmsten Fall —
// wer in einer Herde steht, soll sie treffen, aber nicht den Server aufhalten.
constexpr int kMaxAreaTargets = 16;

// Trefferpause des Opfers in Sekunden.
constexpr float kHitStunSeconds = 0.18f;

// Tempoanteile während Vorlauf und Trefferpause.
constexpr float kWindupSpeedFactor = 0.25f;
constexpr float kHitStunSpeedFactor = 0.40f;

// Regeneration außerhalb des Kampfes, Anteil des Maximums je Sekunde.
constexpr float kOutOfCombatRegen = 0.04f;

// --- Umherwandern ----------------------------------------------------------
//
// Kürzeste und längste Wanderung, und die Pause dazwischen. Die Pause ist
// länger als der Weg, und das ist Absicht: eine Wiese, auf der alles
// gleichzeitig unterwegs ist, wirkt unruhig. Wer stehenbleibt, gibt der
// Bewegung der anderen einen Hintergrund.
//
// Stehen hier und nicht in `ai.cpp`, weil das Erscheinen die Pause ebenfalls
// braucht: ein frisch erschienenes Monster rastet erst einmal.
constexpr float kWanderWalkMin = 3.0f;
constexpr float kWanderWalkMax = 8.0f;
constexpr float kWanderRest = 10.0f;
// Wandern ist ein Spaziergang, kein Sprint. Knapp ein Drittel des Laufschritts
// — bei knapp der Hälfte sah es aus, als hätte das Wesen einen Termin.
constexpr float kWanderSpeedFactor = 0.3f;
// So nah am Ziel gilt es als erreicht.
constexpr float kWanderArrive = 0.6f;

// --- Wiederkehr ------------------------------------------------------------
//
// Wie lange ein erlegtes Monster wegbleibt, wenn die Karte nichts anderes
// sagt, und wie weit die Zeit dabei streut.
//
// Die Streuung ist kein Beiwerk: wer ein Feld leerräumt, erlegt alles
// innerhalb einer Minute — und ohne Streuung stünde die ganze Gruppe eine
// Minute später auf die Sekunde genau wieder da. Mit ±20 % tröpfeln sie
// zurück, und die Wiese füllt sich, statt umzuspringen.
constexpr float kDefaultRespawnSec = 75.0f;
constexpr float kRespawnSpread = 0.2f;

// Ab so vielen Entities wird die paarweise Trennung übersprungen.
constexpr int kSeparationEntityLimit = 400;

enum EntityType : uint8_t {
  kEntityPlayer = 0,
  kEntityMonster = 1,
  kEntityNpc = 2,
};

enum EntityState : uint8_t {
  kStateIdle = 0,
  kStateMove = 1,
  kStateAttack = 2,
  kStateDead = 3,
};

enum InputButton : uint32_t {
  kButtonAttack = 1u << 0,
  kButtonJump = 1u << 1,
  kButtonInteract = 1u << 2,
  kButtonSit = 1u << 3,
};

enum EventType : uint8_t {
  kEventHit = 0,
  kEventDeath = 1,
  kEventSpawn = 2,
  kEventExp = 3,
};

enum CombatFlag : uint8_t {
  kCombatNone = 0,
  kCombatCritical = 1u << 0,
  kCombatKilling = 1u << 1,
  kCombatMiss = 1u << 2,
  // Der Treffer kam aus einer Fertigkeit und nicht aus einem gewöhnlichen
  // Schlag. Der Client zeigt daraufhin einen kräftigeren Funkenschlag.
  kCombatSkill = 1u << 4,
  // Der Treffer kam aus der Ferne. Der Client zeichnet daraufhin einen Pfeil
  // vom Angreifer zum Ziel — die Flugbahn ist reine Anzeige, der Schaden ist
  // in dem Moment schon gefallen.
  kCombatRanged = 1u << 3,
};

// Angriffsarten.
constexpr uint8_t kAttackMelee = 0;
constexpr uint8_t kAttackRanged = 1;

constexpr uint32_t kNoSpawner = 0xffffffffu;
constexpr uint32_t kNoDef = 0xffffffffu;

// Parameter des Höhenfelds. Kommen aus dem Map-Dokument, das TypeScript liest.
struct TerrainDef {
  float size = 512.0f;
  float cellSize = 4.0f;
  uint32_t seed = 1u;
  float heightScale = 14.0f;
  float featureScale = 0.012f;

  // --- Von Hand geformte Höhen -------------------------------------------
  //
  // Das Grundrelief kommt aus dem Seed und ist auf beiden Seiten dieselbe
  // Rechnung. Wer im Editor Hügel aufschüttet, kann das Rauschen aber nicht
  // umstimmen — also kommt sein Ergebnis als Differenzfeld obendrauf.
  //
  // Bewusst ein Zeiger und keine Kopie: `TerrainDef` wird bei jedem Aufruf von
  // `terrainHeight` als Referenz gereicht, und das Gitter kann Zehntausende
  // Stützpunkte haben. Eigentümer ist die `World`, die es am Leben hält,
  // solange sie selbst lebt.
  //
  // Die Felder stehen absichtlich nicht in der embind-Beschreibung: von
  // TypeScript kommt die Form der Karte, nicht ihr Speicher. Der wird über
  // `World::resizeSculpt` angefordert und über `sculptPointer()` beschrieben.

  /** Quadratisches Gitter, Werte in 1/kSculptUnit Weltmetern. Null = aus. */
  const int16_t* sculpt = nullptr;
  /** Stützpunkte je Kante. Kleiner als zwei heißt: kein Feld. */
  int32_t sculptResolution = 0;
};

/**
 * Auflösung der gespeicherten Höhendifferenzen.
 *
 * int16 in Vierundsechzigsteln reicht von -512 bis +512 Metern bei anderthalb
 * Zentimetern Schrittweite. Das ist weit mehr Spielraum, als eine Karte je
 * braucht, und fein genug, dass man die Stufen nicht sieht.
 */
constexpr float kSculptUnit = 64.0f;

// Werte einer Monsterart. Werden von TypeScript aus der Content-Tabelle
// hineingereicht, damit Balancing keinen Neubau des Kerns erzwingt.
struct MobDef {
  float maxHp = 10.0f;
  float attackDamage = 1.0f;
  float defense = 0.0f;
  float moveSpeed = 4.0f;
  float aggroRange = 0.0f;
  float leashRange = 40.0f;
  float attackRange = 2.0f;
  float attackCooldownSec = 1.5f;
  float attackWindupSec = 0.3f;
  /** 0 = Nahkampf, 1 = Fernkampf. Unterscheidet nur Reichweite und Bild. */
  uint32_t attackStyle = 0u;
  float radius = 0.6f;
  float height = 1.6f;
  float expReward = 10.0f;
  float goldReward = 3.0f;
  uint16_t level = 1;
  uint8_t aggressive = 0;
};

struct Spawner {
  float x = 0.0f;
  float z = 0.0f;
  float radius = 20.0f;
  float respawnSec = 12.0f;
  uint32_t mobIndex = kNoDef;
  int32_t levelOverride = -1;
};

struct Collider {
  float x;
  float z;
  float radius;
};

struct Entity {
  uint32_t id = 0;
  uint8_t type = kEntityPlayer;
  uint8_t state = kStateIdle;
  uint16_t level = 1;
  /**
   * Wie zugeschlagen wird.
   *
   * Getroffen wird in beiden Fällen genau das anvisierte Ziel. Der Unterschied
   * liegt in der Reichweite — und darin, dass ein Fernkampftreffer als solcher
   * gemeldet wird, damit der Client einen Pfeil zeichnet.
   */
  uint8_t attackStyle = kAttackMelee;

  float x = 0.0f, y = 0.0f, z = 0.0f, yaw = 0.0f;
  float vx = 0.0f, vz = 0.0f;

  float hp = 1.0f, maxHp = 1.0f;
  float mp = 0.0f, maxMp = 0.0f;

  /**
   * Senkrechte Geschwindigkeit und ob die Figur den Boden verlassen hat.
   *
   * `airborne` ist kein abgeleiteter Wert, obwohl man ihn aus `y` und dem
   * Gelände ausrechnen könnte: die Figur steht beim Absprung noch exakt auf
   * dem Boden, und ein Vergleich ergäbe „am Boden" — der Sprung endete im
   * selben Tick, in dem er beginnt. Das Merkmal gehört zum Zustand, nicht zur
   * Geometrie.
   */
  float vy = 0.0f;
  bool airborne = false;

  float attackCooldown = 0.0f;
  // Negativ heißt: kein Schlag unterwegs.
  float swingTimer = -1.0f;
  float hitStun = 0.0f;

  uint32_t targetId = 0;

  float attackDamage = 1.0f;
  float defense = 0.0f;
  float moveSpeed = 5.0f;
  // Kritische Treffer als Eigenschaft der Figur und nicht als Konstante im
  // Kampfcode. Solange sie fest verdrahtet waren, konnte keine Ausrüstung und
  // kein Monster daran etwas ändern — und die Werte standen an einer Stelle,
  // die von aussen nicht einmal ablesbar war.
  float critChance = 0.12f;
  float critMultiplier = 1.75f;
  float attackRange = 2.0f;
  float attackCooldownSec = 0.9f;
  float attackWindupSec = 0.2f;

  float aggroRange = 0.0f;
  float leashRange = 0.0f;
  float radius = 0.5f;
  float height = 1.8f;

  float homeX = 0.0f, homeZ = 0.0f;

  // --- Umherwandern ---------------------------------------------------------
  //
  // Ein Monster ohne Ziel stand vorher still. Das sah aus wie eine Puppe im
  // Regal und nicht wie ein Tier auf einer Wiese. Es läuft deshalb eine Weile
  // zu einem Punkt in seinem Feld, bleibt dann stehen, und sucht sich danach
  // den nächsten — mehr Verhalten braucht es dafür nicht.
  //
  // `wanderTimer` zählt die Restzeit des laufenden Abschnitts herunter,
  // `wanderWalking` sagt, welcher Abschnitt das ist. Beides gehört zur Figur
  // und nicht in eine Tabelle daneben: eine zweite Liste, die dieselben
  // Wesen adressiert, läuft beim Entfernen eines Monsters auseinander.
  float wanderTimer = 0.0f;
  float wanderX = 0.0f, wanderZ = 0.0f;
  // Wie weit vom Feldmittelpunkt es sich entfernen darf. Null heisst: gar
  // nicht — dann bleibt es, wo es steht.
  float wanderRadius = 0.0f;
  bool wanderWalking = false;

  uint32_t spawnerIndex = kNoSpawner;
  uint32_t defIndex = kNoDef;
  uint32_t respawnTick = 0;

  float expReward = 0.0f;
  float goldReward = 0.0f;
};

// ---------------------------------------------------------------------------
// Gepackte Sichten für JavaScript. Feldreihenfolge = Vertrag.
// ---------------------------------------------------------------------------

#pragma pack(push, 1)

struct EntityView {
  uint32_t id;        // +0
  uint32_t targetId;  // +4
  float x;            // +8
  float y;            // +12
  float z;            // +16
  float yaw;          // +20
  float vx;           // +24
  float vz;           // +28
  float hp;           // +32
  float maxHp;        // +36
  float radius;       // +40
  float height;       // +44
  uint32_t defIndex;  // +48
  uint16_t level;     // +52
  uint8_t type;       // +54
  uint8_t state;      // +55
};                    // 56 Byte

struct EventView {
  uint8_t type;    // +0
  uint8_t flags;   // +1
  uint16_t pad;    // +2
  uint32_t a;      // +4  Angreifer / betroffenes Entity
  uint32_t b;      // +8  Opfer / Töter
  float value;     // +12 Schaden bzw. Erfahrung
  float value2;    // +16 Gold
  float x;         // +20
  float y;         // +24
  float z;         // +28
};                 // 32 Byte

#pragma pack(pop)

static_assert(sizeof(EntityView) == 56, "EntityView-Layout ist Vertrag mit TypeScript");
static_assert(sizeof(EventView) == 32, "EventView-Layout ist Vertrag mit TypeScript");

}  // namespace aur
