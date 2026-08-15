#!/usr/bin/env node
/**
 * Rauchtest: fliegen.
 *
 * Geflogen wird über die Lage, nicht über Richtungstasten — und genau das
 * prüft dieser Lauf, weil man es an einer Zahl festmachen kann:
 *
 *   1. Aufsteigen legt das Gerät an: aus dem Beutel in den Flugplatz.
 *   2. Ohne Schub steht die Figur in der Luft. Kein Fallen, kein Driften.
 *   3. Die Leertaste schaltet den Schub um — und er fährt an, statt zu stehen.
 *   4. S hebt die Nase — im Bild und in der Höhe, auch ohne Schub.
 *   5. Nase nach unten trägt sie nicht durch das Gelände.
 *   6. Wer sich auf dem Gerät abmeldet, sitzt danach wieder darauf.
 *   7. Die Debug-Tafel zeigt dieselben Winkel, nach denen geflogen wird.
 *   8. Absteigen lässt sie fallen.
 *
 * Der Kern rechnet dasselbe (`native_test.cpp`); hier geht es um die Kette
 * davor: Doppelklick, Ausrüstung, Eingabe, Vorhersage.
 *
 * Gewartet wird auf **Ticks**, nicht auf Millisekunden.
 *
 * Der Client holt je Bild höchstens 0,1 s Simulation nach (`Math.min(0.1, …)`
 * in der Bildschleife), damit ein Fenster im Hintergrund nicht hundert
 * Schritte auf einmal nachrechnet. Unter swiftshader kommen nur ein paar
 * Bilder je Sekunde heraus, und damit vergeht in der Welt weniger Zeit als an
 * der Wanduhr — hier waren es 14 Ticks in 2,5 Sekunden statt 50. Eine in
 * Millisekunden gemessene Flugstrecke prüft deshalb die Bildrate des
 * Testrechners und nicht das Fliegen.
 *
 *   node tools/smoke-flug.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { anmeldenBestehend, anmeldenUndBetreten } from './lib/spielstart.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8792;
const WEB = 5192;

const quelle = join(root, 'assets', 'content');
const inhalt = mkdtempSync(join(tmpdir(), 'aurelith-flug-'));
for (const datei of readdirSync(quelle).filter((f) => f.endsWith('.json'))) {
  const daten = JSON.parse(readFileSync(join(quelle, datei), 'utf8'));
  if (datei === 'items.json') daten.starter.push({ item: 'flug_besen' });
  writeFileSync(join(inhalt, datei), JSON.stringify(daten));
}

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
const shutdown = () => {
  for (const { child } of procs) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Schon beendet.
    }
  }
};
process.on('exit', shutdown);

let failures = 0;
const check = (ok, was, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${was}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const waitUntil = async (fn, ms) => {
  const bis = Date.now() + ms;
  while (Date.now() < bis) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

console.log('Aurelith — Fliegen\n');

const server = launch('npx tsx packages/server/src/index.ts', {
  AURELITH_PORT: String(PORT),
  DATABASE_URL: '',
  AURELITH_CONTENT_DIR: inhalt,
  AURELITH_START_POS: '0,0',
});
launch(`cd packages/client && npx vite --port ${WEB} --strictPort --host 127.0.0.1`, {
  AURELITH_SERVER: `ws://127.0.0.1:${PORT}`,
});
if (!(await waitUntil(async () => server.log.join('').includes('bereit'), 60000))) {
  console.error(server.log.join(''));
  throw new Error('Spielserver kam nicht hoch');
}
if (!(await waitUntil(async () => {
  try {
    return (await fetch(`http://127.0.0.1:${WEB}/`)).ok;
  } catch {
    return false;
  }
}, 60000))) throw new Error('Client-Server kam nicht hoch');

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
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
await page.route(/\/content\/[a-z]+\.json/, (route) => {
  const datei = new URL(route.request().url()).pathname.split('/').pop();
  route.fulfill({ status: 200, contentType: 'application/json', body: readFileSync(join(inhalt, datei), 'utf8') });
});
await page.goto(`http://127.0.0.1:${WEB}/`, { waitUntil: 'domcontentloaded' });
const konto = `Flug${Date.now() % 100000}`;
await anmeldenUndBetreten(page, konto, 'pruefer-passwort', 'Flugschuelerin');
await page.waitForTimeout(2000);

const stelle = () => page.evaluate(() => ({ ...window.aurelith.player }));
const beutel = () => page.evaluate(() => window.aurelith.inventar);
const ticks = () => page.evaluate(() => window.aurelith.ticks);
/** Wartet, bis die Simulation `n` Schritte weiter ist. 20 Ticks = 1 Sekunde Welt. */
const warte = async (n) => {
  const start = await ticks();
  if (!(await waitUntil(async () => (await ticks()) >= start + n, 60000))) {
    throw new Error(`Simulation kam über ${n} Ticks nicht hinaus`);
  }
};
const halte = async (taste, n) => {
  await page.keyboard.down(taste);
  await warte(n);
  await page.keyboard.up(taste);
};

console.log('Aufsteigen');

await page.keyboard.press('KeyI');
await page.waitForSelector('.window[data-window="inventory"][data-open="true"]', { timeout: 10000 });
await page.waitForTimeout(400);

const amBoden = await stelle();
const platz = (await beutel()).find((e) => e.itemId === 'flug_besen')?.slot ?? -1;
check(platz >= 0, 'der Besen liegt im Beutel', String(platz));
await page.dblclick(`.item-slot[data-bag-slot="${platz}"]`);
await page.waitForTimeout(900);

const nachAufstieg = (await beutel()).find((e) => e.itemId === 'flug_besen');
check(nachAufstieg?.equipped === true, 'nach dem Doppelklick ist er angelegt');
check(
  (await page.locator('.item-slot[data-bag-slot] .item-icon').count()) >= 0 &&
    (await page.locator('.equip-slot[data-slot="flug"] .item-icon').count()) === 1,
  'und sitzt im Flugplatz',
);
await page.keyboard.press('KeyI');
await page.waitForTimeout(300);

const abgehoben = await stelle();
// Gegen den **Boden** gemessen und nicht gegen null: das Gelände liegt an
// dieser Stelle unter dem Meeresspiegel, und eine absolute Höhe sagte nichts.
check(
  abgehoben.y > amBoden.y + 0.8,
  `die Figur hebt ab (${amBoden.y.toFixed(2)} → ${abgehoben.y.toFixed(2)})`,
);

console.log('\nOhne Schub steht sie');

const vorher = await stelle();
await warte(30);
const jetzt = await stelle();
check(
  Math.abs(jetzt.y - vorher.y) < 0.1 && Math.hypot(jetzt.x - vorher.x, jetzt.z - vorher.z) < 0.1,
  'ohne Schub bleibt sie stehen',
  `Δ ${Math.hypot(jetzt.x - vorher.x, jetzt.z - vorher.z).toFixed(2)} / ${(jetzt.y - vorher.y).toFixed(2)}`,
);

console.log('\nSchub und Nase');

await page.keyboard.press('Space');
await warte(6);
const kurzNach = await stelle();
const weitKurz = Math.hypot(kurzNach.x - jetzt.x, kurzNach.z - jetzt.z);

await warte(50);
const geflogen = await stelle();
const weit = Math.hypot(geflogen.x - jetzt.x, geflogen.z - jetzt.z);
check(weit > 8, `mit Schub fliegt sie los (${weit.toFixed(1)} Einheiten)`);
// Die Rampe: nach knapp einem Zehntel der Zeit darf noch kein Zehntel des
// Weges liegen. Ohne diese Prüfung ginge auch ein Schub durch, der sofort auf
// vollem Tempo steht.
check(
  weitKurz < weit * 0.1,
  `und fährt dabei an, statt sofort zu stehen (${weitKurz.toFixed(2)} nach 6 Ticks)`,
);

const vorNase = await stelle();
await halte('KeyS', 20);
await warte(30);
const gestiegen = await stelle();
check(gestiegen.y > vorNase.y + 2, `S hebt die Nase und sie steigt (${vorNase.y.toFixed(1)} → ${gestiegen.y.toFixed(1)})`);
/*
 * Und die Nase steht auch im Bild.
 *
 * Die eigentliche Gegenprobe: vorher schätzte der Renderer die Neigung aus dem
 * zurückgelegten Weg. Solange die Figur fliegt, kommt dabei ungefähr das
 * Richtige heraus — nur eben nicht, wenn sie steht. Deshalb wird gleich unten
 * ohne Schub gemessen.
 */
check(
  gestiegen.neigung > 0.4,
  `und die gezeichnete Nase zeigt hinauf (${gestiegen.neigung.toFixed(2)} rad)`,
);

// Gegenprobe: W senkt sie wieder. Doppelt so lange gehalten wie S — die Nase
// muss erst durch die Waagerechte, bevor es abwärts geht.
await halte('KeyW', 40);
await warte(30);
const gesunken = await stelle();
check(gesunken.y < gestiegen.y, `W senkt sie wieder (${gesunken.y.toFixed(1)})`);
check(
  gesunken.y >= gesunken.boden + 1.1,
  `und trägt sie nicht durch das Gelände (${gesunken.y.toFixed(1)} über Boden ${gesunken.boden.toFixed(1)})`,
);

console.log('\nDie Debug-Tafel');

/*
 * Ohne Schalter keine Tafel, mit Schalter die richtigen Zahlen.
 *
 * Geprüft wird nicht nur, dass etwas dasteht, sondern dass es **mitgeht**: die
 * Nase in der Tafel muss derselben Taste folgen wie die Figur. Eine Tafel, die
 * eine feste Zahl zeigt, wäre schlimmer als keine — man glaubt ihr.
 */
const tafel = () => page.evaluate(() => {
  const el = document.querySelector('.debug-tafel');
  if (!el || el.style.display === 'none') return '';
  return el.textContent ?? '';
});

check((await tafel()) === '', 'ohne Schalter steht keine Tafel im Bild');

await page.keyboard.press('KeyO');
await page.waitForSelector('.window[data-window="settings"][data-open="true"]', { timeout: 10000 });
const schalter = page.locator('.window[data-window="settings"] .settings-toggle', {
  hasText: 'Debug anzeigen',
});
check((await schalter.count()) === 1, 'die Einstellung gibt es');
await schalter.locator('input[type="checkbox"]').check();
await page.keyboard.press('KeyO');
await warte(4);

const gezeigt = await tafel();
check(/Nase\s+[+-]\d+°/.test(gezeigt), 'die Tafel nennt die Nase', gezeigt.split('\n')[2] ?? '');
check(/Kurs\s+\d+°/.test(gezeigt), 'und den Kurs', gezeigt.split('\n')[1] ?? '');
check(/Knüppel X [+-]\d/.test(gezeigt), 'und was der Knüppel meldet');

const naseAus = (text) => Number(/Nase\s+([+-]\d+)°/.exec(text)?.[1] ?? 'NaN');
const vorher2 = naseAus(gezeigt);
await halte('KeyS', 16);
await warte(4);
const nachher2 = naseAus(await tafel());
check(
  nachher2 > vorher2 + 20,
  `und die Zahl geht mit der Taste mit (${vorher2}° → ${nachher2}°)`,
);
await halte('KeyW', 16);
await warte(4);

console.log('\nAbmelden und wieder ankommen');

/*
 * Wer auf dem Besen aufhört, sitzt beim nächsten Mal wieder darauf.
 *
 * Und zwar in der Welt des Servers und nicht nur im Bild: hier fehlte der
 * Aufruf, der die Ausrüstung in den Kern trägt. Der Beutel meldete das Gerät,
 * der Client schaltete auf Fliegen, der Server führte dieselbe Figur zu Fuss —
 * und jeder Schnappschuss riss sie zurück. Deshalb wird unten nicht nur
 * geprüft, dass sie in der Luft steht, sondern auch, dass die Vorhersage nicht
 * dauernd korrigiert werden muss. Das ist der Unterschied zwischen „fliegt"
 * und „zappelt".
 */
await page.reload({ waitUntil: 'domcontentloaded' });
await anmeldenBestehend(page, konto);
await page.waitForTimeout(2000);
await warte(20);

const wieder = await stelle();
check(
  wieder.y > wieder.boden + 1.0,
  'nach dem Wiedereinstieg steht sie in der Luft',
  `${wieder.y.toFixed(1)} über Boden ${wieder.boden.toFixed(1)}`,
);
check(
  (await beutel()).find((e) => e.itemId === 'flug_besen')?.equipped === true,
  'und der Besen liegt noch im Flugplatz',
);

await page.keyboard.press('Space');
await warte(50);
const wiederGeflogen = await stelle();
const wiederWeit = Math.hypot(wiederGeflogen.x - wieder.x, wiederGeflogen.z - wieder.z);
check(wiederWeit > 5, `und der Schub trägt sie (${wiederWeit.toFixed(1)} Einheiten)`);
const korrekturen = await page.evaluate(() => window.aurelith.reconciles);
check(korrekturen === 0, `ohne dass der Server dagegenhält (${korrekturen} Korrekturen)`);

// Der Schub läuft jetzt noch — den schaltet der nächste Abschnitt ab.
console.log('\nAnhalten und absteigen');

await page.keyboard.press('Space');
// Die Rampe braucht zwei Sekunden Welt zum Ausrollen; erst danach darf
// „steht" geprüft werden.
await warte(50);
// Die Nase bleibt oben, auch wenn nichts mehr fliegt. Genau hier lag der
// Fehler: aus einem Weg von null lässt sich kein Winkel schätzen.
const stehend = await stelle();
await halte('KeyS', 20);
await warte(10);
const nurNase = await stelle();
check(
  nurNase.neigung > stehend.neigung + 0.3,
  `ohne Schub kippt die Nase trotzdem sichtbar (${stehend.neigung.toFixed(2)} → ${nurNase.neigung.toFixed(2)} rad)`,
);
// Und zurück in die Waagerechte, sonst misst die nächste Prüfung ein Steigen.
await halte('KeyW', 20);
await warte(10);
const a = await stelle();
await warte(24);
const b = await stelle();
check(
  Math.hypot(b.x - a.x, b.z - a.z) < 0.2,
  'die zweite Leertaste hält sie an',
  `${Math.hypot(b.x - a.x, b.z - a.z).toFixed(2)} Einheiten in 24 Ticks`,
);

await page.keyboard.press('KeyI');
await page.waitForTimeout(400);
await page.dblclick('.equip-slot[data-slot="flug"]');
await warte(40);
await page.keyboard.press('KeyI');

const gelandet = await stelle();
check(gelandet.y < b.y - 1, `nach dem Absteigen fällt sie (${b.y.toFixed(1)} → ${gelandet.y.toFixed(1)})`);
check(
  (await beutel()).find((e) => e.itemId === 'flug_besen')?.equipped === false,
  'und der Besen liegt wieder im Beutel',
);

const fehler = await page.evaluate(() => window.aurelith.fehler ?? 0);
console.log(`\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`);
await browser.close();
shutdown();
process.exit(failures === 0 ? 0 : 1);
