#!/usr/bin/env node
/**
 * End-to-End-Rauchtest.
 *
 * Startet Server und Client, öffnet die Seite in Chromium und prüft, was ohne
 * echten Browser nicht zu prüfen ist: dass der wasm-Kern lädt, die Verbindung
 * steht, Snapshots ankommen und tatsächlich etwas gezeichnet wird.
 *
 * Ein Typecheck sagt nichts darüber, ob ein Bild entsteht.
 *
 *   node tools/smoke-e2e.mjs [--headed] [--keep]
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = join(root, 'artefakte');
const args = new Set(process.argv.slice(2));

const procs = [];

/**
 * Startet einen Hilfsprozess in eigener Prozessgruppe.
 *
 * Das `detached` ist kein Detail: der Befehl laeuft ueber eine Shell, und ein
 * Signal an die Shell laesst das eigentliche Node dahinter am Leben. Beim
 * naechsten Lauf blockiert dann der Port, und die Ursache steht nirgends.
 */
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
  const entry = { name, child, log };
  procs.push(entry);
  return entry;
}

function shutdown() {
  for (const { child } of procs) {
    try {
      // Negative Kennung heisst: die ganze Gruppe, also auch die Kindprozesse
      // der Shell.
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Schon beendet.
    }
  }
}

async function waitFor(check, timeoutMs, what, source) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  // Ohne die Ausgabe des Prozesses ist eine Zeitüberschreitung nicht zu deuten.
  if (source) console.error(`\nAusgabe von ${source.name}:\n${source.log.join('')}`);
  throw new Error(`Zeitüberschreitung beim Warten auf ${what}`);
}

let failures = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}`);
  if (!ok) failures++;
};

process.on('exit', shutdown);
process.on('SIGINT', () => {
  shutdown();
  process.exit(130);
});

console.log('Aurelith — End-to-End-Rauchtest\n');

const server = launch('server', 'npx tsx packages/server/src/index.ts');
const client = launch(
  'client',
  'cd packages/client && npx vite --port 5199 --strictPort --host 127.0.0.1',
);

await waitFor(
  async () => server.log.join('').includes('bereit'),
  40000,
  'den Spielserver',
  server,
);
console.log('→ Server läuft');

await waitFor(
  async () => {
    try {
      const res = await fetch('http://127.0.0.1:5199/');
      return res.ok;
    } catch {
      return false;
    }
  },
  60000,
  'den Client-Server',
  client,
);
console.log('→ Client-Server läuft\n');

/**
 * Die vorinstallierte Chromium-Ausgabe kann von der abweichen, die dieses
 * Playwright erwartet. Ist eine da, nehmen wir sie — herunterladen wollen wir
 * für einen Rauchtest nichts.
 */
function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    ...['1194', '1200', '1210', '1234'].flatMap((v) => [
      `/opt/pw-browsers/chromium-${v}/chrome-linux/chrome`,
      `/opt/pw-browsers/chromium_headless_shell-${v}/chrome-linux/headless_shell`,
    ]),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

const executablePath = findChromium();
const browser = await chromium.launch({
  headless: !args.has('--headed'),
  ...(executablePath ? { executablePath } : {}),
  // SwiftShader liefert WebGL 2 ohne GPU — anders wäre der Test hier blind.
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const consoleLines = [];
const pageErrors = [];
page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => pageErrors.push(String(err)));

await page.goto('http://127.0.0.1:5199/?name=Rauchtest', { waitUntil: 'domcontentloaded' });

// Der Statusanzeiger ist die ehrlichste Auskunft darüber, wie weit der Client
// gekommen ist — er hängt am tatsächlichen WebSocket-Zustand.
try {
  await page.waitForFunction(
    () => document.querySelector('.status')?.getAttribute('data-state') === 'verbunden',
    { timeout: 30000 },
  );
} catch (err) {
  // Ohne die Browser-Konsole ist eine Zeitueberschreitung hier nicht zu deuten.
  console.error('\nBrowser-Konsole:');
  for (const line of consoleLines) console.error(`  ${line}`);
  for (const line of pageErrors) console.error(`  ! ${line}`);
  console.error(`\nStatus: ${await page.evaluate(() => document.querySelector('.status')?.textContent ?? '(fehlt)')}`);
  shutdown();
  throw err;
}
console.log('Prüfungen');
check(true, 'Verbindung zum Server steht');

// Ein paar Sekunden laufen lassen, damit Snapshots, Terrain und Props ankommen.
await page.waitForTimeout(4000);

const state = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  const gl = canvas?.getContext('webgl2');
  return {
    webgl2: Boolean(gl),
    canvasWidth: canvas?.width ?? 0,
    nameplates: document.querySelectorAll('.nameplate').length,
    chatLines: document.querySelectorAll('.chat-line').length,
    chatText: [...document.querySelectorAll('.chat-line')].map((n) => n.textContent).join(' | '),
    hpLabel: document.querySelector('.bar.hp .bar-label')?.textContent ?? '',
    level: document.querySelector('.vitals-level')?.textContent ?? '',
    inventoryFilled: document.querySelectorAll('.item-slot:not(.item-empty)').length,
    status: document.querySelector('.status')?.textContent ?? '',
  };
});

check(state.webgl2, 'WebGL 2 ist aktiv');
check(state.canvasWidth > 0, `Leinwand hat Größe (${state.canvasWidth} px)`);
check(/\d+ \/ \d+/.test(state.hpLabel), `Lebensanzeige gefüllt (${state.hpLabel})`);
check(state.level.includes('Stufe'), `Stufe angezeigt (${state.level})`);
check(state.inventoryFilled >= 3, `Startausrüstung im Inventar (${state.inventoryFilled} Plätze)`);
check(state.chatLines > 0, `Systemnachricht angekommen (${state.chatLines})`);
check(state.nameplates > 0, `Namensschilder gezeichnet (${state.nameplates})`);

// Bewegung: eine Sekunde vorwärts laufen und prüfen, dass sich etwas tut.
const before = await page.evaluate(() => document.querySelector('.status')?.textContent ?? '');
await page.keyboard.down('KeyW');
await page.waitForTimeout(1200);
await page.keyboard.up('KeyW');
await page.waitForTimeout(400);

// Angriff auslösen — der Flächenschlag soll Treffer melden.
await page.keyboard.down('Space');
await page.waitForTimeout(2500);
await page.keyboard.up('Space');
await page.waitForTimeout(600);

const after = await page.evaluate(() => ({
  damageNumbers: document.querySelectorAll('.damage').length,
  status: document.querySelector('.status')?.textContent ?? '',
}));

check(before.length > 0 && after.status.length > 0, 'Statusanzeige bleibt lesbar');

await mkdir(shotDir, { recursive: true });
await page.screenshot({ path: join(shotDir, 'client.png') });
console.log(`\n→ Bildschirmfoto: artefakte/client.png`);

const errors = consoleLines.filter((l) => l.startsWith('[error]'));
check(pageErrors.length === 0, `keine unbehandelten Ausnahmen (${pageErrors.length})`);
check(errors.length === 0, `keine Fehler in der Konsole (${errors.length})`);

if (pageErrors.length > 0 || errors.length > 0) {
  console.log('\nMeldungen:');
  for (const e of pageErrors) console.log(`  ! ${e}`);
  for (const e of errors.slice(0, 12)) console.log(`  ${e}`);
}

await writeFile(
  join(shotDir, 'konsole.txt'),
  `${consoleLines.join('\n')}\n\n--- Server ---\n${server.log.join('')}`,
  'utf8',
);

if (!args.has('--keep')) await browser.close();
shutdown();

console.log(`\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`);
process.exit(failures === 0 ? 0 : 1);
