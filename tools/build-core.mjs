#!/usr/bin/env node
/**
 * Übersetzt den C++-Kern nach WebAssembly.
 *
 * Ergebnis sind zwei Dateien in `packages/core/dist`:
 *
 *   aurelith_core.js    ES-Modul-Glue, läuft in Browser, Worker und Node
 *   aurelith_core.wasm  der Kern selbst
 *
 * Beide werden zusätzlich nach `assets/core/` kopiert, weil der Client sie
 * über denselben Weg lädt wie jedes andere Asset — vom CDN, mit Version im
 * Query-String. Der Server liest sie direkt von der Platte.
 *
 * Der Blueprint verlangt Brotli im Build und nicht in der Serverkonfiguration,
 * damit die Kompression auch beim statischen Hosting gilt. Deshalb legen wir
 * neben jede Datei ein `.br`.
 *
 *   node tools/build-core.mjs [--debug] [--native]
 */

import { spawnSync } from 'node:child_process';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = join(root, 'packages', 'core');
const distDir = join(coreDir, 'dist');
const assetCoreDir = join(root, 'assets', 'core');

const args = new Set(process.argv.slice(2));
const debug = args.has('--debug');
const nativeOnly = args.has('--native');

function findEmsdk() {
  const candidates = [
    process.env.EMSDK,
    '/opt/emsdk',
    join(process.env.HOME ?? '', 'emsdk'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(join(c, 'emsdk_env.sh'))) return c;
  }
  return null;
}

/**
 * Emscripten setzt seine Umgebung über ein Shell-Skript. Statt sie
 * nachzubauen, lassen wir die Shell das Skript einlesen und danach den
 * eigentlichen Befehl ausführen.
 */
function runInEmsdk(emsdk, command) {
  const script = `set -e\nsource "${emsdk}/emsdk_env.sh" >/dev/null 2>&1\n${command}`;
  return spawnSync('bash', ['-lc', script], { stdio: 'inherit', cwd: coreDir });
}

function run(command) {
  return spawnSync('bash', ['-lc', command], { stdio: 'inherit', cwd: coreDir });
}

// --- Nativer Build und Tests ------------------------------------------------
// Läuft immer zuerst: er ist in Sekunden durch und fängt praktisch alles ab,
// was auch im wasm-Build schiefginge.

console.log('→ nativer Build und Prüfungen');
let res = run(
  `cmake -S . -B build/native -G Ninja -DCMAKE_BUILD_TYPE=${debug ? 'Debug' : 'Release'} >/dev/null && cmake --build build/native`,
);
if (res.status !== 0) process.exit(res.status ?? 1);

res = run('./build/native/core_tests');
if (res.status !== 0) {
  console.error('\nNative Prüfungen fehlgeschlagen — wasm-Build übersprungen.');
  process.exit(res.status ?? 1);
}

if (nativeOnly) process.exit(0);

// --- wasm-Build -------------------------------------------------------------

const emsdk = findEmsdk();
if (!emsdk) {
  console.error(
    '\nEmscripten nicht gefunden. Erwartet unter $EMSDK, /opt/emsdk oder ~/emsdk.\n' +
      'Einrichten mit:\n' +
      '  git clone --depth 1 https://github.com/emscripten-core/emsdk.git /opt/emsdk\n' +
      '  cd /opt/emsdk && ./emsdk install latest && ./emsdk activate latest',
  );
  process.exit(1);
}

console.log(`\n→ wasm-Build (Emscripten aus ${emsdk})`);
res = runInEmsdk(
  emsdk,
  `emcmake cmake -S . -B build/wasm -G Ninja -DCMAKE_BUILD_TYPE=${debug ? 'Debug' : 'Release'} >/dev/null && cmake --build build/wasm`,
);
if (res.status !== 0) process.exit(res.status ?? 1);

// --- Verteilen --------------------------------------------------------------

await mkdir(distDir, { recursive: true });
await mkdir(assetCoreDir, { recursive: true });

const produced = ['aurelith_core.js', 'aurelith_core.wasm'];
for (const name of produced) {
  const from = join(coreDir, 'build', 'wasm', name);
  await copyFile(from, join(distDir, name));
  await copyFile(from, join(assetCoreDir, name));
}

// Brotli neben jede Datei legen — verbindlich im Build, nicht im Server.
for (const name of produced) {
  const raw = await readFile(join(assetCoreDir, name));
  const compressed = brotliCompressSync(raw, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
  await writeFile(join(assetCoreDir, `${name}.br`), compressed);
}

console.log('\n→ Ergebnis');
for (const name of await readdir(assetCoreDir)) {
  const info = await stat(join(assetCoreDir, name));
  console.log(`   ${name.padEnd(26)} ${(info.size / 1024).toFixed(1).padStart(8)} KiB`);
}
console.log(`\nKern gebaut. Client und Server laden dieselbe Binärdatei.`);
