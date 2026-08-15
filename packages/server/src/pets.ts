/**
 * Begleiter — was sie tun, und wann sie es tun.
 *
 * Der Kern trägt ein Haustier dorthin, wo es hinsoll: über das Gelände, um die
 * Hindernisse herum, mit seinem eigenen Tempo. **Wohin** es soll, steht hier.
 * Die Grenze verläuft genau dort, weil auf dieser Seite Beutel und Beute
 * liegen und auf jener Gelände und Kollision — und weil jede Änderung an dem,
 * was ein Tier für richtig hält, sonst einen neuen wasm-Bau bräuchte.
 *
 * Drei Zustände, und der Weg zwischen ihnen ist der ganze Verstand des Tiers:
 *
 *   `folgen`  — hinter dem Menschen her, mit Abstand. Der Ruhezustand.
 *   `sammeln` — ein bestimmter Haufen ist ausgesucht, es läuft hin.
 *   `heimweg` — es hat aufgehoben (oder aufgegeben) und kommt zurück. Von
 *               `folgen` unterscheidet es sich nur darin, dass die Uhr für das
 *               Festhängen läuft.
 *
 * Ein Support-Tier kennt nur `folgen`. Es sammelt nichts; was es beiträgt,
 * steht in denselben Feldern wie bei einem Ring und wird in `sheetFor`
 * aufaddiert — ein eigener Satz Felder wäre eine zweite Art, dieselbe Sache zu
 * sagen.
 */

import type { PetArt } from '@aurelith/shared';

/** Was ein Begleiter gerade vorhat. */
export type PetZustand = 'folgen' | 'sammeln' | 'heimweg';

export interface PetLauf {
  /**
   * Der Gegenstand, zu dem dieses Tier gehört.
   *
   * Die Kennung und **nicht** der Beutelplatz: Plätze werden beim Anlegen und
   * Ablegen neu vergeben (`normalizeSlots`), und eine gemerkte Nummer zeigte
   * danach auf etwas anderes. Eindeutig ist sie trotzdem — draussen ist je
   * Sorte genau eines, und zwei Ratten sind beide Sammler.
   */
  itemId: string;
  art: PetArt;
  /** Kennung des Wesens in der Welt. Wechselt, wenn es neu erscheinen muss. */
  entityId: number;
  zustand: PetZustand;
  /** Der Haufen, den es gerade holen will. */
  ziel?: number;
  /**
   * Seit wann es unterwegs nach Hause ist, in Millisekunden.
   *
   * Nur für den Fall, dass es hängenbleibt. Ein Tier, das seit zehn Sekunden
   * zurückkommen will und immer noch weit weg ist, kommt nicht mehr an: es
   * steht an einer Kiste, einem Zaun oder in einer Felsspalte. Dann wird es
   * eingeholt und neben dem Menschen wieder abgesetzt.
   */
  seitHeimweg: number;
}

/**
 * Abstand, den ein Begleiter zu seinem Menschen hält.
 *
 * Nicht null: bei null liefe das Tier in ihn hinein und zappelte dort, weil
 * jeder Schritt des Menschen es wieder danebenstellt. Anderthalb Einheiten
 * sehen aus wie „dabei" und nicht wie „im Weg" — im Weg steht es ohnehin
 * niemandem, `isCombatant` hält es aus der Trennung heraus.
 */
export const FOLGE_ABSTAND = 1.8;

/** So nah muss es an einem Haufen stehen, um ihn aufzuheben. */
export const SAMMEL_ABSTAND = 0.8;

/**
 * Ab wann ein Rückweg als gescheitert gilt: Zeit **und** Entfernung.
 *
 * Beides zusammen, nie einzeln. Nur die Zeit hiesse, ein Tier einzuholen, das
 * gemütlich zwei Schritte hinter einem herläuft. Nur die Entfernung hiesse,
 * eines einzuholen, das gerade erst losgelaufen ist — quer über eine Lichtung
 * sind zehn Einheiten kein Fehler, sondern ein Weg.
 */
export const HAENGT_MS = 8000;
export const HAENGT_ABSTAND = 14;

/**
 * Wie weit der Mensch weg sein darf, während das Tier sammelt.
 *
 * Gemessen wird zwischen **Mensch und Haufen** und nicht zwischen Mensch und
 * Tier: die Frage ist, ob das Ziel noch in Reichweite liegt. Am Tier gemessen
 * bräche der Sammelgang genau dann ab, wenn das Tier schon fast da ist — es
 * ist ja unterwegs vom Menschen weg.
 */
export function zielNochErlaubt(
  spielerX: number,
  spielerZ: number,
  zielX: number,
  zielZ: number,
  heimweg: number,
): boolean {
  const dx = zielX - spielerX;
  const dz = zielZ - spielerZ;
  return dx * dx + dz * dz <= heimweg * heimweg;
}
