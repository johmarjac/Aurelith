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
/**
 * Wo ein Gegenstand getragen wird.
 *
 * `ring` ist einer und nicht zwei, `earring` ebenso: wie viele gleichzeitig
 * sitzen dürfen, sagt `slotCapacity` in `equipment.ts`. Ein Ring, der sich für
 * eine Hand entscheiden müsste, wäre eine Angabe, die niemand sinnvoll
 * ausfüllen kann.
 */
export type EquipSlot =
  | 'mainhand'
  | 'offhand'
  | 'head'
  | 'chest'
  | 'legs'
  | 'feet'
  | 'hands'
  | 'cloak'
  | 'glasses'
  | 'necklace'
  | 'earring'
  | 'ring'
  | 'none';

/**
 * Wie eine Waffe zuschlägt.
 *
 * Getroffen wird in beiden Fällen genau das anvisierte Ziel. Unterschieden
 * werden sie durch die Reichweite — und dadurch, dass ein `ranged`-Treffer als
 * solcher gemeldet wird, damit ein Pfeil zu sehen ist.
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
  /**
   * Zuschlag auf Lebens- und Manapunkte.
   *
   * Erst damit haben Ringe und Halskette etwas zu geben. Sie sind an der
   * Figur nicht zu sehen — ein Reif von zwei Zentimetern ist auf einem Modell
   * aus Kästen nichts —, also muss sich das Anlegen in den Zahlen zeigen,
   * sonst zeigt es sich nirgends.
   *
   * Beides wirkt über `setPlayerStats` und braucht keinen neuen wasm-Bau: der
   * Kern nimmt Höchstwerte ohnehin von aussen entgegen.
   */
  maxHp: number;
  maxMp: number;
  /** Zuschlag auf die Aussicht auf kritische Treffer, als Anteil (0,03 = 3 %). */
  critChance: number;
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
  /**
   * Wie das Stück an der Figur aussieht — ein Stilschlüssel, kein Modell.
   *
   * `leder`, `eisen`, … Der Renderer macht daraus Farben und Formen für den
   * jeweiligen Platz: derselbe Stil sieht an der Brust anders aus als am
   * Fuß. Nur so kommt ein Satz mit vier Teilen mit einem Wort aus, statt mit
   * vier Modellen, die zueinander passen müssen.
   */
  armorStyle?: string;
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

/**
 * Ein Rüstungssatz: Teile, die zusammengehören.
 *
 * **Die Zugehörigkeit steht nur hier.** Ein Feld `setId` am Gegenstand wäre
 * dieselbe Auskunft ein zweites Mal — und zwei Wahrheiten über eine Sache
 * laufen auseinander, sobald jemand eine davon pflegt. Wer wissen will, zu
 * welchem Satz ein Stück gehört, fragt `setOfItem`; die Umkehrtabelle dafür
 * baut `setArmorSets` aus `pieces`.
 *
 * `bonus` ist in derselben Sprache geschrieben wie ein Gegenstand selbst, weil
 * der Server ihn an derselben Stelle aufsummiert: `statsFor` addiert erst die
 * Teile und dann den Satz, ohne einen zweiten Rechenweg.
 */
export interface ArmorSetDef {
  id: string;
  name: string;
  /** Die Kennungen der Stücke. Vollständig getragen gilt der Satz als aktiv. */
  pieces: readonly string[];
  bonus: {
    attackDamage: number;
    defense: number;
    maxHp: number;
    maxMp: number;
    critChance: number;
  };
}

const armorSets = new Map<string, ArmorSetDef>();
const setOfItemId = new Map<string, ArmorSetDef>();

/** Alle Rüstungssätze. Gefüllt vom Inhaltslader. */
export const ARMOR_SETS: ReadonlyMap<string, ArmorSetDef> = armorSets;

export function getArmorSet(id: string): ArmorSetDef | undefined {
  return armorSets.get(id);
}

/** Zu welchem Satz gehört dieses Stück? Nichts, wenn es zu keinem gehört. */
export function setOfItem(itemId: string): ArmorSetDef | undefined {
  return setOfItemId.get(itemId);
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

export function setArmorSets(rows: readonly ArmorSetDef[]): void {
  fill(armorSets, rows);
  setOfItemId.clear();
  for (const satz of rows) {
    for (const teil of satz.pieces) setOfItemId.set(teil, satz);
  }
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
