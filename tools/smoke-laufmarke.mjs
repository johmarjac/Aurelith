#!/usr/bin/env node
/**
 * Rauchtest: liegt die Laufmarke auf dem Boden?
 *
 * Der Ring am Wegziel ist eine Fläche von knapp einer Einheit Durchmesser, das
 * gezeichnete Gelände ein Dreiecksgitter mit vier bis acht Einheiten
 * Maschenweite. Liegt der Ring auf der **gerechneten** Höhe des Kerns statt auf
 * der **gezeichneten** Fläche des Netzes, versinkt er — ganz oder zur Hälfte,
 * je nachdem, wohin man geklickt hat. Genau das war zu sehen: mal kein Ring,
 * mal ein Halbkreis.
 *
 * Geprüft wird deshalb nicht „ist ein Ring da", sondern die Bedingung, aus der
 * das folgt: **jeder** Punkt des Rings liegt genau eine Handbreit über der
 * Fläche, die an dieser Stelle gezeichnet wird. Ein Punkt darunter ist ein
 * Punkt, den das Gelände verdeckt.
 *
 * Dazu die Gegenprobe, und die ist der eigentliche Wert dieses Tests: aus
 * denselben Zahlen wird ausgerechnet, wo der Ring gelegen hätte, wenn man ihn
 * auf die **gerechnete** Höhe des Kerns legt — der Zustand von vorher. Fiele
 * der an keiner der geprüften Stellen durch, hätte der Test nichts geprüft,
 * sondern nur eine Stelle gefunden, an der beide Flächen zufällig
 * zusammenfallen.
 *
 *   node tools/smoke-laufmarke.mjs
 *
 * Die Bilder landen in tools/.shots/laufmarke-*.png — zum Nachsehen mit dem
 * Auge, denn dafür sind Ringe da.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { anmeldenUndBetreten } from './lib/spielstart.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, 'tools', '.shots');
mkdirSync(shots, { recursive: true });

const procs = [];

function launch(command) {
  const child = spawn('bash', ['-lc', command], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  procs.push({ child, log });
  return { child, log };
}

function shutdown() {
  for (const { child } of procs) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Schon beendet.
    }
  }
}
process.on('exit', shutdown);

let failures = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}`);
  if (!ok) failures++;
};

const waitUntil = async (fn, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

console.log('Aurelith — Laufmarke auf dem Gelände\n');

const server = launch('npx tsx packages/server/src/index.ts');
launch('cd packages/client && npx vite --port 5197 --strictPort --host 127.0.0.1');

if (!(await waitUntil(async () => server.log.join('').includes('bereit'), 40000))) {
  console.error(server.log.join(''));
  throw new Error('Spielserver kam nicht hoch');
}
if (
  !(await waitUntil(async () => {
    try {
      return (await fetch('http://127.0.0.1:5197/')).ok;
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
    '--disable-backgrounding-occluded-windows',
  ],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
await page.goto('http://127.0.0.1:5197/', { waitUntil: 'domcontentloaded' });
await anmeldenUndBetreten(page, `Marke${Date.now() % 100000}`);
await page.waitForTimeout(1500);

/** Wie hoch die Marke über dem Boden schweben soll — `LUFT` in laufmarke.ts. */
const LUFT = 0.05;

/**
 * Klickt an eine Bildstelle und liest die Marke aus.
 *
 * Nach dem Klick zwei Bilder abwarten: gesetzt wird die Marke sofort, auf das
 * Gelände gelegt wird sie erst im nächsten Durchlauf der Zeichenschleife.
 */
async function klickeUndMiss(px, py) {
  await page.mouse.click(px, py);
  await page.waitForTimeout(120);
  return page.evaluate(() => ({
    sichtbar: window.aurelith.laufmarke.sichtbar,
    mitte: window.aurelith.laufmarke.mitte,
    punkte: window.aurelith.laufmarke.punkte,
    auftrag: window.aurelith.auftrag.art,
  }));
}

/** Läuft eine Weile in eine Richtung. Zum Suchen von Hängen. */
async function laufe(key, ms) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
  await page.waitForTimeout(400);
}

console.log('Prüfungen');

// Mehrere Stellen im Bild und dazwischen jeweils ein gutes Stück gelaufen.
//
// Die Wegstrecke ist kein Beiwerk: rund um den Anfangsort ist das Gelände
// eben, und auf einer Ebene fallen die gerechnete und die gezeichnete Fläche
// fast zusammen. Wer dort prüft, findet auch mit dem alten Fehler nichts. Erst
// draussen im Hügeligen trennen sich die beiden.
const stellen = [
  { px: 300, py: 380, lauf: null },
  { px: 620, py: 350, lauf: ['KeyW', 4000] },
  { px: 450, py: 320, lauf: ['KeyW', 4000] },
  { px: 250, py: 420, lauf: ['KeyD', 4000] },
  { px: 680, py: 340, lauf: ['KeyW', 4000] },
  { px: 400, py: 300, lauf: ['KeyA', 4000] },
  { px: 520, py: 400, lauf: ['KeyS', 4000] },
  { px: 350, py: 330, lauf: ['KeyD', 4000] },
];

let gemessen = 0;
let tiefsterPunkt = Infinity;
let groessteAbweichung = 0;
/** Wie viele der Stellen eine waagerechte Scheibe verschluckt hätte. */
let flachVersunken = 0;
let flachTiefe = 0;

for (const [i, stelle] of stellen.entries()) {
  if (stelle.lauf) await laufe(stelle.lauf[0], stelle.lauf[1]);

  const marke = await klickeUndMiss(stelle.px, stelle.py);
  if (!marke.sichtbar || marke.punkte.length === 0) {
    // Kein Boden unter dem Zeiger — etwa Himmel. Keine Aussage, keine Zeile.
    console.log(`  · Stelle ${i + 1}: kein Bodenpunkt getroffen, übersprungen`);
    continue;
  }
  gemessen++;

  let tiefste = Infinity;
  let abweichung = 0;
  // Was der alte Ring getan hätte: jeder Punkt auf der **gerechneten** Höhe
  // des Kerns statt auf der gezeichneten Fläche. Wo das Netz darüber liegt,
  // wäre er verdeckt gewesen.
  let alt = 0;
  for (const p of marke.punkte) {
    const ueberBoden = p.y - p.boden;
    if (ueberBoden < tiefste) tiefste = ueberBoden;
    abweichung = Math.max(abweichung, Math.abs(ueberBoden - LUFT));
    alt = Math.min(alt, p.kern + LUFT - p.boden);
  }
  if (alt < -0.02) {
    flachVersunken++;
    flachTiefe = Math.min(flachTiefe, alt);
  }
  tiefsterPunkt = Math.min(tiefsterPunkt, tiefste);
  groessteAbweichung = Math.max(groessteAbweichung, abweichung);

  await page.screenshot({ path: join(shots, `laufmarke-${i + 1}.png`) });
  console.log(
    `  · Stelle ${i + 1}: ${marke.punkte.length} Punkte, tiefster ${tiefste.toFixed(
      3,
    )} über Boden, auf Kernhöhe wäre ${alt.toFixed(3)}`,
  );
}

check(gemessen >= 4, `genug Stellen geprüft (${gemessen} von ${stellen.length})`);
check(
  tiefsterPunkt > 0,
  `kein Punkt des Rings liegt unter dem Boden (tiefster ${tiefsterPunkt.toFixed(3)})`,
);
check(
  groessteAbweichung < 0.01,
  `jeder Punkt liegt auf der gezeichneten Fläche (grösste Abweichung ` +
    `${groessteAbweichung.toFixed(4)}, erlaubt 0.01)`,
);

// Die Gegenprobe. Ohne sie wüsste man nicht, ob überhaupt etwas Schiefes
// geprüft wurde — auf einer Ebene bestünde auch der alte Zustand.
check(
  flachVersunken > 0,
  `mindestens eine Stelle hätte die alte Marke verschluckt ` +
    `(${flachVersunken} von ${gemessen}, tiefstens ${flachTiefe.toFixed(3)})`,
);

console.log(`\n  Bilder: ${shots}/laufmarke-*.png`);

await browser.close();
shutdown();

console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
