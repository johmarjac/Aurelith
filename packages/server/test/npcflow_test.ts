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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
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
  encodeInteract,
  encodeQuestAction,
  encodeShopTrade,
  encodeInput,
  nullCipher,
  readPacket,
  type InventoryRow,
  type NpcDialogMsg,
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
const seen = new Map<number, { type: number; defId: string; hp: number; x: number; z: number }>();

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
          seen.set(s.id, { type: s.type, defId: s.defId, hp: s.hp, x: s.x, z: s.z });
        }
        for (const u of snap.updates) {
          const row = seen.get(u.id);
          if (!row) continue;
          row.hp = u.hp;
          row.x = u.x;
          row.z = u.z;
        }
        for (const id of snap.despawns) seen.delete(id);
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
send(
  encodeHello({
    protocolVersion: PROTOCOL_VERSION,
    clientBuild: 'test',
    accountName: name,
    token: '',
    supportedCiphers: [0],
  }),
);

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

const bisErfuellt = Date.now() + 120000;
while (Date.now() < bisErfuellt && questLog[0]?.status !== QuestStatus.Erfuellt) {
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
  chat.some((line) => line.startsWith('Erhalten:')),
  'Beute ist im Beutel gelandet',
  chat.filter((l) => l.startsWith('Erhalten:'))[0] ?? 'nichts',
);

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

socket.close();
await sleep(200);
shutdown();

console.log(failures === 0 ? '\nAlle Prüfungen bestanden.\n' : `\n${failures} Prüfung(en) fehlgeschlagen.\n`);
process.exit(failures === 0 ? 0 : 1);
