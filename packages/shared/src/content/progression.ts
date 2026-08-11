/**
 * Stufenaufstieg. Die Kurve ist bewusst flach am Anfang — die ersten Stufen
 * sollen in Minuten fallen, damit sich in einer Testsitzung überhaupt etwas
 * bewegt. Balancing kommt später und ändert nur die Konstanten hier.
 */

import type { ItemDef } from './database.ts';

export const MAX_LEVEL = 60;

/** Erfahrung, die von Stufe `level` auf `level + 1` nötig ist. */
export function expForLevel(level: number): number {
  if (level >= MAX_LEVEL) return Number.POSITIVE_INFINITY;
  return Math.floor(45 * Math.pow(level, 1.72) + 55 * level);
}

export interface DerivedStats {
  maxHp: number;
  maxMp: number;
  attackDamage: number;
  defense: number;
  /** Weltnenheiten pro Sekunde. */
  moveSpeed: number;
}

/** Grundwerte allein aus der Stufe, ohne Ausrüstung. */
export function baseStatsForLevel(level: number): DerivedStats {
  return {
    maxHp: 80 + (level - 1) * 22,
    maxMp: 40 + (level - 1) * 10,
    attackDamage: 6 + (level - 1) * 2.4,
    defense: 1 + (level - 1) * 1.1,
    moveSpeed: 6.2,
  };
}

/**
 * Erfahrungsgewinn mit Stufenabstand. Weit unter dem eigenen Level gibt es
 * kaum noch etwas — sonst farmt jeder ewig auf der Anfängerwiese.
 */
export function expGain(baseExp: number, playerLevel: number, mobLevel: number): number {
  const diff = mobLevel - playerLevel;
  let factor: number;
  if (diff >= 0) factor = Math.min(1.5, 1 + diff * 0.08);
  else if (diff >= -5) factor = 1 + diff * 0.1;
  else if (diff >= -10) factor = 0.5 + (diff + 5) * 0.08;
  else factor = 0.05;
  return Math.max(1, Math.floor(baseExp * Math.max(0.05, factor)));
}

/** Schadensformel. Verteidigung dämpft, statt hart abzuziehen. */
export function computeDamage(attack: number, defense: number, roll: number): number {
  const mitigated = attack * (attack / (attack + Math.max(0, defense) * 1.6));
  // ±12 % Streuung, damit gleiche Gegner nicht identisch sterben.
  const varied = mitigated * (0.88 + roll * 0.24);
  return Math.max(1, Math.round(varied));
}

/** Kritische Treffer: fester Sockel, später aus Werten gespeist. */
export const CRIT_CHANCE = 0.12;
export const CRIT_MULTIPLIER = 1.75;

/**
 * Kampfprofil der Spielerfigur.
 *
 * Server und Client müssen dieselbe Figur in den Kern setzen — sonst rechnet
 * die Vorhersage mit einem anderen Tempo als die Autorität, und die Figur
 * zuckt bei jedem Snapshot. Deshalb steht das hier genau einmal.
 *
 * Der weite Kegel bei kurzer Reichweite ist die zentrale Kampfentscheidung des
 * Projekts: ein Schlag trifft alles davor, nicht ein ausgewähltes Ziel.
 */
/**
 * Angriffsprofil einer Figur — aus Grundwerten und angelegter Waffe.
 *
 * Eine Stelle, drei Nutzer: der Server setzt es im Kern, der Client sagt
 * damit voraus, und der Renderer wählt danach die Waffe in der Hand. Läge es
 * an drei Stellen, würde die Vorhersage bei jedem Waffenwechsel driften.
 */
export interface AttackProfile {
  /** 0 = Nahkampf im Kegel, 1 = Fernkampf auf ein Ziel. */
  style: number;
  range: number;
  arc: number;
  cooldownSec: number;
  windupSec: number;
  /** Was die Figur in der Hand hält. */
  rig: 'sword' | 'club' | 'staff' | 'bow' | 'none';
}

export function attackProfileFor(weapon: ItemDef | undefined): AttackProfile {
  return {
    style: weapon?.attackStyle === 'ranged' ? 1 : 0,
    range: weapon?.attackRange ?? PLAYER_PROFILE.attackRange,
    arc: weapon?.attackArc ?? PLAYER_PROFILE.attackArc,
    cooldownSec: weapon?.attackCooldownSec ?? PLAYER_PROFILE.attackCooldownSec,
    windupSec: weapon?.attackWindupSec ?? PLAYER_PROFILE.attackWindupSec,
    // Ohne Waffe schlägt man mit der Faust — und hält nichts.
    rig: weapon?.weaponRig ?? 'none',
  };
}

export const PLAYER_PROFILE = {
  attackRange: 3.0,
  attackArc: Math.PI * 0.85,
  attackCooldownSec: 0.62,
  attackWindupSec: 0.15,
  radius: 0.45,
  height: 1.8,
} as const;
