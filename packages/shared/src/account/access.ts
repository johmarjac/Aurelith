/**
 * Zugriffsstufen eines Kontos.
 *
 * Vier Stufen, aufsteigend: wer eine Stufe hat, darf alles, was die Stufen
 * darunter dürfen. Deshalb Zahlen und keine Menge von Rechten — ein Vergleich
 * je Befehl reicht, und eine Rechteliste je Stufe wäre eine zweite Wahrheit
 * über dieselbe Ordnung.
 *
 * Die Zahlen gehen als ein Byte über die Leitung; ihre Reihenfolge ist damit
 * Teil des Vertrags und wird nicht umsortiert.
 */

export const AccessLevel = {
  Player: 0,
  Gamemaster: 1,
  Developer: 2,
  Admin: 3,
} as const;
export type AccessLevel = (typeof AccessLevel)[keyof typeof AccessLevel];

/**
 * Wie die Stufen in der Datenbank stehen.
 *
 * Als Wort und nicht als Zahl: wer in die Tabelle sieht, soll lesen können,
 * womit er es zu tun hat. Die Übersetzung steht hier und nirgends sonst.
 */
export const ACCESS_NAMES: Record<string, AccessLevel> = {
  player: AccessLevel.Player,
  gamemaster: AccessLevel.Gamemaster,
  developer: AccessLevel.Developer,
  admin: AccessLevel.Admin,
};

/** Wort zur Stufe — unbekannte Wörter gelten als gewöhnlicher Spieler. */
export function accessFromName(name: string): AccessLevel {
  return ACCESS_NAMES[name.trim().toLowerCase()] ?? AccessLevel.Player;
}

/** Stufe zum Wort, für Datenbank und Anzeige. */
export function accessName(level: AccessLevel): string {
  for (const [wort, stufe] of Object.entries(ACCESS_NAMES)) {
    if (stufe === level) return wort;
  }
  return 'player';
}

/**
 * Wer welche Stufe bekommt — aus `AURELITH_ADMINS`.
 *
 * Kontoname zu Stufe, Name kleingeschrieben. Was hier drinsteht, gilt bei
 * **jeder** Anmeldung neu: so lässt sich eine Stufe durch Eintragen vergeben
 * und durch Streichen wieder entziehen, ohne je in der Datenbank zu schreiben.
 * Ohne diesen Weg gäbe es auf einem frischen Server auch niemanden, der
 * jemandem etwas geben könnte.
 */
export type Zugriffsliste = ReadonlyMap<string, AccessLevel>;

/**
 * Liest die Liste. `name` allein heisst Verwalter, `name:stufe` die genannte.
 *
 *   AURELITH_ADMINS=johmarjac,helferlein:gamemaster,tester:developer
 *
 * Die Kurzform ohne Doppelpunkt ist kein Schmuck, sondern der Grund, warum
 * bestehende Konfigurationen weiterlaufen: der Wert bedeutete immer schon
 * „Verwalter", und das bleibt so.
 *
 * `:player` ist erlaubt und nimmt eine Stufe ausdrücklich zurück — schärfer
 * als Streichen, denn Streichen lässt stehen, was in der Datenbank steht.
 *
 * Gibt die Beanstandungen mit zurück, statt sie zu schlucken. Ein vertipptes
 * `:gamemster` würde sonst zu `player` — die Stufe wäre still weg, und wer den
 * Wert liest, sähe nur, dass er richtig aussieht.
 */
export function leseZugriffsliste(text: string): {
  liste: Map<string, AccessLevel>;
  fehler: string[];
} {
  const liste = new Map<string, AccessLevel>();
  const fehler: string[] = [];

  for (const roh of text.split(',')) {
    const eintrag = roh.trim();
    if (eintrag.length === 0) continue;

    const doppelpunkt = eintrag.lastIndexOf(':');
    const name = (doppelpunkt < 0 ? eintrag : eintrag.slice(0, doppelpunkt)).trim().toLowerCase();
    const wort = doppelpunkt < 0 ? '' : eintrag.slice(doppelpunkt + 1).trim().toLowerCase();

    if (name.length === 0) {
      fehler.push(`„${eintrag}" nennt keinen Namen.`);
      continue;
    }
    // Bewusst gegen die bekannten Wörter und nicht über `accessFromName`: das
    // gibt für alles Unbekannte „player" zurück, und genau diese Stille ist
    // hier der Fehler, den niemand bemerkt.
    if (wort.length > 0 && !(wort in ACCESS_NAMES)) {
      fehler.push(
        `„${eintrag}" nennt keine bekannte Stufe — erlaubt sind ` +
          `${Object.keys(ACCESS_NAMES).join(', ')}. Der Eintrag gilt nicht.`,
      );
      continue;
    }
    if (liste.has(name)) fehler.push(`„${name}" steht mehrfach in der Liste; der letzte gilt.`);

    liste.set(name, wort.length > 0 ? ACCESS_NAMES[wort]! : AccessLevel.Admin);
  }

  return { liste, fehler };
}

/**
 * Was ein Kontoname sein darf.
 *
 * Gleiche Regel für Konto und Charakter: Buchstaben, Ziffern und ein paar
 * gewöhnliche Zeichen, drei bis sechzehn davon. Streng genug, dass niemand
 * sich mit unsichtbaren Zeichen als jemand anderes ausgibt, und weit genug für
 * jeden Namen, den man aussprechen kann.
 */
export const NAME_PATTERN = /^[A-Za-zÄÖÜäöüß0-9_-]{3,16}$/;

export function isValidName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/** Kürzestes Passwort, das der Server annimmt. */
export const MIN_PASSWORD_LENGTH = 6;
