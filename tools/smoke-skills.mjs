#!/usr/bin/env node
/**
 * Rauchtest: der Fertigkeitenbaum.
 *
 * Vier Fragen, und keine davon beantwortet ein Blick auf den Code:
 *
 *   1. Liegt die Taste, wo sie liegen soll? `K` öffnet den Baum, die Konsole
 *      ist auf `Shift`+`^` gewandert. Zwei Fenster auf einer Taste merkt man
 *      erst, wenn das falsche aufgeht.
 *   2. Zeigt der Baum den Beruf — und zwar beides: was man kann und was noch
 *      kommt. Eine Liste, die nur das Erlernte zeigt, verschweigt die Hälfte.
 *   3. Landet eine erlernte Fertigkeit per Zug auf einem Platz der Leiste.
 *   4. Und die Gegenprobe dazu: eine **gesperrte** darf das nicht. Ohne sie
 *      ginge „zieht immer" als Erfolg durch, und auf der Leiste läge ein Knopf,
 *      der nichts tut.
 *
 * Der Beruf kommt im Spiel von einem Auftrag des Kampfmeisters, und der
 * verlangt acht Höhlenkriecher. Für diese Prüfung steht deshalb ein eigener
 * Inhaltsordner daneben: derselbe Auftrag, aber ohne Stufengrenze und mit
 * einem Ziel, das der Startbeutel schon erfüllt — ein Heiltrank. Der Weg zum
 * Beruf bleibt derselbe (annehmen, abgeben), nur die Strecke dazwischen fällt
 * weg. Dazu eine zweite Fertigkeit auf Stufe 30, damit es überhaupt etwas
 * Gesperrtes zu sehen gibt.
 *
 *   node tools/smoke-skills.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { anmeldenUndBetreten } from './lib/spielstart.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, 'tools', '.shots');
mkdirSync(shots, { recursive: true });

const PORT = 8795;
const WEB = 5199;

// --- Inhalte für die Prüfung ------------------------------------------------
//
// Kopiert wird **alles**, nicht nur die zwei geänderten Dateien: der Lader
// liest den Ordner als Ganzes, und eine fehlende Datei ist für ihn ein leerer
// Bestand, kein Rückfall auf das Original.
const quelle = join(root, 'assets', 'content');
const inhalt = mkdtempSync(join(tmpdir(), 'aurelith-skills-'));
for (const datei of readdirSync(quelle).filter((f) => f.endsWith('.json'))) {
  const daten = JSON.parse(readFileSync(join(quelle, datei), 'utf8'));

  if (datei === 'classes.json') {
    const erste = daten.skills[0];
    daten.skills.push({ ...erste, id: 'sturmhieb', name: 'Sturmhieb', level: 30, glyph: '⚔' });
  }
  if (datei === 'quests.json') {
    const beruf = daten.quests.find((q) => q.reward?.beruf);
    if (!beruf) throw new Error('Kein Auftrag lehrt einen Beruf — die Prüfung hätte keinen Aufhänger.');
    beruf.levelReq = 1;
    // Ein Sammelziel und kein leeres: der Inhaltslader weist einen Auftrag
    // ohne Ziel zurück — zu Recht. Sammelziele misst der Server beim Annehmen
    // am Beutel, der Trank liegt dort von Anfang an, und damit ist der Auftrag
    // im selben Atemzug abgabebereit.
    beruf.objectives = [
      { kind: 'collect', target: 'potion_hp_small', count: 1, text: 'Heiltrank vorzeigen' },
    ];
  }
  // Ein Besen im Startbeutel — für den letzten Abschnitt, in dem geprüft wird,
  // dass auf dem Fluggerät nichts gewirkt wird.
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
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

console.log('Aurelith — Fertigkeitenbaum\n');

// Der Startpunkt liegt neben dem Kampfmeister (er steht in Silberfurt auf
// −4/−101). Ohne das müsste die Prüfung erst quer über die Karte laufen — und
// ein Laufweg, der scheitert, sähe aus wie ein kaputtes Gespräch.
const server = launch('npx tsx packages/server/src/index.ts', {
  AURELITH_PORT: String(PORT),
  DATABASE_URL: '',
  AURELITH_CONTENT_DIR: inhalt,
  AURELITH_START_POS: '-2,-98',
});
launch(`cd packages/client && npx vite --port ${WEB} --strictPort --host 127.0.0.1`, {
  AURELITH_SERVER: `ws://127.0.0.1:${PORT}`,
});

if (!(await waitUntil(async () => server.log.join('').includes('bereit'), 60000))) {
  console.error(server.log.join(''));
  throw new Error('Spielserver kam nicht hoch');
}
if (
  !(await waitUntil(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${WEB}/`)).ok;
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

/*
 * Die Inhalte liest der Browser aus `assets/`, der Server aus seinem Ordner —
 * im Betrieb ist das derselbe Baum. Für diese Prüfung liegt er im Temp, und
 * damit die beiden nicht auseinanderlaufen, bekommt auch der Browser ihn:
 * dieselben Dateien, nicht ein zweites Mal von Hand geändert.
 */
await page.route(/\/content\/[a-z]+\.json/, (route) => {
  const datei = new URL(route.request().url()).pathname.split('/').pop();
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: readFileSync(join(inhalt, datei), 'utf8'),
  });
});

await page.goto(`http://127.0.0.1:${WEB}/`, { waitUntil: 'domcontentloaded' });
await anmeldenUndBetreten(page, `Fert${Date.now() % 100000}`, 'pruefer-passwort', 'Klingerin');
await page.waitForTimeout(2000);

const fenster = page.locator('[data-window="skills"]');
const konsole = page.locator('[data-window="konsole"]');
const offen = async (locator) => (await locator.getAttribute('data-open')) === 'true';
const liste = async () => (await page.locator('.skill-liste').textContent()) ?? '';

console.log('Die Taste');

await page.keyboard.press('KeyK');
check(await waitUntil(() => offen(fenster), 4000), 'K öffnet den Fertigkeitenbaum');
check(!(await offen(konsole)), 'und nicht mehr die Konsole');

// Shift+^ — `Backquote` ist die Stelle auf der Tastatur, auf deutschen Brettern
// trägt sie das ^. Playwright benennt die Stelle, nicht das Zeichen.
await page.keyboard.press('Shift+Backquote');
check(await waitUntil(() => offen(konsole), 4000), 'Shift+^ öffnet die Konsole');
await page.keyboard.press('Shift+Backquote');

console.log('\nOhne Beruf');

check(
  (await liste()).includes('Noch kein Beruf'),
  'der Baum sagt, dass noch keiner gelernt ist',
  (await liste()).slice(0, 40),
);
check((await page.locator('.skill').count()) === 0, 'und listet keine Fertigkeit');

console.log('\nDen Beruf lernen');

await page.keyboard.press('KeyK'); // Zu, sonst liegt er über dem Gespräch.

const torvald = page.locator('.nameplate', { hasText: 'Torvald' }).first();
check(await torvald.isVisible(), 'der Kampfmeister steht in Reichweite');
const kasten = await torvald.boundingBox();
if (!kasten) throw new Error('Namensschild ohne Ausdehnung');
// Das Schild hängt über dem Kopf; getroffen werden soll der Körper.
await page.mouse.click(kasten.x + kasten.width / 2, kasten.y + kasten.height + 50);

const dialog = page.locator('[data-window="dialog"]');
check(await waitUntil(() => offen(dialog), 8000), 'das Gespräch geht auf');
await dialog.getByRole('button', { name: 'Annehmen' }).click();
check(
  await waitUntil(async () => (await dialog.getByRole('button', { name: 'Abgeben' }).count()) > 0, 8000),
  'nach dem Annehmen steht der Abgeben-Knopf da',
);
await dialog.getByRole('button', { name: 'Abgeben' }).click();

await page.keyboard.press('Escape');
await page.keyboard.press('KeyK');
check(
  await waitUntil(async () => (await liste()).includes('Krieger'), 8000),
  'der Baum trägt jetzt den Beruf im Kopf',
  (await liste()).slice(0, 40),
);

console.log('\nWas man kann und was noch kommt');

const zeile = (id) => page.locator(`.skill[data-skill="${id}"]`);
check((await page.locator('.skill').count()) === 2, 'beide Fertigkeiten des Berufs stehen im Baum');
check(
  (await zeile('wirbelklinge').getAttribute('data-kann')) === '1',
  'die Wirbelklinge ist erlernt',
);
check(
  (await zeile('sturmhieb').getAttribute('data-kann')) === '0',
  'der Sturmhieb noch nicht — Stufe 30',
);
check(
  ((await zeile('sturmhieb').textContent()) ?? '').includes('ab Stufe 30'),
  'und die Zeile sagt auch, ab wann',
);
await fenster.screenshot({ path: join(shots, 'skills-baum.png') });

console.log('\nAuf die Leiste ziehen');

/** Zieht von einer Bildstelle zur anderen — in Schritten, sonst sieht der Browser keine Bewegung. */
async function ziehe(von, nach) {
  await page.mouse.move(von.x, von.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(von.x + ((nach.x - von.x) * i) / 8, von.y + ((nach.y - von.y) * i) / 8);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
}

const mitte = async (locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Nicht gefunden');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

const leiste = () => page.evaluate(() => window.aurelith.aktionsleiste);
const FERTIGKEIT = 2; // AktionsArt.Fertigkeit

const vorher = await leiste();
check(vorher[4]?.art === 0 && vorher[5]?.art === 0, 'die Plätze 5 und 6 sind vorher leer');

await ziehe(await mitte(zeile('wirbelklinge')), await mitte(page.locator('.action-slot[data-aktion="4"]')));
const belegt = await leiste();
check(
  belegt[4]?.art === FERTIGKEIT && belegt[4]?.id === 'wirbelklinge',
  'die Wirbelklinge liegt danach auf Platz 5',
  `${belegt[4]?.art}/${belegt[4]?.id || 'leer'}`,
);

await ziehe(await mitte(zeile('sturmhieb')), await mitte(page.locator('.action-slot[data-aktion="5"]')));
const gesperrt = await leiste();
check(
  gesperrt[5]?.art === 0,
  'der gesperrte Sturmhieb bleibt liegen, wo er ist',
  `${gesperrt[5]?.art}/${gesperrt[5]?.id || 'leer'}`,
);
await page.screenshot({ path: join(shots, 'skills-leiste.png') });

console.log('\nDieselbe Fertigkeit auf zwei Plätzen');

/*
 * Die Abklingzeit gehört der Fertigkeit, nicht dem Knopf.
 *
 * Vorher lag sie am Platz: wer dieselbe Fertigkeit zweimal auf die Leiste
 * legte, sah nur den einen herunterzählen, während der andere bereit aussah —
 * und beim Drücken sagte der Server nein. Eine Anzeige, die das Gegenteil
 * dessen behauptet, was gilt.
 */
await ziehe(await mitte(zeile('wirbelklinge')), await mitte(page.locator('.action-slot[data-aktion="6"]')));
const zweimal = await leiste();
check(
  zweimal[6]?.art === FERTIGKEIT && zweimal[6]?.id === 'wirbelklinge',
  'die Wirbelklinge liegt ein zweites Mal auf Platz 7',
  `${zweimal[6]?.art}/${zweimal[6]?.id || 'leer'}`,
);

const abkling = (i) =>
  page.evaluate(
    (n) => document.querySelector(`.action-slot[data-aktion="${n}"]`)?.dataset.abkling ?? '?',
    i,
  );

check(
  (await abkling(4)) !== '1' && (await abkling(6)) !== '1',
  'vorher zählt nichts herunter',
  `${await abkling(4)}/${await abkling(6)}`,
);

await page.click('.action-slot[data-aktion="4"]');
await page.waitForTimeout(400);

check((await abkling(4)) === '1', 'der gedrückte Platz zählt herunter');
check((await abkling(6)) === '1', 'und der andere mit derselben Fertigkeit auch');

// Die Gegenprobe: der leere Platz dazwischen bleibt unberührt. Ohne sie ginge
// „alle Plätze zählen herunter" als Erfolg durch — und zusammen mit der
// Messung davor steht damit fest, dass die Eins von diesem Klick kommt.
check((await abkling(5)) !== '1', 'der leere Platz dazwischen bleibt bereit', await abkling(5));

console.log('\nAuf dem Fluggerät wird nicht gewirkt');

/*
 * Zwei Dinge in einem Abschnitt, weil sie zusammengehören: die Sperre und ihre
 * Begründung.
 *
 * Der Server sagt ab — das ist die Regel. Der Client sagt vorher ab — das ist
 * der Grund für diese Prüfung: sonst liefe die Abklingzeit los, bevor die
 * Absage zurückkommt, und die Fertigkeit wäre ihre vollen sechs Sekunden
 * gesperrt, ohne je gewirkt worden zu sein. Zurückdrehen liesse sie sich
 * nicht; der Client weiss hinterher nicht, welche Uhr zu welchem Klick gehört.
 *
 * Und die Absage muss **zu sehen** sein. Eine Sperre ohne Begründung ist im
 * Spiel dasselbe wie ein kaputter Knopf.
 */
const hinweis = () =>
  page.evaluate(() => {
    const el = document.querySelector('.hinweis-zeile');
    return el?.dataset.sichtbar === '1' ? (el.textContent ?? '') : '';
  });
const beutel = () => page.evaluate(() => window.aurelith.inventar);
const besenLiegt = async (angelegt) =>
  (await beutel()).find((e) => e.itemId === 'flug_besen')?.equipped === angelegt;

await page.keyboard.press('KeyI');
await page.waitForSelector('.window[data-window="inventory"][data-open="true"]', { timeout: 10000 });
await page.waitForTimeout(400);
const besen = (await beutel()).find((e) => e.itemId === 'flug_besen');
check(besen !== undefined, 'der Besen liegt im Beutel', String(besen?.slot));
await page.dblclick(`.item-slot[data-bag-slot="${besen.slot}"]`);
// Auf das Ergebnis gewartet und nicht auf eine Zahl Millisekunden: wie lange
// das Aufsteigen dauert, steht im Server (`AUFSTIEG_MS`), und ein Test, der
// die Zahl hier abschreibt, ist beim nächsten Drehen daran still falsch.
check(await waitUntil(() => besenLiegt(true), 20000), 'nach der Wartezeit sitzt die Figur darauf');
await page.keyboard.press('KeyI');
await page.waitForTimeout(300);

// Die Uhr vom Klick weiter oben muss erst ablaufen — sonst prüfte der nächste
// Klick die Abklingzeit und nicht das Fliegen.
check(
  await waitUntil(async () => (await abkling(4)) !== '1', 10000),
  'die Wirbelklinge ist wieder bereit',
);

await page.click('.action-slot[data-aktion="4"]');
await page.waitForTimeout(500);
const gesagt = await hinweis();
// Auf den ganzen Satz geprüft und nicht nur auf das Wort „Fluggerät": beim
// Aufsteigen steht dort ebenfalls eine Meldung, und die soll hier nicht als
// Absage durchgehen.
check(
  /Wirbelklinge lässt sich auf dem Fluggerät/.test(gesagt),
  'der Klick sagt ab und nennt den Grund',
  gesagt,
);
check((await abkling(4)) !== '1', 'und die Abklingzeit läuft dabei nicht an');

// --- Gegenprobe: am Boden geht dieselbe Fertigkeit --------------------------
//
// Ohne sie prüfte der Abschnitt nur, dass ein Klick auf Platz 5 irgendetwas
// nicht tut — auch ein kaputter Platz käme damit durch.
await page.keyboard.press('KeyI');
await page.waitForTimeout(400);
await page.dblclick('.equip-slot[data-slot="flug"]');
check(await waitUntil(() => besenLiegt(false), 10000), 'abgestiegen');
await page.keyboard.press('KeyI');
await page.waitForTimeout(400);

await page.click('.action-slot[data-aktion="4"]');
await page.waitForTimeout(500);
check((await abkling(4)) === '1', 'am Boden wirkt dieselbe Fertigkeit und klingt ab');

console.log(`\n  Bilder: ${shots}/skills-*.png`);

await browser.close();
shutdown();

console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
