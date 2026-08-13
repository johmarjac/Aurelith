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
