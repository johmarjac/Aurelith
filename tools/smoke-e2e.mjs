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
  // SwiftShader liefert WebGL 2 ohne GPU — anders wäre der Test hier blind.
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
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

async function walk(key, seconds) {
  const start = await page.evaluate(() => ({ ...window.aurelith.player }));
  await page.keyboard.down(key);
  await page.waitForTimeout(seconds * 1000);
  await page.keyboard.up(key);
  await page.waitForTimeout(300);
  const end = await page.evaluate(() => ({ ...window.aurelith.player }));
  return { dx: end.x - start.x, dz: end.z - start.z };
}

const camYaw = (await page.evaluate(() => window.aurelith.camera.yaw));
const rightX = -Math.cos(camYaw);
const rightZ = Math.sin(camYaw);
const forwardX = Math.sin(camYaw);
const forwardZ = Math.cos(camYaw);

const moveD = await walk('KeyD', 1.0);
const alongRight = moveD.dx * rightX + moveD.dz * rightZ;
check(alongRight > 1, `D laeuft nach bildschirmrechts (${alongRight.toFixed(2)} Einheiten)`);

const moveA = await walk('KeyA', 1.0);
const alongLeft = moveA.dx * rightX + moveA.dz * rightZ;
check(alongLeft < -1, `A laeuft nach bildschirmlinks (${alongLeft.toFixed(2)} Einheiten)`);

const moveW = await walk('KeyW', 1.0);
const alongForward = moveW.dx * forwardX + moveW.dz * forwardZ;
check(alongForward > 1, `W laeuft vorwaerts (${alongForward.toFixed(2)} Einheiten)`);

// --- Blickrichtung bleibt stehen ------------------------------------------
//
// Beim Laufen dreht sich die Figur in Laufrichtung. Hoert man auf, muss sie so
// stehenbleiben — vorher uebernahm im Stand die Kamera, wodurch die Figur beim
// Loslassen zurueckschnappte und sich beim Drehen der Kamera mitdrehte.

await walk('KeyD', 0.6);
const facingAfterWalk = await page.evaluate(() => window.aurelith.player.yaw);
await page.waitForTimeout(500);
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
await page.waitForTimeout(500);

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

// --- Mobil: Joystick und Zwei-Finger-Zoom ---------------------------------
//
// Ein zweiter Kontext mit Beruehrungsbedienung. Die Zeigerereignisse werden von
// Hand ausgeloest, weil Playwright nur einzelne Tipper kann und eine
// Kneifgeste zwei gleichzeitige Zeiger braucht.

const mobileContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
});
const mobilePage = await mobileContext.newPage();
const mobileErrors = [];
mobilePage.on('pageerror', (e) => mobileErrors.push(String(e)));

// Nach vorn holen: Chromium drosselt requestAnimationFrame in Seiten im
// Hintergrund, und darauf laeuft die Spielschleife. Ohne das laeuft die
// Simulation waehrend der Messung kaum weiter, und der Test kippt sporadisch.
await mobilePage.bringToFront();
await mobilePage.goto('http://127.0.0.1:5199/?name=Mobil', { waitUntil: 'domcontentloaded' });
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

    const start = { ...window.aurelith.player };
    send(canvas, 'pointerdown', 1, 90, 640);
    await new Promise((r) => setTimeout(r, 80));
    send(canvas, 'pointermove', 1, 90, 560);
    await new Promise((r) => setTimeout(r, 1600));
    const visible = !document.querySelector('.joystick').hidden;
    send(window, 'pointerup', 1, 90, 560);
    await new Promise((r) => setTimeout(r, 200));

    const end = { ...window.aurelith.player };
    return { visible, moved: Math.hypot(end.x - start.x, end.z - start.z) };
  });

  check(joystickResult.visible, 'Mobil: Joystick erscheint unter dem Daumen');
  check(joystickResult.moved > 1, `Mobil: Joystick bewegt die Figur (${joystickResult.moved.toFixed(2)} Einheiten)`);

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

check(mobileErrors.length === 0, `Mobil: keine unbehandelten Ausnahmen (${mobileErrors.length})`);
for (const e of mobileErrors.slice(0, 4)) console.log(`      ! ${e}`);

await mkdir(shotDir, { recursive: true });
await mobilePage.screenshot({ path: join(shotDir, 'client-mobil.png') });
await mobileContext.close();

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

await writeFile(
  join(shotDir, 'konsole.txt'),
  `${consoleLines.join('\n')}\n\n--- Server ---\n${server.log.join('')}`,
  'utf8',
);

if (!args.has('--keep')) await browser.close();
shutdown();

console.log(`\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`);
process.exit(failures === 0 ? 0 : 1);
