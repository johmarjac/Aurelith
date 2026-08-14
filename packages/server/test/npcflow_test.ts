/**
 * Rauchtest für den ganzen Weg: ansprechen, annehmen, erlegen, abgeben.
 *
 * Kein Browser. Der Test spricht das Binärprotokoll direkt — genau wie ein
 * Client, nur ohne Bild. Damit prüft er, was das Auftragsbuch allein nicht
 * kann: dass die Pakete stimmen, dass der Server die Entfernung prüft, dass
 * Beute ankommt und dass Belohnungen tatsächlich im Beutel landen.
 *
 *   npx tsx packages/server/test/npcflow_test.ts
 *
 * Der Server wird mit `AURELITH_START_POS` direkt neben Aurel gestartet.
 * Ohne das müsste der Test erst elf Einheiten weit laufen, und ein Testlauf,
 * der Gehwege abbildet, misst am Ende Gehwege.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { anmeldenUndBetreten, beobachteLobby, gruss } from './lib/anmelden.ts';
import {
  ClientOp,
  CipherSuite,
  EntityType,
  FrameSequencer,
  PROTOCOL_VERSION,
  QuestAction,
  QuestStatus,
  ServerOp,
  decodeFrame,
  decodeInventory,
  decodeNpcDialog,
  decodeQuestLog,
  decodeServerChat,
  decodeSnapshot,
  decodeStats,
  decodeWelcome,
  encodeFrame,
  encodeHello,
  encodeEquipItem,
  encodeInteract,
  encodeMoveItem,
  encodePickupLoot,
  encodeQuestAction,
  encodeShopTrade,
  encodeUpgradeItem,
  encodeInput,
  decodeOutfit,
  nullCipher,
  readPacket,
  type InventoryRow,
  type LootRow,
  type NpcDialogMsg,
  type Outfit,
  type QuestLogRow,
  type StatsMsg,
} from '@aurelith/shared';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 8791;

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Server hochfahren
// ---------------------------------------------------------------------------

const server = spawn('npx', ['tsx', join(root, 'packages/server/src/index.ts')], {
  cwd: root,
  env: {
    ...process.env,
    AURELITH_PORT: String(PORT),
    // Direkt neben Aurel (7, 9).
    AURELITH_START_POS: '7,11',
    DATABASE_URL: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});

const serverLog: string[] = [];
server.stdout.on('data', (d: Buffer) => serverLog.push(String(d)));
server.stderr.on('data', (d: Buffer) => serverLog.push(String(d)));

function shutdown(): void {
  try {
    process.kill(-server.pid!, 'SIGKILL');
  } catch {
    // Schon beendet.
  }
}
process.on('exit', shutdown);

const deadline = Date.now() + 60000;
while (Date.now() < deadline && !serverLog.join('').includes('bereit')) await sleep(200);
if (!serverLog.join('').includes('bereit')) {
  console.error(serverLog.join(''));
  throw new Error('Server kam nicht hoch');
}

// ---------------------------------------------------------------------------
// Ein sehr kleiner Client
// ---------------------------------------------------------------------------

const suite = new CipherSuite();
const txSeq = new FrameSequencer();
const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
socket.binaryType = 'arraybuffer';

const chat: string[] = [];
let dialog: NpcDialogMsg | undefined;
let questLog: QuestLogRow[] = [];
let inventory: InventoryRow[] = [];
let stats: StatsMsg | undefined;
let localId = 0;
/** Alles, was der Server als sichtbar meldet: Kennung → Art, Lage, Leben. */
const seen = new Map<
  number,
  { type: number; defId: string; hp: number; x: number; z: number; outfit: string }
>();
/**
 * Was gerade auf dem Boden liegt.
 *
 * Wird bei jedem Snapshot **ersetzt** und nicht ergänzt: der Server schickt
 * die vollständige Liste, und ein Test, der sie zusammenstückelt, prüfte am
 * Ende seine eigene Buchführung statt der des Servers.
 */
let loot: LootRow[] = [];
/** Wie viele Haufen im Verlauf höchstens gleichzeitig dalagen. */
let lootMax = 0;

function send(...packets: Uint8Array[]): void {
  socket.send(encodeFrame(packets, txSeq.next(), nullCipher));
}

socket.on('message', (data: ArrayBuffer | Buffer) => {
  const bytes = data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data);
  const frame = decodeFrame(bytes, suite);
  for (const raw of frame.packets) {
    const { opcode, reader } = readPacket(raw);
    switch (opcode) {
      case ServerOp.Welcome:
        localId = decodeWelcome(reader).entityId;
        break;
      case ServerOp.Snapshot: {
        const snap = decodeSnapshot(reader);
        for (const s of snap.spawns) {
          seen.set(s.id, {
            type: s.type,
            defId: s.defId,
            hp: s.hp,
            x: s.x,
            z: s.z,
            outfit: s.outfit,
          });
        }
        for (const u of snap.updates) {
          const row = seen.get(u.id);
          if (!row) continue;
          row.hp = u.hp;
          row.x = u.x;
          row.z = u.z;
        }
        for (const id of snap.despawns) seen.delete(id);
        loot = snap.loot;
        if (loot.length > lootMax) lootMax = loot.length;
        break;
      }
      case ServerOp.NpcDialog:
        dialog = decodeNpcDialog(reader);
        break;
      case ServerOp.QuestLog:
        questLog = decodeQuestLog(reader);
        break;
      case ServerOp.Inventory:
        inventory = decodeInventory(reader);
        break;
      case ServerOp.Stats:
        stats = decodeStats(reader);
        break;
      case ServerOp.Chat:
        chat.push(decodeServerChat(reader).text);
        break;
      default:
        break;
    }
  }
});

await new Promise<void>((resolve_, reject) => {
  socket.on('open', () => resolve_());
  socket.on('error', reject);
});

const name = `Pruefer${Math.floor(Date.now() % 100000)}`;
const anmeldung = beobachteLobby(socket, suite);
gruss(send);
await anmeldenUndBetreten(send, anmeldung, name);

const eingeloggt = Date.now() + 15000;
while (Date.now() < eingeloggt && localId === 0) await sleep(100);
if (localId === 0) throw new Error('Kein Welcome');
// Auf den ersten Snapshot warten, sonst ist die Welt noch leer.
while (Date.now() < eingeloggt && seen.size === 0) await sleep(100);

console.log('\nAnmeldung');
check(localId > 0, 'Willkommen erhalten', `Entity ${localId}`);
check(inventory.length > 0, 'Inventar kam an', `${inventory.length} Zeilen`);
check(questLog.length === 0, 'ein frischer Charakter hat keine Aufträge');

const zaehle = (itemId: string): number =>
  inventory.filter((i) => i.itemId === itemId).reduce((s, i) => s + i.count, 0);

// Angezogen von der ersten Sekunde an.
//
// Die Übungsweste liegt angelegt im Startbeutel. Sie war trotzdem unsichtbar,
// bis man sie einmal ab- und wieder anlegte: die Erscheinungszeile setzte nur
// Name und Waffe, das Outfit kam erst beim nächsten Ausrüstungswechsel dazu.
// Im Inventar stand „angelegt", in der Welt lief die Figur ohne — zwei
// Auskünfte über dieselbe Weste.
const eigenesOutfit = (): Outfit => decodeOutfit(seen.get(localId)?.outfit ?? '');
const weste = inventory.find((i) => i.itemId === 'training_vest');
check(weste?.equipped === true, 'die Übungsweste liegt angelegt im Beutel');
check(
  eigenesOutfit().chest !== undefined,
  'und die Figur trägt sie ohne weiteres Zutun',
  seen.get(localId)?.outfit || '(nichts)',
);

// Und sie nimmt keine Kachel im Beutel weg: der Beutel hat die Nummern 0 bis
// 29, was am Körper hängt liegt darüber. Vorher lag Angelegtes mitten im
// Raster, und wer vollständig ausgerüstet war, hatte ein Drittel weniger
// Beutel als jemand in Unterhose.
const beutelPlaetze = (
  JSON.parse(readFileSync(join(root, 'assets', 'content', 'tuning.json'), 'utf8')) as {
    economy: { inventorySlots: number };
  }
).economy.inventorySlots;
check(
  inventory.filter((i) => i.equipped).every((i) => i.slot >= beutelPlaetze),
  'Angelegtes liegt ausserhalb des Beutels',
  inventory
    .filter((i) => i.equipped)
    .map((i) => `${i.itemId}@${i.slot}`)
    .join(', '),
);
check(
  inventory.filter((i) => !i.equipped).every((i) => i.slot < beutelPlaetze),
  'und alles andere darin',
  `${beutelPlaetze} Kacheln`,
);

// --- Umsortieren -----------------------------------------------------------
//
// Ein Stück auf eine freie Kachel und zurück, dann zwei belegte tauschen. Was
// dabei nicht passieren darf, steht in den Gegenproben: ein angelegtes Stück
// lässt sich nicht ins Raster schieben, und aus dem Beutel heraus schon gar
// nicht.
const beutelZeilen = () => inventory.filter((i) => !i.equipped);
const belegteSlots = () => new Set(beutelZeilen().map((i) => i.slot));

/*
 * Zum Tauschen braucht es zwei belegte Kacheln — der Startbeutel hat nur eine.
 *
 * Er enthält Schwert und Weste (beide angelegt) und einen Stapel Tränke. Also
 * wird der Bogen... nein: das Schwert kurz abgelegt. Es landet im Beutel, und
 * damit gibt es zwei Zeilen zum Vertauschen. Das ist keine Verrenkung für den
 * Test, sondern die ehrlichere Vorbereitung: er soll nicht davon abhängen, wie
 * viele Sachen eine frische Figur zufällig mitbekommt.
 */
const schwertAmKoerper = inventory.find((i) => i.equipped && i.itemId === 'wooden_sword');
if (schwertAmKoerper) {
  send(encodeEquipItem(schwertAmKoerper.slot));
  const bisAbgelegt = Date.now() + 3000;
  while (Date.now() < bisAbgelegt && inventory.find((i) => i.itemId === 'wooden_sword')?.equipped)
    await sleep(50);
}
check(beutelZeilen().length >= 2, 'zwei Kacheln belegt', `${beutelZeilen().length} Zeilen`);

const erste = beutelZeilen()[0]!;
const freieKachel = (() => {
  const belegt = belegteSlots();
  for (let i = 0; i < beutelPlaetze; i++) if (!belegt.has(i)) return i;
  return -1;
})();

send(encodeMoveItem(erste.slot, freieKachel));
await sleep(500);
check(
  inventory.some((i) => i.itemId === erste.itemId && i.slot === freieKachel),
  'ein Gegenstand lässt sich auf eine freie Kachel legen',
  `${erste.itemId}: ${erste.slot} → ${freieKachel}`,
);

// Tauschen: zwei belegte Kacheln wechseln die Plätze, und beide Stücke sind
// hinterher noch da. Ein Zug, der eines davon verschluckt, wäre schlimmer als
// einer, der gar nichts tut.
const a = beutelZeilen()[0]!;
const b = beutelZeilen().find((i) => i.slot !== a.slot)!;
const vorTausch = { a: { id: a.itemId, slot: a.slot }, b: { id: b.itemId, slot: b.slot } };
// Gezählt vorher und nicht als feste Zahl: wie viel eine frische Figur
// mitbekommt, steht in der Gegenstandstabelle und ändert sich dort — eine 17
// im Test wäre eine zweite Angabe darüber.
const zeilenVorTausch = inventory.length;
send(encodeMoveItem(vorTausch.a.slot, vorTausch.b.slot));
await sleep(500);
check(
  inventory.some((i) => i.itemId === vorTausch.a.id && i.slot === vorTausch.b.slot) &&
    inventory.some((i) => i.itemId === vorTausch.b.id && i.slot === vorTausch.a.slot),
  'zwei belegte Kacheln tauschen ihre Plätze',
  `${vorTausch.a.id}↔${vorTausch.b.id}`,
);
check(
  inventory.length === zeilenVorTausch,
  'und dabei geht nichts verloren',
  `${inventory.length} von ${zeilenVorTausch} Zeilen`,
);

// Gegenprobe: ein angelegtes Stück liegt ausserhalb des Beutels und bleibt
// dort. Ginge das, könnte man sich per Paket ausziehen, ohne abzulegen.
//
// Genommen wird die Weste — das Schwert hängt seit dem Tauschversuch oben im
// Beutel, und ein Stück, das gar nicht angelegt ist, prüft hier nichts.
const westeSlot = inventory.find((i) => i.equipped)?.slot ?? -1;
const westeId = inventory.find((i) => i.equipped)?.itemId ?? '';
send(encodeMoveItem(westeSlot, freieKachel));
await sleep(500);
check(
  inventory.find((i) => i.itemId === westeId && i.equipped)?.slot === westeSlot,
  'ein angelegtes Stück lässt sich nicht ins Raster schieben',
  `${westeId} auf Platz ${westeSlot}`,
);

/*
 * Das Schwert zurück an die Hand.
 *
 * Es lag nur für den Tauschversuch im Beutel. Alles Weitere in dieser Datei
 * ist Kampf — Irrlichter erlegen, Beute, Erfahrung —, und mit blossen Fäusten
 * dauert das so lange, dass die Fristen darunter reissen. Der Fehlschlag sähe
 * dann aus wie ein Fehler im Kampf und wäre einer im Aufräumen.
 */
const schwertImBeutel = inventory.find((i) => !i.equipped && i.itemId === 'wooden_sword');
if (schwertImBeutel) {
  send(encodeEquipItem(schwertImBeutel.slot));
  const bisAngelegt = Date.now() + 3000;
  while (
    Date.now() < bisAngelegt &&
    !inventory.find((i) => i.itemId === 'wooden_sword')?.equipped
  ) {
    await sleep(50);
  }
}
check(
  inventory.find((i) => i.itemId === 'wooden_sword')?.equipped === true,
  'das Schwert ist wieder angelegt',
);

// Gegenprobe: eine Nummer ausserhalb des Beutels ist kein Ziel.
const vorherAussen = beutelZeilen()[0]!.slot;
send(encodeMoveItem(vorherAussen, beutelPlaetze + 5));
await sleep(500);
check(
  beutelZeilen().some((i) => i.slot === vorherAussen),
  'und ausserhalb des Beutels lässt sich nichts hinlegen',
);

// Gegenprobe: abgelegt verschwindet sie auch aus dem Bild. Ohne sie zeigte die
// Prüfung oben nur, dass irgendein Text in der Zeile steht.
if (weste) {
  send(encodeEquipItem(weste.slot));
  await sleep(600);
  check(eigenesOutfit().chest === undefined, 'abgelegt ist sie auch aus dem Bild verschwunden');
  send(encodeEquipItem(inventory.find((i) => i.itemId === 'training_vest')?.slot ?? weste.slot));
  await sleep(600);
  check(eigenesOutfit().chest !== undefined, 'und wieder angelegt ist sie wieder da');
}

// ---------------------------------------------------------------------------
// Ansprechen
// ---------------------------------------------------------------------------

console.log('\nGespräch mit Aurel');

const aurelId = [...seen].find(
  ([, e]) => e.type === EntityType.Npc && e.defId === 'npc_guide',
)?.[0];
check(aurelId !== undefined, 'Aurel steht in der Welt', String(aurelId));

send(encodeInteract(aurelId!));
const bisDialog = Date.now() + 5000;
while (Date.now() < bisDialog && !dialog) await sleep(50);

check(dialog !== undefined, 'der Server antwortet mit einem Gespräch');
check(dialog?.npcDefId === 'npc_guide', 'und zwar für Aurel', dialog?.npcDefId);
check(dialog?.shop === false, 'Aurel hat keinen Laden');
check(
  dialog?.quests[0]?.questId === 'q_irrlichter' &&
    dialog.quests[0]?.status === QuestStatus.Verfuegbar,
  '„Licht im Moor" wird angeboten',
);

// Ein Fantasiewesen anzusprechen darf nichts auslösen und nichts umwerfen.
dialog = undefined;
send(encodeInteract(999999));
await sleep(400);
check(dialog === undefined, 'eine unbekannte Kennung bringt keine Antwort');

// ---------------------------------------------------------------------------
// Annehmen
// ---------------------------------------------------------------------------

console.log('\nAuftrag annehmen');

send(encodeQuestAction('q_irrlichter', QuestAction.Annehmen));
const bisLog = Date.now() + 5000;
while (Date.now() < bisLog && questLog.length === 0) await sleep(50);

check(questLog.length === 1, 'der Auftrag steht im Log', `${questLog.length}`);
check(questLog[0]?.status === QuestStatus.Aktiv, 'und ist aktiv');
check(questLog[0]?.progress[0] === 0, 'noch ohne Fortschritt');

// Und ein Auftrag, dessen Vorgänger fehlt, wird abgelehnt — auch wenn der
// Client danach fragt. Das ist der eigentliche Punkt der Serverprüfung.
send(encodeQuestAction('q_essenzen', QuestAction.Annehmen));
await sleep(400);
check(questLog.length === 1, 'ein gesperrter Auftrag wird nicht angenommen', `${questLog.length}`);

// ---------------------------------------------------------------------------
// Erlegen
// ---------------------------------------------------------------------------

console.log('\nIrrlichter erlegen');

/**
 * Ein sehr kleiner Bot: zum nächsten Irrlicht laufen und zuschlagen.
 *
 * Nötig, weil der Startpunkt neben Aurel liegt und die Wiese siebzig Einheiten
 * weiter nördlich. Den Startpunkt gleich dorthin zu legen ginge auch — dann
 * liesse sich aber das Ansprechen nicht prüfen, und das ist die Hälfte des
 * Tests.
 */
let seq = 1;
function eingabe(moveX: number, moveZ: number, yaw: number, angriff: boolean): void {
  send(encodeInput({ seq: seq++, moveX, moveZ, yaw, buttons: angriff ? 1 : 0 }));
}

/** Ist schon etwas aufgehoben worden? Die Beute ist ein Wurf, kein Automatismus. */
const beute = (): boolean => chat.some((line) => line.startsWith('Aufgehoben:'));

/** Der nächstliegende Haufen, gemessen von der eigenen Figur. */
function naechsteBeute(): { row: LootRow; dist: number } | undefined {
  const selbst = seen.get(localId);
  if (!selbst) return undefined;
  let beste: { row: LootRow; dist: number } | undefined;
  for (const row of loot) {
    const d = Math.hypot(row.x - selbst.x, row.z - selbst.z);
    if (!beste || d < beste.dist) beste = { row, dist: d };
  }
  return beste;
}

// Weitergeschlagen wird, bis *beides* steht: der Auftrag erfüllt und
// mindestens ein Fundstück im Beutel. Bei fünfundvierzig Prozent je Irrlicht
// geht das fast immer in den ersten fünf auf — aber eben nicht immer, und ein
// Test, der in einem von zwanzig Läufen rot wird, ist schlimmer als keiner.
const bisErfuellt = Date.now() + 120000;
while (Date.now() < bisErfuellt && (questLog[0]?.status !== QuestStatus.Erfuellt || !beute())) {
  // Was in Reichweite liegt, wird eingesammelt. Das ist nicht nur Beiwerk:
  // seit die Beute am Boden liegt, kommt auch das Gold nur so herein, und
  // ohne Gold scheitert der Schmied weiter unten.
  const naeheste = naechsteBeute();
  if (naeheste && naeheste.dist <= 3) {
    send(encodePickupLoot(naeheste.row.id));
    await sleep(60);
  }

  const selbst = seen.get(localId);
  let ziel: { x: number; z: number } | undefined;
  let beste = Infinity;
  for (const [, e] of seen) {
    if (e.type !== EntityType.Monster || e.defId !== 'mote' || e.hp <= 0) continue;
    const d = Math.hypot(e.x - (selbst?.x ?? 0), e.z - (selbst?.z ?? 0));
    if (d < beste) {
      beste = d;
      ziel = e;
    }
  }

  if (!selbst || !ziel) {
    await sleep(100);
    continue;
  }

  const dx = ziel.x - selbst.x;
  const dz = ziel.z - selbst.z;
  const laenge = Math.hypot(dx, dz) || 1;
  const yaw = Math.atan2(dx, dz);

  // Innerhalb der Schwertreichweite stehenbleiben und zuschlagen, sonst laufen.
  if (laenge <= 1.6) eingabe(0, 0, yaw, true);
  else eingabe(dx / laenge, dz / laenge, yaw, laenge < 2.2);

  await sleep(50);
}

check(
  questLog[0]?.status === QuestStatus.Erfuellt,
  'nach fünf Irrlichtern ist der Auftrag abgabebereit',
  `Fortschritt ${questLog[0]?.progress[0]}`,
);
check(
  beute(),
  'aufgehobene Beute ist im Beutel gelandet',
  chat.filter((l) => l.startsWith('Aufgehoben:'))[0] ?? 'nichts',
);
check(lootMax > 0, 'Beute lag überhaupt einmal am Boden', `höchstens ${lootMax} Haufen gleichzeitig`);
check(
  chat.some((l) => l.startsWith('Aufgehoben:') && l.includes('Gold')),
  'auch Gold liegt am Boden und wird aufgehoben',
  chat.filter((l) => l.includes('Gold'))[0] ?? 'nichts',
);

// ---------------------------------------------------------------------------
// Was beim Aufheben nicht gehen darf
// ---------------------------------------------------------------------------

console.log('\nBeute: die Gegenproben');

// Eine erfundene Kennung. Der Server darf davon nichts merken — und vor allem
// nichts liefern.
const vorUnsinn = inventory.reduce((s_, i) => s_ + i.count, 0);
send(encodePickupLoot(9999999));
await sleep(400);
check(
  inventory.reduce((s_, i) => s_ + i.count, 0) === vorUnsinn,
  'eine erfundene Kennung liefert nichts',
);

// Und ein Haufen, der zu weit weg liegt. Damit einer da ist, wird einer
// abgelegt und dann davongelaufen — die Beute bleibt liegen, die Figur nicht.
const weit = naechsteBeute();
if (weit) {
  const selbst = seen.get(localId)!;
  const wegX = selbst.x - weit.row.x;
  const wegZ = selbst.z - weit.row.z;
  const l = Math.hypot(wegX, wegZ) || 1;
  const bisWeg = Date.now() + 20000;
  while (Date.now() < bisWeg) {
    const jetzt = seen.get(localId);
    if (!jetzt) break;
    if (Math.hypot(jetzt.x - weit.row.x, jetzt.z - weit.row.z) > 12) break;
    eingabe(wegX / l, wegZ / l, Math.atan2(wegX, wegZ), false);
    await sleep(50);
  }

  const vorFern = chat.length;
  const bestandVorFern = inventory.reduce((s_, i) => s_ + i.count, 0);
  send(encodePickupLoot(weit.row.id));
  await sleep(500);
  check(
    chat.slice(vorFern).some((line) => line.includes('zu weit weg')),
    'aus der Ferne lässt sich nichts aufheben',
    chat.slice(vorFern)[0] ?? 'keine Antwort',
  );
  // Nicht „der Haufen liegt noch da": er könnte inzwischen verfallen sein,
  // und ein Test, der an einer Frist hängt, wird irgendwann grundlos rot.
  // Der Beutel dagegen darf sich in keinem Fall gefüllt haben.
  check(
    inventory.reduce((s_, i) => s_ + i.count, 0) === bestandVorFern,
    'und nichts ist im Beutel gelandet',
  );
} else {
  // Kein Haufen übrig heisst: alles eingesammelt. Das ist kein Fehler, aber
  // die Gegenprobe fällt dann aus, und das soll im Protokoll stehen.
  console.log('  · kein Haufen mehr da — die Entfernungsprobe entfällt');
}

// ---------------------------------------------------------------------------
// Abgeben
// ---------------------------------------------------------------------------

console.log('\nAbgabe');

// Erst zurücklaufen. Aus siebzig Einheiten Entfernung abzugeben muss
// scheitern — und das ist keine Nebensache, sondern der Grund, warum der
// Server die Entfernung überhaupt prüft.
send(encodeQuestAction('q_irrlichter', QuestAction.Abgeben));
await sleep(400);
check(
  questLog[0]?.status === QuestStatus.Erfuellt,
  'aus der Ferne lässt sich nicht abgeben',
  `Zustand ${questLog[0]?.status}`,
);

const aurel = seen.get(aurelId!);
const bisAngekommen = Date.now() + 60000;
while (Date.now() < bisAngekommen) {
  const selbst = seen.get(localId);
  if (!selbst || !aurel) break;
  const dx = aurel.x - selbst.x;
  const dz = aurel.z - selbst.z;
  const laenge = Math.hypot(dx, dz);
  if (laenge <= 3.5) break;
  eingabe(dx / laenge, dz / laenge, Math.atan2(dx, dz), false);
  await sleep(50);
}

const goldVorher = stats?.gold ?? 0;
const traenkeVorher = zaehle('potion_hp_small');
const expVorher = stats?.exp ?? 0;
const stufeVorher = stats?.level ?? 1;

send(encodeQuestAction('q_irrlichter', QuestAction.Abgeben));
const bisFertig = Date.now() + 5000;
while (Date.now() < bisFertig && questLog[0]?.status !== QuestStatus.Abgeschlossen) await sleep(50);

check(questLog[0]?.status === QuestStatus.Abgeschlossen, 'der Auftrag ist abgeschlossen');
check((stats?.gold ?? 0) === goldVorher + 30, 'dreissig Gold sind angekommen', `${stats?.gold}`);
check(
  zaehle('potion_hp_small') === traenkeVorher + 2,
  'zwei Tränke sind angekommen',
  `${zaehle('potion_hp_small')}`,
);
// Nicht nur die Erfahrungszahl: die Belohnung kann eine Stufe auslösen, und
// dann steht der Zähler danach *niedriger*. Verglichen wird der Fortschritt,
// nicht der Rest.
check(
  (stats?.level ?? 1) > stufeVorher || (stats?.exp ?? 0) > expVorher,
  'Erfahrung ist gestiegen',
  `Stufe ${stufeVorher} → ${stats?.level}, EP ${expVorher} → ${stats?.exp}`,
);

// Zweimal abgeben darf nichts einbringen.
const goldNachher = stats?.gold ?? 0;
send(encodeQuestAction('q_irrlichter', QuestAction.Abgeben));
await sleep(500);
check((stats?.gold ?? 0) === goldNachher, 'zweimal abgeben bringt kein zweites Gold');

// ---------------------------------------------------------------------------
// Handel
// ---------------------------------------------------------------------------

console.log('\nHandel');

// Aurel hat keinen Laden, und Iselda steht zu weit weg — beides muss
// scheitern, ohne dass Gold verschwindet.
const vorHandel = stats?.gold ?? 0;
send(encodeShopTrade(0, 'iron_blade', 1));
await sleep(400);
check((stats?.gold ?? 0) === vorHandel, 'ohne Händler in der Nähe wird nicht gekauft');
check(zaehle('iron_blade') === 0, 'und nichts geliefert');

// ---------------------------------------------------------------------------
// Aufwerten
// ---------------------------------------------------------------------------

console.log('\nAufwerten');

const schwert = () => inventory.find((i) => i.itemId === 'wooden_sword');
check(schwert()?.upgrade === 0, 'das Holzschwert steht auf +0', String(schwert()?.upgrade));

// Aurel ist kein Schmied. Aus seiner Nähe darf nichts gehen.
const goldVorSchmied = stats?.gold ?? 0;
send(encodeUpgradeItem(schwert()!.slot));
await sleep(500);
check(schwert()?.upgrade === 0, 'ohne Schmied bleibt die Stufe stehen');
check((stats?.gold ?? 0) === goldVorSchmied, 'und das Gold auch');

// Bregan steht auf (16, -7).
const bregan = [...seen].find(([, e]) => e.type === EntityType.Npc && e.defId === 'npc_smith')?.[1];
check(bregan !== undefined, 'Bregan steht in der Welt');

const bisSchmied = Date.now() + 60000;
while (Date.now() < bisSchmied && bregan) {
  const selbst = seen.get(localId);
  if (!selbst) break;
  const dx = bregan.x - selbst.x;
  const dz = bregan.z - selbst.z;
  const laenge = Math.hypot(dx, dz);
  if (laenge <= 3.5) break;
  eingabe(dx / laenge, dz / laenge, Math.atan2(dx, dz), false);
  await sleep(50);
}

const goldBeimSchmied = stats?.gold ?? 0;
send(encodeUpgradeItem(schwert()!.slot));
const bisPlus = Date.now() + 5000;
while (Date.now() < bisPlus && schwert()?.upgrade === 0) await sleep(50);

// Der erste Schritt gelingt immer — die Tabelle sagt hundert Prozent.
check(schwert()?.upgrade === 1, 'der erste Versuch gelingt sicher', `+${schwert()?.upgrade}`);
check((stats?.gold ?? 0) < goldBeimSchmied, 'und kostet Gold', `${goldBeimSchmied} → ${stats?.gold}`);

// Der Schaden steigt mit. Die angelegte Waffe ist das Holzschwert, also muss
// sich der Angriffswert geändert haben, sobald sie aufgewertet ist.
//
// Abgelesen wird er aus der Attributtafel — dort, wo auch das
// Charakterfenster ihn hernimmt. Ein eigenes Feld daneben wäre eine zweite
// Zahl für dieselbe Sache.
const attribut = (id: string): number =>
  stats?.attributes.find((a) => a.id === id)?.gesamt ?? 0;
const angriffMitPlus = attribut('attackDamage');
check(angriffMitPlus > 0, 'der Angriffswert steht', String(angriffMitPlus));

// Und die Tafel nennt, woher er kommt: Grundwert plus das Stück in der Hand.
const angriffsZeile = stats?.attributes.find((a) => a.id === 'attackDamage');
check(
  (angriffsZeile?.quellen ?? []).some((q) => q.quelle.includes('Holzschwert')),
  'und die Tafel nennt das Holzschwert als Quelle',
  (angriffsZeile?.quellen ?? []).map((q) => `${q.quelle} +${q.flach}`).join(', '),
);
check(
  Math.abs(
    (angriffsZeile?.basis ?? 0) +
      (angriffsZeile?.quellen ?? []).reduce((sum, q) => sum + q.flach, 0) -
      (angriffsZeile?.gesamt ?? 0),
  ) < 0.001,
  'Grundwert und Beiträge ergeben genau die Summe',
);

// Bregans Ausstellungsstück: ein Holzschwert +10 für ein Goldstück. Es geht
// mit seiner Aufwertung in den Beutel — nicht als +0, das ein Sonderfall im
// Code wäre.
const goldVorKauf = stats?.gold ?? 0;
send(encodeShopTrade(0, 'wooden_sword', 1));
const bisGekauft = Date.now() + 5000;
while (Date.now() < bisGekauft && !inventory.some((i) => i.upgrade === 10)) await sleep(50);

const prunkstueck = inventory.find((i) => i.itemId === 'wooden_sword' && i.upgrade === 10);
check(prunkstueck !== undefined, 'das Holzschwert +10 liegt im Beutel');
check((stats?.gold ?? 0) === goldVorKauf - 1, 'und hat genau ein Gold gekostet', `${goldVorKauf} → ${stats?.gold}`);
check(
  inventory.filter((i) => i.itemId === 'wooden_sword').length >= 2,
  'es stapelt nicht mit dem gewöhnlichen Holzschwert',
);

// Etwas, das sich nicht aufwerten lässt, wird abgelehnt — und kostet nichts.
const trank = inventory.find((i) => i.itemId === 'potion_hp_small');
const goldVorTrank = stats?.gold ?? 0;
if (trank) {
  send(encodeUpgradeItem(trank.slot));
  await sleep(400);
  check((stats?.gold ?? 0) === goldVorTrank, 'ein Trank lässt sich nicht verstärken');
}

socket.close();
await sleep(200);
shutdown();

console.log(failures === 0 ? '\nAlle Prüfungen bestanden.\n' : `\n${failures} Prüfung(en) fehlgeschlagen.\n`);
process.exit(failures === 0 ? 0 : 1);
