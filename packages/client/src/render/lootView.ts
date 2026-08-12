/**
 * Beute, die auf dem Boden liegt.
 *
 * Der Server schickt in jedem Snapshot die **vollständige** Liste dessen, was
 * in Sichtweite liegt. Diese Ansicht gleicht ihre Objekte dagegen ab: was neu
 * ist, kommt hinzu, was fehlt, verschwindet. Kein eigenes Buch über Zugänge
 * und Abgänge — es gibt nichts, was auseinanderlaufen könnte.
 *
 * Die Modelle sind dieselben, aus denen auch die Inventarbilder gerendert
 * werden. Das ist keine Sparsamkeit, sondern der Punkt: was auf dem Boden
 * liegt, muss aussehen wie das Symbol, das man danach im Beutel wiederfindet.
 */

import * as THREE from 'three';
import { getItem, type LootRow } from '@aurelith/shared';
import { assemble, cylinder } from './geometry.ts';
import { buildItemGeometry } from './itemModels.ts';

/**
 * Wie gross die Haufen im Bild sind.
 *
 * Ein Viertel dessen, was hier zwischenzeitlich stand. Der Weg dahin ging
 * zweimal daneben, und beide Male in dieselbe Richtung: erst lag die Beute in
 * Originalgrösse da und war aus zehn Metern kaum zu finden, dann auf mehr als
 * dem Doppelten und wirkte wie Requisiten neben der Figur. Ein Gegenstand am
 * Boden soll klein sein — gefunden wird er über sein Schild, das Modell sagt
 * nur, *was* dort liegt.
 */
const SCALE = 0.55;

/** Wie hoch die Beute über dem Boden schwebt, und wie weit sie dabei wippt. */
const HOVER = 0.45;
const BOB = 0.09;
const BOB_SPEED = 1.9;
const SPIN_SPEED = 0.9;

/**
 * Gold ist kein Gegenstand aus der Tabelle, also braucht es ein eigenes
 * Modell: ein Stapel Münzen, gegeneinander versetzt, damit man einzelne
 * Scheiben sieht und nicht einen Zylinder.
 */
function coinPile(): THREE.BufferGeometry {
  const gold = 0xe8c25a;
  const dunkel = 0xbc9636;
  return assemble([
    { geometry: cylinder(0.3, 0.3, 0.06, 14), color: gold, position: [0, 0.03, 0] },
    { geometry: cylinder(0.27, 0.27, 0.06, 14), color: dunkel, position: [0.08, 0.1, -0.05] },
    { geometry: cylinder(0.24, 0.24, 0.06, 14), color: gold, position: [-0.04, 0.17, 0.07] },
    // Eine vierte, hochkant an den Stapel gelehnt: erst dadurch ist von der
    // Seite zu erkennen, dass es Münzen sind und kein Klotz.
    {
      geometry: cylinder(0.26, 0.26, 0.05, 14),
      color: gold,
      position: [0.26, 0.26, 0.02],
      rotation: [0, 0, Math.PI * 0.5],
    },
  ]);
}

interface LootVisual {
  row: LootRow;
  object: THREE.Mesh;
  /** Eigener Versatz auf der Wippe, damit nicht alle im Takt schwingen. */
  phase: number;
}

export class LootView {
  readonly root = new THREE.Group();
  readonly piles = new Map<number, LootVisual>();

  private elapsed = 0;
  private coinGeometry?: THREE.BufferGeometry;
  /** Je Gegenstandsart eine Geometrie — zwanzig Häute sind ein Modell. */
  private readonly cache = new Map<string, THREE.BufferGeometry>();

  constructor(private readonly material: THREE.Material) {}

  /**
   * Gleicht die Ansicht an die Liste des Servers an.
   *
   * Vorhandene Haufen werden nur in ihren Daten aufgefrischt — ein Haufen, aus
   * dem etwas weggenommen wurde, behält sein Objekt und damit seine Wippe.
   */
  sync(rows: readonly LootRow[]): void {
    const gesehen = new Set<number>();

    for (const row of rows) {
      gesehen.add(row.id);
      const vorhanden = this.piles.get(row.id);
      if (vorhanden) {
        vorhanden.row = row;
        continue;
      }

      const geometry = this.geometryFor(row);
      if (!geometry) continue;

      const mesh = new THREE.Mesh(geometry, this.material);
      mesh.scale.setScalar(SCALE);
      mesh.position.set(row.x, row.y + HOVER, row.z);
      // Kein Frustum-Culling: die Geometrien sitzen im Ursprung und werden
      // über die Objektposition gesetzt, ihre Hülle stimmt also nicht.
      mesh.frustumCulled = false;
      this.root.add(mesh);

      this.piles.set(row.id, {
        row,
        object: mesh,
        // Aus der Kennung statt aus dem Zufall: derselbe Haufen wippt nach
        // einem Kartenwechsel wieder genauso, und zwei nebeneinander liegende
        // Haufen sind zuverlässig versetzt.
        phase: (row.id % 16) * 0.4,
      });
    }

    for (const [id, visual] of this.piles) {
      if (gesehen.has(id)) continue;
      this.root.remove(visual.object);
      this.piles.delete(id);
    }
  }

  private geometryFor(row: LootRow): THREE.BufferGeometry | undefined {
    if (row.gold > 0) {
      this.coinGeometry ??= coinPile();
      return this.coinGeometry;
    }

    const treffer = this.cache.get(row.item);
    if (treffer) return treffer;

    const def = getItem(row.item);
    if (!def) return undefined;
    const geometry = buildItemGeometry(def);
    if (!geometry) return undefined;

    this.cache.set(row.item, geometry);
    return geometry;
  }

  /** Dreht und wippt alles, was liegt. */
  step(dt: number): void {
    this.elapsed += dt;
    for (const visual of this.piles.values()) {
      const t = this.elapsed * BOB_SPEED + visual.phase;
      visual.object.position.set(
        visual.row.x,
        visual.row.y + HOVER + Math.sin(t) * BOB,
        visual.row.z,
      );
      visual.object.rotation.y = this.elapsed * SPIN_SPEED + visual.phase;
    }
  }

  /** Beschriftung für das Schild über dem Haufen. */
  label(row: LootRow): string {
    if (row.gold > 0) return `${row.gold} Gold`;
    const name = getItem(row.item)?.name ?? row.item;
    return row.count > 1 ? `${name} ×${row.count}` : name;
  }

  /**
   * Nimmt alles vom Boden — beim Kartenwechsel und beim Serverwechsel.
   *
   * Die Geometrien im Zwischenspeicher bleiben. Sie hängen an der
   * Gegenstandsart und nicht an der Karte: dieselbe Haut fällt in jedem Wald,
   * und sie bei jedem Wechsel neu zu bauen wäre Arbeit für nichts.
   */
  clear(): void {
    for (const visual of this.piles.values()) this.root.remove(visual.object);
    this.piles.clear();
  }
}
