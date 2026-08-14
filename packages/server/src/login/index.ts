/**
 * Einstiegspunkt des Anmeldeservers.
 *
 * Die zweite der beiden Serveranwendungen. Sie hört auf zwei Ohren:
 *
 *   `/ws`      für Spieler — anmelden, Serverliste, Eintrittskarte.
 *   `/intern/` für Spielserver — anmelden, Lebenszeichen, Karten einlösen.
 *
 * Von diesem Server gibt es einen; von Spielservern beliebig viele. Er hält
 * keine Welt, tickt nicht und hat nichts zu simulieren — fällt er aus, kommt
 * niemand mehr neu herein, aber wer drin ist, spielt weiter.
 */

import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { formatBuild } from '@aurelith/shared';
import { loginConfig } from './config.ts';
import { createKontoStore } from '../db/index.ts';
import { KanalRegister } from './registry.ts';
import { Kartenstapel } from './tickets.ts';
import { behandleIntern } from './internal.ts';
import { behandleAnbieterweg, googleBereit } from './anbieterweg.ts';
import { LoginServer } from './loginServer.ts';

function baueHttpServer(): { server: Server; scheme: 'ws' | 'wss' } {
  if (loginConfig.tls) {
    const options = {
      key: readFileSync(loginConfig.tls.keyPath),
      cert: readFileSync(loginConfig.tls.certPath),
    };
    return { server: createHttpsServer(options) as unknown as Server, scheme: 'wss' };
  }
  return { server: createHttpServer(), scheme: 'ws' };
}

// Nur Konten. Der Anmeldeserver hat keine Figuren — die liegen je Region in
// einer eigenen Datenbank neben ihren Kanälen.
const store = await createKontoStore(loginConfig.databaseUrl);
const register = new KanalRegister();
const karten = new Kartenstapel();

/**
 * Ein **zweiter** Stapel für die Anmeldung über einen Anbieter.
 *
 * Nicht derselbe wie `karten`: die Eintrittskarte öffnet einen Kanal, die
 * Anmeldekarte öffnet eine Anmeldung. Aus einem gemeinsamen Stapel liesse sich
 * eine Karte, die für das eine ausgestellt wurde, für das andere einlösen.
 */
const anmeldekarten = new Kartenstapel();

const { server, scheme } = baueHttpServer();

server.on('request', (req, res) => {
  void (async () => {
    if (await behandleIntern(req, res, register, karten)) return;
    if (await behandleAnbieterweg(req, res, store, anmeldekarten)) return;

    // Lesbar auch von einer anderen Herkunft — siehe die gleiche Stelle im
    // Spielserver. `/intern/` ist davon ausgenommen: es wird oben schon
    // behandelt und kommt hier gar nicht an.
    const kopf = { 'access-control-allow-origin': '*' };

    if (req.url === '/health') {
      res.writeHead(200, { ...kopf, 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, kanaele: register.liste().length, store: store.kind }));
      return;
    }
    // Die Kanalliste auch über HTTP — nicht fürs Spiel, sondern für einen
    // Blick von aussen: „welche Kanäle laufen gerade?" soll man beantworten
    // können, ohne einen WebSocket zu öffnen.
    if (req.url === '/kanaele') {
      res.writeHead(200, { ...kopf, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(register.liste()));
      return;
    }
    res.writeHead(404, { ...kopf, 'content-type': 'text/plain; charset=utf-8' });
    res.end('Aurelith-Anmeldeserver. Spieler verbinden über /ws.\n');
  })();
});

const login = new LoginServer(store, register, karten, anmeldekarten);
login.start(server);

// Verwaiste Konten aufräumen: ein abgestürzter Spielserver meldet seine
// Spieler nicht ab, und ohne diesen Durchlauf gälten sie ewig als drin — also
// wäre ihr Konto ewig gesperrt.
const aufraeumer = setInterval(() => register.raeumeVerfallene(), 15_000);

server.listen(loginConfig.port, loginConfig.host, () => {
  console.log(`[anmelde] ${scheme}://${loginConfig.host}:${loginConfig.port}/ws — bereit`);
  console.log(`[anmelde] Fassung ${formatBuild(loginConfig.build)}`);
  console.log(
    `[anmelde] Anmeldearten: Passwort${googleBereit() ? ', Google' : ''}`,
  );
  if (googleBereit() && loginConfig.ziele.length === 0) {
    // Ohne Freigabeliste geht der Google-Weg nirgendwohin zurück — der Knopf
    // wäre da und führte in eine Sackgasse. Lieber laut beim Start als still
    // beim ersten Spieler.
    console.warn(
      '[anmelde] AURELITH_ANMELDE_ZIELE ist leer — die Anmeldung über Google ' +
        'kann den Browser nirgends zurückschicken. Die Herkunft des Clients eintragen.',
    );
  }
  if (loginConfig.internalSecret === 'aurelith-entwicklung') {
    console.warn(
      '[anmelde] AURELITH_INTERNAL_SECRET ist nicht gesetzt — es gilt der ' +
        'Entwicklungswert. Im Betrieb setzen, sonst kann jeder einen Kanal anmelden.',
    );
  }
});

function herunterfahren(): void {
  clearInterval(aufraeumer);
  login.stop();
  server.close(() => process.exit(0));
  // Wer nach zwei Sekunden noch hängt, hängt auch nach zehn.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', herunterfahren);
process.on('SIGTERM', herunterfahren);
