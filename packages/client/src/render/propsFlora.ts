/**
 * Bewuchs — alles, was wächst.
 *
 * Die Regel für diese Datei ist dieselbe, die schon den Busch gerettet hat:
 * **eine Pflanze hat Lücken, und Lücken kann ein Dreieck nicht.** Alles, was
 * Blätter, Halme oder Blüten hat, entsteht deshalb aus gekreuzten Karten mit
 * der Laubtextur (`laub.ts`) — die Silhouette kommt aus dem Bild. Aus Körpern
 * gebaut sind hier nur die Dinge, die tatsächlich massiv sind: Stämme,
 * Wurzeln, Pilze.
 *
 * Zwei Zahlen entscheiden über den Eindruck mehr als alle anderen:
 *
 * - **Die Karten stehen nicht alle senkrecht.** Ein Kranz aus senkrechten
 *   Karten sieht von oben aus wie ein Stern. Zwei geneigte schliessen die
 *   Sicht von oben, ohne dass es mehr Karten braucht.
 * - **Die Farben sind ungleich.** Drei Karten in einem Grün ergeben eine
 *   Fläche; drei in drei Grüntönen ergeben eine Pflanze. Die Textur ist fast
 *   farblos gezeichnet, also kostet das nichts.
 *
 * Der Ursprung liegt immer **am Boden** (y = 0). `snapToGround` in der Karte
 * setzt das Prop auf das Höhenfeld, und ein Modell, dessen Mitte im Ursprung
 * liegt, steckt danach zur Hälfte darin.
 */

import * as THREE from 'three';
import { assemble, box, cylinder, fuegeZusammen, sphere, type Part } from './geometry.ts';
import { laubKarte, laubNormalen, type LaubKachel } from './laub.ts';

const HOLZ = 0x6b4f34;
const TOTHOLZ = 0x5c5245;

interface Karte {
  kachel: LaubKachel;
  b: number;
  h: number;
  x?: number;
  y?: number;
  z?: number;
  gier?: number;
  kipp?: number;
  /**
   * Liegt die Karte flach auf dem Boden?
   *
   * Nicht dasselbe wie `kipp: π/2`, und der Unterschied hat einen Grund: die
   * Drehreihenfolge ist XYZ, also wirkt die Gierung **vor** der Kippung. Eine
   * gegierte Karte, die man danach umlegt, taucht mit einer Ecke unter den
   * Boden — bei einer Efeudecke von 1,4 m Breite fast einen halben Meter. Die
   * flache Karte dreht deshalb um Z (das wirkt zuerst) und kippt danach um X.
   */
  flach?: boolean;
  farbe: number;
}

/**
 * Baut eine Pflanze aus Laubkarten.
 *
 * `mitte` ist die Höhe, von der aus die Normalen nach aussen gezogen werden —
 * ungefähr der Schwerpunkt des Bewuchses. Steht sie auf null, ist die
 * Oberseite eines flachen Büschels seitwärts beleuchtet und damit dunkel.
 */
function pflanze(karten: Karte[], mitte: number, extra: Part[] = []): THREE.BufferGeometry {
  const parts: Part[] = karten.map((k) => ({
    geometry: laubKarte(k.kachel, k.b, k.h),
    color: k.farbe,
    position: [k.x ?? 0, k.y ?? 0, k.z ?? 0],
    rotation: k.flach ? [Math.PI / 2, 0, k.gier ?? 0] : [k.kipp ?? 0, k.gier ?? 0, 0],
  }));
  const laub = assemble(parts);
  laubNormalen(laub, mitte);
  if (extra.length === 0) return laub;
  /*
   * Feste Teile — Stiele, Kolben, Beeren — kommen **nach** dem Ziehen der
   * Normalen dazu, und über `fuegeZusammen` statt über `assemble`.
   *
   * `assemble` färbt jedes Teil neu ein und würde die Blattfarben mit einem
   * einzigen Wert überschreiben; und die Normalen des Stiels dürfen nicht von
   * der Pflanzenmitte wegzeigen, sonst leuchtet er auf der Schattenseite.
   */
  const rest = assemble(extra);
  const zusammen = fuegeZusammen([laub, rest]);
  laub.dispose();
  rest.dispose();
  return zusammen;
}

/** Ein Ring gleichartiger Karten, im Kreis gedreht. */
function kranz(
  kachel: LaubKachel,
  anzahl: number,
  b: number,
  h: number,
  farben: number[],
  kipp = 0,
): Karte[] {
  return Array.from({ length: anzahl }, (_, i) => ({
    kachel,
    b: b * (1 - (i % 3) * 0.08),
    h: h * (1 - (i % 2) * 0.1),
    y: i * 0.01,
    gier: (i / anzahl) * Math.PI * 2 + i * 0.17,
    kipp: i % 3 === 2 ? kipp : 0,
    farbe: farben[i % farben.length]!,
  }));
}

// --- Kraut und Gras ---------------------------------------------------------

export function baueFarn(): THREE.BufferGeometry {
  return pflanze(
    [
      ...kranz('farn', 5, 1.15, 0.85, [0x4f8a3e, 0x5f9a4a, 0x437a36], 0.45),
      { kachel: 'farn', b: 0.9, h: 0.7, y: 0.3, gier: 0.6, kipp: 1.2, farbe: 0x6aa855 },
    ],
    0.4,
  );
}

/** Schilf: hoch, schmal, viele Karten. Es steht im Wasser und am Ufer. */
export function baueSchilf(): THREE.BufferGeometry {
  return pflanze(kranz('gras', 7, 0.55, 1.9, [0x7a9a4a, 0x8aa855, 0x6a8a3e], 0.2), 0.9);
}

/** Rohrkolben — Schilf mit braunen Kolben, damit das Ufer einen Punkt hat. */
export function baueRohrkolben(): THREE.BufferGeometry {
  const kolben: Part[] = [];
  for (const [x, z, y] of [
    [0.1, 0.06, 1.5],
    [-0.14, -0.08, 1.72],
    [0.02, -0.16, 1.32],
  ] as Array<[number, number, number]>) {
    kolben.push({ geometry: cylinder(0.055, 0.045, 0.34, 5), color: 0x6b4a2c, position: [x, y, z] });
    kolben.push({ geometry: box(0.02, 0.5, 0.02), color: 0x6a8a3e, position: [x, y - 0.4, z] });
  }
  return pflanze(kranz('gras', 6, 0.5, 1.7, [0x6f924a, 0x7ea052, 0x5f8240], 0.15), 0.85, kolben);
}

/** Seerose — flach auf dem Wasser, deshalb liegende Karten und kein Halm. */
export function baueSeerose(): THREE.BufferGeometry {
  return pflanze(
    [
      { kachel: 'blatt', b: 1.0, h: 0.9, y: 0.04, gier: 0.2, flach: true, farbe: 0x3f7a3a },
      { kachel: 'blatt', b: 0.8, h: 0.72, x: 0.4, y: 0.05, z: 0.25, gier: 1.9, flach: true, farbe: 0x4a8a42 },
      { kachel: 'bluete', b: 0.42, h: 0.38, x: -0.2, y: 0.06, z: -0.25, gier: 0.8, flach: true, farbe: 0xe8d0e0 },
    ],
    0.05,
  );
}

/**
 * Blumen in drei Farben.
 *
 * Drei Schlüssel und nicht einer mit `tint`: eine Wiese soll gemischt sein,
 * und der Streuer wählt je Prop aus einer Liste von Modellen — mit einem
 * einzigen Modell bekäme jede Karte eine Farbe, oder der Generator müsste je
 * Blume einen Farbwert würfeln und ihn in tausend Zeilen schreiben.
 */
function blume(bluete: number, blatt: number): THREE.BufferGeometry {
  return pflanze(
    [
      ...kranz('gras', 3, 0.5, 0.4, [blatt, blatt], 0.2),
      { kachel: 'bluete', b: 0.44, h: 0.4, y: 0.22, gier: 0.4, farbe: bluete },
      { kachel: 'bluete', b: 0.36, h: 0.32, x: 0.14, y: 0.14, z: 0.1, gier: 2.3, farbe: bluete },
      { kachel: 'bluete', b: 0.3, h: 0.28, x: -0.16, y: 0.1, z: -0.08, gier: 1.2, farbe: bluete },
    ],
    0.25,
  );
}

export const baueBlumeWeiss = (): THREE.BufferGeometry => blume(0xf2ece0, 0x6f9a4a);
export const baueBlumeGelb = (): THREE.BufferGeometry => blume(0xe8c85a, 0x7aa452);
export const baueBlumeBlau = (): THREE.BufferGeometry => blume(0x8fa8e0, 0x628f45);

/** Klee — flach, breit, deckt Boden. */
export function baueKlee(): THREE.BufferGeometry {
  return pflanze(
    [
      { kachel: 'blatt', b: 0.9, h: 0.8, y: 0.02, gier: 0.3, flach: true, farbe: 0x5f9a4a },
      { kachel: 'blatt', b: 0.75, h: 0.65, x: 0.3, y: 0.04, z: -0.2, gier: 1.7, flach: true, farbe: 0x6aa855 },
      { kachel: 'blatt', b: 0.6, h: 0.55, x: -0.3, y: 0.03, z: 0.25, gier: 2.8, flach: true, farbe: 0x538c3e },
    ],
    0.06,
  );
}

/** Distel — namensgebend für den Distelkeiler, und stachlig genug dafür. */
export function baueDistel(): THREE.BufferGeometry {
  return pflanze(
    [
      ...kranz('farn', 4, 0.62, 0.72, [0x5f7a45, 0x6d8a4e], 0.3),
      { kachel: 'bluete', b: 0.3, h: 0.28, y: 0.62, gier: 0.5, farbe: 0xa87fc0 },
      { kachel: 'bluete', b: 0.24, h: 0.22, x: 0.18, y: 0.48, z: 0.12, gier: 2.1, farbe: 0x9a72b4 },
    ],
    0.35,
  );
}

/** Dornbusch — dunkel, dicht, mit sichtbaren Ranken. Das Wappen von Dornwald. */
export function baueDornbusch(): THREE.BufferGeometry {
  const ranken: Part[] = [];
  for (let i = 0; i < 5; i++) {
    const gier = (i / 5) * Math.PI * 2;
    ranken.push({
      geometry: cylinder(0.015, 0.035, 1.1, 4),
      color: 0x3f3428,
      position: [Math.sin(gier) * 0.22, 0.5, Math.cos(gier) * 0.22],
      rotation: [Math.cos(gier) * 0.5, 0, -Math.sin(gier) * 0.5],
    });
  }
  return pflanze(kranz('blatt', 6, 1.0, 0.85, [0x3a5c30, 0x2f4c28, 0x456a36], 1.1), 0.45, ranken);
}

/** Brombeerranke — flach und breit, sie zieht sich über den Boden. */
export function baueBrombeere(): THREE.BufferGeometry {
  const beeren: Part[] = [];
  for (const [x, y, z] of [
    [0.3, 0.42, 0.18],
    [-0.25, 0.34, -0.3],
    [0.1, 0.5, -0.22],
  ] as Array<[number, number, number]>) {
    beeren.push({ geometry: sphere(0.07, 0), color: 0x3a2440, position: [x, y, z] });
  }
  return pflanze(
    [
      ...kranz('blatt', 5, 1.3, 0.6, [0x3f6a34, 0x4c7a3c, 0x35592c], 1.3),
      { kachel: 'blatt', b: 1.0, h: 0.5, y: 0.5, gier: 1.0, kipp: 1.4, farbe: 0x4a7638 },
    ],
    0.3,
    beeren,
  );
}

/** Beerenbusch — dasselbe in freundlich: rote Punkte, hellere Blätter. */
export function baueBeerenbusch(): THREE.BufferGeometry {
  const beeren: Part[] = [];
  for (let i = 0; i < 7; i++) {
    const gier = i * 1.3;
    beeren.push({
      geometry: sphere(0.06, 0),
      color: 0xb03a34,
      position: [Math.sin(gier) * 0.36, 0.35 + (i % 3) * 0.18, Math.cos(gier) * 0.36],
    });
  }
  return pflanze(kranz('blatt', 5, 1.0, 0.8, [0x5d9a4a, 0x69a852, 0x4d8639], 0.9), 0.4, beeren);
}

/** Heidekraut — niedrig, violett, für karge Flächen im Norden. */
export function baueHeidekraut(): THREE.BufferGeometry {
  return pflanze(
    [
      ...kranz('gras', 4, 0.7, 0.4, [0x6a7a48, 0x77854f], 0.4),
      { kachel: 'bluete', b: 0.5, h: 0.3, y: 0.24, gier: 0.9, kipp: 0.6, farbe: 0x9c7aa8 },
      { kachel: 'bluete', b: 0.42, h: 0.26, x: 0.2, y: 0.2, z: 0.16, gier: 2.5, kipp: 0.5, farbe: 0x8a6a98 },
    ],
    0.2,
  );
}

/** Hohes Gras — dasselbe wie der Grasbüschel, aber kniehoch. */
export function baueHochgras(): THREE.BufferGeometry {
  return pflanze(kranz('gras', 5, 0.85, 1.15, [0x84c264, 0x6faa50, 0x8ecb6b], 0.25), 0.55);
}

/** Getreide — Halme mit hellen Ähren, für Felder um die Stadt. */
export function baueGetreide(): THREE.BufferGeometry {
  return pflanze(kranz('gras', 5, 0.6, 1.25, [0xc9b45f, 0xd8c46a, 0xb8a252], 0.12), 0.65);
}

/** Ein Setzling: ein dünner Stamm und drei Karten. Wald von morgen. */
export function baueSetzling(): THREE.BufferGeometry {
  const stamm: Part[] = [
    { geometry: cylinder(0.04, 0.07, 1.1, 5), color: HOLZ, position: [0, 0.55, 0] },
  ];
  return pflanze(
    [
      { kachel: 'blatt', b: 0.85, h: 0.7, y: 0.75, gier: 0.3, farbe: 0x6aa855 },
      { kachel: 'blatt', b: 0.75, h: 0.62, y: 0.85, gier: 1.4, farbe: 0x5d9a4a },
      { kachel: 'blatt', b: 0.7, h: 0.6, y: 0.7, gier: 2.5, kipp: 0.9, farbe: 0x74b45e },
    ],
    1.0,
    stamm,
  );
}

/** Efeu — eine flache Decke, die man über Mauerreste und Stümpfe legt. */
export function baueEfeu(): THREE.BufferGeometry {
  return pflanze(
    [
      { kachel: 'blatt', b: 1.4, h: 1.2, y: 0.03, gier: 0.1, flach: true, farbe: 0x3f6a34 },
      { kachel: 'blatt', b: 1.1, h: 0.95, x: 0.5, y: 0.06, z: 0.4, gier: 1.6, flach: true, farbe: 0x4a7a3c },
      { kachel: 'blatt', b: 0.9, h: 0.8, x: -0.55, y: 0.05, z: -0.3, gier: 2.9, flach: true, farbe: 0x35592c },
    ],
    0.08,
  );
}

// --- Holz und Pilze (massiv) ------------------------------------------------

/**
 * Ein liegender Stamm.
 *
 * Er liegt entlang **X**, damit die Drehung um Y in der Karte ihn ausrichtet.
 * Läge er entlang Z, zeigte er bei `rotation: 0` in Blickrichtung — und alle
 * gestreuten Stämme lägen parallel zur Kamera.
 */
export function baueBaumstammLiegend(): THREE.BufferGeometry {
  const parts: Part[] = [
    {
      geometry: cylinder(0.34, 0.4, 4.2, 8),
      color: HOLZ,
      position: [0, 0.38, 0],
      rotation: [0, 0, Math.PI / 2],
    },
    { geometry: cylinder(0.36, 0.36, 0.06, 8), color: 0xa87f52, position: [2.1, 0.38, 0], rotation: [0, 0, Math.PI / 2] },
    // Zwei Aststummel: ein glatter Stamm ist ein Rohr.
    { geometry: cylinder(0.06, 0.1, 0.7, 5), color: HOLZ, position: [-0.6, 0.6, 0.3], rotation: [0.9, 0.4, 0] },
    { geometry: cylinder(0.05, 0.09, 0.5, 5), color: HOLZ, position: [1.1, 0.55, -0.3], rotation: [-1.1, 0, 0.3] },
  ];
  return assemble(parts);
}

/** Wurzelstock — ein umgestürzter Stamm von der Wurzelseite her. */
export function baueWurzelstock(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: cylinder(0.5, 0.62, 0.5, 9), color: HOLZ, position: [0, 0.25, 0], rotation: [1.35, 0, 0] },
  ];
  for (let i = 0; i < 7; i++) {
    const w = (i / 7) * Math.PI * 2;
    parts.push({
      geometry: cylinder(0.04, 0.11, 0.7 + (i % 3) * 0.2, 5),
      color: 0x5a442e,
      position: [Math.sin(w) * 0.45, 0.68 + (i % 2) * 0.2, Math.cos(w) * 0.2],
      rotation: [Math.cos(w) * 0.7, w, -Math.sin(w) * 0.9],
    });
  }
  return assemble(parts);
}

/** Hohler Stumpf — ein Stumpf mit Loch. Er ist ein Versteck und ein Blickfang. */
export function baueHohlerStumpf(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: cylinder(0.46, 0.55, 1.15, 9), color: HOLZ, position: [0, 0.58, 0] },
    // Der „Hohlraum" ist eine dunkle Scheibe innen — ein echtes Loch wären
    // doppelt so viele Dreiecke für einen Schatten, den das Auge ohnehin ergänzt.
    { geometry: cylinder(0.36, 0.36, 0.1, 9), color: 0x241b12, position: [0, 1.12, 0] },
    { geometry: cylinder(0.2, 0.3, 0.7, 6), color: HOLZ, position: [0.42, 1.35, -0.1], rotation: [0.2, 0, 0.5] },
  ];
  return assemble(parts);
}

/** Astbruch — abgebrochene Äste, die kreuz und quer liegen. */
export function baueAstbruch(): THREE.BufferGeometry {
  const parts: Part[] = [];
  const aeste = [
    { x: 0, z: 0, y: 0.12, gier: 0.2, len: 2.6, r: 0.09 },
    { x: 0.3, z: 0.4, y: 0.26, gier: 1.1, len: 2.0, r: 0.07 },
    { x: -0.4, z: 0.2, y: 0.1, gier: 2.4, len: 1.6, r: 0.06 },
    { x: 0.1, z: -0.5, y: 0.34, gier: 0.7, len: 1.3, r: 0.05 },
  ];
  for (const a of aeste) {
    parts.push({
      geometry: cylinder(a.r * 0.7, a.r, a.len, 5),
      color: TOTHOLZ,
      position: [a.x, a.y, a.z],
      rotation: [0, a.gier, Math.PI / 2],
    });
  }
  return assemble(parts);
}

/** Baumpilz — Konsolen an einem Stamm. Gehört an Totholz und an Stümpfe. */
export function baueBaumpilz(): THREE.BufferGeometry {
  const parts: Part[] = [];
  for (const [y, r, gier] of [
    [0.35, 0.34, 0.0],
    [0.62, 0.26, 1.2],
    [0.5, 0.2, 2.6],
  ] as Array<[number, number, number]>) {
    parts.push({
      geometry: cylinder(r, r * 0.75, 0.09, 7),
      color: 0xbfa878,
      position: [Math.sin(gier) * r * 0.5, y, Math.cos(gier) * r * 0.5],
      rotation: [Math.cos(gier) * 0.2, 0, -Math.sin(gier) * 0.2],
      scale: [1, 1, 0.7],
    });
  }
  return assemble(parts);
}

/**
 * Leuchtpilz.
 *
 * Die Farbe leuchtet nicht wirklich — das Material ist Lambert, und echte
 * Lichter kosten. Ein sehr heller, kalter Farbwert wirkt im Dunkel der Gruft
 * trotzdem wie Glut, weil ringsum alles dunkel ist. Genau dasselbe macht die
 * Glut in der Feuerschale.
 */
export function baueLeuchtpilz(): THREE.BufferGeometry {
  const parts: Part[] = [];
  for (const [x, z, h, r] of [
    [0, 0, 0.75, 0.3],
    [0.32, 0.18, 0.5, 0.2],
    [-0.26, 0.24, 0.38, 0.16],
  ] as Array<[number, number, number, number]>) {
    parts.push({ geometry: cylinder(r * 0.3, r * 0.42, h, 6), color: 0xd8e8ea, position: [x, h * 0.5, z] });
    parts.push({
      geometry: sphere(r, 1),
      color: 0x8feaf0,
      position: [x, h + r * 0.15, z],
      scale: [1, 0.62, 1],
    });
  }
  return assemble(parts);
}

/** Ein Ring kleiner Pilze — der klassische Hexenring. */
export function bauePilzring(): THREE.BufferGeometry {
  const parts: Part[] = [];
  for (let i = 0; i < 8; i++) {
    const w = (i / 8) * Math.PI * 2 + 0.3;
    const r = 0.75 + (i % 3) * 0.08;
    const h = 0.22 + (i % 4) * 0.05;
    parts.push({
      geometry: cylinder(0.035, 0.05, h, 5),
      color: 0xdcd2ba,
      position: [Math.sin(w) * r, h * 0.5, Math.cos(w) * r],
    });
    parts.push({
      geometry: sphere(0.11, 0),
      color: i % 2 === 0 ? 0xa8452f : 0xc06a3a,
      position: [Math.sin(w) * r, h + 0.03, Math.cos(w) * r],
      scale: [1, 0.6, 1],
    });
  }
  return assemble(parts);
}
