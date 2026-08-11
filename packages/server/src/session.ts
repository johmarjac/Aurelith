/**
 * Eine Verbindung. Kennt Frames, Pakete und den Charakter dahinter — aber
 * keine Spielregeln. Die stehen im GameServer.
 */

import type { WebSocket } from 'ws';
import {
  CipherSuite,
  FrameSequencer,
  encodeFrame,
  nullCipher,
  type InputMsg,
  type PacketCipher,
} from '@aurelith/shared';
import type { CharacterRecord, ItemRecord } from './db/index.ts';

export type SessionState = 'handshake' | 'playing' | 'closed';

export class Session {
  state: SessionState = 'handshake';

  /** Kennung des Entities im Kern. Null, solange nicht eingeloggt. */
  entityId = 0;
  mapId = '';
  accountName = '';
  character?: CharacterRecord;
  items: ItemRecord[] = [];

  /** Letzte verarbeitete Eingabesequenz — Anker der Reconciliation im Client. */
  lastInputSeq = 0;
  /** Neueste Eingabe, die im nächsten Tick angewandt wird. */
  pendingInput?: InputMsg;

  /** Entities, von denen der Client bereits die vollständige Zeile hat. */
  readonly known = new Set<number>();

  /** Sekunden, bis das nächste Portal wieder greift. Verhindert Pendeln. */
  portalCooldown = 0;

  lastSeenAt = Date.now();
  /** Verbleibendes Eingabekontingent dieser Sekunde. */
  inputBudget: number;
  private budgetResetAt = Date.now() + 1000;

  private readonly outgoing: Uint8Array[] = [];
  private readonly txSeq = new FrameSequencer();
  private readonly suite = new CipherSuite();
  private cipher: PacketCipher = nullCipher;

  constructor(
    readonly id: number,
    private readonly ws: WebSocket,
    private readonly maxInputsPerSecond: number,
  ) {
    this.inputBudget = maxInputsPerSecond;
  }

  /**
   * Wechselt die Paketverschlüsselung. Heute immer die Null-Cipher; der Weg
   * dahin existiert, damit die Umstellung später eine Zeile ist und kein Umbau.
   */
  useCipher(cipher: PacketCipher): void {
    this.suite.register(cipher);
    this.cipher = cipher;
  }

  get cipherSuite(): CipherSuite {
    return this.suite;
  }

  /** Reiht ein Paket ein. Verschickt wird gesammelt am Ende des Ticks. */
  send(packet: Uint8Array): void {
    if (this.state === 'closed') return;
    this.outgoing.push(packet);
  }

  /** Schickt alle aufgelaufenen Pakete als einen Frame. */
  flush(): void {
    if (this.outgoing.length === 0 || this.state === 'closed') return;
    if (this.ws.readyState !== this.ws.OPEN) {
      this.outgoing.length = 0;
      return;
    }

    const frame = encodeFrame(this.outgoing, this.txSeq.next(), this.cipher);
    this.outgoing.length = 0;
    this.ws.send(frame);
  }

  /** Prüft und verbraucht das Eingabekontingent. */
  consumeInputBudget(): boolean {
    const now = Date.now();
    if (now >= this.budgetResetAt) {
      this.inputBudget = this.maxInputsPerSecond;
      this.budgetResetAt = now + 1000;
    }
    if (this.inputBudget <= 0) return false;
    this.inputBudget--;
    return true;
  }

  close(code = 1000, reason = ''): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    try {
      this.ws.close(code, reason);
    } catch {
      // Bereits zu — nichts zu tun.
    }
  }
}
