/**
 * Der Tageswechsel im Bild.
 *
 * Die Rechnung steht in `@aurelith/shared` — hier wird sie nur angewandt: auf
 * Himmel, Licht und Nebel der Szene und auf die Laternen, die nur nachts
 * brennen sollen.
 *
 * **Nicht jedes Bild.** Der Himmel wird beim Neufärben vertexweise gerechnet,
 * und die Farben ändern sich über Minuten. Ein Wechsel alle paar Zehntel
 * genügt und ist im Bild nicht zu sehen — jedes Bild wäre reine Verschwendung.
 */

import { skyAt, timeOfDay, type EnvironmentDef, type SkyState } from '@aurelith/shared';
import type { Scene3D } from './scene.ts';
import type { Lanterns } from './lanterns.ts';

/** Wie oft die Farben neu gerechnet werden. */
const INTERVAL_MS = 250;

export class DayCycle {
  private base?: EnvironmentDef;
  private nextAt = 0;
  private letzter?: SkyState;
  /** Tageszeit als Anteil — für die Uhr in der Oberfläche. */
  time = 0.5;

  /** Übernimmt die Karteneinstellung als Mittagsstand. */
  setEnvironment(env: EnvironmentDef): void {
    this.base = env;
    // Beim Kartenwechsel sofort neu rechnen: sonst steht die neue Karte bis
    // zum nächsten Fälligkeitszeitpunkt in der Beleuchtung der alten.
    this.nextAt = 0;
  }

  /**
   * Rechnet den Stand zur Serverzeit und trägt ihn ein.
   *
   * `serverTimeMs` ist die *Serveruhr*, nicht die des Geräts — nur so haben
   * zwei Spieler nebeneinander dieselbe Tageszeit.
   */
  update(serverTimeMs: number, scene: Scene3D, lanterns: Lanterns, nowMs: number): void {
    if (!this.base) return;
    this.time = timeOfDay(serverTimeMs);
    if (nowMs < this.nextAt) return;
    this.nextAt = nowMs + INTERVAL_MS;

    const state = skyAt(this.time, this.base);
    this.letzter = state;
    scene.applySky(state);
    lanterns.setDarkness(state.darkness);
  }

  /** Der zuletzt eingetragene Stand. Für die Auskunft. */
  get state(): SkyState | undefined {
    return this.letzter;
  }
}
