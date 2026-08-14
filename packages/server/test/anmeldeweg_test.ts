/**
 * Der Anmeldeweg über einen fremden Anbieter — die Teile, die ohne Google und
 * Facebook prüfbar sind.
 *
 * Das ist absichtlich nicht der ganze Weg: der mittlere Schritt liegt beim
 * Anbieter, und ein Test, der dorthin greift, prüft deren Erreichbarkeit und
 * nicht unseren Code. Was hier geprüft wird, ist alles, was **wir**
 * entscheiden:
 *
 *   1. Bietet der Server eine Anmeldeart überhaupt an, und sagt er es richtig?
 *      (`/anmeldearten`)
 *   2. Geht der Weg nur zu freigegebenen Zielen los? Das ist die eigentliche
 *      Sicherung: am Ende hängt eine Anmeldekarte in der Adresse, und ein
 *      offener Weiterleiter verschenkt sie an jeden, der einen Link schickt.
 *   3. Hält der `state` seine Unterschrift — und fällt er um, wenn jemand
 *      daran dreht?
 *
 * Seit es zwei Anbieter gibt, läuft der grösste Teil davon **je Anbieter**:
 * die Wege sind derselbe Code mit einer anderen Kennung, und genau deshalb
 * muss der Test beide gehen. Ein Weg, der nur für Google eingehängt ist,
 * fiele sonst niemandem auf, bis jemand auf den zweiten Knopf drückt.
 *
 * Dazu der Anbieter, der **nicht** eingerichtet ist. Er ist die Gegenprobe zur
 * ganzen Konfiguration: dass ein Knopf erscheint, sagt nichts, solange nicht
 * danebensteht, dass er ohne Zugangsdaten wegbleibt.
 *
 *   npx tsx packages/server/test/anmeldeweg_test.ts
 */

// Vor dem Import: `loginConfig` liest die Umgebung einmal beim Laden, und
// danach steht sie fest. Ein `import` oben im Kopf liefe vor diesen Zeilen.
process.env.AURELITH_GOOGLE_CLIENT_ID = 'test-kennung.apps.googleusercontent.com';
process.env.AURELITH_GOOGLE_CLIENT_SECRET = 'test-geheimnis';
process.env.AURELITH_GOOGLE_REDIRECT_URI = 'https://anmelde.example/auth/google/callback';
process.env.AURELITH_FACEBOOK_CLIENT_ID = '1234567890123456';
process.env.AURELITH_FACEBOOK_CLIENT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.AURELITH_FACEBOOK_REDIRECT_URI = 'https://anmelde.example/auth/facebook/callback';
process.env.AURELITH_ANMELDE_ZIELE = 'https://spiel.example,http://localhost:5173';
process.env.AURELITH_INTERNAL_SECRET = 'geheim-fuer-den-test';

const { createServer } = await import('node:http');
const { behandleAnbieterweg, anbieterBereit } = await import('../src/login/anbieterweg.ts');
const { ANBIETER, baueState, pruefeState } = await import('../src/login/oauth.ts');
const { Kartenstapel } = await import('../src/login/tickets.ts');
const { loginConfig } = await import('../src/login/config.ts');
import type { KontoStore } from '../src/db/index.ts';

let failures = 0;
function check(ok: boolean, was: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${was}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

// Der Store wird auf keinem der geprüften Wege angefasst: dazu käme es erst
// nach der Antwort des Anbieters, und die gibt es hier nicht.
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

/** Wohin der Browser beim Start geschickt wird — je Anbieter eine andere Adresse. */
const ERWARTET: Record<string, string> = {
  google: 'https://accounts.google.com/o/oauth2/v2/auth',
  facebook: 'https://www.facebook.com/',
};

console.log('\nAnmeldearten');

const arten = await hol('/anmeldearten');
const gemeldet = JSON.parse(arten.text) as Record<string, boolean>;
check(arten.status === 200, 'der Weg antwortet', String(arten.status));
check(gemeldet.passwort === true, 'Name und Passwort gehen unabhängig davon immer');

for (const a of ANBIETER) {
  check(anbieterBereit(a), `mit Kennung, Geheimnis und Rückadresse ist ${a.name} bereit`);
  check(gemeldet[a.id] === true, `und der Server sagt es auch so (${a.id})`);
}

/*
 * Die Gegenprobe zur ganzen Konfiguration.
 *
 * Ein erfundener Anbieter steht in keiner Tabelle, hat keine Zugangsdaten und
 * darf deshalb weder in der Liste auftauchen noch einen Weg haben. Ohne diese
 * Prüfung bestünde der Test auch dann, wenn `/anmeldearten` schlicht alles mit
 * `true` beantwortete.
 */
check(gemeldet.myspace === undefined, 'ein Anbieter, den es nicht gibt, steht nicht in der Liste');
const erfunden = await hol(`/auth/myspace/start?ziel=${encodeURIComponent('https://spiel.example/')}`);
check(erfunden.status === 404, 'und hat auch keinen Weg', String(erfunden.status));

for (const a of ANBIETER) {
  console.log(`\nWohin darf es zurückgehen — ${a.name}`);

  const erlaubt = await hol(
    `/auth/${a.id}/start?ziel=${encodeURIComponent('https://spiel.example/')}`,
  );
  check(erlaubt.status === 302, 'ein freigegebenes Ziel führt zur Weiterleitung', String(erlaubt.status));
  check(
    erlaubt.ort.startsWith(ERWARTET[a.id]!),
    `und zwar zu ${a.name}`,
    erlaubt.ort.slice(0, 60),
  );
  // Der Zettel muss mitgehen — ohne ihn gäbe es auf dem Rückweg kein Ziel,
  // und die Weiterleitung sähe trotzdem richtig aus.
  check(new URL(erlaubt.ort).searchParams.get('state') !== null, 'mit dem Zettel für den Rückweg');

  // Die Gegenprobe: dieselbe Anfrage, nur ein fremdes Ziel. Ohne sie bestünde
  // der Test auch dann, wenn der Weg gar nicht losginge.
  const fremd = await hol(`/auth/${a.id}/start?ziel=${encodeURIComponent('https://boese.example/')}`);
  check(fremd.status === 400, 'ein fremdes Ziel wird abgewiesen', String(fremd.status));
  check(fremd.ort === '', 'und es gibt keine Weiterleitung dorthin', fremd.ort);

  const ohneZiel = await hol(`/auth/${a.id}/start`);
  check(ohneZiel.status === 400, 'ohne Ziel geht es gar nicht erst los');

  // Ein Ziel, das auf der Liste steht, aber mit einem anderen Schema — die
  // Herkunft ist eine andere, auch wenn der Host derselbe ist.
  const falschesSchema = await hol(
    `/auth/${a.id}/start?ziel=${encodeURIComponent('http://spiel.example/')}`,
  );
  check(falschesSchema.status === 400, 'http statt https ist eine andere Herkunft');
}

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

for (const a of ANBIETER) {
  console.log(`\nRückweg — ${a.name}`);

  const gefaelscht = await hol(`/auth/${a.id}/callback?code=egal&state=selbstgebaut`);
  check(
    gefaelscht.status === 400,
    'ein erfundener state bringt keine Karte',
    String(gefaelscht.status),
  );
  check(anmeldekarten.anzahl === 0, 'und der Stapel bleibt leer');

  // Ein echter Zettel, aber der Anbieter sagt „abgebrochen": das ist kein
  // Fehler, sondern eine Entscheidung — und sie führt zurück ans Ziel, nicht
  // in eine Sackgasse. Die Gegenprobe zum abgewiesenen Zettel darüber.
  const abgebrochen = await hol(
    `/auth/${a.id}/callback?error=access_denied&state=${encodeURIComponent(state)}`,
  );
  check(
    abgebrochen.status === 302 && abgebrochen.ort === 'https://spiel.example/#anmeldung=abgebrochen',
    'ein Abbruch beim Anbieter führt zurück ans Ziel',
    abgebrochen.ort,
  );
  check(anmeldekarten.anzahl === 0, 'auch dabei wird keine Karte ausgestellt');
}

/*
 * Die Warnungen beim Start.
 *
 * Sie sind der einzige Hinweis auf eine Konfiguration, die falsch **aussieht**
 * und nach der der Anbieter nur „invalid_client" sagt. Geprüft wird die Regel
 * selbst und nicht die Ausgabe: was gemeldet wird, entscheidet der Anbieter in
 * seiner Tabelle, und dort steht es je einmal.
 */
console.log('\nWas an einer Konfiguration auffällt');

const google = ANBIETER.find((a) => a.id === 'google')!;
const facebook = ANBIETER.find((a) => a.id === 'facebook')!;
const echt = { clientId: '', clientSecret: '', redirectUri: '' };

check(
  google.auffaelligkeiten({
    ...echt,
    clientId: 'x.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-1234567890123456789012345678',
  }).length === 0,
  'eine stimmige Google-Konfiguration gibt keinen Anlass',
);
check(
  google.auffaelligkeiten({ ...echt, clientId: 'x.apps.googleusercontent.com', clientSecret: 'GOCSPX-kurz' })
    .length === 1,
  'ein zu kurzes Geheimnis dagegen schon',
);
check(
  facebook.auffaelligkeiten({
    ...echt,
    clientId: '1234567890123456',
    clientSecret: '0123456789abcdef0123456789abcdef',
  }).length === 0,
  'eine stimmige Facebook-Konfiguration gibt keinen Anlass',
);
check(
  facebook.auffaelligkeiten({
    ...echt,
    clientId: '0123456789abcdef0123456789abcdef',
    clientSecret: '1234567890123456',
  }).length === 2,
  'vertauschte App-ID und Geheimnis fallen auf — beide',
);

server.close();
console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
