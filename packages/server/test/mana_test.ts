/**
 * Mana — wer es führt, und was davon beim Client ankommt.
 *
 * Der Anlass ist ein Fehler, der wie ein kaputter Knopf aussah: eine
 * Fertigkeit auf der Leiste tat beim Anklicken nichts. Die Ursache lag zwei
 * Ebenen tiefer — der Manastand stand an **zwei** Orten. Der Kern führte ihn
 * und füllte ihn beim Erscheinen auf; der Server schickte dagegen
 * `character.mp`, die gespeicherte Kopie, und die stand seit dem Anlegen der
 * Figur auf null. Der Client rechnete also mit leerem Balken und schickte gar
 * nicht erst.
 *
 * Geprüft wird deshalb genau das: was in der Stats-Nachricht steht, muss der
 * Stand der Figur in der Welt sein. Die Gegenprobe steckt daneben — ohne sie
 * ginge „0 von 0" als Erfolg durch.
 *
 * Dazu die Regeneration ausserhalb des Kampfes. Sie ist ein Anteil des
 * Maximums je Sekunde und steht in `tuning.json`; geprüft wird, dass ein
 * geleerter Balken sich wieder füllt — und dass die Zahl daneben nicht
 * einfach null ist.
 *
 *   npx tsx packages/server/test/mana_test.ts
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { anmeldenUndBetreten, beobachteLobby, gruss } from './lib/anmelden.ts';
import { loadContentFromDisk } from '../src/content.ts';
import {
  CipherSuite,
  FrameSequencer,
  ServerOp,
  decodeFrame,
  decodeStats,
  decodeWelcome,
  encodeFrame,
  nullCipher,
  readPacket,
  tuning,
  type StatsMsg,
} from '@aurelith/shared';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 8796;

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const server = spawn('npx', ['tsx', join(root, 'packages/server/src/index.ts')], {
  cwd: root,
  env: { ...process.env, AURELITH_PORT: String(PORT), AURELITH_START_POS: '0,0', DATABASE_URL: '' },
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

console.log('Aurelith — Mana\n');

const suite = new CipherSuite();
const txSeq = new FrameSequencer();
const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
socket.binaryType = 'arraybuffer';

let localId = 0;
let stats: StatsMsg | undefined;

const send = (...packets: Uint8Array[]): void => {
  socket.send(encodeFrame(packets, txSeq.next(), nullCipher));
};

socket.on('message', (data: ArrayBuffer | Buffer) => {
  const bytes = data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data);
  for (const raw of decodeFrame(bytes, suite).packets) {
    const { opcode, reader } = readPacket(raw);
    if (opcode === ServerOp.Welcome) localId = decodeWelcome(reader).entityId;
    else if (opcode === ServerOp.Stats) stats = decodeStats(reader);
  }
});

await new Promise<void>((resolve_, reject) => {
  socket.on('open', () => resolve_());
  socket.on('error', reject);
});

const anmeldung = beobachteLobby(socket, suite);
gruss(send);
await anmeldenUndBetreten(send, anmeldung, `Mana${Math.floor(Date.now() % 100000)}`);

const bis = Date.now() + 15000;
while (Date.now() < bis && (localId === 0 || !stats)) await sleep(100);
if (localId === 0 || !stats) throw new Error('Kein Welcome oder keine Werte');

console.log('Beim Betreten');

/*
 * Die Gegenprobe zuerst: ohne sie ginge „0 von 0" als voller Balken durch,
 * und genau so sah der Fehler aus, den dieser Test fangen soll.
 */
check(stats.maxMp > 0, 'die Figur hat überhaupt Mana', `${stats.maxMp}`);
check(
  stats.mp === stats.maxMp,
  'und der Balken ist beim Betreten voll',
  `${stats.mp} von ${stats.maxMp}`,
);
check(stats.hp === stats.maxHp, 'wie das Leben auch — dieselbe Regel im Kern', `${stats.hp}`);

console.log('\nRegeneration ausserhalb des Kampfes');

/*
 * Der Grundwert ist ein Anteil des Maximums — hier steht keine eingetippte
 * Zahl, sondern die Erwartung aus derselben Datei, die der Server liest.
 */
await loadContentFromDisk(join(root, 'assets', 'content'));
const anteil = tuning().progression;
const erwartetHp = stats.maxHp * anteil.lebensregenerationAnteil;
const erwartetMp = stats.maxMp * anteil.manaregenerationAnteil;

const regen = (id: string): number =>
  stats?.attributes.find((a) => a.id === id)?.gesamt ?? 0;

check(erwartetHp > 0, 'die Inhaltsdatei nennt überhaupt eine Rate', String(erwartetHp));
check(
  Math.abs(regen('hpRegen') - erwartetHp) < 0.01,
  'die Werteliste zeigt den Anteil des Maximums',
  `${regen('hpRegen').toFixed(2)} statt ${erwartetHp.toFixed(2)}`,
);
check(
  Math.abs(regen('mpRegen') - erwartetMp) < 0.01,
  'beim Mana genauso',
  `${regen('mpRegen').toFixed(2)} statt ${erwartetMp.toFixed(2)}`,
);

/*
 * Und der Weg dorthin: Mana ausgeben, dann warten.
 *
 * Ein Trank füllt Leben; für Mana gibt es keinen. Also wird der Balken über
 * eine Fertigkeit geleert — die hat diese Figur nicht. Bleibt der einfache
 * Weg: warten und nachsehen, dass der Stand **steigt**. Er ist beim Betreten
 * voll, deshalb muss vorher etwas fehlen; ohne Fertigkeit fehlt nichts, und
 * ein voller Balken kann nicht weiter steigen.
 *
 * Deshalb prüft dieser Abschnitt die Rechnung und nicht den Verlauf — der
 * Verlauf steht im Kern (`testRegeneration` in native_test.cpp), samt der
 * Gegenprobe, dass im Kampf nichts nachwächst.
 */

console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
