/**
 * Die drei Fenster, die zu einem NPC gehören: Gespräch, Questlog, Laden.
 *
 * Sie stehen hier und nicht in `ui/index.ts`, weil sie zusammengehören und
 * weil die Oberfläche sonst zu einer einzigen Datei würde, in der man nichts
 * mehr findet. Spielregeln kennen sie keine — sie zeigen an, was man ihnen
 * gibt, und melden über Rückrufe, was gedrückt wurde. Wer Aufträge annehmen
 * darf, entscheidet ausschliesslich der Server.
 */

import {
  QuestAction,
  QuestStatus,
  getItem,
  getNpc,
  getQuest,
  type NpcDialogMsg,
  type QuestDef,
  type QuestLogRow,
} from '@aurelith/shared';
import { GameWindow } from './windows.ts';

export interface ShopItemView {
  itemId: string;
  count: number;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void, className = 'btn'): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** Ein Ziel als Zeile: „Irrlichter vertreiben 3 / 5". */
function objectiveRows(def: QuestDef, progress: number[]): HTMLElement {
  const list = el('ul', 'quest-objectives');
  def.objectives.forEach((obj, i) => {
    const habe = Math.min(obj.count, progress[i] ?? 0);
    const li = el('li');
    li.dataset.done = String(habe >= obj.count);
    li.append(el('span', 'quest-obj-text', obj.text), el('span', 'quest-obj-count', `${habe} / ${obj.count}`));
    list.append(li);
  });
  return list;
}

/** Belohnungen als eine Zeile Text. */
function rewardText(def: QuestDef): string {
  const teile: string[] = [];
  if (def.reward.exp > 0) teile.push(`${def.reward.exp} EP`);
  if (def.reward.gold > 0) teile.push(`${def.reward.gold} Gold`);
  for (const item of def.reward.items) {
    const name = getItem(item.item)?.name ?? item.item;
    teile.push(item.count > 1 ? `${name} ×${item.count}` : name);
  }
  return teile.join(' · ');
}

// ---------------------------------------------------------------------------
// Gespräch
// ---------------------------------------------------------------------------

export class DialogWindow {
  private readonly win: GameWindow;
  private readonly body: HTMLElement;

  onQuestAction?: (questId: string, action: number) => void;
  onOpenShop?: (npcDefId: string) => void;

  constructor(host: HTMLElement) {
    this.win = new GameWindow(
      host,
      'dialog',
      'Gespräch',
      { left: Math.max(20, window.innerWidth / 2 - 220), top: 90 },
      true,
    );
    this.body = this.win.body;
  }

  get isOpen(): boolean {
    return this.win.isOpen;
  }

  close(): void {
    this.win.setOpen(false);
  }

  /** Zeigt, was der Server über diesen NPC gemeldet hat. */
  show(msg: NpcDialogMsg): void {
    const def = getNpc(msg.npcDefId);
    const teile: HTMLElement[] = [];

    const kopf = el('div', 'dialog-head');
    kopf.append(
      el('span', 'dialog-name', def?.name ?? msg.npcDefId),
      el('span', 'dialog-title', def?.title ?? ''),
    );
    teile.push(kopf, el('p', 'dialog-greeting', def?.greeting ?? ''));

    for (const eintrag of msg.quests) {
      const quest = getQuest(eintrag.questId);
      if (!quest) continue;

      const box = el('section', 'dialog-quest');
      box.dataset.status = String(eintrag.status);

      const titel = el('div', 'dialog-quest-head');
      titel.append(
        el('span', 'quest-mark', eintrag.status === QuestStatus.Verfuegbar ? '!' : '?'),
        el('span', 'quest-name', quest.name),
      );
      box.append(titel);

      if (eintrag.status === QuestStatus.Verfuegbar) {
        box.append(
          el('p', 'dialog-text', quest.textOffer),
          el('p', 'quest-reward', `Belohnung: ${rewardText(quest)}`),
          button('Annehmen', () => this.onQuestAction?.(quest.id, QuestAction.Annehmen)),
        );
      } else if (eintrag.status === QuestStatus.Erfuellt) {
        box.append(
          el('p', 'dialog-text', quest.textDone),
          el('p', 'quest-reward', `Belohnung: ${rewardText(quest)}`),
          button('Abgeben', () => this.onQuestAction?.(quest.id, QuestAction.Abgeben)),
        );
      } else {
        box.append(el('p', 'dialog-text', quest.textProgress));
      }

      teile.push(box);
    }

    if (msg.shop) {
      teile.push(
        button('Waren ansehen', () => this.onOpenShop?.(msg.npcDefId), 'btn dialog-shop'),
      );
    }

    this.body.replaceChildren(...teile);
    this.win.setOpen(true);
  }
}

// ---------------------------------------------------------------------------
// Questlog
// ---------------------------------------------------------------------------

export class QuestLogWindow {
  private readonly win: GameWindow;
  private rows: QuestLogRow[] = [];

  onQuestAction?: (questId: string, action: number) => void;

  constructor(host: HTMLElement) {
    this.win = new GameWindow(host, 'quests', 'Aufträge', { left: 24, top: 160 }, true);
    this.render();
  }

  toggle(): void {
    this.win.toggle();
  }

  setQuests(rows: QuestLogRow[]): void {
    this.rows = rows;
    this.render();
  }

  /** Nur die laufenden — abgeschlossene stehen nicht im Log, sondern im Weg. */
  private render(): void {
    const aktiv = this.rows.filter((r) => r.status !== QuestStatus.Abgeschlossen);

    if (aktiv.length === 0) {
      this.win.body.replaceChildren(
        el('p', 'quest-empty', 'Keine offenen Aufträge. Sprich mit den Leuten im Dorf.'),
      );
      return;
    }

    const teile: HTMLElement[] = [];
    for (const row of aktiv) {
      const def = getQuest(row.questId);
      if (!def) continue;

      const box = el('section', 'quest-entry');
      box.dataset.status = String(row.status);

      const kopf = el('div', 'quest-entry-head');
      kopf.append(
        el('span', 'quest-name', def.name),
        el(
          'span',
          'quest-state',
          row.status === QuestStatus.Erfuellt ? 'Abgabebereit' : `Stufe ${def.levelReq}`,
        ),
      );

      box.append(
        kopf,
        el('p', 'quest-summary', def.summary),
        objectiveRows(def, row.progress),
        el('p', 'quest-reward', `Belohnung: ${rewardText(def)}`),
      );

      const abgabe = getNpc(def.turnIn ?? def.giver);
      if (abgabe) box.append(el('p', 'quest-turnin', `Abgabe bei ${abgabe.name}`));
      box.append(
        button('Aufgeben', () => this.onQuestAction?.(def.id, QuestAction.Aufgeben), 'btn quest-drop'),
      );

      teile.push(box);
    }

    this.win.body.replaceChildren(...teile);
  }
}

// ---------------------------------------------------------------------------
// Laden
// ---------------------------------------------------------------------------

export class ShopWindow {
  private readonly win: GameWindow;
  private npcDefId = '';
  private inventory: ShopItemView[] = [];
  private gold = 0;

  onBuy?: (itemId: string, count: number) => void;
  onSell?: (itemId: string, count: number) => void;

  constructor(host: HTMLElement) {
    this.win = new GameWindow(
      host,
      'shop',
      'Handel',
      { left: Math.max(20, window.innerWidth / 2 - 200), top: 130 },
      true,
    );
  }

  open(npcDefId: string): void {
    this.npcDefId = npcDefId;
    this.render();
    this.win.setOpen(true);
  }

  close(): void {
    this.win.setOpen(false);
  }

  /** Beutel und Gold ändern sich beim Handeln — das Fenster muss mitgehen. */
  setInventory(items: ShopItemView[], gold: number): void {
    this.inventory = items;
    this.gold = gold;
    if (this.win.isOpen) this.render();
  }

  private render(): void {
    const def = getNpc(this.npcDefId);
    const teile: HTMLElement[] = [];

    teile.push(el('p', 'shop-gold', `Dein Gold: ${this.gold.toLocaleString('de-DE')}`));

    const kaufen = el('section', 'shop-side');
    kaufen.append(el('h3', 'shop-head', 'Waren'));
    for (const itemId of def?.shop ?? []) {
      const item = getItem(itemId);
      if (!item) continue;
      const zeile = el('div', 'shop-row');
      zeile.dataset.leistbar = String(this.gold >= item.value);
      zeile.append(
        el('span', 'shop-name', item.name),
        el('span', 'shop-price', `${item.value} G`),
        button('Kaufen', () => this.onBuy?.(itemId, 1), 'btn shop-action'),
      );
      zeile.title = item.description;
      kaufen.append(zeile);
    }
    teile.push(kaufen);

    const verkaufen = el('section', 'shop-side');
    verkaufen.append(el('h3', 'shop-head', 'Dein Beutel'));
    let etwas = false;
    for (const row of this.inventory) {
      const item = getItem(row.itemId);
      if (!item) continue;
      etwas = true;
      // Derselbe Anteil wie auf dem Server. Steht er hier falsch, verkauft man
      // trotzdem richtig — der Server rechnet nach —, aber die Anzeige lügt.
      const preis = Math.max(1, Math.floor(item.value * 0.4));
      const zeile = el('div', 'shop-row');
      zeile.append(
        el('span', 'shop-name', row.count > 1 ? `${item.name} ×${row.count}` : item.name),
        el('span', 'shop-price', `${preis} G`),
        button('Verkaufen', () => this.onSell?.(row.itemId, 1), 'btn shop-action'),
      );
      verkaufen.append(zeile);
    }
    if (!etwas) verkaufen.append(el('p', 'quest-empty', 'Nichts, was sich verkaufen liesse.'));
    teile.push(verkaufen);

    this.win.body.replaceChildren(...teile);
  }
}
