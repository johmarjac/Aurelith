/**
 * Prüft Auftragsstand und Beutel — ohne Server, ohne Netz, ohne Datenbank.
 *
 * Beides ist bewusst so gebaut, dass es sich einzeln prüfen lässt: der Beutel
 * ist eine Liste mit ein paar Funktionen darauf, das Auftragsbuch eine Klasse,
 * die nur die Content-Tabelle kennt. Was hier durchgeht, geht auch im Spiel
 * durch — und was hier durchfällt, hätte man sonst erst im Gespräch mit Aurel
 * gemerkt.
 *
 *   npx tsx packages/server/test/quests_test.ts
 *
 * Die Gegenprobe steht am Ende: dieselben Prüfungen gegen ein Buch, das
 * Fortschritt annimmt, aber nie den Zustand nachzieht.
 */

import { QuestStatus, getQuest, sellPrice } from '@aurelith/shared';
import {
  addItem,
  countItem,
  freeBagSlots,
  inventorySlots,
  normalizeSlots,
  removeItem,
} from '../src/inventory.ts';
import { loadContentFromDisk } from '../src/content.ts';
import { QuestBook } from '../src/quests.ts';
import type { ItemRecord } from '../src/db/index.ts';

// Die Tabellen stehen als JSON neben dem Spiel und nicht mehr im Quelltext.
// Ohne diesen Aufruf sind sie leer, und jede Prüfung hier prüfte das Nichts.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
await loadContentFromDisk(join(repo, 'assets', 'content'));

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------
// Beutel
// ---------------------------------------------------------------------------

console.log('\nBeutel');

{
  const items: ItemRecord[] = [];
  check(addItem(items, 'potion_hp_small', 3) === 3, 'drei Tränke passen hinein');
  check(addItem(items, 'potion_hp_small', 2) === 2, 'zwei weitere stapeln sich');
  check(countItem(items, 'potion_hp_small') === 5, 'fünf im Stapel', String(countItem(items, 'potion_hp_small')));
  check(items.length === 1, 'und zwar in einem Platz', `${items.length} Plätze belegt`);

  check(addItem(items, 'wooden_sword', 2) === 2, 'zwei Schwerter passen hinein');
  check(items.filter((i) => i.itemId === 'wooden_sword').length === 2, 'Waffen stapeln nicht');

  check(removeItem(items, 'potion_hp_small', 2), 'zwei Tränke gehen heraus');
  check(countItem(items, 'potion_hp_small') === 3, 'drei bleiben übrig');
  check(!removeItem(items, 'potion_hp_small', 99), 'was nicht da ist, geht nicht heraus');
  check(countItem(items, 'potion_hp_small') === 3, 'und der Beutel bleibt dabei unangetastet');

  // Angelegtes bleibt liegen. Sonst verkauft man beim Aufräumen die Waffe,
  // die man gerade in der Hand hält.
  const getragen: ItemRecord[] = [
    { itemId: 'iron_blade', count: 1, slot: 0, equipped: true, upgrade: 0 },
  ];
  check(!removeItem(getragen, 'iron_blade', 1), 'Angelegtes wird nicht herausgenommen');

  // Voller Beutel: was nicht mehr hineingeht, wird gemeldet und nicht still
  // verschluckt.
  const voll: ItemRecord[] = [];
  for (let i = 0; i < 30; i++) addItem(voll, 'wooden_sword', 1);
  check(voll.length === 30, 'dreissig Plätze sind belegt', String(voll.length));
  check(addItem(voll, 'iron_blade', 1) === 0, 'in einen vollen Beutel geht nichts mehr');

  // --- Angelegtes belegt keinen Platz ---------------------------------------
  //
  // Der Beutel hat die Nummern 0 bis 29, was am Körper hängt bekommt eine
  // darüber. Vorher lag Angelegtes mitten im Raster: wer vollständig
  // ausgerüstet war, hatte ein Drittel weniger Beutel als jemand in
  // Unterhose.
  const grenze = inventorySlots();
  const getragenImBeutel: ItemRecord[] = [
    { itemId: 'iron_blade', count: 1, slot: 3, equipped: true, upgrade: 0 },
    { itemId: 'leather_cap', count: 1, slot: 7, equipped: true, upgrade: 0 },
    { itemId: 'potion_hp_small', count: 1, slot: 4, equipped: false, upgrade: 0 },
  ];
  check(normalizeSlots(getragenImBeutel), 'ein alter Spielstand wird zurechtgerückt');
  check(
    getragenImBeutel.every((i) => (i.equipped ? i.slot >= grenze : i.slot < grenze)),
    'Angelegtes liegt danach ausserhalb des Beutels',
    getragenImBeutel.map((i) => `${i.itemId}@${i.slot}`).join(', '),
  );
  check(
    new Set(getragenImBeutel.map((i) => i.slot)).size === getragenImBeutel.length,
    'und keine zwei Stücke teilen sich eine Nummer',
  );
  check(
    getragenImBeutel.find((i) => i.itemId === 'potion_hp_small')?.slot === 4,
    'der Trank behält seinen Platz — umgezogen wird nur, wer muss',
  );
  // Gegenprobe: ein bereits stimmiger Beutel wird nicht angefasst. Ohne sie
  // wüsste man nicht, ob `normalizeSlots` etwas erkennt oder immer umräumt.
  check(!normalizeSlots(getragenImBeutel), 'ein zweiter Durchgang ändert nichts mehr');

  // Und der freie Platz zählt nur den Beutel: dreissig Kacheln, eine belegt.
  check(
    freeBagSlots(getragenImBeutel) === grenze - 1,
    'gezählt werden nur die Kacheln im Beutel',
    String(freeBagSlots(getragenImBeutel)),
  );

  // Voller Beutel plus Angelegtes: das Angelegte darf nichts wegnehmen.
  const vollMitRuestung: ItemRecord[] = [
    { itemId: 'iron_blade', count: 1, slot: 0, equipped: true, upgrade: 0 },
  ];
  normalizeSlots(vollMitRuestung);
  for (let i = 0; i < grenze; i++) addItem(vollMitRuestung, 'wooden_sword', 1);
  check(
    vollMitRuestung.filter((i) => !i.equipped).length === grenze,
    'trotz angelegter Klinge passen dreissig Stücke in den Beutel',
    String(vollMitRuestung.filter((i) => !i.equipped).length),
  );
  check(freeBagSlots(vollMitRuestung) === 0, 'und dann ist er voll');

  check(sellPrice({ value: 100 } as never) === 40, 'Verkaufspreis ist zwei Fünftel');
  check(sellPrice({ value: 1 } as never) === 1, 'und nie null');
  // Aufgewertetes bringt mehr — dieselbe Funktion, aus der auch der Laden
  // seinen angezeigten Preis nimmt.
  check(sellPrice({ value: 100 } as never, 4) === 96, 'und mit +4 deutlich mehr',
    String(sellPrice({ value: 100 } as never, 4)));
}

// ---------------------------------------------------------------------------
// Aufträge
// ---------------------------------------------------------------------------

console.log('\nAufträge annehmen');

const irrlichter = getQuest('q_irrlichter')!;
const haendlerin = getQuest('q_haendlerin')!;
const essenzen = getQuest('q_essenzen')!;
const keiler = getQuest('q_keiler')!;

{
  const buch = new QuestBook();
  const items: ItemRecord[] = [];

  check(buch.statusOf(irrlichter.id) === QuestStatus.Verfuegbar, 'unbekannt heisst verfügbar');
  check(buch.accept(irrlichter, 1, items), 'Stufe 1 darf „Licht im Moor" annehmen');
  check(!buch.accept(irrlichter, 1, items), 'zweimal annehmen geht nicht');
  check(buch.statusOf(irrlichter.id) === QuestStatus.Aktiv, 'läuft jetzt');

  check(!buch.accept(keiler, 1, items), 'zu niedrige Stufe wird abgelehnt');
  check(!buch.accept(haendlerin, 9, items), 'ohne Vorgänger wird abgelehnt');
}

console.log('\nFortschritt');

{
  const buch = new QuestBook();
  const items: ItemRecord[] = [];
  buch.accept(irrlichter, 1, items);

  check(buch.onKill('mote'), 'ein erlegtes Irrlicht zählt');
  check(!buch.onKill('thistle_boar'), 'ein Keiler zählt für diesen Auftrag nicht');
  for (let i = 0; i < 3; i++) buch.onKill('mote');
  check(buch.statusOf(irrlichter.id) === QuestStatus.Aktiv, 'vier von fünf reichen nicht');
  check(buch.onKill('mote'), 'das fünfte zählt');
  check(buch.statusOf(irrlichter.id) === QuestStatus.Erfuellt, 'fünf von fünf sind abgabebereit');
  check(!buch.onKill('mote'), 'darüber hinaus ändert sich nichts mehr');

  check(buch.canComplete(irrlichter), 'abgabebereit');
  check(buch.complete(irrlichter), 'Abgabe geht');
  check(buch.isDone(irrlichter.id), 'und gilt als abgeschlossen');
  check(!buch.complete(irrlichter), 'zweimal abgeben geht nicht');
  check(!buch.abandon(irrlichter.id), 'Abgeschlossenes lässt sich nicht aufgeben');
}

console.log('\nSammeln wird gemessen, nicht gezählt');

{
  const buch = new QuestBook();
  const items: ItemRecord[] = [];
  // Vorbedingungen setzen, damit „Kühles Leuchten" überhaupt annehmbar ist.
  buch.accept(irrlichter, 2, items);
  for (let i = 0; i < 5; i++) buch.onKill('mote');
  buch.complete(irrlichter);
  buch.accept(haendlerin, 2, items);
  buch.onTalk('npc_merchant');
  check(buch.statusOf(haendlerin.id) === QuestStatus.Erfuellt, 'Ansprechen erfüllt ein Redeziel');
  buch.complete(haendlerin);

  // Essenzen liegen schon im Beutel — der Auftrag muss das beim Annehmen sehen.
  addItem(items, 'mote_essence', 4);
  check(buch.accept(essenzen, 2, items), '„Kühles Leuchten" ist jetzt annehmbar');
  check(
    buch.statusOf(essenzen.id) === QuestStatus.Erfuellt,
    'vier bereits gesammelte Essenzen zählen sofort',
  );

  // Und wer sie wieder verkauft, ist nicht mehr abgabebereit. Ein Zähler, der
  // nur hochläuft, hätte das nicht bemerkt.
  removeItem(items, 'mote_essence', 2);
  check(buch.syncCollect(items), 'der Verkauf ändert den Stand');
  check(buch.statusOf(essenzen.id) === QuestStatus.Aktiv, 'und macht die Abgabe wieder unmöglich');
  check(!buch.canComplete(essenzen), 'abgeben geht jetzt nicht');

  addItem(items, 'mote_essence', 2);
  buch.syncCollect(items);
  check(buch.canComplete(essenzen), 'nachgekauft ist wieder abgabebereit');
}

console.log('\nGespräch');

{
  const buch = new QuestBook();
  const items: ItemRecord[] = [];

  const aurel = buch.dialogFor('npc_guide', 1);
  check(aurel.length === 1, 'Aurel bietet zunächst genau einen Auftrag an', `${aurel.length}`);
  check(aurel[0]?.questId === irrlichter.id, 'und zwar „Licht im Moor"');

  const bregan = buch.dialogFor('npc_smith', 1);
  check(bregan.length === 0, 'Bregan hat für Stufe 1 nichts', `${bregan.length}`);
  check(buch.dialogFor('npc_smith', 3).length === 1, 'ab Stufe 3 schon');

  buch.accept(irrlichter, 1, items);
  check(
    buch.dialogFor('npc_guide', 1)[0]?.status === QuestStatus.Aktiv,
    'angenommen zeigt Aurel den Fortschritt',
  );

  for (let i = 0; i < 5; i++) buch.onKill('mote');
  check(
    buch.dialogFor('npc_guide', 1)[0]?.status === QuestStatus.Erfuellt,
    'erfüllt steht die Abgabe zuoberst',
  );

  // „Erst zur Händlerin" wird bei Iselda abgegeben, nicht bei Aurel.
  buch.complete(irrlichter);
  buch.accept(haendlerin, 1, items);
  buch.onTalk('npc_merchant');
  const iselda = buch.dialogFor('npc_merchant', 1);
  check(
    iselda.some((q) => q.questId === haendlerin.id && q.status === QuestStatus.Erfuellt),
    'Iselda nimmt den Auftrag entgegen, den Aurel vergeben hat',
  );
  check(
    !buch.dialogFor('npc_guide', 1).some((q) => q.questId === haendlerin.id),
    'und Aurel bietet ihn nicht ein zweites Mal an',
  );
}

console.log('\nSpeichern und Laden');

{
  const buch = new QuestBook();
  const items: ItemRecord[] = [];
  buch.accept(irrlichter, 1, items);
  buch.onKill('mote');
  buch.onKill('mote');

  const zweites = new QuestBook();
  zweites.load(buch.records());
  check(zweites.statusOf(irrlichter.id) === QuestStatus.Aktiv, 'Zustand übersteht das Speichern');
  check(zweites.rows()[0]?.progress[0] === 2, 'Fortschritt auch', String(zweites.rows()[0]?.progress[0]));

  // Ein Auftrag, den es nicht mehr gibt, darf nichts kaputtmachen.
  zweites.load([{ questId: 'q_gibt_es_nicht', status: 1, progress: [3] }]);
  check(zweites.rows().length === 0, 'unbekannte Aufträge verschwinden still');
}

// ---------------------------------------------------------------------------
// Gegenprobe
// ---------------------------------------------------------------------------

console.log('\nGegenprobe (Buch ohne Zustandswechsel, muss auffallen)');

{
  /** Zählt Fortschritt, zieht aber den Zustand nie nach. */
  class KaputtesBuch extends QuestBook {
    override onKill(_mobId: string): boolean {
      return true;
    }
  }

  const buch = new KaputtesBuch();
  const items: ItemRecord[] = [];
  buch.accept(irrlichter, 1, items);
  for (let i = 0; i < 5; i++) buch.onKill('mote');
  const auffaellig = buch.statusOf(irrlichter.id) !== QuestStatus.Erfuellt;
  check(auffaellig, 'fünf Kills ohne Zustandswechsel bleiben unerfüllt — das fällt auf');
}

console.log(failures === 0 ? '\nAlle Prüfungen bestanden.\n' : `\n${failures} Prüfung(en) fehlgeschlagen.\n`);
process.exit(failures === 0 ? 0 : 1);
