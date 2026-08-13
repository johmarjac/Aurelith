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
  attributeDef,
  formatAttribute,
  formatBeitrag,
  getItem,
  tuning,
  tuningLoaded,
  slotCapacity,
  SLOT_NAMES,
  setOfItem,
  setProgress,
  glowFrom,
  type EquipSlot,
  type LootRow,
  type NpcDialogMsg,
  type QuestLogRow,
  type StatsMsg,
  upgradeBonus,
  upgradeName,
} from '@aurelith/shared';
import type { EntityVisual } from '../render/worldView.ts';
import type { ModelRegistry } from '../render/modelRegistry.ts';
import { GameWindow } from './windows.ts';
import { Konsole, type LogArt } from './konsole.ts';
import { DialogWindow, QuestLogWindow, ShopWindow, UpgradeWindow } from './npcWindows.ts';
import { Overlay } from './overlay.ts';
import { DollView } from './dollView.ts';
import {
  ladeUiScale,
  setzeUiScale,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
} from './uiScale.ts';
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

/**
 * Welche Plätze links und rechts der Figur stehen — und der wievielte.
 *
 * Der Index unterscheidet die beiden Ringe. Er ist kein eigener Platz im
 * Sinne der Inhaltsdatei, sondern nur die Stelle im Kästchen: der erste
 * angelegte Ring sitzt oben, der zweite darunter.
 */
/*
 * Die Anordnung der Kästchen um die Figur — dieselbe wie bei Flyff.
 *
 * Links, was man in der Hand hält und umhängt; rechts die Rüstung von oben
 * nach unten, wie sie am Körper sitzt; über dem Kopf das Zubehör, das man
 * nicht sieht. Dass die Rüstungsteile in der Reihenfolge Kopf–Brust–Hose–Schuh
 * untereinander stehen, ist der halbe Sinn der Sache: man liest sie ab, ohne
 * die Symbole anzusehen.
 *
 * Die Reihe oben trägt Ring, Ohrring, Halskette, Ohrring, Ring — dieselbe
 * Fünferreihe wie im Vorbild. Was es nicht gibt, steht auch nicht da: leere
 * Kästchen für Dinge, die nie hineinpassen, sind ein Versprechen, das niemand
 * einlöst.
 */
const OBERE_PLAETZE: ReadonlyArray<[EquipSlot, number]> = [
  ['ring', 0],
  ['earring', 0],
  ['necklace', 0],
  ['earring', 1],
  ['ring', 1],
];
const LINKE_PLAETZE: ReadonlyArray<[EquipSlot, number]> = [
  ['mainhand', 0],
  ['cloak', 0],
  ['glasses', 0],
];
const RECHTE_PLAETZE: ReadonlyArray<[EquipSlot, number]> = [
  ['head', 0],
  ['chest', 0],
  ['hands', 0],
  ['legs', 0],
  ['feet', 0],
];

/** Ein Zeichen je Platz, solange nichts darin liegt. */
/**
 * So viele Plätze hat die Fertigkeitenleiste.
 *
 * Sechs, weil die Zifferntasten 1 bis 6 ohne Umgreifen erreichbar sind. Die
 * Plätze sind noch leer — die Fertigkeiten kommen als Nächstes.
 */
const ACTION_SLOTS = 6;

const SLOT_GLYPHS: Partial<Record<EquipSlot, string>> = {
  head: '🪖',
  chest: '🎽',
  legs: '👖',
  feet: '🥾',
  hands: '🧤',
  mainhand: '⚔️',
  cloak: '🧣',
  glasses: '👓',
  necklace: '📿',
  earring: '💧',
  ring: '💍',
};

export type ConnectionState = 'verbindet' | 'verbunden' | 'getrennt';

/** So viele Zeilen behält das Chatfenster. */
const CHAT_HISTORY = 120;
/** Wie lange eine neue Zeile den eingeklappten Chat sichtbar hält. */
const CHAT_FLASH_MS = 6000;


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
  /** Der Sprungknopf auf dem Telefon. Dasselbe wie die Leertaste. */
  onJump?: () => void;
  /** Der Spieler will das Tor benutzen, in dem er steht. */
  onUsePortal?: () => void;
  /**
   * Anlegen. Angegeben wird der **Platz**, nicht die Kennung — zwei gleiche
   * Klingen mit verschiedener Aufwertung sind nicht mehr dasselbe Stück.
   */
  onEquipItem?: (slot: number) => void;
  /** Einen Verbrauchsgegenstand benutzen. */
  onUseItem?: (slot: number) => void;
  /** Einen Gegenstand im Beutel auf einen anderen Platz legen. */
  onMoveItem?: (from: number, to: number) => void;
  /** Zurück in die Charakterverwaltung. */
  onLeaveWorld?: () => void;
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
  /** Die gedrehte Figur oben im Inventar. */
  private readonly doll: DollView;
  /** Die Kästchen um die Figur, in der Reihenfolge von `LINKE_/RECHTE_PLAETZE`. */
  private readonly equipCells = new Map<string, HTMLElement>();
  private readonly characterWindow: GameWindow;
  private readonly characterStats: HTMLElement;
  /** Das Menü unten links und sein Knopf. */
  private readonly menuPanel: HTMLDivElement;
  private readonly menuButton: HTMLButtonElement;
  private readonly settingsWindow: GameWindow;
  /**
   * Die Konsole. Öffentlich, weil das ganze Spiel hineinschreibt — und weil
   * die zweite Meldungsstelle daneben (der Chat) etwas anderes ist: dort steht,
   * was den Spieler angeht, hier, was den Entwickler angeht.
   */
  readonly konsole: Konsole;

  private readonly dialogWindow: DialogWindow;
  private readonly questWindow: QuestLogWindow;
  private readonly shopWindow: ShopWindow;
  private readonly upgradeWindow: UpgradeWindow;
  /** Die Beschreibung unter dem Inventarraster, samt gezeigtem Platz. */
  private readonly itemDetail: HTMLElement;
  private detailSlot?: number;
  /**
   * Woher die Sprechblase kam: aus dem Beutel oder von der Figur.
   *
   * Als Angabe und nicht als Knoten. Ein gemerktes Element überlebt den
   * Neuaufbau des Rasters nicht — `replaceChildren` löst es heraus, sein
   * Rechteck wird null, und die Blase springt in die linke obere Ecke. Genau
   * das stand hier, und im Bild sah es aus wie ein Positionierungsfehler.
   */
  private detailFromDoll = false;
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

  constructor(
    host: HTMLElement,
    private readonly touch: boolean,
    registry: ModelRegistry,
  ) {
    this.host = host;
    // Die zuletzt eingestellte Größe gilt ab dem ersten Bild, nicht erst,
    // wenn jemand die Einstellungen aufmacht.
    setzeUiScale(ladeUiScale());
    // Die Anordnung hängt an der Bedienart, nicht an der Fensterbreite. Ein
    // Tablet quer ist zweitausend Pixel breit und wird trotzdem mit dem
    // Daumen bedient — eine Breitenabfrage hätte es als Schreibtisch
    // eingestuft und ihm die Schreibtischanordnung gegeben.
    host.dataset.touch = String(touch);

    // --- Werte ------------------------------------------------------------
    /*
     * Der Werte-Kasten im Flyff-Zuschnitt: Medaillon links, drei schmale
     * Balken rechts.
     *
     * Er war vorher fast so breit wie ein halber Bildschirm und dreizeilig,
     * und das ist für eine Anzeige, die man im Kampf mit einem Blick streift,
     * zu viel Fläche. Die Stufe steht jetzt im Medaillon statt in einer
     * eigenen Zeile — dieselbe Auskunft, keine zusätzliche Zeile —, und die
     * Balken sind halb so hoch.
     */
    const vitals = el('div', 'vitals panel');

    const medaillon = el('div', 'vitals-badge');
    this.levelLabel = el('span', 'vitals-level', '1');
    medaillon.append(this.levelLabel);

    const spalte = el('div', 'vitals-col');
    const head = el('div', 'vitals-head');
    this.nameLabel = el('span', 'vitals-name', '—');
    this.clockLabel = el('span', 'vitals-clock', '');
    head.append(this.nameLabel, this.clockLabel);
    spalte.append(head, this.hpBar.root, this.mpBar.root, this.expBar.root);

    vitals.append(medaillon, spalte);
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
      { left: window.innerWidth - 340, top: 100 },
      true,
    );
    /*
     * Der Aufbau wie bei Flyff: oben die Figur mit ihren Plätzen ringsum,
     * darunter der Beutel, darunter die Beschreibung.
     *
     * Die Plätze stehen links und rechts neben der Figur und nicht in einer
     * Reihe darüber. Das ist nicht bloss Nachbau: ein Platz neben der Figur
     * zeigt, *wo* das Teil hingehört, und genau das muss man beim Anlegen
     * wissen. Eine Reihe gleicher Kästchen könnte alles bedeuten.
     */
    this.doll = new DollView(registry);
    const puppe = el('div', 'doll');
    const linkeSpalte = el('div', 'doll-slots links');
    const rechteSpalte = el('div', 'doll-slots rechts');

    const obereReihe = el('div', 'doll-oben');
    for (const [slot, index] of OBERE_PLAETZE) {
      obereReihe.appendChild(this.equipSlot(slot, index));
    }
    for (const [slot, index] of LINKE_PLAETZE) {
      linkeSpalte.appendChild(this.equipSlot(slot, index));
    }
    for (const [slot, index] of RECHTE_PLAETZE) {
      rechteSpalte.appendChild(this.equipSlot(slot, index));
    }
    puppe.append(linkeSpalte, obereReihe, this.doll.canvas, rechteSpalte);

    this.inventoryGrid = el('div', 'inventory-grid');
    // Die Beschreibung sitzt unter dem Raster und ist leer, solange nichts
    // ausgewählt ist.
    this.itemDetail = el('div', 'item-detail');
    this.itemDetail.hidden = true;
    this.inventoryWindow.body.append(puppe, this.inventoryGrid);
    /*
     * Die Beschreibung schwebt und sitzt nicht mehr unter dem Raster.
     *
     * Am Wirt und nicht im Fenster: als Kind des Fensters wäre sie von dessen
     * Rand beschnitten, und genau darum geht es bei einer Sprechblase — sie
     * darf hinausragen. Ihre Stelle bekommt sie beim Klick, aus der Lage der
     * angeklickten Kachel.
     */
    this.itemDetail.classList.add('item-tooltip');
    host.appendChild(this.itemDetail);

    /*
     * Ein Klick daneben schliesst sie.
     *
     * „Daneben" heisst: nicht in der Blase und nicht auf einem *belegten*
     * Platz. Ein leeres Kästchen zählt damit als daneben — das ist der Fall,
     * den man beim Aufräumen im Beutel dauernd trifft, und eine Blase, die
     * dabei stehenbleibt, zeigt die Beschreibung von etwas, das man gar nicht
     * mehr ansieht.
     *
     * In der Erfassungsphase, damit sie auch dann schliesst, wenn das
     * angeklickte Element den Druck für sich behält.
     */
    document.addEventListener(
      'pointerdown',
      (ev) => {
        if (this.detailSlot === undefined) return;
        const ziel = ev.target as HTMLElement | null;
        if (ziel?.closest('.item-tooltip, [data-bag-slot]')) return;
        this.hideItemDetail();
      },
      true,
    );
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

    // --- Konsole ----------------------------------------------------------
    //
    // Früh angelegt und sofort umgeleitet: was beim Start schiefgeht, ist das
    // Interessanteste überhaupt, und eine Konsole, die erst nach dem Laden
    // zuhört, hat genau davon nichts.
    this.konsole = new Konsole(host);
    this.konsole.uebernehmeGlobales();

    // --- Fertigkeitenleiste -----------------------------------------------
    //
    // Unten in der Mitte, und vorerst leer: hier kommen die Fertigkeiten hin.
    // Die Fenster, die früher hier standen — Inventar, Charakter, Aufträge,
    // Chat —, sind ins Menü gewandert. Was man im Kampf drückt, gehört an
    // diesen Platz; was man einmal am Abend drückt, nicht.
    const actionbar = el('div', 'actionbar panel');
    for (let i = 0; i < ACTION_SLOTS; i++) {
      const platz = el('div', 'action-slot');
      platz.title = `Fertigkeitenplatz ${i + 1} — noch leer`;
      platz.append(el('span', 'key', String(i + 1)));
      actionbar.appendChild(platz);
    }
    host.appendChild(actionbar);

    // --- Menü unten links -------------------------------------------------
    //
    // Alles, was ein Fenster aufmacht, und alles um das Spiel herum. Eine
    // Leiste, in der Inventar neben Abmelden steht, macht aus beidem
    // dasselbe — und nimmt den Platz weg, an dem die Fertigkeiten hingehören.
    this.menuPanel = el('div', 'menu-panel panel');
    this.menuPanel.hidden = true;
    this.menuPanel.append(
      this.menuEntry('🎒', 'Inventar', 'I', () => this.inventoryWindow.toggle()),
      this.menuEntry('👤', 'Charakter', 'C', () => this.characterWindow.toggle()),
      this.menuEntry('📜', 'Aufträge', 'J', () => this.questWindow.toggle()),
      this.menuEntry('💬', 'Chat', '⏎', () => this.setChatOpen(!this.chatOpen)),
      this.menuEntry('⚙', 'Einstellungen', 'O', () => this.settingsWindow.toggle()),
      this.menuEntry('🐞', 'Konsole', 'K', () => this.konsole.fenster.toggle()),
      this.menuEntry('🚪', 'Abmelden', '', () => this.onLeaveWorld?.()),
    );
    host.appendChild(this.menuPanel);

    this.menuButton = el('button', 'btn menu-button', '☰');
    this.menuButton.type = 'button';
    this.menuButton.title = 'Menü (Esc)';
    this.menuButton.setAttribute('aria-label', 'Menü');
    this.menuButton.addEventListener('click', () => this.setMenuOpen(this.menuPanel.hidden));
    host.appendChild(this.menuButton);

    // Ein Druck daneben schliesst es. Ohne das bliebe es offen stehen, und
    // wer weiterspielen will, müsste erst den Knopf wiederfinden.
    window.addEventListener('pointerdown', (ev) => {
      if (this.menuPanel.hidden) return;
      const ziel = ev.target as Node | null;
      if (ziel && (this.menuPanel.contains(ziel) || this.menuButton.contains(ziel))) return;
      this.setMenuOpen(false);
    });

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

      // Springen. Ein eigener Knopf, weil es am Telefon keine Leertaste gibt —
      // und kleiner als der Angriffsknopf: gesprungen wird seltener, und der
      // Daumen soll im Gefecht nicht danebengreifen.
      const jump = el('button', 'jump-button', '⭡');
      jump.type = 'button';
      jump.title = 'Springen';
      jump.setAttribute('aria-label', 'Springen');
      jump.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        this.onJump?.();
      });
      host.appendChild(jump);
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

    // --- Darstellung -------------------------------------------------------
    //
    // Ein Regler für die ganze Oberfläche. Auf einem Telefon ist die
    // Voreinstellung für manche zu klein und für andere zu gross, und beides
    // ist eine Frage der Augen und nicht der Bildschirmgröße — also gehört es
    // in die Einstellungen und nicht in eine Medienabfrage.
    const bild = el('section', 'settings-group');
    bild.append(el('h3', 'settings-head', 'Darstellung'));

    const groesseRow = el('div', 'settings-slider');
    const groesseWert = el('span', 'settings-value', '100 %');
    const groesse = el('input');
    groesse.type = 'range';
    groesse.min = String(Math.round(UI_SCALE_MIN * 100));
    groesse.max = String(Math.round(UI_SCALE_MAX * 100));
    groesse.step = '5';
    groesse.setAttribute('aria-label', 'Größe der Oberfläche');
    groesse.value = String(Math.round(ladeUiScale() * 100));
    groesseWert.textContent = `${groesse.value} %`;
    groesse.addEventListener('input', () => {
      const gilt = setzeUiScale(Number(groesse.value) / 100);
      groesseWert.textContent = `${Math.round(gilt * 100)} %`;
    });

    const groesseKopf = el('div', 'settings-slider-head');
    groesseKopf.append(el('label', undefined, 'Größe der Oberfläche'), groesseWert);
    groesseRow.append(groesseKopf, groesse);
    bild.append(groesseRow);
    body.append(bild);

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

  /**
   * Klappt das Menü auf oder zu.
   *
   * Der Knopf trägt seinen Zustand als `data-open`, damit sich das Zeichen
   * drehen lässt — und damit von aussen ablesbar ist, was gerade gilt.
   */
  private setMenuOpen(offen: boolean): void {
    this.menuPanel.hidden = !offen;
    this.menuButton.dataset.open = String(offen);
  }

  /**
   * Ein Eintrag im Menü.
   *
   * Das Menü schliesst sich bei jedem Eintrag — man klappt es auf, um eine
   * Sache zu tun, nicht um darin zu wohnen. Die Tastenkürzel stehen dabei,
   * weil sie weiter gelten: wer sie kennt, braucht das Menü nicht mehr.
   */
  private menuEntry(
    icon: string,
    label: string,
    key: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = el('button', 'btn menu-entry');
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.append(el('span', 'menu-icon', icon), el('span', 'menu-label', label));
    if (key && !this.touch) button.append(el('span', 'key', key));
    button.addEventListener('click', () => {
      this.setMenuOpen(false);
      onClick();
    });
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
      else if (e.code === 'KeyK') this.konsole.fenster.toggle();
      else if (e.code === 'Escape') this.setMenuOpen(this.menuPanel.hidden);
      else if (e.code === 'Enter') {
        e.preventDefault();
        this.chatInput.focus();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Anzeigen
  // -------------------------------------------------------------------------

  /**
   * Eine Zeile in die Konsole.
   *
   * Der eine Weg dorthin — auch für Meldungen, die nebenbei in `console.log`
   * landen. Zwei Wege wären zwei Fassungen desselben Textes, und beim Suchen
   * eines Fehlers wüsste man nie, welche vollständig ist.
   */
  debug(text: string, art: LogArt = 'info'): void {
    this.konsole.schreibe(art, text);
  }

  setPlayerName(name: string): void {
    this.nameLabel.textContent = name;
  }

  setStats(stats: StatsMsg): void {
    this.lastStats = stats;
    // Das Gold steht im Laden — wer eben etwas verkauft hat, soll den neuen
    // Stand sehen, ohne das Fenster zu schliessen.
    this.shopWindow.setInventory(this.sellableItems(), stats.gold);
    this.upgradeWindow.setInventory(this.inventory, stats.gold);

    // Nur die Zahl: im Medaillon ist kein Platz für das Wort, und ein
    // Medaillon mit einer Zahl darin liest sich ohnehin als Stufe.
    this.levelLabel.textContent = String(stats.level);
    this.levelLabel.title = `Stufe ${stats.level}`;
    // Eine neue Stufe kann Aufträge freischalten — die Zeichen über den NPCs
    // hängen an der Stufe genauso wie am Auftragsstand.
    this.rebuildQuestMarks();
    this.setBar(this.hpBar, stats.hp, stats.maxHp, `${Math.round(stats.hp)} / ${stats.maxHp}`);
    this.setBar(this.mpBar, stats.mp, stats.maxMp, `${Math.round(stats.mp)} / ${stats.maxMp}`);

    const next = stats.expForNext === 0xffffffff ? 0 : stats.expForNext;
    const pct = next > 0 ? (stats.exp / next) * 100 : 100;
    this.setBar(this.expBar, stats.exp, next || 1, `${pct.toFixed(1)} %`);

    // Erst der Steckbrief, dann **alles**, was auf die Figur wirkt.
    //
    // Die Liste der Attribute steht nicht hier, sondern kommt vom Server:
    // eine abgeschriebene Aufzählung zeigt irgendwann sechs von acht Werten,
    // und die zwei fehlenden sind die, an denen das Gleichgewicht kippt.
    const zeilen: HTMLElement[] = [
      ...this.statRow('Stufe', String(stats.level)),
      ...this.statRow('Erfahrung', next > 0 ? `${stats.exp} / ${next}` : 'Höchststufe'),
      ...this.statRow('Leben', `${Math.round(stats.hp)} / ${stats.maxHp}`),
      ...this.statRow('Mana', `${Math.round(stats.mp)} / ${stats.maxMp}`),
      ...this.statRow('Gold', stats.gold.toLocaleString('de-DE')),
    ];

    for (const attribut of stats.attributes) {
      const def = attributeDef(attribut.id);
      // Unbekannte Kennung: dann eben die Kennung. Ein Attribut, das der
      // Server kennt und der Client nicht, soll sichtbar sein und nicht
      // verschluckt werden — es ist genau das neue, um das es gerade geht.
      const name = def?.name ?? attribut.id;
      const [dt, dd] = this.statRow(name, formatAttribute(attribut.id, attribut.gesamt));

      // Die Herkunft steht darunter, klein: Grundwert und jedes Stück, das
      // etwas beisteuert. Beim Ausbalancieren ist die Summe allein wertlos.
      if (attribut.quellen.length > 0) {
        const herkunft = [
          `Grundwert ${formatAttribute(attribut.id, attribut.basis)}`,
          ...attribut.quellen.map((q) => formatBeitrag(attribut.id, q)),
        ].join(' · ');
        dd.appendChild(el('span', 'stat-herkunft', herkunft));
        dt.title = def?.hinweis ?? '';
      } else if (def?.hinweis) {
        dt.title = def.hinweis;
      }
      zeilen.push(dt, dd);
    }

    this.characterStats.replaceChildren(...zeilen);
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

  /**
   * Ein Kästchen neben der Figur.
   *
   * Es ist Anzeige und Knopf zugleich: liegt etwas darin, legt ein Klick es
   * ab. Genau hier gehört das Ablegen hin — man zieht dort aus, wo man
   * anzieht, und die Kachel im Beutel bleibt vom versehentlichen Doppelklick
   * verschont.
   */
  private equipSlot(slot: EquipSlot, index: number): HTMLElement {
    const zelle = el('div', 'equip-slot');
    zelle.dataset.slot = slot;
    zelle.title = SLOT_NAMES[slot];
    zelle.appendChild(el('span', 'equip-glyph', SLOT_GLYPHS[slot] ?? '•'));
    this.equipCells.set(`${slot}:${index}`, zelle);
    return zelle;
  }

  /**
   * Füllt die Kästchen um die Figur.
   *
   * Was auf welchem Kästchen landet, folgt der Reihenfolge im Beutel — bei
   * zwei Ringen sitzt der erste angelegte oben. Eine eigene Ordnung dafür
   * wäre ein Feld mehr für eine Frage, die sich einmal im Monat stellt.
   */
  private fillEquipSlots(entries: InventoryEntry[]): void {
    const jePlatz = new Map<EquipSlot, InventoryEntry[]>();
    for (const entry of entries) {
      if (!entry.equipped) continue;
      const def = getItem(entry.itemId);
      if (!def || def.slot === 'none') continue;
      const liste = jePlatz.get(def.slot) ?? [];
      if (liste.length < slotCapacity(def.slot)) liste.push(entry);
      jePlatz.set(def.slot, liste);
    }

    for (const [key, zelle] of this.equipCells) {
      const [slotName, indexText] = key.split(':');
      const slot = slotName as EquipSlot;
      const entry = jePlatz.get(slot)?.[Number(indexText)];

      zelle.replaceChildren();
      zelle.dataset.filled = String(entry !== undefined);
      if (entry) zelle.dataset.bagSlot = String(entry.slot);
      else delete zelle.dataset.bagSlot;

      if (!entry) {
        zelle.appendChild(el('span', 'equip-glyph', SLOT_GLYPHS[slot] ?? '•'));
        zelle.title = SLOT_NAMES[slot];
        zelle.onclick = null;
        continue;
      }

      const def = getItem(entry.itemId);
      zelle.appendChild(itemIcon(def));
      if (entry.upgrade > 0) {
        zelle.appendChild(el('span', 'item-upgrade', `+${entry.upgrade}`));
      }
      zelle.title = def
        ? `${upgradeName(def, entry.upgrade)} — klicken zum Ablegen`
        : entry.itemId;
      // Klick legt ab. Dasselbe Paket wie das Anlegen: der Server entscheidet
      // anhand des Zustands, was gemeint ist.
      // Klick legt ab. Wer nur nachsehen will, was daran hängt, bekommt die
      // Beschreibung über die rechte Maustaste — dasselbe Fenster, an
      // derselben Stelle.
      zelle.onclick = () => this.onEquipItem?.(entry.slot);
      zelle.oncontextmenu = (ev) => {
        ev.preventDefault();
        this.showItemDetail(entry.slot, false, true);
      };
    }
  }

  /**
   * Wie die Figur im Inventar aussieht.
   *
   * Kommt aus dem Snapshot und wird **nicht** aus dem Beutel gerechnet. Der
   * Server baut das Aussehen ohnehin, um es an alle zu schicken; es hier ein
   * zweites Mal herzuleiten hiesse, zwei Wahrheiten darüber zu haben, was man
   * anhat — und die im eigenen Inventar wäre die falsche, sobald eine der
   * beiden Regeln sich ändert.
   */
  setDollAppearance(weapon: string, outfit: string, setGlow = 0): void {
    this.doll.setAppearance(weapon, outfit, setGlow);
  }

  /** Ein Bild der Figur im Inventar. Zeichnet nur bei offenem Fenster. */
  stepDoll(dt: number): void {
    this.doll.step(dt);
  }

  /** Zustand der Puppe — nur zum Nachsehen. */
  get dollState(): {
    bilder: number;
    rig: boolean;
    breite: number;
    hoehe: number;
    waffe: string | undefined;
    waffeGeliefert: boolean;
  } {
    return this.doll.zustand;
  }

  setInventory(entries: InventoryEntry[]): void {
    this.inventory = entries;
    this.shopWindow.setInventory(this.sellableItems(), this.lastStats?.gold ?? 0);
    this.upgradeWindow.setInventory(entries, this.lastStats?.gold ?? 0);

    // Wie viele Plätze das Raster hat, sagen die Stellschrauben — der Server
    // rechnet mit derselben Zahl. Vor dem Laden gibt es sie noch nicht: die
    // Oberfläche steht schon, bevor die erste Datei da ist. Dann bleibt das
    // Raster leer, und die erste Inventarnachricht baut es auf.
    if (!tuningLoaded()) {
      this.inventoryGrid.replaceChildren();
      return;
    }

    this.fillEquipSlots(entries);

    // Nur der Beutel. Angelegtes trägt eine Platznummer oberhalb des Rasters
    // — es hängt am Körper und nimmt hier keine Kachel weg. Wer voll
    // ausgerüstet war, hatte sonst ein Drittel weniger Beutel als jemand in
    // Unterhose.
    const bySlot = new Map(entries.filter((e) => !e.equipped).map((e) => [e.slot, e]));
    const slots: HTMLElement[] = [];
    const plaetze = tuning().economy.inventorySlots;
    for (let i = 0; i < plaetze; i++) {
      const entry = bySlot.get(i);
      const slot = el('div', 'item-slot');
      // Die Kachelnummer steht auf **jeder** Kachel, auch auf der leeren:
      // sie ist das Ziel beim Umsortieren. `data-bag-slot` gibt es weiter nur
      // dort, wo etwas liegt — daran hängen die Sprechblase und die Prüfungen.
      slot.dataset.slot = String(i);
      if (entry) slot.dataset.bagSlot = String(entry.slot);

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
      slot.title = def ? `${upgradeName(def, entry.upgrade)}\n${def.description}` : entry.itemId;

      if (equippable) slot.classList.add('item-equippable');

      // Ein **einfacher** Klick zeigt die Beschreibung. Vorher hing sie am
      // `title`-Attribut, und das gibt es auf einem Telefon nicht: dort liess
      // sich der Name eines Gegenstands schlicht nicht herausfinden.
      slot.addEventListener('click', () => {
        // Nach einem Zug ist der Klick nur das Nachspiel des Loslassens.
        if (this.zugGelaufen) return;
        this.showItemDetail(entry.slot);
      });
      // Der Doppelklick bleibt als Abkürzung am Schreibtisch. Auf Touch ist er
      // unzuverlässig — dort führt der Weg über den Knopf in der Beschreibung.
      if (equippable) {
        slot.addEventListener('dblclick', () => this.onEquipItem?.(entry.slot));
      }

      this.bindDrag(slot, entry.slot);
      slots.push(slot);
    }

    this.inventoryGrid.replaceChildren(...slots);
    // Die offene Beschreibung neu zeichnen: Anlegen und Aufwerten ändern
    // genau das, was darin steht.
    if (this.detailSlot !== undefined) {
      this.showItemDetail(this.detailSlot, true, this.detailFromDoll);
    }
  }

  /**
   * Gerade ein Zug beendet? Dann ist der Klick danach keiner.
   *
   * Ein Zeiger, der losgelassen wird, löst hinterher ein `click` aus — auch
   * dann, wenn er zwischendurch quer über das Raster gewandert ist. Ohne diese
   * Merke klappte nach jedem Umsortieren die Sprechblase auf.
   */
  private zugGelaufen = false;

  /**
   * Macht eine Kachel ziehbar.
   *
   * Mit Zeigerereignissen und nicht mit der Ziehschnittstelle des Browsers:
   * die gibt es auf dem Telefon nicht, und das Inventar wird dort mit dem
   * Daumen bedient.
   *
   * Der Unterschied zwischen den Geräten ist der Auslöser. Am Schreibtisch
   * beginnt der Zug, sobald die Maus ein paar Punkte weit gezogen hat. Auf dem
   * Telefon ist Wischen aber schon vergeben — damit scrollt der Beutel. Dort
   * beginnt er deshalb nach einem kurzen Halten, und wer vorher wischt, will
   * scrollen und bekommt seinen Scroll.
   */
  private bindDrag(zelle: HTMLElement, von: number): void {
    zelle.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      this.zugGelaufen = false;

      const maus = ev.pointerType === 'mouse';
      const startX = ev.clientX;
      const startY = ev.clientY;
      let ghost: HTMLElement | undefined;
      let halten: number | undefined;
      let markiert: Element | undefined;

      const setzeGhost = (x: number, y: number): void => {
        if (!ghost) return;
        ghost.style.left = `${x}px`;
        ghost.style.top = `${y}px`;
      };

      const beginne = (x: number, y: number): void => {
        if (ghost) return;
        const kasten = zelle.getBoundingClientRect();
        ghost = zelle.cloneNode(true) as HTMLElement;
        ghost.className = 'item-slot item-ghost';
        ghost.style.width = `${kasten.width}px`;
        ghost.style.height = `${kasten.height}px`;
        document.body.appendChild(ghost);
        zelle.classList.add('item-zieht');
        // Solange gezogen wird, scrollt der Beutel nicht mit. Danach schon —
        // deshalb hängt es an einer Klasse und nicht fest im Stil.
        this.inventoryGrid.classList.add('zieht');
        setzeGhost(x, y);
      };

      const markiere = (x: number, y: number): void => {
        const ziel = this.kachelUnter(x, y);
        if (ziel === markiert) return;
        markiert?.classList.remove('item-ziel');
        markiert = ziel ?? undefined;
        markiert?.classList.add('item-ziel');
      };

      const aufraeumen = (): void => {
        if (halten !== undefined) window.clearTimeout(halten);
        ghost?.remove();
        ghost = undefined;
        markiert?.classList.remove('item-ziel');
        markiert = undefined;
        zelle.classList.remove('item-zieht');
        this.inventoryGrid.classList.remove('zieht');
        window.removeEventListener('pointermove', bewegen);
        window.removeEventListener('pointerup', loslassen);
        window.removeEventListener('pointercancel', abbrechen);
      };

      const bewegen = (e: PointerEvent): void => {
        if (e.pointerId !== ev.pointerId) return;
        const weit = Math.hypot(e.clientX - startX, e.clientY - startY);

        if (!ghost) {
          if (maus && weit > 6) beginne(e.clientX, e.clientY);
          // Auf dem Telefon: wer wischt, bevor gehalten wurde, scrollt.
          else if (!maus && weit > 12) aufraeumen();
          return;
        }

        // Erst ab hier gehört die Geste uns.
        e.preventDefault();
        setzeGhost(e.clientX, e.clientY);
        markiere(e.clientX, e.clientY);
      };

      const loslassen = (e: PointerEvent): void => {
        if (e.pointerId !== ev.pointerId) return;
        const zog = ghost !== undefined;
        const ziel = zog ? this.kachelUnter(e.clientX, e.clientY) : undefined;
        const nach = ziel?.getAttribute('data-slot');
        aufraeumen();
        this.zugGelaufen = zog;
        if (nach !== null && nach !== undefined && Number(nach) !== von) {
          this.onMoveItem?.(von, Number(nach));
        }
      };

      // Der Browser bricht den Zeiger ab, sobald er die Geste selbst
      // übernimmt — etwa zum Scrollen. Dann ist der Zug vorbei, und zwar ohne
      // Ergebnis.
      const abbrechen = (e: PointerEvent): void => {
        if (e.pointerId !== ev.pointerId) return;
        aufraeumen();
      };

      window.addEventListener('pointermove', bewegen, { passive: false });
      window.addEventListener('pointerup', loslassen);
      window.addEventListener('pointercancel', abbrechen);

      if (!maus) halten = window.setTimeout(() => beginne(startX, startY), 300);
    });
  }

  /** Welche Beutelkachel liegt an dieser Bildstelle? */
  private kachelUnter(x: number, y: number): Element | undefined {
    const treffer = document.elementFromPoint(x, y)?.closest('.item-slot');
    return treffer instanceof HTMLElement && treffer.dataset.slot !== undefined
      ? treffer
      : undefined;
  }

  /**
   * Zeigt die Beschreibung eines Gegenstands unter dem Raster.
   *
   * Unter dem Raster und nicht als schwebende Sprechblase: eine Blase müsste
   * sich um Bildschirmränder kümmern, und auf einem Telefon deckt sie das
   * halbe Inventar zu. Ein fester Platz ist langweiliger und funktioniert
   * überall gleich.
   */
  /** Schliesst die Sprechblase. */
  private hideItemDetail(): void {
    this.detailSlot = undefined;
    this.detailFromDoll = false;
    this.itemDetail.replaceChildren();
    this.itemDetail.hidden = true;
  }

  private showItemDetail(slot: number, behalten = false, ausDerFigur = false): void {
    const entry = this.inventory.find((e) => e.slot === slot);
    // Nochmal auf dieselbe Kachel: zuklappen. Auf dem Telefon ist das der
    // einzige naheliegende Weg, die Beschreibung wieder loszuwerden.
    if (!entry || (!behalten && this.detailSlot === slot)) {
      this.hideItemDetail();
      return;
    }

    const def = getItem(entry.itemId);
    if (!def) return;

    this.detailSlot = slot;
    this.detailFromDoll = ausDerFigur;
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
    // Lebens- und Manazuschlag: der einzige Grund, einen Ring anzulegen. Er
    // ist an der Figur nicht zu sehen, also muss er hier stehen.
    if (def.maxHp > 0) werte.push(`Leben +${def.maxHp}`);
    if (def.maxMp > 0) werte.push(`Mana +${def.maxMp}`);
    if (def.critChance > 0) werte.push(`Kritisch +${Math.round(def.critChance * 100)} %`);
    if (def.effectValue > 0) werte.push(`Wirkung ${def.effectValue}`);
    if (def.levelReq > 1) werte.push(`ab Stufe ${def.levelReq}`);
    werte.push(`Wert ${def.value} G`);
    if (werte.length > 0) teile.push(el('div', 'detail-stats', werte.join(' · ')));

    const satz = this.setLines(def.id);
    if (satz) teile.push(satz);

    teile.push(el('p', 'detail-text', def.description));

    if (def.kind === 'consumable') {
      const benutzen = el('button', 'btn', 'Benutzen');
      benutzen.type = 'button';
      benutzen.addEventListener('click', () => this.onUseItem?.(entry.slot));
      teile.push(benutzen);
    } else if (entry.equipped) {
      // Ablegen steht dort, wo vorher nur „Angelegt" stand. Ein Zustand ohne
      // Ausweg ist keine Auskunft, sondern eine Sackgasse.
      const ablegen = el('button', 'btn', 'Ablegen');
      ablegen.type = 'button';
      ablegen.addEventListener('click', () => this.onEquipItem?.(entry.slot));
      teile.push(ablegen);
    } else if (def.slot !== 'none') {
      const anlegen = el('button', 'btn', 'Anlegen');
      anlegen.type = 'button';
      anlegen.addEventListener('click', () => this.onEquipItem?.(entry.slot));
      teile.push(anlegen);
    }

    this.itemDetail.replaceChildren(...teile);
    this.placeTooltip(slot);
  }

  /**
   * Der Satzblock in der Sprechblase — oder nichts, wenn das Stück zu keinem
   * Satz gehört.
   *
   * Zeigt an, wie viele Teile sitzen, was der Satz gibt, und ab wann er
   * leuchtet. Gerechnet wird aus dem Beutel, weil nur er weiss, was angelegt
   * ist; **gelten** tut, was der Server rechnet. Das ist keine zweite Wahrheit,
   * sondern eine Vorschau derselben Regel aus `activeArmorSet` — dieselbe
   * Funktion, dieselbe Inhaltsdatei.
   */
  private setLines(itemId: string): HTMLElement | undefined {
    const satz = setOfItem(itemId);
    if (!satz) return undefined;

    const getragen = this.inventory
      .filter((e) => e.equipped)
      .map((e) => ({ itemId: e.itemId, upgrade: e.upgrade }));
    const wieViele = setProgress(satz, getragen);
    const voll = wieViele === satz.pieces.length;

    const block = el('div', 'detail-set');
    if (voll) block.classList.add('aktiv');
    block.append(el('div', 'detail-set-name', `${satz.name} (${wieViele}/${satz.pieces.length})`));

    const b = satz.bonus;
    const werte: string[] = [];
    if (b.attackDamage > 0) werte.push(`Angriff +${b.attackDamage}`);
    if (b.defense > 0) werte.push(`Verteidigung +${b.defense}`);
    if (b.maxHp > 0) werte.push(`Leben +${b.maxHp}`);
    if (b.maxMp > 0) werte.push(`Mana +${b.maxMp}`);
    if (b.critChance > 0) werte.push(`Kritisch +${Math.round(b.critChance * 100)} %`);
    if (werte.length > 0) block.append(el('div', 'detail-set-bonus', `Satzbonus: ${werte.join(' · ')}`));

    // Das Leuchten hängt am schwächsten Teil — deshalb steht hier dessen Stufe
    // und nicht die des Stücks, auf das gerade geklickt wurde.
    const schwelle = glowFrom();
    if (voll) {
      let min = Infinity;
      for (const teil of satz.pieces) {
        for (const stueck of getragen) {
          if (stueck.itemId === teil) min = Math.min(min, stueck.upgrade);
        }
      }
      const stufe = Math.max(0, min);
      block.append(
        el(
          'div',
          'detail-set-glow',
          stufe >= schwelle
            ? `Leuchtet — schwächstes Teil +${stufe}`
            : `Leuchtet, sobald jedes Teil +${schwelle} trägt (jetzt +${stufe})`,
        ),
      );
    }

    return block;
  }

  /**
   * Stellt die Sprechblase neben die angeklickte Kachel.
   *
   * Bevorzugt rechts daneben, sonst links; senkrecht so weit verschoben, dass
   * sie ganz im Bild bleibt. Ohne dieses Zurechtrücken hängt sie bei einer
   * Kachel am rechten Rand zur Hälfte draussen — und das Inventar steht dort
   * fast immer.
   */
  private placeTooltip(slot: number): void {
    // Das Element frisch suchen statt einen Verweis aufzuheben: nach jedem
    // Inventarwechsel ist das Raster neu gebaut, und der alte Knoten hängt
    // nirgends mehr.
    const wo = this.detailFromDoll ? '.equip-slot' : '.item-slot';
    const anker = this.host.querySelector<HTMLElement>(`${wo}[data-bag-slot="${slot}"]`);
    if (!anker) return;

    const kachel = anker.getBoundingClientRect();
    if (kachel.width === 0) return;
    const blase = this.itemDetail.getBoundingClientRect();
    const rand = 8;

    // Gegen das **sichtbare** Fenster rechnen. `innerHeight` zählt auf dem
    // Telefon die Fläche unter der Adressleiste mit; quer gehalten sind das
    // gut fünfzig Bildpunkte, und genau dort landete der untere Rand der
    // Blase — festgehalten von einer Prüfung, die „liegt im Bild" gegen
    // dieselbe zu grosse Zahl gemessen hat.
    const sicht = window.visualViewport;
    const bildBreite = sicht?.width ?? window.innerWidth;
    const bildHoehe = sicht?.height ?? window.innerHeight;

    let links = kachel.right + 10;
    if (links + blase.width > bildBreite - rand) {
      links = kachel.left - blase.width - 10;
    }
    links = Math.max(rand, Math.min(links, bildBreite - blase.width - rand));

    let oben = kachel.top;
    oben = Math.max(rand, Math.min(oben, bildHoehe - blase.height - rand));

    this.itemDetail.style.left = `${Math.round(links)}px`;
    this.itemDetail.style.top = `${Math.round(oben)}px`;
  }

  /**
   * Namensschilder, Auswahlrahmen, Beuteschilder und Zahlen weiterschieben.
   *
   * `ziel` ist das anvisierte Wesen selbst und nicht nur seine Kennung: der
   * Rahmen braucht Lage und Höhe, und eine zweite Suche danach in der Liste
   * wäre eine zweite Gelegenheit, ein anderes zu finden als das Spiel meint.
   */
  updateOverlay(
    camera: THREE.PerspectiveCamera,
    entities: Iterable<EntityVisual>,
    localId: number,
    ziel: { entity: EntityVisual | undefined; kampf: boolean },
    dt: number,
    loot?: { piles: Iterable<{ row: LootRow }>; label: (row: LootRow) => string },
  ): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.overlay.updateNameplates(
      camera,
      entities,
      localId,
      ziel.entity?.id ?? 0,
      width,
      height,
      this.questMarks,
    );
    this.overlay.updateZielrahmen(camera, ziel.entity, ziel.kampf, width, height);
    if (loot) {
      this.overlay.updateLootLabels(camera, loot.piles, loot.label, width, height);
    }
    this.overlay.updateNumbers(camera, dt, width, height);
  }

  get chatHasFocus(): boolean {
    return document.activeElement === this.chatInput;
  }
}
