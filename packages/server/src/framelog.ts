/**
 * Was der Server ins Ausgabefenster schreibt, wenn ein Rahmen nicht aufgeht.
 *
 * Ein Rahmenfehler ist der unangenehmste Fehler im ganzen Netzweg: die
 * Verbindung steht, die Bytes kommen an, und trotzdem ist die Nachricht nicht
 * zu lesen. Was dabei hilft, ist **nicht** die Fehlermeldung allein — die sagt
 * nur, an welcher Prüfung es scheiterte —, sondern die Bytes daneben. Genau
 * deshalb steht hier ein Kopfauszug und ein Hexdump und nicht eine Zeile Text.
 *
 * Drei Dinge, die dieses Protokoll leisten muss:
 *
 *   **Es muss den Absender benennen.** Sitzung, Zustand, Konto, Adresse — ohne
 *   das weiss man nicht, ob ein Client kaputt ist oder jemand am Port
 *   herumprobiert.
 *
 *   **Es muss die rohen Bytes zeigen.** Ein falsches Magic sagt nichts; ein
 *   Hexdump, in dem `47 45 54 20` steht, sagt „da hat jemand HTTP gesprochen".
 *
 *   **Es darf das Fenster nicht fluten.** Wer im Sekundentakt neu verbindet und
 *   Müll schickt, würde jedes andere Protokoll aus dem Rückblick schieben.
 *   Deshalb eine Obergrenze je Minute und danach eine Zählzeile.
 */

import { FRAME_HEADER_SIZE, FRAME_MAGIC, FRAME_VERSION, FrameError } from '@aurelith/shared';

/** So viele Bytes zeigt der Hexdump. Mehr liest ohnehin niemand. */
const DUMP_BYTES = 48;
/** So viele Meldungen je Minute. Danach nur noch gezählt. */
const PRO_MINUTE = 20;

let fenster = 0;
let inDiesemFenster = 0;
let unterdrueckt = 0;

/** Wer den Rahmen geschickt hat — so viel, wie der Server gerade weiss. */
export interface RahmenQuelle {
  sitzung: number;
  zustand: string;
  konto: string;
  figur: string;
  adresse: string;
}

function hex(n: number, stellen = 2): string {
  return n.toString(16).padStart(stellen, '0');
}

/**
 * Bytes als Hexdump mit Klartextspalte.
 *
 * Die Klartextspalte ist der Grund für die ganze Übung: `GET / HTTP/1.1` in
 * einem Spielprotokoll erkennt man dort auf einen Blick, in Hexzahlen nicht.
 */
function dump(daten: Uint8Array): string {
  const zeilen: string[] = [];
  const ende = Math.min(daten.length, DUMP_BYTES);
  for (let i = 0; i < ende; i += 16) {
    const teil = daten.subarray(i, Math.min(i + 16, ende));
    const zahlen = [...teil].map((b) => hex(b)).join(' ').padEnd(47);
    const text = [...teil].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·')).join('');
    zeilen.push(`    ${hex(i, 4)}  ${zahlen}  ${text}`);
  }
  if (daten.length > ende) zeilen.push(`    … ${daten.length - ende} weitere Byte`);
  return zeilen.join('\n');
}

/**
 * Liest den Kopf so weit, wie die Bytes reichen — auch wenn er falsch ist.
 *
 * Bewusst ohne jede Prüfung: hier soll stehen, was **dasteht**, nicht was
 * dastehen dürfte. Ein Kopf, der bei der Prüfung durchgefallen ist, ist genau
 * der, den man sehen will.
 */
function kopfzeile(daten: Uint8Array): string {
  if (daten.length < FRAME_HEADER_SIZE) {
    return `Kopf unvollständig — ${daten.length} von ${FRAME_HEADER_SIZE} Byte`;
  }
  const sicht = new DataView(daten.buffer, daten.byteOffset, daten.byteLength);
  const magic = sicht.getUint8(0);
  const version = sicht.getUint8(1);
  const laenge = sicht.getUint16(6, true);
  const tatsaechlich = daten.length - FRAME_HEADER_SIZE;

  const anmerkung: string[] = [];
  if (magic !== FRAME_MAGIC) anmerkung.push(`Magic soll 0x${hex(FRAME_MAGIC)} sein`);
  if (version !== FRAME_VERSION) anmerkung.push(`Version soll ${FRAME_VERSION} sein`);
  if (laenge !== tatsaechlich) anmerkung.push(`Nutzlast ist ${tatsaechlich} Byte`);

  return (
    `Kopf: magic=0x${hex(magic)} version=${version} flags=0x${hex(sicht.getUint8(2))} ` +
    `cipher=${sicht.getUint8(3)} seq=${sicht.getUint16(4, true)} laenge=${laenge}` +
    (anmerkung.length > 0 ? `  ← ${anmerkung.join(', ')}` : '')
  );
}

/**
 * Deckelt die Ausgabe. Wahr heisst „schreiben", falsch heisst „nur zählen".
 *
 * Die Zählzeile kommt beim ersten unterdrückten Fall des nächsten Fensters —
 * so steht am Ende immer da, wie viel gefehlt hat, statt dass die Zahl
 * stillschweigend verschwindet.
 */
function darfSchreiben(): boolean {
  const jetzt = Math.floor(Date.now() / 60000);
  if (jetzt !== fenster) {
    if (unterdrueckt > 0) {
      console.warn(`[rahmen] ${unterdrueckt} weitere Meldung(en) in der letzten Minute unterdrückt.`);
    }
    fenster = jetzt;
    inDiesemFenster = 0;
    unterdrueckt = 0;
  }
  if (inDiesemFenster >= PRO_MINUTE) {
    unterdrueckt++;
    return false;
  }
  inDiesemFenster++;
  return true;
}

function wer(quelle: RahmenQuelle): string {
  const teile = [`Sitzung ${quelle.sitzung}`, quelle.zustand];
  if (quelle.konto) teile.push(quelle.konto + (quelle.figur ? `/${quelle.figur}` : ''));
  if (quelle.adresse) teile.push(quelle.adresse);
  return teile.join(' · ');
}

/** Ein Rahmen, der nicht aufgeht. Vier Zeilen, damit man ihn lesen kann. */
export function protokolliereRahmenfehler(
  quelle: RahmenQuelle,
  fehler: FrameError,
  daten: Uint8Array,
): void {
  if (!darfSchreiben()) return;
  console.error(
    `[rahmen] ${fehler.code} — ${fehler.message}\n` +
      `    ${wer(quelle)} · ${daten.length} Byte\n` +
      `    ${kopfzeile(daten)}\n` +
      dump(daten),
  );
}

/**
 * Ein Paket, das den Rahmen zwar füllte, aber beim Lesen zerbrach.
 *
 * Der andere Fehler, den es hier gibt: Rahmen in Ordnung, Inhalt nicht. Meist
 * ein Opcode, dessen Rumpf sich seit der letzten Fassung geändert hat — und
 * dann steht die Protokollversion nur zufällig noch auf derselben Zahl.
 */
export function protokolliereOpcodeFehler(
  quelle: RahmenQuelle,
  opcode: number,
  paket: Uint8Array,
  fehler: unknown,
): void {
  if (!darfSchreiben()) return;
  const text = fehler instanceof Error ? `${fehler.name}: ${fehler.message}` : String(fehler);
  console.error(
    `[paket] Opcode 0x${hex(opcode)} nicht lesbar — ${text}\n` +
      `    ${wer(quelle)} · Paket ${paket.length} Byte\n` +
      dump(paket),
  );
  if (fehler instanceof Error && fehler.stack) {
    // Der Aufrufweg zeigt, welcher Dekodierer ausgestiegen ist. Zwei Zeilen
    // davon reichen; der Rest ist Node-Innenleben.
    const zeilen = fehler.stack.split('\n').slice(1, 3).join('\n');
    console.error(zeilen);
  }
}

/** Zurücksetzen — für Prüfungen, die die Deckelung nicht erben sollen. */
export function setzeProtokollZurueck(): void {
  fenster = 0;
  inDiesemFenster = 0;
  unterdrueckt = 0;
}
