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
} from '@aurelith/shared';
import {
  BOOTSTRAP_MAP,
  QUALITY,
  SERVER_CONFIGURED,
  guessQuality,
  isTouchDevice,
  serverUrl,
} from '../config.ts';
import { AssetStreamer } from '../assets/streamer.ts';
import { loadClientCore, type ClientCore } from './coreLoader.ts';
import { Scene3D } from '../render/scene.ts';
import { ModelRegistry } from '../render/modelRegistry.ts';
import { WorldView, type EntityVisual } from '../render/worldView.ts';
import { InputManager } from '../input/input.ts';
import { Connection } from '../net/connection.ts';
import { UI } from '../ui/index.ts';

/** Ab dieser Abweichung wird die Vorhersage hart korrigiert. */
const RECONCILE_THRESHOLD = 1.2;
/** So viele Eingaben werden für das Nachspielen aufbewahrt. */
const MAX_PENDING_INPUTS = 60;
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
    this.view = new WorldView(this.registry);
    this.scene.scene.add(this.view.root);

    this.ui = new UI(uiHost, touch);
    this.input = new InputManager(canvas, this.scene, touch, uiHost);

    this.ui.onChatSubmit = (text) => this.connection?.sendChat(text);
    this.ui.onRespawn = () => this.connection?.sendRespawn();
    this.ui.onAttackHold = (held) => this.input.setAttackButton(held);
    this.input.onPick = (x, y) => this.pickTarget(x, y);
    this.input.onAttackPressed = () => this.view.triggerAttack(this.localId);

    globalThis.aurelith = this.diagnostics;

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

    await this.loadMap(BOOTSTRAP_MAP);
    this.connect(accountName);
  }

  // -------------------------------------------------------------------------
  // Karten
  // -------------------------------------------------------------------------

  private async loadMap(mapId: string): Promise<void> {
    const core = this.core;
    if (!core) return;

    const raw = await this.streamer.requestJson<unknown>(`maps/${mapId}.json`);
    const doc = parseMapDocument(raw, mapId);
    this.mapDoc = doc;

    this.prediction?.dispose();
    const world = core.core.createWorld(doc.terrain.seed, {
      size: doc.terrain.size,
      cellSize: doc.terrain.cellSize,
      seed: doc.terrain.seed,
      heightScale: doc.terrain.heightScale,
      featureScale: doc.terrain.featureScale,
    });
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
    let explainedMissingServer = false;

    this.connection = new Connection(serverUrl(), accountName, {
      onStatus: (status, detail) => {
        this.ui.setConnection(status, detail);

        // Eine statisch ausgelieferte Seite hat keinen WebSocket-Endpunkt.
        // Ohne Erklärung sieht man nur „getrennt" und rätselt, ob etwas kaputt
        // ist. Der Hinweis kommt erst, wenn die Verbindung tatsächlich
        // scheitert — im Entwicklungsbetrieb ist dieselbe Vermutung richtig
        // und soll nichts melden.
        if (status === 'getrennt' && !SERVER_CONFIGURED && !explainedMissingServer) {
          explainedMissingServer = true;
          this.ui.addChat(
            0,
            '',
            'Kein Spielserver hinterlegt — die Welt ist sichtbar, aber ohne Verbindung. ' +
              'Beim Bauen VITE_SERVER_URL auf eine wss://-Adresse setzen.',
          );
        }
      },

      onWelcome: async (msg) => {
        this.localId = msg.entityId;
        this.pending = [];
        this.inputSeq = 0;
        this.targetId = 0;
        this.poseValid = false;
        if (msg.mapId !== this.view.mapId) await this.loadMap(msg.mapId);
      },

      onMapChange: async (msg) => {
        if (msg.mapId !== this.view.mapId) await this.loadMap(msg.mapId);
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

  private applySnapshot(msg: {
    tick: number;
    ackInputSeq: number;
    spawns: Array<Parameters<WorldView['spawn']>[0]>;
    updates: Array<Parameters<WorldView['update']>[0]>;
    despawns: number[];
  }): void {
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
    if (error <= RECONCILE_THRESHOLD) return;

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

    // Solange der Chat den Fokus hat, bewegt sich niemand.
    const snapshot = this.ui.chatHasFocus
      ? { moveX: 0, moveZ: 0, yaw: this.scene.yaw, attack: false, interact: false }
      : this.input.read();

    const buttons = snapshot.attack && !this.dead ? CoreButton.Attack : 0;
    const seq = ++this.inputSeq;

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
    this.prediction?.dispose();
    this.registry.dispose();
    this.scene.dispose();
  }
}
