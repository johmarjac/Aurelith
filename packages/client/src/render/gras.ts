/**
 * Der Grasteppich — Halme rings um die Figur, und nur dort.
 *
 * Der Boden trägt eine Grastextur, und eine Textur ist flach. Aus der Ferne
 * genügt das; unter den Füssen sieht man, dass die Wiese ein bemaltes Blech
 * ist. Was fehlt, ist die **Silhouette**: einzelne Halme, die über den Boden
 * hinausragen und sich vor dem stellen, was dahinter liegt.
 *
 * Sie über die ganze Karte zu streuen wäre die naheliegende und teure Antwort.
 * Lichtmoor ist zweieinhalb Quadratkilometer gross; bei einem Büschel je zwei
 * Meter wären das eine halbe Million, und gesehen wird davon der Kreis von
 * fünfundzwanzig Metern, in dem die Figur steht. Also wird genau dieser Kreis
 * gebaut, und er **wandert mit**.
 *
 * Wie das Mitwandern funktioniert, ist der Kern der Sache und zugleich die
 * Stelle, an der es leicht falsch wird:
 *
 *   - Die Büschel liegen auf festen Punkten in einem Quadrat der Seitenlänge
 *     `2·radius`, und ihre Weltlage ist dieselbe Rechnung **modulo** dieser
 *     Seitenlänge. Ein Büschel bleibt damit an seinem Fleck in der Welt stehen,
 *     solange die Figur in seiner Nähe ist — es klebt nicht an ihr.
 *   - Verlässt es das Quadrat hinten, taucht es vorne wieder auf. Das ist der
 *     einzige Augenblick, in dem ein Halm springt, und er liegt genau am Rand,
 *     wo die Grösse ohnehin auf null heruntergeblendet ist. Ohne diese
 *     Ausblendung sähe man am Rand des Kreises eine Linie, an der Gras aus dem
 *     Nichts erscheint — und die ist schlimmer als gar kein Gras.
 *
 * Zwei Stellen bekommen kein Gras, und beide werden abgetastet und nicht
 * geraten: **Hänge** (dort zeigt der Boden Erde und Fels, nicht Wiese) und
 * alles **unter dem Wasserspiegel**. Halme, die aus dem Meer ragen, sind das
 * Erste, was auffällt.
 */

import * as THREE from 'three';
import { assemble, type Part } from './geometry.ts';
import { laubKarte } from './laub.ts';

/** Woher die Höhen kommen — dieselbe Fläche, die auch gezeichnet wird. */
export interface GrasBoden {
  /**
   * Höhe der **gezeichneten** Fläche.
   *
   * Und nicht die des Kerns: ein Halm ist einen halben Meter hoch, und
   * zwischen zwei Stützpunkten des Geländenetzes liegt die gerechnete Höhe
   * regelmässig über dem Dreieck, das man sieht. Auf der gerechneten Fläche
   * stünde ein Teil der Halme sichtbar in der Luft — derselbe Fehler, den die
   * Laufmarke schon einmal hatte.
   */
  hoeheAn(x: number, z: number): number;
}

export interface GrasEinstellungen {
  /** Wie viele Büschel im Kreis stehen. */
  anzahl: number;
  /** Der Radius des Kreises in Metern. */
  radius: number;
  /** Die beiden Grüntöne der Karte — die Halme tragen die Farbe ihrer Wiese. */
  farbe: number;
  farbeAlt: number;
}

/**
 * Ein Büschel: drei gekreuzte Karten.
 *
 * Drei und nicht zwei. Zwei gekreuzte Karten stehen im rechten Winkel, und
 * genau in der Winkelhalbierenden sieht man beide von der Kante — der Halm
 * verschwindet aus einer von acht Blickrichtungen. Bei drei Karten ist der
 * grösste Winkel, unter dem eine Karte zur Kante wird, dreissig Grad, und
 * dann steht die nächste voll im Bild.
 */
function bueschel(hoehe: number): THREE.BufferGeometry {
  const parts: Part[] = [];
  for (let i = 0; i < 3; i++) {
    parts.push({
      geometry: laubKarte('gras', hoehe * 1.35, hoehe * (1 - (i % 2) * 0.18)),
      // Weiss: die Farbe kommt je Büschel aus `instanceColor`, und die wird
      // mit der Vertexfarbe multipliziert. Stünde hier Grün, wäre es zweimal
      // grün und damit fast schwarz.
      color: 0xffffff,
      rotation: [0, (i / 3) * Math.PI, 0],
    });
  }
  return assemble(parts);
}

export class Grasteppich {
  readonly mesh: THREE.InstancedMesh;

  private readonly einst: GrasEinstellungen;
  /** Die festen Punkte im Quadrat, in [0, seite). */
  private readonly punkte: Float32Array;
  /** Höhe und Drehung je Büschel — einmal gewürfelt, danach fest. */
  private readonly wuchs: Float32Array;
  private boden: GrasBoden | undefined;
  private wasser = -1e9;
  /** Wo zuletzt gerechnet wurde. `NaN`, solange noch gar nichts steht. */
  private letztesX = NaN;
  private letztesZ = NaN;

  constructor(material: THREE.Material, einst: GrasEinstellungen) {
    this.einst = einst;
    this.mesh = new THREE.InstancedMesh(bueschel(0.55), material, einst.anzahl);
    this.mesh.name = 'grasteppich';
    /*
     * Nie wegschneiden. Die Hülle der Instanzen wird nicht mitgeführt — sie
     * bliebe am Ursprung stehen, und der Teppich verschwände, sobald die Figur
     * weit genug gelaufen ist. Ihn zu pflegen wäre Arbeit für nichts: der
     * Teppich ist immer dort, wo die Kamera hinsieht.
     */
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // Sonst bleibt `instanceColor` leer und alle Büschel sind weiss.
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(einst.anzahl * 3),
      3,
    );

    const seite = einst.radius * 2;
    this.punkte = new Float32Array(einst.anzahl * 2);
    this.wuchs = new Float32Array(einst.anzahl * 3);
    /*
     * Gestreut und nicht gerastert.
     *
     * Ein Raster mit Zufall darauf wäre gleichmässiger — und genau das ist der
     * Fehler: gleichmässig verteiltes Gras sieht aus wie ein Acker. Eine
     * Wiese hat dichte Stellen und kahle, und die entstehen von allein, wenn
     * man einfach würfelt.
     */
    let a = 0x9e3779b9;
    const rand = (): number => {
      a ^= a << 13;
      a >>>= 0;
      a ^= a >>> 17;
      a ^= a << 5;
      a >>>= 0;
      return a / 4294967296;
    };
    for (let i = 0; i < einst.anzahl; i++) {
      this.punkte[i * 2] = rand() * seite;
      this.punkte[i * 2 + 1] = rand() * seite;
      this.wuchs[i * 3] = 0.7 + rand() * 0.7;
      this.wuchs[i * 3 + 1] = rand() * Math.PI * 2;
      this.wuchs[i * 3 + 2] = rand();
    }
  }

  /**
   * Sagt, worauf die Halme stehen. Ohne Boden bleibt der Teppich leer — beim
   * Kartenwechsel ist das der richtige Zustand und kein Sonderfall.
   */
  setBoden(boden: GrasBoden | undefined, wasserHoehe: number): void {
    this.boden = boden;
    this.wasser = wasserHoehe;
    // Erzwingt ein Neurechnen beim nächsten `folge`, auch wenn die Figur genau
    // dort steht, wo sie vorher stand.
    this.letztesX = NaN;
    this.letztesZ = NaN;
    this.mesh.visible = boden !== undefined;
  }

  /**
   * Zieht den Teppich unter die Figur.
   *
   * Erst ab zwei Metern Bewegung, und das ist die ganze Kostenrechnung: bei
   * Lauftempo sind das rund vier Neurechnungen je Sekunde statt einer je Bild.
   * Kleiner gewählt gewinnt man nichts — die Halme stehen ohnehin fest in der
   * Welt, es geht nur darum, wann der Kranz nachrückt.
   */
  folge(x: number, z: number): void {
    if (!this.boden) return;
    if (Math.hypot(x - this.letztesX, z - this.letztesZ) < 2) return;
    this.letztesX = x;
    this.letztesZ = z;

    const { anzahl, radius, farbe, farbeAlt } = this.einst;
    const seite = radius * 2;
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const skala = new THREE.Vector3();
    const euler = new THREE.Euler();
    const gruen = new THREE.Color(farbe);
    const gruenAlt = new THREE.Color(farbeAlt);
    const ton = new THREE.Color();

    for (let i = 0; i < anzahl; i++) {
      /*
       * Die Weltlage: der feste Punkt, in das Quadrat um die Figur geholt.
       *
       * `((v % s) + s) % s` und nicht `v % s` — in JavaScript hat der Rest das
       * Vorzeichen des Zählers, und südlich oder westlich vom Ursprung wären
       * die Halme sonst alle auf einer Seite der Figur.
       */
      const rohX = this.punkte[i * 2]! - x + radius;
      const rohZ = this.punkte[i * 2 + 1]! - z + radius;
      const hx = x - radius + (((rohX % seite) + seite) % seite);
      const hz = z - radius + (((rohZ % seite) + seite) % seite);

      const abstand = Math.hypot(hx - x, hz - z);
      // Ausblenden zum Rand hin: die letzten fünf Meter schrumpfen die Halme
      // auf null. Dort springen sie beim Umlauf, und was null gross ist,
      // springt unsichtbar.
      const nah = Math.max(0, Math.min(1, (radius - abstand) / 5));

      const h = this.boden.hoeheAn(hx, hz);
      /*
       * Zwei Ausschlüsse, beide abgetastet:
       *
       *   - Unter Wasser wächst nichts. Ein halber Meter Zuschlag, damit am
       *     Ufer nicht Halme aus der Brandung ragen.
       *   - Am Hang wächst nichts. Die Neigung wird aus vier Nachbarn
       *     genommen — dieselbe Zahl, nach der auch die Bodentextur von Gras
       *     auf Erde wechselt, und deshalb steht das Gras genau dort, wo der
       *     Boden grün ist.
       */
      const steil =
        Math.hypot(
          (this.boden.hoeheAn(hx + 1.5, hz) - this.boden.hoeheAn(hx - 1.5, hz)) / 3,
          (this.boden.hoeheAn(hx, hz + 1.5) - this.boden.hoeheAn(hx, hz - 1.5)) / 3,
        ) > 0.62;
      const traegt = h > this.wasser + 0.5 && !steil;

      const gross = traegt ? nah * this.wuchs[i * 3]! : 0;
      pos.set(hx, h, hz);
      euler.set(0, this.wuchs[i * 3 + 1]!, 0);
      quat.setFromEuler(euler);
      skala.set(gross, gross, gross);
      matrix.compose(pos, quat, skala);
      this.mesh.setMatrixAt(i, matrix);

      /*
       * Die Farbe der Wiese, aber **dunkler**.
       *
       * Genau der Ton des Bodens war der erste Versuch, und die Halme
       * leuchteten darauf wie Farbtupfer: der Boden trägt seine Textur und
       * liegt damit gut ein Fünftel unter seiner reinen Farbe, ein Halm ist
       * eine flache Karte ohne Struktur. Gleiche Zahl heisst hier also nicht
       * gleiches Bild — was zählt, ist, dass das Gras im Boden steht und nicht
       * darauf.
       */
      ton.copy(gruen).lerp(gruenAlt, this.wuchs[i * 3 + 2]!).multiplyScalar(0.82);
      this.mesh.setColorAt(i, ton);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /**
   * Wie viele Büschel es gibt und wie viele davon eine Grösse über null haben.
   *
   * Gelesen wird aus der Instanzmatrix und nicht aus einem mitgeführten
   * Zähler: was hier steht, ist das, was gezeichnet wird — ein Zähler wäre
   * eine zweite Wahrheit und liefe beim nächsten Sonderfall daneben.
   */
  stand(): { bueschel: number; stehend: number } {
    const werte = this.mesh.instanceMatrix.array;
    let stehend = 0;
    for (let i = 0; i < this.einst.anzahl; i++) {
      const o = i * 16;
      if (Math.hypot(werte[o]!, werte[o + 1]!, werte[o + 2]!) > 0) stehend++;
    }
    return { bueschel: this.einst.anzahl, stehend };
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}
