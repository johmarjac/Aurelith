/**
 * Der Grasteppich — was sich an ihm von aussen prüfen lässt.
 *
 * Wie Halme aussehen, sagt kein Test. Was er sagen kann, ist alles, was am
 * Mitwandern schiefgehen kann, und das ist einiges:
 *
 *   1. Die Halme bleiben im Kreis um die Figur — sonst zeichnet man Gras,
 *      das niemand sieht.
 *   2. Sie **kleben nicht an der Figur**. Wer läuft, soll an Halmen
 *      vorbeikommen; wandern sie mit, sieht die Wiese aus wie ein Teppich,
 *      den man vor sich herschiebt. Das ist der eigentliche Fehler dieser
 *      Bauart, und die Prüfung darauf ist der Grund für die ganze Datei.
 *   3. Wo Wasser steht und wo es steil ist, wächst nichts.
 *   4. Am Rand wird ausgeblendet, damit das Umlaufen unsichtbar bleibt.
 *
 *   npx tsx packages/client/test/gras_test.ts
 */

import * as THREE from 'three';

export {};

let failures = 0;
function check(ok: boolean, was: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${was}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('Aurelith — Grasteppich\n');

const { Grasteppich } = await import('../src/render/gras.ts');

const WASSER = -4;

/**
 * Ein Prüfgelände mit allen drei Sorten Boden: eine Ebene, ein See und ein
 * Hang. Ohne alle drei liesse sich nicht zeigen, dass die Ausschlüsse greifen
 * **und** dass sie nicht zu viel ausschliessen.
 */
const boden = {
  hoeheAn(x: number, z: number): number {
    // Der See: eine runde Mulde unter dem Spiegel.
    if (Math.hypot(x - 20, z) < 8) return -9;
    // Der Hang: ab z = 12 geht es mit Steigung 1,2 hinauf — knapp fünfzig
    // Grad, also weit über der Schwelle, ab der der Boden Erde zeigt. Er
    // liegt **innerhalb** des Kreises; ein Hang jenseits davon wäre kein
    // Prüffall, sondern eine leere Menge.
    if (z > 12) return 5 + (z - 12) * 1.2;
    return 5;
  },
};

const material = new THREE.MeshBasicMaterial();
const RADIUS = 25;
const ANZAHL = 600;
const teppich = new Grasteppich(material, {
  anzahl: ANZAHL,
  radius: RADIUS,
  farbe: 0x8ccf42,
  farbeAlt: 0x69ba32,
});
teppich.setBoden(boden, WASSER);

const matrix = new THREE.Matrix4();

/**
 * Lage und Grösse jedes Büschels, so wie sie im Netz stehen.
 *
 * Die Grösse wird **aus den Spalten der Matrix** gerechnet und nicht mit
 * `decompose` geholt. Das hat einen Grund, und er hat den Test schon einmal
 * angelogen: `decompose` kann aus einer Matrix mit Grösse null keine Drehung
 * mehr zurückrechnen — es gibt in dem Fall die Eins zurück, damit nichts durch
 * null geteilt wird. Jeder ausgeblendete Halm sah damit voll ausgewachsen aus,
 * und die Prüfungen über Wasser, Hang und Rand meldeten Fehler, die es nicht
 * gab. Die Länge der ersten Spalte ist die Grösse, und die ist null, wenn sie
 * null ist.
 */
function halme(): { x: number; y: number; z: number; gross: number }[] {
  const out: { x: number; y: number; z: number; gross: number }[] = [];
  for (let i = 0; i < ANZAHL; i++) {
    teppich.mesh.getMatrixAt(i, matrix);
    const e = matrix.elements;
    out.push({
      x: e[12]!,
      y: e[13]!,
      z: e[14]!,
      gross: Math.hypot(e[0]!, e[1]!, e[2]!),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
console.log('Die Halme stehen um die Figur');

teppich.folge(0, 0);
const start = halme();

{
  /*
   * Gebaut wird ein **Quadrat**, gesehen wird ein **Kreis**: die Halme liegen
   * in einem Quadrat der Seitenlänge 2·Radius, und dessen Ecken sind fünfunddreissig
   * Meter weit weg. Was jenseits des Radius liegt, ist deshalb nicht falsch —
   * es muss nur auf null geblendet sein. Geprüft wird darum, was man sieht.
   */
  const sichtbar = start.filter((h) => h.gross > 0);
  const draussen = sichtbar.filter((h) => Math.hypot(h.x, h.z) > RADIUS + 0.01);
  check(draussen.length === 0, 'kein sichtbarer steht ausserhalb des Kreises', `${draussen.length} von ${sichtbar.length}`);
  /*
   * Gegenprobe: der Kreis ist auch **voll**. „Alle innerhalb" wäre sonst
   * trivial zu erfüllen — mit null Halmen, oder mit sechshundert auf einem
   * Haufen in der Mitte.
   */
  const weit = sichtbar.filter((h) => Math.hypot(h.x, h.z) > RADIUS * 0.7);
  check(weit.length > sichtbar.length * 0.15, 'und sie füllen ihn bis nach aussen', `${weit.length} von ${sichtbar.length} jenseits von ${(RADIUS * 0.7).toFixed(0)} m`);
}

// ---------------------------------------------------------------------------
console.log('\nSie kleben nicht an der Figur');

{
  /*
   * Zwölf Meter nach Norden, also nicht einmal die halbe Seitenlänge: der
   * grösste Teil der Halme muss danach **auf demselben Fleck der Welt**
   * stehen. Schöbe der Teppich mit, stünde keiner mehr dort, wo er war.
   */
  teppich.folge(0, 12);
  const nachher = halme();
  let gleich = 0;
  for (let i = 0; i < ANZAHL; i++) {
    const a = start[i]!;
    const b = nachher[i]!;
    if (Math.hypot(a.x - b.x, a.z - b.z) < 1e-3) gleich++;
  }
  check(gleich > ANZAHL * 0.6, 'die meisten stehen unverändert in der Welt', `${gleich} von ${ANZAHL}`);

  /*
   * Und die anderen sind **umgelaufen** und nicht irgendwohin gerutscht: wer
   * hinten aus dem Quadrat fällt, taucht vorne wieder auf, und das ist ein
   * Sprung um genau eine Seitenlänge. Ohne diese Gegenprobe ginge auch ein
   * Teppich durch, der seine Halme bei jedem Schritt neu würfelt — der stünde
   * ebenfalls „meistens gleich", nur eben zufällig.
   */
  let umgelaufen = 0;
  let daneben = 0;
  for (let i = 0; i < ANZAHL; i++) {
    const a = start[i]!;
    const b = nachher[i]!;
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d < 1e-3) continue;
    if (Math.abs(d - RADIUS * 2) < 1e-3) umgelaufen++;
    else daneben++;
  }
  check(umgelaufen > 0 && daneben === 0, 'und der Rest ist um eine Seitenlänge gesprungen', `${umgelaufen} umgelaufen, ${daneben} daneben`);
}

// ---------------------------------------------------------------------------
console.log('\nUnter zwei Metern rechnet er nicht neu');

{
  const vorher = halme();
  teppich.folge(1.2, 12);
  const nachher = halme();
  const bewegt = nachher.filter((h, i) => Math.hypot(h.x - vorher[i]!.x, h.z - vorher[i]!.z) > 1e-6);
  check(bewegt.length === 0, 'ein kurzer Schritt lässt alles stehen', `${bewegt.length} bewegt`);
  // Gegenprobe: ein langer sehr wohl. Sonst wäre die Schwelle unendlich und
  // der Teppich bliebe für immer, wo er zuerst gebaut wurde.
  teppich.folge(40, 12);
  const weiter = halme();
  const jetzt = weiter.filter((h, i) => Math.hypot(h.x - vorher[i]!.x, h.z - vorher[i]!.z) > 1e-6);
  check(jetzt.length > 0, 'ein langer nicht', `${jetzt.length} bewegt`);
}

// ---------------------------------------------------------------------------
console.log('\nAuf Wasser und am Hang wächst nichts');

{
  // Zurück an den Ursprung: dort liegen See (bei x = 20) und Hangfuss
  // (ab z = 12) beide im Kreis.
  teppich.folge(400, 400);
  teppich.folge(0, 0);
  const jetzt = halme();

  const imSee = jetzt.filter((h) => Math.hypot(h.x - 20, h.z) < 7);
  check(imSee.length > 0, 'es liegen überhaupt Halme über dem See', `${imSee.length}`);
  check(imSee.every((h) => h.gross === 0), 'und keiner davon wächst', `${imSee.filter((h) => h.gross > 0).length} zu gross`);

  const amHang = jetzt.filter((h) => h.z > 14 && h.z < RADIUS - 2);
  check(amHang.length > 0, 'es liegen Halme am Hang', `${amHang.length}`);
  check(amHang.every((h) => h.gross === 0), 'und keiner davon wächst', `${amHang.filter((h) => h.gross > 0).length} zu gross`);

  /*
   * Und die Gegenprobe, ohne die alles davon nichts sagt: auf der Ebene
   * dazwischen wächst sehr wohl etwas. Ein Teppich, der nirgends wächst,
   * bestünde jede der beiden Prüfungen darüber.
   */
  const ebene = jetzt.filter(
    (h) => h.z < 8 && h.z > -18 && Math.hypot(h.x - 20, h.z) > 12 && Math.hypot(h.x, h.z) < 14,
  );
  check(ebene.length > 0 && ebene.some((h) => h.gross > 0.4), 'auf der Ebene dagegen schon', `${ebene.filter((h) => h.gross > 0).length} von ${ebene.length}`);
  // Und sie stehen auf dem Boden, nicht darüber oder darin.
  const schwebend = ebene.filter((h) => h.gross > 0 && Math.abs(h.y - 5) > 1e-6);
  check(schwebend.length === 0, 'und sie stehen auf dem Boden', `${schwebend.length} schweben`);
}

// ---------------------------------------------------------------------------
console.log('\nZum Rand hin wird ausgeblendet');

{
  const jetzt = halme().filter((h) => h.gross > 0);
  const rand = jetzt.filter((h) => Math.hypot(h.x, h.z) > RADIUS - 2);
  const innen = jetzt.filter((h) => Math.hypot(h.x, h.z) < RADIUS - 8);
  const mittel = (l: { gross: number }[]): number =>
    l.reduce((s, h) => s + h.gross, 0) / Math.max(1, l.length);
  check(
    rand.length > 0 && mittel(rand) < mittel(innen) * 0.5,
    'aussen sind sie deutlich kleiner als innen',
    `${mittel(rand).toFixed(2)} gegen ${mittel(innen).toFixed(2)}`,
  );
  /*
   * Gegenprobe: „kleiner" heisst nicht „weg". Wären am Rand einfach alle auf
   * null, sähe man dort eine Kante — und genau die soll das Ausblenden
   * verhindern.
   */
  check(rand.some((h) => h.gross > 0.05), 'aber nicht schlagartig verschwunden', `grösster ${Math.max(...rand.map((h) => h.gross)).toFixed(2)}`);
}

// ---------------------------------------------------------------------------
console.log('\nOhne Boden steht nichts');

{
  teppich.setBoden(undefined, WASSER);
  check(teppich.mesh.visible === false, 'beim Kartenwechsel ist der Teppich unsichtbar');
  const vorher = halme();
  teppich.folge(500, 500);
  const nachher = halme();
  const bewegt = nachher.filter((h, i) => Math.hypot(h.x - vorher[i]!.x, h.z - vorher[i]!.z) > 1e-6);
  check(bewegt.length === 0, 'und er rechnet auch nicht mehr', `${bewegt.length} bewegt`);
}

teppich.dispose();

console.log(`\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`);
process.exit(failures === 0 ? 0 : 1);
