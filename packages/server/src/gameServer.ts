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
  AktionsArt,
  type PetArt,
  skillsFor,
  decodeSetActionSlot,
  decodeSetzePunkt,
  encodeActionBar,
  leereLeiste,
  normalisiereLeiste,
  AccessLevel,
  ByteReader,
  canUseSkill,
  ChatChannel,
  EntityState,
  EntityType,
  FrameError,
  CHAT_RADIUS,
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
  encodeVorgang,
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
  eigenschaftsWirkung,
  istEigenschaft,
  offenePunkte,
  isValidName,
} from '@aurelith/shared';
import { CoreEventType, CoreButton } from '@aurelith/core';
import { hashPassword, verifyPassword } from './passwords.ts';
import { runCommand } from './commands.ts';
import { anmelden } from './accounts.ts';
import type { LoginClient, StufenAuskunft } from './loginClient.ts';
import { config } from './config.ts';
import {
  protokolliereOpcodeFehler,
  protokolliereRahmenfehler,
  type RahmenQuelle,
} from './framelog.ts';
import type { CoreBundle } from './core.ts';
import type { MapStore } from './maps.ts';
import { MapInstance, type EntityMeta } from './mapInstance.ts';
import type { LootPile } from './loot.ts';
import {
  FOLGE_ABSTAND,
  FOLGE_ANKUNFT,
  folgePunkt,
  HAENGT_ABSTAND,
  HAENGT_MS,
  SAMMEL_ABSTAND,
  zielNochErlaubt,
  type PetLauf,
} from './pets.ts';
import { INPUT_QUEUE_DRAIN_AT, INPUT_QUEUE_DRAIN_MAX, Session } from './session.ts';
import {
  addItem,
  freeBagSlots,
  inventorySlots,
  normalizeSlots,
  removeItem,
  removeSlot,
  zaehleMunition,
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

/**
 * Abstand zwischen zwei Lebenszeichen für die Eintrittskarten.
 *
 * Deutlich kürzer als die halbe Stunde, die eine Karte gilt — aber nicht
 * knapp: ein ausgefallenes Lebenszeichen darf niemanden aussperren, und
 * neunundzwanzig weitere folgen, bevor die Frist überhaupt in Reichweite
 * kommt.
 */
const KARTEN_FRISCH_MS = 60_000;

/**
 * Wie lange das Aufsteigen auf ein Fluggerät dauert.
 *
 * Vier Sekunden. Lang genug, dass es eine Entscheidung ist und keine Taste —
 * wer vor einem Monster steht, kommt damit nicht mehr einfach weg. Kurz genug,
 * dass es beim Reisen nicht stört.
 */
const AUFSTIEG_MS = 4000;

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
  /** Hält die Eintrittskarten am Leben — siehe `haltekarten`. */
  private kartenTimer?: NodeJS.Timeout;
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

    /*
     * Die Eintrittskarten der laufenden Sitzungen am Leben halten.
     *
     * Die Karte gilt eine halbe Stunde ab ihrem letzten Lebenszeichen. Solange
     * jemand spielt, kommt es von hier; hört es auf, läuft die Frist ab dem
     * Abriss — und genau in dieser Zeit kann er sich wieder verbinden, ohne
     * sein Passwort zu tippen.
     *
     * Jede Minute und nicht je Tick: es geht um eine halbe Stunde Frist, und
     * eine HTTP-Anfrage je Spieler und Sekunde wäre ein Sturm für nichts.
     */
    this.kartenTimer = setInterval(() => this.haltekarten(), KARTEN_FRISCH_MS);
    this.kartenTimer.unref?.();
  }

  /**
   * Beendet einen laufenden Vorgang, ohne ihn auszuführen.
   *
   * Eine Stelle für alle Anlässe — Tod, Kartenwechsel, Abmelden —, weil sonst
   * einer davon den Balken beim Spieler stehenliesse. Und die Null geht auch
   * dann hinaus, wenn gar nichts lief: das kostet ein Paket und spart die
   * Frage, ob Client und Server sich über den Balken einig sind.
   */
  private brichVorgangAb(session: Session): void {
    if (!session.vorgang) return;
    session.vorgang = undefined;
    session.send(encodeVorgang('', 0));
  }

  /** Ein Lebenszeichen je Karte. Siehe `start`. */
  private haltekarten(): void {
    for (const session of this.sessions) {
      if (session.ticket !== '') void this.login.frischeKarte(session.ticket);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.kartenTimer) clearInterval(this.kartenTimer);
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
      // Erst die Begleiter aus der Welt, dann speichern: das Merkmal am
      // Gegenstand bleibt dabei stehen, damit sie beim nächsten Anmelden
      // wieder danebenstehen.
      this.raeumeHaustiere(session);
      await this.persist(session).catch((err) =>
        console.error('[db] Speichern beim Trennen fehlgeschlagen:', err),
      );
      this.instances.get(session.mapId)?.removePlayer(session.entityId);
      this.sessionByEntity.delete(session.entityId);
    }
    // Das Konto ist wieder frei — auf allen Kanälen. Ohne diese Meldung
    // bliebe es beim Anmeldeserver hängen, bis dieser Kanal verfällt.
    void this.login.meldeAnwesenheit(session.accountId, false);
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
        case ClientOp.SetActionSlot: {
          if (session.state !== 'playing') break;
          const { index, art, id } = decodeSetActionSlot(reader);
          this.setzeAktionsplatz(session, index, art, id);
          break;
        }
        case ClientOp.SetzePunkt: {
          if (session.state !== 'playing') break;
          const { eigenschaft, anzahl } = decodeSetzePunkt(reader);
          this.setzePunkt(session, eigenschaft, anzahl);
          break;
        }
        case ClientOp.Logout:
          // Aus jedem Zustand ausser dem Handschlag: wer in der Verwaltung
          // sitzt, darf sich genauso abmelden wie jemand mitten in der Welt.
          if (session.state !== 'handshake') void this.onLogout(session);
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
      config.zugriff,
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

    // Aufgehoben, damit die Frist offen bleibt, solange diese Verbindung
    // steht — siehe `haltekarten`.
    session.ticket = ticket;

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
    void this.login.meldeAnwesenheit(accountId, true);
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
    /*
     * Der Client fängt mit einer leeren Welt an — also auch die Buchführung
     * darüber, was er schon kennt.
     *
     * `known` entscheidet, ob ein Wesen als Spawn geschickt wird oder nur als
     * Aktualisierung. Blieb der Stand von vorhin stehen, hielt der Server
     * jedes Monster für bekannt und schickte bloss noch Positionen — zu
     * Wesen, die der Client eben weggeworfen hatte. Man stand dann in einer
     * leeren Welt: keine Monster, keine NPCs, nichts zum Anklicken.
     *
     * Hier und nicht beim Verlassen, weil hier das `Welcome` rausgeht: das
     * ist die Nachricht, auf die hin der Client abräumt. Wer einen neuen Weg
     * in die Welt baut, kommt an dieser Stelle vorbei.
     */
    session.known.clear();
    session.inputQueue.length = 0;

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
      attackCooldownSec: stats.attackCooldown,
      attackWindupSec: profile.windupSec,
      hpRegen: stats.hpRegen,
      mpRegen: stats.mpRegen,
      attackStyle: profile.style,
      radius: playerProfile().radius,
      height: playerProfile().height,
    });
    // Wer sich auf dem Besen abgemeldet hat, sitzt beim Anmelden wieder darauf
    // — in der Welt und nicht nur im Bild. Siehe `setzeFlugzustand`.
    this.setzeFlugzustand(session);
    instance.meta.set(session.entityId, this.playerMeta(session));
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
    session.aktionen = normalisiereLeiste(geladen.aktionen);
    this.sendStats(session);
    this.sendInventory(session);
    this.sendQuestLog(session);
    this.sendAktionen(session);
    // Wer sich mit einem laufenden Begleiter abgemeldet hat, findet ihn wieder
    // neben sich. Das Merkmal steht am Gegenstand und damit im Spielstand.
    this.stelleHaustiereHer(session);
    this.systemMessage(session, `Willkommen in ${instance.doc.name}, ${geladen.character.name}.`);
    session.flush();

    console.log(
      `[sitzung] ${session.accountName}/${geladen.character.name} betritt ${instance.doc.id} ` +
        `(Entity ${session.entityId})`,
    );
  }

  /**
   * Abmelden — aus der Welt **und** aus dem Kanal.
   *
   * Die Reihenfolge ist der Inhalt dieser Methode: speichern, die Figur aus
   * der Welt nehmen, das Konto beim Anmeldeserver freigeben — und erst danach
   * auflegen. Der Client wartet auf das Auflegen und geht dann zum
   * Anmeldeserver.
   *
   * Legte er stattdessen selbst auf, liefe er dem Freigeben davon: das geht
   * als HTTP-Ruf an den Anmeldeserver, und der Client wäre mit seiner neuen
   * Anmeldung schneller dort als diese Nachricht. Er stünde dann vor „dieses
   * Konto spielt gerade auf Kanal 1" — auf dem Kanal, den er eben verlassen
   * hat.
   *
   * Zurück in die Verwaltung führt dieser Weg nicht mehr. Die Eintrittskarte,
   * mit der man hereinkam, gilt einmal; wer in der Verwaltung sitzt, hat keine
   * mehr und kommt von dort nirgends hin. Also ganz heraus und neu anmelden —
   * das ist ehrlicher als eine Maske, aus der es keinen Ausgang gibt.
   */
  private async onLogout(session: Session): Promise<void> {
    if (session.entityId !== 0) {
      // Vor dem Speichern, wie beim Trennen: das Merkmal am Gegenstand bleibt
      // dabei stehen und wird gleich mitgeschrieben.
      this.raeumeHaustiere(session);
      await this.persist(session).catch((err) =>
        console.error('[db] Speichern beim Abmelden fehlgeschlagen:', err),
      );

      this.instances.get(session.mapId)?.removePlayer(session.entityId);
      this.sessionByEntity.delete(session.entityId);
      // Die anderen sollen die Figur nicht als bekannt führen — sie ist weg.
      for (const other of this.sessions) other.known.delete(session.entityId);
    }

    session.entityId = 0;
    session.mapId = '';
    session.character = undefined;
    // Ein laufender Aufstieg gehört zur Figur in der Welt, nicht zum Konto.
    this.brichVorgangAb(session);
    session.items = [];
    session.quests.load([]);
    session.aktionen = leereLeiste();
    session.itemsDirty = false;
    session.questsDirty = false;
    session.aktionenDirty = false;

    // Abgewartet, nicht nur abgeschickt. Genau dafür gibt es dieses Paket.
    await this.login.meldeAnwesenheit(session.accountId, false);

    /*
     * Und die Karte weg — hier und **nicht** beim Trennen.
     *
     * Das ist der ganze Unterschied zwischen „ich gehe" und „die Leitung ist
     * weg": wer sich abmeldet, soll kein Papier zurücklassen, mit dem eine
     * halbe Stunde lang jemand in seine Figur käme. Wem der Zug in den Tunnel
     * fährt, dem bleibt genau das.
     */
    await this.login.verwirfKarte(session.ticket);
    session.ticket = '';

    console.log(`[sitzung] ${session.accountName} meldet sich ab`);
    session.close(1000, 'abgemeldet');
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

      /*
       * Ein Bogen ohne Pfeile schiesst nicht.
       *
       * Entschieden wird hier und nicht im Kern: der Kern kennt keinen Beutel,
       * und die Vorhersage im Client rechnet mit demselben Kern. Genommen wird
       * die Angriffstaste, nicht der Schlag — wer keine Pfeile hat, bindet
       * sich auch nicht in einen Vorlauf, der ins Leere läuft.
       */
      const munitionFehlt = this.brauchtMunition(session) && zaehleMunition(session.items) <= 0;
      if (munitionFehlt) this.meldeLeerenKoecher(session);

      for (let i = 0; i < budget && session.inputQueue.length > 0; i++) {
        const input = session.inputQueue.shift()!;

        /*
         * Wer losläuft, steigt nicht auf.
         *
         * Vier Sekunden stillstehen ist der Preis fürs Fliegen; wer in dieser
         * Zeit weitergeht, hat es sich anders überlegt. Vorher lief der Balken
         * beim Laufen durch, und die Figur hob mitten im Schritt ab — ein
         * Aufsteigen, das niemand mehr gewollt hatte, und auf dem Telefon der
         * halbe Weg zum versehentlichen Flug.
         *
         * Ein Zehntel Ausschlag als Schwelle, nicht null: der Steuerknüppel
         * gibt analoge Werte ab, und eine ruhende Daumenkuppe darauf schickt
         * kleine Zahlen statt gar keiner. Bei null bräche jeder Zittrer ab.
         */
        if (session.vorgang && Math.hypot(input.moveX, input.moveZ) > 0.1) {
          // Die Absage nennt den Vorgang beim Namen. Heute gibt es nur einen;
          // die Zeile bleibt trotzdem richtig, wenn ein zweiter dazukommt.
          const art = session.vorgang.art;
          this.brichVorgangAb(session);
          this.systemMessage(session, `${art === 'aufsteigen' ? 'Aufsteigen' : art} abgebrochen — du bist losgelaufen.`);
        }

        instance.world.applyInput(
          session.entityId,
          input.moveX,
          input.moveZ,
          input.yaw,
          /*
           * Die Tasten gehen durch — bis auf eine.
           *
           * Hier stand lange nur der Angriff, und das war richtig, solange
           * alles andere eine Geste war: ein Sprung ändert nichts, was der
           * Server entscheiden müsste. Seit die Leertaste in der Luft den
           * Schub schaltet, ist das anders — und eine Taste, die nur im Client
           * ankam, liess die Figur dort losfliegen, während sie hier stehen
           * blieb. Sichtbar war das als eine Figur, die nicht vom Fleck kommt.
           *
           * Herausgenommen wird deshalb nur noch, was tatsächlich nicht geht:
           * ein Schuss ohne Pfeile.
           */
          munitionFehlt ? input.buttons & ~CoreButton.Attack : input.buttons,
          TICK_SECONDS,
        );
        session.lastInputSeq = input.seq;
      }
    }

    // Was ein Schuss kostet, wird abgezogen, sobald einer beginnt — siehe
    // `verbraucheMunition`. Vor dem Schritt, nicht danach: der Zustand
    // „schlägt gerade zu" entsteht beim Anwenden der Eingabe.
    for (const session of this.sessions) {
      if (session.state === 'playing') this.verbraucheMunition(session);
    }

    /*
     * Fällige Vorgänge — zurzeit nur das Aufsteigen.
     *
     * Im Tick und nicht über einen Zeitgeber je Sitzung: der Tick läuft
     * ohnehin, und hundert Zeitgeber, die einzeln in den Zustand einer
     * Sitzung greifen, sind hundert Gelegenheiten, das in der falschen
     * Reihenfolge zu tun.
     */
    const jetztMs = Date.now();
    for (const session of this.sessions) {
      const vorgang = session.vorgang;
      if (!vorgang || session.state !== 'playing' || vorgang.fertigUm > jetztMs) continue;
      session.vorgang = undefined;
      // Der Balken ist ohnehin durchgelaufen; die Null sagt es trotzdem —
      // sonst bliebe er stehen, wenn der Wechsel scheitert.
      session.send(encodeVorgang('', 0));
      this.equipItem(session, vorgang.slot, true);
    }

    for (const instance of this.instances.values()) {
      instance.world.step(TICK_SECONDS);
      instance.refresh();
      this.dispatchEvents(instance);
      // Nach dem Ablegen, nicht davor: sonst läge frische Beute einen Tick
      // lang da, ohne dass die Frist schon liefe.
      instance.loot.expire();
    }

    /*
     * Die Begleiter entscheiden **nach** `refresh`, wohin sie wollen.
     *
     * Erst dachte ich, davor sei richtig: dann wirkt das Ziel noch im selben
     * Schritt. Nur liest diese Stelle Positionen, und die kommen aus
     * `instance.entity` — also aus der Zeilenkopie, die `refresh` schreibt.
     * Davor ist sie einen Tick alt, und ein frisch erschienenes Tier steht
     * gar nicht darin. Es galt damit als verschwunden, wurde neu erschaffen,
     * und das erste stand für immer in der Landschaft.
     *
     * Der Preis ist ein Tick Rückstand auf ein Ziel, das fünfzig
     * Millisekunden alt ist — beim Hinterherlaufen unsichtbar.
     */
    for (const session of this.sessions) {
      if (session.state === 'playing') this.updateHaustiere(session, TICK_SECONDS * 1000);
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
            // Wer fällt, steigt nicht auf. Der Balken hört mit ihm auf.
            this.brichVorgangAb(victim);
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
          // Die Lage kommt aus dem Kern und nicht aus der Ausrüstung: der
          // Client zeichnet damit die Nase, und geschätzt hätte er sie nur,
          // solange sich etwas bewegt.
          neigung: row.pitch,
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
        flug: meta?.flug ?? '',
        setGlow: meta?.setGlow ?? 0,
        neigung: row.pitch,
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
    /**
     * Wie weit. Ohne Angabe so weit, wie man sieht — das passt für alles, was
     * man **sieht**: Treffer, Funken, Gesten. Für alles, was man **hört**,
     * gehört eine kürzere Zahl hin.
     */
    radius = INTEREST_RADIUS,
  ): void {
    const radiusSq = radius * radius;
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

    this.versetze(session, to, portal.target);
  }

  /**
   * Setzt eine Figur auf eine andere Karte — der eigentliche Wechsel.
   *
   * Getrennt vom Tor, weil es zwei Anlässe gibt: durchgehen und `/tp`. Was
   * dabei zu tun ist, ist beide Male dasselbe und alles andere als wenig —
   * Entity umziehen, Kennung tauschen, Eingaben verwerfen, Willkommen und
   * Kartenwechsel schicken. Zweimal geschrieben wäre es zweimal zu pflegen,
   * und die vergessene Hälfte wäre die, bei der jemand im Nichts steht.
   *
   * Die **Stufensperre** gehört nicht hierher, sondern ans Tor: sie ist eine
   * Eigenschaft des Weges und nicht des Wechsels. `/tp` steht Spielleitern zu
   * und fragt deshalb zu Recht nicht danach.
   */
  private versetze(
    session: Session,
    to: MapInstance,
    ziel: { x: number; z: number; yaw: number },
  ): void {
    const from = this.instances.get(session.mapId);
    const character = session.character;
    if (!from || !character) return;

    // Zustand aus der alten Welt retten, bevor das Entity dort verschwindet.
    const row = from.entity(session.entityId);
    const hp = row?.hp ?? character.hp;
    const stats = this.statsFor(session);
    const profile = this.attackProfileOf(session);

    // Die Begleiter bleiben nicht in der alten Karte stehen. Ihr Merkmal am
    // Gegenstand bleibt, und `stelleHaustiereHer` lässt sie drüben wieder
    // erscheinen — sonst käme man durch ein Tor und stünde allein da.
    // Ein Aufstieg gehört zu der Welt, in der er begonnen hat.
    this.brichVorgangAb(session);
    this.raeumeHaustiere(session);

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
      x: ziel.x,
      z: ziel.z,
      yaw: ziel.yaw,
      hp,
      maxHp: stats.maxHp,
      mp: character.mp,
      maxMp: stats.maxMp,
      attackDamage: stats.attackDamage,
      defense: stats.defense,
      moveSpeed: stats.moveSpeed,
      attackRange: profile.range,
      attackCooldownSec: stats.attackCooldown,
      attackWindupSec: profile.windupSec,
      hpRegen: stats.hpRegen,
      mpRegen: stats.mpRegen,
      attackStyle: profile.style,
      radius: playerProfile().radius,
      height: playerProfile().height,
    });
    // Dasselbe hinter dem Tor: die neue Welt kennt die Figur noch nicht, und
    // ein Fluggerät wechselt die Karte mit.
    this.setzeFlugzustand(session);
    to.meta.set(session.entityId, this.playerMeta(session));
    to.playerIds.add(session.entityId);
    this.sessionByEntity.set(session.entityId, session);

    character.mapId = to.doc.id;
    character.x = ziel.x;
    character.z = ziel.z;
    character.yaw = ziel.yaw;

    const spawnY = to.world.heightAt(ziel.x, ziel.z);
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
        x: ziel.x,
        y: spawnY,
        z: ziel.z,
        yaw: ziel.yaw,
      }),
    );
    this.systemMessage(session, `${to.doc.name} betreten.`);
    // Und die Begleiter wieder dazu. Nach dem Willkommen, damit der Client die
    // neue Welt schon kennt, wenn das Tier darin erscheint.
    this.stelleHaustiereHer(session);
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
  private equipItem(session: Session, slot: number, vorgangFertig = false): void {
    const entry = session.items.find((i) => i.slot === slot);
    if (!entry) return;

    const def = getItem(entry.itemId);
    if (!def || def.slot === 'none') return;

    /*
     * Aufsteigen dauert.
     *
     * Vier Sekunden, und in denen läuft beim Spieler ein Balken. Absteigen
     * dagegen geht sofort — wer herunter will, will herunter, und ein Balken
     * beim Verlassen eines Geräts wäre eine Wartezeit ohne Aussage.
     *
     * Der zweite Durchlauf (`vorgangFertig`) kommt aus dem Tick und ist der
     * eigentliche Wechsel. Ohne die Unterscheidung riefe sich diese Stelle
     * selbst und startete jedes Mal einen neuen Vorgang.
     */
    if (def.kind === 'flug' && !entry.equipped && !vorgangFertig) {
      if (session.vorgang) {
        this.systemMessage(session, 'Es läuft schon etwas.');
        return;
      }
      const level = session.character?.level ?? 1;
      if (level < def.levelReq) {
        this.systemMessage(session, `${def.name} braucht Stufe ${def.levelReq}.`);
        return;
      }
      session.vorgang = { art: 'aufsteigen', slot, fertigUm: Date.now() + AUFSTIEG_MS };
      session.send(encodeVorgang('aufsteigen', AUFSTIEG_MS));
      session.flush();
      return;
    }

    if (entry.equipped) {
      /*
       * Abgestiegen wird über Boden, der trägt.
       *
       * Die Insel endet in einer Klippe, und was dahinter liegt, ist Meer.
       * Beides trägt niemanden: unten steht man auf dem Meeresgrund, auf der
       * Klippe auf achtundsiebzig Grad — und in beiden Fällen ist das Gerät,
       * mit dem man wieder wegkäme, gerade in den Beutel gewandert. Das war
       * kein hypothetischer Fall: bis an den Rand fliegen zu dürfen ist genau
       * das, was die Sperrzonen weit draussen erlauben sollen.
       *
       * Die Prüfung steht **vor** jeder Änderung, damit die Absage nichts
       * kostet.
       */
      if (def.kind === 'flug') {
        const instance = this.instances.get(session.mapId);
        const row = instance?.entity(session.entityId);
        if (instance && row && !instance.traegtBoden(row.x, row.z)) {
          this.systemMessage(session, 'Hier unten ist kein Halt — flieg zurück über die Insel.');
          return;
        }
      }

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

    /*
     * Wer aufsteigt, nimmt seine Begleiter mit.
     *
     * Freilassen vom Gerät aus war schon abgesagt (`schalteHaustier`) — der
     * Fall hier ist der umgekehrte und war die Lücke: erst freilassen, dann
     * aufsteigen. Danach lief das Tier am Boden hinter einer Figur her, die
     * vierzig Meter darüber schwebt, kam nie an, und die Heimweg-Regel in
     * `pets.ts` zog es in Sichtweite der Leine wieder ein und liess es wieder
     * los. Einsammeln ist die einzige Antwort, die beide Enden zusammenbringt.
     *
     * Nach `entry.equipped = true`, damit `holeHaustierZurueck` seine
     * Meldungen und den Beutel auf dem schon fliegenden Stand schickt.
     */
    if (def.kind === 'flug') {
      for (const art of [...session.pets.keys()]) {
        const lauf = session.pets.get(art)!;
        const tier = getItem(lauf.itemId);
        this.holeHaustierZurueck(session, art, `${tier?.name ?? 'Dein Begleiter'} kommt mit.`);
      }
    }

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
    if (!def) return;

    /*
     * Etwas zum Anziehen „benutzen" heisst: anziehen.
     *
     * Auf der Aktionsleiste liegt ein Schwert genauso wie ein Trank, und ein
     * Druck darauf ist ein Druck. „Das lässt sich nicht benutzen" wäre formal
     * richtig und in der Sache unbrauchbar — man hat es ja gerade deshalb
     * dorthin gelegt. Ein zweiter Druck legt es wieder ab; das entscheidet
     * `equipItem`, und zwar an derselben Stelle wie beim Doppelklick im
     * Beutel.
     */
    if (def.slot !== 'none') {
      this.equipItem(session, slot);
      return;
    }

    // Ein Haustier „benutzen" heisst: laufen lassen — und beim zweiten Mal
    // wieder einsammeln. Dieselbe Überlegung wie beim Schwert eine Zeile
    // höher: ein Druck ist ein Druck, und was er bewirkt, entscheidet das
    // Stück und nicht ein zweiter Knopf daneben.
    if (def.pet) {
      this.schalteHaustier(session, entry);
      return;
    }

    if (def.kind !== 'consumable') {
      this.systemMessage(session, `${def.name} lässt sich nicht benutzen.`);
      return;
    }

    /*
     * Abklingzeit — hier und nicht nur im Client.
     *
     * Der Client rechnet dieselbe Zahl mit, damit der Knopf grau wird; was
     * gilt, steht aber hier. Sonst wäre die Wartezeit eine Bitte an den
     * Spieler, und ein Trank alle zwanzig Millisekunden machte jeden Kampf zu
     * einer Frage des Vorrats.
     *
     * Vor dem Heilen und vor dem Verbrauchen: eine Absage darf nichts kosten.
     */
    const jetzt = Date.now();
    const bereit = session.gegenstandBereit.get(def.id) ?? 0;
    if (bereit > jetzt) {
      this.systemMessage(
        session,
        `${def.name} ist noch nicht bereit (${((bereit - jetzt) / 1000).toFixed(1)} s).`,
      );
      return;
    }

    const angekommen = instance.world.heal(session.entityId, def.effectValue, 0);
    if (angekommen <= 0) {
      this.systemMessage(session, `${def.name} würde jetzt nichts bewirken.`);
      return;
    }

    // Erst jetzt, wo tatsächlich etwas passiert ist: ein Trank, der nichts
    // bewirkt hätte, ist oben schon abgewiesen worden und soll keine Wartezeit
    // auslösen.
    if (def.cooldownSec > 0) {
      session.gegenstandBereit.set(def.id, jetzt + def.cooldownSec * 1000);
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
   *
   * **Der Name kommt aus der Figur und nicht als Argument.** Er war einmal
   * eines, und an einer der vier Aufrufstellen — dem Kartenwechsel — stand
   * dort der **Konto**name. Solange Konten wie Figuren hiessen, fiel das
   * niemandem auf; seit ein Konto aus dem Google-Weg eine E-Mail-Adresse ist,
   * stand sie nach jedem Tor über dem Kopf. Ein Argument, das man an einer von
   * vier Stellen falsch füllen kann, ist genau eine Stelle zu viel.
   */
  private playerMeta(session: Session): EntityMeta {
    const profile = this.attackProfileOf(session);
    return {
      defId: 'player',
      name: session.character?.name ?? '',
      type: EntityType.Player,
      weapon: profile.rig,
      weaponUpgrade: this.mainhandEntry(session)?.upgrade ?? 0,
      outfit: encodeOutfit(this.outfitOf(session)),
      setGlow: setGlowLevel(this.activeSetOf(session)),
      // Leer heisst: am Boden. Steht in der vollen Zeile, und die schickt
      // `applyLoadout` nach jedem Ausrüstungswechsel ohnehin neu.
      flug: this.flugGeraetVon(session)?.flug?.model ?? '',
    };
  }

  /**
   * Das angelegte Fluggerät — oder nichts.
   *
   * Eine Frage, eine Antwort: daran hängen der Kern (fliegt diese Figur?), der
   * Snapshot (was sehen die anderen?) und die Werte. Drei Schleifen über den
   * Beutel wären drei Gelegenheiten, verschieden zu antworten.
   */
  private flugGeraetVon(session: Session): ItemDef | undefined {
    for (const entry of session.items) {
      if (!entry.equipped) continue;
      const def = getItem(entry.itemId);
      if (def?.flug) return def;
    }
    return undefined;
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

  /**
   * Überträgt das angelegte Fluggerät in die Welt.
   *
   * Eine Stelle, vier Anlässe: Ausrüstungswechsel, verteilte Punkte, Anmelden,
   * Kartenwechsel. Die letzten beiden fehlten, und der Fehler sah aus wie ein
   * Netzproblem: der Beutel meldete das Gerät, der Client schaltete auf
   * Fliegen, und der Server führte dieselbe Figur zu Fuss. Jeder Schnappschuss
   * riss sie zurück, bis man einmal ab- und wieder aufstieg — denn *das* lief
   * über `applyLoadout` und setzte den Zustand nach.
   *
   * Deshalb nicht „auch noch beim Anmelden" ergänzt, sondern eine Stelle
   * daraus gemacht: eine Figur erscheint an genau zwei Orten in einer Welt,
   * und beide gehen jetzt hier vorbei.
   */
  private setzeFlugzustand(session: Session): void {
    const instance = this.instances.get(session.mapId);
    if (!instance) return;
    const geraet = this.flugGeraetVon(session);
    instance.world.setFlying(
      session.entityId,
      geraet !== undefined,
      geraet?.flug?.speed ?? 0,
      geraet?.flug?.steig ?? 0,
      geraet?.flug?.maxHoehe ?? 0,
    );
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
      stats.hpRegen,
      stats.mpRegen,
    );
    instance.world.setAttackProfile(
      session.entityId,
      profile.style,
      profile.range,
      // Siehe `statsFor`: die Pause kommt aus der Tafel, weil Geschick sie
      // kürzt. Reichweite und Vorlauf gehören dagegen allein der Waffe.
      stats.attackCooldown,
      profile.windupSec,
    );
    instance.world.setCritProfile(session.entityId, stats.critChance, stats.critMultiplier);

    this.setzeFlugzustand(session);

    const meta = instance.metaFor(session.entityId);
    if (meta) Object.assign(meta, this.playerMeta(session));

    // Der Snapshot schickt eine volle Zeile nur für Unbekanntes. Damit die
    // neue Waffe bei allen ankommt, muss die Figur einmal als neu gelten.
    for (const other of this.sessions) other.known.delete(session.entityId);
  }

  /**
   * Bringt die Aktionsleiste mit der Wirklichkeit in Übereinstimmung.
   *
   * Zwei Richtungen, und beide sind nötig:
   *
   *   Herunter, was nicht mehr geht — ein Gegenstand, den man vernichtet,
   *   verkauft oder aufgebraucht hat, und eine Fertigkeit, die diese Figur
   *   nicht (mehr) kann. Ein Platz, der auf nichts zeigt, ist ein Knopf, der
   *   nichts tut, und davon hatten wir heute genug.
   *
   *   Hinauf, was neu dazukommt: eine frisch gelernte Fertigkeit legt sich auf
   *   den ersten freien Platz. Ohne das läge sie nirgends, und bis es einen
   *   Fertigkeitenbaum gibt, käme man gar nicht an sie heran.
   *
   * Gibt zurück, ob sich etwas geändert hat — der Aufrufer schickt die Leiste
   * dann neu. Ohne diese Antwort ginge sie bei jeder Bewegung im Beutel
   * unverändert über die Leitung.
   */
  private pflegeAktionen(session: Session): boolean {
    const beruf = session.character?.beruf ?? KEIN_BERUF;
    const level = session.character?.level ?? 1;
    let geaendert = false;

    for (const platz of session.aktionen) {
      if (platz.art === AktionsArt.Leer) continue;

      const bleibt =
        platz.art === AktionsArt.Gegenstand
          ? session.items.some((i) => i.itemId === platz.id)
          : canUseSkill(beruf, level, platz.id);
      if (bleibt) continue;

      platz.art = AktionsArt.Leer;
      platz.id = '';
      geaendert = true;
    }

    for (const koennen of skillsFor(beruf, level)) {
      if (session.aktionen.some((p) => p.art === AktionsArt.Fertigkeit && p.id === koennen.id)) {
        continue;
      }
      const frei = session.aktionen.find((p) => p.art === AktionsArt.Leer);
      // Volle Leiste: dann bleibt die Fertigkeit, wo sie ist — im Können der
      // Figur. Etwas zu verdrängen, das jemand dorthin gelegt hat, wäre das
      // schlechtere von beiden Übeln.
      if (!frei) break;
      frei.art = AktionsArt.Fertigkeit;
      frei.id = koennen.id;
      geaendert = true;
    }

    if (geaendert) session.aktionenDirty = true;
    return geaendert;
  }

  /**
   * Belegt einen Platz — oder räumt ihn.
   *
   * Geprüft wird beides: dass es die Kennung gibt und dass diese Figur damit
   * etwas anfangen kann. Der Client schickt, was der Spieler gezogen hat; was
   * daraus wird, entscheidet diese Stelle, und sie schickt die Leiste
   * anschliessend zurück. Der Client übernimmt also nie seine eigene
   * Vorstellung — er sieht immer das, was wirklich gespeichert ist.
   */
  private setzeAktionsplatz(session: Session, index: number, art: number, id: string): void {
    if (index < 0 || index >= session.aktionen.length) return;
    const platz = session.aktionen[index]!;

    if (art === AktionsArt.Gegenstand && getItem(id) && session.items.some((i) => i.itemId === id)) {
      platz.art = AktionsArt.Gegenstand;
      platz.id = id;
    } else if (
      art === AktionsArt.Fertigkeit &&
      canUseSkill(session.character?.beruf ?? KEIN_BERUF, session.character?.level ?? 1, id)
    ) {
      platz.art = AktionsArt.Fertigkeit;
      platz.id = id;
    } else {
      // Alles andere räumt: eine Kennung, die nicht taugt, ist kein Grund für
      // eine Fehlermeldung — der Platz ist danach eben leer, und das sieht man.
      platz.art = AktionsArt.Leer;
      platz.id = '';
    }

    session.aktionenDirty = true;
    // Erst pflegen, dann schicken: eine Fertigkeit, die eben verdrängt wurde,
    // sucht sich sonst erst beim nächsten Beutelereignis einen neuen Platz.
    this.pflegeAktionen(session);
    this.sendAktionen(session);
  }

  private sendAktionen(session: Session): void {
    session.send(encodeActionBar(session.aktionen));
    session.flush();
  }

  private sendInventory(session: Session): void {
    // Ein Gegenstand, der weg ist, gehört von der Leiste herunter — und der
    // einzige Ort, an dem **jede** Änderung am Beutel vorbeikommt, ist diese
    // Zeile hier. Die Prüfung an die einzelnen Stellen zu hängen (vernichten,
    // fallen lassen, verkaufen, verbrauchen) hiesse, sie viermal zu schreiben
    // und beim fünften Weg zu vergessen.
    if (this.pflegeAktionen(session)) this.sendAktionen(session);
    // Dieselbe Überlegung, dieselbe Stelle: ein Tier, dessen Gegenstand nicht
    // mehr im Beutel liegt, hat draussen nichts mehr verloren.
    this.pflegeHaustiere(session);

    session.send(
      encodeInventory(
        session.items.map((i) => ({
          itemId: i.itemId,
          count: i.count,
          slot: i.slot,
          equipped: i.equipped,
          upgrade: i.upgrade,
          unterwegs: i.unterwegs,
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

    /*
     * Auf dem Fluggerät wird nicht gewirkt.
     *
     * Dieselbe Überlegung wie beim Schlag: wer auf einem Besen sitzt, hat
     * keine Hand frei und keinen Stand. Und dieselbe Stelle wie dort — im
     * Server, denn was er nicht durchsetzt, gilt nicht.
     *
     * Nach der Prüfung „beherrschst du überhaupt" und vor der Abklingzeit: die
     * Absage soll nach der Ursache benannt sein, die zuerst zutrifft, und
     * kosten darf sie nichts.
     */
    if (this.flugGeraetVon(session) !== undefined) {
      this.systemMessage(session, 'Auf dem Fluggerät lassen sich keine Fertigkeiten wirken.');
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

    /*
     * Prüfen und Abziehen in einem Zug — und zwar im Kern.
     *
     * Er führt das Mana der Figur und regeneriert es; eine Prüfung gegen
     * `character.mp` fragte eine Kopie, die zuletzt beim Laden stimmte. Und
     * ein Abzug dort hätte den Kern gar nicht erreicht: die Fertigkeit wäre
     * kostenlos gewesen, sobald jemand den Balken anders liest.
     */
    if (!instance.world.verbrauchtMp(session.entityId, def.manaCost)) {
      this.systemMessage(session, `Zu wenig Mana für ${def.name}.`);
      return;
    }

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

    // Gebückt hat sie sich in jedem Fall — auch wenn gleich der Beutel voll
    // ist. Die Geste gehört zur Handlung, nicht zum Ergebnis.
    this.broadcastNear(instance, self.x, self.z, encodeEmote(session.entityId, EmoteKind.Pickup));
    this.nimmHaufen(session, instance, ergebnis.pile);
  }

  /**
   * Der Haufen wandert in den Beutel — von wem auch immer geholt.
   *
   * Getrennt vom Prüfen, weil es zwei Aufhebende gibt: den Menschen, der
   * danebensteht, und seinen Sammler, der hingelaufen ist. Was danach
   * geschieht, ist für beide dasselbe — und zweimal geschrieben wäre es
   * zweimal zu pflegen, mit dem Auftragsfortschritt als erstem Kandidaten fürs
   * Vergessen.
   */
  private nimmHaufen(session: Session, instance: MapInstance, pile: LootPile): void {
    const character = session.character;
    if (!character) return;

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

  // --- Begleiter -----------------------------------------------------------

  /**
   * Ein Haustier laufen lassen — oder wieder einsammeln.
   *
   * Der Gegenstand bleibt in **beiden** Fällen im Beutel liegen. Das ist der
   * Unterschied zu allem Anziehbaren: ein Brustpanzer wandert beim Anlegen an
   * die Figur, ein Tier läuft daneben her, und sein Gegenstand ist die Leine.
   */
  private schalteHaustier(session: Session, entry: ItemRecord): void {
    const def = getItem(entry.itemId);
    const pet = def?.pet;
    if (!def || !pet) return;

    if (entry.unterwegs) {
      this.holeHaustierZurueck(session, pet.art, `${def.name} ist wieder bei dir.`);
      return;
    }

    const level = session.character?.level ?? 1;
    if (level < def.levelReq) {
      this.systemMessage(session, `${def.name} braucht Stufe ${def.levelReq}.`);
      return;
    }

    /*
     * Und nicht vom Fluggerät aus freilassen.
     *
     * Der Begleiter läuft am Boden und folgt einer Figur, die dort steht. Wer
     * ihn aus vierzig Metern Höhe herunterschickt, hat einen Begleiter, der
     * unter ihm herumirrt und die Leine nie erreicht — die Abbruchregel in
     * `pets.ts` zöge ihn sofort wieder ein. Also gar nicht erst.
     *
     * Einsammeln bleibt erlaubt: das ist oben schon abgehandelt, und wer
     * aufsteigt, soll seinen Begleiter mitnehmen können.
     */
    if (this.flugGeraetVon(session) !== undefined) {
      this.systemMessage(session, `${def.name} lässt sich vom Fluggerät aus nicht freilassen.`);
      return;
    }

    /*
     * Von jeder Sorte eines. Das zweite verdrängt das erste, statt abgewiesen
     * zu werden.
     *
     * „Du hast schon einen Sammler draussen" wäre formal richtig und in der
     * Sache lästig: wer den anderen will, will nicht erst den einen
     * wegräumen. Verdrängen ist genau das, was das Anlegen eines zweiten
     * Brustpanzers auch tut.
     */
    const bisher = session.pets.get(pet.art);
    if (bisher) {
      const alt = getItem(bisher.itemId);
      this.holeHaustierZurueck(session, pet.art, `${alt?.name ?? 'Dein Begleiter'} macht Platz.`);
    }

    if (!this.erscheineHaustier(session, entry, def.name)) return;

    entry.unterwegs = true;
    session.itemsDirty = true;
    this.systemMessage(session, `${def.name} läuft jetzt bei dir.`);
    this.sendInventory(session);
    // Ein Support-Tier wirkt sofort — die Werte hängen an `sheetFor`, und das
    // liest `session.pets`.
    this.applyLoadout(session);
    this.sendStats(session);
  }

  /**
   * Setzt das Tier neben seinen Menschen und merkt es sich.
   *
   * Gibt `false` zurück, wenn die Welt es nicht angenommen hat. Dann bleibt
   * der Gegenstand unangetastet: ein Tier, das als „unterwegs" gilt und
   * nirgends läuft, wäre für den Spieler ein Knopf, der nichts mehr tut.
   */
  private erscheineHaustier(session: Session, entry: ItemRecord, name: string): boolean {
    const instance = this.instances.get(session.mapId);
    const self = this.woStehtEr(session);
    const def = getItem(entry.itemId);
    const pet = def?.pet;
    if (!instance || !self || !pet) return false;

    const id = this.nextEntityId++;
    /*
     * Einen Schritt **hinter** dem Menschen und nicht auf ihm.
     *
     * Auf ihm stünde das Tier im ersten Bild in der Figur; hinter ihm steht
     * es dort, wo es gleich ohnehin herläuft — auf genau dem Platz, den
     * `folgePunkt` ihm zuweist. Damit erscheint es nicht erst irgendwo und
     * rückt dann nach.
     */
    const platz = folgePunkt(self.x, self.z, self.yaw, pet.art);
    const ok = instance.world.spawnPet(
      id,
      platz.x,
      platz.z,
      0.35,
      pet.height,
      // Etwas schneller als sein Mensch, sonst fällt es bei jedem Schritt
      // weiter zurück und holt nie wieder auf.
      this.statsFor(session).moveSpeed * 1.25,
    );
    if (!ok) return false;

    instance.meta.set(id, { defId: entry.itemId, name, type: EntityType.Pet });
    session.pets.set(pet.art, {
      itemId: entry.itemId,
      art: pet.art,
      entityId: id,
      zustand: 'folgen',
      seitHeimweg: 0,
    });
    return true;
  }

  /**
   * Wo die Figur gerade steht — auch unmittelbar nach einem Kartenwechsel.
   *
   * Zuerst das Wesen in der Welt: das ist die Wahrheit, solange eine läuft.
   * Fehlt es, gilt der Figurensatz — und der ist genau in dem einen Moment
   * richtig, in dem das Wesen fehlt: gleich nach `spawnPlayer` steht die neue
   * Position schon in der Figur, aber noch nicht in der Zeilenkopie, die
   * `refresh` am Ende des Ticks schreibt.
   *
   * Ohne diesen Rückfall verschwand ein Begleiter beim Durchschreiten eines
   * Tors. Auf der neuen Karte fand er seinen Menschen nicht, das Erscheinen
   * scheiterte, und das Merkmal am Gegenstand wurde abgeräumt — mit einer
   * Ratte, die vorher danebenlief, und danach nicht mehr.
   */
  private woStehtEr(session: Session): { x: number; z: number; yaw: number } | undefined {
    const row = this.instances.get(session.mapId)?.entity(session.entityId);
    if (row) return { x: row.x, z: row.z, yaw: row.yaw };
    const c = session.character;
    return c ? { x: c.x, z: c.z, yaw: c.yaw } : undefined;
  }

  /**
   * Nimmt das Tier aus der Welt und aus dem Beutel-Merkmal.
   *
   * Eine Stelle für alle Wege dorthin — Einsammeln, Verdrängen, Kartenwechsel,
   * Abmelden. Getrennt geschrieben wäre spätestens beim Portal ein Wesen in
   * der alten Karte stehengeblieben, das niemandem mehr gehört.
   */
  private holeHaustierZurueck(session: Session, art: PetArt, meldung?: string): void {
    const lauf = session.pets.get(art);
    if (!lauf) return;

    const instance = this.instances.get(session.mapId);
    instance?.world.removeEntity(lauf.entityId);
    instance?.meta.delete(lauf.entityId);
    session.pets.delete(art);

    const entry = this.eintragVon(session, lauf);
    if (entry) {
      entry.unterwegs = false;
      session.itemsDirty = true;
    }

    if (meldung) this.systemMessage(session, meldung);
    if (session.state === 'playing') {
      this.sendInventory(session);
      this.applyLoadout(session);
      this.sendStats(session);
    }
  }

  /**
   * Der Beutelplatz zu einem laufenden Begleiter.
   *
   * Gesucht wird über die Kennung und das Merkmal, nicht über eine gemerkte
   * Platznummer: die verschiebt sich beim Anlegen und Ablegen, und eine
   * gemerkte zeigte danach auf einen fremden Gegenstand.
   */
  private eintragVon(session: Session, lauf: PetLauf): ItemRecord | undefined {
    return session.items.find((i) => i.itemId === lauf.itemId && i.unterwegs);
  }

  /**
   * Ruft zurück, was keinen Gegenstand mehr hat.
   *
   * Verkauft, fallen gelassen, vernichtet — es gibt vier Wege, auf denen ein
   * Gegenstand den Beutel verlässt, und jeder von ihnen kommt hier vorbei
   * (siehe `sendInventory`). Die Prüfung an die vier Stellen zu hängen hiesse,
   * sie viermal zu schreiben und beim fünften Weg zu vergessen — dann liefe
   * ein Tier neben jemandem her, dem es nicht mehr gehört.
   */
  private pflegeHaustiere(session: Session): void {
    for (const lauf of [...session.pets.values()]) {
      if (this.eintragVon(session, lauf)) continue;
      const instance = this.instances.get(session.mapId);
      instance?.world.removeEntity(lauf.entityId);
      instance?.meta.delete(lauf.entityId);
      session.pets.delete(lauf.art);
      const def = getItem(lauf.itemId);
      this.systemMessage(session, `${def?.name ?? 'Dein Begleiter'} ist nicht mehr bei dir.`);
    }
  }

  /** Alle Begleiter dieser Sitzung aus der Welt nehmen — ohne Meldung. */
  private raeumeHaustiere(session: Session): void {
    for (const art of [...session.pets.keys()]) {
      const lauf = session.pets.get(art)!;
      const instance = this.instances.get(session.mapId);
      instance?.world.removeEntity(lauf.entityId);
      instance?.meta.delete(lauf.entityId);
      session.pets.delete(art);
      // Das Merkmal am Gegenstand bleibt **stehen**: draussen war es, und nach
      // dem Tor oder dem nächsten Anmelden soll es wieder draussen sein.
    }
  }

  /**
   * Lässt wieder erscheinen, was laut Beutel draussen sein sollte.
   *
   * Gerufen beim Betreten der Welt und nach jedem Kartenwechsel. Der Beutel
   * ist dabei die Wahrheit und nicht `session.pets`: Letzteres ist der Zustand
   * *dieser* Welt, Ersteres der des Spielstands.
   */
  private stelleHaustiereHer(session: Session): void {
    for (const entry of session.items) {
      if (!entry.unterwegs) continue;
      const def = getItem(entry.itemId);
      if (!def?.pet) {
        // Ein Merkmal an etwas, das kein Tier (mehr) ist. Kommt vor, wenn eine
        // Inhaltsdatei sich ändert — dann ist es schlicht ein Gegenstand.
        entry.unterwegs = false;
        session.itemsDirty = true;
        continue;
      }
      if (session.pets.has(def.pet.art)) continue;
      if (!this.erscheineHaustier(session, entry, def.name)) {
        // Sollte nicht vorkommen. Wenn doch, ist ein stiller Verlust das
        // Schlimmste: der Gegenstand trüge ein Merkmal, dem nichts entspricht.
        console.warn(`[haustier] ${entry.itemId} konnte in ${session.mapId} nicht erscheinen.`);
        entry.unterwegs = false;
        session.itemsDirty = true;
      }
    }
  }

  /**
   * Ein Tick für alle Begleiter.
   *
   * Hier steht, **wohin** ein Tier will; der Kern trägt es dorthin. Die
   * Trennung ist der Grund, warum das Sammeln hier oben stehen kann: Beutel
   * und Beute liegen auf dieser Seite, Gelände und Hindernisse auf jener.
   */
  private updateHaustiere(session: Session, dtMs: number): void {
    if (session.pets.size === 0) return;
    const instance = this.instances.get(session.mapId);
    const self = instance?.entity(session.entityId);
    if (!instance || !self) return;

    for (const lauf of [...session.pets.values()]) {
      const def = getItem(lauf.itemId);
      const pet = def?.pet;
      const tier = instance.entity(lauf.entityId);
      if (!pet || !tier) {
        /*
         * Das Wesen ist weg, ohne dass wir es weggenommen hätten.
         *
         * Hier stand einmal „dann eben ein neues" — und genau das hat ein
         * zweites Tier in die Welt gesetzt, während das erste unerreichbar
         * darin stehenblieb: die Zeilenkopie war einen Tick alt, das frisch
         * erschienene Tier fehlte darin, und aus „ich sehe es nicht" wurde
         * „es gibt es nicht".
         *
         * Neu erschaffen darf an dieser Stelle deshalb nichts mehr. Wer ein
         * Wesen nicht findet, hat ein Wissensproblem und kein Tierproblem —
         * und die einzige richtige Antwort darauf ist aufräumen und es
         * sagen. Freilassen kann der Spieler selbst.
         */
        console.warn(`[haustier] ${lauf.itemId} ohne Wesen in ${session.mapId} — zurückgerufen.`);
        this.holeHaustierZurueck(session, lauf.art);
        continue;
      }

      const zumMenschen = Math.hypot(tier.x - self.x, tier.z - self.z);

      // --- Sammeln: das ausgesuchte Ziel prüfen und, wenn erreicht, aufheben.
      if (lauf.zustand === 'sammeln') {
        const haufen = lauf.ziel === undefined ? undefined : instance.loot.get(lauf.ziel);
        const nochErlaubt =
          haufen !== undefined &&
          zielNochErlaubt(self.x, self.z, haufen.x, haufen.z, pet.heimweg);

        if (!haufen || !nochErlaubt) {
          // Weg, aufgehoben von jemand anderem, oder der Mensch ist
          // weitergelaufen. Kein Fehler — nur das Ende dieses Gangs.
          lauf.ziel = undefined;
          lauf.zustand = 'heimweg';
          lauf.seitHeimweg = 0;
        } else if (Math.hypot(tier.x - haufen.x, tier.z - haufen.z) <= SAMMEL_ABSTAND) {
          this.nimmHaufen(session, instance, haufen);
          lauf.ziel = undefined;
          lauf.zustand = 'heimweg';
          lauf.seitHeimweg = 0;
        } else {
          instance.world.setPetGoal(lauf.entityId, haufen.x, haufen.z, SAMMEL_ABSTAND * 0.6);
          continue;
        }
      }

      // --- Heimweg: dieselbe Bewegung wie beim Folgen, aber mit laufender Uhr.
      if (lauf.zustand === 'heimweg') {
        lauf.seitHeimweg += dtMs;
        if (zumMenschen <= FOLGE_ABSTAND * 1.5) {
          lauf.zustand = 'folgen';
          lauf.seitHeimweg = 0;
        } else if (lauf.seitHeimweg >= HAENGT_MS && zumMenschen >= HAENGT_ABSTAND) {
          /*
           * Es kommt nicht mehr an.
           *
           * Zeit **und** Entfernung zusammen: nur die Zeit träfe ein Tier, das
           * gemütlich zwei Schritte hinterherläuft, nur die Entfernung eines,
           * das gerade erst losgelaufen ist. Beides zugleich heisst: es steht
           * an einer Kiste, einem Zaun oder in einer Felsspalte, und der Weg
           * darum herum ist mehr Wegfindung, als ein Haustier verdient.
           *
           * Verschwinden und neu erscheinen, nicht schieben: der Client
           * bewegt Wesen weich zwischen den Schnappschüssen, und ein Sprung
           * über dreissig Einheiten sähe aus wie ein Tier, das durch die
           * Landschaft segelt.
           */
          /*
           * Nur das **Wesen** wird getauscht, der Gegenstand bleibt unberührt.
           *
           * Der Umweg über `holeHaustierZurueck` stand hier zuerst und war
           * falsch: der räumt das Merkmal am Gegenstand ab und schickt einen
           * Beutel ohne Markierung an den Client. Setzt man es gleich darauf
           * wieder, weiss der Client nichts davon — die Kachel bliebe unbunt,
           * obwohl das Tier neben einem läuft.
           */
          const entry = this.eintragVon(session, lauf);
          instance.world.removeEntity(lauf.entityId);
          instance.meta.delete(lauf.entityId);
          session.pets.delete(lauf.art);
          if (entry) this.erscheineHaustier(session, entry, def?.name ?? 'Begleiter');
          continue;
        }
      }

      // --- Folgen: nach Beute sehen, sonst hinterher.
      if (lauf.zustand === 'folgen' && pet.art === 'sammler') {
        const haufen = this.naechsteBeute(session, instance, tier.x, tier.z, pet.sammelRadius, pet.heimweg, self);
        if (haufen) {
          lauf.ziel = haufen.id;
          lauf.zustand = 'sammeln';
          instance.world.setPetGoal(lauf.entityId, haufen.x, haufen.z, SAMMEL_ABSTAND * 0.6);
          continue;
        }
      }

      // Je Sorte ein eigener Platz — sonst stehen zwei Tiere ineinander.
      const platz = folgePunkt(self.x, self.z, self.yaw, lauf.art);
      instance.world.setPetGoal(lauf.entityId, platz.x, platz.z, FOLGE_ANKUNFT);
    }
  }

  /**
   * Der nächste Haufen, den dieser Sammler holen darf.
   *
   * Gesucht wird um das **Tier**, damit es einem Haufen nachgehen kann, den
   * man selbst schon hinter sich gelassen hat — begrenzt aber durch den
   * Abstand vom Menschen, damit es nicht über die halbe Karte zieht.
   *
   * Fremde Beute bleibt liegen: was noch für einen anderen Erleger reserviert
   * ist, würde beim Aufheben ohnehin abgewiesen, und ein Tier, das dorthin
   * läuft und mit leeren Pfoten zurückkommt, sieht kaputt aus.
   */
  private naechsteBeute(
    session: Session,
    instance: MapInstance,
    x: number,
    z: number,
    radius: number,
    heimweg: number,
    self: { x: number; z: number },
  ): LootPile | undefined {
    const jetzt = Date.now();
    let beste: LootPile | undefined;
    let besteDist = Infinity;

    for (const pile of instance.loot.near(x, z, radius)) {
      if (pile.owner !== session.entityId && pile.reservedUntil > jetzt) continue;
      if (!zielNochErlaubt(self.x, self.z, pile.x, pile.z, heimweg)) continue;
      const d = (pile.x - x) ** 2 + (pile.z - z) ** 2;
      if (d < besteDist) {
        besteDist = d;
        beste = pile;
      }
    }
    return beste;
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

    this.uebernehmeWerte(session);
    this.systemMessage(session, `Stufe ${character.level} erreicht.`);

    const offen = offenePunkte(character.level, character);
    if (offen > 0) {
      // Ein Aufstieg, der Punkte bringt, soll das sagen. Sonst liegen sie im
      // Charakterfenster und niemand sieht nach.
      this.systemMessage(session, `${offen} Punkt(e) zu verteilen — im Charakterfenster (C).`);
    }
  }

  /**
   * Versetzt eine Figur auf eine andere Karte — für `/tp`.
   *
   * Abgesetzt wird am **Startpunkt** der Karte, also dort, wo eine neue Figur
   * erscheint. Der steht in der Kartendatei, ist damit im Editor zu verschieben
   * und per Konstruktion begehbar — anders als die eigene Lage, die auf einer
   * kleineren Karte im Berg oder ausserhalb liegen kann.
   *
   * Gibt zurück, ob es die Karte gibt. Der Befehl nennt sonst die, die es
   * gibt: sich an einem Kartennamen zu vertippen ist der Normalfall, und eine
   * Absage ohne Liste hilft dabei niemandem.
   */
  teleportiere(session: Session, mapId: string): boolean {
    const to = this.instances.get(mapId.trim().toLowerCase());
    if (!to) return false;

    if (to.doc.id === session.mapId) {
      // Kein Wechsel, sondern ein Sprung an den Startpunkt. Auch das ist
      // brauchbar — nur soll die Meldung nicht „Lichtmoor betreten" lauten,
      // wenn man schon dort steht.
      this.systemMessage(session, `Du bist schon in ${to.doc.name} — zurück zum Startpunkt.`);
    }
    this.versetze(session, to, to.doc.spawn);
    return true;
  }

  /**
   * Setzt die Figur an eine Stelle **dieser** Karte — für `/tp x y z`.
   *
   * Der Weg über `versetze` (Kartenwechsel) wäre hier falsch: der legt die
   * Figur neu an, und die Höhe geht dabei durch `spawnPlayer` verloren. Hier
   * bleibt dieselbe Figur stehen, sie wird nur woandershin gesetzt.
   *
   * Gedacht zum Prüfen: ohne einen Weg auf einen schwebenden Felsen lässt sich
   * nicht nachstellen, was dort oben gilt — und genau dort war die
   * Wahrnehmung der Monster falsch.
   */
  setzeAn(session: Session, x: number, y: number, z: number): boolean {
    const instance = this.instances.get(session.mapId);
    if (!instance || !instance.entity(session.entityId)) return false;
    instance.world.setzeAn(session.entityId, x, y, z);
    /*
     * Der Client muss von dem Sprung erfahren, sonst zieht seine Vorhersage
     * die Figur zurück: sie rechnet vom letzten bestätigten Stand weiter und
     * kennt keinen Grund für einen Satz über die halbe Karte. Dieselbe
     * Bekanntmachung wie beim Kartenwechsel — eine volle Zeile statt einer
     * Aktualisierung.
     */
    for (const other of this.sessions) other.known.delete(session.entityId);
    instance.refresh();
    return true;
  }

  /** Die Kennungen aller Karten, die dieser Kanal führt — für `/tp` ohne Treffer. */
  kartenListe(): string[] {
    return [...this.instances.keys()].sort();
  }

  /**
   * Setzt ein Monster vor die Figur — für `/spawn`.
   *
   * **Vor** und nicht **auf**: vier Meter in Blickrichtung. Auf der eigenen
   * Stelle stünde es im Bild hinter der Kamera, und genau darum geht es bei
   * diesem Befehl nicht — er ist zum Ansehen da.
   *
   * Gibt den Namen des Wesens zurück. `undefined` heisst: diese Sorte gibt es
   * nicht, oder vor der Figur ist kein Boden, der es trägt. Welcher von beiden
   * Fällen es war, entscheidet der Befehl an der Liste — hier eine zweite
   * Rückgabeart einzuführen, verteilte die Absage auf zwei Stellen.
   */
  spawneMonster(session: Session, sorte: string): string | undefined {
    const instance = this.instances.get(session.mapId);
    const self = instance?.entity(session.entityId);
    if (!instance || !self) return undefined;

    // Vorwärts ist (sin yaw, cos yaw) — dieselbe Richtung, in die der Kern die
    // Figur laufen lässt. Vier Meter: weiter als jeder Kollisionskreis eines
    // Wesens und nah genug, um im Bild zu sein.
    const x = self.x + Math.sin(self.yaw) * 4;
    const z = self.z + Math.cos(self.yaw) * 4;
    if (!instance.traegtBoden(x, z)) return undefined;

    return instance.spawneMonster(sorte, x, z);
  }


  /**
   * Setzt die Stufe einer Figur — für `/level`.
   *
   * Erfahrung wird dabei auf null gesetzt und nicht umgerechnet: „Stufe 30"
   * heisst der Anfang von Stufe 30. Alles andere wäre eine Rechnung, deren
   * Ergebnis niemand vorhersagen kann, und der Befehl ist ein Werkzeug zum
   * Ausprobieren.
   *
   * Verteilte Punkte bleiben stehen — auch beim Herabstufen. Sie wieder
   * einzusammeln hiesse zu entscheiden, welche wegfallen, und diese
   * Entscheidung gehört niemandem hier. `offenePunkte` kommt mit dem Überhang
   * zurecht und meldet dann schlicht null.
   */
  private setzeStufeVon(session: Session, stufe: number): void {
    const character = session.character;
    if (!character) return;
    character.level = stufe;
    character.exp = 0;
    this.uebernehmeWerte(session);
    this.systemMessage(session, `Du bist jetzt Stufe ${stufe}.`);
  }

  /**
   * Legt offene Punkte auf eine Grundeigenschaft.
   *
   * Der Server rechnet nach, wie viele offen sind — der Client schickt nur
   * den Wunsch. Anders wäre es eine Bitte, der man folgt: wer die Zahl selbst
   * mitschickte, könnte sich zwanzig Punkte je Stufe nehmen.
   *
   * Zuviel verlangt heisst nicht abgelehnt, sondern gekürzt: wer zweimal
   * schnell klickt, während die Antwort unterwegs ist, soll den zweiten Klick
   * verlieren und nicht den ganzen Vorgang.
   */
  private setzePunkt(session: Session, eigenschaft: string, anzahl: number): void {
    const character = session.character;
    if (!character || !istEigenschaft(eigenschaft)) return;

    const offen = offenePunkte(character.level, character);
    const nehmen = Math.min(Math.max(0, Math.floor(anzahl)), offen);
    if (nehmen === 0) {
      if (offen === 0) this.systemMessage(session, 'Du hast keine Punkte zu verteilen.');
      return;
    }

    character[eigenschaft] += nehmen;
    this.uebernehmeWerte(session);
  }

  /**
   * Rechnet die Werte neu und schiebt sie überall hin, wo sie gebraucht werden.
   *
   * An einer Stelle, weil es drei Anlässe gibt — Stufenaufstieg, verteilter
   * Punkt, `/level`. Drei Abschriften wären drei Gelegenheiten, eine der
   * Stellen zu vergessen; die vergessene wäre dann die, an der die Anzeige und
   * die Simulation auseinanderlaufen.
   */
  private uebernehmeWerte(session: Session): void {
    const character = session.character;
    const instance = this.instances.get(session.mapId);
    if (!character || !instance) return;

    const stats = this.statsFor(session);
    instance.world.setPlayerStats(
      session.entityId,
      character.level,
      stats.maxHp,
      stats.maxMp,
      stats.attackDamage,
      stats.defense,
      stats.moveSpeed,
      stats.hpRegen,
      stats.mpRegen,
    );
    instance.world.setCritProfile(session.entityId, stats.critChance, stats.critMultiplier);

    this.setzeFlugzustand(session);

    // Die Schlagpause hängt an Geschick und gehört deshalb hierher — sonst
    // gälte der neue Wert erst nach dem nächsten Ausrüstungswechsel.
    const profil = this.attackProfileOf(session);
    instance.world.setAttackProfile(
      session.entityId,
      profil.style,
      profil.range,
      stats.attackCooldown,
      profil.windupSec,
    );

    // Um das Leben ist nicht zu kümmern: `setPlayerStats` behält im Kern den
    // **Anteil** — wer mit halbem Leben eine Stufe verliert, hat danach die
    // Hälfte der kleineren Höchstzahl und nicht mehr, als möglich ist.

    // Die Stufe steht über dem Kopf. Ohne das trägt die Figur ihre alte, bis
    // sie jemand neu kennenlernt.
    const meta = instance.metaFor(session.entityId);
    if (meta) Object.assign(meta, this.playerMeta(session));
    for (const other of this.sessions) other.known.delete(session.entityId);

    this.sendStats(session);
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

    /*
     * Drei Reichweiten, eine Nachricht.
     *
     * Der Client sagt, welchen Kanal er meint; **wie weit** der trägt,
     * entscheidet ausschliesslich diese Stelle. Ein Client, der „global"
     * behauptet und dabei eine Umgebungsnachricht meint, ändert daran nichts —
     * und ein Client, der etwas Unbekanntes schickt, redet in die Umgebung.
     */
    const kanal =
      channel === ChatChannel.Shout || channel === ChatChannel.Global
        ? channel
        : ChatChannel.Say;

    // Die eigene Kennung reist mit: über diesem Kopf erscheint die Blase. Wer
    // auf einer anderen Karte steht, hat für den Empfänger kein Wesen — dann
    // bleibt die Blase weg und es steht nur die Zeile im Fenster.
    const packet = encodeServerChat({
      channel: kanal,
      from: session.accountName,
      text: trimmed,
      entityId: session.entityId,
    });

    if (kanal === ChatChannel.Global) {
      // Jeder auf diesem Spielserver, über alle Karten hinweg. Das ist der
      // Kanal im Sinne der Kanalliste: wer hier zuhört, hat sich mit
      // demselben Prozess verbunden.
      for (const andere of this.sessions) {
        if (andere.state === 'playing') andere.send(packet);
      }
      return;
    }

    if (kanal === ChatChannel.Shout) {
      for (const playerId of instance.playerIds) {
        this.sessionByEntity.get(playerId)?.send(packet);
      }
      return;
    }

    const row = instance.entity(session.entityId);
    if (row) this.broadcastNear(instance, row.x, row.z, packet, CHAT_RADIUS);
  }

  /**
   * Eine Ansage an alle — der Befehl `/sys`.
   *
   * Geht an jeden auf diesem Spielserver und landet nicht im Chatfenster,
   * sondern gross im oberen Bilddrittel. Deshalb eine eigene Sorte und kein
   * Kanal: eine Ansage, die man wegscrollen kann, ist keine.
   */
  ansage(text: string): number {
    const packet = encodeServerChat({
      channel: ChatChannel.Ansage,
      from: '',
      text,
      entityId: 0,
    });
    let erreicht = 0;
    for (const session of this.sessions) {
      if (session.state !== 'playing') continue;
      session.send(packet);
      session.flush();
      erreicht++;
    }
    return erreicht;
  }

  /**
   * Setzt die Zugriffsstufe eines Kontos — für `/accesslevel`.
   *
   * Wen der Name meint, wird in dieser Reihenfolge beantwortet:
   *
   *   1. Eine **Figur, die gerade hier spielt**. Im Spiel sieht man
   *      Figurennamen, nicht Kontonamen, und über einer Figur mit Google-Konto
   *      steht nirgends deren E-Mail-Adresse. Ohne diesen Schritt wäre der
   *      Befehl für den häufigsten Fall — „der da drüben soll Spielleiter
   *      werden" — nicht zu benutzen.
   *   2. Sonst gilt der Name als **Kontoname**. So erreicht man auch, wer
   *      gerade nicht da ist.
   *
   * Geschrieben wird immer beim Anmeldeserver, denn dort stehen die Konten.
   * Nur im Alleinbetrieb gibt es keinen, und dann liegen sie hier.
   */
  setzeStufe(session: Session, name: string, stufe: AccessLevel): void {
    const gesucht = name.trim().toLowerCase();
    const hier = [...this.sessions].find(
      (s) =>
        s.state === 'playing' &&
        (s.character?.name.toLowerCase() === gesucht || s.accountName.toLowerCase() === gesucht),
    );
    const konto = hier?.accountName ?? name.trim();
    const wort = accessName(stufe);

    void (async () => {
      const auskunft = this.login.aktiv
        ? await this.login.setzeStufe(konto, wort)
        : await this.setzeStufeAllein(konto, wort);

      if (!auskunft) {
        this.systemMessage(session, 'Der Anmeldeserver antwortet nicht — nichts geändert.');
        return;
      }
      if (!auskunft.ok) {
        this.systemMessage(session, `Ein Konto namens „${konto}" gibt es nicht.`);
        return;
      }

      this.systemMessage(
        session,
        `${auskunft.name}: Stufe ${auskunft.vorher} → ${auskunft.nachher}.`,
      );
      if (auskunft.inListe) {
        // Die Liste zieht bei jeder Anmeldung nach. Ohne diesen Hinweis stünde
        // der Verwalter vor einer Zuweisung, die beim nächsten Anmelden von
        // selbst zurückspringt — und suchte den Fehler bei sich.
        this.systemMessage(
          session,
          `Achtung: „${auskunft.name}" steht in AURELITH_ADMINS. Diese Liste gilt ` +
            'bei jeder Anmeldung neu und setzt die Stufe dann wieder zurück.',
        );
      }

      /*
       * Wer gerade hier spielt, bekommt die Stufe sofort.
       *
       * Sonst gälte in der Datenbank das eine und in der Sitzung das andere,
       * bis derjenige sich neu anmeldet — zwei Wahrheiten über dieselbe Zahl,
       * und die sichtbare wäre die veraltete. Herabstufen muss ohnehin sofort
       * wirken, sonst nimmt man einem Befehl das, was ihn nötig machte.
       */
      if (hier && hier.state === 'playing') {
        hier.access = stufe;
        this.systemMessage(hier, `Deine Zugriffsstufe ist jetzt „${wort}".`);
      }
    })();
  }

  /**
   * Setzt die Stufe einer Figur — für `/level`.
   *
   * Ohne Namen die eigene. Mit Namen gemeint ist eine **Figur**, nicht ein
   * Konto: das ist der Name, der im Spiel über dem Kopf steht, und der
   * Befehl wird im Spiel getippt. Gesucht wird nur unter denen, die gerade
   * hier spielen — die Werte einer schlafenden Figur zu ändern hiesse, an
   * einem Spielstand zu drehen, der beim nächsten Laden ohnehin überschrieben
   * wird.
   */
  setzeLevel(session: Session, figur: string, level: number): boolean {
    if (figur === '') {
      this.setzeStufeVon(session, level);
      return true;
    }

    const gesucht = figur.trim().toLowerCase();
    const ziel = [...this.sessions].find(
      (s) => s.state === 'playing' && s.character?.name.toLowerCase() === gesucht,
    );
    if (!ziel) return false;

    this.setzeStufeVon(ziel, level);
    // Der Ausführende bekommt seine eigene Zeile — sonst sieht er nur, dass
    // nichts passiert ist, während die Meldung beim anderen steht.
    if (ziel !== session) {
      this.systemMessage(session, `${ziel.character?.name} ist jetzt Stufe ${level}.`);
    }
    return true;
  }

  /**
   * Dasselbe im Alleinbetrieb — dort stehen die Konten in diesem Prozess.
   *
   * Die Antwort hat absichtlich dieselbe Form wie die vom Anmeldeserver: der
   * Aufrufer soll die beiden Betriebsarten nicht auseinanderhalten müssen.
   */
  private async setzeStufeAllein(name: string, wort: string): Promise<StufenAuskunft | undefined> {
    if (!this.konten) return undefined;
    const konto = await this.konten.findAccount(name);
    if (!konto) return { ok: false };
    if (konto.accessLevel !== wort) await this.konten.setAccessLevel(konto.id, wort);
    return {
      ok: true,
      name: konto.name,
      vorher: konto.accessLevel,
      nachher: wort,
      inListe: config.zugriff.has(konto.name.toLowerCase()),
    };
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
    session.send(encodeServerChat({ channel: ChatChannel.System, from: '', text, entityId: 0 }));
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

  /**
   * Braucht die angelegte Waffe Munition?
   *
   * An der Kampfart und nicht an einer Liste von Bögen: was aus der Ferne
   * schiesst, schiesst etwas. Eine zweite Waffe mit `attackStyle: ranged`
   * bekommt die Regel damit umsonst — und niemand muss daran denken.
   */
  private brauchtMunition(session: Session): boolean {
    return this.mainhandOf(session)?.attackStyle === 'ranged';
  }

  /**
   * Nimmt einen Pfeil, sobald ein Schuss beginnt.
   *
   * Gemessen wird die **Flanke**: eben noch nicht am Schlagen, jetzt schon.
   * Der Kern setzt diesen Zustand in `tryStartSwing`, und zwar genau einmal je
   * Schlag — ein eigener Zähler im Server wäre eine zweite Vorstellung davon,
   * wann ein Schuss beginnt, und die beiden liefen bei jeder Änderung an der
   * Abklingzeit auseinander.
   *
   * Abgezogen wird beim Beginn und nicht beim Treffer: ein Pfeil, der
   * danebengeht, ist trotzdem weg. Alles andere hiesse, dass Zielen nichts
   * kostet.
   */
  private verbraucheMunition(session: Session): void {
    const schlaegt =
      this.instances.get(session.mapId)?.entity(session.entityId)?.state === EntityState.Attack;
    const beginnt = schlaegt && !session.schlugZuletzt;
    session.schlugZuletzt = schlaegt;

    if (!beginnt || !this.brauchtMunition(session)) return;

    const munition = session.items.find((i) => getItem(i.itemId)?.kind === 'ammo');
    if (!munition) return;

    removeSlot(session.items, munition.slot, 1);
    session.itemsDirty = true;
    // Wer eben noch geschossen hat, darf sofort erfahren, dass es der letzte
    // Pfeil war. Die Sperre gegen zwanzig Zeilen je Sekunde soll nicht dazu
    // führen, dass der Hinweis nach dem Leerschiessen vier Sekunden schweigt.
    session.koecherGemeldet = 0;
    this.sendInventory(session);
  }

  /**
   * Sagt einmal, dass der Köcher leer ist — und dann eine Weile nicht mehr.
   *
   * Die Prüfung läuft zwanzigmal je Sekunde. Ohne Sperre stünde die Zeile
   * zwanzigmal je Sekunde im Fenster, und der Hinweis wäre unlesbar.
   */
  private meldeLeerenKoecher(session: Session): void {
    const jetzt = Date.now();
    if (jetzt - session.koecherGemeldet < 4000) return;
    session.koecherGemeldet = jetzt;
    this.systemMessage(session, 'Keine Pfeile mehr — beim Händler gibt es welche.');
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
    // Null, und das ist die Aussage: ohne ein Stück, das Regeneration
    // mitbringt, heilt niemand von selbst.
    sheet.basis('hpRegen', basis.hpRegen);
    sheet.basis('mpRegen', basis.mpRegen);

    /*
     * Die Grundeigenschaften — vor der Ausrüstung und nach dem Grundwert.
     *
     * Als Beitrag und nicht in den Grundwert hinein: die Zeile im
     * Charakterfenster soll sagen, wie viel Leben von der Stufe kommt und wie
     * viel von der Ausdauer. In einen Grundwert verrechnet wäre beides
     * dieselbe Zahl, und die Frage „lohnen sich Punkte in Ausdauer?" liesse
     * sich nicht mehr am Fenster beantworten.
     *
     * Was welche Eigenschaft bewirkt, steht in `eigenschaftsWirkung` — an
     * einer Stelle, weil das Charakterfenster dieselbe Auskunft anzeigt.
     */
    if (session.character) {
      for (const w of eigenschaftsWirkung(session.character)) {
        sheet.fuege(w.attribut, w.quelle, w.flach, w.prozent);
      }
    }

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
      sheet.fuege('hpRegen', name, def.hpRegen);
      sheet.fuege('mpRegen', name, def.mpRegen);
    }

    /*
     * Der Begleiter, sofern einer läuft.
     *
     * In denselben Feldern wie ein Ring und über denselben Weg: was er
     * beiträgt, steht in `attackDamage`, `maxHp` und den anderen. Ein eigener
     * Satz Felder wäre eine zweite Art, dieselbe Sache zu sagen — und die
     * Zeile im Charakterfenster müsste beide kennen.
     *
     * Aus `session.pets` und nicht aus dem Beutel: nur was **läuft**, wirkt.
     * Ein Tier, das im Beutel liegt, ist ein Gegenstand.
     */
    for (const lauf of session.pets.values()) {
      const def = getItem(lauf.itemId);
      if (!def) continue;
      sheet.fuege('attackDamage', def.name, def.attackDamage);
      sheet.fuege('defense', def.name, def.defense);
      sheet.fuege('maxHp', def.name, def.maxHp);
      sheet.fuege('maxMp', def.name, def.maxMp);
      sheet.fuege('critChance', def.name, def.critChance);
      sheet.fuege('hpRegen', def.name, def.hpRegen);
      sheet.fuege('mpRegen', def.name, def.mpRegen);
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
      sheet.fuege('hpRegen', satz.set.name, b.hpRegen);
      sheet.fuege('mpRegen', satz.set.name, b.mpRegen);
    }

    /*
     * Und ganz zuletzt die Regeneration — sie hängt am fertigen Maximum.
     *
     * Der Grundwert ist ein Anteil davon, und der lässt sich erst ausrechnen,
     * wenn Stufe, Ausdauer, Ausrüstung und Satz zusammengezählt sind. Weiter
     * oben gesetzt wäre es der Anteil eines Maximums, das noch nicht feststeht
     * — und damit bei jedem Rüstungswechsel ein anderer als der angezeigte.
     *
     * `basis` und nicht `fuege`: was die Stücke beitragen, steht schon als
     * Beitrag da und bleibt stehen. Hier wird nur der Sockel gesetzt, auf dem
     * sie sitzen.
     */
    const p = tuning().progression;
    sheet.basis('hpRegen', sheet.wert('maxHp') * p.lebensregenerationAnteil);
    sheet.basis('mpRegen', sheet.wert('maxMp') * p.manaregenerationAnteil);

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
  private statsFor(session: Session): ReturnType<typeof baseStatsForLevel> & {
    attackCooldown: number;
  } {
    const sheet = this.sheetFor(session);
    return {
      /*
       * Die Schlagpause **aus der Tafel** und nicht aus der Waffe.
       *
       * Sie steht in beiden: die Waffe bringt sie mit, und Geschick kürzt sie.
       * Wer hier `profile.cooldownSec` nähme, hätte im Charakterfenster den
       * einen Wert und im Kampf den anderen — und zwar genau bei den Figuren,
       * die Punkte in Geschick gesteckt haben.
       */
      attackCooldown: sheet.wert('attackCooldown'),
      maxHp: sheet.wert('maxHp'),
      maxMp: sheet.wert('maxMp'),
      attackDamage: sheet.wert('attackDamage'),
      defense: sheet.wert('defense'),
      moveSpeed: sheet.wert('moveSpeed'),
      critChance: sheet.wert('critChance'),
      critMultiplier: sheet.wert('critMultiplier'),
      hpRegen: sheet.wert('hpRegen'),
      mpRegen: sheet.wert('mpRegen'),
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
        hp: this.lebenVon(session),
        maxHp: sheet.wert('maxHp'),
        /*
         * Mana aus der **Zeile**, genau wie das Leben.
         *
         * Hier stand `character.mp`, und das ist die gespeicherte Kopie: sie
         * wird beim Laden gesetzt und danach nie wieder angefasst. Der Kern
         * regeneriert dagegen das Mana der Figur. Beim Betreten war die Kopie
         * null, der Kern füllte auf — und angezeigt wurde die Null. Wer eine
         * Fertigkeit anklickte, sah nichts passieren: der Client rechnete mit
         * null Mana und schickte gar nicht erst.
         */
        mp: this.manaVon(session),
        maxMp: sheet.wert('maxMp'),
        gold: character.gold,
        eigenschaften: {
          staerke: character.staerke,
          ausdauer: character.ausdauer,
          geschick: character.geschick,
          weisheit: character.weisheit,
        },
        offenePunkte: offenePunkte(character.level, character),
        attributes: sheet.alle(),
      }),
    );
  }

  /**
   * Der Manastand der Figur — aus dem Kern.
   *
   * Er führt ihn und regeneriert ihn; `character.mp` ist eine Kopie, die
   * zuletzt beim Laden stimmte. Wer die liest, zeigt den Stand von damals.
   * Ohne laufende Welt bleibt nur die Kopie — zwischen Anmelden und Betreten
   * gibt es kein Wesen, das gefragt werden könnte.
   */
  private manaVon(session: Session): number {
    const welt = this.instances.get(session.mapId)?.world;
    const mana = welt && session.entityId ? welt.manaVon(session.entityId) : -1;
    return mana >= 0 ? mana : (session.character?.mp ?? 0);
  }

  /**
   * Der Lebensstand — aus dem Kern, nicht aus der Sichtstruktur.
   *
   * Die wird einmal je Tick gebaut. Zwischen `spawnPlayer` und dem nächsten
   * Tick steht die Figur nicht darin, und wer dort nachsah, fiel auf
   * `character.hp` zurück: bei einer frischen Figur eine Null. Genau diese
   * Null stand in der ersten Werte-Nachricht nach dem Betreten.
   */
  private lebenVon(session: Session): number {
    const welt = this.instances.get(session.mapId)?.world;
    const leben = welt && session.entityId ? welt.lebenVon(session.entityId) : -1;
    return leben >= 0 ? leben : (session.character?.hp ?? 0);
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
      character.hp = Math.round(this.lebenVon(session));
      // Und das Mana. Ohne diese Zeile stand nach jedem Anmelden wieder die
      // Zahl von der Figurerstellung in der Datenbank.
      character.mp = Math.round(this.manaVon(session));
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
    if (session.aktionenDirty) {
      await this.welt.saveAktionen(character.id, session.aktionen);
      session.aktionenDirty = false;
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
