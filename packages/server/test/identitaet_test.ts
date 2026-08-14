/**
 * Ein Mensch, zwei Anbieter, ein Konto.
 *
 * Der Anlass ist eine Anmeldung, die scheiterte, obwohl alles richtig war:
 * dasselbe Postfach bei Google und bei Facebook, und der zweite Weg lief gegen
 * ein Konto, das es schon gab. Der Server legte dann keines an — richtig — und
 * verband auch nichts — falsch.
 *
 * Geprüft wird die Regel, die daraus wurde: **über Anbieter hinweg entscheidet
 * die Adresse.** Wer mit derselben Adresse wiederkommt, findet dasselbe Konto
 * und dieselben Figuren vor, egal über wen.
 *
 * Und die Gegenproben, ohne die das nur die halbe Aussage wäre:
 *
 *   - Zwei **verschiedene** Adressen sind zwei Konten. Ohne das ginge auch ein
 *     „alle bekommen dasselbe Konto" als bestanden durch.
 *   - Ein Konto **mit Passwort** bekommt nichts angehängt. Das ist die Grenze
 *     der ganzen Regel: an ein selbstgewähltes Konto käme man sonst über einen
 *     Anbieter heran, bei dem man sich die Adresse aussucht.
 *   - Die Kennung des Anbieters bleibt der Schlüssel. Wer seine Adresse dort
 *     ändert, behält sein Konto.
 *
 * Ohne Netz und ohne Datenbank: die Regel steht in `accounts.ts`, der
 * Speicher im Arbeitsspeicher.
 *
 *   npx tsx packages/server/test/identitaet_test.ts
 */

import { leseZugriffsliste } from '@aurelith/shared';
import { anmeldenMitIdentitaet, anmelden } from '../src/accounts.ts';
import { MemoryStore } from '../src/db/memory.ts';

let failures = 0;
function check(ok: boolean, was: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${was}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const store = new MemoryStore();
await store.init();

/** Ohne Verwalterliste: die Stufen prüft `account_test.ts`. */
const keine = leseZugriffsliste('').liste;

const melde = (provider: string, subject: string, email: string) =>
  anmeldenMitIdentitaet(store, provider, subject, email, keine);

console.log('Aurelith — Konten über Anbieter hinweg\n');

console.log('Dieselbe Adresse, zwei Anbieter');

const ersteAnmeldung = await melde('google', 'goog-1', 'jemand@example.com');
check(ersteAnmeldung.ok, 'die erste Anmeldung legt ein Konto an');
const konto = ersteAnmeldung.ok ? ersteAnmeldung.account : undefined;
check(konto?.name === 'jemand@example.com', 'das Konto heisst wie die Adresse', konto?.name);

const zweite = await melde('facebook', 'fb-1', 'jemand@example.com');
check(zweite.ok, 'der zweite Anbieter kommt durch', zweite.ok ? '' : zweite.fehler);
check(
  zweite.ok && zweite.account.id === konto?.id,
  'und landet auf demselben Konto',
  zweite.ok ? `${zweite.account.id} statt ${konto?.id}` : '',
);

// Und beim nächsten Mal ist es keine Verknüpfung mehr, sondern ein Wiedersehen:
// die Identität steht jetzt in der Tabelle und wird gefunden.
const nochmal = await melde('facebook', 'fb-1', 'jemand@example.com');
check(
  nochmal.ok && nochmal.account.id === konto?.id,
  'beim nächsten Mal wird die Identität schlicht gefunden',
);

console.log('\nDie Gegenproben');

const andere = await melde('facebook', 'fb-2', 'wer.anders@example.com');
check(
  andere.ok && andere.account.id !== konto?.id,
  'eine andere Adresse ist ein anderes Konto',
  andere.ok ? String(andere.account.id) : '',
);

/*
 * Die Kennung des Anbieters bleibt der Schlüssel, nicht die Adresse.
 *
 * Wer seine Adresse bei Google ändert, kommt mit derselben `sub` und einer
 * neuen Adresse wieder — und behält sein Konto samt Figuren. Der angezeigte
 * Name bleibt dabei der alte; ihn nachzuziehen wäre eine eigene Entscheidung
 * mit eigenen Folgen (der Name steht in jeder Freundesliste).
 */
const umgezogen = await melde('google', 'goog-1', 'neue.adresse@example.com');
check(
  umgezogen.ok && umgezogen.account.id === konto?.id,
  'eine neue Adresse bei derselben Kennung behält das Konto',
);
check(
  umgezogen.ok && umgezogen.account.name === 'jemand@example.com',
  'der Kontoname bleibt dabei der alte',
  umgezogen.ok ? umgezogen.account.name : '',
);

/*
 * Die Grenze: ein Konto mit Passwort.
 *
 * Angelegt wird es hier am Regelwerk vorbei, direkt im Speicher — über
 * `anmelden` ginge es gar nicht, weil `isValidName` kein `@` zulässt. Genau
 * das ist der Punkt: die Prüfung in `accounts.ts` darf sich nicht auf jenen
 * Namensfilter verlassen, sondern muss selbst nachsehen, ob da ein Passwort
 * steht.
 */
const mitPasswort = await store.createAccount('geschuetzt@example.com', 'ein-hash', 'player');
const uebernahme = await melde('facebook', 'fb-3', 'geschuetzt@example.com');
check(mitPasswort !== undefined, 'ein Konto mit Passwort steht bereit', mitPasswort?.name);
check(!uebernahme.ok, 'ein Anbieter bekommt es nicht angehängt');
check(
  (await store.findeIdentitaet('facebook', 'fb-3')) === undefined,
  'und es entsteht auch keine Identität dazu',
);

/*
 * Und der Weg über das Passwort bleibt für Anbieterkonten zu.
 *
 * Sie haben keines — der Hash ist leer. Ohne diese Prüfung käme man in ein
 * Google-Konto mit einem leeren Passwort hinein.
 */
const ueberPasswort = await anmelden(store, 'jemand@example.com', '', false, keine);
check(!ueberPasswort.ok, 'in ein Anbieterkonto kommt man nicht per Passwort');

console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
