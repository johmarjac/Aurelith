/**
 * PostgreSQL-Backend. Die einzige Datei im Server, in der SQL steht.
 */

import pg from 'pg';
import { KEIN_BERUF } from '@aurelith/shared';
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

const { Pool } = pg;

export class PostgresStore implements GameStore {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  async init(): Promise<void> {
    // Verbindung einmal antesten, damit ein falscher DATABASE_URL beim
    // Hochfahren auffällt und nicht erst beim ersten Login.
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async findAccount(name: string): Promise<AccountRecord | undefined> {
    const res = await this.pool.query(
      `SELECT id, name, password_hash, access_level
         FROM accounts
        WHERE lower(name) = lower($1)`,
      [name],
    );
    const row = res.rows[0];
    return row ? toAccount(row) : undefined;
  }

  async createAccount(
    name: string,
    passwordHash: string,
    accessLevel: string,
  ): Promise<AccountRecord | undefined> {
    // `ON CONFLICT DO NOTHING` statt vorher nachsehen: zwei gleichzeitige
    // Anmeldungen auf denselben Namen sollen nicht beide durchkommen, und die
    // Entscheidung darüber gehört der Datenbank.
    const res = await this.pool.query(
      `INSERT INTO accounts (name, password_hash, access_level, last_login_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (name) DO NOTHING
       RETURNING id, name, password_hash, access_level`,
      [name, passwordHash, accessLevel],
    );
    const row = res.rows[0];
    return row ? toAccount(row) : undefined;
  }

  async setAccessLevel(accountId: number, accessLevel: string): Promise<void> {
    await this.pool.query('UPDATE accounts SET access_level = $2 WHERE id = $1', [
      accountId,
      accessLevel,
    ]);
  }

  async touchLogin(accountId: number): Promise<void> {
    await this.pool.query('UPDATE accounts SET last_login_at = now() WHERE id = $1', [accountId]);
  }

  async listCharacters(accountId: number): Promise<CharacterRecord[]> {
    const res = await this.pool.query(
      `SELECT id, account_id, name, class, level, exp, gold, hp, mp, map_id, pos_x, pos_z, yaw
         FROM characters
        WHERE account_id = $1
        ORDER BY id`,
      [accountId],
    );
    return res.rows.map((r) => toCharacter(r));
  }

  async createCharacter(
    accountId: number,
    name: string,
    beruf: string,
    spawn: SpawnPoint,
  ): Promise<CharacterRecord | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO characters (account_id, name, class, map_id, pos_x, pos_z, yaw)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (name) DO NOTHING
         RETURNING id, account_id, name, class, level, exp, gold, hp, mp, map_id, pos_x, pos_z, yaw`,
        [accountId, name, beruf, spawn.mapId, spawn.x, spawn.z, spawn.yaw],
      );
      if (inserted.rowCount === 0) {
        await client.query('ROLLBACK');
        return undefined;
      }

      const character = toCharacter(inserted.rows[0]);
      for (const row of starterRows()) {
        await client.query(
          `INSERT INTO character_items (character_id, item_id, count, slot, equipped)
           VALUES ($1, $2, $3, $4, $5)`,
          [character.id, row.itemId, row.count, row.slot, row.equipped],
        );
      }

      await client.query('COMMIT');
      return character;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteCharacter(accountId: number, characterId: number): Promise<boolean> {
    // Die Kontokennung steht in der Bedingung und nicht in einer Prüfung
    // davor: sonst gäbe es ein Fenster, in dem die Figur schon jemand anderem
    // gehört. Beutel und Aufträge hängen an ON DELETE CASCADE.
    const res = await this.pool.query('DELETE FROM characters WHERE id = $1 AND account_id = $2', [
      characterId,
      accountId,
    ]);
    return (res.rowCount ?? 0) > 0;
  }

  async loadCharacter(
    accountId: number,
    characterId: number,
  ): Promise<LoadedCharacter | undefined> {
    const res = await this.pool.query(
      `SELECT id, account_id, name, class, level, exp, gold, hp, mp, map_id, pos_x, pos_z, yaw
         FROM characters
        WHERE id = $1 AND account_id = $2`,
      [characterId, accountId],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    const character = toCharacter(row);

    const items = await this.pool.query(
      `SELECT item_id, count, slot, equipped, upgrade
         FROM character_items
        WHERE character_id = $1
        ORDER BY slot`,
      [character.id],
    );

    const quests = await this.pool.query(
      `SELECT quest_id, status, progress
         FROM character_quests
        WHERE character_id = $1
        ORDER BY quest_id`,
      [character.id],
    );

    return {
      character,
      items: items.rows.map((r) => ({
        itemId: String(r.item_id),
        count: Number(r.count),
        slot: Number(r.slot),
        equipped: Boolean(r.equipped),
        upgrade: Number(r.upgrade ?? 0),
      })),
      quests: quests.rows.map((r) => ({
        questId: String(r.quest_id),
        status: Number(r.status),
        // pg liefert INTEGER[] als JS-Array; die Zahlen kommen je nach
        // Treiberfassung als Text zurueck, deshalb der Durchlauf.
        progress: Array.isArray(r.progress) ? r.progress.map((p: unknown) => Number(p)) : [],
      })),
    };
  }

  async saveCharacter(c: CharacterRecord): Promise<void> {
    await this.pool.query(
      // Der Beruf steht mit in der Zeile: er ändert sich nur einmal im Leben
      // einer Figur, aber genau dann — beim Lehrer — und ein Speichern ohne
      // ihn hiesse, dass der frisch gelernte Beruf beim Abmelden verfällt.
      `UPDATE characters
          SET class = $2, level = $3, exp = $4, gold = $5, hp = $6, mp = $7,
              map_id = $8, pos_x = $9, pos_z = $10, yaw = $11, updated_at = now()
        WHERE id = $1`,
      [c.id, c.beruf, c.level, c.exp, c.gold, c.hp, c.mp, c.mapId, c.x, c.z, c.yaw],
    );
  }

  async saveInventory(characterId: number, items: ItemRecord[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Ersetzen statt abgleichen: Inventare sind klein, und der Abgleich
      // wäre mehr Code für dieselbe Wirkung.
      await client.query('DELETE FROM character_items WHERE character_id = $1', [characterId]);
      for (const item of items) {
        await client.query(
          `INSERT INTO character_items (character_id, item_id, count, slot, equipped, upgrade)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [characterId, item.itemId, item.count, item.slot, item.equipped, item.upgrade],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async saveQuests(characterId: number, quests: QuestRecord[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Ersetzen statt abgleichen, genau wie beim Inventar. Das raeumt
      // nebenbei aufgegebene Auftraege weg — mit einem reinen UPSERT bliebe
      // ihre Zeile stehen und der Auftrag waere nach dem naechsten Anmelden
      // wieder da.
      await client.query('DELETE FROM character_quests WHERE character_id = $1', [characterId]);
      for (const quest of quests) {
        await client.query(
          `INSERT INTO character_quests (character_id, quest_id, status, progress)
           VALUES ($1, $2, $3, $4)`,
          [characterId, quest.questId, quest.status, quest.progress],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

function toAccount(row: Record<string, unknown>): AccountRecord {
  return {
    id: Number(row.id),
    name: String(row.name),
    passwordHash: String(row.password_hash ?? ''),
    accessLevel: String(row.access_level ?? 'player'),
  };
}

function toCharacter(row: Record<string, unknown> | undefined): CharacterRecord {
  if (!row) throw new Error('Charakterzeile fehlt');
  return {
    id: Number(row.id),
    accountId: Number(row.account_id),
    name: String(row.name),
    beruf: String(row.class ?? KEIN_BERUF),
    level: Number(row.level),
    exp: Number(row.exp),
    gold: Number(row.gold),
    hp: Number(row.hp),
    mp: Number(row.mp),
    mapId: String(row.map_id),
    x: Number(row.pos_x),
    z: Number(row.pos_z),
    yaw: Number(row.yaw),
  };
}
