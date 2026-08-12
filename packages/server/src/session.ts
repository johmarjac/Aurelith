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
import { QuestBook } from './quests.ts';

export type SessionState = 'handshake' | 'playing' | 'closed';

/**
 * Wie viele unverarbeitete Eingaben höchstens gepuffert werden.
 *
 * Grosszügig, weil Verwerfen teurer ist als Warten: eine verworfene Eingabe
 * lässt die Figur im Client zurückspringen, eine gepufferte kostet nur einen
 * Tick Verzögerung. Sechzehn Ticks sind acht Zehntelsekunden — mehr Rückstand
 * als das hat kein Jitter, sondern ein Client, der zu schnell sendet.
 */
const MAX_INPUT_QUEUE = 16;

/**
 * Ab dieser Länge wird der Rückstand schneller abgebaut.
 *
 * Sonst bliebe ein einmaliger Burst als dauerhafte Verzögerung stehen: die
 * Schlange schrumpft nie, weil je Tick genau eine Eingabe hinzukommt und eine
 * verarbeitet wird.
 */
export const INPUT_QUEUE_DRAIN_AT = 4;
/** Wie viele Eingaben dann höchstens je Tick verarbeitet werden. */
export const INPUT_QUEUE_DRAIN_MAX = 3;

export class Session {
  state: SessionState = 'handshake';

  /** Kennung des Entities im Kern. Null, solange nicht eingeloggt. */
  entityId = 0;
  mapId = '';
  accountName = '';
  character?: CharacterRecord;
  items: ItemRecord[] = [];
  /** Auftragsstand. Leer, solange nicht eingeloggt. */
  readonly quests = new QuestBook();
  /**
   * Hat sich seit dem letzten Speichern etwas an Beutel oder Aufträgen getan?
   *
   * Beides wird ersetzend geschrieben, und das ist teurer als ein
   * Positionsupdate. Ohne die Merke schriebe der Server alle dreissig Sekunden
   * dreissig Inventarzeilen neu, auch wenn niemand etwas angefasst hat.
   */
  itemsDirty = false;
  questsDirty = false;

  /** Letzte verarbeitete Eingabesequenz — Anker der Reconciliation im Client. */
  lastInputSeq = 0;
  /**
   * Eingaben, die noch nicht verarbeitet sind — in der Reihenfolge, in der sie
   * gesendet wurden.
   *
   * Hier stand vorher ein einzelner Platz, in dem immer nur die *neueste*
   * Eingabe lag. Das war der Grund, warum die eigene Figur beim Laufen
   * gelegentlich zurücksprang: der Client rechnet jede Eingabe, der Server nahm
   * aber nur eine je Tick, und was in derselben Lücke ankam, fiel heraus.
   * Zwanzig Eingaben je Sekunde treffen auf zwanzig Ticks je Sekunde — im
   * Mittel passt das, aber Netzjitter schiebt regelmässig zwei in dieselbe
   * Lücke und keine in die nächste. Jede verworfene Eingabe ist ein
   * Simulationsschritt Unterschied, und nach ein paar Sekunden reicht die
   * Summe über die Korrekturschwelle.
   *
   * Als Warteschlange geht nichts verloren: der Burst wird gepuffert, die Lücke
   * danach zehrt ihn auf.
   */
  readonly inputQueue: InputMsg[] = [];

  /** Entities, von denen der Client bereits die vollständige Zeile hat. */
  readonly known = new Set<number>();

  /**
   * Nimmt eine Eingabe entgegen.
   *
   * Verspätete und doppelte werden verworfen — sie würden die Figur
   * zurückwerfen. Die Länge ist gedeckelt: ein Client, der dauerhaft schneller
   * sendet, als der Server tickt, soll nicht unbegrenzt Verzögerung anhäufen.
   */
  queueInput(input: InputMsg): void {
    if (input.seq <= this.lastInputSeq) return;
    const last = this.inputQueue[this.inputQueue.length - 1];
    if (last && input.seq <= last.seq) return;

    this.inputQueue.push(input);
    if (this.inputQueue.length > MAX_INPUT_QUEUE) this.inputQueue.shift();
  }

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
