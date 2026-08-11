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

console.log('→ baue Client und Editor mit Unterpfad');
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

await rm(site, { recursive: true, force: true });
await mkdir(join(site, 'editor'), { recursive: true });
await cp(join(root, 'packages', 'client', 'dist'), site, { recursive: true });
await cp(join(root, 'packages', 'editor', 'dist'), join(site, 'editor'), { recursive: true });

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
  const marker = name === 'Client' ? '.chat-line' : '#panel .stats div';
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
  }

  await page.screenshot({ path: join(root, 'artefakte', `pages-${name.toLowerCase()}.png`) });
  await page.close();
}

await browser.close();
server.close();

console.log(`\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`);
process.exit(failures === 0 ? 0 : 1);
