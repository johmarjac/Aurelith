#!/usr/bin/env node
/**
 * Rauchtest für die Veröffentlichung auf GitHub Pages.
 *
 * Baut genau das, was der Workflow baut, legt es hinter einen Unterpfad und
 * lädt es im Browser. Der Punkt ist der Unterpfad: `base`, `BASE_URL` und die
 * von Hand gebauten Asset-Adressen müssen zusammenpassen, und wenn sie es nicht
 * tun, merkt man das lokal unter `/` niemals.
 *
 * Geprüft wird außerdem, dass der wasm-Kern über den Unterpfad lädt — er kommt
 * als einziger nicht durch Vites Bündelung, sondern über eine selbst gebaute
 * Adresse.
 *
 *   node tools/smoke-pages.mjs
 */

import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'artefakte', 'site');
const REPO = 'Aurelith';
const BASE = `/${REPO}/`;
const PORT = 5197;

let failures = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}`);
  if (!ok) failures++;
};

function run(command, env = {}) {
  const res = spawnSync('bash', ['-lc', command], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    throw new Error(`Fehlgeschlagen: ${command}`);
  }
}

console.log('Aurelith — Pages-Rauchtest\n');

// --- Bauen wie im Workflow --------------------------------------------------

console.log('→ baue Client, Editor und Modellschau mit Unterpfad');
run('npm run maps >/dev/null && npm run manifest -- --build pagestest >/dev/null');
run('npm run build --workspace @aurelith/client >/dev/null', {
  AURELITH_BUILD: 'pagestest',
  AURELITH_BASE: BASE,
  // Bewusst ohne VITE_SERVER_URL: so prüfen wir zugleich den Hinweis, den der
  // Client geben soll, wenn kein Spielserver hinterlegt ist.
});
run('npm run build --workspace @aurelith/editor >/dev/null', {
  AURELITH_EDITOR_BASE: `${BASE}editor/`,
});
run('npm run build --workspace @aurelith/modelviewer >/dev/null', {
  AURELITH_VIEWER_BASE: `${BASE}model_viewer/`,
});

await rm(site, { recursive: true, force: true });
await mkdir(join(site, 'editor'), { recursive: true });
await mkdir(join(site, 'model_viewer'), { recursive: true });
await cp(join(root, 'packages', 'client', 'dist'), site, { recursive: true });
await cp(join(root, 'packages', 'editor', 'dist'), join(site, 'editor'), { recursive: true });
await cp(join(root, 'packages', 'modelviewer', 'dist'), join(site, 'model_viewer'), {
  recursive: true,
});

const bytes = await folderSize(site);
console.log(`→ Ausgabe: ${(bytes / 1024).toFixed(0)} KiB\n`);

async function folderSize(dir) {
  const { readdir } = await import('node:fs/promises');
  let sum = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sum += await folderSize(full);
    // `.br`-Beilagen zählen nicht: GitHub Pages liefert sie nicht aus.
    else if (!entry.name.endsWith('.br')) sum += (await stat(full)).size;
  }
  return sum;
}

// --- Statisch ausliefern, wie Pages es täte ---------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json',
};

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0] ?? '/';
  if (!url.startsWith(BASE)) {
    res.writeHead(404).end('außerhalb der Projektseite');
    return;
  }

  let rel = url.slice(BASE.length);
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';

  const file = join(site, normalize(rel));
  if (!file.startsWith(site) || !existsSync(file)) {
    res.writeHead(404).end('nicht gefunden');
    return;
  }

  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

// --- Im Browser prüfen ------------------------------------------------------

const executablePath = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
].find((p) => existsSync(p));

const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

console.log('Prüfungen');

for (const [name, path] of [
  ['Client', BASE],
  ['Editor', `${BASE}editor/`],
  ['Modellschau', `${BASE}model_viewer/`],
]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  const failedRequests = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Ohne hinterlegten Spielserver scheitert die WebSocket-Verbindung, und
    // der Browser meldet das. Genau das ist hier der erwartete Zustand — die
    // Prüfung darauf steht weiter unten.
    if (m.text().includes('WebSocket connection to')) return;
    errors.push(m.text());
  });
  page.on('requestfailed', (r) => failedRequests.push(r.url()));
  page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`);
  });

  await page.goto(`http://127.0.0.1:${PORT}${path}`, { waitUntil: 'domcontentloaded' });

  // Der Kern ist geladen, sobald die Welt steht — beim Client zeigt sich das
  // am Terrain, beim Editor an der gefüllten Statistik.
  const marker =
    name === 'Client' ? '.chat-line' : name === 'Editor' ? '#panel .stats div' : '#panel select';
  await page.waitForSelector(marker, { timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(2500);

  const state = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    return {
      webgl2: Boolean(canvas?.getContext('webgl2')),
      drew: (canvas?.width ?? 0) > 0,
      text: document.body.innerText.slice(0, 400),
    };
  });

  check(state.webgl2 && state.drew, `${name}: zeichnet unter ${path}`);
  check(failedRequests.length === 0, `${name}: keine fehlgeschlagenen Anfragen (${failedRequests.length})`);
  check(errors.length === 0, `${name}: keine Fehler (${errors.length})`);
  if (failedRequests.length) for (const f of failedRequests.slice(0, 6)) console.log(`      ${f}`);
  if (errors.length) for (const e of errors.slice(0, 6)) console.log(`      ${e}`);

  if (name === 'Client') {
    // Ohne hinterlegten Spielserver muss der Client das sagen, statt nur
    // „getrennt" anzuzeigen.
    check(
      state.text.includes('Kein Spielserver hinterlegt'),
      'Client: erklärt die fehlende Serveradresse',
    );

    /*
     * Die Marke liegt **neben** der Seite und nicht im Asset-Baum, hat also
     * ihre eigene Adressbildung (`seitenUrl`). Genau die geht unter einem
     * Unterpfad kaputt, ohne dass es unter `/` je auffiele — und ein Logo,
     * das nicht lädt, sieht man auf dem Bildschirmfoto nicht: der Platz
     * bleibt einfach leer.
     *
     * `naturalWidth` ist der Beleg dafür, dass wirklich Bild ankam. Ein
     * kaputtes `<img>` steht mit null da.
     */
    const marke = await page.evaluate(() => {
      const img = document.querySelector('.lobby-marke');
      return { breite: img?.naturalWidth ?? 0, quelle: img?.currentSrc ?? '' };
    });
    check(marke.breite > 0, `Client: das Logo der Maske lädt (${marke.breite} px, ${marke.quelle})`);

    // Das Reitersymbol holt ein kopfloser Browser nicht von selbst — also
    // von Hand, und zwar über die Adresse, die im Dokument steht.
    const symbolUrl = await page.evaluate(
      () => document.querySelector('link[rel="icon"]')?.getAttribute('href') ?? '',
    );
    const symbol = await fetch(`http://127.0.0.1:${PORT}${symbolUrl}`);
    check(
      symbolUrl.startsWith(BASE) && symbol.ok,
      `Client: das Reitersymbol liegt unter dem Unterpfad (${symbolUrl} → ${symbol.status})`,
    );
  }

  if (name === 'Modellschau') {
    /*
     * Die Schau baut ihren Katalog aus den Bauern des Clients. Ein leerer
     * Katalog wäre die Sorte Fehler, die man auf dem Bildschirmfoto nicht
     * sieht: die Seite steht da, dreht ein Nichts und meldet keinen Fehler.
     */
    const schau = await page.evaluate(() => ({
      anzahl: window.modellschau.modelle.length,
      gruppen: [...new Set(window.modellschau.modelle.map((m) => m.gruppe))],
      aktuell: window.modellschau.aktuell,
    }));
    check(schau.anzahl > 40, `Modellschau: der Katalog ist gefüllt (${schau.anzahl} Modelle)`);
    check(
      schau.gruppen.includes('Props') &&
        schau.gruppen.includes('Figuren') &&
        schau.gruppen.includes('Waffen'),
      `Modellschau: alle Sorten sind dabei (${schau.gruppen.join(', ')})`,
    );

    // Und die Geste greift: ein Wischen dreht die Kamera. Ohne diese Prüfung
    // wäre eine Seite grün, auf der man das Modell nicht bewegen kann — und
    // genau dafür ist sie da.
    const vorher = await page.evaluate(() => window.modellschau.kamera.gier);
    await page.mouse.move(400, 400);
    await page.mouse.down();
    await page.mouse.move(640, 400, { steps: 10 });
    await page.mouse.up();
    const nachher = await page.evaluate(() => window.modellschau.kamera.gier);
    check(
      Math.abs(nachher - vorher) > 0.2,
      `Modellschau: Ziehen dreht das Modell (${vorher.toFixed(2)} → ${nachher.toFixed(2)} rad)`,
    );

    // Gegenprobe: ein Klick ohne Weg dreht nichts. Sonst ginge auch eine
    // Fassung durch, in der die Kamera von selbst wandert.
    const ruheVor = await page.evaluate(() => window.modellschau.kamera.gier);
    await page.mouse.click(400, 400);
    const ruheNach = await page.evaluate(() => window.modellschau.kamera.gier);
    check(Math.abs(ruheNach - ruheVor) < 0.01, 'Modellschau: ein Klick allein dreht nichts');
  }

  await page.screenshot({ path: join(root, 'artefakte', `pages-${name.toLowerCase()}.png`) });
  await page.close();
}

/*
 * --- Und dasselbe am Telefon ----------------------------------------------
 *
 * Die Modellschau ist ausdrücklich zum Danebenhalten gebaut, also gehört die
 * Bedienung mit dem Daumen geprüft und nicht nur die mit der Maus. Playwright
 * kann nur einzelne Tipper; zwei gleichzeitige Finger werden deshalb von Hand
 * ausgelöst — dieselbe Technik wie beim Zwei-Finger-Zoom in `smoke-e2e`.
 */
{
  const kontext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
  });
  const page = await kontext.newPage();
  await page.goto(`http://127.0.0.1:${PORT}${BASE}model_viewer/`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#fuss', { timeout: 30000 });
  await page.waitForTimeout(1500);

  // Auf einem schmalen Bild fängt das Bedienfeld zugeklappt an: das Modell ist
  // der Grund, warum man hier ist, und ein Feld über der halben Breite nimmt
  // ihm den Platz.
  check(
    await page.evaluate(() => window.modellschau.panelZu),
    'Mobil: das Bedienfeld startet zugeklappt',
  );
  await page.tap('#klapp');
  await page.waitForTimeout(300);
  check(
    !(await page.evaluate(() => window.modellschau.panelZu)),
    'Mobil: der Zahnradknopf klappt es auf',
  );
  await page.tap('#klapp');
  await page.waitForTimeout(300);

  const gesten = await page.evaluate(async () => {
    const canvas = document.querySelector('canvas');
    const send = (type, id, x, y) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          pointerType: 'touch',
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
    const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));

    // --- Ein Finger dreht ---------------------------------------------------
    const drehVor = { ...window.modellschau.kamera };
    send('pointerdown', 1, 180, 420);
    for (let i = 1; i <= 8; i++) {
      send('pointermove', 1, 180 + i * 12, 420 + i * 5);
      await schlaf(16);
    }
    send('pointerup', 1, 276, 460);
    await schlaf(60);
    const drehNach = { ...window.modellschau.kamera };

    /*
     * --- Zwei Finger zoomen, in beide Richtungen ---------------------------
     *
     * Erst spreizen, dann zusammenziehen. Beides, weil eine einzelne Messung
     * nicht sagt, ob das Vorzeichen stimmt: eine Fassung, die immer wegzoomt,
     * bestünde eine Prüfung, die nur „der Abstand hat sich geändert" fragt.
     * Spreizen heisst näher heran, Zusammenziehen weiter weg — so herum kennt
     * man es von jeder Landkarte.
     */
    const spreizVor = window.modellschau.kamera.abstand;
    send('pointerdown', 2, 170, 500);
    send('pointerdown', 3, 220, 500);
    await schlaf(40);
    for (let i = 1; i <= 8; i++) {
      send('pointermove', 2, 170 - i * 8, 500);
      send('pointermove', 3, 220 + i * 8, 500);
      await schlaf(16);
    }
    const spreizNach = window.modellschau.kamera.abstand;
    send('pointerup', 2, 106, 500);
    send('pointerup', 3, 284, 500);
    await schlaf(60);

    const kneifVor = window.modellschau.kamera.abstand;
    send('pointerdown', 6, 110, 500);
    send('pointerdown', 7, 280, 500);
    await schlaf(40);
    for (let i = 1; i <= 8; i++) {
      send('pointermove', 6, 110 + i * 8, 500);
      send('pointermove', 7, 280 - i * 8, 500);
      await schlaf(16);
    }
    const kneifNach = window.modellschau.kamera.abstand;
    send('pointerup', 6, 174, 500);
    send('pointerup', 7, 216, 500);
    await schlaf(60);

    // --- Zwei Finger schieben ----------------------------------------------
    const schiebVor = { ...window.modellschau.kamera.blick };
    send('pointerdown', 4, 140, 500);
    send('pointerdown', 5, 260, 500);
    await schlaf(40);
    for (let i = 1; i <= 8; i++) {
      send('pointermove', 4, 140 + i * 10, 500 - i * 4);
      send('pointermove', 5, 260 + i * 10, 500 - i * 4);
      await schlaf(16);
    }
    const schiebNach = { ...window.modellschau.kamera.blick };
    send('pointerup', 4, 220, 468);
    send('pointerup', 5, 340, 468);

    return { drehVor, drehNach, spreizVor, spreizNach, kneifVor, kneifNach, schiebVor, schiebNach };
  });

  check(
    Math.abs(gesten.drehNach.gier - gesten.drehVor.gier) > 0.2 &&
      Math.abs(gesten.drehNach.nick - gesten.drehVor.nick) > 0.05,
    `Mobil: ein Finger dreht Gieren und Nicken (${gesten.drehVor.gier.toFixed(2)} → ` +
      `${gesten.drehNach.gier.toFixed(2)} rad, Nick ${gesten.drehNach.nick.toFixed(2)})`,
  );
  check(
    gesten.spreizNach < gesten.spreizVor * 0.9,
    `Mobil: Spreizen holt das Modell heran (${gesten.spreizVor.toFixed(2)} → ` +
      `${gesten.spreizNach.toFixed(2)})`,
  );
  check(
    gesten.kneifNach > gesten.kneifVor * 1.1,
    `Mobil: Zusammenziehen schiebt es weg (${gesten.kneifVor.toFixed(2)} → ` +
      `${gesten.kneifNach.toFixed(2)})`,
  );
  const weg = Math.hypot(
    gesten.schiebNach.x - gesten.schiebVor.x,
    gesten.schiebNach.y - gesten.schiebVor.y,
    gesten.schiebNach.z - gesten.schiebVor.z,
  );
  check(weg > 0.05, `Mobil: zwei Finger schieben die Kamera (${weg.toFixed(2)} Einheiten)`);

  await page.screenshot({ path: join(root, 'artefakte', 'pages-modellschau-mobil.png') });
  await kontext.close();
}

await browser.close();
server.close();

console.log(`\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`);
process.exit(failures === 0 ? 0 : 1);
