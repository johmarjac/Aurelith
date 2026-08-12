#!/usr/bin/env node
/**
 * Bilder vom Himmel zu mehreren Tageszeiten.
 *
 * Kein Test, ein Blick. Helligkeit lässt sich rechnen — der Tageszyklus wird
 * in `test:tag` geprüft —, aber ob eine Nacht *benutzbar* ist, sieht man nur.
 * Deshalb schiebt dieses Werkzeug die Uhr und macht Bilder.
 *
 *   node tools/shot-sky.mjs
 *
 * `AURELITH_TIME_OFFSET_MS` verschiebt die Serveruhr. Der Zyklus hängt an ihr
 * und nicht an der Geräteuhr — genau deshalb lässt er sich nur dort stellen
 * und nicht im Client. Je Tageszeit ein Serverlauf; Vite läuft durch.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

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

/** Beendet nur den Spielserver. Vite läuft über alle Tageszeiten durch. */
function shutdownServer(eintrag) {
  if (!eintrag) return;
  try {
    process.kill(-eintrag.child.pid, 'SIGKILL');
  } catch {
    // Schon beendet.
  }
  const i = procs.indexOf(eintrag);
  if (i >= 0) procs.splice(i, 1);
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

const waitUntil = async (fn, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

// Vierundzwanzig Minuten je Tag — dieselbe Zahl wie in tuning.json. Die
// Tageszeiten werden daraus als Anteil gerechnet.
//
// `VORLAUF` gleicht aus, was zwischen dem Stellen der Uhr und dem Bild
// vergeht: Server hochfahren, Seite laden, ein paar Bilder zeichnen. Bei
// vierundzwanzig Minuten je Tag ist eine echte Minute eine Spielstunde —
// ohne den Ausgleich wäre jedes Bild eine Dreiviertelstunde zu spät.
const TAG_MS = 24 * 60 * 1000;
const VORLAUF_MS = 42000;
//
// Die dritte Zahl dreht die Kamera waagerecht. Für den Mond ist sie nötig und
// ausgerechnet, nicht geraten: er steht der Sonne gegenüber, also auf der
// anderen Seite des Himmels. Bei t = 0,80 sind das 2,52 rad Blickrichtung und
// 17,9 Grad über dem Horizont — beides passt gerade noch ins Bild.
const ZEITEN = [
  ['mittag', 0.5, 0],
  ['abend', 0.79, 0],
  ['nacht', 0.0, 0],
  ['morgen', 0.27, 0],
  ['mond', 0.8, -456],
];

// Ein Server je Tageszeit wäre sauberer, dauert aber viermal so lange. Statt
// dessen läuft einer, und die Uhr wird zwischen den Bildern neu gestellt —
// der Client übernimmt sie aus dem Snapshot und rechnet den Zyklus neu.
function starteServer(versatzMs) {
  return launch('npx tsx packages/server/src/index.ts', {
    AURELITH_PORT: '8795',
    AURELITH_START_POS: '7,20',
    AURELITH_TIME_OFFSET_MS: String(versatzMs),
    DATABASE_URL: '',
  });
}

launch('cd packages/client && npx vite --port 5199 --strictPort --host 127.0.0.1', {
  AURELITH_SERVER: 'ws://127.0.0.1:8795',
});

let server = starteServer(0);

if (!(await waitUntil(async () => server.log.join('').includes('bereit'), 60000))) {
  console.error(server.log.join(''));
  throw new Error('Spielserver kam nicht hoch');
}
if (
  !(await waitUntil(async () => {
    try {
      return (await fetch('http://127.0.0.1:5199/')).ok;
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
  ],
});

mkdirSync(join(root, 'artefakte'), { recursive: true });

for (const [name, anteil, drehen] of ZEITEN) {
  // Die Serveruhr an die gewünschte Stelle im Zyklus schieben. Der Versatz
  // wirkt beim Start, also bekommt jede Tageszeit ihren eigenen Serverlauf.
  const ziel = anteil * TAG_MS;
  const versatz = Math.round((ziel - ((Date.now() + VORLAUF_MS) % TAG_MS) + TAG_MS) % TAG_MS);

  shutdownServer(server);
  server = starteServer(versatz);
  if (!(await waitUntil(async () => server.log.join('').includes('bereit'), 60000))) {
    console.error(server.log.join(''));
    throw new Error('Spielserver kam nicht hoch');
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`http://127.0.0.1:5199/?name=Himmel${name}${Date.now() % 10000}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => window.aurelith?.localId > 0, { timeout: 40000 });
  // Die Kamera anheben, damit Himmel und Boden beide im Bild sind — und,
  // wo nötig, waagerecht drehen.
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(640 + (drehen ?? 0), 250, { steps: 14 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(3500);

  const stand = await page.evaluate(() => ({
    ...window.aurelith.sky,
    kamera: Number(window.aurelith.camera.yaw.toFixed(2)),
  }));
  console.log(`${name.padEnd(7)} ${JSON.stringify(stand)}`);
  await page.screenshot({ path: join(root, 'artefakte', `himmel-${name}.png`) });
  await page.close();
}

await browser.close();
shutdown();
console.log('\nBilder liegen in artefakte/himmel-*.png\n');
