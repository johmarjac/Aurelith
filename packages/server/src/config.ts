/**
 * Serverkonfiguration. Alles über Umgebungsvariablen, mit Standardwerten, die
 * eine lokale Entwicklungssitzung ohne jede Vorbereitung starten lassen.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ermittleBuildStamp } from '@aurelith/shared/build/ermitteln.node.ts';

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

  /**
   * Wo die Inhaltstabellen liegen — Gegenstände, Monster, NPCs, Aufträge.
   *
   * Ebenfalls dieselben Dateien wie im CDN. Wer Inhalte ändern will, ändert
   * sie dort und startet den Server neu; gebaut werden muss nichts.
   */
  contentDir: env('AURELITH_CONTENT_DIR', join(repoRoot, 'assets', 'content')),

  /** Map, auf der ein neuer Charakter startet. */
  startMap: env('AURELITH_START_MAP', 'lichtmoor'),

  /**
   * Startpunkt eines neuen Charakters, als `"x,z"` oder `"x,z,blickrichtung"`.
   *
   * Ohne die Angabe gilt der Startpunkt der Karte, und das ist im Betrieb auch
   * das Richtige. Gedacht ist sie für Prüfungen: der Portaltest musste bisher
   * erst achtundzwanzig Simulationsschritte zum Tor laufen, und auf Lichtmoor
   * wären es zweihundert Einheiten gewesen. Wer den Startpunkt setzen kann,
   * prüft in Sekunden, was sonst eine Minute Anlauf braucht.
   *
   * Wirkt nur bei der **Erzeugung** eines Charakters. Wer schon einen hat,
   * behält seine gespeicherte Stelle — sonst würde die Angabe im Betrieb
   * jeden bei jedem Anmelden verschieben.
   */
  startPos: ((): { x: number; z: number; yaw: number } | undefined => {
    const raw = process.env.AURELITH_START_POS ?? '';
    if (raw === '') return undefined;

    const parts = raw.split(',').map((p) => Number(p.trim()));
    if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) {
      console.warn(`[config] AURELITH_START_POS="${raw}" nicht lesbar — erwartet "x,z" oder "x,z,yaw".`);
      return undefined;
    }
    return { x: parts[0]!, z: parts[1]!, yaw: parts[2] ?? 0 };
  })(),

  /**
   * Versatz der Weltuhr, in Millisekunden.
   *
   * Der Tageszyklus hängt an der Serveruhr — nur so haben zwei Spieler
   * nebeneinander dieselbe Tageszeit. Genau deshalb lässt sich die Tageszeit
   * auch nur hier stellen und nicht im Client. Für Bilder und Prüfungen zu
   * einer bestimmten Stunde ist das der einzige ehrliche Hebel.
   *
   * Dieselbe Kategorie wie `AURELITH_START_POS`: nichts, was im Betrieb
   * gesetzt wird, aber ohne das läuft jede Prüfung zu der Tageszeit, zu der
   * sie zufällig startet.
   */
  timeOffsetMs: ((): number => {
    const raw = Number(process.env.AURELITH_TIME_OFFSET_MS ?? '0');
    if (!Number.isFinite(raw)) {
      console.warn(`[config] AURELITH_TIME_OFFSET_MS="${process.env.AURELITH_TIME_OFFSET_MS}" nicht lesbar.`);
      return 0;
    }
    return raw;
  })(),

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

  /** Wie viele Figuren ein Konto haben darf. */
  maxCharacters: envNum('AURELITH_MAX_CHARACTERS', 4),

  /**
   * Konten, die als Verwalter gelten — durch Komma getrennt.
   *
   * Die Stufe wird bei jeder Anmeldung nachgezogen: so lässt sie sich vergeben
   * und wieder entziehen, ohne in der Datenbank zu schreiben. Ohne diesen Weg
   * gäbe es auf einem frischen Server niemanden, der jemandem etwas geben
   * könnte — das erste Konto muss von aussen benannt werden.
   */
  admins: env('AURELITH_ADMINS', '')
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length > 0),

  /**
   * Aus welchem Stand dieser Server gebaut wurde.
   *
   * Einmal beim Start ermittelt und nicht bei jeder Anfrage: der Bau ändert
   * sich im laufenden Betrieb nicht, und ein `git`-Aufruf je Chatbefehl wäre
   * ein Prozessstart für eine Antwort, die schon feststeht.
   */
  build: ermittleBuildStamp(),

  repoRoot,
} as const;
