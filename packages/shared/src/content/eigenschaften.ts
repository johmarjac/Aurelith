/**
 * Die vier Grundeigenschaften — Stärke, Ausdauer, Geschick, Weisheit.
 *
 * Nicht zu verwechseln mit den **Attributen** in `attributes.ts`. Der
 * Unterschied ist die Richtung: eine Eigenschaft ist etwas, das der Spieler
 * **setzt**, ein Attribut etwas, das daraus **folgt**. Leben, Angriff,
 * Verteidigung stehen dort und werden gerechnet; hier stehen die vier Zahlen,
 * aus denen unter anderem gerechnet wird.
 *
 * Bei jedem Stufenaufstieg gibt es Punkte, und wer sie verteilt, entscheidet,
 * woran seine Figur stark wird. Das ist der ganze Sinn: zwei Figuren derselben
 * Stufe waren bisher bis auf die Ausrüstung gleich.
 *
 * **Die offenen Punkte werden nicht gespeichert.** Sie ergeben sich aus Stufe
 * minus dem, was schon verteilt ist. Eine eigene Spalte dafür wäre eine zweite
 * Wahrheit über dieselbe Sache — und die eine, die man beim Zurücksetzen einer
 * Stufe vergisst.
 */

import { tuning } from './tuning.ts';

export type EigenschaftId = 'staerke' | 'ausdauer' | 'geschick' | 'weisheit';

export interface EigenschaftDef {
  id: EigenschaftId;
  name: string;
  /** Wofür sie gut ist — steht als Hinweis an der Zeile. */
  hinweis: string;
}

/**
 * Die Liste. Reihenfolge ist Anzeigereihenfolge, und die Kennungen gehen über
 * die Leitung — sie werden nicht umbenannt.
 */
export const EIGENSCHAFTEN: readonly EigenschaftDef[] = [
  { id: 'staerke', name: 'Stärke', hinweis: 'Mehr Schaden mit jedem Schlag.' },
  { id: 'ausdauer', name: 'Ausdauer', hinweis: 'Mehr Leben und mehr Verteidigung.' },
  {
    id: 'geschick',
    name: 'Geschick',
    hinweis: 'Häufiger kritische Treffer und kürzere Schlagpausen.',
  },
  {
    id: 'weisheit',
    name: 'Weisheit',
    hinweis: 'Mehr Mana — und damit mehr Fertigkeiten hintereinander.',
  },
];

export type Eigenschaften = Record<EigenschaftId, number>;

export function istEigenschaft(id: string): id is EigenschaftId {
  return EIGENSCHAFTEN.some((e) => e.id === id);
}

/** Womit eine frische Figur anfängt — auf allen vieren gleich. */
export function startEigenschaften(): Eigenschaften {
  const start = tuning().progression.startEigenschaft;
  return { staerke: start, ausdauer: start, geschick: start, weisheit: start };
}

/**
 * Wie viele Punkte diese Stufe insgesamt hergegeben hat.
 *
 * Stufe 1 gibt keine — die Startwerte **sind** der Anfang. Ab da je Stufe so
 * viele, wie in `tuning.json` stehen.
 */
export function punkteFuerStufe(level: number): number {
  return Math.max(0, level - 1) * tuning().progression.punkteJeStufe;
}

/** Wie viele Punkte über den Startwerten schon verteilt sind. */
export function verteiltePunkte(e: Eigenschaften): number {
  const start = tuning().progression.startEigenschaft;
  return EIGENSCHAFTEN.reduce((summe, def) => summe + Math.max(0, e[def.id] - start), 0);
}

/**
 * Wie viele Punkte noch offen sind.
 *
 * Kann nach einer Änderung an `tuning.json` — oder nach `/level` nach unten —
 * negativ sein. Dann wird `null` daraus: die Anzeige soll „nichts zu
 * verteilen" sagen und keine Zahl mit Minus davor, und verteilen lässt sich
 * ohnehin nichts. Was schon verteilt war, bleibt stehen; einer Figur Punkte
 * wieder wegzunehmen, die sie längst ausgegeben hat, wäre die unfreundlichere
 * Auslegung derselben Zahl.
 */
export function offenePunkte(level: number, e: Eigenschaften): number {
  return Math.max(0, punkteFuerStufe(level) - verteiltePunkte(e));
}

/** Liest die vier Werte aus beliebigem Zeug — fehlende werden zu Startwerten. */
export function leseEigenschaften(roh: Partial<Eigenschaften> | undefined): Eigenschaften {
  const start = startEigenschaften();
  if (!roh) return start;
  const zahl = (v: unknown, ersatz: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : ersatz;
  return {
    staerke: zahl(roh.staerke, start.staerke),
    ausdauer: zahl(roh.ausdauer, start.ausdauer),
    geschick: zahl(roh.geschick, start.geschick),
    weisheit: zahl(roh.weisheit, start.weisheit),
  };
}

/** Ein Beitrag einer Eigenschaft zu einem Attribut. */
export interface EigenschaftsWirkung {
  /** Kennung des Attributs — siehe `ATTRIBUTES`. */
  attribut: string;
  /** Flacher Zuschlag. */
  flach: number;
  /** Anteil, −0.2 heisst zwanzig Prozent weniger. */
  prozent: number;
  /** Welche Eigenschaft ihn beisteuert — für die Herkunftszeile. */
  quelle: string;
}

/**
 * Was die vier Zahlen bewirken.
 *
 * An **einer** Stelle, weil es zwei Leser gibt: der Server rechnet damit die
 * Werte der Figur aus, und das Charakterfenster zeigt sie an. Zwei Abschriften
 * wären zwei Meinungen darüber, was ein Punkt Ausdauer wert ist — und die
 * angezeigte wäre die falsche.
 *
 * Die Schlagpause ist der einzige Anteil statt Zuschlag, und sie ist gedeckelt.
 * Ohne Deckel führte genug Geschick zu einer Pause von null, und der Kern
 * kennt dafür keinen Sonderfall: aus „schnell" würde „unendlich oft je Bild".
 */
export function eigenschaftsWirkung(e: Eigenschaften): EigenschaftsWirkung[] {
  const p = tuning().progression;
  const raus: EigenschaftsWirkung[] = [];
  const fuege = (attribut: string, flach: number, prozent: number, quelle: string): void => {
    if (flach !== 0 || prozent !== 0) raus.push({ attribut, flach, prozent, quelle });
  };

  fuege('attackDamage', e.staerke * p.angriffProStaerke, 0, 'Stärke');
  fuege('maxHp', e.ausdauer * p.lebenProAusdauer, 0, 'Ausdauer');
  fuege('defense', e.ausdauer * p.verteidigungProAusdauer, 0, 'Ausdauer');
  fuege('critChance', e.geschick * p.kritProGeschick, 0, 'Geschick');
  fuege(
    'attackCooldown',
    0,
    -Math.min(p.maxPausenkuerzung, e.geschick * p.pausenkuerzungProGeschick),
    'Geschick',
  );
  fuege('maxMp', e.weisheit * p.manaProWeisheit, 0, 'Weisheit');

  return raus;
}
