/**
 * Migrationslauf. Liest die SQL-Dateien aus `migrations/` in Namensreihenfolge
 * und wendet an, was noch fehlt.
 *
 * Bewusst ohne Framework: eine Tabelle, eine Schleife, eine Transaktion je
 * Datei. Solange Migrationen nur vorwärts gehen, ist mehr nicht nötig.
 *
 *   npm run db:migrate
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export async function migrate(connectionString: string): Promise<number> {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT        PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
        (r) => r.name,
      ),
    );

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    let count = 0;

    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = await readFile(join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`  angewandt: ${file}`);
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} fehlgeschlagen: ${(err as Error).message}`);
      }
    }

    return count;
  } finally {
    await client.end();
  }
}

// Direktaufruf über `npm run db:migrate`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL ist nicht gesetzt.');
    process.exit(1);
  }
  const applied = await migrate(url);
  console.log(applied === 0 ? 'Schema ist aktuell.' : `${applied} Migration(en) angewandt.`);
}
