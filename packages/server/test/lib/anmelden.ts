/**
 * Der Weg in die Welt, für Prüfungen, die das Protokoll sprechen.
 *
 * Gruss, Konto anlegen, Figur anlegen, betreten — vier Pakete, die jeder
 * Protokolltest braucht und keiner unterschiedlich machen sollte. Stünde der
 * Ablauf in jedem Test noch einmal, wäre jede Änderung am Anmeldeweg eine
 * Änderung an fünf Dateien, und eine davon bliebe zurück.
 */

import type { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  ServerOp,
  decodeFrame,
  decodeLobby,
  decodeLobbyError,
  encodeCreateAccount,
  encodeCreateCharacter,
  encodeEnterWorld,
  encodeFrame,
  encodeHello,
  encodeLogin,
  nullCipher,
  readPacket,
  type CipherSuite,
  type FrameSequencer,
  type LobbyMsg,
} from '@aurelith/shared';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface Anmeldung {
  /** Der Stand der Verwaltung nach dem letzten Paket. */
  lobby(): LobbyMsg | undefined;
  /** Die letzte Absage — nützlich für Prüfungen, die eine erwarten. */
  fehler(): string | undefined;
  /** Setzt beides zurück, damit die nächste Antwort eindeutig ist. */
  vergiss(): void;
}

/**
 * Hängt sich in die Nachrichten und merkt sich Verwaltungsantworten.
 *
 * Der Aufrufer behält seinen eigenen `onmessage`-Handler — dieser hier hört
 * zusätzlich zu, statt ihn zu ersetzen.
 */
export function beobachteLobby(socket: WebSocket, suite: CipherSuite): Anmeldung {
  let lobby: LobbyMsg | undefined;
  let fehler: string | undefined;

  socket.on('message', (data: ArrayBuffer | Buffer) => {
    const bytes = data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data);
    for (const raw of decodeFrame(bytes, suite).packets) {
      const { opcode, reader } = readPacket(raw);
      if (opcode === ServerOp.Lobby) lobby = decodeLobby(reader);
      if (opcode === ServerOp.LobbyError) fehler = decodeLobbyError(reader).text;
    }
  });

  return {
    lobby: () => lobby,
    fehler: () => fehler,
    vergiss: () => {
      lobby = undefined;
      fehler = undefined;
    },
  };
}

/**
 * Meldet ein frisches Konto an, legt eine Figur an und betritt die Welt.
 *
 * `send` kommt von aussen, weil jeder Test seine eigene Rahmenzählung führt.
 * Gewartet wird auf den Stand der Verwaltung und nicht auf eine feste Zeit:
 * scrypt braucht auf einem müden Rechner seine hundert Millisekunden, und ein
 * Test, der stattdessen eine Zahl schätzt, schlägt genau dort fehl.
 */
export async function anmeldenUndBetreten(
  send: (paket: Uint8Array) => void,
  beobachter: Anmeldung,
  name: string,
  passwort = 'pruefer-passwort',
): Promise<void> {
  send(encodeCreateAccount({ name, password: passwort }));
  const konto = await warteAufLobby(beobachter, 15000);
  if (!konto) throw new Error(`Konto ${name} nicht angelegt: ${beobachter.fehler() ?? 'stumm'}`);

  beobachter.vergiss();
  send(encodeCreateCharacter(name));
  const mitFigur = await warteAufLobby(beobachter, 15000);
  const figur = mitFigur?.characters[0];
  if (!figur) throw new Error(`Figur ${name} nicht angelegt: ${beobachter.fehler() ?? 'stumm'}`);

  send(encodeEnterWorld(figur.id));
}

/** Der erste Gruss. Ohne ihn nimmt der Server nichts weiter an. */
export function gruss(send: (paket: Uint8Array) => void, clientBuild = 'test'): void {
  send(encodeHello({ protocolVersion: PROTOCOL_VERSION, clientBuild, supportedCiphers: [0] }));
}

/** Meldet ein bestehendes Konto an. */
export function anmelden(
  send: (paket: Uint8Array) => void,
  name: string,
  passwort: string,
): void {
  send(encodeLogin({ name, password: passwort }));
}

/** Baut ein Frame — dieselbe Zeile in jedem Test, einmal aufgeschrieben. */
export function rahme(
  socket: WebSocket,
  seq: FrameSequencer,
): (...pakete: Uint8Array[]) => void {
  return (...pakete: Uint8Array[]) => {
    socket.send(encodeFrame(pakete, seq.next(), nullCipher));
  };
}

async function warteAufLobby(
  beobachter: Anmeldung,
  ms: number,
): Promise<LobbyMsg | undefined> {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    const stand = beobachter.lobby();
    if (stand) return stand;
    if (beobachter.fehler()) return undefined;
    await sleep(50);
  }
  return undefined;
}
