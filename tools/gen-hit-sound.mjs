#!/usr/bin/env node
/**
 * Erzeugt die Trefferklänge — synthetisch, ohne Aufnahme.
 *
 * Ein Einschlag besteht aus drei Dingen, und alle drei lassen sich rechnen:
 *
 *   **Der Knall.** Ein kurzer Rauschstoß, der in Millisekunden verfällt. Er
 *   trägt die Härte; ohne ihn klingt jeder Treffer weich und weit weg.
 *
 *   **Der Schlag.** Ein tiefer Sinus, der schnell abfällt. Er gibt dem Ton
 *   Körper — man hört, dass etwas Masse hat.
 *
 *   **Der Nachklang.** Ein zweiter, etwas höherer Ton mit längerem Abfall.
 *   Ohne ihn endet der Treffer abrupt und klingt nach Knacken.
 *
 * Warum gerechnet und nicht aufgenommen: für einen Einschlag braucht es keine
 * Aufnahme, wohl aber Varianten. Ein kritischer Treffer soll heller und
 * härter klingen als ein gewöhnlicher, ein tödlicher tiefer und länger — und
 * das sind hier drei Zahlen statt drei Aufnahmen.
 *
 *   node tools/gen-hit-sound.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'assets', 'audio');

let ffmpeg;
try {
  ffmpeg = (await import('ffmpeg-static')).default;
} catch {
  console.error('Zum Erzeugen fehlt ffmpeg. Einmalig: npm i -D ffmpeg-static');
  process.exit(1);
}

/**
 * Eine Stimme des Einschlags.
 *
 * `knall` ist der Rauschanteil, `grund` und `ober` die beiden Sinusanteile.
 * Die Zahl hinter `exp(-t*…)` ist der Abfall: größer heißt kürzer.
 */
function ausdruck({ knallStaerke, knallAbfall, grundHz, grundAbfall, oberHz, oberAbfall }) {
  return [
    `(random(0)*2-1)*exp(-t*${knallAbfall})*${knallStaerke}`,
    `sin(2*PI*t*${grundHz})*exp(-t*${grundAbfall})*0.85`,
    `sin(2*PI*t*${oberHz})*exp(-t*${oberAbfall})*0.35`,
  ].join(' + ');
}

const varianten = [
  {
    name: 'treffer',
    dauer: 0.3,
    // Der gewöhnliche Treffer: mittlerer Schlag, kurzer Knall.
    stimme: {
      knallStaerke: 0.55,
      knallAbfall: 42,
      grundHz: 148,
      grundAbfall: 24,
      oberHz: 320,
      oberAbfall: 15,
    },
    // Tiefpass gegen die Schärfe des weißen Rauschens, Hochpass gegen den
    // Gleichanteil, den die Sinusanteile bei so kurzen Hüllkurven hinterlassen.
    filter: 'highpass=f=70,lowpass=f=4200',
  },
  {
    name: 'treffer_kritisch',
    dauer: 0.34,
    // Heller und härter: mehr Rauschen, höhere Töne, langsamerer Abfall.
    stimme: {
      knallStaerke: 0.8,
      knallAbfall: 30,
      grundHz: 196,
      grundAbfall: 19,
      oberHz: 540,
      oberAbfall: 12,
    },
    filter: 'highpass=f=90,lowpass=f=6500',
  },
  {
    name: 'treffer_toedlich',
    dauer: 0.55,
    // Tiefer und länger — ein Treffer, der etwas beendet.
    stimme: {
      knallStaerke: 0.6,
      knallAbfall: 22,
      grundHz: 96,
      grundAbfall: 11,
      oberHz: 210,
      oberAbfall: 7,
    },
    filter: 'highpass=f=45,lowpass=f=3200',
  },
];

await mkdir(outDir, { recursive: true });

for (const v of varianten) {
  const ziel = join(outDir, `${v.name}.mp3`);
  const res = spawnSync(
    ffmpeg,
    [
      '-y',
      '-f', 'lavfi',
      '-i', `aevalsrc=${ausdruck(v.stimme)}:d=${v.dauer}:s=32000`,
      // Reihenfolge zaehlt: **erst** verstaerken, **dann** begrenzen.
      // Andersherum kappt der Begrenzer bei 0,92 und die Verstaerkung hebt
      // das Ergebnis wieder darueber — das Ergebnis klippt hart, und man
      // sieht es nur daran, dass der Spitzenpegel exakt auf 0,0 dB liegt.
      //
      // Die Einblendung von zwei Millisekunden verhindert das Knacken am
      // Anfang; ein harter Start klickt hoerbar.
      '-af', `${v.filter},afade=t=in:st=0:d=0.002,volume=1.6,alimiter=limit=0.92`,
      '-ac', '1',
      '-codec:a', 'libmp3lame',
      '-b:a', '96k',
      ziel,
    ],
    { encoding: 'utf8' },
  );

  if (res.status !== 0) {
    console.error(res.stderr?.split('\n').slice(-12).join('\n'));
    process.exit(res.status ?? 1);
  }

  const info = await stat(ziel);
  console.log(`${v.name.padEnd(20)} ${(info.size / 1024).toFixed(1).padStart(6)} KiB, ${v.dauer}s`);
}

console.log(`\nToene in ${outDir}`);
