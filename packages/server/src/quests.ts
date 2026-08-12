/**
 * Der Auftragsstand eines Spielers.
 *
 * Eine Klasse, die nichts kennt außer der Content-Tabelle und ihrem eigenen
 * Zustand — kein Netz, keine Datenbank, keine Welt. Der GameServer fragt sie,
 * was gilt, und schreibt anschließend, was daraus folgt. Damit lässt sich das
 * ganze Regelwerk prüfen, ohne einen Server hochzufahren.
 *
 * **Sammelziele werden nicht gezählt, sondern gemessen.** Ein Zähler, der beim
 * Aufsammeln hochläuft, geht falsch, sobald jemand einen Gegenstand verkauft,
 * ablegt oder für einen zweiten Auftrag abgibt. Stattdessen wird der Beutel
 * angesehen: was drin liegt, ist der Fortschritt. Das kann nicht auseinander-
 * laufen, weil es keine zweite Wahrheit gibt.
 */

import {
  QuestStatus,
  getQuest,
  questsFrom,
  questsTo,
  turnInOf,
  type QuestDef,
  type QuestLogRow,
} from '@aurelith/shared';
import type { ItemRecord, QuestRecord } from './db/index.ts';
import { countItem } from './inventory.ts';

export interface QuestState {
  status: number;
  progress: number[];
}

export class QuestBook {
  private readonly byId = new Map<string, QuestState>();

  /** Übernimmt den Stand aus der Datenbank. */
  load(records: readonly QuestRecord[]): void {
    this.byId.clear();
    for (const record of records) {
      const def = getQuest(record.questId);
      // Ein Auftrag, den es nicht mehr gibt, verschwindet still. Er im Log
      // stehen zu lassen hiesse, dem Client eine Kennung zu schicken, zu der
      // er keinen Text hat.
      if (!def) continue;
      const progress = def.objectives.map((_, i) => record.progress[i] ?? 0);
      this.byId.set(record.questId, { status: record.status, progress });
    }
  }

  /** Für die Datenbank. */
  records(): QuestRecord[] {
    return [...this.byId].map(([questId, state]) => ({
      questId,
      status: state.status,
      progress: [...state.progress],
    }));
  }

  /** Für den Client. Dasselbe, nur als Protokollzeilen. */
  rows(): QuestLogRow[] {
    return [...this.byId].map(([questId, state]) => ({
      questId,
      status: state.status,
      progress: [...state.progress],
    }));
  }

  statusOf(questId: string): number {
    return this.byId.get(questId)?.status ?? QuestStatus.Verfuegbar;
  }

  isDone(questId: string): boolean {
    return this.statusOf(questId) === QuestStatus.Abgeschlossen;
  }

  /** Läuft gerade — angenommen oder erfüllt, aber nicht abgegeben. */
  isActive(questId: string): boolean {
    const s = this.statusOf(questId);
    return s === QuestStatus.Aktiv || s === QuestStatus.Erfuellt;
  }

  /**
   * Darf dieser Auftrag jetzt angenommen werden?
   *
   * Drei Bedingungen, und alle drei prüft der Server: die Stufe, der
   * Vorgänger, und dass er nicht schon läuft oder erledigt ist.
   */
  canAccept(def: QuestDef, level: number): boolean {
    if (this.byId.has(def.id)) return false;
    if (level < def.levelReq) return false;
    if (def.requires && !this.isDone(def.requires)) return false;
    return true;
  }

  accept(def: QuestDef, level: number, items: ItemRecord[]): boolean {
    if (!this.canAccept(def, level)) return false;
    this.byId.set(def.id, {
      status: QuestStatus.Aktiv,
      progress: def.objectives.map(() => 0),
    });
    // Wer die vier Essenzen schon im Beutel hat, soll den Auftrag nicht noch
    // einmal erfüllen müssen. Deshalb sofort messen statt bei null anzufangen.
    this.syncCollect(items);
    return true;
  }

  abandon(questId: string): boolean {
    if (this.statusOf(questId) === QuestStatus.Abgeschlossen) return false;
    return this.byId.delete(questId);
  }

  /**
   * Ein Monster ist gefallen. Gibt zurück, ob sich etwas geändert hat — nur
   * dann muss der Server ein neues Log schicken.
   */
  onKill(mobId: string): boolean {
    return this.advance('kill', mobId);
  }

  /** Ein NPC wurde angesprochen. */
  onTalk(npcDefId: string): boolean {
    return this.advance('talk', npcDefId);
  }

  private advance(kind: 'kill' | 'talk', target: string): boolean {
    let geaendert = false;

    for (const [questId, state] of this.byId) {
      if (state.status !== QuestStatus.Aktiv) continue;
      const def = getQuest(questId);
      if (!def) continue;

      let dieser = false;
      def.objectives.forEach((obj, i) => {
        if (obj.kind !== kind || obj.target !== target) return;
        if (state.progress[i]! >= obj.count) return;
        state.progress[i] = state.progress[i]! + 1;
        dieser = true;
      });

      // Je Auftrag prüfen, nicht mit dem Sammelflag der Schleife: sonst
      // bekäme jeder Auftrag nach dem ersten geänderten eine Zustandsprüfung,
      // die er nicht verlangt hat.
      if (dieser) {
        this.refreshStatus(questId, state);
        geaendert = true;
      }
    }

    return geaendert;
  }

  /** Liest Sammelziele aus dem Beutel. Siehe Kopfkommentar. */
  syncCollect(items: ItemRecord[]): boolean {
    let geaendert = false;

    for (const [questId, state] of this.byId) {
      if (state.status === QuestStatus.Abgeschlossen) continue;
      const def = getQuest(questId);
      if (!def) continue;

      let dieser = false;
      def.objectives.forEach((obj, i) => {
        if (obj.kind !== 'collect') return;
        const habe = Math.min(obj.count, countItem(items, obj.target));
        if (state.progress[i] === habe) return;
        state.progress[i] = habe;
        dieser = true;
      });

      if (dieser) {
        this.refreshStatus(questId, state);
        geaendert = true;
      }
    }

    return geaendert;
  }

  private refreshStatus(questId: string, state: QuestState): void {
    if (state.status === QuestStatus.Abgeschlossen) return;
    const def = getQuest(questId);
    if (!def) return;
    const fertig = def.objectives.every((obj, i) => (state.progress[i] ?? 0) >= obj.count);
    // In beide Richtungen: wer die gesammelten Essenzen wieder verkauft, ist
    // nicht mehr abgabebereit.
    state.status = fertig ? QuestStatus.Erfuellt : QuestStatus.Aktiv;
  }

  /** Abgabebereit — und beim richtigen NPC? */
  canComplete(def: QuestDef): boolean {
    return this.statusOf(def.id) === QuestStatus.Erfuellt;
  }

  complete(def: QuestDef): boolean {
    const state = this.byId.get(def.id);
    if (!state || state.status !== QuestStatus.Erfuellt) return false;
    state.status = QuestStatus.Abgeschlossen;
    return true;
  }

  /**
   * Was dieser NPC im Gespräch anzubieten hat.
   *
   * Reihenfolge ist Absicht: erst was fertig ist, dann was neu ist, dann was
   * noch läuft. Wer zu einem NPC zurückkommt, will zuerst abgeben.
   */
  dialogFor(npcDefId: string, level: number): Array<{ questId: string; status: number }> {
    const out: Array<{ questId: string; status: number }> = [];

    for (const def of questsTo(npcDefId)) {
      if (this.canComplete(def)) out.push({ questId: def.id, status: QuestStatus.Erfuellt });
    }
    for (const def of questsFrom(npcDefId)) {
      if (this.canAccept(def, level)) out.push({ questId: def.id, status: QuestStatus.Verfuegbar });
    }
    for (const def of questsFrom(npcDefId)) {
      // Nur beim Auftraggeber *oder* beim Abgabeort anzeigen, nicht doppelt.
      if (this.statusOf(def.id) === QuestStatus.Aktiv && turnInOf(def) === npcDefId) {
        out.push({ questId: def.id, status: QuestStatus.Aktiv });
      }
    }
    for (const def of questsTo(npcDefId)) {
      if (def.giver === npcDefId) continue;
      if (this.statusOf(def.id) === QuestStatus.Aktiv) {
        out.push({ questId: def.id, status: QuestStatus.Aktiv });
      }
    }

    return out;
  }
}
