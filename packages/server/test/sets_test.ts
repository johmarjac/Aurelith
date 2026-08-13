/**
 * Rüstungssätze — wann ein Satz zählt, und wann er leuchtet.
 *
 * Die Regel ist klein und wird an drei Stellen geglaubt: der Server rechnet
 * die Werte damit aus, die Sprechblase zeigt sie an, und die Aura am Körper
 * hängt an derselben Zahl. Deshalb steht sie in einer Funktion und wird hier
 * geprüft, statt über einen laufenden Server mit vier Schmiedegängen.
 *
 *   npx tsx packages/server/test/sets_test.ts
 *
 * Die Gegenprobe steht am Ende: dieselben Fälle laufen noch einmal gegen eine
 * Fassung, die jeden Satz gelten lässt und jede Stufe leuchten. Gehen sie auch
 * damit durch, prüfen sie nichts.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activeArmorSet,
  getArmorSet,
  glowFrom,
  glowStrength,
  loadContent,
  setGlowLevel,
  setOfItem,
  setProgress,
  type WornPiece,
} from '@aurelith/shared';

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
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const LEDER = getArmorSet('leder');
if (!LEDER) {
  console.error('Der Ledersatz fehlt in der Inhaltsdatei — ohne ihn prüft hier nichts.');
  process.exit(1);
}

/** Alle Teile des Ledersatzes auf derselben Stufe. */
function vollerSatz(stufe: number): WornPiece[] {
  return LEDER!.pieces.map((itemId) => ({ itemId, upgrade: stufe }));
}

// ---------------------------------------------------------------------------
// Zugehörigkeit
// ---------------------------------------------------------------------------

console.log('\nZugehörigkeit');

check(LEDER.pieces.length === 5, 'der Ledersatz hat fünf Teile', `${LEDER.pieces.length}`);
check(
  LEDER.pieces.every((id) => setOfItem(id)?.id === 'leder'),
  'jedes Teil kennt seinen Satz',
);
check(setOfItem('wooden_sword') === undefined, 'ein Holzschwert gehört zu keinem Satz');
check(
  setProgress(LEDER, [{ itemId: 'leather_cap', upgrade: 0 }]) === 1,
  'ein getragenes Teil zählt als eines',
);
check(
  setProgress(LEDER, [
    { itemId: 'leather_cap', upgrade: 0 },
    { itemId: 'leather_cap', upgrade: 3 },
  ]) === 1,
  'dasselbe Teil doppelt zählt trotzdem als eines',
);

// ---------------------------------------------------------------------------
// Wann der Satz gilt
// ---------------------------------------------------------------------------

console.log('\nWann der Satz gilt');

{
  const aktiv = activeArmorSet(vollerSatz(0));
  check(aktiv?.set.id === 'leder', 'alle Teile: der Satz gilt', aktiv?.set.id ?? 'keiner');
}

{
  const fastAlle = vollerSatz(0).slice(0, -1);
  check(activeArmorSet(fastAlle) === undefined, 'eines fehlt: der Satz gilt nicht');
}

{
  // Ein voller Satz plus Fremdteile ändert nichts: was zusätzlich getragen
  // wird, geht den Satz nichts an.
  const mitFremdem = [
    ...vollerSatz(2),
    { itemId: 'wooden_sword', upgrade: 5 },
    { itemId: 'copper_ring', upgrade: 0 },
  ];
  check(activeArmorSet(mitFremdem)?.set.id === 'leder', 'Fremdteile stören den Satz nicht');
}

check(activeArmorSet([]) === undefined, 'wer nichts trägt, trägt keinen Satz');

// ---------------------------------------------------------------------------
// Das schwächste Teil bestimmt die Stufe
// ---------------------------------------------------------------------------

console.log('\nDie Stufe hängt am schwächsten Teil');

{
  // Alle hoch bis auf eines — die Stufen kommen aus dem Satz selbst, damit die
  // Prüfung ein zusätzliches Teil überlebt.
  const gemischt = vollerSatz(9).map((teil, i) => (i === 0 ? { ...teil, upgrade: 3 } : teil));
  const aktiv = activeArmorSet(gemischt);
  check(aktiv?.minUpgrade === 3, 'lauter starke Teile und ein schwaches ergeben die schwache Stufe', `${aktiv?.minUpgrade}`);
  check(setGlowLevel(aktiv) === 0, 'und damit leuchtet nichts', `${setGlowLevel(aktiv)}`);
}

{
  const aktiv = activeArmorSet(vollerSatz(glowFrom()));
  check(setGlowLevel(aktiv) === glowFrom(), 'genau auf der Schwelle leuchtet es', `${setGlowLevel(aktiv)}`);
}

{
  const aktiv = activeArmorSet(vollerSatz(glowFrom() - 1));
  check(setGlowLevel(aktiv) === 0, 'eine Stufe darunter nicht', `${setGlowLevel(aktiv)}`);
}

check(setGlowLevel(undefined) === 0, 'ohne Satz leuchtet nichts');

{
  const schwach = glowStrength(setGlowLevel(activeArmorSet(vollerSatz(glowFrom()))));
  const stark = glowStrength(setGlowLevel(activeArmorSet(vollerSatz(10))));
  check(stark > schwach, 'höher aufgewertet leuchtet stärker', `${schwach.toFixed(2)} → ${stark.toFixed(2)}`);
  check(schwach > 0 && stark <= 1, 'und bleibt zwischen null und eins');
}

// ---------------------------------------------------------------------------
// Der Bonus
// ---------------------------------------------------------------------------

console.log('\nDer Bonus');

{
  const b = LEDER.bonus;
  const summe = b.attackDamage + b.defense + b.maxHp + b.maxMp + b.critChance;
  check(summe > 0, 'der Ledersatz gibt überhaupt etwas', JSON.stringify(b));
}

// ---------------------------------------------------------------------------
// Gegenprobe
// ---------------------------------------------------------------------------
//
// Eine Fassung, die alles durchwinkt: jeder Satz gilt, jede Stufe leuchtet.
// Mindestens eine der Prüfungen oben muss daran scheitern — sonst prüfen sie
// nur, dass die Funktionen sich aufrufen lassen.

console.log('\nGegenprobe');

function nachsichtigAktiv(worn: readonly WornPiece[]): { set: { id: string }; minUpgrade: number } | undefined {
  return worn.length > 0 ? { set: { id: 'leder' }, minUpgrade: 10 } : undefined;
}
function nachsichtigGlow(aktiv: { minUpgrade: number } | undefined): number {
  return aktiv?.minUpgrade ?? 0;
}

const gegenproben = [
  nachsichtigAktiv(vollerSatz(0).slice(0, -1)) === undefined,
  nachsichtigGlow(nachsichtigAktiv(vollerSatz(glowFrom() - 1))) === 0,
  nachsichtigGlow(
    nachsichtigAktiv(vollerSatz(9).map((teil, i) => (i === 0 ? { ...teil, upgrade: 3 } : teil))),
  ) === 0,
];
check(
  gegenproben.some((ok) => !ok),
  'die nachsichtige Fassung fällt durch',
  `${gegenproben.filter((ok) => !ok).length} von ${gegenproben.length} Fällen`,
);

console.log(
  failures === 0 ? '\nAlle Prüfungen bestanden.\n' : `\n${failures} Prüfung(en) fehlgeschlagen.\n`,
);
process.exit(failures === 0 ? 0 : 1);
