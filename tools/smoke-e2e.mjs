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

await page.goto('http://127.0.0.1:5199/?name=Rauchtest', { waitUntil: 'domcontentloaded' });

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
    status: document.querySelector('.status')?.textContent ?? '',
  };
});

check(state.webgl2, 'WebGL 2 ist aktiv');
check(state.canvasWidth > 0, `Leinwand hat Größe (${state.canvasWidth} px)`);
check(/\d+ \/ \d+/.test(state.hpLabel), `Lebensanzeige gefüllt (${state.hpLabel})`);
check(state.level.includes('Stufe'), `Stufe angezeigt (${state.level})`);
check(state.inventoryFilled >= 3, `Startausrüstung im Inventar (${state.inventoryFilled} Plätze)`);
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

// Angriff ausloesen — der Flaechenschlag soll Treffer melden.
await page.keyboard.down('Space');
await page.waitForTimeout(2500);
await page.keyboard.up('Space');
await page.waitForTimeout(600);

const after = await page.evaluate(() => ({
  damageNumbers: document.querySelectorAll('.damage').length,
  status: document.querySelector('.status')?.textContent ?? '',
}));

check(after.status.length > 0, 'Statusanzeige bleibt lesbar');

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
await mobilePage.goto('http://127.0.0.1:5199/?name=Mobilheld123', {
  waitUntil: 'domcontentloaded',
});
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
    send(canvas, 'pointermove', 1, 90, 560);
    await new Promise((r) => setTimeout(r, 2500));
    const visible = !document.querySelector('.joystick').hidden;
    send(window, 'pointerup', 1, 90, 560);
    await new Promise((r) => setTimeout(r, 200));

    const end = { ...window.aurelith.playerSim };
    return {
      visible,
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

    const vorher = { ...window.aurelith.input };
    send(canvas, 'pointerdown', 7, 90, 200);
    await new Promise((r) => setTimeout(r, 120));
    send(canvas, 'pointermove', 7, 90, 120);
    await new Promise((r) => setTimeout(r, 300));
    const sichtbar = !document.querySelector('.joystick').hidden;
    const eingabe = { ...window.aurelith.input };
    send(window, 'pointerup', 7, 90, 120);
    return { sichtbar, eingabe, vorher };
  });

  check(!obenLinks.sichtbar, 'Mobil: oben links greift der Joystick nicht');
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
  if (!kasten || !name || !uhr || !stufe) return undefined;
  return {
    kasten: { left: kasten.left, right: kasten.right, width: kasten.width },
    ueberstand: Math.max(name.right, uhr.right, stufe.right) - kasten.right,
    // Ganz eingeklappte Elemente sind genauso falsch wie ueberstehende: dann
    // steht die Stufe zwar im Kasten, aber als Strich.
    schmalstes: Math.min(name.width, uhr.width, stufe.width),
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
    `Mobil: nichts davon ist zusammengequetscht (schmalstes ${kopfzeile.schmalstes.toFixed(0)} px)`,
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
await tabletPage.goto('http://127.0.0.1:5199/?name=Tablet', { waitUntil: 'domcontentloaded' });

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

  // Und das 💬 klappt ihn wieder auf.
  const opened = await tabletPage.evaluate(async () => {
    const buttons = [...document.querySelectorAll('.actionbar .slot')];
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
