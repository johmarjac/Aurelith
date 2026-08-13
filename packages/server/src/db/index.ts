/**
 * Wählt das Persistenz-Backend. PostgreSQL, wenn eine Verbindung konfiguriert
 * ist — sonst Speicher, damit eine Entwicklungssitzung ohne Datenbank
 * hochkommt. Der Unterschied wird beim Start sichtbar gemeldet, nicht
 * verschwiegen.
 */

import { MemoryStore } from './memory.ts';
import { PostgresStore } from './postgres.ts';
import { migrate } from './migrate.ts';
import type { GameStore } from './types.ts';

export * from './types.ts';
export { migrate } from './migrate.ts';

/**
 * Baut den Speicher.
 *
 * Die Adresse kommt als Parameter und nicht aus der Konfiguration: es gibt
 * zwei Anwendungen, die einen Speicher brauchen — Spielserver und
 * Anmeldeserver —, und jede hat ihre eigene Konfiguration. Ein Griff in die
 * eine von hier aus hiesse, dass der Anmeldeserver die Karten- und
 * Tickeinstellungen des Spielservers mitlädt, um an eine Datenbankadresse zu
 * kommen.
 */
export async function createStore(databaseUrl: string): Promise<GameStore> {
  if (!databaseUrl) {
    console.warn(
      '[db] DATABASE_URL ist nicht gesetzt — Speicher-Backend aktiv.\n' +
        '     Charaktere, Fortschritt und Inventare sind beim Neustart weg.',
    );
    const store = new MemoryStore();
    await store.init();
    return store;
  }

  const store = new PostgresStore(databaseUrl);
  await store.init();

  // Migrationen beim Start mitziehen. Bei einem Server ist das bequem; sobald
  // mehrere Instanzen laufen, gehört das in einen eigenen Schritt vor dem Rollout.
  const applied = await migrate(databaseUrl);
  if (applied > 0) console.log(`[db] ${applied} Migration(en) angewandt.`);
  console.log('[db] PostgreSQL verbunden.');

  return store;
}
