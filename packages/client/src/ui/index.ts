/**
 * Die Oberfläche als Ganzes.
 *
 * Aufgebaut wie bei Flyff: Werte oben links, Ziel oben in der Mitte, Chat
 * unten links, Aktionsleiste unten in der Mitte, Fenster für Inventar und
 * Charakter. Nichts davon ist neu erfunden — die Anordnung ist eingeübt, und
 * daran zu rütteln kostet nur Gewöhnung.
 *
 * Diese Klasse kennt keine Spielregeln. Sie zeigt an, was man ihr gibt, und
 * meldet über Rückrufe, was der Spieler getan hat.
 */

import * as THREE from 'three';
import {
  ChatChannel,
  QUESTS,
  QuestStatus,
  clockText,
  getItem,
  type NpcDialogMsg,
  type QuestLogRow,
  type StatsMsg,
  upgradeBonus,
  upgradeName,
} from '@aurelith/shared';
import type { EntityVisual } from '../render/worldView.ts';
import { GameWindow } from './windows.ts';
import { DialogWindow, QuestLogWindow, ShopWindow, UpgradeWindow } from './npcWindows.ts';
import { Overlay } from './overlay.ts';
import { DEFAULT_LEVELS, type MixerLevels } from '../audio/mixer.ts';
import { assetUrl } from '../config.ts';
import './style.css';

export interface InventoryEntry {
  itemId: string;
  count: number;
  slot: number;
  equipped: boolean;
  /** Aufwertungsstufe, 0 bis 10. */
  upgrade: number;
}

/** Wie eine Gegenstandsart in der Beschreibung heisst. */
const KIND_LABEL: Record<string, string> = {
  weapon: 'Waffe',
  armor: 'Rüstung',
  consumable: 'Verbrauchsgegenstand',
  material: 'Material',
  quest: 'Auftragsgegenstand',
};

export type ConnectionState = 'verbindet' | 'verbunden' | 'getrennt';

/** So viele Zeilen behält das Chatfenster. */
const CHAT_HISTORY = 120;
/** Wie lange eine neue Zeile den eingeklappten Chat sichtbar hält. */
const CHAT_FLASH_MS = 6000;
/** Plätze im Inventar. */
const INVENTORY_SLOTS = 30;

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

/**
 * Die Kachel eines Gegenstands.
 *
 * Mit Bild, wenn die Tabelle eines nennt — erzeugt mit `npm run icons` aus
 * denselben Modellen, die auch in der Welt stehen. Ohne Bild bleibt die alte
 * Farbfläche: sie ist als Rückfall besser als ein leeres Kästchen, und ein
 * neuer Gegenstand ohne Symbol soll nicht unsichtbar sein.
 */
function itemIcon(def: { icon?: string; iconColor: number } | undefined): HTMLElement {
  const farbe = `#${(def?.iconColor ?? 0x888888).toString(16).padStart(6, '0')}`;

  if (!def?.icon) {
    const flaeche = el('div', 'item-icon');
    flaeche.style.background = farbe;
    return flaeche;
  }

  const bild = el('img', 'item-icon item-icon-bild');
  bild.src = assetUrl(def.icon);
  bild.alt = '';
  // Nicht ziehbar und nicht anklickbar: der Klick gehört der Kachel darunter,
  // sonst zieht man auf dem Telefon das Bild statt die Beschreibung zu öffnen.
  bild.draggable = false;
  // Kommt das Bild nicht an, bleibt die Farbe. Ein Symbol, das fehlt, darf
  // keine leere Kachel hinterlassen.
  bild.addEventListener('error', () => {
    bild.removeAttribute('src');
    bild.style.background = farbe;
  });
  return bild;
}

function bar(kind: 'hp' | 'mp' | 'exp'): { root: HTMLDivElement; fill: HTMLDivElement; label: HTMLDivElement } {
  const root = el('div', `bar ${kind}`);
  const fill = el('div', 'bar-fill');
  const label = el('div', 'bar-label');
  root.append(fill, label);
  return { root, fill, label };
}

export class UI {
  readonly overlay: Overlay;

  onChatSubmit?: (text: string) => void;
  onRespawn?: () => void;
  onAttackHold?: (held: boolean) => void;
  /** Der Spieler will das Tor benutzen, in dem er steht. */
  onUsePortal?: () => void;
  /**
   * Anlegen. Angegeben wird der **Platz**, nicht die Kennung — zwei gleiche
   * Klingen mit verschiedener Aufwertung sind nicht mehr dasselbe Stück.
   */
  onEquipItem?: (slot: number) => void;
  /** Aufwerten beim Schmied. Ebenfalls über den Platz. */
  onUpgradeItem?: (slot: number) => void;
  /** Auftrag annehmen, abgeben oder aufgeben. */
  onQuestAction?: (questId: string, action: number) => void;
  /** Kaufen und verkaufen. */
  onBuy?: (itemId: string, count: number) => void;
  onSell?: (itemId: string, count: number, slot: number) => void;

  private readonly host: HTMLElement;

  private readonly nameLabel: HTMLElement;
  private readonly levelLabel: HTMLElement;
  private readonly hpBar = bar('hp');
  private readonly mpBar = bar('mp');
  private readonly expBar = bar('exp');

  private readonly targetPanel: HTMLElement;
  private readonly targetName: HTMLElement;
  private readonly targetLevel: HTMLElement;
  private readonly targetHp = bar('hp');

  private readonly chat: HTMLElement;
  private readonly chatLog: HTMLElement;
  private readonly chatInput: HTMLInputElement;
  /** Auf Touchgeräten eingeklappt; am Schreibtisch immer offen. */
  private chatOpen: boolean;
  private chatFade?: ReturnType<typeof setTimeout>;

  private readonly statusPanel: HTMLElement;
  private readonly statusText: HTMLElement;

  private readonly deathScreen: HTMLElement;
  private readonly portalPrompt: HTMLButtonElement;

  private readonly inventoryWindow: GameWindow;
  private readonly inventoryGrid: HTMLElement;
  private readonly characterWindow: GameWindow;
  private readonly characterStats: HTMLElement;
  private readonly settingsWindow: GameWindow;

  private readonly dialogWindow: DialogWindow;
  private readonly questWindow: QuestLogWindow;
  private readonly shopWindow: ShopWindow;
  private readonly upgradeWindow: UpgradeWindow;
  /** Die Beschreibung unter dem Inventarraster, samt gezeigtem Platz. */
  private readonly itemDetail: HTMLElement;
  private detailSlot?: number;
  /** Die Uhr oben links. Zeigt die Weltzeit, nicht die des Geräts. */
  private readonly clockLabel: HTMLElement;
  /** Zuletzt gesehenes Inventar — der Laden verkauft daraus. */
  private inventory: InventoryEntry[] = [];
  /** Zuletzt gesehener Auftragsstand, samt daraus gerechneten Zeichen. */
  private questQuests: QuestLogRow[] = [];
  private readonly questMarks = new Map<string, string>();

  /** Lautstärken, wie sie im Fenster stehen. */
  private levels: MixerLevels = DEFAULT_LEVELS;
  private muteBox?: HTMLInputElement;
  private readonly levelInputs = new Map<
    'master' | 'weapons' | 'effects' | 'music',
    { input: HTMLInputElement; value: HTMLElement }
  >();
  /** Meldet eine Änderung nach draußen — das Mischpult hängt nicht an der UI. */
  onAudioChange?: (levels: Partial<MixerLevels>) => void;
  /** Der Testknopf. Gibt zurück, ob tatsächlich etwas gespielt wurde. */
  onAudioProbe?: () => boolean;

  private audioState?: HTMLElement;
  private lastAudioState: 'stumm' | 'wartet' | 'bereit' | 'unterbrochen' | 'unmoeglich' =
    'wartet';

  private lastStats?: StatsMsg;

  constructor(host: HTMLElement, private readonly touch: boolean) {
    this.host = host;
    // Die Anordnung hängt an der Bedienart, nicht an der Fensterbreite. Ein
    // Tablet quer ist zweitausend Pixel breit und wird trotzdem mit dem
    // Daumen bedient — eine Breitenabfrage hätte es als Schreibtisch
    // eingestuft und ihm die Schreibtischanordnung gegeben.
    host.dataset.touch = String(touch);

    // --- Werte ------------------------------------------------------------
    const vitals = el('div', 'vitals panel');
    const head = el('div', 'vitals-head');
    this.nameLabel = el('span', 'vitals-name', '—');
    this.levelLabel = el('span', 'vitals-level', 'Stufe 1');
    this.clockLabel = el('span', 'vitals-clock', '');
    head.append(this.nameLabel, this.clockLabel, this.levelLabel);
    vitals.append(head, this.hpBar.root, this.mpBar.root, this.expBar.root);
    host.appendChild(vitals);

    // --- Ziel -------------------------------------------------------------
    this.targetPanel = el('div', 'target panel');
    const targetHead = el('div', 'target-head');
    this.targetName = el('span', 'target-name', '');
    this.targetLevel = el('span', 'target-level', '');
    targetHead.append(this.targetName, this.targetLevel);
    this.targetPanel.append(targetHead, this.targetHp.root);
    host.appendChild(this.targetPanel);

    // --- Verbindungsanzeige ----------------------------------------------
    this.statusPanel = el('div', 'status panel');
    const dot = el('span', 'dot');
    this.statusText = el('span', undefined, 'verbindet');
    this.statusPanel.append(dot, this.statusText);
    this.statusPanel.dataset.state = 'verbindet';
    host.appendChild(this.statusPanel);

    // --- Chat -------------------------------------------------------------
    //
    // Am Schreibtisch steht der Chat dauerhaft unten links — dort ist Platz,
    // und er verdeckt nichts. Auf dem Telefon ist genau das falsch: die
    // Bildfläche ist knapp, und ein Kasten über dem halben Bild nimmt Sicht
    // weg, ohne dass man ihn die meiste Zeit braucht.
    //
    // Also ist er dort eingeklappt. Neue Zeilen blenden sich kurz ein und
    // wieder aus, das 💬 in der Aktionsleiste klappt ihn zum Lesen und
    // Schreiben auf. Eingeklappt fängt er auch keine Berührungen ab — das
    // war bislang eine unsichtbare tote Ecke über der Welt.
    this.chat = el('div', 'chat');
    this.chatOpen = !touch;
    this.chat.dataset.open = String(this.chatOpen);
    this.chatLog = el('div', 'chat-log panel');
    this.chatInput = el('input', 'chat-input');
    this.chatInput.type = 'text';
    this.chatInput.placeholder = 'Nachricht … (Enter)';
    this.chatInput.maxLength = 200;
    this.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.setChatOpen(false);
        e.stopPropagation();
        return;
      }
      if (e.key !== 'Enter') return;
      const text = this.chatInput.value.trim();
      this.chatInput.value = '';
      if (text) this.onChatSubmit?.(text);
      // Auf dem Telefon zurück ins Spiel: Tastatur weg, Sicht frei.
      this.setChatOpen(false);
      e.stopPropagation();
    });
    this.chat.append(this.chatLog, this.chatInput);
    host.appendChild(this.chat);

    // --- NPC-Fenster ------------------------------------------------------
    this.dialogWindow = new DialogWindow(host);
    this.questWindow = new QuestLogWindow(host);
    this.shopWindow = new ShopWindow(host);
    this.upgradeWindow = new UpgradeWindow(host);
    this.upgradeWindow.onUpgrade = (slot) => this.onUpgradeItem?.(slot);
    this.dialogWindow.onOpenUpgrade = () => {
      this.upgradeWindow.setInventory(this.inventory, this.lastStats?.gold ?? 0);
      this.upgradeWindow.open();
    };

    this.dialogWindow.onQuestAction = (id, action) => this.onQuestAction?.(id, action);
    this.questWindow.onQuestAction = (id, action) => this.onQuestAction?.(id, action);
    this.dialogWindow.onOpenShop = (npcDefId) => {
      this.shopWindow.setInventory(this.sellableItems(), this.lastStats?.gold ?? 0);
      this.shopWindow.open(npcDefId);
    };
    this.shopWindow.onBuy = (itemId, count) => this.onBuy?.(itemId, count);
    this.shopWindow.onSell = (itemId, count, slot) => this.onSell?.(itemId, count, slot);

    // --- Fenster ----------------------------------------------------------
    this.inventoryWindow = new GameWindow(
      host,
      'inventory',
      'Inventar',
      { left: window.innerWidth - 300, top: 120 },
      true,
    );
    this.inventoryGrid = el('div', 'inventory-grid');
    // Die Beschreibung sitzt unter dem Raster und ist leer, solange nichts
    // ausgewählt ist.
    this.itemDetail = el('div', 'item-detail');
    this.itemDetail.hidden = true;
    this.inventoryWindow.body.append(this.inventoryGrid, this.itemDetail);
    this.setInventory([]);

    this.characterWindow = new GameWindow(
      host,
      'character',
      'Charakter',
      { left: window.innerWidth - 300, top: 340 },
      true,
    );
    this.characterStats = el('dl', 'stat-list');
    this.characterWindow.body.appendChild(this.characterStats);

    // --- Einstellungen ----------------------------------------------------
    this.settingsWindow = new GameWindow(
      host,
      'settings',
      'Einstellungen',
      { left: Math.max(20, window.innerWidth / 2 - 150), top: 100 },
      true,
    );
    this.buildSettings();

    // --- Aktionsleiste ----------------------------------------------------
    const actionbar = el('div', 'actionbar panel');
    actionbar.append(
      this.slot('🎒', 'I', 'Inventar', () => this.inventoryWindow.toggle()),
      this.slot('👤', 'C', 'Charakter', () => this.characterWindow.toggle()),
      this.slot('📜', 'J', 'Aufträge', () => this.questWindow.toggle()),
      this.slot('💬', '⏎', 'Chat', () => this.setChatOpen(!this.chatOpen)),
      this.slot('⚙', 'O', 'Einstellungen', () => this.settingsWindow.toggle()),
    );
    host.appendChild(actionbar);

    // --- Angriffsknopf (nur mobil) ---------------------------------------
    if (touch) {
      const attack = el('button', 'attack-button', 'ANGRIFF');
      attack.type = 'button';
      const press = (held: boolean) => (e: Event) => {
        e.preventDefault();
        this.onAttackHold?.(held);
      };
      attack.addEventListener('pointerdown', press(true));
      attack.addEventListener('pointerup', press(false));
      attack.addEventListener('pointercancel', press(false));
      attack.addEventListener('pointerleave', press(false));
      host.appendChild(attack);
    }

    // --- Tor-Hinweis ------------------------------------------------------
    //
    // Auf dem PC eine Zeile mit der Taste, auf Mobil ein Knopf — dasselbe
    // Element, nur unterschiedlich bedient. Sichtbar wird es nur, wenn die
    // Figur wirklich in einem Tor steht.
    this.portalPrompt = el('button', 'portal-prompt panel');
    this.portalPrompt.type = 'button';
    this.portalPrompt.hidden = true;
    this.portalPrompt.addEventListener('click', () => this.onUsePortal?.());
    host.appendChild(this.portalPrompt);

    // --- Todesbildschirm --------------------------------------------------
    this.deathScreen = el('div', 'death');
    const deathPanel = el('div', 'death-panel panel');
    const respawn = el('button', 'btn', 'Zurückkehren');
    respawn.type = 'button';
    respawn.addEventListener('click', () => this.onRespawn?.());
    deathPanel.append(
      el('h2', undefined, 'Gefallen'),
      el('p', undefined, 'Du kehrst am Startpunkt der Karte zurück.'),
      respawn,
    );
    this.deathScreen.appendChild(deathPanel);
    host.appendChild(this.deathScreen);

    this.overlay = new Overlay(host);

    if (!touch) this.bindHotkeys();
    else this.trackKeyboard();
  }

  /**
   * Hält die Höhe der eingeblendeten Bildschirmtastatur in `--kb`.
   *
   * Der Chat hängt am unteren Rand, und für feststehende Elemente verschiebt
   * sich der nicht, wenn die Tastatur aufgeht — das Eingabefeld läge darunter
   * und man tippte blind. `visualViewport` meldet, wie viel unten fehlt.
   */
  private trackKeyboard(): void {
    const view = window.visualViewport;
    if (!view) return;

    const update = (): void => {
      const hidden = Math.max(0, window.innerHeight - view.height - view.offsetTop);
      this.host.style.setProperty('--kb', `${Math.round(hidden)}px`);
    };
    view.addEventListener('resize', update);
    view.addEventListener('scroll', update);
    update();
  }

  /**
   * Baut das Einstellungsfenster.
   *
   * Vier Regler statt einem: wer die Waffen leiser dreht, will nicht auch die
   * Musik leiser haben. Musik gibt es noch nicht — der Regler steht trotzdem
   * schon da, weil ein Mischpult, das man später umbauen muss, kein Mischpult
   * ist, sondern eine Baustelle.
   */
  private buildSettings(): void {
    const body = this.settingsWindow.body;

    const ton = el('section', 'settings-group');
    ton.append(el('h3', 'settings-head', 'Ton'));

    const muteRow = el('label', 'settings-toggle');
    const mute = el('input');
    mute.type = 'checkbox';
    mute.addEventListener('change', () => {
      this.levels = { ...this.levels, muted: mute.checked };
      this.applyLevelsToForm();
      this.onAudioChange?.({ muted: mute.checked });
    });
    muteRow.append(mute, el('span', undefined, 'Ton aus'));
    ton.append(muteRow);

    const keys = [
      ['master', 'Gesamt'],
      ['weapons', 'Waffen'],
      ['effects', 'Effekte'],
      ['music', 'Musik'],
    ] as const;

    for (const [key, label] of keys) {
      const row = el('div', 'settings-slider');
      const name = el('label', undefined, label);
      const value = el('span', 'settings-value', '0 %');

      const input = el('input');
      input.type = 'range';
      input.min = '0';
      input.max = '100';
      input.step = '1';
      input.setAttribute('aria-label', label);
      input.addEventListener('input', () => {
        const level = Number(input.value) / 100;
        this.levels = { ...this.levels, [key]: level };
        value.textContent = `${input.value} %`;
        this.onAudioChange?.({ [key]: level });
      });

      const head = el('div', 'settings-slider-head');
      head.append(name, value);
      row.append(head, input);
      ton.append(row);

      this.levelInputs.set(key, { input, value });
    }

    this.muteBox = mute;
    body.append(ton);

    // --- Zustand und Probe ------------------------------------------------
    //
    // „Ich höre nichts" hat auf einem Telefon drei Ursachen: der Tonkontext
    // schläft noch, der Regler steht auf stumm, oder der Lautlos-Schalter des
    // Geräts ist an. Die Seite sieht nur die ersten beiden — also zeigt sie
    // die an und nennt die dritte, statt den Benutzer raten zu lassen.
    const probe = el('section', 'settings-group');
    this.audioState = el('p', 'settings-state', '');

    const testButton = el('button', 'btn', 'Ton testen');
    testButton.type = 'button';
    testButton.addEventListener('click', () => {
      const ok = this.onAudioProbe?.() ?? false;
      this.setAudioState(this.lastAudioState, ok ? 'gespielt' : 'nichts da');
    });

    probe.append(this.audioState, testButton);
    body.append(probe);

    const hinweis = el('p', 'settings-note', '');
    hinweis.append(
      document.createTextNode(
        'Töne starten erst nach der ersten Eingabe — Browser lassen Ton ohne ' +
          'Zutun nicht zu. Ein Tipper ins Bild genügt. ',
      ),
      el(
        'strong',
        undefined,
        'Auf iPhone und iPad schaltet der Lautlos-Schalter auch Web-Ton stumm.',
      ),
    );
    body.append(hinweis);
  }

  /**
   * Zeigt an, ob Ton möglich ist.
   *
   * `hinweis` ist die Rückmeldung des Testknopfs und verfällt beim nächsten
   * Zustandswechsel — sie gehört zu einem Druck, nicht zum Zustand.
   */
  setAudioState(
    state: 'stumm' | 'wartet' | 'bereit' | 'unterbrochen' | 'unmoeglich',
    hinweis?: string,
  ): void {
    this.lastAudioState = state;
    if (!this.audioState) return;

    const text: Record<typeof state, string> = {
      bereit: 'Ton ist bereit.',
      wartet: 'Wartet auf die erste Eingabe — einmal ins Bild tippen.',
      unterbrochen:
        'Vom System unterbrochen (Anruf, Wecker, Siri) — einmal ins Bild tippen.',
      stumm: 'Ton ist ausgeschaltet.',
      unmoeglich: 'Dieser Browser gibt keinen Ton aus.',
    };

    this.audioState.dataset.state = state;
    this.audioState.textContent = hinweis ? `${text[state]} (${hinweis})` : text[state];
  }

  /** Übernimmt Lautstärken von außen ins Fenster. */
  setAudioLevels(levels: MixerLevels): void {
    this.levels = levels;
    this.applyLevelsToForm();
  }

  private applyLevelsToForm(): void {
    if (this.muteBox) this.muteBox.checked = this.levels.muted;
    for (const [key, { input, value }] of this.levelInputs) {
      const pct = Math.round(this.levels[key] * 100);
      input.value = String(pct);
      value.textContent = `${pct} %`;
      // Bei stumm bleiben die Regler bedienbar, sehen aber inaktiv aus —
      // sonst dreht man am Regler und wundert sich, warum nichts kommt.
      input.closest('.settings-slider')?.setAttribute('data-muted', String(this.levels.muted));
    }
  }

  private slot(icon: string, key: string, label: string, onClick: () => void): HTMLButtonElement {
    const button = el('button', 'btn slot', icon);
    button.type = 'button';
    button.title = `${label} (${key})`;
    button.setAttribute('aria-label', label);
    if (!this.touch) button.append(el('span', 'key', key));
    button.addEventListener('click', onClick);
    return button;
  }

  private bindHotkeys(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.isContentEditable)) {
        if (e.key === 'Escape') (target as HTMLInputElement).blur();
        return;
      }
      if (e.code === 'KeyI') this.inventoryWindow.toggle();
      else if (e.code === 'KeyC') this.characterWindow.toggle();
      else if (e.code === 'KeyJ') this.questWindow.toggle();
      else if (e.code === 'KeyO') this.settingsWindow.toggle();
      else if (e.code === 'Enter') {
        e.preventDefault();
        this.chatInput.focus();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Anzeigen
  // -------------------------------------------------------------------------

  setPlayerName(name: string): void {
    this.nameLabel.textContent = name;
  }

  setStats(stats: StatsMsg): void {
    this.lastStats = stats;
    // Das Gold steht im Laden — wer eben etwas verkauft hat, soll den neuen
    // Stand sehen, ohne das Fenster zu schliessen.
    this.shopWindow.setInventory(this.sellableItems(), stats.gold);
    this.upgradeWindow.setInventory(this.inventory, stats.gold);

    this.levelLabel.textContent = `Stufe ${stats.level}`;
    // Eine neue Stufe kann Aufträge freischalten — die Zeichen über den NPCs
    // hängen an der Stufe genauso wie am Auftragsstand.
    this.rebuildQuestMarks();
    this.setBar(this.hpBar, stats.hp, stats.maxHp, `${Math.round(stats.hp)} / ${stats.maxHp}`);
    this.setBar(this.mpBar, stats.mp, stats.maxMp, `${Math.round(stats.mp)} / ${stats.maxMp}`);

    const next = stats.expForNext === 0xffffffff ? 0 : stats.expForNext;
    const pct = next > 0 ? (stats.exp / next) * 100 : 100;
    this.setBar(this.expBar, stats.exp, next || 1, `${pct.toFixed(1)} %`);

    this.characterStats.replaceChildren(
      ...this.statRow('Stufe', String(stats.level)),
      ...this.statRow('Erfahrung', next > 0 ? `${stats.exp} / ${next}` : 'Höchststufe'),
      ...this.statRow('Leben', `${Math.round(stats.hp)} / ${stats.maxHp}`),
      ...this.statRow('Mana', `${Math.round(stats.mp)} / ${stats.maxMp}`),
      ...this.statRow('Angriff', String(stats.attackDamage)),
      ...this.statRow('Verteidigung', String(stats.defense)),
      ...this.statRow('Gold', stats.gold.toLocaleString('de-DE')),
    );
  }

  /** Aktualisiert nur die Lebensanzeige — kommt mit jedem Snapshot. */
  setHp(hp: number): void {
    if (!this.lastStats) return;
    this.lastStats.hp = hp;
    this.setBar(this.hpBar, hp, this.lastStats.maxHp, `${Math.round(hp)} / ${this.lastStats.maxHp}`);
  }

  private statRow(label: string, value: string): [HTMLElement, HTMLElement] {
    return [el('dt', undefined, label), el('dd', undefined, value)];
  }

  private setBar(
    b: { fill: HTMLDivElement; label: HTMLDivElement },
    value: number,
    max: number,
    text: string,
  ): void {
    const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    b.fill.style.transform = `scaleX(${ratio})`;
    b.label.textContent = text;
  }

  /**
   * Zeigt oder verbirgt den Hinweis auf ein Tor.
   *
   * `undefined` heisst: die Figur steht in keinem. Bewusst nur eine Anzeige —
   * ob die Reise stattfindet, entscheidet der Server, der die Entfernung
   * nochmals prüft.
   */
  setPortalPrompt(label: string | undefined): void {
    const text = label === undefined ? '' : this.touch ? `${label} betreten` : `[F] ${label} betreten`;
    if (this.portalPrompt.textContent !== text) this.portalPrompt.textContent = text;
    this.portalPrompt.hidden = label === undefined;
  }

  setTarget(target: EntityVisual | undefined): void {
    if (!target) {
      this.targetPanel.dataset.visible = 'false';
      return;
    }
    this.targetPanel.dataset.visible = 'true';
    this.targetName.textContent = target.name || '—';
    this.targetLevel.textContent = `Stufe ${target.level}`;
    this.setBar(
      this.targetHp,
      target.hp,
      target.maxHp,
      `${Math.round(target.hp)} / ${Math.round(target.maxHp)}`,
    );
  }

  setConnection(state: ConnectionState, detail?: string): void {
    this.statusPanel.dataset.state = state;
    this.statusText.textContent = detail ? `${state} · ${detail}` : state;
  }

  setDead(dead: boolean): void {
    this.deathScreen.dataset.visible = String(dead);
  }

  addChat(channel: number, from: string, text: string): void {
    const line = el('div', 'chat-line');
    line.dataset.channel =
      channel === ChatChannel.System ? 'system' : channel === ChatChannel.Shout ? 'shout' : 'say';

    if (from) {
      const who = el('span', 'who', `${from}: `);
      line.append(who, document.createTextNode(text));
    } else {
      line.textContent = text;
    }

    this.chatLog.appendChild(line);
    while (this.chatLog.childElementCount > CHAT_HISTORY) {
      this.chatLog.firstElementChild?.remove();
    }
    this.chatLog.scrollTop = this.chatLog.scrollHeight;

    // Eingeklappt bleibt die Zeile trotzdem kurz stehen. Systemmeldungen —
    // „Holzbogen angelegt“, ein Stufenaufstieg — sind sonst nicht zu sehen,
    // ohne dass man erst etwas aufklappt.
    if (!this.chatOpen) this.flashChat();
  }

  /**
   * Klappt den Chat auf oder zu.
   *
   * Am Schreibtisch gibt es kein Zuklappen — dort steht er ohnehin dauerhaft,
   * und `false` bedeutet nur „raus aus dem Eingabefeld“, damit WASD wieder
   * die Figur bewegt statt Buchstaben zu tippen.
   */
  setChatOpen(open: boolean): void {
    if (!this.touch) {
      if (open) this.chatInput.focus();
      else this.chatInput.blur();
      return;
    }

    this.chatOpen = open;
    this.chat.dataset.open = String(open);

    if (open) {
      clearTimeout(this.chatFade);
      this.chat.dataset.fresh = 'false';
      this.chatLog.scrollTop = this.chatLog.scrollHeight;
      this.chatInput.focus();
    } else {
      this.chatInput.blur();
    }
  }

  /** Zeigt den eingeklappten Chat für ein paar Sekunden. */
  private flashChat(): void {
    this.chat.dataset.fresh = 'true';
    clearTimeout(this.chatFade);
    this.chatFade = setTimeout(() => {
      this.chat.dataset.fresh = 'false';
    }, CHAT_FLASH_MS);
  }

  /**
   * Stellt die Uhr.
   *
   * `t` ist der Anteil des Tages, wie ihn der Tageszyklus rechnet. Das Symbol
   * wechselt mit — eine Zahl allein sagt einem nicht, ob 05:00 morgens noch
   * dunkel ist.
   */
  setWorldTime(t: number, darkness: number): void {
    const text = `${darkness > 0.5 ? '🌙' : '☀'} ${clockText(t)}`;
    if (this.clockLabel.textContent !== text) this.clockLabel.textContent = text;
  }

  /** Zeigt das Gespräch mit einem NPC. */
  showDialog(msg: NpcDialogMsg): void {
    this.dialogWindow.show(msg);
  }

  closeDialog(): void {
    this.dialogWindow.close();
    this.shopWindow.close();
    this.upgradeWindow.close();
  }

  setQuests(rows: QuestLogRow[]): void {
    this.questQuests = rows;
    this.questWindow.setQuests(rows);
    this.rebuildQuestMarks();
  }

  /**
   * Rechnet die Zeichen über den NPCs.
   *
   * Dieselbe Frage, die der Server beim Gespräch beantwortet — hier nur
   * vorweggenommen, damit man von weitem sieht, wo es etwas zu holen gibt.
   * Weicht das Ergebnis ab, entscheidet das Gespräch: der Server prüft
   * ohnehin nochmal, und ein Zeichen, das zu viel steht, kostet einen Klick.
   */
  private rebuildQuestMarks(): void {
    const level = this.lastStats?.level ?? 1;
    const status = new Map(this.questQuests.map((r) => [r.questId, r.status]));
    this.questMarks.clear();

    for (const quest of QUESTS.values()) {
      const eigener = status.get(quest.id) ?? QuestStatus.Verfuegbar;

      if (eigener === QuestStatus.Erfuellt) {
        this.questMarks.set(quest.turnIn ?? quest.giver, 'fertig');
        continue;
      }
      if (eigener === QuestStatus.Aktiv) {
        const ziel = quest.turnIn ?? quest.giver;
        if (this.questMarks.get(ziel) !== 'fertig') this.questMarks.set(ziel, 'laeuft');
        continue;
      }
      if (eigener !== QuestStatus.Verfuegbar) continue;

      // Noch nicht angenommen: nur zeigen, wenn er auch annehmbar wäre.
      if (level < quest.levelReq) continue;
      if (quest.requires && status.get(quest.requires) !== QuestStatus.Abgeschlossen) continue;
      if (this.questMarks.get(quest.giver) !== 'fertig') this.questMarks.set(quest.giver, 'neu');
    }
  }

  /** Was sich verkaufen lässt: alles im Beutel, was nicht angelegt ist. */
  private sellableItems(): Array<{ itemId: string; count: number; slot: number; upgrade: number }> {
    return this.inventory
      .filter((e) => !e.equipped)
      .map((e) => ({ itemId: e.itemId, count: e.count, slot: e.slot, upgrade: e.upgrade }));
  }

  setInventory(entries: InventoryEntry[]): void {
    this.inventory = entries;
    this.shopWindow.setInventory(this.sellableItems(), this.lastStats?.gold ?? 0);
    this.upgradeWindow.setInventory(entries, this.lastStats?.gold ?? 0);

    const bySlot = new Map(entries.map((e) => [e.slot, e]));
    const slots: HTMLElement[] = [];

    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      const entry = bySlot.get(i);
      const slot = el('div', 'item-slot');
      slot.dataset.equipped = String(entry?.equipped ?? false);

      if (!entry) {
        slot.classList.add('item-empty');
        slots.push(slot);
        continue;
      }

      const def = getItem(entry.itemId);
      slot.appendChild(itemIcon(def));

      if (entry.count > 1) slot.appendChild(el('span', 'item-count', String(entry.count)));
      // Die Aufwertung steht auf der Kachel. Ohne sie sähen eine +0 und eine
      // +7 im Beutel gleich aus, und das ist der eine Unterschied, den man
      // dort auf jeden Fall sehen will.
      if (entry.upgrade > 0) {
        slot.appendChild(el('span', 'item-upgrade', `+${entry.upgrade}`));
      }

      const equippable = def !== undefined && def.slot !== 'none';
      slot.title = def
        ? `${upgradeName(def, entry.upgrade)}${entry.equipped ? ' (angelegt)' : ''}\n${def.description}`
        : entry.itemId;

      if (equippable && !entry.equipped) slot.classList.add('item-equippable');

      // Ein **einfacher** Klick zeigt die Beschreibung. Vorher hing sie am
      // `title`-Attribut, und das gibt es auf einem Telefon nicht: dort liess
      // sich der Name eines Gegenstands schlicht nicht herausfinden.
      slot.addEventListener('click', () => this.showItemDetail(entry.slot));
      // Der Doppelklick bleibt als Abkürzung am Schreibtisch. Auf Touch ist er
      // unzuverlässig — dort führt der Weg über den Knopf in der Beschreibung.
      if (equippable && !entry.equipped) {
        slot.addEventListener('dblclick', () => this.onEquipItem?.(entry.slot));
      }

      slots.push(slot);
    }

    this.inventoryGrid.replaceChildren(...slots);
    // Die offene Beschreibung neu zeichnen: Anlegen und Aufwerten ändern
    // genau das, was darin steht.
    if (this.detailSlot !== undefined) this.showItemDetail(this.detailSlot, true);
  }

  /**
   * Zeigt die Beschreibung eines Gegenstands unter dem Raster.
   *
   * Unter dem Raster und nicht als schwebende Sprechblase: eine Blase müsste
   * sich um Bildschirmränder kümmern, und auf einem Telefon deckt sie das
   * halbe Inventar zu. Ein fester Platz ist langweiliger und funktioniert
   * überall gleich.
   */
  private showItemDetail(slot: number, behalten = false): void {
    const entry = this.inventory.find((e) => e.slot === slot);
    // Nochmal auf dieselbe Kachel: zuklappen. Auf dem Telefon ist das der
    // einzige naheliegende Weg, die Beschreibung wieder loszuwerden.
    if (!entry || (!behalten && this.detailSlot === slot)) {
      this.detailSlot = undefined;
      this.itemDetail.replaceChildren();
      this.itemDetail.hidden = true;
      return;
    }

    const def = getItem(entry.itemId);
    if (!def) return;

    this.detailSlot = slot;
    this.itemDetail.hidden = false;

    const kopf = el('div', 'detail-head');
    const bild = itemIcon(def);
    bild.classList.add('detail-icon');
    const beschriftung = el('div');
    beschriftung.append(
      el('div', 'detail-name', upgradeName(def, entry.upgrade)),
      el('div', 'detail-kind', KIND_LABEL[def.kind] ?? def.kind),
    );
    kopf.append(bild, beschriftung);

    const teile: HTMLElement[] = [kopf];

    const werte: string[] = [];
    const bonus = upgradeBonus(def, entry.upgrade);
    if (def.attackDamage > 0) {
      werte.push(
        bonus.attackDamage > 0
          ? `Angriff ${def.attackDamage} (+${bonus.attackDamage})`
          : `Angriff ${def.attackDamage}`,
      );
    }
    if (def.defense > 0) {
      werte.push(
        bonus.defense > 0 ? `Verteidigung ${def.defense} (+${bonus.defense})` : `Verteidigung ${def.defense}`,
      );
    }
    if (def.effectValue > 0) werte.push(`Wirkung ${def.effectValue}`);
    if (def.levelReq > 1) werte.push(`ab Stufe ${def.levelReq}`);
    werte.push(`Wert ${def.value} G`);
    if (werte.length > 0) teile.push(el('div', 'detail-stats', werte.join(' · ')));

    teile.push(el('p', 'detail-text', def.description));

    if (entry.equipped) {
      teile.push(el('div', 'detail-worn', 'Angelegt'));
    } else if (def.slot !== 'none') {
      const anlegen = el('button', 'btn', 'Anlegen');
      anlegen.type = 'button';
      anlegen.addEventListener('click', () => this.onEquipItem?.(entry.slot));
      teile.push(anlegen);
    }

    this.itemDetail.replaceChildren(...teile);
    // Bei dreissig Plätzen steht die Beschreibung auf einem Telefon unter dem
    // sichtbaren Bereich — man tippt und sieht nichts. `nearest` scrollt nur,
    // wenn es nötig ist, und lässt den Rest in Ruhe.
    if (!behalten) this.itemDetail.scrollIntoView({ block: 'nearest' });
  }

  /** Namensschilder und Zahlen weiterschieben. */
  updateOverlay(
    camera: THREE.PerspectiveCamera,
    entities: Iterable<EntityVisual>,
    localId: number,
    targetId: number,
    dt: number,
  ): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.overlay.updateNameplates(
      camera,
      entities,
      localId,
      targetId,
      width,
      height,
      this.questMarks,
    );
    this.overlay.updateNumbers(camera, dt, width, height);
  }

  get chatHasFocus(): boolean {
    return document.activeElement === this.chatInput;
  }
}
