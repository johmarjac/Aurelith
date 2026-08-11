// Weltzustand und Tick.
//
// Der Server hält eine `World` je Map. Der Client hält eine `World`, die nur
// seine eigene Figur und die Kollider der Map enthält — dieselbe Klasse,
// dieselben Funktionen, nur weniger darin. Das ist der Kern der Zusicherung
// „eine Simulation, zweimal gehostet".

#pragma once

#include <cstddef>
#include <unordered_map>
#include <vector>

#include "aurelith/math.hpp"
#include "aurelith/terrain.hpp"
#include "aurelith/types.hpp"

namespace aur {

// Monsterarten. Global statt je Welt, weil sie sich zur Laufzeit nicht
// unterscheiden und TypeScript sie einmal beim Start hineinreicht.
class MobRegistry {
 public:
  uint32_t add(const MobDef& def) {
    defs_.push_back(def);
    return static_cast<uint32_t>(defs_.size() - 1);
  }

  const MobDef* get(uint32_t index) const {
    return index < defs_.size() ? &defs_[index] : nullptr;
  }

  size_t size() const { return defs_.size(); }
  void clear() { defs_.clear(); }

 private:
  std::vector<MobDef> defs_;
};

// Startwerte einer Spielerfigur. Kommen aus der Datenbank über den Server.
struct PlayerSpawn {
  uint32_t id = 0;
  uint16_t level = 1;
  float x = 0.0f;
  float z = 0.0f;
  float yaw = 0.0f;
  float hp = 0.0f;
  float maxHp = 1.0f;
  float mp = 0.0f;
  float maxMp = 0.0f;
  float attackDamage = 1.0f;
  float defense = 0.0f;
  float moveSpeed = 6.0f;
  float attackRange = 3.0f;
  float attackArc = 2.67f;
  float attackCooldownSec = 0.62f;
  float attackWindupSec = 0.15f;
  float radius = 0.45f;
  float height = 1.8f;
};

class World {
 public:
  World(uint32_t seed, const TerrainDef& terrain, const MobRegistry* mobs);

  // --- Aufbau ------------------------------------------------------------

  void addCollider(float x, float z, float radius);
  void clearColliders();

  /**
   * Legt das Feld der von Hand geformten Höhen an.
   *
   * Der Kern besitzt den Speicher, nicht JavaScript. Das erspart `_malloc` an
   * der Brücke und stellt sicher, dass der Zeiger in `TerrainDef` genau so
   * lange gilt wie die Welt selbst — er wird bei jedem einzelnen Höhenabruf
   * gelesen, und ein Feld, das JavaScript zwischendurch freigibt, wäre der
   * unangenehmste denkbare Fehler.
   *
   * `resolution` kleiner als zwei schaltet das Feld ab. Der Inhalt ist nach
   * dem Anlegen null; beschrieben wird er über `sculptData()`.
   */
  void resizeSculpt(int resolution);

  /** Zeiger auf das Höhenfeld, damit JavaScript hineinschreiben kann. */
  int16_t* sculptData() { return sculpt_.empty() ? nullptr : sculpt_.data(); }
  int sculptResolution() const { return terrain_.sculptResolution; }
  uint32_t addSpawner(const Spawner& spawner);
  void clearSpawners();

  // --- Entities ----------------------------------------------------------

  bool spawnPlayer(const PlayerSpawn& seed);
  bool spawnMob(uint32_t id, uint32_t mobIndex, float x, float z, int32_t levelOverride,
                uint32_t spawnerIndex);
  bool spawnNpc(uint32_t id, float x, float z, float yaw, float radius, float height);
  bool removeEntity(uint32_t id);

  Entity* find(uint32_t id);
  const Entity* find(uint32_t id) const;

  // --- Ablauf ------------------------------------------------------------

  // Wendet ein Eingabekommando an: Bewegung, Blickrichtung und — falls die
  // Angriffstaste gehalten wird — der Beginn eines Schlags.
  void applyInput(uint32_t id, float moveX, float moveZ, float yaw, uint32_t buttons, float dt);

  void step(float dt);

  // --- Eingriffe von außen ----------------------------------------------

  void teleport(uint32_t id, float x, float z, float yaw);
  void respawnPlayer(uint32_t id, float x, float z);
  void setTarget(uint32_t id, uint32_t targetId);
  void setPlayerStats(uint32_t id, uint16_t level, float maxHp, float maxMp, float attackDamage,
                      float defense);

  // --- Auslesen ----------------------------------------------------------

  uint32_t tick() const { return tick_; }
  size_t entityCount() const { return entities_.size(); }

  // Füllt den Sichtpuffer und liefert einen Zeiger darauf. JavaScript legt
  // eine Sicht über den wasm-Heap — kein Aufruf pro Entity.
  const EntityView* buildView();
  size_t viewCount() const { return view_.size(); }

  const EventView* events() const { return events_.empty() ? nullptr : events_.data(); }
  size_t eventCount() const { return events_.size(); }
  void clearEvents() { events_.clear(); }

  float heightAt(float x, float z) const { return terrainHeight(x, z, terrain_); }
  float slopeAt(float x, float z) const { return terrainSlopeDeg(x, z, terrain_); }

  // Füllt ein regelmäßiges Höhengitter in einem Aufruf. Der Renderer baut sein
  // Terrainnetz daraus, ohne je Stützpunkt über die Brücke zu gehen.
  void sampleHeightGrid(float originX, float originZ, float step, int countX, int countZ,
                        float* out) const;

  const TerrainDef& terrain() const { return terrain_; }
  Rng& rng() { return rng_; }

 private:
  // Bewegung
  bool tryStep(Entity& e, float dx, float dz);
  void moveWithCollision(Entity& e, float dx, float dz, float* outDx, float* outDz);
  void moveTowards(Entity& e, float targetX, float targetZ, float dt, float speedFactor);

  // Kampf
  bool tryStartSwing(Entity& e);
  void resolveSwing(Entity& attacker);
  void applyDamage(Entity& attacker, Entity& target);

  // Tick-Abschnitte
  void advanceTimers(Entity& e, float dt);
  void updateMonsterAi(Entity& e, float dt);
  void resolveOverlaps();
  void regenerate(float dt);
  void handleRespawns();
  void respawnMonster(Entity& e);

  Entity* findByIndex(size_t index) { return &entities_[index]; }

  TerrainDef terrain_;
  const MobRegistry* mobs_;
  Rng rng_;
  uint32_t tick_ = 0;

  std::vector<Entity> entities_;
  std::unordered_map<uint32_t, size_t> index_;
  std::vector<Collider> colliders_;
  /** Von Hand geformte Höhen. `terrain_.sculpt` zeigt hierauf. */
  std::vector<int16_t> sculpt_;
  std::vector<Spawner> spawners_;

  std::vector<EntityView> view_;
  std::vector<EventView> events_;
};

bool isAlive(const Entity& e);
bool isHostile(const Entity& a, const Entity& b);

// Schadensformel. Verteidigung dämpft, statt hart abzuziehen.
float computeDamage(float attack, float defense, float roll);

}  // namespace aur
