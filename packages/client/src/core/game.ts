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
  angleDelta,
  CombatFlag,
  EntityState,
  EntityType,
  PLAYER_PROFILE,
  TICK_MS,
  TICK_SECONDS,
  parseMapDocument,
  type MapDocument,
  type StatsMsg,
  terrainSetup,
} from '@aurelith/shared';
import {
  BOOTSTRAP_MAP,
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
import { WorldView, type EntityVisual } from '../render/worldView.ts';
import { TextureLoader } from '../render/textures.ts';
import { InputManager } from '../input/input.ts';
import { Connection } from '../net/connection.ts';
import { UI } from '../ui/index.ts';

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
  input: { moveX: number; moveZ: number; yaw: number; attack: boolean };
  /** Simulationsschritte seit dem Start. */
  ticks: number;
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
  targetId: number;
  connection: string;
  latencyMs: number;
  frames: number;
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
  private readonly input: InputManager;
  private readonly streamer = new AssetStreamer();
  private readonly textures: TextureLoader;
  private readonly quality = QUALITY[guessQuality()];

  private core?: ClientCore;
  private connection?: Connection;

  /** Welt allein für die Vorhersage: nur die eigene Figur und die Kollider. */
  private prediction?: CoreWorld;
  private predictionRows: CoreEntityRow[] = [];
  private mapDoc?: MapDocument;

  private localId = 0;
  private playerName = '';
  private inputSeq = 0;
  private pending: PendingInput[] = [];
  private targetId = 0;
  private dead = false;
  /** Das Tor, in dem die Figur gerade steht. Nur Anzeige — der Server prüft. */
  private nearbyPortalId?: string;

  /** Laeuft gerade ein Kartenwechsel? Dann warten Snapshots. */
  private mapLoad?: Promise<void>;
  private loadingMapId?: string;
  private queuedSnapshots: Parameters<Game['applySnapshot']>[0][] = [];
  private stats?: StatsMsg;

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

  private readonly diagnostics: Diagnostics = {
    camera: { yaw: 0, pitch: 0, distance: 0 },
    player: { x: 0, y: 0, z: 0, yaw: 0, speed: 0 },
    playerSim: { x: 0, y: 0, z: 0, yaw: 0 },
    input: { moveX: 0, moveZ: 0, yaw: 0, attack: false },
    ticks: 0,
    reconciles: 0,
    maxReconcileError: 0,
    hasPrediction: false,
    predictionReady: false,
    hasConnection: false,
    mapId: '',
    localId: 0,
    entityCount: 0,
    targetId: 0,
    connection: 'getrennt',
    latencyMs: 0,
    frames: 0,
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
    );
    this.scene.scene.add(this.view.root);

    this.ui = new UI(uiHost, touch);
    this.input = new InputManager(canvas, this.scene, touch, uiHost);

    this.ui.onChatSubmit = (text) => this.onChatInput(text);
    this.ui.onRespawn = () => this.connection?.sendRespawn();
    this.ui.onUsePortal = () => this.usePortal();
    this.ui.onAttackHold = (held) => this.input.setAttackButton(held);
    this.input.onPick = (x, y) => this.pickTarget(x, y);
    this.input.onAttackPressed = () => this.view.triggerAttack(this.localId);

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
  async start(accountName: string): Promise<void> {
    this.playerName = accountName;
    this.ui.setPlayerName(accountName);
    this.ui.setConnection('verbindet');

    this.running = true;
    this.lastFrameAt = performance.now();
    requestAnimationFrame(this.frame);

    try {
      this.core = await loadClientCore();
    } catch (err) {
      this.ui.addChat(0, '', `Kern konnte nicht geladen werden: ${String(err)}`);
      throw err;
    }

    // Das Manifest darf fehlschlagen — ohne es lädt der Streamer direkt, nur
    // ohne Größen und damit ohne echte Priorisierung.
    try {
      await this.streamer.loadManifest();
    } catch (err) {
      console.warn('[assets] Manifest nicht verfügbar, lade ohne Priorisierung:', err);
    }

    await this.ensureMap(BOOTSTRAP_MAP);
    this.connect(accountName);
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
    this.view.setMap(world, doc, this.quality);
    this.streamer.setViewer(doc.spawn.x, doc.spawn.z);
    this.scene.snapTo(doc.spawn.x, world.heightAt(doc.spawn.x, doc.spawn.z), doc.spawn.z);
  }

  // -------------------------------------------------------------------------
  // Verbindung
  // -------------------------------------------------------------------------

  private connect(accountName: string): void {
    // Eine bestehende Verbindung zuerst abraeumen: nach `close()` meldet sie
    // nichts mehr nach oben, also kann kein Paket im Flug die frische Sitzung
    // durcheinanderbringen.
    this.connection?.close();
    this.resetSession();

    let explainedMissingServer = false;
    const url = serverUrl();

    this.connection = new Connection(url, accountName, {
      onStatus: (status, detail) => {
        this.ui.setConnection(status, detail);

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

      onWelcome: async (msg) => {
        this.localId = msg.entityId;
        this.pending = [];
        this.inputSeq = 0;
        this.targetId = 0;
        this.poseValid = false;
        await this.ensureMap(msg.mapId);
      },

      onMapChange: async (msg) => {
        // Zuerst den Hinweis wegnehmen: bis die neue Karte geladen ist, würde
        // die neue Position gegen die Tore der alten geprüft.
        this.nearbyPortalId = undefined;
        this.ui.setPortalPrompt(undefined);

        await this.ensureMap(msg.mapId);
        this.scene.snapTo(msg.x, msg.y, msg.z);
        this.pending = [];
        this.poseValid = false;
        this.input.setFacing(msg.yaw);
      },

      onSnapshot: (msg) => this.applySnapshot(msg),

      onStats: (msg) => {
        this.stats = msg;
        this.ui.setStats(msg);
      },

      onInventory: (rows) => this.ui.setInventory(rows),

      onChat: (msg) => this.ui.addChat(msg.channel, msg.from, msg.text),

      onCombat: (msg) => this.applyCombat(msg),

      onKick: (_reason, message) => {
        this.ui.setConnection('getrennt', message);
        this.ui.addChat(0, '', `Verbindung beendet: ${message}`);
      },
    });

    this.connection.connect();
  }

  /**
   * Chateingabe. Alles, was mit einem Schraegstrich beginnt, ist ein Befehl und
   * geht nicht an den Server.
   *
   * `/connect` gibt es, weil die Serveradresse auf einer statisch
   * ausgelieferten Seite sonst beim Bauen eingebacken waere — fuer jede andere
   * Adresse muesste neu gebaut und veroeffentlicht werden.
   */
  private onChatInput(text: string): void {
    if (!text.startsWith('/')) {
      this.connection?.sendChat(text);
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
      case 'help':
        this.systemLine(
          '/connect <adresse> — mit einem Server verbinden, z. B. /connect ws://localhost:8787/ws',
        );
        this.systemLine('/disconnect — gespeicherte Adresse loeschen und trennen');
        this.systemLine('/server — aktuelle Adresse anzeigen');
        break;
      default:
        this.systemLine(`Unbekannter Befehl: /${command}. /help zeigt die Liste.`);
        break;
    }
  }

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
    this.connect(this.playerName);
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
    this.pending = [];
    this.inputSeq = 0;
    this.localId = 0;
    this.targetId = 0;
    this.poseValid = false;
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
    spawns: Array<Parameters<WorldView['spawn']>[0]>;
    updates: Array<Parameters<WorldView['update']>[0]>;
    despawns: number[];
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

    const self = this.view.entities.get(this.localId);
    if (self) {
      const nowDead = self.state === EntityState.Dead;
      if (nowDead !== this.dead) {
        this.dead = nowDead;
        this.ui.setDead(nowDead);
      }
      this.ui.setHp(self.hp);
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
      attackRange: PLAYER_PROFILE.attackRange,
      attackArc: PLAYER_PROFILE.attackArc,
      attackCooldownSec: PLAYER_PROFILE.attackCooldownSec,
      attackWindupSec: PLAYER_PROFILE.attackWindupSec,
      radius: PLAYER_PROFILE.radius,
      height: PLAYER_PROFILE.height,
    });
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
    this.view.triggerAttack(msg.attackerId);

    const mine = msg.attackerId === this.localId;
    const onMe = msg.victimId === this.localId;
    if (!mine && !onMe) {
      // Fremder Schaden an fremden Zielen würde nur den Bildschirm füllen.
      return;
    }

    const kind = onMe ? 'taken' : (msg.flags & CombatFlag.Critical) !== 0 ? 'crit' : 'dealt';
    this.ui.overlay.addNumber(msg.x, msg.y, msg.z, String(msg.damage), kind);
  }

  // -------------------------------------------------------------------------
  // Zielauswahl
  // -------------------------------------------------------------------------

  private pickTarget(ndcX: number, ndcY: number): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const clickX = ((ndcX + 1) / 2) * width;
    const clickY = ((1 - ndcY) / 2) * height;

    let best: EntityVisual | undefined;
    let bestDist = PICK_RADIUS_PX;

    for (const e of this.view.entities.values()) {
      if (e.id === this.localId || e.type === EntityType.Npc) continue;
      if (e.state === EntityState.Dead) continue;

      this.projection.set(e.x, e.y + e.height * 0.5, e.z).project(this.scene.camera);
      if (this.projection.z > 1) continue;

      const sx = (this.projection.x * 0.5 + 0.5) * width;
      const sy = (-this.projection.y * 0.5 + 0.5) * height;
      const d = Math.hypot(sx - clickX, sy - clickY);
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }

    this.setTarget(best?.id ?? 0);
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

  /** Schickt die Bitte, das Tor zu benutzen, in dem die Figur steht. */
  private usePortal(): void {
    if (!this.nearbyPortalId) return;
    this.connection?.sendUsePortal(this.nearbyPortalId);
  }

  private setTarget(id: number): void {
    if (this.targetId === id) return;
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

    // Solange der Chat den Fokus hat, nimmt die Eingabe nichts mehr an — sie
    // läuft aber weiter, damit die Figur ausläuft statt stehenzubleiben.
    const snapshot = this.input.read(TICK_SECONDS, this.ui.chatHasFocus);

    const buttons = snapshot.attack && !this.dead ? CoreButton.Attack : 0;
    const seq = ++this.inputSeq;

    this.diagnostics.input.moveX = snapshot.moveX;
    this.diagnostics.input.moveZ = snapshot.moveZ;
    this.diagnostics.input.yaw = snapshot.yaw;
    this.diagnostics.input.attack = snapshot.attack;
    this.diagnostics.ticks++;

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
      this.scene.follow(x, y, z, this.prediction, dt);
      this.streamer.setViewer(x, z);
      this.updateNearbyPortal(x, z);

      const self = this.view.entities.get(this.localId);
      if (self) self.rig.root.visible = !this.scene.isFirstPerson;
    }

    this.view.step(dt, this.localId);
    this.ui.updateOverlay(this.scene.camera, this.view.entities.values(), this.localId, this.targetId, dt);
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

    d.hasPrediction = this.prediction !== undefined;
    d.predictionReady = this.poseValid;
    d.hasConnection = this.connection !== undefined;
    d.mapId = this.view.mapId;
    d.localId = this.localId;
    d.entityCount = this.view.entities.size;
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
