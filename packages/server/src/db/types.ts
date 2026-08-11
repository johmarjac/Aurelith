/**
 * Persistenzschnittstelle. Zwei Implementierungen: PostgreSQL für den Betrieb,
 * ein Speicher-Backend für den Fall, dass keine Datenbank konfiguriert ist.
 *
 * Der Rest des Servers kennt nur dieses Interface — es gibt keine Stelle, an
 * der SQL außerhalb von `postgres.ts` steht.
 */

export interface CharacterRecord {
  id: number;
  accountId: number;
  name: string;
  level: number;
  exp: number;
  gold: number;
  hp: number;
  mp: number;
  mapId: string;
  x: number;
  z: number;
  yaw: number;
}

export interface ItemRecord {
  itemId: string;
  count: number;
  slot: number;
  equipped: boolean;
}

export interface LoginResult {
  character: CharacterRecord;
  items: ItemRecord[];
  /** Wahr, wenn der Charakter in diesem Aufruf neu angelegt wurde. */
  created: boolean;
}

export interface SpawnPoint {
  mapId: string;
  x: number;
  z: number;
  yaw: number;
}

export interface GameStore {
  readonly kind: 'postgres' | 'memory';
  init(): Promise<void>;
  close(): Promise<void>;
  /**
   * Meldet ein Konto an und legt es samt Startcharakter an, falls es noch
   * nicht existiert. Ein Konto hat vorerst genau einen Charakter — die
   * Charakterauswahl kommt später und ändert nur diese Methode.
   */
  loginOrCreate(accountName: string, spawn: SpawnPoint): Promise<LoginResult>;
  saveCharacter(character: CharacterRecord): Promise<void>;
  saveInventory(characterId: number, items: ItemRecord[]): Promise<void>;
}
