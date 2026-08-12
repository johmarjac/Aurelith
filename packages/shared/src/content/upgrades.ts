/**
 * Aufwertung von Ausrüstung, +0 bis +10.
 *
 * Hier stehen die Regeln, die Zahlen stehen in `assets/content/tuning.json`:
 * Höchststufe, Erfolgsaussichten, Kosten, Bonus, ab wann es leuchtet. Server
 * und Client lesen dieselben — sonst zeigt der Laden andere Kosten an, als
 * abgebucht werden.
 *
 * Der Wurf selbst passiert **ausschliesslich auf dem Server**. Was hier steht,
 * ist die Wahrscheinlichkeit, nicht ihre Ziehung: ein Client, der würfeln
 * dürfte, würfelte immer richtig.
 */

import type { ItemDef } from './database.ts';
import { tuning } from './tuning.ts';

/** Höchste erreichbare Stufe. */
export function maxUpgrade(): number {
  return tuning().upgrades.max;
}

/**
 * Ab hier leuchtet die Waffe.
 *
 * Vier ist kein Zufall: bis dahin ist die Aufwertung fast geschenkt, danach
 * wird sie zur Entscheidung. Wer eine leuchtende Waffe trägt, hat etwas
 * riskiert — und genau das soll man von weitem sehen.
 */
export function glowFrom(): number {
  return tuning().upgrades.glowFrom;
}

/** Wie wahrscheinlich der Sprung von `level` auf `level + 1` gelingt. */
export function upgradeChance(level: number): number {
  const u = tuning().upgrades;
  if (level < 0 || level >= u.max) return 0;
  return u.chances[level] ?? 0;
}

/**
 * Was der Versuch kostet — auch der misslungene.
 *
 * Am Grundwert des Gegenstands, damit eine Eisenklinge mehr kostet als ein
 * Holzschwert, und mit der Stufe steigend. Der Sockel verhindert, dass
 * billiges Zeug für nichts auf +10 steht.
 */
export function upgradeCost(def: ItemDef, level: number): number {
  const u = tuning().upgrades;
  const basis = Math.max(u.costMinValue, def.value);
  return Math.round(basis * (u.costBase + level * u.costPerLevel));
}

/**
 * Was die Aufwertung bringt: zusätzlicher Schaden, zusätzliche Verteidigung.
 *
 * Anteilig am Grundwert, aber mit einem Mindestwert je Stufe — sonst brächte
 * ein +10-Holzschwert mit vier Grundschaden ganze fünf Punkte, und die
 * Aufwertung wäre auf niedriger Stufe sinnlos.
 */
export function upgradeBonus(def: ItemDef, level: number): { attackDamage: number; defense: number } {
  const u = tuning().upgrades;
  const stufe = Math.max(0, Math.min(u.max, Math.round(level)));
  if (stufe === 0) return { attackDamage: 0, defense: 0 };

  const anteil = u.bonusPerLevel * stufe;
  return {
    attackDamage: def.attackDamage > 0 ? Math.max(stufe, Math.round(def.attackDamage * anteil)) : 0,
    defense: def.defense > 0 ? Math.max(stufe, Math.round(def.defense * anteil)) : 0,
  };
}

/**
 * Was ein Händler für ein Stück zahlt.
 *
 * Ein Anteil des Grundwerts, und Aufgewertetes bringt mehr — was hineingesteckt
 * wurde, ist nicht weg. Server und Oberfläche rechnen mit dieser einen
 * Funktion: stünde sie zweimal da, zeigte der Laden andere Preise an, als
 * gutgeschrieben werden.
 */
export function sellPrice(def: ItemDef, upgrade = 0): number {
  const t = tuning();
  const grund = Math.max(1, Math.floor(def.value * t.economy.sellFactor));
  return Math.round(grund * (1 + Math.max(0, upgrade) * t.upgrades.sellBonusPerLevel));
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
 * Unter der Leuchtschwelle gar nicht, ab dort auf einen Schlag deutlich
 * sichtbar und von da an linear bis zur Höchststufe. Der Sockel ist der Punkt:
 * die erste Fassung fing bei einem Siebtel an, und ein Leuchten, das man
 * suchen muss, ist keine Belohnung.
 *
 * Eine Zahl statt einer Fallunterscheidung, damit Renderer und Oberfläche
 * dieselbe Kurve benutzen.
 */
export function glowStrength(level: number): number {
  const u = tuning().upgrades;
  if (level < u.glowFrom) return 0;
  const spanne = Math.max(1, u.max - u.glowFrom);
  const t = (level - u.glowFrom) / spanne;
  return Math.max(0, Math.min(1, u.glowBase + (1 - u.glowBase) * t));
}
