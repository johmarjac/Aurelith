/**
 * Konten: anmelden und anlegen.
 *
 * Eine Stelle für beides, weil es zwei Aufrufer gibt: den Anmeldeserver, der
 * im Betrieb der einzige ist, der Passwörter sieht — und den Spielserver in
 * seinem Alleinbetrieb, in dem er ohne Anmeldeserver läuft (Entwicklung,
 * Prüfungen). Zwei Abschriften dieser Regeln wären zwei Antworten auf „wann
 * ist ein Passwort in Ordnung", und die eine davon würde beim Nachschärfen
 * vergessen.
 *
 * Was hier **nicht** steht: wer schon angemeldet ist. Das weiss der
 * Anmeldeserver, weil nur er alle Kanäle kennt.
 */

import {
  AccessLevel,
  MIN_PASSWORD_LENGTH,
  accessName,
  isValidName,
} from '@aurelith/shared';
import { hashPassword, verifyPassword } from './passwords.ts';
import type { AccountRecord, KontoStore } from './db/index.ts';

export type AnmeldeErgebnis =
  | { ok: true; account: AccountRecord }
  /**
   * Der Text ist für Menschen und benennt bewusst nicht, ob Name oder
   * Passwort falsch war — sonst liesse sich damit prüfen, welche Konten es
   * gibt.
   */
  | { ok: false; fehler: string };

/**
 * Findet oder legt das Konto zu einer fremden Identität an.
 *
 * Kein Passwort im Spiel: wer über Google kommt, hat hier keines, und
 * `anmelden` weist eine Passwortanmeldung für so ein Konto ab — der leere Hash
 * passt zu keiner Eingabe.
 *
 * Der **Name** ist die einzige heikle Stelle. Google liefert einen Vornamen,
 * und der ist weder eindeutig noch immer brauchbar („Jörg", „李"). Daraus wird
 * ein zulässiger Vorschlag gemacht und, wenn er vergeben ist, durchnummeriert.
 * Dass der Spieler ihn nicht selbst wählt, ist eine bewusste Verkürzung für
 * den Anfang: die Alternative wäre eine zweite Maske im Anmeldeweg, und die
 * gehört gebaut, wenn die Anmeldung selbst steht.
 */
export async function anmeldenMitIdentitaet(
  store: KontoStore,
  provider: string,
  subject: string,
  vorschlag: string,
  email: string,
  admins: readonly string[],
): Promise<AnmeldeErgebnis> {
  const vorhanden = await store.findeIdentitaet(provider, subject);
  if (vorhanden) return { ok: true, account: await ziehStufeNach(store, vorhanden, admins) };

  const basis = machNamen(vorschlag || email.split('@')[0] || 'Held');
  for (let versuch = 0; versuch < 20; versuch++) {
    // Der erste Versuch ohne Anhängsel: „Jonas" ist schöner als „Jonas1".
    const name = versuch === 0 ? basis : `${basis}${versuch + 1}`.slice(0, 16);
    const istAdmin = admins.includes(name.toLowerCase());
    const konto = await store.legeKontoMitIdentitaet(
      name,
      accessName(istAdmin ? AccessLevel.Admin : AccessLevel.Player),
      provider,
      subject,
      email,
    );
    if (konto) return { ok: true, account: konto };
  }

  return { ok: false, fehler: 'Es liess sich kein freier Name finden. Versuch es noch einmal.' };
}

/**
 * Macht aus einem beliebigen Namen einen zulässigen.
 *
 * Dieselben Regeln wie `isValidName` — drei bis sechzehn Zeichen aus
 * Buchstaben, Ziffern, Strich und Unterstrich. Was übrig bleibt, wird
 * aufgefüllt: ein Name aus lauter Zeichen, die hier nicht zählen, ergäbe
 * sonst einen leeren.
 */
function machNamen(roh: string): string {
  const sauber = roh.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16);
  return sauber.length >= 3 ? sauber : `Held${sauber}`.slice(0, 16);
}

/** Die Verwalterliste gilt auch hier — eine Regel, ein Ort. */
async function ziehStufeNach(
  store: KontoStore,
  account: AccountRecord,
  admins: readonly string[],
): Promise<AccountRecord> {
  const gewuenscht = admins.includes(account.name.toLowerCase())
    ? accessName(AccessLevel.Admin)
    : account.accessLevel;
  if (gewuenscht === account.accessLevel) return account;
  await store.setAccessLevel(account.id, gewuenscht);
  return { ...account, accessLevel: gewuenscht };
}

/**
 * Meldet an oder legt an.
 *
 * `admins` ist die Liste der Verwalterkonten aus der Konfiguration. Sie gilt
 * bei **jeder** Anmeldung: so lässt sich eine Stufe vergeben und wieder
 * entziehen, ohne in der Datenbank zu schreiben — und ohne diesen Weg gäbe es
 * auf einem frischen Server niemanden, der jemandem etwas geben könnte.
 */
export async function anmelden(
  store: KontoStore,
  name: string,
  passwort: string,
  anlegen: boolean,
  admins: readonly string[],
): Promise<AnmeldeErgebnis> {
  const sauber = name.trim();

  if (!isValidName(sauber)) {
    return {
      ok: false,
      fehler: 'Der Name darf drei bis sechzehn Buchstaben, Ziffern, Strich oder Unterstrich haben.',
    };
  }
  if (anlegen && passwort.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, fehler: `Das Passwort braucht mindestens ${MIN_PASSWORD_LENGTH} Zeichen.` };
  }

  const istAdmin = admins.includes(sauber.toLowerCase());
  let account = await store.findAccount(sauber);

  if (anlegen) {
    if (account) return { ok: false, fehler: 'Diesen Namen gibt es schon.' };
    account = await store.createAccount(
      sauber,
      await hashPassword(passwort),
      accessName(istAdmin ? AccessLevel.Admin : AccessLevel.Player),
    );
    // Zwischen Nachsehen und Anlegen war jemand schneller.
    if (!account) return { ok: false, fehler: 'Diesen Namen gibt es schon.' };
  } else {
    // Ein Konto ohne Passwort gehört zu einem Anbieter. Der leere Hash passt
    // zu keiner Eingabe, aber die Prüfung steht hier ausdrücklich: sonst hinge
    // die Sicherheit daran, dass `verifyPassword` mit einem leeren Hash das
    // Richtige tut, und das ist eine Zusicherung, die man nicht sieht.
    const ohnePasswort = account !== undefined && account.passwordHash === '';
    const passt =
      account && !ohnePasswort ? await verifyPassword(passwort, account.passwordHash) : false;
    if (ohnePasswort) {
      return {
        ok: false,
        fehler: 'Dieses Konto meldet sich über einen Anbieter an — nimm den Knopf dafür.',
      };
    }
    if (!account || !passt) return { ok: false, fehler: 'Name oder Passwort stimmt nicht.' };
  }

  const gewuenscht = istAdmin ? accessName(AccessLevel.Admin) : account.accessLevel;
  if (gewuenscht !== account.accessLevel) {
    await store.setAccessLevel(account.id, gewuenscht);
    account = { ...account, accessLevel: gewuenscht };
  }

  return { ok: true, account };
}
