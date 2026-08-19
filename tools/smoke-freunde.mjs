#!/usr/bin/env node
/**
 * Rauchtest: das Freundefenster im Browser.
 *
 * Die Regeln dahinter prüft `packages/server/test/freunde_test.ts` über das
 * Protokoll. Hier geht es um das, was der nicht sehen kann: dass sich das
 * Fenster mit `E` öffnet, dass der Plusknopf ein zweites aufmacht, dass eine
 * Anfrage als Ja-Nein vor dem Bild steht — und dass danach in **beiden**
 * Fenstern eine Zeile mit Name, Stufe und Onlinestand steht.
 *
 *   node tools/smoke-freunde.mjs
 *
 * Zwei Browserseiten auf einem Server: anders lässt sich eine Freundschaft
 * nicht prüfen. Sie laufen nacheinander durch die Anmeldung, weil zwei
 * WebGL-Kontexte in SwiftShader zusammen auf ein bis zwei Bilder je Sekunde
 * fallen — für dieses Fenster reicht das trotzdem, denn geprüft wird die
 * Oberfläche und keine Bewegung.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { anmeldenUndBetreten } from './lib/spielstart.mjs';

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
process.on('exit', () => {
  for (const { child } of procs) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Schon beendet.
    }
  }
});

let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const waitUntil = async (fn, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

console.log('Aurelith — das Freundefenster\n');

const PORT = 8810;
const VITE = 5212;
const server = launch('npx tsx packages/server/src/index.ts', {
  AURELITH_PORT: String(PORT),
  AURELITH_START_POS: '-44,-232',
  DATABASE_URL: '',
});
launch(`cd packages/client && npx vite --port ${VITE} --strictPort --host 127.0.0.1`, {
  AURELITH_SERVER: `ws://127.0.0.1:${PORT}`,
});

if (!(await waitUntil(async () => server.log.join('').includes('bereit'), 60000))) {
  console.error(server.log.join(''));
  throw new Error('Spielserver kam nicht hoch');
}
if (
  !(await waitUntil(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${VITE}/`)).ok;
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

const fehler = [];
async function seite(name) {
  const page = await browser.newPage({
    viewport: { width: 900, height: 620 },
    deviceScaleFactor: 0.5,
  });
  page.on('pageerror', (e) => fehler.push(`${name}: ${e}`));
  page.on('console', (m) => {
    if (m.type() === 'error') fehler.push(`${name}: ${m.text()}`);
  });
  await page.goto(`http://127.0.0.1:${VITE}/`, { waitUntil: 'domcontentloaded' });
  await anmeldenUndBetreten(page, name);
  if (!(await waitUntil(async () => (await page.evaluate(() => window.aurelith?.localId ?? 0)) !== 0, 30000))) {
    throw new Error(`${name}: kein Welcome`);
  }
  return page;
}

const marke = Date.now() % 10000;
const ANNA = `Anna${marke}`;
const BORIS = `Boris${marke}`;

const anna = await seite(ANNA);
const boris = await seite(BORIS);
await anna.waitForTimeout(1500);

const offen = (page) =>
  page.evaluate(
    () => document.querySelector('.window[data-window="freunde"]')?.dataset.open === 'true',
  );
const zeilen = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.freunde-zeile')].map((z) => ({
      name: z.dataset.name,
      online: z.dataset.online,
      text: z.textContent,
    })),
  );

// --- Das Fenster ------------------------------------------------------------

console.log('Das Fenster');

check(!(await offen(anna)), 'zu Beginn ist es zu');
await anna.keyboard.press('KeyE');
await anna.waitForTimeout(400);
check(await offen(anna), 'E macht es auf');
await anna.keyboard.press('KeyE');
await anna.waitForTimeout(400);
check(!(await offen(anna)), 'und E wieder zu');

// Und über das Menü — derselbe Weg wie bei jedem anderen Fenster.
await anna.click('.menu-button');
await anna.click('.menu-entry:has-text("Freunde")');
await anna.waitForTimeout(400);
check(await offen(anna), 'der Menüeintrag macht es ebenfalls auf');

check(
  (await zeilen(anna)).length === 0,
  'und es ist leer',
  JSON.stringify(await zeilen(anna)),
);

// --- Anfragen und annehmen --------------------------------------------------

console.log('\nAnfragen und annehmen');

await anna.click('.window[data-window="freunde"] .freunde-knopf:has-text("+")');
await anna.waitForTimeout(400);
check(
  await anna.evaluate(
    () => document.querySelector('.window[data-window="freund-neu"]')?.dataset.open === 'true',
  ),
  'der Plusknopf macht das Eingabefenster auf',
);

await anna.fill('.window[data-window="freund-neu"] .freunde-feld', BORIS);
await anna.click('.window[data-window="freund-neu"] .freunde-knopf:has-text("Anfragen")');

check(
  await waitUntil(
    async () => !(await boris.evaluate(() => document.querySelector('.freund-anfrage')?.hidden ?? true)),
    10000,
  ),
  'die Frage steht bei Boris vor dem Bild',
);
check(
  (await boris.textContent('.freund-anfrage-text'))?.includes(ANNA) ?? false,
  'und nennt Anna',
  (await boris.textContent('.freund-anfrage-text')) ?? '',
);

await boris.click('.freund-anfrage .freunde-knopf:has-text("Ja")');

check(
  await waitUntil(async () => (await zeilen(anna)).length === 1, 10000),
  'danach steht bei Anna eine Zeile',
  JSON.stringify(await zeilen(anna)),
);
const zeile = (await zeilen(anna))[0] ?? {};
check(zeile.name === BORIS, 'mit dem Namen', String(zeile.name));
check((zeile.text ?? '').includes('Stufe 1'), 'mit der Stufe', zeile.text ?? '');
check(zeile.online === 'true', 'und als anwesend markiert', String(zeile.online));

await boris.keyboard.press('KeyE');
await boris.waitForTimeout(500);
check(
  await waitUntil(async () => (await zeilen(boris)).length === 1, 8000),
  'und bei Boris genauso — beidseitig',
  JSON.stringify(await zeilen(boris)),
);

// --- Auswahl, Kontextmenü, private Nachricht --------------------------------

console.log('\nAuswahl und Kontextmenü');

const entfernenAus = () =>
  anna.evaluate(
    () =>
      document.querySelector('.window[data-window="freunde"] .freunde-knopf:nth-child(2)')
        ?.disabled ?? null,
  );
check((await entfernenAus()) === true, 'ohne Auswahl ist „Entfernen" aus');
await anna.click(`.freunde-zeile[data-name="${BORIS}"]`);
await anna.waitForTimeout(300);
check((await entfernenAus()) === false, 'mit Auswahl ist er an');

// Rechtsklick auf die Zeile — dasselbe Menü wie an einer Figur in der Welt.
await anna.click(`.freunde-zeile[data-name="${BORIS}"]`, { button: 'right' });
await anna.waitForTimeout(300);
check(
  await anna.evaluate(() => !(document.querySelector('.freunde-menu')?.hidden ?? true)),
  'ein Rechtsklick öffnet das Kontextmenü',
);
await anna.click('.freunde-menu-eintrag:has-text("Private Nachricht")');
await anna.waitForTimeout(400);
check(
  (await anna.inputValue('.chat-input')) === `/pm ${BORIS} `,
  'und „Private Nachricht" legt den Befehl in die Chatzeile',
  await anna.inputValue('.chat-input'),
);

// Und die Nachricht geht auch wirklich raus.
await anna.fill('.chat-input', `/pm ${BORIS} bis gleich`);
await anna.keyboard.press('Enter');
check(
  await waitUntil(
    async () =>
      (await boris.textContent('.chat-log'))?.includes('bis gleich') ?? false,
    8000,
  ),
  'die private Nachricht kommt bei Boris im Chat an',
);

// --- Das Menü an der Figur in der Welt --------------------------------------

/*
 * Der zweite Weg zu einer Anfrage: die Figur anklicken, statt den Namen zu
 * tippen. Beide starten auf demselben Punkt, Boris steht also in der
 * Bildmitte hinter Anna — genau dorthin geht der Klick.
 *
 * Das Menü zeigt „Als Freund hinzufügen" nur, wenn die Figur **nicht** schon
 * in der Liste steht. Hier steht sie drin, und genau das wird geprüft: der
 * Eintrag fehlt, „Private Nachricht" ist da. Ein Knopf, der jedes Mal
 * dieselbe Absage bringt, ist kein Angebot.
 */
console.log('\nDas Menü an der Figur');

await anna.mouse.click(450, 330);
await anna.waitForTimeout(500);
const menuOffen = await anna.evaluate(
  () => !(document.querySelector('.npc-menu')?.hidden ?? true),
);
check(menuOffen, 'ein Klick auf die fremde Figur öffnet das Menü');
const eintraege = await anna.evaluate(() =>
  [...document.querySelectorAll('.npc-menu .npc-menu-label')].map((e) => e.textContent),
);
check(
  eintraege.includes('Private Nachricht'),
  'es bietet „Private Nachricht" an',
  eintraege.join(', ') || '(nichts)',
);
check(
  !eintraege.includes('Als Freund hinzufügen'),
  'und keine Anfrage an jemanden, der schon in der Liste steht',
  eintraege.join(', ') || '(nichts)',
);
await anna.keyboard.press('Escape');
await anna.waitForTimeout(300);

// --- Entfernen --------------------------------------------------------------

console.log('\nEntfernen');

await anna.click(`.freunde-zeile[data-name="${BORIS}"]`);
await anna.waitForTimeout(200);
await anna.click('.window[data-window="freunde"] .freunde-knopf:has-text("Entfernen")');
check(
  await waitUntil(async () => (await zeilen(anna)).length === 0, 8000),
  'die Zeile verschwindet bei Anna',
  JSON.stringify(await zeilen(anna)),
);
check(
  await waitUntil(async () => (await zeilen(boris)).length === 0, 8000),
  'und bei Boris auch — beidseitig',
  JSON.stringify(await zeilen(boris)),
);

/*
 * Gegenprobe zum Menü an der Figur: **jetzt** steht sie nicht mehr in der
 * Liste, und jetzt bietet es die Anfrage an. Ohne diese Zeile wäre auch ein
 * Client grün, der den Eintrag nie zeigt.
 */
await anna.mouse.click(450, 330);
await anna.waitForTimeout(500);
const eintraegeDanach = await anna.evaluate(() =>
  [...document.querySelectorAll('.npc-menu .npc-menu-label')].map((e) => e.textContent),
);
check(
  eintraegeDanach.includes('Als Freund hinzufügen'),
  'und nach dem Entfernen bietet das Menü die Anfrage wieder an',
  eintraegeDanach.join(', ') || '(nichts)',
);
await anna.keyboard.press('Escape');

check(fehler.length === 0, `keine Fehler in der Konsole (${fehler.length})`);
for (const e of fehler.slice(0, 8)) console.log(`  ! ${e}`);

console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
