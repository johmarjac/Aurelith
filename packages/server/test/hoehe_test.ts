/**
 * Wer oben aufhört, fängt oben wieder an.
 *
 * Gemeldet wurde beides: „wenn ich mich auf einem Felsen auslogge stehe ich
 * beim nächsten Login wieder drunter aufm Boden" und dasselbe auf dem Besen —
 * abgemeldet in der Luft, angemeldet am Boden, mit dem Gerät unter den Füssen.
 *
 * Der Grund war eine fehlende Spalte: gespeichert wurden `pos_x`, `pos_z` und
 * `yaw`, und die Höhe ergab sich beim Anmelden aus dem Gelände. Das stimmte,
 * solange es nur Gelände gab.
 *
 * Geprüft über die Leitung und über einen echten Abriss der Verbindung: die
 * Höhe geht durch Welt, Figurensatz, Speicher und wieder zurück, und jede
 * dieser vier Stationen hat den Fehler einzeln verursachen können.
 *
 * Die Gegenprobe steht am Ende und ist der halbe Test: nach einem Abstieg auf
 * den Boden muss dieselbe Figur auch **unten** wieder erscheinen. Ohne sie
 * wäre diese Datei auch mit einem Server zufrieden, der jeden auf vierzig
 * Meter setzt.
 *
 *   npx tsx packages/server/test/hoehe_test.ts
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { anmelden, anmeldenUndBetreten, beobachteLobby, gruss, type Anmeldung } from './lib/anmelden.ts';
import {
  ChatChannel,
  CipherSuite,
  FrameSequencer,
  ServerOp,
  decodeFrame,
  decodeInventory,
  decodeLobby,
  decodeSnapshot,
  decodeWelcome,
  encodeClientChat,
  encodeEnterWorld,
  encodeEquipItem,
  encodeFrame,
  nullCipher,
  readPacket,
  type InventoryRow,
  type LobbyMsg,
} from '@aurelith/shared';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 8801;
const KONTO = 'Hoehepruefer';
const PASSWORT = 'pruefer-passwort';

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Ein Besen in die Starterausrüstung. Die echten Inhaltsdateien bleiben
// unberührt — eine Prüfung, die den Spielinhalt ändert, prüft irgendwann ihn.
const quelle = join(root, 'assets', 'content');
const inhalt = mkdtempSync(join(tmpdir(), 'aurelith-hoehe-'));
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
    // `/tp` ist ein Werkzeug für Spielleiter. Ohne diese Zeile käme statt der
    // Versetzung eine Absage, und der Test prüfte die Absage.
    AURELITH_ADMINS: `${KONTO}:gamemaster`,
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

console.log('Aurelith — die Höhe übersteht das Abmelden\n');

/** Eine Verbindung samt allem, was dieser Test von ihr liest. */
interface Draht {
  socket: WebSocket;
  anmeldung: Anmeldung;
  send: (...pakete: Uint8Array[]) => void;
  /** Die Höhe der eigenen Figur aus dem letzten Schnappschuss. */
  hoehe: () => number | undefined;
  beutel: () => InventoryRow[];
  lobby: () => LobbyMsg | undefined;
}

async function verbinde(): Promise<Draht> {
  const suite = new CipherSuite();
  const txSeq = new FrameSequencer();
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  socket.binaryType = 'arraybuffer';

  let localId = 0;
  let hoehe: number | undefined;
  let beutel: InventoryRow[] = [];
  let lobby: LobbyMsg | undefined;

  socket.on('message', (data: ArrayBuffer | Buffer) => {
    const bytes = data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data);
    for (const raw of decodeFrame(bytes, suite).packets) {
      const { opcode, reader } = readPacket(raw);
      if (opcode === ServerOp.Welcome) {
        // Die alte Höhe gehört zur alten Verbindung. Bliebe sie stehen, läse
        // die Prüfung nach dem Wiederanmelden womöglich noch den Wert von
        // vorhin und wäre auch dann grün, wenn gar nichts mehr käme.
        hoehe = undefined;
        localId = decodeWelcome(reader).entityId;
      } else if (opcode === ServerOp.Lobby) lobby = decodeLobby(reader);
      else if (opcode === ServerOp.Inventory) beutel = decodeInventory(reader);
      else if (opcode === ServerOp.Snapshot) {
        const snap = decodeSnapshot(reader);
        for (const zeile of [...snap.spawns, ...snap.updates]) {
          if (zeile.id === localId) hoehe = zeile.y;
        }
      }
    }
  });

  await new Promise<void>((fertig, fehler) => {
    socket.on('open', () => fertig());
    socket.on('error', fehler);
  });

  const anmeldung = beobachteLobby(socket, suite);
  const send = (...pakete: Uint8Array[]): void => {
    socket.send(encodeFrame(pakete, txSeq.next(), nullCipher));
  };
  return { socket, anmeldung, send, hoehe: () => hoehe, beutel: () => beutel, lobby: () => lobby };
}

/** Wartet, bis eine Höhe da ist — oder gibt auf. */
async function warteAufHoehe(draht: Draht, ms = 15000): Promise<number | undefined> {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    const h = draht.hoehe();
    if (h !== undefined) return h;
    await sleep(50);
  }
  return undefined;
}

// --- 1. Anmelden, aufsteigen, hinaufsetzen ----------------------------------

console.log('Auf dem Besen in die Höhe');

const erste = await verbinde();
gruss(erste.send);
await anmeldenUndBetreten(erste.send, erste.anmeldung, KONTO, PASSWORT);

const bodenHoehe = await warteAufHoehe(erste);
if (bodenHoehe === undefined) throw new Error('Keine Höhe im ersten Schnappschuss');

const bis = Date.now() + 15000;
while (Date.now() < bis && erste.beutel().length === 0) await sleep(100);
const besen = erste.beutel().find((e) => e.itemId === 'flug_besen');
check(besen !== undefined, 'der Besen liegt im Beutel');
if (!besen) throw new Error('ohne Besen keine Prüfung');

// Aufsteigen dauert vier Sekunden — die Wartezeit gehört dem Server, siehe
// `vorgang_test`. Hier wird sie nur abgewartet.
erste.send(encodeEquipItem(besen.slot));
await sleep(4600);
check(
  erste.beutel().find((e) => e.itemId === 'flug_besen')?.equipped === true,
  'und nach der Wartezeit sitzt die Figur darauf',
);

const ZIEL = 40;
erste.send(encodeClientChat(ChatChannel.Say, `/tp 0 ${ZIEL} 0`));
await sleep(800);
const obenVorher = erste.hoehe() ?? Number.NaN;
check(
  Math.abs(obenVorher - ZIEL) < 1.5,
  'der Server führt sie danach in vierzig Metern',
  `y = ${obenVorher.toFixed(2)}`,
);
/*
 * Und der Boden liegt weit darunter. Ohne diese Zeile prüfte der Abschnitt
 * nach dem Wiederanmelden nichts: läge das Gelände hier zufällig auf vierzig
 * Metern, wäre auch ein Server grün, der die Höhe wegwirft und die Figur wie
 * früher auf das Gelände setzt.
 */
check(
  ZIEL - bodenHoehe > 10,
  'und der Boden liegt weit genug darunter, damit das etwas heisst',
  `Boden y = ${bodenHoehe.toFixed(2)}`,
);

// --- 2. Verbindung kappen und wiederkommen ----------------------------------

console.log('\nAbmelden und wieder anmelden');

erste.socket.close();
await sleep(800);

const zweite = await verbinde();
gruss(zweite.send);
anmelden(zweite.send, KONTO, PASSWORT);
const nachAnmeldung = Date.now() + 15000;
while (Date.now() < nachAnmeldung && !zweite.lobby()?.characters.length) await sleep(100);
const figur = zweite.lobby()?.characters[0];
if (!figur) throw new Error('Die Figur taucht in der Verwaltung nicht auf');
zweite.send(encodeEnterWorld(figur.id));

const obenNachher = await warteAufHoehe(zweite);
check(
  obenNachher !== undefined && Math.abs(obenNachher - ZIEL) < 1.5,
  'die Figur erscheint wieder in vierzig Metern',
  `y = ${obenNachher === undefined ? 'keine' : obenNachher.toFixed(2)}`,
);

// --- 3. Gegenprobe: unten bleibt unten --------------------------------------

/*
 * Dieselbe Figur, derselbe Weg, nur andersherum. Ohne diesen Abschnitt wäre
 * die Zeile darüber auch mit einem Server zufrieden, der jeden auf vierzig
 * Meter setzt — und dann stünde nach jedem Anmelden die halbe Welt in der
 * Luft.
 */
console.log('\nGegenprobe: wer unten aufhört, fängt unten an');

zweite.send(encodeClientChat(ChatChannel.Say, `/tp 0 ${bodenHoehe.toFixed(2)} 0`));
await sleep(800);
const untenVorher = zweite.hoehe() ?? Number.NaN;
check(
  untenVorher < bodenHoehe + 2,
  'abgestiegen steht sie wieder knapp über dem Gras',
  `y = ${untenVorher.toFixed(2)}`,
);

zweite.socket.close();
await sleep(800);

const dritte = await verbinde();
gruss(dritte.send);
anmelden(dritte.send, KONTO, PASSWORT);
const nochmal = Date.now() + 15000;
while (Date.now() < nochmal && !dritte.lobby()?.characters.length) await sleep(100);
const figur2 = dritte.lobby()?.characters[0];
if (!figur2) throw new Error('Die Figur taucht beim dritten Mal nicht auf');
dritte.send(encodeEnterWorld(figur2.id));

const untenNachher = await warteAufHoehe(dritte);
check(
  untenNachher !== undefined && untenNachher < bodenHoehe + 2,
  'und erscheint auch wieder dort und nicht in der Luft',
  `y = ${untenNachher === undefined ? 'keine' : untenNachher.toFixed(2)}`,
);

dritte.socket.close();
await sleep(200);

console.log(`\n${failures === 0 ? 'Alles gut.' : `${failures} Prüfung(en) fehlgeschlagen.`}`);
process.exit(failures === 0 ? 0 : 1);
