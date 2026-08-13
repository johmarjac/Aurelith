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
    const passt = account ? await verifyPassword(passwort, account.passwordHash) : false;
    if (!account || !passt) return { ok: false, fehler: 'Name oder Passwort stimmt nicht.' };
  }

  const gewuenscht = istAdmin ? accessName(AccessLevel.Admin) : account.accessLevel;
  if (gewuenscht !== account.accessLevel) {
    await store.setAccessLevel(account.id, gewuenscht);
    account = { ...account, accessLevel: gewuenscht };
  }

  return { ok: true, account };
}
