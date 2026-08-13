#!/usr/bin/env node
/**
 * Rauchtest: die Aktionsleiste.
 *
 * Drei Regeln, und alle drei sieht man beim Hinsehen für erfüllt an:
 *
 *   1. Was man aus dem Beutel auf einen Platz zieht, liegt danach dort.
 *   2. Die Belegung übersteht ein Abmelden. Das ist der eigentliche Grund,
 *      warum die Leiste beim Server liegt und nicht im Browser.
 *   3. Ein vernichteter Gegenstand verschwindet vom Platz. Sonst bliebe ein
 *      Knopf stehen, der auf nichts zeigt.
 *
 * Die zweite und die dritte prüft niemand beim Spielen — man merkt sie erst
 * am nächsten Abend, wenn die Leiste leer ist oder ein Trank darauf liegt, den
 * es nicht mehr gibt.
 *
 *   node tools/smoke-aktionsleiste.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { anmeldenUndBetreten, anmeldenBestehend } from './lib/spielstart.mjs';

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

console.log('Aurelith — Aktionsleiste\n');

const server = launch('npx tsx packages/server/src/index.ts');
launch('cd packages/client && npx vite --port 5198 --strictPort --host 127.0.0.1');

if (!(await waitUntil(async () => server.log.join('').includes('bereit'), 40000))) {
  console.error(server.log.join(''));
  throw new Error('Spielserver kam nicht hoch');
}
if (
  !(await waitUntil(async () => {
    try {
      return (await fetch('http://127.0.0.1:5198/')).ok;
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
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
await page.goto('http://127.0.0.1:5198/', { waitUntil: 'domcontentloaded' });

const name = `Leiste${Date.now() % 100000}`;
await anmeldenUndBetreten(page, name);
await page.waitForTimeout(1200);

/** Die Leiste, wie der Client sie zuletzt vom Server bekommen hat. */
const leiste = () => page.evaluate(() => window.aurelith.aktionsleiste);

/** Der Trank aus dem Startbeutel — irgendein Ding, das man benutzen kann. */
const TRANK = 'potion_hp_small';

async function oeffneInventar() {
  await page.keyboard.press('KeyI');
  await page.waitForSelector('.window[data-window="inventory"][data-open="true"]', {
    timeout: 10000,
  });
  await page.waitForTimeout(400);
}

/** Zieht von einer Bildstelle zur anderen — mit der Maus, in kleinen Schritten. */
async function ziehe(von, nach) {
  await page.mouse.move(von.x, von.y);
  await page.mouse.down();
  // Mehrere Schritte: der Zug beginnt erst nach ein paar Bildpunkten, und ein
  // einziger Sprung sieht für den Browser aus wie gar keine Bewegung.
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(
      von.x + ((nach.x - von.x) * i) / 8,
      von.y + ((nach.y - von.y) * i) / 8,
    );
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);
}

const mitte = async (auswahl) => {
  const kasten = await page.locator(auswahl).first().boundingBox();
  if (!kasten) throw new Error(`Nicht gefunden: ${auswahl}`);
  return { x: kasten.x + kasten.width / 2, y: kasten.y + kasten.height / 2 };
};

console.log('Prüfungen');

// --- Vorbedingung: der Krieger hat noch keinen Beruf, also keine Fertigkeit.
// Die Leiste ist frisch und leer, und ohne das prüfte der Rest gar nichts.
const anfang = await leiste();
check(
  anfang.length === 10,
  `die Leiste hat zehn Plätze (${anfang.length})`,
);
check(
  anfang.every((p) => p.art === 0),
  'eine frische Figur hat eine leere Leiste',
);

// --- 1. Zuweisen ---------------------------------------------------------
await oeffneInventar();
const trankKachel = `.item-slot[data-bag-slot]:has(.item-icon)`;
const trankStelle = await page.evaluate((id) => {
  // Die Kachel des Tranks über den Beutel des Clients finden: welcher
  // Beutelplatz das ist, hängt an der Reihenfolge im Startbeutel.
  const eintrag = window.aurelith.inventar?.find?.((e) => e.itemId === id);
  return eintrag ? eintrag.slot : -1;
}, TRANK);

const kachel =
  trankStelle >= 0
    ? `.item-slot[data-bag-slot="${trankStelle}"]`
    : trankKachel;
const von = await mitte(kachel);
const nach = await mitte('.action-slot[data-aktion="2"]');
await ziehe(von, nach);

const belegt = await leiste();
check(
  belegt[2]?.art === 1 && belegt[2]?.id === TRANK,
  `Platz 3 trägt den Trank (${belegt[2]?.art}/${belegt[2]?.id || 'leer'})`,
);
await page.screenshot({ path: join(shots, 'aktionsleiste-belegt.png') });

// --- 2. Abmelden und wiederkommen ---------------------------------------
await page.keyboard.press('KeyI');
await page.keyboard.press('Escape');
await page.click('.menu-panel .menu-entry:has-text("Abmelden")');
await page.waitForSelector('.lobby', { state: 'visible', timeout: 30000 });
await anmeldenBestehend(page, name);
await page.waitForTimeout(1200);

const nachher = await leiste();
check(
  nachher[2]?.art === 1 && nachher[2]?.id === TRANK,
  `nach dem Neuanmelden liegt er immer noch da (${nachher[2]?.id || 'leer'})`,
);

// --- 3. Gegenstand vernichten -------------------------------------------
await oeffneInventar();
const nochmal = await page.evaluate((id) => {
  const eintrag = window.aurelith.inventar?.find?.((e) => e.itemId === id);
  return eintrag ? eintrag.slot : -1;
}, TRANK);
check(nochmal >= 0, `der Trank ist noch im Beutel (Platz ${nochmal})`);

const vonZwei = await mitte(`.item-slot[data-bag-slot="${nochmal}"]`);
const muell = await mitte('[data-muell]');
await ziehe(vonZwei, muell);
await page.waitForTimeout(600);

const geraeumt = await leiste();
check(
  geraeumt[2]?.art === 0,
  `der Platz ist danach leer (${geraeumt[2]?.art}/${geraeumt[2]?.id || 'leer'})`,
);
await page.screenshot({ path: join(shots, 'aktionsleiste-geraeumt.png') });

console.log(`\n  Bilder: ${shots}/aktionsleiste-*.png`);

await browser.close();
shutdown();

console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
