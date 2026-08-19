#!/usr/bin/env node
/**
 * End-to-End-Rauchtest.
 *
 * Startet Server und Client, öffnet die Seite in Chromium und prüft, was ohne
 * echten Browser nicht zu prüfen ist: dass der wasm-Kern lädt, die Verbindung
 * steht, Snapshots ankommen und tatsächlich etwas gezeichnet wird.
 *
 * Ein Typecheck sagt nichts darüber, ob ein Bild entsteht.
 *
 *   node tools/smoke-e2e.mjs [--headed] [--keep]
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { anmeldenBestehend, anmeldenUndBetreten } from './lib/spielstart.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = join(root, 'artefakte');
const args = new Set(process.argv.slice(2));

const procs = [];

/**
 * Startet einen Hilfsprozess in eigener Prozessgruppe.
 *
 * Das `detached` ist kein Detail: der Befehl laeuft ueber eine Shell, und ein
 * Signal an die Shell laesst das eigentliche Node dahinter am Leben. Beim
 * naechsten Lauf blockiert dann der Port, und die Ursache steht nirgends.
 */
function launch(name, command, extraEnv = {}) {
  const child = spawn('bash', ['-lc', command], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const entry = { name, child, log };
  procs.push(entry);
  return entry;
}

function shutdown() {
  for (const { child } of procs) {
    try {
      // Negative Kennung heisst: die ganze Gruppe, also auch die Kindprozesse
      // der Shell.
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Schon beendet.
    }
  }
}

async function waitFor(check, timeoutMs, what, source) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  // Ohne die Ausgabe des Prozesses ist eine Zeitüberschreitung nicht zu deuten.
  if (source) console.error(`\nAusgabe von ${source.name}:\n${source.log.join('')}`);
  throw new Error(`Zeitüberschreitung beim Warten auf ${what}`);
}

let failures = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}`);
  if (!ok) failures++;
};

process.on('exit', shutdown);
process.on('SIGINT', () => {
  shutdown();
  process.exit(130);
});

console.log('Aurelith — End-to-End-Rauchtest\n');

const server = launch('server', 'npx tsx packages/server/src/index.ts');
const client = launch(
  'client',
  'cd packages/client && npx vite --port 5199 --strictPort --host 127.0.0.1',
);

await waitFor(
  async () => server.log.join('').includes('bereit'),
  40000,
  'den Spielserver',
  server,
);
console.log('→ Server läuft');

await waitFor(
  async () => {
    try {
      const res = await fetch('http://127.0.0.1:5199/');
      return res.ok;
    } catch {
      return false;
    }
  },
  60000,
  'den Client-Server',
  client,
);
console.log('→ Client-Server läuft\n');

/**
 * Die vorinstallierte Chromium-Ausgabe kann von der abweichen, die dieses
 * Playwright erwartet. Ist eine da, nehmen wir sie — herunterladen wollen wir
 * für einen Rauchtest nichts.
 */
function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    ...['1194', '1200', '1210', '1234'].flatMap((v) => [
      `/opt/pw-browsers/chromium-${v}/chrome-linux/chrome`,
      `/opt/pw-browsers/chromium_headless_shell-${v}/chrome-linux/headless_shell`,
    ]),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

const executablePath = findChromium();
const browser = await chromium.launch({
  headless: !args.has('--headed'),
  ...(executablePath ? { executablePath } : {}),
  args: [
    // SwiftShader liefert WebGL 2 ohne GPU — anders wäre der Test hier blind.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    // Chromium friert Seiten im Hintergrund ein und drosselt dort
    // requestAnimationFrame. Die Spielschleife laeuft darauf — ohne diese
    // Flaggen misst der Test an einer stehenden Simulation und meldet
    // sporadisch Bewegungen von null.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const consoleLines = [];
const pageErrors = [];
page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => pageErrors.push(String(err)));

const spielerName = `Rauch${Date.now() % 100000}`;
await page.goto('http://127.0.0.1:5199/', { waitUntil: 'domcontentloaded' });

// --- Die Maske bleibt stehen, während man tippt ----------------------------
//
// Die Verbindungsanzeige meldet mit jedem Pong wieder „verbunden", also im
// Sekundentakt. Baute sich die Maske daraufhin neu auf, sprang der Fokus aus
// dem Passwortfeld zurück ins Namensfeld — nach ein, zwei Sekunden, mitten
// im Tippen. Drei Sekunden Stillstand sind der Nachweis, dass sie das nicht
// mehr tut.
await page.waitForSelector('.lobby:not([hidden]) .lobby-input', { timeout: 40000 });
await page.click('.lobby-form .lobby-input[type="password"]');
await page.keyboard.type('geheim');
await page.waitForTimeout(3000);
const beimTippen = await page.evaluate(() => ({
  feld: document.activeElement?.getAttribute('type') ?? '(keins)',
  wert: document.querySelector('.lobby-form .lobby-input[type="password"]')?.value ?? '',
}));
check(beimTippen.feld === 'password', `Fokus bleibt im Passwortfeld (${beimTippen.feld})`);
check(beimTippen.wert === 'geheim', `und das Getippte auch (${beimTippen.wert})`);

await anmeldenUndBetreten(page, spielerName);

// Der Statusanzeiger ist die ehrlichste Auskunft darüber, wie weit der Client
// gekommen ist — er hängt am tatsächlichen WebSocket-Zustand.
try {
  await page.waitForFunction(
    () => document.querySelector('.status')?.getAttribute('data-state') === 'verbunden',
    { timeout: 30000 },
  );
} catch (err) {
  // Ohne die Browser-Konsole ist eine Zeitueberschreitung hier nicht zu deuten.
  console.error('\nBrowser-Konsole:');
  for (const line of consoleLines) console.error(`  ${line}`);
  for (const line of pageErrors) console.error(`  ! ${line}`);
  console.error(`\nStatus: ${await page.evaluate(() => document.querySelector('.status')?.textContent ?? '(fehlt)')}`);
  shutdown();
  throw err;
}
console.log('Prüfungen');
check(true, 'Verbindung zum Server steht');

// Ein paar Sekunden laufen lassen, damit Snapshots, Terrain und Props ankommen.
await page.waitForTimeout(4000);

const state = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  const gl = canvas?.getContext('webgl2');
  return {
    webgl2: Boolean(gl),
    canvasWidth: canvas?.width ?? 0,
    nameplates: document.querySelectorAll('.nameplate').length,
    chatLines: document.querySelectorAll('.chat-line').length,
    chatText: [...document.querySelectorAll('.chat-line')].map((n) => n.textContent).join(' | '),
    hpLabel: document.querySelector('.bar.hp .bar-label')?.textContent ?? '',
    level: document.querySelector('.vitals-level')?.textContent ?? '',
    inventoryFilled: document.querySelectorAll('.item-slot:not(.item-empty)').length,
    equipFilled: document.querySelectorAll('.equip-slot[data-filled="true"]').length,
    status: document.querySelector('.status')?.textContent ?? '',
  };
});

check(state.webgl2, 'WebGL 2 ist aktiv');
check(state.canvasWidth > 0, `Leinwand hat Größe (${state.canvasWidth} px)`);
check(/\d+ \/ \d+/.test(state.hpLabel), `Lebensanzeige gefüllt (${state.hpLabel})`);
// Im Medaillon steht die Zahl allein — das Wort „Stufe" trägt der Tooltip.
// Vorher stand hier `includes('Stufe')`, und das prüfte die Beschriftung
// statt der Auskunft.
check(/^\d+$/.test(state.level.trim()), `Stufe angezeigt (${state.level})`);
/*
 * Die Startausrüstung — im Beutel **und** am Körper.
 *
 * Beides zusammen, weil sie an beiden Orten liegt: Schwert und Weste sind
 * angelegt und nehmen deshalb keine Kachel im Raster weg. Ein Blick allein
 * auf den Beutel zählte nur die Tränke und hielte eine leere Ausrüstung für
 * in Ordnung.
 */
check(
  state.inventoryFilled >= 1,
  `Startausrüstung im Beutel (${state.inventoryFilled} Kacheln)`,
);
check(
  state.equipFilled >= 2,
  `und am Körper (${state.equipFilled} Plätze belegt)`,
);
check(state.chatLines > 0, `Systemnachricht angekommen (${state.chatLines})`);
check(state.nameplates > 0, `Namensschilder gezeichnet (${state.nameplates})`);

// --- Die Leinwand muss erreichbar sein ------------------------------------
//
// Die Oberflaechenebene liegt bildschirmfuellend ueber der Leinwand. Faengt sie
// Zeigerereignisse ab, sind Kameradrehung, Zoom und Zielauswahl tot — und man
// sieht davon nichts, weil die Ebene durchsichtig ist.

const topElement = await page.evaluate(() => {
  const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  return el ? el.tagName.toLowerCase() + (el.className ? `.${el.className}` : '') : '(nichts)';
});
check(topElement.startsWith('canvas'), `Leinwand nimmt Zeiger entgegen (${topElement})`);

// --- Kamera: drehen und zoomen --------------------------------------------

const camBefore = await page.evaluate(() => ({ ...window.aurelith.camera }));

// Rechte Maustaste gedrueckt halten und ziehen.
await page.mouse.move(640, 360);
await page.mouse.down({ button: 'right' });
await page.mouse.move(820, 300, { steps: 12 });
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(200);

const camAfterOrbit = await page.evaluate(() => ({ ...window.aurelith.camera }));
check(
  Math.abs(camAfterOrbit.yaw - camBefore.yaw) > 0.2,
  `rechte Maustaste dreht die Kamera (yaw ${camBefore.yaw.toFixed(2)} → ${camAfterOrbit.yaw.toFixed(2)})`,
);
check(
  Math.abs(camAfterOrbit.pitch - camBefore.pitch) > 0.05,
  `Ziehen neigt die Kamera (pitch ${camBefore.pitch.toFixed(2)} → ${camAfterOrbit.pitch.toFixed(2)})`,
);

/*
 * Das Namensschild darf beim Schwenken nicht hinterherhinken.
 *
 * `project()` liest die Matrizen der Kamera, und three.js schreibt sie erst
 * beim Zeichnen fort. Wer die Kamera bewegt und noch vor dem Zeichnen
 * projiziert, rechnet mit dem Stand des letzten Bildes — beim Laufen ein
 * unsichtbarer Bruchteil eines Bildpunkts, beim Schwenken ein Zittern.
 *
 * Gemessen wird genau dieser eine Rückstand: Wo steht das Schild ein Bild nach
 * der letzten Mausbewegung, und wo steht es, wenn die Kamera zur Ruhe gekommen
 * ist? Die Kameralage ist dieselbe — Neigung und Drehung ändern sich ohne
 * Nachziehen —, also müssen beide Zahlen gleich sein. Hinkt die Projektion ein
 * Bild hinterher, unterscheiden sie sich um genau einen Schritt des Zuges.
 */
/*
 * Gemessen wird **in der Seite**, Bild für Bild.
 *
 * Von aussen geht es nicht: jede Abfrage über die Fernsteuerung dauert ein
 * paar Millisekunden, in denen der Browser weiterzeichnet — bis die Antwort
 * ankommt, hat ein Rückstand von einem Bild sich längst aufgeholt. Also
 * schreibt eine eigene Bildschleife Neigung und Schildposition mit; sie wird
 * nach der des Spiels angemeldet und läuft deshalb auch nach ihr.
 *
 * Ausgewertet wird danach in Ruhe: Beim **ersten** Bild, in dem die Neigung
 * ihren Endwert hat, muss das Schild schon dort stehen, wo es am Ende steht.
 * Rechnet die Projektion mit dem vorigen Bild, steht es dort noch einen
 * Zugschritt daneben.
 */
await page.evaluate(() => {
  window.__schild = [];
  window.__schildLaeuft = true;
  const tick = () => {
    const el = document.querySelector('.nameplate');
    if (el && el.style.display !== 'none') {
      window.__schild.push([window.aurelith.camera.pitch, el.getBoundingClientRect().top]);
    }
    if (window.__schildLaeuft) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

await page.mouse.move(640, 360);
await page.mouse.down({ button: 'right' });
// In Schritten und mit Pausen: jeder Schritt soll ein eigenes Bild bekommen,
// sonst fasst der Browser sie zusammen und es gibt gar keine Bewegung je Bild.
for (let i = 1; i <= 10; i++) {
  await page.mouse.move(640, 360 + i * 12);
  await page.waitForTimeout(50);
}
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(600);

const schildLauf = await page.evaluate(() => {
  window.__schildLaeuft = false;
  return window.__schild;
});

const letzte = schildLauf[schildLauf.length - 1];
const endNeigung = letzte?.[0] ?? 0;
const endY = letzte?.[1] ?? 0;
// Das erste Bild mit der endgültigen Neigung. Ab da bewegt sich die Kamera
// nicht mehr — was das Schild danach noch tut, ist Rückstand.
const ersteRuhe = schildLauf.find(([p]) => Math.abs(p - endNeigung) < 1e-9);
const rueckstand = Math.abs((ersteRuhe?.[1] ?? endY) - endY);
const geschwenkt = Math.abs((schildLauf[0]?.[0] ?? 0) - endNeigung);

check(
  schildLauf.length > 10 && geschwenkt > 0.3,
  `beim Schwenken gemessen (${schildLauf.length} Bilder, Neigung um ${geschwenkt.toFixed(2)})`,
);
check(
  rueckstand < 4,
  `das Namensschild klebt am Kopf statt zu zittern (${rueckstand.toFixed(1)} px Rückstand)`,
);

await page.mouse.move(640, 360);
await page.mouse.wheel(0, 600);
await page.waitForTimeout(200);
const camAfterZoom = await page.evaluate(() => ({ ...window.aurelith.camera }));
check(
  camAfterZoom.distance > camAfterOrbit.distance + 0.5,
  `Mausrad zoomt (${camAfterOrbit.distance.toFixed(1)} → ${camAfterZoom.distance.toFixed(1)})`,
);

// --- Bewegungsrichtung ----------------------------------------------------
//
// Die Kamera blickt entlang (sin yaw, cos yaw), bildschirmrechts ist damit
// (-cos yaw, sin yaw). Gedrueckte D-Taste muss die Figur also entlang genau
// dieser Richtung schieben — und nicht entgegengesetzt, wie es vorher war.

/**
 * Wartet, bis die Simulation eine Anzahl Schritte weiter ist.
 *
 * Nicht Wanduhrzeit, sondern Simulationsschritte. Die Schleife holt zwar auf,
 * aber gedeckelt — bei zwei Bildern je Sekunde kommen hoechstens acht Schritte
 * je Bild durch, und eine Wartezeit von 1,2 Sekunden ergibt dann mal dreissig
 * Schritte und mal zwei. Genau daran haben diese Pruefungen frueher gewackelt:
 * gemessen wurde die Maschine, nicht der Code.
 */
async function waitTicks(count) {
  const start = await page.evaluate(() => window.aurelith.ticks);
  await page.waitForFunction((n) => window.aurelith.ticks >= n, start + count, { timeout: 30000 });
}

/** Wartet, bis die Figur ausgelaufen ist und sich nicht mehr dreht. */
async function waitSettled() {
  await page.waitForFunction(
    () => {
      const w = window;
      const p = w.aurelith.player;
      const last = w.__settle;
      w.__settle = { x: p.x, z: p.z, yaw: p.yaw };
      if (!last) return false;
      return (
        Math.abs(p.x - last.x) < 1e-4 &&
        Math.abs(p.z - last.z) < 1e-4 &&
        Math.abs(p.yaw - last.yaw) < 1e-4
      );
    },
    undefined,
    { timeout: 30000, polling: 120 },
  );
  await page.evaluate(() => {
    delete window.__settle;
  });
}

async function walk(key, ticks = 24) {
  const start = await page.evaluate(() => ({ ...window.aurelith.player }));
  await page.keyboard.down(key);
  await waitTicks(ticks);
  await page.keyboard.up(key);
  await waitSettled();
  const end = await page.evaluate(() => ({ ...window.aurelith.player }));
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  return { dx, dz, distance: Math.hypot(dx, dz) };
}

/**
 * Prueft die Laufrichtung, nicht die Laufstrecke.
 *
 * Die zurueckgelegte Strecke haengt an der Bildrate, und die schwankt hier
 * stark: mit Bodentexturen faellt die Software-Rasterisierung von zehn auf zwei
 * Bilder je Sekunde. Eine Schwelle in Weltnenheiten misst dann die Maschine
 * statt den Code. Der Anteil der Bewegung, der in die erwartete Richtung geht,
 * ist davon unabhaengig — und genau das ist die Eigenschaft, um die es geht.
 */
function directionCheck(move, dirX, dirZ, label) {
  if (move.distance < 0.05) {
    check(false, `${label}: keine Bewegung messbar (${move.distance.toFixed(2)})`);
    return;
  }
  const along = (move.dx * dirX + move.dz * dirZ) / move.distance;
  check(along > 0.8, `${label} (${(along * 100).toFixed(0)} % der Bewegung, ${move.distance.toFixed(2)} Einheiten)`);
}

const camYaw = (await page.evaluate(() => window.aurelith.camera.yaw));
const rightX = -Math.cos(camYaw);
const rightZ = Math.sin(camYaw);
const forwardX = Math.sin(camYaw);
const forwardZ = Math.cos(camYaw);

directionCheck(await walk('KeyD'), rightX, rightZ, 'D laeuft nach bildschirmrechts');
directionCheck(await walk('KeyA'), -rightX, -rightZ, 'A laeuft nach bildschirmlinks');
directionCheck(await walk('KeyW'), forwardX, forwardZ, 'W laeuft vorwaerts');

// --- Blickrichtung bleibt stehen ------------------------------------------
//
// Beim Laufen dreht sich die Figur in Laufrichtung. Hoert man auf, muss sie so
// stehenbleiben — vorher uebernahm im Stand die Kamera, wodurch die Figur beim
// Loslassen zurueckschnappte und sich beim Drehen der Kamera mitdrehte.

// `walk` wartet bereits, bis die Figur steht und ausgedreht hat — die Drehung
// ist seit der Glaettung nicht mehr im selben Schritt fertig wie die Eingabe.
await walk('KeyD', 16);
const facingAfterWalk = await page.evaluate(() => window.aurelith.player.yaw);
await page.waitForTimeout(600);
const facingIdle = await page.evaluate(() => window.aurelith.player.yaw);

const yawDiff = (a, b) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
};

check(
  yawDiff(facingAfterWalk, facingIdle) < 0.05,
  `Figur behaelt die Richtung nach dem Anhalten (${facingAfterWalk.toFixed(2)} → ${facingIdle.toFixed(2)})`,
);

// Kamera drehen, ohne eine Taste zu druecken — die Figur darf sich nicht
// mitdrehen.
await page.mouse.move(640, 360);
await page.mouse.down({ button: 'right' });
await page.mouse.move(400, 360, { steps: 10 });
await page.mouse.up({ button: 'right' });
await waitSettled();

const facingAfterOrbit = await page.evaluate(() => window.aurelith.player.yaw);
const camAfterSecondOrbit = await page.evaluate(() => window.aurelith.camera.yaw);
check(
  yawDiff(facingIdle, facingAfterOrbit) < 0.05,
  `Kameradrehung dreht die Figur nicht mit (Figur ${facingAfterOrbit.toFixed(2)}, Kamera ${camAfterSecondOrbit.toFixed(2)})`,
);

// --- Ruckeln der eigenen Figur --------------------------------------------
//
// Die Simulation laeuft mit 20 Hz, gezeichnet wird schneller. Ohne
// Zwischenwerte aendert sich die gezeichnete Lage nur bei jedem Simulations-
// schritt — das ist das Zittern, das fremde Figuren nicht haben.
//
// Nicht ueber die Zahl verschiedener Positionen geprueft: headless liegt die
// Bildrate nahe der Simulationsrate, dann sieht ungeglaettet genauso aus wie
// geglaettet. Stattdessen der direkte Nachweis — die gezeichnete Lage muss von
// der zuletzt simulierten abweichen. Tut sie das nie, wird nicht interpoliert,
// und zwar unabhaengig davon, wie schnell gezeichnet wird.

await page.keyboard.down('KeyW');
await page.waitForTimeout(400);

const smoothness = await page.evaluate(async () => {
  const samples = [];
  const started = performance.now();
  await new Promise((resolve) => {
    let frames = 0;
    const tick = () => {
      const d = window.aurelith;
      samples.push(
        Math.abs(d.player.x - d.playerSim.x) + Math.abs(d.player.z - d.playerSim.z),
      );
      if (++frames >= 90) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const elapsed = performance.now() - started;
  return {
    total: samples.length,
    interpolated: samples.filter((v) => v > 0.0005).length,
    fps: (samples.length / elapsed) * 1000,
  };
});

await page.keyboard.up('KeyW');
await page.waitForTimeout(200);

check(
  smoothness.interpolated > smoothness.total * 0.5,
  `eigene Figur wird zwischen Schritten interpoliert ` +
    `(${smoothness.interpolated} von ${smoothness.total} Bildern, ${smoothness.fps.toFixed(0)} fps)`,
);

// Springen. Die Leertaste greift seit dem Zielsystem nicht mehr an — sie hebt
// die Figur vom Boden. Gemessen an der Höhe der eigenen Figur: sie steigt und
// kommt danach wieder auf dieselbe Höhe zurück.
/*
 * Nicht nach fester Frist nachsehen, sondern warten, bis es passiert ist.
 *
 * Die Vorhersage rechnet einen Schritt je Tick, und wie viele Ticks in einer
 * Viertelsekunde vergehen, hängt daran, wie schnell dieser Rechner zeichnet.
 * Ohne Grafikkarte sind das mitunter zwei statt zwanzig — dann steht die Figur
 * nach 250 ms noch am Boden und nach 900 ms mitten in der Luft, und der Test
 * meldet einen Fehler, der keiner ist. Umgekehrt gilt dasselbe: erscheint die
 * Figur nie oben oder kommt sie nie zurück, läuft die Frist ab, und das ist
 * dann ein echter Fehlschlag.
 */
const vorSprung = await page.evaluate(() => window.aurelith.playerSim.y);
await page.keyboard.press('Space');

let imSprung = vorSprung;
let hobAb = true;
try {
  imSprung = await page
    .waitForFunction(
      (boden) => (window.aurelith.playerSim.y > boden + 0.3 ? window.aurelith.playerSim.y : false),
      vorSprung,
      { timeout: 8000, polling: 50 },
    )
    .then((h) => h.jsonValue());
} catch {
  hobAb = false;
  imSprung = await page.evaluate(() => window.aurelith.playerSim.y);
}

/*
 * Landen heisst „wieder unten", nicht „auf denselben Zentimeter".
 *
 * Die Figur läuft vor dem Sprung ein Stück und rollt danach noch aus — das
 * Gelände unter ihr ist dabei nicht mehr dasselbe. Auf `Math.abs(...) < 0.05`
 * geprüft hing der Ausgang daran, ob sie zufällig auf gleicher Höhe zum Stehen
 * kam, und das war mal so und mal so.
 *
 * Die Aussage, um die es geht, hält der Vergleich mit dem Scheitelpunkt: sie
 * war oben (Prüfung darüber) und ist wieder auf Absprunghöhe herunter. Ein
 * Fingerbreit Toleranz für die Bodenwelle, auf der sie ausrollt — weit unter
 * den 0,3, die sie überhaupt erst als „abgehoben" gelten lassen.
 */
let gelandet = true;
try {
  await page.waitForFunction(
    (boden) => window.aurelith.playerSim.y < boden + 0.15,
    vorSprung,
    { timeout: 10000, polling: 50 },
  );
} catch {
  gelandet = false;
}

const nachSprung = await page.evaluate(() => ({
  y: window.aurelith.playerSim.y,
  auftrag: { ...window.aurelith.auftrag },
  status: document.querySelector('.status')?.textContent ?? '',
}));

check(hobAb, `die Leertaste hebt die Figur vom Boden (${vorSprung.toFixed(2)} → ${imSprung.toFixed(2)})`);
check(
  gelandet,
  `und sie landet wieder (${imSprung.toFixed(2)} → ${nachSprung.y.toFixed(2)})`,
);
// Die Gegenprobe zum alten Verhalten: ein Sprung ist kein Angriff.
check(
  nachSprung.auftrag.art === 'nichts' && nachSprung.auftrag.angriff === false,
  'ein Sprung loest keinen Angriff aus',
  `${nachSprung.auftrag.art}, angriff=${nachSprung.auftrag.angriff}`,
);
check(nachSprung.status.length > 0, 'Statusanzeige bleibt lesbar');

// --- Chatbefehl /connect --------------------------------------------------
//
// Der eigentliche Zweck: auf einer statisch ausgelieferten Seite ist die
// Serveradresse beim Bauen eingebacken. Ohne einen Weg, sie zur Laufzeit zu
// setzen, muesste fuer jede andere Adresse neu gebaut und veroeffentlicht
// werden.

async function chat(text) {
  await page.click('.chat-input');
  await page.fill('.chat-input', text);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
}

const chatText = () =>
  page.evaluate(() => [...document.querySelectorAll('.chat-line')].map((n) => n.textContent).join(' | '));

await chat('/disconnect');
// Die Diagnose wird am Ende eines Bildes fortgeschrieben. Bei zwei Bildern je
// Sekunde ist sie sonst noch nicht nachgezogen.
await page
  .waitForFunction(() => window.aurelith.localId === 0, { timeout: 10000 })
  .catch(() => undefined);
const afterDisconnect = await page.evaluate(() => ({
  state: document.querySelector('.status')?.getAttribute('data-state'),
  localId: window.aurelith.localId,
  stored: localStorage.getItem('aurelith.server'),
}));
check(afterDisconnect.state === 'getrennt', `/disconnect trennt (${afterDisconnect.state})`);
check(afterDisconnect.localId === 0, '/disconnect raeumt die Sitzung ab');
check(afterDisconnect.stored === null, '/disconnect loescht die gespeicherte Adresse');

// Eine Adresse, die kein WebSocket ist, muss abgelehnt werden — und zwar
// bevor irgendetwas versucht wird.
await chat('/connect http://example.com');
const rejected = await chatText();
check(
  rejected.includes('ws:// oder wss://'),
  'ungueltige Adresse wird mit Begruendung abgelehnt',
);
check(
  (await page.evaluate(() => localStorage.getItem('aurelith.server'))) === null,
  'abgelehnte Adresse wird nicht gespeichert',
);

// Jetzt die echte: direkt auf den Spielserver, nicht ueber den Vite-Proxy.
await chat('/connect ws://127.0.0.1:8787/ws');

// Und danach wieder anmelden. Eine neue Verbindung weist niemanden aus: es
// gibt kein Sitzungspapier, das den alten Namen belegen würde, und ein
// Client, der sich einfach wieder als derselbe ausgäbe, wäre genau die Lücke,
// die das Passwort schliessen soll. Dasselbe Konto, dieselbe Figur — der Weg
// dorthin führt noch einmal über die Maske.
await anmeldenBestehend(page, spielerName);

let reconnected = true;
try {
  // Auf die Figur *und* die Welt warten: nach dem Neuverbinden kommen die
  // Entities erst mit dem naechsten Snapshot, und die Diagnose wird am Ende
  // eines Bildes fortgeschrieben — bei zwei Bildern je Sekunde ist das ein
  // spuerbarer Abstand.
  await page.waitForFunction(
    () => window.aurelith.localId > 0 && window.aurelith.entityCount > 1,
    { timeout: 25000 },
  );
} catch {
  reconnected = false;
}
const afterConnect = await page.evaluate(() => ({
  state: document.querySelector('.status')?.getAttribute('data-state'),
  localId: window.aurelith.localId,
  stored: localStorage.getItem('aurelith.server'),
  entities: window.aurelith.entityCount,
}));

check(reconnected && afterConnect.localId > 0, `/connect verbindet neu (Entity ${afterConnect.localId})`);
check(afterConnect.state === 'verbunden', `/connect meldet verbunden (${afterConnect.state})`);
check(
  afterConnect.stored === 'ws://127.0.0.1:8787/ws',
  `Adresse bleibt gespeichert (${afterConnect.stored})`,
);
check(afterConnect.entities > 1, `Welt kommt wieder an (${afterConnect.entities} Entities)`);

// --- Menü unten links ------------------------------------------------------
//
// Der Knopf sitzt in derselben Ecke wie der Chat. Dass er nicht darunter
// liegt, ist keine Geschmacksfrage: ein Knopf hinter einem Textfeld ist kein
// Knopf mehr.

const ecke = await page.evaluate(() => {
  const knopf = document.querySelector('.menu-button')?.getBoundingClientRect();
  const chat = document.querySelector('.chat')?.getBoundingClientRect();
  if (!knopf || !chat) return undefined;
  const ueberlappt =
    knopf.left < chat.right &&
    knopf.right > chat.left &&
    knopf.top < chat.bottom &&
    knopf.bottom > chat.top;
  return { ueberlappt, knopf: Math.round(knopf.top), chat: Math.round(chat.bottom) };
});
check(ecke !== undefined, 'der Menüknopf steht im Bild');
check(
  ecke?.ueberlappt === false,
  `Menüknopf und Chat überschneiden sich nicht (Knopf ab ${ecke?.knopf}, Chat bis ${ecke?.chat})`,
);

await page.click('.menu-button');
const menue = await page.evaluate(() => {
  const panel = document.querySelector('.menu-panel');
  return {
    offen: panel ? !panel.hidden : false,
    eintraege: [...document.querySelectorAll('.menu-entry')].map((n) => n.textContent?.trim()),
  };
});
check(menue.offen, 'ein Klick klappt das Menü auf');
check(
  ['Inventar', 'Charakter', 'Aufträge', 'Chat', 'Einstellungen', 'Abmelden'].every((wort) =>
    menue.eintraege.some((t) => t?.includes(wort)),
  ),
  `alle Fenster stehen darin (${menue.eintraege.join(', ')})`,
);

// Unten steht jetzt die Fertigkeitenleiste — leer, aber vorhanden. Das ist der
// Platz, den das Menü frei gemacht hat.
const leiste = await page.evaluate(() => ({
  plaetze: document.querySelectorAll('.actionbar .action-slot').length,
  knoepfe: document.querySelectorAll('.actionbar .btn').length,
}));
check(leiste.plaetze > 0, `unten stehen Fertigkeitenplätze (${leiste.plaetze})`);
check(leiste.knoepfe === 0, 'und keine Fensterknöpfe mehr');

await page.click('.menu-entry:has-text("Einstellungen")');
check(
  await page
    .waitForSelector('.window[data-window="settings"][data-open="true"]', { timeout: 3000 })
    .then(() => true)
    .catch(() => false),
  'Einstellungen öffnen sich aus dem Menü',
);
check(
  await page.evaluate(() => document.querySelector('.menu-panel')?.hidden === true),
  'und das Menü schliesst sich dabei',
);

/*
 * --- Der Vitalkasten öffnet das Charakterblatt ------------------------------
 *
 * Er zeigt Stufe, Leben, Mana und Erfahrung — wer mehr davon will, greift
 * dorthin, wo die Zahlen stehen. Geprüft wird beides: dass der Griff aufmacht
 * **und** dass ein zweiter wieder zumacht. Ein Knopf, der nur die eine
 * Richtung kann, lässt einen die andere woanders suchen.
 */
const kompass = await page.evaluate(
  () => document.querySelector('.vitals-kompass')?.textContent ?? '',
);
check(
  /^(N|NO|O|SO|S|SW|W|NW)$/.test(kompass),
  `der Kompass steht neben der Uhr (${kompass || 'leer'})`,
);

/*
 * --- Reiter, Zahlentafel und Sichtweite ------------------------------------
 *
 * Drei Dinge in einem Abschnitt, weil sie zusammenhängen: die Sichtweite steht
 * im Reiter „Grafik", und ob sie wirkt, sagt die Zahlentafel — die man dort
 * einschaltet. Geprüft wird die **Wirkung** und nicht das Häkchen: ein
 * Menüeintrag, der eine Zahl setzt, die niemand liest, wäre ebenfalls grün.
 */
const reiterNamen = await page.evaluate(() =>
  [...document.querySelectorAll('.settings-tab')].map((n) => n.textContent),
);
check(
  reiterNamen.length >= 3 && reiterNamen.includes('Ton') && reiterNamen.includes('Grafik'),
  `die Einstellungen haben Reiter (${reiterNamen.join(', ')})`,
);

// Auf „Grafik" wechseln — und nachsehen, dass wirklich das Blatt wechselt.
const grafikReiter = page.locator('.settings-tab', { hasText: 'Grafik' });
await grafikReiter.click();
await page.waitForTimeout(300);
check(
  await page.evaluate(
    () => document.querySelector('.settings-sheet:not([hidden]) select') !== null,
  ),
  'und der Reiter „Grafik" zeigt die Renderdistanz',
);

// Debug einschalten, damit die Zahlentafel etwas sagt.
await page.evaluate(() => {
  const kaesten = [
    ...document.querySelectorAll('.settings-sheet:not([hidden]) input[type=checkbox]'),
  ];
  const debug = kaesten[kaesten.length - 1];
  if (debug && !debug.checked) debug.click();
});

/**
 * Wie viele Props die Tafel gerade meldet.
 *
 * Gewartet wird auf eine **Änderung** und nicht auf Millisekunden: die Tafel
 * wird zusammen mit der Bildrate zweimal je Sekunde neu geschrieben, und
 * headless mit swiftshader dauert eine halbe Sekunde Simulationszeit deutlich
 * länger als eine halbe Sekunde Wanduhr.
 */
const gezeichnet = async (nichtMehr = -1) => {
  const ende = Date.now() + 30000;
  while (Date.now() < ende) {
    const roh = await page.evaluate(
      () => document.querySelector('.debugtafel-wert')?.textContent ?? '',
    );
    const n = Number(roh.split('/')[0]?.trim());
    if (Number.isFinite(n) && n > 0 && n !== nichtMehr) return n;
    await page.waitForTimeout(400);
  }
  return -1;
};

const propsHoch = await gezeichnet();
check(propsHoch > 0, `die Zahlentafel zählt gezeichnete Props (${propsHoch})`);

await page.selectOption('.settings-sheet:not([hidden]) select', 'niedrig');
const propsNiedrig = await gezeichnet(propsHoch);
check(
  propsNiedrig > 0 && propsNiedrig < propsHoch * 0.6,
  `„Niedrig" zeichnet deutlich weniger (${propsHoch} → ${propsNiedrig})`,
);

/*
 * Und zurück — die Gegenprobe. Ohne sie wäre auch eine Fassung grün, die beim
 * ersten Umschalten alles wegwirft und nie wieder etwas zeichnet.
 */
await page.selectOption('.settings-sheet:not([hidden]) select', 'hoch');
const propsWieder = await gezeichnet(propsNiedrig);
check(
  propsWieder > propsNiedrig * 1.5,
  `und „Hoch" holt sie zurück (${propsNiedrig} → ${propsWieder})`,
);

await page.keyboard.press('KeyO');
await page.waitForTimeout(400);

const charOffen = () =>
  page.evaluate(
    () => document.querySelector('.window[data-window="character"]')?.dataset.open === 'true',
  );

/*
 * Zustandsbasiert und nicht „warte auf offen".
 *
 * Vor dieser Stelle läuft ein halber Test durch — Menü, Fenster, Tasten —, und
 * ob das Charakterblatt dabei schon einmal aufging, ist nicht die Sache dieser
 * Prüfung. Gemessen wird der **Wechsel**: einmal hin, einmal zurück. Die
 * Pause dazwischen ist nötig, damit zwei Klicks nicht als Doppelklick
 * durchgehen.
 */
const vorher = await charOffen();
await page.click('.vitals');
await page.waitForTimeout(400);
const nachEins = await charOffen();
check(nachEins !== vorher, 'ein Griff auf den Vitalkasten schaltet das Charakterblatt um', `${vorher} → ${nachEins}`);

await page.click('.vitals');
await page.waitForTimeout(400);
check(
  (await charOffen()) === vorher,
  'und der nächste schaltet es zurück',
  `${nachEins} → ${await charOffen()}`,
);

// Und es geht dabei wirklich auf — ein Kasten, der nur zumacht, was schon zu
// war, erfüllte die beiden Zeilen darüber ebenfalls.
check(nachEins === true || vorher === true, 'und mindestens einmal stand es dabei offen');

// --- Die rechte Maustaste gehört dem Spiel ---------------------------------

/*
 * Gemessen wird `defaultPrevented` und nicht „ist ein Menü zu sehen": das Menü
 * des Browsers ist kein Teil der Seite, Playwright sieht es nicht, und ein
 * Bildvergleich hinge am Betriebssystem. Abbestellt ist abbestellt — genau das
 * entscheidet, ob es aufklappt.
 *
 * Der Zuhörer sitzt am Fenster und damit **hinter** der Oberfläche: das
 * Ereignis steigt erst durch sie hindurch, und was sie abbestellt hat, steht
 * hier schon fest.
 */
console.log('\nRechtsklick');

await page.evaluate(() => {
  window.__rechtsklicks = [];
  window.addEventListener('contextmenu', (ev) => {
    window.__rechtsklicks.push(ev.defaultPrevented);
  });
});

const letzterRechtsklick = async (auf) => {
  await page.evaluate(() => {
    window.__rechtsklicks = [];
  });
  await page.click(auf, { button: 'right' });
  await page.waitForTimeout(200);
  return page.evaluate(() => window.__rechtsklicks.at(-1));
};

if (!(await charOffen())) {
  await page.click('.vitals');
  await page.waitForTimeout(400);
}
check(
  (await letzterRechtsklick('.window[data-window="character"] .window-title')) === true,
  'auf einem Fenster klappt kein Browsermenü mehr auf',
);
check((await letzterRechtsklick('.vitals')) === true, 'und auf dem Vitalkasten auch nicht');

/*
 * Gegenprobe: im Textfeld bleibt es. Ohne sie wäre auch eine Fassung grün, die
 * das Menü überall abbestellt — und dann käme ein Passwort aus dem Verwalter
 * nicht mehr in die Anmeldemaske.
 */
check(
  (await letzterRechtsklick('.chat-input')) === false,
  'in der Chatzeile bleibt es dagegen stehen',
);

// Zu lassen, was hier stand: das Bildschirmfoto gleich darunter soll nicht von
// einem Fenster verdeckt sein, das dieser Abschnitt aufgemacht hat.
if (await charOffen()) {
  await page.click('.vitals');
  await page.waitForTimeout(300);
}

await mkdir(shotDir, { recursive: true });
await page.screenshot({ path: join(shotDir, 'client.png') });
console.log(`\n→ Bildschirmfoto: artefakte/client.png`);

const errors = consoleLines.filter((l) => l.startsWith('[error]'));
check(pageErrors.length === 0, `keine unbehandelten Ausnahmen (${pageErrors.length})`);
check(errors.length === 0, `keine Fehler in der Konsole (${errors.length})`);

if (pageErrors.length > 0 || errors.length > 0) {
  console.log('\nMeldungen:');
  for (const e of pageErrors) console.log(`  ! ${e}`);
  for (const e of errors.slice(0, 12)) console.log(`  ${e}`);
}

// --- Mobil: erst wenn die Desktop-Seite zu ist -----------------------------
//
// Die Desktop-Seite wird vorher geschlossen. Zwei WebGL-Kontexte gleichzeitig
// bringen die Software-Rasterisierung auf ein bis zwei Bilder je Sekunde, und
// dann misst der Test die Maschine statt die Eingabe: in einem gemeinsamen Lauf
// kam die Mobil-Seite auf vier Bilder und null Simulationsschritte, allein
// gestartet auf zweiundzwanzig Schritte und knapp vier Einheiten Bewegung.

// --- Abmelden --------------------------------------------------------------
//
// Zurück in die Figurenauswahl, ohne die Verbindung zu verlieren: die Figur
// verlässt die Welt, das Konto bleibt angemeldet.

await page.click('.menu-button');
await page.click('.menu-entry:has-text("Abmelden")');
const abgemeldet = await page
  .waitForFunction(
    () =>
      window.aurelith.localId === 0 &&
      document.querySelector('.lobby')?.hidden === false &&
      document.querySelectorAll('[data-seite="figuren"] .kanal-zeile').length > 0,
    { timeout: 15000 },
  )
  .then(() => true)
  .catch(() => false);
check(abgemeldet, 'Abmelden führt zurück in die Figurenauswahl');
/*
 * Und die Verbindung bleibt dabei stehen.
 *
 * Beobachtet statt einmal abgefragt. Der Zustand stand hier eine Zeile später
 * schon wieder auf „verbunden", im Augenblick der Abfrage aber auf
 * „verbindet": beim Verlassen der Welt raeumt der Client sechzehntausend
 * Props ab, und der naechste Pong kommt erst danach. Ein einzelner Blick
 * traf mal das eine, mal das andere — je nachdem, wie gross die Karte war.
 *
 * Gefragt ist ohnehin nicht „welcher Text steht in dieser Millisekunde da",
 * sondern „ist die Verbindung weg". Deshalb: bis zu sechs Sekunden lang
 * zusehen, „getrennt" gilt sofort als Fehler.
 */
let verbindungStand = '';
let getrenntGesehen = false;
for (let i = 0; i < 60; i++) {
  verbindungStand = await page.evaluate(
    () => document.querySelector('.status')?.getAttribute('data-state') ?? '(keiner)',
  );
  if (verbindungStand === 'getrennt') {
    getrenntGesehen = true;
    break;
  }
  if (verbindungStand === 'verbunden') break;
  await page.waitForTimeout(100);
}
check(
  verbindungStand === 'verbunden' && !getrenntGesehen,
  `und die Verbindung bleibt dabei stehen (${verbindungStand})`,
);

await page.close();

// --- Mobil: Joystick und Zwei-Finger-Zoom ---------------------------------
//
// Ein zweiter Kontext mit Beruehrungsbedienung. Die Zeigerereignisse werden von
// Hand ausgeloest, weil Playwright nur einzelne Tipper kann und eine
// Kneifgeste zwei gleichzeitige Zeiger braucht.

const mobileContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  // Bewusst 1 statt 2: bei doppelter Pixeldichte rechnet die
  // Software-Rasterisierung vierfach so viele Pixel, und der Test misst dann
  // die Maschine statt die Eingabe.
  deviceScaleFactor: 1,
});
const mobilePage = await mobileContext.newPage();
const mobileErrors = [];
const mobileConsole = [];
mobilePage.on('pageerror', (e) => mobileErrors.push(String(e)));
mobilePage.on('console', (m) => mobileConsole.push(`[${m.type()}] ${m.text()}`));

// Nach vorn holen: Chromium drosselt requestAnimationFrame in Seiten im
// Hintergrund, und darauf laeuft die Spielschleife. Ohne das laeuft die
// Simulation waehrend der Messung kaum weiter, und der Test kippt sporadisch.
await mobilePage.bringToFront();
// Ein Name in üblicher Länge, nicht der kürzestmögliche: die Kopfzeile oben
// links ist genau dann eng, wenn jemand nicht „Ada" heisst.
await mobilePage.goto('http://127.0.0.1:5199/', { waitUntil: 'domcontentloaded' });
// Ein Name in üblicher Länge, nicht der kürzestmögliche: die Kopfzeile oben
// links ist genau dann eng, wenn jemand nicht „Ada" heisst.
await anmeldenUndBetreten(mobilePage, `Mobilheld${Date.now() % 1000}`).catch(() => undefined);
// Auf „verbunden" zu warten reicht nicht: die Figur entsteht erst, wenn der
// erste Snapshot sie meldet. Wer vorher misst, misst eine Figur, die es noch
// nicht gibt — und bekommt einen Test, der mal durchgeht und mal nicht.
let mobileReady = true;
try {
  await mobilePage.waitForFunction(
    () => window.aurelith?.localId > 0 && window.aurelith.entityCount > 0,
    { timeout: 30000 },
  );
} catch {
  mobileReady = false;
}
check(mobileReady, 'Mobil: Spielfigur ist eingeloggt');
await mobilePage.waitForTimeout(1200);

const mobileMode = await mobilePage.evaluate(() => ({
  coarse: window.matchMedia('(pointer: coarse)').matches,
  touchPoints: navigator.maxTouchPoints,
  hasJoystick: Boolean(document.querySelector('.joystick')),
  hasAttackButton: Boolean(document.querySelector('.attack-button')),
}));

check(
  mobileMode.hasJoystick && mobileMode.hasAttackButton,
  `Mobil: Joystick und Angriffsknopf vorhanden (pointer:coarse=${mobileMode.coarse}, ` +
    `Beruehrungspunkte=${mobileMode.touchPoints})`,
);

if (mobileMode.hasJoystick && mobileReady) {
  // Daumen auf die linke Haelfte: der Joystick soll dort erscheinen und die
  // Figur in Bewegung setzen.
  const joystickResult = await mobilePage.evaluate(async () => {
    const canvas = document.querySelector('canvas');
    const send = (target, type, id, x, y) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          pointerType: 'touch',
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );

    // Der rohe Simulationsstand, nicht die gezeichnete Lage: gefragt ist, ob
    // der Joystick die Figur bewegt, und das ist eine Eigenschaft der
    // Simulation. Die gezeichnete Lage haengt zusaetzlich an der Bildrate.
    const start = { ...window.aurelith.playerSim };
    const framesBefore = window.aurelith.frames;
    const ticksBefore = window.aurelith.ticks;
    send(canvas, 'pointerdown', 1, 90, 640);
    await new Promise((r) => setTimeout(r, 80));
    const mitteAmAnfang = document.querySelector('.joystick-base').style.transform;
    send(canvas, 'pointermove', 1, 90, 560);
    await new Promise((r) => setTimeout(r, 2500));
    const visible = !document.querySelector('.joystick').hidden;
    // Ein langer Wischer weit ueber den Ausschlag hinaus. Frueher schob der
    // den ganzen Joystick vor sich her.
    for (let y = 540; y >= 240; y -= 20) {
      send(canvas, 'pointermove', 1, 90, y);
      await new Promise((r) => setTimeout(r, 20));
    }
    const mitteDanach = document.querySelector('.joystick-base').style.transform;
    // Ein Bild abwarten, bevor die Eingabe gelesen wird: sie entsteht in der
    // Spielschleife, und die laeuft hier nur etwa einmal je Sekunde.
    {
      const ziel = window.aurelith.frames + 2;
      const frist = Date.now() + 15000;
      while (window.aurelith.frames < ziel && Date.now() < frist) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    const vollerAusschlag = Math.hypot(window.aurelith.input.moveX, window.aurelith.input.moveZ);
    send(window, 'pointerup', 1, 90, 240);
    await new Promise((r) => setTimeout(r, 200));

    const end = { ...window.aurelith.playerSim };
    return {
      visible,
      mitteAmAnfang,
      mitteDanach,
      vollerAusschlag,
      moved: Math.hypot(end.x - start.x, end.z - start.z),
      frames: window.aurelith.frames - framesBefore,
      ticks: window.aurelith.ticks - ticksBefore,
      input: { ...window.aurelith.input },
      localId: window.aurelith.localId,
      hasPrediction: window.aurelith.hasPrediction,
      hasConnection: window.aurelith.hasConnection,
      mapId: window.aurelith.mapId,
    };
  });

  check(joystickResult.visible, 'Mobil: Joystick erscheint unter dem Daumen');

  /*
   * Und bleibt liegen, wo er erschienen ist.
   *
   * Vorher zog die Mitte dem Daumen nach, sobald er den Rand erreichte. Nach
   * einem langen Wischer lag der Joystick dadurch woanders als der Daumen ihn
   * hingelegt hatte — quer über dem Bild, unter der Aktionsleiste —, und der
   * Weg zurück begann mit einer Strecke, auf der nichts passierte.
   */
  check(
    joystickResult.mitteDanach === joystickResult.mitteAmAnfang,
    'Mobil: der Joystick wandert beim Ziehen nicht mit',
    `${joystickResult.mitteAmAnfang} → ${joystickResult.mitteDanach}`,
  );
  // Gegenprobe: das Stillhalten kommt nicht davon, dass gar nichts ankam.
  check(
    joystickResult.vollerAusschlag > 0.9,
    'Mobil: und steht dabei auf vollem Ausschlag',
    joystickResult.vollerAusschlag.toFixed(2),
  );

  // Und **nur** dort. Vorher galt die ganze linke Bildhälfte, und damit liess
  // sich links von der Mitte nichts anklicken — kein Monster, kein NPC, kein
  // Tor. Auf einem Telefon ist das die halbe Welt.
  const obenLinks = await mobilePage.evaluate(async () => {
    const canvas = document.querySelector('canvas');
    const send = (target, type, id, x, y) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          pointerType: 'touch',
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );

    /*
     * Gewartet wird auf **Bilder** und nicht auf die Uhr.
     *
     * `window.aurelith.input` entsteht in der Spielschleife; loslassen wirkt
     * erst, wenn die einmal gelaufen ist. In SwiftShader sind das drei Bilder
     * in zweieinhalb Sekunden — nach dreihundert Millisekunden steht dort noch
     * die Eingabe vom vorigen Wischer, und die Pruefung darunter meldete einen
     * Fehler, den es nicht gab.
     */
    const warteBilder = async (n) => {
      const ziel = window.aurelith.frames + n;
      const frist = Date.now() + 15000;
      while (window.aurelith.frames < ziel && Date.now() < frist) {
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    await warteBilder(2);
    const vorher = { ...window.aurelith.input };
    send(canvas, 'pointerdown', 7, 90, 200);
    await warteBilder(1);
    send(canvas, 'pointermove', 7, 90, 120);
    await warteBilder(2);
    const sichtbar = !document.querySelector('.joystick').hidden;
    const eingabe = { ...window.aurelith.input };
    send(window, 'pointerup', 7, 90, 120);
    return { sichtbar, eingabe, vorher };
  });

  check(!obenLinks.sichtbar, 'Mobil: oben links greift der Joystick nicht');
  // Die Vorbedingung zuerst: nach dem Loslassen steht die Figur wieder. Ohne
  // sie sagte die Pruefung darunter nichts — eine haengengebliebene Eingabe
  // vom vorigen Wischer saehe genauso aus wie eine, die oben links entstand.
  check(
    obenLinks.vorher.moveX === 0 && obenLinks.vorher.moveZ === 0,
    'Mobil: Loslassen beendet die Bewegung',
    `${obenLinks.vorher.moveX} / ${obenLinks.vorher.moveZ}`,
  );
  check(
    obenLinks.eingabe.moveX === 0 && obenLinks.eingabe.moveZ === 0,
    'Mobil: und die Figur bleibt dabei stehen',
    `${obenLinks.eingabe.moveX} / ${obenLinks.eingabe.moveZ}`,
  );
  check(
    joystickResult.moved > 0.1,
    `Mobil: Joystick bewegt die Figur (${joystickResult.moved.toFixed(2)} Einheiten, ` +
      `${joystickResult.frames} Bilder, ${joystickResult.ticks} Schritte, ` +
      `Eingabe ${joystickResult.input.moveX.toFixed(2)}/${joystickResult.input.moveZ.toFixed(2)}, ` +
      `Entity ${joystickResult.localId}, Welt ${joystickResult.hasPrediction}, ` +
      `Verbindung ${joystickResult.hasConnection}, Karte "${joystickResult.mapId}")`,
  );
  if (joystickResult.moved <= 0.1) {
    console.log('    Mobil-Konsole:');
    for (const m of mobileConsole.slice(-8)) console.log(`      ${m}`);
  }

  // Zwei Finger zusammenziehen.
  const pinch = await mobilePage.evaluate(async () => {
    const canvas = document.querySelector('canvas');
    const send = (target, type, id, x, y) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          pointerType: 'touch',
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );

    const before = window.aurelith.camera.distance;
    send(canvas, 'pointerdown', 20, 260, 400);
    send(canvas, 'pointerdown', 21, 340, 400);
    await new Promise((r) => setTimeout(r, 60));
    for (let step = 1; step <= 6; step++) {
      send(canvas, 'pointermove', 20, 260 + step * 5, 400);
      send(canvas, 'pointermove', 21, 340 - step * 5, 400);
      await new Promise((r) => setTimeout(r, 30));
    }
    send(window, 'pointerup', 20, 290, 400);
    send(window, 'pointerup', 21, 310, 400);
    await new Promise((r) => setTimeout(r, 200));
    return { before, after: window.aurelith.camera.distance };
  });

  check(
    Math.abs(pinch.after - pinch.before) > 0.3,
    `Mobil: Zwei-Finger-Geste zoomt (${pinch.before.toFixed(1)} → ${pinch.after.toFixed(1)})`,
  );
}

// --- Mobil: passt die Kopfzeile in ihren Kasten? ---------------------------
//
// Hochkant ist der Platz oben links am knappsten: Name, Uhr und Stufe stehen
// in einer Zeile, und ein langer Name schob die Stufe frueher aus dem Kasten
// heraus. Geprueft wird deshalb in Bildpunkten und nicht mit dem Auge — ob
// etwas ueber eine Kante haengt, ist eine Zahl.
const kopfzeile = await mobilePage.evaluate(() => {
  const kasten = document.querySelector('.vitals')?.getBoundingClientRect();
  const name = document.querySelector('.vitals-name')?.getBoundingClientRect();
  const uhr = document.querySelector('.vitals-clock')?.getBoundingClientRect();
  const stufe = document.querySelector('.vitals-level')?.getBoundingClientRect();
  const medaillon = document.querySelector('.vitals-badge')?.getBoundingClientRect();
  if (!kasten || !name || !uhr || !stufe || !medaillon) return undefined;
  return {
    kasten: { left: kasten.left, right: kasten.right, width: kasten.width },
    ueberstand: Math.max(name.right, uhr.right, stufe.right) - kasten.right,
    // Ganz eingeklappte Elemente sind genauso falsch wie ueberstehende: dann
    // steht der Name zwar im Kasten, aber als Strich.
    //
    // Die Stufe ist hier **nicht** dabei: sie ist eine einstellige Zahl im
    // Medaillon und darf acht Bildpunkte breit sein. Gemessen wird stattdessen
    // das Medaillon — das ist das Element, das nicht zusammenfallen darf.
    schmalstes: Math.min(name.width, uhr.width),
    medaillon: medaillon.width,
    fensterbreite: window.innerWidth,
  };
});

check(kopfzeile !== undefined, 'Mobil: Kopfzeile ist da');
if (kopfzeile) {
  check(
    kopfzeile.ueberstand <= 1,
    `Mobil: Name, Uhr und Stufe bleiben im Kasten (Ueberstand ${kopfzeile.ueberstand.toFixed(1)} px)`,
  );
  check(
    kopfzeile.schmalstes > 24,
    `Mobil: Name und Uhr sind nicht zusammengequetscht (schmalstes ${kopfzeile.schmalstes.toFixed(0)} px)`,
  );
  check(
    kopfzeile.medaillon > 24,
    `Mobil: das Medaillon behaelt seine Groesse (${kopfzeile.medaillon.toFixed(0)} px)`,
  );
  check(
    kopfzeile.kasten.right <= kopfzeile.fensterbreite,
    `Mobil: der Kasten selbst passt aufs Bild (${kopfzeile.kasten.width.toFixed(0)} von ${kopfzeile.fensterbreite} px)`,
  );
}

check(mobileErrors.length === 0, `Mobil: keine unbehandelten Ausnahmen (${mobileErrors.length})`);
for (const e of mobileErrors.slice(0, 4)) console.log(`      ! ${e}`);

await mobilePage.screenshot({ path: join(shotDir, 'client-mobil.png') });
await mobileContext.close();

// --- Tablet: breit und trotzdem mit dem Daumen bedient ---------------------
//
// Der Fall, der die Anordnung frueher kippen liess. Ein Tablet quer ist
// zweitausend Pixel breit; eine Breitenabfrage stuft es als Schreibtisch ein
// und gibt ihm den dauerhaft offenen Chatkasten. Auf dem Bildschirm verdeckte
// der die halbe Sicht — und fing als unsichtbare Ecke Beruehrungen ab, die in
// der Welt ankommen sollten.

const tabletContext = await browser.newContext({
  viewport: { width: 1180, height: 820 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 1,
});
const tabletPage = await tabletContext.newPage();
await tabletPage.bringToFront();
await tabletPage.goto('http://127.0.0.1:5199/', { waitUntil: 'domcontentloaded' });
await anmeldenUndBetreten(tabletPage, `Tablet${Date.now() % 1000}`).catch(() => undefined);

let tabletReady = true;
try {
  await tabletPage.waitForFunction(
    () => window.aurelith?.localId > 0 && window.aurelith.entityCount > 0,
    { timeout: 30000 },
  );
} catch {
  tabletReady = false;
}
check(tabletReady, 'Tablet: Spielfigur ist eingeloggt');

if (tabletReady) {
  // Warten, bis die Begruessungszeilen ausgeblendet **sind** — nicht sieben
  // Sekunden lang hoffen, dass es reicht. Eine feste Wartezeit misst den
  // Ruhezustand nur, solange die letzte Zeile puenktlich kommt; kommt sie eine
  // Sekunde spaeter, faengt man mitten im Ausblenden eine Deckkraft von 0,13.
  await tabletPage
    .waitForFunction(
      () => Number(getComputedStyle(document.querySelector('.chat')).opacity) < 0.05,
      { timeout: 20000 },
    )
    .catch(() => undefined);

  const chat = await tabletPage.evaluate(() => {
    const node = document.querySelector('.chat');
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    // Genau in der Mitte des Chatkastens: liegt dort der Kasten selbst, geht
    // die Beruehrung nicht in die Welt.
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      open: node.dataset.open,
      opacity: Number(style.opacity),
      events: style.pointerEvents,
      inputShown: getComputedStyle(node.querySelector('.chat-input')).display !== 'none',
      hitTag: hit?.tagName.toLowerCase() ?? '—',
      touchFlag: document.getElementById('ui-root')?.dataset.touch,
    };
  });

  check(chat.touchFlag === 'true', `Tablet: als Beruehrungsgeraet erkannt (${chat.touchFlag})`);
  check(chat.open === 'false', `Tablet: Chat ist eingeklappt (data-open=${chat.open})`);
  check(chat.opacity < 0.05, `Tablet: eingeklappt unsichtbar (Deckkraft ${chat.opacity})`);
  check(!chat.inputShown, 'Tablet: kein Eingabefeld im Weg');
  check(
    chat.events === 'none' && chat.hitTag === 'canvas',
    `Tablet: Beruehrung geht durch in die Welt (pointer-events=${chat.events}, ` +
      `getroffen=${chat.hitTag})`,
  );

  // Und das 💬 klappt ihn wieder auf — jetzt aus dem Menü.
  const opened = await tabletPage.evaluate(async () => {
    document.querySelector('.menu-button')?.click();
    const buttons = [...document.querySelectorAll('.menu-entry')];
    const chatButton = buttons.find((b) => b.getAttribute('aria-label') === 'Chat');
    chatButton?.click();
    await new Promise((r) => setTimeout(r, 150));
    const node = document.querySelector('.chat');
    return {
      open: node.dataset.open,
      inputShown: getComputedStyle(node.querySelector('.chat-input')).display !== 'none',
    };
  });

  check(
    opened.open === 'true' && opened.inputShown,
    `Tablet: 💬 klappt den Chat auf (data-open=${opened.open}, Eingabe=${opened.inputShown})`,
  );

  await tabletPage.screenshot({ path: join(shotDir, 'client-tablet.png') });
}

await tabletContext.close();

await writeFile(
  join(shotDir, 'konsole.txt'),
  `${consoleLines.join('\n')}\n\n--- Server ---\n${server.log.join('')}`,
  'utf8',
);

if (!args.has('--keep')) await browser.close();
shutdown();

console.log(`\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`);
process.exit(failures === 0 ? 0 : 1);
