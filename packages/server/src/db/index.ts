/**
 * Wählt das Persistenz-Backend. PostgreSQL, wenn eine Verbindung konfiguriert
 * ist — sonst Speicher, damit eine Entwicklungssitzung ohne Datenbank
 * hochkommt. Der Unterschied wird beim Start sichtbar gemeldet, nicht
 * verschwiegen.
 */

import { config } from '../config.ts';
import { MemoryStore } from './memory.ts';
import { PostgresStore } from './postgres.ts';
import { migrate } from './migrate.ts';
import type { GameStore } from './types.ts';

export * from './types.ts';
export { migrate } from './migrate.ts';

export async function createStore(): Promise<GameStore> {
  if (!config.databaseUrl) {
    console.warn(
      '[db] DATABASE_URL ist nicht gesetzt — Speicher-Backend aktiv.\n' +
        '     Charaktere, Fortschritt und Inventare sind beim Neustart weg.',
    );
    const store = new MemoryStore();
    await store.init();
    return store;
  }

  const store = new PostgresStore(config.databaseUrl);
  await store.init();

  // Migrationen beim Start mitziehen. Bei einem Server ist das bequem; sobald
  // mehrere Instanzen laufen, gehört das in einen eigenen Schritt vor dem Rollout.
  const applied = await migrate(config.databaseUrl);
  if (applied > 0) console.log(`[db] ${applied} Migration(en) angewandt.`);
  console.log('[db] PostgreSQL verbunden.');

  return store;
}
