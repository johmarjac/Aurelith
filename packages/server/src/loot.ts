/**
 * Beute, die auf dem Boden liegt.
 *
 * Eine eigene Liste je Map und keine Entities im Kern. Das ist der Punkt, an
 * dem sich die beiden Sorten unterscheiden: ein Wesen bewegt sich, kollidiert,
 * kämpft und lebt in der Simulation. Ein Beutehaufen liegt da. Er braucht
 * keinen Tick, keine Kollision und keine Wegfindung — ihn in den Kern zu
 * heben, hieße die wasm-Brücke für eine Position und eine Kennung zu
 * verbreitern, und jede Änderung an der Beute bräuchte einen neuen Build.
 *
 * Hier oben kostet er eine Zeile in einer Liste.
 */

import { tuning } from '@aurelith/shared';

export interface LootPile {
  id: number;
  x: number;
  y: number;
  z: number;
  /** Kennung des Gegenstands, leer bei Gold. */
  item: string;
  count: number;
  upgrade: number;
  gold: number;
  /** Wann der Haufen verfällt, in Millisekunden seit der Epoche. */
  expiresAt: number;
  /** Entity des Erlegers — nur der darf zunächst aufheben. */
  owner: number;
  /** Bis wann diese Bevorzugung gilt. */
  reservedUntil: number;
}

export type PickupResult =
  | { ok: true; pile: LootPile }
  | { ok: false; reason: 'weg' | 'zu weit' | 'fremd' };

/**
 * Alle Haufen einer Map.
 *
 * Die Kennungen sind ein eigener Zählraum und nicht der der Entities. Beide
 * Listen stehen im Snapshot nebeneinander und werden vom Client getrennt
 * geführt; sie zu vermischen brächte nichts außer der Gefahr, dass ein
 * Beutehaufen und ein Monster dieselbe Nummer tragen.
 */
export class LootField {
  private piles = new Map<number, LootPile>();
  private nextId = 1;

  /**
   * Legt einen Haufen ab.
   *
   * `index` streut die Haufen eines Kadavers auf einem Kreis, damit zwei
   * Gegenstände nicht ineinanderstehen. Kein Zufall: bei zwei Haufen sollen
   * es zuverlässig zwei sichtbare Stellen sein und nicht mit einer gewissen
   * Wahrscheinlichkeit eine.
   */
  drop(
    pile: Omit<LootPile, 'id' | 'expiresAt' | 'reservedUntil'>,
    index = 0,
    total = 1,
    now = Date.now(),
  ): LootPile {
    const t = tuning().loot;
    const winkel = total > 1 ? (index / total) * Math.PI * 2 : 0;
    const radius = total > 1 ? t.scatterRadius : 0;

    const eintrag: LootPile = {
      ...pile,
      id: this.nextId++,
      x: pile.x + Math.cos(winkel) * radius,
      z: pile.z + Math.sin(winkel) * radius,
      expiresAt: now + t.lifetimeSec * 1000,
      reservedUntil: now + t.reserveSec * 1000,
    };
    this.piles.set(eintrag.id, eintrag);
    return eintrag;
  }

  /** Räumt ab, was verfallen ist. Einmal je Tick. */
  expire(now = Date.now()): void {
    for (const [id, pile] of this.piles) {
      if (pile.expiresAt <= now) this.piles.delete(id);
    }
  }

  /** Alles, was in einem Umkreis liegt — für den Snapshot. */
  near(x: number, z: number, radius: number): LootPile[] {
    const rSq = radius * radius;
    const treffer: LootPile[] = [];
    for (const pile of this.piles.values()) {
      const dx = pile.x - x;
      const dz = pile.z - z;
      if (dx * dx + dz * dz <= rSq) treffer.push(pile);
    }
    return treffer;
  }

  get(id: number): LootPile | undefined {
    return this.piles.get(id);
  }

  get size(): number {
    return this.piles.size;
  }

  /**
   * Versucht, einen Haufen aufzuheben.
   *
   * Prüft hier und nicht beim Aufrufer, weil das die Stelle ist, an der der
   * Haufen tatsächlich verschwindet: eine Prüfung daneben ließe sich beim
   * nächsten Aufrufer vergessen.
   *
   * Nimmt den Haufen **nicht** aus der Liste — das tut erst `take`, wenn der
   * Inhalt wirklich im Beutel angekommen ist. Ein voller Beutel darf keine
   * Beute verschlucken.
   */
  check(id: number, entityId: number, x: number, z: number, now = Date.now()): PickupResult {
    const pile = this.piles.get(id);
    if (!pile || pile.expiresAt <= now) return { ok: false, reason: 'weg' };

    if (pile.owner !== entityId && pile.reservedUntil > now) {
      return { ok: false, reason: 'fremd' };
    }

    const reichweite = tuning().loot.pickupRange;
    const dx = pile.x - x;
    const dz = pile.z - z;
    if (dx * dx + dz * dz > reichweite * reichweite) return { ok: false, reason: 'zu weit' };

    return { ok: true, pile };
  }

  /** Entfernt einen Haufen endgültig. */
  take(id: number): void {
    this.piles.delete(id);
  }
}
