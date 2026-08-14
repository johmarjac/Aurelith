#!/usr/bin/env node
/**
 * Erzeugt alles Bildliche der Marke aus **einer** Zeichnung.
 *
 * Die Quelle ist `packages/client/icons/aurelith.webp` — das Logo, so wie es
 * gezeichnet wurde: das goldene A mit dem blauen Stein, auf schwarzem Grund.
 * Alles andere hier ist davon abgeleitet und wird versioniert mitgeliefert;
 * dieses Skript ist kein Bauschritt, sondern läuft von Hand, wenn sich die
 * Zeichnung ändert:
 *
 *   node tools/gen-icons.mjs
 *
 * Zwei Sorten kommen dabei heraus, und der Unterschied ist nicht die Grösse:
 *
 *   - **Symbole** behalten den schwarzen Grund. Ein Home-Bildschirm braucht
 *     eine Fläche, keine freigestellte Form — ohne Grund liefe die Zeichnung
 *     auf hellen Hintergründen ins Leere.
 *   - **Das Logo** wird freigestellt. In der Anmeldemaske liegt es auf dem
 *     warmen Braun der Oberfläche; ein schwarzes Quadrat mittendrin sähe aus
 *     wie ein Ladefehler.
 *
 * Freigestellt wird über die Helligkeit und nicht über eine Farbwahl: der
 * Grund ist nahezu schwarz (Maximalkanal unter 10), das Blau des Steins liegt
 * an seiner dunkelsten Stelle noch bei 82. Dazwischen ist Platz für einen
 * weichen Übergang, und der nimmt die Treppenstufen an den Kanten gleich mit.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'packages', 'client', 'icons');
const quelle = join(dir, 'aurelith.webp');

/** Der Grund der Zeichnung. Steht hier, damit die Ränder nahtlos anschliessen. */
const GRUND = { r: 3, g: 5, b: 9 };

/** Unterhalb davon ist Grund, oberhalb ist Zeichnung. Dazwischen wird verblendet. */
const UNSICHTBAR = 10;
const SICHTBAR = 30;

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('Für die Symbole fehlt sharp. Einmalig: npm i -D sharp');
  process.exit(1);
}

await mkdir(dir, { recursive: true });

/**
 * Nimmt den schwarzen Grund weg.
 *
 * Der Alphakanal kommt aus dem hellsten Farbkanal des Bildpunkts. Das ist
 * dasselbe, was ein additiver Mischmodus täte — nur einmal ausgerechnet statt
 * bei jedem Bild, und ohne dass die Oberfläche dunkel sein muss.
 */
async function freistellen() {
  const { data, info } = await sharp(quelle)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let p = 0; p < info.width * info.height; p++) {
    const o = p * 4;
    const hell = Math.max(data[o], data[o + 1], data[o + 2]);
    const t = (hell - UNSICHTBAR) / (SICHTBAR - UNSICHTBAR);
    data[o + 3] = Math.round(Math.max(0, Math.min(1, t)) * 255);
  }

  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } });
}

/**
 * Die Zeichnung ohne ihren leeren Rand.
 *
 * Die Vorlage hat rundum viel Luft. Für ein Symbol von achtundvierzig
 * Bildpunkten ist das verschenkter Platz: das A wäre halb so gross wie es sein
 * könnte. Also erst wegschneiden, dann nach Bedarf wieder Rand geben.
 */
async function beschnitten() {
  return sharp(await (await freistellen()).png().toBuffer()).trim({ threshold: 1 });
}

const kern = await beschnitten();
const kernPng = await kern.png().toBuffer();
const { width: kw, height: kh } = await sharp(kernPng).metadata();
console.log(`Zeichnung freigestellt und beschnitten: ${kw}×${kh}\n`);

/**
 * Ein Symbol: die Zeichnung auf ihrem Grund, mittig, mit Rand.
 *
 * `rand` ist der Anteil, den die leere Fläche je Seite einnimmt. Die
 * maskierbare Fassung braucht davon mehr — Android schneidet daran beliebig
 * herum, und was am Rand steht, kann fehlen.
 */
async function symbol(size, rand) {
  const innen = Math.round(size * (1 - rand * 2));
  const bild = await sharp(kernPng)
    .resize(innen, innen, { fit: 'contain', background: { ...GRUND, alpha: 0 } })
    .toBuffer();

  return sharp({
    create: { width: size, height: size, channels: 4, background: { ...GRUND, alpha: 1 } },
  })
    .composite([{ input: bild, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

const symbole = [
  // 192 und 512 verlangt das Web-App-Manifest, 180 nimmt iOS für den
  // Home-Bildschirm, 48 der Browser für den Reiter.
  { name: 'icon-192.png', size: 192, rand: 0.08 },
  { name: 'icon-512.png', size: 512, rand: 0.08 },
  { name: 'icon-maskable-512.png', size: 512, rand: 0.2 },
  { name: 'apple-touch-icon.png', size: 180, rand: 0.08 },
  { name: 'favicon.png', size: 48, rand: 0.04 },
];

for (const { name, size, rand } of symbole) {
  const out = await symbol(size, rand);
  await writeFile(join(dir, name), out);
  console.log(`  ${name.padEnd(24)} ${(out.length / 1024).toFixed(1).padStart(7)} KiB`);
}

// Das freigestellte Logo für die Oberfläche. 512 breit: mehr braucht die
// Anmeldemaske auch auf einem groben Bildschirm nicht, und WebP hält das in
// derselben Grössenordnung wie ein PNG mit einem Viertel der Kantenlänge.
const logo = await sharp(kernPng).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 90 }).toBuffer();
await writeFile(join(dir, 'logo.webp'), logo);
console.log(`  ${'logo.webp'.padEnd(24)} ${(logo.length / 1024).toFixed(1).padStart(7)} KiB  (freigestellt)`);

console.log(`\nAus ${quelle}\nnach ${dir}`);
