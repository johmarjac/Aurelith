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

/** Mehr Inputs als das puffert der Server pro Spieler nicht. */
export const MAX_INPUT_BACKLOG = 32;

export const EntityType = {
  Player: 0,
  Monster: 1,
  Npc: 2,
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
