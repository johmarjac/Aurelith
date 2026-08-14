/**
 * Die Attributtafel — Rechnung, Sammlung, Anzeige.
 *
 * Ohne Server und ohne Netz: das ist eine Regel, und Regeln lassen sich
 * einzeln prüfen. Was hier steht, entscheidet später jedes Gleichgewicht im
 * Spiel — ein Prozentzuschlag, der auf den Grundwert statt auf die Summe
 * geht, verschiebt jede Rechnung, und zwar unauffällig.
 *
 *   npx tsx packages/server/test/attributes_test.ts
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ATTRIBUTES,
  AttributeSheet,
  EIGENSCHAFTEN,
  attributeDef,
  eigenschaftsWirkung,
  formatAttribute,
  formatBeitrag,
  offenePunkte,
  startEigenschaften,
  summiere,
  verteiltePunkte,
} from '@aurelith/shared';
import { loadContentFromDisk } from '../src/content.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Die Eigenschaften rechnen mit `tuning.json` — was ein Punkt wert ist, steht
 * dort und nicht hier. Eine im Test eingetippte Zahl wäre beim nächsten Drehen
 * an der Datei falsch, ohne dass jemand es merkt.
 */
const ladeInhalte = (): Promise<unknown> =>
  loadContentFromDisk(join(root, 'assets', 'content'));

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('Aurelith — Attribute\n');

// ---------------------------------------------------------------------------
// Die Rechnung
// ---------------------------------------------------------------------------

console.log('Rechnung');

check(summiere(10, []) === 10, 'ohne Beiträge bleibt der Grundwert');
check(
  summiere(10, [{ quelle: 'a', flach: 5, prozent: 0 }]) === 15,
  'ein flacher Zuschlag wird addiert',
);
check(
  summiere(10, [{ quelle: 'a', flach: 0, prozent: 0.5 }]) === 15,
  'ein Anteil wird malgenommen',
);
check(
  summiere(10, [{ quelle: 'a', flach: -3, prozent: 0 }]) === 7,
  'und Abzüge gehen genauso',
);

// Die Festlegung, auf die es ankommt: Anteile gelten auf die **Summe**, nicht
// auf den Grundwert. Sonst wäre ein Prozentzuschlag umso schwächer, je besser
// die Ausrüstung ist.
const gemischt = summiere(10, [
  { quelle: 'Stück', flach: 10, prozent: 0 },
  { quelle: 'Segen', flach: 0, prozent: 0.5 },
]);
check(gemischt === 30, 'Anteile gelten auf Grundwert plus flache Zuschläge', String(gemischt));
check(gemischt !== 25, 'und nicht nur auf den Grundwert', `${gemischt} statt 25`);

// Mehrere Anteile addieren sich, sie stapeln sich nicht multiplikativ. Auch
// das ist eine Festlegung — bei drei Quellen ist der Unterschied schon spürbar.
const zweiAnteile = summiere(100, [
  { quelle: 'a', flach: 0, prozent: 0.1 },
  { quelle: 'b', flach: 0, prozent: 0.1 },
]);
check(zweiAnteile === 120, 'zwei Anteile addieren sich', String(zweiAnteile));

// ---------------------------------------------------------------------------
// Das Sammeln
// ---------------------------------------------------------------------------

console.log('\nSammeln');

const sheet = new AttributeSheet();
sheet.basis('attackDamage', 10);
sheet.basis('maxHp', 100);
sheet.fuege('attackDamage', 'Eisenklinge', 12);
sheet.fuege('attackDamage', 'Ledersatz', 3);
sheet.fuege('attackDamage', 'Nichts', 0);
sheet.fuege('maxHp', 'Wams', 0, 0.1);

check(sheet.wert('attackDamage') === 25, 'die Summe stimmt', String(sheet.wert('attackDamage')));
// Auf ein Tausendstel genau: Fliesskomma rechnet 100 × 1,1 nicht auf den
// Punkt aus, und ein Test, der das verlangt, prüft die Zahlendarstellung und
// nicht die Regel.
check(
  Math.abs(sheet.wert('maxHp') - 110) < 0.001,
  'auch mit Anteil',
  String(sheet.wert('maxHp')),
);

const alle = sheet.alle();
const angriff = alle.find((a) => a.id === 'attackDamage');
check(angriff?.quellen.length === 2, 'Null-Beiträge stehen nicht in der Liste', `${angriff?.quellen.length}`);
check(angriff?.basis === 10, 'der Grundwert steht separat');
check(
  angriff !== undefined &&
    Math.abs(angriff.basis + angriff.quellen.reduce((s, q) => s + q.flach, 0) - angriff.gesamt) <
      1e-9,
  'Grundwert und Beiträge ergeben die Summe',
);

// Was nie gesetzt wurde, taucht auch nicht auf: eine Zeile „Mana 0" für eine
// Figur ohne Mana wäre Füllmaterial und keine Auskunft.
check(!alle.some((a) => a.id === 'maxMp'), 'ungesetzte Attribute bleiben draussen');

// Und was der Tabelle noch unbekannt ist, kommt trotzdem mit — sonst
// verschluckt die Anzeige genau das Attribut, das gerade neu dazukommt.
const neu = new AttributeSheet();
neu.basis('zauberkraft', 7);
check(neu.alle().some((a) => a.id === 'zauberkraft'), 'ein neues Attribut wird durchgereicht');

// Die Reihenfolge folgt der Tabelle und nicht dem Zufall der Eintragung.
const gemischtSheet = new AttributeSheet();
gemischtSheet.basis('defense', 1);
gemischtSheet.basis('maxHp', 1);
check(
  gemischtSheet.alle()[0]?.id === 'maxHp',
  'die Reihenfolge kommt aus der Tabelle',
  gemischtSheet.alle().map((a) => a.id).join(', '),
);

// ---------------------------------------------------------------------------
// Anzeige
// ---------------------------------------------------------------------------

console.log('\nAnzeige');

check(formatAttribute('attackDamage', 25) === '25', 'ganze Zahlen ohne Komma');
check(formatAttribute('attackRange', 2.4) === '2.4', 'gebrochene mit einer Stelle');
check(formatAttribute('critChance', 0.075) === '7.5 %', 'Chancen in Prozent');
check(formatAttribute('critMultiplier', 1.5) === '×1.50', 'Faktoren mit Kreuz');
check(formatAttribute('attackCooldown', 0.8) === '0.80 s', 'Zeiten mit Sekunde');

check(
  formatBeitrag('attackDamage', { quelle: 'Eisenklinge', flach: 12, prozent: 0 }) ===
    'Eisenklinge +12',
  'ein Beitrag nennt Quelle und Vorzeichen',
);
check(
  formatBeitrag('attackCooldown', { quelle: 'Bogen', flach: -0.2, prozent: 0 }).includes('−'),
  'Abzüge bekommen ein Minus',
  formatBeitrag('attackCooldown', { quelle: 'Bogen', flach: -0.2, prozent: 0 }),
);

// Jede Kennung in der Tabelle hat einen Namen und eine Form — sonst steht im
// Fenster die Kennung, und das ist keine Anzeige, sondern ein Hinweis auf
// einen vergessenen Eintrag.
const unvollstaendig = ATTRIBUTES.filter((a) => !a.name || !a.form);
check(unvollstaendig.length === 0, 'jedes Attribut hat Namen und Form', unvollstaendig.map((a) => a.id).join(', '));
check(attributeDef('attackDamage')?.name === 'Angriff', 'und ist über die Kennung zu finden');
check(attributeDef('gibtsnicht') === undefined, 'unbekannte Kennungen finden nichts');

// Und die Schlagpause ist die eine, bei der weniger besser ist. Ohne diese
// Angabe läse sich „+0,2 s" wie ein Gewinn.
check(attributeDef('attackCooldown')?.wenigerIstBesser === true, 'bei der Schlagpause ist weniger besser');
check(
  attributeDef('attackDamage')?.wenigerIstBesser !== true,
  'beim Angriff nicht',
);

// ---------------------------------------------------------------------------
// Die vier Grundeigenschaften
// ---------------------------------------------------------------------------
//
// Sie sind der einzige Teil der Werte, an dem der Spieler dreht. Was ein Punkt
// bewirkt, steht in `eigenschaftsWirkung` — an einer Stelle, weil Server und
// Charakterfenster dieselbe Auskunft brauchen.

console.log('\nGrundeigenschaften');

await ladeInhalte();

const start = startEigenschaften();
check(
  EIGENSCHAFTEN.every((d) => start[d.id] === start.staerke),
  'eine frische Figur beginnt auf allen vieren gleich',
  JSON.stringify(start),
);
check(verteiltePunkte(start) === 0, 'und hat nichts verteilt');
check(offenePunkte(1, start) === 0, 'auf Stufe eins gibt es nichts zu verteilen');

const zehn = offenePunkte(10, start);
check(zehn > 0, `Stufe zehn bringt Punkte (${zehn})`);
check(
  offenePunkte(20, start) > zehn,
  'und Stufe zwanzig mehr — die Gegenprobe zu „irgendeine Zahl"',
);

// Verteilen zieht ab, und zwar genau so viel, wie es kostet.
const verteilt = { ...start, ausdauer: start.ausdauer + 3 };
check(verteiltePunkte(verteilt) === 3, 'drei Punkte gelten als drei verteilte');
check(offenePunkte(10, verteilt) === zehn - 3, 'und fehlen dann bei den offenen');

/*
 * Der Fall, um den es bei `/level` nach unten geht.
 *
 * Wer auf Stufe 30 verteilt hat und dann auf Stufe 2 gesetzt wird, hat mehr
 * ausgegeben, als seine Stufe hergibt. Eine Zahl mit Minus davor wäre in der
 * Anzeige unbrauchbar und im Server gefährlich — `setzePunkt` rechnet damit,
 * wie viele offen sind.
 */
const ueberzogen = { ...start, staerke: start.staerke + 40 };
check(offenePunkte(2, ueberzogen) === 0, 'mehr verteilt als verdient ergibt null offene');

// Und die Wirkung: Ausdauer muss Leben bringen, sonst ist der Punkt sinnlos.
const ohne = eigenschaftsWirkung(start).find((w) => w.attribut === 'maxHp')?.flach ?? 0;
const mit = eigenschaftsWirkung({ ...start, ausdauer: start.ausdauer + 10 }).find(
  (w) => w.attribut === 'maxHp',
)?.flach ?? 0;
check(mit > ohne, `zehn Punkte Ausdauer geben Leben (${ohne} → ${mit})`);

check(
  eigenschaftsWirkung(start).some((w) => w.attribut === 'attackDamage' && w.quelle === 'Stärke'),
  'und jeder Beitrag nennt seine Eigenschaft — dafür die Herkunftszeile',
);

/*
 * Die Schlagpause ist der einzige Anteil statt Zuschlag — und sie ist
 * gedeckelt. Ohne Deckel führte genug Geschick zu einer Pause von null, und
 * der Kern kennt dafür keinen Sonderfall.
 */
const pause = (geschick: number): number =>
  eigenschaftsWirkung({ ...start, geschick }).find((w) => w.attribut === 'attackCooldown')
    ?.prozent ?? 0;
check(pause(100) < pause(10), 'mehr Geschick kürzt die Schlagpause stärker');
check(pause(100000) === pause(1000000), 'aber nur bis zum Deckel');
check(pause(100000) > -1, 'und nie so weit, dass die Pause verschwindet', String(pause(100000)));

console.log(
  failures === 0 ? '\nAlle Prüfungen bestanden.\n' : `\n${failures} Prüfung(en) fehlgeschlagen.\n`,
);
process.exit(failures === 0 ? 0 : 1);
