/**
 * Die Gesteinsoberfläche — gezeichnet, nicht geliefert.
 *
 * Ein Fels aus Dreiecken hat zwei Möglichkeiten, überhaupt nach etwas
 * auszusehen: **Kanten** oder **Oberfläche**. Die Kanten hatten wir, und sie
 * waren zu viel davon — ein Findling aus zwanzig grossen Facetten liest sich
 * als geschliffener Stein und nicht als einer, der seit tausend Jahren auf der
 * Wiese liegt.
 *
 * Also die andere Möglichkeit: eine runde Form und die Unruhe im Bild statt in
 * der Geometrie. Das ist zugleich das billigere Geschäft — Körnung, Sprünge
 * und Flechten kosten hier einmal 512 × 512 Bildpunkte und auf jedem Stein der
 * Karte kein einziges Dreieck.
 *
 * **Die Textur ist hell.** Sie wird mit der Vertexfarbe multipliziert, und ein
 * dunkles Bild mal einer dunklen Farbe ergibt Schwarz. Gezeichnet wird deshalb
 * um einen Mittelwert von etwa 0,8 herum: die Textur trägt die Struktur, die
 * Farbe trägt die Farbe. Damit gilt weiter, was für alle Props gilt — derselbe
 * Fels in einem anderen Grau ist eine Zeile in der Karte und kein zweites
 * Modell.
 *
 * **Sie muss kacheln.** Ein Findling ist vier Meter breit, die Kachel deckt gut
 * einen — jede Naht liefe also mehrfach über denselben Stein. Deshalb wird
 * jedes Element neunmal gezeichnet, einmal in der Mitte und achtmal um eine
 * Bildbreite versetzt: was rechts hinausläuft, kommt links wieder herein.
 */

import * as THREE from 'three';

/** Kantenlänge der Kachel in Bildpunkten. */
const GROESSE = 512;

/**
 * Wie viele Meter eine Kachel abdeckt.
 *
 * Steht hier und nicht bei den Steinen: die Bildkoordinaten werden aus den
 * Weltkoordinaten gerechnet, damit ein grosser und ein kleiner Fels dieselbe
 * Körnung haben. Sonst sieht der kleine aus wie der grosse in der Ferne, und
 * die beiden nebeneinander verraten, dass es dasselbe Modell ist.
 */
export const GESTEIN_KACHEL_METER = 1.6;

/** Kleiner, wiederholbarer Zufall. Dieselbe Textur bei jedem Start. */
function wuerfel(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a ^= a << 13;
    a >>>= 0;
    a ^= a >>> 17;
    a ^= a << 5;
    a >>>= 0;
    return a / 4294967296;
  };
}

/**
 * Zeichnet dasselbe neunmal — in der Mitte und ringsum versetzt.
 *
 * Der ganze Trick am nahtlosen Kacheln. Ein Fleck, der über den rechten Rand
 * hinausragt, wird zusätzlich um eine Bildbreite nach links gezeichnet und
 * taucht dort wieder auf; an der Naht passt damit beides zusammen. Kostet das
 * Neunfache an Zeichenaufrufen und läuft genau einmal beim Start.
 */
function ringsum(ctx: CanvasRenderingContext2D, male: () => void): void {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      ctx.save();
      ctx.translate(dx * GROESSE, dy * GROESSE);
      male();
      ctx.restore();
    }
  }
}

/** Ein Grauwert als Farbzeichenkette. */
function grau(wert: number, deckung = 1): string {
  const v = Math.max(0, Math.min(255, Math.round(wert * 255)));
  return `rgba(${v},${v},${v},${deckung})`;
}

/**
 * Die grossen, weichen Flecken.
 *
 * Ohne sie ist die Körnung gleichmässig verteilt, und gleichmässig verteiltes
 * Rauschen sieht aus wie Fernsehschnee — aus zehn Metern wird daraus wieder
 * eine glatte graue Fläche. Ein Stein hat hellere und dunklere Zonen, und die
 * sind es, die man von weitem noch sieht.
 */
function zonen(ctx: CanvasRenderingContext2D, rand: () => number): void {
  for (let i = 0; i < 70; i++) {
    const x = rand() * GROESSE;
    const y = rand() * GROESSE;
    const r = 26 + rand() * 90;
    const hell = 0.78 + (rand() - 0.5) * 0.26;
    ringsum(ctx, () => {
      const verlauf = ctx.createRadialGradient(x, y, 0, x, y, r);
      verlauf.addColorStop(0, grau(hell, 0.5));
      verlauf.addColorStop(1, grau(hell, 0));
      ctx.fillStyle = verlauf;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

/** Die Körnung: einzelne Kristalle, wie sie Granit hat. */
function koerner(ctx: CanvasRenderingContext2D, rand: () => number): void {
  for (let i = 0; i < 5200; i++) {
    const x = rand() * GROESSE;
    const y = rand() * GROESSE;
    const r = 0.7 + rand() * 2.2;
    // Zwei Drittel dunkler, ein Drittel heller — sonst wird die Fläche mit
    // jedem Korn insgesamt heller und die Textur verliert ihren Mittelwert.
    const hell = rand() < 0.66 ? 0.62 + rand() * 0.16 : 0.9 + rand() * 0.1;
    ringsum(ctx, () => {
      ctx.fillStyle = grau(hell, 0.55);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

/**
 * Sprünge.
 *
 * Das Einzige an der Textur, das eine **Richtung** hat, und deshalb das, was
 * einen Stein von einer Betonplatte unterscheidet. Sie laufen in Zacken und
 * nicht in Bögen: ein Riss folgt der Schwäche im Gestein und macht dabei
 * Ecken.
 */
function spruenge(ctx: CanvasRenderingContext2D, rand: () => number): void {
  for (let i = 0; i < 16; i++) {
    let x = rand() * GROESSE;
    let y = rand() * GROESSE;
    let richtung = rand() * Math.PI * 2;
    const punkte: Array<[number, number]> = [[x, y]];
    const glieder = 5 + Math.floor(rand() * 7);
    for (let g = 0; g < glieder; g++) {
      richtung += (rand() - 0.5) * 1.5;
      const laenge = 12 + rand() * 42;
      x += Math.cos(richtung) * laenge;
      y += Math.sin(richtung) * laenge;
      punkte.push([x, y]);
    }
    const breite = 0.8 + rand() * 1.8;
    ringsum(ctx, () => {
      ctx.strokeStyle = grau(0.5, 0.55);
      ctx.lineWidth = breite;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(punkte[0]![0], punkte[0]![1]);
      for (const p of punkte.slice(1)) ctx.lineTo(p[0], p[1]);
      ctx.stroke();
      // Ein heller Streifen daneben: eine Kante hat eine Sonnen- und eine
      // Schattenseite, und erst dadurch sieht der Riss nach Tiefe aus statt
      // nach aufgemaltem Strich.
      ctx.strokeStyle = grau(0.95, 0.28);
      ctx.lineWidth = breite * 0.7;
      ctx.beginPath();
      ctx.moveTo(punkte[0]![0] + 1.4, punkte[0]![1] + 1.4);
      for (const p of punkte.slice(1)) ctx.lineTo(p[0] + 1.4, p[1] + 1.4);
      ctx.stroke();
    });
  }
}

let gecacht: THREE.Texture | undefined;

/**
 * Die Gesteinstextur. Einmal gezeichnet, danach dieselbe.
 *
 * Gecacht, weil sie sonst je Modell neu entstünde — und der Client baut jedes
 * Prop einzeln. Vier Felsmodelle wären sonst vier Zeichenleinwände und vier
 * Texturen im Speicher der Grafikkarte, für dasselbe Bild.
 */
export function gesteinsTextur(): THREE.Texture {
  if (gecacht) return gecacht;

  const leinwand = document.createElement('canvas');
  leinwand.width = GROESSE;
  leinwand.height = GROESSE;
  const ctx = leinwand.getContext('2d')!;
  const rand = wuerfel(0x57e1);

  ctx.fillStyle = grau(0.8);
  ctx.fillRect(0, 0, GROESSE, GROESSE);
  zonen(ctx, rand);
  koerner(ctx, rand);
  spruenge(ctx, rand);

  const textur = new THREE.CanvasTexture(leinwand);
  // Wiederholend, weil die Bildkoordinaten aus Metern kommen und bei einem
  // vier Meter breiten Findling weit über eins hinauslaufen.
  textur.wrapS = THREE.RepeatWrapping;
  textur.wrapT = THREE.RepeatWrapping;
  textur.anisotropy = 4;
  textur.colorSpace = THREE.SRGBColorSpace;
  gecacht = textur;
  return textur;
}

/**
 * Legt Bildkoordinaten auf eine fertige Geometrie — je Dreieck einzeln.
 *
 * Eine Kugel bekommt man mit Kugelkoordinaten belegt, ein Findling nicht: er
 * ist keine Kugel mehr, und an der Naht bei 180 Grad läuft die Textur einmal
 * quer über den Stein zurück. Stattdessen wird jedes Dreieck **von der Seite
 * projiziert**, aus der man am ehesten darauf schaut: bei einer Fläche, die
 * nach oben zeigt, von oben, bei einer senkrechten von vorn oder von der
 * Seite. Das ist dieselbe Idee wie eine Kistenprojektion, nur je Dreieck
 * entschieden statt je Bildpunkt.
 *
 * Die Nähte zwischen zwei verschieden projizierten Dreiecken sind da, aber auf
 * einer Körnung ohne Muster sieht sie niemand — und der Preis dafür wäre eine
 * ausgerollte Textur je Modell.
 *
 * Muss **nach** allen Verzerrungen laufen: die Koordinaten kommen aus den
 * Weltmassen, und eine Stauchung danach würde die Körnung mitstauchen.
 */
export function gesteinsUV(geo: THREE.BufferGeometry, meterJeKachel = GESTEIN_KACHEL_METER): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const k1 = new THREE.Vector3();
  const k2 = new THREE.Vector3();

  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    n.copy(k1.subVectors(b, a).cross(k2.subVectors(c, a))).normalize();

    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    for (let j = 0; j < 3; j++) {
      const p = j === 0 ? a : j === 1 ? b : c;
      let u: number;
      let v: number;
      if (ay >= ax && ay >= az) {
        u = p.x;
        v = p.z;
      } else if (ax >= az) {
        u = p.z;
        v = p.y;
      } else {
        u = p.x;
        v = p.y;
      }
      uv[(i + j) * 2] = u / meterJeKachel;
      uv[(i + j) * 2 + 1] = v / meterJeKachel;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
