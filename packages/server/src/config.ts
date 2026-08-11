/**
 * Serverkonfiguration. Alles über Umgebungsvariablen, mit Standardwerten, die
 * eine lokale Entwicklungssitzung ohne jede Vorbereitung starten lassen.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

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

export interface TlsConfig {
  keyPath: string;
  certPath: string;
}

export const config = {
  host: env('AURELITH_HOST', '0.0.0.0'),
  port: envNum('AURELITH_PORT', 8787),

  /** Wo die Map-Dokumente liegen. Im Betrieb dieselben Dateien wie im CDN. */
  mapsDir: env('AURELITH_MAPS_DIR', join(repoRoot, 'assets', 'maps')),

  /** Map, auf der ein neuer Charakter startet. */
  startMap: env('AURELITH_START_MAP', 'lichtmoor'),

  /**
   * PostgreSQL-Verbindung. Fehlt sie, läuft der Server mit einem
   * Speicher-Backend weiter — praktisch für schnelle Tests, aber alles ist
   * beim Neustart weg. Der Server sagt das beim Hochfahren deutlich.
   */
  databaseUrl: process.env.DATABASE_URL ?? '',

  /**
   * TLS. Sind beide Pfade gesetzt, hört der Server auf wss:// statt ws://.
   * Das ist die Verschlüsselungsstufe, die tatsächlich schützt — die
   * Paket-Cipher im Frame-Header kommt zusätzlich, nicht stattdessen.
   */
  tls: ((): TlsConfig | undefined => {
    const keyPath = process.env.AURELITH_TLS_KEY ?? '';
    const certPath = process.env.AURELITH_TLS_CERT ?? '';
    return keyPath && certPath ? { keyPath, certPath } : undefined;
  })(),

  /**
   * Sekunden ohne Lebenszeichen, nach denen eine Sitzung fliegt.
   *
   * Grosszuegig bemessen, weil Browser Zeitgeber in Hintergrund-Tabs drosseln:
   * erst auf hoechstens einmal je Sekunde, nach einigen Minuten im Hintergrund
   * auf etwa einmal je Minute. Ein Fenster von dreissig Sekunden wirft dann
   * jeden raus, der den Tab kurz wechselt.
   */
  sessionTimeoutSeconds: envNum('AURELITH_SESSION_TIMEOUT', 90),

  /** Wie oft der Spielstand in die Datenbank geschrieben wird. */
  persistIntervalSeconds: envNum('AURELITH_PERSIST_INTERVAL', 30),

  /** Obergrenze der Eingabepakete pro Sekunde und Sitzung. */
  maxInputsPerSecond: envNum('AURELITH_MAX_INPUT_RATE', 60),

  repoRoot,
} as const;
