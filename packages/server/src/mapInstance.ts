/**
 * Eine laufende Map.
 *
 * Der Kern kennt nur Zahlen — Kennungen, Positionen, Lebenspunkte. Namen,
 * Content-Kennungen und Portale bleiben hier oben, weil sie für die Simulation
 * bedeutungslos sind und die Brücke sonst breiter würde als nötig.
 */

import type { CoreEntityRow, CoreWorld } from '@aurelith/core';
import {
  EntityType,
  getNpc,
  type MapDocument,
  type PortalDef,
} from '@aurelith/shared';
import type { CoreBundle } from './core.ts';

export interface EntityMeta {
  defId: string;
  name: string;
  type: EntityType;
}

export class MapInstance {
  readonly world: CoreWorld;
  /** Alles, was der Kern nicht führt, aber das Protokoll braucht. */
  readonly meta = new Map<number, EntityMeta>();
  /** Kennungen der Sitzungen auf dieser Map. */
  readonly playerIds = new Set<number>();

  private rows: CoreEntityRow[] = [];
  private byId = new Map<number, CoreEntityRow>();

  constructor(
    readonly doc: MapDocument,
    private readonly bundle: CoreBundle,
    allocId: () => number,
  ) {
    this.world = bundle.core.createWorld(doc.terrain.seed, {
      size: doc.terrain.size,
      cellSize: doc.terrain.cellSize,
      seed: doc.terrain.seed,
      heightScale: doc.terrain.heightScale,
      featureScale: doc.terrain.featureScale,
    });

    for (const prop of doc.props) {
      if (prop.collision !== 'circle') continue;
      this.world.addCollider(prop.position[0], prop.position[2], prop.collisionRadius * prop.scale);
    }

    for (const npc of doc.npcs) {
      const def = getNpc(npc.def);
      if (!def) continue;
      const id = allocId();
      this.world.spawnNpc(
        id,
        npc.position[0],
        npc.position[1],
        npc.yaw,
        def.radius * def.scale,
        def.height * def.scale,
      );
      this.meta.set(id, { defId: npc.def, name: npc.name ?? def.name, type: EntityType.Npc });
    }

    for (const spawner of doc.spawners) {
      const mobIndex = bundle.mobIndexById.get(spawner.mob);
      if (mobIndex === undefined) continue;

      const spawnerIndex = this.world.addSpawner(
        spawner.position[0],
        spawner.position[1],
        spawner.radius,
        spawner.respawnMs / 1000,
        mobIndex,
        spawner.level ?? -1,
      );

      for (let i = 0; i < spawner.count; i++) {
        // Gleichverteilt in der Kreisfläche: die Wurzel verhindert, dass sich
        // alles in der Mitte drängt.
        const angle = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * spawner.radius;
        const id = allocId();
        const ok = this.world.spawnMob(
          id,
          mobIndex,
          spawner.position[0] + Math.cos(angle) * r,
          spawner.position[1] + Math.sin(angle) * r,
          spawner.level ?? -1,
          spawnerIndex,
        );
        if (ok) {
          this.meta.set(id, {
            defId: spawner.mob,
            name: '',
            type: EntityType.Monster,
          });
        }
      }
    }
  }

  /** Liest den Weltzustand einmal je Tick. Alle Sitzungen teilen sich das. */
  refresh(): void {
    this.rows = this.world.readEntities(this.rows);
    this.byId.clear();
    for (const row of this.rows) this.byId.set(row.id, row);
  }

  get entities(): readonly CoreEntityRow[] {
    return this.rows;
  }

  entity(id: number): CoreEntityRow | undefined {
    return this.byId.get(id);
  }

  metaFor(id: number): EntityMeta | undefined {
    return this.meta.get(id);
  }

  removePlayer(id: number): void {
    this.world.removeEntity(id);
    this.meta.delete(id);
    this.playerIds.delete(id);
  }

  /** Portal, in dessen Radius die Position liegt — oder nichts. */
  portalAt(x: number, z: number): PortalDef | undefined {
    for (const p of this.doc.portals) {
      const dx = x - p.position[0];
      const dz = z - p.position[1];
      if (dx * dx + dz * dz <= p.radius * p.radius) return p;
    }
    return undefined;
  }

  dispose(): void {
    this.world.dispose();
  }
}
