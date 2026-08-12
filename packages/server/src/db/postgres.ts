/**
 * PostgreSQL-Backend. Die einzige Datei im Server, in der SQL steht.
 */

import pg from 'pg';
import { STARTER_INVENTORY } from '@aurelith/shared';
import type {
  CharacterRecord,
  GameStore,
  ItemRecord,
  LoginResult,
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

  async loginOrCreate(accountName: string, spawn: SpawnPoint): Promise<LoginResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Konto anlegen oder anmelden. ON CONFLICT macht daraus einen einzigen
      // Rundlauf statt SELECT-dann-INSERT mit Wettlauf dazwischen.
      const account = await client.query<{ id: string }>(
        `INSERT INTO accounts (name, last_login_at)
         VALUES ($1, now())
         ON CONFLICT (name) DO UPDATE SET last_login_at = now()
         RETURNING id`,
        [accountName],
      );
      const accountId = Number(account.rows[0]!.id);

      const existing = await client.query(
        `SELECT id, account_id, name, level, exp, gold, hp, mp, map_id, pos_x, pos_z, yaw
           FROM characters
          WHERE account_id = $1
          ORDER BY id
          LIMIT 1`,
        [accountId],
      );

      let character: CharacterRecord;
      let created = false;

      if (existing.rowCount === 0) {
        const inserted = await client.query(
          `INSERT INTO characters (account_id, name, map_id, pos_x, pos_z, yaw)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, account_id, name, level, exp, gold, hp, mp, map_id, pos_x, pos_z, yaw`,
          [accountId, accountName, spawn.mapId, spawn.x, spawn.z, spawn.yaw],
        );
        character = toCharacter(inserted.rows[0]);
        created = true;

        for (let i = 0; i < STARTER_INVENTORY.length; i++) {
          const s = STARTER_INVENTORY[i]!;
          await client.query(
            `INSERT INTO character_items (character_id, item_id, count, slot, equipped)
             VALUES ($1, $2, $3, $4, $5)`,
            [character.id, s.item, s.count, i, s.equipped],
          );
        }
      } else {
        character = toCharacter(existing.rows[0]);
      }

      const items = await client.query(
        `SELECT item_id, count, slot, equipped
           FROM character_items
          WHERE character_id = $1
          ORDER BY slot`,
        [character.id],
      );

      const quests = await client.query(
        `SELECT quest_id, status, progress
           FROM character_quests
          WHERE character_id = $1
          ORDER BY quest_id`,
        [character.id],
      );

      await client.query('COMMIT');

      return {
        character,
        items: items.rows.map((r) => ({
          itemId: String(r.item_id),
          count: Number(r.count),
          slot: Number(r.slot),
          equipped: Boolean(r.equipped),
        })),
        quests: quests.rows.map((r) => ({
          questId: String(r.quest_id),
          status: Number(r.status),
          // pg liefert INTEGER[] als JS-Array; die Zahlen kommen je nach
          // Treiberfassung als Text zurueck, deshalb der Durchlauf.
          progress: Array.isArray(r.progress) ? r.progress.map((p: unknown) => Number(p)) : [],
        })),
        created,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async saveCharacter(c: CharacterRecord): Promise<void> {
    await this.pool.query(
      `UPDATE characters
          SET level = $2, exp = $3, gold = $4, hp = $5, mp = $6,
              map_id = $7, pos_x = $8, pos_z = $9, yaw = $10, updated_at = now()
        WHERE id = $1`,
      [c.id, c.level, c.exp, c.gold, c.hp, c.mp, c.mapId, c.x, c.z, c.yaw],
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
          `INSERT INTO character_items (character_id, item_id, count, slot, equipped)
           VALUES ($1, $2, $3, $4, $5)`,
          [characterId, item.itemId, item.count, item.slot, item.equipped],
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

function toCharacter(row: Record<string, unknown> | undefined): CharacterRecord {
  if (!row) throw new Error('Charakterzeile fehlt');
  return {
    id: Number(row.id),
    accountId: Number(row.account_id),
    name: String(row.name),
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
