/**
 * Einlesen der Inhaltstabellen aus JSON.
 *
 * Gegenstände, Monster, NPCs und Aufträge stehen als Daten unter
 * `assets/content/` und nicht mehr im Quelltext. Server und Client laden
 * dieselben Dateien beim Hochfahren; wer etwas ändern will, ändert eine
 * JSON-Datei und startet neu — kein Bauen, kein Veröffentlichen.
 *
 * **Der Preis dafür ist die Typprüfung.** Solange die Tabellen TypeScript
 * waren, hat der Übersetzer jeden Tippfehler gefunden: ein falsches Feld, eine
 * fehlende Zahl, eine Kennung, die es nicht gibt. Von JSON weiss er nichts.
 * Genau deshalb steht hier ein Parser, der jedes Feld einzeln prüft und im
 * Fehlerfall sagt, *wo* — und deshalb prüft `checkReferences` zusätzlich, ob
 * alle Verweise auflösbar sind. Was der Übersetzer nicht mehr tut, muss das
 * Laden tun.
 *
 * Die Formen sind bewusst genau die der Schnittstellen: was hier
 * herauskommt, ist ein `ItemDef` und keine lose Abbildung davon.
 */

import {
  setArmorSets,
  setItems,
  setMobs,
  setNpcs,
  setStarter,
  type ArmorSetDef,
  type ItemDef,
  type ItemKind,
  type EquipSlot,
  type AttackStyle,
  type MobDef,
  type NpcDef,
  type NpcRole,
  type ShopOffer,
  type StarterEntry,
} from './database.ts';
import {
  setQuests,
  type ObjectiveKind,
  type QuestDef,
  type QuestReward,
} from './quests.ts';
import {
  setClasses,
  setSkills,
  type ClassDef,
  type SkillArt,
  type SkillDef,
} from './classes.ts';
import { setTuning, type Tuning } from './tuning.ts';

export class ContentFormatError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} (bei ${path})`);
    this.name = 'ContentFormatError';
  }
}

// ---------------------------------------------------------------------------
// Kleine Leser
// ---------------------------------------------------------------------------

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContentFormatError('Objekt erwartet', path);
  }
  return value as Record<string, unknown>;
}

function str(o: Record<string, unknown>, key: string, path: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v === '') {
    throw new ContentFormatError(`Feld "${key}" muss ein nichtleerer Text sein`, path);
  }
  return v;
}

function optStr(o: Record<string, unknown>, key: string, fallback: string): string {
  const v = o[key];
  return typeof v === 'string' ? v : fallback;
}

function num(o: Record<string, unknown>, key: string, path: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ContentFormatError(`Feld "${key}" muss eine Zahl sein`, path);
  }
  return v;
}

function optNum(o: Record<string, unknown>, key: string, fallback: number, path: string): number {
  if (o[key] === undefined) return fallback;
  return num(o, key, path);
}

function optBool(o: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = o[key];
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * Farbe als Zahl — geschrieben als `"#a9743f"`, `"0xa9743f"` oder als Zahl.
 *
 * JSON kennt keine Hexadezimalliterale, und `11105343` liest niemand. Beide
 * Formen sind erlaubt, damit von Hand gepflegte Dateien lesbar bleiben und
 * maschinell erzeugte nicht umgerechnet werden müssen.
 */
function color(o: Record<string, unknown>, key: string, fallback: number, path: string): number {
  const v = o[key];
  if (v === undefined) return fallback;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string') {
    const text = v.trim().replace(/^#/, '').replace(/^0x/i, '');
    if (/^[0-9a-f]{6}$/i.test(text)) return Number.parseInt(text, 16);
  }
  throw new ContentFormatError(`Feld "${key}" ist keine Farbe (#rrggbb oder Zahl)`, path);
}

function list(o: Record<string, unknown>, key: string, path: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new ContentFormatError(`Feld "${key}" muss eine Liste sein`, path);
  return v;
}

/** Wert aus einer festen Auswahl. Alles andere ist ein Fehler, kein Standard. */
function oneOf<T extends string>(
  o: Record<string, unknown>,
  key: string,
  erlaubt: readonly T[],
  path: string,
): T {
  const v = o[key];
  if (typeof v === 'string' && (erlaubt as readonly string[]).includes(v)) return v as T;
  throw new ContentFormatError(
    `Feld "${key}" muss eines von: ${erlaubt.join(', ')} sein`,
    path,
  );
}

/**
 * Kopf einer Inhaltsdatei prüfen und die Liste darin herausgeben.
 *
 * Der Kopf existiert aus demselben Grund wie beim Kartenformat: eine Datei,
 * die sich selbst benennt, lässt sich nicht mit einer anderen verwechseln.
 */
function body(raw: unknown, key: string, source: string): { doc: Record<string, unknown>; rows: unknown[] } {
  const doc = obj(raw, source);
  const format = optStr(doc, 'format', '');
  if (format !== 'aurelith.content') {
    throw new ContentFormatError(`Format "${format}" ist keine Inhaltsdatei`, source);
  }
  return { doc, rows: list(doc, key, source) };
}

// ---------------------------------------------------------------------------
// Gegenstände
// ---------------------------------------------------------------------------

const ITEM_KINDS = ['weapon', 'armor', 'consumable', 'material', 'quest'] as const;
const SLOT_NAMEN = [
  'mainhand',
  'offhand',
  'head',
  'chest',
  'legs',
  'feet',
  'hands',
  'cloak',
  'glasses',
  'necklace',
  'earring',
  'ring',
  'none',
] as const;
const ATTACK_STYLES = ['melee', 'ranged'] as const;
const WEAPON_RIGS = ['sword', 'club', 'staff', 'bow'] as const;

export function parseItems(raw: unknown, source = 'items.json'): {
  items: ItemDef[];
  starter: StarterEntry[];
  sets: ArmorSetDef[];
} {
  const { doc, rows } = body(raw, 'items', source);

  const items = rows.map((row, i) => {
    const path = `${source}.items[${i}]`;
    const o = obj(row, path);

    const def: ItemDef = {
      id: str(o, 'id', path),
      name: str(o, 'name', path),
      kind: oneOf<ItemKind>(o, 'kind', ITEM_KINDS, path),
      slot: oneOf<EquipSlot>(o, 'slot', SLOT_NAMEN, path),
      levelReq: optNum(o, 'levelReq', 1, path),
      attackDamage: optNum(o, 'attackDamage', 0, path),
      defense: optNum(o, 'defense', 0, path),
      critChance: optNum(o, 'critChance', 0, path),
      maxHp: optNum(o, 'maxHp', 0, path),
      maxMp: optNum(o, 'maxMp', 0, path),
      effectValue: optNum(o, 'effectValue', 0, path),
      stackable: optBool(o, 'stackable', false),
      maxStack: optNum(o, 'maxStack', 1, path),
      value: optNum(o, 'value', 1, path),
      model: optStr(o, 'model', ''),
      iconColor: color(o, 'iconColor', 0x888888, path),
      icon: optStr(o, 'icon', ''),
      description: optStr(o, 'description', ''),
    };

    // Waffenfelder nur setzen, wenn sie dastehen: `undefined` heisst an jeder
    // dieser Stellen „nimm das Grundprofil", und ein eingesetzter Standardwert
    // wäre etwas anderes.
    if (o.attackStyle !== undefined) def.attackStyle = oneOf<AttackStyle>(o, 'attackStyle', ATTACK_STYLES, path);
    if (o.attackRange !== undefined) def.attackRange = num(o, 'attackRange', path);
    if (o.attackCooldownSec !== undefined) def.attackCooldownSec = num(o, 'attackCooldownSec', path);
    if (o.attackWindupSec !== undefined) def.attackWindupSec = num(o, 'attackWindupSec', path);
    if (o.armorStyle !== undefined) def.armorStyle = str(o, 'armorStyle', path);
    if (o.weaponRig !== undefined) {
      def.weaponRig = oneOf<'sword' | 'club' | 'staff' | 'bow'>(o, 'weaponRig', WEAPON_RIGS, path);
    }

    if (def.stackable && def.maxStack < 2) {
      throw new ContentFormatError('stapelbar, aber maxStack unter 2', path);
    }
    return def;
  });

  const starter = (doc.starter === undefined ? [] : list(doc, 'starter', source)).map((row, i) => {
    const path = `${source}.starter[${i}]`;
    const o = obj(row, path);
    return {
      item: str(o, 'item', path),
      count: optNum(o, 'count', 1, path),
      equipped: optBool(o, 'equipped', false),
    };
  });

  // Sätze stehen in derselben Datei wie die Gegenstände, weil sie nichts
  // anderes sind als eine Aussage über sie. Eine eigene Datei hätte drei
  // Ladewege mehr bedeutet — Server, Client, Manifest — für eine Handvoll
  // Zeilen.
  const sets = (doc.sets === undefined ? [] : list(doc, 'sets', source)).map((row, i) => {
    const path = `${source}.sets[${i}]`;
    const o = obj(row, path);
    const bonus = o.bonus === undefined ? {} : obj(o.bonus, `${path}.bonus`);

    const teile = list(o, 'pieces', path).map((teil, j) => {
      if (typeof teil !== 'string') {
        throw new ContentFormatError('pieces enthält etwas, das keine Kennung ist', `${path}.pieces[${j}]`);
      }
      return teil;
    });
    if (teile.length < 2) {
      throw new ContentFormatError('ein Satz aus weniger als zwei Teilen ist kein Satz', path);
    }

    const def: ArmorSetDef = {
      id: str(o, 'id', path),
      name: str(o, 'name', path),
      pieces: teile,
      bonus: {
        attackDamage: optNum(bonus, 'attackDamage', 0, `${path}.bonus`),
        defense: optNum(bonus, 'defense', 0, `${path}.bonus`),
        maxHp: optNum(bonus, 'maxHp', 0, `${path}.bonus`),
        maxMp: optNum(bonus, 'maxMp', 0, `${path}.bonus`),
        critChance: optNum(bonus, 'critChance', 0, `${path}.bonus`),
      },
    };
    return def;
  });

  return { items, starter, sets };
}

// ---------------------------------------------------------------------------
// Monster
// ---------------------------------------------------------------------------

export function parseMobs(raw: unknown, source = 'mobs.json'): MobDef[] {
  const { rows } = body(raw, 'mobs', source);

  return rows.map((row, i) => {
    const path = `${source}.mobs[${i}]`;
    const o = obj(row, path);

    const def: MobDef = {
      id: str(o, 'id', path),
      name: str(o, 'name', path),
      level: optNum(o, 'level', 1, path),
      maxHp: num(o, 'maxHp', path),
      attackDamage: optNum(o, 'attackDamage', 1, path),
      defense: optNum(o, 'defense', 0, path),
      moveSpeed: optNum(o, 'moveSpeed', 3.5, path),
      aggressive: optBool(o, 'aggressive', false),
      aggroRange: optNum(o, 'aggroRange', 10, path),
      leashRange: optNum(o, 'leashRange', 40, path),
      attackRange: optNum(o, 'attackRange', 2, path),
      attackCooldownMs: optNum(o, 'attackCooldownMs', 1500, path),
      attackWindupMs: optNum(o, 'attackWindupMs', 300, path),
      expReward: optNum(o, 'expReward', 1, path),
      goldReward: optNum(o, 'goldReward', 0, path),
      model: optStr(o, 'model', 'mob_mote'),
      scale: optNum(o, 'scale', 1, path),
      radius: optNum(o, 'radius', 0.6, path),
      height: optNum(o, 'height', 1.6, path),
    };

    if (o.drops !== undefined) {
      def.drops = list(o, 'drops', path).map((d, j) => {
        const dPath = `${path}.drops[${j}]`;
        const drop = obj(d, dPath);
        const min = optNum(drop, 'min', 1, dPath);
        const max = optNum(drop, 'max', min, dPath);
        if (max < min) throw new ContentFormatError('max kleiner als min', dPath);
        const chance = num(drop, 'chance', dPath);
        if (chance <= 0 || chance > 1) {
          throw new ContentFormatError('chance muss zwischen 0 und 1 liegen', dPath);
        }
        return { item: str(drop, 'item', dPath), chance, min, max };
      });
    }

    return def;
  });
}

// ---------------------------------------------------------------------------
// NPCs
// ---------------------------------------------------------------------------

const NPC_ROLES = ['guide', 'smith', 'merchant', 'gatekeeper', 'healer', 'trainer'] as const;

export function parseNpcs(raw: unknown, source = 'npcs.json'): NpcDef[] {
  const { rows } = body(raw, 'npcs', source);

  return rows.map((row, i) => {
    const path = `${source}.npcs[${i}]`;
    const o = obj(row, path);

    const def: NpcDef = {
      id: str(o, 'id', path),
      name: str(o, 'name', path),
      title: optStr(o, 'title', ''),
      role: oneOf<NpcRole>(o, 'role', NPC_ROLES, path),
      model: optStr(o, 'model', 'npc_guide'),
      scale: optNum(o, 'scale', 1, path),
      radius: optNum(o, 'radius', 0.5, path),
      height: optNum(o, 'height', 1.8, path),
      greeting: optStr(o, 'greeting', ''),
    };

    if (o.shop !== undefined) {
      def.shop = list(o, 'shop', path).map((s, j) => {
        const sPath = `${path}.shop[${j}]`;
        const angebot = obj(s, sPath);
        const out: ShopOffer = { item: str(angebot, 'item', sPath) };
        if (angebot.upgrade !== undefined) out.upgrade = num(angebot, 'upgrade', sPath);
        if (angebot.price !== undefined) out.price = num(angebot, 'price', sPath);
        return out;
      });
    }

    return def;
  });
}

// ---------------------------------------------------------------------------
// Berufe und Fertigkeiten
// ---------------------------------------------------------------------------

const SKILL_ARTEN = ['flaeche', 'ziel', 'selbst'] as const;

export function parseClasses(raw: unknown, source = 'classes.json'): {
  classes: ClassDef[];
  skills: SkillDef[];
} {
  const { doc, rows } = body(raw, 'classes', source);

  const classes = rows.map((row, i) => {
    const path = `${source}.classes[${i}]`;
    const o = obj(row, path);
    return {
      id: str(o, 'id', path),
      name: str(o, 'name', path),
      beschreibung: optStr(o, 'beschreibung', ''),
      glyph: optStr(o, 'glyph', '•'),
      waffe: optStr(o, 'waffe', 'none'),
    };
  });

  const skills = list(doc, 'skills', source).map((row, i) => {
    const path = `${source}.skills[${i}]`;
    const o = obj(row, path);
    return {
      id: str(o, 'id', path),
      name: str(o, 'name', path),
      class: str(o, 'class', path),
      level: optNum(o, 'level', 1, path),
      beschreibung: optStr(o, 'beschreibung', ''),
      glyph: optStr(o, 'glyph', '✳'),
      art: oneOf<SkillArt>(o, 'art', SKILL_ARTEN, path),
      radius: optNum(o, 'radius', 0, path),
      damageFactor: optNum(o, 'damageFactor', 1, path),
      cooldownMs: optNum(o, 'cooldownMs', 1000, path),
      manaCost: optNum(o, 'manaCost', 0, path),
      wirkung: optStr(o, 'wirkung', ''),
    };
  });

  return { classes, skills };
}

// ---------------------------------------------------------------------------
// Aufträge
// ---------------------------------------------------------------------------

const OBJECTIVE_KINDS = ['kill', 'collect', 'talk'] as const;

export function parseQuests(raw: unknown, source = 'quests.json'): QuestDef[] {
  const { rows } = body(raw, 'quests', source);

  return rows.map((row, i) => {
    const path = `${source}.quests[${i}]`;
    const o = obj(row, path);

    const objectives = list(o, 'objectives', path).map((z, j) => {
      const zPath = `${path}.objectives[${j}]`;
      const ziel = obj(z, zPath);
      const count = optNum(ziel, 'count', 1, zPath);
      if (count < 1) throw new ContentFormatError('count muss mindestens 1 sein', zPath);
      return {
        kind: oneOf<ObjectiveKind>(ziel, 'kind', OBJECTIVE_KINDS, zPath),
        target: str(ziel, 'target', zPath),
        count,
        text: optStr(ziel, 'text', ''),
      };
    });

    if (objectives.length === 0) {
      throw new ContentFormatError('Auftrag ohne Ziel', path);
    }

    const rewardRaw = o.reward === undefined ? {} : obj(o.reward, `${path}.reward`);
    const reward: QuestReward = {
      exp: optNum(rewardRaw, 'exp', 0, `${path}.reward`),
      gold: optNum(rewardRaw, 'gold', 0, `${path}.reward`),
      items: (rewardRaw.items === undefined
        ? []
        : list(rewardRaw, 'items', `${path}.reward`)
      ).map((g, j) => {
        const gPath = `${path}.reward.items[${j}]`;
        const gabe = obj(g, gPath);
        return { item: str(gabe, 'item', gPath), count: optNum(gabe, 'count', 1, gPath) };
      }),
    };
    // Nur eintragen, wenn er dasteht: ein leerer Beruf im Lohn hiesse
    // „lehrt beruflos", und das ist etwas anderes als „lehrt nichts".
    if (typeof rewardRaw.beruf === 'string') reward.beruf = rewardRaw.beruf;

    const def: QuestDef = {
      id: str(o, 'id', path),
      name: str(o, 'name', path),
      levelReq: optNum(o, 'levelReq', 1, path),
      giver: str(o, 'giver', path),
      objectives,
      reward,
      summary: optStr(o, 'summary', ''),
      textOffer: optStr(o, 'textOffer', ''),
      textProgress: optStr(o, 'textProgress', ''),
      textDone: optStr(o, 'textDone', ''),
    };
    if (typeof o.turnIn === 'string') def.turnIn = o.turnIn;
    if (typeof o.requires === 'string') def.requires = o.requires;

    return def;
  });
}

// ---------------------------------------------------------------------------
// Stellschrauben
// ---------------------------------------------------------------------------

/**
 * Liest `tuning.json`.
 *
 * **Ohne Vorgabewerte**: jede Zahl muss dastehen. Ein eingesetzter Standard
 * wäre eine zweite Wahrheit über dieselbe Sache, und die schweigende von
 * beiden gewinnt genau dann, wenn jemand sich vertippt. Fehlt etwas, sagt der
 * Fehler, was — das ist in dreissig Sekunden behoben, ein falsch balanciertes
 * Spiel nicht.
 */
export function parseTuning(raw: unknown, source = 'tuning.json'): Tuning {
  const doc = obj(raw, source);
  if (optStr(doc, 'format', '') !== 'aurelith.content') {
    throw new ContentFormatError('Format ist keine Inhaltsdatei', source);
  }

  const abschnitt = (key: string): Record<string, unknown> =>
    obj(doc[key], `${source}.${key}`);

  const p = abschnitt('progression');
  const pPath = `${source}.progression`;
  const sp = abschnitt('player');
  const spPath = `${source}.player`;
  const u = abschnitt('upgrades');
  const uPath = `${source}.upgrades`;
  const e = abschnitt('economy');
  const ePath = `${source}.economy`;
  const w = abschnitt('world');
  const wPath = `${source}.world`;
  const l = abschnitt('loot');
  const lPath = `${source}.loot`;

  const chancen = list(u, 'chances', uPath).map((c, i) => {
    if (typeof c !== 'number' || c < 0 || c > 1) {
      throw new ContentFormatError('Aussicht muss zwischen 0 und 1 liegen', `${uPath}.chances[${i}]`);
    }
    return c;
  });

  const werte: Tuning = {
    progression: {
      maxLevel: num(p, 'maxLevel', pPath),
      expFactor: num(p, 'expFactor', pPath),
      expExponent: num(p, 'expExponent', pPath),
      expLinear: num(p, 'expLinear', pPath),
      baseHp: num(p, 'baseHp', pPath),
      hpPerLevel: num(p, 'hpPerLevel', pPath),
      baseMp: num(p, 'baseMp', pPath),
      mpPerLevel: num(p, 'mpPerLevel', pPath),
      baseAttack: num(p, 'baseAttack', pPath),
      attackPerLevel: num(p, 'attackPerLevel', pPath),
      baseDefense: num(p, 'baseDefense', pPath),
      defensePerLevel: num(p, 'defensePerLevel', pPath),
      moveSpeed: num(p, 'moveSpeed', pPath),
      critChance: num(p, 'critChance', pPath),
      critMultiplier: num(p, 'critMultiplier', pPath),
      expMaxBonus: num(p, 'expMaxBonus', pPath),
      expBonusPerLevel: num(p, 'expBonusPerLevel', pPath),
      expMalusPerLevel: num(p, 'expMalusPerLevel', pPath),
      expFarMalusPerLevel: num(p, 'expFarMalusPerLevel', pPath),
      expFloor: num(p, 'expFloor', pPath),
    },
    player: {
      attackRange: num(sp, 'attackRange', spPath),
      attackCooldownSec: num(sp, 'attackCooldownSec', spPath),
      attackWindupSec: num(sp, 'attackWindupSec', spPath),
      radius: num(sp, 'radius', spPath),
      height: num(sp, 'height', spPath),
    },
    upgrades: {
      max: num(u, 'max', uPath),
      glowFrom: num(u, 'glowFrom', uPath),
      glowBase: num(u, 'glowBase', uPath),
      chances: chancen,
      costMinValue: num(u, 'costMinValue', uPath),
      costBase: num(u, 'costBase', uPath),
      costPerLevel: num(u, 'costPerLevel', uPath),
      bonusPerLevel: num(u, 'bonusPerLevel', uPath),
      sellBonusPerLevel: num(u, 'sellBonusPerLevel', uPath),
    },
    economy: {
      sellFactor: num(e, 'sellFactor', ePath),
      inventorySlots: num(e, 'inventorySlots', ePath),
    },
    world: {
      dayMinutes: num(w, 'dayMinutes', wPath),
      interactRange: num(w, 'interactRange', wPath),
    },
    loot: {
      pickupRange: num(l, 'pickupRange', lPath),
      lifetimeSec: num(l, 'lifetimeSec', lPath),
      reserveSec: num(l, 'reserveSec', lPath),
      scatterRadius: num(l, 'scatterRadius', lPath),
    },
  };

  // Die Aufwertungstabelle muss zur Höchststufe passen: eine Stufe ohne
  // Aussicht liesse sich nie erreichen, und niemand würde merken warum.
  if (werte.upgrades.chances.length < werte.upgrades.max) {
    throw new ContentFormatError(
      `chances hat ${werte.upgrades.chances.length} Einträge, gebraucht werden ${werte.upgrades.max}`,
      uPath,
    );
  }
  if (werte.upgrades.glowFrom > werte.upgrades.max) {
    throw new ContentFormatError('glowFrom liegt über der Höchststufe', uPath);
  }

  return werte;
}

// ---------------------------------------------------------------------------
// Laden
// ---------------------------------------------------------------------------

/** Die vier Dateien, roh wie sie vom Datenträger oder aus dem Netz kommen. */
export interface RawContent {
  items: unknown;
  mobs: unknown;
  npcs: unknown;
  quests: unknown;
  tuning: unknown;
  classes: unknown;
}

/** Was `loadContent` eingelesen hat — nur zur Auskunft. */
export interface ContentSummary {
  items: number;
  mobs: number;
  npcs: number;
  quests: number;
  classes: number;
  skills: number;
}

/**
 * Liest alles ein und trägt es in die Tabellen ein.
 *
 * Muss **vor** allem anderen laufen: der Kern bekommt seine Monsterprofile
 * daraus, der Server seine Startausrüstung, der Client seine Modelle. Wer zu
 * früh in eine leere Tabelle greift, bekommt von `getItem` schlicht nichts —
 * deshalb prüft `contentLoaded()` einmal am Anfang statt später an fünfzig
 * Stellen.
 */
export function loadContent(raw: RawContent): ContentSummary {
  const { items, starter, sets } = parseItems(raw.items);
  const mobs = parseMobs(raw.mobs);
  const npcs = parseNpcs(raw.npcs);
  const quests = parseQuests(raw.quests);
  const werte = parseTuning(raw.tuning);
  const { classes, skills } = parseClasses(raw.classes);

  const probleme = checkReferences({ items, mobs, npcs, quests, starter, sets });
  // Eine Fertigkeit ohne Beruf gehört niemandem: sie stünde in keiner Leiste
  // und fiele erst auf, wenn jemand sie vermisst.
  const berufe = new Set(classes.map((c) => c.id));
  for (const s of skills) {
    if (!berufe.has(s.class)) probleme.push(`skill ${s.id} → class ${s.class}`);
  }
  // Ein Auftrag, der einen Beruf lehrt, den es nicht gibt, ist eine Sackgasse
  // mit Belohnung: er lässt sich abgeben, und danach hat die Figur eine
  // Kennung, zu der keine Fertigkeit passt.
  for (const q of quests) {
    const lehrt = q.reward.beruf;
    if (lehrt !== undefined && !berufe.has(lehrt)) {
      probleme.push(`Auftrag "${q.id}" lehrt unbekannten Beruf "${lehrt}"`);
    }
  }
  if (probleme.length > 0) {
    throw new ContentFormatError(`Verweise gehen ins Leere:\n  - ${probleme.join('\n  - ')}`, 'content');
  }

  setItems(items);
  setArmorSets(sets);
  setMobs(mobs);
  setNpcs(npcs);
  setQuests(quests);
  setStarter(starter);
  setTuning(werte);
  setClasses(classes);
  setSkills(skills);

  return {
    items: items.length,
    mobs: mobs.length,
    npcs: npcs.length,
    quests: quests.length,
    classes: classes.length,
    skills: skills.length,
  };
}

/**
 * Prüft, ob jede Kennung, die irgendwo steht, auch irgendwo definiert ist.
 *
 * Das ist der Ersatz für den Übersetzer. Solange die Tabellen Quelltext waren,
 * fiel ein Tippfehler in `'potion_hp_smal'` beim Bauen auf; in JSON fällt er
 * sonst erst auf, wenn jemand den Auftrag abgibt und keine Belohnung bekommt.
 *
 * Gibt die Probleme als Liste zurück und nicht als Ausnahme: wer eine Datei
 * pflegt, will alle Fehler auf einmal sehen und nicht einen nach dem anderen.
 */
export function checkReferences(content: {
  items: readonly ItemDef[];
  mobs: readonly MobDef[];
  npcs: readonly NpcDef[];
  quests: readonly QuestDef[];
  starter: readonly StarterEntry[];
  sets?: readonly ArmorSetDef[];
}): string[] {
  const probleme: string[] = [];
  const itemIds = new Set(content.items.map((i) => i.id));
  const mobIds = new Set(content.mobs.map((m) => m.id));
  const npcIds = new Set(content.npcs.map((n) => n.id));
  const questIds = new Set(content.quests.map((q) => q.id));

  const doppelt = (was: string, ids: string[], menge: Set<string>): void => {
    if (ids.length !== menge.size) probleme.push(`${was}: doppelte Kennungen`);
  };
  doppelt('Gegenstände', content.items.map((i) => i.id), itemIds);
  doppelt('Monster', content.mobs.map((m) => m.id), mobIds);
  doppelt('NPCs', content.npcs.map((n) => n.id), npcIds);
  doppelt('Aufträge', content.quests.map((q) => q.id), questIds);

  for (const s of content.starter) {
    if (!itemIds.has(s.item)) probleme.push(`Startausrüstung nennt unbekannten Gegenstand "${s.item}"`);
  }

  // Ein Satz ist eine Aussage über Gegenstände: jedes Teil muss es geben, und
  // keines darf in zwei Sätzen stehen — sonst hinge an einem Stück, welcher
  // von beiden gilt, und `setOfItem` müsste raten.
  const teilGehoertZu = new Map<string, string>();
  for (const satz of content.sets ?? []) {
    for (const teil of satz.pieces) {
      if (!itemIds.has(teil)) {
        probleme.push(`Satz "${satz.id}" nennt unbekannten Gegenstand "${teil}"`);
      }
      const anderer = teilGehoertZu.get(teil);
      if (anderer === satz.id) {
        probleme.push(`Satz "${satz.id}" nennt "${teil}" doppelt`);
      } else if (anderer !== undefined) {
        probleme.push(`Gegenstand "${teil}" steht in zwei Sätzen: "${anderer}" und "${satz.id}"`);
      }
      teilGehoertZu.set(teil, satz.id);
    }
  }

  for (const mob of content.mobs) {
    for (const drop of mob.drops ?? []) {
      if (!itemIds.has(drop.item)) {
        probleme.push(`Monster "${mob.id}" lässt unbekannten Gegenstand "${drop.item}" fallen`);
      }
    }
  }

  for (const npc of content.npcs) {
    for (const angebot of npc.shop ?? []) {
      if (!itemIds.has(angebot.item)) {
        probleme.push(`NPC "${npc.id}" verkauft unbekannten Gegenstand "${angebot.item}"`);
      }
    }
  }

  for (const quest of content.quests) {
    if (!npcIds.has(quest.giver)) {
      probleme.push(`Auftrag "${quest.id}" wird von unbekanntem NPC "${quest.giver}" vergeben`);
    }
    if (quest.turnIn && !npcIds.has(quest.turnIn)) {
      probleme.push(`Auftrag "${quest.id}" wird bei unbekanntem NPC "${quest.turnIn}" abgegeben`);
    }
    if (quest.requires && !questIds.has(quest.requires)) {
      probleme.push(`Auftrag "${quest.id}" verlangt unbekannten Auftrag "${quest.requires}"`);
    }
    for (const ziel of quest.objectives) {
      const bekannt =
        ziel.kind === 'kill' ? mobIds.has(ziel.target)
        : ziel.kind === 'collect' ? itemIds.has(ziel.target)
        : npcIds.has(ziel.target);
      if (!bekannt) {
        probleme.push(`Auftrag "${quest.id}": Ziel "${ziel.kind}" nennt unbekanntes "${ziel.target}"`);
      }
    }
    for (const gabe of quest.reward.items) {
      if (!itemIds.has(gabe.item)) {
        probleme.push(`Auftrag "${quest.id}" belohnt mit unbekanntem Gegenstand "${gabe.item}"`);
      }
    }
  }

  return probleme;
}
