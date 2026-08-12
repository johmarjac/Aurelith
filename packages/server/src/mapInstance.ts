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
  getMob,
  getNpc,
  type MapDocument,
  terrainSetup,
} from '@aurelith/shared';
import type { CoreBundle } from './core.ts';
import { LootField } from './loot.ts';

export interface EntityMeta {
  /**
   * Was die Figur in der Hand hält — Schlüssel des Rigs, oder leer.
   *
   * Steht hier und nicht in der Sitzung, weil der Snapshot fremde Figuren
   * beschreibt: wer einen Spieler sieht, braucht dessen Waffe, nicht seine
   * eigene.
   */
  weapon?: string;
  /**
   * Aufwertungsstufe der getragenen Waffe.
   *
   * Aus demselben Grund hier wie die Waffe selbst: ab +4 hat sie eine Aura,
   * und die gehört zu dem, was andere von dieser Figur sehen.
   */
  weaponUpgrade?: number;
  /**
   * Was die Figur trägt, als Zeichenkette — siehe `encodeOutfit`.
   *
   * Aus demselben Grund hier wie die Waffe: der Snapshot beschreibt fremde
   * Figuren, und wer eine sieht, will sie angezogen sehen und nicht in
   * Unterhose.
   */
  outfit?: string;
  /**
   * Stufe des leuchtenden Rüstungssatzes, 0 wenn keiner leuchtet.
   *
   * Ausgerechnet wird sie in `applyLoadout` und nicht beim Verschicken: der
   * Snapshot geht zehnmal je Sekunde an jeden in Sichtweite, die Ausrüstung
   * ändert sich alle paar Minuten.
   */
  setGlow?: number;
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
  /** Was hier gerade auf dem Boden liegt. */
  readonly loot = new LootField();

  private rows: CoreEntityRow[] = [];
  private byId = new Map<number, CoreEntityRow>();

  constructor(
    readonly doc: MapDocument,
    private readonly bundle: CoreBundle,
    allocId: () => number,
  ) {
    // Über `terrainSetup`, nicht von Hand: Server, Client und Editor müssen
    // denselben Boden bekommen, und drei Abschriften driften.
    const setup = terrainSetup(doc);
    this.world = bundle.core.createWorld(doc.terrain.seed, setup.shape);
    this.world.setSculpt(setup.sculpt, setup.sculptResolution);

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
            // Aus der Content-Tabelle, genau wie beim NPC eine Schleife
            // weiter oben. Vorher stand hier ein leerer Text, und im Spiel
            // trug jedes Monster ein Schild, auf dem nur die Stufe stand.
            name: getMob(spawner.mob)?.name ?? '',
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

  dispose(): void {
    this.world.dispose();
  }
}
