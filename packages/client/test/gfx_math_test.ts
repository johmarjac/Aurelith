/**
 * Die Rechnung unter dem eigenen Renderer — ohne GPU, ohne Browser.
 *
 * Matrizen sind die Sorte Code, bei der ein Vorzeichenfehler nicht abstürzt,
 * sondern ein Bild ergibt, das *fast* stimmt: die Figur steht seitenverkehrt,
 * der Schatten fällt in die falsche Richtung, ferne Dinge verschwinden zu
 * früh. Solche Fehler am Bild zu suchen kostet Stunden; hier kosten sie eine
 * Zeile.
 *
 *   npx tsx packages/client/test/gfx_math_test.ts
 */

import {
  compose,
  copy,
  frustum,
  frustumFrom,
  frustumSeesSphere,
  identity,
  invert,
  mat4,
  mul,
  normalMatrix,
  perspective,
  quatFromYaw,
  transformPoint,
} from '../src/gfx/math.ts';

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const nah = (a: number, b: number, eps = 1e-5): boolean => Math.abs(a - b) <= eps;
const punkt = { x: 0, y: 0, z: 0 };

console.log('Aurelith — Renderer-Mathematik\n');

// --- Multiplikation --------------------------------------------------------

console.log('Multiplikation');
{
  const a = compose(mat4(), 1, 2, 3, 0, 0, 0, 1, 1, 1, 1);
  const i = identity(mat4());
  const r = mul(mat4(), a, i);
  check([...r].every((v, k) => nah(v, a[k]!)), 'mit der Einheitsmatrix ändert sich nichts');

  // Das Ziel darf eine der Eingaben sein — dafür rechnet `mul` über
  // Zwischenwerte. Ohne sie schriebe die Rechnung ihre eigene Eingabe um, und
  // zwar mitten im Durchlauf.
  const b = copy(mat4(), a);
  mul(b, b, i);
  check([...b].every((v, k) => nah(v, a[k]!)), 'das Ziel darf die Eingabe sein');

  // Reihenfolge zählt: erst drehen, dann verschieben ist nicht dasselbe wie
  // umgekehrt. Ein Test, der das nicht prüft, ginge auch mit vertauschten
  // Argumenten durch — der häufigste Matrizenfehler überhaupt.
  const dreh = compose(mat4(), 0, 0, 0, ...(quatFromYaw(new Float32Array(4), Math.PI / 2) as unknown as [number, number, number, number]), 1, 1, 1);
  const schub = compose(mat4(), 5, 0, 0, 0, 0, 0, 1, 1, 1, 1);
  const ds = mul(mat4(), dreh, schub);
  const sd = mul(mat4(), schub, dreh);
  check(![...ds].every((v, k) => nah(v, sd[k]!)), 'Reihenfolge zählt');

  // Und zwar so herum: `mul(a, b)` wendet erst b an, dann a.
  transformPoint(punkt, ds, 0, 0, 0);
  check(
    nah(punkt.x, 0) && nah(punkt.z, -5),
    'erst verschieben, dann drehen ergibt eine gedrehte Verschiebung',
    `${punkt.x.toFixed(2)}/${punkt.z.toFixed(2)}`,
  );
}

// --- Zusammensetzen --------------------------------------------------------

console.log('\nOrt, Drehung, Massstab');
{
  const m = compose(mat4(), 4, 5, 6, 0, 0, 0, 1, 1, 1, 1);
  transformPoint(punkt, m, 0, 0, 0);
  check(nah(punkt.x, 4) && nah(punkt.y, 5) && nah(punkt.z, 6), 'der Ursprung landet am Ort');

  // Blickrichtung: yaw = 0 schaut nach +Z, wie im ganzen Spiel (atan2(dx, dz)).
  // Ein Vorzeichenfehler hier drehte jede Figur um 180 Grad.
  const q = quatFromYaw(new Float32Array(4), Math.PI / 2);
  const gedreht = compose(mat4(), 0, 0, 0, q[0]!, q[1]!, q[2]!, q[3]!, 1, 1, 1);
  transformPoint(punkt, gedreht, 0, 0, 1);
  check(
    nah(punkt.x, 1) && nah(punkt.z, 0),
    'eine Vierteldrehung schickt +Z nach +X',
    `${punkt.x.toFixed(2)}/${punkt.z.toFixed(2)}`,
  );

  // Gegenprobe: ohne Drehung bleibt +Z, wo es war. Ohne sie prüfte die Zeile
  // oben nur, dass die Zahlen irgendetwas tun.
  const ohne = compose(mat4(), 0, 0, 0, 0, 0, 0, 1, 1, 1, 1);
  transformPoint(punkt, ohne, 0, 0, 1);
  check(nah(punkt.x, 0) && nah(punkt.z, 1), 'ohne Drehung bleibt +Z bei +Z');

  // Massstab wirkt vor der Drehung — sonst verzöge ein ungleichmässiger
  // Massstab das Modell schief.
  const breit = compose(mat4(), 0, 0, 0, q[0]!, q[1]!, q[2]!, q[3]!, 2, 1, 1);
  transformPoint(punkt, breit, 1, 0, 0);
  check(
    nah(punkt.x, 0) && nah(punkt.z, -2),
    'der Massstab gilt in den Achsen des Modells',
    `${punkt.x.toFixed(2)}/${punkt.z.toFixed(2)}`,
  );
}

// --- Invertieren -----------------------------------------------------------

console.log('\nInvertieren');
{
  const q = quatFromYaw(new Float32Array(4), 0.7);
  const m = compose(mat4(), 3, -2, 8, q[0]!, q[1]!, q[2]!, q[3]!, 2, 2, 2);
  const inv = mat4();
  check(invert(inv, m), 'eine gewöhnliche Matrix lässt sich invertieren');

  const zurueck = mul(mat4(), m, inv);
  const einheit = identity(mat4());
  check(
    [...zurueck].every((v, k) => nah(v, einheit[k]!, 1e-4)),
    'Matrix mal Inverse ergibt die Einheitsmatrix',
  );

  // Ein Massstab von null lässt sich nicht rückgängig machen. Wichtig ist
  // nicht, dass es scheitert, sondern *wie*: mit Einheitsmatrix und einem
  // ehrlichen `false`. Ein stilles NaN zöge sich durch jede weitere Rechnung
  // und wäre im Bild nur noch als schwarze Fläche zu sehen.
  const platt = compose(mat4(), 0, 0, 0, 0, 0, 0, 1, 1, 0, 1);
  const kaputt = mat4();
  check(!invert(kaputt, platt), 'eine platte Matrix meldet sich als nicht invertierbar');
  check([...kaputt].every((v, k) => nah(v, einheit[k]!)), 'und hinterlässt die Einheitsmatrix');
  check([...kaputt].every(Number.isFinite), 'kein NaN im Ergebnis');
}

// --- Normalen --------------------------------------------------------------

console.log('\nNormalen');
{
  // Eine Fläche, die doppelt so hoch skaliert wird: ihre Normale kippt, wenn
  // man die Modellmatrix darauf anwendet. Die Normalenmatrix ist genau die
  // Korrektur dafür.
  const m = compose(mat4(), 0, 0, 0, 0, 0, 0, 1, 1, 2, 1);
  const nm = normalMatrix(mat4(), m);

  // Kante entlang +Y, Normale entlang +Z: nach dem Skalieren muss die Normale
  // weiterhin senkrecht auf der Kante stehen.
  const kante = { x: 0, y: 0, z: 0 };
  transformPoint(kante, m, 0, 1, 0);
  const normale = { x: 0, y: 0, z: 0 };
  transformPoint(normale, nm, 0, 0, 1);
  const skalar = kante.x * normale.x + kante.y * normale.y + kante.z * normale.z;
  check(nah(skalar, 0, 1e-4), 'die Normale bleibt senkrecht auf der Fläche');

  // Gegenprobe: mit der Modellmatrix statt der Normalenmatrix stimmt es hier
  // zufällig auch — deshalb ein Fall mit schräger Normale, bei dem es nicht
  // mehr stimmt.
  const schraeg = { x: 0, y: 0, z: 0 };
  transformPoint(schraeg, m, 0, 1, 1);
  const falsch = { x: 0, y: 0, z: 0 };
  transformPoint(falsch, m, 0, -1, 1);
  const falschSkalar = schraeg.x * falsch.x + schraeg.y * falsch.y + schraeg.z * falsch.z;
  check(!nah(falschSkalar, 0, 1e-4), 'mit der Modellmatrix stünde sie schief');

  const richtig = { x: 0, y: 0, z: 0 };
  transformPoint(richtig, nm, 0, -1, 1);
  const richtigSkalar =
    schraeg.x * richtig.x + schraeg.y * richtig.y + schraeg.z * richtig.z;
  check(nah(richtigSkalar, 0, 1e-4), 'mit der Normalenmatrix steht sie richtig');
}

// --- Projektion ------------------------------------------------------------

console.log('\nProjektion');
{
  const p = perspective(mat4(), Math.PI / 3, 16 / 9, 0.1, 100);

  // Blick nach −Z: was davor liegt, landet im Bild.
  transformPoint(punkt, p, 0, 0, -10);
  check(
    Math.abs(punkt.x) <= 1 && Math.abs(punkt.y) <= 1 && Math.abs(punkt.z) <= 1,
    'ein Punkt vor der Kamera landet im Einheitswürfel',
    `${punkt.x.toFixed(2)}/${punkt.y.toFixed(2)}/${punkt.z.toFixed(2)}`,
  );

  // Die Nahebene liegt bei −1, die Fernebene bei +1. Verwechselt man beides,
  // ist der Tiefenpuffer verkehrt herum und alles sichtbar, was verdeckt sein
  // sollte.
  transformPoint(punkt, p, 0, 0, -0.1);
  check(nah(punkt.z, -1, 1e-4), 'die Nahebene liegt bei −1', punkt.z.toFixed(4));
  transformPoint(punkt, p, 0, 0, -100);
  check(nah(punkt.z, 1, 1e-4), 'die Fernebene bei +1', punkt.z.toFixed(4));

  // Seitenverhältnis: bei 16:9 wird ein quadratischer Ausschnitt breiter als
  // hoch abgebildet, also ist x kleiner als y.
  transformPoint(punkt, p, 1, 1, -10);
  check(Math.abs(punkt.x) < Math.abs(punkt.y), 'das Seitenverhältnis geht in x ein');

  // Unendliche Fernebene: für die Himmelskuppel. Was sehr weit weg ist, darf
  // nicht plötzlich verschwinden.
  const weit = perspective(mat4(), Math.PI / 3, 1, 0.1, Infinity);
  transformPoint(punkt, weit, 0, 0, -1e6);
  check(punkt.z <= 1 + 1e-4 && Number.isFinite(punkt.z), 'ohne Fernebene bleibt auch sehr Fernes im Bild', punkt.z.toFixed(4));
}

// --- Sichtkörper -----------------------------------------------------------

console.log('\nSichtkörper');
{
  const proj = perspective(mat4(), Math.PI / 3, 1, 0.1, 100);
  // Kamera im Ursprung, Blick nach −Z: die Sichtmatrix ist die Einheitsmatrix.
  const f = frustumFrom(frustum(), proj);

  check(frustumSeesSphere(f, 0, 0, -10, 1), 'was vor der Kamera steht, ist sichtbar');
  check(!frustumSeesSphere(f, 0, 0, 10, 1), 'was dahinter steht, nicht');
  check(!frustumSeesSphere(f, 0, 0, -200, 1), 'und was hinter der Fernebene liegt, auch nicht');
  check(!frustumSeesSphere(f, 60, 0, -10, 1), 'weit seitlich ebenfalls nicht');

  // Der Fall, auf den es ankommt: eine grosse Kugel, deren Mittelpunkt
  // ausserhalb liegt, ragt trotzdem ins Bild. Wer nur den Mittelpunkt prüft,
  // lässt ganze Geländekacheln verschwinden, sobald man nah genug steht.
  check(frustumSeesSphere(f, 60, 0, -10, 55), 'eine grosse Kugel ragt herein');

  // Und die Gegenprobe zur Normierung: ohne normierte Ebenen wäre der
  // Radiusvergleich falsch skaliert, und dieser Fall fiele um.
  check(frustumSeesSphere(f, 0, 0, -0.05, 0.2), 'eine Kugel um die Nahebene bleibt drin');
}

console.log(
  `\n${failures === 0 ? 'Alle Pruefungen bestanden.' : `${failures} Pruefung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
