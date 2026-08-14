/**
 * Pfeile: kaufen, verschiessen, aufbrauchen.
 *
 * Drei Regeln, die zusammen erst einen Bogen ergeben:
 *
 *   1. Pfeile gibt es bei der Händlerin, für ein Goldstück das Stück.
 *   2. Ein Bogen ohne Pfeile schiesst nicht — und sagt das auch.
 *   3. Jeder Schuss kostet genau einen Pfeil.
 *
 * Kein Browser, kein Bild: der Test spricht das Binärprotokoll wie ein Client.
 * Was hier geprüft wird, ist ohnehin nichts zum Ansehen — es sind Zahlen im
 * Beutel und eine Taste, die wirkt oder nicht.
 *
 * Ein Ziel braucht es dafür nicht. Ein Schlag beginnt im Kern ohne jede
 * Bedingung (siehe `combat.cpp`), und genau das ist die Stelle, an der ein
 * Pfeil die Sehne verlässt — ob er jemanden trifft, ist eine spätere Frage und
 * für die Munition keine.
 *
 *   npx tsx packages/server/test/pfeile_test.ts
 *
 * Der Server startet neben Iselda und mit diesem Konto als Verwalter: ohne
 * Gold kein Handel, und `/gg` gibt es erst ab Spielleiter.
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { anmeldenUndBetreten, beobachteLobby, gruss } from './lib/anmelden.ts';
import {
  CipherSuite,
  FrameSequencer,
  ServerOp,
  decodeFrame,
  decodeInventory,
  decodeServerChat,
  decodeSnapshot,
  decodeStats,
  decodeWelcome,
  encodeClientChat,
  encodeEquipItem,
  encodeFrame,
  encodeInput,
  encodeShopTrade,
  encodeUseItem,
  nullCipher,
  readPacket,
  type InventoryRow,
  type StatsMsg,
} from '@aurelith/shared';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 8793;
const name = `Bogen${Math.floor(Date.now() % 100000)}`;

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const server = spawn('npx', ['tsx', join(root, 'packages/server/src/index.ts')], {
  cwd: root,
  env: {
    ...process.env,
    AURELITH_PORT: String(PORT),
    // Iselda steht auf (-12, 13). Nah genug zum Handeln, weit genug, dass die
    // Figur nicht in ihr steht.
    AURELITH_START_POS: '-12,15',
    AURELITH_ADMINS: name,
    DATABASE_URL: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});

const serverLog: string[] = [];
server.stdout.on('data', (d: Buffer) => serverLog.push(String(d)));
server.stderr.on('data', (d: Buffer) => serverLog.push(String(d)));
process.on('exit', () => {
  try {
    process.kill(-server.pid!, 'SIGKILL');
  } catch {
    // Schon beendet.
  }
});

const deadline = Date.now() + 60000;
while (Date.now() < deadline && !serverLog.join('').includes('bereit')) await sleep(200);
if (!serverLog.join('').includes('bereit')) {
  console.error(serverLog.join(''));
  throw new Error('Server kam nicht hoch');
}

const suite = new CipherSuite();
const txSeq = new FrameSequencer();
const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
socket.binaryType = 'arraybuffer';

const chat: string[] = [];
let inventory: InventoryRow[] = [];
let stats: StatsMsg | undefined;
let localId = 0;

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
      case ServerOp.Snapshot:
        decodeSnapshot(reader);
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

const anmeldung = beobachteLobby(socket, suite);
gruss(send);
await anmeldenUndBetreten(send, anmeldung, name);

const eingeloggt = Date.now() + 15000;
while (Date.now() < eingeloggt && localId === 0) await sleep(100);
if (localId === 0) throw new Error('Kein Welcome');
await sleep(500);

const zaehle = (itemId: string): number =>
  inventory.filter((i) => i.itemId === itemId).reduce((s, i) => s + i.count, 0);
const bogen = (): InventoryRow | undefined => inventory.find((i) => i.itemId === 'wooden_bow');

let seq = 1;
/** Ein Eingabepaket. `angriff` ist die gedrückte Angriffstaste. */
function eingabe(angriff: boolean): void {
  send(encodeInput({ seq: seq++, moveX: 0, moveZ: 0, yaw: 0, buttons: angriff ? 1 : 0 }));
}

/** Hält die Angriffstaste für eine Weile gedrückt — wie ein Daumen auf dem Knopf. */
async function schiesse(ms: number): Promise<void> {
  const bis = Date.now() + ms;
  while (Date.now() < bis) {
    eingabe(true);
    await sleep(50);
  }
  eingabe(false);
  await sleep(300);
}

console.log('\nAusrüsten über die Aktionsleiste');

// Ein Bogen ist kein Trank — „benutzen" heisst hier anlegen. Auf der
// Aktionsleiste liegt beides nebeneinander, und ein Druck ist ein Druck.
check(bogen()?.equipped === false, 'der Holzbogen liegt unangelegt im Beutel');
send(encodeUseItem(bogen()!.slot));
await sleep(600);
check(bogen()?.equipped === true, 'ihn zu „benutzen" legt ihn an');
check(
  chat.every((z) => !z.includes('lässt sich nicht benutzen')),
  'und keine Absage dabei',
  chat.filter((z) => z.includes('benutzen')).join(' | '),
);

console.log('\nOhne Pfeile');

check(zaehle('arrow') === 0, 'der Startbeutel enthält keine Pfeile');
const vorher = chat.length;
await schiesse(1200);
check(
  chat.slice(vorher).some((z) => z.includes('Keine Pfeile')),
  'der Bogen sagt, dass der Köcher leer ist',
  chat.slice(vorher).join(' | ') || '(nichts gesagt)',
);

console.log('\nKaufen');

send(encodeClientChat(0, '/gg 50'));
await sleep(600);
check((stats?.gold ?? 0) >= 50, 'Gold für den Handel da', String(stats?.gold));

const goldVorKauf = stats?.gold ?? 0;
send(encodeShopTrade(0, 'arrow', 20));
const bisGekauft = Date.now() + 5000;
while (Date.now() < bisGekauft && zaehle('arrow') === 0) await sleep(50);

check(zaehle('arrow') === 20, 'zwanzig Pfeile im Beutel', String(zaehle('arrow')));
check(
  (stats?.gold ?? 0) === goldVorKauf - 20,
  'und sie haben ein Goldstück je Pfeil gekostet',
  `${goldVorKauf} → ${stats?.gold}`,
);
check(
  inventory.filter((i) => i.itemId === 'arrow').length === 1,
  'sie stapeln zu einem Posten',
);

console.log('\nSchiessen');

// Ein Schuss dauert eine Abklingzeit — beim Holzbogen 0,95 s. In zweieinhalb
// Sekunden gehen also zwei bis drei Pfeile weg. Geprüft wird der Bereich und
// nicht die genaue Zahl: die hinge sonst an der Bildrate der Prüfmaschine.
const vorSchuss = zaehle('arrow');
await schiesse(2500);
const verschossen = vorSchuss - zaehle('arrow');
check(
  verschossen >= 2 && verschossen <= 4,
  'jeder Schuss nimmt genau einen Pfeil',
  `${verschossen} Pfeile in 2,5 Sekunden`,
);

// Und der Rest muss weg sein können, ohne dass der Beutel etwas erfindet.
const langeGenug = Date.now() + 40000;
while (Date.now() < langeGenug && zaehle('arrow') > 0) await schiesse(2000);
check(zaehle('arrow') === 0, 'der Köcher lässt sich leerschiessen', String(zaehle('arrow')));

// Vier Sekunden Ruhe, bevor noch einmal gefragt wird.
//
// Der Hinweis hat eine Sperre — die Prüfung läuft zwanzigmal je Sekunde, und
// ohne sie stünde die Zeile zwanzigmal je Sekunde im Fenster. Beim
// Leerschiessen eben ist sie schon gefallen; wer sofort weiterfragt, misst die
// Sperre und nicht die Regel. Dass sie wieder aufmacht, ist hier die Aussage.
await sleep(4200);
const nachLeer = chat.length;
await schiesse(1500);
check(
  chat.slice(nachLeer).some((z) => z.includes('Keine Pfeile')),
  'danach sagt der Bogen wieder, dass nichts mehr da ist',
  chat.slice(nachLeer).join(' | ') || '(nichts gesagt)',
);
check(zaehle('arrow') === 0, 'und es entsteht kein Pfeil aus dem Nichts');

socket.close();
console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
