/**
 * Der Kompass neben der Uhr — zeigt er dorthin, wo man hinsieht?
 *
 * Die Rechnung ist zwei Zeilen lang und trotzdem die Sorte, die man am Bild
 * nicht prüfen kann: „N" steht auch dann da, wenn N in Wahrheit Süden ist, und
 * wer im Spiel nachsieht, hat kein zweites Nord zum Vergleichen. Deshalb steht
 * hier nicht nur, welcher Winkel welchen Buchstaben ergibt, sondern auch,
 * **wohin man dabei tatsächlich läuft**.
 *
 * Norden ist +z. Das steht nicht nur in `himmelsrichtung`, sondern in der
 * ganzen Welt: Lichtmoors Nordufer liegt bei `z = 240`, die Sperrfläche
 * darüber heisst „Nordsee", und die Stufen der Monster steigen mit `z`. Ein
 * Kompass, der das anders sähe, wäre schlimmer als keiner.
 *
 *   npx tsx packages/client/test/kompass_test.ts
 */

import { HIMMELSRICHTUNGEN, himmelsrichtung } from '@aurelith/shared';

let failures = 0;
function check(ok: boolean, was: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${was}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('Aurelith — Kompass\n');

const grad = (g: number): number => (g * Math.PI) / 180;

console.log('Acht Richtungen im Uhrzeigersinn');

/*
 * Der volle Kreis, jeweils genau auf der Richtung. Alle acht und nicht nur
 * zwei: ein vertauschtes Paar in der Mitte der Tabelle fiele bei einer
 * Stichprobe nicht auf, und genau so entstehen Kompasse, bei denen Nordost
 * und Nordwest getauscht sind.
 */
const ERWARTET: Array<[number, string]> = [
  [0, 'N'],
  [45, 'NO'],
  [90, 'O'],
  [135, 'SO'],
  [180, 'S'],
  [225, 'SW'],
  [270, 'W'],
  [315, 'NW'],
];
for (const [winkel, richtung] of ERWARTET) {
  const ist = himmelsrichtung(grad(winkel));
  check(ist === richtung, `${String(winkel).padStart(3)}° ist ${richtung}`, ist);
}

console.log('\nUnd der Wechsel liegt in der Mitte');

/*
 * Ein Achtel des Kreises je Richtung heisst: der Wechsel liegt bei 22,5° und
 * nicht bei 45. Ohne diese Prüfung wäre auch eine Fassung grün, die auf
 * geradem Nordostkurs noch „N" anzeigt — die Tabelle oben träfe sie nicht,
 * denn dort steht jeder Winkel genau auf seiner Richtung.
 */
check(himmelsrichtung(grad(22)) === 'N', 'bei 22° steht noch N', himmelsrichtung(grad(22)));
check(himmelsrichtung(grad(23)) === 'NO', 'bei 23° schon NO', himmelsrichtung(grad(23)));
check(himmelsrichtung(grad(67)) === 'NO', 'bei 67° noch NO', himmelsrichtung(grad(67)));
check(himmelsrichtung(grad(68)) === 'O', 'bei 68° schon O', himmelsrichtung(grad(68)));

console.log('\nJeder Winkel ergibt eine Richtung');

/*
 * Der Kurs der Kamera läuft über den Nullpunkt hinaus in beide Richtungen —
 * `scene.yaw` zählt beim Drehen einfach weiter und wird nie zurückgeholt.
 * Ein `%` ohne Ausgleich gäbe für negative Winkel einen negativen Index und
 * damit `undefined`; im Spiel stünde dann plötzlich nichts mehr im Feld.
 */
let unbekannt = 0;
let schlimmster = '';
for (let g = -3600; g <= 3600; g += 7) {
  const r = himmelsrichtung(grad(g));
  if (!HIMMELSRICHTUNGEN.includes(r)) {
    unbekannt++;
    if (schlimmster === '') schlimmster = `${g}° → ${String(r)}`;
  }
}
check(unbekannt === 0, 'auch nach zehn Umdrehungen in beide Richtungen', schlimmster || 'keiner');

// Und dasselbe Ergebnis nach einer vollen Umdrehung — sonst wäre die Prüfung
// darüber mit einer Fassung zufrieden, die irgendetwas Gültiges zurückgibt.
check(
  himmelsrichtung(grad(-90)) === 'W' && himmelsrichtung(grad(630)) === 'W',
  'und Westen bleibt Westen, ob man links- oder rechtsherum kam',
  `${himmelsrichtung(grad(-90))} / ${himmelsrichtung(grad(630))}`,
);

console.log('\nUnd die Richtung stimmt mit der Welt überein');

/*
 * Die eigentliche Prüfung.
 *
 * Alles oben wäre auch dann grün, wenn die ganze Rose um neunzig Grad
 * verdreht stünde — es prüft nur die Tabelle gegen sich selbst. Hier steht die
 * Verbindung zur Welt: die Blickrichtung zu einem Kurs ist `(sin yaw, cos
 * yaw)`, genau wie im Kern (`moveWithCollision`) und in der Kamera
 * (`scene.ts`). Wer nach „N" sieht, muss damit nach +z sehen.
 */
const blick = (yaw: number): { x: number; z: number } => ({ x: Math.sin(yaw), z: Math.cos(yaw) });

const nordKurs = ERWARTET.find(([, r]) => r === 'N')![0];
const ostKurs = ERWARTET.find(([, r]) => r === 'O')![0];
const suedKurs = ERWARTET.find(([, r]) => r === 'S')![0];
const westKurs = ERWARTET.find(([, r]) => r === 'W')![0];

check(blick(grad(nordKurs)).z > 0.99, 'wer nach N sieht, sieht nach +z', blick(grad(nordKurs)).z.toFixed(2));
check(blick(grad(ostKurs)).x > 0.99, 'wer nach O sieht, sieht nach +x', blick(grad(ostKurs)).x.toFixed(2));
// Die Gegenproben: Süden und Westen zeigen in die anderen Richtungen. Ohne sie
// bestünde auch eine Rose, in der alle vier nach +z zeigen.
check(blick(grad(suedKurs)).z < -0.99, 'und wer nach S sieht, nach −z', blick(grad(suedKurs)).z.toFixed(2));
check(blick(grad(westKurs)).x < -0.99, 'und wer nach W sieht, nach −x', blick(grad(westKurs)).x.toFixed(2));

console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
