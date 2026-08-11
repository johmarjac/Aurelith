#!/usr/bin/env node
/**
 * Rauchtest für Tore.
 *
 * Der Kern der Sache: Hineinlaufen bewirkt **nichts**. Erst der Tastendruck
 * reist. Vorher löste ein Tor von selbst aus, und wer im Gegentor landete,
 * wurde zurückgereicht — dagegen halfen weder eine Zeitsperre noch eine Merke,
 * ob ein Tor gerade scharf ist. Beides ist ersatzlos weg, und genau das prüft
 * dieser Test: dass Stillstehen im Tor folgenlos bleibt.
 *
 * Gespielt wird auf `gruft_01`, weil dort das Ausgangstor acht Einheiten vom
 * Startpunkt entfernt steht — auf Lichtmoor wären es zweihundert, und der Test
 * würde eine Minute lang nur laufen.
 *
 *   node tools/smoke-portal.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const procs = [];

function launch(command, extraEnv = {}) {
  const child = spawn('bash', ['-lc', command], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
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

console.log('Aurelith — Tore\n');

const server = launch('npx tsx packages/server/src/index.ts', {
  // Dornwald: Startpunkt (0, -178), Tor nach Lichtmoor bei (0, -186), Radius 4.
  // Von dort geht es nach Lichtmoor auf (0, 196), wo das Gegentor bei (0, 204)
  // steht — beide ohne Stufensperre, also derselbe Weg hin und zurueck.
  //
  // Bewusst nicht ueber die Schattengruft: die verlangt Stufe zehn, und eine
  // Abweisung saehe genauso aus wie ein Fehler. Eine fruehere Fassung dieses
  // Tests ist genau darauf hereingefallen.
  AURELITH_START_MAP: 'dornwald',
});
launch('cd packages/client && npx vite --port 5195 --strictPort --host 127.0.0.1');

if (!(await waitUntil(async () => server.log.join('').includes('bereit'), 40000))) {
  console.error(server.log.join(''));
  throw new Error('Spielserver kam nicht hoch');
}
if (
  !(await waitUntil(async () => {
    try {
      return (await fetch('http://127.0.0.1:5195/')).ok;
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
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`  [seite] ${m.text()}`); });
page.on('pageerror', (e) => console.log(`  [seite] ${String(e)}`));
await page.goto('http://127.0.0.1:5195/?name=Torgaenger', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.aurelith?.localId > 0, { timeout: 30000 });
/**
 * Wartet, bis die Vorhersage die eigene Figur traegt.
 *
 * Zwischen Willkommensnachricht und erstem Snapshot steht `localId` schon,
 * die Figur fehlt aber noch — und alles, was an ihrer Lage haengt, steht
 * derweil auf dem Ausgangswert (0, 0). Genau daran ist dieser Test zweimal
 * von drei Laeufen vorbeigelaufen.
 */
async function waitReady() {
  await page.waitForFunction(() => window.aurelith?.predictionReady === true, { timeout: 30000 });
}
await waitReady();

async function waitTicks(count) {
  const start = await page.evaluate(() => window.aurelith.ticks);
  await page.waitForFunction((n) => window.aurelith.ticks >= n, start + count, { timeout: 60000 });
}

const state = () =>
  page.evaluate(() => ({
    mapId: window.aurelith.mapId,
    // Die vorhergesagte Lage und nicht die gezeichnete: die gezeichnete braucht
    // nach einem Kartenwechsel erst wieder zwei Schritte, bevor sie
    // Zwischenwerte bilden kann, und steht so lange auf dem alten Stand.
    x: window.aurelith.playerSim.x,
    z: window.aurelith.playerSim.z,
    prompt: (() => {
      const el = document.querySelector('.portal-prompt');
      return el && !el.hidden ? (el.textContent ?? '') : '';
    })(),
    // Was der Server zuletzt gesagt hat. Verweigert er ein Tor, steht die
    // Begruendung hier — sonst sieht ein „nichts passiert" wie ein Fehler aus,
    // obwohl es eine Ansage war.
    chat: [...document.querySelectorAll('.chat-log > *')].slice(-3).map((n) => n.textContent).join(' | '),
  }));

console.log('Pruefungen');

const start = await state();
check(start.mapId === 'dornwald', `auf der Testkarte gestartet (${start.mapId})`);
check(start.prompt === '', `kein Hinweis abseits eines Tores ("${start.prompt}")`);

/** Laeuft `ticks` Schritte in eine Richtung und laesst die Figur auslaufen. */
async function walk(key, ticks = 27) {
  await page.keyboard.down(key);
  await waitTicks(ticks);
  await page.keyboard.up(key);
  await waitTicks(8);
}

// --- Erster Wechsel: Dornwald -> Lichtmoor --------------------------------
//
// Das Tor liegt acht Einheiten in Richtung -Z, die Kamera schaut nach +Z.

await walk('KeyS');

const inGate = await state();
check(
  inGate.prompt.includes('Lichtmoor'),
  `im Tor erscheint der Hinweis bei (${inGate.x.toFixed(1)}, ${inGate.z.toFixed(1)}): "${inGate.prompt}"`,
);
check(inGate.prompt.startsWith('[F]'), `mit der Taste davor ("${inGate.prompt}")`);

// Das Entscheidende: stehenbleiben. Frueher haette das gereicht.
await waitTicks(120);
const stillThere = await state();
check(
  stillThere.mapId === 'dornwald',
  `Stehen im Tor reist nicht (nach 120 Schritten noch auf ${stillThere.mapId})`,
);
check(stillThere.prompt.includes('Lichtmoor'), 'der Hinweis bleibt stehen, solange man drinsteht');

await page.keyboard.press('KeyF');
const arrived = await waitUntil(
  async () => (await page.evaluate(() => window.aurelith.mapId)) === 'lichtmoor',
  20000,
);
check(arrived, 'F betritt das Tor');

if (!arrived) {
  console.log(`  (Chat: ${(await state()).chat})`);
}

// --- Zweiter Wechsel: zurueck ---------------------------------------------
//
// Der eigentliche Pruefstein. Nach dem ersten Wechsel kann zwischen Client und
// Server etwas auseinandergelaufen sein, das man erst hier bemerkt.

if (arrived) {
  await waitReady();
  await waitTicks(4);

  const after = await state();
  check(
    Math.hypot(after.x - 0, after.z - 196) < 3,
    `Ankunft am vorgesehenen Punkt (${after.x.toFixed(1)}, ${after.z.toFixed(1)})`,
  );
  check(after.prompt === '', `nach der Ankunft kein Hinweis ("${after.prompt}")`);

  // Gegentor bei (0, 204), also in Richtung +Z.
  await walk('KeyW');

  const back = await state();
  const moved = Math.hypot(back.x - after.x, back.z - after.z);
  check(moved > 4, `die Figur laesst sich nach dem Wechsel noch bewegen (${moved.toFixed(1)} Einheiten)`);

  // Der Abstand zur Lage, die der Server meldet — und nicht die Zahl der
  // Korrekturen. Die schweigt naemlich, wenn der Server die Eingaben gar nicht
  // erst annimmt: ohne Bestaetigung findet die Korrektur keinen Anker und
  // vergleicht nichts. Genau daran ist eine fruehere Fassung dieses Tests
  // vorbeigelaufen, waehrend die Figur auf dem Server unbewegt am
  // Ankunftspunkt stand.
  const sync = await page.evaluate(() => ({
    serverDistance: window.aurelith.serverDistance,
    reconciles: window.aurelith.reconciles,
  }));
  check(
    sync.serverDistance < 1.5,
    `der Server sieht die Figur an derselben Stelle (${sync.serverDistance.toFixed(2)} Einheiten Abstand)`,
  );

  check(
    back.prompt.includes('Dornwald'),
    `das Tor der zweiten Karte meldet sich (${back.x.toFixed(1)}, ${back.z.toFixed(1)}): "${back.prompt}"`,
  );

  await page.keyboard.press('KeyF');
  const returned = await waitUntil(
    async () => (await page.evaluate(() => window.aurelith.mapId)) === 'dornwald',
    20000,
  );
  check(returned, 'F wirkt auch nach einem Kartenwechsel');
  if (!returned) console.log(`  (Chat: ${(await state()).chat})`);
}

// Der Server darf sich nicht von ueberall aus reisen lassen.
const cheated = await page.evaluate(async () => {
  const before = window.aurelith.mapId;
  // Die Verbindung ist nicht oeffentlich; ueber die Oberflaeche geht es auch
  // nicht, solange kein Tor in der Naehe ist. Also nur pruefen, dass die
  // Oberflaeche gar nichts anbietet.
  const el = document.querySelector('.portal-prompt');
  return { before, offered: !!el && !el.hidden };
});
check(!cheated.offered, 'die Oberflaeche bietet abseits eines Tores nichts an');

await browser.close();
shutdown();

console.log(`\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`);
process.exit(failures === 0 ? 0 : 1);
