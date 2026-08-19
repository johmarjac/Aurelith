/**
 * Freundschaften über die Leitung.
 *
 * Der ganze Ablauf mit zwei echten Verbindungen: anfragen, ablehnen, annehmen,
 * lösen — und die Absagen dazwischen. Geprüft wird über das Protokoll und
 * nicht an den Funktionen vorbei, denn die Hälfte der Regeln steht nicht in
 * `freunde.ts`, sondern in dem, was der Server über seine Sitzungen weiss:
 * wer gerade spielt, wer im Kampf steckt, wer wem eine Liste schickt.
 *
 *   npx tsx packages/server/test/freunde_test.ts
 *
 * **Jede Regel hat hier ihre Gegenprobe**, und zwar meistens direkt daneben:
 * dass eine Anfrage ankommt, sagt für sich nichts — es muss auch eine geben,
 * die nicht ankommt, und einen Grund dafür.
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { anmeldenUndBetreten, beobachteLobby, gruss } from './lib/anmelden.ts';
import {
  ChatChannel,
  CipherSuite,
  FrameSequencer,
  FreundAktion,
  ServerOp,
  decodeFrame,
  decodeFreundAnfrage,
  decodeFreunde,
  decodeServerChat,
  decodeWelcome,
  encodeClientChat,
  encodeFrame,
  encodeFreund,
  nullCipher,
  readPacket,
  type FreundZeile,
} from '@aurelith/shared';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 8808;

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ANNA = `Anna${Math.floor(Date.now() % 10000)}`;
const BORIS = `Boris${Math.floor(Date.now() % 10000)}`;
const CILLA = `Cilla${Math.floor(Date.now() % 10000)}`;

const server = spawn('npx', ['tsx', join(root, 'packages/server/src/index.ts')], {
  cwd: root,
  env: {
    ...process.env,
    AURELITH_PORT: String(PORT),
    // Auf der Wiese, damit `/spawn` weiter unten Boden vor der Figur findet.
    AURELITH_START_POS: '-44,-56',
    // Boris darf Monster setzen — anders bekommt dieser Test keinen Kampf
    // zustande, und der Kampf ist eine der gefragten Regeln.
    AURELITH_ADMINS: `${BORIS}:gamemaster`,
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

console.log('Aurelith — Freundschaften\n');

/** Eine Verbindung samt allem, was dieser Test von ihr liest. */
interface Spieler {
  name: string;
  socket: WebSocket;
  /** Was der Server als Systemzeile geschickt hat, seit dem letzten Leeren. */
  meldungen: string[];
  /** Private Nachrichten: Absender und Text. */
  fluestern: Array<{ from: string; text: string }>;
  /** Die zuletzt empfangene Freundesliste. */
  freunde: FreundZeile[];
  /** Die zuletzt empfangene Anfrage. */
  anfragen: Array<{ vonName: string; fristMs: number }>;
  freund: (aktion: number, name: string) => void;
  sag: (text: string) => void;
}

async function verbinde(name: string): Promise<Spieler> {
  const suite = new CipherSuite();
  const txSeq = new FrameSequencer();
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  socket.binaryType = 'arraybuffer';

  const meldungen: string[] = [];
  const fluestern: Array<{ from: string; text: string }> = [];
  const anfragen: Array<{ vonName: string; fristMs: number }> = [];
  let freunde: FreundZeile[] = [];
  let localId = 0;

  const send = (...packets: Uint8Array[]): void => {
    socket.send(encodeFrame(packets, txSeq.next(), nullCipher));
  };

  socket.on('message', (data: ArrayBuffer | Buffer) => {
    const bytes = data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data);
    for (const raw of decodeFrame(bytes, suite).packets) {
      const { opcode, reader } = readPacket(raw);
      if (opcode === ServerOp.Welcome) localId = decodeWelcome(reader).entityId;
      else if (opcode === ServerOp.Freunde) freunde = decodeFreunde(reader);
      else if (opcode === ServerOp.FreundAnfrage) anfragen.push(decodeFreundAnfrage(reader));
      else if (opcode === ServerOp.Chat) {
        const msg = decodeServerChat(reader);
        if (msg.channel === ChatChannel.System) meldungen.push(msg.text);
        else if (msg.channel === ChatChannel.Whisper) {
          fluestern.push({ from: msg.from, text: msg.text });
        }
      }
    }
  });

  await new Promise<void>((fertig, fehler) => {
    socket.on('open', () => fertig());
    socket.on('error', fehler);
  });

  const anmeldung = beobachteLobby(socket, suite);
  gruss(send);
  await anmeldenUndBetreten(send, anmeldung, name);

  const bis = Date.now() + 15000;
  while (Date.now() < bis && localId === 0) await sleep(100);
  if (localId === 0) throw new Error(`${name}: kein Welcome`);

  return {
    name,
    socket,
    meldungen,
    fluestern,
    anfragen,
    get freunde() {
      return freunde;
    },
    freund: (aktion, wen) => send(encodeFreund(aktion, wen)),
    sag: (text) => send(encodeClientChat(ChatChannel.Say, text)),
  };
}

const anna = await verbinde(ANNA);
const boris = await verbinde(BORIS);
await sleep(600);

/** Wartet, bis eine Bedingung eintritt — oder gibt auf. */
async function bis(pruefe: () => boolean, ms = 6000): Promise<boolean> {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    if (pruefe()) return true;
    await sleep(100);
  }
  return false;
}

const leere = (s: Spieler): void => {
  s.meldungen.length = 0;
  s.anfragen.length = 0;
  s.fluestern.length = 0;
};

// --- Absagen vor der ersten Anfrage -----------------------------------------

console.log('Was gar nicht erst rausgeht');

leere(anna);
anna.freund(FreundAktion.Anfragen, anna.name);
await sleep(500);
check(
  anna.meldungen.some((t) => t.includes('Mit sich selbst')),
  'sich selbst kann man nicht anfragen',
  anna.meldungen.join(' | ') || '(stumm)',
);

leere(anna);
anna.freund(FreundAktion.Anfragen, 'GibtsNichtHier');
await sleep(500);
check(
  anna.meldungen.some((t) => t.includes('gibt es auf diesem Kanal nicht')),
  'ein Name, den es nicht gibt, wird als solcher gemeldet',
  anna.meldungen.join(' | ') || '(stumm)',
);

/*
 * Eine Figur, die es **gibt**, aber die nicht spielt.
 *
 * Das ist die Gegenprobe zur Zeile darüber: ohne sie wäre auch ein Server
 * grün, der jede Anfrage mit „gibt es nicht" abtut. Cilla meldet sich an,
 * geht wieder und wird danach gesucht.
 */
const cilla = await verbinde(CILLA);
await sleep(400);
cilla.socket.close();
await sleep(900);

leere(anna);
anna.freund(FreundAktion.Anfragen, CILLA);
await sleep(600);
check(
  anna.meldungen.some((t) => t.includes('spielt gerade nicht')),
  'eine Figur, die es gibt, die aber nicht spielt, wird anders gemeldet',
  anna.meldungen.join(' | ') || '(stumm)',
);

// --- Anfragen, ablehnen -----------------------------------------------------

console.log('\nAnfragen und ablehnen');

leere(anna);
leere(boris);
anna.freund(FreundAktion.Anfragen, BORIS);
check(await bis(() => boris.anfragen.length > 0), 'die Anfrage kommt bei Boris an');
check(boris.anfragen[0]?.vonName === ANNA, 'und nennt den Absender', boris.anfragen[0]?.vonName ?? '(nichts)');
check((boris.anfragen[0]?.fristMs ?? 0) > 0, 'samt einer Frist', String(boris.anfragen[0]?.fristMs ?? 0));

leere(anna);
boris.freund(FreundAktion.Ablehnen, ANNA);
check(
  await bis(() => anna.meldungen.some((t) => t.includes('abgelehnt'))),
  'die Ablehnung kommt bei Anna an',
  anna.meldungen.join(' | ') || '(stumm)',
);
check(anna.freunde.length === 0, 'und niemand steht in einer Liste', String(anna.freunde.length));

// --- Anfragen, annehmen -----------------------------------------------------

console.log('\nAnfragen und annehmen');

leere(anna);
leere(boris);
anna.freund(FreundAktion.Anfragen, BORIS);
check(await bis(() => boris.anfragen.length > 0), 'die zweite Anfrage kommt an');

boris.freund(FreundAktion.Annehmen, ANNA);
check(
  await bis(() => anna.freunde.some((f) => f.name === BORIS)),
  'Boris steht in Annas Liste',
  anna.freunde.map((f) => f.name).join(', ') || '(leer)',
);
check(
  await bis(() => boris.freunde.some((f) => f.name === ANNA)),
  'und Anna in Boris’ — beidseitig',
  boris.freunde.map((f) => f.name).join(', ') || '(leer)',
);
check(
  anna.freunde.find((f) => f.name === BORIS)?.online === true,
  'und er steht als anwesend darin',
);
check(
  (anna.freunde.find((f) => f.name === BORIS)?.level ?? 0) >= 1,
  'mit seiner Stufe',
  String(anna.freunde.find((f) => f.name === BORIS)?.level ?? 0),
);

// Und ein zweites Mal geht nicht — sonst stünde derselbe Name zweimal da.
leere(anna);
anna.freund(FreundAktion.Anfragen, BORIS);
await sleep(600);
check(
  anna.meldungen.some((t) => t.includes('steht schon in deiner Freundesliste')),
  'wer schon in der Liste steht, wird nicht noch einmal angefragt',
  anna.meldungen.join(' | ') || '(stumm)',
);

// --- Private Nachrichten ----------------------------------------------------

console.log('\nPrivate Nachrichten');

leere(boris);
leere(anna);
anna.sag(`/pm ${BORIS} bis gleich am Fluss`);
check(
  await bis(() => boris.fluestern.length > 0),
  'die Nachricht kommt bei Boris an',
  boris.fluestern.map((f) => `${f.from}: ${f.text}`).join(' | ') || '(nichts)',
);
check(boris.fluestern[0]?.from === ANNA, 'und nennt Anna als Absenderin', boris.fluestern[0]?.from ?? '');
check(
  boris.fluestern[0]?.text === 'bis gleich am Fluss',
  'mit dem ganzen Satz',
  boris.fluestern[0]?.text ?? '',
);
check(
  anna.fluestern.some((f) => f.from.startsWith('an ')),
  'und Anna sieht ihre eigene Nachricht',
  anna.fluestern.map((f) => f.from).join(', ') || '(nichts)',
);

/*
 * Gegenprobe: sie geht **nur** an den einen. Ohne sie wäre auch ein Server
 * grün, der private Nachrichten an alle schickt — und das wäre der schlimmste
 * denkbare Fehler an dieser Stelle.
 */
const cilla2 = await verbinde(`${CILLA}b`);
await sleep(500);
leere(cilla2);
anna.sag(`/pm ${BORIS} nur für dich`);
await sleep(800);
check(cilla2.fluestern.length === 0, 'und niemand sonst liest mit', String(cilla2.fluestern.length));

// --- Im Kampf keine Frage ---------------------------------------------------

console.log('\nWer kämpft, wird nicht gefragt');

/*
 * Erst lösen, dann kämpfen: eine Anfrage an einen Freund würde ohnehin
 * abgelehnt, und dann prüfte dieser Abschnitt die falsche Absage.
 */
leere(anna);
leere(boris);
anna.freund(FreundAktion.Entfernen, BORIS);
check(
  await bis(() => anna.freunde.length === 0),
  'Anna löst die Freundschaft',
  anna.freunde.map((f) => f.name).join(', ') || '(leer)',
);
check(
  await bis(() => boris.freunde.length === 0),
  'und sie ist auch bei Boris weg — beidseitig',
  boris.freunde.map((f) => f.name).join(', ') || '(leer)',
);
check(
  boris.meldungen.some((t) => t.includes('hat die Freundschaft gelöst')),
  'Boris erfährt davon',
  boris.meldungen.join(' | ') || '(stumm)',
);

/*
 * Gegenprobe zum Kampf, direkt davor: **ohne** Monster geht dieselbe Anfrage
 * durch. Ohne sie wäre der Abschnitt unten auch mit einem Server zufrieden,
 * der nach dem Lösen einer Freundschaft überhaupt nichts mehr durchlässt.
 */
leere(anna);
leere(boris);
anna.freund(FreundAktion.Anfragen, BORIS);
check(
  await bis(() => boris.anfragen.length > 0),
  'ohne Kampf geht dieselbe Anfrage durch',
  anna.meldungen.join(' | ') || '(stumm)',
);
boris.freund(FreundAktion.Ablehnen, ANNA);
await sleep(500);

/*
 * Boris geht ein Stück beiseite, **bevor** das Monster kommt.
 *
 * Beide starten auf demselben Punkt, und ein Keiler dazwischen sucht sich das
 * nächste Ziel selbst aus — beim ersten Anlauf griff er Anna an, und dann
 * stand Boris nicht im Kampf. Sechsundzwanzig Meter sind mehr als seine
 * Wahrnehmung von fünfzehn: damit ist die Frage entschieden und nicht
 * ausgewürfelt. Die Höhe darf darunterliegen; der Server hebt auf den Boden.
 */
boris.sag('/tp -44 -100 -30');
await sleep(800);

// Und jetzt ein Monster vor Boris’ Nase. Es greift innerhalb weniger Ticks an.
leere(boris);
boris.sag('/spawn distelkeiler');
await sleep(3000);

leere(anna);
anna.freund(FreundAktion.Anfragen, BORIS);
await sleep(800);
check(
  anna.meldungen.some((t) => t.includes('im Kampf')),
  'eine Anfrage an jemanden im Kampf geht nicht raus',
  anna.meldungen.join(' | ') || '(stumm)',
);
check(boris.anfragen.length === 0, 'und Boris bekommt sie gar nicht erst zu sehen');

anna.socket.close();
boris.socket.close();
cilla2.socket.close();
await sleep(300);

console.log(
  failures === 0 ? '\nAlle Prüfungen bestanden.\n' : `\n${failures} Prüfung(en) fehlgeschlagen.\n`,
);
process.exit(failures === 0 ? 0 : 1);
