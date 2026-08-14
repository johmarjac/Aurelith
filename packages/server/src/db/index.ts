/**
 * Wählt das Persistenz-Backend.
 *
 * PostgreSQL, wenn eine Verbindung konfiguriert ist — sonst Speicher, damit
 * eine Entwicklungssitzung ohne Datenbank hochkommt. Der Unterschied wird beim
 * Start sichtbar gemeldet, nicht verschwiegen.
 *
 * **Zwei Sorten, zwei Funktionen.** Der Anmeldeserver holt sich einen
 * Kontospeicher, ein Kanal einen Weltspeicher. Ein Prozess im Alleinbetrieb
 * holt sich beides — dann zeigen beide auf dieselbe Adresse, und derselbe
 * Speicher trägt Konten und Figuren.
 *
 * Die Adressen kommen als Parameter und nicht aus der Konfiguration: es gibt
 * zwei Anwendungen, die einen Speicher brauchen, und jede hat ihre eigene.
 */

import { MemoryStore } from './memory.ts';
import { PostgresKonten, PostgresWelt } from './postgres.ts';
import { migrate } from './migrate.ts';
import type { GameStore, KontoStore, WeltStore } from './types.ts';

export * from './types.ts';
export { migrate } from './migrate.ts';

function ohneDatenbank(was: string): void {
  console.warn(
    `[db] Keine Datenbankadresse für ${was} — Speicher-Backend aktiv.\n` +
      '     Konten, Charaktere, Fortschritt und Inventare sind beim Neustart weg.',
  );
}

/** Die Masterdatenbank: Konten. Für den Anmeldeserver. */
export async function createKontoStore(databaseUrl: string): Promise<KontoStore> {
  if (!databaseUrl) {
    ohneDatenbank('die Konten');
    const store = new MemoryStore();
    await store.init();
    return store;
  }

  const store = new PostgresKonten(databaseUrl);
  await store.init();
  const applied = await migrate(databaseUrl, 'master');
  if (applied > 0) console.log(`[db] ${applied} Migration(en) auf der Masterdatenbank angewandt.`);
  console.log('[db] Masterdatenbank verbunden.');
  return store;
}

/**
 * Eine Weltdatenbank: Figuren einer Region. Für einen Kanal.
 *
 * Der Servername ist keine Zierde: die Welt trägt ihn ein, wenn sie noch
 * niemandem gehört, und lehnt ab, wenn er nicht passt. Zwei Server
 * versehentlich auf derselben Datenbank ist ein Fehler, den man sonst erst
 * bemerkt, wenn Spieler fremde Figuren in ihrer Liste sehen.
 */
export async function createWeltStore(
  databaseUrl: string,
  serverName: string,
): Promise<WeltStore> {
  if (!databaseUrl) {
    ohneDatenbank('die Welt');
    const store = new MemoryStore();
    await store.init();
    return store;
  }

  const store = new PostgresWelt(databaseUrl);
  await store.init();
  const applied = await migrate(databaseUrl, 'welt');
  if (applied > 0) console.log(`[db] ${applied} Migration(en) auf der Weltdatenbank angewandt.`);

  const anspruch = await store.beanspruche(serverName);
  if (!anspruch.ok) {
    await store.close();
    throw new Error(
      `Diese Weltdatenbank gehört "${anspruch.gehoert}", nicht "${serverName}". ` +
        'Jeder Server braucht seine eigene — sonst sehen die Spieler der einen ' +
        'Welt die Figuren der anderen.',
    );
  }
  console.log(`[db] Weltdatenbank "${serverName}" verbunden.`);
  return store;
}

/**
 * Beides aus einer Adresse — nur für den Alleinbetrieb.
 *
 * Ein Prozess ohne Anmeldeserver ist Master und Welt zugleich. Mit Datenbank
 * heisst das: zwei Verbindungspools auf dieselbe Adresse und beide
 * Migrationssätze. Ohne: ein Speicher, der beides kann.
 */
export async function createStore(databaseUrl: string, serverName: string): Promise<GameStore> {
  if (!databaseUrl) {
    ohneDatenbank('den Alleinbetrieb');
    const store = new MemoryStore();
    await store.init();
    return store;
  }

  const konten = (await createKontoStore(databaseUrl)) as PostgresKonten;
  const welt = (await createWeltStore(databaseUrl, serverName)) as PostgresWelt;

  // Zusammengesetzt statt geerbt: die beiden Klassen bleiben, was sie sind,
  // und der Alleinbetrieb ist eine Sicht darauf und keine dritte Sorte.
  return {
    kind: 'postgres',
    init: async () => undefined,
    close: async () => {
      await welt.close();
      await konten.close();
    },
    findAccount: (name) => konten.findAccount(name),
    createAccount: (name, hash, stufe) => konten.createAccount(name, hash, stufe),
    setAccessLevel: (id, stufe) => konten.setAccessLevel(id, stufe),
    touchLogin: (id) => konten.touchLogin(id),
    findeIdentitaet: (anbieter, kennung) => konten.findeIdentitaet(anbieter, kennung),
    legeKontoMitIdentitaet: (name, stufe, anbieter, kennung, email) =>
      konten.legeKontoMitIdentitaet(name, stufe, anbieter, kennung, email),
    verknuepfeIdentitaet: (id, anbieter, kennung, email) =>
      konten.verknuepfeIdentitaet(id, anbieter, kennung, email),
    beanspruche: (server) => welt.beanspruche(server),
    listCharacters: (accountId) => welt.listCharacters(accountId),
    createCharacter: (accountId, name, beruf, spawn) =>
      welt.createCharacter(accountId, name, beruf, spawn),
    deleteCharacter: (accountId, characterId) => welt.deleteCharacter(accountId, characterId),
    loadCharacter: (accountId, characterId) => welt.loadCharacter(accountId, characterId),
    saveCharacter: (character) => welt.saveCharacter(character),
    saveInventory: (characterId, items) => welt.saveInventory(characterId, items),
    saveQuests: (characterId, quests) => welt.saveQuests(characterId, quests),
    saveAktionen: (characterId, plaetze) => welt.saveAktionen(characterId, plaetze),
  };
}
