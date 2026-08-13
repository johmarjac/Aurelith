#!/usr/bin/env node
/**
 * Rauchtest: springt die eigene Figur beim Laufen zurück?
 *
 * Client und Server rechnen dieselbe wasm-Binärdatei auf denselben Eingaben.
 * Es gibt also nichts, worin sie sich unterscheiden könnten — ausser darin,
 * dass eine Eingabe unterwegs verlorengeht oder der Server sie verwirft. Jede
 * Korrektur der Vorhersage ist damit ein Hinweis auf genau das, und sie ist im
 * Bild als Zurückspringen zu sehen.
 *
 * Der Test läuft eine Weile in wechselnde Richtungen und liest danach die
 * Zähler aus `window.aurelith`. Bewusst über mehrere Richtungswechsel: bei
 * gleichbleibender Eingabe faellt eine verworfene Eingabe kaum auf, weil die
 * naechste dasselbe sagt.
 *
 *   node tools/smoke-prediction.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { anmeldenUndBetreten } from './lib/spielstart.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
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

console.log('Aurelith — Vorhersage und Autoritaet\n');

const server = launch('npx tsx packages/server/src/index.ts');
launch('cd packages/client && npx vite --port 5194 --strictPort --host 127.0.0.1');

if (!(await waitUntil(async () => server.log.join('').includes('bereit'), 40000))) {
  console.error(server.log.join(''));
  throw new Error('Spielserver kam nicht hoch');
}
if (
  !(await waitUntil(async () => {
    try {
      return (await fetch('http://127.0.0.1:5194/')).ok;
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
await page.goto('http://127.0.0.1:5194/', { waitUntil: 'domcontentloaded' });
await anmeldenUndBetreten(page, `Vorher${Date.now() % 100000}`);
await page.waitForTimeout(1500);

/** Wartet, bis die Simulation `count` Schritte weiter ist. */
async function waitTicks(count) {
  const start = await page.evaluate(() => window.aurelith.ticks);
  await page.waitForFunction((n) => window.aurelith.ticks >= n, start + count, { timeout: 60000 });
}

console.log('Pruefungen');

// Zaehler zuruecksetzen: was beim Anmelden und beim ersten Snapshot passiert,
// interessiert hier nicht — dort ist ein Sprung normal.
await page.evaluate(() => {
  window.aurelith.reconciles = 0;
  window.aurelith.maxReconcileError = 0;
});

const KEYS = ['KeyW', 'KeyD', 'KeyS', 'KeyA', 'KeyW', 'KeyA', 'KeyD', 'KeyS'];
const ticksBefore = await page.evaluate(() => window.aurelith.ticks);

for (const key of KEYS) {
  await page.keyboard.down(key);
  await waitTicks(20);
  await page.keyboard.up(key);
  await waitTicks(4);
}

const ticks = (await page.evaluate(() => window.aurelith.ticks)) - ticksBefore;
const result = await page.evaluate(() => ({
  reconciles: window.aurelith.reconciles,
  maxError: window.aurelith.maxReconcileError,
  latency: window.aurelith.latencyMs,
}));

console.log(
  `  (${ticks} Simulationsschritte gelaufen, ${Math.round(result.latency)} ms Umlaufzeit)`,
);

check(ticks > 150, `genug gelaufen, um etwas zu sehen (${ticks} Schritte)`);
check(
  result.reconciles === 0,
  `keine Korrektur der Vorhersage (${result.reconciles} Sprünge)`,
);
// Die groesste gemessene Abweichung sagt mehr als die Zahl der Spruenge: sie
// zeigt, wie nah es am Schwellwert war. Bleibt sie klar darunter, ist es kein
// Zufall, dass nichts gesprungen ist.
check(
  result.maxError < 0.3,
  `Abweichung bleibt klein (groesste ${result.maxError.toFixed(3)} Einheiten, Schwelle 1.2)`,
);

await browser.close();
shutdown();

console.log(`\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`);
process.exit(failures === 0 ? 0 : 1);
