/**
 * Konten, Zugriffsstufen und die Befehle, die daran hängen.
 *
 * Zwei Teile. Der erste braucht keinen Server: Passwörter und die
 * Befehlstabelle sind Regeln, und Regeln lassen sich einzeln prüfen. Der
 * zweite spricht das Protokoll — anmelden, Figuren anlegen, löschen, betreten
 * —, weil erst dort auffällt, ob die Zustände einer Sitzung zusammenpassen.
 *
 *   npx tsx packages/server/test/account_test.ts
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  AccessLevel,
  CipherSuite,
  FrameSequencer,
  ServerOp,
  accessFromName,
  accessName,
  decodeFrame,
  decodeServerChat,
  decodeStats,
  encodeClientChat,
  encodeCreateCharacter,
  encodeDeleteCharacter,
  encodeEnterWorld,
  encodeFrame,
  encodeLogin,
  encodeCreateAccount,
  isValidName,
  nullCipher,
  readPacket,
  type LobbyMsg,
} from '@aurelith/shared';
import { hashPassword, verifyPassword } from '../src/passwords.ts';
import { COMMANDS, runCommand, type CommandHost } from '../src/commands.ts';
import { Session } from '../src/session.ts';
import { beobachteLobby, gruss } from './lib/anmelden.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 8797;

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

console.log('Aurelith — Konten und Befehle\n');

// ---------------------------------------------------------------------------
// Passwörter
// ---------------------------------------------------------------------------

console.log('Passwörter');

const zeile = await hashPassword('bergkristall');
check(zeile.startsWith('scrypt$'), 'die Zeile nennt ihr Verfahren', zeile.slice(0, 7));
check(!zeile.includes('bergkristall'), 'und enthält das Passwort nicht');
check(await verifyPassword('bergkristall', zeile), 'das richtige Passwort passt');
check(!(await verifyPassword('bergkristal', zeile)), 'ein Zeichen daneben passt nicht');
check(!(await verifyPassword('', zeile)), 'und nichts passt erst recht nicht');

// Zwei Zeilen zum selben Passwort sind verschieden — sonst verriete die
// Tabelle, wer dasselbe Passwort benutzt.
check(
  (await hashPassword('bergkristall')) !== zeile,
  'zweimal dasselbe Passwort ergibt zwei Zeilen',
);

// Bestandskonten ohne Passwort kommen nicht hinein. Ein leerer Hash, der zum
// leeren Passwort passte, wäre eine offene Tür für jedes alte Konto.
check(!(await verifyPassword('', '')), 'eine leere Zeile passt zu nichts');
check(!(await verifyPassword('x', 'kaputt$1$2')), 'und eine kaputte auch nicht');

// ---------------------------------------------------------------------------
// Namen und Stufen
// ---------------------------------------------------------------------------

console.log('\nNamen und Stufen');

check(isValidName('Aurel'), 'ein gewöhnlicher Name geht');
check(isValidName('Hüter_42'), 'Umlaute, Ziffern und Unterstrich auch');
check(!isValidName('ab'), 'zwei Zeichen sind zu wenig');
check(!isValidName('a'.repeat(17)), 'siebzehn sind zu viel');
check(!isValidName('Herr Meier'), 'ein Leerzeichen ist keins');
check(!isValidName('<script>'), 'und spitze Klammern erst recht nicht');

check(accessFromName('admin') === AccessLevel.Admin, 'admin ist die höchste Stufe');
check(accessFromName('PLAYER') === AccessLevel.Player, 'Grossschreibung ändert nichts');
check(accessFromName('unfug') === AccessLevel.Player, 'Unbekanntes gilt als Spieler');
check(accessName(AccessLevel.Gamemaster) === 'gamemaster', 'und zurück geht es auch');
check(
  AccessLevel.Player < AccessLevel.Gamemaster &&
    AccessLevel.Gamemaster < AccessLevel.Developer &&
    AccessLevel.Developer < AccessLevel.Admin,
  'die Stufen sind geordnet',
);

// ---------------------------------------------------------------------------
// Befehle
// ---------------------------------------------------------------------------
//
// Ohne Server: die Tabelle bekommt einen Wirt, der nur mitschreibt. Damit
// lässt sich prüfen, wer was darf, ohne eine Welt zu bauen.

console.log('\nBefehle');

const gesagt: string[] = [];
const ansagen: string[] = [];
let gutgeschrieben = 0;
const wirt: CommandHost = {
  systemMessage: (_s, text) => gesagt.push(text),
  giveGold: (_s, menge) => {
    gutgeschrieben += menge;
  },
  ansage: (text) => {
    ansagen.push(text);
    return 3;
  },
};

const sitzung = (stufe: AccessLevel): Session => {
  const s = Object.create(Session.prototype) as Session;
  s.access = stufe;
  return s;
};

check(
  COMMANDS.every((c) => c.minLevel >= AccessLevel.Gamemaster),
  'kein Serverbefehl steht gewöhnlichen Spielern zu',
);

gesagt.length = 0;
runCommand(wirt, sitzung(AccessLevel.Player), '/gg 500');
check(gutgeschrieben === 0, 'ein Spieler bekommt kein Gold');
check(
  gesagt.some((t) => t.includes('gamemaster')),
  'und erfährt, ab welcher Stufe es ginge',
  gesagt[0] ?? '(stumm)',
);

gesagt.length = 0;
runCommand(wirt, sitzung(AccessLevel.Gamemaster), '/gg 500');
check(gutgeschrieben === 500, 'ein Spielleiter bekommt es', String(gutgeschrieben));

// Gegenproben: was keine Zahl ist, wird nicht gutgeschrieben.
for (const eingabe of ['/gg', '/gg null', '/gg -5', '/gg 1.5', '/gg 99999999']) {
  gutgeschrieben = 0;
  runCommand(wirt, sitzung(AccessLevel.Admin), eingabe);
  check(gutgeschrieben === 0, `„${eingabe}" schreibt nichts gut`);
}

// --- Ansagen ---------------------------------------------------------------

gesagt.length = 0;
ansagen.length = 0;
runCommand(wirt, sitzung(AccessLevel.Player), '/sys Serverneustart in 5 Minuten');
check(ansagen.length === 0, 'ein Spieler macht keine Ansage');

runCommand(wirt, sitzung(AccessLevel.Gamemaster), '/sys Serverneustart in 5 Minuten');
check(
  ansagen[0] === 'Serverneustart in 5 Minuten',
  'ein Spielleiter schon — und zwar mit der ganzen Zeile',
  ansagen[0] ?? '(nichts)',
);
check(
  gesagt.some((t) => t.includes('3 Spieler')),
  'und erfährt, wen sie erreicht hat',
  gesagt.join(' | '),
);

ansagen.length = 0;
runCommand(wirt, sitzung(AccessLevel.Admin), '/sys');
check(ansagen.length === 0, 'eine leere Ansage geht nicht raus');

gesagt.length = 0;
check(runCommand(wirt, sitzung(AccessLevel.Admin), '/unfug'), 'ein unbekannter Befehl gilt als erledigt');
check(
  gesagt.some((t) => t.includes('Unbekannter Befehl')),
  'und sagt das auch',
);
check(!runCommand(wirt, sitzung(AccessLevel.Admin), 'Hallo zusammen'), 'gewöhnlicher Text ist kein Befehl');

// ---------------------------------------------------------------------------
// Über das Protokoll
// ---------------------------------------------------------------------------

const server = spawn('npx', ['tsx', join(root, 'packages/server/src/index.ts')], {
  cwd: root,
  env: {
    ...process.env,
    AURELITH_PORT: String(PORT),
    AURELITH_MAX_CHARACTERS: '2',
    // Dieses eine Konto gilt als Verwalter — der einzige Weg, auf einem
    // frischen Server überhaupt jemandem etwas zu geben.
    AURELITH_ADMINS: 'chefin',
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

/** Eine Verbindung mit allem, was die Prüfungen davon brauchen. */
async function verbinde(): Promise<{
  send: (...p: Uint8Array[]) => void;
  lobby: () => LobbyMsg | undefined;
  fehler: () => string | undefined;
  vergiss: () => void;
  chat: string[];
  gold: () => number;
  geschlossen: () => boolean;
  close: () => void;
}> {
  const suite = new CipherSuite();
  const seq = new FrameSequencer();
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  socket.binaryType = 'arraybuffer';

  const chat: string[] = [];
  let gold = 0;
  let geschlossen = false;
  socket.on('close', () => {
    geschlossen = true;
  });
  socket.on('message', (data: ArrayBuffer | Buffer) => {
    const bytes = data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data);
    for (const raw of decodeFrame(bytes, suite).packets) {
      const { opcode, reader } = readPacket(raw);
      if (opcode === ServerOp.Chat) chat.push(decodeServerChat(reader).text);
      if (opcode === ServerOp.Stats) gold = decodeStats(reader).gold;
    }
  });

  const beobachter = beobachteLobby(socket, suite);
  await new Promise<void>((res, rej) => {
    socket.on('open', () => res());
    socket.on('error', rej);
  });

  const send = (...p: Uint8Array[]): void => {
    socket.send(encodeFrame(p, seq.next(), nullCipher));
  };
  gruss(send);

  return {
    send,
    lobby: beobachter.lobby,
    fehler: beobachter.fehler,
    vergiss: beobachter.vergiss,
    chat,
    gold: () => gold,
    geschlossen: () => geschlossen,
    close: () => socket.close(),
  };
}

/** Wartet, bis eine Antwort da ist — Stand oder Absage. */
async function warte(
  c: { lobby: () => LobbyMsg | undefined; fehler: () => string | undefined },
  ms = 8000,
): Promise<void> {
  const ende = Date.now() + ms;
  while (Date.now() < ende && !c.lobby() && !c.fehler()) await sleep(50);
}

console.log('\nAnmeldung über das Protokoll');

const name = `Held${Math.floor(Date.now() % 100000)}`;
const c1 = await verbinde();

c1.send(encodeLogin({ name, password: 'geheimnis' }));
await warte(c1);
check(c1.lobby() === undefined, 'ein Konto, das es nicht gibt, meldet sich nicht an');
check(
  (c1.fehler() ?? '').includes('stimmt nicht'),
  'und der Grund verrät nicht, ob es den Namen gibt',
  c1.fehler() ?? '(stumm)',
);

c1.vergiss();
c1.send(encodeCreateAccount({ name, password: 'kurz' }));
await warte(c1);
check((c1.fehler() ?? '').includes('Zeichen'), 'ein zu kurzes Passwort wird abgelehnt', c1.fehler());

c1.vergiss();
c1.send(encodeCreateAccount({ name, password: 'geheimnis' }));
await warte(c1);
check(c1.lobby()?.accountName === name, 'ein neues Konto kommt hinein', c1.lobby()?.accountName);
check(c1.lobby()?.characters.length === 0, 'und hat noch keine Figuren');
check(c1.lobby()?.maxCharacters === 2, 'die Obergrenze kommt aus der Konfiguration');
check(c1.lobby()?.accessLevel === AccessLevel.Player, 'und die Stufe ist gewöhnlich');

// Zweiter Anlauf auf denselben Namen: einmal ist genug.
const c2 = await verbinde();
c2.send(encodeCreateAccount({ name, password: 'geheimnis' }));
await warte(c2);
check((c2.fehler() ?? '').includes('schon'), 'denselben Namen gibt es nur einmal', c2.fehler());

c2.vergiss();
c2.send(encodeLogin({ name, password: 'falsch' }));
await warte(c2);
check(c2.lobby() === undefined, 'mit falschem Passwort geht nichts');

// Ein Konto, eine Sitzung: solange die erste Verbindung steht, kommt die
// zweite nicht hinein — auch nicht mit richtigem Passwort. Andersherum (die
// ältere fliegt) wäre es ein Werkzeug: wer das Passwort kennt, könnte den
// Spieler jederzeit aus der Welt werfen.
c2.vergiss();
c2.send(encodeLogin({ name, password: 'geheimnis' }));
await warte(c2);
check(c2.lobby() === undefined, 'ein zweites Gerät kommt nicht auf dasselbe Konto');
check(
  (c2.fehler() ?? '').includes('bereits angemeldet'),
  'und erfährt auch, warum',
  c2.fehler() ?? '(stumm)',
);
await sleep(300);
check(!c1.geschlossen(), 'die erste Verbindung bleibt dabei bestehen');

// Gegenprobe: ist die erste weg, geht es sofort. Ohne sie prüfte das oben nur,
// dass die zweite Anmeldung *irgendwie* scheitert — etwa am Passwort.
c1.close();
await sleep(500);
c2.vergiss();
c2.send(encodeLogin({ name, password: 'geheimnis' }));
await warte(c2);
check(c2.lobby()?.accountName === name, 'nach dem Trennen der ersten schon');

console.log('\nFiguren');

c2.vergiss();
c2.send(encodeCreateCharacter('ab'));
await warte(c2);
check((c2.fehler() ?? '').includes('Name'), 'ein zu kurzer Figurenname wird abgelehnt', c2.fehler());

c2.vergiss();
c2.send(encodeCreateCharacter(`${name}A`));
await warte(c2);
check(c2.lobby()?.characters.length === 1, 'die erste Figur steht in der Liste');

c2.vergiss();
c2.send(encodeCreateCharacter(`${name}B`));
await warte(c2);
check(c2.lobby()?.characters.length === 2, 'die zweite auch');
// Festhalten, solange der Stand steht: die nächsten Schritte enden in
// Absagen, und eine Absage bringt keine Liste mit.
const beideFiguren = c2.lobby()?.characters ?? [];

c2.vergiss();
c2.send(encodeCreateCharacter(`${name}C`));
await warte(c2);
check(
  (c2.fehler() ?? '').includes('2'),
  'die dritte scheitert an der Obergrenze',
  c2.fehler() ?? '(stumm)',
);

// Gegenprobe: ein fremder Name lässt sich nicht doppelt vergeben.
const c3 = await verbinde();
c3.send(encodeCreateAccount({ name: `${name}X`, password: 'geheimnis' }));
await warte(c3);
c3.vergiss();
c3.send(encodeCreateCharacter(`${name}A`));
await warte(c3);
check((c3.fehler() ?? '').includes('schon'), 'einen vergebenen Figurennamen gibt es nicht zweimal');

// Und eine fremde Figur lässt sich weder löschen noch betreten.
const fremdeId = beideFiguren[0]?.id ?? 0;
c3.vergiss();
c3.send(encodeDeleteCharacter(fremdeId));
await warte(c3);
check((c3.fehler() ?? '').includes('gibt es nicht'), 'eine fremde Figur lässt sich nicht löschen');
c3.vergiss();
c3.send(encodeEnterWorld(fremdeId));
await warte(c3);
check((c3.fehler() ?? '').includes('gibt es nicht'), 'und auch nicht betreten');
c3.close();

const zuLoeschen = beideFiguren[1]?.id ?? 0;
c2.vergiss();
c2.send(encodeDeleteCharacter(zuLoeschen));
await warte(c2);
check(c2.lobby()?.characters.length === 1, 'die eigene Figur lässt sich löschen');
check(
  c2.lobby()?.characters.every((c) => c.id !== zuLoeschen) === true,
  'und ist danach nicht mehr in der Liste',
);

console.log('\nIn der Welt');

const eigene = beideFiguren[0]?.id ?? 0;
c2.send(encodeEnterWorld(eigene));
await sleep(2500);
check(c2.gold() > -1 && c2.chat.some((t) => t.includes('Willkommen')), 'die Figur betritt die Welt');

const goldVorher = c2.gold();
c2.chat.length = 0;
c2.send(encodeClientChat(1, '/gg 500'));
await sleep(800);
check(c2.gold() === goldVorher, 'ein Spieler schreibt sich kein Gold gut', String(c2.gold()));
check(
  c2.chat.some((t) => t.includes('steht erst ab Stufe')),
  'und bekommt eine Absage',
  c2.chat.join(' | ') || '(stumm)',
);
c2.close();

// Und dasselbe als Verwalter — das Konto steht in `AURELITH_ADMINS`.
const chefin = await verbinde();
chefin.send(encodeCreateAccount({ name: 'chefin', password: 'geheimnis' }));
await warte(chefin);
check(chefin.lobby()?.accessLevel === AccessLevel.Admin, 'die Liste der Verwalter greift');

chefin.vergiss();
chefin.send(encodeCreateCharacter(`Chefin${Math.floor(Date.now() % 10000)}`));
await warte(chefin);
chefin.send(encodeEnterWorld(chefin.lobby()?.characters[0]?.id ?? 0));
await sleep(2500);

const chefGold = chefin.gold();
chefin.send(encodeClientChat(1, '/gg 500'));
await sleep(800);
check(chefin.gold() === chefGold + 500, 'eine Verwalterin schon', `${chefGold} → ${chefin.gold()}`);
chefin.close();

await sleep(200);
shutdown();

console.log(
  failures === 0 ? '\nAlle Prüfungen bestanden.\n' : `\n${failures} Prüfung(en) fehlgeschlagen.\n`,
);
process.exit(failures === 0 ? 0 : 1);
