/**
 * Vom Wunsch zur Bewegung.
 *
 * Tasten und Joystick liefern einen Richtungswunsch, der von einem Bild auf das
 * nächste springt: eben noch Norden, jetzt Westen. Gibt man den unverändert an
 * die Simulation weiter, dreht sich die Figur in einem einzigen Schritt um
 * neunzig Grad und läuft im selben Moment mit voller Geschwindigkeit los. Beides
 * sieht aus wie ein Schnitt, nicht wie eine Bewegung.
 *
 * Hier wird daraus etwas Stetiges: die Blickrichtung dreht mit begrenzter
 * Geschwindigkeit, der Betrag läuft an und aus.
 *
 * Bewusst ohne DOM und ohne Zeitquelle — die Schrittweite kommt von außen.
 * Damit läuft dieselbe Rechnung im festen Simulationstakt wie im Test, und es
 * gibt nichts, was sich je nach Bildrate anders verhält. Das ist keine
 * Bequemlichkeit: was hier herauskommt, geht als Eingabe an den Server, und
 * jede Abhängigkeit von der Bildrate wäre eine Abweichung zwischen Vorhersage
 * und Autorität.
 */

import { angleDelta, clamp, normalizeAngle } from '@aurelith/shared';

/**
 * Wie schnell sich die Figur um die eigene Achse dreht, Bogenmaß je Sekunde.
 *
 * Eine halbe Drehung dauert damit knapp drei Zehntelsekunden — schnell genug,
 * dass sich die Steuerung direkt anfühlt, langsam genug, dass man die Drehung
 * als Bewegung sieht.
 */
export const TURN_RATE = 11;

/** Zeit vom Stand auf volle Geschwindigkeit, in Sekunden. */
export const ACCEL_TIME = 0.14;

/**
 * Zeit von voller Geschwindigkeit zurück auf null. Etwas länger als das
 * Anlaufen — auslaufen wirkt schwerfälliger, und genau das erwartet man auch.
 */
export const DECEL_TIME = 0.2;

/** Unterhalb dieses Betrags gilt die Figur als stehend. */
const REST_EPSILON = 0.002;

export interface SteeringOutput {
  /** Bewegungswunsch in Weltachsen, Länge höchstens 1. */
  moveX: number;
  moveZ: number;
  /** Blickrichtung der Figur, in [0, 2*PI). */
  yaw: number;
}

export class Steering {
  /** Blickrichtung der Figur. Läuft der gewünschten hinterher, nie sprunghaft. */
  private facing = 0;
  /** Wohin die Figur schauen soll. Ändert sich sofort, wenn man drückt. */
  private desired = 0;
  /** Geglätteter Betrag des Bewegungswunsches, 0 bis 1. */
  private magnitude = 0;

  /**
   * Ein Schritt.
   *
   * `wishX`/`wishZ` ist der rohe Richtungswunsch in Weltachsen; seine Länge
   * wird als Intensität gelesen und auf eins gedeckelt. Null heißt „steht".
   */
  step(wishX: number, wishZ: number, dt: number): SteeringOutput {
    const wish = Math.min(1, Math.hypot(wishX, wishZ));

    // Die Wunschrichtung folgt der Eingabe sofort. Nur die Figur braucht Zeit.
    if (wish > 0.001) this.desired = Math.atan2(wishX, wishZ);

    // Drehen mit begrenzter Geschwindigkeit, über den kürzesten Weg.
    const maxTurn = TURN_RATE * dt;
    this.facing = normalizeAngle(
      this.facing + clamp(angleDelta(this.facing, this.desired), -maxTurn, maxTurn),
    );

    // Anlaufen und Auslaufen mit fester Rate. Eine exponentielle Annäherung
    // erreicht ihr Ziel nie ganz, und „fast null" schöbe die Figur ewig weiter.
    const rate = dt / (wish > this.magnitude ? ACCEL_TIME : DECEL_TIME);
    this.magnitude = clamp(this.magnitude + clamp(wish - this.magnitude, -rate, rate), 0, 1);
    if (this.magnitude < REST_EPSILON) this.magnitude = 0;

    // Bewegt wird in die **Wunschrichtung**, gedreht wird gemächlich.
    //
    // Der Unterschied ist wichtig genug für einen Absatz. Koppelt man die
    // Bewegung an die Blickrichtung, fährt die Figur beim Richtungswechsel
    // eine Kurve — sie zieht noch ein Stück in die alte Richtung, während sie
    // sich dreht. Das sieht zwar zusammenhängend aus, kostet aber genau in dem
    // Moment Reaktion, in dem man sie braucht: bei einer Vierteldrehung sind
    // das anderthalb Zehntelsekunden, in denen die Figur woanders hinläuft, als
    // man gedrückt hat. Der Rauchtest hat das prompt gemessen — die Figur kam
    // beim Antippen von A und D kaum von der Stelle.
    //
    // Also: die Bewegung folgt sofort, der Körper dreht sich nach. Für den
    // kurzen Moment dazwischen schaut die Figur nicht ganz dorthin, wo sie
    // hinläuft. Das ist der Kompromiss, den auch die Vorbilder wählen, und der
    // unauffälligere von beiden.
    const dir = wish > 0.001 ? Math.atan2(wishX, wishZ) : this.facing;
    return {
      moveX: Math.sin(dir) * this.magnitude,
      moveZ: Math.cos(dir) * this.magnitude,
      yaw: this.facing,
    };
  }

  /**
   * Dreht die Figur zu einem Winkel, ohne den Lauf anzuhalten.
   *
   * Für den Kampf: wer sein Ziel anschaut, soll sich dorthin **drehen** und
   * nicht dorthin springen. `reset` täte beides falsch — es setzt den Winkel
   * hart und stellt den Betrag der Bewegung auf null, was die Figur bei jedem
   * Aufruf neu anlaufen liesse.
   *
   * Der Wunsch gilt nur, solange niemand steuert: `step` überschreibt ihn,
   * sobald ein Bewegungswunsch anliegt. Genau so soll es sein — wer läuft,
   * schaut, wohin er läuft.
   */
  ausrichten(yaw: number): void {
    this.desired = normalizeAngle(yaw);
  }

  /**
   * Setzt die Blickrichtung hart — beim Einloggen und nach einem Kartenwechsel.
   *
   * Beide Winkel, sonst dreht sich die Figur nach dem Erscheinen erst gemächlich
   * dorthin, wo sie ohnehin schon stehen sollte.
   */
  reset(yaw: number): void {
    this.facing = normalizeAngle(yaw);
    this.desired = this.facing;
    this.magnitude = 0;
  }

  get yaw(): number {
    return this.facing;
  }

  /** Aktueller Betrag der Bewegung, 0 bis 1. */
  get speed(): number {
    return this.magnitude;
  }
}
