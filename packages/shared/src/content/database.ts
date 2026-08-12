/**
 * Spielinhalte: die Formen, nicht die Daten.
 *
 * Die Daten selbst stehen als JSON unter `assets/content/` und werden beim
 * Hochfahren geladen — Server und Client lesen dieselben Dateien. Diese Datei
 * beschreibt nur noch, *wie* ein Gegenstand, ein Monster oder ein NPC aussieht,
 * und hält die Tabellen, in die der Lader sie einträgt.
 *
 * Die Tabellen sind bewusst dieselben Objekte wie vorher: `MOBS`, `NPCS` und
 * `ITEMS` bleiben Maps, die man synchron befragt. Alles, was sie benutzt,
 * musste dadurch nicht angefasst werden — nur der Zeitpunkt zählt jetzt, und
 * dafür gibt es `contentLoaded()`.
 *
 * `model` verweist immer auf einen Schlüssel der ModelRegistry des Clients.
 * Heute steht dahinter ein prozedural gebautes Modell, morgen ein glTF —
 * die Definition hier bleibt unverändert.
 */

export interface MobDef {
  id: string;
  name: string;
  level: number;
  maxHp: number;
  attackDamage: number;
  defense: number;
  moveSpeed: number;
  aggressive: boolean;
  aggroRange: number;
  leashRange: number;
  attackRange: number;
  attackArc: number;
  attackCooldownMs: number;
  /** Vorlaufzeit des Schlags, bevor Schaden entsteht. */
  attackWindupMs: number;
  expReward: number;
  goldReward: number;
  model: string;
  scale: number;
  radius: number;
  /** Höhe für Nameplate und Trefferzahlen. */
  height: number;
  /**
   * Was beim Tod herausfällt.
   *
   * Landet ohne Umweg im Beutel des Spielers, der den letzten Schlag gesetzt
   * hat — es gibt keine Beutel am Boden, und es soll auch keine geben: ein
   * Gegenstand, den man erst noch aufheben muss, ist auf dem Telefon eine
   * Zumutung. `chance` ist eine Wahrscheinlichkeit von 0 bis 1.
   */
  drops?: ReadonlyArray<{ item: string; chance: number; min?: number; max?: number }>;
}

const mobs = new Map<string, MobDef>();

/** Alle Monsterprofile. Gefüllt vom Inhaltslader, siehe `contentFormat.ts`. */
export const MOBS: ReadonlyMap<string, MobDef> = mobs;

export function getMob(id: string): MobDef | undefined {
  return mobs.get(id);
}

export type NpcRole = 'guide' | 'smith' | 'merchant' | 'gatekeeper' | 'healer';

export interface NpcDef {
  id: string;
  name: string;
  title: string;
  role: NpcRole;
  model: string;
  scale: number;
  radius: number;
  height: number;
  /** Erste Zeile im Dialogfenster. */
  greeting: string;
  /**
   * Was dieser NPC verkauft.
   *
   * Fehlt die Liste, hat er keinen Laden. Der Bestand ist unbegrenzt: ein
   * Händler, dem die Tränke ausgehen, ist eine Verwaltungsaufgabe ohne
   * Spielwert, solange es nur einen Server und eine Handvoll Spieler gibt.
   */
  shop?: ReadonlyArray<ShopOffer>;
}

/**
 * Ein Posten im Laden.
 *
 * Mehr als eine Kennung, weil dasselbe Stück in verschiedenen Zuständen über
 * den Tresen gehen kann: `upgrade` legt fest, wie aufgewertet die Ware ist,
 * `price` übersteuert den Grundwert. Beides fehlt im Normalfall.
 */
export interface ShopOffer {
  item: string;
  upgrade?: number;
  price?: number;
}

const npcs = new Map<string, NpcDef>();

export const NPCS: ReadonlyMap<string, NpcDef> = npcs;

export function getNpc(id: string): NpcDef | undefined {
  return npcs.get(id);
}

export type ItemKind = 'weapon' | 'armor' | 'consumable' | 'material' | 'quest';
export type EquipSlot = 'mainhand' | 'offhand' | 'chest' | 'legs' | 'head' | 'none';

/**
 * Wie eine Waffe zuschlägt.
 *
 * `melee` trifft alles im Kegel vor der Figur — das Metin2-Gefühl, um das es
 * geht. `ranged` trifft genau ein Ziel innerhalb `attackRange`, ohne Rücksicht
 * auf die Blickrichtung; die Figur dreht sich beim Schuss dorthin.
 */
export type AttackStyle = 'melee' | 'ranged';

export interface ItemDef {
  id: string;
  name: string;
  kind: ItemKind;
  slot: EquipSlot;
  levelReq: number;
  attackDamage: number;
  defense: number;
  /** Aktionswert für Verbrauchsgegenstände, z. B. geheilte Lebenspunkte. */
  effectValue: number;
  stackable: boolean;
  maxStack: number;
  value: number;
  model: string;
  /**
   * Bild für die Inventarkachel, Pfad im Asset-Manifest.
   *
   * Fehlt es, bleibt die Kachel einfarbig — `iconColor` ist der Rückfall und
   * nicht der Regelfall. Erzeugt werden die Bilder mit `npm run icons`.
   */
  icon?: string;
  /** Farbe der Kachel, solange kein Bild da ist. 0xRRGGBB. */
  iconColor: number;
  description: string;

  // --- Nur für Waffen ------------------------------------------------------

  /** Wie zugeschlagen wird. Fehlt es, gilt Nahkampf. */
  attackStyle?: AttackStyle;
  /**
   * Reichweite in Weltnenheiten. Fehlt sie, gilt die des Grundprofils.
   *
   * Bei einer Fernwaffe ist das die Entfernung, bis zu der ein Ziel überhaupt
   * gefunden wird — der Radius, in dem gesucht wird.
   */
  attackRange?: number;
  /** Öffnungswinkel des Nahkampfkegels. Fehlt er, gilt der des Grundprofils. */
  attackArc?: number;
  /** Sekunden zwischen zwei Angriffen. Fehlt es, gilt das Grundprofil. */
  attackCooldownSec?: number;
  /** Vorlaufzeit bis zum Schaden. Fehlt sie, gilt das Grundprofil. */
  attackWindupSec?: number;
  /** Schlüssel der Waffe im Rig — bestimmt, was die Figur in der Hand hält. */
  weaponRig?: 'sword' | 'club' | 'staff' | 'bow';
}

const items = new Map<string, ItemDef>();

export const ITEMS: ReadonlyMap<string, ItemDef> = items;

export function getItem(id: string): ItemDef | undefined {
  return items.get(id);
}

export interface StarterEntry {
  item: string;
  count: number;
  equipped: boolean;
}

const starter: StarterEntry[] = [];

/** Startausrüstung eines frisch erstellten Charakters. */
export const STARTER_INVENTORY: ReadonlyArray<StarterEntry> = starter;

// ---------------------------------------------------------------------------
// Eintragen
// ---------------------------------------------------------------------------
//
// Nur der Inhaltslader ruft das hier auf. Die Setzer stehen trotzdem im
// öffentlichen Teil des Pakets: eine versteckte Hintertür wäre schwerer zu
// finden als eine offene Tür mit einem Schild daran.

function fill<T extends { id: string }>(ziel: Map<string, T>, rows: readonly T[]): void {
  ziel.clear();
  for (const row of rows) ziel.set(row.id, row);
}

export function setItems(rows: readonly ItemDef[]): void {
  fill(items, rows);
}

export function setMobs(rows: readonly MobDef[]): void {
  fill(mobs, rows);
}

export function setNpcs(rows: readonly NpcDef[]): void {
  fill(npcs, rows);
}

export function setStarter(rows: readonly StarterEntry[]): void {
  starter.length = 0;
  starter.push(...rows.map((r) => ({ ...r })));
}

/**
 * Stehen die Tabellen? Einmal am Anfang zu prüfen ist billiger, als an jeder
 * Abfrage einen Sonderfall für „noch nichts geladen" mitzuschleppen.
 */
export function contentLoaded(): boolean {
  return items.size > 0 && mobs.size > 0;
}
