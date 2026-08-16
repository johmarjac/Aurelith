/**
 * Der schwebende Felsen.
 *
 * Hier stand zuerst ein Zylinder mit einem Kegel darunter, und genau so sah es
 * aus: eine grüne Scheibe auf einem Eishörnchen. Drei Fehler auf einmal —
 *
 *   1. **Alles war ein perfekter Kreis.** Ein Felsen, der aus jeder Richtung
 *      denselben Umriss hat, liest sich als Drehkörper und nicht als Stein.
 *   2. **Der Zapfen lief spitz zu wie eine Nadel.** Ein Brocken, der aus dem
 *      Boden gebrochen ist, hat unten eine Bruchkante, keine Spitze.
 *   3. **Die drei Lagen waren drei Bänder.** Gras, Erde und Fels stiessen als
 *      waagerechte Ringe aneinander, und man sah drei Zylinder statt eines
 *      Felsens.
 *
 * Jetzt: ein Ring aus Stützpunkten, der nach unten enger wird, und jeder
 * Stützpunkt hat seinen eigenen Ausschlag. Der Ausschlag bleibt über die
 * ganze Höhe **derselbe** — daraus werden senkrechte Kanten und Grate, und
 * genau die machen aus einem Drehkörper einen Felsen.
 *
 * Flach schattiert und mit Farbe je Dreieck: dieselbe Sprache wie der Rest der
 * Modelle. Die Kanten sollen zu sehen sein.
 *
 * **Der Ursprung liegt in der begehbaren Fläche**, also bei y = 0, und alles
 * andere hängt darunter. Das ist keine Geschmacksfrage: der Kern liest die
 * Höhe der Fläche als `position[1]` des Props (`collision: 'plattform'`).
 * Läge der Ursprung in der Mitte, stünde die Zahl im Dokument zweimal.
 */

import * as THREE from 'three';

/**
 * Stützpunkte auf dem Ring.
 *
 * Dreizehn, und die Zahl ist eine Primzahl: bei zwölf fallen die Kanten mit
 * jeder Vierteldrehung aufeinander, und aus der Ferne sieht man ein Muster
 * statt eines Steins.
 */
const SEGMENTE = 13;

/**
 * Der Umriss von oben nach unten, in Vielfachen des Radius.
 *
 * `y` ist die Tiefe unter der begehbaren Fläche, `r` der Anteil am Radius. Die
 * zweite Zeile steht **weiter aussen** als die erste: das ist die Lippe unter
 * der Grasnarbe, und sie ist der Grund, warum der Felsen von der Seite nach
 * abgebrochen aussieht und nicht nach abgedreht.
 */
const RINGE: ReadonlyArray<{ y: number; r: number; farbe: number; streu: number }> = [
  { y: 0, r: 1.0, farbe: 0x7e6448, streu: 0.1 },
  { y: -0.09, r: 1.05, farbe: 0x74593f, streu: 0.14 },
  { y: -0.26, r: 0.95, farbe: 0x9a9082, streu: 0.2 },
  // Die dritte und vierte Zeile liegen dicht beieinander und springen dann
  // weit: eine gleichmässige Verjüngung ist ein Kegel, und einen Kegel hatten
  // wir schon.
  { y: -0.4, r: 0.88, farbe: 0x958c7f, streu: 0.22 },
  { y: -0.72, r: 0.58, farbe: 0x8a8175, streu: 0.24 },
  { y: -1.02, r: 0.36, farbe: 0x776f66, streu: 0.26 },
];

/** Wo der Zapfen endet, in Vielfachen des Radius. */
const SPITZE = -1.38;

/** Wiederholbarer Zufall — derselbe Felsen bei jedem Start. */
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
 * Sammelt Dreiecke mit Farbe.
 *
 * Ohne Index und mit flachen Normalen: ein Felsen soll Kanten haben, und
 * geteilte Vertizes glätten sie weg. Die doppelten Punkte kosten bei ein paar
 * hundert Dreiecken nichts.
 */
class Netz {
  private readonly orte: number[] = [];
  private readonly farben: number[] = [];

  dreieck(
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    farbe: number,
    helligkeit = 1,
  ): void {
    const r = (((farbe >> 16) & 0xff) / 255) * helligkeit;
    const g = (((farbe >> 8) & 0xff) / 255) * helligkeit;
    const bl = ((farbe & 0xff) / 255) * helligkeit;
    for (const p of [a, b, c]) {
      this.orte.push(p.x, p.y, p.z);
      this.farben.push(r, g, bl);
    }
  }

  fertig(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.orte, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.farben, 3));
    // Flach: `computeVertexNormals` mittelt über geteilte Vertizes, und die
    // gibt es hier keine — jedes Dreieck bekommt damit seine eigene Normale.
    geo.computeVertexNormals();
    return geo;
  }
}

/**
 * Ein Brocken — der Felsen selbst, ohne Zubehör.
 *
 * Getrennt, weil er zweimal gebraucht wird: einmal gross als Insel, und ein
 * paarmal klein als Trabant darunter. Dieselbe Form in klein sieht aus wie
 * abgebrochen — und genau das soll sie.
 */
function brocken(
  netz: Netz,
  mitte: THREE.Vector3,
  radius: number,
  rand: () => number,
  grasFarbe: number | undefined,
): void {
  /*
   * Der Ausschlag je Stützpunkt, **einmal** gewürfelt und für alle Ringe
   * gleich. Daraus werden senkrechte Grate, die über die ganze Höhe
   * durchlaufen — mit einem eigenen Wurf je Ring wäre es Rauschen statt Form.
   */
  const kante: number[] = [];
  for (let i = 0; i < SEGMENTE; i++) kante.push(0.74 + rand() * 0.52);

  /*
   * Und ein Höhenversatz je Stützpunkt **und** Ring.
   *
   * Das ist der Griff, der aus Ringen einen Felsen macht: ohne ihn liegt jeder
   * Ring in einer waagerechten Ebene, und man sieht Bänder, so unregelmässig
   * der Umriss auch ist. Mit ihm zacken die Kanten auch in der Höhe.
   */
  const hoehenversatz: number[][] = RINGE.map((r, ring) =>
    Array.from({ length: SEGMENTE }, () =>
      ring === 0 ? 0 : (rand() - 0.5) * radius * 0.14,
    ),
  );

  // Und ein leichter Versatz der Mitte je Ring: der Zapfen hängt damit
  // schief, statt senkrecht wie ein Zapfhahn zu stehen.
  const versatz = RINGE.map(() => ({
    x: (rand() - 0.5) * radius * 0.16,
    z: (rand() - 0.5) * radius * 0.16,
  }));

  const punkt = (ring: number, seg: number): THREE.Vector3 => {
    const r = RINGE[ring]!;
    const v = versatz[ring]!;
    const winkel = (seg / SEGMENTE) * Math.PI * 2;
    const weite = radius * r.r * kante[seg % SEGMENTE]!;
    return new THREE.Vector3(
      mitte.x + v.x + Math.cos(winkel) * weite,
      // Der oberste Ring bleibt eben: dort liegt die begehbare Fläche, und
      // eine wellige Wiese wäre eine Lüge über das, was der Kern kennt.
      mitte.y + radius * r.y + hoehenversatz[ring]![seg % SEGMENTE]!,
      mitte.z + v.z + Math.sin(winkel) * weite,
    );
  };

  // --- Der Mantel ---------------------------------------------------------
  for (let ring = 0; ring + 1 < RINGE.length; ring++) {
    const oben = RINGE[ring]!;
    for (let seg = 0; seg < SEGMENTE; seg++) {
      const a = punkt(ring, seg);
      const b = punkt(ring, seg + 1);
      const c = punkt(ring + 1, seg + 1);
      const d = punkt(ring + 1, seg);
      // Helligkeit je Facette: ohne sie sieht ein Ring aus wie ein Band,
      // obwohl die Kanten stimmen. Das Licht allein reicht nicht — die
      // Facetten liegen zu flach zueinander.
      const h1 = 0.72 + rand() * 0.56;
      const h2 = 0.72 + rand() * 0.56;
      netz.dreieck(a, b, c, oben.farbe, h1 * (1 + oben.streu * (rand() - 0.5)));
      netz.dreieck(a, c, d, oben.farbe, h2 * (1 + oben.streu * (rand() - 0.5)));
    }
  }

  // --- Die Bruchkante unten ----------------------------------------------
  //
  // Kein Punkt, sondern ein kurzer Grat: drei Ecken statt einer. Eine Spitze
  // sieht aus wie eine Eistüte, eine Kante wie etwas, das abgebrochen ist.
  const letzter = RINGE.length - 1;
  const grat = [
    new THREE.Vector3(
      mitte.x + (rand() - 0.5) * radius * 0.2,
      mitte.y + radius * SPITZE,
      mitte.z + (rand() - 0.5) * radius * 0.2,
    ),
    new THREE.Vector3(
      mitte.x + (rand() - 0.5) * radius * 0.3,
      mitte.y + radius * (SPITZE + 0.12),
      mitte.z + (rand() - 0.5) * radius * 0.3,
    ),
  ];
  for (let seg = 0; seg < SEGMENTE; seg++) {
    const a = punkt(letzter, seg);
    const b = punkt(letzter, seg + 1);
    netz.dreieck(a, b, grat[seg % 2]!, RINGE[letzter]!.farbe, 0.7 + rand() * 0.35);
  }
  netz.dreieck(grat[0]!, grat[1]!, punkt(letzter, 0), RINGE[letzter]!.farbe, 0.75);

  // --- Der Deckel oben ----------------------------------------------------
  //
  // Auch ohne Gras: ein Brocken ohne Deckel ist eine Schale, und die
  // Trabanten unter der Insel sahen aus wie umgedrehte Scherben.
  /*
   * Ein Fächer bei y = 0 — flach, weil genau diese Ebene begehbar ist. Eine
   * Kuppe darauf sähe besser aus und wäre falsch: der Kern kennt nur die
   * Scheibe, und man liefe durch den Hügel hindurch.
   *
   * Die Farbe wechselt je Dreieck zwischen Gras und Moos. Aus zehn Metern ist
   * das der Unterschied zwischen „Wiese" und „grüne Scheibe".
   */
  const oben = new THREE.Vector3(mitte.x, mitte.y, mitte.z);
  for (let seg = 0; seg < SEGMENTE; seg++) {
    const a = punkt(0, seg);
    const b = punkt(0, seg + 1);
    const moos = rand() < 0.3;
    /*
     * Reihenfolge `oben, b, a` und nicht `oben, a, b`.
     *
     * Die Wicklung entscheidet, wohin die Fläche zeigt, und das Material
     * zeichnet nur die Vorderseite. Andersherum herum lag die Wiese mit dem
     * Gesicht nach unten: von oben sah man durch sie hindurch in den Felsen,
     * und der sah aus wie eine Schüssel.
     */
    netz.dreieck(
      oben,
      b,
      a,
      grasFarbe === undefined ? 0x8a8175 : moos ? 0x4f7f3a : grasFarbe,
      0.86 + rand() * 0.28,
    );
  }
}

/**
 * Wurzeln, die unter der Lippe heraushängen.
 *
 * Drei Dreiecke je Wurzel, und sie tun mehr für die Silhouette als hundert
 * Dreiecke am Zapfen: von unten gesehen ist ein schwebender Felsen sonst eine
 * glatte Fläche, und nichts sagt, dass er einmal irgendwo gewachsen ist.
 */
function wurzeln(netz: Netz, radius: number, rand: () => number): void {
  const anzahl = Math.max(4, Math.round(radius * 0.7));
  for (let i = 0; i < anzahl; i++) {
    const winkel = (i / anzahl) * Math.PI * 2 + rand() * 0.4;
    const weite = radius * (0.72 + rand() * 0.26);
    const dicke = radius * (0.03 + rand() * 0.03);
    const laenge = radius * (0.3 + rand() * 0.55);

    const fuss = new THREE.Vector3(
      Math.cos(winkel) * weite,
      -radius * 0.16,
      Math.sin(winkel) * weite,
    );
    // Nach innen und unten: eine Wurzel, die nach aussen zeigt, sieht aus wie
    // ein Stachel.
    const spitze = new THREE.Vector3(
      fuss.x * 0.72 + (rand() - 0.5) * radius * 0.1,
      fuss.y - laenge,
      fuss.z * 0.72 + (rand() - 0.5) * radius * 0.1,
    );
    const quer = new THREE.Vector3(-Math.sin(winkel), 0, Math.cos(winkel)).multiplyScalar(dicke);
    const hoch = new THREE.Vector3(0, dicke, 0);

    const a = fuss.clone().add(quer);
    const b = fuss.clone().sub(quer);
    const c = fuss.clone().add(hoch);
    netz.dreieck(a, b, spitze, 0x5b4a34, 0.8 + rand() * 0.3);
    netz.dreieck(b, c, spitze, 0x5b4a34, 0.75 + rand() * 0.3);
    netz.dreieck(c, a, spitze, 0x5b4a34, 0.85 + rand() * 0.3);
  }
}

/**
 * Flache Steine auf der Wiese.
 *
 * Bewusst **flach**: der Kern kennt nur die Scheibe bei y = 0, man läuft also
 * durch alles hindurch, was darauf steht. Ein handbreiter Stein fällt dabei
 * nicht auf, ein Findling schon.
 */
function steine(netz: Netz, radius: number, rand: () => number): void {
  const anzahl = Math.max(3, Math.round(radius * 0.6));
  for (let i = 0; i < anzahl; i++) {
    const winkel = rand() * Math.PI * 2;
    const weite = radius * (0.2 + rand() * 0.6);
    const gross = radius * (0.05 + rand() * 0.06);
    const mitte = new THREE.Vector3(
      Math.cos(winkel) * weite,
      radius * 0.012,
      Math.sin(winkel) * weite,
    );
    const ecken = 5;
    const kranz: THREE.Vector3[] = [];
    for (let e = 0; e < ecken; e++) {
      const a = (e / ecken) * Math.PI * 2;
      const w = gross * (0.7 + rand() * 0.6);
      kranz.push(
        new THREE.Vector3(mitte.x + Math.cos(a) * w, mitte.y, mitte.z + Math.sin(a) * w),
      );
    }
    const kuppe = new THREE.Vector3(mitte.x, mitte.y + gross * 0.45, mitte.z);
    // Wicklung wie bei der Wiese: die Kuppe zeigt nach oben.
    for (let e = 0; e < ecken; e++) {
      netz.dreieck(kranz[(e + 1) % ecken]!, kranz[e]!, kuppe, 0x6f6b62, 0.8 + rand() * 0.35);
    }
  }
}

/**
 * Ein Findling auf dem Boden — derselbe Brocken, nur andersherum.
 *
 * Vorher war das eine flachgedrückte Kugel mit `roughen`: dieselbe Silhouette
 * aus jeder Richtung, weiche Kanten, und im Bild ein grauer Klumpen. Ein Stein
 * hat Facetten, und Facetten sind genau das, was die Ringe hier machen.
 *
 * `RINGE` beschreibt einen Brocken, der nach **unten** schmaler wird — bei
 * einem Findling ist das richtig herum: er sitzt breit im Boden und läuft nach
 * oben zusammen. Also wird die Form gestürzt und der Ursprung an die
 * Unterkante gelegt, damit `snapToGround` sie auf das Gelände setzt.
 */
export function baueFindling(radius: number, seed: number): THREE.BufferGeometry {
  const rand = wuerfel(seed);
  const netz = new Netz();
  brocken(netz, new THREE.Vector3(0, 0, 0), radius, rand, undefined);

  const geo = netz.fertig();
  // Umdrehen: aus dem Zapfen nach unten wird eine Kuppe nach oben.
  geo.rotateX(Math.PI);
  // Und flacher als der schwebende Felsen — ein Findling ist ein Stein und
  // kein Turm.
  geo.scale(1, 0.62, 1);

  // Auf den Boden setzen. Ohne das steckte der halbe Stein im Gelände: der
  // Ursprung der Ringe liegt in ihrer breitesten Ebene, nicht unten.
  const kasten = new THREE.Box3().setFromBufferAttribute(
    geo.attributes.position as THREE.BufferAttribute,
  );
  geo.translate(0, -kasten.min.y, 0);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Der ganze schwebende Felsen: Brocken, Wurzeln, Steine und ein paar Trabanten.
 *
 * Die Trabanten sind kleine Brocken, die unter der Insel mitschweben. Sie
 * kosten fast nichts und sind das, was einen einzelnen Stein zu einer
 * schwebenden Insel macht — der Blick von unten hat damit etwas zu sehen.
 */
export function baueSchwebfels(radius: number, seed: number): THREE.BufferGeometry {
  const rand = wuerfel(seed);
  const netz = new Netz();

  brocken(netz, new THREE.Vector3(0, 0, 0), radius, rand, 0x5f9a4a);
  wurzeln(netz, radius, rand);
  steine(netz, radius, rand);

  const trabanten = Math.max(2, Math.round(radius * 0.22));
  for (let i = 0; i < trabanten; i++) {
    const winkel = (i / trabanten) * Math.PI * 2 + rand();
    const weite = radius * (0.6 + rand() * 0.55);
    brocken(
      netz,
      new THREE.Vector3(
        Math.cos(winkel) * weite,
        -radius * (0.45 + rand() * 0.8),
        Math.sin(winkel) * weite,
      ),
      // Gross genug, dass man sie als Brocken erkennt: bei einem Zehntel des
      // Radius waren es Splitter, und Splitter sehen nach Fehler aus.
      radius * (0.17 + rand() * 0.14),
      rand,
      // Ohne Gras: was unter der Insel schwebt, hat keine Sonne.
      undefined,
    );
  }

  return netz.fertig();
}
