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
  AccessLevel,
  ByteReader,
  canUseSkill,
  ChatChannel,
  EntityState,
  EntityType,
  FrameError,
  INTEREST_RADIUS,
  KickReason,
  MOBS,
  playerProfile,
  MIN_PASSWORD_LENGTH,
  PROTOCOL_VERSION,
  QuestAction,
  SNAPSHOT_TICK_DIVISOR,
  TICK_MS,
  TICK_SECONDS,
  attackProfileFor,
  AttributeSheet,
  baseStatsForLevel,
  ClientOp,
  decodeClientChat,
  decodeEquipItem,
  decodeFrame,
  decodeHello,
  decodeInput,
  decodeInteract,
  decodePickupLoot,
  decodePing,
  decodeQuestAction,
  decodeSetTarget,
  decodeTicket,
  decodeShopTrade,
  decodeUpgradeItem,
  decodeCharacterRef,
  decodeCreateCharacter,
  decodeCredentials,
  decodeItemSlot,
  decodeMoveItem,
  decodeUseItem,
  decodeUseSkill,
  decodeUsePortal,
  encodeCombatEvent,
  encodeInventory,
  encodeKick,
  EmoteKind,
  encodeEmote,
  encodeSkillCast,
  encodeLobby,
  encodeLobbyError,
  encodeServerVersion,
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
  maxUpgrade,
  getItem,
  getClass,
  KEIN_BERUF,
  getNpc,
  getSkill,
  getQuest,
  isUpgradable,
  type ItemDef,
  slotCapacity,
  styleOf,
  encodeOutfit,
  isVisibleSlot,
  activeArmorSet,
  setGlowLevel,
  type WornPiece,
  type Outfit,
  type LootRow,
  readPacket,
  upgradeBonus,
  upgradeChance,
  upgradeCost,
  upgradeName,
  sellPrice,
  type SpawnRow,
  tuning,
  turnInOf,
  type UpdateRow,
  accessFromName,
  accessName,
  isValidName,
} from '@aurelith/shared';
import { CoreEventType, CoreButton } from '@aurelith/core';
import { hashPassword, verifyPassword } from './passwords.ts';
import { runCommand } from './commands.ts';
import { anmelden } from './accounts.ts';
import type { LoginClient } from './loginClient.ts';
import { config } from './config.ts';
import {
  protokolliereOpcodeFehler,
  protokolliereRahmenfehler,
  type RahmenQuelle,
} from './framelog.ts';
import type { CoreBundle } from './core.ts';
import type { MapStore } from './maps.ts';
import { MapInstance, type EntityMeta } from './mapInstance.ts';
import { INPUT_QUEUE_DRAIN_AT, INPUT_QUEUE_DRAIN_MAX, Session } from './session.ts';
import {
  addItem,
  freeBagSlots,
  inventorySlots,
  normalizeSlots,
  removeItem,
  removeSlot,
} from './inventory.ts';
import type { ItemRecord, KontoStore, WeltStore } from './db/index.ts';

/**
 * So viele Fehlversuche verträgt eine Verbindung, dann fliegt sie.
 *
 * Grosszügig gegenüber einem vertippten Passwort und eng genug, dass eine
 * Liste durchzuprobieren teuer wird: wer weitermachen will, muss jedes Mal neu
 * verbinden, und das kostet Zeit und fällt im Protokoll auf.
 */
const MAX_LOGIN_ATTEMPTS = 6;

/** Wie nah man an einem NPC stehen muss — aus den Stellschrauben. */
const interactRange = (): number => tuning().world.interactRange;

/**
 * Die Weltuhr.
 *
 * Nicht `Date.now()` an den Aufrufstellen: an dieser Uhr hängt der
 * Tageszyklus, und sie muss sich für Bilder und Prüfungen stellen lassen.
 * Drei Abschriften von `Date.now()` liessen sich das nicht sagen.
 */
const worldNow = (): number => Date.now() + config.timeOffsetMs;

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
    /**
     * Die Weltdatenbank dieses Servers — Figuren, Beutel, Aufträge.
     *
     * Sie steht in derselben Region wie dieser Kanal. Das ist der Grund für
     * die ganze Aufteilung: eine Figur wird beim Betreten geladen und alle
     * dreissig Sekunden geschrieben, und beides über ein Seekabel wäre in
     * jeder Sitzung spürbar.
     */
    private readonly welt: WeltStore,
    /**
     * Die Verbindung zum Anmeldeserver.
     *
     * Immer da, auch im Alleinbetrieb — dann ist sie still und `aktiv` ist
     * falsch. Ein `undefined` hier hiesse, an jeder Stelle zu fragen, ob es
     * sie gibt, und die Antwort wäre überall dieselbe Verzweigung.
     */
    private readonly login: LoginClient,
    /**
     * Konten — **nur** im Alleinbetrieb.
     *
     * Läuft ein Anmeldeserver, sieht dieser Prozess nie ein Passwort und
     * braucht die Masterdatenbank nicht: wer da ist, sagt die Eintrittskarte.
     * Das ist keine Sparsamkeit, sondern der Sinn der Trennung — die
     * Masterdatenbank steht in einer anderen Erdhälfte.
     */
    private readonly konten?: KontoStore,
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

    // Die Adresse einmal beim Verbinden merken: nach dem Schliessen ist sie
    // weg, und der Rahmenfehler, den man protokollieren will, kommt gern genau
    // dann.
    session.adresse = String(
      (ws as unknown as { _socket?: { remoteAddress?: string } })._socket?.remoteAddress ?? '',
    );

    ws.binaryType = 'nodebuffer';
    ws.on('message', (data: Buffer) => {
      session.lastSeenAt = Date.now();
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      try {
        this.onFrame(session, bytes);
      } catch (err) {
        if (err instanceof FrameError) {
          // Ins Ausgabefenster, mit Kopf und Hexdump. Ein Rahmenfehler beendet
          // die Sitzung — wenn er nicht protokolliert wird, ist er danach
          // spurlos weg, und übrig bleibt „die Verbindung bricht manchmal ab".
          session.rahmenfehler++;
          protokolliereRahmenfehler(this.quelleVon(session), err, bytes);
          session.send(encodeKick(KickReason.BadFrame, err.code));
          session.flush();
          session.close(1002, err.code);
        } else {
          console.error(`[sitzung ${session.id}] Fehler beim Verarbeiten:`, err);
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
    // Das Konto ist wieder frei — auf allen Kanälen. Ohne diese Meldung
    // bliebe es beim Anmeldeserver hängen, bis dieser Kanal verfällt.
    this.login.meldeAnwesenheit(session.accountId, false);
    this.login.setzeOnline(this.sessions.size);
    session.state = 'closed';
  }

  /** Wer da schickt — so viel, wie gerade bekannt ist. Für das Protokoll. */
  private quelleVon(session: Session): RahmenQuelle {
    return {
      sitzung: session.id,
      zustand: session.state,
      konto: session.accountName,
      figur: session.character?.name ?? '',
      adresse: session.adresse,
    };
  }

  private onFrame(session: Session, data: Uint8Array): void {
    const frame = decodeFrame(data, session.cipherSuite);
    for (const raw of frame.packets) {
      const { opcode, reader } = readPacket(raw);
      try {
        this.onPacket(session, opcode, reader);
      } catch (err) {
        // Rahmen in Ordnung, Inhalt nicht: meist ein Rumpf, der sich geändert
        // hat, während die Protokollversion stehenblieb. Das Paket fällt aus,
        // die Sitzung bleibt — ein einzelnes unlesbares Paket ist kein Grund,
        // jemanden aus der Welt zu werfen.
        session.paketfehler++;
        protokolliereOpcodeFehler(this.quelleVon(session), opcode, raw, err);
      }
    }
  }

  private onPacket(session: Session, opcode: number, reader: ByteReader): void {
    {
      switch (opcode) {
        case ClientOp.Hello:
          this.onHello(session, decodeHello(reader));
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
          const { slot } = decodeEquipItem(reader);
          this.equipItem(session, slot);
          break;
        }
        case ClientOp.UpgradeItem: {
          if (session.state !== 'playing') break;
          const { slot } = decodeUpgradeItem(reader);
          this.upgradeItem(session, slot);
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
          const { mode, itemId, count, slot } = decodeShopTrade(reader);
          this.shopTrade(session, mode, itemId, count, slot);
          break;
        }
        case ClientOp.MoveItem: {
          if (session.state !== 'playing') break;
          const { from, to } = decodeMoveItem(reader);
          this.moveItem(session, from, to);
          break;
        }
        case ClientOp.UseItem: {
          if (session.state !== 'playing') break;
          const { slot } = decodeUseItem(reader);
          this.useItem(session, slot);
          break;
        }
        case ClientOp.DropItem: {
          if (session.state !== 'playing') break;
          this.dropItem(session, decodeItemSlot(reader).slot);
          break;
        }
        case ClientOp.DestroyItem: {
          if (session.state !== 'playing') break;
          this.destroyItem(session, decodeItemSlot(reader).slot);
          break;
        }
        case ClientOp.PickupLoot: {
          if (session.state !== 'playing') break;
          const { lootId } = decodePickupLoot(reader);
          this.pickupLoot(session, lootId);
          break;
        }
        case ClientOp.Respawn:
          if (session.state === 'playing') this.respawn(session);
          break;
        case ClientOp.Login:
          void this.onLogin(session, decodeCredentials(reader), false);
          break;
        case ClientOp.CreateAccount:
          void this.onLogin(session, decodeCredentials(reader), true);
          break;
        case ClientOp.Ticket:
          void this.onTicket(session, decodeTicket(reader).ticket);
          break;
        case ClientOp.CreateCharacter:
          void (() => {
            const { name } = decodeCreateCharacter(reader);
            return this.onCreateCharacter(session, name);
          })();
          break;
        case ClientOp.DeleteCharacter:
          void this.onDeleteCharacter(session, decodeCharacterRef(reader).characterId);
          break;
        case ClientOp.EnterWorld:
          void this.onEnterWorld(session, decodeCharacterRef(reader).characterId);
          break;
        case ClientOp.LeaveWorld:
          if (session.state === 'playing') void this.onLeaveWorld(session);
          break;
        case ClientOp.UseSkill: {
          if (session.state !== 'playing') break;
          this.useSkill(session, decodeUseSkill(reader).skillId);
          break;
        }
        case ClientOp.VersionRequest:
          // Ohne Zustandsprüfung: die Fassung ist keine Auskunft über die
          // Welt, und gerade wenn eine Sitzung nicht ins Spiel kommt, will
          // man wissen, gegen welchen Server man läuft.
          session.send(encodeServerVersion(config.build));
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

  private onHello(session: Session, hello: ReturnType<typeof decodeHello>): void {
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

    // Ab hier darf geredet werden — aber noch nichts über eine Figur. Wer man
    // ist, sagt `Login`.
    session.state = 'anonym';
  }

  /**
   * Anmelden oder Konto anlegen.
   *
   * Beide Wege enden an derselben Stelle, und sie scheitern mit demselben
   * Satz. „Kein solches Konto" gegen „falsches Passwort" zu unterscheiden
   * verrät, welche Namen es gibt — und das ist die Hälfte der Arbeit für den,
   * der sie durchprobiert.
   */
  /**
   * Anmeldung mit Name und Passwort — nur im **Alleinbetrieb**.
   *
   * Läuft ein Anmeldeserver, kennt dieser Server keine Passwörter: dann kommt
   * man ausschliesslich mit einer Eintrittskarte herein (siehe `onTicket`).
   * Beides zugleich zuzulassen hiesse, zwei Türen zu bauen und nur eine zu
   * bewachen.
   *
   * Die Regeln selbst — Namensform, Passwortlänge, Verwalterliste — stehen in
   * `accounts.ts` und gelten für beide Türen. Was hier steht, ist der Weg
   * dorthin und zurück.
   */
  private async onLogin(
    session: Session,
    daten: ReturnType<typeof decodeCredentials>,
    anlegen: boolean,
  ): Promise<void> {
    if (session.state !== 'anonym') return;

    if (this.login.aktiv) {
      session.send(
        encodeLobbyError('Dieser Server nimmt nur Eintrittskarten vom Anmeldeserver an.'),
      );
      session.flush();
      return;
    }

    // Fehlversuche kosten. Nach ein paar davon ist die Verbindung zu Ende —
    // wer wirklich sein Passwort sucht, verbindet neu; wer eine Liste
    // durchprobiert, fängt jedes Mal von vorn an.
    if (session.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
      session.send(encodeKick(KickReason.AuthFailed, 'Zu viele Fehlversuche.'));
      session.flush();
      session.close(1008, 'auth');
      return;
    }
    session.loginAttempts++;

    if (!this.konten) {
      session.send(encodeLobbyError('Dieser Server kennt keine Konten.'));
      session.flush();
      return;
    }

    const ergebnis = await anmelden(
      this.konten,
      daten.name,
      daten.password,
      anlegen,
      config.admins,
    );
    if (!ergebnis.ok) {
      session.send(encodeLobbyError(ergebnis.fehler));
      session.flush();
      return;
    }

    await this.uebernehmeKonto(
      session,
      ergebnis.account.id,
      ergebnis.account.name,
      ergebnis.account.accessLevel,
    );
  }

  /**
   * Eintrittskarte vorzeigen — der Weg herein, wenn ein Anmeldeserver läuft.
   *
   * Der Spielserver prüft die Karte nicht selbst, er fragt. Damit gibt es
   * genau eine Stelle im System, die Konten kennt, egal wie viele Kanäle
   * laufen — und ein neuer Kanal bringt keine neue Stelle mit, an der ein
   * Passwort falsch behandelt werden könnte.
   */
  private async onTicket(session: Session, ticket: string): Promise<void> {
    if (session.state !== 'anonym') return;
    if (!this.login.aktiv) {
      session.send(encodeLobbyError('Dieser Server läuft ohne Anmeldeserver.'));
      session.flush();
      return;
    }

    const konto = await this.login.loeseTicket(ticket);
    if (!konto) {
      // Auch ein Netzfehler landet hier. Der Text sagt beides zugleich, weil
      // der Spieler in beiden Fällen dasselbe tun soll: neu anmelden.
      session.send(encodeLobbyError('Die Eintrittskarte gilt nicht mehr. Melde dich neu an.'));
      session.flush();
      return;
    }

    // Die Zugriffsstufe kommt **mit der Karte**. Sie am Konto nachzusehen
    // hiesse, in die Masterdatenbank zu greifen — die in einer anderen
    // Erdhälfte steht und die dieser Prozess sonst gar nicht kennt.
    await this.uebernehmeKonto(session, konto.accountId, konto.accountName, konto.accessLevel);
  }

  /**
   * Trägt das Konto in die Sitzung ein und schickt die Figurenliste.
   *
   * Der gemeinsame Schluss beider Türen: was danach passiert, hängt nicht
   * mehr davon ab, ob ein Passwort oder eine Karte den Weg geöffnet hat.
   */
  private async uebernehmeKonto(
    session: Session,
    accountId: number,
    accountName: string,
    accessLevel: string,
  ): Promise<void> {
    /*
     * Ein Konto, eine Sitzung — auf **diesem** Kanal.
     *
     * Über alle Kanäle hinweg wacht der Anmeldeserver darüber; er ist der
     * Einzige, der alle kennt. Diese Prüfung hier bleibt trotzdem: sie gilt
     * auch im Alleinbetrieb, und sie fängt den Fall ab, in dem zwei
     * Eintrittskarten desselben Kontos kurz hintereinander ausgestellt wurden.
     *
     * Die zweite Anmeldung wird abgewiesen, die bestehende bleibt. Andersherum
     * — die ältere fliegt — war es einmal, und das ist die gefährlichere
     * Richtung: wer das Passwort kennt, könnte den Spieler damit jederzeit aus
     * der Welt werfen, mitten im Kampf.
     */
    for (const other of this.sessions) {
      if (other === session || other.accountId !== accountId) continue;
      if (other.state === 'closed') continue;

      session.send(
        encodeLobbyError(
          'Dieses Konto ist bereits angemeldet. Nach einem Verbindungsabbruch dauert ' +
            `es bis zu ${config.sessionTimeoutSeconds} Sekunden, bis es wieder frei ist.`,
        ),
      );
      session.flush();
      // Kein Fehlversuch: das Passwort stimmte. Sonst käme, wer sein Konto
      // sucht, nach sechs Versuchen ohne Grund vor die Tür.
      session.loginAttempts--;
      return;
    }

    session.accountId = accountId;
    session.accountName = accountName;
    session.access = accessFromName(accessLevel);
    session.state = 'lobby';
    session.loginAttempts = 0;
    // Nur im Alleinbetrieb: sonst hat der Anmeldeserver das schon getan, und
    // zwar dort, wo die Konten stehen.
    await this.konten?.touchLogin(accountId);

    // Dem Anmeldeserver sagen, dass dieses Konto hier ist. Er sperrt es damit
    // auf allen anderen Kanälen.
    this.login.meldeAnwesenheit(accountId, true);
    this.login.setzeOnline(this.sessions.size);

    await this.sendLobby(session);
    console.log(`[konto] ${accountName} in ${config.channelName} (${accessLevel})`);
  }

  /** Schickt den Stand der Verwaltung: wer man ist, welche Figuren es gibt. */
  private async sendLobby(session: Session): Promise<void> {
    if (session.accountId === 0) return;
    const figuren = await this.welt.listCharacters(session.accountId);
    session.send(
      encodeLobby({
        accountName: session.accountName,
        accessLevel: session.access,
        maxCharacters: config.maxCharacters,
        characters: figuren.map((c) => ({
          id: c.id,
          name: c.name,
          level: c.level,
          mapId: c.mapId,
          beruf: c.beruf,
        })),
      }),
    );
    session.flush();
  }

  private async onCreateCharacter(session: Session, name: string): Promise<void> {
    if (session.state !== 'lobby') return;

    const sauber = name.trim();
    if (!isValidName(sauber)) {
      session.send(
        encodeLobbyError(
          'Der Name darf drei bis sechzehn Buchstaben, Ziffern, Strich oder Unterstrich haben.',
        ),
      );
      session.flush();
      return;
    }

    const vorhanden = await this.welt.listCharacters(session.accountId);
    if (vorhanden.length >= config.maxCharacters) {
      session.send(
        encodeLobbyError(`Mehr als ${config.maxCharacters} Figuren gehen nicht.`),
      );
      session.flush();
      return;
    }

    const startMap = this.maps.require(config.startMap);
    // `startPos` übersteuert den Startpunkt der Karte — nur für Prüfungen
    // gedacht, und nur beim Anlegen einer Figur.
    const spawn = config.startPos ?? startMap.spawn;
    // Ohne Beruf: den lehrt der Kampfmeister ab Stufe 15.
    // In **dieser** Welt — die Datenbank dieses Servers. Kanäle teilen sie
    // sich; ein anderer Server hat seine eigene, in seiner eigenen Region.
    const figur = await this.welt.createCharacter(
      session.accountId,
      sauber,
      KEIN_BERUF,
      {
        mapId: startMap.id,
        x: spawn.x,
        z: spawn.z,
        yaw: spawn.yaw,
      },
    );
    if (!figur) {
      session.send(encodeLobbyError('Diesen Namen trägt schon jemand.'));
      session.flush();
      return;
    }

    await this.sendLobby(session);
  }

  private async onDeleteCharacter(session: Session, characterId: number): Promise<void> {
    if (session.state !== 'lobby') return;
    const weg = await this.welt.deleteCharacter(session.accountId, characterId);
    if (!weg) {
      session.send(encodeLobbyError('Diese Figur gibt es nicht.'));
      session.flush();
      return;
    }
    await this.sendLobby(session);
  }

  /**
   * Mit einer Figur in die Welt.
   *
   * Erst hier entsteht ein Entity. Alles davor — Konto, Liste, Anlegen — ist
   * Verwaltung und rührt die Simulation nicht an.
   */
  private async onEnterWorld(session: Session, characterId: number): Promise<void> {
    if (session.state !== 'lobby') return;

    const geladen = await this.welt.loadCharacter(session.accountId, characterId);
    if (!geladen) {
      session.send(encodeLobbyError('Diese Figur gibt es nicht.'));
      session.flush();
      return;
    }

    // Eine Map, die es nicht mehr gibt, darf keinen Eintritt blockieren.
    const instance =
      this.instances.get(geladen.character.mapId) ?? this.instances.get(config.startMap);
    if (!instance) {
      session.send(encodeLobbyError('Keine Karte verfügbar.'));
      session.flush();
      return;
    }

    session.character = geladen.character;
    session.items = geladen.items;
    session.quests.load(geladen.quests);
    // Sammelziele einmal am Beutel messen: wer sich abgemeldet hat, während
    // die Essenzen im Beutel lagen, ist beim Anmelden abgabebereit.
    session.quests.syncCollect(session.items);
    // Plätze zurechtrücken: was angelegt ist, gehört aus dem Beutel heraus.
    // Ältere Spielstände haben Angelegtes noch mitten im Raster liegen, und
    // die Datenbank kennt Zeilen ohne Platz.
    if (normalizeSlots(session.items)) session.itemsDirty = true;
    session.entityId = this.nextEntityId++;
    session.mapId = instance.doc.id;
    session.state = 'playing';

    const stats = this.statsFor(session);
    const profile = this.attackProfileOf(session);
    instance.world.spawnPlayer({
      id: session.entityId,
      level: geladen.character.level,
      x: geladen.character.x,
      z: geladen.character.z,
      yaw: geladen.character.yaw,
      hp: geladen.character.hp,
      maxHp: stats.maxHp,
      mp: geladen.character.mp,
      maxMp: stats.maxMp,
      attackDamage: stats.attackDamage,
      defense: stats.defense,
      moveSpeed: stats.moveSpeed,
      attackRange: profile.range,
      attackCooldownSec: profile.cooldownSec,
      attackWindupSec: profile.windupSec,
      attackStyle: profile.style,
      radius: playerProfile().radius,
      height: playerProfile().height,
    });
    instance.meta.set(session.entityId, this.playerMeta(session, geladen.character.name));
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
        serverTimeMs: worldNow(),
      }),
    );
    this.sendStats(session);
    this.sendInventory(session);
    this.sendQuestLog(session);
    this.systemMessage(session, `Willkommen in ${instance.doc.name}, ${geladen.character.name}.`);
    session.flush();

    console.log(
      `[sitzung] ${session.accountName}/${geladen.character.name} betritt ${instance.doc.id} ` +
        `(Entity ${session.entityId})`,
    );
  }

  /**
   * Die Figur verlässt die Welt, die Verbindung bleibt.
   *
   * Derselbe Weg wie beim Trennen — speichern, Entity entfernen —, nur endet
   * er in der Verwaltung statt im Nichts. Zwei Wege dorthin wären zwei
   * Gelegenheiten, das Speichern zu vergessen.
   */
  private async onLeaveWorld(session: Session): Promise<void> {
    await this.persist(session).catch((err) =>
      console.error('[db] Speichern beim Verlassen fehlgeschlagen:', err),
    );

    this.instances.get(session.mapId)?.removePlayer(session.entityId);
    this.sessionByEntity.delete(session.entityId);
    // Die anderen sollen die Figur nicht als bekannt führen — sie ist weg.
    for (const other of this.sessions) other.known.delete(session.entityId);

    session.entityId = 0;
    session.mapId = '';
    session.character = undefined;
    session.items = [];
    session.quests.load([]);
    session.itemsDirty = false;
    session.questsDirty = false;
    session.state = 'lobby';

    await this.sendLobby(session);
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
      // Nach dem Ablegen, nicht davor: sonst läge frische Beute einen Tick
      // lang da, ohne dass die Frist schon liefe.
      instance.loot.expire();
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
    this.levelUpIfNeeded(session);

    // Beute und Auftragsfortschritt hängen an derselben Stelle, weil beide
    // dieselbe Frage beantworten: *wer* hat *was* erlegt. Der Kern meldet den
    // Erfahrungsgewinn nur an den, der den Todesstoss gesetzt hat — genau der
    // soll auch die Beute vorfinden.
    const mobId = meta?.defId ?? '';
    const leiche = instance.entity(victimId);
    if (mobId && leiche) {
      this.dropLoot(session, instance, mobId, leiche.x, leiche.y, leiche.z, Math.round(gold));
    }

    // Erfahrung bleibt sofort, Beutel und Gold nicht: die Erfahrung ist kein
    // Gegenstand, sie liegt nirgends herum.
    if (mobId && session.quests.onKill(mobId)) {
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
        weaponUpgrade: meta?.weaponUpgrade ?? 0,
        outfit: meta?.outfit ?? '',
        setGlow: meta?.setGlow ?? 0,
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

    // Beute ohne Buchführung: die volle Liste dessen, was in Sichtweite liegt.
    // Was hier fehlt, liegt nicht mehr da — der Client braucht dafür keinen
    // eigenen Abgleich.
    const loot: LootRow[] = instance.loot
      .near(originX, originZ, INTEREST_RADIUS)
      .map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        z: p.z,
        item: p.item,
        count: p.count,
        upgrade: p.upgrade,
        gold: p.gold,
      }));

    session.send(
      encodeSnapshot({
        tick: instance.world.tick,
        ackInputSeq: session.lastInputSeq,
        serverTimeMs: worldNow(),
        spawns,
        updates,
        despawns,
        loot,
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
      attackCooldownSec: profile.cooldownSec,
      attackWindupSec: profile.windupSec,
      attackStyle: profile.style,
      radius: playerProfile().radius,
      height: playerProfile().height,
    });
    to.meta.set(session.entityId, this.playerMeta(session, session.accountName));
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
        serverTimeMs: worldNow(),
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
   * Der Client sagt nur, *welchen Platz*. Ob dort etwas liegt und ob die Stufe
   * reicht, entscheidet ausschliesslich diese Stelle — sonst legte sich jeder
   * per Paket an, was er nicht hat.
   *
   * Ein zweiter Gegenstand im selben Platz verdrängt den ersten. Das ist das
   * ganze Ausrüstungssystem: eine Hand, eine Waffe.
   */
  /**
   * Anlegen und Ablegen — dasselbe Paket, je nachdem was gerade der Fall ist.
   *
   * Früher war ein zweiter Klick auf ein angelegtes Stück absichtlich wirkungslos:
   * ohne Waffe dazustehen war selten das, was jemand wollte. Seit es Rüstung gibt,
   * ist das falsch herum — man muss sich ausziehen können, und zwar an der Stelle,
   * an der man sich anzieht. Der versehentliche Doppelklick fällt trotzdem nicht
   * zurück: die Kachel im Beutel hört nur auf Doppelklick, **solange nichts
   * angelegt ist**, und das Ablegen geht über den Platz an der Figur.
   */
  private equipItem(session: Session, slot: number): void {
    const entry = session.items.find((i) => i.slot === slot);
    if (!entry) return;

    const def = getItem(entry.itemId);
    if (!def || def.slot === 'none') return;

    if (entry.equipped) {
      // Abgelegt heisst: zurück in den Beutel. Ist dort keine Kachel frei,
      // bleibt es an. Sonst hätte das Stück nach dem Ablegen keinen Ort — und
      // ein Gegenstand ohne Ort ist ein verlorener Gegenstand.
      if (freeBagSlots(session.items) < 1) {
        this.systemMessage(session, 'Der Beutel ist voll — dafür ist kein Platz.');
        return;
      }
      entry.equipped = false;
      normalizeSlots(session.items);
      session.itemsDirty = true;
      this.applyLoadout(session);
      this.sendInventory(session);
      this.sendStats(session);
      this.systemMessage(session, `${upgradeName(def, entry.upgrade)} abgelegt.`);
      return;
    }

    const level = session.character?.level ?? 1;
    if (level < def.levelReq) {
      this.systemMessage(session, `${def.name} braucht Stufe ${def.levelReq}.`);
      return;
    }

    /**
     * Platz machen — aber nur so viel wie nötig.
     *
     * Ein Brustpanzer verdrängt den vorigen. Ein Ring nicht: davon passen
     * zwei, und erst der dritte schiebt den ältesten heraus. Welcher der
     * älteste ist, sagt die Reihenfolge im Beutel; eine eigene Zeitangabe je
     * Stück wäre ein Feld mehr für eine Frage, die sich einmal im Monat
     * stellt.
     */
    const getragen = session.items.filter(
      (other) => other !== entry && other.equipped && getItem(other.itemId)?.slot === def.slot,
    );
    const platz = slotCapacity(def.slot);
    const weichende = getragen.slice(0, Math.max(0, getragen.length - platz + 1));

    // Jedes verdrängte Stück braucht eine Kachel im Beutel. Eine wird gleich
    // frei — die des Stücks, das angelegt wird —, der Rest muss vorhanden
    // sein. Geprüft **bevor** irgendein Zustand kippt: eine halb ausgeführte
    // Umkleide wäre schlimmer als eine, die gar nicht stattfindet.
    if (weichende.length > freeBagSlots(session.items) + 1) {
      this.systemMessage(session, 'Der Beutel ist voll — dafür ist kein Platz.');
      return;
    }

    for (const weichen of weichende) weichen.equipped = false;

    entry.equipped = true;
    normalizeSlots(session.items);
    session.itemsDirty = true;

    this.applyLoadout(session);
    this.sendInventory(session);
    this.sendStats(session);
    this.systemMessage(session, `${upgradeName(def, entry.upgrade)} angelegt.`);
  }

  /**
   * Legt einen Gegenstand im Beutel auf einen anderen Platz.
   *
   * Nur innerhalb des Beutels: was am Körper hängt, ordnet nicht der Spieler,
   * sondern der Platz, an den es gehört — ein Helm liegt im Kopfkästchen, und
   * dort gibt es nichts umzusortieren. Wer ein angelegtes Stück verschieben
   * will, legt es ab.
   *
   * Liegt am Ziel etwas, tauschen die beiden ihre Plätze. Das ist die
   * Bewegung, die man von einem Raster erwartet — und sie kann nichts
   * verlieren: es bleiben dieselben Zeilen, nur mit anderen Nummern.
   */
  private moveItem(session: Session, from: number, to: number): void {
    if (from === to) return;
    const grenze = inventorySlots();
    if (from < 0 || from >= grenze || to < 0 || to >= grenze) return;

    const quelle = session.items.find((i) => i.slot === from);
    if (!quelle || quelle.equipped) return;

    const ziel = session.items.find((i) => i.slot === to);
    if (ziel?.equipped) return;

    quelle.slot = to;
    if (ziel) ziel.slot = from;

    session.itemsDirty = true;
    this.sendInventory(session);
  }

  /**
   * Prüft, ob ein Platz etwas enthält, das man loswerden darf.
   *
   * Eine Stelle für Wegwerfen und Vernichten: die Bedingungen sind dieselben,
   * und zwei Abschriften davon wären zwei Stellen, an denen eines Tages die
   * Auftragsgegenstände wieder in der Mülltonne landen.
   */
  private wegwerfbar(session: Session, slot: number): ItemRecord | undefined {
    const entry = session.items.find((i) => i.slot === slot);
    if (!entry) return undefined;

    // Angelegtes bleibt an der Figur. Erst ablegen, dann wegwerfen — sonst
    // steht die Figur nach einem Fehlgriff nackt da.
    if (entry.equipped) {
      this.systemMessage(session, 'Leg es erst ab.');
      return undefined;
    }

    const def = getItem(entry.itemId);
    if (def?.kind === 'quest') {
      this.systemMessage(session, `${def.name} gehört zu einem Auftrag.`);
      return undefined;
    }
    return entry;
  }

  /**
   * Legt einen Gegenstand vor die Füsse der Figur.
   *
   * Daraus wird ein gewöhnlicher Beutehaufen — mit derselben Verfallszeit und
   * derselben Reservierung wie die Beute eines Monsters. Ein eigener „liegt
   * für immer"-Haufen wäre eine zweite Sorte Beute, und die erste Sorte
   * räumt sich selbst auf.
   */
  private dropItem(session: Session, slot: number): void {
    const instance = this.instances.get(session.mapId);
    const self = instance?.entity(session.entityId);
    const entry = this.wegwerfbar(session, slot);
    if (!instance || !self || !entry) return;

    const genommen = removeSlot(session.items, slot, entry.count);
    if (!genommen) return;

    instance.loot.drop({
      x: self.x,
      y: self.y,
      z: self.z,
      item: genommen.itemId,
      count: genommen.count,
      upgrade: genommen.upgrade,
      gold: 0,
      owner: session.entityId,
    });

    const def = getItem(genommen.itemId);
    session.itemsDirty = true;
    this.sendInventory(session);
    this.systemMessage(
      session,
      `${def?.name ?? genommen.itemId} fallen gelassen${genommen.count > 1 ? ` (${genommen.count})` : ''}.`,
    );
  }

  /** Vernichtet einen Gegenstand. Weg ist weg — es gibt kein Zurück. */
  private destroyItem(session: Session, slot: number): void {
    const entry = this.wegwerfbar(session, slot);
    if (!entry) return;

    const genommen = removeSlot(session.items, slot, entry.count);
    if (!genommen) return;

    const def = getItem(genommen.itemId);
    session.itemsDirty = true;
    this.sendInventory(session);
    this.systemMessage(
      session,
      `${def?.name ?? genommen.itemId} vernichtet${genommen.count > 1 ? ` (${genommen.count})` : ''}.`,
    );
  }

  /**
   * Benutzt einen Verbrauchsgegenstand.
   *
   * Der Kern heilt und meldet zurück, wie viel angekommen ist. Genau daran
   * hängt, ob der Trank verbraucht wird: auf voller Gesundheit kommt null
   * zurück, und dann bleibt er im Beutel. Ohne diese Rückmeldung müsste der
   * Server den Füllstand selbst mitführen — eine zweite Wahrheit über etwas,
   * das der Kern schon weiß.
   */
  private useItem(session: Session, slot: number): void {
    const instance = this.instances.get(session.mapId);
    const entry = session.items.find((i) => i.slot === slot);
    if (!instance || !entry) return;

    const def = getItem(entry.itemId);
    if (!def || def.kind !== 'consumable') {
      this.systemMessage(session, 'Das lässt sich nicht benutzen.');
      return;
    }

    const angekommen = instance.world.heal(session.entityId, def.effectValue, 0);
    if (angekommen <= 0) {
      this.systemMessage(session, `${def.name} würde jetzt nichts bewirken.`);
      return;
    }

    removeSlot(session.items, slot, 1);
    session.itemsDirty = true;
    this.systemMessage(session, `${def.name} benutzt — ${Math.round(angekommen)} Leben zurück.`);
    this.sendInventory(session);
    this.sendStats(session);
  }

  /**
   * Wertet einen Gegenstand auf, +0 bis +10.
   *
   * Der Wurf passiert hier und nirgends sonst. Ein Fehlschlag kostet das Gold
   * und lässt die Stufe stehen — die Waffe zu zerstören wäre die Vorlage aus
   * den Neunzigern, und sie hat damals schon mehr Leute vertrieben als
   * gebunden.
   */
  private upgradeItem(session: Session, slot: number): void {
    const character = session.character;
    const entry = session.items.find((i) => i.slot === slot);
    if (!character || !entry) return;

    const def = getItem(entry.itemId);
    if (!def || !isUpgradable(def)) {
      this.systemMessage(session, 'Das lässt sich nicht aufwerten.');
      return;
    }

    // Nur beim Schmied. Wie beim Handel ist der Client hier nur der Antrag.
    if (!this.nearSmith(session)) {
      this.systemMessage(session, 'Dafür brauchst du einen Schmied.');
      return;
    }

    if (entry.upgrade >= maxUpgrade()) {
      this.systemMessage(session, `${upgradeName(def, entry.upgrade)} ist am Anschlag.`);
      return;
    }

    const kosten = upgradeCost(def, entry.upgrade);
    if (character.gold < kosten) {
      this.systemMessage(session, `Dafür fehlen ${kosten - character.gold} Gold.`);
      return;
    }

    character.gold -= kosten;
    session.itemsDirty = true;

    if (Math.random() <= upgradeChance(entry.upgrade)) {
      entry.upgrade++;
      this.systemMessage(session, `Aufwertung gelungen: ${upgradeName(def, entry.upgrade)}.`);
    } else {
      this.systemMessage(
        session,
        `Aufwertung misslungen. ${upgradeName(def, entry.upgrade)} bleibt, das Gold ist weg.`,
      );
    }

    // Auch der Fehlschlag geht durch `applyLoadout`: das Gold hat sich
    // geändert, und wer die Waffe trägt, soll den neuen Stand sehen.
    if (entry.equipped) this.applyLoadout(session);
    this.sendInventory(session);
    this.sendStats(session);
    session.flush();
  }

  /** Steht ein Schmied in Reichweite? */
  private nearSmith(session: Session): boolean {
    const instance = this.instances.get(session.mapId);
    const self = instance?.entity(session.entityId);
    if (!instance || !self) return false;

    for (const row of instance.entities) {
      const meta = instance.metaFor(row.id);
      if (!meta || meta.type !== EntityType.Npc) continue;
      if (getNpc(meta.defId)?.role !== 'smith') continue;
      const dx = row.x - self.x;
      const dz = row.z - self.z;
      if (dx * dx + dz * dz <= interactRange() * interactRange()) return true;
    }
    return false;
  }

  /**
   * Überträgt Werte und Angriffsprofil der Ausrüstung in die Welt.
   *
   * Beides zusammen, weil beides an derselben Ausrüstung hängt: der Schaden aus
   * `statsFor`, die Art des Zuschlagens aus der Waffe. Die Waffe wandert
   * ausserdem in die Entity-Meta, damit sie im nächsten Snapshot bei allen
   * ankommt — Ausrüstung ist sichtbar.
   */
  /**
   * Was man an dieser Figur sieht.
   *
   * Nur die sichtbaren Plätze — Ringe und Kette ändern die Werte und nicht das
   * Bild. Sie mitzuschicken hiesse, den Snapshot für eine Auskunft zu
   * verbreitern, die niemand ablesen kann.
   */
  /**
   * Wie diese Figur für alle anderen aussieht.
   *
   * Eine Stelle für drei Anlässe: Anmelden, Kartenwechsel und jede Änderung an
   * der Ausrüstung. Vorher stand sie dreimal da, und zweimal ohne Kleidung —
   * beim Erscheinen wurden nur Waffe und Name gesetzt. Wer sich anmeldete, sah
   * seine angelegte Rüstung deshalb erst, nachdem er sie einmal ab- und wieder
   * angelegt hatte: dann lief `applyLoadout`, und erst dort stand das Outfit.
   */
  private playerMeta(session: Session, name: string): EntityMeta {
    const profile = this.attackProfileOf(session);
    return {
      defId: 'player',
      name,
      type: EntityType.Player,
      weapon: profile.rig,
      weaponUpgrade: this.mainhandEntry(session)?.upgrade ?? 0,
      outfit: encodeOutfit(this.outfitOf(session)),
      setGlow: setGlowLevel(this.activeSetOf(session)),
    };
  }

  private outfitOf(session: Session): Outfit {
    const outfit: Outfit = {};
    for (const entry of session.items) {
      if (!entry.equipped) continue;
      const def = getItem(entry.itemId);
      if (!def || !isVisibleSlot(def.slot)) continue;
      outfit[def.slot] = styleOf(def);
    }
    return outfit;
  }

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
      stats.moveSpeed,
    );
    instance.world.setAttackProfile(
      session.entityId,
      profile.style,
      profile.range,
      profile.cooldownSec,
      profile.windupSec,
    );
    instance.world.setCritProfile(session.entityId, stats.critChance, stats.critMultiplier);

    const meta = instance.metaFor(session.entityId);
    if (meta) Object.assign(meta, this.playerMeta(session, meta.name));

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
          upgrade: i.upgrade,
        })),
      ),
    );
  }

  /**
   * Eine Fertigkeit wirken.
   *
   * Der Server entscheidet **alles**: ob die Figur den Beruf hat, ob die Stufe
   * reicht, ob die Abklingzeit abgelaufen ist, ob das Mana reicht. Der Client
   * zeigt dieselben Regeln an — aber als Vorschau. Was tatsächlich gilt, steht
   * hier, und wer eine Fertigkeit ohne Leiste schickt, kommt genauso wenig
   * durch wie jemand, der zu früh drückt.
   *
   * Die Wirkung selbst macht der Kern (`areaAttack`): Schaden, Tod, Beute und
   * Erfahrung laufen damit über denselben Weg wie ein gewöhnlicher Treffer.
   * Eine zweite Schadensrechnung neben der des Kerns wäre die Sorte Fehler,
   * die man erst beim Ausbalancieren bemerkt.
   */
  private useSkill(session: Session, skillId: string): void {
    const character = session.character;
    const instance = this.instances.get(session.mapId);
    const row = instance?.entity(session.entityId);
    if (!character || !instance || !row) return;
    if (row.state === EntityState.Dead) return;

    const def = getSkill(skillId);
    if (!def || !canUseSkill(character.beruf, character.level, skillId)) {
      this.systemMessage(session, 'Diese Fertigkeit beherrschst du nicht.');
      return;
    }

    const jetzt = Date.now();
    const frei = session.skillReady.get(skillId) ?? 0;
    if (jetzt < frei) {
      // Auf ein Zehntel gerundet: „noch 2,4 Sekunden" ist eine Auskunft,
      // „noch 2437 Millisekunden" ist eine Zahl.
      const rest = ((frei - jetzt) / 1000).toFixed(1);
      this.systemMessage(session, `${def.name} ist noch nicht bereit (${rest} s).`);
      return;
    }

    if (character.mp < def.manaCost) {
      this.systemMessage(session, `Zu wenig Mana für ${def.name}.`);
      return;
    }

    character.mp -= def.manaCost;
    session.skillReady.set(skillId, jetzt + def.cooldownMs);

    if (def.art === 'flaeche') {
      instance.world.areaAttack(session.entityId, def.radius, def.damageFactor);
    }

    // Das Bild geht an alle in der Nähe — auch an den Wirkenden selbst. Der
    // Client spielt es nicht von sich aus: eine Fertigkeit, die im eigenen
    // Bild anders aussieht als im fremden, ist zwei Fertigkeiten.
    this.broadcastNear(instance, row.x, row.z, encodeSkillCast(session.entityId, skillId));

    // Die Werte haben sich geändert (Mana), und die Treffer sind gefallen —
    // beides gehört in denselben Tick hinaus.
    this.sendStats(session);
    session.flush();
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
    if (dx * dx + dz * dz > interactRange() * interactRange()) {
      this.systemMessage(session, 'Zu weit weg.');
      return;
    }

    if (!getNpc(meta.defId)) return;

    // Ansprechen ist selbst ein Auftragsziel — die halbe Wegbeschreibung im
    // Spiel besteht daraus, jemanden aufzusuchen.
    if (session.quests.onTalk(meta.defId)) {
      session.questsDirty = true;
      this.sendQuestLog(session);
    }

    this.sendDialog(session, entityId, meta.defId);
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

    // Wer gerade angesprochen ist. Nach der Handlung geht das Gespräch mit
    // neuem Inhalt an denselben NPC zurück.
    let gespraechspartner: number | undefined;
    let gespraechsDef = '';

    switch (action) {
      case QuestAction.Annehmen: {
        gespraechspartner = this.nearNpcId(session, def.giver);
        gespraechsDef = def.giver;
        if (gespraechspartner === undefined) return;
        if (!session.quests.accept(def, character.level, session.items)) {
          this.systemMessage(session, `„${def.name}" ist gerade nicht verfügbar.`);
          return;
        }
        this.systemMessage(session, `Auftrag angenommen: ${def.name}.`);
        break;
      }

      case QuestAction.Abgeben: {
        gespraechsDef = turnInOf(def);
        gespraechspartner = this.nearNpcId(session, gespraechsDef);
        if (gespraechspartner === undefined) return;
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

        // Der Beruf, falls dieser Auftrag einer lehrt.
        //
        // Nur, wenn die Figur noch keinen hat: umlernen ist eine eigene
        // Entscheidung mit eigenem Preis, und sie stillschweigend in eine
        // Auftragsabgabe zu legen hiesse, jemandem seine Fertigkeiten zu
        // nehmen, weil er einen Text weggeklickt hat.
        const lehrt = def.reward.beruf;
        if (lehrt !== undefined && getClass(lehrt) && character.beruf === KEIN_BERUF) {
          character.beruf = lehrt;
          this.systemMessage(session, `Du bist jetzt ${getClass(lehrt)!.name}.`);
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
        // Aufgegeben wird meist aus dem Questlog heraus, also irgendwo auf der
        // Karte. Steht man zufällig beim Auftraggeber, wird das Gespräch
        // trotzdem erneuert.
        gespraechsDef = def.giver;
        gespraechspartner = this.nearNpcId(session, gespraechsDef);
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
    // Und zum Schluss das Gespräch selbst. Ohne das steht im offenen Fenster
    // weiter der Knopf, den man gerade gedrückt hat — es sah aus, als sei
    // nichts passiert, und erst Schliessen und neu Ansprechen zeigte den
    // neuen Stand.
    if (gespraechspartner !== undefined) {
      this.sendDialog(session, gespraechspartner, gespraechsDef);
    }
    session.flush();
  }

  /** Kaufen und verkaufen. `mode` ist 0 für kaufen, 1 für verkaufen. */
  private shopTrade(
    session: Session,
    mode: number,
    itemId: string,
    count: number,
    slot: number,
  ): void {
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
      const angebot = npc.shop?.find((o) => o.item === itemId);
      if (!angebot) return;

      // Der Posten bestimmt Preis und Aufwertung, nicht der Grundwert allein:
      // Bregan führt ein Holzschwert +10 für ein Goldstück.
      const stueckpreis = angebot.price ?? def.value;
      const preis = stueckpreis * menge;
      if (character.gold < preis) {
        this.systemMessage(session, `Dafür fehlen ${preis - character.gold} Gold.`);
        return;
      }

      const angekommen = addItem(session.items, itemId, menge, angebot.upgrade ?? 0);
      if (angekommen === 0) {
        this.systemMessage(session, 'Der Beutel ist voll.');
        return;
      }
      character.gold -= stueckpreis * angekommen;
      this.systemMessage(
        session,
        `${upgradeName(def, angebot.upgrade ?? 0)} ×${angekommen} gekauft.`,
      );
    } else {
      // Verkauft wird ein Platz, keine Sorte: sonst wandert die +7 über den
      // Tresen, weil sie dieselbe Kennung trägt wie die +0 daneben.
      const genommen = removeSlot(session.items, slot, menge);
      if (!genommen || genommen.itemId !== itemId) {
        this.systemMessage(session, 'So viel ist nicht da.');
        return;
      }
      // Der Zuschlag für Aufgewertetes steckt in `sellPrice` — dieselbe
      // Funktion, aus der die Oberfläche ihren Preis nimmt.
      const erloes = sellPrice(def, genommen.upgrade) * menge;
      character.gold += erloes;
      this.systemMessage(
        session,
        `${upgradeName(def, genommen.upgrade)} ×${menge} verkauft (+${erloes} Gold).`,
      );
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

  /**
   * Der NPC dieser Art in Reichweite — als Kennung, nicht als Ja/Nein.
   *
   * Die Kennung wird gebraucht, um das Gespräch nach einer Handlung neu zu
   * schicken: der Auftrag, den man eben angenommen hat, steht sonst weiter als
   * „annehmen" im offenen Fenster.
   */
  private nearNpcId(session: Session, npcDefId: string): number | undefined {
    const instance = this.instances.get(session.mapId);
    const self = instance?.entity(session.entityId);
    if (!instance || !self) return undefined;

    for (const row of instance.entities) {
      const meta = instance.metaFor(row.id);
      if (!meta || meta.type !== EntityType.Npc || meta.defId !== npcDefId) continue;
      const dx = row.x - self.x;
      const dz = row.z - self.z;
      if (dx * dx + dz * dz <= interactRange() * interactRange()) return row.id;
    }
    return undefined;
  }

  /**
   * Schickt den Gesprächsstand eines NPCs erneut.
   *
   * Nach jeder Handlung, die etwas daran ändert. Der Client zeigt daraufhin
   * dasselbe Fenster mit neuem Inhalt — angenommen statt annehmbar, der
   * Folgeauftrag statt des abgegebenen.
   */
  private sendDialog(session: Session, entityId: number, npcDefId: string): void {
    const def = getNpc(npcDefId);
    if (!def) return;
    session.send(
      encodeNpcDialog({
        entityId,
        npcDefId,
        shop: (def.shop?.length ?? 0) > 0,
        quests: session.quests.dialogFor(npcDefId, session.character?.level ?? 1),
      }),
    );
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
      if (dx * dx + dz * dz <= interactRange() * interactRange()) return def;
    }
    return undefined;
  }

  private sendQuestLog(session: Session): void {
    session.send(encodeQuestLog(session.quests.rows()));
  }

  /**
   * Beute.
   *
   * Fällt zu Boden, statt in den Beutel zu springen. Das ist die teurere
   * Variante — eine zweite Liste, ein weiteres Paket, ein Ziel zum Antippen —,
   * aber die richtige: ein erlegtes Monster, das wortlos eine Zeile im Beutel
   * erzeugt, sieht nach nichts aus. Gold liegt aus demselben Grund mit da und
   * wird nicht still gutgeschrieben.
   */
  private dropLoot(
    session: Session,
    instance: MapInstance,
    mobId: string,
    x: number,
    y: number,
    z: number,
    gold: number,
  ): void {
    const mob = MOBS.get(mobId);

    // Erst sammeln, dann ablegen: `drop` streut die Haufen auf einem Kreis
    // und muss dafür wissen, wie viele es insgesamt werden.
    const haufen: Array<{ item: string; count: number; gold: number }> = [];
    if (gold > 0) haufen.push({ item: '', count: 0, gold });

    for (const drop of mob?.drops ?? []) {
      if (Math.random() > drop.chance) continue;
      const min = drop.min ?? 1;
      const max = drop.max ?? min;
      haufen.push({
        item: drop.item,
        count: min + Math.floor(Math.random() * (max - min + 1)),
        gold: 0,
      });
    }
    if (haufen.length === 0) return;

    haufen.forEach((h, i) => {
      instance.loot.drop(
        { x, y, z, item: h.item, count: h.count, upgrade: 0, gold: h.gold, owner: session.entityId },
        i,
        haufen.length,
      );
    });
  }

  /**
   * Einen Haufen aufheben.
   *
   * Der Client schickt nur die Kennung. Ob der Haufen noch da ist, ob der
   * Spieler nah genug steht und ob die Beute noch für den Erleger reserviert
   * ist, entscheidet ausschließlich der Server — sonst hebt ein geänderter
   * Client die halbe Karte von der Stelle aus auf.
   */
  private pickupLoot(session: Session, lootId: number): void {
    const instance = this.instances.get(session.mapId);
    const self = instance?.entity(session.entityId);
    if (!instance || !self) return;

    const ergebnis = instance.loot.check(lootId, session.entityId, self.x, self.z);
    if (!ergebnis.ok) {
      // „weg" ist der Normalfall bei einem Doppelklick oder wenn ein anderer
      // schneller war — dazu jedes Mal eine Meldung wäre nur Lärm.
      if (ergebnis.reason === 'zu weit') this.systemMessage(session, 'Das liegt zu weit weg.');
      if (ergebnis.reason === 'fremd') this.systemMessage(session, 'Das gehört noch jemand anderem.');
      return;
    }

    const pile = ergebnis.pile;
    const character = session.character;
    if (!character) return;

    // Gebückt hat sie sich in jedem Fall — auch wenn gleich der Beutel voll
    // ist. Die Geste gehört zur Handlung, nicht zum Ergebnis.
    this.broadcastNear(instance, self.x, self.z, encodeEmote(session.entityId, EmoteKind.Pickup));

    if (pile.gold > 0) {
      character.gold += pile.gold;
      instance.loot.take(pile.id);
      this.systemMessage(session, `Aufgehoben: ${pile.gold} Gold.`);
      this.sendStats(session);
      return;
    }

    const angekommen = addItem(session.items, pile.item, pile.count, pile.upgrade);
    if (angekommen <= 0) {
      this.systemMessage(session, 'Dein Beutel ist voll.');
      return;
    }

    // Nur was hereinpasste, verschwindet vom Boden. Ein halb aufgehobener
    // Haufen behält den Rest — sonst frisst ein voller Beutel die Beute.
    if (angekommen < pile.count) {
      pile.count -= angekommen;
    } else {
      instance.loot.take(pile.id);
    }

    const def = getItem(pile.item);
    this.systemMessage(
      session,
      `Aufgehoben: ${def?.name ?? pile.item}${angekommen > 1 ? ` ×${angekommen}` : ''}.`,
    );

    session.itemsDirty = true;
    if (session.quests.syncCollect(session.items)) {
      session.questsDirty = true;
      this.sendQuestLog(session);
    }
    this.sendInventory(session);
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
      stats.moveSpeed,
    );
    this.systemMessage(session, `Stufe ${character.level} erreicht.`);
  }

  // -------------------------------------------------------------------------
  // Kleinkram
  // -------------------------------------------------------------------------

  private onChat(session: Session, channel: number, text: string): void {
    const trimmed = text.trim().slice(0, 200);
    if (trimmed.length === 0) return;

    // Ein Schrägstrich ist ein Befehl und keine Nachricht. Auch der abgelehnte
    // — sonst stünde „/gg 5000" im Chat der ganzen Wiese.
    if (runCommand(this, session, trimmed)) return;

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

  /**
   * Schreibt Gold gut — für Befehle, die das dürfen.
   *
   * Über dieselbe Stelle wie jeder andere Goldzugang: der Wert steht am
   * Charakter, die Anzeige kommt aus `sendStats`. Ein Befehl, der die Zahl
   * selbst setzte und die Anzeige selbst schickte, wäre der zweite Weg zu
   * derselben Sache.
   */
  giveGold(session: Session, amount: number): void {
    const character = session.character;
    if (!character) return;
    character.gold += amount;
    this.sendStats(session);
  }

  systemMessage(session: Session, text: string): void {
    session.send(encodeServerChat({ channel: ChatChannel.System, from: '', text }));
  }

  /** Grundwerte der Stufe plus Boni der angelegten Ausrüstung. */
  /** Der angelegte Hauptwaffen-Eintrag mitsamt Aufwertung, oder nichts. */
  private mainhandEntry(session: Session): (typeof session.items)[number] | undefined {
    for (const entry of session.items) {
      if (!entry.equipped) continue;
      if (getItem(entry.itemId)?.slot === 'mainhand') return entry;
    }
    return undefined;
  }

  /** Die angelegte Hauptwaffe, oder nichts. */
  private mainhandOf(session: Session): ItemDef | undefined {
    const entry = this.mainhandEntry(session);
    return entry ? getItem(entry.itemId) : undefined;
  }

  /** Angriffsprofil aus der angelegten Waffe. Eine Stelle, drei Nutzer. */
  private attackProfileOf(session: Session): ReturnType<typeof attackProfileFor> {
    return attackProfileFor(this.mainhandOf(session));
  }

  /**
   * Die vollständige Attributtafel einer Figur.
   *
   * **Die** Rechnung — es gibt keine zweite. Was hier herauskommt, geht in die
   * Simulation *und* ins Charakterfenster; eine Anzeige, die ihre Zahlen
   * anderswo herholt, zeigt früher oder später etwas anderes an, als gilt.
   *
   * Jeder Beitrag nennt seine Quelle. Zum Ausbalancieren ist die Summe allein
   * wertlos: die Frage ist immer, welches Stück sie treibt.
   */
  private sheetFor(session: Session): AttributeSheet {
    const level = session.character?.level ?? 1;
    const basis = baseStatsForLevel(level);
    const sheet = new AttributeSheet();

    sheet.basis('maxHp', basis.maxHp);
    sheet.basis('maxMp', basis.maxMp);
    sheet.basis('attackDamage', basis.attackDamage);
    sheet.basis('defense', basis.defense);
    sheet.basis('moveSpeed', basis.moveSpeed);
    sheet.basis('critChance', basis.critChance);
    sheet.basis('critMultiplier', basis.critMultiplier);

    for (const entry of session.items) {
      if (!entry.equipped) continue;
      const def = getItem(entry.itemId);
      if (!def) continue;

      // Die Aufwertung gehört zum Stück und steht deshalb in derselben Zeile:
      // „Eisenklinge +7" ist ein Gegenstand, nicht zwei.
      const bonus = upgradeBonus(def, entry.upgrade);
      const name = upgradeName(def, entry.upgrade);
      sheet.fuege('attackDamage', name, def.attackDamage + bonus.attackDamage);
      sheet.fuege('defense', name, def.defense + bonus.defense);
      sheet.fuege('maxHp', name, def.maxHp);
      sheet.fuege('maxMp', name, def.maxMp);
      sheet.fuege('critChance', name, def.critChance);
    }

    // Und ganz zum Schluss der Satz. Er wird auf die Summe der Teile addiert
    // und nicht in sie hinein: der Satzbonus ist die Belohnung dafür, dass
    // alle Teile zusammen getragen werden, kein geteiltes Extra je Stück.
    const satz = this.activeSetOf(session);
    if (satz) {
      const b = satz.set.bonus;
      sheet.fuege('attackDamage', satz.set.name, b.attackDamage);
      sheet.fuege('defense', satz.set.name, b.defense);
      sheet.fuege('maxHp', satz.set.name, b.maxHp);
      sheet.fuege('maxMp', satz.set.name, b.maxMp);
      sheet.fuege('critChance', satz.set.name, b.critChance);
    }

    // Reichweite und Schlagpause kommen von der Waffe, und zwar ersetzend:
    // ein Schwert *hat* seine Reichweite, es addiert sie nicht. Als Beitrag
    // steht deshalb der Unterschied zur blossen Faust — die Summe ist damit
    // genau der Wert der Waffe, und die Zeile sagt trotzdem, woher er kommt.
    const faust = attackProfileFor(undefined);
    const profil = this.attackProfileOf(session);
    const waffe = this.mainhandOf(session);
    sheet.basis('attackRange', faust.range);
    sheet.basis('attackCooldown', faust.cooldownSec);
    if (waffe) {
      sheet.fuege('attackRange', waffe.name, profil.range - faust.range);
      sheet.fuege('attackCooldown', waffe.name, profil.cooldownSec - faust.cooldownSec);
    }

    return sheet;
  }

  /** Was die Simulation braucht — aus derselben Tafel wie die Anzeige. */
  private statsFor(session: Session): ReturnType<typeof baseStatsForLevel> {
    const sheet = this.sheetFor(session);
    return {
      maxHp: sheet.wert('maxHp'),
      maxMp: sheet.wert('maxMp'),
      attackDamage: sheet.wert('attackDamage'),
      defense: sheet.wert('defense'),
      moveSpeed: sheet.wert('moveSpeed'),
      critChance: sheet.wert('critChance'),
      critMultiplier: sheet.wert('critMultiplier'),
    };
  }

  /** Die angelegten Stücke, so wie die Satzrechnung sie sehen will. */
  private wornPieces(session: Session): WornPiece[] {
    return session.items
      .filter((e) => e.equipped)
      .map((e) => ({ itemId: e.itemId, upgrade: e.upgrade }));
  }

  /** Welcher Rüstungssatz ist vollständig angelegt? Höchstens einer. */
  private activeSetOf(session: Session): ReturnType<typeof activeArmorSet> {
    return activeArmorSet(this.wornPieces(session));
  }

  private sendStats(session: Session): void {
    const character = session.character;
    if (!character) return;
    const instance = this.instances.get(session.mapId);
    const row = instance?.entity(session.entityId);
    // Eine Tafel, zwei Nutzer: die Balken oben und die Liste im
    // Charakterfenster. Zweimal rechnen hiesse, zwei Zahlen für dieselbe
    // Sache zu schicken.
    const sheet = this.sheetFor(session);

    session.send(
      encodeStats({
        beruf: character.beruf,
        level: character.level,
        exp: character.exp,
        expForNext: expForLevel(character.level),
        hp: row?.hp ?? character.hp,
        maxHp: row?.maxHp ?? sheet.wert('maxHp'),
        mp: character.mp,
        maxMp: sheet.wert('maxMp'),
        gold: character.gold,
        attributes: sheet.alle(),
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
    await this.welt.saveCharacter(character);

    // Beutel und Aufträge nur, wenn sich etwas getan hat: beide werden
    // ersetzend geschrieben, und das ist deutlich teurer als eine Zeile mit
    // der neuen Position.
    if (session.itemsDirty) {
      await this.welt.saveInventory(character.id, session.items);
      session.itemsDirty = false;
    }
    if (session.questsDirty) {
      await this.welt.saveQuests(character.id, session.quests.records());
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
