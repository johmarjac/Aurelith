/**
 * Aus einem Distanzfeld ein Netz — „Surface Nets".
 *
 * Bisher entstehen alle Modelle dieses Spiels aus **zusammengesetzten**
 * Grundkörpern: ein Rumpf, zwei Arme, ein Kopf, und wo sie sich schneiden,
 * sieht man die Schnittkante. Für einen Fels ist das richtig, für einen Körper
 * nicht. Eine Schulter geht in einen Arm über, sie stösst nicht an ihn.
 *
 * Der Weg dorthin führt über eine andere Beschreibung: nicht „hier liegt ein
 * Zylinder", sondern „so weit ist es von hier bis zur Oberfläche". Das ist ein
 * **Distanzfeld**, und zwei Distanzfelder lassen sich weich verschmelzen — die
 * Naht wird zur Rundung, und zwar von selbst und überall gleich.
 *
 * Übrig bleibt die Frage, wie aus einem Feld Dreiecke werden. Der bekannte Weg
 * sind Marching Cubes; die brauchen eine Tabelle mit 256 Einträgen, und die
 * schreibt niemand fehlerfrei ab. Surface Nets kommen ohne aus:
 *
 *   1. Das Feld wird auf einem Gitter abgetastet.
 *   2. Jede Zelle, in der das Vorzeichen wechselt, bekommt **einen** Punkt —
 *      den Mittelwert der Nulldurchgänge auf ihren zwölf Kanten.
 *   3. Wo eine Gitterkante das Vorzeichen wechselt, spannen die vier Zellen um
 *      diese Kante ein Viereck auf.
 *
 * Das Ergebnis ist ein geschlossenes, gleichmässig unterteiltes Netz mit
 * geteilten Ecken — also genau das, was weiche Normalen brauchen. Die Normalen
 * kommen dabei nicht aus den Dreiecken, sondern aus dem **Gradienten des
 * Feldes**: der weiss auch dort, wohin die Fläche zeigt, wo das Gitter grob
 * ist, und macht aus einer Treppe eine Rundung.
 */

import * as THREE from 'three';

/** Ein Feld: liefert den Abstand zur Oberfläche. Negativ heisst innen. */
export type Feld = (x: number, y: number, z: number) => number;

export interface NetzOptionen {
  /** Der Kasten, in dem gesucht wird. Was ausserhalb liegt, gibt es nicht. */
  min: [number, number, number];
  max: [number, number, number];
  /** Kantenlänge einer Zelle. Kleiner heisst feiner und teurer. */
  schritt: number;
}

/**
 * Die zwölf Kanten eines Würfels, als Paare seiner acht Ecken.
 *
 * Die Ecken sind so nummeriert, dass Bit 0 für x, Bit 1 für y und Bit 2 für z
 * steht — Ecke 5 ist also (1, 0, 1). Damit ist die Nummer zugleich der
 * Versatz im Gitter, und man braucht keine zweite Tabelle dafür.
 */
const KANTEN: ReadonlyArray<[number, number]> = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/**
 * Baut das Netz.
 *
 * Gibt eine indizierte Geometrie mit `position` und `normal` zurück — ohne
 * Farbe: welche Stelle welche Farbe bekommt, weiss das Feld nicht, und ein
 * Netzbauer, der Körperteile kennt, wäre keiner mehr.
 */
export function baueNetz(feld: Feld, opt: NetzOptionen): THREE.BufferGeometry {
  const { min, max, schritt } = opt;
  const nx = Math.ceil((max[0] - min[0]) / schritt) + 1;
  const ny = Math.ceil((max[1] - min[1]) / schritt) + 1;
  const nz = Math.ceil((max[2] - min[2]) / schritt) + 1;

  /*
   * Erst abtasten, dann suchen.
   *
   * Jeder Gitterpunkt wird von acht Zellen benutzt; ohne diesen Puffer würde
   * das Feld achtmal für denselben Punkt ausgewertet, und das Feld ist der
   * teure Teil — ein Körper besteht aus zwei Dutzend Gliedern, die jedes Mal
   * alle durchgerechnet werden.
   */
  const werte = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    const z = min[2] + k * schritt;
    for (let j = 0; j < ny; j++) {
      const y = min[1] + j * schritt;
      for (let i = 0; i < nx; i++) {
        werte[(k * ny + j) * nx + i] = feld(min[0] + i * schritt, y, z);
      }
    }
  }
  const wert = (i: number, j: number, k: number): number => werte[(k * ny + j) * nx + i]!;

  // Je Zelle die Nummer ihres Punktes, oder −1. Der Puffer ist die halbe
  // Miete: die Vierecke unten finden ihre Nachbarzellen darüber wieder.
  const punktIndex = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const orte: number[] = [];
  const normalen: number[] = [];

  /*
   * Der Gradient des Feldes, aus zentralen Differenzen.
   *
   * Er zeigt dorthin, wo das Feld am schnellsten wächst — also von der
   * Oberfläche weg, und das ist die Normale. Aus den Dreiecken gerechnet wäre
   * sie stufig: ein Gitterpunkt liegt nie genau auf der Fläche, und die
   * Facetten des Gitters schlagen durch. Der Gradient kennt das Gitter nicht.
   */
  const h = schritt * 0.5;
  const normale = (x: number, y: number, z: number): [number, number, number] => {
    const dx = feld(x + h, y, z) - feld(x - h, y, z);
    const dy = feld(x, y + h, z) - feld(x, y - h, z);
    const dz = feld(x, y, z + h) - feld(x, y, z - h);
    const l = Math.hypot(dx, dy, dz) || 1;
    return [dx / l, dy / l, dz / l];
  };

  const eckOffsets: Array<[number, number, number]> = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];

  for (let k = 0; k + 1 < nz; k++) {
    for (let j = 0; j + 1 < ny; j++) {
      for (let i = 0; i + 1 < nx; i++) {
        const ecke: number[] = [];
        let innen = 0;
        for (let e = 0; e < 8; e++) {
          const [oi, oj, ok] = eckOffsets[e]!;
          const v = wert(i + oi, j + oj, k + ok);
          ecke.push(v);
          if (v < 0) innen++;
        }
        // Ganz drinnen oder ganz draussen: hier liegt keine Fläche.
        if (innen === 0 || innen === 8) continue;

        /*
         * Der Punkt der Zelle: der Mittelwert der Nulldurchgänge.
         *
         * Nicht die Zellenmitte — die ergäbe ein Treppenmuster, und zwar genau
         * dort, wo die Fläche flach durch die Zelle läuft. Linear zwischen den
         * beiden Eckwerten interpoliert liegt der Übergang dagegen fast auf
         * der wahren Fläche.
         */
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let treffer = 0;
        for (const [a, b] of KANTEN) {
          const va = ecke[a]!;
          const vb = ecke[b]!;
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          const [ax, ay, az] = eckOffsets[a]!;
          const [bx, by, bz] = eckOffsets[b]!;
          sx += ax + (bx - ax) * t;
          sy += ay + (by - ay) * t;
          sz += az + (bz - az) * t;
          treffer++;
        }
        const px = min[0] + (i + sx / treffer) * schritt;
        const py = min[1] + (j + sy / treffer) * schritt;
        const pz = min[2] + (k + sz / treffer) * schritt;

        punktIndex[(k * (ny - 1) + j) * (nx - 1) + i] = orte.length / 3;
        orte.push(px, py, pz);
        const n = normale(px, py, pz);
        normalen.push(n[0], n[1], n[2]);
      }
    }
  }

  const zelle = (i: number, j: number, k: number): number =>
    i < 0 || j < 0 || k < 0 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1
      ? -1
      : punktIndex[(k * (ny - 1) + j) * (nx - 1) + i]!;

  /*
   * Die Vierecke.
   *
   * Wo eine **Gitterkante** das Vorzeichen wechselt, treffen sich vier Zellen,
   * und ihre vier Punkte bilden ein Viereck der Oberfläche. Die Reihenfolge
   * entscheidet, wohin es zeigt: sie wird umgedreht, wenn die Kante von innen
   * nach aussen läuft statt umgekehrt. Ohne das ist die Hälfte des Körpers von
   * aussen unsichtbar — und man schaut in ihn hinein.
   */
  const index: number[] = [];
  const viereck = (a: number, b: number, c: number, d: number, umdrehen: boolean): void => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (umdrehen) index.push(a, c, b, a, d, c);
    else index.push(a, b, c, a, c, d);
  };

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const v = wert(i, j, k);
        if (i + 1 < nx && (v < 0) !== (wert(i + 1, j, k) < 0)) {
          viereck(
            zelle(i, j - 1, k - 1),
            zelle(i, j, k - 1),
            zelle(i, j, k),
            zelle(i, j - 1, k),
            v >= 0,
          );
        }
        if (j + 1 < ny && (v < 0) !== (wert(i, j + 1, k) < 0)) {
          viereck(
            zelle(i - 1, j, k - 1),
            zelle(i, j, k - 1),
            zelle(i, j, k),
            zelle(i - 1, j, k),
            v < 0,
          );
        }
        if (k + 1 < nz && (v < 0) !== (wert(i, j, k + 1) < 0)) {
          viereck(
            zelle(i - 1, j - 1, k),
            zelle(i, j - 1, k),
            zelle(i, j, k),
            zelle(i - 1, j, k),
            v >= 0,
          );
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(orte, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normalen, 3));
  geo.setIndex(index);
  return geo;
}

// ---------------------------------------------------------------------------
// Distanzfunktionen
// ---------------------------------------------------------------------------

/**
 * Weiche Vereinigung zweier Felder.
 *
 * Das Herzstück. Ein gewöhnliches `min` ergibt eine Kante — genau die
 * Schnittkante, die zusammengesetzte Grundkörper so unbeholfen aussehen lässt.
 * Die polynomiale Fassung mischt in einem Band der Breite `k` und liefert dort
 * eine Rundung, deren Radius man vorgibt. Eine Schulter geht damit in den Arm
 * über, statt an ihn zu stossen.
 */
export function weichesMin(a: number, b: number, k: number): number {
  const t = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b * (1 - t) + a * t - k * t * (1 - t);
}

/**
 * Abstand zu einem **Kegelstumpf mit runden Enden** — der Grundbaustein.
 *
 * Ein Glied ist keine Röhre: ein Oberschenkel ist an der Hüfte dicker als am
 * Knie, ein Unterarm am Ellbogen dicker als am Handgelenk. Mit gleichem Radius
 * an beiden Enden sieht ein Körper aus wie aus Rohren gesteckt — der übliche
 * Fehler bei Figuren aus Zylindern.
 */
export function gliedAbstand(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  ra: number,
  rb: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const laengeQ = dx * dx + dy * dy + dz * dz || 1e-9;
  const vx = px - ax;
  const vy = py - ay;
  const vz = pz - az;
  // Der Fusspunkt auf der Achse, auf das Stück begrenzt: darüber hinaus
  // übernimmt die Halbkugel am Ende.
  const t = Math.max(0, Math.min(1, (vx * dx + vy * dy + vz * dz) / laengeQ));
  const cx = vx - dx * t;
  const cy = vy - dy * t;
  const cz = vz - dz * t;
  return Math.hypot(cx, cy, cz) - (ra + (rb - ra) * t);
}

/** Abstand zu einem Ellipsoid. Für Kopf, Brustkorb, Becken — alles Rundliche. */
export function ellipsoidAbstand(
  px: number,
  py: number,
  pz: number,
  cx: number,
  cy: number,
  cz: number,
  rx: number,
  ry: number,
  rz: number,
): number {
  const x = (px - cx) / rx;
  const y = (py - cy) / ry;
  const z = (pz - cz) / rz;
  const k = Math.hypot(x, y, z);
  /*
   * Kein echter Abstand, sondern eine Näherung.
   *
   * Der exakte Abstand zu einem Ellipsoid ist die Nullstelle eines Polynoms
   * sechsten Grades — pro Gitterpunkt und pro Körperteil. Die Näherung
   * `(k − 1) · min(r)` unterschätzt ihn nach innen und ist auf der Fläche
   * selbst genau; für das weiche Verschmelzen reicht das, und die Fläche liegt
   * dort, wo sie liegen soll.
   */
  return (k - 1) * Math.min(rx, ry, rz);
}
