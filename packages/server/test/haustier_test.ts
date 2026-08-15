/**
 * Begleiter — die Regeln, die der Server entscheidet.
 *
 * Was ein Haustier tut, hängt an drei Fragen, und alle drei werden hier
 * gestellt, ohne Welt, ohne Netz und ohne wasm:
 *
 *   1. Sind die beiden Tiere überhaupt richtig beschrieben? Ein Sammler ohne
 *      Umkreis und ein Haustier ohne pet-Block sind Fehler, die im Spiel als
 *      unsichtbares Nichts danebenherlaufen.
 *   2. Wann darf ein Sammler einem Haufen nachgehen — und wann ist der Mensch
 *      zu weit weg? Das ist die Regel, die den Gang abbricht.
 *   3. Was trägt ein Support-Tier bei? Es rechnet über dieselben Felder wie
 *      ein Ring, und genau das soll die Werteliste zeigen.
 *
 * Was hier **nicht** geprüft wird: das Laufen selbst. Der Weg über das Gelände
 * gehört dem Kern, und dessen native Prüfungen decken ihn ab. Die Kette bis
 * zum Bild — freilassen, danebenherlaufen, aufheben — prüft
 * `tools/smoke-haustier.mjs` im Browser.
 *
 *   npx tsx packages/server/test/haustier_test.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AttributeSheet,
  ContentFormatError,
  getItem,
  loadContent,
  parseItems,
} from '@aurelith/shared';
import { zielNochErlaubt, FOLGE_ABSTAND, SAMMEL_ABSTAND } from '../src/pets.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const datei = (name: string): unknown =>
  JSON.parse(readFileSync(join(repo, 'assets', 'content', name), 'utf8'));
loadContent({
  items: datei('items.json'),
  mobs: datei('mobs.json'),
  npcs: datei('npcs.json'),
  quests: datei('quests.json'),
  tuning: datei('tuning.json'),
  classes: datei('classes.json'),
});

let failures = 0;
function check(ok: boolean, was: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${was}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('Aurelith — Begleiter\n');

console.log('Die beiden Tiere');

const ratte = getItem('pet_ratte');
const fuchs = getItem('pet_fuchs');

check(ratte?.pet?.art === 'sammler', 'die Ratte ist ein Sammler', ratte?.pet?.art);
check(fuchs?.pet?.art === 'support', 'der Fuchs ist ein Support-Tier', fuchs?.pet?.art);
check((ratte?.pet?.sammelRadius ?? 0) > 0, 'der Sammler hat einen Umkreis', String(ratte?.pet?.sammelRadius));
check(
  ratte?.stackable === false && fuchs?.stackable === false,
  'beide sind Einzelstücke — freigelassen wird ein bestimmtes Tier',
);
check(
  ratte?.slot === 'none' && fuchs?.slot === 'none',
  'und keines wandert an einen Ausrüstungsplatz',
);

/*
 * Die Gegenproben zur Inhaltsprüfung.
 *
 * Dass die echten Dateien durchgehen, sagt für sich genommen nichts: eine
 * Prüfung, die alles durchwinkt, käme zum selben Ergebnis.
 */
const abgelehnt = (doc: unknown, was: string): boolean => {
  try {
    parseItems(doc, 'prüfung');
    return false;
  } catch (err) {
    return err instanceof ContentFormatError && String(err.message).length > 0 && was.length > 0;
  }
};

const grundgeruest = {
  format: 'aurelith.items',
  version: 1,
  items: [{ id: 'x', name: 'X', kind: 'material', slot: 'none' }],
};

check(
  abgelehnt(
    { ...grundgeruest, items: [{ id: 'x', name: 'X', kind: 'pet', slot: 'none' }] },
    'ohne Block',
  ),
  'ein Haustier ohne pet-Block wird abgelehnt',
);
check(
  abgelehnt(
    {
      ...grundgeruest,
      items: [
        { id: 'x', name: 'X', kind: 'material', slot: 'none', pet: { art: 'support', model: 'm' } },
      ],
    },
    'Block am Falschen',
  ),
  'und ein pet-Block an einem Nicht-Haustier auch',
);
check(
  abgelehnt(
    {
      ...grundgeruest,
      items: [
        {
          id: 'x',
          name: 'X',
          kind: 'pet',
          slot: 'none',
          pet: { art: 'sammler', model: 'm', sammelRadius: 0 },
        },
      ],
    },
    'Sammler ohne Umkreis',
  ),
  'ein Sammler ohne Umkreis ebenfalls',
);

console.log('\nWie weit ein Sammler gehen darf');

const heimweg = ratte?.pet?.heimweg ?? 18;

// Der Mensch steht im Ursprung. Ein Haufen dicht daneben ist erlaubt, einer
// jenseits der Leine nicht — und dazwischen liegt die Grenze.
check(zielNochErlaubt(0, 0, 5, 0, heimweg), 'ein Haufen in der Nähe ist erlaubt');
check(
  !zielNochErlaubt(0, 0, heimweg + 1, 0, heimweg),
  'einer jenseits der Leine nicht',
  `${heimweg + 1} > ${heimweg}`,
);
// Gemessen wird zwischen Mensch und Haufen, nicht zwischen Tier und Haufen:
// derselbe Haufen wird verboten, sobald der Mensch weiterläuft.
check(
  !zielNochErlaubt(heimweg + 2, 0, 0, 0, heimweg),
  'derselbe Haufen wird verboten, wenn der Mensch weiterläuft',
);

check(SAMMEL_ABSTAND < FOLGE_ABSTAND, 'aufgehoben wird näher, als gefolgt wird');

console.log('\nWas ein Support-Tier beiträgt');

/*
 * Gerechnet wird über dieselbe Tafel wie bei der Ausrüstung — deshalb steht
 * hier keine eingetippte Zahl, sondern die Erwartung aus derselben Datei, die
 * der Server liest.
 */
const sheet = new AttributeSheet();
sheet.basis('maxHp', 100);
sheet.basis('attackDamage', 10);
check(sheet.wert('maxHp') === 100, 'ohne Begleiter steht der Grundwert', String(sheet.wert('maxHp')));

sheet.fuege('maxHp', fuchs!.name, fuchs!.maxHp);
sheet.fuege('attackDamage', fuchs!.name, fuchs!.attackDamage);
check(
  sheet.wert('maxHp') === 100 + fuchs!.maxHp,
  'der Fuchs legt sein Leben obendrauf',
  `${sheet.wert('maxHp')} statt ${100 + fuchs!.maxHp}`,
);
check(
  sheet.wert('attackDamage') === 10 + fuchs!.attackDamage,
  'und seinen Schaden',
  `${sheet.wert('attackDamage')}`,
);
check(fuchs!.maxHp > 0 && fuchs!.attackDamage > 0, 'beides ist überhaupt etwas wert');

// Die Gegenprobe: der Sammler gibt nichts. Ohne sie ginge „jedes Tier gibt
// etwas" als Erfolg durch, und die Sorten wären nicht zu unterscheiden.
check(
  ratte!.maxHp === 0 && ratte!.attackDamage === 0 && ratte!.defense === 0,
  'der Sammler dagegen gibt keine Werte — er sammelt',
);

console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
