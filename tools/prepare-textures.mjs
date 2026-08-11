#!/usr/bin/env node
/**
 * Bereitet einen gelieferten PBR-Texturensatz für die Auslieferung auf.
 *
 * Erwartet einen Ordner, wie ihn Texturanbieter ausliefern — Dateien mit
 * `BaseColor`, `Normal`, `Roughness` im Namen, Groß- und Kleinschreibung egal.
 * Was nicht gebraucht wird, bleibt liegen.
 *
 * Zwei Entscheidungen stecken darin:
 *
 * **Die Rauheitskarte wird gemessen, nicht ausgeliefert.** Bei Bodenmaterial
 * schwankt sie kaum — beim ersten gelieferten Satz um 1,3 Prozent. Eine Textur
 * dafür wäre eine Texturabfrage und ein Sampler für eine Zahl. Das Werkzeug
 * misst den Mittelwert und schreibt ihn hin; er gehört dann als Konstante in
 * die Bodenebene der Karte. Sollte ein Satz doch echte Schwankung zeigen,
 * meldet das Werkzeug es.
 *
 * **Normalen bekommen mehr Qualität als Farbe.** Kompressionsartefakte in
 * einer Farbtextur sieht niemand; in einer Normalen erzeugen sie sichtbare
 * Beulen in der Beleuchtung.
 *
 * Was hier bewusst *nicht* passiert: die Umwandlung in ein GPU-komprimiertes
 * Format (KTX2/Basis → S3TC, ETC, ASTC, BPTC). Der Blueprint verlangt diese
 * Matrix, und sie ist der eigentliche Hebel — WebP spart Downloadgröße, aber
 * im Grafikspeicher liegt jede Textur trotzdem unkomprimiert. Dafür braucht es
 * `toktx` oder `basisu`, und beides ist hier nicht verfügbar.
 *
 *   node tools/prepare-textures.mjs <quellordner> <name> [--size 1024]
 *
 * Beispiel:
 *   node tools/prepare-textures.mjs /tmp/grass/1K ground_grass
 */

import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const sourceDir = args[0];
const name = args[1];
const sizeFlag = args.indexOf('--size');
const size = sizeFlag >= 0 ? Number(args[sizeFlag + 1]) : 1024;

if (!sourceDir || !name) {
  console.error(
    'Aufruf: node tools/prepare-textures.mjs <quellordner> <name> [--size 1024]\n' +
      'Beispiel: node tools/prepare-textures.mjs /tmp/grass/1K ground_grass',
  );
  process.exit(1);
}

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error(
    'sharp fehlt. Einmalig einrichten mit:\n  npm i -D sharp\n' +
      'Es bringt vorkompilierte Binärdateien mit, es wird nichts übersetzt.',
  );
  process.exit(1);
}

/**
 * Findet eine Datei anhand von Namensbestandteilen.
 *
 * Anbieter benennen dieselben Karten verschieden: `BaseColor` oder `COL`,
 * `Normal` oder `NRM`. Deshalb eine Liste von Kandidaten statt eines festen
 * Namens — und die Vorschau (`Preview`) muss draussen bleiben, sonst wird sie
 * fuer die Farbtextur gehalten.
 */
function pick(files, needles) {
  for (const needle of needles) {
    const hit = files.find((f) => {
      const lower = f.toLowerCase();
      return lower.includes(needle.toLowerCase()) && !lower.includes('preview');
    });
    if (hit) return join(sourceDir, hit);
  }
  return null;
}

const files = (await readdir(sourceDir)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
const baseColor = pick(files, ['basecolor', 'albedo', 'diffuse', '_col']);
const normal = pick(files, ['normal', '_nrm']);
const roughness = pick(files, ['roughness', '_rgh']);
// Glanz ist die Umkehrung der Rauheit. Wer das verwechselt, bekommt spiegelnden
// Sand und stumpfes Metall.
const gloss = roughness ? null : pick(files, ['gloss', '_gls']);

if (!baseColor) {
  console.error(`Keine Farbtextur in ${sourceDir} gefunden. Gesehen: ${files.join(', ')}`);
  process.exit(1);
}

const outDir = join(root, 'assets', 'textures', name);
await mkdir(outDir, { recursive: true });

console.log(`Quelle:  ${sourceDir}`);
console.log(`Ziel:    assets/textures/${name}/`);
console.log(`Größe:   ${size}×${size}\n`);

// --- Farbe ------------------------------------------------------------------

const albedoBuffer = await sharp(baseColor)
  .resize(size, size, { fit: 'fill' })
  .removeAlpha()
  .toColorspace('srgb')
  .webp({ quality: 82 })
  .toBuffer();
await writeFile(join(outDir, 'albedo.webp'), albedoBuffer);

// --- Rauheit: messen statt ausliefern ---------------------------------------

let roughnessValue = 0.9;
const roughSource = roughness ?? gloss;
if (roughSource) {
  const stats = await sharp(roughSource).greyscale().stats();
  const channel = stats.channels[0];
  const mean = channel.mean / 255;
  roughnessValue = Math.round((gloss ? 1 - mean : mean) * 100) / 100;
  const spread = channel.stdev / 255;

  console.log(
    `Rauheit       ${roughnessValue.toFixed(2).padStart(9)}   ` +
      `gemessen aus ${gloss ? 'Glanz (umgekehrt)' : 'Rauheit'}, ` +
      `Streuung ${(spread * 100).toFixed(1)} %`,
  );
  if (spread > 0.08) {
    console.log(
      '              Achtung: diese Karte tr\u00e4gt echte Schwankung. Eine Konstante\n' +
        '              verschenkt hier etwas — als eigene Textur w\u00e4re sie es wert.',
    );
  }
}

// --- Normalen ---------------------------------------------------------------

let normalBytes = 0;
if (normal) {
  const normalBuffer = await sharp(normal)
    .resize(size, size, { fit: 'fill' })
    .removeAlpha()
    // Höhere Qualität als bei der Farbe: Artefakte in einer Normalen zeigen
    // sich als Beulen in der Beleuchtung.
    .webp({ quality: 90 })
    .toBuffer();
  await writeFile(join(outDir, 'normal.webp'), normalBuffer);
  normalBytes = normalBuffer.length;
} else {
  console.log('Hinweis: keine Normalenkarte gefunden.');
}

// --- Bilanz -----------------------------------------------------------------

let originalBytes = 0;
for (const f of files) originalBytes += (await stat(join(sourceDir, f))).size;
const outBytes = albedoBuffer.length + normalBytes;

const kib = (n) => `${(n / 1024).toFixed(0)} KiB`;
console.log(`albedo.webp   ${kib(albedoBuffer.length).padStart(9)}`);
if (normalBytes) console.log(`normal.webp   ${kib(normalBytes).padStart(9)}`);
console.log(`\nQuellsatz  ${kib(originalBytes)}  →  Auslieferung ${kib(outBytes)}`);

// Der Grafikspeicher ist die eigentliche Grenze, nicht der Download.
const vram = size * size * 4 * (1 + 1 / 3) * (normalBytes ? 2 : 1);
console.log(
  `Im Grafikspeicher unkomprimiert etwa ${(vram / 1024 / 1024).toFixed(1)} MiB ` +
    `(mit Mipmaps). Das ist die Zahl, die die Texturformat-Matrix drücken soll.`,
);
console.log(
  `\nEintrag f\u00fcr die Bodenebene der Karte:\n` +
    `  "texture": "textures/${name}/albedo.webp",\n` +
    (normalBytes ? `  "normal":  "textures/${name}/normal.webp",\n` : '') +
    `  "roughness": ${roughnessValue}`,
);
console.log(`\nDanach: npm run manifest`);
