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
  maxUpgrade,
  QuestAction,
  QuestStatus,
  getItem,
  getNpc,
  getQuest,
  isUpgradable,
  sellPrice,
  type NpcDialogMsg,
  type QuestDef,
  type QuestLogRow,
  upgradeChance,
  upgradeCost,
  upgradeName,
} from '@aurelith/shared';
import { GameWindow } from './windows.ts';

export interface ShopItemView {
  itemId: string;
  count: number;
  /** Der Platz im Beutel — verkauft wird ein Stück, keine Sorte. */
  slot: number;
  upgrade: number;
}

/** Was das Aufwertungsfenster von einem Beutelplatz braucht. */
export interface UpgradeItemView {
  itemId: string;
  slot: number;
  upgrade: number;
  equipped: boolean;
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

    // Laden und Schmiede stehen **nicht** mehr hier drin.
    //
    // Sie sind eigene Anliegen und keine Absätze eines Gesprächs: wer handeln
    // will, sucht keinen Knopf unter drei Auftragstexten. Beides steht jetzt
    // im Auswahlmenü, das vor dem Gespräch aufgeht — siehe `NpcMenu`.
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
  onSell?: (itemId: string, count: number, slot: number) => void;

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

  get isOpen(): boolean {
    return this.win.isOpen;
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
    for (const angebot of def?.shop ?? []) {
      const item = getItem(angebot.item);
      if (!item) continue;
      // Preis und Aufwertung stehen am Posten, nicht am Gegenstand: derselbe
      // Gegenstand kann bei zwei Händlern verschieden über den Tresen gehen.
      const preis = angebot.price ?? item.value;
      const zeile = el('div', 'shop-row');
      zeile.dataset.leistbar = String(this.gold >= preis);
      zeile.append(
        el('span', 'shop-name', upgradeName(item, angebot.upgrade ?? 0)),
        el('span', 'shop-price', `${preis} G`),
        button('Kaufen', () => this.onBuy?.(angebot.item, 1), 'btn shop-action'),
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
      // Dieselbe Funktion wie auf dem Server. Sie zweimal zu schreiben hiesse,
      // dass die Anzeige lügt, sobald jemand nur eine der beiden ändert.
      const preis = sellPrice(item, row.upgrade);
      const name = upgradeName(item, row.upgrade);
      const zeile = el('div', 'shop-row');
      zeile.append(
        el('span', 'shop-name', row.count > 1 ? `${name} ×${row.count}` : name),
        el('span', 'shop-price', `${preis} G`),
        button('Verkaufen', () => this.onSell?.(row.itemId, 1, row.slot), 'btn shop-action'),
      );
      verkaufen.append(zeile);
    }
    if (!etwas) verkaufen.append(el('p', 'quest-empty', 'Nichts, was sich verkaufen liesse.'));
    teile.push(verkaufen);

    this.win.body.replaceChildren(...teile);
  }
}

// ---------------------------------------------------------------------------
// Aufwerten
// ---------------------------------------------------------------------------

/**
 * Der Schmiedetisch.
 *
 * Zeigt jedes aufwertbare Stück im Beutel mit seiner Stufe, was der nächste
 * Versuch kostet und wie wahrscheinlich er gelingt. Die Aussicht steht dabei,
 * bevor man drückt — ein Glücksspiel, dessen Quote man erst hinterher erfährt,
 * ist keins, sondern eine Falle.
 *
 * Gewürfelt wird ausschliesslich auf dem Server. Was hier steht, ist dieselbe
 * Tabelle, aus der er liest.
 */
export class UpgradeWindow {
  private readonly win: GameWindow;
  private items: UpgradeItemView[] = [];
  private gold = 0;

  onUpgrade?: (slot: number) => void;

  constructor(host: HTMLElement) {
    this.win = new GameWindow(
      host,
      'upgrade',
      'Verstärken',
      { left: Math.max(20, window.innerWidth / 2 - 200), top: 150 },
      true,
    );
    this.render();
  }

  open(): void {
    this.render();
    this.win.setOpen(true);
  }

  get isOpen(): boolean {
    return this.win.isOpen;
  }

  close(): void {
    this.win.setOpen(false);
  }

  setInventory(items: UpgradeItemView[], gold: number): void {
    this.items = items;
    this.gold = gold;
    if (this.win.isOpen) this.render();
  }

  private render(): void {
    const teile: HTMLElement[] = [
      el('p', 'shop-gold', `Dein Gold: ${this.gold.toLocaleString('de-DE')}`),
    ];

    let etwas = false;
    for (const row of this.items) {
      const def = getItem(row.itemId);
      if (!def || !isUpgradable(def)) continue;
      etwas = true;

      const zeile = el('div', 'upgrade-row');
      const kosten = upgradeCost(def, row.upgrade);
      const aussicht = Math.round(upgradeChance(row.upgrade) * 100);
      const amAnschlag = row.upgrade >= maxUpgrade();

      zeile.dataset.leistbar = String(!amAnschlag && this.gold >= kosten);
      zeile.append(
        el('span', 'shop-name', upgradeName(def, row.upgrade) + (row.equipped ? ' (angelegt)' : '')),
        el(
          'span',
          'upgrade-odds',
          amAnschlag ? 'Anschlag' : `${aussicht} % · ${kosten} G`,
        ),
      );

      if (!amAnschlag) {
        zeile.append(button('Verstärken', () => this.onUpgrade?.(row.slot), 'btn shop-action'));
      }
      teile.push(zeile);
    }

    if (!etwas) {
      teile.push(el('p', 'quest-empty', 'Nichts im Beutel, was sich verstärken liesse.'));
    } else {
      teile.push(
        el(
          'p',
          'settings-note',
          'Ein Fehlschlag kostet das Gold, die Stufe bleibt. Ab +4 leuchtet die Waffe.',
        ),
      );
    }

    this.win.body.replaceChildren(...teile);
  }
}

// ---------------------------------------------------------------------------
// Auswahlmenü vor dem Gespräch
// ---------------------------------------------------------------------------

/** Ein Anliegen, das man bei diesem NPC haben kann. */
export interface NpcOption {
  label: string;
  /** Kurze Beschreibung darunter. Weglassen, wenn der Name genügt. */
  hinweis?: string;
  oeffne: () => void;
}

/**
 * Was man bei diesem NPC vorhat — bevor irgendein Fenster aufgeht.
 *
 * Ein Händler, der nebenbei zwei Aufträge vergibt, hatte bisher alles in
 * einem Fenster: Begrüssung, zwei Auftragstexte mit Belohnungen, darunter
 * „Waren ansehen". Man sucht dann den Knopf, den man meint. Die Auswahl
 * vorweg trennt die Anliegen — und wer nur eines hat, sieht sie gar nicht.
 *
 * Bewusst kein `GameWindow`: das Menü hat keine Titelleiste, wird nicht
 * verschoben und schliesst beim ersten Druck daneben. Es ist eine Frage, kein
 * Fenster.
 */
export class NpcMenu {
  private readonly root: HTMLDivElement;

  constructor(host: HTMLElement) {
    this.root = el('div', 'npc-menu panel');
    this.root.hidden = true;
    host.appendChild(this.root);

    // Ein Druck daneben schliesst. Auf `pointerdown` und nicht auf `click`:
    // die Welt darunter hört ebenfalls auf `pointerdown`, und ein `click` käme
    // zu spät — man hätte das Menü geschlossen *und* daneben ein Ziel gewählt.
    window.addEventListener('pointerdown', (ev) => {
      if (this.root.hidden) return;
      const ziel = ev.target as Node | null;
      if (ziel && this.root.contains(ziel)) return;
      this.schliesse();
    });
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') this.schliesse();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  schliesse(): void {
    this.root.hidden = true;
  }

  /**
   * Zeigt die Auswahl neben der angetippten Stelle.
   *
   * Die Lage wird ins Bild zurückgeholt, nachdem das Menü steht: erst dann ist
   * bekannt, wie breit es geworden ist. Ein am unteren Rand aufgeklapptes Menü
   * wäre sonst zur Hälfte ausserhalb — und zwar genau dann, wenn man einen NPC
   * am unteren Bildrand anspricht.
   */
  zeige(titel: string, optionen: readonly NpcOption[], x: number, y: number): void {
    const kopf = el('div', 'npc-menu-kopf', titel);
    const eintraege = optionen.map((o) => {
      const knopf = el('button', 'npc-menu-eintrag');
      knopf.type = 'button';
      knopf.append(el('span', 'npc-menu-label', o.label));
      if (o.hinweis) knopf.append(el('span', 'npc-menu-hinweis', o.hinweis));
      knopf.addEventListener('click', () => {
        this.schliesse();
        o.oeffne();
      });
      return knopf;
    });

    this.root.replaceChildren(kopf, ...eintraege);
    this.root.hidden = false;

    const rand = 8;
    const kasten = this.root.getBoundingClientRect();
    const links = Math.max(rand, Math.min(window.innerWidth - kasten.width - rand, x));
    const oben = Math.max(rand, Math.min(window.innerHeight - kasten.height - rand, y));
    this.root.style.left = `${Math.round(links)}px`;
    this.root.style.top = `${Math.round(oben)}px`;
  }
}
