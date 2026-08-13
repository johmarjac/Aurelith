#!/usr/bin/env node
/**
 * Nahaufnahme der Figur.
 *
 * Modellfehler sieht man nicht in einer Zusicherung, sondern nur im Bild — und
 * aus der Spielkamera in neun Metern Abstand auch dort nicht. Dieses Skript
 * zoomt heran und dreht einmal herum, damit sich Haltung, Waffe und
 * Durchdringungen beurteilen lassen.
 *
 *   node tools/shot-figur.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { anmeldenUndBetreten } from './lib/spielstart.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = join(root, 'artefakte');
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

const server = launch('npx tsx packages/server/src/index.ts');
launch('cd packages/client && npx vite --port 5196 --strictPort --host 127.0.0.1');

const waitUntil = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

await waitUntil(async () => server.log.join('').includes('bereit'), 40000);
await waitUntil(async () => {
  try {
    return (await fetch('http://127.0.0.1:5196/')).ok;
  } catch {
    return false;
  }
}, 60000);

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
const page = await browser.newPage({ viewport: { width: 520, height: 760 } });

// Ohne die Konsole ist eine Zeitueberschreitung hier nicht zu deuten — man
// sieht nur, dass kein Bild entsteht, nicht warum.
const messages = [];
page.on('console', (m) => messages.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => messages.push(`! ${String(e)}`));

await page.goto('http://127.0.0.1:5196/', { waitUntil: 'domcontentloaded' });
try {
  await anmeldenUndBetreten(page, `Modell${Date.now() % 100000}`);
} catch (err) {
  console.error('\nBrowser-Konsole:');
  for (const m of messages) console.error(`  ${m}`);
  shutdown();
  throw err;
}
await page.waitForTimeout(2500);

// Heranzoomen — aber nicht bis zum Anschlag: dort schaltet die Kamera in die
// Ich-Perspektive und blendet die eigene Figur aus.
await page.mouse.move(260, 380);
for (let i = 0; i < 4; i++) {
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(60);
}

// Blick flacher stellen, damit die Figur von der Seite und nicht von oben zu
// sehen ist.
await page.mouse.move(260, 380);
await page.mouse.down({ button: 'right' });
await page.mouse.move(260, 320, { steps: 8 });
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(700);

await mkdir(shotDir, { recursive: true });

// Einmal um die Figur herum, damit auch die Waffenseite zu sehen ist.
const winkel = [
  ['hinten', 0],
  ['rechts', 240],
  ['vorn', 240],
  ['links', 240],
];
for (const [name, drag] of winkel) {
  if (drag !== 0) {
    await page.mouse.move(260, 380);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(260 + drag, 380, { steps: 10 });
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: join(shotDir, `figur-${name}.png`) });
  console.log(`→ artefakte/figur-${name}.png`);
}

await browser.close();
shutdown();
