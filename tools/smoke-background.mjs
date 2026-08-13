#!/usr/bin/env node
/**
 * Rauchtest: überlebt die Verbindung einen Tab im Hintergrund?
 *
 * Der Browser stellt `requestAnimationFrame` ein, sobald ein Tab nicht mehr
 * sichtbar ist. Hängt irgendetwas Lebensnotwendiges an der Renderschleife,
 * fällt es damit aus — und genau das war der Fall: das Lebenszeichen wurde
 * eingereiht, aber nur aus der Renderschleife heraus verschickt. Nach dem
 * Zeitablauf warf der Server die Sitzung, und weil ein Rauswurf als „selbst
 * geschlossen" galt, kam auch kein neuer Versuch.
 *
 * Nachgestellt wird das, indem `requestAnimationFrame` in der Seite durch eine
 * Funktion ersetzt wird, die nie zurückruft. Das ist näher am echten Verhalten
 * als jede Sichtbarkeits-Attrappe: die Schleife steht wirklich still.
 *
 * Der Server läuft dafür mit einem kurzen Zeitfenster, damit der Test Sekunden
 * dauert und nicht Minuten.
 *
 *   node tools/smoke-background.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { anmeldenUndBetreten } from './lib/spielstart.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Zeitfenster des Servers für diesen Test. Der Standard sind 90 Sekunden. */
const TIMEOUT_SECONDS = 8;
/** So lange bleibt die Renderschleife stehen — deutlich länger als das Fenster. */
const FREEZE_SECONDS = 14;

const procs = [];
function launch(name, command, extraEnv = {}) {
  const child = spawn('bash', ['-lc', command], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  procs.push({ name, child, log });
  return { name, child, log };
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

console.log('Aurelith — Verbindung im Hintergrund\n');

const server = launch('server', 'npx tsx packages/server/src/index.ts', {
  AURELITH_SESSION_TIMEOUT: String(TIMEOUT_SECONDS),
});
launch('client', 'cd packages/client && npx vite --port 5193 --strictPort --host 127.0.0.1');

const waitUntil = async (fn, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

if (!(await waitUntil(async () => server.log.join('').includes('bereit'), 40000))) {
  console.error(server.log.join(''));
  throw new Error('Spielserver kam nicht hoch');
}
if (
  !(await waitUntil(async () => {
    try {
      return (await fetch('http://127.0.0.1:5193/')).ok;
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
    '--disable-renderer-backgrounding',
  ],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.goto('http://127.0.0.1:5193/', { waitUntil: 'domcontentloaded' });
await anmeldenUndBetreten(page, `Hinter${Date.now() % 100000}`);
await page.waitForTimeout(1500);

console.log(`Prüfungen (Zeitfenster des Servers: ${TIMEOUT_SECONDS} s)`);

// Renderschleife anhalten. Die laufende Anforderung wurde bereits gestellt,
// aber die nächste kommt nicht mehr durch — nach dem aktuellen Bild steht sie.
const frozenAt = await page.evaluate(() => {
  window.requestAnimationFrame = () => 0;
  return window.aurelith.frames;
});

await page.waitForTimeout(FREEZE_SECONDS * 1000);

const after = await page.evaluate(() => ({
  frames: window.aurelith.frames,
  connection: window.aurelith.connection,
  state: document.querySelector('.status')?.getAttribute('data-state'),
  // Bewusst aus der Anzeige und nicht aus der Diagnose: die wird am Ende eines
  // Bildes fortgeschrieben und steht bei eingefrorener Schleife ebenfalls
  // still. Die Statusanzeige setzt die Verbindung selbst, sobald ein Pong
  // ankommt — sie ist hier die einzige ehrliche Quelle.
  statusText: document.querySelector('.status')?.textContent ?? '',
}));

check(
  after.frames - frozenAt <= 1,
  `Renderschleife steht tatsaechlich still (${after.frames - frozenAt} Bilder in ${FREEZE_SECONDS} s)`,
);
check(
  after.connection === 'verbunden' && after.state === 'verbunden',
  `Verbindung haelt ohne Renderschleife (${after.connection}, Anzeige: ${after.state})`,
);
check(
  /\d+\s*ms/.test(after.statusText),
  `Lebenszeichen kommen weiter an (Anzeige: "${after.statusText.trim()}")`,
);

const kicked = server.log.join('').includes('Timeout');
check(!kicked, 'Server hat die Sitzung nicht geworfen');

await browser.close();
shutdown();

console.log(`\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`);
process.exit(failures === 0 ? 0 : 1);
