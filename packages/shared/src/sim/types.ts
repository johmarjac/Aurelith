/**
 * Konstanten und Aufzählungen, die TypeScript und der C++-Kern gemeinsam
 * kennen müssen.
 *
 * Die Simulation selbst liegt seit dem Wechsel auf den Hybrid-Aufbau in
 * `packages/core` — hier steht nur noch, was das Protokoll und die
 * Spielsteuerung zum Reden brauchen. Die Zahlenwerte spiegeln `types.hpp`;
 * wer eine ändert, ändert beide.
 */

/** Feste Schrittweite der Simulation. Spiegelt `kTickRate`. */
export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;
export const TICK_SECONDS = 1 / TICK_RATE;

/** Snapshots gehen nur jeden n-ten Tick raus. 20 / 2 = 10 Hz. */
export const SNAPSHOT_TICK_DIVISOR = 2;

/** Sichtweite, ab der ein Entity für einen Spieler relevant ist. */
export const INTEREST_RADIUS = 140;

/**
 * Wie weit der Umgebungschat trägt, in Weltenheiten.
 *
 * Deutlich kürzer als der Sichtradius, und das ist der Punkt: gesehen wird
 * über das halbe Dorf, gehört wird ein paar Schritte weit. Vorher galt für
 * beides dieselbe Zahl — damit war „Umgebung" praktisch dasselbe wie „Karte",
 * und der Unterschied zwischen den Kanälen stand nur im Namen.
 *
 * Fünfundzwanzig Einheiten sind etwa der Platz vor dem Brunnen: wer dort
 * steht, ist im Gespräch; wer am Ortsrand steht, nicht.
 */
export const CHAT_RADIUS = 25;

/** Mehr Inputs als das puffert der Server pro Spieler nicht. */
export const MAX_INPUT_BACKLOG = 32;

/**
 * Die acht Himmelsrichtungen, beginnend im Norden und im Uhrzeigersinn.
 *
 * **Norden ist +z.** Das ist keine Willkür, sondern steht schon überall in
 * dieser Welt: Lichtmoor heisst sein Nordufer `zNord = 240`, die Sperrfläche
 * darüber heisst „Nordsee", und die Stufen der Monster steigen mit `z` — die
 * Prüfung der Karte rechnet genau diesen Zusammenhang nach. Eine zweite
 * Festlegung daneben hiesse, dass eines Tages die Karte nach Norden härter
 * wird und der Kompass dabei nach Süden zeigt.
 */
export const HIMMELSRICHTUNGEN = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'] as const;

export type Himmelsrichtung = (typeof HIMMELSRICHTUNGEN)[number];

/**
 * Welche Himmelsrichtung ein Kurs bezeichnet.
 *
 * `yaw` ist der Winkel, mit dem Kern und Kamera arbeiten: die Blickrichtung
 * zeigt entlang `(sin yaw, cos yaw)`. Bei null ist das `(0, 1)`, also +z —
 * Norden. Ein Achtel des Vollkreises je Richtung, und gerundet wird zur
 * nächsten: der Wechsel von N auf NO liegt damit bei 22,5 Grad und nicht bei
 * 45, sonst hiesse geradeaus nach Nordosten immer noch „N".
 *
 * **Das Minus ist der Kern der Sache.** Hier stand einmal ein Plus, und die
 * Anzeige war damit an Ost und West spiegelverkehrt: wer nach Norden sah und
 * die Kamera nach rechts drehte, las „W". Der Grund sind zwei Drehsinne, die
 * gegeneinander laufen.
 *
 *   - **Die Peilung läuft im Uhrzeigersinn**: N, NO, O, SO — nach rechts.
 *   - **`yaw` läuft andersherum.** Osten ist die Richtung, die rechts liegt,
 *     wenn man nach Norden sieht, und rechts auf dem Bildschirm ist
 *     `kreuz(vorwärts, oben)`. Bei Blick nach Norden ist das
 *     `kreuz((0,0,1), (0,1,0)) = (-1,0,0)` — also **−x**. Der Kurs mit
 *     Blickrichtung −x ist `yaw = -PI/2` und nicht `+PI/2`.
 *
 * Anders gesagt: Norden ist +z, Osten ist −x, Süden ist −z, Westen ist +x.
 * Ein Plus an dieser Stelle vertauscht die beiden mittleren.
 */
export function himmelsrichtung(yaw: number): Himmelsrichtung {
  const achtel = Math.round(-yaw / (Math.PI / 4));
  // Erst das Modulo, dann der Ausgleich: `%` behält in JavaScript das
  // Vorzeichen des Zählers, und ein Blick nach Westen (yaw = +PI/2) gäbe
  // sonst den Index -2 und damit `undefined`.
  return HIMMELSRICHTUNGEN[((achtel % 8) + 8) % 8]!;
}

export const EntityType = {
  Player: 0,
  Monster: 1,
  Npc: 2,
  /**
   * Ein Begleiter. Läuft hinter jemandem her, kämpft nicht und lässt sich
   * nicht anvisieren — im Kern sorgt `isCombatant` dafür.
   */
  Pet: 3,
} as const;
export type EntityType = (typeof EntityType)[keyof typeof EntityType];

export const EntityState = {
  Idle: 0,
  Move: 1,
  Attack: 2,
  Dead: 3,
} as const;
export type EntityState = (typeof EntityState)[keyof typeof EntityState];

/** Ein Eingabekommando, wie es über das Protokoll geht. */
export interface InputCommand {
  seq: number;
  /** Bewegungswunsch in Weltachsen, Länge maximal 1. */
  moveX: number;
  moveZ: number;
  /** Blickrichtung, die der Client haben möchte. */
  yaw: number;
  buttons: number;
}
