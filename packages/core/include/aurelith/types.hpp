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

// Höchstzahl der Ziele eines Schlags. Deckelt den schlimmsten Fall.
constexpr int kMaxTargetsPerSwing = 12;

// Trefferpause des Opfers in Sekunden.
constexpr float kHitStunSeconds = 0.18f;

// Tempoanteile während Vorlauf und Trefferpause.
constexpr float kWindupSpeedFactor = 0.25f;
constexpr float kHitStunSpeedFactor = 0.40f;

// Regeneration außerhalb des Kampfes, Anteil des Maximums je Sekunde.
constexpr float kOutOfCombatRegen = 0.04f;

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
};

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
  float attackArc = 2.0f;
  float attackCooldownSec = 1.5f;
  float attackWindupSec = 0.3f;
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

  float x = 0.0f, y = 0.0f, z = 0.0f, yaw = 0.0f;
  float vx = 0.0f, vz = 0.0f;

  float hp = 1.0f, maxHp = 1.0f;
  float mp = 0.0f, maxMp = 0.0f;

  float attackCooldown = 0.0f;
  // Negativ heißt: kein Schlag unterwegs.
  float swingTimer = -1.0f;
  float hitStun = 0.0f;

  uint32_t targetId = 0;

  float attackDamage = 1.0f;
  float defense = 0.0f;
  float moveSpeed = 5.0f;
  float attackRange = 2.0f;
  float attackArc = 2.2f;
  float attackCooldownSec = 0.9f;
  float attackWindupSec = 0.2f;

  float aggroRange = 0.0f;
  float leashRange = 0.0f;
  float radius = 0.5f;
  float height = 1.8f;

  float homeX = 0.0f, homeZ = 0.0f;
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
