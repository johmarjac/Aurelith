/**
 * Die Grafikeinstellungen — was aus dem Speicher zurückkommt.
 *
 * Eine Einstellung im Browserspeicher ist eine Zeichenkette, die irgendwann
 * einmal von irgendeiner Fassung dieses Spiels geschrieben wurde. Sie kann
 * eine Stufe nennen, die es nicht mehr gibt; sie kann halb sein; sie kann
 * Unsinn sein. Was dann herauskommt, entscheidet, ob das Spiel startet oder
 * mit einer Sichtweite von `undefined` in ein schwarzes Bild läuft.
 *
 * Deshalb steht hier nicht „Speichern und Laden geht", sondern: **was passiert
 * mit kaputten Daten**.
 *
 *   npx tsx packages/client/test/grafik_test.ts
 */

import {
  GRAFIK_VORGABE,
  SICHTWEITEN,
  SICHTWEITE_NAMEN,
  ladeGrafik,
  setzeGrafik,
} from '../src/ui/grafik.ts';

let failures = 0;
function check(ok: boolean, was: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${was}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/*
 * Ein Speicher aus einer Zeile — node hat keinen.
 *
 * Nachgebaut und nicht weggemockt: die Datei fängt Ausnahmen ab („privates
 * Fenster"), und ein Speicher, der gar nicht da ist, ginge durch diesen Zweig
 * statt durch den, um den es geht.
 */
const daten = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => daten.get(k) ?? null,
  setItem: (k: string, v: string) => void daten.set(k, v),
  removeItem: (k: string) => void daten.delete(k),
  clear: () => daten.clear(),
};

console.log('Aurelith — Grafikeinstellungen\n');

console.log('Ohne Eintrag gilt die Vorgabe');

daten.clear();
const frisch = ladeGrafik();
check(frisch.sichtweite === GRAFIK_VORGABE.sichtweite, 'die Sichtweite', frisch.sichtweite);
check(frisch.schatten === GRAFIK_VORGABE.schatten, 'die Schatten');
check(frisch.umriss === GRAFIK_VORGABE.umriss, 'der Umriss');
/*
 * Und die Vorgabe ist die grosszügige. Eine Voreinstellung auf „Niedrig" wäre
 * die Sorte Sparsamkeit, die niemand bemerkt, ausser dass das Spiel schlechter
 * aussieht als es könnte — wer sparen muss, stellt um.
 */
check(GRAFIK_VORGABE.sichtweite === 'hoch', 'und sie ist die grosszügige');

console.log('\nWas gespeichert wurde, kommt zurück');

setzeGrafik({ sichtweite: 'niedrig', schatten: false, umriss: false });
const zurueck = ladeGrafik();
check(
  zurueck.sichtweite === 'niedrig' && !zurueck.schatten && !zurueck.umriss,
  'alle drei Werte',
  JSON.stringify(zurueck),
);
// Gegenprobe: es ist wirklich der Speicher und nicht ein Rest im Modul.
daten.clear();
check(ladeGrafik().sichtweite === 'hoch', 'und ohne Speicher wieder die Vorgabe');

console.log('\nKaputte Daten kippen nichts um');

/*
 * Die eigentliche Prüfung. Jede dieser Zeilen hat irgendwann einmal in einem
 * Browser gestanden — die erste, weil eine Stufe umbenannt wurde, die zweite,
 * weil jemand von Hand hineingeschrieben hat, die dritte, weil ein Schreiben
 * mitten im Zumachen des Fensters abgebrochen ist.
 */
const kaputt: Array<[string, string]> = [
  ['eine Stufe, die es nicht mehr gibt', '{"sichtweite":"extrem","schatten":true,"umriss":true}'],
  ['ein Wahrheitswert als Text', '{"sichtweite":"mittel","schatten":"ja","umriss":1}'],
  ['halbes JSON', '{"sichtweite":"mittel"'],
  ['gar kein JSON', 'kaputt'],
  ['eine Zahl statt eines Satzes', '42'],
  ['null', 'null'],
];
for (const [was, roh] of kaputt) {
  daten.set('aurelith.grafik', roh);
  let werte;
  try {
    werte = ladeGrafik();
  } catch (err) {
    check(false, `${was} wirft`, String(err));
    continue;
  }
  check(
    werte.sichtweite in SICHTWEITEN &&
      typeof werte.schatten === 'boolean' &&
      typeof werte.umriss === 'boolean',
    `${was} ergibt trotzdem gültige Werte`,
    JSON.stringify(werte),
  );
}

// Und die Gegenprobe zu allem darüber: eine **gültige** Zeile wird nicht
// stillschweigend auf die Vorgabe zurückgesetzt. Ohne sie wäre auch eine
// Fassung grün, die den Speicher gar nicht liest.
daten.set('aurelith.grafik', '{"sichtweite":"mittel","schatten":false,"umriss":true}');
const gut = ladeGrafik();
check(
  gut.sichtweite === 'mittel' && gut.schatten === false && gut.umriss === true,
  'eine gültige Zeile bleibt dagegen stehen',
  JSON.stringify(gut),
);

console.log('\nDie Auswahl und die Zahlen passen zusammen');

/*
 * Was im Menü steht, muss es auch als Zahl geben — und umgekehrt. Zwei Listen
 * nebeneinander laufen sonst auseinander, und der Fehler wäre eine Auswahl,
 * die eine Sichtweite von `undefined` einstellt.
 */
check(
  SICHTWEITE_NAMEN.every(([stufe]) => stufe in SICHTWEITEN),
  'jeder Eintrag im Menü hat eine Zahl',
  SICHTWEITE_NAMEN.map(([s]) => s).join(', '),
);
check(
  SICHTWEITE_NAMEN.length === Object.keys(SICHTWEITEN).length,
  'und keine Zahl fehlt im Menü',
  `${SICHTWEITE_NAMEN.length} zu ${Object.keys(SICHTWEITEN).length}`,
);
// Und sie steigen. Eine Auswahl, in der „Hoch" weniger zeigt als „Niedrig",
// wäre formal vollständig und praktisch verkehrt herum.
const zahlen = SICHTWEITE_NAMEN.map(([s]) => SICHTWEITEN[s]);
check(
  zahlen.every((z, i) => i === 0 || z > zahlen[i - 1]!),
  'und sie steigen von Niedrig nach Hoch',
  zahlen.join(' < '),
);

console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
