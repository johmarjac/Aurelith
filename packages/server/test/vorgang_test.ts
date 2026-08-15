/**
 * Zwei Wartezeiten, die der **Server** durchsetzt.
 *
 * Beide sind im Client ebenfalls eingebaut — als grauer Knopf und als Balken —,
 * und genau deshalb steht diese Prüfung hier: was der Client tut, ist eine
 * Höflichkeit, was der Server tut, ist die Regel. Ein Wartebalken, den allein
 * der Client zeichnet, ist eine Bitte, vier Sekunden zu warten, und die
 * schlägt jeder aus, der seinen Client anfasst.
 *
 *   1. **Aufsteigen dauert vier Sekunden.** Direkt nach dem Doppelklick ist
 *      das Gerät noch **nicht** angelegt — das ist die eigentliche Aussage.
 *      Erst danach.
 *   2. **Heiltränke klingen ab.** Zweimal hintereinander geht nicht; eine
 *      Sekunde später schon. Die Zahl steht am Gegenstand und nicht im Code.
 *
 * Geprüft über die Leitung und nicht an der Funktion vorbei: die Wartezeit
 * hängt an `equipItem` und `useItem`, und beide erreicht man von aussen nur
 * so, wie ein Client es täte.
 *
 *   npx tsx packages/server/test/vorgang_test.ts
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  decodeVorgang,
  decodeWelcome,
  encodeEquipItem,
  encodeFrame,
  encodeUseItem,
  nullCipher,
  readPacket,
  type InventoryRow,
} from '@aurelith/shared';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 8798;

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Ein Besen in die Starterausrüstung. Die echten Inhaltsdateien bleiben
// unberührt — eine Prüfung, die den Spielinhalt ändert, prüft irgendwann ihn.
const quelle = join(root, 'assets', 'content');
const inhalt = mkdtempSync(join(tmpdir(), 'aurelith-vorgang-'));
for (const datei of readdirSync(quelle).filter((f) => f.endsWith('.json'))) {
  const daten = JSON.parse(readFileSync(join(quelle, datei), 'utf8')) as {
    starter?: Array<Record<string, unknown>>;
  };
  if (datei === 'items.json') daten.starter?.push({ item: 'flug_besen', count: 1, equipped: false });
  writeFileSync(join(inhalt, datei), JSON.stringify(daten));
}

const server = spawn('npx', ['tsx', join(root, 'packages/server/src/index.ts')], {
  cwd: root,
  env: {
    ...process.env,
    AURELITH_PORT: String(PORT),
    AURELITH_START_POS: '0,0',
    AURELITH_CONTENT_DIR: inhalt,
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

console.log('Aurelith — Vorgänge und Abklingzeiten\n');

const suite = new CipherSuite();
const txSeq = new FrameSequencer();
const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
socket.binaryType = 'arraybuffer';

let localId = 0;
let beutel: InventoryRow[] = [];
const vorgaenge: Array<{ art: string; dauerMs: number }> = [];
const meldungen: string[] = [];

const send = (...packets: Uint8Array[]): void => {
  socket.send(encodeFrame(packets, txSeq.next(), nullCipher));
};

socket.on('message', (data: ArrayBuffer | Buffer) => {
  const bytes = data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data);
  for (const raw of decodeFrame(bytes, suite).packets) {
    const { opcode, reader } = readPacket(raw);
    if (opcode === ServerOp.Welcome) localId = decodeWelcome(reader).entityId;
    else if (opcode === ServerOp.Inventory) beutel = decodeInventory(reader);
    else if (opcode === ServerOp.Vorgang) vorgaenge.push(decodeVorgang(reader));
    else if (opcode === ServerOp.Chat) meldungen.push(decodeServerChat(reader).text);
  }
});

await new Promise<void>((resolve_, reject) => {
  socket.on('open', () => resolve_());
  socket.on('error', reject);
});

const anmeldung = beobachteLobby(socket, suite);
gruss(send);
await anmeldenUndBetreten(send, anmeldung, `Vorgang${Math.floor(Date.now() % 100000)}`);

const bis = Date.now() + 15000;
while (Date.now() < bis && (localId === 0 || beutel.length === 0)) await sleep(100);
if (localId === 0 || beutel.length === 0) throw new Error('Kein Welcome oder kein Beutel');

// --- 1. Aufsteigen dauert ---------------------------------------------------

console.log('Aufsteigen');

const besen = beutel.find((e) => e.itemId === 'flug_besen');
check(besen !== undefined, 'der Besen liegt im Beutel');
if (!besen) throw new Error('ohne Besen keine Prüfung');

send(encodeEquipItem(besen.slot));
await sleep(600);

check(
  vorgaenge.some((v) => v.art === 'aufsteigen' && v.dauerMs === 4000),
  'der Server meldet einen Vorgang über vier Sekunden',
  vorgaenge.map((v) => `${v.art || '(ende)'}:${v.dauerMs}`).join(', '),
);
check(
  beutel.find((e) => e.itemId === 'flug_besen')?.equipped === false,
  'und nach einer halben Sekunde ist noch nichts angelegt',
);

await sleep(4200);
check(
  beutel.find((e) => e.itemId === 'flug_besen')?.equipped === true,
  'nach der Wartezeit sitzt er im Flugplatz',
);
check(
  vorgaenge.some((v) => v.dauerMs === 0),
  'und der Balken bekommt sein Ende gemeldet',
);

// Absteigen dagegen sofort — sonst wäre die Wartezeit ein Käfig.
const vorherEnden = vorgaenge.filter((v) => v.dauerMs === 0).length;
send(encodeEquipItem(beutel.find((e) => e.itemId === 'flug_besen')!.slot));
await sleep(600);
check(
  beutel.find((e) => e.itemId === 'flug_besen')?.equipped === false,
  'absteigen geht ohne Wartezeit',
);
check(
  vorgaenge.filter((v) => v.dauerMs === 0).length === vorherEnden,
  'und meldet gar keinen Vorgang',
);

// --- 2. Der Heiltrank ------------------------------------------------------

console.log('\nHeiltrank');

/*
 * Was hier **nicht** steht, und warum.
 *
 * Die eigentliche Regel — „zweimal hintereinander geht nicht" — verlangt einen
 * Trank, der wirkt, und der wirkt nur bei fehlendem Leben. Schaden gibt es auf
 * diesem Server nur aus dem Kampf: die Stufe hebt den Anteil mit (siehe
 * `setPlayerStats`), Sturz und Wasser tun nichts, und die Wesen um den
 * Startpunkt greifen von sich aus niemanden an. Ein Testbot, der sich erst
 * verprügeln lässt, hinge an der Karte und an ihrer Bestückung.
 *
 * Geprüft wird deshalb, was ohne Schaden entscheidbar ist — und das ist mehr
 * als nichts:
 *
 *   * Die Zahl steht am Gegenstand und ist damit je Trank einstellbar.
 *   * Eine **Absage kostet keine Abklingzeit**. Das ist keine Nebensache,
 *     sondern die Reihenfolge im Code: erst prüfen, dann heilen, dann die
 *     Frist setzen. Wäre sie vertauscht, sperrte ein Trank, der nichts
 *     bewirkt hat, den nächsten — und genau das fiele im Kampf auf, wo es
 *     wehtut.
 *
 * Die Wartezeit selbst gehört damit in die Prüfung von Hand: verletzt sein,
 * zweimal schnell trinken, die zweite Absage lesen.
 */
const traenke = (): number =>
  beutel.filter((e) => e.itemId === 'potion_hp_small').reduce((s, e) => s + e.count, 0);

const items = JSON.parse(readFileSync(join(inhalt, 'items.json'), 'utf8')) as {
  items: Array<{ id: string; cooldownSec?: number }>;
};
check(
  items.items.find((i) => i.id === 'potion_hp_small')?.cooldownSec === 1,
  'der kleine Heiltrank trägt eine Sekunde Abklingzeit im Inhalt',
);

const vorher = traenke();
const trankPlatz = beutel.find((e) => e.itemId === 'potion_hp_small')!.slot;
meldungen.length = 0;
send(encodeUseItem(trankPlatz));
await sleep(300);
check(traenke() === vorher, 'bei vollem Leben wird keiner verbraucht', `${vorher} → ${traenke()}`);
check(
  meldungen.some((m) => m.includes('würde jetzt nichts bewirken')),
  'und der Server sagt auch, warum',
  meldungen.join(' | '),
);

meldungen.length = 0;
send(encodeUseItem(trankPlatz));
await sleep(300);
check(
  meldungen.some((m) => m.includes('würde jetzt nichts bewirken')),
  'der zweite Versuch scheitert am selben Grund — eine Absage kostet keine Wartezeit',
  meldungen.join(' | '),
);
check(
  !meldungen.some((m) => m.includes('noch nicht bereit')),
  'und nicht an einer Abklingzeit, die nie hätte anlaufen dürfen',
);

socket.close();
console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
