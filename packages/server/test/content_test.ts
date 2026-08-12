/**
 * Prüft die Inhaltsdateien — und damit das, was der Übersetzer nicht mehr
 * prüfen kann.
 *
 * Solange Gegenstände, Monster, NPCs und Aufträge TypeScript waren, fiel ein
 * Tippfehler beim Bauen auf. Seit sie als JSON danebenliegen, fällt er sonst
 * erst auf, wenn jemand den Auftrag abgibt und keine Belohnung bekommt. Dieser
 * Test ist der Ersatz: er liest alle vier Dateien, löst jeden Verweis auf und
 * geht dabei auch durch die Karten — ein Spawner, der ein Monster nennt, das
 * es nicht gibt, ist derselbe Fehler.
 *
 *   npx tsx packages/server/test/content_test.ts
 *
 * Am Ende die Gegenprobe: absichtlich kaputte Dateien müssen abgelehnt werden.
 * Ein Parser, der alles annimmt, prüft nichts.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ITEMS,
  MOBS,
  NPCS,
  QUESTS,
  STARTER_INVENTORY,
  getItem,
  loadContent,
  parseItems,
  parseMobs,
  parseNpcs,
  parseQuests,
  parseMapDocument,
} from '@aurelith/shared';
import { loadContentFromDisk } from '../src/content.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const contentDir = join(repo, 'assets', 'content');
const mapsDir = join(repo, 'assets', 'maps');

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const json = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(join(contentDir, name), 'utf8'));

// ---------------------------------------------------------------------------
// Laden
// ---------------------------------------------------------------------------

console.log('\nLaden');

const summe = await loadContentFromDisk(contentDir);
check(summe.items > 0, 'Gegenstände geladen', String(summe.items));
check(summe.mobs > 0, 'Monster geladen', String(summe.mobs));
check(summe.npcs > 0, 'NPCs geladen', String(summe.npcs));
check(summe.quests > 0, 'Aufträge geladen', String(summe.quests));
check(STARTER_INVENTORY.length > 0, 'Startausrüstung geladen', String(STARTER_INVENTORY.length));

// Die Tabellen sind dieselben Objekte wie vorher — wer `ITEMS` importiert hat,
// bekommt nach dem Laden auch etwas darin zu sehen.
check(ITEMS.size === summe.items, 'ITEMS ist gefüllt');
check(MOBS.size === summe.mobs, 'MOBS ist gefüllt');
check(NPCS.size === summe.npcs, 'NPCS ist gefüllt');
check(QUESTS.size === summe.quests, 'QUESTS ist gefüllt');

// Stichprobe auf die Werte selbst: geladen heisst nicht richtig gelesen.
const schwert = getItem('wooden_sword');
check(schwert?.name === 'Holzschwert', 'ein Gegenstand hat seinen Namen', schwert?.name);
check(schwert?.attackDamage === 4, 'und seine Zahlen', String(schwert?.attackDamage));
check(schwert?.weaponRig === 'sword', 'und seine Waffenform', schwert?.weaponRig);
// Farbe als `#a9743f` in der Datei, als Zahl in der Tabelle.
check(schwert?.iconColor === 0xa9743f, 'Farben werden aus Hex gelesen', schwert?.iconColor.toString(16));

const bogen = getItem('wooden_bow');
check(bogen?.attackStyle === 'ranged', 'Fernwaffe bleibt Fernwaffe');
check(bogen?.attackRange === 18, 'mit ihrer Reichweite', String(bogen?.attackRange));
check(getItem('rusty_dagger')?.attackStyle === undefined, 'was nicht dasteht, bleibt offen');

// ---------------------------------------------------------------------------
// Verweise, auch über die Karten
// ---------------------------------------------------------------------------

console.log('\nVerweise');

const kartenDateien = (await readdir(mapsDir)).filter((f) => f.endsWith('.json'));
check(kartenDateien.length > 0, 'Karten gefunden', String(kartenDateien.length));

const fehlendeMobs: string[] = [];
const fehlendeNpcs: string[] = [];

for (const datei of kartenDateien) {
  const doc = parseMapDocument(JSON.parse(await readFile(join(mapsDir, datei), 'utf8')), datei);
  for (const spawner of doc.spawners) {
    if (!MOBS.has(spawner.mob)) fehlendeMobs.push(`${datei}: ${spawner.mob}`);
  }
  for (const npc of doc.npcs) {
    if (!NPCS.has(npc.def)) fehlendeNpcs.push(`${datei}: ${npc.def}`);
  }
}

check(fehlendeMobs.length === 0, 'jeder Spawner nennt ein bekanntes Monster', fehlendeMobs.join(', '));
check(fehlendeNpcs.length === 0, 'jeder NPC auf der Karte ist definiert', fehlendeNpcs.join(', '));

// ---------------------------------------------------------------------------
// Gegenprobe
// ---------------------------------------------------------------------------

console.log('\nGegenprobe (kaputte Dateien müssen auffallen)');

function lehntAb(was: string, fn: () => unknown): void {
  try {
    fn();
    check(false, `${was} wird abgelehnt`, 'ging durch');
  } catch (err) {
    check(true, `${was} wird abgelehnt`, (err as Error).message.split('\n')[0]);
  }
}

const items = (await json('items.json')) as { items: Record<string, unknown>[] };
const mobs = (await json('mobs.json')) as { mobs: Record<string, unknown>[] };
const npcs = (await json('npcs.json')) as { npcs: Record<string, unknown>[] };
const quests = (await json('quests.json')) as { quests: Record<string, unknown>[] };

lehntAb('fehlender Kopf', () => parseItems({ items: [] }));
lehntAb('fehlender Name', () =>
  parseItems({ ...items, items: [{ ...items.items[0], name: undefined }] }),
);
lehntAb('unbekannte Art', () =>
  parseItems({ ...items, items: [{ ...items.items[0], kind: 'zauberstab' }] }),
);
lehntAb('Zahl als Text', () =>
  parseMobs({ ...mobs, mobs: [{ ...mobs.mobs[0], maxHp: 'viel' }] }),
);
lehntAb('unmögliche Wahrscheinlichkeit', () =>
  parseMobs({ ...mobs, mobs: [{ ...mobs.mobs[0], drops: [{ item: 'mote_essence', chance: 2 }] }] }),
);
lehntAb('unbekannte Rolle', () =>
  parseNpcs({ ...npcs, npcs: [{ ...npcs.npcs[0], role: 'drache' }] }),
);
lehntAb('Auftrag ohne Ziel', () =>
  parseQuests({ ...quests, quests: [{ ...quests.quests[0], objectives: [] }] }),
);
lehntAb('unbekannte Zielart', () =>
  parseQuests({
    ...quests,
    quests: [{ ...quests.quests[0], objectives: [{ kind: 'tanzen', target: 'mote', count: 1 }] }],
  }),
);

// Und der Fall, für den `checkReferences` da ist: alles gut geformt, aber eine
// Kennung zeigt ins Leere. Genau das hat der Übersetzer früher gefunden.
lehntAb('Belohnung mit unbekanntem Gegenstand', () => {
  const kaputt = structuredClone(quests);
  (kaputt.quests[0] as { reward: { items: unknown[] } }).reward.items = [
    { item: 'potion_hp_smal', count: 1 },
  ];
  // Über `loadContent`, weil erst dort die Verweise geprüft werden — der
  // Parser allein kennt nur seine eigene Datei. Die Prüfung läuft vor dem
  // Eintragen, die geladenen Tabellen bleiben also heil.
  return loadContent({ items, mobs, npcs, quests: kaputt });
});

lehntAb('Auftrag von einem NPC, den es nicht gibt', () => {
  const kaputt = structuredClone(quests);
  (kaputt.quests[0] as { giver: string }).giver = 'npc_niemand';
  return loadContent({ items, mobs, npcs, quests: kaputt });
});

lehntAb('Beute, die kein Gegenstand ist', () => {
  const kaputt = structuredClone(mobs);
  (kaputt.mobs[0] as { drops: unknown[] }).drops = [{ item: 'gold_nugget', chance: 0.5 }];
  return loadContent({ items, mobs: kaputt, npcs, quests });
});

// Und zum Schluss: die echten Dateien gehen weiterhin durch. Sonst hätte die
// Gegenprobe oben womöglich nur bewiesen, dass alles abgelehnt wird.
check(
  loadContent({ items, mobs, npcs, quests }).items === ITEMS.size,
  'die echten Dateien gehen weiterhin durch',
);

console.log(failures === 0 ? '\nAlle Prüfungen bestanden.\n' : `\n${failures} Prüfung(en) fehlgeschlagen.\n`);
process.exit(failures === 0 ? 0 : 1);
