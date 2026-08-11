/**
 * Typisierte Hülle um den wasm-Kern.
 *
 * Alles, was TypeScript vom Kern sieht, geht durch diese Datei. Das ist die
 * andere Hälfte der schmalen Brücke: `embind.cpp` bestimmt, was C++ hergibt,
 * und hier bekommt es Namen, Typen und eine Form, mit der sich arbeiten lässt.
 *
 * Zwei Ladewege, weil die Wirte sich unterscheiden:
 *
 *   `loadCoreFromModule` — der Aufrufer hat das Emscripten-Modul schon. Der
 *   Server importiert es direkt, der Client holt es über den Asset-Streamer.
 *
 * Der Kern wird nie doppelt geladen: die Monster-Definitionen liegen global im
 * wasm, und zwei Instanzen hätten zwei getrennte Registries.
 */

import { ENTITY_VIEW, EVENT_VIEW, verifyLayout } from './layout.ts';

export { ENTITY_VIEW, EVENT_VIEW, LayoutMismatchError, verifyLayout } from './layout.ts';

// --- Spiegelbilder der C++-Aufzählungen -------------------------------------

export const CoreEntityType = { Player: 0, Monster: 1, Npc: 2 } as const;
export type CoreEntityType = (typeof CoreEntityType)[keyof typeof CoreEntityType];

export const CoreEntityState = { Idle: 0, Move: 1, Attack: 2, Dead: 3 } as const;
export type CoreEntityState = (typeof CoreEntityState)[keyof typeof CoreEntityState];

export const CoreButton = { Attack: 1, Jump: 2, Interact: 4, Sit: 8 } as const;

export const CoreEventType = { Hit: 0, Death: 1, Spawn: 2, Exp: 3 } as const;
export type CoreEventType = (typeof CoreEventType)[keyof typeof CoreEventType];

export const CoreCombatFlag = { None: 0, Critical: 1, Killing: 2, Miss: 4 } as const;

/** Kein Spawner zugeordnet. Entspricht `kNoSpawner` im Kern. */
export const NO_SPAWNER = 0xffffffff;

// --- Formen, die über die Brücke gehen --------------------------------------

export interface CoreTerrainDef {
  size: number;
  cellSize: number;
  seed: number;
  heightScale: number;
  featureScale: number;
}

export interface CoreMobDef {
  maxHp: number;
  attackDamage: number;
  defense: number;
  moveSpeed: number;
  aggroRange: number;
  leashRange: number;
  attackRange: number;
  attackArc: number;
  attackCooldownSec: number;
  attackWindupSec: number;
  radius: number;
  height: number;
  expReward: number;
  goldReward: number;
  level: number;
  aggressive: number;
}

export interface CorePlayerSpawn {
  id: number;
  level: number;
  x: number;
  z: number;
  yaw: number;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  attackDamage: number;
  defense: number;
  moveSpeed: number;
  attackRange: number;
  attackArc: number;
  attackCooldownSec: number;
  attackWindupSec: number;
  radius: number;
  height: number;
}

/** Eine Zeile aus dem Sichtpuffer, wiederverwendet statt neu erzeugt. */
export interface CoreEntityRow {
  id: number;
  targetId: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  hp: number;
  maxHp: number;
  radius: number;
  height: number;
  defIndex: number;
  level: number;
  type: CoreEntityType;
  state: CoreEntityState;
}

export interface CoreEvent {
  type: CoreEventType;
  flags: number;
  a: number;
  b: number;
  value: number;
  value2: number;
  x: number;
  y: number;
  z: number;
}

// --- Rohschnittstelle des Emscripten-Moduls ---------------------------------

interface RawWorld {
  addCollider(x: number, z: number, radius: number): void;
  resizeSculpt(resolution: number): void;
  sculptPointer(): number;
  sculptResolution(): number;
  clearColliders(): void;
  addSpawner(
    x: number,
    z: number,
    radius: number,
    respawnSec: number,
    mobIndex: number,
    levelOverride: number,
  ): number;
  clearSpawners(): void;
  spawnPlayer(seed: CorePlayerSpawn): boolean;
  spawnMob(
    id: number,
    mobIndex: number,
    x: number,
    z: number,
    levelOverride: number,
    spawnerIndex: number,
  ): boolean;
  spawnNpc(id: number, x: number, z: number, yaw: number, radius: number, height: number): boolean;
  removeEntity(id: number): boolean;
  applyInput(
    id: number,
    moveX: number,
    moveZ: number,
    yaw: number,
    buttons: number,
    dt: number,
  ): void;
  step(dt: number): void;
  teleport(id: number, x: number, z: number, yaw: number): void;
  respawnPlayer(id: number, x: number, z: number): void;
  setTarget(id: number, targetId: number): void;
  setPlayerStats(
    id: number,
    level: number,
    maxHp: number,
    maxMp: number,
    attackDamage: number,
    defense: number,
  ): void;
  tick(): number;
  entityCount(): number;
  viewPointer(): number;
  viewCount(): number;
  eventPointer(): number;
  eventCount(): number;
  clearEvents(): void;
  heightAt(x: number, z: number): number;
  slopeAt(x: number, z: number): number;
  sampleHeightGrid(
    originX: number,
    originZ: number,
    step: number,
    countX: number,
    countZ: number,
    out: number,
  ): void;
  delete(): void;
}

export interface RawCoreModule {
  World: new (seed: number, terrain: CoreTerrainDef) => RawWorld;
  registerMob(def: CoreMobDef): number;
  clearMobs(): void;
  mobCount(): number;
  describeLayout(): { entity: Record<string, number>; event: Record<string, number> };
  coreVersion(): string;
  tickRate(): number;
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
}

/** Signatur der von Emscripten erzeugten Fabrikfunktion. */
export type CoreModuleFactory = (options?: Record<string, unknown>) => Promise<RawCoreModule>;

// --- Welt -------------------------------------------------------------------

export class CoreWorld {
  /** Sicht auf den wasm-Heap. Wird nach jedem Wachstum neu geholt. */
  private view: DataView;

  constructor(
    private readonly raw: RawWorld,
    private readonly module: RawCoreModule,
  ) {
    this.view = new DataView(module.HEAPU8.buffer);
  }

  private heap(): DataView {
    // Der Heap wächst zwar nicht (ALLOW_MEMORY_GROWTH=0), aber die Prüfung
    // kostet nichts und macht die Annahme sichtbar.
    if (this.view.buffer !== this.module.HEAPU8.buffer) {
      this.view = new DataView(this.module.HEAPU8.buffer);
    }
    return this.view;
  }

  addCollider(x: number, z: number, radius: number): void {
    this.raw.addCollider(x, z, radius);
  }

  clearColliders(): void {
    this.raw.clearColliders();
  }

  /**
   * Übergibt die von Hand geformten Höhen an den Kern.
   *
   * Den Speicher besitzt der Kern, nicht wir: `resizeSculpt` legt ihn an, wir
   * schreiben einmal hinein. Das erspart `_malloc` an der Brücke und stellt
   * sicher, dass der Zeiger genau so lange gilt wie die Welt — er wird bei
   * jedem einzelnen Höhenabruf gelesen.
   *
   * `undefined` schaltet das Feld ab; danach ist der Boden wieder rein
   * prozedural.
   */
  setSculpt(values: Int16Array | undefined, resolution: number): void {
    if (!values || resolution < 2) {
      this.raw.resizeSculpt(0);
      return;
    }
    const expected = resolution * resolution;
    if (values.length !== expected) {
      throw new RangeError(
        `Höhenfeld hat ${values.length} Werte, erwartet ${expected} bei Auflösung ${resolution}`,
      );
    }

    this.raw.resizeSculpt(resolution);
    const ptr = this.raw.sculptPointer();
    if (ptr === 0) throw new Error('Kern hat keinen Speicher für das Höhenfeld geliefert');

    // Int16-Sicht auf den wasm-Heap. Der Zeiger ist zwangsläufig gerade, weil
    // der Kern ihn aus einem std::vector<int16_t> liefert.
    new Int16Array(this.module.HEAPU8.buffer, ptr, expected).set(values);
  }

  /** Stützpunkte je Kante des Höhenfeldes. Null heißt: keines. */
  get sculptResolution(): number {
    return this.raw.sculptResolution();
  }

  addSpawner(
    x: number,
    z: number,
    radius: number,
    respawnSec: number,
    mobIndex: number,
    levelOverride = -1,
  ): number {
    return this.raw.addSpawner(x, z, radius, respawnSec, mobIndex, levelOverride);
  }

  spawnPlayer(seed: CorePlayerSpawn): boolean {
    return this.raw.spawnPlayer(seed);
  }

  spawnMob(
    id: number,
    mobIndex: number,
    x: number,
    z: number,
    levelOverride = -1,
    spawnerIndex = NO_SPAWNER,
  ): boolean {
    return this.raw.spawnMob(id, mobIndex, x, z, levelOverride, spawnerIndex);
  }

  spawnNpc(id: number, x: number, z: number, yaw: number, radius: number, height: number): boolean {
    return this.raw.spawnNpc(id, x, z, yaw, radius, height);
  }

  removeEntity(id: number): boolean {
    return this.raw.removeEntity(id);
  }

  applyInput(
    id: number,
    moveX: number,
    moveZ: number,
    yaw: number,
    buttons: number,
    dt: number,
  ): void {
    this.raw.applyInput(id, moveX, moveZ, yaw, buttons, dt);
  }

  step(dt: number): void {
    this.raw.step(dt);
  }

  teleport(id: number, x: number, z: number, yaw: number): void {
    this.raw.teleport(id, x, z, yaw);
  }

  respawnPlayer(id: number, x: number, z: number): void {
    this.raw.respawnPlayer(id, x, z);
  }

  setTarget(id: number, targetId: number): void {
    this.raw.setTarget(id, targetId);
  }

  setPlayerStats(
    id: number,
    level: number,
    maxHp: number,
    maxMp: number,
    attackDamage: number,
    defense: number,
  ): void {
    this.raw.setPlayerStats(id, level, maxHp, maxMp, attackDamage, defense);
  }

  get tick(): number {
    return this.raw.tick();
  }

  get entityCount(): number {
    return this.raw.entityCount();
  }

  heightAt(x: number, z: number): number {
    return this.raw.heightAt(x, z);
  }

  slopeAt(x: number, z: number): number {
    return this.raw.slopeAt(x, z);
  }

  /**
   * Liest den gesamten Entity-Zustand in ein wiederverwendetes Array. Der
   * Aufrufer bekommt dieselben Objekte zurück, die er beim letzten Mal bekommen
   * hat — das vermeidet je Frame ein paar hundert kurzlebige Allokationen.
   */
  readEntities(into: CoreEntityRow[] = []): CoreEntityRow[] {
    const ptr = this.raw.viewPointer();
    const count = this.raw.viewCount();
    const dv = this.heap();

    while (into.length < count) {
      into.push({
        id: 0,
        targetId: 0,
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        vx: 0,
        vz: 0,
        hp: 0,
        maxHp: 0,
        radius: 0,
        height: 0,
        defIndex: 0,
        level: 0,
        type: CoreEntityType.Player,
        state: CoreEntityState.Idle,
      });
    }
    into.length = count;
    if (count === 0 || ptr === 0) return into;

    const L = ENTITY_VIEW;
    for (let i = 0; i < count; i++) {
      const base = ptr + i * L.stride;
      const row = into[i]!;
      row.id = dv.getUint32(base + L.id, true);
      row.targetId = dv.getUint32(base + L.targetId, true);
      row.x = dv.getFloat32(base + L.x, true);
      row.y = dv.getFloat32(base + L.y, true);
      row.z = dv.getFloat32(base + L.z, true);
      row.yaw = dv.getFloat32(base + L.yaw, true);
      row.vx = dv.getFloat32(base + L.vx, true);
      row.vz = dv.getFloat32(base + L.vz, true);
      row.hp = dv.getFloat32(base + L.hp, true);
      row.maxHp = dv.getFloat32(base + L.maxHp, true);
      row.radius = dv.getFloat32(base + L.radius, true);
      row.height = dv.getFloat32(base + L.height, true);
      row.defIndex = dv.getUint32(base + L.defIndex, true);
      row.level = dv.getUint16(base + L.level, true);
      row.type = dv.getUint8(base + L.type) as CoreEntityType;
      row.state = dv.getUint8(base + L.state) as CoreEntityState;
    }
    return into;
  }

  /** Holt die Ereignisse dieses Ticks und leert den Puffer im Kern. */
  drainEvents(): CoreEvent[] {
    const count = this.raw.eventCount();
    if (count === 0) return [];

    const ptr = this.raw.eventPointer();
    const dv = this.heap();
    const L = EVENT_VIEW;
    const out: CoreEvent[] = new Array(count);

    for (let i = 0; i < count; i++) {
      const base = ptr + i * L.stride;
      out[i] = {
        type: dv.getUint8(base + L.type) as CoreEventType,
        flags: dv.getUint8(base + L.flags),
        a: dv.getUint32(base + L.a, true),
        b: dv.getUint32(base + L.b, true),
        value: dv.getFloat32(base + L.value, true),
        value2: dv.getFloat32(base + L.value2, true),
        x: dv.getFloat32(base + L.x, true),
        y: dv.getFloat32(base + L.y, true),
        z: dv.getFloat32(base + L.z, true),
      };
    }
    this.raw.clearEvents();
    return out;
  }

  /**
   * Füllt ein regelmäßiges Höhengitter in einem Aufruf. Der Renderer baut sein
   * Terrainnetz daraus, ohne je Stützpunkt über die Brücke zu gehen.
   */
  sampleHeightGrid(
    originX: number,
    originZ: number,
    step: number,
    countX: number,
    countZ: number,
  ): Float32Array {
    const total = countX * countZ;
    const bytes = total * 4;
    const ptr = this.module._malloc(bytes);
    try {
      this.raw.sampleHeightGrid(originX, originZ, step, countX, countZ, ptr);
      // Kopieren, bevor der Speicher zurückgeht.
      return new Float32Array(this.module.HEAPU8.buffer.slice(ptr, ptr + bytes));
    } finally {
      this.module._free(ptr);
    }
  }

  dispose(): void {
    this.raw.delete();
  }
}

// --- Kern -------------------------------------------------------------------

export class Core {
  private constructor(readonly module: RawCoreModule) {}

  static async fromModule(module: RawCoreModule): Promise<Core> {
    // Der Vertrag wird geprüft, nicht geglaubt.
    verifyLayout(module.describeLayout());
    return new Core(module);
  }

  get version(): string {
    return this.module.coreVersion();
  }

  get tickRate(): number {
    return this.module.tickRate();
  }

  /**
   * Trägt eine Monsterart ein und liefert ihren Index. Die Definitionen leben
   * global im Kern, also genau einmal je Prozess.
   */
  registerMob(def: CoreMobDef): number {
    return this.module.registerMob(def);
  }

  clearMobs(): void {
    this.module.clearMobs();
  }

  get mobCount(): number {
    return this.module.mobCount();
  }

  createWorld(seed: number, terrain: CoreTerrainDef): CoreWorld {
    return new CoreWorld(new this.module.World(seed >>> 0, terrain), this.module);
  }
}

/**
 * Lädt den Kern aus einer bereits importierten Emscripten-Fabrik.
 * `locateFile` bestimmt, woher die `.wasm` kommt — im Browser vom CDN, in Node
 * neben dem Glue-Modul.
 */
export async function loadCore(
  factory: CoreModuleFactory,
  options: Record<string, unknown> = {},
): Promise<Core> {
  const module = await factory(options);
  return Core.fromModule(module);
}
