#include "aurelith/world.hpp"

#include <algorithm>

namespace aur {

World::World(uint32_t seed, const TerrainDef& terrain, const MobRegistry* mobs)
    : terrain_(terrain), mobs_(mobs), rng_(seed == 0u ? 1u : seed) {}

// ---------------------------------------------------------------------------
// Aufbau
// ---------------------------------------------------------------------------

void World::addCollider(float x, float z, float radius) {
  colliders_.push_back({x, z, radius});
}

void World::clearColliders() {
  colliders_.clear();
}

uint32_t World::addSpawner(const Spawner& spawner) {
  spawners_.push_back(spawner);
  return static_cast<uint32_t>(spawners_.size() - 1);
}

void World::clearSpawners() {
  spawners_.clear();
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

bool World::spawnPlayer(const PlayerSpawn& seed) {
  if (index_.count(seed.id) != 0) return false;

  Entity e;
  e.id = seed.id;
  e.type = kEntityPlayer;
  e.state = kStateIdle;
  e.level = seed.level;
  e.x = seed.x;
  e.z = seed.z;
  e.y = terrainHeight(seed.x, seed.z, terrain_);
  e.yaw = seed.yaw;
  e.maxHp = seed.maxHp;
  e.hp = seed.hp > 0.0f ? std::min(seed.hp, seed.maxHp) : seed.maxHp;
  e.maxMp = seed.maxMp;
  e.mp = seed.mp > 0.0f ? std::min(seed.mp, seed.maxMp) : seed.maxMp;
  e.attackDamage = seed.attackDamage;
  e.defense = seed.defense;
  e.moveSpeed = seed.moveSpeed;
  e.attackRange = seed.attackRange;
  e.attackArc = seed.attackArc;
  e.attackCooldownSec = seed.attackCooldownSec;
  e.attackWindupSec = seed.attackWindupSec;
  e.radius = seed.radius;
  e.height = seed.height;
  e.homeX = seed.x;
  e.homeZ = seed.z;
  e.spawnerIndex = kNoSpawner;
  e.defIndex = kNoDef;

  index_[e.id] = entities_.size();
  entities_.push_back(e);
  return true;
}

bool World::spawnMob(uint32_t id, uint32_t mobIndex, float x, float z, int32_t levelOverride,
                     uint32_t spawnerIndex) {
  if (index_.count(id) != 0) return false;
  const MobDef* def = mobs_ ? mobs_->get(mobIndex) : nullptr;
  if (def == nullptr) return false;

  const uint16_t level =
      levelOverride > 0 ? static_cast<uint16_t>(levelOverride) : def->level;
  // Stufenabweichung skaliert die Werte linear. Reicht, solange Spawner nur
  // leicht über oder unter der Grundstufe liegen.
  const float scale =
      static_cast<float>(level) / static_cast<float>(def->level > 0 ? def->level : 1);

  Entity e;
  e.id = id;
  e.type = kEntityMonster;
  e.state = kStateIdle;
  e.level = level;
  e.x = x;
  e.z = z;
  e.y = terrainHeight(x, z, terrain_);
  e.yaw = rng_.next() * kTau;
  e.maxHp = def->maxHp * scale;
  e.hp = e.maxHp;
  e.attackDamage = def->attackDamage * scale;
  e.defense = def->defense * scale;
  e.moveSpeed = def->moveSpeed;
  e.attackRange = def->attackRange;
  e.attackArc = def->attackArc;
  e.attackCooldownSec = def->attackCooldownSec;
  e.attackWindupSec = def->attackWindupSec;
  // Friedliche Monster bekommen gar keine Wahrnehmung — sie schlagen nur
  // zurück, wenn man sie trifft. Damit braucht die KI kein zweites Feld.
  e.aggroRange = def->aggressive != 0 ? def->aggroRange : 0.0f;
  e.leashRange = def->leashRange;
  e.radius = def->radius;
  e.height = def->height;
  e.homeX = x;
  e.homeZ = z;
  e.spawnerIndex = spawnerIndex;
  e.defIndex = mobIndex;
  e.expReward = def->expReward;
  e.goldReward = def->goldReward;

  index_[e.id] = entities_.size();
  entities_.push_back(e);
  return true;
}

bool World::spawnNpc(uint32_t id, float x, float z, float yaw, float radius, float height) {
  if (index_.count(id) != 0) return false;

  Entity e;
  e.id = id;
  e.type = kEntityNpc;
  e.state = kStateIdle;
  e.x = x;
  e.z = z;
  e.y = terrainHeight(x, z, terrain_);
  e.yaw = yaw;
  e.hp = 1.0f;
  e.maxHp = 1.0f;
  e.moveSpeed = 0.0f;
  e.radius = radius;
  e.height = height;
  e.homeX = x;
  e.homeZ = z;

  index_[e.id] = entities_.size();
  entities_.push_back(e);
  return true;
}

bool World::removeEntity(uint32_t id) {
  auto it = index_.find(id);
  if (it == index_.end()) return false;

  const size_t slot = it->second;
  const size_t last = entities_.size() - 1;
  if (slot != last) {
    entities_[slot] = entities_[last];
    index_[entities_[slot].id] = slot;
  }
  entities_.pop_back();
  index_.erase(it);
  return true;
}

Entity* World::find(uint32_t id) {
  auto it = index_.find(id);
  return it == index_.end() ? nullptr : &entities_[it->second];
}

const Entity* World::find(uint32_t id) const {
  auto it = index_.find(id);
  return it == index_.end() ? nullptr : &entities_[it->second];
}

// ---------------------------------------------------------------------------
// Eingriffe von außen
// ---------------------------------------------------------------------------

void World::teleport(uint32_t id, float x, float z, float yaw) {
  Entity* e = find(id);
  if (e == nullptr) return;
  e->x = clampToMap(x, terrain_);
  e->z = clampToMap(z, terrain_);
  e->y = terrainHeight(e->x, e->z, terrain_);
  e->yaw = yaw;
  e->vx = 0.0f;
  e->vz = 0.0f;
  e->swingTimer = -1.0f;
  e->targetId = 0;
  e->homeX = e->x;
  e->homeZ = e->z;
}

void World::respawnPlayer(uint32_t id, float x, float z) {
  Entity* e = find(id);
  if (e == nullptr) return;
  e->x = clampToMap(x, terrain_);
  e->z = clampToMap(z, terrain_);
  e->y = terrainHeight(e->x, e->z, terrain_);
  e->hp = std::max(1.0f, e->maxHp * 0.5f);
  e->mp = e->maxMp * 0.5f;
  e->state = kStateIdle;
  e->swingTimer = -1.0f;
  e->attackCooldown = 0.0f;
  e->hitStun = 0.0f;
  e->targetId = 0;
  e->vx = 0.0f;
  e->vz = 0.0f;

  EventView ev{};
  ev.type = kEventSpawn;
  ev.a = e->id;
  ev.x = e->x;
  ev.y = e->y;
  ev.z = e->z;
  events_.push_back(ev);
}

void World::setTarget(uint32_t id, uint32_t targetId) {
  Entity* e = find(id);
  if (e != nullptr) e->targetId = targetId;
}

void World::setPlayerStats(uint32_t id, uint16_t level, float maxHp, float maxMp,
                           float attackDamage, float defense) {
  Entity* e = find(id);
  if (e == nullptr) return;
  const float hpRatio = e->maxHp > 0.0f ? e->hp / e->maxHp : 1.0f;
  e->level = level;
  e->maxHp = maxHp;
  e->maxMp = maxMp;
  // Beim Stufenaufstieg bleibt der Anteil erhalten, statt voll zu heilen.
  e->hp = std::min(maxHp, maxHp * hpRatio);
  e->mp = std::min(maxMp, e->mp);
  e->attackDamage = attackDamage;
  e->defense = defense;
}

// ---------------------------------------------------------------------------
// Auslesen
// ---------------------------------------------------------------------------

const EntityView* World::buildView() {
  view_.clear();
  view_.reserve(entities_.size());
  for (const Entity& e : entities_) {
    EntityView v{};
    v.id = e.id;
    v.targetId = e.targetId;
    v.x = e.x;
    v.y = e.y;
    v.z = e.z;
    v.yaw = e.yaw;
    v.vx = e.vx;
    v.vz = e.vz;
    v.hp = e.hp;
    v.maxHp = e.maxHp;
    v.radius = e.radius;
    v.height = e.height;
    v.defIndex = e.defIndex;
    v.level = e.level;
    v.type = e.type;
    v.state = e.state;
    view_.push_back(v);
  }
  return view_.empty() ? nullptr : view_.data();
}

void World::sampleHeightGrid(float originX, float originZ, float step, int countX, int countZ,
                             float* out) const {
  if (out == nullptr || countX <= 0 || countZ <= 0) return;
  for (int iz = 0; iz < countZ; ++iz) {
    const float z = originZ + static_cast<float>(iz) * step;
    float* row = out + static_cast<size_t>(iz) * static_cast<size_t>(countX);
    for (int ix = 0; ix < countX; ++ix) {
      row[ix] = terrainHeight(originX + static_cast<float>(ix) * step, z, terrain_);
    }
  }
}

// ---------------------------------------------------------------------------
// Freie Funktionen
// ---------------------------------------------------------------------------

bool isAlive(const Entity& e) {
  return e.state != kStateDead && e.hp > 0.0f;
}

bool isHostile(const Entity& a, const Entity& b) {
  if (a.type == kEntityNpc || b.type == kEntityNpc) return false;
  if (a.id == b.id) return false;
  if (a.type == kEntityPlayer && b.type == kEntityMonster) return true;
  if (a.type == kEntityMonster && b.type == kEntityPlayer) return true;
  // Spieler gegen Spieler bleibt vorerst aus — PvP-Zonen kommen später.
  return false;
}

float computeDamage(float attack, float defense, float roll) {
  const float d = defense > 0.0f ? defense : 0.0f;
  const float mitigated = attack * (attack / (attack + d * 1.6f));
  // ±12 % Streuung, damit gleiche Gegner nicht identisch sterben.
  const float varied = mitigated * (0.88f + roll * 0.24f);
  const float rounded = std::floor(varied + 0.5f);
  return rounded < 1.0f ? 1.0f : rounded;
}

}  // namespace aur
