/**
 * Der autoritative Server.
 *
 * Er hält je Map eine Welt im wasm-Kern, treibt sie mit fester Schrittweite und
 * schickt jedem Spieler das, was in seiner Nähe passiert. Alles, was der Client
 * sagt, ist ein Wunsch: Bewegungsrichtung, Blickrichtung, gedrückte Tasten.
 * Was daraus wird, entscheidet ausschließlich diese Datei — das ist der einzige
 * Schutz, den es gibt, und laut Blueprint auch der einzige, auf den wir bauen.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import {
  ChatChannel,
  EntityState,
  EntityType,
  FrameError,
  INTEREST_RADIUS,
  KickReason,
  MOBS,
  PLAYER_PROFILE,
  PROTOCOL_VERSION,
  QuestAction,
  SNAPSHOT_TICK_DIVISOR,
  TICK_MS,
  TICK_SECONDS,
  attackProfileFor,
  baseStatsForLevel,
  ClientOp,
  decodeClientChat,
  decodeEquipItem,
  decodeFrame,
  decodeHello,
  decodeInput,
  decodeInteract,
  decodePing,
  decodeQuestAction,
  decodeSetTarget,
  decodeShopTrade,
  decodeUsePortal,
  encodeCombatEvent,
  encodeInventory,
  encodeKick,
  encodeMapChange,
  encodeNpcDialog,
  encodePong,
  encodeQuestLog,
  encodeServerChat,
  encodeSnapshot,
  encodeStats,
  encodeWelcome,
  expForLevel,
  expGain,
  getItem,
  getNpc,
  getQuest,
  type ItemDef,
  readPacket,
  type SpawnRow,
  turnInOf,
  type UpdateRow,
} from '@aurelith/shared';
import { CoreEventType, CoreButton } from '@aurelith/core';
import { config } from './config.ts';
import type { CoreBundle } from './core.ts';
import type { MapStore } from './maps.ts';
import { MapInstance } from './mapInstance.ts';
import { INPUT_QUEUE_DRAIN_AT, INPUT_QUEUE_DRAIN_MAX, Session } from './session.ts';
import { addItem, removeItem, sellPrice } from './inventory.ts';
import type { GameStore } from './db/index.ts';

/** Wie nah man an einem NPC stehen muss, um ihn anzusprechen. */
const INTERACT_RANGE = 6;

export class GameServer {
  private readonly instances = new Map<string, MapInstance>();
  private readonly sessions = new Set<Session>();
  private readonly sessionByEntity = new Map<number, Session>();

  private nextEntityId = 1;
  private nextSessionId = 1;
  private timer?: NodeJS.Timeout;
  private accumulator = 0;
  private lastTickAt = 0;
  private persistCountdown = config.persistIntervalSeconds;

  constructor(
    private readonly bundle: CoreBundle,
    private readonly maps: MapStore,
    private readonly store: GameStore,
  ) {}

  // -------------------------------------------------------------------------
  // Aufbau
  // -------------------------------------------------------------------------

  start(httpServer: Server): void {
    for (const id of this.maps.ids) {
      const doc = this.maps.require(id);
      this.instances.set(id, new MapInstance(doc, this.bundle, () => this.nextEntityId++));
      console.log(
        `[welt] ${doc.name} (${id}): ${doc.props.length} Props, ${doc.spawners.length} Spawner, ` +
          `${doc.portals.length} Portale`,
      );
    }

    const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    wss.on('connection', (ws) => this.onConnection(ws));

    this.lastTickAt = Date.now();
    this.timer = setInterval(() => this.pump(), Math.max(1, Math.floor(TICK_MS / 2)));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const session of this.sessions) {
      session.send(encodeKick(KickReason.ServerShutdown, 'Server fährt herunter.'));
      session.flush();
      await this.persist(session).catch(() => undefined);
      session.close(1001, 'shutdown');
    }
    for (const instance of this.instances.values()) instance.dispose();
  }

  // -------------------------------------------------------------------------
  // Verbindungen
  // -------------------------------------------------------------------------

  private onConnection(ws: WebSocket): void {
    const session = new Session(this.nextSessionId++, ws, config.maxInputsPerSecond);
    this.sessions.add(session);

    ws.binaryType = 'nodebuffer';
    ws.on('message', (data: Buffer) => {
      session.lastSeenAt = Date.now();
      try {
        this.onFrame(session, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      } catch (err) {
        if (err instanceof FrameError) {
          session.send(encodeKick(KickReason.BadFrame, err.code));
          session.flush();
          session.close(1002, err.code);
        } else {
          console.error('[sitzung] Fehler beim Verarbeiten:', err);
          session.close(1011, 'internal');
        }
      }
    });

    ws.on('close', () => void this.onDisconnect(session));
    ws.on('error', () => void this.onDisconnect(session));
  }

  private async onDisconnect(session: Session): Promise<void> {
    if (!this.sessions.has(session)) return;
    this.sessions.delete(session);

    if (session.entityId !== 0) {
      await this.persist(session).catch((err) =>
        console.error('[db] Speichern beim Trennen fehlgeschlagen:', err),
      );
      this.instances.get(session.mapId)?.removePlayer(session.entityId);
      this.sessionByEntity.delete(session.entityId);
    }
    session.state = 'closed';
  }

  private onFrame(session: Session, data: Uint8Array): void {
    const frame = decodeFrame(data, session.cipherSuite);
    for (const raw of frame.packets) {
      const { opcode, reader } = readPacket(raw);
      switch (opcode) {
        case ClientOp.Hello:
          void this.onHello(session, decodeHello(reader));
          break;
        case ClientOp.Input: {
          if (session.state !== 'playing') break;
          if (!session.consumeInputBudget()) break;
          session.queueInput(decodeInput(reader));
          break;
        }
        case ClientOp.Ping: {
          const { clientTime } = decodePing(reader);
          session.send(encodePong(clientTime, Date.now()));
          break;
        }
        case ClientOp.Chat: {
          if (session.state !== 'playing') break;
          const { channel, text } = decodeClientChat(reader);
          this.onChat(session, channel, text);
          break;
        }
        case ClientOp.SetTarget: {
          if (session.state !== 'playing') break;
          const { entityId } = decodeSetTarget(reader);
          this.instances.get(session.mapId)?.world.setTarget(session.entityId, entityId);
          break;
        }
        case ClientOp.UsePortal: {
          if (session.state !== 'playing') break;
          const { portalId } = decodeUsePortal(reader);
          this.usePortal(session, portalId);
          break;
        }
        case ClientOp.EquipItem: {
          if (session.state !== 'playing') break;
          const { itemId } = decodeEquipItem(reader);
          this.equipItem(session, itemId);
          break;
        }
        case ClientOp.Interact: {
          if (session.state !== 'playing') break;
          const { entityId } = decodeInteract(reader);
          this.interact(session, entityId);
          break;
        }
        case ClientOp.QuestAction: {
          if (session.state !== 'playing') break;
          const { questId, action } = decodeQuestAction(reader);
          this.questAction(session, questId, action);
          break;
        }
        case ClientOp.ShopTrade: {
          if (session.state !== 'playing') break;
          const { mode, itemId, count } = decodeShopTrade(reader);
          this.shopTrade(session, mode, itemId, count);
          break;
        }
        case ClientOp.Respawn:
          if (session.state === 'playing') this.respawn(session);
          break;
        default:
          // Unbekannter Opcode: verwerfen. Ein Kick wäre zu hart, solange
          // Client und Server dieselbe Protokollversion melden.
          break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Anmeldung
  // -------------------------------------------------------------------------

  private async onHello(session: Session, hello: ReturnType<typeof decodeHello>): Promise<void> {
    if (session.state !== 'handshake') return;

    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      session.send(
        encodeKick(
          KickReason.ProtocolMismatch,
          `Protokoll ${hello.protocolVersion}, Server spricht ${PROTOCOL_VERSION}.`,
        ),
      );
      session.flush();
      session.close(1002, 'protocol');
      return;
    }

    const accountName = sanitizeName(hello.accountName);
    if (accountName.length < 2) {
      session.send(encodeKick(KickReason.AuthFailed, 'Name ist zu kurz.'));
      session.flush();
      session.close(1008, 'auth');
      return;
    }

    // Doppelte Anmeldung desselben Kontos: die ältere Sitzung fliegt.
    for (const other of this.sessions) {
      if (other !== session && other.accountName === accountName) {
        other.send(encodeKick(KickReason.AuthFailed, 'An anderer Stelle angemeldet.'));
        other.flush();
        other.close(1000, 'replaced');
      }
    }

    const startMap = this.maps.require(config.startMap);
    // `startPos` übersteuert den Startpunkt der Karte — nur für Prüfungen
    // gedacht, und nur beim Anlegen eines Charakters.
    const spawn = config.startPos ?? startMap.spawn;
    const login = await this.store.loginOrCreate(accountName, {
      mapId: startMap.id,
      x: spawn.x,
      z: spawn.z,
      yaw: spawn.yaw,
    });

    // Eine Map, die es nicht mehr gibt, darf keinen Login blockieren.
    const instance =
      this.instances.get(login.character.mapId) ?? this.instances.get(config.startMap);
    if (!instance) {
      session.send(encodeKick(KickReason.AuthFailed, 'Keine Map verfügbar.'));
      session.flush();
      session.close(1011, 'no-map');
      return;
    }

    session.accountName = accountName;
    session.character = login.character;
    session.items = login.items;
    session.quests.load(login.quests);
    // Sammelziele einmal am Beutel messen: wer sich abgemeldet hat, während
    // die Essenzen im Beutel lagen, ist beim Anmelden abgabebereit.
    session.quests.syncCollect(session.items);
    session.entityId = this.nextEntityId++;
    session.mapId = instance.doc.id;
    session.state = 'playing';

    const stats = this.statsFor(session);
    const profile = this.attackProfileOf(session);
    instance.world.spawnPlayer({
      id: session.entityId,
      level: login.character.level,
      x: login.character.x,
      z: login.character.z,
      yaw: login.character.yaw,
      hp: login.character.hp,
      maxHp: stats.maxHp,
      mp: login.character.mp,
      maxMp: stats.maxMp,
      attackDamage: stats.attackDamage,
      defense: stats.defense,
      moveSpeed: stats.moveSpeed,
      attackRange: profile.range,
      attackArc: profile.arc,
      attackCooldownSec: profile.cooldownSec,
      attackWindupSec: profile.windupSec,
      attackStyle: profile.style,
      radius: PLAYER_PROFILE.radius,
      height: PLAYER_PROFILE.height,
    });
    instance.meta.set(session.entityId, {
      defId: 'player',
      name: accountName,
      type: EntityType.Player,
      weapon: profile.rig,
    });
    instance.playerIds.add(session.entityId);
    this.sessionByEntity.set(session.entityId, session);

    session.send(
      encodeWelcome({
        protocolVersion: PROTOCOL_VERSION,
        entityId: session.entityId,
        mapId: instance.doc.id,
        tick: instance.world.tick,
        tickRate: 20,
        snapshotRate: 20 / SNAPSHOT_TICK_DIVISOR,
        // Klartext. Die Aushandlung existiert, damit der Wechsel später keine
        // Protokolländerung ist.
        cipherId: 0,
        serverTimeMs: Date.now(),
      }),
    );
    this.sendStats(session);
    this.sendInventory(session);
    this.sendQuestLog(session);
    this.systemMessage(
      session,
      login.created
        ? `Willkommen in ${instance.doc.name}, ${accountName}. Du beginnst mit einem Holzschwert.`
        : `Willkommen zurück, ${accountName}.`,
    );
    session.flush();

    console.log(`[sitzung] ${accountName} betritt ${instance.doc.id} (Entity ${session.entityId})`);
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  /**
   * Holt die vergangene Zeit ein. Ein fester Zeitschritt ist Voraussetzung
   * dafür, dass die Prediction im Client dieselbe Rechnung anstellen kann —
   * eine variable Schrittweite würde sofort auseinanderlaufen.
   */
  private pump(): void {
    const now = Date.now();
    this.accumulator += now - this.lastTickAt;
    this.lastTickAt = now;

    // Nach einer Pause nicht hundert Ticks nachholen.
    if (this.accumulator > TICK_MS * 10) this.accumulator = TICK_MS * 10;

    while (this.accumulator >= TICK_MS) {
      this.accumulator -= TICK_MS;
      this.tick();
    }
  }

  private tick(): void {
    this.dropTimedOutSessions();

    for (const session of this.sessions) {
      if (session.state !== 'playing' || session.inputQueue.length === 0) continue;
      const instance = this.instances.get(session.mapId);
      if (!instance) continue;

      // Genau eine Eingabe je Tick — dieselbe Rechnung wie im Client, der je
      // Schritt eine erzeugt und anwendet. Nur wenn sich ein Rückstand
      // aufgebaut hat, werden mehrere verarbeitet, damit ein einmaliger Burst
      // nicht als dauerhafte Verzögerung stehenbleibt.
      //
      // Mehrere in einem Tick heisst: `applyInput` läuft mehrfach, `step` nur
      // einmal. Die Bewegung stimmt dabei, weil sie vollständig in
      // `applyInput` passiert; die Zeitgeber für Schlag und Treffer laufen
      // etwas langsamer. Das ist der Preis fürs Aufholen, und er fällt nur an,
      // wenn ohnehin schon etwas klemmt.
      const budget =
        session.inputQueue.length >= INPUT_QUEUE_DRAIN_AT ? INPUT_QUEUE_DRAIN_MAX : 1;

      for (let i = 0; i < budget && session.inputQueue.length > 0; i++) {
        const input = session.inputQueue.shift()!;
        instance.world.applyInput(
          session.entityId,
          input.moveX,
          input.moveZ,
          input.yaw,
          input.buttons & CoreButton.Attack,
          TICK_SECONDS,
        );
        session.lastInputSeq = input.seq;
      }
    }

    for (const instance of this.instances.values()) {
      instance.world.step(TICK_SECONDS);
      instance.refresh();
      this.dispatchEvents(instance);
    }

    const instanceTick = this.instances.values().next().value?.world.tick ?? 0;
    if (instanceTick % SNAPSHOT_TICK_DIVISOR === 0) {
      for (const session of this.sessions) {
        if (session.state === 'playing') this.sendSnapshot(session);
      }
    }

    for (const session of this.sessions) session.flush();

    this.persistCountdown -= TICK_SECONDS;
    if (this.persistCountdown <= 0) {
      this.persistCountdown = config.persistIntervalSeconds;
      void this.persistAll();
    }
  }

  private dropTimedOutSessions(): void {
    const deadline = Date.now() - config.sessionTimeoutSeconds * 1000;
    for (const session of this.sessions) {
      if (session.lastSeenAt < deadline) {
        session.send(encodeKick(KickReason.Timeout, 'Keine Antwort.'));
        session.flush();
        session.close(1001, 'timeout');
        void this.onDisconnect(session);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Ereignisse aus dem Kern
  // -------------------------------------------------------------------------

  private dispatchEvents(instance: MapInstance): void {
    const events = instance.world.drainEvents();
    if (events.length === 0) return;

    for (const ev of events) {
      switch (ev.type) {
        case CoreEventType.Hit: {
          const packet = encodeCombatEvent({
            attackerId: ev.a,
            victimId: ev.b,
            damage: Math.round(ev.value),
            flags: ev.flags,
            x: ev.x,
            y: ev.y,
            z: ev.z,
          });
          this.broadcastNear(instance, ev.x, ev.z, packet);
          break;
        }

        case CoreEventType.Death: {
          const victim = this.sessionByEntity.get(ev.a);
          if (victim) {
            this.systemMessage(victim, 'Du bist gefallen. Kehre zurück, um weiterzumachen.');
          }
          break;
        }

        case CoreEventType.Exp: {
          const session = this.sessionByEntity.get(ev.a);
          if (session) this.grantExp(session, instance, ev.b, ev.value, ev.value2);
          break;
        }

        case CoreEventType.Spawn:
          // Der Snapshot bemerkt neue Entities von selbst — hier ist nichts zu tun.
          break;

        default:
          break;
      }
    }

    // Die Zeilen können sich durch Tod und Wiederkehr geändert haben.
    instance.refresh();
  }

  private grantExp(
    session: Session,
    instance: MapInstance,
    victimId: number,
    baseExp: number,
    gold: number,
  ): void {
    const character = session.character;
    if (!character) return;

    const meta = instance.metaFor(victimId);
    const mob = meta ? MOBS.get(meta.defId) : undefined;
    const mobLevel = mob?.level ?? character.level;

    // Die Stufenabhängigkeit rechnet der Server, nicht der Kern: sie ist
    // Balancing und soll sich ohne neuen wasm-Build ändern lassen.
    const gained = expGain(baseExp, character.level, mobLevel);
    character.exp += gained;
    character.gold += Math.round(gold);
    this.levelUpIfNeeded(session);

    // Beute und Auftragsfortschritt hängen an derselben Stelle, weil beide
    // dieselbe Frage beantworten: *wer* hat *was* erlegt. Der Kern meldet den
    // Erfahrungsgewinn nur an den, der den Todesstoss gesetzt hat — genau der
    // soll auch die Haut bekommen.
    const mobId = meta?.defId ?? '';
    const beute = mobId ? this.rollDrops(session, mobId) : false;
    let logGeaendert = mobId ? session.quests.onKill(mobId) : false;

    if (beute) {
      session.itemsDirty = true;
      // Was eben hereinkam, kann ein Sammelziel erfüllen.
      if (session.quests.syncCollect(session.items)) logGeaendert = true;
      this.sendInventory(session);
    }
    if (logGeaendert) {
      session.questsDirty = true;
      this.sendQuestLog(session);
    }

    this.sendStats(session);
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  private sendSnapshot(session: Session): void {
    const instance = this.instances.get(session.mapId);
    if (!instance) return;

    const self = instance.entity(session.entityId);
    const originX = self?.x ?? 0;
    const originZ = self?.z ?? 0;
    const radiusSq = INTEREST_RADIUS * INTEREST_RADIUS;

    const spawns: SpawnRow[] = [];
    const updates: UpdateRow[] = [];
    const visible = new Set<number>();

    for (const row of instance.entities) {
      const dx = row.x - originX;
      const dz = row.z - originZ;
      // Die eigene Figur ist immer sichtbar, auch wenn etwas schiefgeht.
      if (row.id !== session.entityId && dx * dx + dz * dz > radiusSq) continue;

      visible.add(row.id);

      if (session.known.has(row.id)) {
        updates.push({
          id: row.id,
          x: row.x,
          y: row.y,
          z: row.z,
          yaw: row.yaw,
          hp: row.hp,
          state: row.state as EntityState,
          // Der Kern führt für jedes Wesen mit, wen es gerade verfolgt. Das
          // ist genau die Frage, die der Client für ein rotes Namensschild
          // beantwortet haben will — mehr braucht es dafür nicht.
          aggro: row.targetId !== 0,
        });
        continue;
      }

      const meta = instance.metaFor(row.id);
      spawns.push({
        id: row.id,
        type: (meta?.type ?? EntityType.Monster) as EntityType,
        defId: meta?.defId ?? '',
        name: meta?.name ?? '',
        level: row.level,
        x: row.x,
        y: row.y,
        z: row.z,
        yaw: row.yaw,
        hp: row.hp,
        maxHp: row.maxHp,
        state: row.state as EntityState,
        aggro: row.targetId !== 0,
        weapon: meta?.weapon ?? '',
      });
      session.known.add(row.id);
    }

    const despawns: number[] = [];
    for (const id of session.known) {
      if (!visible.has(id)) {
        despawns.push(id);
        session.known.delete(id);
      }
    }

    session.send(
      encodeSnapshot({
        tick: instance.world.tick,
        ackInputSeq: session.lastInputSeq,
        serverTimeMs: Date.now(),
        spawns,
        updates,
        despawns,
      }),
    );
  }

  private broadcastNear(
    instance: MapInstance,
    x: number,
    z: number,
    packet: Uint8Array,
  ): void {
    const radiusSq = INTEREST_RADIUS * INTEREST_RADIUS;
    for (const playerId of instance.playerIds) {
      const session = this.sessionByEntity.get(playerId);
      if (!session || session.state !== 'playing') continue;
      const row = instance.entity(playerId);
      if (!row) continue;
      const dx = row.x - x;
      const dz = row.z - z;
      if (dx * dx + dz * dz <= radiusSq) session.send(packet);
    }
  }

  // -------------------------------------------------------------------------
  // Portale
  // -------------------------------------------------------------------------

  /**
   * Ein Tor benutzen.
   *
   * Nur auf ausdrückliche Anfrage — Hineinlaufen allein bewirkt nichts mehr.
   * Das ist nicht bloss angenehmer, es macht auch die ganze Mechanik einfacher:
   * ohne selbsttätiges Auslösen gibt es kein Zurückpendeln, also braucht es
   * weder eine Zeitsperre noch eine Merke, ob ein Tor gerade scharf ist. Wer
   * im Gegentor landet, steht eben darin, bis er F drückt.
   *
   * Geprüft wird trotzdem hier: der Client sagt nur, *welches* Tor er meint.
   * Ob die Figur dort steht, entscheidet der Server — sonst wäre es eine
   * Einladung, sich von überall aus überallhin zu setzen.
   */
  private usePortal(session: Session, portalId: string): void {
    const instance = this.instances.get(session.mapId);
    const row = instance?.entity(session.entityId);
    if (!instance || !row || row.state === EntityState.Dead) return;

    const portal = instance.doc.portals.find((p) => p.id === portalId);
    if (!portal) return;

    const dx = row.x - portal.position[0];
    const dz = row.z - portal.position[1];
    if (dx * dx + dz * dz > portal.radius * portal.radius) return;

    this.transfer(session, portalId);
  }

  private transfer(session: Session, portalId: string): void {
    const from = this.instances.get(session.mapId);
    const character = session.character;
    if (!from || !character) return;

    const portal = from.doc.portals.find((p) => p.id === portalId);
    if (!portal) return;

    // Eine Meldung je Anfrage — es gibt keine Wiederholung mehr abzufangen,
    // seit nur noch der Tastendruck auslöst.
    if (character.level < portal.minLevel) {
      this.systemMessage(session, `Für ${portal.label} brauchst du Stufe ${portal.minLevel}.`);
      return;
    }

    const to = this.instances.get(portal.target.map);
    if (!to) {
      this.systemMessage(session, `${portal.label} ist derzeit nicht erreichbar.`);
      return;
    }

    // Zustand aus der alten Welt retten, bevor das Entity dort verschwindet.
    const row = from.entity(session.entityId);
    const hp = row?.hp ?? character.hp;
    const stats = this.statsFor(session);
    const profile = this.attackProfileOf(session);

    from.removePlayer(session.entityId);
    this.sessionByEntity.delete(session.entityId);

    // Neue Kennung: der Client räumt beim Kartenwechsel ohnehin alles ab, und
    // eine frische Nummer verhindert Verwechslungen mit Altbeständen.
    session.entityId = this.nextEntityId++;
    session.mapId = to.doc.id;
    session.known.clear();
    // Eingaben, die noch für die alte Welt gedacht waren, gehören nicht in die
    // neue. `lastInputSeq` bleibt dagegen stehen: der Zähler gehört der
    // Verbindung, und die läuft weiter.
    session.inputQueue.length = 0;

    to.world.spawnPlayer({
      id: session.entityId,
      level: character.level,
      x: portal.target.x,
      z: portal.target.z,
      yaw: portal.target.yaw,
      hp,
      maxHp: stats.maxHp,
      mp: character.mp,
      maxMp: stats.maxMp,
      attackDamage: stats.attackDamage,
      defense: stats.defense,
      moveSpeed: stats.moveSpeed,
      attackRange: profile.range,
      attackArc: profile.arc,
      attackCooldownSec: profile.cooldownSec,
      attackWindupSec: profile.windupSec,
      attackStyle: profile.style,
      radius: PLAYER_PROFILE.radius,
      height: PLAYER_PROFILE.height,
    });
    to.meta.set(session.entityId, {
      defId: 'player',
      name: session.accountName,
      type: EntityType.Player,
      weapon: profile.rig,
    });
    to.playerIds.add(session.entityId);
    this.sessionByEntity.set(session.entityId, session);

    character.mapId = to.doc.id;
    character.x = portal.target.x;
    character.z = portal.target.z;
    character.yaw = portal.target.yaw;

    const spawnY = to.world.heightAt(portal.target.x, portal.target.z);
    session.send(
      encodeWelcome({
        protocolVersion: PROTOCOL_VERSION,
        entityId: session.entityId,
        mapId: to.doc.id,
        tick: to.world.tick,
        tickRate: 20,
        snapshotRate: 20 / SNAPSHOT_TICK_DIVISOR,
        cipherId: 0,
        serverTimeMs: Date.now(),
      }),
    );
    session.send(
      encodeMapChange({
        mapId: to.doc.id,
        x: portal.target.x,
        y: spawnY,
        z: portal.target.z,
        yaw: portal.target.yaw,
      }),
    );
    this.systemMessage(session, `${to.doc.name} betreten.`);
  }

  /**
   * Legt einen Gegenstand an.
   *
   * Der Client sagt nur, *welchen*. Ob er ihn besitzt und ob die Stufe reicht,
   * entscheidet ausschliesslich diese Stelle — sonst legte sich jeder per Paket
   * an, was er nicht hat.
   *
   * Ein zweiter Gegenstand im selben Platz verdrängt den ersten. Das ist das
   * ganze Ausrüstungssystem: eine Hand, eine Waffe.
   */
  private equipItem(session: Session, itemId: string): void {
    const entry = session.items.find((i) => i.itemId === itemId);
    if (!entry) return;

    const def = getItem(itemId);
    if (!def || def.slot === 'none') return;

    const level = session.character?.level ?? 1;
    if (level < def.levelReq) {
      this.systemMessage(session, `${def.name} braucht Stufe ${def.levelReq}.`);
      return;
    }

    // Schon angelegt: nichts zu tun. Ein Doppelklick soll nichts ablegen —
    // ohne Waffe dazustehen ist selten das, was jemand wollte.
    if (entry.equipped) return;

    for (const other of session.items) {
      if (other === entry) continue;
      if (!other.equipped) continue;
      if (getItem(other.itemId)?.slot === def.slot) other.equipped = false;
    }
    entry.equipped = true;
    session.itemsDirty = true;

    this.applyLoadout(session);
    this.sendInventory(session);
    this.sendStats(session);
    this.systemMessage(session, `${def.name} angelegt.`);
  }

  /**
   * Überträgt Werte und Angriffsprofil der Ausrüstung in die Welt.
   *
   * Beides zusammen, weil beides an derselben Ausrüstung hängt: der Schaden aus
   * `statsFor`, die Art des Zuschlagens aus der Waffe. Die Waffe wandert
   * ausserdem in die Entity-Meta, damit sie im nächsten Snapshot bei allen
   * ankommt — Ausrüstung ist sichtbar.
   */
  private applyLoadout(session: Session): void {
    const instance = this.instances.get(session.mapId);
    const character = session.character;
    if (!instance || !character) return;

    const stats = this.statsFor(session);
    const profile = this.attackProfileOf(session);

    instance.world.setPlayerStats(
      session.entityId,
      character.level,
      stats.maxHp,
      stats.maxMp,
      stats.attackDamage,
      stats.defense,
    );
    instance.world.setAttackProfile(
      session.entityId,
      profile.style,
      profile.range,
      profile.arc,
      profile.cooldownSec,
      profile.windupSec,
    );

    const meta = instance.metaFor(session.entityId);
    if (meta) meta.weapon = profile.rig;

    // Der Snapshot schickt eine volle Zeile nur für Unbekanntes. Damit die
    // neue Waffe bei allen ankommt, muss die Figur einmal als neu gelten.
    for (const other of this.sessions) other.known.delete(session.entityId);
  }

  private sendInventory(session: Session): void {
    session.send(
      encodeInventory(
        session.items.map((i) => ({
          itemId: i.itemId,
          count: i.count,
          slot: i.slot,
          equipped: i.equipped,
        })),
      ),
    );
  }

  private respawn(session: Session): void {
    const instance = this.instances.get(session.mapId);
    const row = instance?.entity(session.entityId);
    if (!instance || !row || row.state !== EntityState.Dead) return;

    instance.world.respawnPlayer(session.entityId, instance.doc.spawn.x, instance.doc.spawn.z);
    this.sendStats(session);
  }

  // -------------------------------------------------------------------------
  // NPCs, Aufträge, Handel
  // -------------------------------------------------------------------------

  /**
   * Einen NPC ansprechen.
   *
   * Der Client schickt eine Entity-Kennung; alles andere wird hier geprüft.
   * Ohne die Entfernungsprüfung liesse sich vom anderen Ende der Karte aus
   * handeln — und Handeln heisst Gold, also ist das keine Kleinigkeit.
   */
  private interact(session: Session, entityId: number): void {
    const instance = this.instances.get(session.mapId);
    const self = instance?.entity(session.entityId);
    const target = instance?.entity(entityId);
    if (!instance || !self || !target) return;
    if (self.state === EntityState.Dead) return;

    const meta = instance.metaFor(entityId);
    if (!meta || meta.type !== EntityType.Npc) return;

    const dx = target.x - self.x;
    const dz = target.z - self.z;
    if (dx * dx + dz * dz > INTERACT_RANGE * INTERACT_RANGE) {
      this.systemMessage(session, 'Zu weit weg.');
      return;
    }

    const def = getNpc(meta.defId);
    if (!def) return;

    // Ansprechen ist selbst ein Auftragsziel — die halbe Wegbeschreibung im
    // Spiel besteht daraus, jemanden aufzusuchen.
    if (session.quests.onTalk(meta.defId)) {
      session.questsDirty = true;
      this.sendQuestLog(session);
    }

    session.send(
      encodeNpcDialog({
        entityId,
        npcDefId: meta.defId,
        shop: (def.shop?.length ?? 0) > 0,
        quests: session.quests.dialogFor(meta.defId, session.character?.level ?? 1),
      }),
    );
    session.flush();
  }

  /**
   * Auftrag annehmen, abgeben oder aufgeben.
   *
   * Beim Abgeben wird zusätzlich geprüft, ob die Figur beim richtigen NPC
   * steht. Der Client zeigt den Knopf nur dort an — aber der Client ist ein
   * Wunsch, keine Erlaubnis.
   */
  private questAction(session: Session, questId: string, action: number): void {
    const def = getQuest(questId);
    const character = session.character;
    if (!def || !character) return;

    switch (action) {
      case QuestAction.Annehmen: {
        if (!this.nearNpc(session, def.giver)) return;
        if (!session.quests.accept(def, character.level, session.items)) {
          this.systemMessage(session, `„${def.name}" ist gerade nicht verfügbar.`);
          return;
        }
        this.systemMessage(session, `Auftrag angenommen: ${def.name}.`);
        break;
      }

      case QuestAction.Abgeben: {
        if (!this.nearNpc(session, turnInOf(def))) return;
        if (!session.quests.canComplete(def)) {
          this.systemMessage(session, `„${def.name}" ist noch nicht erledigt.`);
          return;
        }

        // Erst die Sammelgegenstände einziehen, dann belohnen. Andersherum
        // könnte der Beutel durch die Belohnung voll sein und das Einziehen
        // scheitern — nachdem die Belohnung schon vergeben ist.
        for (const obj of def.objectives) {
          if (obj.kind !== 'collect') continue;
          if (!removeItem(session.items, obj.target, obj.count)) {
            this.systemMessage(session, 'Es fehlt etwas im Beutel.');
            session.quests.syncCollect(session.items);
            this.sendQuestLog(session);
            return;
          }
        }

        session.quests.complete(def);
        character.exp += def.reward.exp;
        character.gold += def.reward.gold;

        for (const geschenk of def.reward.items) {
          const angekommen = addItem(session.items, geschenk.item, geschenk.count);
          if (angekommen < geschenk.count) {
            this.systemMessage(session, 'Der Beutel ist voll — ein Teil der Belohnung blieb liegen.');
          }
        }

        this.levelUpIfNeeded(session);
        session.itemsDirty = true;
        this.systemMessage(
          session,
          `Auftrag abgeschlossen: ${def.name} (+${def.reward.exp} EP, +${def.reward.gold} Gold).`,
        );
        break;
      }

      case QuestAction.Aufgeben: {
        if (!session.quests.abandon(questId)) return;
        this.systemMessage(session, `Auftrag aufgegeben: ${def.name}.`);
        break;
      }

      default:
        return;
    }

    session.questsDirty = true;
    session.quests.syncCollect(session.items);
    this.sendQuestLog(session);
    this.sendInventory(session);
    this.sendStats(session);
    session.flush();
  }

  /** Kaufen und verkaufen. `mode` ist 0 für kaufen, 1 für verkaufen. */
  private shopTrade(session: Session, mode: number, itemId: string, count: number): void {
    const character = session.character;
    const def = getItem(itemId);
    if (!character || !def) return;

    const menge = Math.max(1, Math.min(99, Math.round(count)));
    const npc = this.nearestShopNpc(session);
    if (!npc) {
      this.systemMessage(session, 'Kein Händler in der Nähe.');
      return;
    }

    if (mode === 0) {
      // Nur was der Händler auch führt. Sonst kaufte man sich per Paket die
      // Eisenklinge bei der Kräuterfrau.
      if (!npc.shop?.includes(itemId)) return;

      const preis = def.value * menge;
      if (character.gold < preis) {
        this.systemMessage(session, `Dafür fehlen ${preis - character.gold} Gold.`);
        return;
      }

      const angekommen = addItem(session.items, itemId, menge);
      if (angekommen === 0) {
        this.systemMessage(session, 'Der Beutel ist voll.');
        return;
      }
      character.gold -= def.value * angekommen;
      this.systemMessage(session, `${def.name} ×${angekommen} gekauft.`);
    } else {
      if (!removeItem(session.items, itemId, menge)) {
        this.systemMessage(session, 'So viel ist nicht da.');
        return;
      }
      const erloes = sellPrice(def) * menge;
      character.gold += erloes;
      this.systemMessage(session, `${def.name} ×${menge} verkauft (+${erloes} Gold).`);
    }

    session.itemsDirty = true;
    // Verkaufen kann ein Sammelziel zunichtemachen — und Kaufen eines
    // erfüllen. Beides ist derselbe Aufruf, weil der Beutel gemessen wird.
    if (session.quests.syncCollect(session.items)) {
      session.questsDirty = true;
      this.sendQuestLog(session);
    }
    this.sendInventory(session);
    this.sendStats(session);
    session.flush();
  }

  /** Steht die Figur bei einem NPC dieser Art? */
  private nearNpc(session: Session, npcDefId: string): boolean {
    const instance = this.instances.get(session.mapId);
    const self = instance?.entity(session.entityId);
    if (!instance || !self) return false;

    for (const row of instance.entities) {
      const meta = instance.metaFor(row.id);
      if (!meta || meta.type !== EntityType.Npc || meta.defId !== npcDefId) continue;
      const dx = row.x - self.x;
      const dz = row.z - self.z;
      if (dx * dx + dz * dz <= INTERACT_RANGE * INTERACT_RANGE) return true;
    }
    return false;
  }

  /** Der nächstgelegene NPC mit Laden, oder nichts. */
  private nearestShopNpc(session: Session): ReturnType<typeof getNpc> {
    const instance = this.instances.get(session.mapId);
    const self = instance?.entity(session.entityId);
    if (!instance || !self) return undefined;

    for (const row of instance.entities) {
      const meta = instance.metaFor(row.id);
      if (!meta || meta.type !== EntityType.Npc) continue;
      const def = getNpc(meta.defId);
      if (!def?.shop?.length) continue;
      const dx = row.x - self.x;
      const dz = row.z - self.z;
      if (dx * dx + dz * dz <= INTERACT_RANGE * INTERACT_RANGE) return def;
    }
    return undefined;
  }

  private sendQuestLog(session: Session): void {
    session.send(encodeQuestLog(session.quests.rows()));
  }

  /**
   * Beute.
   *
   * Fällt ohne Umweg in den Beutel des Spielers, der den Todesstoss gesetzt
   * hat. Kein Beutel am Boden — auf dem Telefon wäre das Aufheben eine
   * Zumutung, und für den Server ist es eine zweite Sorte Entity.
   */
  private rollDrops(session: Session, mobId: string): boolean {
    const mob = MOBS.get(mobId);
    if (!mob?.drops?.length) return false;

    let etwas = false;
    for (const drop of mob.drops) {
      if (Math.random() > drop.chance) continue;
      const min = drop.min ?? 1;
      const max = drop.max ?? min;
      const menge = min + Math.floor(Math.random() * (max - min + 1));
      const angekommen = addItem(session.items, drop.item, menge);
      if (angekommen <= 0) continue;

      etwas = true;
      const def = getItem(drop.item);
      this.systemMessage(
        session,
        `Erhalten: ${def?.name ?? drop.item}${angekommen > 1 ? ` ×${angekommen}` : ''}.`,
      );
    }
    return etwas;
  }

  /** Stufenaufstiege einlösen, solange die Erfahrung reicht. */
  private levelUpIfNeeded(session: Session): void {
    const character = session.character;
    const instance = this.instances.get(session.mapId);
    if (!character || !instance) return;

    let levelled = false;
    while (character.exp >= expForLevel(character.level)) {
      character.exp -= expForLevel(character.level);
      character.level++;
      levelled = true;
    }
    if (!levelled) return;

    const stats = this.statsFor(session);
    instance.world.setPlayerStats(
      session.entityId,
      character.level,
      stats.maxHp,
      stats.maxMp,
      stats.attackDamage,
      stats.defense,
    );
    this.systemMessage(session, `Stufe ${character.level} erreicht.`);
  }

  // -------------------------------------------------------------------------
  // Kleinkram
  // -------------------------------------------------------------------------

  private onChat(session: Session, channel: number, text: string): void {
    const trimmed = text.trim().slice(0, 200);
    if (trimmed.length === 0) return;

    const instance = this.instances.get(session.mapId);
    if (!instance) return;

    const packet = encodeServerChat({
      channel: channel === ChatChannel.Shout ? ChatChannel.Shout : ChatChannel.Say,
      from: session.accountName,
      text: trimmed,
    });

    // Rufen erreicht die ganze Map, Reden nur die Umgebung.
    if (channel === ChatChannel.Shout) {
      for (const playerId of instance.playerIds) {
        this.sessionByEntity.get(playerId)?.send(packet);
      }
      return;
    }

    const row = instance.entity(session.entityId);
    if (row) this.broadcastNear(instance, row.x, row.z, packet);
  }

  private systemMessage(session: Session, text: string): void {
    session.send(encodeServerChat({ channel: ChatChannel.System, from: '', text }));
  }

  /** Grundwerte der Stufe plus Boni der angelegten Ausrüstung. */
  /** Die angelegte Hauptwaffe, oder nichts. */
  private mainhandOf(session: Session): ItemDef | undefined {
    for (const entry of session.items) {
      if (!entry.equipped) continue;
      const def = getItem(entry.itemId);
      if (def?.slot === 'mainhand') return def;
    }
    return undefined;
  }

  /** Angriffsprofil aus der angelegten Waffe. Eine Stelle, drei Nutzer. */
  private attackProfileOf(session: Session): ReturnType<typeof attackProfileFor> {
    return attackProfileFor(this.mainhandOf(session));
  }

  private statsFor(session: Session): ReturnType<typeof baseStatsForLevel> {
    const level = session.character?.level ?? 1;
    const stats = baseStatsForLevel(level);
    for (const entry of session.items) {
      if (!entry.equipped) continue;
      const def = getItem(entry.itemId);
      if (!def) continue;
      stats.attackDamage += def.attackDamage;
      stats.defense += def.defense;
    }
    return stats;
  }

  private sendStats(session: Session): void {
    const character = session.character;
    if (!character) return;
    const instance = this.instances.get(session.mapId);
    const row = instance?.entity(session.entityId);
    const stats = this.statsFor(session);

    session.send(
      encodeStats({
        level: character.level,
        exp: character.exp,
        expForNext: expForLevel(character.level),
        hp: row?.hp ?? character.hp,
        maxHp: row?.maxHp ?? stats.maxHp,
        mp: character.mp,
        maxMp: stats.maxMp,
        gold: character.gold,
        attackDamage: stats.attackDamage,
        defense: stats.defense,
      }),
    );
  }

  private async persistAll(): Promise<void> {
    for (const session of this.sessions) {
      if (session.state === 'playing') {
        await this.persist(session).catch((err) =>
          console.error('[db] Speichern fehlgeschlagen:', err),
        );
      }
    }
  }

  /** Schreibt Position und Fortschritt zurück in die Datenbank. */
  private async persist(session: Session): Promise<void> {
    const character = session.character;
    if (!character) return;

    const row = this.instances.get(session.mapId)?.entity(session.entityId);
    if (row) {
      character.x = row.x;
      character.z = row.z;
      character.yaw = row.yaw;
      character.hp = Math.round(row.hp);
      character.mapId = session.mapId;
    }
    await this.store.saveCharacter(character);

    // Beutel und Aufträge nur, wenn sich etwas getan hat: beide werden
    // ersetzend geschrieben, und das ist deutlich teurer als eine Zeile mit
    // der neuen Position.
    if (session.itemsDirty) {
      await this.store.saveInventory(character.id, session.items);
      session.itemsDirty = false;
    }
    if (session.questsDirty) {
      await this.store.saveQuests(character.id, session.quests.records());
      session.questsDirty = false;
    }
  }
}

/** Kontonamen auf etwas eingrenzen, das als Anzeigename taugt. */
function sanitizeName(raw: string): string {
  return raw
    .trim()
    .slice(0, 20)
    .replace(/[^\p{L}\p{N}_-]/gu, '');
}
