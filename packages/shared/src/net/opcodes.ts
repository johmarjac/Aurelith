/**
 * Opcodes. Client→Server unter 0x80, Server→Client ab 0x80 — dadurch fällt
 * ein in die falsche Richtung geschicktes Paket sofort auf.
 *
 * Die Nummern sind Teil des Vertrags: bestehende Werte werden nie neu belegt,
 * neue Pakete bekommen die nächste freie Nummer, und wenn sich ein Rumpf
 * ändert, zählt PROTOCOL_VERSION hoch.
 */

export const PROTOCOL_VERSION = 1;

export const ClientOp = {
  Hello: 0x01,
  Input: 0x02,
  Ping: 0x03,
  Chat: 0x04,
  UsePortal: 0x05,
  SetTarget: 0x06,
  Respawn: 0x07,
} as const;
export type ClientOp = (typeof ClientOp)[keyof typeof ClientOp];

export const ServerOp = {
  Welcome: 0x81,
  Snapshot: 0x82,
  MapChange: 0x83,
  CombatEvent: 0x84,
  Chat: 0x85,
  Pong: 0x86,
  Kick: 0x87,
  Stats: 0x88,
  Inventory: 0x89,
} as const;
export type ServerOp = (typeof ServerOp)[keyof typeof ServerOp];

/** Bits im Input-Paket. */
export const InputButton = {
  Attack: 1 << 0,
  Jump: 1 << 1,
  Interact: 1 << 2,
  Sit: 1 << 3,
} as const;

export const ChatChannel = {
  System: 0,
  Say: 1,
  Shout: 2,
  Whisper: 3,
  Party: 4,
} as const;
export type ChatChannel = (typeof ChatChannel)[keyof typeof ChatChannel];

export const KickReason = {
  ProtocolMismatch: 0,
  BadFrame: 1,
  Timeout: 2,
  ServerShutdown: 3,
  AuthFailed: 4,
  RateLimited: 5,
} as const;
export type KickReason = (typeof KickReason)[keyof typeof KickReason];

export const CombatFlag = {
  None: 0,
  Critical: 1 << 0,
  Killing: 1 << 1,
  Miss: 1 << 2,
} as const;
