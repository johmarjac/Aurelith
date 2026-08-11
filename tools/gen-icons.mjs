#!/usr/bin/env node
/**
 * Erzeugt die App-Symbole aus einer einzigen Zeichnung.
 *
 * Gebraucht werden sie, damit die Seite sich zum Home-Bildschirm legen lässt
 * und dann ohne Adressleiste startet. iOS nimmt für `apple-touch-icon`
 * ausschliesslich PNG — eine SVG wird schlicht ignoriert und man bekommt ein
 * Bildschirmfoto der Seite als Symbol.
 *
 * Die Ergebnisse sind versioniert. Dieses Skript ist kein Bauschritt, sondern
 * läuft von Hand, wenn sich die Zeichnung ändert:
 *
 *   node tools/gen-icons.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'packages', 'client', 'icons');

/**
 * Ein Tor: der Bogen, durch den man in Aurelith von Karte zu Karte geht.
 *
 * Bewusst grob — bei achtundvierzig Pixeln am Home-Bildschirm überlebt keine
 * Feinheit. Zwei Farben, eine Form, klarer Rand.
 */
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#16202a"/>
      <stop offset="1" stop-color="#080c10"/>
    </linearGradient>
    <linearGradient id="arch" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#6fe3d8"/>
      <stop offset="1" stop-color="#2c7d78"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.62" r="0.5">
      <stop offset="0" stop-color="#4cc9bf" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#4cc9bf" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="512" height="512" rx="96" fill="url(#ground)"/>
  <circle cx="256" cy="300" r="190" fill="url(#glow)"/>

  <!-- Der Torbogen. Offen nach unten, damit er als Durchgang lesbar ist. -->
  <path d="M138 400 V236 a118 118 0 0 1 236 0 V400"
        fill="none" stroke="url(#arch)" stroke-width="42" stroke-linecap="round"/>

  <!-- Der Schlussstein. Das einzige Gold im Bild, deshalb der Blickfang. -->
  <path d="M256 96 l30 52 -30 52 -30 -52 z" fill="#d8b84a"/>

  <rect x="104" y="398" width="304" height="26" rx="13" fill="#2c3a45"/>
</svg>`;

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('Für die Symbole fehlt sharp. Einmalig: npm i -D sharp');
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'icon.svg'), svg, 'utf8');

// 192 und 512 verlangt das Web-App-Manifest, 180 nimmt iOS für den
// Home-Bildschirm. Die Maskierbaren brauchen Luft am Rand, weil Android
// beliebig zuschneidet — dafür bekommen sie einen eigenen Rahmen.
const sizes = [
  { name: 'icon-192.png', size: 192, pad: 0 },
  { name: 'icon-512.png', size: 512, pad: 0 },
  { name: 'icon-maskable-512.png', size: 512, pad: 0.14 },
  { name: 'apple-touch-icon.png', size: 180, pad: 0 },
];

for (const { name, size, pad } of sizes) {
  const inner = Math.round(size * (1 - pad * 2));
  const border = Math.round((size - inner) / 2);

  let img = sharp(Buffer.from(svg)).resize(inner, inner);
  if (border > 0) {
    img = img.extend({
      top: border,
      bottom: border,
      left: border,
      right: border,
      background: '#0b1014',
    });
  }
  const out = await img.png({ compressionLevel: 9 }).toBuffer();
  await writeFile(join(outDir, name), out);
  console.log(`  ${name.padEnd(24)} ${(out.length / 1024).toFixed(1).padStart(7)} KiB`);
}

console.log(`\nSymbole in ${outDir}`);
