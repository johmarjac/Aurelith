/**
 * Beute am Boden — die Regeln, ohne Server und ohne Netz.
 *
 * `LootField` ist die Stelle, an der entschieden wird, wer was aufheben darf.
 * Das lässt sich hier in Millisekunden prüfen, wo derselbe Fall über den
 * laufenden Server eine Minute Kampf und einen Zufallswurf braucht.
 *
 *   npx tsx packages/server/test/loot_test.ts
 *
 * Die Gegenprobe steht am Ende: dieselben Prüfungen laufen noch einmal gegen
 * eine Fassung, die alles durchwinkt. Gehen sie auch damit durch, prüfen sie
 * nichts.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContent, tuning } from '@aurelith/shared';
import { LootField, type PickupResult } from '../src/loot.ts';

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

const T = tuning().loot;
const ERLEGER = 7;
const FREMDER = 9;

/** Ein Haufen an (0,0), abgelegt vom Erleger. */
function feld(now = 0): { field: LootField; id: number } {
  const field = new LootField();
  const pile = field.drop(
    { x: 0, y: 0, z: 0, item: 'mote_essence', count: 1, upgrade: 0, gold: 0, owner: ERLEGER },
    0,
    1,
    now,
  );
  return { field, id: pile.id };
}

// ---------------------------------------------------------------------------
// Ablegen
// ---------------------------------------------------------------------------

console.log('\nAblegen');

{
  const field = new LootField();
  const a = field.drop(
    { x: 5, y: 1, z: 5, item: 'mote_essence', count: 1, upgrade: 0, gold: 0, owner: ERLEGER },
    0,
    1,
    0,
  );
  check(a.x === 5 && a.z === 5, 'ein einzelner Haufen liegt genau am Kadaver', `${a.x}/${a.z}`);
  check(a.expiresAt === T.lifetimeSec * 1000, 'die Frist steht in den Stellschrauben');

  const feldZwei = new LootField();
  const b1 = feldZwei.drop(
    { x: 5, y: 1, z: 5, item: 'mote_essence', count: 1, upgrade: 0, gold: 0, owner: ERLEGER },
    0,
    2,
    0,
  );
  const b2 = feldZwei.drop(
    { x: 5, y: 1, z: 5, item: '', count: 0, upgrade: 0, gold: 3, owner: ERLEGER },
    1,
    2,
    0,
  );
  const abstand = Math.hypot(b1.x - b2.x, b1.z - b2.z);
  check(abstand > 0.5, 'zwei Haufen liegen nicht ineinander', `${abstand.toFixed(2)} Einheiten`);
  check(b1.id !== b2.id, 'und tragen verschiedene Kennungen');
}

// ---------------------------------------------------------------------------
// Aufheben
// ---------------------------------------------------------------------------

console.log('\nAufheben');

/**
 * Die Prüfungen als Funktion, damit sie zweimal laufen können: einmal gegen
 * die echte Prüfung, einmal gegen eine, die alles erlaubt.
 */
function pruefe(
  pruefer: (field: LootField, id: number, wer: number, x: number, z: number, now: number) => PickupResult,
): number {
  const vorher = failures;

  {
    const { field, id } = feld();
    check(pruefer(field, id, ERLEGER, 0, 0, 0).ok, 'direkt daneben geht es');
  }
  {
    const { field, id } = feld();
    const weit = T.pickupRange + 2;
    const r = pruefer(field, id, ERLEGER, weit, 0, 0);
    check(!r.ok && r.reason === 'zu weit', 'aus der Ferne nicht', r.ok ? 'erlaubt' : r.reason);
  }
  {
    const { field, id } = feld();
    const r = pruefer(field, id, FREMDER, 0, 0, 0);
    check(!r.ok && r.reason === 'fremd', 'ein Fremder muss warten', r.ok ? 'erlaubt' : r.reason);
  }
  {
    // Nach der Frist ist der Haufen frei — sonst blockierte ein Spieler, der
    // sich abmeldet, seine Beute bis zum Verfall.
    const { field, id } = feld();
    const spaeter = T.reserveSec * 1000 + 1;
    check(pruefer(field, id, FREMDER, 0, 0, spaeter).ok, 'nach der Frist darf jeder');
  }
  {
    const { field, id } = feld();
    const verfallen = T.lifetimeSec * 1000 + 1;
    const r = pruefer(field, id, ERLEGER, 0, 0, verfallen);
    check(!r.ok && r.reason === 'weg', 'ein verfallener Haufen ist weg', r.ok ? 'erlaubt' : r.reason);
  }
  {
    const { field } = feld();
    const r = pruefer(field, 999, ERLEGER, 0, 0, 0);
    check(!r.ok && r.reason === 'weg', 'eine erfundene Kennung auch', r.ok ? 'erlaubt' : r.reason);
  }

  return failures - vorher;
}

/*
 * Die Höhe kommt mit — die Prüfung misst seit dem Felsen im Raum. Hier steht
 * überall null: der Haufen liegt auf dem Boden und der Prüfling daneben, und
 * damit ist die senkrechte Lücke null und das Ergebnis dasselbe wie vorher.
 * Was die Höhe wirklich ausmacht, steht gleich darunter.
 */
pruefe((field, id, wer, x, z, now) => field.check(id, wer, x, 0, z, 1.8, now));

// ---------------------------------------------------------------------------
// Aus der Höhe hebt niemand auf
// ---------------------------------------------------------------------------

/*
 * Die Reichweite gilt im Raum und nicht auf der Karte.
 *
 * Auf der Karte liegt ein Haufen unter einem schwebenden Felsen genau da, wo
 * man oben steht — und mit einer flachen Reichweite räumte man von dort die
 * ganze Wiese ab, ohne hinunterzugehen. Dieselbe Verwechslung, die eine Horde
 * Keiler sechsundzwanzig Meter nach oben schlagen liess.
 */
console.log('\nAus der Höhe hebt niemand auf');

{
  const { field, id } = feld();
  // Direkt daneben, auf gleicher Höhe: das muss gehen.
  const nah = field.check(id, ERLEGER, 0, 0, 0, 1.8, 0);
  check(nah.ok, 'wer danebensteht, hebt auf', nah.ok ? '' : nah.reason);

  // Und derselbe Haufen von einem Felsen darüber aus: dieselbe Stelle auf der
  // Karte, sechsundzwanzig Meter höher.
  const hoch = field.check(id, ERLEGER, 0, 26, 0, 1.8, 0);
  check(!hoch.ok && hoch.reason === 'zu weit', 'vom Felsen darüber nicht', hoch.ok ? 'erlaubt' : hoch.reason);
}

// ---------------------------------------------------------------------------
// Wegnehmen und Verfallen
// ---------------------------------------------------------------------------

console.log('\nWegnehmen und Verfallen');

{
  const { field, id } = feld();
  check(field.size === 1, 'ein Haufen liegt da');
  // `check` allein nimmt nichts weg: der Inhalt kann in einem vollen Beutel
  // stecken bleiben, und dann muss der Haufen liegen bleiben.
  field.check(id, ERLEGER, 0, 0, 0, 1.8, 0);
  check(field.size === 1, 'prüfen allein nimmt nichts weg');
  field.take(id);
  check(field.size === 0, 'wegnehmen schon');
}

{
  const { field } = feld();
  field.expire(T.lifetimeSec * 1000 - 1);
  check(field.size === 1, 'vor der Frist bleibt er liegen');
  field.expire(T.lifetimeSec * 1000 + 1);
  check(field.size === 0, 'danach ist er weg');
}

{
  const field = new LootField();
  field.drop(
    { x: 0, y: 0, z: 0, item: 'mote_essence', count: 1, upgrade: 0, gold: 0, owner: ERLEGER },
    0,
    1,
    0,
  );
  field.drop(
    { x: 60, y: 0, z: 0, item: 'mote_essence', count: 1, upgrade: 0, gold: 0, owner: ERLEGER },
    0,
    1,
    0,
  );
  check(field.near(0, 0, 20).length === 1, 'nur was in Sichtweite liegt, geht in den Snapshot');
  check(field.near(0, 0, 100).length === 2, 'mit grösserem Umkreis beides');
}

// ---------------------------------------------------------------------------
// Gegenprobe
// ---------------------------------------------------------------------------

console.log('\nGegenprobe (alles erlaubt, muss auffallen)');

const still = failures;
const echtesLog = console.log;
console.log = () => undefined;
const gefunden = pruefe((field, id) => {
  const pile = field.get(id);
  return pile ? { ok: true, pile } : { ok: true, pile: undefined as never };
});
console.log = echtesLog;
failures = still;

check(gefunden > 0, 'die nachsichtige Fassung fällt durch', `${gefunden} Prüfungen schlagen an`);

console.log(failures === 0 ? '\nAlle Prüfungen bestanden.\n' : `\n${failures} Prüfung(en) fehlgeschlagen.\n`);
process.exit(failures === 0 ? 0 : 1);
