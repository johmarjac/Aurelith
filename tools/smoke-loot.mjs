#!/usr/bin/env node
/**
 * Rauchtest: Beute fällt zu Boden und lässt sich aufheben.
 *
 * Die Regeln dahinter prüft `packages/server/test/loot_test.ts`, den Weg über
 * das Protokoll `packages/server/test/npcflow_test.ts`. Hier geht es um das,
 * was beide nicht sehen können: dass der Haufen im Bild auftaucht, dass ein
 * Schild darüber steht, und dass ein Klick darauf ihn tatsächlich aufhebt.
 *
 *   node tools/smoke-loot.mjs
 *
 * Die Figur startet mitten auf der Irrlichtwiese — `AURELITH_START_POS` spart
 * die siebzig Einheiten Fussweg, die sonst die halbe Laufzeit wären.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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

console.log('Aurelith — Beute am Boden\n');

const server = launch('npx tsx packages/server/src/index.ts', {
  AURELITH_PORT: '8794',
  // Mitten in den Irrlichtschwarm bei (-8, 78).
  AURELITH_START_POS: '-8,78',
  DATABASE_URL: '',
});
launch('cd packages/client && npx vite --port 5198 --strictPort --host 127.0.0.1', {
  AURELITH_SERVER: 'ws://127.0.0.1:8794',
});

if (!(await waitUntil(async () => server.log.join('').includes('bereit'), 60000))) {
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
  ],
});

const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const fehler = [];
page.on('pageerror', (err) => fehler.push(String(err)));

const name = `Beute${Date.now() % 100000}`;
await page.goto(`http://127.0.0.1:5198/?name=${name}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.aurelith?.localId > 0, { timeout: 40000 });
await page.waitForTimeout(2500);

console.log('Prüfungen');

// --- Vorher liegt nichts ---------------------------------------------------
//
// Die Gegenprobe muss zuerst kommen: eine Ansicht, die von Anfang an Haufen
// zeigt, würde jede folgende Prüfung bestehen, ohne dass je etwas gefallen
// wäre.
check(
  (await page.evaluate(() => window.aurelith.lootCount)) === 0,
  'vor dem ersten Kampf liegt nichts herum',
);
check(
  (await page.locator('.loot-label').count()) === 0,
  'und es steht kein Beuteschild im Bild',
);

// --- Ein Irrlicht suchen und erlegen ---------------------------------------
//
// Irrlichter greifen nicht von selbst an, also muss die Figur zu ihnen. Der
// Bot steuert nach dem, was **im Bild** steht: die Namensschilder sind nach
// Entfernung sortiert, das erste ist das nächste Wesen. Liegt es links der
// Bildmitte, wird die Kamera gedreht, bis es mittig steht — dann läuft die
// Figur geradeaus darauf zu, denn W folgt der Blickrichtung.
//
// Kein Zugriff auf Weltkoordinaten von Monstern: die gibt `window.aurelith`
// bewusst nicht her, und ein Testhaken dafür wäre Gerüst im Auslieferungscode.

const MITTE_X = 550;

/**
 * Bildschirmmitte des nächsten Monsterschilds, oder nichts.
 *
 * Die Schilder stehen nach Entfernung sortiert im DOM — das erste sichtbare
 * gehört zum nächsten Wesen. Gefiltert wird über `display`, nicht über
 * Playwrights `:visible`: ein Schild hinter der Kamera wird zwar auf einen
 * Punkt weit ausserhalb des Bildes projiziert, hat dort aber immer noch
 * Ausdehnung und gälte damit als sichtbar.
 */
async function zielX() {
  return page.evaluate((breite) => {
    for (const plate of document.querySelectorAll('.nameplate[data-kind="monster"]')) {
      if (plate.style.display === 'none') continue;
      const box = plate.getBoundingClientRect();
      const x = box.x + box.width / 2;
      // „Im Bild" heisst im Bild — nicht „ungefähr". Ein Wesen seitlich oder
      // hinter der Kamera landet bei der Projektion irgendwo daneben, und wer
      // darauf zusteuert, dreht sich fest: das Ziel kommt nie zur Mitte, weil
      // es nie auf dem Schirm war. Solche Schilder werden übersprungen, das
      // nächste in der Liste ist das zweitnächste Wesen.
      if (x < 0 || x > breite) continue;
      return x;
    }
    return undefined;
  }, 1100);
}

/**
 * Dreht die Kamera. Ein Zug nach rechts schiebt das Bild nach links.
 *
 * Gemessen und nicht angenommen: ein Zug von 550 auf 700 hat ein Schild von
 * 621 auf 555 gebracht. Wer ein Ziel rechts der Mitte zur Mitte holen will,
 * zieht also nach rechts.
 */
async function drehe(pixel) {
  await page.mouse.move(MITTE_X, 350);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(MITTE_X + pixel, 350, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(120);
}

let runde = 0;
const gefallen = await waitUntil(async () => {
  const x = await zielX();

  // Alle zehn Runden eine Spur. Ohne sie ist ein Fehlschlag nur „nichts
  // gefallen", und man braucht einen zweiten Lauf, um zu sehen, ob der Bot
  // gedreht, gelaufen oder gar nichts gefunden hat.
  if (++runde % 10 === 0) {
    const p = await page.evaluate(() => window.aurelith.player);
    console.log(
      `  · Runde ${runde}: Ziel ${x === undefined ? 'keins im Bild' : Math.round(x)}` +
        `, Figur bei ${p.x.toFixed(1)}/${p.z.toFixed(1)}`,
    );
  }

  // Nichts Brauchbares im Bild: weiterdrehen und wieder nachsehen.
  if (x === undefined) {
    await drehe(200);
    return false;
  }

  const abweichung = x - MITTE_X;
  if (Math.abs(abweichung) > 45) {
    await drehe(abweichung > 0 ? 120 : -120);
    return false;
  }

  // Ziel steht mittig: hinlaufen und dabei schlagen. Der Schlag trifft alles
  // im Bogen vor der Figur, ein eigenes Zielen braucht es nicht.
  await page.keyboard.down('KeyW');
  await page.keyboard.down('Space');
  await page.waitForTimeout(800);
  await page.keyboard.up('KeyW');
  await page.keyboard.up('Space');

  return (await page.evaluate(() => window.aurelith.lootCount)) > 0;
}, 150000);

check(gefallen, 'nach dem Kampf liegt Beute am Boden',
  `${await page.evaluate(() => window.aurelith.lootCount)} Haufen`);

const schilder = page.locator('.loot-label');
check(
  await waitUntil(async () => (await schilder.count()) > 0, 8000),
  'darüber steht ein Schild',
  String(await schilder.count()),
);

const beschriftung = (await schilder.first().textContent()) ?? '';
check(
  /Gold|Essenz|Irrlicht/.test(beschriftung),
  'und es nennt, was da liegt',
  beschriftung || '(leer)',
);

// Das Schild muss gross genug sein, um es mit dem Daumen zu treffen. Vierzig
// Bildpunkte sind die übliche Untergrenze; darunter zielt man.
const kasten = await schilder.first().boundingBox();
check(
  (kasten?.height ?? 0) >= 18 && (kasten?.width ?? 0) >= 40,
  'das Schild ist gross genug zum Antippen',
  kasten ? `${Math.round(kasten.width)}×${Math.round(kasten.height)} px` : 'ohne Ausdehnung',
);

await page.screenshot({ path: join(root, 'artefakte', 'beute.png') });

// --- Aufheben --------------------------------------------------------------

const vorher = await page.evaluate(() => window.aurelith.lootCount);
// `force`, weil das Schild wippt: Playwright wartet sonst darauf, dass sich
// die Fläche zwei Bilder lang nicht bewegt, und das tut sie nie. Ein echter
// Mausklick an der Stelle des Schilds bleibt es trotzdem — verdeckt jemand
// das Schild, landet der Klick auf dem, was davor liegt, und die Prüfung
// fällt durch. Genau das soll sie.
await schilder.first().click({ force: true });

check(
  await waitUntil(
    async () => ((await page.locator('.chat-log').textContent()) ?? '').includes('Aufgehoben:'),
    8000,
  ),
  'ein Klick auf das Schild hebt die Beute auf',
  ((await page.locator('.chat-log').textContent()) ?? '')
    .split('\n')
    .find((l) => l.includes('Aufgehoben:')) ?? 'keine Meldung',
);
check(
  await waitUntil(async () => (await page.evaluate(() => window.aurelith.lootCount)) < vorher, 8000),
  'und der Haufen verschwindet aus der Welt',
  `${vorher} → ${await page.evaluate(() => window.aurelith.lootCount)}`,
);

check(fehler.length === 0, 'keine unbehandelten Ausnahmen', String(fehler.length));
if (fehler.length > 0) console.error(fehler.join('\n'));

await browser.close();
shutdown();

console.log(failures === 0 ? '\nAlle Prüfungen bestanden.\n' : `\n${failures} Prüfung(en) fehlgeschlagen.\n`);
process.exit(failures === 0 ? 0 : 1);
