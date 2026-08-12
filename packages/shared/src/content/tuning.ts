/**
 * Die Stellschrauben des Spiels.
 *
 * Alles, woran man beim Ausbalancieren dreht: Erfahrungskurve, Grundwerte je
 * Stufe, Aufwertungskosten und -chancen, Verkaufspreise, Taglänge. Die Zahlen
 * stehen in `assets/content/tuning.json` und werden zusammen mit den übrigen
 * Inhalten geladen.
 *
 * **Es gibt hier keine Standardwerte.** Ein Vorgabewert im Quelltext neben
 * einer Zahl in der Datei sind zwei Wahrheiten über dieselbe Sache, und die
 * schweigende von beiden gewinnt genau dann, wenn jemand in der Datei einen
 * Tippfehler macht. Wer vor dem Laden liest, bekommt deshalb eine Ausnahme mit
 * klarer Ansage statt einer stillen anderen Zahl.
 *
 * **Was hier nicht steht: die Kampfformel.** Schadensberechnung, kritische
 * Treffer und Trefferfenster rechnet der C++-Kern (`packages/core/src/
 * world.cpp`, `combat.cpp`). Die Zahlen dort in eine JSON-Datei zu schreiben
 * wäre eine Lüge: der Kern ist übersetzt, er würde sie nie lesen. Was den
 * Schaden angeht, ist `world.cpp` die Quelle — und zwar die einzige.
 */

export interface ProgressionTuning {
  maxLevel: number;
  /** `faktor * level^exponent + linear * level` — Erfahrung bis zur nächsten Stufe. */
  expFactor: number;
  expExponent: number;
  expLinear: number;

  baseHp: number;
  hpPerLevel: number;
  baseMp: number;
  mpPerLevel: number;
  baseAttack: number;
  attackPerLevel: number;
  baseDefense: number;
  defensePerLevel: number;
  moveSpeed: number;

  /** Höchster Bonus für Gegner über der eigenen Stufe. */
  expMaxBonus: number;
  /** Zuschlag je Stufe darüber. */
  expBonusPerLevel: number;
  /** Abschlag je Stufe darunter, bis fünf Stufen. */
  expMalusPerLevel: number;
  /** Abschlag je weiterer Stufe, bis zehn. */
  expFarMalusPerLevel: number;
  /** Was darunter übrigbleibt. */
  expFloor: number;
}

export interface PlayerTuning {
  attackRange: number;
  attackArc: number;
  attackCooldownSec: number;
  attackWindupSec: number;
  radius: number;
  height: number;
}

export interface UpgradeTuning {
  max: number;
  /** Ab dieser Stufe leuchtet die Waffe. */
  glowFrom: number;
  /** Wie hell die Aura auf der untersten leuchtenden Stufe ist, 0 bis 1. */
  glowBase: number;
  /** Erfolgsaussicht je Stufe. Feld 0 gilt für +0 auf +1. */
  chances: number[];
  /** Kleinster Grundwert, auf dem die Kosten aufsetzen. */
  costMinValue: number;
  /** Kosten = Grundwert · (`costBase` + Stufe · `costPerLevel`). */
  costBase: number;
  costPerLevel: number;
  /** Anteil des Grundwerts, den eine Stufe an Schaden oder Schutz bringt. */
  bonusPerLevel: number;
  /** Aufschlag auf den Verkaufspreis je Aufwertungsstufe. */
  sellBonusPerLevel: number;
}

export interface EconomyTuning {
  /** Anteil des Grundwerts, den ein Händler beim Ankauf zahlt. */
  sellFactor: number;
  inventorySlots: number;
}

export interface WorldTuning {
  /** Wie lange ein voller Tag dauert, in echten Minuten. */
  dayMinutes: number;
  /** Wie nah man an einem NPC stehen muss, um ihn anzusprechen. */
  interactRange: number;
}

export interface Tuning {
  progression: ProgressionTuning;
  player: PlayerTuning;
  upgrades: UpgradeTuning;
  economy: EconomyTuning;
  world: WorldTuning;
}

let geladen: Tuning | undefined;

/**
 * Die geltenden Zahlen.
 *
 * Wirft, solange nichts geladen ist. Das ist Absicht: eine stille Null wäre
 * ein Balancing-Fehler, den niemand findet, und ein Vorgabewert wäre eine
 * zweite Wahrheit. Beides ist schlimmer als ein Abbruch beim Start.
 */
export function tuning(): Tuning {
  if (!geladen) {
    throw new Error(
      '[tuning] Noch nichts geladen — assets/content/tuning.json muss vor dem Spielstart eingelesen werden.',
    );
  }
  return geladen;
}

/** Trägt die geladenen Zahlen ein. Nur der Inhaltslader ruft das auf. */
export function setTuning(werte: Tuning): void {
  geladen = werte;
}

/** Stehen die Zahlen schon? Für Werkzeuge, die ohne auskommen wollen. */
export function tuningLoaded(): boolean {
  return geladen !== undefined;
}
