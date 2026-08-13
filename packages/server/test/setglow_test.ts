/**
 * Der leuchtende Rüstungssatz — über das Netz, so wie ihn andere sehen.
 *
 * `sets_test.ts` prüft die Regel: wann ein Satz gilt und welche Stufe ihn
 * leuchten lässt. Hier geht es um den Weg dorthin — dass der Server die Stufe
 * ausrechnet, wenn sich am Beutel etwas ändert, und dass sie im Schnappschuss
 * ankommt. Das ist der Teil, den keine reine Prüfung sehen kann: `setGlow`
 * steht in der vollen Zeile, und die schickt der Server nur, wenn er die Figur
 * als neu meldet.
 *
 *   npx tsx packages/server/test/setglow_test.ts
 *
 * Zwei Dinge werden für den Lauf zurechtgelegt, beide in einem eigenen
 * Inhaltsverzeichnis unter dem Temp-Ordner:
 *
 *   **Der Ledersatz liegt angelegt im Beutel.** Sonst bestünde der halbe Test
 *   aus vier Anlegen-Paketen, die `npcflow_test` ohnehin schon prüft.
 *
 *   **Aufwerten gelingt immer und kostet nichts.** Der Wurf gehört dem Server,
 *   und ein Test, der ihn abwartet, prüft irgendwann Wahrscheinlichkeiten
 *   statt Leuchten. Die Regel bleibt dieselbe — nur die Zahlen daneben sind
 *   für diesen Lauf entschärft.
 */

import { anmeldenUndBetreten, beobachteLobby, gruss } from './lib/anmelden.ts';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  CipherSuite,
  FrameSequencer,
  PROTOCOL_VERSION,
  ServerOp,
  decodeFrame,
  decodeInventory,
  decodeSnapshot,
  decodeWelcome,
  encodeFrame,
  encodeEquipItem,
  encodeHello,
  encodeUpgradeItem,
  nullCipher,
  readPacket,
  type InventoryRow,
} from '@aurelith/shared';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 8793;
/** Bregan steht auf (16, -7). Daneben stehen heisst: aufwerten geht. */
const START_POS = '17,-6';

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Inhalte für diesen Lauf zurechtlegen
// ---------------------------------------------------------------------------

const quelle = join(root, 'assets', 'content');
const inhalt = mkdtempSync(join(tmpdir(), 'aurelith-satz-'));
const lies = (name: string): any => JSON.parse(readFileSync(join(quelle, name), 'utf8'));

const items = lies('items.json');
const satz = (items.sets ?? []).find((s: { id: string }) => s.id === 'leder');
if (!satz) {
  console.error('Ohne den Ledersatz in items.json prüft dieser Test nichts.');
  process.exit(1);
}
const TEILE: string[] = satz.pieces;

// Alle vier Teile angelegt, damit der Satz von der ersten Sekunde an zählt.
items.starter = [
  ...items.starter.filter((s: { item: string }) => !TEILE.includes(s.item)),
  ...TEILE.map((item) => ({ item, count: 1, equipped: true })),
];

const werte = lies('tuning.json');
werte.upgrades.chances = werte.upgrades.chances.map(() => 1);
werte.upgrades.costBase = 0;
werte.upgrades.costPerLevel = 0;
werte.upgrades.costMinValue = 0;

writeFileSync(join(inhalt, 'items.json'), JSON.stringify(items));
writeFileSync(join(inhalt, 'tuning.json'), JSON.stringify(werte));
for (const name of ['mobs.json', 'npcs.json', 'quests.json']) {
  writeFileSync(join(inhalt, name), JSON.stringify(lies(name)));
}

// ---------------------------------------------------------------------------
// Server hochfahren
// ---------------------------------------------------------------------------

const server = spawn('npx', ['tsx', join(root, 'packages/server/src/index.ts')], {
  cwd: root,
  env: {
    ...process.env,
    AURELITH_PORT: String(PORT),
    AURELITH_CONTENT_DIR: inhalt,
    AURELITH_START_POS: START_POS,
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
  rmSync(inhalt, { recursive: true, force: true });
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

let localId = 0;
let inventory: InventoryRow[] = [];
/**
 * Die zuletzt gemeldete Leuchtstufe der eigenen Figur.
 *
 * Aus dem Schnappschuss und nicht aus dem Beutel gerechnet: die Frage lautet,
 * was **andere** sehen, und die haben nur diese eine Zahl.
 */
let setGlow: number | undefined;

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
          if (s.id === localId) setGlow = s.setGlow;
        }
        break;
      }
      case ServerOp.Inventory:
        inventory = decodeInventory(reader);
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
await anmeldenUndBetreten(send, anmeldung, `Satz${Math.floor(Date.now() % 100000)}`);

const eingeloggt = Date.now() + 15000;
while (Date.now() < eingeloggt && localId === 0) await sleep(100);
if (localId === 0) throw new Error('Kein Welcome');
while (Date.now() < eingeloggt && setGlow === undefined) await sleep(100);

// Die Schwelle aus derselben Datei, die der Server gerade eingelesen hat —
// dieser Prozess selbst lädt keine Inhalte, und eine hier eingetippte Vier
// stimmte nur so lange, bis jemand an den Stellschrauben dreht.
const SCHWELLE: number = werte.upgrades.glowFrom;

/** Der Beutelplatz eines Stücks. */
const platzVon = (itemId: string): number =>
  inventory.find((i) => i.itemId === itemId)?.slot ?? -1;

const stufeVon = (itemId: string): number =>
  inventory.find((i) => i.itemId === itemId)?.upgrade ?? -1;

console.log('\nAnmeldung');
check(localId > 0, 'Willkommen erhalten', `Entity ${localId}`);
check(
  TEILE.every((id) => inventory.find((i) => i.itemId === id)?.equipped === true),
  'der ganze Ledersatz liegt an',
);
check(setGlow === 0, 'und leuchtet noch nicht', String(setGlow));

// ---------------------------------------------------------------------------
// Aufwerten, Stück für Stück
// ---------------------------------------------------------------------------

/** Wertet ein Stück eine Stufe auf und wartet, bis der Beutel es bestätigt. */
async function aufwerten(itemId: string): Promise<void> {
  const vorher = stufeVon(itemId);
  send(encodeUpgradeItem(platzVon(itemId)));
  const bis = Date.now() + 8000;
  while (Date.now() < bis && stufeVon(itemId) === vorher) await sleep(50);
}

console.log('\nAlle Teile hoch bis auf eines');

// `slice(0, -1)` und nicht `slice(0, 3)`: wie viele Teile ein Satz hat, sagt
// die Inhaltsdatei. Als die Handschuhe dazukamen, blieb bei einer festen Drei
// ein weiteres Teil liegen, und die Prüfung darunter mass etwas anderes, als
// sie behauptete.
for (const teil of TEILE.slice(0, -1)) {
  for (let i = 0; i < SCHWELLE; i++) await aufwerten(teil);
}
// Auf die Antwort warten: die Stufe steht im Beutel, das Leuchten im
// Schnappschuss, und der kommt zehnmal je Sekunde.
await sleep(400);

check(
  TEILE.slice(0, -1).every((id) => stufeVon(id) === SCHWELLE),
  `${TEILE.length - 1} Teile stehen auf +${SCHWELLE}`,
  TEILE.map((id) => `${stufeVon(id)}`).join('/'),
);
check(
  setGlow === 0,
  'und trotzdem leuchtet nichts — ein Teil hängt hinterher',
  String(setGlow),
);

console.log('\nDas letzte Teil nach');

for (let i = 0; i < SCHWELLE; i++) await aufwerten(TEILE.at(-1)!);
await sleep(400);

check(setGlow === SCHWELLE, `jetzt leuchtet es — Stufe ${SCHWELLE}`, String(setGlow));

console.log('\nEins höher');

await aufwerten(TEILE[0]!);
await sleep(400);
check(
  setGlow === SCHWELLE,
  'ein einzelnes stärkeres Teil ändert nichts — das schwächste zählt',
  String(setGlow),
);

for (const teil of TEILE.slice(1)) await aufwerten(teil);
await sleep(400);
check(setGlow === SCHWELLE + 1, 'erst wenn alle nachziehen, wird es heller', String(setGlow));

// ---------------------------------------------------------------------------
// Und wieder aus
// ---------------------------------------------------------------------------
//
// Die Gegenprobe zum Ganzen: ein abgelegtes Teil macht den Satz unvollständig,
// und dann darf nichts mehr leuchten — egal, wie hoch der Rest steht.

console.log('\nEin Teil ausziehen');

send(encodeEquipItem(platzVon(TEILE[0]!)));
const bisAus = Date.now() + 8000;
while (Date.now() < bisAus && inventory.find((i) => i.itemId === TEILE[0])?.equipped) {
  await sleep(50);
}
await sleep(400);

check(setGlow === 0, 'ohne dieses eine Teil leuchtet nichts mehr', String(setGlow));

console.log(
  failures === 0 ? '\nAlle Prüfungen bestanden.\n' : `\n${failures} Prüfung(en) fehlgeschlagen.\n`,
);
socket.close();
shutdown();
process.exit(failures === 0 ? 0 : 1);
