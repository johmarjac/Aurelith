/**
 * Ausrüstungsplätze: was man wo trägt, und was man davon sieht.
 *
 * Zwei Dinge, die hier bewusst auseinandergehalten werden.
 *
 * **Der Platz eines Gegenstands ist nicht seine Stelle an der Figur.** Ein
 * Ring ist ein Ring; ob er an der linken oder rechten Hand sitzt, geht die
 * Inhaltsdatei nichts an. Deshalb sagt `EquipSlot` nur `ring`, und wie viele
 * davon gleichzeitig getragen werden dürfen, sagt `slotCapacity`. Zwei
 * getrennte Plätze `ring1` und `ring2` hätten bedeutet, dass jeder Ring sich
 * für eine Hand entscheiden muss — und dass man den zweiten nicht anlegen
 * kann, solange der erste am falschen Finger steckt.
 *
 * **Was man trägt ist nicht, was man sieht.** Eine Halskette und zwei Ringe
 * ändern die Werte, aber auf einem Modell aus Kästen sind sie nicht zu
 * erkennen. Sichtbar sind die sieben Teile in `VISIBLE_SLOTS` — und nur die
 * gehen als `Outfit` über die Leitung, damit der Snapshot nicht für Dinge
 * wächst, die niemand sehen kann.
 */

import type { EquipSlot, ItemDef } from './database.ts';

/** Alle Plätze, auf denen etwas getragen werden kann. Ohne `none`. */
export const EQUIP_SLOTS: readonly EquipSlot[] = [
  'mainhand',
  'offhand',
  'head',
  'chest',
  'legs',
  'feet',
  'hands',
  'cloak',
  'glasses',
  'necklace',
  'earring',
  'ring',
];

/** Deutscher Name eines Platzes — für die Beschriftung in der Oberfläche. */
export const SLOT_NAMES: Readonly<Record<EquipSlot, string>> = {
  mainhand: 'Waffe',
  offhand: 'Nebenhand',
  head: 'Kopf',
  chest: 'Brust',
  legs: 'Hose',
  feet: 'Schuhe',
  hands: 'Hände',
  cloak: 'Umhang',
  glasses: 'Brille',
  necklace: 'Halskette',
  earring: 'Ohrring',
  ring: 'Ring',
  none: '—',
};

/**
 * Wie viele Stücke auf einem Platz gleichzeitig sitzen dürfen.
 *
 * Ringe und Ohrringe sind mehr als eins — man hat zwei Hände und zwei Ohren.
 * Steht hier und nicht als Zahl im Server, weil der Client dieselbe Frage
 * beantworten muss: das Inventar zeichnet zwei Ringkästchen und nur ein
 * Brustkästchen.
 */
export function slotCapacity(slot: EquipSlot): number {
  if (slot === 'none') return 0;
  return slot === 'ring' || slot === 'earring' ? 2 : 1;
}

/**
 * Die Teile, die man an der Figur sieht, in fester Reihenfolge.
 *
 * Die Reihenfolge ist Teil des Vertrags: `encodeOutfit` schreibt sie so in
 * die Zeichenkette, und `decodeOutfit` liest sie so zurück. Wer hier etwas
 * einfügt, muss PROTOCOL_VERSION hochzählen.
 */
export const VISIBLE_SLOTS = [
  'head',
  'chest',
  'legs',
  'feet',
  'hands',
  'cloak',
  'glasses',
] as const;
export type VisibleSlot = (typeof VISIBLE_SLOTS)[number];

/** Welcher Stil auf welchem sichtbaren Platz sitzt. Leer heißt: nichts an. */
export type Outfit = Partial<Record<VisibleSlot, string>>;

/**
 * Das Aussehen als eine Zeichenkette, für den Snapshot.
 *
 * Ein Feld statt sieben: Ausrüstung wechselt selten, und der Server schickt
 * ohnehin die volle Zeile, wenn sich etwas ändert. Sieben kurze Felder wären
 * sieben Längenbytes für dieselbe Auskunft.
 *
 *     encodeOutfit({ chest: 'leder', feet: 'leder' })  →  "|leder||leder|||"
 */
export function encodeOutfit(outfit: Outfit): string {
  return VISIBLE_SLOTS.map((s) => outfit[s] ?? '').join('|');
}

export function decodeOutfit(text: string): Outfit {
  if (text === '') return {};
  const teile = text.split('|');
  const outfit: Outfit = {};
  VISIBLE_SLOTS.forEach((slot, i) => {
    const stil = teile[i] ?? '';
    if (stil !== '') outfit[slot] = stil;
  });
  return outfit;
}

/** Ist dieser Platz einer, den man an der Figur sieht? */
export function isVisibleSlot(slot: EquipSlot): slot is VisibleSlot {
  return (VISIBLE_SLOTS as readonly string[]).includes(slot);
}

/**
 * Der Stil, in dem ein Stück gezeichnet wird.
 *
 * `armorStyle` steht in der Inhaltsdatei; fehlt er, gilt `schlicht`. Ein
 * Rückfall statt einer Pflichtangabe, weil ein Gegenstand ohne Stil sonst
 * unsichtbar wäre — und ein Teil, das man anlegt und nicht sieht, ist genau
 * der Fehler, den diese ganze Runde beheben soll.
 */
export function styleOf(def: ItemDef): string {
  return def.armorStyle ?? 'schlicht';
}
