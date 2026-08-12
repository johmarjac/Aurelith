/**
 * Stufenaufstieg und Kampfprofil.
 *
 * Die Zahlen dahinter stehen in `assets/content/tuning.json` — hier stehen nur
 * die Formeln, die sie benutzen. Wer am Balancing dreht, ändert die Datei und
 * startet neu.
 *
 * **Die Schadensformel steht bewusst nicht hier.** Sie rechnet im C++-Kern
 * (`packages/core/src/world.cpp`), weil Server und Client dieselbe Simulation
 * fahren müssen. Eine TypeScript-Fassung daneben war eine zweite Wahrheit, die
 * niemand benutzt hat und die beim ersten Balancing-Schritt still veraltet
 * wäre — sie ist deshalb entfernt.
 */

import type { ItemDef } from './database.ts';
import { tuning } from './tuning.ts';

/** Höchste erreichbare Stufe. */
export function maxLevel(): number {
  return tuning().progression.maxLevel;
}

/** Erfahrung, die von Stufe `level` auf `level + 1` nötig ist. */
export function expForLevel(level: number): number {
  const p = tuning().progression;
  if (level >= p.maxLevel) return Number.POSITIVE_INFINITY;
  return Math.floor(p.expFactor * Math.pow(level, p.expExponent) + p.expLinear * level);
}

export interface DerivedStats {
  maxHp: number;
  maxMp: number;
  attackDamage: number;
  defense: number;
  /** Weltnenheiten pro Sekunde. */
  moveSpeed: number;
  /** Aussicht auf einen kritischen Treffer, als Anteil. */
  critChance: number;
  /** Womit der Schaden dabei malgenommen wird. */
  critMultiplier: number;
}

/** Grundwerte allein aus der Stufe, ohne Ausrüstung. */
export function baseStatsForLevel(level: number): DerivedStats {
  const p = tuning().progression;
  const stufen = level - 1;
  return {
    maxHp: p.baseHp + stufen * p.hpPerLevel,
    maxMp: p.baseMp + stufen * p.mpPerLevel,
    attackDamage: p.baseAttack + stufen * p.attackPerLevel,
    defense: p.baseDefense + stufen * p.defensePerLevel,
    moveSpeed: p.moveSpeed,
    critChance: p.critChance,
    critMultiplier: p.critMultiplier,
  };
}

/**
 * Erfahrungsgewinn mit Stufenabstand. Weit unter dem eigenen Level gibt es
 * kaum noch etwas — sonst farmt jeder ewig auf der Anfängerwiese.
 */
export function expGain(baseExp: number, playerLevel: number, mobLevel: number): number {
  const p = tuning().progression;
  const diff = mobLevel - playerLevel;

  let factor: number;
  if (diff >= 0) factor = Math.min(p.expMaxBonus, 1 + diff * p.expBonusPerLevel);
  else if (diff >= -5) factor = 1 + diff * p.expMalusPerLevel;
  else if (diff >= -10) factor = 1 - 5 * p.expMalusPerLevel + (diff + 5) * p.expFarMalusPerLevel;
  else factor = p.expFloor;

  return Math.max(1, Math.floor(baseExp * Math.max(p.expFloor, factor)));
}

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
  const p = playerProfile();
  return {
    style: weapon?.attackStyle === 'ranged' ? 1 : 0,
    range: weapon?.attackRange ?? p.attackRange,
    arc: weapon?.attackArc ?? p.attackArc,
    cooldownSec: weapon?.attackCooldownSec ?? p.attackCooldownSec,
    windupSec: weapon?.attackWindupSec ?? p.attackWindupSec,
    // Ohne Waffe schlägt man mit der Faust — und hält nichts.
    rig: weapon?.weaponRig ?? 'none',
  };
}

/**
 * Kampfprofil der Spielerfigur.
 *
 * Server und Client müssen dieselbe Figur in den Kern setzen — sonst rechnet
 * die Vorhersage mit einem anderen Tempo als die Autorität, und die Figur
 * zuckt bei jedem Snapshot. Deshalb kommt es aus einer Quelle.
 *
 * Der weite Kegel bei kurzer Reichweite ist die zentrale Kampfentscheidung des
 * Projekts: ein Schlag trifft alles davor, nicht ein ausgewähltes Ziel.
 */
export function playerProfile(): {
  attackRange: number;
  attackArc: number;
  attackCooldownSec: number;
  attackWindupSec: number;
  radius: number;
  height: number;
} {
  return tuning().player;
}
