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

/**
 * Wartet auf ein frisch gezeichnetes Bild.
 *
 * `window.aurelithEditor` wird am Ende eines Bildes fortgeschrieben. In
 * SwiftShader laeuft die Schleife mit zwei Bildern je Sekunde — wer direkt nach
 * einer Eingabe liest, bekommt womoeglich noch den Stand von davor. Das hat
 * genau einmal zugeschlagen: mitten im Strich stand die Hoehe schon im Feld,
 * der Kern bekam sie aber erst am Strichende, und der Test las dazwischen.
 */
/**
 * Wartet, bis die Zielpruefung eines Tores durchgelaufen ist, und liefert ihr
 * Ergebnis.
 *
 * Direkt aus dem DOM und nicht aus `window.aurelithEditor`: die Auskunft dort
 * wird am Bildende fortgeschrieben, und bei zwei Bildern je Sekunde liest man
 * sonst den Stand von vorhin. Die Marke `data-checked` setzt der Editor erst,
 * wenn die Pruefung wirklich gelaufen ist — „keine Warnung" und „noch nicht
 * geprueft" sehen im DOM sonst gleich aus.
 */
async function gateWarning(page) {
  await page.waitForFunction(
    () => document.querySelector('#panel .warning[data-checked]') !== null,
    undefined,
    { timeout: 15000 },
  );
  return page.evaluate(() => {
    const el = document.querySelector('#panel .warning[data-checked]');
    return el && !el.hidden ? (el.textContent ?? '') : '';
  });
}

/** Wert eines beschrifteten Eingabefeldes im Bedienfeld. */
async function fieldValue(page, caption) {
  return page.evaluate(
    (c) =>
      [...document.querySelectorAll('#panel .field')].find(
        (f) => f.querySelector('span')?.textContent === c,
      )?.querySelector('input')?.value ?? null,
    caption,
  );
}

async function nextFrame(page) {
  const before = await page.evaluate(() => window.aurelithEditor?.frames ?? 0);
  await page.waitForFunction(
    (n) => (window.aurelithEditor?.frames ?? 0) > n + 1,
    before,
    { timeout: 15000 },
  );
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

// --- Gelände formen --------------------------------------------------------
//
// Die Prüfung, auf die es hier ankommt: was der Pinsel ändert, muss im **Kern**
// ankommen. Nur dann steht die Figur im Spiel auf demselben Boden, den man im
// Editor gesehen hat — der Kern ist dieselbe Binärdatei auf dem Server.

const toolButton = async (caption) => {
  const handle = await page.evaluateHandle((c) => {
    const all = [...document.querySelectorAll('#panel .palette button')];
    return all.find((b) => b.textContent === c) ?? null;
  }, caption);
  const el = handle.asElement();
  if (!el) throw new Error(`Werkzeug "${caption}" nicht gefunden`);
  return el;
};

await (await toolButton('Anheben')).click();
await page.waitForTimeout(300);

await page.mouse.move(560, 380);
await nextFrame(page);

// Die Zeigermarkierung: Punkte auf dem Gelaende, kein flacher Ring.
const cursor = await page.evaluate(() => ({
  points: window.aurelithEditor?.cursorPoints ?? 0,
  spread: window.aurelithEditor?.cursorHeightSpread ?? 0,
}));
check(cursor.points > 20, `Zeigermarkierung besteht aus Punkten (${cursor.points})`);

await mkdir(join(root, 'artefakte'), { recursive: true });
await page.screenshot({ path: join(root, 'artefakte', 'editor-pinsel.png') });

// Ausgangshoehe des gezeichneten Netzes unter dem Zeiger. Gemessen wird gleich
// die *Differenz* dazu — die absolute Hoehe sagt nichts, das Gelaende ist an
// dieser Stelle ohnehin nicht null.
const meshBefore = await page.evaluate(
  () => window.aurelithEditor?.meshPeakNearPointer?.() ?? 0,
);

await page.mouse.down();

// Waehrend des Haltens messen — nicht erst danach. Vorher wurde das Netz erst
// beim Loslassen neu gebaut, und man formte blind.
await nextFrame(page);
await nextFrame(page);
// Die hoechste Stelle im tatsaechlich gezeichneten Netz — nicht im Feld. Nur so
// zeigt sich, ob das Bild dem Pinsel folgt.
const midStroke = await page.evaluate(() => ({
  peak: window.aurelithEditor?.sculptPeak ?? 0,
  meshHeight: window.aurelithEditor?.meshPeakNearPointer?.() ?? 0,
}));
const midStrokeRise = midStroke.meshHeight - meshBefore;

await page.waitForTimeout(700);
await page.mouse.up();
await nextFrame(page);

const sculptState = await page.evaluate(() => ({
  resolution: window.aurelithEditor?.sculptResolution ?? 0,
  peak: window.aurelithEditor?.sculptPeak ?? 0,
  coreResolution: window.aurelithEditor?.coreSculptResolution ?? 0,
}));

check(sculptState.resolution >= 2, `Höhenfeld angelegt (${sculptState.resolution} Stützpunkte je Kante)`);
// Schwelle bewusst niedrig. Der Pinsel wirkt zeitbasiert, und in SwiftShader
// laeuft die Schleife mit zwei Bildern je Sekunde — wie viele davon in die
// gehaltenen 900 ms fallen, schwankt zwischen eins und drei. Garantiert ist
// allein der Anschlag beim Druecken: 8 m/s * 50 ms = 0,4 m. Dass sich der
// Pinsel ueber die Zeit aufsummiert, pruefen die Einzeltests in
// packages/editor/test/brushes_test.ts, und zwar ohne Bildrate im Spiel.
check(sculptState.peak > 0.3, `Gelände wurde angehoben (${sculptState.peak.toFixed(2)} m)`);
check(
  midStrokeRise > 0.2,
  `das Netz folgt schon waehrend des Ziehens (${meshBefore.toFixed(2)} → ${midStroke.meshHeight.toFixed(2)} m, also +${midStrokeRise.toFixed(2)})`,
);
check(
  midStroke.peak > 0.2,
  `und das Feld ebenso (${midStroke.peak.toFixed(2)} m)`,
);
check(
  sculptState.coreResolution === sculptState.resolution,
  `der Kern hat dasselbe Feld (${sculptState.coreResolution})`,
);
// --- Malen -----------------------------------------------------------------

await (await toolButton('Malen')).click();
await page.waitForTimeout(300);

await page.mouse.move(600, 400);
await page.mouse.down();
await page.waitForTimeout(700);
await page.mouse.up();
await nextFrame(page);

// Die Punkte muessen der Gelaendeform folgen — genau das kann ein flacher Ring
// nicht. Nach dem Anheben ist unter dem Zeiger ein Huegel, also muss sich die
// Hoehenspanne der Punkte deutlich von null unterscheiden.
const cursorOnHill = await page.evaluate(() => ({
  points: window.aurelithEditor?.cursorPoints ?? 0,
  spread: window.aurelithEditor?.cursorHeightSpread ?? 0,
}));
check(
  cursorOnHill.spread > 0.2,
  `die Punkte folgen dem Gelaende (${cursorOnHill.spread.toFixed(2)} m Hoehenunterschied ueber ${cursorOnHill.points} Punkte)`,
);

const paintState = await page.evaluate(() => ({
  resolution: window.aurelithEditor?.paintResolution ?? 0,
  peak: window.aurelithEditor?.paintPeak ?? 0,
}));
check(paintState.resolution >= 2, `Malfeld angelegt (${paintState.resolution})`);
check(paintState.peak > 0, `Bodenebene wurde gemalt (Gewicht ${paintState.peak})`);

// --- Tore setzen -----------------------------------------------------------
//
// Das ging vorher gar nicht: der Editor konnte ausschliesslich Props, und ein
// Tor war eine unsichtbare Zone, die nur `gen-maps.mjs` schreiben konnte.

await (await toolButton('Tore')).click();
await page.waitForTimeout(300);

const gatesBefore = await page.evaluate(() => window.aurelithEditor?.portals ?? 0);

await page.mouse.move(540, 420);
await page.waitForTimeout(200);
await page.mouse.down();
await page.mouse.up();
await nextFrame(page);

const afterGate = await page.evaluate(() => ({
  portals: window.aurelithEditor?.portals ?? 0,
  selected: window.aurelithEditor?.selectedGate ?? '',
}));
check(afterGate.portals === gatesBefore + 1, `Tor gesetzt (${gatesBefore} → ${afterGate.portals})`);
check(afterGate.selected !== '', `neues Tor ist ausgewaehlt (${afterGate.selected})`);

// Das Bedienfeld muss die Felder des Tores zeigen.
const fields = await page.evaluate(() =>
  [...document.querySelectorAll('#panel .field span')].map((n) => n.textContent),
);
for (const wanted of ['X', 'Z', 'Karte', 'Ziel-X', 'Ziel-Z', 'Mindeststufe']) {
  check(fields.includes(wanted), `Feld „${wanted}" im Bedienfeld`);
}

// Das Ziel auf eine andere Karte stellen — der Parameter, um den es geht.
await page.selectOption('#panel select:not(:first-of-type)', 'dornwald').catch(async () => {
  // Die Kartenauswahl ganz oben ist das erste select; das Ziel ist das zweite.
  const selects = await page.$$('#panel select');
  await selects[selects.length - 1].selectOption('dornwald');
});
// Warten, bis der Zielpunkt auf Dornwalds Startpunkt (0, -178) umgesprungen ist
// — daran erkennt man, dass die Zielkarte geholt und das Feld neu gezeichnet
// wurde. Erst danach ist die Warnung, die dort steht, die zum neuen Ziel.
await page.waitForFunction(
  () =>
    [...document.querySelectorAll('#panel .field')].find(
      (f) => f.querySelector('span')?.textContent === 'Ziel-Z',
    )?.querySelector('input')?.value === '-178',
  undefined,
  { timeout: 15000 },
);

const retargetWarning = await gateWarning(page);
const portalsNow = await page.evaluate(() => window.aurelithEditor?.portals ?? 0);
check(portalsNow === afterGate.portals, 'Zielwechsel legt kein zweites Tor an');
check(
  (await fieldValue(page, 'Ziel-X')) === '0',
  `Zielpunkt springt auf den Startpunkt der Zielkarte (${await fieldValue(page, 'Ziel-X')}, -178)`,
);
check(retargetWarning === '', `und ist dort unbedenklich ("${retargetWarning}")`);

// Und jetzt absichtlich auf ein Tor der Zielkarte zielen: das muss auffallen.
await page.evaluate(() => {
  const inputs = [...document.querySelectorAll('#panel .field input')];
  const byLabel = (name) =>
    inputs.find((i) => i.parentElement?.querySelector('span')?.textContent === name);
  const setValue = (name, value) => {
    const el = byLabel(name);
    el.value = String(value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // Das Rueckportal von Dornwald steht auf (0, -186).
  setValue('Ziel-X', 0);
  setValue('Ziel-Z', -186);
});
const warned = await gateWarning(page);
check(
  warned.includes('Tor') && warned.includes('weitergereicht'),
  `Zielpunkt in einem Tor wird gemeldet ("${warned.slice(0, 70)}…")`,
);

// --- Das Ergebnis muss wieder lesbar sein ----------------------------------

const roundTrip = await page.evaluate(() => window.aurelithEditor?.roundTrip?.() ?? null);
check(roundTrip?.ok === true, `Dokument bleibt lesbar (${roundTrip?.note ?? 'kein Ergebnis'})`);
check(
  roundTrip?.sculptSurvives === true,
  `geformte Höhen überleben Speichern und Laden (${roundTrip?.peakAfter?.toFixed?.(2) ?? '?'} m)`,
);
check(
  Math.abs((roundTrip?.peakAfter ?? 0) - sculptState.peak) < 0.02,
  `und zwar unveraendert (${sculptState.peak.toFixed(2)} → ${(roundTrip?.peakAfter ?? 0).toFixed(2)} m)`,
);
check(
  roundTrip?.portalsAfter === afterGate.portals,
  `das gesetzte Tor ueberlebt Speichern und Laden (${roundTrip?.portalsAfter} Tore)`,
);
check(
  roundTrip?.targetAfter === 'dornwald',
  `mit seinem Ziel (${roundTrip?.targetAfter})`,
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
