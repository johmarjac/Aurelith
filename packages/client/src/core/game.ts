/**
 * Der Client als Ganzes.
 *
 * Hier laufen die vier Stränge zusammen: der wasm-Kern für die Vorhersage,
 * der Streamer für die Inhalte, der Renderer für das Bild und die Verbindung
 * für die Wahrheit. Es ist die einzige Datei, die alle vier kennt.
 *
 * Zwei Takte:
 *
 *   **Simulationstakt (20 Hz).** Eingabe lesen, in den Kern geben, einen
 *   Schritt rechnen, das Kommando an den Server schicken und im Verlauf
 *   merken. Feste Schrittweite, sonst rechnet die Vorhersage anders als die
 *   Autorität.
 *
 *   **Bildtakt (so oft der Browser mag).** Interpolieren, Rig-Posen setzen,
 *   Kamera nachführen, zeichnen.
 *
 * Die Vorhersage betrifft **nur die eigene Bewegung**. Schaden, Tod und Beute
 * kommen ausschließlich vom Server — vorhergesagter Schaden, der später
 * zurückgenommen werden muss, ist schlimmer als Schaden, der einen Wimpernschlag
 * später erscheint.
 */

import * as THREE from 'three';
import { CoreButton, type CoreEntityRow, type CoreWorld } from '@aurelith/core';
import {
  ChatChannel,
  normalisiereLeiste,
  type InventoryRow,
  angleDelta,
  CombatFlag,
  EntityState,
  EntityType,
  playerProfile,
  TICK_MS,
  TICK_SECONDS,
  attackProfileFor,
  EmoteKind,
  clockText,
  formatBuild,
  getItem,
  getMob,
  getSkill,
  loadContent,
  tuning,
  type AttackProfile,
  type LootRow,
  parseMapDocument,
  type MapDocument,
  type StatsMsg,
  terrainSetup,
} from '@aurelith/shared';
import { DayCycle } from '../render/daycycle.ts';
import {
  BUILD_STAMP,
  QUALITY,
  checkServerUrl,
  guessQuality,
  isServerConfigured,
  isTouchDevice,
  serverUrl,
  setStoredServerUrl,
  storedServerUrl,
} from '../config.ts';
import { AssetStreamer } from '../assets/streamer.ts';
import { loadClientCore, type ClientCore } from './coreLoader.ts';
import { Scene3D } from '../render/scene.ts';
import { ModelRegistry } from '../render/modelRegistry.ts';
import { ATTACK_ANIM_SECONDS, WorldView, type EntityVisual } from '../render/worldView.ts';
import { burstHit, burstWirbel } from '../render/particles.ts';
import { TextureLoader } from '../render/textures.ts';
import { InputManager } from '../input/input.ts';
import { Mixer } from '../audio/mixer.ts';
import { PRELOAD, SOUNDS, WEAPON_SWING, type SoundDef } from '../audio/sounds.ts';
import { Connection } from '../net/connection.ts';
import { UI } from '../ui/index.ts';
import { LobbyView } from '../ui/lobby.ts';

/** Ab dieser Abweichung wird die Vorhersage hart korrigiert. */
const RECONCILE_THRESHOLD = 1.2;
/** So viele Eingaben werden für das Nachspielen aufbewahrt. */
const MAX_PENDING_INPUTS = 60;
/**
 * So viele Snapshots werden waehrend eines Kartenwechsels aufgehoben.
 *
 * Zwei Sekunden bei zehn Snapshots je Sekunde. Dauert ein Ladevorgang laenger,
 * ist der aelteste Stand ohnehin ueberholt.
 */
const MAX_QUEUED_SNAPSHOTS = 20;

/** Ein Klick trifft ein Entity, wenn es näher als das am Zeiger liegt. */
const PICK_RADIUS_PX = 70;
/**
 * So nah gilt eine angeklickte Stelle als erreicht.
 *
 * Grosszügiger als es aussieht, und das mit Absicht: der Boden ist uneben, und
 * eine Figur, die den letzten halben Meter noch aushandelt, zappelt auf der
 * Stelle, statt anzukommen.
 */
const GEH_ANKUNFT = 0.7;
/**
 * Wie viel näher als nötig die Figur an ihr Ziel läuft, um zuzuschlagen.
 *
 * Der Kern prüft `Abstand − Zielradius ≤ Reichweite`, und zwar mit **seiner**
 * Lage der Figur; die Vorhersage ist ihm um die Laufzeit voraus. Wer die
 * Reichweite ausreizt, steht aus Sicht des Servers einen Wimpernschlag zu weit
 * weg — die Figur schlägt dann sichtbar zu, und nichts passiert.
 *
 * Dieselbe Zahl benutzt die Monster-KI im Kern (`kPreferredGap`), aus
 * demselben Grund: wer genau am Rand stehenbleibt, fällt bei der kleinsten
 * Bewegung wieder heraus.
 */
const KAMPF_LUFT = 0.4;
/** Ohne bekannten Zielradius: der Vorgabewert der Inhaltstabelle. */
const MOB_RADIUS_FALLBACK = 0.6;
/** Schrittweite und Weite der Bodensuche für den Klick ins Gelände. */
/**
 * Schrittweite der Sichtprüfung, in Weltenheiten.
 *
 * Gröber als beim Suchen des Bodens: dort wird ein Punkt gesucht, hier nur
 * beantwortet, ob etwas dazwischensteht. Ein Berg, der auf einen Meter genau
 * verfehlt würde, ist kein Berg.
 */
const SICHT_SCHRITT = 1;
/**
 * Wie tief ein Punkt unter dem Gelände liegen darf, ohne als verdeckt zu
 * gelten. Fängt die Ungenauigkeit zwischen zwei Schritten auf — ohne sie
 * verdeckte jede Bodenwelle, über die man hinwegsieht.
 */
const SICHT_LUFT = 0.35;

const BODEN_SCHRITT = 0.5;
const BODEN_WEITE = 260;

/**
 * Was die Figur gerade von selbst tut.
 *
 * Drei Sorten, ein Feld: hingehen, aufheben, angreifen. Als getrennte Felder —
 * ein Beuteziel hier, ein Kampfziel dort — gäbe es Zustände, in denen zwei
 * Absichten gleichzeitig gelten, und die Figur liefe zum Haufen, während sie
 * ein Monster schlagen will. Ein neuer Auftrag löst den alten ab, jede
 * eigene Bewegung wirft ihn weg.
 *
 * Die **Auswahl** (`targetId`) ist davon unabhängig und überlebt das Ende
 * eines Auftrags: wer wegläuft, hat sein Monster immer noch anvisiert.
 */
type Auftrag =
  | { art: 'gehen'; x: number; z: number }
  | { art: 'beute'; lootId: number }
  | { art: 'kampf'; entityId: number };
/**
 * So lange wartet `/version` auf die Antwort des Servers.
 *
 * Grosszügig gegenüber einer langsamen Leitung und trotzdem kurz genug, dass
 * niemand glaubt, der Befehl sei verschluckt worden.
 */
const VERSION_TIMEOUT_MS = 4000;
/**
 * So viel der Aufhebereichweite nutzt der Client — der Rest ist Luft für den
 * Abstand zwischen Vorhersage und Server. Siehe `inPickupRange`.
 */
const PICKUP_SICHERHEIT = 0.6;

interface PendingInput {
  seq: number;
  moveX: number;
  moveZ: number;
  yaw: number;
  buttons: number;
  x: number;
  z: number;
}

/** Lage der eigenen Figur zu einem Simulationsschritt. */
interface LocalPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
}

function copyPose(from: LocalPose, to: LocalPose): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
  to.yaw = from.yaw;
  to.speed = from.speed;
}

/**
 * Lesender Blick auf den Clientzustand, unter `window.aurelith`.
 *
 * Ein Vorbehalt: fortgeschrieben wird am Ende eines Bildes. Steht die
 * Renderschleife — etwa weil der Tab im Hintergrund liegt —, steht auch diese
 * Auskunft. Was trotzdem weiterläuft (Verbindung, Lebenszeichen), ist an der
 * Statusanzeige abzulesen, die die Verbindung selbst setzt.
 *
 * Ausschließlich Anzeige — nichts hier verändert etwas, und der Server glaubt
 * dem Client ohnehin nichts. Der Nutzen ist Prüfbarkeit: Kamerastand und die
 * *gezeichnete* Position der Figur lassen sich sonst von außen nicht ansehen,
 * und genau daran hingen die drei Fehler, die man im Bild sieht, aber in
 * keinem Typecheck.
 */
export interface Diagnostics {
  camera: { yaw: number; pitch: number; distance: number };
  /** Gezeichnete Lage — mit Zwischenwerten. */
  player: { x: number; y: number; z: number; yaw: number; speed: number };
  /**
   * Roher Stand des letzten Simulationsschritts, ohne Zwischenwerte.
   *
   * Der Vergleich mit `player` ist der einzige bildratenunabhängige Nachweis,
   * dass zwischen den Schritten überhaupt interpoliert wird: laufen beide
   * gleich, wird nicht interpoliert, und die Figur zuckt im Takt der
   * Simulation.
   */
  playerSim: { x: number; y: number; z: number; yaw: number };
  /** Zuletzt gelesene Eingabe. Zeigt, ob Tastatur oder Joystick ankommen. */
  input: { moveX: number; moveZ: number; yaw: number };
  /**
   * Was die Figur von sich aus tut — Auftrag, Ziel, Schlag.
   *
   * Die Angriffstaste taugt seit dem Zielsystem nicht mehr als Auskunft: sie
   * ist ein Druck und kein Zustand. Was man von aussen sehen will, ist, ob
   * gerade ein Kampf läuft und ob in diesem Schritt zugeschlagen wird — und
   * das steht nirgends sonst.
   */
  auftrag: { art: string; zielId: number; angriff: boolean };
  /** Simulationsschritte seit dem Start. */
  ticks: number;
  /**
   * Die Aktionsleiste, wie der Server sie zuletzt gemeldet hat.
   *
   * Von aussen sonst nur mit dem Auge zu prüfen — und zwei der Regeln daran
   * sind gerade solche, die man beim Hinsehen für erfüllt hält: dass die
   * Belegung ein Abmelden übersteht, und dass ein vernichteter Gegenstand vom
   * Platz verschwindet.
   */
  aktionsleiste: { art: number; id: string }[];
  /**
   * Der Beutel, wie er zuletzt gemeldet wurde.
   *
   * Von aussen ist eine Inventarkachel nur an ihrer Nummer zu erkennen, und
   * welche Nummer der Trank hat, weiss allein diese Liste. Ohne sie müsste
   * eine Prüfung raten, worauf sie klickt.
   */
  inventar: { itemId: string; slot: number; count: number; equipped: boolean }[];
  /**
   * Die Laufmarke — jeder ihrer Punkte und der Boden darunter.
   *
   * Sie liegt auf dem Gelände oder sie liegt darin, und der Unterschied ist im
   * Bild ein fehlender halber Ring. Von aussen ist das sonst nur mit dem Auge
   * zu prüfen; hier steht es als Zahl. `boden` ist die Höhe der
   * **gezeichneten** Fläche an dieser Stelle — die Fläche, die den Ring
   * verdeckt, wenn er darunter liegt.
   *
   * `kern` daneben ist die **gerechnete** Höhe desselben Punktes. Die beiden
   * auseinanderzuhalten ist der ganze Witz: an ihrem Unterschied hing der
   * verschwundene Ring, und eine Prüfung, die nur eine von beiden kennt, kann
   * ihn nicht wiederfinden.
   */
  laufmarke: {
    sichtbar: boolean;
    /** Boden in der Mitte der Marke. Zeigt, wie schief die Stelle ist. */
    mitte: number;
    punkte: { x: number; y: number; z: number; boden: number; kern: number }[];
  };
  /**
   * Welche gelieferten Waffenmodelle angekommen sind.
   *
   * Nicht zur Anzeige, sondern zur Unterscheidung: eine Figur mit Platzhalter
   * und eine mit Modell sehen im Bild verschieden aus, im Zustand aber gleich.
   */
  weaponModels: string[];
  /**
   * Zustand der Tonwiedergabe.
   *
   * „Es kommt kein Ton" hat zu viele moegliche Ursachen, um sie einzeln
   * durchzuprobieren. Hier steht, wie weit es gekommen ist.
   */
  audio: {
    state: string;
    contextState: string;
    sampleRate: number;
    geladen: string[];
    dekodiert: string[];
  };
  /**
   * Wie oft die Vorhersage hart zurechtgerückt werden musste.
   *
   * Sichtbar als Zurückspringen der eigenen Figur. Im Idealfall null: Client
   * und Server rechnen dieselbe wasm-Binärdatei auf denselben Eingaben, es gibt
   * also nichts, worin sie sich unterscheiden könnten — ausser darin, dass eine
   * Eingabe unterwegs verlorengeht oder der Server sie verwirft.
   */
  reconciles: number;
  /** Grösste Abweichung, die dabei je gemessen wurde, in Weltnenheiten. */
  maxReconcileError: number;
  /**
   * Abstand zwischen der vorhergesagten und der vom Server gemeldeten Lage.
   *
   * Der ehrlichere Wert von beiden. `maxReconcileError` wird nur berechnet,
   * wenn sich zu einer Bestätigung ein Anker im Verlauf findet — bleiben die
   * Bestätigungen aus, weil der Server die Eingaben gar nicht annimmt, schweigt
   * er und meldet null, während die Figur im Bild längst woanders steht als in
   * der Welt. Genau so ist ein Fehler nach einem Kartenwechsel unbemerkt
   * geblieben.
   *
   * Ein kleiner Abstand ist normal: die Vorhersage ist um die Laufzeit voraus,
   * bei dreissig Millisekunden und Tempo sechs also gut ein Fünftel einer
   * Einheit. Wächst er darüber hinaus, laufen beide Seiten auseinander.
   */
  serverDistance: number;
  /** Ist die Vorhersagewelt aufgebaut? Ohne sie laeuft kein Schritt. */
  hasPrediction: boolean;
  /**
   * Trägt die Vorhersage die eigene Figur schon?
   *
   * Zwischen der Willkommensnachricht und dem ersten Snapshot gibt es ein
   * Fenster, in dem `localId` bereits steht, die Figur in der Vorhersagewelt
   * aber noch fehlt. Alles, was von ihrer Lage abhängt — die gezeichnete
   * Position, der Hinweis auf ein Tor, die Kamera — steht darin auf dem
   * Ausgangswert. Nach einem Kartenwechsel dasselbe.
   */
  predictionReady: boolean;
  hasConnection: boolean;
  mapId: string;
  localId: number;
  entityCount: number;
  /** Wie viele Beutehaufen gerade in Sichtweite liegen. */
  lootCount: number;
  /**
   * Entfernung zum nächsten Haufen. Unendlich, wenn keiner liegt.
   *
   * Die Zahl, an der man von aussen sieht, ob der automatische Weg zu einem
   * angeklickten Haufen tatsächlich zurückgelegt wird — „die Figur bewegt
   * sich" allein sagt nichts darüber, wohin.
   */
  lootNearest: number;
  /**
   * Der Stand des Tageszyklus, gerundet.
   *
   * Helligkeit lässt sich rechnen, aber nicht ansehen — und umgekehrt sieht
   * man einem Bild nicht an, ob es dunkel *gerechnet* oder dunkel *gefärbt*
   * ist. Genau daran hing der Fehler, dass nachts das Umgebungslicht die
   * Farbe der Kuppel bekam und damit schwarz war.
   */
  /** Zustand der Figur im Inventar — zeichnet sie überhaupt? */
  doll: { bilder: number; rig: boolean; breite: number; hoehe: number };
  sky: {
    uhr: string;
    dunkelheit: number;
    sonne: number;
    umgebung: number;
    /** Farbe des Umgebungslichts — nicht die der Kuppel. */
    lichtfarbe: string;
    kuppelfarbe: string;
  };
  targetId: number;
  connection: string;
  latencyMs: number;
  frames: number;
  /** Bilder je Sekunde, über ein halbes Sekundenfenster gemittelt. */
  fps: number;
}

declare global {
  // eslint-disable-next-line no-var
  var aurelith: Diagnostics | undefined;
}

export class Game {
  private readonly scene: Scene3D;
  private readonly registry = new ModelRegistry();
  private readonly view: WorldView;
  private readonly ui: UI;
  /** Anmeldung und Figurenauswahl. Liegt über der Welt, bis eine Figur drin ist. */
  private readonly lobby: LobbyView;
  private readonly input: InputManager;
  private readonly streamer = new AssetStreamer();
  private readonly textures: TextureLoader;
  private readonly quality = QUALITY[guessQuality()];
  private readonly mixer = new Mixer();
  /** Tag und Nacht. Läuft nach der Serveruhr, nicht nach der des Geräts. */
  private readonly dayCycle = new DayCycle();
  /**
   * Was gerade angelegt ist, als sortierte Kennungsliste.
   *
   * `undefined` heißt: noch nie ein Inventar gesehen. Die erste Nachricht
   * setzt nur den Ausgangswert und klingt nicht — sonst begrüßte einen das
   * Spiel beim Betreten mit einem Waffenwechsel, den niemand vorgenommen hat.
   */
  private equipped?: string;

  private core?: ClientCore;
  private connection?: Connection;

  /** Welt allein für die Vorhersage: nur die eigene Figur und die Kollider. */
  private prediction?: CoreWorld;
  private predictionRows: CoreEntityRow[] = [];
  private mapDoc?: MapDocument;

  private localId = 0;
  /** Name der Figur, mit der man spielt — kommt aus der Verwaltung. */
  private playerName = '';
  /** Was das angemeldete Konto darf. Nur für die Anzeige; geprüft wird am Server. */
  private accessLevel = 0;
  private inputSeq = 0;
  private pending: PendingInput[] = [];
  private targetId = 0;
  private dead = false;
  /** Das Tor, in dem die Figur gerade steht. Nur Anzeige — der Server prüft. */
  private nearbyPortalId?: string;

  /**
   * Angriffsprofil der eigenen Figur, aus der angelegten Waffe.
   *
   * Dieselbe Rechnung wie auf dem Server (`attackProfileFor`) — beide lesen
   * dieselbe Tabelle. Der Client braucht es für die Vorhersage und fürs
   * Zielen, der Server für den Schaden.
   */
  private profile!: AttackProfile;

  /**
   * Wie weit die Serveruhr von der des Geräts abweicht, in Millisekunden.
   *
   * Daran hängt die Tageszeit. Sie aus `Date.now()` zu nehmen wäre einfacher
   * und falsch: zwei Spieler nebeneinander hätten verschiedene Tageszeiten,
   * und wer seine Systemuhr verstellt, hätte Mittag, wenn alle anderen Nacht
   * haben. Geglättet, damit ein einzelner verspäteter Snapshot die Sonne nicht
   * springen lässt.
   */
  private clockOffset = 0;
  private clockSeen = false;

  /** Zuletzt vom Server gemeldete Lage der eigenen Figur. Nur zur Auskunft. */
  private serverX = 0;
  private serverZ = 0;
  private serverSeen = false;

  /** Laeuft gerade ein Kartenwechsel? Dann warten Snapshots. */
  private mapLoad?: Promise<void>;
  private loadingMapId?: string;
  private queuedSnapshots: Parameters<Game['applySnapshot']>[0][] = [];
  private stats?: StatsMsg;

  /**
   * Bildzähler für die Anzeige.
   *
   * Gemessen über ein halbes Sekundenfenster statt über den Kehrwert des
   * letzten Bildabstands: einzelne Bilder schwanken um ein Vielfaches, und
   * eine Zahl, die zwischen 40 und 200 springt, sagt weniger als gar keine.
   */
  private fpsFenster = 0;
  private fpsBilder = 0;

  private accumulator = 0;
  private lastFrameAt = 0;
  private running = false;

  /**
   * Lage der eigenen Figur vor und nach dem letzten Simulationsschritt.
   *
   * Die Simulation läuft mit 20 Hz, gezeichnet wird mit 60 und mehr. Ohne
   * Zwischenwerte steht die Figur zwei von drei Bildern still und springt im
   * dritten — genau das Zittern, das fremde Figuren nicht haben, weil die
   * ohnehin zwischen Snapshots interpoliert werden.
   */
  private readonly posePrev: LocalPose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0 };
  private readonly poseCurr: LocalPose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0 };
  /** Falsch, solange keine zwei Schritte vorliegen oder gerade gesprungen wurde. */
  private poseValid = false;

  private readonly projection = new THREE.Vector3();
  /** Für den Klick ins Gelände — siehe `bodenPunkt`. */
  private readonly strahl = new THREE.Raycaster();
  private readonly zeiger = new THREE.Vector2();

  private readonly diagnostics: Diagnostics = {
    camera: { yaw: 0, pitch: 0, distance: 0 },
    player: { x: 0, y: 0, z: 0, yaw: 0, speed: 0 },
    playerSim: { x: 0, y: 0, z: 0, yaw: 0 },
    input: { moveX: 0, moveZ: 0, yaw: 0 },
    auftrag: { art: 'nichts', zielId: 0, angriff: false },
    ticks: 0,
    laufmarke: { sichtbar: false, mitte: 0, punkte: [] },
    aktionsleiste: [],
    inventar: [],
    weaponModels: [],
    audio: { state: 'wartet', contextState: 'kein Kontext', sampleRate: 0, geladen: [], dekodiert: [] },
    reconciles: 0,
    maxReconcileError: 0,
    serverDistance: 0,
    hasPrediction: false,
    predictionReady: false,
    hasConnection: false,
    mapId: '',
    localId: 0,
    entityCount: 0,
    lootCount: 0,
    lootNearest: Infinity,
    doll: { bilder: 0, rig: false, breite: 0, hoehe: 0 },
    sky: { uhr: '', dunkelheit: 0, sonne: 0, umgebung: 0, lichtfarbe: '', kuppelfarbe: '' },
    targetId: 0,
    connection: 'getrennt',
    latencyMs: 0,
    frames: 0,
    fps: 0,
  };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    uiHost: HTMLElement,
  ) {
    const touch = isTouchDevice();
    this.scene = new Scene3D(canvas, this.quality);
    // Texturen kommen ueber den Streamer, nicht ueber Three.js — mit Version im
    // Query-String und ohne dass ein fehlendes Asset die Sitzung beendet.
    this.textures = new TextureLoader((path) => this.streamer.request(path));
    this.view = new WorldView(
      this.registry,
      this.textures,
      this.scene.renderer.capabilities.getMaxAnisotropy(),
      this.quality.lanternLights,
    );
    this.scene.scene.add(this.view.root);
    // Die Funken zeichnen wir selbst — der erste Pass ohne three.js. Er läuft
    // nach der Szene, im selben Kontext und gegen denselben Tiefenpuffer.
    this.scene.fuegePassHinzu((gfx, sicht, projektion) => {
      // Erst der Schweif, dann die Funken: beide sind additiv und damit von
      // der Reihenfolge unabhängig — aber die Funken eines Treffers gehören
      // vor die Klinge, wenn doch einmal etwas dazwischenkommt.
      this.view.spur.zeichne(gfx, sicht, projektion);
      this.view.particles.zeichne(gfx, sicht, projektion);
    });

    // Dieselbe Modellablage wie die Welt: die Figur im Inventar soll die Waffe
    // tragen, die sie draussen trägt, und nicht deren Platzhalter.
    this.ui = new UI(uiHost, touch, this.registry);
    this.input = new InputManager(canvas, this.scene, touch, uiHost);

    // Anmeldung und Figurenauswahl. Sie schickt nur Pakete — was daraus wird,
    // entscheidet der Server, und die Antwort kommt über `onLobby`.
    this.lobby = new LobbyView(uiHost);
    this.lobby.onLogin = (name, pass) => this.connection?.sendLogin(name, pass);
    this.lobby.onCreateAccount = (name, pass) => this.connection?.sendCreateAccount(name, pass);
    this.lobby.onCreateCharacter = (name) => this.connection?.sendCreateCharacter(name);
    this.lobby.onDeleteCharacter = (id) => this.connection?.sendDeleteCharacter(id);
    /*
     * Einen Kanal betreten.
     *
     * Die Adresse kommt vom Anmeldeserver und wird trotzdem geprüft — mit
     * derselben Prüfung wie eine von Hand eingegebene. Der häufigste Fall ist
     * kein Angriff, sondern ein Tippfehler in der Serverkonfiguration: steht
     * dort `ws://localhost:8787/ws`, verweigert der Browser die Verbindung
     * wortlos, sobald die Seite über HTTPS kam. Ohne diese Prüfung sieht der
     * Spieler nur „getrennt" und hat nichts, woran er es festmachen könnte.
     */
    this.lobby.onEnterChannel = (url, ticket) => {
      const geprueft = checkServerUrl(url);
      if (!geprueft.ok) {
        this.lobby.zeigeFehler(
          `Dieser Kanal ist nicht erreichbar: ${geprueft.error ?? 'Adresse unbrauchbar.'}`,
        );
        this.ui.debug(`[kanal] Adresse vom Anmeldeserver unbrauchbar: ${url}`, 'fehler');
        this.lobby.notiere(`Adresse unbrauchbar: ${url}`, 'fehler');
        return;
      }
      if (geprueft.warning) {
        this.ui.debug(`[kanal] ${geprueft.warning}`, 'warnung');
        this.lobby.notiere(geprueft.warning, 'fehler');
      }
      this.connect(geprueft.url, ticket);
    };
    this.lobby.onRefreshRealms = () => this.connection?.sendRealmList();
    // Zurück zur Kanalauswahl heisst: zurück zum Anmeldeserver. Die
    // Eintrittskarte für den nächsten Kanal gibt es nur dort, und sie wird
    // nur gegen eine Anmeldung ausgestellt — deshalb vergisst die Maske
    // vorher, dass sie angemeldet war, und zeigt wieder das Formular.
    // Denselben Weg wie „Abmelden": auch hier wird die Kanalsitzung beendet,
    // und auch hier muss der Kanal das Konto erst freigeben, bevor der
    // Anmeldeserver eine neue Anmeldung annimmt.
    this.lobby.onBackToChannels = () => this.abmelden();
    this.lobby.onEnterWorld = (id) => {
      // Der Name für den Kasten oben links steht in der Liste, nicht im
      // Willkommen: der Server nennt dort die Karte, nicht die Figur.
      this.playerName = this.lobby.nameVon(id) ?? this.playerName;
      this.ui.setPlayerName(this.playerName);
      this.connection?.sendEnterWorld(id);
    };

    this.ui.onChatSubmit = (text, kanal) => this.onChatInput(text, kanal);
    this.ui.onRespawn = () => this.connection?.sendRespawn();
    this.ui.onEquipItem = (slot) => this.connection?.sendEquipItem(slot);
    this.ui.onUpgradeItem = (slot) => this.connection?.sendUpgradeItem(slot);
    this.ui.onUsePortal = () => this.usePortal();
    this.ui.onUseItem = (slot) => this.connection?.sendUseItem(slot);
    this.ui.onSetActionSlot = (index, art, id) =>
      this.connection?.sendSetActionSlot(index, art, id);
    /*
     * Ein Gegenstand von der Aktionsleiste.
     *
     * Die Leiste kennt nur die Kennung; der Server will einen Beutelplatz. Die
     * Übersetzung gehört hierher, weil hier der letzte bekannte Beutel liegt —
     * und sie nimmt den kleinsten Stapel zuerst. Das räumt den Beutel beim
     * Spielen von selbst auf, statt einen angebrochenen Stapel ewig
     * mitzuschleppen.
     */
    this.ui.onUseItemId = (itemId) => {
      const stapel = this.inventar
        .filter((e) => e.itemId === itemId && !e.equipped)
        .sort((a, b) => a.count - b.count)[0];
      if (!stapel) return;
      this.connection?.sendUseItem(stapel.slot);
    };
    this.ui.onMoveItem = (from, to) => this.connection?.sendMoveItem(from, to);
    this.ui.onDropItem = (slot) => this.connection?.sendDropItem(slot);
    this.ui.onDestroyItem = (slot) => this.connection?.sendDestroyItem(slot);
    // Abmelden heisst: ganz heraus. Siehe `abmelden` — in die Figurenauswahl
    // zurückzukehren wäre eine Sackgasse, denn von dort führt ohne
    // Eintrittskarte kein Weg mehr in die Welt.
    this.ui.onLogout = () => this.abmelden();
    this.ui.onQuestAction = (questId, action) =>
      this.connection?.sendQuestAction(questId, action);
    this.ui.onBuy = (itemId, count) => this.connection?.sendShopTrade(0, itemId, count);
    this.ui.onSell = (itemId, count, slot) =>
      this.connection?.sendShopTrade(1, itemId, count, slot);
    this.ui.onAttackHold = (held) => {
      // Beim Drücken erst zielen, dann halten: der Knopf sagt „schlag zu",
      // und worauf, soll er selbst herausfinden.
      this.angriffGehalten = held;
      if (held) this.angriffsknopf();
      this.input.setAttackButton(held);
    };
    this.ui.onJump = () => this.input.springe();
    this.ui.onUseSkill = (skillId) => this.connection?.sendUseSkill(skillId);
    this.input.onPick = (x, y) => this.pickTarget(x, y);
    // Über einem Haufen zeigt die Maus eine Hand.
    this.input.zeigerFasstAn = (x, y) => this.lootUnderPointer(x, y).id !== 0;
    // Das Beuteschild im Overlay ist die verlässliche Trefferfläche — vor
    // allem auf dem Telefon, wo der Haufen am Boden ein paar Bildpunkte gross
    // ist. Der Klick auf das Modell selbst geht durch `pickTarget`.
    this.ui.overlay.onPickup = (lootId) => this.pickupLoot(lootId);
    // Die Angriffstaste greift an, was ausgewählt ist. Die Animation hängt
    // nicht daran, sondern am vorhergesagten Schwung — siehe `simulate`.
    this.input.onAttackPressed = () => this.angriffTaste();

    // --- Ton --------------------------------------------------------------
    //
    // Die Ansicht meldet jeden beginnenden Schlag, egal von wem. Was daraus zu
    // hören ist, entscheidet sich hier — sie kennt keine Töne.
    this.view.onAttackStart = (entity) => this.playSwing(entity);
    this.ui.setAudioLevels(this.mixer.settings);
    this.ui.onAudioChange = (levels) => {
      // Auch die Bedienung des Reglers ist eine Nutzerhandlung, und die
      // braucht der Tonkontext. Wer als Erstes die Lautstärke anfasst, soll
      // nicht erst noch woanders hinklicken müssen.
      this.mixer.resume();
      this.mixer.setLevels(levels);
      this.ui.setAudioState(this.mixer.state);
    };

    this.ui.onAudioProbe = () => {
      this.mixer.resume();
      const def = SOUNDS.bogen_schuss;
      return this.mixer.probe(def.path, def.category, def.gain);
    };

    // Ein AudioContext startet gesperrt und darf erst nach einer Geste
    // aufwachen. Drei Ereignisse, weil drei Bedienarten dazugehören —
    // `touchend` ist dabei, weil ältere iOS-Fassungen darauf zuverlässiger
    // freischalten als auf `pointerdown`.
    const wake = (): void => {
      this.mixer.resume();
      this.ui.setAudioState(this.mixer.state);
    };
    window.addEventListener('pointerdown', wake);
    window.addEventListener('touchend', wake);
    window.addEventListener('keydown', wake);
    // Nach einem Anruf, einem Wecker oder einem App-Wechsel liegt der
    // Tonkontext unterbrochen da. Ohne das bliebe es still, bis der Spieler
    // zufaellig etwas antippt — und er wuesste nicht, warum.
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    this.ui.setAudioState(this.mixer.state);

    globalThis.aurelith = this.diagnostics;

    // Beim Wechsel in den Hintergrund noch einmal alles rausschicken, und beim
    // Zurueckkommen die Zeitrechnung neu ansetzen — sonst versucht die
    // Simulation, die verpasste Zeit nachzuholen.
    document.addEventListener('visibilitychange', () => {
      this.connection?.flush();
      if (document.visibilityState === 'visible') {
        this.lastFrameAt = performance.now();
        this.accumulator = 0;
      }
    });

    window.addEventListener('resize', () => this.scene.resize());
    window.addEventListener('orientationchange', () => {
      // Nach dem Drehen liefert das Fenster erst im nächsten Frame die neuen Maße.
      requestAnimationFrame(() => this.scene.resize());
    });
  }

  /**
   * Startet das Zeichnen sofort und lädt danach nach. Es gibt bewusst keinen
   * Ladebildschirm: der Blueprint stellt „spielbar im ersten Frame" gegen
   * Flyffs 9-MB-Schranke, und unser Kern ist klein genug, dass das trägt.
   */
  async start(): Promise<void> {
    this.ui.setConnection('verbindet');

    // Das Manifest darf fehlschlagen — ohne es lädt der Streamer direkt, nur
    // ohne Größen und damit ohne echte Priorisierung.
    try {
      await this.streamer.loadManifest();
    } catch (err) {
      console.warn('[assets] Manifest nicht verfügbar, lade ohne Priorisierung:', err);
    }

    // Die Inhaltstabellen **vor allem anderen**.
    //
    // Der Kern bekommt seine Monsterprofile daraus, das Angriffsprofil der
    // eigenen Figur steht darin, und die Zeichenschleife fragt bei jedem Bild
    // die Tageszeit ab — die ihre Länge ebenfalls von dort nimmt. Fünf kleine
    // Dateien, gleichzeitig geholt, zusammen unter zwanzig Kilobyte: das ist
    // kein Ladebalken, sondern ein Wimpernschlag. Ohne sie gäbe es nichts
    // Sinnvolles zu zeichnen.
    try {
      await this.loadContentTables();
    } catch (err) {
      this.ui.addChat(0, '', `Inhalte konnten nicht geladen werden: ${String(err)}`);
      throw err;
    }

    // Erst jetzt steht fest, wie die Figur ohne Waffe zuschlägt.
    this.profile = attackProfileFor(undefined);

    this.running = true;
    this.lastFrameAt = performance.now();
    requestAnimationFrame(this.frame);

    try {
      this.core = await loadClientCore();
    } catch (err) {
      this.ui.addChat(0, '', `Kern konnte nicht geladen werden: ${String(err)}`);
      throw err;
    }

    // Gelieferte Waffenmodelle nachholen — bewusst ohne `await`. Bis sie da
    // sind, trägt jede Figur den prozeduralen Platzhalter, und das erste Bild
    // wartet auf nichts.
    void this.registry.loadWeaponModels((path) => this.streamer.request(path));

    // Kampfgeräusche vorladen, ebenfalls ohne `await`. Zusammen zwölf
    // Kilobyte — ein Ton, der erst beim ersten Schlag geholt wird, fehlt
    // genau bei diesem ersten Schlag.
    for (const id of PRELOAD) {
      void this.mixer.preload(SOUNDS[id].path, (path) => this.streamer.request(path));
    }

    /*
     * Keine Karte vor der Anmeldung.
     *
     * Hier stand einmal eine: die Welt wurde geladen, während jemand sein
     * Passwort tippte, und lag als Bild hinter der Maske. Wer sich anmeldete,
     * war ohne Ladebalken drin.
     *
     * Der Preis dafür war ein Gelände samt Kacheln, Textur und Props, das
     * niemand betritt — geholt auf jedem Gerät, das die Seite aufruft, und
     * bezahlt von jedem Telefon, das darüber warm wird. Geladen wird jetzt
     * die Karte, in die man wirklich geht, und erst dann, wenn der Server
     * gesagt hat, welche das ist.
     */
    this.connect();
  }

  /**
   * Holt Gegenstände, Monster, NPCs und Aufträge vom CDN.
   *
   * Über den Streamer und nicht über ein eingebackenes Modul: Inhalte sollen
   * sich ändern lassen, ohne den Client neu zu bauen. Der Preis ist dieser
   * eine Wartepunkt beim Start — vier Dateien unter zwanzig Kilobyte, parallel
   * geholt.
   */
  private async loadContentTables(): Promise<void> {
    const [items, mobs, npcs, quests, tuning, classes] = await Promise.all([
      this.streamer.requestJson<unknown>('content/items.json'),
      this.streamer.requestJson<unknown>('content/mobs.json'),
      this.streamer.requestJson<unknown>('content/npcs.json'),
      this.streamer.requestJson<unknown>('content/quests.json'),
      this.streamer.requestJson<unknown>('content/tuning.json'),
      this.streamer.requestJson<unknown>('content/classes.json'),
    ]);
    const summe = loadContent({ items, mobs, npcs, quests, tuning, classes });
    console.log(
      `[inhalt] ${summe.items} Gegenstände, ${summe.mobs} Monster, ` +
        `${summe.npcs} NPCs, ${summe.quests} Aufträge, ` +
        `${summe.classes} Berufe mit ${summe.skills} Fertigkeiten`,
    );
  }

  /**
   * Spielt den Schwung, der zu der Waffe in der Hand gehört.
   *
   * Gilt für jede Figur: der Bogen des Spielers neben einem soll zu hören
   * sein, und zwar aus der Richtung, in der er steht. Kennt die Waffe keinen
   * Ton, bleibt es still — lieber keiner als der falsche.
   */
  private playSwing(entity: EntityVisual): void {
    const id = WEAPON_SWING[entity.weapon];
    if (!id) return;

    const def = SOUNDS[id];
    // Fernkampf klingt erst, wenn ein Pfeil fliegt — siehe playProjectileSound.
    if (def.viaProjectile) return;
    const delayMs = def.cue * ATTACK_ANIM_SECONDS * 1000;
    if (delayMs < 1) {
      this.emitSound(def, entity.id);
      return;
    }

    // Der Ton hängt an der Animation, nicht an ihrem Beginn: wer den Bogen
    // hebt, hat noch nichts abgeschossen. Gemerkt wird die Kennung, nicht die
    // Figur — bis der Ton fällt, ist sie ein Stück weitergelaufen, und der
    // Ton gehört dorthin, wo sie *dann* steht.
    const attacker = entity.id;
    setTimeout(() => {
      const still = this.view.entities.get(attacker);
      // Weg oder längst fertig? Dann gehörte der Ton zu einem Schlag, den es
      // nicht mehr gibt — etwa weil die Figur mitten im Ausholen gefallen ist.
      if (!still || still.attackTimer < 0) return;
      this.emitSound(def, attacker);
    }, delayMs);
  }

  /**
   * Der Ton eines abgefeuerten Geschosses.
   *
   * Getrennt vom Schwung, weil ein Bogen nur klingt, wenn tatsächlich ein
   * Pfeil fliegt. Der Server lässt die Schwinge auch ohne Ziel beginnen —
   * das muss er, sonst rechnete die Vorhersage im Client, der keine Monster
   * kennt, an dieser Stelle anders als die Autorität. Sichtbar wird der
   * Unterschied erst hier: Animation ja, Pfeil nein, also auch kein Sirren.
   */
  private playProjectileSound(attackerId: number): void {
    const attacker = this.view.entities.get(attackerId);
    if (!attacker) return;

    const id = WEAPON_SWING[attacker.weapon];
    if (!id) return;

    const def = SOUNDS[id];
    if (!def.viaProjectile) return;
    this.emitSound(def, attackerId);
  }

  private emitSound(def: SoundDef, entityId: number): void {
    const entity = this.view.entities.get(entityId);
    if (!entity) return;

    this.mixer.play(def.path, def.category, (path) => this.streamer.request(path), {
      // Auf Brusthöhe, nicht am Boden: die Höhe geht in die Entfernung ein.
      at: { x: entity.x, y: entity.y + entity.height * 0.6, z: entity.z },
      gain: def.gain,
      spread: def.spread,
    });
  }

  // -------------------------------------------------------------------------
  // Karten
  // -------------------------------------------------------------------------

  /**
   * Laedt eine Karte — hoechstens einmal gleichzeitig je Kennung.
   *
   * Bei einem Kartenwechsel schickt der Server erst `Welcome`, dann
   * `MapChange`. Beide Behandlungen wollten laden, beide sahen `view.mapId`
   * noch auf der alten Karte — und starteten zwei Ladevorgaenge, von denen der
   * zweite die Welt des ersten wegwarf.
   */
  private ensureMap(mapId: string): Promise<void> {
    if (this.view.mapId === mapId && this.mapLoad === undefined) return Promise.resolve();
    if (this.loadingMapId === mapId && this.mapLoad) return this.mapLoad;

    this.loadingMapId = mapId;
    const load = this.loadMap(mapId).finally(() => {
      if (this.loadingMapId === mapId) {
        this.loadingMapId = undefined;
        this.mapLoad = undefined;
        this.drainSnapshots();
      }
    });
    this.mapLoad = load;
    return load;
  }

  /**
   * Spielt Snapshots nach, die waehrend eines Kartenwechsels eintrafen.
   *
   * Ohne das ging die eigene Figur beim Reisen verloren: der erste Snapshot
   * nach der Ankunft kam an, waehrend die neue Karte noch geholt wurde. Er
   * setzte die Figur in die alte Vorhersagewelt, die einen Wimpernschlag
   * spaeter verworfen wurde — und der Server schickte sie kein zweites Mal,
   * weil er sie als bekannt vermerkt hatte. Was blieb, war eine Figur, die
   * sich nicht mehr bewegte.
   *
   * Aufgehoben statt verworfen, weil in einem `spawn` die vollstaendige Zeile
   * steht: nachtraeglich angewandt ist sie genauso richtig wie sofort.
   */
  private drainSnapshots(): void {
    if (this.queuedSnapshots.length === 0) return;
    const queued = this.queuedSnapshots;
    this.queuedSnapshots = [];
    for (const msg of queued) this.applySnapshot(msg);
  }

  private async loadMap(mapId: string): Promise<void> {
    const core = this.core;
    if (!core) return;

    const raw = await this.streamer.requestJson<unknown>(`maps/${mapId}.json`);
    const doc = parseMapDocument(raw, mapId);
    this.mapDoc = doc;

    this.prediction?.dispose();
    const setup = terrainSetup(doc);
    const world = core.core.createWorld(doc.terrain.seed, setup.shape);
    world.setSculpt(setup.sculpt, setup.sculptResolution);
    // Dieselben Kollider wie auf dem Server: sonst sagt die Vorhersage, man
    // stehe im Baum, und die Autorität schiebt einen jedes Mal heraus.
    for (const prop of doc.props) {
      if (prop.collision !== 'circle') continue;
      world.addCollider(prop.position[0], prop.position[2], prop.collisionRadius * prop.scale);
    }
    this.prediction = world;

    this.scene.applyEnvironment(doc.environment, this.quality.viewDistance);
    // Die Karteneinstellung ist der Mittagsstand; alles andere rechnet der
    // Zyklus daraus.
    this.dayCycle.setEnvironment(doc.environment);
    this.view.setMap(world, doc, this.quality);
    this.streamer.setViewer(doc.spawn.x, doc.spawn.z);
    this.scene.snapTo(doc.spawn.x, world.heightAt(doc.spawn.x, doc.spawn.z), doc.spawn.z);
  }

  // -------------------------------------------------------------------------
  // Verbindung
  // -------------------------------------------------------------------------

  /**
   * Baut die Verbindung auf.
   *
   * Ohne Argumente geht sie an die hinterlegte Adresse — im Betrieb der
   * Anmeldeserver, im Alleinbetrieb ein Spielserver. Mit `url` und `ticket`
   * geht sie an einen Kanal, den man sich in der Maske ausgesucht hat.
   *
   * **Eine** Verbindung und ein Satz Rückrufe für beide Fälle. Der Client
   * fragt nie, mit welcher Sorte Server er spricht: er meldet sich an und
   * bekommt entweder eine Kanalliste oder gleich seine Figuren.
   */
  private connect(url = serverUrl(), ticket?: string): void {
    // Eine bestehende Verbindung zuerst abraeumen: nach `close()` meldet sie
    // nichts mehr nach oben, also kann kein Paket im Flug die frische Sitzung
    // durcheinanderbringen.
    this.connection?.close();
    this.resetSession();

    let explainedMissingServer = false;
    // Solange eine Karte im Spiel ist und noch keine Figurenliste kam, hängt
    // die Sitzung am Kanal. Scheitert sie, geht es zurück zum Anmeldeserver —
    // dort und nur dort gibt es eine neue Karte.
    this.amKanal = ticket !== undefined;
    this.kanalUrl = ticket === undefined ? '' : url;
    this.lobby.notiere(
      `Verbinde mit ${url}${ticket === undefined ? '' : ' (mit Eintrittskarte)'}`,
    );
    /*
     * Eine Wache gegen die stumme Sitzung.
     *
     * Nur beim Betreten eines Kanals: dort reist die Karte gleich hinter dem
     * Gruss mit, und der Kanal muss antworten — mit der Figurenliste oder mit
     * einer Absage. Bleibt beides aus, steht die Leitung und trotzdem geht es
     * nicht weiter, und genau dieser Fall sah bisher aus wie gar kein Fehler:
     * die Maske wartete, der Spieler wartete, und niemand sagte worauf.
     *
     * Am Anmeldeserver gibt es diese Wache nicht — dort wartet der Server
     * zurecht, nämlich darauf, dass jemand sein Passwort tippt.
     *
     * Fünfzehn Sekunden, weil der Kanal die Karte beim Anmeldeserver
     * nachfragt und dafür bis zu fünf braucht.
     */
    window.clearTimeout(this.stilleWache);
    if (ticket !== undefined) {
      this.stilleWache = window.setTimeout(() => {
        this.lobby.notiere(
          `${url} hat die Verbindung angenommen, antwortet aber nicht. ` +
            'Weder Figurenliste noch Absage — der Kanal bleibt hier stumm.',
          'fehler',
        );
      }, 15_000);
    }

    this.connection = new Connection(url, {
      onStatus: (status, detail) => {
        this.ui.setConnection(status, detail);
        /*
         * Denselben Stand auch in die Maske schreiben.
         *
         * Die Konsole ist von der Anmeldung und der Kanalauswahl aus nicht zu
         * öffnen — sie gehört zur Spieloberfläche, und die gibt es dort noch
         * nicht. Alles, was hier in die Konsole ginge, wäre also genau so
         * lange unsichtbar, wie es gebraucht wird.
         *
         * Die Marke lässt „verbunden" die Laufzeit weg: die kommt mit jedem
         * Pong neu und wäre eine Zeile je Sekunde. Bei „getrennt" gehört der
         * Grund dazu — er ist der ganze Inhalt der Meldung.
         */
        this.lobby.notiere(
          `${status}${detail ? ` — ${detail}` : ''} · ${url}`,
          status === 'getrennt' ? 'fehler' : 'info',
          `${status}|${status === 'verbunden' ? '' : (detail ?? '')}|${url}`,
        );

        /*
         * Eine Kanalverbindung, die endet — gleich aus welchem Grund.
         *
         * Sie lässt sich nicht wieder aufnehmen. Der Schlüssel dazu war die
         * Eintrittskarte, und die gilt einmal: was der Client noch in der Hand
         * hält, ist ein Stück Papier, das der Kanal beim zweiten Vorzeigen
         * zurückweist. Ein selbsttätiger Wiederversuch liefe deshalb in eine
         * Schleife aus Absagen. Also zurück zum Anmeldeserver, wo es eine neue
         * Karte gibt — gegen eine neue Anmeldung.
         *
         * Drei Fälle enden hier, und sie sollen sich nicht gleich anfühlen:
         * gewollt abgemeldet, nie angekommen, mittendrin abgerissen.
         */
        if (status === 'getrennt' && this.kanalUrl !== '') {
          const nichtAngekommen = this.amKanal;
          const gewollt = this.abmeldeWunsch;
          this.amKanal = false;
          this.kanalUrl = '';
          this.abmeldeWunsch = false;
          window.clearTimeout(this.abmeldeFrist);
          this.connection?.close();
          this.resetSession();
          this.lobby.zuruecksetzen();

          if (gewollt) {
            this.lobby.notiere('Abgemeldet. Der Kanal hat die Sitzung aufgeräumt.');
            this.lobby.zeigeHinweis(
              'Du bist abgemeldet. Melde dich an, um wieder einen Kanal zu betreten.',
            );
          } else if (nichtAngekommen) {
            // Der Schliesscode gehört in die Meldung und nicht nur in die
            // Konsole: er ist der Unterschied zwischen „kommt nicht hin"
            // (1006) und „wurde abgewiesen" (1002, 1008), und niemand öffnet
            // die Konsole, bevor er weiss, dass dort etwas steht.
            this.lobby.zeigeFehler(
              `Der Kanal unter ${url} antwortet nicht${detail ? ` (${detail})` : ''}. ` +
                'Prüfe, ob er von aussen erreichbar ist, und melde dich neu an.',
            );
            this.ui.debug(
              `[kanal] ${url} nicht erreichbar${detail ? ` — ${detail}` : ''}`,
              'fehler',
            );
            this.lobby.notiere(
              'Kanal nicht erreichbar — zurück zum Anmeldeserver, die Eintrittskarte ist verbraucht.',
              'fehler',
            );
            // Der Schliesscode allein reicht nicht: 1006 heisst nur „gar nicht
            // zustande gekommen" und nennt keinen Grund. Die Nachfrage über
            // HTTP trennt die beiden Fälle — siehe `pruefeKanal`.
            void this.pruefeKanal(url);
          } else {
            this.lobby.zeigeFehler(
              `Die Verbindung zum Kanal ist abgerissen${detail ? ` (${detail})` : ''}. ` +
                'Die Eintrittskarte gilt nur einmal — melde dich neu an, dann geht es weiter.',
            );
            this.lobby.notiere(
              'Kanalverbindung verloren — die verbrauchte Eintrittskarte taugt für ' +
                'keinen zweiten Versuch, also zurück zum Anmeldeserver.',
              'fehler',
            );
          }

          this.connect();
          this.lobby.zeigeAnmeldung();
          return;
        }

        // Steht die Leitung, ist als Nächstes die Anmeldung dran. Sie erscheint
        // auch nach einem Verbindungsabriss wieder: es gibt kein Sitzungspapier,
        // das eine neue Verbindung ausweisen könnte, also wird neu angemeldet.
        if (status === 'verbunden' && this.localId === 0) this.lobby.zeigeAnmeldung();
        if (status === 'getrennt') {
          this.resetSession();
          this.lobby.zuruecksetzen();
        }

        // Eine statisch ausgelieferte Seite hat keinen WebSocket-Endpunkt.
        // Ohne Erklärung sieht man nur „getrennt" und rätselt, ob etwas kaputt
        // ist. Der Hinweis kommt erst, wenn die Verbindung tatsächlich
        // scheitert — im Entwicklungsbetrieb ist dieselbe Vermutung richtig
        // und soll nichts melden.
        if (status === 'getrennt' && !isServerConfigured() && !explainedMissingServer) {
          explainedMissingServer = true;
          this.ui.addChat(
            0,
            '',
            'Kein Spielserver hinterlegt — die Welt ist sichtbar, aber ohne Verbindung. ' +
              'Mit  /connect ws://localhost:8787/ws  eine Adresse setzen.',
          );
        }
      },

      // Eine Geste — Aufheben ist die einzige, die es bisher gibt. Sie kommt
      // vom Server, damit auch die Umstehenden sie sehen.
      onEmote: (entityId, kind) => {
        if (kind === EmoteKind.Pickup) this.view.playPickup(entityId);
      },

      /**
       * Eine gewirkte Fertigkeit — Bewegung, Funken und Ton.
       *
       * Was für ein Bild das ist, steht in der Fertigkeit selbst (`wirkung`)
       * und nicht in einer Fallunterscheidung nach Kennung: eine zweite
       * Fertigkeit mit demselben Wirbel bekäme sonst hier eine Zeile, obwohl
       * sie in `classes.json` schon alles sagt, was nötig ist.
       */
      onSkillCast: (entityId, skillId) => {
        const def = getSkill(skillId);
        if (!def) return;
        if (def.wirkung !== 'wirbel') return;

        const ort = this.view.playWirbel(entityId);
        if (!ort) return;
        burstWirbel(
          this.view.particles,
          ort.x,
          ort.y,
          ort.z,
          def.radius,
          this.quality.particleBudget,
        );
      },

      onLobby: (msg) => {
        // Die Karte ist eingelöst, die Sitzung steht.
        this.amKanal = false;
        window.clearTimeout(this.stilleWache);
        // Angemeldet, aber nicht in der Welt: die Maske zeigt die Figuren.
        // Auch nach dem Abmelden aus dem Spiel — dann steht die Sitzung
        // wieder in der Verwaltung, und was von ihr im Bild war, gehört
        // abgeräumt.
        this.resetSession();
        this.lobby.setStand(msg);
        this.accessLevel = msg.accessLevel;
      },

      /**
       * Eine Absage.
       *
       * Kam sie von einem Kanal, während die Eintrittskarte noch nicht
       * eingelöst war, ist die Karte verbraucht oder abgelaufen — dann führt
       * kein Weg von hier weiter, und der Client geht zurück zum
       * Anmeldeserver. Ohne das stünde man vor einer Kanalliste, deren Karte
       * nicht mehr gilt, und jeder weitere Versuch scheiterte gleich.
       */
      onLobbyError: (text) => {
        window.clearTimeout(this.stilleWache);
        this.lobby.zeigeFehler(text);
        this.lobby.notiere(`Absage: ${text}`, 'fehler');
        if (this.amKanal) {
          this.amKanal = false;
          this.connect();
        }
      },

      // Die Kanalliste. Kommt nur vom Anmeldeserver.
      onRealms: (msg) => this.lobby.zeigeKanaele(msg),

      // Die Aktionsleiste. Kommt vom Server, weil sie dort gemerkt wird —
      // sonst wäre sie auf jedem Gerät eine andere.
      onActionBar: (plaetze) => {
        const leiste = normalisiereLeiste(plaetze);
        this.diagnostics.aktionsleiste = leiste.map((p) => ({ art: p.art, id: p.id }));
        this.ui.setzeAktionsleiste(leiste);
      },

      onWelcome: async (msg) => {
        this.localId = msg.entityId;
        // Die Maske bleibt noch stehen — sie geht erst, wenn es etwas zu
        // sehen gibt. Vorher stand hier ein `verbergen()`, und weil die Karte
        // damals längst geladen war, fiel nicht auf, dass es zu früh kam. Ohne
        // Vorladen wäre es eine leere Fläche für ein, zwei Sekunden.
        this.lobby.zeigeHinweis(`Die Welt wird geladen — ${msg.mapId} …`);
        this.syncClock(msg.serverTimeMs);
        this.pending = [];
        this.targetId = 0;
        this.poseValid = false;

        // Der Eingabezähler wird hier **nicht** zurückgesetzt.
        //
        // Er gehört der Verbindung, nicht der Karte. Bei einem Kartenwechsel
        // schickt der Server erneut ein `Welcome`; wer hier auf null ginge,
        // liefe gegen die Sitzung auf der Gegenseite, die weiterzählt: sie
        // verwirft alles, was nicht neuer ist als die letzte gesehene Nummer,
        // und das wäre nach einem Wechsel schlicht alles.
        //
        // Sichtbar war das als etwas ganz anderes: die Figur lief im Bild
        // weiter, weil die Vorhersage örtlich rechnet, aber auf dem Server
        // stand sie unbewegt am Ankunftspunkt. Tore reagierten nicht, Monster
        // liefen an einer Figur vorbei, die für sie woanders stand — und die
        // Korrektur schwieg, weil sie zu keiner Bestätigung mehr einen Anker
        // fand und deshalb gar nichts verglich.
        //
        // Zurückgesetzt wird er in `resetSession`, also genau dann, wenn die
        // Gegenseite wirklich neu anfängt.
        try {
          await this.ensureMap(msg.mapId);
        } catch (err) {
          // Die Maske bleibt stehen — mit einem Grund. Sie wegzunehmen hiesse,
          // jemanden vor einer leeren Fläche stehen zu lassen, die aussieht
          // wie ein Absturz und keine ist.
          const grund = err instanceof Error ? err.message : String(err);
          this.lobby.zeigeFehler(`Die Karte ${msg.mapId} lässt sich nicht laden: ${grund}`);
          this.lobby.notiere(`Karte ${msg.mapId} nicht ladbar — ${grund}`, 'fehler');
          return;
        }
        // Jetzt steht das Gelände. Die Maske hat ihren Dienst getan.
        this.lobby.zeigeHinweis('');
        this.lobby.verbergen();
      },

      onMapChange: async (msg) => {
        // Zuerst den Hinweis wegnehmen: bis die neue Karte geladen ist, würde
        // die neue Position gegen die Tore der alten geprüft.
        this.nearbyPortalId = undefined;
        this.serverSeen = false;
        this.ui.setPortalPrompt(undefined);
        // Der NPC, mit dem man eben sprach, steht auf der alten Karte.
        this.ui.closeDialog();

        await this.ensureMap(msg.mapId);
        this.scene.snapTo(msg.x, msg.y, msg.z);
        this.pending = [];
        this.poseValid = false;
        this.input.setFacing(msg.yaw);
      },

      onSnapshot: (msg) => {
        // Die Uhr laeuft mit jedem Snapshot mit, nicht nur beim Anmelden: eine
        // Sitzung dauert laenger, als eine Geraeteuhr genau geht. Hier und
        // nicht in `applySnapshot`: der wird beim Kartenwechsel mit
        // aufgehobenen Snapshots ein zweites Mal gerufen, und deren Zeitstempel
        // sind dann alt.
        this.syncClock(msg.serverTimeMs);
        this.applySnapshot(msg);
      },

      onStats: (msg) => {
        this.stats = msg;
        this.ui.setStats(msg);
      },

      onInventory: (rows) => {
        // Der letzte bekannte Beutel. Die Aktionsleiste zeigt auf Kennungen
        // und braucht ihn, um daraus einen Beutelplatz zu machen.
        this.inventar = rows;
        this.diagnostics.inventar = rows.map((r) => ({
          itemId: r.itemId,
          slot: r.slot,
          count: r.count,
          equipped: r.equipped,
        }));
        this.ui.setInventory(rows);

        // Aus der Ausrüstung folgt, wie die Figur zuschlägt — und was sie in
        // der Hand hält. Beides muss der Client kennen: das eine, damit die
        // Vorhersage dieselbe Vorlaufzeit rechnet wie der Server, das andere
        // fürs Zielen.
        const mainhand = rows.find((r) => {
          if (!r.equipped) return false;
          return getItem(r.itemId)?.slot === 'mainhand';
        });
        this.profile = attackProfileFor(mainhand ? getItem(mainhand.itemId) : undefined);
        this.applyProfileToPrediction();

        // Klang nur beim *Wechsel*, nicht bei jeder Inventarnachricht.
        //
        // Der Server schickt das Inventar auch beim Anmelden und nach jedem
        // Aufsammeln. Ohne den Vergleich klänge es beim Betreten der Welt und
        // bei jedem eingesammelten Kraut — der Ton bestätigt aber eine
        // Handlung, und wo keine war, gehört keine Bestätigung hin.
        const angelegt = rows
          .filter((r) => r.equipped)
          .map((r) => r.itemId)
          .sort()
          .join(',');
        if (this.equipped !== undefined && angelegt !== this.equipped) {
          const ton = SOUNDS.ausruestung;
          // Ohne Ort: das passiert in der Hand des Spielers, nicht in der Welt.
          this.mixer.play(ton.path, ton.category, (path) => this.streamer.request(path), {
            gain: ton.gain,
          });
        }
        this.equipped = angelegt;
      },

      onNpcDialog: (msg) => this.ui.showDialog(msg, this.npcKlickX, this.npcKlickY),

      onQuestLog: (rows) => this.ui.setQuests(rows),

      onChat: (msg) => {
        // Eine Ansage ist keine Chatzeile. Sie steht gross im Bild und nicht
        // im Fenster — siehe `zeigeAnsage`.
        if (msg.channel === ChatChannel.Ansage) {
          this.ui.zeigeAnsage(msg.text);
          return;
        }
        this.ui.addChat(msg.channel, msg.from, msg.text);
        // Und über dem Kopf dessen, der es gesagt hat. Wer auf einer anderen
        // Karte steht, hat hier kein Wesen — dann bleibt es bei der Zeile.
        this.ui.overlay.zeigeBlase(msg.entityId, msg.text);
      },

      // Die Antwort auf `/version`. Beide Zeilen entstehen hier, mit derselben
      // Formatierung — die eine aus dem, was der Server geschickt hat, die
      // andere aus dem, was beim Bauen eingebacken wurde.
      onVersion: (stamp) => {
        if (this.versionFrage === 0) return;
        this.versionFrage = 0;
        this.systemLine(`Server: ${formatBuild(stamp)}`);
        this.systemLine(`Client: ${formatBuild(BUILD_STAMP)}`);
      },

      onCombat: (msg) => this.applyCombat(msg),

      onKick: (_reason, message) => {
        this.ui.setConnection('getrennt', message);
        this.ui.addChat(0, '', `Verbindung beendet: ${message}`);
      },
    },
    // Die Eintrittskarte. Sie hat hier gefehlt, und weil sie freiwillig ist,
    // hat kein Übersetzer etwas gesagt: der Client verband sich mit dem Kanal,
    // grüsste und schwieg dann. Der Kanal wartete auf eine Karte, die nie kam,
    // und der Spieler sah eine Maske, die nichts mehr tat — bis der Server die
    // stumme Sitzung nach dreissig Sekunden schloss.
    ticket);

    this.connection.connect();
  }

  /**
   * Abmelden — aus der Welt, aus dem Kanal, zurück ans Anmeldeformular.
   *
   * Nicht zurück in die Figurenauswahl. Die gehört zum Kanal, und in den kommt
   * man nur mit einer Eintrittskarte; wer dort ohne eine sässe, hätte eine
   * Liste mit einem Knopf, der nichts mehr bewirken kann.
   *
   * Der Client legt nicht selbst auf, sondern bittet den Kanal darum. Der
   * räumt auf — speichern, Figur aus der Welt, Konto beim Anmeldeserver
   * freigeben — und legt danach von sich aus auf; erst das schliessende
   * `getrennt` bringt uns zum Anmeldeserver zurück. Die Frist darunter ist
   * für den Fall, dass er das nicht tut: lieber eine Sekunde zu früh
   * abgemeldet als eine Maske, die für immer wartet.
   */
  private abmelden(): void {
    if (this.abmeldeWunsch) return;

    // Ohne Eintrittskarte — am Anmeldeserver oder bei einem Spielserver im
    // Alleinbetrieb — hat das Auflegen keine Folgen, die man abwarten müsste:
    // es gibt kein Konto freizugeben, und die Figur speichert der Server beim
    // Trennen ohnehin. Also gleich zurück ans Formular.
    if (this.kanalUrl === '') {
      this.resetSession();
      this.lobby.zuruecksetzen();
      this.connect();
      this.lobby.zeigeAnmeldung();
      return;
    }

    this.abmeldeWunsch = true;
    this.lobby.notiere('Abmelden — der Kanal räumt die Sitzung auf.');
    this.connection?.sendLogout();
    window.clearTimeout(this.abmeldeFrist);
    this.abmeldeFrist = window.setTimeout(() => {
      if (!this.abmeldeWunsch) return;
      this.lobby.notiere(
        'Der Kanal bestätigt das Abmelden nicht — die Leitung wird von hier aus ' +
          'geschlossen. Falls die nächste Anmeldung „Konto spielt gerade" meldet, ' +
          'liegt es daran; nach einem Moment ist es frei.',
        'fehler',
      );
      // Der Rest ist derselbe Weg wie sonst: das Schliessen meldet `getrennt`,
      // und dort steht, was danach passiert.
      this.connection?.close();
      this.abmeldeWunsch = false;
      this.kanalUrl = '';
      this.resetSession();
      this.lobby.zuruecksetzen();
      this.connect();
      this.lobby.zeigeAnmeldung();
    }, 4000);
  }

  /**
   * Nachfragen, warum ein Kanal nicht erreichbar war.
   *
   * Ein gescheitertes WebSocket gibt dem Browser aus Sicherheitsgründen keinen
   * Grund heraus — nur `1006`, „gar nicht zustande gekommen". Darunter liegen
   * zwei völlig verschiedene Ursachen, und ohne sie zu trennen sucht man an
   * der falschen Stelle:
   *
   *   Der Rechner kommt gar nicht hin — kein Weg im Proxy, ein Zertifikat,
   *   dem **dieses Gerät** nicht traut, ein Netz, das `wss` blockt. Dann
   *   scheitert auch die Anfrage unten.
   *
   *   Der Rechner kommt hin, und der Kanal weist ab. Dann antwortet `/health`,
   *   und der Fehler liegt hinter dem Handschlag.
   *
   * Gefragt wird zweimal, und die zweite Frage ist die wichtigere:
   *
   *   `/health` sagt, ob der Kanal überhaupt zu erreichen ist — und wer dort
   *   steht. Der Kanal nennt in der Antwort seinen Namen; damit ist auch
   *   geklärt, ob hinter der Adresse der erwartete hängt.
   *
   *   `/ws` ohne Aufwertung muss vom **Spielserver** beantwortet werden, mit
   *   seinem eigenen 404-Text. Kommt stattdessen die Fehlerseite des Proxys
   *   oder ein 502, endet der Weg vor dem Kanal — dann fehlt dem Proxy der
   *   Ort für `/ws`, und die Spielverbindung kann gar nicht ankommen.
   */
  private async pruefeKanal(url: string): Promise<void> {
    let ziel: URL;
    try {
      ziel = new URL(url);
    } catch {
      this.lobby.notiere(`Adresse nicht lesbar: ${url}`, 'fehler');
      return;
    }
    ziel.protocol = ziel.protocol === 'wss:' ? 'https:' : 'http:';
    ziel.search = '';
    const wsPfad = ziel.pathname || '/ws';

    const gesund = await this.frageAb(new URL('/health', ziel).toString());
    if (gesund.art === 'nichts') {
      this.lobby.notiere(
        `${ziel.host} ist von diesem Gerät aus gar nicht erreichbar (${gesund.text}). ` +
          'Das trifft Adresse, Zertifikat oder Weg im Proxy — nicht den Kanal.',
        'fehler',
      );
      return;
    }
    this.lobby.notiere(`${ziel.host}/health: ${gesund.text}`);

    const ws = await this.frageAb(new URL(wsPfad, ziel).toString());
    this.lobby.notiere(`${ziel.host}${wsPfad}: ${ws.text}`);
    this.lobby.notiere(
      ws.text.includes('Aurelith')
        ? `${wsPfad} führt bis zum Kanal — es scheitert erst an der Aufwertung zum ` +
            'WebSocket. Im Proxy fehlen dort die Kopfzeilen Upgrade und Connection.'
        : `${wsPfad} kommt nicht beim Kanal an — die Antwort stammt nicht von ihm. ` +
            'Im Proxy fehlt der Weg dorthin.',
      'fehler',
    );
  }

  /**
   * Eine Adresse abfragen und in einem Satz beantworten, was zurückkam.
   *
   * Der zweite Versuch ohne CORS ist kein Ersatz, sondern eine schwächere
   * Auskunft: eine verschlossene Antwort beweist immerhin, dass Adresse,
   * Zertifikat und Weg stimmen — nur lesen darf man sie nicht. Nötig ist er
   * für Gegenstellen, die die Kopfzeile nicht setzen; unsere tun es.
   */
  private async frageAb(
    adresse: string,
  ): Promise<{ art: 'gelesen' | 'verschlossen' | 'nichts'; text: string }> {
    // Ohne Frist hinge die Nachfrage genau dort fest, wo auch das WebSocket
    // hing, und meldete nie etwas.
    const abbruch = new AbortController();
    const frist = window.setTimeout(() => abbruch.abort(), 6000);
    try {
      const antwort = await fetch(adresse, { signal: abbruch.signal, cache: 'no-store' });
      const text = (await antwort.text()).replace(/\s+/g, ' ').trim().slice(0, 160);
      return { art: 'gelesen', text: `${antwort.status} ${text}` };
    } catch (err) {
      if (abbruch.signal.aborted) return { art: 'nichts', text: 'keine Antwort in 6 s' };
      try {
        await fetch(adresse, { mode: 'no-cors', signal: abbruch.signal, cache: 'no-store' });
        return { art: 'verschlossen', text: 'antwortet, aber verschlossen (kein CORS)' };
      } catch {
        return { art: 'nichts', text: err instanceof Error ? err.message : String(err) };
      }
    } finally {
      window.clearTimeout(frist);
    }
  }

  /**
   * Chateingabe. Alles, was mit einem Schraegstrich beginnt, ist ein Befehl und
   * geht nicht an den Server.
   *
   * `/connect` gibt es, weil die Serveradresse auf einer statisch
   * ausgelieferten Seite sonst beim Bauen eingebacken waere — fuer jede andere
   * Adresse muesste neu gebaut und veroeffentlicht werden.
   */
  private onChatInput(text: string, kanal: number = ChatChannel.Say): void {
    if (!text.startsWith('/')) {
      this.connection?.sendChat(text, kanal);
      return;
    }

    const [command, ...rest] = text.slice(1).trim().split(/\s+/);
    const argument = rest.join(' ');

    switch ((command ?? '').toLowerCase()) {
      case 'connect':
        this.commandConnect(argument);
        break;
      case 'disconnect':
        this.commandDisconnect();
        break;
      case 'server':
        this.systemLine(`Aktuelle Adresse: ${serverUrl()}`);
        break;
      case 'version':
        this.commandVersion();
        break;
      case 'help':
        this.systemLine(
          '/connect <adresse> — mit einem Server verbinden, z. B. /connect ws://localhost:8787/ws',
        );
        this.systemLine('/disconnect — gespeicherte Adresse loeschen und trennen');
        this.systemLine('/server — aktuelle Adresse anzeigen');
        this.systemLine('/version — Fassung von Server und Client anzeigen');
        // Und was der Server noch kann, sagt der Server: seine Liste hängt an
        // der Zugriffsstufe des Kontos.
        this.connection?.sendChat('/help');
        break;
      default:
        // Was der Client nicht kennt, kennt vielleicht der Server: dort liegen
        // die Befehle, die am Spielstand rühren. Er antwortet selbst, auch mit
        // „unbekannt" — sonst müsste der Client eine zweite Liste derselben
        // Befehle führen, und zwar eine, die veraltet.
        this.connection?.sendChat(text);
        break;
    }
  }

  /**
   * `/version` — welche Fassung dort läuft, und welche hier.
   *
   * Die eigene Zeile wird **erst mit der Antwort** geschrieben, nicht sofort.
   * Zwei Zeilen im Chat, zwischen denen eine Sekunde Netz liegt, lesen sich
   * wie zwei Ereignisse; hier ist es eine Auskunft. Und käme die Antwort gar
   * nicht, stünde sonst eine Clientzeile ohne Gegenstück da — wer schnell
   * liest, hielte sie für die Serverzeile.
   */
  private commandVersion(): void {
    if (!this.connection) {
      this.systemLine('Nicht verbunden — nur die eigene Fassung:');
      this.systemLine(`Client: ${formatBuild(BUILD_STAMP)}`);
      return;
    }

    // Ein Zähler statt eines Zeitstempels: wer zweimal fragt und einmal keine
    // Antwort bekommt, soll nicht die Absage auf die erste Frage zur zweiten
    // gerechnet sehen.
    const frage = ++this.versionFrage;
    window.setTimeout(() => {
      if (this.versionFrage !== frage) return;
      this.systemLine('Der Server antwortet nicht auf die Frage nach seiner Fassung.');
      this.systemLine(`Client: ${formatBuild(BUILD_STAMP)}`);
    }, VERSION_TIMEOUT_MS);

    this.connection.sendVersionRequest();
  }

  /** Läuft gerade eine `/version`-Frage, und welche? 0 heisst: keine. */
  private versionFrage = 0;

  /**
   * Hängt diese Verbindung an einer Eintrittskarte, die noch nicht eingelöst
   * ist?
   *
   * Nur bis zur ersten Figurenliste wahr. Danach ist die Sitzung eine
   * gewöhnliche, und eine Absage ist eine Absage — kein Grund, zum
   * Anmeldeserver zurückzugehen.
   */
  /**
   * Der zuletzt gemeldete Beutel.
   *
   * Nur zum Nachschlagen: welcher Stapel zu einer Kennung gehört. Die
   * Anzeige führt die Oberfläche, der Bestand der Server — das hier ist eine
   * Abschrift und keine dritte Meinung.
   */
  private inventar: InventoryRow[] = [];
  private amKanal = false;
  /**
   * Die Adresse des Kanals, an dem diese Sitzung hängt. Leer heisst:
   * Anmeldeserver.
   *
   * Der Unterschied zu `amKanal`: das dort erlischt, sobald die Karte
   * eingelöst ist. Diese Angabe bleibt, solange die Verbindung steht — denn
   * die Frage „darf ich es einfach noch einmal versuchen?" wird auch nach dem
   * Einlösen gestellt, und die Antwort ist dieselbe: nein, die Karte ist weg.
   */
  private kanalUrl = '';
  /** Liegt der Daumen gerade auf dem Angriffsknopf? Nur am Telefon. */
  private angriffGehalten = false;
  /** Läuft, solange ein Kanal noch keine Antwort auf die Eintrittskarte gab. */
  private stilleWache = 0;
  /** Wir haben uns abgemeldet und warten darauf, dass der Kanal auflegt. */
  private abmeldeWunsch = false;
  /** Notausgang, falls der Kanal auf das Abmelden nicht antwortet. */
  private abmeldeFrist = 0;

  private commandConnect(argument: string): void {
    if (!argument) {
      this.systemLine(`Aktuelle Adresse: ${serverUrl()}`);
      this.systemLine('Zum Wechseln: /connect ws://localhost:8787/ws');
      return;
    }

    const checked = checkServerUrl(argument);
    if (!checked.ok) {
      this.systemLine(checked.error ?? 'Adresse nicht verwendbar.');
      return;
    }
    if (checked.warning) this.systemLine(checked.warning);

    setStoredServerUrl(checked.url);
    this.systemLine(`Verbinde mit ${checked.url} …`);
    this.connect();
  }

  private commandDisconnect(): void {
    const stored = storedServerUrl();
    setStoredServerUrl(null);
    this.connection?.close();
    this.connection = undefined;
    this.resetSession();
    this.ui.setConnection('getrennt', 'getrennt');
    this.systemLine(
      stored ? `Getrennt, gespeicherte Adresse ${stored} geloescht.` : 'Getrennt.',
    );
  }

  /** Alles verwerfen, was zur alten Sitzung gehoerte. Boden und Props bleiben. */
  private resetSession(): void {
    this.view.clearEntities();
    // Die Marke gehört zu einem Weg, den es nicht mehr gibt.
    this.view.laufmarke.loesche();
    this.pending = [];
    this.inputSeq = 0;
    this.localId = 0;
    this.targetId = 0;
    this.auftrag = undefined;
    this.schlaegtZu = false;
    this.schwungLief = false;
    this.input.setAutoWish(0, 0);
    this.poseValid = false;
    this.serverSeen = false;
    this.dead = false;
    this.ui.setDead(false);
    this.ui.setTarget(undefined);
  }

  private systemLine(text: string): void {
    this.ui.addChat(0, '', text);
  }

  private applySnapshot(msg: {
    tick: number;
    ackInputSeq: number;
    serverTimeMs?: number;
    spawns: Array<Parameters<WorldView['spawn']>[0]>;
    updates: Array<Parameters<WorldView['update']>[0]>;
    despawns: number[];
    loot?: LootRow[];
  }): void {
    // Waehrend eine Karte geladen wird, gehoert dieser Snapshot noch keiner
    // Welt. Aufheben und danach nachspielen.
    if (this.mapLoad !== undefined) {
      this.queuedSnapshots.push(msg);
      if (this.queuedSnapshots.length > MAX_QUEUED_SNAPSHOTS) this.queuedSnapshots.shift();
      return;
    }

    for (const row of msg.spawns) {
      this.view.spawn(row);
      if (row.id === this.localId) this.seedPrediction(row.x, row.z, row.yaw, row.hp, row.maxHp);
    }
    for (const row of msg.updates) this.view.update(row);
    for (const id of msg.despawns) {
      this.view.despawn(id);
      if (id === this.targetId) this.setTarget(0);
    }

    // Die volle Liste, kein Abgleich: was der Server nicht mehr nennt, liegt
    // nicht mehr da. Fehlt das Feld ganz — beim Nachspielen aufgehobener
    // Snapshots aus einer älteren Fassung —, bleibt die Ansicht wie sie war.
    if (msg.loot) this.view.loot.sync(msg.loot);

    const self = this.view.entities.get(this.localId);
    if (self) {
      // Die Puppe im Inventar trägt, was der Server meldet — dieselbe Quelle
      // wie die Figur in der Welt.
      this.ui.setDollAppearance(self.weapon, self.outfit, self.setGlow);

      const nowDead = self.state === EntityState.Dead;
      if (nowDead !== this.dead) {
        this.dead = nowDead;
        this.ui.setDead(nowDead);
      }
      this.ui.setHp(self.hp);

      // Die Lage, die der Server meldet, hier festhalten und nicht später aus
      // der Ansicht lesen: für die eigene Figur überschreibt `setLocal` deren
      // Zielwerte in jedem Bild mit der Vorhersage. Wer sie danach abfragt,
      // vergleicht die Vorhersage mit sich selbst — und sieht nie eine
      // Abweichung, auch wenn der Server ganz woanders rechnet.
      this.serverX = self.targetX;
      this.serverZ = self.targetZ;
      this.serverSeen = true;

      this.reconcile(msg.ackInputSeq, self.targetX, self.targetZ, self.targetYaw);
    }

    const target = this.targetId ? this.view.entities.get(this.targetId) : undefined;
    this.ui.setTarget(target);
  }

  /** Setzt die eigene Figur in die Vorhersagewelt, sobald der Server sie meldet. */
  private seedPrediction(x: number, z: number, yaw: number, hp: number, maxHp: number): void {
    const world = this.prediction;
    if (!world || this.localId === 0) return;

    // Ueber einen Sprung hinweg darf nicht interpoliert werden — sonst
    // schwebt die Figur sichtbar von der alten zur neuen Stelle.
    this.poseValid = false;
    // Die Blickrichtung kommt vom Server; ohne das steht die Figur nach dem
    // Einloggen nach Norden, egal wie sie sich abgemeldet hat.
    this.input.setFacing(yaw);
    this.applyProfileToPrediction();

    world.removeEntity(this.localId);
    world.spawnPlayer({
      id: this.localId,
      level: this.stats?.level ?? 1,
      x,
      z,
      yaw,
      hp,
      maxHp,
      mp: 0,
      maxMp: 1,
      // Schaden und Verteidigung sind für die Vorhersage bedeutungslos — sie
      // rechnet keinen Kampf. Tempo und Maße sind es nicht.
      attackDamage: 1,
      defense: 0,
      moveSpeed: this.stats ? 6.2 : 6.2,
      attackRange: playerProfile().attackRange,
      attackCooldownSec: playerProfile().attackCooldownSec,
      attackWindupSec: playerProfile().attackWindupSec,
      // Die Vorhersage heilt nicht. Leben kommt vom Server, und eine Figur,
      // die im Client nebenher regeneriert, zeigt eine Leiste, die es nicht
      // gibt.
      hpRegen: 0,
      mpRegen: 0,
      attackStyle: 0,
      radius: playerProfile().radius,
      height: playerProfile().height,
    });
    // Und gleich das Profil der angelegten Waffe darüber. Getrennt, weil beim
    // Erscheinen noch nicht feststeht, ob das Inventar schon da ist.
    this.applyProfileToPrediction();
  }

  /**
   * Gleicht Vorhersage und Autorität ab.
   *
   * Weil beide Seiten dieselbe wasm-Binärdatei rechnen, ist die Abweichung im
   * Normalfall null. Sie entsteht durch verlorene oder umsortierte Pakete —
   * und dann muss sie weg, sonst summiert sie sich.
   */
  private reconcile(ackSeq: number, serverX: number, serverZ: number, serverYaw: number): void {
    const world = this.prediction;
    if (!world || this.localId === 0) return;

    const anchor = this.pending.find((p) => p.seq === ackSeq);
    this.pending = this.pending.filter((p) => p.seq > ackSeq);

    if (!anchor) return;

    const error = Math.hypot(serverX - anchor.x, serverZ - anchor.z);
    if (error > this.diagnostics.maxReconcileError) this.diagnostics.maxReconcileError = error;
    if (error <= RECONCILE_THRESHOLD) return;
    this.diagnostics.reconciles++;

    // Zurück auf den Stand des Servers, dann alles nachspielen, was der Server
    // noch nicht gesehen hat.
    world.teleport(this.localId, serverX, serverZ, serverYaw);
    this.poseValid = false;
    for (const p of this.pending) {
      world.applyInput(this.localId, p.moveX, p.moveZ, p.yaw, p.buttons, TICK_SECONDS);
      world.step(TICK_SECONDS);
      world.drainEvents();
      const row = this.localRow();
      if (row) {
        p.x = row.x;
        p.z = row.z;
      }
    }
  }

  private applyCombat(msg: {
    attackerId: number;
    victimId: number;
    damage: number;
    flags: number;
    x: number;
    y: number;
    z: number;
  }): void {
    // Hier wird **nicht** die Schlaganimation ausgelöst.
    //
    // Diese Nachricht ist der Treffer, also das *Ende* des Ausholens — eine
    // Animation, die hier begänne, liefe hinter ihrem eigenen Schaden her.
    // Der Beginn steht im Zustandswechsel nach `Attack`, den der Schnappschuss
    // meldet, und für die eigene Figur im Tastendruck.
    //
    // Es war außerdem ein zweiter, unabhängiger Auslöser: dieselbe Schwinge
    // konnte zweimal beginnen, wenn Zustandswechsel und Treffer weiter
    // auseinanderlagen als die Animation dauert. Genau daraus wurde der
    // doppelte Schusston.
    const mine = msg.attackerId === this.localId;
    const onMe = msg.victimId === this.localId;

    /**
     * Der Einschlag: Funken, und für die Beteiligten die Zahl.
     *
     * Zusammen und nicht getrennt, weil beides denselben Moment beschreibt.
     * Fremder Schaden an fremden Zielen bekommt Funken, aber keine Zahl — die
     * würde nur den Bildschirm füllen.
     */
    const impact = (): void => {
      const critical = (msg.flags & CombatFlag.Critical) !== 0;
      const killing = (msg.flags & CombatFlag.Killing) !== 0;

      burstHit(this.view.particles, msg.x, msg.y, msg.z, {
        critical,
        killing,
        budget: this.quality.particleBudget,
      });

      // Der Einschlag klingt dort, wo er stattfindet — nicht beim Spieler.
      // Die Stelle kommt vom Server und ist dieselbe, aus der die Funken
      // sprühen; Bild und Ton beschreiben denselben Punkt im Raum.
      const ton = SOUNDS[killing ? 'treffer_toedlich' : critical ? 'treffer_kritisch' : 'treffer'];
      this.mixer.play(ton.path, ton.category, (path) => this.streamer.request(path), {
        at: { x: msg.x, y: msg.y, z: msg.z },
        gain: ton.gain,
        spread: ton.spread,
      });

      if (!mine && !onMe) return;
      const kind = onMe ? 'taken' : critical ? 'crit' : 'dealt';
      this.ui.overlay.addNumber(msg.x, msg.y, msg.z, String(msg.damage), kind);
    };

    // Ein Fernkampftreffer bekommt seinen Pfeil — und der Einschlag wartet, bis
    // der Pfeil da ist. Der Schaden ist längst gefallen; das Bild darf trotzdem
    // in der richtigen Reihenfolge kommen.
    if ((msg.flags & CombatFlag.Ranged) !== 0) {
      this.view.spawnArrow(msg.attackerId, msg.x, msg.y, msg.z, impact);
      // Der Schuss klingt, wenn ein Pfeil fliegt — und nur dann. Ein Bogen,
      // der ins Leere gezogen wird, gibt kein Sirren.
      this.playProjectileSound(msg.attackerId);
      return;
    }

    impact();
  }

  // -------------------------------------------------------------------------
  // Zielauswahl
  // -------------------------------------------------------------------------

  /**
   * Zieht die Serveruhr nach.
   *
   * Beim ersten Mal hart, danach geglättet — ein einzelner verspäteter
   * Snapshot soll die Sonne nicht springen lassen. Die Laufzeit des Pakets
   * wird nicht herausgerechnet: bei einer Tageslänge von vierundzwanzig
   * Minuten sind fünfzig Millisekunden Versatz drei Zehntel einer Spielsekunde.
   */
  private syncClock(serverTimeMs: number): void {
    const offset = serverTimeMs - Date.now();
    if (!this.clockSeen) {
      this.clockOffset = offset;
      this.clockSeen = true;
      return;
    }
    this.clockOffset = this.clockOffset * 0.95 + offset * 0.05;
  }

  /** Die Weltzeit in Millisekunden — Geräteuhr plus gemessener Versatz. */
  private get worldTimeMs(): number {
    return Date.now() + this.clockOffset;
  }

  /** Wo zuletzt ein NPC angetippt wurde — für die Lage seines Auswahlmenüs. */
  private npcKlickX = 0;
  private npcKlickY = 0;
  /** Was die Figur von selbst tut — siehe `Auftrag`. */
  private auftrag?: Auftrag;
  /** Schlägt die Figur in diesem Schritt zu? Ergebnis von `steuere`. */
  private schlaegtZu = false;
  /** Lief im letzten Schritt schon ein Schwung? Für die Flanke der Animation. */
  private schwungLief = false;

  private pickTarget(ndcX: number, ndcY: number): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const clickX = ((ndcX + 1) / 2) * width;
    const clickY = ((1 - ndcY) / 2) * height;

    let best: EntityVisual | undefined;
    let bestDist = PICK_RADIUS_PX;
    // NPCs werden nicht angegriffen, sondern angesprochen. Sie stehen deshalb
    // in einer eigenen Auswahl: sonst nähme ein NPC dem Monster dahinter das
    // Ziel weg, und man schlüge ins Leere, statt zu reden.
    let bestNpc: EntityVisual | undefined;
    let bestNpcDist = PICK_RADIUS_PX;

    for (const e of this.view.entities.values()) {
      if (e.id === this.localId) continue;
      if (e.state === EntityState.Dead) continue;

      if (e.type === EntityType.Npc) {
        this.projection.set(e.x, e.y + e.height * 0.5, e.z).project(this.scene.camera);
        if (this.projection.z > 1) continue;
        const nx = (this.projection.x * 0.5 + 0.5) * width;
        const ny = (-this.projection.y * 0.5 + 0.5) * height;
        const nd = Math.hypot(nx - clickX, ny - clickY);
        if (nd < bestNpcDist && this.sichtFrei(e.x, e.y + e.height * 0.5, e.z)) {
          bestNpcDist = nd;
          bestNpc = e;
        }
        continue;
      }

      this.projection.set(e.x, e.y + e.height * 0.5, e.z).project(this.scene.camera);
      if (this.projection.z > 1) continue;

      const sx = (this.projection.x * 0.5 + 0.5) * width;
      const sy = (-this.projection.y * 0.5 + 0.5) * height;
      const d = Math.hypot(sx - clickX, sy - clickY);
      // Die Sichtprüfung erst hier, wo dieses Wesen das beste wäre: sie kostet
      // einen Abstieg durchs Höhenfeld, und den für jedes Wesen der Karte zu
      // bezahlen wäre Verschwendung. Fällt der Beste durch, gewinnt eben der
      // Nächste — genau richtig, denn hinter dem Berg steht er ja nicht.
      if (d < bestDist && this.sichtFrei(e.x, e.y + e.height * 0.5, e.z)) {
        bestDist = d;
        best = e;
      }
    }

    // Ein getroffenes Monster gewinnt gegen einen NPC dahinter — im Gefecht
    // will man kämpfen, nicht plaudern.
    //
    // Beute gewinnt, wenn sie näher am Zeiger liegt als das Monster.
    //
    // Vorher kam sie erst dran, wenn gar nichts anderes getroffen war — mit
    // dem Ergebnis, dass ein Haufen vor den Füssen eines Monsters nicht
    // anzuklicken war: man schlug zu, statt aufzuheben. Ein Vergleich der
    // Abstände beantwortet beide Fälle, ohne dass einer von ihnen eine
    // Ausnahme braucht: wer auf das Monster zielt, trifft das Monster.
    const beute = this.lootUnderPointer(ndcX, ndcY);
    if (beute.id > 0 && (!best || beute.dist <= bestDist)) {
      this.pickupLoot(beute.id);
      return;
    }

    if (best) {
      // Erster Klick visiert an, zweiter greift an. Wer schon anvisiert hat,
      // will beim nächsten Klick nicht dasselbe noch einmal — er will los.
      if (this.targetId === best.id) this.greifeAn(best.id);
      else this.setTarget(best.id);
      return;
    }
    if (bestNpc) {
      // Ansprechen heisst stehenbleiben. Ohne das liefe ein Auftrag von vorhin
      // weiter — und weil ein laufender Auftrag das Gespräch schliesst, ginge
      // das Fenster im selben Moment wieder zu, in dem es aufgeht.
      this.brichAuftragAb();
      // Wo geklickt wurde, wird gemerkt: die Antwort des Servers kommt einen
      // Wimpernschlag später, und das Auswahlmenü soll dort aufgehen, wo man
      // hingesehen hat — nicht in der Bildmitte.
      this.npcKlickX = clickX;
      this.npcKlickY = clickY;
      this.connection?.sendInteract(bestNpc.id);
      return;
    }

    // Ins Leere geklickt heisst: dorthin laufen. Die Auswahl bleibt stehen —
    // sie ist keine Absicht, sondern eine Ansicht. Der laufende Auftrag endet
    // trotzdem, und genau das ist der Ausstieg aus dem Kampf: man klickt
    // irgendwohin, die Figur löst sich und das Monster bleibt anvisiert.
    const boden = this.bodenPunkt(ndcX, ndcY);
    if (boden) {
      this.auftrag = { art: 'gehen', x: boden.x, z: boden.z };
      // Die Marke steht auf der Höhe des Geländes an dieser Stelle — dieselbe
      // Rechnung wie für den Boden unter der Figur. Auf fester Höhe läge sie
      // an einem Hang in der Luft oder im Berg.
      //
      // Und weil ein Ring breiter ist als ein Punkt, bekommt er die Auskunft
      // gleich mit: seine Punkte legen sich einzeln auf das Gelände. Eine
      // waagerechte Scheibe verschwindet am Hang zur Hälfte im Boden.
      //
      // Gefragt wird das **Netz** und nicht der Kern. Der Kern rechnet eine
      // stetige Fläche, gezeichnet werden Dreiecke mit vier bis acht Einheiten
      // Maschenweite, und dazwischen liegt die gerechnete Höhe regelmässig
      // über dem Dreieck. Ein Ring von knapp einer Einheit passt fast immer in
      // eine einzige Masche — er lag deshalb ganz oder halb unter dem Boden,
      // je nachdem, wohin man geklickt hat.
      const hoehe = (x: number, z: number) => this.view.gelaendeHoehe(x, z) ?? 0;
      this.view.laufmarke.setze(boden.x, hoehe(boden.x, boden.z), boden.z, hoehe);
    } else this.brichAuftragAb();
  }

  /**
   * Steht zwischen der Kamera und diesem Punkt ein Berg?
   *
   * Anklicken soll man nur, was man auch sieht. Ohne diese Prüfung reichte es,
   * dass ein Monster **irgendwo** in der Nähe des Zeigers steht — auch hinter
   * einem Hügel, wo kein Bildpunkt von ihm zu sehen ist. Man visierte dann
   * etwas an, das gar nicht da war, und die Figur lief los.
   *
   * Geprüft wird gegen das Höhenfeld und nicht gegen die gezeichneten Kacheln:
   * das Höhenfeld ist überall da, auch wo die Sichtweite noch keine Kachel
   * geladen hat, und es kennt dieselbe Rechnung wie der Server.
   *
   * Nur Gelände. Ein Haus verdeckt nicht — Props stehen nicht im Höhenfeld,
   * und ein zweiter Satz Körper nur für diese Frage wäre eine zweite Wahrheit
   * darüber, wo etwas steht.
   */
  private sichtFrei(zx: number, zy: number, zz: number): boolean {
    const welt = this.prediction;
    if (!welt) return true;

    const kamera = this.scene.camera.position;
    const dx = zx - kamera.x;
    const dy = zy - kamera.y;
    const dz = zz - kamera.z;
    const weite = Math.hypot(dx, dz);
    if (weite < 1e-3) return true;

    // Die beiden Enden bleiben aussen vor: an der Kamera steht die Kamera, am
    // Ziel das Ziel, und beide stünden sich sonst selbst im Weg.
    const schritte = Math.min(64, Math.max(4, Math.ceil(weite / SICHT_SCHRITT)));
    for (let i = 1; i < schritte; i++) {
      const t = i / schritte;
      const x = kamera.x + dx * t;
      const y = kamera.y + dy * t;
      const z = kamera.z + dz * t;
      if (y < welt.heightAt(x, z) - SICHT_LUFT) return false;
    }
    return true;
  }

  /**
   * Wo der Strahl durch diese Bildstelle den Boden trifft.
   *
   * Gesucht wird am **Höhenfeld** und nicht am gezeichneten Gelände: der Boden
   * ist in Kacheln zerlegt, die je nach Sichtweite da sind oder nicht, und ein
   * Klick auf eine nicht geladene Kachel fände nichts. Das Höhenfeld kennt
   * dieselbe Rechnung wie der Server — es gibt keine zweite Vorstellung davon,
   * wo der Boden liegt.
   *
   * Erst grob abschreiten, dann halbieren: das Gelände ist nicht monoton, ein
   * reines Halbieren über die ganze Strecke könnte einen Hügel überspringen.
   */
  private bodenPunkt(ndcX: number, ndcY: number): { x: number; z: number } | undefined {
    const welt = this.prediction;
    if (!welt) return undefined;

    this.zeiger.set(ndcX, ndcY);
    this.strahl.setFromCamera(this.zeiger, this.scene.camera);
    const o = this.strahl.ray.origin;
    const d = this.strahl.ray.direction;
    // Waagerecht oder in den Himmel: da liegt kein Boden.
    if (d.y > -1e-3) return undefined;

    let ueber = 0;
    for (let t = BODEN_SCHRITT; t <= BODEN_WEITE; t += BODEN_SCHRITT) {
      const x = o.x + d.x * t;
      const y = o.y + d.y * t;
      const z = o.z + d.z * t;
      if (y > welt.heightAt(x, z)) {
        ueber = t;
        continue;
      }

      let hoch = t;
      let tief = ueber;
      for (let i = 0; i < 12; i++) {
        const m = (tief + hoch) * 0.5;
        const mx = o.x + d.x * m;
        const my = o.y + d.y * m;
        const mz = o.z + d.z * m;
        if (my > welt.heightAt(mx, mz)) tief = m;
        else hoch = m;
      }
      return { x: o.x + d.x * hoch, z: o.z + d.z * hoch };
    }
    return undefined;
  }

  /**
   * Nimmt den Kampf gegen dieses Wesen auf.
   *
   * Angegriffen wird nur, was sich angreifen lässt: ein NPC ist zum Reden da,
   * ein anderer Spieler zurzeit unantastbar. Ohne diese Prüfung liefe die
   * Figur zu einem Händler und schlüge ins Leere, weil der Server den Schlag
   * folgerichtig verwirft.
   */
  private greifeAn(entityId: number): void {
    if (this.dead) return;
    const ziel = this.view.entities.get(entityId);
    if (!ziel || ziel.type !== EntityType.Monster || ziel.state === EntityState.Dead) return;

    this.setTarget(entityId);
    this.auftrag = { art: 'kampf', entityId };
  }

  /** Beendet den laufenden Auftrag. Die Auswahl bleibt, wie sie ist. */
  private brichAuftragAb(): void {
    if (!this.auftrag) return;
    this.auftrag = undefined;
    this.input.setAutoWish(0, 0);
  }

  /**
   * Die Angriffstaste — Leertaste am Schreibtisch, Knopf auf dem Telefon.
   *
   * Sie greift an, was ausgewählt ist, und tut sonst nichts. Ein zweiter Weg
   * ins Gefecht, aber kein zweites Regelwerk: derselbe Auftrag wie beim
   * zweiten Klick.
   */
  private angriffTaste(): void {
    if (this.targetId === 0) return;
    this.greifeAn(this.targetId);
  }

  /**
   * Welcher Beutehaufen liegt unter dieser Bildstelle — und wie weit daneben.
   *
   * Eine Stelle für drei Nutzer: der Klick, der Handzeiger und die Sperre des
   * Schlags. Stünde die Rechnung dreimal da, zeigte irgendwann die Maus eine
   * Hand über etwas, das der Klick nicht trifft.
   */
  private lootUnderPointer(ndcX: number, ndcY: number): { id: number; dist: number } {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const px = ((ndcX + 1) / 2) * width;
    const py = ((1 - ndcY) / 2) * height;

    let id = 0;
    let dist = PICK_RADIUS_PX;
    for (const { row } of this.view.loot.piles.values()) {
      this.projection.set(row.x, row.y + 0.5, row.z).project(this.scene.camera);
      if (this.projection.z > 1) continue;
      const lx = (this.projection.x * 0.5 + 0.5) * width;
      const ly = (-this.projection.y * 0.5 + 0.5) * height;
      const d = Math.hypot(lx - px, ly - py);
      if (d < dist && this.sichtFrei(row.x, row.y + 0.5, row.z)) {
        dist = d;
        id = row.id;
      }
    }
    return { id, dist };
  }

  /**
   * Bittet den Server, einen Haufen aufzuheben.
   *
   * Der Client nimmt nichts vorweg — kein Ausblenden des Modells, keine Zeile
   * im Beutel. Ob der Haufen noch da ist und ob er dem Spieler zusteht, weiss
   * nur der Server; ein vorweggenommenes Aufheben müsste in dem Moment
   * zurückgenommen werden, in dem ein anderer schneller war.
   */
  private pickupLoot(lootId: number): void {
    if (this.dead) return;

    // Zu weit weg? Dann wird hingelaufen statt abgelehnt.
    //
    // Der Server prüft die Entfernung ohnehin noch einmal; eine Bitte aus
    // zwanzig Metern wäre also nicht falsch, nur nutzlos — und der Spieler
    // bekäme „zu weit weg" zu lesen, obwohl er genau weiss, wo der Haufen
    // liegt. Hinlaufen ist die Antwort, die er meint.
    const haufen = this.view.loot.piles.get(lootId);
    if (haufen && !this.inPickupRange(haufen.row.x, haufen.row.z)) {
      this.auftrag = { art: 'beute', lootId };
      return;
    }

    this.brichAuftragAb();
    this.connection?.sendPickupLoot(lootId);
  }

  /**
   * Steht die Figur nah genug an dieser Stelle, um aufzuheben?
   *
   * Absichtlich strenger als der Server: der rechnet mit **seiner** Lage der
   * Figur, und die Vorhersage ist ihm um die Laufzeit voraus. Wer den Rand
   * der Reichweite ausreizt, fragt aus Sicht des Servers aus dem Nirgendwo —
   * die Figur steht dann vor dem Haufen, und es geschieht nichts.
   *
   * Deshalb eine Antwort für beide Nutzer, den Klick und den Weg dorthin:
   * gälte für den Klick der ganze Radius und für den Weg ein kleinerer, gäbe
   * es zwei Entfernungen, die beide „nah genug" heissen.
   */
  private inPickupRange(x: number, z: number): boolean {
    const reichweite = tuning().loot.pickupRange * PICKUP_SICHERHEIT;
    const dx = x - this.poseCurr.x;
    const dz = z - this.poseCurr.z;
    return dx * dx + dz * dz <= reichweite * reichweite;
  }

  /**
   * Wie nah die Figur an dieses Ziel heran muss, um es zu treffen.
   *
   * Reichweite der Waffe plus die Hülle des Ziels, abzüglich etwas Luft — die
   * Rechnung des Kerns, um `KAMPF_LUFT` verschärft. Der Radius kommt aus
   * derselben Inhaltstabelle, aus der ihn auch der Server in den Kern gibt;
   * ein hier angenommener Wert wäre eine zweite Wahrheit über die Grösse eines
   * Monsters.
   */
  /**
   * Steht ein lebendes Monster in Schlagweite?
   *
   * Mit der **getragenen** Waffe gerechnet: `this.profile` kommt aus der
   * angelegten Ausrüstung, ein Bogen reicht also weiter als eine Faust. Und
   * bis zur Hülle des Monsters, wie überall — dieselbe Rechnung wie
   * `kampfReichweite`, damit der Knopf nicht zu einem Schlag einlädt, den der
   * Kern gleich verwirft.
   *
   * Über alle Monster und nicht nur über das anvisierte: wer nichts anvisiert
   * hat, aber mitten in einer Gruppe steht, soll den Knopf trotzdem sehen —
   * der erste Druck sucht sich dann sein Ziel.
   */
  /**
   * Das nächste lebende Monster in Schlagweite — oder 0.
   *
   * Eine Frage, eine Antwort, zwei Verwender: der Angriffsknopf am Telefon
   * erscheint genau dann, wenn hier etwas herauskommt, und beim Drücken wird
   * genau das angegriffen. Zwei getrennte Rechnungen wären zwei Vorstellungen
   * von „in Reichweite", und die eine liesse einen Knopf erscheinen, den die
   * andere für gegenstandslos hielte.
   *
   * Die Reichweite hängt an der getragenen Waffe und am Umfang des Ziels —
   * siehe `kampfReichweite`. Ein Bogen holt weiter aus als eine Faust.
   *
   * Gemessen wird mit den zuletzt **gemeldeten** Lagen, nicht mit den
   * gezeichneten: genau das tut auch der Kampfauftrag, und der Server prüft
   * ebenso. Mit der gezeichneten Lage wäre der Knopf ein paar Zehntel früher
   * da als der Schlag — und man drückte ins Leere, während die Figur noch
   * einen halben Schritt nachlaufen muss.
   */
  private naechstesZiel(): number {
    let besterAbstand = Infinity;
    let bestes = 0;
    for (const e of this.view.entities.values()) {
      if (e.type !== EntityType.Monster || e.state === EntityState.Dead) continue;
      const abstand = this.kampfAbstand(e);
      if (abstand > this.kampfReichweite(e)) continue;
      if (abstand < besterAbstand) {
        besterAbstand = abstand;
        bestes = e.id;
      }
    }
    return bestes;
  }

  /** Wie weit die Figur von diesem Wesen entfernt ist — in Kampfrechnung. */
  private kampfAbstand(ziel: EntityVisual): number {
    return Math.hypot(ziel.targetX - this.poseCurr.x, ziel.targetZ - this.poseCurr.z);
  }

  /**
   * Der Angriffsknopf am Telefon wurde gedrückt.
   *
   * Ohne Ziel geschah bisher nichts: der Knopf war zu sehen, weil etwas in
   * Reichweite stand, und tat trotzdem nichts, weil niemand es angeklickt
   * hatte. Am Telefon ist das Anklicken eines Monsters aber die mühsamere
   * Geste von beiden — der Knopf ist da, um sie zu ersparen.
   *
   * Also: wer schon ein taugliches Ziel hat, schlägt darauf ein; wer keines
   * hat oder dessen Ziel tot oder aus der Reichweite gelaufen ist, bekommt
   * das nächststehende. Das ist dasselbe, das den Knopf hat erscheinen
   * lassen.
   */
  private angriffsknopf(): void {
    if (this.dead) return;

    const bisher = this.view.entities.get(this.targetId);
    const taugt =
      bisher !== undefined &&
      bisher.type === EntityType.Monster &&
      bisher.state !== EntityState.Dead &&
      this.kampfAbstand(bisher) <= this.kampfReichweite(bisher);

    const ziel = taugt ? this.targetId : this.naechstesZiel();
    if (ziel !== 0) this.greifeAn(ziel);
  }

  private kampfReichweite(ziel: EntityVisual): number {
    const radius = getMob(ziel.defId)?.radius ?? MOB_RADIUS_FALLBACK;
    return Math.max(0.9, this.profile.range + radius - KAMPF_LUFT);
  }

  /**
   * Führt den laufenden Auftrag einen Schritt weiter.
   *
   * Läuft **vor** dem Einlesen der Eingabe: der Bewegungswunsch geht durch
   * dieselbe Glättung wie die Hand am Joystick, und die liest ihn im selben
   * Takt. Danach entscheidet `manual`, ob der Spieler das Steuer übernommen
   * hat — dann ist der Auftrag zu Ende, ohne dass er ihn abbrechen müsste.
   *
   * Eine Stelle für alle drei Sorten, und eine Antwort für den Schritt:
   * `schlaegtZu`. Stünde der Angriff woanders, gäbe es einen Zustand, in dem
   * die Figur zuschlägt und gleichzeitig irgendwohin läuft.
   */
  private steuere(): void {
    this.schlaegtZu = false;

    const auftrag = this.auftrag;
    if (!auftrag) return;
    if (this.dead) {
      this.brichAuftragAb();
      return;
    }

    if (auftrag.art === 'gehen') {
      const dx = auftrag.x - this.poseCurr.x;
      const dz = auftrag.z - this.poseCurr.z;
      if (Math.hypot(dx, dz) <= GEH_ANKUNFT) this.brichAuftragAb();
      else this.laufeNach(dx, dz);
      return;
    }

    if (auftrag.art === 'beute') {
      const haufen = this.view.loot.piles.get(auftrag.lootId);
      if (!haufen) {
        this.brichAuftragAb();
        return;
      }
      const { x, z, id } = haufen.row;
      if (this.inPickupRange(x, z)) {
        this.brichAuftragAb();
        this.connection?.sendPickupLoot(id);
        return;
      }
      this.laufeNach(x - this.poseCurr.x, z - this.poseCurr.z);
      return;
    }

    // Kampf: hinlaufen, bis es reicht, dann stehen bleiben und schlagen.
    const ziel = this.view.entities.get(auftrag.entityId);
    if (!ziel || ziel.state === EntityState.Dead) {
      // Erledigt oder verschwunden. Die Auswahl räumt der Snapshot weg, wenn
      // das Wesen tatsächlich aus der Welt geht — bis dahin bleibt der
      // Kadaver anvisiert, so wie man ihn zuletzt gesehen hat.
      this.brichAuftragAb();
      return;
    }

    // Gerechnet wird mit der zuletzt **gemeldeten** Lage und nicht mit der
    // gezeichneten: die läuft der Meldung um einige Zehntel hinterher, und der
    // Server prüft gegen die gemeldete.
    const dx = ziel.targetX - this.poseCurr.x;
    const dz = ziel.targetZ - this.poseCurr.z;

    if (Math.hypot(dx, dz) > this.kampfReichweite(ziel)) {
      // Beim Anlaufen dreht die Steuerung ohnehin in die Laufrichtung, und die
      // zeigt zum Ziel. Ein zweiter Drehwunsch daneben wäre ohne Wirkung —
      // oder schlimmer: `setFacing` stellt den Betrag der Bewegung auf null,
      // und die Figur käme im Schneckentempo an.
      this.laufeNach(dx, dz);
      return;
    }

    this.input.setAutoWish(0, 0);
    // In Reichweite steht die Figur still — jetzt zählt, wohin sie schaut.
    this.input.richteAus(Math.atan2(dx, dz));
    this.schlaegtZu = true;
  }

  /** Setzt den Bewegungswunsch in diese Richtung. Länge egal, Richtung zählt. */
  private laufeNach(dx: number, dz: number): void {
    const laenge = Math.hypot(dx, dz);
    if (laenge < 1e-3) return;
    this.input.setAutoWish(dx / laenge, dz / laenge);
  }

  /**
   * Sucht das Tor, in dem die Figur steht.
   *
   * Dieselbe Rechnung, die der Server bei der Anfrage nochmals anstellt — hier
   * nur, um den Hinweis einzublenden. Was der Client hier findet, ist ein
   * Vorschlag, keine Erlaubnis.
   */
  private updateNearbyPortal(x: number, z: number): void {
    const portals = this.mapDoc?.portals;
    let found: string | undefined;
    let label = '';

    if (portals && !this.dead) {
      for (const portal of portals) {
        const dx = x - portal.position[0];
        const dz = z - portal.position[1];
        if (dx * dx + dz * dz <= portal.radius * portal.radius) {
          found = portal.id;
          label = portal.label || 'Tor';
          break;
        }
      }
    }

    if (found === this.nearbyPortalId) return;
    this.nearbyPortalId = found;
    this.ui.setPortalPrompt(found ? label : undefined);
  }

  /** Überträgt das Angriffsprofil in die Vorhersagewelt. */
  private applyProfileToPrediction(): void {
    if (!this.prediction || this.localId === 0) return;
    this.prediction.setAttackProfile(
      this.localId,
      this.profile.style,
      this.profile.range,
      this.profile.cooldownSec,
      this.profile.windupSec,
    );
  }

  /** Schickt die Bitte, das Tor zu benutzen, in dem die Figur steht. */
  private usePortal(): void {
    if (!this.nearbyPortalId) return;
    this.connection?.sendUsePortal(this.nearbyPortalId);
  }

  /**
   * Visiert etwas an — oder nichts, bei 0.
   *
   * Die Auswahl geht an den Server, weil er den Schaden austeilt: getroffen
   * wird ausschliesslich, was anvisiert ist. Ein Wechsel beendet einen
   * laufenden Kampf; wer auf ein anderes Wesen klickt, will nicht, dass das
   * alte weiter geschlagen wird.
   */
  private setTarget(id: number): void {
    if (this.targetId === id) return;
    if (this.auftrag?.art === 'kampf') this.brichAuftragAb();
    this.targetId = id;
    this.connection?.sendTarget(id);
    this.ui.setTarget(id ? this.view.entities.get(id) : undefined);
  }

  // -------------------------------------------------------------------------
  // Takte
  // -------------------------------------------------------------------------

  private localRow(): CoreEntityRow | undefined {
    const world = this.prediction;
    if (!world) return undefined;
    this.predictionRows = world.readEntities(this.predictionRows);
    return this.predictionRows.find((r) => r.id === this.localId);
  }

  /** Simulationsschritt. Feste Schrittweite, sonst driftet die Vorhersage. */
  private simulate(): void {
    const world = this.prediction;
    const connection = this.connection;
    if (!world || !connection || this.localId === 0) return;

    // Der laufende Auftrag, bevor die Eingabe gelesen wird — sein
    // Bewegungswunsch ist einer wie jeder andere.
    this.steuere();

    // Solange der Chat den Fokus hat, nimmt die Eingabe nichts mehr an — sie
    // läuft aber weiter, damit die Figur ausläuft statt stehenzubleiben.
    const snapshot = this.input.read(TICK_SECONDS, this.ui.chatHasFocus);

    // Wer selbst steuert, hat den Auftrag übernommen — und damit beendet.
    // Das ist der Ausstieg aus dem Kampf, den man mit WASD oder dem Joystick
    // nimmt: die Figur läuft los und hört auf zu schlagen, das Monster bleibt
    // anvisiert. Gefragt ist die **Absicht** und nicht die Bewegung: die
    // Glättung lässt die Figur auch dann noch laufen, wenn niemand mehr etwas
    // drückt.
    if (snapshot.manual && this.auftrag) {
      this.brichAuftragAb();
      this.schlaegtZu = false;
    }

    // Wer losgeht, ist mit dem Reden fertig.
    //
    // Gemeint ist jede Art von Losgehen: eigene Steuerung ebenso wie ein
    // angeklicktes Ziel. Ein Gesprächsfenster, das an der Stelle stehen
    // bleibt, an der man den NPC verlassen hat, verdeckt danach die halbe
    // Welt — und der Laden zeigt Waren von jemandem, der zwanzig Meter weiter
    // hinten steht.
    //
    // Die Abfrage kostet nur einen Blick auf vier Merker; geschlossen wird
    // erst, wenn tatsächlich etwas offen ist.
    if ((snapshot.manual || this.auftrag !== undefined) && this.ui.npcFensterOffen) {
      this.ui.closeDialog();
    }

    // Angriff und Sprung sind unabhängig: man kann im Sprung weiterschlagen,
    // und ein Sprung bricht keinen Auftrag ab — er ist keine Bewegung im Sinne
    // der Steuerung, sondern eine Geste nach oben.
    /*
     * Ohne Pfeile kein Schuss — und zwar auch hier.
     *
     * Entschieden wird das auf dem Server; er nimmt die Taste heraus, bevor
     * sie in den Kern geht. Genau deshalb muss der Client dasselbe tun: seine
     * Vorhersage rechnet mit demselben Kern, und ein Schlag, den nur eine
     * Seite beginnt, ist ein Vorlauf, in dem nur eine Seite langsamer wird.
     * Sichtbar wäre das als Zucken bei jedem Klick auf ein Monster.
     */
    const schiesst = this.profile.style === 1;
    const munition = schiesst
      ? this.inventar.some((e) => !e.equipped && getItem(e.itemId)?.kind === 'ammo')
      : true;

    const buttons =
      (this.schlaegtZu && !this.dead && munition ? CoreButton.Attack : 0) |
      (snapshot.sprung && !this.dead ? CoreButton.Jump : 0);

    const seq = ++this.inputSeq;

    this.diagnostics.input.moveX = snapshot.moveX;
    this.diagnostics.input.moveZ = snapshot.moveZ;
    this.diagnostics.input.yaw = snapshot.yaw;
    this.diagnostics.auftrag.art = this.auftrag?.art ?? 'nichts';
    this.diagnostics.auftrag.zielId =
      this.auftrag?.art === 'kampf' ? this.auftrag.entityId : 0;
    this.diagnostics.auftrag.angriff = buttons !== 0;
    this.diagnostics.ticks++;

    // Die Marke lebt anderthalb Sekunden; wer sie prüfen will, muss sie in
    // dieser Zeit antreffen. Deshalb bei jedem Schritt und nicht auf Anfrage.
    const marke = this.view.laufmarke.punkteWelt();
    this.diagnostics.laufmarke.sichtbar = marke.length > 0;
    this.diagnostics.laufmarke.punkte = marke.map((p) => ({
      ...p,
      boden: this.view.gelaendeHoehe(p.x, p.z) ?? 0,
      kern: this.prediction?.heightAt(p.x, p.z) ?? 0,
    }));
    this.diagnostics.laufmarke.mitte = this.view.laufmarke.mittelpunkt();

    world.applyInput(
      this.localId,
      snapshot.moveX,
      snapshot.moveZ,
      snapshot.yaw,
      buttons,
      TICK_SECONDS,
    );
    world.step(TICK_SECONDS);
    // Die Vorhersagewelt erzeugt Ereignisse, die niemanden angehen — der
    // Server ist die einzige Quelle für Treffer.
    world.drainEvents();

    const row = this.localRow();
    if (row) {
      // Die Schlaganimation folgt dem **vorhergesagten** Schwung und nicht dem
      // Tastendruck: bei einem Angriff schlägt die Figur immer weiter, solange
      // der Auftrag steht, und jeder dieser Schwünge will gesehen werden. Der
      // Zustandswechsel nach `Attack` ist der Anfang eines Schwungs — genau
      // einer je Schlag, weil der Kern am Ende des Vorlaufs zurückschaltet.
      const schwingt = row.state === EntityState.Attack;
      if (schwingt && !this.schwungLief) this.view.triggerAttack(this.localId);
      this.schwungLief = schwingt;

      // Der Stand vor diesem Schritt wird zum Anfangswert der Zwischenwerte,
      // der neue zum Endwert.
      if (this.poseValid) copyPose(this.poseCurr, this.posePrev);
      this.poseCurr.x = row.x;
      this.poseCurr.y = row.y;
      this.poseCurr.z = row.z;
      this.poseCurr.yaw = row.yaw;
      this.poseCurr.speed = Math.hypot(row.vx, row.vz);
      if (!this.poseValid) {
        copyPose(this.poseCurr, this.posePrev);
        this.poseValid = true;
      }
    }

    if (snapshot.interact) this.usePortal();

    this.pending.push({
      seq,
      moveX: snapshot.moveX,
      moveZ: snapshot.moveZ,
      yaw: snapshot.yaw,
      buttons,
      x: row?.x ?? 0,
      z: row?.z ?? 0,
    });
    if (this.pending.length > MAX_PENDING_INPUTS) this.pending.shift();

    connection.sendInput({
      seq,
      moveX: snapshot.moveX,
      moveZ: snapshot.moveZ,
      yaw: snapshot.yaw,
      buttons,
    });
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);

    const dt = Math.min(0.1, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;

    // Simulationstakt einholen. Die Deckelung verhindert, dass nach einem
    // Tabwechsel hundert Schritte auf einmal nachgerechnet werden.
    this.accumulator += dt * 1000;
    if (this.accumulator > TICK_MS * 8) this.accumulator = TICK_MS * 8;
    while (this.accumulator >= TICK_MS) {
      this.accumulator -= TICK_MS;
      this.simulate();
    }
    this.connection?.flush();

    // Eigene Figur aus der Vorhersage übernehmen, nicht aus dem Snapshot —
    // und dabei zwischen den beiden letzten Schritten interpolieren, damit sie
    // nicht im Takt der Simulation zuckt.
    if (this.poseValid && this.localId !== 0) {
      const alpha = Math.max(0, Math.min(1, this.accumulator / TICK_MS));
      const prev = this.posePrev;
      const curr = this.poseCurr;

      const x = prev.x + (curr.x - prev.x) * alpha;
      const y = prev.y + (curr.y - prev.y) * alpha;
      const z = prev.z + (curr.z - prev.z) * alpha;
      // Über den kürzesten Weg, sonst dreht sich die Figur beim Übergang von
      // 359° auf 1° einmal komplett um die eigene Achse.
      const yaw = prev.yaw + angleDelta(prev.yaw, curr.yaw) * alpha;

      this.view.setLocal(this.localId, x, y, z, yaw, curr.speed);
      // Der Zuhörer steht bei der Figur, hört aber in Blickrichtung der
      // Kamera. Nähme man die Blickrichtung der Figur, wanderten die Töne bei
      // jeder Drehung durch den Kopf, obwohl das Bild stehen bleibt.
      this.mixer.setListener(x, y, z, this.scene.yaw);
      // Die Laternenlichter folgen dem Spieler: ein fester Pool, verteilt auf
      // die nächstgelegenen. Siehe render/lanterns.ts.
      this.view.lanterns.update(x, z);
      this.scene.follow(x, y, z, this.prediction, dt);
      this.streamer.setViewer(x, z);
      this.updateNearbyPortal(x, z);

      const self = this.view.entities.get(this.localId);
      if (self) self.rig.root.visible = !this.scene.isFirstPerson;

      // Der Angriffsknopf am Telefon kommt nur, wenn etwas in Reichweite ist.
      this.ui.setAttackReady(!this.dead && this.naechstesZiel() !== 0);

      // Der Daumen bleibt auf dem Knopf, das Monster fällt um. Ohne diese
      // Zeile stünde man mit gedrücktem Knopf vor dem nächsten und müsste
      // loslassen und neu drücken, um es zu bemerken — dieselbe Enttäuschung
      // wie vorher, nur eine Leiche später.
      if (this.angriffGehalten && this.auftrag?.art !== 'kampf') this.angriffsknopf();
    }

    // Tag und Nacht. Vor dem Zeichnen, damit Himmel und Licht zum Bild
    // passen, das gleich entsteht.
    this.dayCycle.update(this.worldTimeMs, this.scene, this.view.lanterns, now);
    this.ui.setWorldTime(this.dayCycle.time, this.dayCycle.state?.darkness ?? 0);

    // Bildrate: zweimal je Sekunde neu, aus dem, was in diesem Fenster
    // tatsächlich gezeichnet wurde.
    this.fpsFenster += dt;
    this.fpsBilder++;
    if (this.fpsFenster >= 0.5) {
      this.diagnostics.fps = this.fpsBilder / this.fpsFenster;
      this.ui.setFps(this.diagnostics.fps);
      this.fpsFenster = 0;
      this.fpsBilder = 0;
    }

    this.view.step(dt, this.localId);
    // Die Wolken ziehen je Bild. Die Farben rechnet der Zyklus nur alle paar
    // Zehntel — ein Wolkenzug in Rucken wäre daran sofort zu sehen.
    this.scene.stepSky(dt);
    this.ui.stepDoll(dt);
    this.ui.updateOverlay(
      this.scene.camera,
      this.view.entities.values(),
      this.localId,
      {
        entity: this.targetId ? this.view.entities.get(this.targetId) : undefined,
        kampf: this.auftrag?.art === 'kampf',
      },
      dt,
      {
        piles: this.view.loot.piles.values(),
        label: (row) => this.view.loot.label(row),
      },
    );
    this.scene.render();

    this.updateDiagnostics();
  };

  private updateDiagnostics(): void {
    const d = this.diagnostics;
    d.camera.yaw = this.scene.yaw;
    d.camera.pitch = this.scene.pitch;
    d.camera.distance = this.scene.distance;

    const self = this.view.entities.get(this.localId);
    if (self) {
      // Die *gezeichnete* Lage, nicht der rohe Simulationsstand — nur so faellt
      // ein Ruckeln zwischen den Simulationsschritten ueberhaupt auf.
      d.player.x = self.x;
      d.player.y = self.y;
      d.player.z = self.z;
      d.player.yaw = self.yaw;
      d.player.speed = self.speed;
    }

    d.playerSim.x = this.poseCurr.x;
    d.playerSim.y = this.poseCurr.y;
    d.playerSim.z = this.poseCurr.z;
    d.playerSim.yaw = this.poseCurr.yaw;

    d.serverDistance =
      this.serverSeen && this.poseValid
        ? Math.hypot(this.serverX - this.poseCurr.x, this.serverZ - this.poseCurr.z)
        : 0;

    d.weaponModels = this.registry.loadedWeaponModels();

    const ton = this.mixer.diagnostics();
    d.audio.state = ton.state;
    d.audio.contextState = ton.contextState;
    d.audio.sampleRate = ton.sampleRate;
    d.audio.geladen = ton.geladen;
    d.audio.dekodiert = ton.dekodiert;
    d.hasPrediction = this.prediction !== undefined;
    d.predictionReady = this.poseValid;
    d.hasConnection = this.connection !== undefined;
    d.mapId = this.view.mapId;
    d.localId = this.localId;
    d.entityCount = this.view.entities.size;
    d.lootCount = this.view.loot.piles.size;
    let naechster = Infinity;
    for (const { row } of this.view.loot.piles.values()) {
      const dx = row.x - this.poseCurr.x;
      const dz = row.z - this.poseCurr.z;
      naechster = Math.min(naechster, Math.hypot(dx, dz));
    }
    d.lootNearest = naechster;
    d.doll = this.ui.dollState;

    const himmel = this.dayCycle.state;
    if (himmel) {
      const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;
      d.sky.uhr = clockText(this.dayCycle.time);
      d.sky.dunkelheit = Number(himmel.darkness.toFixed(3));
      d.sky.sonne = Number(himmel.sunIntensity.toFixed(3));
      d.sky.umgebung = Number(himmel.ambientIntensity.toFixed(3));
      d.sky.lichtfarbe = hex(himmel.ambientSkyColor);
      d.sky.kuppelfarbe = hex(himmel.skyColor);
    }
    d.targetId = this.targetId;
    d.connection = this.connection?.status ?? 'getrennt';
    d.latencyMs = this.connection?.latency ?? 0;
    d.frames++;
  }

  stop(): void {
    this.running = false;
    this.connection?.close();
    this.input.dispose();
    this.view.clear();
    this.textures.dispose();
    this.prediction?.dispose();
    this.registry.dispose();
    this.scene.dispose();
  }
}
