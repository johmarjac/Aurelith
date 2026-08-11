/**
 * Aurelith-Frame — unser eigenes Rahmenformat auf dem WebSocket.
 *
 * Warum überhaupt ein eigener Rahmen, wo WebSocket doch schon Nachrichten
 * abgrenzt? Weil wir drei Dinge brauchen, die WebSocket nicht liefert:
 * eine Versionsnummer, die einen Fehlerfall früh und eindeutig macht; eine
 * Sequenznummer, die später als Nonce für die Paketverschlüsselung dient; und
 * die Möglichkeit, mehrere Pakete eines Ticks zu einem Frame zusammenzufassen,
 * statt pro Paket einen WebSocket-Rahmen zu bezahlen.
 *
 * Aufbau (Header 8 Byte, Little-Endian):
 *
 *   +0  u8   Magic        0xAE
 *   +1  u8   Version      FRAME_VERSION
 *   +2  u8   Flags        Bit 0 = Nutzlast komprimiert (reserviert)
 *   +3  u8   Cipher       CipherId der Nutzlast
 *   +4  u16  Sequenz      je Richtung fortlaufend, läuft über
 *   +6  u16  Länge        Nutzlastlänge in Byte (nach Verschlüsselung)
 *   +8  ...  Nutzlast
 *
 * Die Nutzlast ist eine Folge von Paketen, jedes seinerseits
 * `u16 Größe` + `u8 Opcode` + Rumpf. Die Größe schließt den Opcode ein.
 */

import { ByteReader, ByteWriter } from './bytes.ts';
import { CipherId, type CipherSuite, type PacketCipher, nullCipher } from './cipher.ts';

export const FRAME_MAGIC = 0xae;
export const FRAME_VERSION = 1;
export const FRAME_HEADER_SIZE = 8;

/** Obergrenze der Nutzlast — durch das u16-Längenfeld vorgegeben. */
export const MAX_FRAME_PAYLOAD = 0xffff;

export const FrameFlags = {
  None: 0,
  /** Reserviert: Nutzlast ist komprimiert. Noch nicht implementiert. */
  Compressed: 1 << 0,
} as const;

export const FrameErrorCode = {
  TooShort: 'frame.too_short',
  BadMagic: 'frame.bad_magic',
  BadVersion: 'frame.bad_version',
  UnknownCipher: 'frame.unknown_cipher',
  LengthMismatch: 'frame.length_mismatch',
  BadPacketLength: 'frame.bad_packet_length',
  PayloadTooLarge: 'frame.payload_too_large',
  UnsupportedFlags: 'frame.unsupported_flags',
} as const;
export type FrameErrorCode = (typeof FrameErrorCode)[keyof typeof FrameErrorCode];

export class FrameError extends Error {
  constructor(
    readonly code: FrameErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FrameError';
  }
}

export interface DecodedFrame {
  version: number;
  flags: number;
  seq: number;
  /** Je Eintrag ein vollständiges Paket, beginnend mit dem Opcode-Byte. */
  packets: Uint8Array[];
}

/**
 * Baut aus einer Reihe fertiger Pakete einen Frame.
 * Die Pakete enthalten bereits ihr Opcode-Byte an Position 0.
 */
export function encodeFrame(
  packets: readonly Uint8Array[],
  seq: number,
  cipher: PacketCipher = nullCipher,
  flags: number = FrameFlags.None,
): Uint8Array {
  let payloadSize = 0;
  for (const p of packets) payloadSize += 2 + p.length;
  if (payloadSize > MAX_FRAME_PAYLOAD) {
    throw new FrameError(
      FrameErrorCode.PayloadTooLarge,
      `Nutzlast ${payloadSize} Byte überschreitet ${MAX_FRAME_PAYLOAD}`,
    );
  }

  const out = new Uint8Array(FRAME_HEADER_SIZE + payloadSize);
  const view = new DataView(out.buffer);

  // Nutzlast zuerst zusammensetzen — sie wird danach als Ganzes verschlüsselt.
  let off = FRAME_HEADER_SIZE;
  for (const p of packets) {
    view.setUint16(off, p.length, true);
    off += 2;
    out.set(p, off);
    off += p.length;
  }

  const payload = out.subarray(FRAME_HEADER_SIZE);
  cipher.apply(payload, seq);

  view.setUint8(0, FRAME_MAGIC);
  view.setUint8(1, FRAME_VERSION);
  view.setUint8(2, flags);
  view.setUint8(3, cipher.id);
  view.setUint16(4, seq & 0xffff, true);
  view.setUint16(6, payloadSize, true);

  return out;
}

/** Bequemlichkeit für den häufigen Fall genau eines Pakets. */
export function encodeSingleFrame(
  packet: Uint8Array,
  seq: number,
  cipher: PacketCipher = nullCipher,
): Uint8Array {
  return encodeFrame([packet], seq, cipher);
}

export function decodeFrame(data: Uint8Array, suite?: CipherSuite): DecodedFrame {
  if (data.length < FRAME_HEADER_SIZE) {
    throw new FrameError(
      FrameErrorCode.TooShort,
      `Frame hat ${data.length} Byte, mindestens ${FRAME_HEADER_SIZE} nötig`,
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = view.getUint8(0);
  if (magic !== FRAME_MAGIC) {
    throw new FrameError(
      FrameErrorCode.BadMagic,
      `Magic 0x${magic.toString(16)} statt 0x${FRAME_MAGIC.toString(16)}`,
    );
  }

  const version = view.getUint8(1);
  if (version !== FRAME_VERSION) {
    throw new FrameError(
      FrameErrorCode.BadVersion,
      `Frame-Version ${version}, erwartet ${FRAME_VERSION}`,
    );
  }

  const flags = view.getUint8(2);
  if ((flags & ~FrameFlags.Compressed) !== 0) {
    throw new FrameError(FrameErrorCode.UnsupportedFlags, `Unbekannte Flags 0x${flags.toString(16)}`);
  }
  if ((flags & FrameFlags.Compressed) !== 0) {
    throw new FrameError(
      FrameErrorCode.UnsupportedFlags,
      'Komprimierte Frames sind noch nicht implementiert',
    );
  }

  const cipherId = view.getUint8(3);
  const cipher = cipherId === CipherId.None ? nullCipher : suite?.resolve(cipherId);
  if (!cipher) {
    throw new FrameError(FrameErrorCode.UnknownCipher, `Cipher ${cipherId} ist nicht registriert`);
  }

  const seq = view.getUint16(4, true);
  const payloadSize = view.getUint16(6, true);
  if (FRAME_HEADER_SIZE + payloadSize !== data.length) {
    throw new FrameError(
      FrameErrorCode.LengthMismatch,
      `Header meldet ${payloadSize} Byte Nutzlast, Frame hat ${data.length - FRAME_HEADER_SIZE}`,
    );
  }

  // Kopieren, weil die Cipher in-place arbeitet und der Eingangspuffer dem
  // Aufrufer gehört.
  const payload = data.slice(FRAME_HEADER_SIZE);
  cipher.apply(payload, seq);

  const packets: Uint8Array[] = [];
  let off = 0;
  while (off < payload.length) {
    if (off + 2 > payload.length) {
      throw new FrameError(FrameErrorCode.BadPacketLength, 'Abgeschnittenes Paket-Längenfeld');
    }
    const size = payload[off]! | (payload[off + 1]! << 8);
    off += 2;
    if (size < 1 || off + size > payload.length) {
      throw new FrameError(
        FrameErrorCode.BadPacketLength,
        `Paketlänge ${size} passt nicht in die verbleibende Nutzlast`,
      );
    }
    packets.push(payload.subarray(off, off + size));
    off += size;
  }

  return { version, flags, seq, packets };
}

/**
 * Zählt Frames je Richtung. Client und Server halten je einen Sender- und
 * einen Empfängerzähler; der Empfängerzähler dient dazu, verlorene oder
 * doppelte Frames zu erkennen, sobald eine Cipher aktiv ist.
 */
export class FrameSequencer {
  private value = 0;

  next(): number {
    const v = this.value;
    this.value = (this.value + 1) & 0xffff;
    return v;
  }

  reset(): void {
    this.value = 0;
  }

  get current(): number {
    return this.value;
  }
}

/** Kleiner Helfer: Paket mit Opcode-Präfix beginnen. */
export function packet(opcode: number, capacity = 64): ByteWriter {
  return new ByteWriter(capacity).u8(opcode);
}

/** Gegenstück: Opcode lesen und einen Reader auf den Rumpf zurückgeben. */
export function readPacket(data: Uint8Array): { opcode: number; reader: ByteReader } {
  const reader = new ByteReader(data);
  return { opcode: reader.u8(), reader };
}
