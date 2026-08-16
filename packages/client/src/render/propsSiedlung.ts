/**
 * Siedlung — was Menschen hinstellen, wo sie leben und arbeiten.
 *
 * Eine Karte wird nicht dadurch bewohnt, dass Häuser darauf stehen, sondern
 * dadurch, dass **Arbeit** darauf sichtbar ist: ein Amboss neben der Esse, ein
 * Trog neben dem Zaun, ein Stapel Holz neben dem Hackklotz. Wer nur Gebäude
 * hinsetzt, bekommt eine Kulisse; wer Werkzeug hinsetzt, bekommt einen Ort.
 *
 * Drei Regeln, die sich aus den vorhandenen Props ergeben haben:
 *
 * - **Der Ursprung liegt am Boden** und, wo es eine gibt, in der begehbaren
 *   Fläche. Alles andere schwebt oder steckt fest, sobald `snapToGround` es
 *   auf ein Höhenfeld setzt.
 * - **Was sich aneinanderreihen soll, hat seine Pfosten an den Enden** — wie
 *   beim Zaunfeld. Ein Steg aus Feldern mit Pfosten in der Mitte hat zwischen
 *   je zwei Stücken eine Lücke.
 * - **Kein Teil ist dünner als drei Zentimeter.** Darunter verschwindet es in
 *   der Ferne ganz und flackert dazwischen — teurer als ein dickerer Balken
 *   und hässlicher.
 */

import * as THREE from 'three';
import { assemble, box, cone, cylinder, rundeBox, sphere, type Part } from './geometry.ts';

const HOLZ = 0x8a6a42;
const DUNKELHOLZ = 0x6b4f34;
const STEIN = 0x7d7a70;
const DUNKELSTEIN = 0x4a4a52;
const EISEN = 0x3a3a40;
const STOFF = 0xb8542f;

// --- Markt und Transport ----------------------------------------------------

/**
 * Ein Marktstand: Tisch, vier Stangen, Dach.
 *
 * Das Dach ist **gestreift**, und das ist der ganze Trick — ein einfarbiges
 * Tuch liest sich als Kiste auf Stelzen, zwei Farben im Wechsel sofort als
 * Markise.
 */
export function baueMarktstand(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: box(2.4, 0.1, 1.2), color: HOLZ, position: [0, 0.9, 0] },
    { geometry: box(2.4, 0.5, 0.08), color: DUNKELHOLZ, position: [0, 0.62, -0.55] },
  ];
  for (const [x, z] of [[-1.1, -0.5], [1.1, -0.5], [-1.1, 0.5], [1.1, 0.5]] as Array<[number, number]>) {
    parts.push({ geometry: box(0.09, 2.2, 0.09), color: DUNKELHOLZ, position: [x, 1.1, z] });
  }
  for (let i = 0; i < 5; i++) {
    parts.push({
      geometry: box(0.52, 0.07, 1.6),
      color: i % 2 === 0 ? STOFF : 0xe8dcc0,
      position: [-1.04 + i * 0.52, 2.24, 0],
      rotation: [0.12, 0, 0],
    });
  }
  return assemble(parts);
}

/** Ein grober Tisch mit Böcken — er steht auf dem Markt und in der Schenke. */
export function baueMarkttisch(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(2.0, 0.1, 0.9), color: HOLZ, position: [0, 0.82, 0] },
    { geometry: box(0.1, 0.8, 0.7), color: DUNKELHOLZ, position: [-0.8, 0.4, 0], rotation: [0.12, 0, 0] },
    { geometry: box(0.1, 0.8, 0.7), color: DUNKELHOLZ, position: [0.8, 0.4, 0], rotation: [-0.12, 0, 0] },
    { geometry: box(1.7, 0.08, 0.08), color: DUNKELHOLZ, position: [0, 0.32, 0] },
  ]);
}

/** Handkarre — zwei Räder, zwei Holme, eine Ladefläche. */
export function baueHandkarre(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: box(1.5, 0.1, 0.9), color: HOLZ, position: [0, 0.6, 0] },
    { geometry: box(1.5, 0.35, 0.07), color: HOLZ, position: [0, 0.78, -0.42] },
    { geometry: box(1.5, 0.35, 0.07), color: HOLZ, position: [0, 0.78, 0.42] },
    { geometry: box(0.07, 0.28, 0.9), color: HOLZ, position: [-0.72, 0.75, 0] },
    // Die Holme laufen nach vorn aus und liegen auf dem Boden auf — eine
    // Karre, die auf zwei Rädern balanciert, sieht aus, als sei sie abgestellt
    // worden, während jemand fällt.
    { geometry: box(1.2, 0.07, 0.07), color: DUNKELHOLZ, position: [1.2, 0.3, -0.3], rotation: [0, 0, -0.32] },
    { geometry: box(1.2, 0.07, 0.07), color: DUNKELHOLZ, position: [1.2, 0.3, 0.3], rotation: [0, 0, -0.32] },
  ];
  for (const z of [-0.52, 0.52]) {
    parts.push({
      geometry: cylinder(0.42, 0.42, 0.1, 10),
      color: DUNKELHOLZ,
      position: [-0.3, 0.42, z],
      rotation: [Math.PI / 2, 0, 0],
    });
  }
  return assemble(parts);
}

/** Planwagen — eine Karre mit Bögen und Plane. Er gehört an eine Strasse. */
export function bauePlanwagen(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: box(3.2, 0.16, 1.6), color: HOLZ, position: [0, 0.95, 0] },
    { geometry: box(3.2, 0.5, 0.09), color: DUNKELHOLZ, position: [0, 1.2, -0.78] },
    { geometry: box(3.2, 0.5, 0.09), color: DUNKELHOLZ, position: [0, 1.2, 0.78] },
    { geometry: box(0.09, 0.5, 1.6), color: DUNKELHOLZ, position: [-1.6, 1.2, 0] },
  ];
  // Die Plane: fünf Bögen aus flachen Kästen. Ein echter Halbzylinder wäre
  // hier hundert Dreiecke für eine Silhouette, die man auch mit fünf bekommt.
  for (let i = 0; i < 5; i++) {
    const x = -1.3 + i * 0.65;
    parts.push({
      geometry: rundeBox(0.6, 1.5, 1.66, { rund: 0.5, oben: 0.75, seg: 3 }),
      color: 0xd8cdb0,
      position: [x, 1.75, 0],
    });
  }
  for (const [x, z] of [[-1.15, -0.9], [-1.15, 0.9], [1.15, -0.9], [1.15, 0.9]] as Array<[number, number]>) {
    parts.push({
      geometry: cylinder(0.5, 0.5, 0.12, 10),
      color: DUNKELHOLZ,
      position: [x, 0.5, z],
      rotation: [Math.PI / 2, 0, 0],
    });
  }
  return assemble(parts);
}

/** Ein Wagenrad, angelehnt. Es sagt: hier ist etwas kaputtgegangen. */
export function baueWagenrad(): THREE.BufferGeometry {
  /*
   * Die Felge ist ein flachgedrückter Zylinder, die Speichen sind sechs
   * durchgehende Balken.
   *
   * Ein echtes Loch in der Mitte hiesse ein Ring aus zwölf Segmenten — doppelt
   * so viele Dreiecke für etwas, das aus zehn Metern gleich aussieht, weil die
   * Speichen die Fläche ohnehin zerteilen.
   */
  const parts: Part[] = [
    {
      geometry: cylinder(0.62, 0.62, 0.1, 12),
      color: DUNKELHOLZ,
      position: [0, 0.62, 0],
      rotation: [Math.PI / 2, 0, 0.2],
      scale: [1, 1, 0.16],
    },
  ];
  for (let i = 0; i < 6; i++) {
    parts.push({
      geometry: box(1.1, 0.07, 0.07),
      color: HOLZ,
      position: [0, 0.62, 0],
      rotation: [0, 0, 0.2 + (i / 6) * Math.PI],
    });
  }
  parts.push({ geometry: cylinder(0.14, 0.14, 0.16, 8), color: DUNKELHOLZ, position: [0, 0.62, 0], rotation: [Math.PI / 2, 0, 0] });
  return assemble(parts);
}

// --- Handwerk ---------------------------------------------------------------

/** Holzstapel — gespaltene Scheite, quer geschichtet. */
export function baueHolzstapel(): THREE.BufferGeometry {
  const parts: Part[] = [];
  for (let reihe = 0; reihe < 4; reihe++) {
    const quer = reihe % 2 === 1;
    for (let i = 0; i < 5; i++) {
      const o = -0.5 + i * 0.25;
      parts.push({
        geometry: cylinder(0.12, 0.12, 1.3, 6),
        color: i % 2 === 0 ? DUNKELHOLZ : 0x7a5a36,
        position: quer ? [o, 0.14 + reihe * 0.25, 0] : [0, 0.14 + reihe * 0.25, o],
        rotation: quer ? [Math.PI / 2, 0, 0] : [0, 0, Math.PI / 2],
      });
    }
  }
  return assemble(parts);
}

/** Hackklotz mit Beil. Ohne das Beil ist es ein Stumpf. */
export function baueHackklotz(): THREE.BufferGeometry {
  return assemble([
    { geometry: cylinder(0.4, 0.44, 0.7, 9), color: DUNKELHOLZ, position: [0, 0.35, 0] },
    { geometry: cylinder(0.36, 0.36, 0.05, 9), color: 0xa87f52, position: [0, 0.72, 0] },
    { geometry: box(0.05, 0.7, 0.05), color: 0x9a7a4a, position: [0.1, 1.0, 0], rotation: [0, 0, -0.35] },
    { geometry: box(0.06, 0.24, 0.18), color: 0x9aa3ad, position: [0.31, 1.32, 0], rotation: [0, 0, -0.35] },
  ]);
}

/** Amboss auf Block. Das Werkzeug, an dem man einen Schmied erkennt. */
export function baueAmboss(): THREE.BufferGeometry {
  return assemble([
    { geometry: cylinder(0.34, 0.4, 0.55, 8), color: DUNKELHOLZ, position: [0, 0.28, 0] },
    { geometry: box(0.7, 0.16, 0.3), color: EISEN, position: [0, 0.63, 0] },
    { geometry: box(0.3, 0.18, 0.24), color: EISEN, position: [0, 0.48, 0] },
    // Das Horn: ohne es ist der Amboss ein Kasten.
    { geometry: cone(0.11, 0.4, 6), color: EISEN, position: [0.48, 0.63, 0], rotation: [0, 0, -Math.PI / 2] },
  ]);
}

/** Die Esse — Feuerstelle mit Rauchfang. Sie steht neben dem Amboss. */
export function baueEsse(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(1.5, 0.9, 1.1), color: STEIN, position: [0, 0.45, 0] },
    { geometry: box(1.3, 0.16, 0.9), color: DUNKELSTEIN, position: [0, 0.95, 0] },
    { geometry: box(0.9, 0.1, 0.7), color: 0x2a1a12, position: [0, 1.02, 0] },
    // Die Glut ist nur Farbe — echtes Licht kostet, siehe Feuerschale.
    { geometry: sphere(0.34, 0), color: 0xff9a3c, position: [0, 1.06, 0], scale: [1.4, 0.3, 1.1] },
    { geometry: cylinder(0.32, 0.5, 2.2, 6), color: DUNKELSTEIN, position: [0, 2.1, -0.3] },
  ]);
}

/** Schleifstein — Rad, Gestell, Kurbel. */
export function baueSchleifstein(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(0.12, 0.7, 0.12), color: DUNKELHOLZ, position: [-0.35, 0.35, 0] },
    { geometry: box(0.12, 0.7, 0.12), color: DUNKELHOLZ, position: [0.35, 0.35, 0] },
    { geometry: box(0.9, 0.1, 0.4), color: HOLZ, position: [0, 0.72, 0] },
    { geometry: cylinder(0.32, 0.32, 0.12, 10), color: 0x8a8880, position: [0, 0.86, 0], rotation: [0, 0, Math.PI / 2] },
    { geometry: box(0.06, 0.06, 0.3), color: EISEN, position: [0.12, 0.86, 0.16] },
  ]);
}

/** Wassertrog aus einem ausgehöhlten Stamm. */
export function baueWassertrog(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(1.8, 0.5, 0.7), color: DUNKELHOLZ, position: [0, 0.3, 0] },
    { geometry: box(1.62, 0.08, 0.52), color: 0x2a4450, position: [0, 0.52, 0] },
    { geometry: box(0.14, 0.34, 0.14), color: DUNKELHOLZ, position: [-0.75, 0.17, 0] },
    { geometry: box(0.14, 0.34, 0.14), color: DUNKELHOLZ, position: [0.75, 0.17, 0] },
  ]);
}

// --- Hausrat ----------------------------------------------------------------

/** Eine Bank. Sie steht an Wegen, an Häusern und um Feuerstellen. */
export function baueBank(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(1.8, 0.09, 0.42), color: HOLZ, position: [0, 0.46, 0] },
    { geometry: box(1.8, 0.32, 0.07), color: HOLZ, position: [0, 0.75, -0.18], rotation: [-0.15, 0, 0] },
    { geometry: box(0.1, 0.46, 0.38), color: DUNKELHOLZ, position: [-0.75, 0.23, 0] },
    { geometry: box(0.1, 0.46, 0.38), color: DUNKELHOLZ, position: [0.75, 0.23, 0] },
  ]);
}

/** Ein runder Tisch mit einem Bein — er passt in jede Ecke. */
export function baueTisch(): THREE.BufferGeometry {
  return assemble([
    { geometry: cylinder(0.62, 0.62, 0.08, 10), color: HOLZ, position: [0, 0.78, 0] },
    { geometry: cylinder(0.12, 0.16, 0.78, 6), color: DUNKELHOLZ, position: [0, 0.39, 0] },
    { geometry: cylinder(0.4, 0.44, 0.08, 8), color: DUNKELHOLZ, position: [0, 0.04, 0] },
  ]);
}

/** Ein Hocker. Drei Beine, weil ein dreibeiniger nie wackelt. */
export function baueHocker(): THREE.BufferGeometry {
  const parts: Part[] = [{ geometry: cylinder(0.26, 0.26, 0.07, 8), color: HOLZ, position: [0, 0.48, 0] }];
  for (let i = 0; i < 3; i++) {
    const w = (i / 3) * Math.PI * 2;
    parts.push({
      geometry: cylinder(0.04, 0.055, 0.48, 5),
      color: DUNKELHOLZ,
      position: [Math.sin(w) * 0.16, 0.24, Math.cos(w) * 0.16],
      rotation: [Math.cos(w) * 0.12, 0, -Math.sin(w) * 0.12],
    });
  }
  return assemble(parts);
}

/** Ein Stapel Säcke — Mehl, Korn, was auch immer. */
export function baueSackstapel(): THREE.BufferGeometry {
  const sack = (x: number, y: number, z: number, s: number, gier: number): Part => ({
    geometry: rundeBox(0.6 * s, 0.5 * s, 0.44 * s, { rund: 0.16 * s, oben: 0.72, seg: 3 }),
    color: 0xc9b48c,
    position: [x, y, z],
    rotation: [0, gier, 0],
  });
  return assemble([
    sack(0, 0.25, 0, 1, 0.2),
    sack(0.55, 0.22, 0.15, 0.9, 1.1),
    sack(0.2, 0.66, 0.08, 0.85, 2.3),
    sack(-0.4, 0.24, -0.25, 0.8, 0.7),
  ]);
}

/** Ein Korb, geflochten. Die Ringe machen ihn zum Korb. */
export function baueKorb(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: cylinder(0.34, 0.24, 0.5, 9), color: 0xb08c56, position: [0, 0.25, 0] },
  ];
  for (const y of [0.1, 0.26, 0.42]) {
    parts.push({
      geometry: cylinder(0.28 + y * 0.14, 0.28 + y * 0.14, 0.04, 9),
      color: 0x8f6f42,
      position: [0, y, 0],
    });
  }
  return assemble(parts);
}

/** Ein Stapel Kisten. Drei übereinander, die oberste verdreht. */
export function baueKistenstapel(): THREE.BufferGeometry {
  const kiste = (x: number, y: number, z: number, s: number, gier: number): Part[] => [
    { geometry: box(0.8 * s, 0.7 * s, 0.8 * s), color: HOLZ, position: [x, y, z], rotation: [0, gier, 0] },
    { geometry: box(0.86 * s, 0.09 * s, 0.09 * s), color: DUNKELHOLZ, position: [x, y + 0.27 * s, z], rotation: [0, gier, 0] },
  ];
  return assemble([
    ...kiste(0, 0.35, 0, 1, 0),
    ...kiste(0.1, 1.03, -0.08, 0.92, 0.4),
    ...kiste(-0.05, 1.62, 0.05, 0.8, 0.9),
  ]);
}

/** Ein Tonkrug. Er steht neben Türen und in Kellern. */
export function baueTonkrug(): THREE.BufferGeometry {
  return assemble([
    { geometry: sphere(0.34, 1), color: 0xa87048, position: [0, 0.42, 0], scale: [1, 1.15, 1] },
    { geometry: cylinder(0.14, 0.2, 0.3, 8), color: 0xa87048, position: [0, 0.85, 0] },
    { geometry: cylinder(0.17, 0.17, 0.06, 8), color: 0x8a5a38, position: [0, 0.99, 0] },
    { geometry: cylinder(0.16, 0.16, 0.05, 8), color: 0x8a5a38, position: [0, 0.06, 0] },
  ]);
}

// --- Licht, Zeichen, Zier ---------------------------------------------------

/** Eine Fackel auf einem Pfahl — kleiner und billiger als die Laterne. */
export function baueFackel(): THREE.BufferGeometry {
  return assemble([
    { geometry: cylinder(0.06, 0.09, 1.9, 6), color: DUNKELHOLZ, position: [0, 0.95, 0] },
    { geometry: cylinder(0.13, 0.09, 0.26, 6), color: EISEN, position: [0, 2.0, 0] },
    { geometry: sphere(0.15, 0), color: 0xff9a3c, position: [0, 2.16, 0], scale: [1, 1.5, 1] },
  ]);
}

/** Eine flache Feuerschale auf drei Beinen. Sie gehört an ein Lagerfeuer. */
export function baueFeuerschale(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: cylinder(0.5, 0.34, 0.24, 10), color: EISEN, position: [0, 0.42, 0] },
    { geometry: sphere(0.36, 0), color: 0xff9a3c, position: [0, 0.5, 0], scale: [1, 0.5, 1] },
  ];
  for (let i = 0; i < 3; i++) {
    const w = (i / 3) * Math.PI * 2;
    parts.push({
      geometry: cylinder(0.04, 0.05, 0.36, 5),
      color: EISEN,
      position: [Math.sin(w) * 0.24, 0.18, Math.cos(w) * 0.24],
      rotation: [Math.cos(w) * 0.35, 0, -Math.sin(w) * 0.35],
    });
  }
  return assemble(parts);
}

/** Ein Fahnenmast mit Wimpel — höher und schlanker als der Bannermast. */
export function baueFahnenmast(): THREE.BufferGeometry {
  return assemble([
    { geometry: cylinder(0.06, 0.12, 4.6, 6), color: 0x9a8a72, position: [0, 2.3, 0] },
    { geometry: cylinder(0.3, 0.34, 0.2, 8), color: DUNKELSTEIN, position: [0, 0.1, 0] },
    { geometry: box(0.05, 0.9, 1.3), color: 0x2f6a8a, position: [0, 4.0, 0.65] },
    { geometry: box(0.06, 0.16, 1.34), color: 0xd8b84a, position: [0, 4.38, 0.67] },
    { geometry: cone(0.1, 0.3, 5), color: 0xd8b84a, position: [0, 4.72, 0] },
  ]);
}

/** Ein Meilenstein — niedrig, mit einer eingeschlagenen Kerbe. */
export function baueMeilenstein(): THREE.BufferGeometry {
  return assemble([
    { geometry: rundeBox(0.44, 0.9, 0.36, { rund: 0.1, oben: 0.86, seg: 2 }), color: STEIN, position: [0, 0.45, 0] },
    { geometry: box(0.3, 0.06, 0.04), color: DUNKELSTEIN, position: [0, 0.66, 0.18] },
    { geometry: box(0.2, 0.06, 0.04), color: DUNKELSTEIN, position: [0, 0.54, 0.18] },
  ]);
}

/** Ein Bildstock — ein Dach über einer Nische. Wegzeichen und Andachtsort. */
export function baueBildstock(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(0.34, 1.9, 0.34), color: STEIN, position: [0, 0.95, 0] },
    { geometry: box(0.56, 0.7, 0.44), color: STEIN, position: [0, 2.2, 0] },
    { geometry: box(0.34, 0.46, 0.1), color: 0x2a2620, position: [0, 2.2, 0.2] },
    { geometry: cone(0.55, 0.4, 4), color: DUNKELSTEIN, position: [0, 2.75, 0], rotation: [0, Math.PI / 4, 0] },
    { geometry: box(0.7, 0.16, 0.6), color: DUNKELSTEIN, position: [0, 0.08, 0] },
  ]);
}

/**
 * Eine Statue auf Sockel.
 *
 * Die Figur ist absichtlich grob: eine Statue soll aus Stein **gehauen**
 * aussehen, und ein sauber modellierter Mensch in Grau sieht aus wie eine
 * Spielfigur, der die Farbe fehlt.
 */
export function baueStatue(): THREE.BufferGeometry {
  const grau = 0x8a8880;
  return assemble([
    { geometry: box(1.3, 0.3, 1.3), color: DUNKELSTEIN, position: [0, 0.15, 0] },
    { geometry: box(1.0, 0.9, 1.0), color: STEIN, position: [0, 0.75, 0] },
    { geometry: box(1.1, 0.14, 1.1), color: DUNKELSTEIN, position: [0, 1.27, 0] },
    { geometry: rundeBox(0.6, 1.3, 0.44, { rund: 0.16, oben: 0.86, unten: 1.05, seg: 3 }), color: grau, position: [0, 1.98, 0] },
    { geometry: sphere(0.24, 1), color: grau, position: [0, 2.78, 0] },
    { geometry: rundeBox(0.16, 0.9, 0.16, { rund: 0.06, seg: 2 }), color: grau, position: [-0.36, 2.1, 0.06], rotation: [0, 0, 0.22] },
    { geometry: rundeBox(0.16, 0.9, 0.16, { rund: 0.06, seg: 2 }), color: grau, position: [0.36, 2.2, 0.1], rotation: [0, 0, -0.5] },
  ]);
}

/** Ein Zierbrunnen: Becken, Säule, Schale. Er gehört auf einen Platz. */
export function baueZierbrunnen(): THREE.BufferGeometry {
  return assemble([
    { geometry: cylinder(1.6, 1.7, 0.6, 12), color: STEIN, position: [0, 0.3, 0] },
    { geometry: cylinder(1.42, 1.42, 0.16, 12), color: 0x2a5060, position: [0, 0.55, 0] },
    { geometry: cylinder(0.26, 0.34, 1.1, 8), color: DUNKELSTEIN, position: [0, 1.1, 0] },
    { geometry: cylinder(0.7, 0.4, 0.24, 10), color: STEIN, position: [0, 1.72, 0] },
    { geometry: cylinder(0.6, 0.6, 0.06, 10), color: 0x2a5060, position: [0, 1.84, 0] },
    { geometry: sphere(0.16, 1), color: STEIN, position: [0, 1.98, 0] },
  ]);
}

/** Ein Torpfosten — er steht paarweise da, wo ein Weg in einen Hof führt. */
export function baueTorpfosten(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(0.5, 2.4, 0.5), color: STEIN, position: [0, 1.2, 0] },
    { geometry: box(0.66, 0.18, 0.66), color: DUNKELSTEIN, position: [0, 2.42, 0] },
    { geometry: cone(0.42, 0.42, 4), color: DUNKELSTEIN, position: [0, 2.7, 0], rotation: [0, Math.PI / 4, 0] },
    { geometry: box(0.62, 0.16, 0.62), color: DUNKELSTEIN, position: [0, 0.08, 0] },
  ]);
}

/** Ein Blumenkasten — Holz, Erde, drei Blüten. Vor Fenstern und an Wegen. */
export function baueBlumenkasten(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: box(1.2, 0.36, 0.4), color: DUNKELHOLZ, position: [0, 0.18, 0] },
    { geometry: box(1.06, 0.08, 0.3), color: 0x3f3025, position: [0, 0.38, 0] },
  ];
  for (const [x, farbe] of [[-0.36, 0xd85a5a], [0, 0xe8c85a], [0.36, 0x9a7fd8]] as Array<[number, number]>) {
    parts.push({ geometry: box(0.04, 0.22, 0.04), color: 0x4d8639, position: [x, 0.5, 0] });
    parts.push({ geometry: sphere(0.11, 0), color: farbe, position: [x, 0.64, 0], scale: [1, 0.8, 1] });
  }
  return assemble(parts);
}

/** Ein Bienenkorb aus Stroh. */
export function baueBienenkorb(): THREE.BufferGeometry {
  const parts: Part[] = [];
  for (let i = 0; i < 5; i++) {
    const r = 0.42 - i * 0.07;
    parts.push({
      geometry: cylinder(r * 0.92, r, 0.16, 9),
      color: i % 2 === 0 ? 0xc9a94f : 0xb89742,
      position: [0, 0.08 + i * 0.16, 0],
    });
  }
  parts.push({ geometry: sphere(0.14, 1), color: 0xc9a94f, position: [0, 0.9, 0] });
  parts.push({ geometry: box(0.14, 0.1, 0.06), color: 0x2a2018, position: [0, 0.16, 0.4] });
  return assemble(parts);
}

/** Ein Taubenschlag auf einem Pfahl. */
export function baueTaubenschlag(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: box(0.16, 2.4, 0.16), color: DUNKELHOLZ, position: [0, 1.2, 0] },
    { geometry: box(0.9, 0.8, 0.9), color: HOLZ, position: [0, 2.8, 0] },
    { geometry: box(1.1, 0.1, 1.1), color: DUNKELHOLZ, position: [0, 2.42, 0] },
    { geometry: cone(0.85, 0.5, 4), color: 0x8a4a34, position: [0, 3.42, 0], rotation: [0, Math.PI / 4, 0] },
  ];
  for (const [x, z] of [[0, 0.46], [0.46, 0], [0, -0.46], [-0.46, 0]] as Array<[number, number]>) {
    parts.push({ geometry: box(0.18, 0.2, 0.06), color: 0x2a2018, position: [x, 2.9, z], rotation: [0, x === 0 ? 0 : Math.PI / 2, 0] });
  }
  return assemble(parts);
}

/** Ein Hühnerstall — niedrig, mit Klappe und Pultdach. */
export function baueHuehnerstall(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(1.6, 0.9, 1.1), color: HOLZ, position: [0, 0.45, 0] },
    { geometry: box(1.8, 0.09, 1.3), color: 0x8a4a34, position: [0, 0.98, 0], rotation: [-0.18, 0, 0] },
    { geometry: box(0.4, 0.5, 0.06), color: 0x2a2018, position: [0.3, 0.25, 0.56] },
    { geometry: box(0.6, 0.06, 0.4), color: DUNKELHOLZ, position: [0.3, 0.06, 0.85], rotation: [0.25, 0, 0] },
    { geometry: box(0.09, 0.5, 0.09), color: DUNKELHOLZ, position: [-0.7, 0.25, 0.5] },
  ]);
}

/** Eine Wäscheleine zwischen zwei Pfählen. Nichts sagt „bewohnt" schneller. */
export function baueWaescheleine(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: box(0.1, 2.0, 0.1), color: DUNKELHOLZ, position: [-1.8, 1.0, 0] },
    { geometry: box(0.1, 2.0, 0.1), color: DUNKELHOLZ, position: [1.8, 1.0, 0] },
    { geometry: box(3.6, 0.035, 0.035), color: 0x9a8a72, position: [0, 1.9, 0] },
  ];
  const tuecher: Array<[number, number, number, number]> = [
    [-1.1, 0.6, 0.5, 0xd8d0c0],
    [-0.3, 0.5, 0.42, 0x8fa8d8],
    [0.5, 0.65, 0.55, 0xc9a97f],
    [1.2, 0.45, 0.38, 0xa8c09a],
  ];
  for (const [x, h, b, farbe] of tuecher) {
    parts.push({ geometry: box(b, h, 0.03), color: farbe, position: [x, 1.9 - h * 0.5, 0] });
  }
  return assemble(parts);
}

/** Ein Pflug. Er steht am Feldrand, wenn niemand pflügt. */
export function bauePflug(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(1.6, 0.1, 0.1), color: DUNKELHOLZ, position: [0, 0.5, 0], rotation: [0, 0, 0.22] },
    { geometry: box(0.1, 0.7, 0.1), color: DUNKELHOLZ, position: [-0.6, 0.35, 0], rotation: [0, 0, -0.15] },
    { geometry: cone(0.22, 0.6, 5), color: 0x9aa3ad, position: [-0.75, 0.16, 0], rotation: [0, 0, 1.9] },
    { geometry: box(0.9, 0.07, 0.07), color: HOLZ, position: [0.75, 0.95, 0.12], rotation: [0, 0, 0.5] },
    { geometry: box(0.9, 0.07, 0.07), color: HOLZ, position: [0.75, 0.95, -0.12], rotation: [0, 0, 0.5] },
    { geometry: cylinder(0.3, 0.3, 0.08, 8), color: DUNKELHOLZ, position: [0.5, 0.3, 0], rotation: [Math.PI / 2, 0, 0] },
  ]);
}

// --- Wasser -----------------------------------------------------------------

/**
 * Ein Steg über dem Wasser.
 *
 * Die Pfosten sitzen an den **Enden**, damit sich Felder aneinanderreihen —
 * dieselbe Regel wie beim Zaun. Vier Meter lang, also passt ein zweiter im
 * Abstand von vier Metern nahtlos daneben.
 */
export function baueSteg(): THREE.BufferGeometry {
  const parts: Part[] = [];
  for (let i = 0; i < 8; i++) {
    parts.push({
      geometry: box(0.44, 0.09, 1.6),
      color: i % 2 === 0 ? HOLZ : 0x7a5a36,
      position: [-1.78 + i * 0.5, 0.5, 0],
    });
  }
  for (const [x, z] of [[-1.9, -0.7], [-1.9, 0.7], [1.9, -0.7], [1.9, 0.7]] as Array<[number, number]>) {
    parts.push({ geometry: cylinder(0.1, 0.12, 1.0, 6), color: DUNKELHOLZ, position: [x, 0.0, z] });
  }
  parts.push({ geometry: box(4.0, 0.08, 0.08), color: DUNKELHOLZ, position: [0, 0.42, -0.72] });
  parts.push({ geometry: box(4.0, 0.08, 0.08), color: DUNKELHOLZ, position: [0, 0.42, 0.72] });
  return assemble(parts);
}

/** Ein Ruderboot. Es liegt am Ufer oder am Steg. */
export function baueRuderboot(): THREE.BufferGeometry {
  const parts: Part[] = [
    // Der Rumpf: eine gerundete Box, vorn und hinten schmaler. Ein Boot aus
    // einer Halbkugel sieht aus wie eine Schale, nicht wie ein Boot.
    { geometry: rundeBox(3.4, 0.7, 1.2, { rund: 0.34, oben: 1.08, unten: 0.5, seg: 3 }), color: DUNKELHOLZ, position: [0, 0.35, 0] },
    { geometry: box(3.0, 0.1, 0.9), color: 0x2a2018, position: [0, 0.62, 0] },
    { geometry: box(0.7, 0.08, 1.0), color: HOLZ, position: [-0.7, 0.56, 0] },
    { geometry: box(0.7, 0.08, 1.0), color: HOLZ, position: [0.8, 0.56, 0] },
    { geometry: box(1.9, 0.06, 0.09), color: 0x9a7a4a, position: [0.2, 0.6, 0.3], rotation: [0, 0.12, 0] },
    { geometry: box(0.3, 0.05, 0.18), color: 0x9a7a4a, position: [1.2, 0.6, 0.42] },
  ];
  return assemble(parts);
}

/** Ein Gestell mit trocknenden Fischen. Es riecht förmlich. */
export function baueFischgestell(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: box(0.1, 1.8, 0.1), color: DUNKELHOLZ, position: [-1.0, 0.9, 0] },
    { geometry: box(0.1, 1.8, 0.1), color: DUNKELHOLZ, position: [1.0, 0.9, 0] },
    { geometry: box(2.2, 0.08, 0.08), color: DUNKELHOLZ, position: [0, 1.72, 0] },
    { geometry: box(2.2, 0.08, 0.08), color: DUNKELHOLZ, position: [0, 1.2, 0] },
  ];
  for (let i = 0; i < 6; i++) {
    const x = -0.8 + i * 0.32;
    const oben = i % 2 === 0;
    parts.push({
      geometry: rundeBox(0.14, 0.42, 0.07, { rund: 0.05, oben: 0.5, unten: 0.7, seg: 2 }),
      color: 0x9aa39a,
      position: [x, (oben ? 1.72 : 1.2) - 0.24, 0],
    });
  }
  return assemble(parts);
}

/** Ein Fischernetz, aufgehängt. Die Maschen sind gemalt — als Gitter aus Balken. */
export function baueFischernetz(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: box(0.1, 1.9, 0.1), color: DUNKELHOLZ, position: [-1.1, 0.95, 0] },
    { geometry: box(0.1, 1.9, 0.1), color: DUNKELHOLZ, position: [1.1, 0.95, 0] },
    { geometry: box(2.3, 0.07, 0.07), color: DUNKELHOLZ, position: [0, 1.85, 0] },
  ];
  const netz = 0xb0a888;
  for (let i = 0; i < 9; i++) {
    parts.push({ geometry: box(0.03, 1.2, 0.03), color: netz, position: [-1.0 + i * 0.25, 1.24, 0] });
  }
  for (let i = 0; i < 5; i++) {
    parts.push({ geometry: box(2.05, 0.03, 0.03), color: netz, position: [0, 0.7 + i * 0.28, 0] });
  }
  return assemble(parts);
}
