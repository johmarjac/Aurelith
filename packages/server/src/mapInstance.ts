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
  /** Worauf diese Figur fliegt — Modellschlüssel, leer heisst: am Boden. */
  flug?: string;
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
    private readonly allocId: () => number,
  ) {
    // Über `terrainSetup`, nicht von Hand: Server, Client und Editor müssen
    // denselben Boden bekommen, und drei Abschriften driften.
    const setup = terrainSetup(doc);
    this.world = bundle.core.createWorld(doc.terrain.seed, setup.shape);
    this.world.setSculpt(setup.sculpt, setup.sculptResolution);

    for (const prop of doc.props) {
      if (prop.collision === 'circle') {
        this.world.addCollider(
          prop.position[0],
          prop.position[2],
          prop.collisionRadius * prop.scale,
          // Die Höhe skaliert mit: ein doppelt so grosser Zaun ist auch
          // doppelt so hoch, und über den kommt man dann eben nicht mehr.
          prop.collisionHeight * prop.scale,
        );
      } else if (prop.collision === 'plattform') {
        // Der Ursprung des Modells liegt in seiner Oberfläche — deshalb ist
        // `position[1]` die begehbare Höhe und keine zweite Zahl daneben.
        this.world.addPlattform(
          prop.position[0],
          prop.position[2],
          prop.collisionRadius * prop.scale,
          prop.position[1],
        );
      }
    }

    // Sperrflächen. Der Kern kennt sie, also rechnen Client und Server
    // dieselbe Grenze — eine Sperre, die nur hier stünde, sähe im Bild wie ein
    // Gummiband aus.
    for (const zone of doc.zonen) {
      this.world.addZone(
        zone.position[0],
        zone.position[1],
        zone.extent[0],
        zone.extent[1],
        zone.keinLauf,
        zone.keinFlug,
      );
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

  /**
   * Kann an dieser Stelle jemand stehen, der einfach dort abgesetzt wird —
   * und **wieder wegkommen**?
   *
   * Zwei Gründe, warum nicht, und beide entstanden erst mit der Insel:
   *
   *   - **Unter Wasser.** Der Kern kennt kein Wasser; der Meeresgrund ist für
   *     ihn gewöhnlicher Boden. Wer über dem Meer absteigt, fällt bis auf den
   *     Grund und steht dort.
   *   - **Rundherum zu steil.** Die Klippe hat achtundsiebzig Grad über zwölf
   *     Meter Lauflänge. Wer auf ihr landet, bekommt von `tryStep` in keine
   *     Richtung einen Schritt zugestanden.
   *
   * In beiden Fällen käme man ohne Fluggerät nie wieder weg, und das Gerät
   * liegt nach dem Absteigen im Beutel.
   *
   * **Die Nachbarschaft entscheidet, nicht der Fleck selbst.** Hier stand
   * einmal nur `begehbar(x, z)`, und das war zu streng: an einem Flussufer
   * oder einer Geländekante ist ein einzelner Punkt schnell steiler als
   * zweiundfünfzig Grad, und zwei Meter weiter läuft es sich wieder. Der
   * Flugtest fiel daran durch — er stieg über ganz gewöhnlicher Wiese ab und
   * bekam eine Absage. Eine Klippe unterscheidet sich von einer Kante genau
   * dadurch, dass sie **weiträumig** steil ist.
   */
  traegtBoden(x: number, z: number): boolean {
    if (this.world.heightAt(x, z) < this.doc.terrain.waterLevel) return false;
    if (this.world.begehbar(x, z)) return true;

    // Zwei Ringe: einer für die Kante, einer für den Hang dahinter. Auf der
    // Klippe liegt auch der äussere Ring noch in der Wand.
    for (const weite of [1.5, 3.5]) {
      for (let i = 0; i < 8; i++) {
        const winkel = (i * Math.PI) / 4;
        const nx = x + Math.cos(winkel) * weite;
        const nz = z + Math.sin(winkel) * weite;
        if (this.world.heightAt(nx, nz) < this.doc.terrain.waterLevel) continue;
        if (this.world.begehbar(nx, nz)) return true;
      }
    }
    return false;
  }

  /**
   * Setzt ein einzelnes Monster an eine Stelle — ohne Spawner dahinter.
   *
   * Für `/spawn`. Ohne Spawner heisst: es kommt nicht wieder, wenn es
   * gefallen ist. Genau richtig für ein Werkzeug, mit dem man sich etwas
   * ansieht — ein Befehl, der nebenbei einen dauerhaften Nistplatz anlegt,
   * verändert die Karte, und das will niemand, der nur nachsehen wollte, wie
   * ein Modell aussieht.
   *
   * Gibt den Namen des Wesens zurück; `undefined` heisst, dass der Kern es
   * nicht setzen konnte.
   */
  spawneMonster(sorte: string, x: number, z: number): string | undefined {
    const mobIndex = this.bundle.mobIndexById.get(sorte);
    if (mobIndex === undefined) return undefined;

    const id = this.allocId();
    if (!this.world.spawnMob(id, mobIndex, x, z)) return undefined;

    const name = getMob(sorte)?.name ?? '';
    this.meta.set(id, { defId: sorte, name, type: EntityType.Monster });
    return name;
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
