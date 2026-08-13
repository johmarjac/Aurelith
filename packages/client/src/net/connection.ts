/**
 * Verbindung zum Spielserver.
 *
 * Kennt Frames und Pakete, sonst nichts. Sie entscheidet nie, was eine
 * Nachricht bedeutet — sie reicht sie weiter. Damit bleibt die Stelle, an der
 * das Protokoll auf Spiellogik trifft, genau eine: `game.ts`.
 *
 * Ausgehende Pakete werden gesammelt und einmal je Frame als ein Frame
 * verschickt. Bei zwanzig Eingaben je Sekunde ist der Unterschied gering, aber
 * er kostet nichts und gilt genauso für alles, was später dazukommt.
 */

import {
  CipherSuite,
  FrameSequencer,
  KickReason,
  PROTOCOL_VERSION,
  ServerOp,
  decodeCombatEvent,
  decodeEmote,
  decodeRealms,
  decodeSkillCast,
  decodeFrame,
  FrameError,
  decodeInventory,
  decodeKick,
  decodeMapChange,
  decodeNpcDialog,
  decodePong,
  decodeQuestLog,
  decodeServerChat,
  decodeLobby,
  decodeLobbyError,
  decodeServerVersion,
  decodeSnapshot,
  decodeStats,
  decodeWelcome,
  encodeClientChat,
  encodeCreateAccount,
  encodeCreateCharacter,
  encodeDeleteCharacter,
  encodeEnterWorld,
  encodeLeaveWorld,
  encodeFrame,
  encodeHello,
  encodeInput,
  encodePing,
  encodeRespawn,
  encodeEquipItem,
  encodeInteract,
  encodeLogin,
  encodeDestroyItem,
  encodeDropItem,
  encodeMoveItem,
  encodePickupLoot,
  encodeUseItem,
  encodeUseSkill,
  encodeUpgradeItem,
  encodeQuestAction,
  encodeRealmList,
  encodeSetTarget,
  encodeTicket,
  encodeShopTrade,
  encodeUsePortal,
  encodeVersionRequest,
  nullCipher,
  readPacket,
  type BuildStamp,
  type ChatMsg,
  type CombatEventMsg,
  type InputMsg,
  type InventoryRow,
  type LobbyMsg,
  type MapChangeMsg,
  type NpcDialogMsg,
  type QuestLogRow,
  type RealmsMsg,
  type SnapshotMsg,
  type StatsMsg,
  type WelcomeMsg,
} from '@aurelith/shared';
import { BUILD } from '../config.ts';

export type ConnectionStatus = 'verbindet' | 'verbunden' | 'getrennt';

export interface ConnectionHandlers {
  onStatus?: (status: ConnectionStatus, detail?: string) => void;
  onWelcome?: (msg: WelcomeMsg) => void;
  onSnapshot?: (msg: SnapshotMsg) => void;
  onMapChange?: (msg: MapChangeMsg) => void;
  onCombat?: (msg: CombatEventMsg) => void;
  onChat?: (msg: ChatMsg) => void;
  onStats?: (msg: StatsMsg) => void;
  onInventory?: (rows: InventoryRow[]) => void;
  onNpcDialog?: (msg: NpcDialogMsg) => void;
  onQuestLog?: (rows: QuestLogRow[]) => void;
  onKick?: (reason: number, message: string) => void;
  /** Antwort auf `sendVersionRequest`. */
  onVersion?: (stamp: BuildStamp) => void;
  /** Eine Geste einer Figur — siehe `EmoteKind`. */
  onEmote?: (entityId: number, kind: number) => void;
  /**
   * Jemand hat eine Fertigkeit gewirkt.
   *
   * Auch die eigene Figur: was sie tut, meldet der Server, und nicht die
   * Taste. Sonst sähe der Wirbel im eigenen Bild anders aus als im fremden —
   * zum Beispiel dann, wenn der Server ihn gar nicht zugelassen hat.
   */
  onSkillCast?: (entityId: number, skillId: string) => void;
  /** Der Stand der Charakterverwaltung — nach dem Anmelden und nach jeder Änderung. */
  onLobby?: (msg: LobbyMsg) => void;
  /**
   * Die Server- und Kanalliste des Anmeldeservers.
   *
   * Kommt statt `onLobby`, wenn am anderen Ende ein Anmeldeserver hängt: der
   * kennt keine Figuren, sondern Kanäle. Ein Spielserver im Alleinbetrieb
   * schickt weiterhin gleich die Figurenliste — der Client muss deshalb nicht
   * wissen, mit welcher Sorte er spricht.
   */
  onRealms?: (msg: RealmsMsg) => void;
  /** Was an einer Anmeldung oder einer Figurenänderung nicht ging. */
  onLobbyError?: (text: string) => void;
}

/** Wartezeiten zwischen Verbindungsversuchen, in Millisekunden. */
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000];

export class Connection {
  status: ConnectionStatus = 'getrennt';
  /** Umlaufzeit in Millisekunden, gleitend gemittelt. */
  latency = 0;

  private socket?: WebSocket;
  private readonly outgoing: Uint8Array[] = [];
  private readonly txSeq = new FrameSequencer();
  private readonly suite = new CipherSuite();
  private cipher = nullCipher;

  private retries = 0;
  private retryTimer?: number;
  private pingTimer?: number;
  private closedByUs = false;
  /**
   * Nach `close()` wird nichts mehr nach oben gemeldet.
   *
   * Wichtig beim Wechsel des Servers über `/connect`: eine alte Verbindung
   * kann noch ein Paket im Flug haben, und dessen Snapshot würde sonst die
   * frische Sitzung durcheinanderbringen.
   */
  private disposed = false;

  constructor(
    private readonly url: string,
    private readonly handlers: ConnectionHandlers,
    /**
     * Eintrittskarte für einen Kanal, falls diese Verbindung eine zu einem
     * Spielserver ist.
     *
     * Sie geht direkt hinter dem Gruss raus — es gibt nichts, worauf sie
     * warten müsste. Ohne Karte ist es eine Verbindung zum Anmeldeserver
     * (oder zu einem Spielserver im Alleinbetrieb), und dann kommt der Name
     * über die Anmeldemaske.
     *
     * Anzugeben ist sie **immer**, notfalls als `undefined`. Freiwillig war
     * sie schon einmal, und dann fehlte sie an der einzigen Stelle, die sie
     * braucht: der Client grüsste den Kanal und schwieg, der Kanal wartete
     * auf eine Karte, die nie kam, und niemand bekam eine Fehlermeldung —
     * denn beide taten genau das, was ihnen aufgetragen war. Ein Übersetzer,
     * der ein vergessenes Argument bemängelt, ist billiger als ein Abend
     * Suche im Proxy.
     */
    private readonly ticket: string | undefined,
  ) {}

  connect(): void {
    if (this.disposed) return;
    this.closedByUs = false;
    this.setStatus('verbindet');

    const socket = new WebSocket(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.retries = 0;
      this.txSeq.reset();
      // Der Handschlag steht. Die Zeile trennt zwei Fälle, die von aussen
      // gleich aussehen: „kommt gar nicht hin" und „kommt hin und fliegt
      // gleich wieder raus".
      console.log(`[netz] verbunden mit ${this.url}`);
      this.send(
        encodeHello({
          protocolVersion: PROTOCOL_VERSION,
          clientBuild: BUILD,
          // Heute beherrschen wir nur Klartext. Die Liste existiert, damit die
          // Aushandlung später keine Protokolländerung braucht.
          supportedCiphers: [0],
        }),
      );
      if (this.ticket) this.send(encodeTicket(this.ticket));
      this.flush();
      this.setStatus('verbunden');
      this.startPinging();
    };

    socket.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(event.data);
      try {
        this.handleFrame(bytes);
      } catch (err) {
        // Dasselbe, was der Server in sein Ausgabefenster schreibt, nur von
        // dieser Seite gesehen: Fehlerschlüssel, Länge und die ersten Bytes.
        // Ohne die Bytes ist „Frame nicht lesbar" eine Feststellung ohne
        // Anhaltspunkt.
        const code = err instanceof FrameError ? err.code : 'unbekannt';
        const text = err instanceof Error ? err.message : String(err);
        const kopf = [...bytes.subarray(0, 16)]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' ');
        console.error(`[netz] Rahmen nicht lesbar (${code}): ${text} — ${bytes.length} Byte: ${kopf}`);
      }
    };

    /*
     * Warum die Leitung zuging.
     *
     * Der Schliesscode ist die einzige Auskunft, die ein Browser über ein
     * gescheitertes WebSocket herausgibt — die eigentliche Ursache
     * (Zertifikat, Zeitüberschreitung, abgewiesen) bleibt aus
     * Sicherheitsgründen verborgen. Ihn wegzuwerfen hiess, aus jedem
     * Fehlschlag dasselbe „getrennt" zu machen.
     *
     * Was die Zahlen bedeuten:
     *
     *   1000/1001  ordentlich geschlossen — normalerweise wir selbst
     *   1002       Protokollfehler, meist ein unlesbarer Rahmen
     *   1006       gar nicht erst zustande gekommen: kein Handschlag, kein
     *              Zertifikat, keine Antwort. Der häufigste bei falscher
     *              Adresse oder fehlender Route.
     *   1008/1011  der Server hat abgewiesen oder ist gestolpert
     */
    socket.onclose = (event) => {
      this.stopPinging();
      const grund = event.reason ? `${event.code} ${event.reason}` : String(event.code);
      if (!this.disposed) {
        console.warn(`[netz] Leitung zu (${grund}) — ${this.url}`);
      }
      if (this.disposed) return;
      this.setStatus('getrennt', `Code ${grund}`);
      if (!this.closedByUs) this.scheduleRetry();
    };

    socket.onerror = () => {
      // `onclose` folgt ohnehin und bringt den Schliesscode mit — hier nur
      // nicht zusätzlich in die Konsole schreien.
    };
  }

  private scheduleRetry(): void {
    const delay = RETRY_DELAYS[Math.min(this.retries, RETRY_DELAYS.length - 1)]!;
    this.retries++;
    this.setStatus('getrennt', `neuer Versuch in ${Math.round(delay / 1000)} s`);
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private startPinging(): void {
    this.stopPinging();
    this.pingTimer = window.setInterval(() => {
      this.send(encodePing(performance.now()));
      // Sofort verschicken, nicht nur einreihen.
      //
      // Sonst haengt das Lebenszeichen an der Renderschleife, und die friert
      // ein, sobald der Tab in den Hintergrund geht: der Browser stellt
      // requestAnimationFrame dort ein. Die Pings liefen dann in die
      // Warteschlange, der Server sah dreissig Sekunden lang nichts und warf
      // die Sitzung — bei einem Spiel, das im Hintergrund einfach
      // weiterlaufen soll, die unangenehmste Art zu scheitern.
      this.flush();
    }, 3000);
  }

  private stopPinging(): void {
    if (this.pingTimer !== undefined) window.clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private handleFrame(data: Uint8Array): void {
    if (this.disposed) return;
    const frame = decodeFrame(data, this.suite);
    for (const raw of frame.packets) {
      const { opcode, reader } = readPacket(raw);
      switch (opcode) {
        case ServerOp.Welcome:
          this.handlers.onWelcome?.(decodeWelcome(reader));
          break;
        case ServerOp.Snapshot:
          this.handlers.onSnapshot?.(decodeSnapshot(reader));
          break;
        case ServerOp.MapChange:
          this.handlers.onMapChange?.(decodeMapChange(reader));
          break;
        case ServerOp.CombatEvent:
          this.handlers.onCombat?.(decodeCombatEvent(reader));
          break;
        case ServerOp.Chat:
          this.handlers.onChat?.(decodeServerChat(reader));
          break;
        case ServerOp.Version:
          this.handlers.onVersion?.(decodeServerVersion(reader));
          break;
        case ServerOp.Emote: {
          const { entityId, kind } = decodeEmote(reader);
          this.handlers.onEmote?.(entityId, kind);
          break;
        }
        case ServerOp.SkillCast: {
          const { entityId, skillId } = decodeSkillCast(reader);
          this.handlers.onSkillCast?.(entityId, skillId);
          break;
        }
        case ServerOp.Realms:
          this.handlers.onRealms?.(decodeRealms(reader));
          break;
        case ServerOp.Lobby:
          this.handlers.onLobby?.(decodeLobby(reader));
          break;
        case ServerOp.LobbyError:
          this.handlers.onLobbyError?.(decodeLobbyError(reader).text);
          break;
        case ServerOp.Stats:
          this.handlers.onStats?.(decodeStats(reader));
          break;
        case ServerOp.Inventory:
          this.handlers.onInventory?.(decodeInventory(reader));
          break;
        case ServerOp.NpcDialog:
          this.handlers.onNpcDialog?.(decodeNpcDialog(reader));
          break;
        case ServerOp.QuestLog:
          this.handlers.onQuestLog?.(decodeQuestLog(reader));
          break;
        case ServerOp.Pong: {
          const { clientTime } = decodePong(reader);
          const rtt = performance.now() - clientTime;
          // Gleitender Mittelwert: eine einzelne Ausreißermessung soll die
          // Anzeige nicht springen lassen.
          this.latency = this.latency === 0 ? rtt : this.latency * 0.8 + rtt * 0.2;
          this.setStatus('verbunden', `${Math.round(this.latency)} ms`);
          break;
        }
        case ServerOp.Kick: {
          const { reason, message } = decodeKick(reader);
          // Nach einem Rauswurf wird normalerweise nicht neu verbunden — bei
          // falscher Protokollversion oder abgelehnter Anmeldung waere jeder
          // weitere Versuch derselbe Fehlschlag.
          //
          // Zeitablauf und Serverneustart sind anders: das sind Zustaende, die
          // von selbst vergehen. Dort darf der Client es wieder versuchen.
          const recoverable = reason === KickReason.Timeout || reason === KickReason.ServerShutdown;
          this.closedByUs = !recoverable;
          this.handlers.onKick?.(reason, message);
          break;
        }
        default:
          break;
      }
    }
  }

  private setStatus(status: ConnectionStatus, detail?: string): void {
    if (this.disposed) return;
    this.status = status;
    this.handlers.onStatus?.(status, detail);
  }

  // --- Senden --------------------------------------------------------------

  private send(packet: Uint8Array): void {
    this.outgoing.push(packet);
  }

  sendInput(msg: InputMsg): void {
    this.send(encodeInput(msg));
  }

  sendChat(text: string, channel = 1): void {
    this.send(encodeClientChat(channel, text));
  }

  /** Anmelden. Die Antwort kommt über `onLobby` oder `onLobbyError`. */
  sendLogin(name: string, password: string): void {
    this.send(encodeLogin({ name, password }));
  }

  /** Konto anlegen. Bei Erfolg ist man damit auch angemeldet. */
  sendCreateAccount(name: string, password: string): void {
    this.send(encodeCreateAccount({ name, password }));
  }

  sendCreateCharacter(name: string): void {
    this.send(encodeCreateCharacter(name));
  }

  sendDeleteCharacter(characterId: number): void {
    this.send(encodeDeleteCharacter(characterId));
  }

  sendEnterWorld(characterId: number): void {
    this.send(encodeEnterWorld(characterId));
  }

  /** Zurück in die Verwaltung — die Figur verlässt die Welt. */
  sendLeaveWorld(): void {
    this.send(encodeLeaveWorld());
  }

  sendMoveItem(from: number, to: number): void {
    this.send(encodeMoveItem(from, to));
  }

  /** Einen Gegenstand vor die Füsse legen. Er wird zu Beute wie jede andere. */
  sendDropItem(slot: number): void {
    this.send(encodeDropItem(slot));
    this.flush();
  }

  /** Einen Gegenstand vernichten. Sofort raus — der Mülleimer hat kein Zurück. */
  sendDestroyItem(slot: number): void {
    this.send(encodeDestroyItem(slot));
    this.flush();
  }

  /** Holt die Kanalliste neu — und damit eine frische Eintrittskarte. */
  sendRealmList(): void {
    this.send(encodeRealmList());
    this.flush();
  }

  /** Fragt den Server nach seiner Fassung. Die Antwort kommt über `onVersion`. */
  sendVersionRequest(): void {
    this.send(encodeVersionRequest());
  }

  sendTarget(entityId: number): void {
    this.send(encodeSetTarget(entityId));
  }

  sendRespawn(): void {
    this.send(encodeRespawn());
  }

  /** Anlegen und Aufwerten meinen ein *Stück*, also den Platz im Beutel. */
  sendEquipItem(slot: number): void {
    this.send(encodeEquipItem(slot));
    this.flush();
  }

  sendUpgradeItem(slot: number): void {
    this.send(encodeUpgradeItem(slot));
    this.flush();
  }

  sendInteract(entityId: number): void {
    this.send(encodeInteract(entityId));
    this.flush();
  }

  /** Einen Beutehaufen aufheben. Der Server prüft Nähe und Anspruch. */
  sendPickupLoot(lootId: number): void {
    this.send(encodePickupLoot(lootId));
    this.flush();
  }

  /** Einen Verbrauchsgegenstand benutzen. Über den Platz, wie beim Anlegen. */
  sendUseItem(slot: number): void {
    this.send(encodeUseItem(slot));
    this.flush();
  }

  /**
   * Eine Fertigkeit wirken. Sofort raus, nicht erst im nächsten Frame:
   * Fertigkeiten haben Abklingzeiten, und ein halber Frame Verzug ist der
   * Unterschied zwischen „gedrückt" und „zu früh gedrückt".
   */
  sendUseSkill(skillId: string): void {
    this.send(encodeUseSkill(skillId));
    this.flush();
  }

  sendQuestAction(questId: string, action: number): void {
    this.send(encodeQuestAction(questId, action));
    this.flush();
  }

  sendShopTrade(mode: number, itemId: string, count: number, slot = 0): void {
    this.send(encodeShopTrade(mode, itemId, count, slot));
    this.flush();
  }

  sendUsePortal(portalId: string): void {
    this.send(encodeUsePortal(portalId));
    // Sofort raus: ein Tastendruck soll nicht bis zum nächsten Bild warten.
    this.flush();
  }

  /**
   * Verschickt alles Aufgelaufene als einen Frame.
   *
   * Wird aus der Renderschleife gerufen — und zusaetzlich vom Ping-Zeitgeber,
   * damit die Verbindung auch dann lebt, wenn nicht gezeichnet wird.
   */
  flush(): void {
    if (this.outgoing.length === 0) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.outgoing.length = 0;
      return;
    }
    const frame = encodeFrame(this.outgoing, this.txSeq.next(), this.cipher);
    this.outgoing.length = 0;
    this.socket.send(frame);
  }

  close(): void {
    this.disposed = true;
    this.closedByUs = true;
    this.stopPinging();
    if (this.retryTimer !== undefined) window.clearTimeout(this.retryTimer);
    this.socket?.close(1000, 'client');
  }
}
