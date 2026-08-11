/**
 * Spielinhalte. Bewusst als Datentabellen und nicht als Klassen — sie sollen
 * sich später ohne Codeänderung aus der Datenbank oder aus gelieferten
 * JSON-Dateien speisen lassen.
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
}

const mobList: MobDef[] = [
  {
    id: 'mote',
    name: 'Irrlicht',
    level: 1,
    maxHp: 32,
    attackDamage: 4,
    defense: 0,
    moveSpeed: 3.2,
    aggressive: false,
    aggroRange: 9,
    leashRange: 40,
    attackRange: 1.8,
    attackArc: Math.PI,
    attackCooldownMs: 1600,
    attackWindupMs: 320,
    expReward: 12,
    goldReward: 3,
    model: 'mob_mote',
    scale: 1,
    radius: 0.55,
    height: 1.4,
  },
  {
    id: 'burrow_pup',
    name: 'Grabwelpe',
    level: 3,
    maxHp: 68,
    attackDamage: 8,
    defense: 2,
    moveSpeed: 4.4,
    aggressive: true,
    aggroRange: 13,
    leashRange: 48,
    attackRange: 2.0,
    attackArc: Math.PI * 0.7,
    attackCooldownMs: 1400,
    attackWindupMs: 280,
    expReward: 28,
    goldReward: 7,
    model: 'mob_pup',
    scale: 1,
    radius: 0.7,
    height: 1.2,
  },
  {
    id: 'thistle_boar',
    name: 'Distelkeiler',
    level: 6,
    maxHp: 145,
    attackDamage: 15,
    defense: 5,
    moveSpeed: 4.8,
    aggressive: true,
    aggroRange: 15,
    leashRange: 55,
    attackRange: 2.4,
    attackArc: Math.PI * 0.6,
    attackCooldownMs: 1700,
    attackWindupMs: 420,
    expReward: 74,
    goldReward: 18,
    model: 'mob_boar',
    scale: 1.15,
    radius: 0.95,
    height: 1.5,
  },
  {
    id: 'bandit_scout',
    name: 'Banditenspäher',
    level: 9,
    maxHp: 220,
    attackDamage: 22,
    defense: 9,
    moveSpeed: 5.2,
    aggressive: true,
    aggroRange: 17,
    leashRange: 60,
    attackRange: 2.2,
    attackArc: Math.PI * 0.7,
    attackCooldownMs: 1300,
    attackWindupMs: 260,
    expReward: 140,
    goldReward: 42,
    model: 'mob_bandit',
    scale: 1,
    radius: 0.6,
    height: 1.9,
  },
  {
    id: 'cave_crawler',
    name: 'Höhlenkriecher',
    level: 13,
    maxHp: 340,
    attackDamage: 31,
    defense: 14,
    moveSpeed: 4.2,
    aggressive: true,
    aggroRange: 14,
    leashRange: 44,
    attackRange: 2.6,
    attackArc: Math.PI * 0.8,
    attackCooldownMs: 1500,
    attackWindupMs: 380,
    expReward: 260,
    goldReward: 78,
    model: 'mob_crawler',
    scale: 1.1,
    radius: 0.9,
    height: 1.3,
  },
  {
    id: 'dungeon_warden',
    name: 'Gruftwärter',
    level: 18,
    maxHp: 1600,
    attackDamage: 58,
    defense: 24,
    moveSpeed: 3.8,
    aggressive: true,
    aggroRange: 22,
    leashRange: 70,
    attackRange: 3.6,
    attackArc: Math.PI * 1.1,
    attackCooldownMs: 2200,
    attackWindupMs: 620,
    expReward: 2400,
    goldReward: 900,
    model: 'mob_warden',
    scale: 1.9,
    radius: 1.8,
    height: 3.4,
  },
];

export const MOBS: ReadonlyMap<string, MobDef> = new Map(mobList.map((m) => [m.id, m]));

export function getMob(id: string): MobDef | undefined {
  return MOBS.get(id);
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
}

const npcList: NpcDef[] = [
  {
    id: 'npc_guide',
    name: 'Aurel',
    title: 'Wegweiser',
    role: 'guide',
    model: 'npc_guide',
    scale: 1,
    radius: 0.5,
    height: 1.85,
    greeting:
      'Willkommen in Lichtmoor. Nimm das Holzschwert und übe an den Irrlichtern auf der Wiese.',
  },
  {
    id: 'npc_smith',
    name: 'Bregan',
    title: 'Waffenschmied',
    role: 'smith',
    model: 'npc_smith',
    scale: 1.05,
    radius: 0.55,
    height: 1.9,
    greeting: 'Holzschwerter halten nicht ewig. Bring mir Erz, dann reden wir über Stahl.',
  },
  {
    id: 'npc_merchant',
    name: 'Iselda',
    title: 'Händlerin',
    role: 'merchant',
    model: 'npc_merchant',
    scale: 0.95,
    radius: 0.5,
    height: 1.72,
    greeting: 'Tränke, Bandagen, Reiseproviant. Alles ehrlich gehandelt.',
  },
  {
    id: 'npc_gatekeeper',
    name: 'Torwart Halvar',
    title: 'Torwächter',
    role: 'gatekeeper',
    model: 'npc_gatekeeper',
    scale: 1.1,
    radius: 0.6,
    height: 2.0,
    greeting: 'Hinter dem Tor wird es ernst. Komm nicht unvorbereitet zurück.',
  },
];

export const NPCS: ReadonlyMap<string, NpcDef> = new Map(npcList.map((n) => [n.id, n]));

export function getNpc(id: string): NpcDef | undefined {
  return NPCS.get(id);
}

export type ItemKind = 'weapon' | 'armor' | 'consumable' | 'material' | 'quest';
export type EquipSlot = 'mainhand' | 'offhand' | 'chest' | 'legs' | 'head' | 'none';

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
  /** Farbe der Platzhalter-Kachel im Inventar, 0xRRGGBB. */
  iconColor: number;
  description: string;
}

const itemList: ItemDef[] = [
  {
    id: 'wooden_sword',
    name: 'Holzschwert',
    kind: 'weapon',
    slot: 'mainhand',
    levelReq: 1,
    attackDamage: 4,
    defense: 0,
    effectValue: 0,
    stackable: false,
    maxStack: 1,
    value: 10,
    model: 'weapon_wooden_sword',
    iconColor: 0xa9743f,
    description: 'Abgegriffenes Übungsschwert. Jeder fängt damit an.',
  },
  {
    id: 'rusty_dagger',
    name: 'Rostiger Dolch',
    kind: 'weapon',
    slot: 'mainhand',
    levelReq: 3,
    attackDamage: 7,
    defense: 0,
    effectValue: 0,
    stackable: false,
    maxStack: 1,
    value: 45,
    model: 'weapon_dagger',
    iconColor: 0x8c7a5e,
    description: 'Schnell, kurz, und schon bessere Tage gesehen.',
  },
  {
    id: 'iron_blade',
    name: 'Eisenklinge',
    kind: 'weapon',
    slot: 'mainhand',
    levelReq: 8,
    attackDamage: 16,
    defense: 0,
    effectValue: 0,
    stackable: false,
    maxStack: 1,
    value: 320,
    model: 'weapon_iron_blade',
    iconColor: 0xb8c0c8,
    description: 'Ordentlich geschmiedet, ordentlich schwer.',
  },
  {
    id: 'training_vest',
    name: 'Übungsweste',
    kind: 'armor',
    slot: 'chest',
    levelReq: 1,
    attackDamage: 0,
    defense: 3,
    effectValue: 0,
    stackable: false,
    maxStack: 1,
    value: 15,
    model: 'armor_vest',
    iconColor: 0x6f7f5a,
    description: 'Gesteppter Stoff. Hält Kratzer ab, mehr nicht.',
  },
  {
    id: 'potion_hp_small',
    name: 'Kleiner Heiltrank',
    kind: 'consumable',
    slot: 'none',
    levelReq: 1,
    attackDamage: 0,
    defense: 0,
    effectValue: 60,
    stackable: true,
    maxStack: 99,
    value: 25,
    model: 'item_potion',
    iconColor: 0xc4433f,
    description: 'Stellt 60 Lebenspunkte wieder her.',
  },
  {
    id: 'mote_essence',
    name: 'Irrlichtessenz',
    kind: 'material',
    slot: 'none',
    levelReq: 1,
    attackDamage: 0,
    defense: 0,
    effectValue: 0,
    stackable: true,
    maxStack: 999,
    value: 6,
    model: 'item_essence',
    iconColor: 0x7fd8e8,
    description: 'Kühles Leuchten, das nach dem Verlöschen zurückbleibt.',
  },
];

export const ITEMS: ReadonlyMap<string, ItemDef> = new Map(itemList.map((i) => [i.id, i]));

export function getItem(id: string): ItemDef | undefined {
  return ITEMS.get(id);
}

/** Startausrüstung eines frisch erstellten Charakters. */
export const STARTER_INVENTORY: ReadonlyArray<{ item: string; count: number; equipped: boolean }> = [
  { item: 'wooden_sword', count: 1, equipped: true },
  { item: 'training_vest', count: 1, equipped: true },
  { item: 'potion_hp_small', count: 3, equipped: false },
];
