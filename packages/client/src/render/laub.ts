/**
 * Laub — Blätter, Gras, Farn und Blüten als **Textur mit Loch**.
 *
 * Ein Busch aus geschlossenen Körpern sieht aus wie ein Busch aus
 * geschlossenen Körpern: drei zerknautschte Kugeln, und wo sie sich schneiden,
 * sieht man die Schnittkanten. Echtes Laub hat Lücken, und Lücken sind das
 * eine, was ein Dreieck nicht kann.
 *
 * Deshalb hier: eine Textur mit Alphakanal, aufgezogen auf gekreuzte Karten.
 * Wo die Textur durchsichtig ist, wird das Dreieck verworfen (`alphaTest`) —
 * die Silhouette kommt aus dem Bild und nicht aus der Geometrie. Ein Busch aus
 * acht Karten hat damit sechzehn Dreiecke und trotzdem eine Blattkante.
 *
 * **Gezeichnet und nicht geliefert.** Die Modelle dieses Spiels entstehen im
 * Code; die Textur dazu ebenso. Das erspart eine Datei im Manifest, eine
 * Anfrage beim Laden und die Frage, welche Fassung gerade ausgeliefert wird —
 * und die Modellschau bekommt sie damit geschenkt, ohne den Asset-Baum zu
 * kennen.
 *
 * **Fast farblos gezeichnet.** Die Blätter sind hell und kaum gesättigt; die
 * Farbe kommt aus den Vertexfarben der Karte, die das Material darüberlegt.
 * Damit gilt weiterhin, was für alle Props gilt: dieselbe Geometrie in einem
 * anderen Grün ist eine Zeile in der Karte (`tint`) und kein zweites Modell.
 */

import * as THREE from 'three';

/** Kantenlänge einer Kachel im Atlas. */
const KACHEL = 256;

/**
 * Die vier Kacheln, als Zeile/Spalte im 2×2-Atlas.
 *
 * Ein Atlas und nicht vier Texturen: alle Laubprops teilen sich damit **ein**
 * Material, und ein Material heisst ein Zeichenaufruf je Modell statt einem je
 * Sorte. Auf einer Karte mit vierhundert Büschen und Grasbüscheln ist das der
 * Unterschied zwischen zwei Aufrufen und acht.
 */
export const LAUB_KACHEL = {
  blatt: [0, 0],
  gras: [1, 0],
  farn: [0, 1],
  bluete: [1, 1],
} as const;

export type LaubKachel = keyof typeof LAUB_KACHEL;

/**
 * Rand innerhalb einer Kachel, in dem nichts gezeichnet wird.
 *
 * Nicht Zierde, sondern Notwendigkeit: die Mipmap-Stufen mischen benachbarte
 * Bildpunkte, und an der Kachelgrenze wären das die der Nachbarkachel. Mit
 * einem durchsichtigen Saum mischt sich dort Durchsichtiges mit
 * Durchsichtigem, und aus der Ferne wächst kein Gras aus den Blättern.
 */
const SAUM = 14;

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
 * Ein einzelnes Blatt: spitze Ellipse mit Mittelrippe.
 *
 * Die Rippe ist der Grund, warum das Blatt nicht wie ein Fleck aussieht. Sie
 * ist dunkler als die Fläche und läuft nicht ganz bis zur Spitze — genau so
 * weit, wie man aus drei Metern noch etwas erkennt.
 */
function blatt(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  laenge: number,
  breite: number,
  winkel: number,
  helligkeit: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(winkel);

  const g = Math.round(255 * helligkeit);
  ctx.fillStyle = `rgb(${Math.round(g * 0.93)}, ${g}, ${Math.round(g * 0.86)})`;
  ctx.beginPath();
  ctx.moveTo(0, -laenge * 0.5);
  ctx.quadraticCurveTo(breite * 0.5, 0, 0, laenge * 0.5);
  ctx.quadraticCurveTo(-breite * 0.5, 0, 0, -laenge * 0.5);
  ctx.fill();

  ctx.strokeStyle = `rgba(${Math.round(g * 0.55)}, ${Math.round(g * 0.62)}, ${Math.round(g * 0.5)}, 0.75)`;
  ctx.lineWidth = Math.max(1, laenge * 0.02);
  ctx.beginPath();
  ctx.moveTo(0, laenge * 0.46);
  ctx.lineTo(0, -laenge * 0.36);
  ctx.stroke();

  ctx.restore();
}

/** Ein Büschel Blätter, von der Mitte nach aussen. */
function zeichneBlatt(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
  const rand = wuerfel(0x1eaf);
  const mitte = KACHEL * 0.5;
  const platz = KACHEL * 0.5 - SAUM;

  // Von hinten nach vorn: die grossen, dunklen zuerst, die kleinen hellen
  // obendrauf. Andersherum verdeckten die grossen alles, was Tiefe gibt.
  /*
   * Drei Lagen, und die Blätter sind **rundlich**.
   *
   * Zuerst waren sie dreimal so lang wie breit, und aus drei Metern sah der
   * Busch damit aus wie eine Palme: lauter lange Spitzen, die vom Mittelpunkt
   * wegzeigen. Ein Verhältnis um zwei zu eins liest sich als Laub.
   */
  for (const lage of [
    { anzahl: 20, weite: 0.95, laenge: 0.34, hell: 0.66 },
    { anzahl: 16, weite: 0.7, laenge: 0.3, hell: 0.85 },
    { anzahl: 12, weite: 0.42, laenge: 0.26, hell: 1.0 },
  ]) {
    for (let i = 0; i < lage.anzahl; i++) {
      const winkel = rand() * Math.PI * 2;
      // Bis in die Mitte hinein und nicht nur am Rand: eine Kachel mit freiem
      // Kern sieht aus wie ein Kranz, und ein Kranz ist kein Busch.
      const weite = platz * lage.weite * (0.08 + rand() * 0.92);
      blatt(
        ctx,
        ox + mitte + Math.cos(winkel) * weite,
        oy + mitte + Math.sin(winkel) * weite * 0.9,
        KACHEL * lage.laenge * (0.8 + rand() * 0.4),
        KACHEL * lage.laenge * (0.42 + rand() * 0.16),
        /*
         * Grob nach aussen, aber weit gestreut.
         *
         * Genau nach aussen gerichtet ergab eine Rosette — von drei Metern sah
         * der Busch aus wie ein Löwenzahn: lauter Spitzen, die sternförmig vom
         * Mittelpunkt wegzeigen. Mit gut siebzig Grad Streuung liegen die
         * Blätter durcheinander, und genau so liegt Laub.
         */
        winkel + Math.PI * 0.5 + (rand() - 0.5) * 2.4,
        lage.hell * (0.86 + rand() * 0.14),
      );
    }
  }
}

/** Halme, unten breit, oben spitz — von der Standlinie nach oben. */
function zeichneGras(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
  const rand = wuerfel(0x67a5);
  const boden = oy + KACHEL - SAUM;
  const halme = 26;

  for (let i = 0; i < halme; i++) {
    const fuss = ox + SAUM + rand() * (KACHEL - 2 * SAUM);
    // Die Halme werden nach aussen kürzer: ein Büschel ist in der Mitte hoch,
    // ein Rechteck aus gleich langen Halmen sieht aus wie ein Kamm.
    const mitte = 1 - Math.abs((fuss - ox - KACHEL * 0.5) / (KACHEL * 0.5));
    const hoehe = (KACHEL - 2 * SAUM) * (0.32 + mitte * 0.6) * (0.75 + rand() * 0.35);
    const neigung = (rand() - 0.5) * KACHEL * 0.28;
    const dicke = KACHEL * (0.014 + rand() * 0.014);
    const g = Math.round(255 * (0.6 + rand() * 0.4));

    ctx.fillStyle = `rgb(${Math.round(g * 0.9)}, ${g}, ${Math.round(g * 0.72)})`;
    ctx.beginPath();
    ctx.moveTo(fuss - dicke, boden);
    ctx.quadraticCurveTo(fuss + neigung * 0.4, boden - hoehe * 0.6, fuss + neigung, boden - hoehe);
    ctx.quadraticCurveTo(fuss + neigung * 0.4, boden - hoehe * 0.55, fuss + dicke, boden);
    ctx.fill();
  }
}

/** Ein Farnwedel: eine Mittelrippe mit Fiedern nach beiden Seiten. */
function zeichneFarn(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
  const rand = wuerfel(0x3fe2);
  const fuss = { x: ox + KACHEL * 0.5, y: oy + KACHEL - SAUM };

  // Enger gefächert und kürzer als zuerst: die Wedel ragten über die Kachel
  // hinaus, und der Beschnitt schnitt sie mitten durch.
  for (const wedel of [-0.26, 0, 0.26]) {
    const laenge = (KACHEL - 2 * SAUM) * (0.6 + rand() * 0.2);
    ctx.save();
    ctx.translate(fuss.x, fuss.y);
    ctx.rotate(wedel);

    ctx.strokeStyle = 'rgba(150, 165, 130, 0.9)';
    ctx.lineWidth = KACHEL * 0.014;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -laenge);
    ctx.stroke();

    const fiedern = 11;
    for (let i = 1; i <= fiedern; i++) {
      const t = i / fiedern;
      // Nach oben kürzer: ein Wedel läuft spitz aus.
      const spanne = KACHEL * 0.13 * (1 - t * 0.7) * (0.8 + rand() * 0.4);
      const g = Math.round(255 * (0.66 + rand() * 0.3));
      for (const seite of [-1, 1]) {
        blatt(
          ctx,
          (seite * spanne) / 2,
          -laenge * t,
          spanne * 1.5,
          spanne * 0.5,
          seite * 1.1,
          g / 255,
        );
      }
    }
    ctx.restore();
  }
}

/** Kleine Blüten, für die Kacheln zwischen den Blättern. */
function zeichneBluete(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
  const rand = wuerfel(0x9b10);
  const mitte = KACHEL * 0.5;
  const platz = KACHEL * 0.5 - SAUM;

  // Erst ein paar Blätter als Untergrund — eine Blüte ohne Grün darunter
  // schwebt in der Luft.
  for (let i = 0; i < 10; i++) {
    const winkel = rand() * Math.PI * 2;
    const weite = platz * (0.3 + rand() * 0.6);
    blatt(
      ctx,
      ox + mitte + Math.cos(winkel) * weite,
      oy + mitte + Math.sin(winkel) * weite,
      KACHEL * 0.3,
      KACHEL * 0.11,
      winkel + Math.PI * 0.5,
      0.62 + rand() * 0.2,
    );
  }

  for (let i = 0; i < 7; i++) {
    const winkel = rand() * Math.PI * 2;
    const weite = platz * (0.15 + rand() * 0.62);
    const x = ox + mitte + Math.cos(winkel) * weite;
    const y = oy + mitte + Math.sin(winkel) * weite;
    const r = KACHEL * (0.028 + rand() * 0.022);

    // Fünf Blätter um eine Mitte. Ganz weiss, damit die Vertexfarbe des
    // Modells entscheidet, ob daraus eine gelbe oder eine violette Blüte wird.
    ctx.fillStyle = 'rgb(255, 252, 244)';
    for (let b = 0; b < 5; b++) {
      const a = (b / 5) * Math.PI * 2 + winkel;
      ctx.beginPath();
      ctx.ellipse(x + Math.cos(a) * r, y + Math.sin(a) * r, r * 0.85, r * 0.6, a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgb(210, 190, 120)';
    ctx.beginPath();
    ctx.arc(x, y, r * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

let atlas: THREE.Texture | undefined;

/**
 * Der Laubatlas — 2×2 Kacheln, einmal gezeichnet und danach behalten.
 *
 * Ohne Zwischenspeicher zeichnete jedes Modell den Atlas neu, und der
 * Map-Editor tut das beim Blättern durch die Palette einmal je Prop.
 */
export function laubAtlas(): THREE.Texture {
  if (atlas) return atlas;

  const leinwand = document.createElement('canvas');
  leinwand.width = KACHEL * 2;
  leinwand.height = KACHEL * 2;
  const ctx = leinwand.getContext('2d');
  if (!ctx) throw new Error('Kein 2D-Kontext für den Laubatlas');

  // Durchsichtig anfangen. Alles, was nicht gezeichnet wird, ist Loch.
  ctx.clearRect(0, 0, leinwand.width, leinwand.height);

  /*
   * Jede Kachel wird beim Zeichnen **beschnitten**.
   *
   * Ohne das ragen einzelne Blätter über den Kachelrand in die Nachbarkachel,
   * und die zeigt sie brav mit an: im Grasbüschel schwebten Blattfetzen neben
   * den Halmen, weil der Farnwedel der Nachbarkachel dort hineinragte. Der
   * durchsichtige Saum allein reicht nicht — er hält die Mipmaps auseinander,
   * nicht den Pinsel.
   */
  const kachel = (
    zeichner: (c: CanvasRenderingContext2D, ox: number, oy: number) => void,
    [sx, sy]: readonly [number, number],
  ): void => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(sx * KACHEL, sy * KACHEL, KACHEL, KACHEL);
    ctx.clip();
    zeichner(ctx, sx * KACHEL, sy * KACHEL);
    ctx.restore();
  };
  kachel(zeichneBlatt, LAUB_KACHEL.blatt);
  kachel(zeichneGras, LAUB_KACHEL.gras);
  kachel(zeichneFarn, LAUB_KACHEL.farn);
  kachel(zeichneBluete, LAUB_KACHEL.bluete);

  const textur = new THREE.CanvasTexture(leinwand);
  textur.colorSpace = THREE.SRGBColorSpace;
  textur.anisotropy = 4;
  // Kein Wiederholen: jede Kachel ist ein Ausschnitt, und ein Ausschnitt, der
  // am Rand umläuft, holt sich die Nachbarkachel ins Bild.
  textur.wrapS = THREE.ClampToEdgeWrapping;
  textur.wrapT = THREE.ClampToEdgeWrapping;
  atlas = textur;
  return textur;
}

/**
 * Eine Laubkarte: ein Viereck mit den Bildkoordinaten einer Atlaskachel.
 *
 * Der Ursprung liegt unten in der Mitte — dort, wo die Karte im Modell
 * angesetzt wird. Bei einem Grasbüschel ist das der Boden, bei einem Blattfeld
 * die Stelle, an der es am Ast hängt.
 */
export function laubKarte(
  kachel: LaubKachel,
  breite: number,
  hoehe: number,
): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(breite, hoehe);
  geo.translate(0, hoehe * 0.5, 0);

  const [spalte, zeile] = LAUB_KACHEL[kachel];
  /*
   * Die Kacheln liegen in **Bildzeilen** von oben nach unten, die Texturachse
   * läuft von unten nach oben. Zeile 0 ist deshalb die obere Hälfte der
   * Textur (v von 0,5 bis 1) und Zeile 1 die untere. Ohne das `1 −` trägt der
   * Busch Gras und das Gras Blätter.
   */
  const u0 = spalte * 0.5;
  const v0 = (1 - zeile) * 0.5;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, u0 + uv.getX(i) * 0.5, v0 + uv.getY(i) * 0.5);
  }
  uv.needsUpdate = true;
  return geo;
}

/**
 * Zieht die Normalen einer Laubgruppe von einem Punkt aus nach aussen.
 *
 * Eine Karte hat ihre Normale in der Kartenebene, und damit wird eine, die zur
 * Seite steht, von oben schwarz. Ein Busch besteht aber aus Blättern, die in
 * alle Richtungen zeigen — die Normale einer Kugel um den Mittelpunkt trifft
 * das besser als die des Vierecks, aus dem die Karte tatsächlich ist. Derselbe
 * Griff, mit dem Bäume in jeder Engine schattiert werden.
 */
export function laubNormalen(geo: THREE.BufferGeometry, mitteY: number): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i) - mitteY;
    const z = pos.getZ(i);
    const laenge = Math.hypot(x, y, z) || 1;
    nor.setXYZ(i, x / laenge, y / laenge, z / laenge);
  }
  nor.needsUpdate = true;
}
