/**
 * Speicher-Backend. Kein Ersatz für PostgreSQL, sondern die Zusicherung, dass
 * `npm run dev` ohne installierte Datenbank funktioniert. Alles ist beim
 * Neustart weg, und der Server sagt das beim Hochfahren.
 */

import { starterRows } from '../inventory.ts';
import type {
  AccountRecord,
  CharacterRecord,
  GameStore,
  ItemRecord,
  LoadedCharacter,
  QuestRecord,
  SpawnPoint,
} from './types.ts';

interface Figur {
  character: CharacterRecord;
  items: ItemRecord[];
  quests: QuestRecord[];
}

/** Namen vergleichen sich ohne Rücksicht auf Gross- und Kleinschreibung. */
const schluessel = (name: string): string => name.trim().toLowerCase();

export class MemoryStore implements GameStore {
  readonly kind = 'memory' as const;

  private readonly accounts = new Map<string, AccountRecord>();
  private readonly figuren = new Map<number, Figur>();
  private nextAccountId = 1;
  private nextCharacterId = 1;

  async init(): Promise<void> {
    // Nichts vorzubereiten.
  }

  async close(): Promise<void> {
    this.accounts.clear();
    this.figuren.clear();
  }

  async findAccount(name: string): Promise<AccountRecord | undefined> {
    const row = this.accounts.get(schluessel(name));
    return row ? { ...row } : undefined;
  }

  async createAccount(
    name: string,
    passwordHash: string,
    accessLevel: string,
  ): Promise<AccountRecord | undefined> {
    if (this.accounts.has(schluessel(name))) return undefined;
    const row: AccountRecord = { id: this.nextAccountId++, name, passwordHash, accessLevel };
    this.accounts.set(schluessel(name), row);
    return { ...row };
  }

  async setAccessLevel(accountId: number, accessLevel: string): Promise<void> {
    for (const row of this.accounts.values()) {
      if (row.id === accountId) row.accessLevel = accessLevel;
    }
  }

  async touchLogin(): Promise<void> {
    // Im Speicher gibt es keine Buchführung über gestern.
  }

  async listCharacters(accountId: number): Promise<CharacterRecord[]> {
    return [...this.figuren.values()]
      .filter((f) => f.character.accountId === accountId)
      .sort((a, b) => a.character.id - b.character.id)
      .map((f) => ({ ...f.character }));
  }

  async createCharacter(
    accountId: number,
    name: string,
    beruf: string,
    spawn: SpawnPoint,
  ): Promise<CharacterRecord | undefined> {
    for (const f of this.figuren.values()) {
      if (schluessel(f.character.name) === schluessel(name)) return undefined;
    }

    const character: CharacterRecord = {
      id: this.nextCharacterId++,
      accountId,
      name,
      beruf,
      level: 1,
      exp: 0,
      gold: 0,
      hp: 0,
      mp: 0,
      mapId: spawn.mapId,
      x: spawn.x,
      z: spawn.z,
      yaw: spawn.yaw,
    };
    this.figuren.set(character.id, { character, items: starterRows(), quests: [] });
    return { ...character };
  }

  async deleteCharacter(accountId: number, characterId: number): Promise<boolean> {
    const figur = this.figuren.get(characterId);
    if (!figur || figur.character.accountId !== accountId) return false;
    this.figuren.delete(characterId);
    return true;
  }

  async loadCharacter(
    accountId: number,
    characterId: number,
  ): Promise<LoadedCharacter | undefined> {
    const figur = this.figuren.get(characterId);
    if (!figur || figur.character.accountId !== accountId) return undefined;
    return {
      character: { ...figur.character },
      items: figur.items.map((i) => ({ ...i })),
      quests: figur.quests.map((q) => ({ ...q, progress: [...q.progress] })),
    };
  }

  async saveCharacter(character: CharacterRecord): Promise<void> {
    const figur = this.figuren.get(character.id);
    if (figur) figur.character = { ...character };
  }

  async saveInventory(characterId: number, items: ItemRecord[]): Promise<void> {
    const figur = this.figuren.get(characterId);
    if (figur) figur.items = items.map((i) => ({ ...i }));
  }

  async saveQuests(characterId: number, quests: QuestRecord[]): Promise<void> {
    const figur = this.figuren.get(characterId);
    if (figur) figur.quests = quests.map((q) => ({ ...q, progress: [...q.progress] }));
  }
}
