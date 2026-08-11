/**
 * Speicher-Backend. Kein Ersatz für PostgreSQL, sondern die Zusicherung, dass
 * `npm run dev` ohne installierte Datenbank funktioniert. Alles ist beim
 * Neustart weg, und der Server sagt das beim Hochfahren.
 */

import { STARTER_INVENTORY } from '@aurelith/shared';
import type { CharacterRecord, GameStore, ItemRecord, LoginResult, SpawnPoint } from './types.ts';

interface Row {
  character: CharacterRecord;
  items: ItemRecord[];
}

export class MemoryStore implements GameStore {
  readonly kind = 'memory' as const;

  private readonly byAccount = new Map<string, Row>();
  private nextId = 1;

  async init(): Promise<void> {
    // Nichts vorzubereiten.
  }

  async close(): Promise<void> {
    this.byAccount.clear();
  }

  async loginOrCreate(accountName: string, spawn: SpawnPoint): Promise<LoginResult> {
    const existing = this.byAccount.get(accountName);
    if (existing) {
      return { character: { ...existing.character }, items: existing.items.map((i) => ({ ...i })), created: false };
    }

    const id = this.nextId++;
    const character: CharacterRecord = {
      id,
      accountId: id,
      name: accountName,
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
    const items: ItemRecord[] = STARTER_INVENTORY.map((s, index) => ({
      itemId: s.item,
      count: s.count,
      slot: index,
      equipped: s.equipped,
    }));

    this.byAccount.set(accountName, { character, items });
    return { character: { ...character }, items: items.map((i) => ({ ...i })), created: true };
  }

  async saveCharacter(character: CharacterRecord): Promise<void> {
    const row = this.byAccount.get(character.name);
    if (row) row.character = { ...character };
  }

  async saveInventory(characterId: number, items: ItemRecord[]): Promise<void> {
    for (const row of this.byAccount.values()) {
      if (row.character.id === characterId) {
        row.items = items.map((i) => ({ ...i }));
        return;
      }
    }
  }
}
