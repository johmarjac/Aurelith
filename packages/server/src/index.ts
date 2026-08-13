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
import { formatBuild } from '@aurelith/shared';
import { config } from './config.ts';
import { loadContentFromDisk } from './content.ts';
import { loadServerCore } from './core.ts';
import { MapStore } from './maps.ts';
import { GameServer } from './gameServer.ts';
import { LoginClient } from './loginClient.ts';
import { createStore, createWeltStore } from './db/index.ts';

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
      `${inhalt.npcs} NPCs, ${inhalt.quests} Aufträge, ` +
        `${inhalt.classes} Berufe mit ${inhalt.skills} Fertigkeiten aus ${config.contentDir}`,
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



const { server, scheme } = buildHttpServer();

// Ein einzelner Endpunkt für Betriebsprüfungen. Alles Weitere läuft über
// den WebSocket — der Spielserver liefert bewusst keine Assets aus, die
// kommen vom CDN.
server.on('request', (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        server: config.serverName,
        channel: config.channelName,
        maps: maps.ids,
        store: welt.kind,
        core: core.core.version,
      }),
    );
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Aurelith-Spielserver. Spielverkehr läuft über /ws.\n');
});

// Der Kanal meldet sich beim Anmeldeserver an — oder stellt fest, dass es
// keinen gibt und läuft im Alleinbetrieb weiter.
const loginClient = new LoginClient();

/*
 * Welche Datenbanken dieser Prozess braucht, hängt an einer Frage: gibt es
 * einen Anmeldeserver?
 *
 * **Mit** einem: nur die Weltdatenbank dieser Region — Figuren, Beutel,
 * Aufträge. Konten sieht dieser Prozess nie; wer da ist, sagt die
 * Eintrittskarte. Das ist der Punkt der ganzen Aufteilung: die
 * Masterdatenbank darf in einer anderen Erdhälfte stehen, weil sie im Spiel
 * nicht angefasst wird.
 *
 * **Ohne** einen: Alleinbetrieb, und dann ist dieselbe Datenbank beides.
 */
const alleinbetrieb = !loginClient.aktiv;
// Im Alleinbetrieb **ein** Speicher für beides. Zwei getrennt gebaute wären
// bei PostgreSQL zwei Pools auf dieselbe Adresse und beim Speicher-Backend
// zwei getrennte Zustände — Konten im einen, Figuren im anderen.
const konten = alleinbetrieb ? await createStore(config.databaseUrl, config.serverName) : undefined;
const welt = konten ?? (await createWeltStore(config.databaseUrl, config.serverName));

// Ein Kanal am Anmeldeserver **ohne** Weltdatenbank ist eine Falle: die Figuren
// lägen im Speicher und wären beim nächsten Kanalwechsel weg. Im Alleinbetrieb
// ist der Speicher dagegen genau richtig — ein Prozess, ein Zustand.
if (loginClient.aktiv && !config.databaseUrl) {
  console.error(
    '[kanal] AURELITH_LOGIN_URL ist gesetzt, DATABASE_URL nicht.\n' +
      '        Ein Kanal braucht die Weltdatenbank seines Servers — sonst hätte\n' +
      '        jeder Kanal seine eigenen Figuren, und sie wären beim Neustart weg.',
  );
  process.exit(1);
}
await loginClient.start();

const game = new GameServer(core, maps, welt, loginClient, konten);
game.start(server);

server.listen(config.port, config.host, () => {
  console.log(
    `[server] ${config.serverName} · ${config.channelName} — ` +
      `${scheme}://${config.host}:${config.port}/ws bereit`,
  );
  // Dieselbe Zeile, die `/version` im Chat zeigt. Wer ein Protokoll liest,
  // soll nicht raten müssen, welcher Stand da lief.
  console.log(`[server] Fassung ${formatBuild(config.build)}`);
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
  // Zuerst aus der Kanalliste heraus, dann die Datenbank zu: sonst steht der
  // Kanal noch bis zu einer halben Minute zum Betreten da, obwohl er schon
  // niemanden mehr annehmen kann.
  await loginClient.stop();
  await welt.close();
  // Im Alleinbetrieb ist `konten` derselbe Speicher — dann ist er schon zu.
  if (konten && konten !== welt) await konten.close();
  server.close(() => process.exit(0));
  // Falls offene Verbindungen das Schließen aufhalten, nicht ewig warten.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
