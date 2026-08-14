/**
 * Die Fassung, die `/version` im Chat zeigt.
 *
 * Zwei Dinge, die zusammen die Zeile ergeben: das Format — dieselbe Funktion
 * auf beiden Seiten — und der Weg über das Protokoll, auf dem die Angaben des
 * Servers beim Client ankommen.
 *
 *   npx tsx packages/server/test/version_test.ts
 *
 * Die Zeitzone wird bewusst **vor** allem anderen umgestellt: der Stempel ist
 * in UTC vereinbart, und ein Formatierer, der versehentlich Ortszeit nimmt,
 * fiele in einem Lauf unter UTC gar nicht auf.
 */

process.env.TZ = 'America/New_York';

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { anmeldenUndBetreten, beobachteLobby, gruss } from './lib/anmelden.ts';
import { ermittleBuildStamp } from '@aurelith/shared/build/ermitteln.node.ts';
import {
  CipherSuite,
  FrameSequencer,
  PROTOCOL_VERSION,
  ServerOp,
  decodeFrame,
  decodeServerVersion,
  encodeFrame,
  encodeHello,
  encodeVersionRequest,
  formatBuild,
  nullCipher,
  readPacket,
  type BuildStamp,
} from '@aurelith/shared';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 8793;

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

console.log('Aurelith — Fassung\n');

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

console.log('Format');

const zeit = Date.UTC(2026, 7, 13, 14, 22, 7);
check(
  formatBuild({ nummer: 'a1b2c3', zeit }) === 'a1b2c3-260813-142207',
  'Nummer, Datum und Uhrzeit in einer Zeile',
  formatBuild({ nummer: 'a1b2c3', zeit }),
);

// In New York wäre es der 13. um 10:22 — dieselbe Sekunde, andere Zahlen. Die
// Zeile darf davon nicht abhängen, sonst vergleicht man im Chat Ortszeiten.
check(
  new Date(zeit).getHours() !== new Date(zeit).getUTCHours(),
  'die Prüfung läuft in einer Zeitzone, die von UTC abweicht',
  `${new Date(zeit).getHours()} statt ${new Date(zeit).getUTCHours()}`,
);

// Einstellige Werte werden aufgefüllt — sonst wird aus dem 2. Januar der 21.
check(
  formatBuild({ nummer: 'x', zeit: Date.UTC(2026, 0, 2, 3, 4, 5) }) === 'x-260102-030405',
  'einstellige Werte bekommen ihre Null',
  formatBuild({ nummer: 'x', zeit: Date.UTC(2026, 0, 2, 3, 4, 5) }),
);

// Gegenprobe: eine andere Sekunde ergibt eine andere Zeile. Ohne sie prüfte
// das obige nur, dass überhaupt eine Zeichenkette herauskommt.
check(
  formatBuild({ nummer: 'a1b2c3', zeit }) !== formatBuild({ nummer: 'a1b2c3', zeit: zeit + 1000 }),
  'eine andere Sekunde ergibt eine andere Zeile',
);

// Ohne Zeitangabe bleibt die Nummer allein stehen, statt eine Zeit zu erfinden.
check(formatBuild({ nummer: 'dev', zeit: 0 }) === 'dev', 'ohne Zeit steht die Nummer allein');

/*
 * Der Commit neben der Nummer.
 *
 * Der Anlass: die Zeile des Clients nannte eine Laufnummer, die des Servers
 * einen Commit, und beide standen im selben Chatfenster untereinander. Ob dort
 * derselbe Stand lief, war daran nicht zu erkennen.
 *
 * Die zweite Prüfung ist die wichtigere. Beim Server **ist** die Nummer schon
 * der Commit; stünde er dort noch einmal daneben, läse sich „9eb7b9/9eb7b9"
 * wie zwei Angaben, von denen man eine für die andere hält.
 */
check(
  formatBuild({ nummer: '113', zeit, commit: '5d6405' }) === '113/5d6405-260813-142207',
  'mit Commit steht er hinter der Nummer',
  formatBuild({ nummer: '113', zeit, commit: '5d6405' }),
);
check(
  formatBuild({ nummer: '9eb7b9', zeit, commit: '9eb7b9' }) === '9eb7b9-260813-142207',
  'ist die Nummer schon der Commit, steht er nicht zweimal da',
  formatBuild({ nummer: '9eb7b9', zeit, commit: '9eb7b9' }),
);
check(
  formatBuild({ nummer: '113', zeit }) === '113-260813-142207',
  'und ohne Commit bleibt die Zeile, wie sie war',
  formatBuild({ nummer: '113', zeit }),
);

/*
 * Und der Weg dorthin: aus der Umgebung, wie in der Veröffentlichung.
 *
 * Gekürzt wird in `ermittleBuildStamp` — die Arbeitsabläufe reichen den vollen
 * Hash durch. Wäre die Kürzung dort, hätten Client und Server irgendwann
 * verschieden lange Hashes, und der Vergleich, um den es hier geht, ginge
 * wieder nicht.
 */
const ausUmgebung = ermittleBuildStamp({
  AURELITH_BUILD: '113',
  AURELITH_BUILD_TIME: '2026-08-13T14:22:07.000Z',
  AURELITH_COMMIT: '5d640585a1b2c3d4e5f60718293a4b5c6d7e8f90',
});
check(ausUmgebung.commit === '5d6405', 'der volle Hash wird auf sechs Zeichen gekürzt', ausUmgebung.commit);
check(
  ermittleBuildStamp({ AURELITH_BUILD: '113', AURELITH_BUILD_TIME: '2026-08-13T14:22:07.000Z' })
    .commit === undefined,
  'ohne AURELITH_COMMIT bleibt das Feld leer',
);

// ---------------------------------------------------------------------------
// Der Weg über das Protokoll
// ---------------------------------------------------------------------------
//
// Der Server bekommt seine Kennung über die Umgebung — genau wie im
// Containerbild, wo es weder Arbeitsbaum noch git gibt. Damit ist die Antwort
// vorhersagbar: was hier ankommt, kann nur von dort kommen.

const BUILD = 'probe123';
const BUILD_ZEIT = '2026-08-13T14:22:07.000Z';

const server = spawn('npx', ['tsx', join(root, 'packages/server/src/index.ts')], {
  cwd: root,
  env: {
    ...process.env,
    AURELITH_PORT: String(PORT),
    AURELITH_BUILD: BUILD,
    AURELITH_BUILD_TIME: BUILD_ZEIT,
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

const suite = new CipherSuite();
const txSeq = new FrameSequencer();
const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
socket.binaryType = 'arraybuffer';

let antwort: BuildStamp | undefined;

socket.on('message', (data: ArrayBuffer | Buffer) => {
  const bytes = data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data);
  for (const raw of decodeFrame(bytes, suite).packets) {
    const { opcode, reader } = readPacket(raw);
    if (opcode === ServerOp.Version) antwort = decodeServerVersion(reader);
  }
});

await new Promise<void>((resolve_, reject) => {
  socket.on('open', () => resolve_());
  socket.on('error', reject);
});

function send(...packets: Uint8Array[]): void {
  socket.send(encodeFrame(packets, txSeq.next(), nullCipher));
}

console.log('\nÜber das Protokoll');

// Zuerst ohne Anmeldung: die Fassung ist keine Auskunft über die Welt, und
// gerade wer nicht ins Spiel kommt, will wissen, gegen welchen Server er
// läuft. Nur der Gruss muss durch sein — davor nimmt der Server nichts an.
gruss(send);
send(encodeVersionRequest());
const bisAntwort = Date.now() + 5000;
while (Date.now() < bisAntwort && !antwort) await sleep(50);
check(antwort !== undefined, 'der Server antwortet auch vor der Anmeldung');
check(
  antwort !== undefined && formatBuild(antwort) === `${BUILD}-260813-142207`,
  'und nennt genau das, was ihm mitgegeben wurde',
  antwort ? formatBuild(antwort) : 'keine Antwort',
);

// Und danach ein zweites Mal — der Befehl ist kein Einmalgruss beim Verbinden,
// sondern eine Frage, die man mitten im Spiel stellen kann.
antwort = undefined;
const anmeldung = beobachteLobby(socket, suite);
await anmeldenUndBetreten(send, anmeldung, `Fassung${Math.floor(Date.now() % 100000)}`);
await sleep(1200);
send(encodeVersionRequest());
const bisZweite = Date.now() + 5000;
while (Date.now() < bisZweite && !antwort) await sleep(50);
check(antwort !== undefined, 'und antwortet im Spiel genauso');

socket.close();
await sleep(200);
shutdown();

console.log(
  failures === 0 ? '\nAlle Prüfungen bestanden.\n' : `\n${failures} Prüfung(en) fehlgeschlagen.\n`,
);
process.exit(failures === 0 ? 0 : 1);
