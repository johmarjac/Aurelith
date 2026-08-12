#!/usr/bin/env node
/**
 * Rauchtest: NPC anklicken, Auftrag annehmen, Questlog öffnen.
 *
 * Das Protokoll dahinter prüft `packages/server/test/npcflow_test.ts` — dort
 * ohne Browser und bis zur Abgabe. Hier geht es um das, was der Test dort
 * nicht sehen kann: dass ein Klick auf eine Figur im Bild beim richtigen NPC
 * ankommt, dass das Fenster aufgeht und dass der Knopf darin etwas bewirkt.
 *
 *   node tools/smoke-npc.mjs
 *
 * Der Server startet mit `AURELITH_START_POS` direkt neben Aurel. Sonst
 * bestünde der halbe Test aus Hinlaufen.
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
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

console.log('Aurelith — NPCs, Aufträge, Handel\n');

const server = launch('npx tsx packages/server/src/index.ts', {
  AURELITH_PORT: '8792',
  // Zwei Einheiten neben Aurel, der auf (7, 9) steht.
  AURELITH_START_POS: '7,11',
  DATABASE_URL: '',
});
// `AURELITH_SERVER` sagt Vite, wohin es `/ws` durchreicht — sonst zeigte der
// Proxy auf den Standardport, auf dem hier nichts läuft.
launch('cd packages/client && npx vite --port 5196 --strictPort --host 127.0.0.1', {
  AURELITH_SERVER: 'ws://127.0.0.1:8792',
});

if (!(await waitUntil(async () => server.log.join('').includes('bereit'), 60000))) {
  console.error(server.log.join(''));
  throw new Error('Spielserver kam nicht hoch');
}
if (
  !(await waitUntil(async () => {
    try {
      return (await fetch('http://127.0.0.1:5196/')).ok;
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

const name = `Npc${Date.now() % 100000}`;
await page.goto(`http://127.0.0.1:5196/?name=${name}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.aurelith?.localId > 0, { timeout: 40000 });
await page.waitForTimeout(2500);

console.log('Prüfungen');

// --- Der NPC steht da und trägt ein Auftragszeichen ------------------------

const aurel = page.locator('.nameplate', { hasText: 'Aurel' }).first();
check(await aurel.isVisible(), 'Aurels Namensschild ist zu sehen');

const zeichen = await aurel.locator('.np-mark').textContent();
check(zeichen === '!', 'über ihm steht ein Ausrufezeichen', zeichen ?? '(leer)');

// --- Anklicken öffnet das Gespräch ----------------------------------------

const kasten = await aurel.boundingBox();
if (!kasten) throw new Error('Namensschild ohne Ausdehnung');
// Das Schild hängt über dem Kopf; getroffen werden soll der Körper. Fünfzig
// Bildpunkte tiefer liegt er sicher innerhalb des Aufgreifradius.
await page.mouse.click(kasten.x + kasten.width / 2, kasten.y + kasten.height + 50);

const dialog = page.locator('[data-window="dialog"]');
check(
  await waitUntil(async () => (await dialog.getAttribute('data-open')) === 'true', 8000),
  'das Gesprächsfenster geht auf',
);
check((await dialog.textContent())?.includes('Aurel') ?? false, 'und zeigt Aurel');
check(
  (await dialog.textContent())?.includes('Licht im Moor') ?? false,
  'mitsamt dem angebotenen Auftrag',
);

// --- Annehmen landet im Questlog ------------------------------------------

await dialog.getByRole('button', { name: 'Annehmen' }).click();

const questlog = page.locator('[data-window="quests"]');
check(
  await waitUntil(async () => (await questlog.textContent())?.includes('Licht im Moor') ?? false, 8000),
  'der Auftrag steht im Questlog',
);
check(
  (await questlog.textContent())?.includes('0 / 5') ?? false,
  'mit Fortschritt null von fünf',
  (await questlog.textContent())?.match(/\d+ \/ \d+/)?.[0] ?? 'nichts gefunden',
);

// Das Fenster selbst muss sich sofort ändern. Vorher stand der Knopf, den man
// eben gedrückt hatte, unverändert weiter da — es sah aus, als sei nichts
// passiert, und erst Schliessen und neu Ansprechen zeigte den neuen Stand.
check(
  await waitUntil(
    async () => ((await dialog.textContent()) ?? '').includes('Die Wiese ist gleich'),
    5000,
  ),
  'das Gespräch zeigt danach den Fortschrittstext',
);
check(
  (await dialog.getByRole('button', { name: 'Annehmen' }).count()) === 0,
  'und den Annehmen-Knopf nicht mehr',
);
check((await dialog.getAttribute('data-open')) === 'true', 'das Fenster bleibt dabei offen');

// Das Zeichen über Aurel wechselt von „hier gibt es etwas" zu „läuft noch".
check(
  await waitUntil(async () => (await aurel.locator('.np-mark').textContent()) === '?', 5000),
  'das Zeichen über Aurel wechselt',
);

// --- Der Laden -------------------------------------------------------------
//
// Iselda steht zwanzig Einheiten weiter; statt hinzulaufen wird geprüft, dass
// Aurel keinen Ladenknopf hat. Das Handeln selbst prüft der Protokolltest.
check(
  !((await dialog.textContent())?.includes('Waren ansehen') ?? true),
  'Aurel bietet keinen Laden an',
);

// --- Gegenstände: Name und Beschreibung auf Tippen -------------------------
//
// Das ist der Teil, der auf dem Telefon fehlte: die Beschreibung hing am
// `title`-Attribut, und das zeigt ohne Maus niemand an. Geprüft wird deshalb
// mit einem einfachen Klick — genau das, was ein Finger auslöst.

await page.keyboard.press('KeyI');
const inventar = page.locator('[data-window="inventory"]');
check(
  await waitUntil(async () => (await inventar.getAttribute('data-open')) === 'true', 5000),
  'das Inventar geht auf',
);

const belegte = inventar.locator('.item-slot:not(.item-empty)');
check((await belegte.count()) >= 3, 'es liegen Gegenstände darin', String(await belegte.count()));

// Die Kacheln zeigen gerenderte Symbole, keine Farbflächen mehr. Geprüft wird
// nicht nur, dass ein `<img>` dasteht, sondern dass auch etwas darin ankam —
// ein falscher Pfad ergäbe sonst ein leeres, aber vorhandenes Element.
const bilder = await page.evaluate(() =>
  [...document.querySelectorAll('.item-icon-bild')].map((n) => ({
    src: n.getAttribute('src') ?? '',
    breite: n.naturalWidth,
  })),
);
check(bilder.length >= 3, 'die Kacheln tragen Symbolbilder', `${bilder.length} Bilder`);
check(
  bilder.every((b) => b.breite > 0),
  'und alle sind geladen',
  bilder.find((b) => b.breite === 0)?.src ?? 'alle',
);

// --- Die Figur im Inventar -------------------------------------------------
//
// Gemessen statt angesehen. Der erste Aufbau bestand jede Prüfung und war im
// Bild trotzdem kaputt: das Raster war breiter als das Fenster, und die rechte
// Reihe Plätze stand ausserhalb. Ein Rauchtest, der nur „geht auf" prüft,
// findet so etwas nie.

const puppe = await page.evaluate(() => {
  const fenster = document.querySelector('[data-window="inventory"]');
  const leinwand = document.querySelector('.doll-canvas');
  const raster = document.querySelector('.doll');
  if (!fenster || !leinwand || !raster) return undefined;
  const f = fenster.getBoundingClientRect();
  const l = leinwand.getBoundingClientRect();
  const r = raster.getBoundingClientRect();
  return {
    leinwand: { breite: Math.round(l.width), hoehe: Math.round(l.height) },
    // Wie weit das Raster über den Fensterrand hinausragt — **beide** Achsen.
    // Beim ersten Anlauf stand hier nur links/rechts, und genau deshalb ging
    // die Prüfung durch, während die Figur senkrecht aus dem Bild gescrollt
    // war. Eine halbe Messung ist keine.
    ueberstand: Math.round(
      Math.max(0, r.right - f.right) +
        Math.max(0, f.left - r.left) +
        Math.max(0, r.bottom - f.bottom) +
        Math.max(0, f.top - r.top),
    ),
    plaetze: document.querySelectorAll('.equip-slot').length,
    // Höhe des Puppenbereichs gegen die Höhe seines Inhalts. Ein
    // geschrumpftes Flex-Element meldet ein sauberes, aber zu kleines
    // Rechteck — der Inhalt läuft darüber hinaus und wird abgeschnitten,
    // ohne dass irgendein Rand überschritten wäre.
    gequetscht: (() => {
      const d = document.querySelector('.doll');
      const c = document.querySelector('.doll-canvas');
      const l = document.querySelector('.doll-slots.links');
      if (!d || !c || !l) return -1;
      const noetig = Math.max(c.getBoundingClientRect().height, l.scrollHeight);
      return Math.round(noetig - d.getBoundingClientRect().height);
    })(),
    // Scrollt der Körper? Ein gescrollter Körper schiebt die Figur aus dem
    // Bild, ohne dass irgendeine Breite oder Höhe falsch wäre.
    scroll: (() => {
      const b = document.querySelector('[data-window="inventory"] .window-body');
      return b ? `${b.scrollTop}/${b.scrollHeight}@${b.clientHeight}` : '—';
    })(),
    sichtbar: [...document.querySelectorAll('.equip-slot')].filter((n) => {
      const b = n.getBoundingClientRect();
      return (
        b.width > 0 &&
        b.height > 0 &&
        b.right <= f.right + 1 &&
        b.left >= f.left - 1 &&
        b.bottom <= f.bottom + 1 &&
        b.top >= f.top - 1
      );
    }).length,
  };
});

// Die gemessene Geometrie steht im Protokoll. Zwei Anläufe lang habe ich aus
// dem Bildschirmfoto auf die Ursache geschlossen und zweimal daneben gelegen;
// die Zahlen daneben hätten beide Male sofort gezeigt, was los ist.
console.log(`  · Puppe: ${JSON.stringify(puppe)}`);

check(puppe !== undefined, 'die Figur samt Plätzen steht im Inventar');
check(
  (puppe?.leinwand.breite ?? 0) > 40 && (puppe?.leinwand.hoehe ?? 0) > 80,
  'die Leinwand hat eine brauchbare Größe',
  puppe ? `${puppe.leinwand.breite}×${puppe.leinwand.hoehe} px` : '—',
);
check(puppe?.plaetze === 10, 'zehn Ausrüstungsplätze', String(puppe?.plaetze));
check(
  puppe?.sichtbar === puppe?.plaetze,
  'und alle liegen im Fenster',
  `${puppe?.sichtbar} von ${puppe?.plaetze}`,
);
check((puppe?.ueberstand ?? 99) === 0, 'nichts ragt über den Rand', `${puppe?.ueberstand} px`);
check(
  (puppe?.gequetscht ?? 99) <= 0,
  'der Puppenbereich ist nicht zusammengequetscht',
  `${puppe?.gequetscht} px zu wenig`,
);

// Und zuletzt: zeichnet die Figur überhaupt?
//
// Über den lesenden Blick und nicht über die Bildpunkte der Leinwand. Ein
// Versuch mit `readPixels` stand hier und wurde wieder entfernt: three.js
// erhält den Zeichenpuffer nicht (`preserveDrawingBuffer` ist aus), also kam
// dort verlässlich eine leere Fläche zurück — der Test hätte behauptet, die
// Figur fehle, während sie danebenstand. Eine Prüfung, die nicht misst, was
// sie behauptet, ist schlimmer als keine.
const puppenzustand = await page.evaluate(() => window.aurelith.doll);
console.log(`  · Puppenzustand: ${JSON.stringify(puppenzustand)}`);

check(puppenzustand.rig, 'die Figur hat ein Modell');
check(
  puppenzustand.bilder > 0,
  'und zeichnet tatsächlich',
  `${puppenzustand.bilder} Bilder`,
);
check(
  puppenzustand.breite === 256 && puppenzustand.hoehe === 340,
  'auf einem Puffer fester Größe',
  `${puppenzustand.breite}×${puppenzustand.hoehe}`,
);

const detail = page.locator('.item-detail');
await belegte.first().click();
check(
  await waitUntil(async () => await detail.isVisible(), 3000),
  'ein Klick zeigt die Beschreibung',
);
// Die Sprechblase muss neben der angeklickten Kachel stehen und ganz im Bild
// liegen — sonst nützt sie am rechten Rand nichts, und genau dort steht das
// Inventar.
const blase = await page.evaluate(() => {
  const t = document.querySelector('.item-detail');
  const k = document.querySelector('.item-slot:not(.item-empty)');
  if (!t || !k) return undefined;
  const a = t.getBoundingClientRect();
  const b = k.getBoundingClientRect();
  return {
    abstand: Math.round(Math.min(Math.abs(a.left - b.right), Math.abs(b.left - a.right))),
    imBild:
      a.left >= 0 && a.top >= 0 && a.right <= window.innerWidth && a.bottom <= window.innerHeight,
    breite: Math.round(a.width),
  };
});
console.log(`  · Sprechblase: ${JSON.stringify(blase)}`);
check(blase?.imBild === true, 'die Sprechblase liegt ganz im Bild');
check((blase?.abstand ?? 999) < 40, 'und klebt an der angeklickten Kachel', `${blase?.abstand} px`);

const detailText = (await detail.textContent()) ?? '';
check(detailText.includes('Holzschwert'), 'mit dem Namen des Gegenstands', detailText.slice(0, 40));
check(detailText.includes('Waffe'), 'und seiner Art');
check(/Angriff \d/.test(detailText), 'samt Werten', detailText.match(/Angriff \d+/)?.[0] ?? '—');

// Nochmal auf dieselbe Kachel klappt wieder zu — anders käme man auf einem
// Telefon nicht heraus.
await belegte.first().click();
check(!(await detail.isVisible()), 'ein zweiter Klick klappt sie zu');

// Anlegen über den Knopf: der Doppelklick ist auf Touch unzuverlässig, und
// vorher war er der einzige Weg.
const bogen = inventar.locator('.item-slot', { hasText: '' }).nth(1);
await bogen.click();
const anlegen = detail.getByRole('button', { name: 'Anlegen' });
if (await anlegen.count()) {
  await anlegen.click();
  check(
    await waitUntil(
      async () => ((await page.locator('.chat-log').textContent()) ?? '').includes('angelegt'),
      5000,
    ),
    'der Knopf legt den Gegenstand an',
  );
}

await page.screenshot({ path: join(root, 'artefakte', 'inventar.png') });

// --- Die Uhr ---------------------------------------------------------------

const uhr = await page.locator('.vitals-clock').textContent();
check(/^[☀🌙] \d{2}:\d{2}$/u.test(uhr ?? ''), 'die Weltuhr läuft', uhr ?? '(leer)');

check(fehler.length === 0, 'keine unbehandelten Ausnahmen', String(fehler.length));
if (fehler.length > 0) console.error(fehler.join('\n'));

await browser.close();
shutdown();

console.log(failures === 0 ? '\nAlle Prüfungen bestanden.\n' : `\n${failures} Prüfung(en) fehlgeschlagen.\n`);
process.exit(failures === 0 ? 0 : 1);
