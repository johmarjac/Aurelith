/**
 * Einstiegspunkt des Servers.
 *
 * Hört auf `ws://` — oder auf `wss://`, sobald Schlüssel und Zertifikat
 * konfiguriert sind. Das ist die Verschlüsselungsstufe, die tatsächlich
 * schützt; die Cipher-ID im Frame-Header kommt zusätzlich, nicht stattdessen.
 */

import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { config } from './config.ts';
import { loadContentFromDisk } from './content.ts';
import { loadServerCore } from './core.ts';
import { MapStore } from './maps.ts';
import { GameServer } from './gameServer.ts';
import { createStore } from './db/index.ts';

function buildHttpServer(): { server: Server; scheme: 'ws' | 'wss' } {
  if (config.tls) {
    const options = {
      key: readFileSync(config.tls.keyPath),
      cert: readFileSync(config.tls.certPath),
    };
    return { server: createHttpsServer(options) as unknown as Server, scheme: 'wss' };
  }
  return { server: createHttpServer(), scheme: 'ws' };
}

// Zuerst die Inhalte: der Kern bekommt seine Monsterprofile daraus, und ein
// Kern ohne Monster ist eine leere Welt. Schlägt das fehl, ist der Start
// vorbei — mit halben Tabellen zu spielen waere schlimmer als gar nicht.
try {
  const inhalt = await loadContentFromDisk(config.contentDir);
  console.log(
    `[inhalt] ${inhalt.items} Gegenstände, ${inhalt.mobs} Monster, ` +
      `${inhalt.npcs} NPCs, ${inhalt.quests} Aufträge aus ${config.contentDir}`,
  );
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
}

const core = await loadServerCore();

const maps = new MapStore();
await maps.load(config.mapsDir);
if (maps.size === 0) {
  console.error(`[maps] Keine Maps in ${config.mapsDir}. Erzeugen mit: npm run maps`);
  process.exit(1);
}
console.log(`[maps] ${maps.size} Maps geladen: ${maps.ids.join(', ')}`);

const store = await createStore();

const { server, scheme } = buildHttpServer();

// Ein einzelner Endpunkt für Betriebsprüfungen. Alles Weitere läuft über
// den WebSocket — der Spielserver liefert bewusst keine Assets aus, die
// kommen vom CDN.
server.on('request', (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, maps: maps.ids, store: store.kind, core: core.core.version }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Aurelith-Spielserver. Spielverkehr läuft über /ws.\n');
});

const game = new GameServer(core, maps, store);
game.start(server);

server.listen(config.port, config.host, () => {
  console.log(`[server] ${scheme}://${config.host}:${config.port}/ws — bereit`);
  if (!config.tls) {
    console.log('[server] Ohne TLS. Für wss: AURELITH_TLS_KEY und AURELITH_TLS_CERT setzen.');
  }
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${signal} — fahre herunter`);
  await game.stop();
  await store.close();
  server.close(() => process.exit(0));
  // Falls offene Verbindungen das Schließen aufhalten, nicht ewig warten.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
