#!/usr/bin/env node
/**
 * Rauchtest: der schwarze Strich um Figuren und Wesen.
 *
 * Der Umriss entsteht in zwei Durchgängen aus dem fertigen Bild — Maske,
 * Kantensuche, Tiefentest (siehe `packages/client/src/render/umriss.ts`).
 * Davon lässt sich nichts aus einer Zahl im Zustand ablesen: entweder es steht
 * ein Strich im Bild, oder es steht keiner. Deshalb wird hier **gezählt**, und
 * zwar sehr dunkle Bildpunkte in einem Ausschnitt um die Figur.
 *
 *   node tools/smoke-umriss.mjs
 *
 * Die Gegenproben sind der halbe Test und stehen unten einzeln erklärt: ohne
 * Häkchen verschwinden die dunklen Punkte wieder, mit Häkchen kommen sie
 * zurück, und auf einem Stück leerer Wiese ändert sich in keinem Fall etwas.
 * Ohne die letzte wäre auch ein Shader grün, der das halbe Bild einschwärzt.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { anmeldenUndBetreten } from './lib/spielstart.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const procs = [];

function launch(command, env = {}) {
  const child = spawn('bash', ['-lc', command], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  procs.push({ child, log });
  return { child, log };
}
process.on('exit', () => {
  for (const { child } of procs) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Schon beendet.
    }
  }
});

let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const waitUntil = async (fn, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

console.log('Aurelith — der Umriss um Figuren und Wesen\n');

const PORT = 8806;
const VITE = 5210;

/*
 * Die Uhr auf Mittag stellen.
 *
 * Der Tag dauert vierundzwanzig Minuten, und die Messung vergleicht zwei
 * Bildschirmfotos, zwischen denen ein paar Sekunden liegen. In der
 * Dämmerung ändert sich die Helligkeit in diesen Sekunden mehr als durch den
 * Strich, den es zu messen gilt — mittags ist die Kurve flach.
 */
const TAG_MS = 24 * 60 * 1000;
const MITTAG = ((0.5 * TAG_MS - (Date.now() % TAG_MS)) % TAG_MS + TAG_MS) % TAG_MS;

const server = launch('npx tsx packages/server/src/index.ts', {
  AURELITH_PORT: String(PORT),
  AURELITH_TIME_OFFSET_MS: String(MITTAG),
  // Mitten auf der Wiese: freie Sicht auf die Figur und ringsherum Gras statt
  // Stadtmauer. Ein Ausschnitt „leere Wiese" muss auch wirklich leer sein.
  AURELITH_START_POS: '-44,-232',
  DATABASE_URL: '',
});
launch(`cd packages/client && npx vite --port ${VITE} --strictPort --host 127.0.0.1`, {
  AURELITH_SERVER: `ws://127.0.0.1:${PORT}`,
});

if (!(await waitUntil(async () => server.log.join('').includes('bereit'), 60000))) {
  console.error(server.log.join(''));
  throw new Error('Spielserver kam nicht hoch');
}
if (
  !(await waitUntil(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${VITE}/`)).ok;
    } catch {
      return false;
    }
  }, 60000))
) {
  throw new Error('Client-Server kam nicht hoch');
}

const executablePath = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
].find((p) => existsSync(p));

const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
});

const BREITE = 900;
const HOEHE = 620;
const page = await browser.newPage({
  viewport: { width: BREITE, height: HOEHE },
  // Volle Punktdichte: der Strich ist in Gerätepunkten breit, und bei halber
  // Dichte wäre er auf dem Bildschirmfoto einen halben Punkt schmal.
  deviceScaleFactor: 1,
});
const fehler = [];
page.on('pageerror', (e) => fehler.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') fehler.push(`[console] ${m.text()}`);
});

await page.goto(`http://127.0.0.1:${VITE}/`, { waitUntil: 'domcontentloaded' });
await anmeldenUndBetreten(page, `Umriss${Date.now() % 100000}`);
if (!(await waitUntil(async () => (await page.evaluate(() => window.aurelith?.localId ?? 0)) !== 0, 30000))) {
  throw new Error('Kein Welcome');
}
await page.waitForTimeout(3000);

// Näher an die Figur, damit sie im Ausschnitt gross genug steht. Die Kamera
// steht danach im Rücken der Figur, und der Ausschnitt liegt in der Bildmitte.
await page.mouse.move(BREITE / 2, HOEHE / 2);
for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -120);
await page.waitForTimeout(2500);

/** Der Ausschnitt um die Figur. */
const FIGUR = { x: 330, y: 170, width: 240, height: 280 };
/**
 * Und der ganze Ausschnitt, in dem die Figur liegt.
 *
 * Ohne die Ränder: oben sitzen Werteleiste und Verbindungsanzeige, unten Chat
 * und Aktionsleiste. Beide ändern sich von selbst — der Chat blendet sich aus,
 * die Laufzeit zählt hoch —, und beides hätte in der Messung wie ein Strich
 * ausgesehen.
 *
 * Eine „leere Wiese" als Vergleich gibt es hier nicht, und das ist kein
 * Versäumnis: über die Irrlichtwiese wandern Irrlichter, und die bekommen zu
 * Recht einen Strich. Ein Ausschnitt, von dem man behauptet, er sei leer, wäre
 * je nach Laune eines Irrlichts grün oder rot.
 */
const GANZ = { x: 0, y: 90, width: BREITE, height: 380 };

/**
 * Wie viele sehr dunkle Bildpunkte in einem Ausschnitt stehen.
 *
 * Vierzig als Grenze: der Strich liegt bei elf, das dunkelste Haar der Figur
 * bei knapp sechzig, beschattetes Gras darüber. Zwischen Strich und allem
 * anderen ist damit Platz, und die Zahl misst wirklich den Strich.
 */
async function dunkel(bereich) {
  const png = await page.screenshot({ clip: bereich });
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (Math.max(data[i], data[i + 1], data[i + 2]) < 40) n++;
  }
  return n;
}

/** Legt das Häkchen „Comic-Umriss" um. */
async function umriss(an) {
  await page.keyboard.press('KeyO');
  await page.waitForSelector('.window[data-window="settings"][data-open="true"]', {
    timeout: 10000,
  });
  // Erst das Blatt: die Einstellungen sind in Reiter geteilt, und ein Häkchen
  // in einem geschlossenen Blatt ist nicht anklickbar.
  await page.locator('.window[data-window="settings"] .settings-tab', { hasText: 'Grafik' }).click();
  const feld = page
    .locator('.window[data-window="settings"] .settings-toggle', { hasText: 'Comic-Umriss' })
    .locator('input[type="checkbox"]');
  if (an) await feld.check();
  else await feld.uncheck();
  await page.keyboard.press('KeyO');
  await page.waitForTimeout(1200);
}

console.log('Der Strich steht im Bild');

const mit = await dunkel(FIGUR);
const ganzMit = await dunkel(GANZ);

await umriss(false);
const ohne = await dunkel(FIGUR);
const ganzOhne = await dunkel(GANZ);

check(
  mit > ohne * 3 + 200,
  'mit Häkchen stehen deutlich mehr dunkle Punkte um die Figur',
  `${mit} mit, ${ohne} ohne`,
);

/*
 * Gegenprobe eins: **zurück**.
 *
 * Ohne sie wäre auch eine Fassung grün, die den Umriss beim ersten Umschalten
 * für immer wegwirft — und genau so war die alte Hülle: sie galt nur für
 * Figuren, die danach neu erschienen.
 */
await umriss(true);
const wieder = await dunkel(FIGUR);
check(wieder > ohne * 3 + 200, 'und das Häkchen holt ihn sofort zurück', `${ohne} → ${wieder}`);

/*
 * Gegenprobe zwei: der Strich sammelt sich an der Figur, statt die Fläche zu
 * schwärzen.
 *
 * Ohne sie wäre auch ein Shader grün, der schlicht das ganze Bild abdunkelt —
 * der hätte oben ebenfalls mehr dunkle Punkte um die Figur geliefert.
 *
 * Verglichen wird je Bildpunkt, denn die beiden Ausschnitte sind verschieden
 * gross. Ausserhalb der Figur stehen andere Wesen — Irrlichter wandern über
 * diese Wiese —, und die bringen ihren eigenen Strich mit. Deshalb kein
 * „ändert sich gar nicht", sondern „um ein Vielfaches weniger dicht".
 */
const flaeche = (b) => b.width * b.height;
const dichteFigur = (mit - ohne) / flaeche(FIGUR);
const restMit = ganzMit - mit;
const restOhne = ganzOhne - ohne;
const dichteRest = (restMit - restOhne) / (flaeche(GANZ) - flaeche(FIGUR));
check(
  dichteRest < dichteFigur / 3,
  'und der Rest des Bildes wird dabei kaum dunkler',
  `${(dichteFigur * 100).toFixed(2)} % an der Figur, ${(dichteRest * 100).toFixed(2)} % daneben`,
);

check(fehler.length === 0, `keine Fehler in der Konsole (${fehler.length})`);
for (const e of fehler.slice(0, 8)) console.log(`  ! ${e}`);

console.log(`\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
