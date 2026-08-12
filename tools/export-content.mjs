#!/usr/bin/env node
/**
 * Einmalwerkzeug: schreibt die Inhaltstabellen als JSON heraus.
 *
 * Gebraucht wurde es genau einmal — beim Umzug der Tabellen aus dem
 * TypeScript-Quelltext nach `assets/content/`. Es steht trotzdem im Baum,
 * weil es die Herkunft der Dateien dokumentiert und weil derselbe Weg noch
 * einmal nötig wird, wenn Inhalte aus einer anderen Quelle kommen sollen.
 *
 *   npx tsx tools/export-content.mjs
 *
 * Liest die Tabellen über den Umweg des geteilten Pakets und schreibt sie
 * unverändert weg. Nichts wird dabei umgeformt: was hier herauskommt, muss
 * der Parser wieder genau so einlesen.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'assets', 'content');

const shared = await import('@aurelith/shared');

/** Kopfzeile jeder Datei — dieselbe Idee wie beim Kartenformat. */
function doc(key, list, extra = {}) {
  return { format: 'aurelith.content', version: 1, [key]: list, ...extra };
}

/**
 * Farben als `#rrggbb` statt als Dezimalzahl.
 *
 * JSON kennt keine Hexadezimalliterale, und `11105343` sagt niemandem etwas.
 * Der Parser nimmt beide Formen — geschrieben wird die lesbare.
 */
function farbenLesbar(eintrag) {
  const kopie = { ...eintrag };
  for (const feld of ['iconColor', 'tint', 'color']) {
    if (typeof kopie[feld] === 'number') {
      kopie[feld] = `#${kopie[feld].toString(16).padStart(6, '0')}`;
    }
  }
  return kopie;
}

await mkdir(outDir, { recursive: true });

const dateien = [
  [
    'items.json',
    doc('items', [...shared.ITEMS.values()].map(farbenLesbar), {
      // Die Startausrüstung gehört zu den Gegenständen: sie ist eine Liste von
      // Kennungen aus derselben Tabelle und hätte in einer eigenen Datei nur
      // eine weitere Stelle, an der ein Tippfehler unbemerkt bliebe.
      starter: [...shared.STARTER_INVENTORY],
    }),
  ],
  ['mobs.json', doc('mobs', [...shared.MOBS.values()])],
  ['npcs.json', doc('npcs', [...shared.NPCS.values()])],
  ['quests.json', doc('quests', [...shared.QUESTS.values()])],
];

for (const [name, inhalt] of dateien) {
  await writeFile(join(outDir, name), `${JSON.stringify(inhalt, null, 2)}\n`, 'utf8');
  const anzahl = Object.values(inhalt).find(Array.isArray)?.length ?? 0;
  console.log(`${name.padEnd(14)} ${String(anzahl).padStart(3)} Einträge`);
}

console.log(`\ngeschrieben nach ${outDir}`);
