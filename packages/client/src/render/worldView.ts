/**
 * Alles Sichtbare einer Map: Boden, Props, Figuren.
 *
 * Zwei Dinge passieren hier, die man leicht übersieht:
 *
 * **Props werden instanziiert.** Sechshundert Bäume sind ein Draw-Call je
 * Modellart, nicht sechshundert Objekte. Deshalb liegt jedes Prop als eine
 * verschmolzene Geometrie mit Vertexfarben vor.
 *
 * **Fremde Figuren werden interpoliert.** Snapshots kommen zehnmal je Sekunde,
 * gezeichnet wird sechzigmal. Ohne Interpolation ruckelt jede Bewegung außer
 * der eigenen. Die eigene Figur läuft über die Prediction und wird hier nur
 * gesetzt, nicht geglättet.
 */

import * as THREE from 'three';
import type { CoreWorld } from '@aurelith/core';
import {
  EntityState,
  EntityType,
  getMob,
  getNpc,
  type MapDocument,
  type SpawnRow,
  type UpdateRow,
} from '@aurelith/shared';
import type { QualitySettings } from '../config.ts';
import type { ModelRegistry } from './modelRegistry.ts';
import { buildTerrain, type TerrainMesh } from './terrain.ts';
import type { CharacterRig } from './rigs.ts';

/** Wie lange die Schlaganimation läuft, unabhängig von der Serverabklingzeit. */
const ATTACK_ANIM_SECONDS = 0.45;

export interface EntityVisual {
  id: number;
  type: EntityType;
  defId: string;
  name: string;
  level: number;
  hp: number;
  maxHp: number;
  state: EntityState;

  /** Gezeichnete Position — läuft der Zielposition hinterher. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Zuletzt vom Server gemeldete Position. */
  targetX: number;
  targetY: number;
  targetZ: number;
  targetYaw: number;

  /** Sekunden seit Beginn der Schlaganimation, oder negativ. */
  attackTimer: number;
  /** Geschätztes Tempo für die Laufanimation. */
  speed: number;

  rig: CharacterRig;
  /** Höhe über dem Boden für Nameplate und Schadenszahlen. */
  height: number;
}

function modelKeyFor(type: EntityType, defId: string): string {
  if (type === EntityType.Player) return 'player';
  if (type === EntityType.Npc) return getNpc(defId)?.model ?? 'npc_guide';
  return getMob(defId)?.model ?? 'mob_mote';
}

function heightFor(type: EntityType, defId: string): number {
  if (type === EntityType.Player) return 1.8;
  if (type === EntityType.Npc) {
    const def = getNpc(defId);
    return (def?.height ?? 1.8) * (def?.scale ?? 1);
  }
  const def = getMob(defId);
  return (def?.height ?? 1.5) * (def?.scale ?? 1);
}

export class WorldView {
  readonly root = new THREE.Group();
  readonly entities = new Map<number, EntityVisual>();

  private terrain?: TerrainMesh;
  private propMeshes: THREE.InstancedMesh[] = [];
  private doc?: MapDocument;
  private elapsed = 0;

  constructor(private readonly registry: ModelRegistry) {}

  get mapId(): string {
    return this.doc?.id ?? '';
  }

  /** Baut Boden und Props einer Map neu auf. Alte Entities fallen dabei weg. */
  setMap(world: CoreWorld, doc: MapDocument, quality: QualitySettings): void {
    this.clear();
    this.doc = doc;

    this.terrain = buildTerrain(world, doc, quality.terrainCell);
    this.root.add(this.terrain.object);

    this.buildProps(world, doc);
  }

  private buildProps(world: CoreWorld, doc: MapDocument): void {
    // Nach Modellart bündeln — daraus wird je Art eine InstancedMesh.
    const byModel = new Map<string, typeof doc.props>();
    for (const prop of doc.props) {
      const list = byModel.get(prop.model);
      if (list) list.push(prop);
      else byModel.set(prop.model, [prop]);
    }

    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const color = new THREE.Color();

    for (const [model, props] of byModel) {
      const geometry = this.registry.propGeometry(model);
      const mesh = new THREE.InstancedMesh(geometry, this.registry.material, props.length);
      mesh.name = `props:${model}`;
      // Props liegen über die ganze Map verteilt; eine Hüllkugel dafür wäre so
      // groß wie die Map und würde ohnehin nie aussortiert.
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;

      let anyTint = false;
      for (let i = 0; i < props.length; i++) {
        const prop = props[i]!;
        // Die Höhe kommt aus dem Kern, nicht aus der Datei: ändert jemand im
        // Editor den Terrain-Seed, sitzen die Props trotzdem richtig.
        const y = prop.snapToGround
          ? world.heightAt(prop.position[0], prop.position[2])
          : prop.position[1];

        position.set(prop.position[0], y, prop.position[2]);
        quaternion.setFromEuler(
          new THREE.Euler(prop.rotation[0], prop.rotation[1], prop.rotation[2]),
        );
        scale.setScalar(prop.scale);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(i, matrix);

        if (prop.tint !== undefined) {
          anyTint = true;
          color.setHex(prop.tint);
        } else {
          color.setRGB(1, 1, 1);
        }
        mesh.setColorAt(i, color);
      }

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      if (!anyTint && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

      this.root.add(mesh);
      this.propMeshes.push(mesh);
    }
  }

  // -------------------------------------------------------------------------
  // Entities
  // -------------------------------------------------------------------------

  spawn(row: SpawnRow): EntityVisual {
    const existing = this.entities.get(row.id);
    if (existing) return existing;

    const key = modelKeyFor(row.type, row.defId);
    const rig = this.registry.createRig(key);
    rig.root.position.set(row.x, row.y, row.z);
    rig.root.rotation.y = row.yaw;
    this.root.add(rig.root);

    const visual: EntityVisual = {
      id: row.id,
      type: row.type,
      defId: row.defId,
      name: row.name,
      level: row.level,
      hp: row.hp,
      maxHp: row.maxHp,
      state: row.state,
      x: row.x,
      y: row.y,
      z: row.z,
      yaw: row.yaw,
      targetX: row.x,
      targetY: row.y,
      targetZ: row.z,
      targetYaw: row.yaw,
      attackTimer: -1,
      speed: 0,
      rig,
      height: heightFor(row.type, row.defId),
    };
    this.entities.set(row.id, visual);
    return visual;
  }

  update(row: UpdateRow): void {
    const e = this.entities.get(row.id);
    if (!e) return;

    // Tempo aus dem Sprung zwischen zwei Snapshots schätzen — der Server
    // schickt keine Geschwindigkeit, und für die Laufanimation reicht das.
    const dx = row.x - e.targetX;
    const dz = row.z - e.targetZ;
    e.speed = Math.hypot(dx, dz) * 10;

    e.targetX = row.x;
    e.targetY = row.y;
    e.targetZ = row.z;
    e.targetYaw = row.yaw;
    e.hp = row.hp;

    if (row.state === EntityState.Attack && e.state !== EntityState.Attack) {
      e.attackTimer = 0;
    }
    e.state = row.state;
  }

  despawn(id: number): void {
    const e = this.entities.get(id);
    if (!e) return;
    this.root.remove(e.rig.root);
    e.rig.dispose();
    this.entities.delete(id);
  }

  /** Setzt die eigene Figur direkt — sie läuft über die Prediction. */
  setLocal(id: number, x: number, y: number, z: number, yaw: number, speed: number): void {
    const e = this.entities.get(id);
    if (!e) return;
    e.x = e.targetX = x;
    e.y = e.targetY = y;
    e.z = e.targetZ = z;
    e.yaw = e.targetYaw = yaw;
    e.speed = speed;
  }

  /** Löst die Schlaganimation aus, ohne auf den nächsten Snapshot zu warten. */
  triggerAttack(id: number): void {
    const e = this.entities.get(id);
    if (e && e.attackTimer < 0) e.attackTimer = 0;
  }

  /**
   * Schiebt alle Figuren einen Frame weiter. `localId` wird von der
   * Interpolation ausgenommen — dort gilt die Vorhersage.
   */
  step(dt: number, localId: number): void {
    this.elapsed += dt;
    // Bildratenunabhängige Glättung: bei 60 Hz landet man knapp unter einem
    // Snapshot-Intervall, bei 30 Hz genauso weit.
    const blend = 1 - Math.pow(0.0000001, dt);

    for (const e of this.entities.values()) {
      if (e.id !== localId) {
        e.x += (e.targetX - e.x) * blend;
        e.y += (e.targetY - e.y) * blend;
        e.z += (e.targetZ - e.z) * blend;

        let d = e.targetYaw - e.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        e.yaw += d * blend;
      }

      e.rig.root.position.set(e.x, e.y, e.z);
      e.rig.root.rotation.y = e.yaw;

      if (e.attackTimer >= 0) {
        e.attackTimer += dt;
        if (e.attackTimer > ATTACK_ANIM_SECONDS) e.attackTimer = -1;
      }

      e.rig.update({
        speed: e.speed,
        attackPhase: e.attackTimer >= 0 ? e.attackTimer / ATTACK_ANIM_SECONDS : -1,
        dead: e.state === EntityState.Dead,
        time: this.elapsed,
      });
    }
  }

  clear(): void {
    for (const e of this.entities.values()) {
      this.root.remove(e.rig.root);
      e.rig.dispose();
    }
    this.entities.clear();

    for (const mesh of this.propMeshes) {
      this.root.remove(mesh);
      mesh.dispose();
    }
    this.propMeshes = [];

    if (this.terrain) {
      this.root.remove(this.terrain.object);
      this.terrain.dispose();
      this.terrain = undefined;
    }
  }
}
