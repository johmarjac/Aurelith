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
  SNAPSHOT_TICK_DIVISOR,
  TICK_MS,
  TICK_SECONDS,
  baseStatsForLevel,
  ClientOp,
  decodeClientChat,
  decodeFrame,
  decodeHello,
  decodeInput,
  decodePing,
  decodeSetTarget,
  decodeUsePortal,
  encodeCombatEvent,
  encodeInventory,
  encodeKick,
  encodeMapChange,
  encodePong,
  encodeServerChat,
  encodeSnapshot,
  encodeStats,
  encodeWelcome,
  expForLevel,
  expGain,
  getItem,
  readPacket,
  type SpawnRow,
  type UpdateRow,
} from '@aurelith/shared';
import { CoreEventType, CoreButton } from '@aurelith/core';
import { config } from './config.ts';
import type { CoreBundle } from './core.ts';
import type { MapStore } from './maps.ts';
import { MapInstance } from './mapInstance.ts';
import { INPUT_QUEUE_DRAIN_AT, INPUT_QUEUE_DRAIN_MAX, Session } from './session.ts';
import type { GameStore } from './db/index.ts';

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
    session.entityId = this.nextEntityId++;
    session.mapId = instance.doc.id;
    session.state = 'playing';

    const stats = this.statsFor(session);
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
      attackRange: PLAYER_PROFILE.attackRange,
      attackArc: PLAYER_PROFILE.attackArc,
      attackCooldownSec: PLAYER_PROFILE.attackCooldownSec,
      attackWindupSec: PLAYER_PROFILE.attackWindupSec,
      radius: PLAYER_PROFILE.radius,
      height: PLAYER_PROFILE.height,
    });
    instance.meta.set(session.entityId, {
      defId: 'player',
      name: accountName,
      type: EntityType.Player,
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

    let levelled = false;
    while (character.exp >= expForLevel(character.level)) {
      character.exp -= expForLevel(character.level);
      character.level++;
      levelled = true;
    }

    if (levelled) {
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
      attackRange: PLAYER_PROFILE.attackRange,
      attackArc: PLAYER_PROFILE.attackArc,
      attackCooldownSec: PLAYER_PROFILE.attackCooldownSec,
      attackWindupSec: PLAYER_PROFILE.attackWindupSec,
      radius: PLAYER_PROFILE.radius,
      height: PLAYER_PROFILE.height,
    });
    to.meta.set(session.entityId, {
      defId: 'player',
      name: session.accountName,
      type: EntityType.Player,
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

  private respawn(session: Session): void {
    const instance = this.instances.get(session.mapId);
    const row = instance?.entity(session.entityId);
    if (!instance || !row || row.state !== EntityState.Dead) return;

    instance.world.respawnPlayer(session.entityId, instance.doc.spawn.x, instance.doc.spawn.z);
    this.sendStats(session);
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
  }
}

/** Kontonamen auf etwas eingrenzen, das als Anzeigename taugt. */
function sanitizeName(raw: string): string {
  return raw
    .trim()
    .slice(0, 20)
    .replace(/[^\p{L}\p{N}_-]/gu, '');
}
