/**
 * Migrationslauf. Liest die SQL-Dateien aus `migrations/` in Namensreihenfolge
 * und wendet an, was noch fehlt.
 *
 * Bewusst ohne Framework: eine Tabelle, eine Schleife, eine Transaktion je
 * Datei. Solange Migrationen nur vorwärts gehen, ist mehr nicht nötig.
 *
 *   npm run db:migrate
 *
 * **Ein Läufer zur Zeit.** Seit es Kanäle gibt, starten mehrere Prozesse
 * gleichzeitig gegen dieselbe Datenbank, und jeder migriert beim Hochfahren.
 * Ohne Sperre lesen zwei davon dieselbe Lücke, wenden dieselbe Datei an und
 * der Zweite scheitert am Primärschlüssel von `schema_migrations` — ein
 * Kanal, der beim gemeinsamen Start nicht hochkommt und beim Einzelstart
 * einwandfrei läuft. Die Sperre unten macht daraus ein Warten.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/** Schlüssel der Beratungssperre. Frei gewählt, überall derselbe. */
const MIGRATIONS_LOCK = 8_147_231;

export async function migrate(connectionString: string): Promise<number> {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    /*
     * Die Sperre gilt für die ganze Verbindung und fällt mit ihr — auch wenn
     * der Prozess mittendrin stirbt. Genau deshalb eine Beratungssperre und
     * keine eigene Zeile in einer Tabelle: die müsste jemand aufräumen, und
     * das wäre ausgerechnet der Prozess, der gerade nicht mehr da ist.
     *
     * Die Zahl ist frei gewählt und muss nur überall dieselbe sein. Sie steht
     * hier und sonst nirgends.
     */
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATIONS_LOCK]);

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
    // Erst entsperren, dann auflegen. Das Auflegen allein täte es auch, aber
    // nur, weil die Sperre an der Verbindung hängt — und das ist eine Zusage
    // von PostgreSQL, auf die sich der Code nicht stillschweigend verlassen
    // sollte.
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_LOCK]).catch(() => undefined);
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
