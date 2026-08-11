#!/usr/bin/env node
/**
 * Rauchtest für den Map-Editor.
 *
 * Prüft das, worauf es beim Editor ankommt: dass er dieselbe Map-Datei liest,
 * die das Spiel liest, sie zeichnet, ein Prop dazusetzt und das Ergebnis wieder
 * als gültiges Dokument herausgibt. Bricht dieser Kreis, ist das Format nicht
 * mehr die eine Wahrheit, als die es gedacht ist.
 *
 *   node tools/smoke-editor.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

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
  procs.push(child);
  return { child, log };
}

function shutdown() {
  for (const child of procs) {
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

console.log('Aurelith — Editor-Rauchtest\n');

const editor = launch('cd packages/editor && npx vite --port 5198 --strictPort --host 127.0.0.1');

const deadline = Date.now() + 60000;
let up = false;
while (Date.now() < deadline && !up) {
  try {
    up = (await fetch('http://127.0.0.1:5198/')).ok;
  } catch {
    await new Promise((r) => setTimeout(r, 300));
  }
}
if (!up) {
  console.error(editor.log.join(''));
  throw new Error('Editor-Server kam nicht hoch');
}

const executablePath = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
].find((p) => existsSync(p));

const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const consoleLines = [];
const pageErrors = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.goto('http://127.0.0.1:5198/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#panel h1', { timeout: 30000 });
await page.waitForTimeout(3000);

console.log('Prüfungen');

const before = await page.evaluate(() =>
  [...document.querySelectorAll('#panel .stats div')].map((n) => n.textContent).join(' | '),
);
check(before.includes('Props:'), `Map geladen (${before})`);
check(/Props: [1-9]/.test(before), 'Props aus der Datei übernommen');

// Ein Prop in die Mitte des Sichtfelds setzen.
await page.mouse.move(500, 400);
await page.waitForTimeout(200);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(500);

const after = await page.evaluate(() =>
  [...document.querySelectorAll('#panel .stats div')].map((n) => n.textContent).join(' | '),
);
const countOf = (s) => Number(/Props: (\d+)/.exec(s)?.[1] ?? 0);
check(countOf(after) === countOf(before) + 1, `Prop gesetzt (${countOf(before)} → ${countOf(after)})`);

// Ein Klick ins Bedienfeld darf nichts in der Welt anfassen.
//
// Genau das ging schief: `pointerup` hing am Fenster, `pointerdown` an der
// Zeichenflaeche — jede Schaltflaeche setzte nebenbei ein Prop.
const paletteButton = await page.$('#panel .palette button:nth-child(3)');
if (!paletteButton) throw new Error('Palette nicht gefunden');
const box = await paletteButton.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(400);

const afterPanelClick = await page.evaluate(() =>
  [...document.querySelectorAll('#panel .stats div')].map((n) => n.textContent).join(' | '),
);
check(
  countOf(afterPanelClick) === countOf(after),
  `Klick ins Bedienfeld setzt nichts (${countOf(after)} → ${countOf(afterPanelClick)})`,
);
check(
  await page.evaluate(
    () =>
      document.querySelector('#panel .palette button:nth-child(3)')?.getAttribute('aria-pressed') ===
      'true',
  ),
  'Klick ins Bedienfeld waehlt trotzdem aus',
);

// Kamera ueber die Karte schieben — vorher gab es nur Drehen und Zoomen.
const camBefore = await page.evaluate(() => window.aurelithEditor?.camTarget);
await page.keyboard.down('KeyW');
await page.waitForTimeout(700);
await page.keyboard.up('KeyW');
await page.waitForTimeout(200);
const camAfterKeys = await page.evaluate(() => window.aurelithEditor?.camTarget);
check(
  camBefore !== undefined && Math.hypot(camAfterKeys.x - camBefore.x, camAfterKeys.z - camBefore.z) > 1,
  `WASD schiebt die Kamera (${Math.hypot(
    (camAfterKeys?.x ?? 0) - (camBefore?.x ?? 0),
    (camAfterKeys?.z ?? 0) - (camBefore?.z ?? 0),
  ).toFixed(1)} Einheiten)`,
);

// Ziehen mit gedrueckter Umschalttaste schiebt ebenfalls.
await page.keyboard.down('Shift');
await page.mouse.move(640, 360);
await page.mouse.down();
await page.mouse.move(500, 300, { steps: 8 });
await page.mouse.up();
await page.keyboard.up('Shift');
await page.waitForTimeout(200);
const camAfterDrag = await page.evaluate(() => window.aurelithEditor?.camTarget);
check(
  Math.hypot(camAfterDrag.x - camAfterKeys.x, camAfterDrag.z - camAfterKeys.z) > 1,
  `Ziehen schiebt die Kamera (${Math.hypot(
    camAfterDrag.x - camAfterKeys.x,
    camAfterDrag.z - camAfterKeys.z,
  ).toFixed(1)} Einheiten)`,
);

// ... und dabei kein Prop setzen, denn es war ein Ziehen, kein Klick.
const afterDragClick = await page.evaluate(() =>
  [...document.querySelectorAll('#panel .stats div')].map((n) => n.textContent).join(' | '),
);
check(
  countOf(afterDragClick) === countOf(afterPanelClick),
  `Ziehen setzt kein Prop (${countOf(afterPanelClick)} → ${countOf(afterDragClick)})`,
);

check(pageErrors.length === 0, `keine unbehandelten Ausnahmen (${pageErrors.length})`);
const errors = consoleLines.filter((l) => l.startsWith('[error]'));
check(errors.length === 0, `keine Fehler in der Konsole (${errors.length})`);
if (errors.length || pageErrors.length) {
  for (const e of pageErrors) console.log(`  ! ${e}`);
  for (const e of errors.slice(0, 8)) console.log(`  ${e}`);
}

await mkdir(join(root, 'artefakte'), { recursive: true });
await page.screenshot({ path: join(root, 'artefakte', 'editor.png') });
console.log('\n→ Bildschirmfoto: artefakte/editor.png');

await browser.close();
shutdown();

console.log(`\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`);
process.exit(failures === 0 ? 0 : 1);
