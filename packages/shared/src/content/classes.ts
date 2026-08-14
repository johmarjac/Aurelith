/**
 * Berufe und Fertigkeiten.
 *
 * Ein Beruf ist die Antwort auf „was für eine Figur ist das" — und damit die
 * Antwort darauf, welche Fertigkeiten sie überhaupt bekommen kann. Ein
 * Bogenschütze wirbelt nicht mit einer Klinge, und ein Krieger schiesst keinen
 * Regenpfeil.
 *
 * Die Zuordnung steht an der **Fertigkeit** und nicht am Beruf. Eine Liste von
 * Fertigkeiten am Beruf und ein Beruf an der Fertigkeit wären zwei Wahrheiten
 * über dieselbe Beziehung, und eine davon veraltet beim ersten Umbenennen.
 *
 * Was hier steht, ist Form. Die Daten liegen in `assets/content/classes.json`
 * und werden beim Hochfahren geladen — Server und Client lesen dieselbe Datei.
 */

export interface ClassDef {
  id: string;
  name: string;
  beschreibung: string;
  /** Zeichen für die Auswahl. Ein Bild wäre ein Asset für eine Zeile Text. */
  glyph: string;
  /**
   * Womit dieser Beruf kämpft.
   *
   * Heute nur zur Anzeige in der Figurenauswahl. Sobald es mehr als einen
   * Beruf gibt, hängt daran, was er anlegen darf.
   */
  waffe: string;
}

/** Wie eine Fertigkeit wirkt. */
export type SkillArt = 'flaeche' | 'ziel' | 'selbst';

export interface SkillDef {
  id: string;
  name: string;
  /** Kennung des Berufs, der sie kann. */
  class: string;
  /** Ab dieser Stufe steht sie zur Verfügung. */
  level: number;
  beschreibung: string;
  glyph: string;
  art: SkillArt;
  /**
   * Wirkradius in Weltnenheiten — nur bei `flaeche`.
   *
   * Gemessen bis zur Hülle des Ziels, wie jede Reichweite im Kern.
   */
  radius: number;
  /** Womit der Angriffswert für diesen einen Schlag malgenommen wird. */
  damageFactor: number;
  cooldownMs: number;
  manaCost: number;
  /**
   * Welche Vorstellung der Client dazu spielt.
   *
   * Ein Schlüssel und keine Beschreibung: was daraus wird — Drehung, Funken,
   * Klingenschweif —, weiss allein der Renderer. Der Server schickt beim
   * Auslösen nur, *dass* es passiert ist.
   */
  wirkung: string;
}

const classes = new Map<string, ClassDef>();
const skills = new Map<string, SkillDef>();

export const CLASSES: ReadonlyMap<string, ClassDef> = classes;
export const SKILLS: ReadonlyMap<string, SkillDef> = skills;

export function getClass(id: string): ClassDef | undefined {
  return classes.get(id);
}

export function getSkill(id: string): SkillDef | undefined {
  return skills.get(id);
}

/**
 * Der Beruf einer Figur, die noch keinen hat.
 *
 * Eine neue Figur ist beruflos, und das bleibt sie, bis sie einen Beruf
 * **lernt** — bei einem Lehrer, gegen einen Auftrag, ab einer Stufe. Das ist
 * kein Fehlwert und kein „noch nicht gesetzt": beruflos ist ein Zustand, in
 * dem man die ersten Stufen tatsächlich verbringt.
 *
 * Der leere Text und nicht „anfaenger": ein Anfängerberuf müsste in
 * `classes.json` stehen, hätte dort eine Beschreibung und eine Waffe und wäre
 * damit ein Beruf wie die anderen — mit dem einzigen Unterschied, dass ihn
 * niemand wählen kann. Was leer ist, findet `getClass` nicht, und jede Stelle,
 * die einen Beruf braucht, merkt es von selbst.
 */
export const KEIN_BERUF = '';

/**
 * Was eine Figur dieses Berufs auf dieser Stufe kann.
 *
 * In der Reihenfolge der Tabelle, damit die Leiste unten nicht bei jedem
 * Stufenaufstieg umsortiert. Wer eine Fertigkeit an einen festen Platz binden
 * will, tut das später über den Spielstand — nicht über die Reihenfolge hier.
 */
export function skillsFor(classId: string, level: number): SkillDef[] {
  const raus: SkillDef[] = [];
  for (const s of skills.values()) {
    if (s.class !== classId) continue;
    if (level < s.level) continue;
    raus.push(s);
  }
  return raus;
}

/**
 * **Alle** Fertigkeiten eines Berufs — auch die, für die die Stufe fehlt.
 *
 * Der Unterschied zu `skillsFor` ist der Zweck: dort geht es darum, was eine
 * Figur *kann*, hier darum, was sie *lernen wird*. Ein Fertigkeitenbaum, der
 * nur das Erreichte zeigt, ist kein Baum, sondern eine Liste — und die
 * eigentliche Auskunft, was als Nächstes kommt, fehlte darin.
 *
 * Nach Stufe sortiert: so steht oben, was man hat, und darunter, worauf man
 * zugeht.
 */
export function alleSkillsVon(classId: string): SkillDef[] {
  const raus: SkillDef[] = [];
  for (const s of skills.values()) if (s.class === classId) raus.push(s);
  return raus.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, 'de'));
}

/** Kann diese Figur das? Die eine Frage, die der Server vor dem Wirken stellt. */
export function canUseSkill(classId: string, level: number, skillId: string): boolean {
  const def = skills.get(skillId);
  return def !== undefined && def.class === classId && level >= def.level;
}

export function setClasses(rows: readonly ClassDef[]): void {
  classes.clear();
  for (const row of rows) classes.set(row.id, row);
}

export function setSkills(rows: readonly SkillDef[]): void {
  skills.clear();
  for (const row of rows) skills.set(row.id, row);
}
