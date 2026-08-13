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
