/**
 * Prüft die Pinsel — ohne Browser, ohne Bild.
 *
 * Was hier zählt: dass ein Strich genau dort wirkt, wo der Pinsel steht, nach
 * aussen ausläuft, mit der Pinselgrösse mitwächst, und dass gemalte Gewichte
 * sich gegenseitig verdrängen statt sich zu stapeln.
 *
 *   npx tsx packages/editor/test/brushes_test.ts
 */

import { MAX_GROUND_LAYERS, SCULPT_UNIT, worldToGrid } from '@aurelith/shared';
import {
  DEFAULT_BRUSH,
  brushFalloff,
  createPaintField,
  createSculptField,
  paintLayer,
  sculptRaise,
  sculptSmooth,
  type BrushSettings,
} from '../src/brushes.ts';

const SIZE = 512;

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Höhe an einem Stützpunkt, in Metern. */
function heightAt(
  field: { values: Int16Array; resolution: number },
  x: number,
  z: number,
): number {
  const ix = Math.round(worldToGrid(x, SIZE, field.resolution));
  const iz = Math.round(worldToGrid(z, SIZE, field.resolution));
  return field.values[iz * field.resolution + ix]! / SCULPT_UNIT;
}

function weightsAt(
  field: { values: Uint8Array; resolution: number },
  x: number,
  z: number,
): number[] {
  const ix = Math.round(worldToGrid(x, SIZE, field.resolution));
  const iz = Math.round(worldToGrid(z, SIZE, field.resolution));
  const base = (iz * field.resolution + ix) * MAX_GROUND_LAYERS;
  return Array.from({ length: MAX_GROUND_LAYERS }, (_, l) => field.values[base + l]!);
}

const brush = (over: Partial<BrushSettings> = {}): BrushSettings => ({ ...DEFAULT_BRUSH, ...over });

console.log('Aurelith — Pinsel\n');

// --- Auslauf ---------------------------------------------------------------
console.log('Auslauf');
{
  check(brushFalloff(0, 10, 0) === 1, 'Mitte voll');
  check(brushFalloff(10, 10, 0) === 0, 'Rand null');
  check(brushFalloff(20, 10, 0) === 0, 'ausserhalb null');

  const mid = brushFalloff(5, 10, 0);
  check(mid > 0 && mid < 1, 'dazwischen anteilig', mid.toFixed(3));

  // Haerter heisst: weiter aussen noch voll.
  check(
    brushFalloff(7, 10, 0.9) > brushFalloff(7, 10, 0.1),
    'Haerte schiebt den Abfall nach aussen',
    `${brushFalloff(7, 10, 0.9).toFixed(2)} vs ${brushFalloff(7, 10, 0.1).toFixed(2)}`,
  );

  // Monoton fallend — sonst gaebe es Ringe im Gelaende.
  let monotone = true;
  let prev = 1;
  for (let d = 0; d <= 10; d += 0.25) {
    const v = brushFalloff(d, 10, 0.4);
    if (v > prev + 1e-9) monotone = false;
    prev = v;
  }
  check(monotone, 'faellt monoton nach aussen');
}

// --- Heben und Senken ------------------------------------------------------
console.log('\nHeben und Senken');
{
  const field = createSculptField(SIZE);
  const touched = sculptRaise(field, SIZE, 0, 0, brush({ radius: 20, hardness: 0 }), 10);

  check(touched > 0, `Stuetzpunkte veraendert (${touched})`);
  check(heightAt(field, 0, 0) > 9.9, 'Mitte um zehn Meter angehoben', heightAt(field, 0, 0).toFixed(2));
  check(
    heightAt(field, 10, 0) > 0 && heightAt(field, 10, 0) < heightAt(field, 0, 0),
    'auf halbem Weg weniger',
    heightAt(field, 10, 0).toFixed(2),
  );
  check(heightAt(field, 40, 0) === 0, 'ausserhalb unberuehrt', heightAt(field, 40, 0).toFixed(2));

  // Senken ist dasselbe mit umgekehrtem Vorzeichen.
  sculptRaise(field, SIZE, 0, 0, brush({ radius: 20, hardness: 0 }), -10);
  check(Math.abs(heightAt(field, 0, 0)) < 0.02, 'Senken hebt das Heben auf', heightAt(field, 0, 0).toFixed(3));
}

{
  // Die Pinselgroesse muss wirken — das war die ausdrueckliche Anforderung.
  const small = createSculptField(SIZE);
  const large = createSculptField(SIZE);
  const nSmall = sculptRaise(small, SIZE, 0, 0, brush({ radius: 8 }), 5);
  const nLarge = sculptRaise(large, SIZE, 0, 0, brush({ radius: 40 }), 5);
  check(nLarge > nSmall * 4, 'grosser Pinsel fasst deutlich mehr an', `${nSmall} vs ${nLarge}`);
  check(heightAt(small, 20, 0) === 0, 'kleiner Pinsel reicht nicht bis 20');
  check(heightAt(large, 20, 0) > 0, 'grosser Pinsel reicht bis 20', heightAt(large, 20, 0).toFixed(2));
}

{
  // Am Rand der Karte darf nichts ueberlaufen.
  const field = createSculptField(SIZE);
  const n = sculptRaise(field, SIZE, -SIZE / 2, -SIZE / 2, brush({ radius: 30 }), 5);
  check(n > 0, 'Ecke laesst sich formen');
  check(heightAt(field, -SIZE / 2, -SIZE / 2) > 4.9, 'Ecke wird angehoben');
}

// --- Glaetten --------------------------------------------------------------
console.log('\nGlaetten');
{
  const field = createSculptField(SIZE);
  // Eine Stufe bauen: harter Pinsel, danach steht am Rand eine Kante.
  sculptRaise(field, SIZE, 0, 0, brush({ radius: 20, hardness: 0.95 }), 10);

  // Bei 129 Stuetzpunkten auf 512 Einheiten liegt alle vier Einheiten einer.
  // 16 liegt innerhalb des harten Kerns (voll angehoben), 24 ausserhalb des
  // Pinsels (unberuehrt) — dazwischen steht die Kante.
  const stepBefore = Math.abs(heightAt(field, 16, 0) - heightAt(field, 24, 0));
  for (let i = 0; i < 12; i++) sculptSmooth(field, SIZE, 20, 0, brush({ radius: 14 }), 0.5);
  const stepAfter = Math.abs(heightAt(field, 16, 0) - heightAt(field, 24, 0));

  check(stepAfter < stepBefore, 'Glaetten baut die Kante ab', `${stepBefore.toFixed(2)} → ${stepAfter.toFixed(2)}`);
}

// --- Malen -----------------------------------------------------------------
console.log('\nMalen');
{
  const field = createPaintField(SIZE);
  check(weightsAt(field, 0, 0).every((v) => v === 0), 'unbemalt ist alles null');

  paintLayer(field, SIZE, 0, 0, brush({ radius: 20, hardness: 1 }), 1, 1);
  const w = weightsAt(field, 0, 0);
  check(w[1]! > 250, 'gemalte Ebene deckt', String(w[1]));
  check(w[0] === 0 && w[2] === 0 && w[3] === 0, 'andere Ebenen bleiben leer', w.join('/'));
  check(weightsAt(field, 60, 0).every((v) => v === 0), 'ausserhalb unbemalt');
}

{
  // Verdraengen statt stapeln.
  const field = createPaintField(SIZE);
  paintLayer(field, SIZE, 0, 0, brush({ radius: 20, hardness: 1 }), 0, 1);
  // Mehrfach mit voller Deckung, damit die Annaeherung ankommt.
  for (let i = 0; i < 6; i++) paintLayer(field, SIZE, 0, 0, brush({ radius: 20, hardness: 1 }), 2, 1);

  const w = weightsAt(field, 0, 0);
  check(w[2]! > 250, 'die zuletzt gemalte Ebene setzt sich durch', String(w[2]));
  check(w[0]! < 5, 'die vorherige weicht', String(w[0]));
  const sum = w.reduce((a, b) => a + b, 0);
  check(sum <= 255 + 3, 'die Summe stapelt sich nicht auf', String(sum));
}

{
  // Ein zarter Strich soll zart sein.
  const field = createPaintField(SIZE);
  paintLayer(field, SIZE, 0, 0, brush({ radius: 20, hardness: 1 }), 1, 0.2);
  const w = weightsAt(field, 0, 0);
  check(w[1]! > 30 && w[1]! < 90, 'Deckung wirkt anteilig', String(w[1]));
}

{
  // Auch hier: die Pinselgroesse muss wirken.
  const small = createPaintField(SIZE);
  const large = createPaintField(SIZE);
  paintLayer(small, SIZE, 0, 0, brush({ radius: 8 }), 1, 1);
  paintLayer(large, SIZE, 0, 0, brush({ radius: 40 }), 1, 1);
  check(weightsAt(small, 24, 0)[1] === 0, 'kleiner Pinsel malt nicht bis 24');
  check(weightsAt(large, 24, 0)[1]! > 0, 'grosser Pinsel malt bis 24', String(weightsAt(large, 24, 0)[1]));
}

console.log(
  `\n${failures === 0 ? 'Alle Pruefungen bestanden.' : `${failures} Pruefung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
