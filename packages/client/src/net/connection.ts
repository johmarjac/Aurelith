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
  decodeFrame,
  decodeInventory,
  decodeKick,
  decodeMapChange,
  decodePong,
  decodeServerChat,
  decodeSnapshot,
  decodeStats,
  decodeWelcome,
  encodeClientChat,
  encodeFrame,
  encodeHello,
  encodeInput,
  encodePing,
  encodeRespawn,
  encodeEquipItem,
  encodeSetTarget,
  encodeUsePortal,
  nullCipher,
  readPacket,
  type ChatMsg,
  type CombatEventMsg,
  type InputMsg,
  type InventoryRow,
  type MapChangeMsg,
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
  onKick?: (reason: number, message: string) => void;
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
    private readonly accountName: string,
    private readonly handlers: ConnectionHandlers,
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
      this.send(
        encodeHello({
          protocolVersion: PROTOCOL_VERSION,
          clientBuild: BUILD,
          accountName: this.accountName,
          token: '',
          // Heute beherrschen wir nur Klartext. Die Liste existiert, damit die
          // Aushandlung später keine Protokolländerung braucht.
          supportedCiphers: [0],
        }),
      );
      this.flush();
      this.setStatus('verbunden');
      this.startPinging();
    };

    socket.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      try {
        this.handleFrame(new Uint8Array(event.data));
      } catch (err) {
        console.error('[netz] Frame nicht lesbar:', err);
      }
    };

    socket.onclose = () => {
      this.stopPinging();
      if (this.disposed) return;
      this.setStatus('getrennt');
      if (!this.closedByUs) this.scheduleRetry();
    };

    socket.onerror = () => {
      // `onclose` folgt ohnehin — hier nur nicht in die Konsole schreien.
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
        case ServerOp.Stats:
          this.handlers.onStats?.(decodeStats(reader));
          break;
        case ServerOp.Inventory:
          this.handlers.onInventory?.(decodeInventory(reader));
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

  sendTarget(entityId: number): void {
    this.send(encodeSetTarget(entityId));
  }

  sendRespawn(): void {
    this.send(encodeRespawn());
  }

  sendEquipItem(itemId: string): void {
    this.send(encodeEquipItem(itemId));
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
