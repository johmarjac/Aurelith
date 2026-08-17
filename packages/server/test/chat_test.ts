/**
 * Chatkanäle: wer hört was — und die Ansage der Spielleitung.
 *
 * Drei Reichweiten, und der ganze Sinn der Sache ist, dass sie sich
 * unterscheiden:
 *
 *   Umgebung — nur wer in Hörweite steht.
 *   Karte    — jeder auf derselben Karte.
 *   Global   — jeder auf diesem Spielserver, über alle Karten hinweg.
 *
 * Geprüft wird mit **zwei** Verbindungen: eine Reichweite lässt sich nicht an
 * einem einzelnen Client feststellen — der hört seine eigene Zeile in jedem
 * Kanal. Der zweite Spieler läuft dafür ein Stück weg; erst dann sagt das
 * Schweigen etwas aus.
 *
 * Und die Gegenprobe steckt in derselben Anordnung: nach dem Weglaufen darf
 * die Umgebungszeile nicht ankommen, die Kartenzeile aber schon. Käme keine
 * von beiden, hiesse das nur, dass die zweite Verbindung nichts hört.
 *
 *   npx tsx packages/server/test/chat_test.ts
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { anmeldenUndBetreten, beobachteLobby, gruss } from './lib/anmelden.ts';
import {
  CHAT_RADIUS,
  ChatChannel,
  CipherSuite,
  FrameSequencer,
  ServerOp,
  decodeFrame,
  decodeServerChat,
  decodeSnapshot,
  decodeWelcome,
  encodeClientChat,
  encodeFrame,
  encodeInput,
  nullCipher,
  readPacket,
  type ChatMsg,
} from '@aurelith/shared';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 8794;
const chefName = `Chef${Math.floor(Date.now() % 100000)}`;

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
    AURELITH_START_POS: '0,0',
    AURELITH_ADMINS: chefName,
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

/** Eine Verbindung mit allem, was dieser Test von ihr braucht. */
interface Spieler {
  name: string;
  send: (...p: Uint8Array[]) => void;
  gehoert: ChatMsg[];
  entityId: () => number;
  lauf: (dx: number, dz: number, ms: number) => Promise<void>;
  /**
   * Wo die eigene Figur gerade steht — aus dem Schnappschuss.
   *
   * Der Test unten läuft ausser Hörweite, und „ausser Hörweite" ist eine
   * Entfernung. Ohne diese Zahl liesse sich nicht unterscheiden, ob die
   * Umgebung wirklich nicht so weit trägt oder ob die Figur gar nicht erst
   * losgekommen ist — und der zweite Fall sähe genauso grün aus.
   */
  wo: () => { x: number; z: number };
}

async function verbinde(name: string): Promise<Spieler> {
  const suite = new CipherSuite();
  const txSeq = new FrameSequencer();
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  socket.binaryType = 'arraybuffer';

  const gehoert: ChatMsg[] = [];
  let localId = 0;
  let seq = 1;
  const ort = { x: 0, z: 0 };

  const send = (...packets: Uint8Array[]): void => {
    socket.send(encodeFrame(packets, txSeq.next(), nullCipher));
  };

  socket.on('message', (data: ArrayBuffer | Buffer) => {
    const bytes = data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data);
    for (const raw of decodeFrame(bytes, suite).packets) {
      const { opcode, reader } = readPacket(raw);
      if (opcode === ServerOp.Welcome) localId = decodeWelcome(reader).entityId;
      else if (opcode === ServerOp.Chat) gehoert.push(decodeServerChat(reader));
      else if (opcode === ServerOp.Snapshot) {
        const snap = decodeSnapshot(reader);
        for (const zeile of [...snap.spawns, ...snap.updates]) {
          if (zeile.id !== localId) continue;
          ort.x = zeile.x;
          ort.z = zeile.z;
        }
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

  const bis = Date.now() + 15000;
  while (Date.now() < bis && localId === 0) await sleep(100);
  if (localId === 0) throw new Error(`${name}: kein Welcome`);

  return {
    name,
    send,
    gehoert,
    entityId: () => localId,
    wo: () => ({ ...ort }),
    async lauf(dx, dz, ms) {
      const ende = Date.now() + ms;
      while (Date.now() < ende) {
        send(encodeInput({ seq: seq++, moveX: dx, moveZ: dz, yaw: Math.atan2(dx, dz), buttons: 0 }));
        await sleep(50);
      }
    },
  };
}

const chef = await verbinde(chefName);
const gast = await verbinde(`Gast${Math.floor(Date.now() % 100000)}`);
await sleep(600);

/** Alles vergessen, was bisher gesagt wurde — Willkommenszeilen zum Beispiel. */
function stille(): void {
  chef.gehoert.length = 0;
  gast.gehoert.length = 0;
}

const hoerte = (s: Spieler, text: string): ChatMsg | undefined =>
  s.gehoert.find((m) => m.text === text);

console.log('\nIn Hörweite');

stille();
chef.send(encodeClientChat(ChatChannel.Say, 'nebenan'));
await sleep(500);
check(hoerte(gast, 'nebenan') !== undefined, 'die Umgebung hört, wer daneben steht');
check(
  hoerte(gast, 'nebenan')?.entityId === chef.entityId(),
  'und die Zeile nennt den Sprecher — dafür die Sprechblase',
  `${hoerte(gast, 'nebenan')?.entityId} statt ${chef.entityId()}`,
);

console.log('\nWeit weg');

/*
 * Weg vom Chef, bis die Hörweite überschritten ist.
 *
 * Nach Süden und nicht nach Osten: seit Lichtmoor eine weite Insel ist, steht
 * östlich der Mitte genug herum, dass fünf Sekunden Laufzeit an einem Zaun
 * endeten — der Gast kam auf gut zwanzig Einheiten und hörte damit zu Recht
 * noch mit. Der Fehler sah aus wie einer an der Hörweite und war einer am
 * Weg.
 *
 * Dagegen hilft nicht „noch ein paar Sekunden", sondern die Zahl selbst: erst
 * wird nachgesehen, wie weit der Gast gekommen ist, und dann erst gilt seine
 * Stille als Aussage.
 */
const chefOrt = chef.wo();
for (let versuch = 0; versuch < 4 && abstandZumChef() < CHAT_RADIUS + 8; versuch++) {
  await gast.lauf(0, -1, 4000);
  await sleep(300);
}
function abstandZumChef(): number {
  const g = gast.wo();
  return Math.hypot(g.x - chefOrt.x, g.z - chefOrt.z);
}
check(
  abstandZumChef() > CHAT_RADIUS + 8,
  'der Gast kommt weit genug weg',
  `${abstandZumChef().toFixed(1)} von ${CHAT_RADIUS} Hörweite`,
);

stille();
chef.send(encodeClientChat(ChatChannel.Say, 'nur hier'));
await sleep(600);
check(hoerte(gast, 'nur hier') === undefined, 'die Umgebung trägt nicht bis dorthin');

stille();
chef.send(encodeClientChat(ChatChannel.Shout, 'auf der ganzen Karte'));
await sleep(600);
check(
  hoerte(gast, 'auf der ganzen Karte') !== undefined,
  'die Karte schon — und das ist die Gegenprobe zum Schweigen davor',
);

stille();
chef.send(encodeClientChat(ChatChannel.Global, 'an alle'));
await sleep(600);
check(hoerte(gast, 'an alle') !== undefined, 'global erst recht');
check(
  hoerte(gast, 'an alle')?.channel === ChatChannel.Global,
  'und kommt als globaler Kanal an',
);

console.log('\nAnsage');

stille();
gast.send(encodeClientChat(ChatChannel.Say, '/sys Testansage'));
await sleep(600);
check(
  chef.gehoert.every((m) => m.channel !== ChatChannel.Ansage),
  'ein gewöhnlicher Spieler macht keine Ansage',
);

stille();
chef.send(encodeClientChat(ChatChannel.Say, '/sys Serverneustart in fünf Minuten'));
await sleep(600);
const ansage = gast.gehoert.find((m) => m.channel === ChatChannel.Ansage);
check(ansage?.text === 'Serverneustart in fünf Minuten', 'ein Spielleiter schon', ansage?.text);
check(
  ansage !== undefined && ansage.entityId === 0,
  'und sie gehört niemandem — keine Blase über einem Kopf',
);
check(
  gast.gehoert.every((m) => m.text !== '/sys Serverneustart in fünf Minuten'),
  'der Befehl selbst steht in keinem Chat',
);

console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
