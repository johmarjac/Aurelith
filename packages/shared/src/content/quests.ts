/**
 * Aufträge.
 *
 * Wie alles unter `content/` eine Datentabelle, keine Klassenhierarchie. Ein
 * Auftrag ist eine Liste von Zielen und eine Liste von Belohnungen; was daraus
 * folgt, entscheidet der Server, und wie es aussieht, entscheidet der Client.
 *
 * Die Daten selbst stehen in `assets/content/quests.json` — hier stehen nur
 * die Formen und die Tabelle, in die der Lader sie einträgt.
 *
 * Die Texte gehören mit in die Daten. Das spart das halbe Protokoll: der Client
 * hat dieselbe Tabelle wie der Server, also muss über die Leitung nur *welcher*
 * Auftrag und *wie weit* — nicht, was Aurel dazu sagt.
 */

export type ObjectiveKind = 'kill' | 'collect' | 'talk';

export interface QuestObjective {
  kind: ObjectiveKind;
  /** Mob-, Gegenstands- oder NPC-Kennung, je nach Art. */
  target: string;
  count: number;
  /** Wie das Ziel im Questlog steht. */
  text: string;
}

export interface QuestReward {
  exp: number;
  gold: number;
  items: ReadonlyArray<{ item: string; count: number }>;
  /**
   * Ein Beruf, den dieser Auftrag lehrt — Kennung aus `classes.json`.
   *
   * So und nicht über einen eigenen Auftragstyp: einen Beruf zu lernen ist von
   * aussen dasselbe wie einen Gegenstand zu bekommen — man tut etwas für
   * jemanden und hat danach etwas, das man vorher nicht hatte. Ein eigener Typ
   * hätte dieselbe Annahme, dieselbe Abgabe und dieselben Texte, nur mit einer
   * zweiten Codebahn daneben.
   *
   * Fehlt es, lehrt der Auftrag nichts. Das ist der Normalfall.
   */
  beruf?: string;
}

export interface QuestDef {
  id: string;
  name: string;
  /** Ab welcher Stufe der Auftrag angeboten wird. */
  levelReq: number;
  /** NPC, der ihn vergibt — Kennung aus der NPC-Tabelle. */
  giver: string;
  /** Wo abgegeben wird. Fehlt es, beim Auftraggeber. */
  turnIn?: string;
  /** Auftrag, der vorher abgeschlossen sein muss. */
  requires?: string;
  objectives: ReadonlyArray<QuestObjective>;
  reward: QuestReward;
  /** Ein Satz fürs Questlog. */
  summary: string;
  /** Was der NPC beim Anbieten sagt. */
  textOffer: string;
  /** Was er sagt, solange es noch nicht erledigt ist. */
  textProgress: string;
  /** Und was bei der Abgabe. */
  textDone: string;
}

const quests = new Map<string, QuestDef>();

/** Alle Aufträge. Gefüllt vom Inhaltslader, siehe `contentFormat.ts`. */
export const QUESTS: ReadonlyMap<string, QuestDef> = quests;

/** Trägt die geladenen Aufträge ein. Nur der Lader ruft das auf. */
export function setQuests(rows: readonly QuestDef[]): void {
  quests.clear();
  for (const row of rows) quests.set(row.id, row);
}

export function getQuest(id: string): QuestDef | undefined {
  return quests.get(id);
}

/** Alle Aufträge, die dieser NPC vergibt. */
export function questsFrom(npcDefId: string): QuestDef[] {
  return [...quests.values()].filter((q) => q.giver === npcDefId);
}

/** Alle Aufträge, die bei diesem NPC abgegeben werden. */
export function questsTo(npcDefId: string): QuestDef[] {
  return [...quests.values()].filter((q) => (q.turnIn ?? q.giver) === npcDefId);
}

/** Wo abgegeben wird — der Auftraggeber, wenn nichts anderes dasteht. */
export function turnInOf(quest: QuestDef): string {
  return quest.turnIn ?? quest.giver;
}

/**
 * Zustand eines Auftrags aus Sicht eines Spielers.
 *
 * Wandert als ein Byte über die Leitung; die Reihenfolge ist Teil des
 * Vertrags und wird nicht umsortiert.
 */
export const QuestStatus = {
  /** Angeboten, aber nicht angenommen. Kommt nie aus der Datenbank. */
  Verfuegbar: 0,
  Aktiv: 1,
  /** Alle Ziele erfüllt, noch nicht abgegeben. */
  Erfuellt: 2,
  Abgeschlossen: 3,
} as const;
export type QuestStatus = (typeof QuestStatus)[keyof typeof QuestStatus];

/** Was der Client mit einem Auftrag tun kann. Auch das ein Byte im Protokoll. */
export const QuestAction = {
  Annehmen: 0,
  Abgeben: 1,
  Aufgeben: 2,
} as const;
export type QuestAction = (typeof QuestAction)[keyof typeof QuestAction];
