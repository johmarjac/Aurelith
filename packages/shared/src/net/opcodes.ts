/**
 * Opcodes. Client→Server unter 0x80, Server→Client ab 0x80 — dadurch fällt
 * ein in die falsche Richtung geschicktes Paket sofort auf.
 *
 * Die Nummern sind Teil des Vertrags: bestehende Werte werden nie neu belegt,
 * neue Pakete bekommen die nächste freie Nummer, und wenn sich ein Rumpf
 * ändert, zählt PROTOCOL_VERSION hoch.
 */

export const PROTOCOL_VERSION = 10;

export const ClientOp = {
  Hello: 0x01,
  Input: 0x02,
  Ping: 0x03,
  Chat: 0x04,
  UsePortal: 0x05,
  SetTarget: 0x06,
  Respawn: 0x07,
  /** Einen Gegenstand anlegen oder ablegen. */
  EquipItem: 0x08,
  /** Einen NPC ansprechen. */
  Interact: 0x09,
  /** Auftrag annehmen, abgeben oder aufgeben. */
  QuestAction: 0x0a,
  /** Beim Händler kaufen oder verkaufen. */
  ShopTrade: 0x0b,
  /** Einen Gegenstand beim Schmied aufwerten. */
  UpgradeItem: 0x0c,
  /** Beute vom Boden aufheben. */
  PickupLoot: 0x0d,
  /** Einen Verbrauchsgegenstand benutzen. */
  UseItem: 0x0e,
  /** Frage nach der Fassung des Servers. Antwort: `ServerOp.Version`. */
  VersionRequest: 0x0f,
  /** Einen Gegenstand im Beutel auf einen anderen Platz legen. */
  MoveItem: 0x10,
  /** Anmeldung mit Name und Passwort. Antwort: `Lobby` oder `LobbyError`. */
  Login: 0x11,
  /** Neues Konto anlegen. Bei Erfolg ist man damit auch angemeldet. */
  CreateAccount: 0x12,
  /** Einen Charakter anlegen. */
  CreateCharacter: 0x13,
  /** Einen Charakter löschen. */
  DeleteCharacter: 0x14,
  /** Mit einem Charakter in die Welt. */
  EnterWorld: 0x15,
  /** Zurück in die Charakterverwaltung — die Figur verlässt die Welt. */
  LeaveWorld: 0x16,
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
  /** Antwort auf `Interact`: wer da steht und was er anzubieten hat. */
  NpcDialog: 0x8a,
  /** Der vollständige Auftragsstand des Spielers. */
  QuestLog: 0x8b,
  /** Antwort auf `VersionRequest`: Buildnummer und Bauzeitpunkt. */
  Version: 0x8c,
  /** Kontostand der Verwaltung: wer man ist und welche Figuren es gibt. */
  Lobby: 0x8d,
  /**
   * Was an einer Anmeldung oder einer Figurenänderung nicht ging.
   *
   * Kein Kick: eine falsche Eingabe beendet keine Verbindung, sie wird
   * korrigiert. Der Text ist für Menschen und benennt bewusst nicht, ob Name
   * oder Passwort falsch war — sonst liesse sich damit prüfen, welche Konten
   * es gibt.
   */
  LobbyError: 0x8e,
  /**
   * Eine Geste einer Figur — etwas, das man **sieht** und das die Simulation
   * nicht berührt.
   *
   * Aufheben ist keine Bewegung und kein Schlag: der Kern kennt es nicht, und
   * er soll es auch nicht kennen. Trotzdem sollen die Umstehenden sehen, wie
   * sich jemand nach etwas bückt.
   */
  Emote: 0x8f,
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
  /**
   * Der Treffer kam aus der Ferne.
   *
   * Der Client zeichnet daraufhin einen Pfeil vom Angreifer zum Ziel. Reine
   * Anzeige — der Schaden ist in dem Moment schon gefallen.
   */
  Ranged: 1 << 3,
} as const;
