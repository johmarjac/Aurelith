#!/usr/bin/env node
/**
 * Packt ein glTF samt Puffer und Texturen in **eine** .glb-Datei.
 *
 * Warum überhaupt: geliefert werden Modelle meist als `scene.gltf` plus
 * `scene.bin` plus einen Ordner Texturen. Der Lader würde die Nebendateien
 * selbst nachholen — an unserem Asset-Streamer vorbei, ohne Version im
 * Query-String und ohne Prioritätsreihenfolge. Genau das soll er nicht: laut
 * Blueprint redet der Streamer mit dem CDN, und sonst niemand.
 *
 * Als .glb ist ein Modell eine Anfrage, ein Eintrag im Manifest, ein Puffer im
 * Speicher. Der Lader bekommt Bytes und baut daraus die Szene, ohne je selbst
 * ins Netz zu greifen.
 *
 * Der Container ist schlicht: zwölf Byte Kopf, dann Abschnitte aus je acht Byte
 * Kopf und Inhalt. Zwei davon — das JSON und die Binärdaten. Beide auf vier
 * Byte ausgerichtet.
 *
 * `--max-textur=<px>` verkleinert Texturen dabei. Das ist kein Schnickschnack:
 * gelieferte Modelle kommen fast immer mit 2048er oder 4096er Karten, auch
 * dann, wenn das Modell aus zweihundert Dreiecken besteht und die Textur aus
 * drei Farbflächen. Beim Holzschwert waren es 452 KiB für etwas, das bei
 * 256 Pixeln 14 KiB kostet und sich um weniger als ein Prozent unterscheidet —
 * gemessen, nicht geschätzt.
 *
 *   node tools/pack-glb.mjs <eingabe.gltf> <ausgabe.glb> [--max-textur=256]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const [inputPath, outputPath] = args.filter((a) => !a.startsWith('--'));
const maxTexture = Number(
  args.find((a) => a.startsWith('--max-textur='))?.split('=')[1] ?? '0',
);

if (!inputPath || !outputPath) {
  console.error('Aufruf: node tools/pack-glb.mjs <eingabe.gltf> <ausgabe.glb> [--max-textur=256]');
  process.exit(1);
}

let sharp;
if (maxTexture > 0) {
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.error('Zum Verkleinern der Texturen fehlt sharp. Einmalig: npm i -D sharp');
    process.exit(1);
  }
}

const baseDir = dirname(resolve(inputPath));
const gltf = JSON.parse(await readFile(inputPath, 'utf8'));

/** Sammelt die Binärabschnitte und liefert Ausrichtung und Grenzen. */
const chunks = [];
let binLength = 0;

function appendBinary(bytes) {
  const offset = binLength;
  chunks.push(bytes);
  binLength += bytes.length;

  // Jeder bufferView muss auf vier Byte ausgerichtet beginnen.
  const padding = (4 - (binLength % 4)) % 4;
  if (padding > 0) {
    chunks.push(Buffer.alloc(padding));
    binLength += padding;
  }
  return offset;
}

// --- Puffer -----------------------------------------------------------------
//
// Ein glTF kann mehrere Puffer haben; in einer .glb gibt es genau einen. Die
// bufferViews werden entsprechend umgehängt.

const bufferOffsets = [];
for (const buffer of gltf.buffers ?? []) {
  if (!buffer.uri) {
    // Schon eingebettet — kommt bei einer bereits gepackten Datei vor.
    bufferOffsets.push(0);
    continue;
  }
  if (buffer.uri.startsWith('data:')) {
    const base64 = buffer.uri.slice(buffer.uri.indexOf(',') + 1);
    bufferOffsets.push(appendBinary(Buffer.from(base64, 'base64')));
    continue;
  }
  bufferOffsets.push(appendBinary(await readFile(join(baseDir, decodeURIComponent(buffer.uri)))));
}

for (const view of gltf.bufferViews ?? []) {
  view.byteOffset = (view.byteOffset ?? 0) + bufferOffsets[view.buffer ?? 0];
  view.buffer = 0;
}

// --- Texturen ---------------------------------------------------------------

const mimeTypes = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

let textureBytes = 0;
for (const image of gltf.images ?? []) {
  if (!image.uri) continue;

  const uri = decodeURIComponent(image.uri);
  let data = uri.startsWith('data:')
    ? Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64')
    : await readFile(join(baseDir, uri));

  let extension = uri.split('.').pop()?.toLowerCase() ?? '';

  if (sharp) {
    const before = data.length;
    const meta = await sharp(data).metadata();
    const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
    if (longest > maxTexture) {
      // Als PNG mit Palette: die Karten dieser Modelle bestehen aus wenigen
      // Farbflächen, da holt eine Palette mehr heraus als JPEG — und ohne die
      // Artefakte an den Kanten zwischen den Flächen.
      data = await sharp(data)
        .resize(maxTexture, maxTexture, { fit: 'inside', kernel: 'lanczos3' })
        .png({ compressionLevel: 9, palette: true })
        .toBuffer();
      extension = 'png';
      image.mimeType = 'image/png';
      console.log(
        `  Textur ${longest}px → ${maxTexture}px: ${(before / 1024).toFixed(1)} → ${(data.length / 1024).toFixed(1)} KiB`,
      );
    }
  }

  textureBytes += data.length;
  const offset = appendBinary(data);

  gltf.bufferViews ??= [];
  gltf.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length });

  image.bufferView = gltf.bufferViews.length - 1;
  image.mimeType = image.mimeType ?? mimeTypes[extension] ?? 'image/png';
  delete image.uri;
}

const binary = Buffer.concat(chunks);
gltf.buffers = binary.length > 0 ? [{ byteLength: binary.length }] : [];

// --- Zusammensetzen ---------------------------------------------------------

// Das JSON wird mit Leerzeichen aufgefüllt, die Binärdaten mit Nullen — so
// steht es in der Spezifikation, und ein Lader, der das JSON blind einliest,
// stolpert sonst über die Füllbytes.
const jsonRaw = Buffer.from(JSON.stringify(gltf), 'utf8');
const jsonPad = (4 - (jsonRaw.length % 4)) % 4;
const json = Buffer.concat([jsonRaw, Buffer.alloc(jsonPad, 0x20)]);

const binPad = (4 - (binary.length % 4)) % 4;
const bin = Buffer.concat([binary, Buffer.alloc(binPad, 0)]);

const header = Buffer.alloc(12);
header.write('glTF', 0, 'ascii');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + (bin.length > 0 ? 8 + bin.length : 0), 8);

const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(json.length, 0);
jsonHeader.write('JSON', 4, 'ascii');

const parts = [header, jsonHeader, json];
if (bin.length > 0) {
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  // Der Abschnittstyp ist "BIN" gefolgt von einem Nullbyte, nicht "BIN ".
  binHeader.write('BIN\0', 4, 'ascii');
  parts.push(binHeader, bin);
}

const out = Buffer.concat(parts);
await mkdir(dirname(resolve(outputPath)), { recursive: true });
await writeFile(outputPath, out);

const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;
console.log(`${outputPath}  ${kib(out.length)}`);
console.log(`  JSON ${kib(json.length)}  Binärdaten ${kib(bin.length)}  davon Texturen ${kib(textureBytes)}`);
