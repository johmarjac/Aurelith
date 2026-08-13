/**
 * PostgreSQL-Backend. Die einzige Datei im Server, in der SQL steht.
 *
 * **Zwei Sorten Datenbank, zwei Klassen.** `PostgresKonten` spricht mit der
 * Masterdatenbank, `PostgresWelt` mit der Weltdatenbank einer Region. Eine
 * Klasse für beides hätte Methoden mitgebracht, die auf der jeweils anderen
 * Verbindung ins Leere greifen — und das erst zur Laufzeit gezeigt.
 *
 * Im Alleinbetrieb zeigen beide auf dieselbe Adresse. Das kostet einen
 * zweiten Verbindungspool und spart die Fallunterscheidung überall sonst.
 */

import pg from 'pg';
import {
  AktionsArt,
  KEIN_BERUF,
  leereLeiste,
  normalisiereLeiste,
  type AktionsPlatz,
} from '@aurelith/shared';
import { starterRows } from '../inventory.ts';
import type {
  AccountRecord,
  CharacterRecord,
  ItemRecord,
  KontoStore,
  LoadedCharacter,
  QuestRecord,
  SpawnPoint,
  WeltStore,
} from './types.ts';

const { Pool } = pg;

/** Was beide Sorten teilen: ein Pool, ein Antest, ein Auflegen. */
abstract class PostgresBasis {
  readonly kind = 'postgres' as const;
  protected readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  async init(): Promise<void> {
    // Verbindung einmal antesten, damit eine falsche Adresse beim Hochfahren
    // auffällt und nicht erst beim ersten Login.
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
}

/** Die Masterdatenbank: Konten. */
export class PostgresKonten extends PostgresBasis implements KontoStore {
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

}

/** Eine Weltdatenbank: Figuren, Beutel, Aufträge einer Region. */
export class PostgresWelt extends PostgresBasis implements WeltStore {
  /**
   * Schreibt den Servernamen hinein — oder liest ihn, wenn schon einer
   * dasteht.
   *
   * Ein einziges `INSERT … ON CONFLICT DO NOTHING` gefolgt vom Lesen: so
   * entscheidet die Datenbank, wer zuerst da war, und zwei gleichzeitig
   * startende Kanäle desselben Servers stolpern nicht übereinander.
   */
  async beanspruche(server: string): Promise<{ ok: true } | { ok: false; gehoert: string }> {
    await this.pool.query(
      `INSERT INTO welt_info (einzig, server) VALUES (TRUE, $1)
       ON CONFLICT (einzig) DO NOTHING`,
      [server],
    );
    const res = await this.pool.query('SELECT server FROM welt_info WHERE einzig');
    const gehoert = String(res.rows[0]?.server ?? '');
    return gehoert === server ? { ok: true } : { ok: false, gehoert };
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
        // Der Name kollidiert nur **in dieser Welt** — der Index liegt auf
        // lower(name), und die Datenbank ist der Server. Eine andere Region
        // darf denselben Namen noch einmal vergeben.
        `INSERT INTO characters (account_id, name, class, map_id, pos_x, pos_z, yaw)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING
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

    const aktionen = await this.pool.query(
      `SELECT idx, art, ref FROM character_actions WHERE character_id = $1`,
      [character.id],
    );
    const leiste = leereLeiste();
    for (const r of aktionen.rows) {
      const i = Number(r.idx);
      // Was ausserhalb liegt, fällt weg: die Zahl der Plätze kann sich ändern,
      // und eine alte Zeile für Platz 12 soll dann nichts umwerfen.
      if (i >= 0 && i < leiste.length) {
        // `normalisiereLeiste` weiter unten wirft weg, was keine gültige Art
        // ist — deshalb reicht hier die rohe Zahl.
        leiste[i] = { art: Number(r.art) as AktionsArt, id: String(r.ref) };
      }
    }

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
      aktionen: normalisiereLeiste(leiste),
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

  async saveAktionen(characterId: number, plaetze: AktionsPlatz[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Ersetzend wie Beutel und Aufträge. Leere Plätze bekommen keine Zeile —
      // ein Platz, von dem nichts in der Datenbank steht, ist leer, und beides
      // zugleich zu führen wären zwei Wahrheiten über dasselbe Loch.
      await client.query('DELETE FROM character_actions WHERE character_id = $1', [characterId]);
      for (let i = 0; i < plaetze.length; i++) {
        const p = plaetze[i]!;
        if (p.art === AktionsArt.Leer || p.id === '') continue;
        await client.query(
          `INSERT INTO character_actions (character_id, idx, art, ref) VALUES ($1, $2, $3, $4)`,
          [characterId, i, p.art, p.id],
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
