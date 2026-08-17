/**
 * Der Kompass neben der Uhr — zeigt er dorthin, wo man hinsieht?
 *
 * Die Rechnung ist zwei Zeilen lang und war trotzdem falsch, und die erste
 * Fassung dieser Prüfung war dabei **grün**. Sie hatte einen Winkel gegen einen
 * Buchstaben gehalten und dazu die Behauptung „Osten ist +x" — beide aus
 * derselben Annahme geschöpft, und die Annahme war der Fehler. Wer nach Norden
 * sah und die Kamera nach rechts drehte, las „W".
 *
 * Deshalb hängt hier nichts mehr an einer Zahl, die man sich ausdenken kann.
 * Verankert ist alles an einem Satz, den man ohne Code nachprüfen kann:
 *
 *     **Osten ist rechts, wenn man nach Norden sieht.**
 *
 * „Rechts" wird dafür ausgerechnet und nicht behauptet: es ist das Kreuzprodukt
 * aus Blickrichtung und Oben, dieselbe Rechnung, mit der jede Kamera ihre
 * Querachse bekommt. Und „Norden ist +z" steht nicht nur hier, sondern in der
 * ganzen Welt: Lichtmoors Nordufer liegt bei `z = 240`, die Sperrfläche darüber
 * heisst „Nordsee", und die Stufen der Monster steigen mit `z`.
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
const rund = (v: number): number => Math.round(v * 1000) / 1000;

/** Wohin ein Kurs sieht. Dieselbe Formel wie im Kern und in der Kamera. */
const blick = (yaw: number): { x: number; z: number } => ({
  x: rund(Math.sin(yaw)),
  z: rund(Math.cos(yaw)),
});

/**
 * Wohin „rechts" zeigt, wenn man diesen Kurs hält.
 *
 * `kreuz(vorwärts, oben)` mit `oben = (0,1,0)`. Ausgerechnet und nicht
 * abgeschrieben: genau die Zahl, die man sich nicht ausdenken darf, denn sie
 * war der ganze Fehler.
 */
const rechts = (yaw: number): { x: number; z: number } => {
  const f = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
  return { x: rund(f.y * 0 - f.z * 1), z: rund(f.x * 1 - f.y * 0) };
};

const gleich = (a: { x: number; z: number }, b: { x: number; z: number }): boolean =>
  Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;

/**
 * Der Kurs, den der Kompass mit dieser Richtung beschriftet — und zwar die
 * **Mitte** seines Sektors.
 *
 * Gesucht wird unter den acht Vielfachen von 45 Grad und nicht in Einerschritten
 * durch den ganzen Kreis: Letzteres fand den ersten Winkel, der noch „N" heisst,
 * und das ist der Rand bei −22 Grad. Die Rechnungen darunter vergleichen
 * Richtungsvektoren miteinander, und mit einem Sektorrand statt seiner Mitte
 * stimmt dabei nichts mehr. Dass die Mitten überhaupt auf Vielfachen von 45
 * Grad liegen, prüft der Abschnitt „Der Wechsel liegt in der Mitte".
 */
function kursFuer(richtung: string): number {
  for (let i = -4; i < 4; i++) {
    const yaw = (i * Math.PI) / 4;
    if (himmelsrichtung(yaw) === richtung) return yaw;
  }
  throw new Error(`kein Kurs ergibt „${richtung}"`);
}

// ---------------------------------------------------------------------------
console.log('Osten ist rechts, wenn man nach Norden sieht');
// ---------------------------------------------------------------------------

/*
 * Die eine Prüfung, an der alles hängt — und die einzige, die den Fehler
 * gefunden hätte. Beides kommt aus dem Kompass selbst: der Kurs, den er „N"
 * nennt, und der, den er „O" nennt. Verglichen wird die Querachse des einen
 * mit der Blickrichtung des anderen.
 */
const nord = kursFuer('N');
const ost = kursFuer('O');
const sued = kursFuer('S');
const west = kursFuer('W');

check(
  gleich(rechts(nord), blick(ost)),
  'rechts von Norden liegt Osten',
  `rechts (${rechts(nord).x}, ${rechts(nord).z}) gegen O (${blick(ost).x}, ${blick(ost).z})`,
);
/*
 * Und die Gegenprobe, ohne die ein Kompass durchginge, bei dem *alle* vier
 * Richtungen denselben Kurs meinen: links von Norden liegt Westen, und Süden
 * liegt hinten. Die drei zusammen legen die Rose eindeutig fest.
 */
check(
  gleich({ x: -rechts(nord).x, z: -rechts(nord).z }, blick(west)),
  'und links davon Westen',
  `W sieht nach (${blick(west).x}, ${blick(west).z})`,
);
check(
  gleich({ x: -blick(nord).x, z: -blick(nord).z }, blick(sued)),
  'und Süden liegt hinten',
  `S sieht nach (${blick(sued).x}, ${blick(sued).z})`,
);

// ---------------------------------------------------------------------------
console.log('\nUnd Norden ist +z, wie in der ganzen Karte');
// ---------------------------------------------------------------------------

/*
 * Die Verbindung zur Welt. Ohne sie stünde die Rose zwar in sich richtig, aber
 * womöglich um neunzig Grad verdreht zu dem, was die Karte „Norden" nennt —
 * und die nennt so ihr Ufer bei `z = 240`.
 */
check(blick(nord).z > 0.999, 'wer nach N sieht, sieht nach +z', String(blick(nord).z));
check(blick(ost).x < -0.999, 'und wer nach O sieht, nach −x', String(blick(ost).x));

// ---------------------------------------------------------------------------
console.log('\nNach rechts drehen heisst N, NO, O, SO, S, SW, W, NW');
// ---------------------------------------------------------------------------

/*
 * Der volle Kreis in Achtelschritten **nach rechts** — genau die Bewegung aus
 * der Fehlermeldung: „ich gucke nach Norden und drehe nach rechts". Nach
 * rechts heisst: um die Querachse herum, also in Richtung `rechts(yaw)`, und
 * das ist ein *fallender* `yaw`.
 *
 * Geprüft werden alle acht und nicht zwei: ein vertauschtes Paar in der Mitte
 * fiele bei einer Stichprobe nicht auf, und genau so entstehen Kompasse, bei
 * denen Nordost und Nordwest getauscht sind.
 */
let schritt = nord;
for (const erwartet of HIMMELSRICHTUNGEN) {
  const ist = himmelsrichtung(schritt);
  check(ist === erwartet, `eine Achteldrehung weiter: ${erwartet}`, ist);
  schritt -= Math.PI / 4;
}

// ---------------------------------------------------------------------------
console.log('\nDer Wechsel liegt in der Mitte zwischen zwei Richtungen');
// ---------------------------------------------------------------------------

/*
 * Ein Achtel des Kreises je Richtung heisst: der Wechsel liegt bei 22,5° und
 * nicht bei 45. Ohne diese Prüfung wäre auch eine Fassung grün, die auf
 * geradem Nordostkurs noch „N" anzeigt — der Kreis oben träfe sie nicht, denn
 * dort steht jeder Kurs genau auf seiner Richtung.
 */
check(himmelsrichtung(grad(-22)) === 'N', 'bei 22° nach rechts steht noch N', himmelsrichtung(grad(-22)));
check(himmelsrichtung(grad(-23)) === 'NO', 'bei 23° schon NO', himmelsrichtung(grad(-23)));
check(himmelsrichtung(grad(-67)) === 'NO', 'bei 67° noch NO', himmelsrichtung(grad(-67)));
check(himmelsrichtung(grad(-68)) === 'O', 'bei 68° schon O', himmelsrichtung(grad(-68)));

// ---------------------------------------------------------------------------
console.log('\nJeder Winkel ergibt eine Richtung');
// ---------------------------------------------------------------------------

/*
 * Der Kurs der Kamera läuft über den Nullpunkt hinaus in beide Richtungen —
 * `scene.yaw` zählt beim Drehen einfach weiter und wird nie zurückgeholt. Ein
 * `%` ohne Ausgleich gäbe für die eine Hälfte einen negativen Index und damit
 * `undefined`; im Spiel stünde dann plötzlich nichts mehr im Feld.
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
  himmelsrichtung(grad(-90)) === 'O' && himmelsrichtung(grad(270)) === 'O',
  'und Osten bleibt Osten, ob man links- oder rechtsherum kam',
  `${himmelsrichtung(grad(-90))} / ${himmelsrichtung(grad(270))}`,
);

console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
