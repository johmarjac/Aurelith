#!/usr/bin/env node
/**
 * Bereitet eine Tondatei für die Auslieferung auf.
 *
 * Rohes PCM ist als Spielasset unbrauchbar: der Bogenschuss kam als
 * 1-Sekunden-Stereo-WAV mit 48 kHz und wog 187 KiB. Das ist mehr als der
 * gesamte wasm-Kern, für einen Ton, den man hundertmal pro Kampf hört.
 *
 * Zwei Eingriffe bringen das auf ein vernünftiges Maß:
 *
 *   **Mono.** Räumlich verteilt wird im Spiel, nicht in der Datei. Ein
 *   Stereo-Sample, das anschließend nach links oder rechts gezogen wird,
 *   trägt die doppelte Datenmenge für nichts.
 *
 *   **Verlustbehaftet.** MP3 statt PCM. Nicht Opus, obwohl es besser wäre:
 *   Safari nimmt Opus nur in bestimmten Behältern zuverlässig an, MP3 spielt
 *   jeder Browser seit zwanzig Jahren.
 *
 * Die Stille am Ende wird abgeschnitten. Sie kostet nicht nur Bytes, sondern
 * hält auch die Tonquelle länger am Leben als nötig.
 *
 *   node tools/pack-audio.mjs <quelle> --name bogen_schuss [--rate 96k]
 */

import { spawnSync } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'assets', 'audio');

const argv = process.argv.slice(2);
const source = argv.find((a) => !a.startsWith('--'));
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

if (!source) {
  console.error('Aufruf: node tools/pack-audio.mjs <quelle> --name <kennung> [--rate 96k]');
  process.exit(1);
}

const name = opt('name', undefined);
if (!name) {
  console.error('--name fehlt. Das ist die Kennung, unter der das Spiel den Ton kennt.');
  process.exit(1);
}

const bitrate = opt('rate', '96k');
// 32 kHz statt 48: für einen Ein-Sekunden-Effekt hört niemand den
// Unterschied, und MP3 kommt bei niedrigerer Abtastrate mit weniger Bits aus.
const sampleRate = opt('hz', '32000');
// Schwelle, ab der Stille als Stille gilt.
const silence = opt('stille', '-55dB');

// Wie lange ein Signal anhalten muss, um als Signal zu zaehlen.
//
// Ohne das entscheidet ein einzelner Knacks ueber die ganze Datei: beide
// gelieferten Aufnahmen haben am Ende einen Ausschlag von wenigen
// Millisekunden. Beim Bogen lag er knapp unter der Schwelle und wurde
// weggeschnitten, beim Schwert knapp darueber — und dort blieb dann eine
// halbe Sekunde Stille stehen. Eine Entscheidung, die an einem Dezibel
// kippt, ist keine.
const minSignal = opt('mindestsignal', '0.04');

let ffmpeg;
try {
  ffmpeg = (await import('ffmpeg-static')).default;
} catch {
  console.error('Zum Umwandeln fehlt ffmpeg. Einmalig: npm i -D ffmpeg-static');
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
const target = join(outDir, `${name}.mp3`);

const result = spawnSync(
  ffmpeg,
  [
    '-y',
    '-i', source,
    '-ac', '1',
    '-ar', sampleRate,
    // `reverse` zweimal: silenceremove schneidet nur am Anfang, also dreht
    // man die Spur um, schneidet den nun vorne liegenden Schwanz ab und
    // dreht zurück. Ein alter Trick, aber der kürzeste.
    '-af', [
      `silenceremove=start_periods=1:start_threshold=${silence}:start_duration=${minSignal}:start_silence=0.02`,
      'areverse',
      `silenceremove=start_periods=1:start_threshold=${silence}:start_duration=${minSignal}:start_silence=0.02`,
      'areverse',
    ].join(','),
    '-codec:a', 'libmp3lame',
    '-b:a', bitrate,
    target,
  ],
  { encoding: 'utf8' },
);

if (result.status !== 0) {
  console.error(result.stderr?.split('\n').slice(-15).join('\n'));
  process.exit(result.status ?? 1);
}

const before = (await stat(source)).size;
const after = (await stat(target)).size;

// Dauer nachmessen: schneidet die Stilleentfernung zu gierig, faellt es hier
// auf und nicht erst im Spiel.
const probe = spawnSync(
  ffmpeg,
  ['-hide_banner', '-i', target, '-f', 'null', '-'],
  { encoding: 'utf8' },
);
const dauer = /time=(\d+:\d+:\d+\.\d+)/.exec(probe.stderr ?? '')?.[1] ?? '?';

console.log(
  `${name}.mp3\n` +
    `  ${(before / 1024).toFixed(1)} KiB → ${(after / 1024).toFixed(1)} KiB ` +
    `(${((1 - after / before) * 100).toFixed(0)} % kleiner)\n` +
    `  Dauer ${dauer}, mono, ${sampleRate} Hz, ${bitrate}`,
);
