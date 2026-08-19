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
  leseZugriffsliste,
  maxLevel,
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
  getMob,
  isValidName,
  nullCipher,
  readPacket,
  type LobbyMsg,
} from '@aurelith/shared';
import { hashPassword, verifyPassword } from '../src/passwords.ts';
import { loadContentFromDisk } from '../src/content.ts';
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
// Die Zugriffsliste aus AURELITH_ADMINS
// ---------------------------------------------------------------------------
//
// Der Wert entscheidet, wer Befehle ausführen darf. Ein stiller Fehler darin
// ist deshalb keiner von der harmlosen Sorte: er vergibt entweder zu viel oder
// zu wenig, und beides fällt erst auf, wenn jemand es braucht.

console.log('\nZugriffsliste');

const einfach = leseZugriffsliste('johmarjac');
check(einfach.liste.get('johmarjac') === AccessLevel.Admin, 'ein blosser Name heisst Verwalter');
check(einfach.fehler.length === 0, 'und ist keine Beanstandung wert');

const gemischt = leseZugriffsliste(' Chef , helfer:gamemaster,Tester:developer , weg:player ');
check(gemischt.liste.get('chef') === AccessLevel.Admin, 'Leerzeichen stören nicht');
check(gemischt.liste.get('helfer') === AccessLevel.Gamemaster, 'die genannte Stufe gilt');
check(gemischt.liste.get('tester') === AccessLevel.Developer, 'Namen werden kleingeschrieben');
check(
  gemischt.liste.get('weg') === AccessLevel.Player,
  '`:player` nimmt eine Stufe ausdrücklich zurück',
);
check(gemischt.fehler.length === 0, 'und nichts davon ist zu beanstanden', gemischt.fehler[0]);

/*
 * Die Gegenprobe, um die es hier eigentlich geht.
 *
 * `accessFromName` gibt für jedes unbekannte Wort „player" zurück. Wäre die
 * Liste darüber gebaut, würde aus `:gamemster` stillschweigend eine
 * Herabstufung — und der Wert in der `.env` sähe dabei völlig richtig aus.
 */
const vertippt = leseZugriffsliste('helfer:gamemster');
check(!vertippt.liste.has('helfer'), 'ein vertipptes Stufenwort gilt gar nicht');
check(
  vertippt.fehler.some((f) => f.includes('gamemster')),
  'und wird benannt',
  vertippt.fehler[0] ?? '(stumm)',
);

const leer = leseZugriffsliste('');
check(leer.liste.size === 0 && leer.fehler.length === 0, 'ein leerer Wert ergibt eine leere Liste');

const doppelt = leseZugriffsliste('wer:gamemaster,wer:admin');
check(doppelt.liste.get('wer') === AccessLevel.Admin, 'bei zwei Einträgen gilt der letzte');
check(doppelt.fehler.length === 1, 'und der Widerspruch wird gemeldet', doppelt.fehler[0]);

// Eine E-Mail-Adresse als Kontoname — so heissen die Konten aus dem
// Google-Weg. Der Doppelpunkt trennt von hinten, sonst zerschnitte ein Name
// mit Doppelpunkt darin sich selbst.
const perMail = leseZugriffsliste('jemand@example.com:gamemaster');
check(
  perMail.liste.get('jemand@example.com') === AccessLevel.Gamemaster,
  'eine Adresse geht als Name genauso',
  [...perMail.liste.keys()][0],
);

// ---------------------------------------------------------------------------
// Befehle
// ---------------------------------------------------------------------------
//
// Ohne Server: die Tabelle bekommt einen Wirt, der nur mitschreibt. Damit
// lässt sich prüfen, wer was darf, ohne eine Welt zu bauen.

/*
 * Die Inhalte müssen vorher geladen sein.
 *
 * `/level` liest die Höchststufe aus `tuning.json` — es gibt keine zweite,
 * hier eingetippte Zahl dafür. Ohne geladene Inhalte wirft das, und zwar mit
 * genau der Meldung, die es soll: „noch nichts geladen".
 */
await loadContentFromDisk(join(root, 'assets', 'content'));

console.log('\nBefehle');

const gesagt: string[] = [];
const ansagen: string[] = [];
const stufenrufe: Array<{ name: string; stufe: AccessLevel }> = [];
const levelrufe: Array<{ figur: string; level: number }> = [];
const tprufe: string[] = [];
const stellen: Array<{ x: number; y: number; z: number }> = [];
const spawnrufe: string[] = [];
const fluesterrufe: Array<{ name: string; text: string }> = [];
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
  setzeStufe: (_s, name, stufe) => {
    stufenrufe.push({ name, stufe });
  },
  teleportiere: (_s, mapId) => {
    tprufe.push(mapId);
    // „Es gibt sie" — welche Karten der Kanal führt, weiss der Server. Hier
    // geht es um das, was **vor** ihm passiert.
    return mapId !== 'gibtsnicht';
  },
  kartenListe: () => ['dornwald', 'gruft_01', 'lichtmoor'],
  lage: () => ({ x: 12.345, y: 4.5, z: -7.891 }),
  setzeAn: (_s, x, y, z) => {
    stellen.push({ x, y, z });
    // Ob die Figur gerade in einer Welt steht, weiss der Server. Hier geht es
    // um das, was **vor** ihm passiert: drei Zahlen oder ein Kartenname.
    return true;
  },
  setzeLevel: (_s, figur, level) => {
    levelrufe.push({ figur, level });
    // „Es gibt sie" — die Suche nach der Figur prüft der Server, nicht die
    // Befehlstabelle. Hier geht es um das, was **vor** ihr passiert.
    return true;
  },
  spawneMonster: (_s, sorte) => {
    spawnrufe.push(sorte);
    // Ob vor der Figur Boden ist, weiss der Server. Hier geht es um das, was
    // **vor** ihm passiert — die Übersetzung vom getippten Wort zur Kennung.
    // „gruftwärter" spielt den einen Fall nach, in dem er nichts setzen kann.
    return sorte === 'dungeon_warden' ? undefined : (getMob(sorte)?.name ?? sorte);
  },
  fluestere: (_s, name, text) => {
    fluesterrufe.push({ name, text });
    // Wer gerade spielt, weiss der Server. Hier geht es um das, was **vor** ihm
    // passiert: die Zerlegung in Name und Nachricht. „Niemand" spielt den
    // einen Fall nach, in dem die Figur nicht da ist.
    return name === 'Niemand' ? 'weg' : 'ok';
  },
};

const sitzung = (stufe: AccessLevel): Session => {
  const s = Object.create(Session.prototype) as Session;
  s.access = stufe;
  return s;
};

/*
 * Was einem gewöhnlichen Spieler zusteht, steht **namentlich** hier.
 *
 * Vorher hiess die Regel „gar nichts", und das war richtig, solange jeder
 * Serverbefehl am Spielstand rührte. Die private Nachricht tut das nicht: sie
 * schiebt Text von einer Figur zur anderen und ändert nichts.
 *
 * Eine Liste statt einer aufgeweichten Schwelle, damit die Frage beim Lesen
 * beantwortet ist: wer `/gg` versehentlich auf `Player` setzt, fällt hier
 * durch, weil `gg` nicht in der Liste steht.
 */
const FUER_SPIELER = new Set(['pm']);
check(
  COMMANDS.every((c) => c.minLevel >= AccessLevel.Gamemaster || FUER_SPIELER.has(c.name)),
  'kein Serverbefehl ausserhalb der Liste steht gewöhnlichen Spielern zu',
  COMMANDS.filter((c) => c.minLevel < AccessLevel.Gamemaster)
    .map((c) => c.name)
    .join(', '),
);
// Gegenprobe zur Liste selbst: ein Name darin, den es nicht mehr gibt, machte
// sie stillschweigend länger als nötig — und die Regel damit weicher.
check(
  [...FUER_SPIELER].every((name) => COMMANDS.some((c) => c.name === name)),
  'und die Liste nennt nur Befehle, die es gibt',
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

/*
 * `/position` — dieselbe Lage auf beiden Seiten?
 *
 * Die Antwort steht in **einer** Zeile, weil nur so derselbe Augenblick
 * verglichen wird. Geprüft wird, dass beide Zahlenpaare darin vorkommen und
 * dass der Abstand dazwischen wirklich gerechnet und nicht abgeschrieben ist.
 */
gesagt.length = 0;
runCommand(wirt, sitzung(AccessLevel.Player), '/position');
check(
  gesagt.some((t) => t.includes('gamemaster')),
  'ein Spieler fragt die Lage nicht ab',
  gesagt.join(' | '),
);

gesagt.length = 0;
runCommand(wirt, sitzung(AccessLevel.Gamemaster), '/position');
check(
  gesagt.some((t) => t.includes('12.35') && t.includes('4.50') && t.includes('-7.89')),
  'ohne Zahlen des Clients steht die des Servers da',
  gesagt.join(' | '),
);
// Gegenprobe: ohne Angabe des Clients wird auch keine Abweichung behauptet.
check(!gesagt.some((t) => t.includes('Abweichung')), 'und keine Abweichung dazu erfunden');

gesagt.length = 0;
runCommand(wirt, sitzung(AccessLevel.Gamemaster), '/position 12.345 4.5 -7.891');
check(
  gesagt.some((t) => t.includes('Abweichung 0.00')),
  'bei gleicher Lage ist die Abweichung null',
  gesagt.join(' | '),
);

/*
 * Und die Gegenprobe, die den Befehl erst brauchbar macht: eine echte
 * Abweichung muss auch als solche dastehen. Drei Meter daneben — auf der
 * Karte zwei, in der Höhe zwei, macht nach Pythagoras 2,83.
 */
gesagt.length = 0;
runCommand(wirt, sitzung(AccessLevel.Gamemaster), '/position 14.345 6.5 -7.891');
check(
  gesagt.some((t) => t.includes('Abweichung 2.83')),
  'und eine echte Abweichung steht als Zahl da',
  gesagt.join(' | '),
);

// Was keine Zahlen sind, wird benannt statt als null durchgereicht.
gesagt.length = 0;
runCommand(wirt, sitzung(AccessLevel.Gamemaster), '/position hier drüben irgendwo');
check(
  gesagt.some((t) => t.includes('keine Zahlen')),
  'und Unsinn vom Client wird benannt',
  gesagt.join(' | '),
);

/*
 * `/tp` kann zweierlei, und die Anzahl der Wörter entscheidet.
 *
 * Ein Wort ist eine Karte, drei Zahlen sind eine Stelle auf dieser. Die
 * Verwechslung wäre teuer: `/tp 12 4 -7` als Kartenname gelesen ergäbe eine
 * Absage mit Kartenliste, und `/tp lichtmoor` als Zahlen gelesen eine Figur
 * bei NaN.
 */
gesagt.length = 0;
stellen.length = 0;
tprufe.length = 0;
runCommand(wirt, sitzung(AccessLevel.Gamemaster), '/tp 12 4 -7');
check(
  stellen.length === 1 && stellen[0]!.x === 12 && stellen[0]!.y === 4 && stellen[0]!.z === -7,
  'drei Zahlen setzen an eine Stelle',
  JSON.stringify(stellen[0] ?? null),
);
check(tprufe.length === 0, 'und suchen keine Karte dazu');

// Die Gegenprobe: ein Wort bleibt eine Karte und keine Stelle.
stellen.length = 0;
tprufe.length = 0;
runCommand(wirt, sitzung(AccessLevel.Gamemaster), '/tp lichtmoor');
check(tprufe[0] === 'lichtmoor' && stellen.length === 0, 'ein Wort bleibt eine Karte');

// Und was weder das eine noch das andere ist, wird abgesagt statt geraten.
for (const eingabe of ['/tp 12 vier -7', '/tp 1 2', '/tp 1 2 3 4']) {
  stellen.length = 0;
  tprufe.length = 0;
  gesagt.length = 0;
  runCommand(wirt, sitzung(AccessLevel.Gamemaster), eingabe);
  check(stellen.length === 0, `„${eingabe}" setzt niemanden`);
  check(gesagt.length > 0, `und „${eingabe}" sagt, was es erwartet`, gesagt.join(' | '));
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

/*
 * `/pm` — die private Nachricht.
 *
 * Geprüft wird die Zerlegung: das erste Wort ist die Figur, **alles Weitere**
 * ist die Nachricht. Ein Befehl, der nur `args[1]` nimmt, verschluckt alles ab
 * dem zweiten Leerzeichen — und niemand bemerkt es, solange man „hallo"
 * schreibt.
 */
gesagt.length = 0;
fluesterrufe.length = 0;
runCommand(wirt, sitzung(AccessLevel.Player), '/pm Gandalf du kommst hier nicht durch');
check(fluesterrufe[0]?.name === 'Gandalf', 'das erste Wort ist die Figur', fluesterrufe[0]?.name ?? '(nichts)');
check(
  fluesterrufe[0]?.text === 'du kommst hier nicht durch',
  'und der ganze Rest ist die Nachricht',
  fluesterrufe[0]?.text ?? '(nichts)',
);
check(gesagt.length === 0, 'und bei Erfolg sagt der Befehl selbst nichts');

// Ohne Nachricht geht nichts raus — und der Absender erfährt, warum.
gesagt.length = 0;
fluesterrufe.length = 0;
runCommand(wirt, sitzung(AccessLevel.Player), '/pm Gandalf');
check(fluesterrufe.length === 0, 'ohne Nachricht geht nichts raus');
check(
  gesagt.some((t) => t.includes('/pm <figur> <nachricht>')),
  'und die Absage nennt die Form',
  gesagt.join(' | ') || '(stumm)',
);

// Und wer nicht spielt, bekommt keine — die Absage kommt trotzdem.
gesagt.length = 0;
runCommand(wirt, sitzung(AccessLevel.Player), '/pm Niemand hallo');
check(
  gesagt.some((t) => t.includes('spielt gerade nicht')),
  'eine Figur, die nicht spielt, wird gemeldet',
  gesagt.join(' | ') || '(stumm)',
);

/*
 * `/accesslevel` — wer ihn darf und was er weiterreicht.
 *
 * Die Zuweisung selbst steht hier nicht auf dem Prüfstand: sie schreibt in
 * eine Datenbank, und dieser Abschnitt kommt ohne Server aus. Geprüft wird die
 * Schwelle davor — und die ist die eigentliche Gefahrenstelle: ein Spielleiter,
 * der Stufen vergeben darf, ernennt sich irgendwann jemanden, der ihn ernennt.
 */
/*
 * `/spawn` — das Werkzeug, mit dem man sich ein Wesen ansieht.
 *
 * Geprüft wird hier die Übersetzung vom getippten Wort zur Kennung, denn die
 * steht in dieser Datei. Ob vor der Figur Boden ist, entscheidet der Server.
 */
gesagt.length = 0;
spawnrufe.length = 0;
runCommand(wirt, sitzung(AccessLevel.Player), '/spawn Höhlenkriecher');
check(spawnrufe.length === 0, 'ein Spieler setzt keine Monster');

// Der deutsche Name — so, wie er im Spiel über dem Wesen steht.
spawnrufe.length = 0;
gesagt.length = 0;
runCommand(wirt, sitzung(AccessLevel.Gamemaster), '/spawn Höhlenkriecher');
check(spawnrufe[0] === 'cave_crawler', 'der deutsche Name findet die Kennung', spawnrufe[0] ?? '(nichts)');
check(
  gesagt.some((t) => t.includes('Höhlenkriecher steht vor dir')),
  'und der Absender erfährt, dass es steht',
  gesagt.join(' | '),
);

// Die Kennung selbst genauso, und beides ohne Rücksicht auf Grossschreibung.
for (const eingabe of ['/spawn cave_crawler', '/spawn HÖHLENKRIECHER', '/spawn  höhlenkriecher ']) {
  spawnrufe.length = 0;
  runCommand(wirt, sitzung(AccessLevel.Gamemaster), eingabe);
  check(spawnrufe[0] === 'cave_crawler', `„${eingabe}" findet dasselbe Wesen`, spawnrufe[0] ?? '(nichts)');
}

/*
 * Die Gegenprobe, und sie ist hier die wichtigere: was es nicht gibt, wird
 * nicht gesetzt. Ohne sie prüfte das obige nur, dass irgendein Wort
 * durchgereicht wird — und ein Befehl, der auf `/spawn drache` stillschweigend
 * einen Höhlenkriecher setzte, wäre schlimmer als einer, der gar nichts tut.
 */
for (const eingabe of ['/spawn', '/spawn drache', '/spawn cave crawler', '/spawn kriecher']) {
  spawnrufe.length = 0;
  gesagt.length = 0;
  runCommand(wirt, sitzung(AccessLevel.Gamemaster), eingabe);
  check(spawnrufe.length === 0, `„${eingabe}" setzt nichts`);
  check(
    gesagt.some((t) => t.includes('Es gibt:') && t.includes('Höhlenkriecher')),
    `und „${eingabe}" nennt, was es gäbe`,
    gesagt.join(' | '),
  );
}

// Und wenn der Server nichts setzen kann, sagt der Befehl das — und behauptet
// nicht, es stünde etwas da.
spawnrufe.length = 0;
gesagt.length = 0;
runCommand(wirt, sitzung(AccessLevel.Gamemaster), '/spawn Gruftwärter');
check(spawnrufe[0] === 'dungeon_warden', 'der Gruftwärter wird versucht');
check(
  gesagt.some((t) => t.includes('kein Boden')) && !gesagt.some((t) => t.includes('steht vor dir')),
  'und eine abgelehnte Stelle meldet sich als solche',
  gesagt.join(' | '),
);

gesagt.length = 0;
stufenrufe.length = 0;
runCommand(wirt, sitzung(AccessLevel.Gamemaster), '/accesslevel helfer gamemaster');
check(stufenrufe.length === 0, 'ein Spielleiter setzt keine Stufen');
check(
  gesagt.some((t) => t.includes('admin')),
  'und erfährt, ab welcher Stufe es ginge',
  gesagt[0] ?? '(stumm)',
);

gesagt.length = 0;
stufenrufe.length = 0;
runCommand(wirt, sitzung(AccessLevel.Admin), '/accesslevel Helfer gamemaster');
check(
  stufenrufe.length === 1 && stufenrufe[0]!.stufe === AccessLevel.Gamemaster,
  'ein Verwalter schon — und die Stufe kommt richtig an',
  accessName(stufenrufe[0]?.stufe ?? AccessLevel.Player),
);
check(
  stufenrufe[0]?.name === 'Helfer',
  'der Name geht unverändert weiter — die Datenbank entscheidet über Gross und Klein',
  stufenrufe[0]?.name,
);

/*
 * Die Gegenprobe, auf die es ankommt: ein vertipptes Stufenwort darf **nicht**
 * durchgehen. `accessFromName` gäbe dafür „player" zurück, und aus einem
 * Vertipper würde eine Herabstufung, die wie ein gelungener Befehl aussieht.
 */
gesagt.length = 0;
stufenrufe.length = 0;
runCommand(wirt, sitzung(AccessLevel.Admin), '/accesslevel Helfer gamemster');
check(stufenrufe.length === 0, 'ein vertipptes Stufenwort wird nicht ausgeführt');
check(
  gesagt.some((t) => t.includes('keine Stufe')),
  'und benannt',
  gesagt[0] ?? '(stumm)',
);

gesagt.length = 0;
stufenrufe.length = 0;
runCommand(wirt, sitzung(AccessLevel.Admin), '/accesslevel Helfer');
check(stufenrufe.length === 0, 'ohne Stufe passiert nichts');
check(
  gesagt.some((t) => t.includes('Erwartet')),
  'und der Befehl sagt, was er erwartet',
);

/*
 * `/level` — ein Wort meint einen selbst, zwei jemand anderen.
 *
 * Die Unterscheidung hängt an der **Anzahl** der Wörter und nicht daran, ob
 * das erste eine Zahl ist. Eine Figur darf „7" heissen, und dann entschiede
 * eine Zeichenprüfung falsch: `/level 7` würde zu „setz die Figur 7 auf ...
 * nichts". Die Gegenprobe dazu steht unten.
 */
gesagt.length = 0;
levelrufe.length = 0;
runCommand(wirt, sitzung(AccessLevel.Gamemaster), '/level 30');
check(
  levelrufe.length === 1 && levelrufe[0]!.figur === '' && levelrufe[0]!.level === 30,
  'ein Wort setzt die eigene Stufe',
  JSON.stringify(levelrufe[0]),
);

levelrufe.length = 0;
runCommand(wirt, sitzung(AccessLevel.Gamemaster), '/level Aurel 12');
check(
  levelrufe.length === 1 && levelrufe[0]!.figur === 'Aurel' && levelrufe[0]!.level === 12,
  'zwei Wörter setzen die einer anderen Figur',
  JSON.stringify(levelrufe[0]),
);

// Die Gegenprobe zur Regel oben: eine Figur, die wie eine Zahl heisst.
levelrufe.length = 0;
runCommand(wirt, sitzung(AccessLevel.Gamemaster), '/level 7 12');
check(
  levelrufe.length === 1 && levelrufe[0]!.figur === '7' && levelrufe[0]!.level === 12,
  'eine Figur namens „7" wird als Figur gelesen',
  JSON.stringify(levelrufe[0]),
);

gesagt.length = 0;
levelrufe.length = 0;
runCommand(wirt, sitzung(AccessLevel.Gamemaster), '/level 0');
check(levelrufe.length === 0, 'Stufe null gibt es nicht');
runCommand(wirt, sitzung(AccessLevel.Gamemaster), `/level ${maxLevel() + 1}`);
check(levelrufe.length === 0, 'und über der Höchststufe auch nicht');
check(
  gesagt.every((t) => t.includes('ganze Zahl')),
  'beides wird mit der erlaubten Spanne beantwortet',
  gesagt[0] ?? '(stumm)',
);

levelrufe.length = 0;
runCommand(wirt, sitzung(AccessLevel.Player), '/level 30');
check(levelrufe.length === 0, 'und ein gewöhnlicher Spieler setzt gar keine Stufe');

/*
 * `/tp` — eine Karte, sonst nichts.
 *
 * Die Absage bei einem unbekannten Namen nennt die Karten, die es gibt. Sich
 * an einem Kartennamen zu vertippen ist der Normalfall; eine Absage ohne
 * Liste lässt einen dabei genauso ratlos zurück wie vorher.
 */
gesagt.length = 0;
tprufe.length = 0;
runCommand(wirt, sitzung(AccessLevel.Gamemaster), '/tp dornwald');
check(tprufe.length === 1 && tprufe[0] === 'dornwald', 'ein Spielleiter darf sich versetzen');

gesagt.length = 0;
runCommand(wirt, sitzung(AccessLevel.Gamemaster), '/tp gibtsnicht');
check(
  gesagt.some((t) => t.includes('lichtmoor')),
  'eine unbekannte Karte wird mit der Liste beantwortet',
  gesagt[0] ?? '(stumm)',
);

gesagt.length = 0;
tprufe.length = 0;
runCommand(wirt, sitzung(AccessLevel.Gamemaster), '/tp');
check(tprufe.length === 0, 'ohne Karte passiert nichts');
check(gesagt.some((t) => t.includes('Erwartet')), 'und der Befehl sagt, was er erwartet');

tprufe.length = 0;
runCommand(wirt, sitzung(AccessLevel.Player), '/tp dornwald');
check(tprufe.length === 0, 'ein gewöhnlicher Spieler versetzt sich nicht');

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

/*
 * `/accesslevel` bis in die Datenbank — und wieder heraus.
 *
 * Der Weg ist erst dann geprüft, wenn die Stufe eine **neue Anmeldung**
 * übersteht: geschrieben wird ins Konto, gelesen wird beim nächsten Anmelden,
 * und dazwischen liegt genau die Stelle, an der eine Zuweisung verloren gehen
 * kann. Ein Blick in dieselbe Sitzung würde das nicht zeigen.
 *
 * `${name}` ist das Konto von oben — ein gewöhnlicher Spieler, der eben noch
 * eine Absage auf `/gg` bekommen hat. Das ist die Gegenprobe, und sie steht
 * schon da.
 */
chefin.chat.length = 0;
chefin.send(encodeClientChat(1, `/accesslevel ${name} gamemaster`));
await sleep(1200);
check(
  chefin.chat.some((t) => t.includes('player') && t.includes('gamemaster')),
  'der Befehl meldet den Wechsel',
  chefin.chat.join(' | ') || '(stumm)',
);

const nochmal = await verbinde();
nochmal.send(encodeLogin({ name, password: 'geheimnis' }));
await warte(nochmal);
check(
  nochmal.lobby()?.accessLevel === AccessLevel.Gamemaster,
  'und die Stufe gilt nach dem nächsten Anmelden',
  accessName((nochmal.lobby()?.accessLevel ?? AccessLevel.Player) as AccessLevel),
);
nochmal.close();

// Ein Konto, das es nicht gibt, ändert nichts — und sagt das auch.
chefin.chat.length = 0;
chefin.send(encodeClientChat(1, '/accesslevel GibtsNicht admin'));
await sleep(1200);
check(
  chefin.chat.some((t) => t.includes('gibt es nicht')),
  'ein unbekanntes Konto wird als solches gemeldet',
  chefin.chat.join(' | ') || '(stumm)',
);

chefin.close();

await sleep(200);
shutdown();

console.log(
  failures === 0 ? '\nAlle Prüfungen bestanden.\n' : `\n${failures} Prüfung(en) fehlgeschlagen.\n`,
);
process.exit(failures === 0 ? 0 : 1);
