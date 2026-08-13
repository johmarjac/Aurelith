/**
 * Die Aktionsleiste — was auf den Plätzen unten liegt.
 *
 * Zehn Plätze, belegt vom Spieler: ein Gegenstand aus dem Beutel oder eine
 * Fertigkeit. Am Schreibtisch liegen sie auf den Zifferntasten, auf dem Telefon
 * sind sie die einzige Möglichkeit, im Kampf an einen Trank zu kommen — dort
 * ist das Inventar bildfüllend, und wer es öffnet, sieht nichts mehr.
 *
 * Ein Platz zeigt auf eine **Kennung**, nicht auf einen Beutelplatz. Das ist
 * der Unterschied zwischen „der Trank" und „was gerade auf Platz 7 im Beutel
 * liegt": Beutelplätze ändern sich beim Umsortieren, beim Aufheben, beim
 * Verkaufen. Ein Verweis darauf zeigte nach dem ersten Aufräumen auf etwas
 * anderes — und man tränke im Kampf ein Fischbrötchen.
 */

/**
 * Wie viele Plätze die Leiste hat.
 *
 * Zehn, weil es zehn Zifferntasten gibt: 1 bis 9 und die 0 ganz rechts. Mehr
 * Plätze als Tasten hiesse, dass die letzten am Schreibtisch nur mit der Maus
 * erreichbar wären.
 */
export const AKTIONS_PLAETZE = 10;

/** Was auf einem Platz liegen kann. */
export const AktionsArt = {
  Leer: 0,
  Gegenstand: 1,
  Fertigkeit: 2,
} as const;
export type AktionsArt = (typeof AktionsArt)[keyof typeof AktionsArt];

export interface AktionsPlatz {
  art: AktionsArt;
  /** Kennung des Gegenstands oder der Fertigkeit. Leer, wenn der Platz leer ist. */
  id: string;
}

/** Eine leere Leiste. Immer voller Länge — ein Loch wäre ein zweiter Zustand. */
export function leereLeiste(): AktionsPlatz[] {
  return Array.from({ length: AKTIONS_PLAETZE }, () => ({ art: AktionsArt.Leer, id: '' }));
}

/**
 * Bringt eine Leiste beliebiger Herkunft auf Form.
 *
 * Zu kurz wird aufgefüllt, zu lang abgeschnitten, Unbekanntes wird leer. Eine
 * Stelle dafür, weil es drei Herkünfte gibt — Datenbank, Netz, frische Figur —
 * und drei Auffassungen davon, was „kaputt" bedeutet, unweigerlich
 * auseinanderlaufen.
 */
export function normalisiereLeiste(
  roh: readonly { art?: number; id?: string }[],
): AktionsPlatz[] {
  const leiste = leereLeiste();
  for (let i = 0; i < AKTIONS_PLAETZE; i++) {
    const p = roh[i];
    if (!p) continue;
    const art: AktionsArt =
      p.art === AktionsArt.Gegenstand || p.art === AktionsArt.Fertigkeit
        ? p.art
        : AktionsArt.Leer;
    const id = art === AktionsArt.Leer ? '' : (p.id ?? '');
    // Eine Art ohne Kennung ist kein halber Eintrag, sondern ein leerer.
    leiste[i] = id === '' ? { art: AktionsArt.Leer, id: '' } : { art, id };
  }
  return leiste;
}
