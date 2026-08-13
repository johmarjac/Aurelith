/**
 * Die Marke am Wegziel.
 *
 * Wer irgendwohin klickt, sieht dort für gut eine Sekunde einen Ring
 * aufblühen. Das ist keine Zierde: zwischen dem Klick und dem ersten Schritt
 * liegt eine Umlaufzeit, und ohne Rückmeldung klickt man in dieser Zeit noch
 * zweimal, weil man glaubt, nicht getroffen zu haben. Die Marke beantwortet
 * genau eine Frage — „ist der Klick angekommen, und wo?".
 *
 * Zwei Ringe, versetzt gestartet: einer allein liest sich als Fehler im Bild,
 * zwei nacheinander lesen sich als Bewegung. Beide wachsen und verblassen,
 * der äussere langsamer.
 *
 * Three.js und nicht der eigene Renderer: die Marke liegt **im** Gelände, also
 * hinter Hügeln und vor der Figur, und dafür braucht sie den Tiefenpuffer der
 * Szene. Die eigenen Pässe zeichnen additiv obendrauf — richtig für Funken,
 * falsch für etwas, das auf dem Boden liegt.
 */

import * as THREE from 'three';

/** Wie lange die Marke steht. Ein Wimpernschlag zu lang ist besser als zu kurz. */
export const MARKE_SEKUNDEN = 1.4;

/** Aussenradius am Ende des Wachsens, in Weltnenheiten. */
const RADIUS = 0.85;

/**
 * Wie hoch die Marke über dem Boden schwebt.
 *
 * Genau null hiesse, mit dem Gelände um dieselben Bildpunkte zu streiten —
 * das flimmert. Viel mehr hiesse, an einer Kante in der Luft zu liegen.
 */
const LUFT = 0.05;

export class Laufmarke {
  readonly root = new THREE.Group();

  private readonly ringe: THREE.Mesh[] = [];
  private readonly materialien: THREE.MeshBasicMaterial[] = [];
  private readonly geometrien: THREE.BufferGeometry[] = [];

  /** Sekunden seit dem Setzen. Negativ heisst: keine Marke. */
  private zeit = -1;
  /**
   * Wo der Boden liegt — dieselbe Auskunft, die auch die Figur benutzt.
   *
   * Ohne sie wäre der Ring eine waagerechte Scheibe, und das ist er in einem
   * Gelände fast nie: an einem Hang steckt die bergseitige Hälfte im Boden und
   * die talseitige schwebt. Man sah dann einen halben Ring und hielt ihn für
   * einen Fehler in der Anzeige.
   */
  private hoehe?: (x: number, z: number) => number;

  constructor(farbe = 0xffd98a) {
    this.root.visible = false;
    // Nicht in die Tiefe schreiben: zwei durchsichtige Ringe übereinander
    // würden sich sonst gegenseitig ausstanzen, und der innere verschwände je
    // nach Blickwinkel.
    for (let i = 0; i < 2; i++) {
      const geo = new THREE.RingGeometry(0.62, 1, 40, 1);
      // Flach auf den Boden legen. Die Ringgeometrie steht senkrecht.
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({
        color: farbe,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const netz = new THREE.Mesh(geo, mat);
      netz.position.y = LUFT;
      // Nicht am Sichtkegel prüfen. Die Hülle, an der three.js das täte, ist
      // beim Bauen des Netzes berechnet worden — mit flachen Punkten. Sobald
      // sie am Hang nach oben wandern, liegen sie ausserhalb dieser Hülle, und
      // die Marke verschwände genau dort, wo sie eben erst sichtbar wurde. Ein
      // Ring für anderthalb Sekunden ist nichts, was man wegsortieren müsste.
      netz.frustumCulled = false;
      netz.renderOrder = 2;
      this.root.add(netz);
      this.ringe.push(netz);
      this.materialien.push(mat);
      this.geometrien.push(geo);
    }
  }

  /**
   * Setzt die Marke an eine Stelle. Eine neue Marke ersetzt die alte.
   *
   * Kein Verblassen der vorherigen: wer zweimal hintereinander klickt, hat
   * genau ein Ziel, und zwei Marken behaupteten zwei.
   */
  setze(x: number, y: number, z: number, hoehe?: (x: number, z: number) => number): void {
    this.root.position.set(x, y, z);
    this.root.visible = true;
    this.zeit = 0;
    // Bei jedem Setzen neu: nach einem Kartenwechsel gehört die alte Auskunft
    // zu einem Gelände, das es nicht mehr gibt.
    this.hoehe = hoehe;
  }

  /** Nimmt die Marke weg — beim Kartenwechsel oder wenn der Auftrag endet. */
  loesche(): void {
    this.zeit = -1;
    this.root.visible = false;
  }

  step(dt: number): void {
    if (this.zeit < 0) return;
    this.zeit += dt;
    if (this.zeit >= MARKE_SEKUNDEN) {
      this.loesche();
      return;
    }

    for (let i = 0; i < this.ringe.length; i++) {
      // Der zweite Ring startet ein Drittel später und ist damit die halbe
      // Zeit über allein zu sehen.
      const versatz = i * 0.33;
      const p = (this.zeit / MARKE_SEKUNDEN - versatz) / (1 - versatz);
      const netz = this.ringe[i]!;
      const mat = this.materialien[i]!;

      if (p <= 0) {
        netz.visible = false;
        continue;
      }
      netz.visible = true;

      // Schnell auf, langsam aus: ein Ring, der gleichmässig wächst, sieht aus
      // wie eine Animation; einer, der aufschnellt und ausklingt, wie ein
      // Aufschlag.
      const gross = 1 - (1 - p) * (1 - p);
      const skala = RADIUS * (0.35 + gross * 0.65);
      netz.scale.setScalar(skala);
      mat.opacity = (1 - p) * 0.75;
      // Der Ring wächst, also wandern seine Punkte über den Boden — die Höhen
      // von eben gelten für die Stellen von eben. Deshalb bei jedem Bild neu.
      this.legeAufGelaende(this.geometrien[i]!, skala);
    }
  }

  /**
   * Legt die Punkte des Rings auf das Gelände.
   *
   * Gerechnet wird in der Höhe **relativ** zum Mittelpunkt der Marke und durch
   * die Skalierung geteilt: der Punkt liegt im Netz, und das Netz wird beim
   * Wachsen gestreckt — auch nach oben. Ohne die Teilung wüchse der
   * Höhenunterschied mit dem Ring, und am Hang stellte er sich auf.
   */
  private legeAufGelaende(geo: THREE.BufferGeometry, skala: number): void {
    const hoehe = this.hoehe;
    if (!hoehe || skala < 1e-3) return;
    const punkte = geo.getAttribute('position') as THREE.BufferAttribute;
    const mitte = this.root.position;
    for (let i = 0; i < punkte.count; i++) {
      const wx = mitte.x + punkte.getX(i) * skala;
      const wz = mitte.z + punkte.getZ(i) * skala;
      punkte.setY(i, (hoehe(wx, wz) - mitte.y) / skala);
    }
    punkte.needsUpdate = true;
  }

  dispose(): void {
    for (const g of this.geometrien) g.dispose();
    for (const m of this.materialien) m.dispose();
  }
}
