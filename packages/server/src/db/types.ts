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
  /** Aufwertungsstufe, 0 bis 10. Stapelbares hat immer 0. */
  upgrade: number;
}

export interface QuestRecord {
  questId: string;
  /** `QuestStatus` aus dem geteilten Paket. */
  status: number;
  /** Fortschritt je Ziel, in der Reihenfolge der Definition. */
  progress: number[];
}

export interface AccountRecord {
  id: number;
  name: string;
  /** `scrypt$…` — siehe `passwords.ts`. Leer heisst: passt zu nichts. */
  passwordHash: string;
  /** Wort aus `ACCESS_NAMES`. Übersetzt wird im geteilten Paket. */
  accessLevel: string;
}

/** Ein Charakter samt allem, was zum Betreten der Welt gebraucht wird. */
export interface LoadedCharacter {
  character: CharacterRecord;
  items: ItemRecord[];
  quests: QuestRecord[];
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
  /** Konto zum Namen, oder nichts. Der Vergleich ist unabhängig von Gross-
   * und Kleinschreibung: `Held` und `held` sind dieselbe Person. */
  findAccount(name: string): Promise<AccountRecord | undefined>;
  /**
   * Legt ein Konto an. Gibt nichts zurück, wenn der Name schon vergeben ist —
   * geprüft wird in der Datenbank und nicht davor, sonst gewinnt bei zwei
   * gleichzeitigen Anmeldungen die Zufälligkeit.
   */
  createAccount(
    name: string,
    passwordHash: string,
    accessLevel: string,
  ): Promise<AccountRecord | undefined>;
  /** Setzt die Zugriffsstufe — für die Liste der Verwalter in der Konfiguration. */
  setAccessLevel(accountId: number, accessLevel: string): Promise<void>;
  /** Merkt sich, wann zuletzt angemeldet wurde. Reine Buchführung. */
  touchLogin(accountId: number): Promise<void>;

  /** Die Figuren eines Kontos, in der Reihenfolge ihrer Entstehung. */
  listCharacters(accountId: number): Promise<CharacterRecord[]>;
  /**
   * Legt eine Figur an. Nichts, wenn der Name schon vergeben ist.
   *
   * Der Startbeutel entsteht mit — eine Figur ohne Ausrüstung wäre ein
   * halbfertiger Zustand, den jeder Aufrufer selbst vollenden müsste.
   */
  createCharacter(
    accountId: number,
    name: string,
    spawn: SpawnPoint,
  ): Promise<CharacterRecord | undefined>;
  /** Löscht eine Figur — nur, wenn sie dem Konto gehört. */
  deleteCharacter(accountId: number, characterId: number): Promise<boolean>;
  /** Lädt eine Figur samt Beutel und Aufträgen — nur, wenn sie dem Konto gehört. */
  loadCharacter(accountId: number, characterId: number): Promise<LoadedCharacter | undefined>;
  saveCharacter(character: CharacterRecord): Promise<void>;
  saveInventory(characterId: number, items: ItemRecord[]): Promise<void>;
  /**
   * Schreibt den Auftragsstand.
   *
   * Wie beim Inventar vollständig ersetzend: eine Handvoll Zeilen je Charakter,
   * und ein Abgleich wäre mehr Code für dieselbe Wirkung.
   */
  saveQuests(characterId: number, quests: QuestRecord[]): Promise<void>;
}
