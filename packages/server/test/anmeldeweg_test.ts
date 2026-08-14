/**
 * Der Anmeldeweg über einen fremden Anbieter — die Teile, die ohne Google
 * prüfbar sind.
 *
 * Das ist absichtlich nicht der ganze Weg: der mittlere Schritt liegt bei
 * Google, und ein Test, der dorthin greift, prüft deren Erreichbarkeit und
 * nicht unseren Code. Was hier geprüft wird, ist alles, was **wir**
 * entscheiden:
 *
 *   1. Bietet der Server diese Anmeldeart überhaupt an, und sagt er es
 *      richtig? (`/anmeldearten`)
 *   2. Geht der Weg nur zu freigegebenen Zielen los? Das ist die eigentliche
 *      Sicherung: am Ende hängt eine Anmeldekarte in der Adresse, und ein
 *      offener Weiterleiter verschenkt sie an jeden, der einen Link schickt.
 *   3. Hält der `state` seine Unterschrift — und fällt er um, wenn jemand
 *      daran dreht?
 *
 * Jede Prüfung hat ihre Gegenprobe unmittelbar daneben: dass ein fremdes Ziel
 * abgelehnt wird, sagt nichts, solange nicht danebensteht, dass das erlaubte
 * durchgeht. Sonst bestünde der Test auch, wenn schlicht alles abgelehnt würde.
 *
 *   npx tsx packages/server/test/anmeldeweg_test.ts
 */

// Vor dem Import: `loginConfig` liest die Umgebung einmal beim Laden, und
// danach steht sie fest. Ein `import` oben im Kopf liefe vor diesen Zeilen.
process.env.AURELITH_GOOGLE_CLIENT_ID = 'test-kennung.apps.googleusercontent.com';
process.env.AURELITH_GOOGLE_CLIENT_SECRET = 'test-geheimnis';
process.env.AURELITH_GOOGLE_REDIRECT_URI = 'https://anmelde.example/auth/google/callback';
process.env.AURELITH_ANMELDE_ZIELE = 'https://spiel.example,http://localhost:5173';
process.env.AURELITH_INTERNAL_SECRET = 'geheim-fuer-den-test';

const { createServer } = await import('node:http');
const { behandleAnbieterweg, googleBereit } = await import('../src/login/anbieterweg.ts');
const { baueState, pruefeState } = await import('../src/login/oauth.ts');
const { Kartenstapel } = await import('../src/login/tickets.ts');
const { loginConfig } = await import('../src/login/config.ts');
import type { KontoStore } from '../src/db/index.ts';

let failures = 0;
function check(ok: boolean, was: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${was}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

// Der Store wird auf keinem der geprüften Wege angefasst: dazu käme es erst
// nach der Antwort von Google, und die gibt es hier nicht.
const store = {} as KontoStore;
const anmeldekarten = new Kartenstapel();

const server = createServer((req, res) => {
  void (async () => {
    if (await behandleAnbieterweg(req, res, store, anmeldekarten)) return;
    res.writeHead(404);
    res.end('nicht hier');
  })();
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const adresse = server.address();
const port = typeof adresse === 'object' && adresse ? adresse.port : 0;
const basis = `http://127.0.0.1:${port}`;

/** Ohne Folgen: die Weiterleitung selbst ist das Ergebnis, nicht ihr Ziel. */
async function hol(pfad: string): Promise<{ status: number; ort: string; text: string }> {
  const antwort = await fetch(`${basis}${pfad}`, { redirect: 'manual' });
  return {
    status: antwort.status,
    ort: antwort.headers.get('location') ?? '',
    text: await antwort.text(),
  };
}

console.log('\nAnmeldearten');

check(googleBereit(), 'mit Kennung, Geheimnis und Rückadresse ist Google bereit');

const arten = await hol('/anmeldearten');
const gemeldet = JSON.parse(arten.text) as { passwort: boolean; google: boolean };
check(arten.status === 200 && gemeldet.google === true, 'und der Server sagt es auch so');
check(gemeldet.passwort === true, 'Name und Passwort gehen unabhängig davon immer');

console.log('\nWohin darf es zurückgehen');

const erlaubt = await hol(`/auth/google/start?ziel=${encodeURIComponent('https://spiel.example/')}`);
check(erlaubt.status === 302, 'ein freigegebenes Ziel führt zur Weiterleitung', String(erlaubt.status));
check(
  erlaubt.ort.startsWith('https://accounts.google.com/o/oauth2/v2/auth'),
  'und zwar zu Google',
  erlaubt.ort.slice(0, 60),
);

// Die Gegenprobe: dieselbe Anfrage, nur ein fremdes Ziel. Ohne sie bestünde
// der Test auch dann, wenn der Weg gar nicht losginge.
const fremd = await hol(`/auth/google/start?ziel=${encodeURIComponent('https://boese.example/')}`);
check(fremd.status === 400, 'ein fremdes Ziel wird abgewiesen', String(fremd.status));
check(fremd.ort === '', 'und es gibt keine Weiterleitung dorthin', fremd.ort);

const ohneZiel = await hol('/auth/google/start');
check(ohneZiel.status === 400, 'ohne Ziel geht es gar nicht erst los');

// Ein Ziel, das auf der Liste steht, aber mit einem anderen Schema — die
// Herkunft ist eine andere, auch wenn der Host derselbe ist.
const falschesSchema = await hol(
  `/auth/google/start?ziel=${encodeURIComponent('http://spiel.example/')}`,
);
check(falschesSchema.status === 400, 'http statt https ist eine andere Herkunft');

console.log('\nDer Zettel für den Rückweg');

const state = baueState('https://spiel.example/', loginConfig.internalSecret);
check(
  pruefeState(state, loginConfig.internalSecret) === 'https://spiel.example/',
  'der eigene Zettel wird wiedererkannt',
);
check(
  pruefeState(state, 'ein anderes Geheimnis') === undefined,
  'einer mit fremder Unterschrift nicht',
);
check(
  pruefeState(`${state.slice(0, -2)}xx`, loginConfig.internalSecret) === undefined,
  'und einer, an dem gedreht wurde, auch nicht',
);

console.log('\nRückweg');

const gefaelscht = await hol('/auth/google/callback?code=egal&state=selbstgebaut');
check(gefaelscht.status === 400, 'ein erfundener state bringt keine Karte', String(gefaelscht.status));
check(anmeldekarten.anzahl === 0, 'und der Stapel bleibt leer');

// Ein echter Zettel, aber Google sagt „abgebrochen": das ist kein Fehler,
// sondern eine Entscheidung — und sie führt zurück ans Ziel, nicht in eine
// Sackgasse. Die Gegenprobe zum abgewiesenen Zettel darüber.
const abgebrochen = await hol(
  `/auth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
);
check(
  abgebrochen.status === 302 && abgebrochen.ort === 'https://spiel.example/#anmeldung=abgebrochen',
  'ein Abbruch bei Google führt zurück ans Ziel',
  abgebrochen.ort,
);
check(anmeldekarten.anzahl === 0, 'auch dabei wird keine Karte ausgestellt');

server.close();
console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
