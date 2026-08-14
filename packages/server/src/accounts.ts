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
  type Zugriffsliste,
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
 * **Der Kontoname ist die E-Mail-Adresse.** Sie ist beim Anbieter eindeutig,
 * und damit fällt der ganze Umweg weg, der vorher nötig war: aus Googles
 * Vornamen einen zulässigen Namen basteln, feststellen, dass „Jonas" schon
 * vergeben ist, und „Jonas2" daraus machen. Zwei Menschen namens Jonas bekamen
 * so Namen, die keiner von beiden gewählt hat; zwei Adressen kollidieren gar
 * nicht erst.
 *
 * Deshalb gilt `isValidName` hier **nicht**. Die Regel — drei bis sechzehn
 * Zeichen ohne `@` und `.` — ist für selbstgewählte Namen da: sie hält
 * Verwechslungen und unsichtbare Zeichen draussen, wo jemand sich einen Namen
 * ausdenkt. Eine Adresse denkt sich niemand aus, sie wird nachgewiesen. Und
 * weil ein Passwortkonto wegen dieser Regel niemals ein `@` enthalten kann,
 * können die beiden Sorten sich auch nicht ins Gehege kommen.
 *
 * Der **Identitätsschlüssel** bleibt trotzdem `subject` und nicht die Adresse:
 * die kann sich ändern, weitergegeben und in manchen Verzeichnissen sogar neu
 * vergeben werden. Wer seine Adresse bei Google ändert, behält hier sein Konto
 * — nur der angezeigte Name bleibt der alte.
 *
 * **Über Anbieter hinweg zählt aber die Adresse.** Wer sich gestern über Google
 * angemeldet hat und heute über Facebook, findet dasselbe Konto und dieselben
 * Figuren vor, sofern dieselbe Adresse dabei herauskommt. Das Konto sammelt
 * die Identitäten; die Tabelle konnte das immer, ihr Schlüssel ist (Anbieter,
 * Kennung).
 *
 * Das steht und fällt damit, dass der Anbieter die Adresse **geprüft** hat —
 * sonst genügte ein Konto bei irgendeinem Anbieter mit frei eingetragener
 * Adresse, um an ein fremdes Spielkonto zu kommen. Deshalb prüft der
 * Anbieterweg das, bevor er hierherkommt (`email_verified` bei Google), und
 * deshalb hängt hier nichts an einem Anbieter, der es nicht sagt.
 */
export async function anmeldenMitIdentitaet(
  store: KontoStore,
  provider: string,
  subject: string,
  email: string,
  zugriff: Zugriffsliste,
): Promise<AnmeldeErgebnis> {
  const vorhanden = await store.findeIdentitaet(provider, subject);
  if (vorhanden) return { ok: true, account: await ziehStufeNach(store, vorhanden, zugriff) };

  /*
   * Ohne Adresse ein Ersatzname aus der Kennung des Anbieters.
   *
   * Google liefert sie mit dem angefragten Bereich immer mit; „immer" heisst
   * hier aber „bisher immer". Ein Konto ohne Namen ginge gar nicht anzulegen,
   * und ein leerer Name wäre in jeder Liste eine Lücke, die niemand erklären
   * kann.
   */
  const name = email.trim().toLowerCase() || `${provider}-${subject}`.slice(0, 64);

  const konto = await store.legeKontoMitIdentitaet(
    name,
    accessName(zugriff.get(name) ?? AccessLevel.Player),
    provider,
    subject,
    email,
  );
  if (konto) return { ok: true, account: konto };

  /*
   * Den Namen gibt es schon, die Identität aber nicht — sonst hätte die
   * Abfrage oben sie gefunden.
   *
   * Das heisst: **dieselbe Adresse, ein anderer Anbieter.** Wer sich gestern
   * über Google angemeldet hat und heute über Facebook, ist dieselbe Person,
   * und die Adresse ist hier der Kontoname. Also bekommt das bestehende Konto
   * die neue Identität dazu und der Spieler seine Figuren.
   *
   * Vorher stand hier eine Absage, mit dem Argument, die Adresse habe „jemand
   * anderes nachgewiesen". Das stimmt für den Fall, dass ein Anbieter Adressen
   * herausgibt, die er nicht geprüft hat — und genau dagegen steht die Prüfung
   * eine Ebene höher, beim Anbieter selbst (`email_verified`). Was übrig
   * bleibt, sind zwei bestätigte Nachweise derselben Adresse, und zwei Konten
   * daraus zu machen wäre einem Spieler nicht zu erklären.
   */
  const bestehend = await store.findAccount(name);

  /*
   * Nur an Konten **ohne Passwort**.
   *
   * Ein Passwortkonto kann diesen Namen ohnehin nicht tragen — `isValidName`
   * lässt kein `@` zu. Die Prüfung steht trotzdem hier und nicht als Verweis
   * auf jene Regel: sie ist die genaue Aussage, um die es geht. Wer sie
   * weglässt, hängt die Sicherheit eines Kontos mit Passwort an einen
   * Namensfilter zwei Dateien weiter — und der wird eines Tages gelockert,
   * ohne dass jemand an diese Stelle denkt.
   */
  if (bestehend && bestehend.passwordHash === '') {
    await store.verknuepfeIdentitaet(bestehend.id, provider, subject, email);
    console.log(`[konto] „${name}" bekommt ${provider} als weiteren Anbieter.`);
    return { ok: true, account: await ziehStufeNach(store, bestehend, zugriff) };
  }

  console.warn(
    `[konto] „${name}" existiert bereits — mit Passwort, also wird nichts verknüpft.`,
  );
  return {
    ok: false,
    fehler: 'Zu dieser Adresse gibt es schon ein Konto. Wende dich an die Serververwaltung.',
  };
}

/** Die Zugriffsliste gilt auch hier — eine Regel, ein Ort. */
async function ziehStufeNach(
  store: KontoStore,
  account: AccountRecord,
  zugriff: Zugriffsliste,
): Promise<AccountRecord> {
  const stufe = zugriff.get(account.name.toLowerCase());
  const gewuenscht = stufe === undefined ? account.accessLevel : accessName(stufe);
  if (gewuenscht === account.accessLevel) return account;
  await store.setAccessLevel(account.id, gewuenscht);
  return { ...account, accessLevel: gewuenscht };
}

/**
 * Meldet an oder legt an.
 *
 * `zugriff` ist die Zugriffsliste aus der Konfiguration. Sie gilt bei **jeder**
 * Anmeldung: so lässt sich eine Stufe vergeben und wieder entziehen, ohne in
 * der Datenbank zu schreiben — und ohne diesen Weg gäbe es auf einem frischen
 * Server niemanden, der jemandem etwas geben könnte.
 *
 * Wer **nicht** in der Liste steht, behält, was in der Datenbank steht. Das
 * ist der Unterschied zwischen „nicht genannt" und `:player`: das eine lässt
 * in Ruhe, das andere nimmt ausdrücklich zurück.
 */
export async function anmelden(
  store: KontoStore,
  name: string,
  passwort: string,
  anlegen: boolean,
  zugriff: Zugriffsliste,
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

  const gewuenschteStufe = zugriff.get(sauber.toLowerCase());
  let account = await store.findAccount(sauber);

  if (anlegen) {
    if (account) return { ok: false, fehler: 'Diesen Namen gibt es schon.' };
    account = await store.createAccount(
      sauber,
      await hashPassword(passwort),
      accessName(gewuenschteStufe ?? AccessLevel.Player),
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

  const gewuenscht =
    gewuenschteStufe === undefined ? account.accessLevel : accessName(gewuenschteStufe);
  if (gewuenscht !== account.accessLevel) {
    await store.setAccessLevel(account.id, gewuenscht);
    account = { ...account, accessLevel: gewuenscht };
  }

  return { ok: true, account };
}
