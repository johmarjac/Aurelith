/**
 * Eintrittskarten: die Frist, und wer sie verschiebt.
 *
 * Die Karte war einmal einmalig, und das kostete jede unterbrochene
 * Verbindung die Sitzung. Jetzt gilt sie auf Zeit — und damit ist die Zeit
 * das, was geprüft werden muss. Ohne einen einstellbaren „jetzt" ginge das
 * nur mit einer halben Stunde Wartezeit je Prüfung; deshalb nimmt jede
 * Methode ihn entgegen.
 *
 * Vier Aussagen, und die dritte ist der eigentliche Grund für den Umbau:
 *
 *   1. Frisch ausgestellt gilt sie kurz — zwei Minuten für die Kanalwahl.
 *   2. Eingelöst gilt sie lange, und **bleibt liegen**: derselbe Spieler darf
 *      mit derselben Karte wiederkommen.
 *   3. Jedes Lebenszeichen schiebt die Frist weiter. Wer eine Stunde spielt,
 *      hat danach immer noch eine gültige Karte.
 *   4. Wer sich abmeldet, lässt kein Papier zurück.
 *
 *   npx tsx packages/server/test/karten_test.ts
 */

// Vor den Modulen gesetzt und deshalb über `await import`: eine gewöhnliche
// `import`-Zeile wird vor jeder Anweisung ausgewertet, und die Konfiguration
// des Anmeldeservers liest das Geheimnis beim Laden.
process.env.AURELITH_INTERNAL_SECRET = 'geheim-fuer-den-test';

import { createServer } from 'node:http';
const { Kartenstapel, SITZUNG_MS } = await import('../src/login/tickets.ts');
const { behandleIntern, GEHEIM_KOPF } = await import('../src/login/internal.ts');
const { KanalRegister } = await import('../src/login/registry.ts');
import type { KontoStore } from '../src/db/index.ts';

let failures = 0;
let checks = 0;
function check(ok: boolean, was: string, detail = ''): void {
  checks++;
  console.log(`  ${ok ? '✓' : '✗'} ${was}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const MINUTE = 60_000;
/** Ein fester Anfang. Echte Uhrzeiten machen Prüfungen von der Tageszeit abhängig. */
const T0 = 1_700_000_000_000;

console.log('Aurelith — Eintrittskarten\n');

// --- 1. Kurz gültig, solange sie niemand einlöst ---------------------------

{
  const stapel = new Kartenstapel();
  const karte = stapel.stelleAus(7, 'pruefer', 'player', T0);
  check(stapel.loeseEin(karte, T0 + MINUTE) !== undefined, 'nach einer Minute gilt sie');

  const zweite = new Kartenstapel();
  const spaet = zweite.stelleAus(7, 'pruefer', 'player', T0);
  check(
    zweite.loeseEin(spaet, T0 + 3 * MINUTE) === undefined,
    'nach drei Minuten ohne Einlösen nicht mehr',
  );
  check(zweite.anzahl === 0, 'und sie liegt auch nicht mehr im Stapel');
}

// --- 2. Eingelöst bleibt sie liegen ----------------------------------------
//
// Das ist der Umbau: vorher war sie hier weg, und ein Wiedereinstieg
// unmöglich.

{
  const stapel = new Kartenstapel();
  const karte = stapel.stelleAus(7, 'pruefer', 'gm', T0);
  const konto = stapel.loeseEin(karte, T0);
  check(konto?.accountId === 7, 'sie nennt ihr Konto', String(konto?.accountId));
  check(konto?.accessLevel === 'gm', 'und die Zugriffsstufe reist mit', konto?.accessLevel);

  const nochmal = stapel.loeseEin(karte, T0 + MINUTE);
  check(nochmal?.accountId === 7, 'ein zweites Vorzeigen geht durch — der Wiedereinstieg');

  // Und die lange Frist gilt ab jetzt: eine halbe Stunde später ist Schluss.
  check(
    stapel.loeseEin(karte, T0 + MINUTE + SITZUNG_MS + 1) === undefined,
    'eine halbe Stunde nach dem letzten Vorzeigen nicht mehr',
  );
}

// --- 3. Lebenszeichen schieben die Frist -----------------------------------
//
// Der Kern der Sache: eine lange Sitzung darf die Karte nicht verfallen
// lassen, und eine abgerissene Verbindung soll genau eine halbe Stunde
// nachlaufen.

{
  const stapel = new Kartenstapel();
  const karte = stapel.stelleAus(7, 'pruefer', 'player', T0);
  stapel.loeseEin(karte, T0);

  // Zwei Stunden spielen, jede Minute ein Lebenszeichen.
  let jetzt = T0;
  let alleDurch = true;
  for (let i = 0; i < 120; i++) {
    jetzt += MINUTE;
    if (!stapel.frischeAuf(karte, jetzt)) alleDurch = false;
  }
  check(alleDurch, 'zwei Stunden Lebenszeichen halten die Karte am Leben');

  // Jetzt reisst die Verbindung ab: keine Zeichen mehr.
  check(
    stapel.loeseEin(karte, jetzt + 29 * MINUTE) !== undefined,
    'neunundzwanzig Minuten nach dem Abriss geht der Wiedereinstieg',
  );
  check(
    stapel.frischeAuf(karte, jetzt + 29 * MINUTE + SITZUNG_MS + 1) === false,
    'danach ist sie weg',
  );
}

// --- 4. Abmelden lässt kein Papier zurück ----------------------------------
//
// Die Gegenprobe zu Punkt 2: dieselbe Karte, derselbe Zeitpunkt, und trotzdem
// zurückgewiesen — der Unterschied ist allein der ausdrückliche Verzicht.

{
  const stapel = new Kartenstapel();
  const karte = stapel.stelleAus(7, 'pruefer', 'player', T0);
  stapel.loeseEin(karte, T0);
  check(stapel.loeseEin(karte, T0 + MINUTE) !== undefined, 'vor dem Abmelden gilt sie noch');
  stapel.verwirf(karte);
  check(stapel.loeseEin(karte, T0 + MINUTE) === undefined, 'nach dem Abmelden nicht mehr');
  check(stapel.anzahl === 0, 'und der Stapel ist leer');
}

/*
 * --- 5. Und dieselben Aussagen über die interne Leitung ---------------------
 *
 * Der Kanal fasst den Stapel nicht an, er ruft an. Die Regeln oben nützen also
 * nur, wenn es die Wege dorthin auch gibt — ohne diesen Abschnitt liesse sich
 * `/intern/karte-frisch` aus dem Anmeldeserver löschen, und alles bliebe grün.
 */
{
  const stapel = new Kartenstapel();
  const register = new KanalRegister();
  const store = {} as KontoStore;
  const server = createServer((req, res) => {
    void (async () => {
      if (await behandleIntern(req, res, register, stapel, store)) return;
      res.writeHead(404);
      res.end('nicht hier');
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const adresse = server.address();
  const port = typeof adresse === 'object' && adresse ? adresse.port : 0;

  const ruf = async (pfad: string, koerper: unknown): Promise<Record<string, unknown>> => {
    const antwort = await fetch(`http://127.0.0.1:${port}${pfad}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [GEHEIM_KOPF]: 'geheim-fuer-den-test',
      },
      body: JSON.stringify(koerper),
    });
    return (await antwort.json()) as Record<string, unknown>;
  };

  const karte = stapel.stelleAus(9, 'leitung', 'player');
  check((await ruf('/intern/ticket', { ticket: karte })).accountId === 9, 'die Karte löst sich über die Leitung ein');
  check((await ruf('/intern/karte-frisch', { ticket: karte })).ok === true, 'und lässt sich auffrischen');
  check(
    (await ruf('/intern/karte-frisch', { ticket: 'gibt-es-nicht' })).ok === false,
    'eine erfundene dagegen nicht',
  );
  await ruf('/intern/karte-weg', { ticket: karte });
  check(
    (await ruf('/intern/karte-frisch', { ticket: karte })).ok === false,
    'nach dem Wegwerfen ist auch das Auffrischen vorbei',
  );

  // Ohne Geheimnis geht gar nichts — dieselbe Wache wie bei allen internen
  // Wegen. Ohne diese Prüfung wäre eine neue Route die eine, die man beim
  // Absichern vergisst.
  const ohne = await fetch(`http://127.0.0.1:${port}/intern/karte-frisch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: karte }),
  });
  check(ohne.status === 403, 'ohne Geheimnis bleibt die Tür zu', String(ohne.status));

  server.close();
}

console.log(`\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} von ${checks} fehlgeschlagen.`}`);
process.exit(failures === 0 ? 0 : 1);
