#!/usr/bin/env node
/**
 * Erzeugt das Asset-Manifest.
 *
 * Der Streamer braucht Größen und Hashes *vorab*, sonst kann er nicht
 * priorisieren, sondern nur raten. Genau dafür existiert diese Datei — sie ist
 * die Übernahme aus Flyffs `filemap.bin`, nur als lesbares JSON statt als
 * eigenes Containerformat.
 *
 *   node tools/build-manifest.mjs [--build 42]
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(root, 'assets');

const args = process.argv.slice(2);
const buildFlag = args.indexOf('--build');
const build =
  buildFlag >= 0 && args[buildFlag + 1]
    ? args[buildFlag + 1]
    : (process.env.AURELITH_BUILD ?? 'dev');

/** Dateiendung → Art. Bestimmt später, wie der Streamer das Asset behandelt. */
function kindOf(relPath) {
  if (relPath.startsWith('maps/')) return 'map';
  if (relPath.startsWith('core/')) return 'data';
  if (relPath.startsWith('content/')) return 'data';
  if (relPath.startsWith('content/')) return 'data';
  if (/\.(glb|gltf)$/i.test(relPath)) return 'model';
  if (/\.(png|jpg|jpeg|webp|ktx2|basis)$/i.test(relPath)) return 'texture';
  if (/\.(ogg|mp3|wav|m4a)$/i.test(relPath)) return 'audio';
  return 'data';
}

/**
 * Zone eines Assets — die Map, zu der es gehört. Leer heißt: überall nötig.
 * Der Streamer zieht beim Kartenwechsel gezielt die passende Zone vor.
 */
function zoneOf(relPath) {
  const map = /^maps\/([^/]+)\.json$/.exec(relPath);
  if (map) return map[1];
  const zoned = /^(?:models|textures|audio)\/([^/]+)\//.exec(relPath);
  return zoned ? zoned[1] : '';
}

/** 0 = sofort nötig, höher = kann warten. */
function priorityOf(relPath, kind) {
  // Kern und Inhalte zuerst: ohne beides startet das Spiel nicht, alles
  // andere ist Nachschub.
  if (relPath.startsWith('core/')) return 0;
  if (relPath.startsWith('content/')) return 0;
  if (kind === 'map') return 1;
  if (kind === 'model') return 3;
  if (kind === 'texture') return 4;
  if (kind === 'audio') return 6;
  return 5;
}

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
      continue;
    }
    // Weder das Manifest selbst noch die daneben liegenden Brotli-Kopien
    // gehören ins Manifest — und auch keine Begleittexte: Lizenzhinweise
    // stehen neben den Assets, weil sie dorthin gehören, aber der Client soll
    // sie nicht herunterladen.
    if (entry.name === 'manifest.json' || entry.name.endsWith('.br')) continue;
    if (/\.(md|txt)$/i.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

const files = await walk(assetsDir);
const entries = [];

for (const file of files) {
  const relPath = relative(assetsDir, file).split(sep).join(posix.sep);
  const info = await stat(file);
  const bytes = await readFile(file);
  const kind = kindOf(relPath);

  entries.push({
    path: relPath,
    kind,
    size: info.size,
    // 16 Hex-Zeichen reichen zur Integritätsprüfung und halten das Manifest klein.
    hash: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
    zone: zoneOf(relPath),
    priority: priorityOf(relPath, kind),
  });
}

entries.sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path));

const manifest = {
  format: 'aurelith.manifest',
  version: 1,
  build: String(build),
  generatedAt: new Date().toISOString(),
  entries,
};

await writeFile(join(assetsDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
const byKind = new Map();
for (const e of entries) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);

console.log(`Manifest geschrieben — Build ${manifest.build}`);
for (const [kind, count] of [...byKind].sort()) {
  console.log(`  ${kind.padEnd(8)} ${String(count).padStart(4)} Dateien`);
}
console.log(`  ${'gesamt'.padEnd(8)} ${String(entries.length).padStart(4)} Dateien, ` +
  `${(totalBytes / 1024).toFixed(1)} KiB`);
