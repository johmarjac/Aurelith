/**
 * Kodierung der einzelnen Pakete. Jede Nachricht hat genau eine `encode`- und
 * genau eine `decode`-Funktion, und beide stehen direkt untereinander — das ist
 * die billigste Art, sie synchron zu halten.
 */

import type { ByteReader } from './bytes.ts';
import { packet } from './frame.ts';
import { ClientOp, ServerOp } from './opcodes.ts';
import type { EntityState, EntityType } from '../sim/types.ts';

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export interface HelloMsg {
  protocolVersion: number;
  /** Build-Kennung des Clients, dient nur der Diagnose. */
  clientBuild: string;
  accountName: string;
  /** Später ein echtes Sitzungstoken. Heute leer. */
  token: string;
  /** Cipher-IDs, die der Client beherrscht — Grundlage der Aushandlung. */
  supportedCiphers: number[];
}

export function encodeHello(m: HelloMsg): Uint8Array {
  const w = packet(ClientOp.Hello, 128);
  w.u16(m.protocolVersion).str(m.clientBuild).str(m.accountName).str(m.token);
  w.u8(m.supportedCiphers.length);
  for (const c of m.supportedCiphers) w.u8(c);
  return w.finish();
}

export function decodeHello(r: ByteReader): HelloMsg {
  const protocolVersion = r.u16();
  const clientBuild = r.str();
  const accountName = r.str();
  const token = r.str();
  const count = r.u8();
  const supportedCiphers: number[] = [];
  for (let i = 0; i < count; i++) supportedCiphers.push(r.u8());
  return { protocolVersion, clientBuild, accountName, token, supportedCiphers };
}

export interface InputMsg {
  seq: number;
  moveX: number;
  moveZ: number;
  yaw: number;
  buttons: number;
}

export function encodeInput(m: InputMsg): Uint8Array {
  // Bewegungsachsen als i8 in Hundertsteln: 2 Byte statt 8, und feiner als
  // jeder Joystick tatsächlich auflöst.
  return packet(ClientOp.Input, 16)
    .u32(m.seq)
    .i8(Math.round(Math.max(-1, Math.min(1, m.moveX)) * 100))
    .i8(Math.round(Math.max(-1, Math.min(1, m.moveZ)) * 100))
    .angle(m.yaw)
    .u8(m.buttons)
    .finish();
}

export function decodeInput(r: ByteReader): InputMsg {
  return {
    seq: r.u32(),
    moveX: r.i8() / 100,
    moveZ: r.i8() / 100,
    yaw: r.angle(),
    buttons: r.u8(),
  };
}

export function encodePing(clientTime: number): Uint8Array {
  return packet(ClientOp.Ping, 16).f64(clientTime).finish();
}

export function decodePing(r: ByteReader): { clientTime: number } {
  return { clientTime: r.f64() };
}

export interface ChatMsg {
  channel: number;
  from: string;
  text: string;
}

export function encodeClientChat(channel: number, text: string): Uint8Array {
  return packet(ClientOp.Chat, 256).u8(channel).str(text).finish();
}

export function decodeClientChat(r: ByteReader): { channel: number; text: string } {
  return { channel: r.u8(), text: r.str() };
}

/**
 * Bitte, einen Gegenstand anzulegen.
 *
 * Der Client sagt *welchen*; ob es geht, entscheidet der Server. Er prüft, ob
 * der Gegenstand überhaupt im Beutel liegt und ob die Stufe reicht — sonst
 * legte man sich per Paket an, was man nicht besitzt.
 */
export function encodeEquipItem(itemId: string): Uint8Array {
  return packet(ClientOp.EquipItem, 64).str(itemId).finish();
}

export function decodeEquipItem(r: ByteReader): { itemId: string } {
  return { itemId: r.str() };
}

export function encodeUsePortal(portalId: string): Uint8Array {
  return packet(ClientOp.UsePortal, 64).str(portalId).finish();
}

export function decodeUsePortal(r: ByteReader): { portalId: string } {
  return { portalId: r.str() };
}

export function encodeSetTarget(entityId: number): Uint8Array {
  return packet(ClientOp.SetTarget, 8).u32(entityId).finish();
}

export function decodeSetTarget(r: ByteReader): { entityId: number } {
  return { entityId: r.u32() };
}

export function encodeRespawn(): Uint8Array {
  return packet(ClientOp.Respawn, 4).finish();
}

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export interface WelcomeMsg {
  protocolVersion: number;
  entityId: number;
  mapId: string;
  tick: number;
  tickRate: number;
  snapshotRate: number;
  /** Ausgehandelte Cipher für nachfolgende Frames. */
  cipherId: number;
  serverTimeMs: number;
}

export function encodeWelcome(m: WelcomeMsg): Uint8Array {
  return packet(ServerOp.Welcome, 96)
    .u16(m.protocolVersion)
    .u32(m.entityId)
    .str(m.mapId)
    .u32(m.tick)
    .u8(m.tickRate)
    .u8(m.snapshotRate)
    .u8(m.cipherId)
    .f64(m.serverTimeMs)
    .finish();
}

export function decodeWelcome(r: ByteReader): WelcomeMsg {
  return {
    protocolVersion: r.u16(),
    entityId: r.u32(),
    mapId: r.str(),
    tick: r.u32(),
    tickRate: r.u8(),
    snapshotRate: r.u8(),
    cipherId: r.u8(),
    serverTimeMs: r.f64(),
  };
}

/** Vollständige Beschreibung eines neu sichtbaren Entities. */
export interface SpawnRow {
  id: number;
  type: EntityType;
  defId: string;
  name: string;
  level: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  maxHp: number;
  state: EntityState;
  /**
   * Was die Figur in der Hand hält — Schlüssel des Rigs, oder leer.
   *
   * Muss mit, weil sonst jede fremde Figur mit dem Schwert dasteht, das im
   * Modell voreingestellt ist. Ausrüstung ist sichtbar, also gehört sie in den
   * Snapshot.
   */
  weapon: string;
}

/** Laufende Aktualisierung eines bereits bekannten Entities. */
export interface UpdateRow {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  state: EntityState;
}

export interface SnapshotMsg {
  tick: number;
  /** Letzte vom Server verarbeitete Eingabesequenz — Anker der Reconciliation. */
  ackInputSeq: number;
  serverTimeMs: number;
  spawns: SpawnRow[];
  updates: UpdateRow[];
  despawns: number[];
}

export function encodeSnapshot(m: SnapshotMsg): Uint8Array {
  const w = packet(ServerOp.Snapshot, 1024);
  w.u32(m.tick).u32(m.ackInputSeq).f64(m.serverTimeMs);

  w.u16(m.spawns.length);
  for (const s of m.spawns) {
    w.u32(s.id)
      .u8(s.type)
      .str(s.defId)
      .str(s.name)
      .u16(s.level)
      .pos(s.x)
      .pos(s.y)
      .pos(s.z)
      .angle(s.yaw)
      .u32(Math.max(0, Math.round(s.hp)))
      .u32(Math.max(0, Math.round(s.maxHp)))
      .u8(s.state)
      .str(s.weapon);
  }

  w.u16(m.updates.length);
  for (const u of m.updates) {
    w.u32(u.id)
      .pos(u.x)
      .pos(u.y)
      .pos(u.z)
      .angle(u.yaw)
      .u32(Math.max(0, Math.round(u.hp)))
      .u8(u.state);
  }

  w.u16(m.despawns.length);
  for (const id of m.despawns) w.u32(id);

  return w.finish();
}

export function decodeSnapshot(r: ByteReader): SnapshotMsg {
  const tick = r.u32();
  const ackInputSeq = r.u32();
  const serverTimeMs = r.f64();

  const spawnCount = r.u16();
  const spawns: SpawnRow[] = new Array(spawnCount);
  for (let i = 0; i < spawnCount; i++) {
    spawns[i] = {
      id: r.u32(),
      type: r.u8() as EntityType,
      defId: r.str(),
      name: r.str(),
      level: r.u16(),
      x: r.pos(),
      y: r.pos(),
      z: r.pos(),
      yaw: r.angle(),
      hp: r.u32(),
      maxHp: r.u32(),
      state: r.u8() as EntityState,
      weapon: r.str(),
    };
  }

  const updateCount = r.u16();
  const updates: UpdateRow[] = new Array(updateCount);
  for (let i = 0; i < updateCount; i++) {
    updates[i] = {
      id: r.u32(),
      x: r.pos(),
      y: r.pos(),
      z: r.pos(),
      yaw: r.angle(),
      hp: r.u32(),
      state: r.u8() as EntityState,
    };
  }

  const despawnCount = r.u16();
  const despawns: number[] = new Array(despawnCount);
  for (let i = 0; i < despawnCount; i++) despawns[i] = r.u32();

  return { tick, ackInputSeq, serverTimeMs, spawns, updates, despawns };
}

export interface MapChangeMsg {
  mapId: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export function encodeMapChange(m: MapChangeMsg): Uint8Array {
  return packet(ServerOp.MapChange, 64)
    .str(m.mapId)
    .pos(m.x)
    .pos(m.y)
    .pos(m.z)
    .angle(m.yaw)
    .finish();
}

export function decodeMapChange(r: ByteReader): MapChangeMsg {
  return { mapId: r.str(), x: r.pos(), y: r.pos(), z: r.pos(), yaw: r.angle() };
}

export interface CombatEventMsg {
  attackerId: number;
  victimId: number;
  damage: number;
  flags: number;
  x: number;
  y: number;
  z: number;
}

export function encodeCombatEvent(m: CombatEventMsg): Uint8Array {
  return packet(ServerOp.CombatEvent, 32)
    .u32(m.attackerId)
    .u32(m.victimId)
    .u32(m.damage)
    .u8(m.flags)
    .pos(m.x)
    .pos(m.y)
    .pos(m.z)
    .finish();
}

export function decodeCombatEvent(r: ByteReader): CombatEventMsg {
  return {
    attackerId: r.u32(),
    victimId: r.u32(),
    damage: r.u32(),
    flags: r.u8(),
    x: r.pos(),
    y: r.pos(),
    z: r.pos(),
  };
}

export function encodeServerChat(m: ChatMsg): Uint8Array {
  return packet(ServerOp.Chat, 320).u8(m.channel).str(m.from).str(m.text).finish();
}

export function decodeServerChat(r: ByteReader): ChatMsg {
  return { channel: r.u8(), from: r.str(), text: r.str() };
}

export function encodePong(clientTime: number, serverTime: number): Uint8Array {
  return packet(ServerOp.Pong, 24).f64(clientTime).f64(serverTime).finish();
}

export function decodePong(r: ByteReader): { clientTime: number; serverTime: number } {
  return { clientTime: r.f64(), serverTime: r.f64() };
}

export function encodeKick(reason: number, message: string): Uint8Array {
  return packet(ServerOp.Kick, 128).u8(reason).str(message).finish();
}

export function decodeKick(r: ByteReader): { reason: number; message: string } {
  return { reason: r.u8(), message: r.str() };
}

export interface StatsMsg {
  level: number;
  exp: number;
  expForNext: number;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  gold: number;
  attackDamage: number;
  defense: number;
}

export function encodeStats(m: StatsMsg): Uint8Array {
  return packet(ServerOp.Stats, 48)
    .u16(m.level)
    .u32(m.exp)
    .u32(Number.isFinite(m.expForNext) ? m.expForNext : 0xffffffff)
    .u32(Math.round(m.hp))
    .u32(Math.round(m.maxHp))
    .u32(Math.round(m.mp))
    .u32(Math.round(m.maxMp))
    .u32(m.gold)
    .u16(Math.round(m.attackDamage))
    .u16(Math.round(m.defense))
    .finish();
}

export interface InventoryRow {
  itemId: string;
  count: number;
  slot: number;
  equipped: boolean;
}

/**
 * Das vollständige Inventar. Ein Teilabgleich wäre möglich, lohnt aber nicht:
 * dreißig Plätze sind unter einem Kilobyte, und Vollbilder können nicht
 * auseinanderlaufen.
 */
export function encodeInventory(rows: InventoryRow[]): Uint8Array {
  const w = packet(ServerOp.Inventory, 256);
  w.u16(rows.length);
  for (const row of rows) {
    w.str(row.itemId).u16(row.count).u16(row.slot).bool(row.equipped);
  }
  return w.finish();
}

export function decodeInventory(r: ByteReader): InventoryRow[] {
  const count = r.u16();
  const rows: InventoryRow[] = new Array(count);
  for (let i = 0; i < count; i++) {
    rows[i] = { itemId: r.str(), count: r.u16(), slot: r.u16(), equipped: r.bool() };
  }
  return rows;
}

export function decodeStats(r: ByteReader): StatsMsg {
  return {
    level: r.u16(),
    exp: r.u32(),
    expForNext: r.u32(),
    hp: r.u32(),
    maxHp: r.u32(),
    mp: r.u32(),
    maxMp: r.u32(),
    gold: r.u32(),
    attackDamage: r.u16(),
    defense: r.u16(),
  };
}
