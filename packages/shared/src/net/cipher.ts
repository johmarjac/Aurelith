/**
 * Paketverschlüsselung.
 *
 * Stand heute läuft alles im Klartext (`CipherId.None`). Die Schicht existiert
 * trotzdem schon, weil sie sich nachträglich nicht mehr sauber einziehen lässt:
 * die Cipher-ID steht im Frame-Header, beide Seiten handeln sie beim Handshake
 * aus, und der Rest des Codes kennt nur das Interface.
 *
 * Zwei Ausbaustufen sind vorgesehen:
 *
 *   1. Transportverschlüsselung über `wss://` — kostet keine Codeänderung,
 *      nur eine andere URL. Das ist die Stufe, die tatsächlich Sicherheit
 *      liefert.
 *   2. Paketverschlüsselung über diese Schnittstelle — XOR-Stream als
 *      einfachster Fall, austauschbar gegen etwas Ernsthaftes.
 *
 * Wichtig, damit hier keine falsche Erwartung entsteht: ein XOR-Stream ist
 * Verschleierung, keine Kryptografie. Er erschwert triviales Mitlesen und
 * naives Paket-Basteln. Der Schutz gegen Manipulation liegt bei uns
 * ausschließlich in der Server-Autorität — genau wie im Blueprint festgehalten.
 */

export const CipherId = {
  None: 0,
  XorStream: 1,
} as const;
export type CipherId = (typeof CipherId)[keyof typeof CipherId];

export interface PacketCipher {
  readonly id: CipherId;
  /**
   * Symmetrische Transformation der Frame-Nutzlast. `seq` ist die
   * Frame-Sequenznummer der jeweiligen Richtung und dient als Nonce, damit
   * gleiche Klartexte nicht gleiche Chiffrate ergeben.
   *
   * Darf `payload` in-place verändern und zurückgeben.
   */
  apply(payload: Uint8Array, seq: number): Uint8Array;
}

export const nullCipher: PacketCipher = {
  id: CipherId.None,
  apply(payload) {
    return payload;
  },
};

/**
 * XOR gegen einen aus Schlüssel und Sequenznummer abgeleiteten Keystream.
 * Symmetrisch — dieselbe Funktion ver- und entschlüsselt.
 */
export function createXorStreamCipher(key: Uint8Array): PacketCipher {
  if (key.length === 0) throw new Error('XOR-Cipher braucht einen Schlüssel');

  // Schlüssel auf einen 32-Bit-Startwert falten.
  let keySeed = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    keySeed ^= key[i]!;
    keySeed = Math.imul(keySeed, 0x01000193) >>> 0;
  }

  return {
    id: CipherId.XorStream,
    apply(payload, seq) {
      let state = (keySeed ^ Math.imul(seq + 1, 0x9e3779b9)) >>> 0;
      for (let i = 0; i < payload.length; i++) {
        // xorshift32 — ein Byte pro Runde, ausreichend schnell für unsere Frames.
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        payload[i] = payload[i]! ^ (state & 0xff);
      }
      return payload;
    },
  };
}

/** Registry, damit die Gegenseite eine im Header angekündigte Cipher auflösen kann. */
export class CipherSuite {
  private readonly byId = new Map<number, PacketCipher>([[CipherId.None, nullCipher]]);

  register(cipher: PacketCipher): void {
    this.byId.set(cipher.id, cipher);
  }

  resolve(id: number): PacketCipher | undefined {
    return this.byId.get(id);
  }
}
