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

import { getItem, tuning } from '@aurelith/shared';
import type { ItemRecord } from './db/index.ts';

/**
 * So viele Plätze hat der Beutel.
 *
 * Aus den Stellschrauben, nicht als Zahl hier: der Client zeichnet dasselbe
 * Raster, und zwei Zahlen für dieselbe Sache gehen irgendwann auseinander.
 */
export function inventorySlots(): number {
  return tuning().economy.inventorySlots;
}

export function countItem(items: ItemRecord[], itemId: string): number {
  let sum = 0;
  for (const row of items) if (row.itemId === itemId) sum += row.count;
  return sum;
}

function freeSlot(items: ItemRecord[]): number {
  const used = new Set(items.map((i) => i.slot));
  const plaetze = inventorySlots();
  for (let i = 0; i < plaetze; i++) if (!used.has(i)) return i;
  return -1;
}

/**
 * Legt etwas in den Beutel.
 *
 * Gibt zurück, wie viel **tatsächlich** hineinging — bei vollem Beutel also
 * weniger als verlangt und womöglich null. Wer das ignoriert, verschenkt
 * Gegenstände ins Nichts, und genau das soll die Rückgabe verhindern.
 */
export function addItem(
  items: ItemRecord[],
  itemId: string,
  count: number,
  upgrade = 0,
): number {
  const def = getItem(itemId);
  if (!def || count <= 0) return 0;

  let rest = count;

  // Aufgewertetes stapelt nicht: zwei +10-Klingen wären ein Stapel, dem man
  // nachher nicht mehr ansieht, dass beide aufgewertet sind.
  if (def.stackable && upgrade === 0) {
    for (const row of items) {
      if (row.itemId !== itemId || row.upgrade !== 0) continue;
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
    const nimm = def.stackable && upgrade === 0 ? Math.min(def.maxStack, rest) : 1;
    items.push({ itemId, count: nimm, slot, equipped: false, upgrade });
    rest -= nimm;
  }

  return count - rest;
}

/** Was sich anfassen lässt: nicht angelegt und nicht aufgewertet. */
function frei(row: ItemRecord, itemId: string): boolean {
  // Aufgewertetes wird nie über die Kennung angefasst. Ein Auftrag, der vier
  // Essenzen einzieht, soll nicht die +5-Klinge daneben erwischen, nur weil
  // beide dieselbe Kennung tragen — und Materialien lassen sich ohnehin nicht
  // aufwerten, also kostet die Regel nichts.
  return row.itemId === itemId && !row.equipped && row.upgrade === 0;
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
    if (frei(row, itemId)) verfuegbar += row.count;
  }
  if (verfuegbar < count) return false;

  let rest = count;
  for (let i = items.length - 1; i >= 0 && rest > 0; i--) {
    const row = items[i]!;
    if (!frei(row, itemId)) continue;
    const nimm = Math.min(row.count, rest);
    row.count -= nimm;
    rest -= nimm;
    if (row.count === 0) items.splice(i, 1);
  }
  return true;
}

/**
 * Nimmt aus einem bestimmten Platz. Für alles, was ein *Stück* meint und
 * nicht eine Sorte — verkaufen zum Beispiel.
 */
export function removeSlot(items: ItemRecord[], slot: number, count: number): ItemRecord | undefined {
  const index = items.findIndex((i) => i.slot === slot);
  if (index < 0) return undefined;

  const row = items[index]!;
  if (row.equipped) return undefined;
  if (row.count < count) return undefined;

  const genommen: ItemRecord = { ...row, count };
  row.count -= count;
  if (row.count === 0) items.splice(index, 1);
  return genommen;
}


