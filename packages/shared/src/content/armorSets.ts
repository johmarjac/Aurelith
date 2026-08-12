/**
 * Rüstungssätze: wann ein Satz zählt, und wie hell er dann leuchtet.
 *
 * Zwei Fragen, die überall dieselbe Antwort brauchen — der Server rechnet die
 * Werte damit aus, der Client schreibt sie ins Fenster, und die Aura am Körper
 * hängt an derselben Zahl. Stünde die Regel an drei Stellen, zeigte das
 * Inventar irgendwann einen Satzbonus an, den der Server nicht gibt.
 *
 * **Der Satz gilt ganz oder gar nicht.** Drei von vier Teilen bringen nichts;
 * das ist der Sinn eines Satzes und der Grund, warum man das vierte Stück
 * sucht. Flyff macht es genauso.
 *
 * **Das Leuchten hängt am schwächsten Stück.** Wer Kappe, Wams und Hose auf
 * +9 hat und die Stiefel auf +0, hat keinen leuchtenden Satz — er hat drei
 * gute Teile und ein vergessenes. Das Kleinste über alle Teile ist deshalb die
 * Stufe, mit der `glowStrength` gefüttert wird: eine einzige Zahl, die genau
 * das aussagt, was der Spieler sieht.
 */

import { setOfItem, type ArmorSetDef } from './database.ts';
import { glowFrom } from './upgrades.ts';

/** Ein angelegtes Stück — mehr braucht die Rechnung nicht. */
export interface WornPiece {
  itemId: string;
  upgrade: number;
}

/** Ein aktiver Satz mitsamt der Stufe, die sein schwächstes Teil trägt. */
export interface ActiveSet {
  set: ArmorSetDef;
  /** Kleinste Aufwertungsstufe über alle Teile des Satzes. */
  minUpgrade: number;
}

/**
 * Wie viele Teile eines Satzes getragen werden.
 *
 * Für die Anzeige gedacht („2/4"): wer sieht, dass zwei fehlen, sucht weiter.
 * Doppelte Stücke zählen einmal — zwei gleiche Ringe wären sonst ein halber
 * Satz.
 */
export function setProgress(set: ArmorSetDef, worn: readonly WornPiece[]): number {
  const getragen = new Set(worn.map((w) => w.itemId));
  return set.pieces.reduce((n, teil) => n + (getragen.has(teil) ? 1 : 0), 0);
}

/**
 * Welcher Satz ist vollständig angelegt?
 *
 * Höchstens einer: ein Stück gehört zu höchstens einem Satz, und ein Platz
 * trägt höchstens ein Stück. Gefunden wird über die Sätze der angelegten
 * Teile — nicht über alle Sätze der Welt, denn davon gibt es beliebig viele
 * und angelegt ist immer eine Handvoll.
 */
export function activeArmorSet(worn: readonly WornPiece[]): ActiveSet | undefined {
  const kandidaten = new Map<string, ArmorSetDef>();
  for (const stueck of worn) {
    const satz = setOfItem(stueck.itemId);
    if (satz) kandidaten.set(satz.id, satz);
  }

  for (const satz of kandidaten.values()) {
    if (setProgress(satz, worn) < satz.pieces.length) continue;

    let min = Infinity;
    for (const teil of satz.pieces) {
      // Bei doppelt getragenen Stücken zählt das schlechtere: das Leuchten
      // soll nicht davon abhängen, welches der beiden zuerst gefunden wird.
      for (const stueck of worn) {
        if (stueck.itemId === teil) min = Math.min(min, stueck.upgrade);
      }
    }
    return { set: satz, minUpgrade: Math.max(0, min) };
  }
  return undefined;
}

/**
 * Die Stufe, mit der die Rüstung leuchtet. Null heisst: sie leuchtet nicht.
 *
 * Kein eigener Schwellenwert — es ist derselbe wie bei der Waffe, weil es
 * dieselbe Aussage ist: ab hier hat jemand etwas riskiert. Unter der Schwelle
 * gibt die Funktion glatt Null zurück, damit über die Leitung nicht eine Zahl
 * geht, die am anderen Ende doch nichts bewirkt.
 */
export function setGlowLevel(active: ActiveSet | undefined): number {
  if (!active) return 0;
  return active.minUpgrade >= glowFrom() ? active.minUpgrade : 0;
}
