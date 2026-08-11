// Die Brücke zwischen wasm und JavaScript.
//
// Der Blueprint verlangt an dieser Stelle ausdrücklich „eine schmale, benannte
// Brücke" statt Flyffs Weg, bei dem C++ über emval einfach in den globalen
// Namensraum des Browsers greift und jeder Aufruf alles darf. Deshalb gilt hier:
//
//   * Jede Funktion, die JavaScript aufrufen darf, steht namentlich unten im
//     `EMSCRIPTEN_BINDINGS`-Block. Was dort nicht steht, existiert für die
//     andere Seite nicht.
//   * Der Kern ruft nie von sich aus in JavaScript hinein. Der Datenfluss ist
//     einseitig: JS fragt, C++ antwortet.
//   * Zustand wird nicht Feld für Feld übergeben, sondern als zusammenhängender
//     Puffer, über den JavaScript eine Sicht legt. Ein Aufruf pro Frame statt
//     einer pro Entity.
//   * `describeLayout` gibt die Byte-Versätze der gepackten Strukturen zurück,
//     damit die TypeScript-Seite den Vertrag beim Start prüfen kann, statt ihn
//     zu glauben.

#include <emscripten/bind.h>

#include <cstdint>
#include <string>

#include "aurelith/world.hpp"

using namespace emscripten;

namespace {

// Monsterarten sind global: sie unterscheiden sich nicht je Welt, und
// TypeScript reicht sie einmal beim Start hinein.
aur::MobRegistry& mobRegistry() {
  static aur::MobRegistry registry;
  return registry;
}

uint32_t registerMob(const aur::MobDef& def) {
  return mobRegistry().add(def);
}

void clearMobs() {
  mobRegistry().clear();
}

uint32_t mobCount() {
  return static_cast<uint32_t>(mobRegistry().size());
}

aur::World* createWorld(uint32_t seed, const aur::TerrainDef& terrain) {
  return new aur::World(seed, terrain, &mobRegistry());
}

// --- Zeiger als Zahlen -----------------------------------------------------
// Embind kennt keine typisierten Zeiger nach JS. Wir geben Adressen im
// wasm-Heap zurück; die TypeScript-Seite legt darüber ein DataView.

uintptr_t viewPointer(aur::World& world) {
  return reinterpret_cast<uintptr_t>(world.buildView());
}

uintptr_t eventPointer(aur::World& world) {
  return reinterpret_cast<uintptr_t>(world.events());
}

void sampleHeightGrid(aur::World& world, float originX, float originZ, float step, int countX,
                      int countZ, uintptr_t out) {
  world.sampleHeightGrid(originX, originZ, step, countX, countZ, reinterpret_cast<float*>(out));
}

uint32_t addSpawner(aur::World& world, float x, float z, float radius, float respawnSec,
                    uint32_t mobIndex, int32_t levelOverride) {
  aur::Spawner s;
  s.x = x;
  s.z = z;
  s.radius = radius;
  s.respawnSec = respawnSec;
  s.mobIndex = mobIndex;
  s.levelOverride = levelOverride;
  return world.addSpawner(s);
}

// --- Selbstauskunft --------------------------------------------------------
// Struktur-Layouts als Daten, damit die Gegenseite den Vertrag prüfen kann.

val describeLayout() {
  val entity = val::object();
  entity.set("stride", static_cast<int>(sizeof(aur::EntityView)));
  entity.set("id", static_cast<int>(offsetof(aur::EntityView, id)));
  entity.set("targetId", static_cast<int>(offsetof(aur::EntityView, targetId)));
  entity.set("x", static_cast<int>(offsetof(aur::EntityView, x)));
  entity.set("y", static_cast<int>(offsetof(aur::EntityView, y)));
  entity.set("z", static_cast<int>(offsetof(aur::EntityView, z)));
  entity.set("yaw", static_cast<int>(offsetof(aur::EntityView, yaw)));
  entity.set("vx", static_cast<int>(offsetof(aur::EntityView, vx)));
  entity.set("vz", static_cast<int>(offsetof(aur::EntityView, vz)));
  entity.set("hp", static_cast<int>(offsetof(aur::EntityView, hp)));
  entity.set("maxHp", static_cast<int>(offsetof(aur::EntityView, maxHp)));
  entity.set("radius", static_cast<int>(offsetof(aur::EntityView, radius)));
  entity.set("height", static_cast<int>(offsetof(aur::EntityView, height)));
  entity.set("defIndex", static_cast<int>(offsetof(aur::EntityView, defIndex)));
  entity.set("level", static_cast<int>(offsetof(aur::EntityView, level)));
  entity.set("type", static_cast<int>(offsetof(aur::EntityView, type)));
  entity.set("state", static_cast<int>(offsetof(aur::EntityView, state)));

  val event = val::object();
  event.set("stride", static_cast<int>(sizeof(aur::EventView)));
  event.set("type", static_cast<int>(offsetof(aur::EventView, type)));
  event.set("flags", static_cast<int>(offsetof(aur::EventView, flags)));
  event.set("a", static_cast<int>(offsetof(aur::EventView, a)));
  event.set("b", static_cast<int>(offsetof(aur::EventView, b)));
  event.set("value", static_cast<int>(offsetof(aur::EventView, value)));
  event.set("value2", static_cast<int>(offsetof(aur::EventView, value2)));
  event.set("x", static_cast<int>(offsetof(aur::EventView, x)));
  event.set("y", static_cast<int>(offsetof(aur::EventView, y)));
  event.set("z", static_cast<int>(offsetof(aur::EventView, z)));

  val out = val::object();
  out.set("entity", entity);
  out.set("event", event);
  return out;
}

std::string coreVersion() {
  return "0.1.0";
}

int tickRate() {
  return aur::kTickRate;
}

}  // namespace

EMSCRIPTEN_BINDINGS(aurelith_core) {
  // --- Wertobjekte ---------------------------------------------------------

  value_object<aur::TerrainDef>("TerrainDef")
      .field("size", &aur::TerrainDef::size)
      .field("cellSize", &aur::TerrainDef::cellSize)
      .field("seed", &aur::TerrainDef::seed)
      .field("heightScale", &aur::TerrainDef::heightScale)
      .field("featureScale", &aur::TerrainDef::featureScale);

  value_object<aur::MobDef>("MobDef")
      .field("maxHp", &aur::MobDef::maxHp)
      .field("attackDamage", &aur::MobDef::attackDamage)
      .field("defense", &aur::MobDef::defense)
      .field("moveSpeed", &aur::MobDef::moveSpeed)
      .field("aggroRange", &aur::MobDef::aggroRange)
      .field("leashRange", &aur::MobDef::leashRange)
      .field("attackRange", &aur::MobDef::attackRange)
      .field("attackArc", &aur::MobDef::attackArc)
      .field("attackCooldownSec", &aur::MobDef::attackCooldownSec)
      .field("attackWindupSec", &aur::MobDef::attackWindupSec)
      .field("radius", &aur::MobDef::radius)
      .field("height", &aur::MobDef::height)
      .field("expReward", &aur::MobDef::expReward)
      .field("goldReward", &aur::MobDef::goldReward)
      .field("level", &aur::MobDef::level)
      .field("aggressive", &aur::MobDef::aggressive);

  value_object<aur::PlayerSpawn>("PlayerSpawn")
      .field("id", &aur::PlayerSpawn::id)
      .field("level", &aur::PlayerSpawn::level)
      .field("x", &aur::PlayerSpawn::x)
      .field("z", &aur::PlayerSpawn::z)
      .field("yaw", &aur::PlayerSpawn::yaw)
      .field("hp", &aur::PlayerSpawn::hp)
      .field("maxHp", &aur::PlayerSpawn::maxHp)
      .field("mp", &aur::PlayerSpawn::mp)
      .field("maxMp", &aur::PlayerSpawn::maxMp)
      .field("attackDamage", &aur::PlayerSpawn::attackDamage)
      .field("defense", &aur::PlayerSpawn::defense)
      .field("moveSpeed", &aur::PlayerSpawn::moveSpeed)
      .field("attackRange", &aur::PlayerSpawn::attackRange)
      .field("attackArc", &aur::PlayerSpawn::attackArc)
      .field("attackCooldownSec", &aur::PlayerSpawn::attackCooldownSec)
      .field("attackWindupSec", &aur::PlayerSpawn::attackWindupSec)
      .field("radius", &aur::PlayerSpawn::radius)
      .field("height", &aur::PlayerSpawn::height);

  // --- Welt ----------------------------------------------------------------

  class_<aur::World>("World")
      .constructor(&createWorld, allow_raw_pointers())

      // Aufbau
      .function("addCollider", &aur::World::addCollider)
      .function("clearColliders", &aur::World::clearColliders)
      .function("addSpawner", &addSpawner)
      .function("clearSpawners", &aur::World::clearSpawners)

      // Entities
      .function("spawnPlayer", &aur::World::spawnPlayer)
      .function("spawnMob", &aur::World::spawnMob)
      .function("spawnNpc", &aur::World::spawnNpc)
      .function("removeEntity", &aur::World::removeEntity)

      // Ablauf
      .function("applyInput", &aur::World::applyInput)
      .function("step", &aur::World::step)

      // Eingriffe
      .function("teleport", &aur::World::teleport)
      .function("respawnPlayer", &aur::World::respawnPlayer)
      .function("setTarget", &aur::World::setTarget)
      .function("setPlayerStats", &aur::World::setPlayerStats)

      // Auslesen
      .function("tick", &aur::World::tick)
      .function("entityCount", &aur::World::entityCount)
      .function("viewPointer", &viewPointer)
      .function("viewCount", &aur::World::viewCount)
      .function("eventPointer", &eventPointer)
      .function("eventCount", &aur::World::eventCount)
      .function("clearEvents", &aur::World::clearEvents)
      .function("heightAt", &aur::World::heightAt)
      .function("slopeAt", &aur::World::slopeAt)
      .function("sampleHeightGrid", &sampleHeightGrid);

  // --- Freie Funktionen ----------------------------------------------------

  function("registerMob", &registerMob);
  function("clearMobs", &clearMobs);
  function("mobCount", &mobCount);
  function("describeLayout", &describeLayout);
  function("coreVersion", &coreVersion);
  function("tickRate", &tickRate);
}
