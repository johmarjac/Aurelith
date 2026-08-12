/**
 * Der Beutel.
 *
 * Ein paar Funktionen auf einer Liste von Zeilen, kein Objekt mit Zustand: das
 * Inventar gehört der Sitzung, und diese Datei sagt nur, was mit ihm geschieht.
 * Genau deshalb ist es prüfbar, ohne einen Server zu starten.
 *
 * Die Plätze sind fest nummeriert. Ein Gegenstand ohne Platz wäre im Client
 * nicht darstellbar — dort ist das Inventar ein Raster, und ein Raster braucht
 * für jede Kachel eine Nummer.
 */

import { getItem, type ItemDef } from '@aurelith/shared';
import type { ItemRecord } from './db/index.ts';

/** So viele Plätze hat der Beutel. Muss zur Anzeige im Client passen. */
export const INVENTORY_SLOTS = 30;

export function countItem(items: ItemRecord[], itemId: string): number {
  let sum = 0;
  for (const row of items) if (row.itemId === itemId) sum += row.count;
  return sum;
}

function freeSlot(items: ItemRecord[]): number {
  const used = new Set(items.map((i) => i.slot));
  for (let i = 0; i < INVENTORY_SLOTS; i++) if (!used.has(i)) return i;
  return -1;
}

/**
 * Legt etwas in den Beutel.
 *
 * Gibt zurück, wie viel **tatsächlich** hineinging — bei vollem Beutel also
 * weniger als verlangt und womöglich null. Wer das ignoriert, verschenkt
 * Gegenstände ins Nichts, und genau das soll die Rückgabe verhindern.
 */
export function addItem(items: ItemRecord[], itemId: string, count: number): number {
  const def: ItemDef | undefined = getItem(itemId);
  if (!def || count <= 0) return 0;

  let rest = count;

  if (def.stackable) {
    for (const row of items) {
      if (row.itemId !== itemId) continue;
      const platz = def.maxStack - row.count;
      if (platz <= 0) continue;
      const nimm = Math.min(platz, rest);
      row.count += nimm;
      rest -= nimm;
      if (rest === 0) return count;
    }
  }

  while (rest > 0) {
    const slot = freeSlot(items);
    if (slot < 0) break;
    const nimm = def.stackable ? Math.min(def.maxStack, rest) : 1;
    items.push({ itemId, count: nimm, slot, equipped: false });
    rest -= nimm;
  }

  return count - rest;
}

/**
 * Nimmt etwas heraus. Gibt `false` zurück, wenn nicht genug da ist — und
 * ändert dann auch nichts, sonst bliebe nach einem gescheiterten Handel die
 * Hälfte abgebucht.
 *
 * Angelegte Gegenstände werden nicht angerührt: was man am Körper trägt,
 * verkauft man nicht versehentlich mit.
 */
export function removeItem(items: ItemRecord[], itemId: string, count: number): boolean {
  let verfuegbar = 0;
  for (const row of items) {
    if (row.itemId === itemId && !row.equipped) verfuegbar += row.count;
  }
  if (verfuegbar < count) return false;

  let rest = count;
  for (let i = items.length - 1; i >= 0 && rest > 0; i--) {
    const row = items[i]!;
    if (row.itemId !== itemId || row.equipped) continue;
    const nimm = Math.min(row.count, rest);
    row.count -= nimm;
    rest -= nimm;
    if (row.count === 0) items.splice(i, 1);
  }
  return true;
}

/** Wie viel ein Händler beim Verkauf zahlt. */
export function sellPrice(def: ItemDef): number {
  return Math.max(1, Math.floor(def.value * 0.4));
}
