/**
 * Aufwertung von Ausrüstung, +0 bis +10.
 *
 * Wie alles unter `content/` eine Tabelle mit ein paar Funktionen darauf —
 * Server und Client lesen dieselbe, sonst zeigt der Laden andere Kosten an,
 * als abgebucht werden.
 *
 * Der Wurf selbst passiert **ausschliesslich auf dem Server**. Was hier steht,
 * ist die Wahrscheinlichkeit, nicht ihre Ziehung: ein Client, der würfeln
 * dürfte, würfelte immer richtig.
 */

import type { ItemDef } from './database.ts';

/** Höchste erreichbare Stufe. */
export const MAX_UPGRADE = 10;

/**
 * Ab hier leuchtet die Waffe.
 *
 * Vier ist kein Zufall: bis dahin ist die Aufwertung fast geschenkt, danach
 * wird sie zur Entscheidung. Wer eine leuchtende Waffe trägt, hat etwas
 * riskiert — und genau das soll man von weitem sehen.
 */
export const GLOW_FROM = 4;

/**
 * Erfolgsaussicht je aktueller Stufe: Feld 0 gilt für +0 auf +1.
 *
 * Der Verlauf ist bewusst gnädiger als bei den Vorbildern. Ein Fehlschlag
 * kostet hier nur Gold, nicht die Waffe — dafür darf er häufiger vorkommen,
 * ohne dass jemand das Spiel schliesst.
 */
const CHANCES = [1, 0.95, 0.9, 0.85, 0.75, 0.65, 0.5, 0.4, 0.3, 0.2];

/** Wie wahrscheinlich der Sprung von `level` auf `level + 1` gelingt. */
export function upgradeChance(level: number): number {
  if (level < 0) return 0;
  if (level >= MAX_UPGRADE) return 0;
  return CHANCES[level] ?? 0;
}

/**
 * Was der Versuch kostet — auch der misslungene.
 *
 * Am Grundwert des Gegenstands, damit eine Eisenklinge mehr kostet als ein
 * Holzschwert, und mit der Stufe steigend. Der Sockel verhindert, dass
 * billiges Zeug für nichts auf +10 steht.
 */
export function upgradeCost(def: ItemDef, level: number): number {
  const basis = Math.max(40, def.value);
  return Math.round(basis * (0.5 + level * 0.85));
}

/**
 * Was die Aufwertung bringt: zusätzlicher Schaden, zusätzliche Verteidigung.
 *
 * Anteilig am Grundwert, aber mit einem Mindestwert je Stufe — sonst brächte
 * ein +10-Holzschwert mit vier Grundschaden ganze fünf Punkte, und die
 * Aufwertung wäre auf niedriger Stufe sinnlos.
 */
export function upgradeBonus(def: ItemDef, level: number): { attackDamage: number; defense: number } {
  const stufe = Math.max(0, Math.min(MAX_UPGRADE, Math.round(level)));
  if (stufe === 0) return { attackDamage: 0, defense: 0 };

  const anteil = 0.13 * stufe;
  return {
    attackDamage: def.attackDamage > 0 ? Math.max(stufe, Math.round(def.attackDamage * anteil)) : 0,
    defense: def.defense > 0 ? Math.max(stufe, Math.round(def.defense * anteil)) : 0,
  };
}

/** Lässt sich dieser Gegenstand überhaupt aufwerten? */
export function isUpgradable(def: ItemDef): boolean {
  return def.kind === 'weapon' || def.kind === 'armor';
}

/** „Eisenklinge +7" — oder ohne Anhang, solange nichts aufgewertet ist. */
export function upgradeName(def: ItemDef, level: number): string {
  return level > 0 ? `${def.name} +${level}` : def.name;
}

/**
 * Wie stark die Aura leuchtet, 0 bis 1.
 *
 * Unter `GLOW_FROM` gar nicht, darüber linear bis +10. Eine Zahl statt einer
 * Fallunterscheidung, damit Renderer und Oberfläche dieselbe Kurve benutzen.
 */
export function glowStrength(level: number): number {
  if (level < GLOW_FROM) return 0;
  const t = (level - GLOW_FROM + 1) / (MAX_UPGRADE - GLOW_FROM + 1);
  return Math.max(0, Math.min(1, t));
}
