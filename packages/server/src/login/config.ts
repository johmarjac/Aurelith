/**
 * Konfiguration des Anmeldeservers.
 *
 * Getrennt von der des Spielservers, weil es zwei Anwendungen sind: der
 * Anmeldeserver braucht keine Karten, keinen Startpunkt und keine Tickrate,
 * und ein gemeinsamer Kasten mit dreissig Feldern, von denen jede Seite
 * fünfzehn ignoriert, sagt beim Lesen nichts mehr darüber, was wozu gehört.
 *
 * Was beide brauchen — die Datenbank, die Verwalterliste —, steht in beiden.
 * Das ist kein Widerspruch zur einen Wahrheit: die Werte kommen aus derselben
 * Umgebungsvariable, hier wird nur gelesen.
 */

import { ermittleBuildStamp } from '@aurelith/shared/build/ermitteln.node.ts';

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const loginConfig = {
  host: env('AURELITH_LOGIN_HOST', '0.0.0.0'),
  port: envNum('AURELITH_LOGIN_PORT', 8790),

  /**
   * Dieselbe Datenbank wie die Spielserver.
   *
   * Konten stehen darin, und die Figurenliste ebenfalls — eine Figur gehört
   * einem Konto und nicht einem Kanal. Wer auf Kanal 2 wechselt, findet
   * dieselben Figuren vor; alles andere wäre für einen Spieler nicht zu
   * erklären.
   */
  databaseUrl: process.env.DATABASE_URL ?? '',

  /**
   * Das gemeinsame Geheimnis für die internen Wege.
   *
   * Damit weist sich ein Spielserver aus, wenn er sich anmeldet oder eine
   * Eintrittskarte einlöst. Ohne das könnte jeder im Netz einen Kanal in die
   * Liste stellen und Spieler auf seinen Rechner locken.
   *
   * Der Vorgabewert ist absichtlich offensichtlich und der Server sagt beim
   * Start, dass er gilt: ein Geheimnis, das man vergessen kann zu setzen,
   * sollte wenigstens laut sein.
   */
  internalSecret: env('AURELITH_INTERNAL_SECRET', 'aurelith-entwicklung'),

  /**
   * Anmeldung über Google — leer heisst: gibt es hier nicht.
   *
   * Alle drei Angaben stammen aus der Google Cloud Console. `redirectUri` muss
   * dort **wörtlich** eingetragen sein: ein fehlender Schrägstrich reicht für
   * eine Absage, und die kommt dann von Google und nicht von uns.
   *
   * Ohne Kennung und Geheimnis bietet der Server diese Anmeldeart gar nicht
   * erst an — der Knopf im Client erscheint nicht. Ein Knopf, der zu einer
   * Fehlerseite führt, ist schlechter als keiner.
   */
  google: {
    clientId: env('AURELITH_GOOGLE_CLIENT_ID', ''),
    clientSecret: env('AURELITH_GOOGLE_CLIENT_SECRET', ''),
    redirectUri: env('AURELITH_GOOGLE_REDIRECT_URI', ''),
  },

  /**
   * Wohin der Anmeldeweg zurückschicken darf — Herkünfte, mit Komma getrennt.
   *
   * Am Ende des Weges hängt eine **Anmeldekarte** in der Adresse, und die ist
   * so gut wie ein Passwort. Käme das Ziel ungeprüft aus der Anfrage, liesse
   * sich jeder Spieler mit einem Link auf eine fremde Seite schicken, die die
   * Karte aus der Adresse liest und sich damit anmeldet — ein offener
   * Weiterleiter ist hier keine Unschönheit, sondern das Loch selbst.
   *
   * Der Client liegt auf GitHub Pages und damit auf einer anderen Herkunft als
   * dieser Server; deshalb eine Liste und nicht „dieselbe Herkunft".
   *
   *   AURELITH_ANMELDE_ZIELE=https://johmarjac.github.io,http://localhost:5173
   */
  ziele: env('AURELITH_ANMELDE_ZIELE', '')
    .split(',')
    .map((z) => z.trim())
    .filter((z) => z.length > 0),

  admins: env('AURELITH_ADMINS', '')
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length > 0),

  tls: ((): { keyPath: string; certPath: string } | undefined => {
    const keyPath = process.env.AURELITH_LOGIN_TLS_KEY ?? '';
    const certPath = process.env.AURELITH_LOGIN_TLS_CERT ?? '';
    return keyPath && certPath ? { keyPath, certPath } : undefined;
  })(),

  build: ermittleBuildStamp(),
} as const;
