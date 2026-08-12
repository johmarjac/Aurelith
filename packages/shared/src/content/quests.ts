/**
 * Aufträge.
 *
 * Wie alles unter `content/` eine Datentabelle, keine Klassenhierarchie. Ein
 * Auftrag ist eine Liste von Zielen und eine Liste von Belohnungen; was daraus
 * folgt, entscheidet der Server, und wie es aussieht, entscheidet der Client.
 *
 * Die Texte stehen hier mit drin. Das spart das halbe Protokoll: der Client hat
 * dieselbe Tabelle wie der Server, also muss über die Leitung nur *welcher*
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

const questList: QuestDef[] = [
  {
    id: 'q_irrlichter',
    name: 'Licht im Moor',
    levelReq: 1,
    giver: 'npc_guide',
    objectives: [{ kind: 'kill', target: 'mote', count: 5, text: 'Irrlichter vertreiben' }],
    reward: { exp: 60, gold: 30, items: [{ item: 'potion_hp_small', count: 2 }] },
    summary: 'Auf der Wiese vor dem Dorf treiben Irrlichter. Fünf davon reichen fürs Erste.',
    textOffer:
      'Die Irrlichter auf der Wiese sind harmlos, solange man sie in Ruhe lässt — und sie ' +
      'lassen einen nicht in Ruhe. Vertreib fünf davon, dann reden wir weiter.',
    textProgress: 'Fünf, sagte ich. Die Wiese ist gleich hinter dem Brunnen.',
    textDone: 'Gut gemacht. Nimm die Tränke, du wirst sie brauchen.',
  },
  {
    id: 'q_haendlerin',
    name: 'Erst zur Händlerin',
    levelReq: 1,
    giver: 'npc_guide',
    turnIn: 'npc_merchant',
    requires: 'q_irrlichter',
    objectives: [{ kind: 'talk', target: 'npc_merchant', count: 1, text: 'Mit Iselda sprechen' }],
    reward: { exp: 30, gold: 20, items: [] },
    summary: 'Aurel schickt dich zu Iselda, der Händlerin am Brunnenplatz.',
    textOffer:
      'Bevor du weiterziehst: geh zu Iselda. Sie handelt am Brunnen und weiß mehr über die ' +
      'Gegend als ich.',
    textProgress: 'Iselda steht am Brunnen, westlich vom Wegweiser.',
    textDone: 'Aurel schickt dich? Dann bist du wenigstens vorgewarnt. Sieh dich um.',
  },
  {
    id: 'q_essenzen',
    name: 'Kühles Leuchten',
    levelReq: 2,
    giver: 'npc_merchant',
    requires: 'q_haendlerin',
    objectives: [
      { kind: 'collect', target: 'mote_essence', count: 4, text: 'Irrlichtessenz sammeln' },
    ],
    reward: { exp: 120, gold: 60, items: [{ item: 'rusty_dagger', count: 1 }] },
    summary: 'Iselda kauft Irrlichtessenz. Vier Stück, dann bekommst du etwas Brauchbares.',
    textOffer:
      'Was von einem Irrlicht übrigbleibt, kann man verkaufen. Bring mir vier Essenzen, ich ' +
      'habe eine Klinge, die dir mehr nützt als deinem Vorbesitzer.',
    textProgress: 'Vier Essenzen. Die Irrlichter lassen sie fallen, wenn sie verlöschen.',
    textDone: 'Da sind sie ja. Der Dolch ist rostig, aber schneller als Holz.',
  },
  {
    id: 'q_welpen',
    name: 'Was in den Gruben haust',
    levelReq: 3,
    giver: 'npc_smith',
    objectives: [{ kind: 'kill', target: 'burrow_pup', count: 6, text: 'Grabwelpen erlegen' }],
    reward: { exp: 260, gold: 120, items: [{ item: 'potion_hp_small', count: 3 }] },
    summary: 'Bregan hat genug von den Grabwelpen nördlich des Dorfes.',
    textOffer:
      'Die Grabwelpen kommen bis an die Koppel. Sechs weniger, und ich schlafe wieder durch.',
    textProgress: 'Sechs. Sie graben nördlich, wo der Boden weich ist.',
    textDone: 'Das war Arbeit. Nimm die Tränke, ich habe sie ohnehin doppelt.',
  },
  {
    id: 'q_keiler',
    name: 'Stahl statt Holz',
    levelReq: 6,
    giver: 'npc_smith',
    requires: 'q_welpen',
    objectives: [{ kind: 'kill', target: 'thistle_boar', count: 4, text: 'Distelkeiler erlegen' }],
    reward: { exp: 700, gold: 320, items: [{ item: 'iron_blade', count: 1 }] },
    summary: 'Vier Distelkeiler, dann rückt Bregan die Eisenklinge heraus.',
    textOffer:
      'Du fragst nach Stahl. Gut: vier Distelkeiler oben am Weg zum Tor, und die Eisenklinge ' +
      'gehört dir. Sie liegt fertig unter der Bank.',
    textProgress: 'Vier Keiler. Sie stehen weiter oben, wo die Disteln wachsen.',
    textDone: 'Ein Wort ist ein Wort. Die Klinge ist geschmiedet, nicht gegossen — halt sie trocken.',
  },
];

export const QUESTS: ReadonlyMap<string, QuestDef> = new Map(questList.map((q) => [q.id, q]));

export function getQuest(id: string): QuestDef | undefined {
  return QUESTS.get(id);
}

/** Alle Aufträge, die dieser NPC vergibt. */
export function questsFrom(npcDefId: string): QuestDef[] {
  return questList.filter((q) => q.giver === npcDefId);
}

/** Alle Aufträge, die bei diesem NPC abgegeben werden. */
export function questsTo(npcDefId: string): QuestDef[] {
  return questList.filter((q) => (q.turnIn ?? q.giver) === npcDefId);
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
