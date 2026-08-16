/**
 * Lager, Ruine, Gruft — was niemand mehr pflegt.
 *
 * Der Unterschied zur Siedlung ist keiner der Formen, sondern einer der
 * **Ordnung**: dort steht alles gerade und vollständig, hier steht es schief,
 * halb, umgefallen. Deshalb tragen fast alle Teile hier eine Neigung, und die
 * Zäune sind Stückwerk. Ein Banditenlager mit einem sauber geschlossenen Zaun
 * sieht aus wie ein Bauernhof.
 *
 * Zwei Dinge, an denen frühere Versuche gescheitert sind:
 *
 * - **Ein Skelett ist kein Modell, sondern eine Andeutung.** Ein anatomisch
 *   gebauter Schädel bei dieser Grösse ist ein Klumpen mit zwei Dellen. Was
 *   trägt, sind die zwei dunklen Augenhöhlen — der Rest darf grob sein.
 * - **Was in der Gruft leuchten soll, leuchtet nicht.** Das Material ist
 *   Lambert, echte Lichter kosten. Ein sehr heller, kalter Farbwert wirkt im
 *   Dunkeln trotzdem wie Glut, weil ringsum alles dunkel ist.
 */

import * as THREE from 'three';
import { assemble, box, cone, cylinder, rundeBox, sphere, type Part } from './geometry.ts';

const HOLZ = 0x8a6a42;
const DUNKELHOLZ = 0x6b4f34;
const TOTHOLZ = 0x5c5245;
const STEIN = 0x7d7a70;
const DUNKELSTEIN = 0x4a4a52;
const ALTSTEIN = 0x5f5c56;
const EISEN = 0x3a3a40;
const KNOCHEN = 0xd8d0bc;

// --- Lager ------------------------------------------------------------------

/** Ein Lagerfeuer: Steinkranz, Scheite, Glut. */
export function baueLagerfeuer(): THREE.BufferGeometry {
  const parts: Part[] = [];
  for (let i = 0; i < 8; i++) {
    const w = (i / 8) * Math.PI * 2;
    parts.push({
      geometry: sphere(0.16 + (i % 3) * 0.03, 0),
      color: i % 2 === 0 ? 0x6a6862 : 0x55534e,
      position: [Math.sin(w) * 0.72, 0.1, Math.cos(w) * 0.72],
      scale: [1, 0.7, 1],
    });
  }
  // Die Scheite liegen im Kegel gegeneinander — flach hingelegt sähe es aus
  // wie Abfall und nicht wie ein Feuer.
  for (let i = 0; i < 5; i++) {
    const w = (i / 5) * Math.PI * 2 + 0.4;
    parts.push({
      geometry: cylinder(0.06, 0.08, 0.9, 5),
      color: 0x3f3025,
      position: [Math.sin(w) * 0.2, 0.32, Math.cos(w) * 0.2],
      rotation: [Math.cos(w) * 0.6, 0, -Math.sin(w) * 0.6],
    });
  }
  parts.push({ geometry: sphere(0.34, 0), color: 0xff9a3c, position: [0, 0.16, 0], scale: [1, 0.55, 1] });
  return assemble(parts);
}

/** Ein Zelt aus Segeltuch — zwei Flächen, eine Firststange, eine Klappe. */
export function baueZelt(): THREE.BufferGeometry {
  const tuch = 0xa8a086;
  /*
   * Die Traufe liegt **auf dem Boden**, nicht zwanzig Zentimeter darüber:
   * beim ersten Anlauf schwebte das Zelt, und aus zehn Metern sah man einen
   * hellen Streifen darunter durchscheinen.
   *
   * Und hinten sitzt eine Wand. Ohne sie schaut man von jeder Seite durch das
   * Zelt hindurch — das ist dann ein Sonnendach und kein Zelt.
   */
  return assemble([
    { geometry: box(2.6, 0.09, 1.9), color: tuch, position: [0, 0.63, -0.62], rotation: [-0.72, 0, 0] },
    { geometry: box(2.6, 0.09, 1.9), color: 0x8f886f, position: [0, 0.63, 0.62], rotation: [0.72, 0, 0] },
    { geometry: rundeBox(1.75, 1.3, 0.07, { oben: 0.06, rund: 0.05, seg: 2 }), color: 0x9a927a, position: [1.2, 0.65, 0] },
    { geometry: box(0.08, 0.08, 2.8), color: DUNKELHOLZ, position: [0, 1.4, 0] },
    { geometry: box(0.09, 1.45, 0.09), color: DUNKELHOLZ, position: [-1.25, 0.72, 0] },
    { geometry: box(0.09, 1.45, 0.09), color: DUNKELHOLZ, position: [1.25, 0.72, 0] },
    // Die aufgeschlagene Klappe: sie macht aus dem Dreieck ein Zelt, in das
    // jemand hineingeht.
    { geometry: box(0.06, 1.25, 0.9), color: 0x7a745e, position: [-1.32, 0.62, 0.5], rotation: [0, 0.5, 0] },
  ]);
}

/** Eine Schlafrolle. Sie liegt neben dem Feuer und sagt: hier wird geschlafen. */
export function baueSchlafrolle(): THREE.BufferGeometry {
  return assemble([
    { geometry: rundeBox(1.9, 0.24, 0.8, { rund: 0.12, seg: 2 }), color: 0x8a7a5e, position: [0, 0.12, 0] },
    { geometry: cylinder(0.2, 0.2, 0.7, 8), color: 0xa89878, position: [-0.7, 0.2, 0], rotation: [Math.PI / 2, 0, 0] },
    { geometry: box(0.8, 0.1, 0.7), color: 0x6a5a44, position: [0.45, 0.24, 0] },
  ]);
}

/** Ein Bratspiess über dem Feuer — zwei Gabeln und eine Stange. */
export function baueBratspiess(): THREE.BufferGeometry {
  return assemble([
    { geometry: cylinder(0.05, 0.06, 1.3, 5), color: DUNKELHOLZ, position: [-0.8, 0.65, 0], rotation: [0, 0, 0.16] },
    { geometry: cylinder(0.05, 0.06, 1.3, 5), color: DUNKELHOLZ, position: [0.8, 0.65, 0], rotation: [0, 0, -0.16] },
    { geometry: box(2.0, 0.045, 0.045), color: EISEN, position: [0, 1.24, 0] },
    { geometry: rundeBox(0.5, 0.34, 0.34, { rund: 0.14, seg: 3 }), color: 0x8a5a3a, position: [0, 1.24, 0] },
  ]);
}

/** Ein Waffenständer mit drei Speeren. */
export function baueWaffenstaender(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: box(1.4, 0.12, 0.4), color: DUNKELHOLZ, position: [0, 0.06, 0] },
    { geometry: box(0.1, 1.2, 0.1), color: DUNKELHOLZ, position: [-0.62, 0.6, 0] },
    { geometry: box(0.1, 1.2, 0.1), color: DUNKELHOLZ, position: [0.62, 0.6, 0] },
    { geometry: box(1.34, 0.08, 0.08), color: DUNKELHOLZ, position: [0, 1.14, 0] },
  ];
  for (let i = 0; i < 3; i++) {
    const x = -0.4 + i * 0.4;
    parts.push({ geometry: cylinder(0.03, 0.035, 2.1, 5), color: 0x9a7a4a, position: [x, 1.05, 0.06], rotation: [0.06, 0, i * 0.04 - 0.04] });
    parts.push({ geometry: cone(0.07, 0.26, 5), color: 0x9aa3ad, position: [x, 2.2, 0.06] });
  }
  return assemble(parts);
}

/**
 * Ein Palisadenfeld.
 *
 * Wie das Zaunfeld zwei Meter breit und mit den Pfosten an den Enden, damit
 * sich Läufe daraus bauen lassen. Die Spitzen stehen ungleich hoch — eine
 * Palisade aus gleich langen Stämmen sieht aus wie ein Kamm.
 */
export function bauePalisade(): THREE.BufferGeometry {
  const parts: Part[] = [];
  for (let i = 0; i < 9; i++) {
    const h = 2.1 + ((i * 7) % 5) * 0.12;
    const x = -0.9 + i * 0.225;
    parts.push({ geometry: cylinder(0.11, 0.13, h, 6), color: i % 2 === 0 ? DUNKELHOLZ : 0x5a4430, position: [x, h * 0.5, 0] });
    parts.push({ geometry: cone(0.12, 0.28, 6), color: 0x4a3828, position: [x, h + 0.14, 0] });
  }
  parts.push({ geometry: box(2.0, 0.1, 0.07), color: HOLZ, position: [0, 1.5, 0.14] });
  parts.push({ geometry: box(2.0, 0.1, 0.07), color: HOLZ, position: [0, 0.7, 0.14] });
  return assemble(parts);
}

/** Eine spanische Reiterei — gekreuzte Spitzbalken, quer über den Weg. */
export function baueSpitzbarriere(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: box(2.2, 0.12, 0.12), color: DUNKELHOLZ, position: [0, 0.8, 0] },
  ];
  for (const x of [-0.7, 0.1, 0.8]) {
    for (const s of [-1, 1]) {
      parts.push({
        geometry: cylinder(0.05, 0.07, 1.9, 5),
        color: TOTHOLZ,
        position: [x, 0.7, 0],
        rotation: [s * 0.7, 0, s * 0.1],
      });
    }
  }
  return assemble(parts);
}

/** Ein Wachturm aus Holz — vier Beine, eine Plattform, ein Dach. */
export function baueWachturm(): THREE.BufferGeometry {
  const parts: Part[] = [];
  for (const [x, z] of [[-1.1, -1.1], [1.1, -1.1], [-1.1, 1.1], [1.1, 1.1]] as Array<[number, number]>) {
    // Die Beine stehen schräg nach aussen: senkrechte sähen aus wie ein
    // Hochsitz aus dem Baumarkt, und ein Turm muss unten breiter sein.
    parts.push({
      geometry: cylinder(0.13, 0.18, 4.2, 6),
      color: DUNKELHOLZ,
      position: [x * 0.86, 2.1, z * 0.86],
      rotation: [z * 0.05, 0, -x * 0.05],
    });
  }
  parts.push({ geometry: box(2.6, 0.14, 2.6), color: HOLZ, position: [0, 4.2, 0] });
  for (const [x, z, rot] of [[0, -1.24, 0], [0, 1.24, 0], [-1.24, 0, Math.PI / 2], [1.24, 0, Math.PI / 2]] as Array<[number, number, number]>) {
    parts.push({ geometry: box(2.6, 0.7, 0.09), color: HOLZ, position: [x, 4.6, z], rotation: [0, rot, 0] });
  }
  for (const [x, z] of [[-1.1, -1.1], [1.1, -1.1], [-1.1, 1.1], [1.1, 1.1]] as Array<[number, number]>) {
    parts.push({ geometry: box(0.1, 1.6, 0.1), color: DUNKELHOLZ, position: [x, 5.1, z] });
  }
  parts.push({ geometry: cone(2.2, 0.9, 4), color: 0x6a4a34, position: [0, 6.3, 0], rotation: [0, Math.PI / 4, 0] });
  // Die Leiter — ohne sie ist der Turm unerreichbar und sieht auch so aus.
  for (let i = 0; i < 7; i++) {
    parts.push({ geometry: box(0.8, 0.06, 0.06), color: 0x9a7a4a, position: [0, 0.4 + i * 0.55, 1.5] });
  }
  parts.push({ geometry: box(0.07, 4.4, 0.07), color: DUNKELHOLZ, position: [-0.38, 2.2, 1.5] });
  parts.push({ geometry: box(0.07, 4.4, 0.07), color: DUNKELHOLZ, position: [0.38, 2.2, 1.5] });
  return assemble(parts);
}

/** Ein Käfig aus Eisenstäben. Leer — was darin war, ist die Geschichte. */
export function baueKaefig(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: box(1.5, 0.12, 1.5), color: DUNKELHOLZ, position: [0, 0.06, 0] },
    { geometry: box(1.5, 0.12, 1.5), color: EISEN, position: [0, 2.0, 0] },
  ];
  for (let i = 0; i < 6; i++) {
    const t = i / 6;
    for (const [x, z] of [[-0.7 + t * 1.4, -0.7], [-0.7 + t * 1.4, 0.7], [-0.7, -0.7 + t * 1.4], [0.7, -0.7 + t * 1.4]] as Array<[number, number]>) {
      parts.push({ geometry: box(0.06, 1.9, 0.06), color: EISEN, position: [x, 1.02, z] });
    }
  }
  parts.push({ geometry: cylinder(0.1, 0.1, 0.3, 6), color: EISEN, position: [0, 2.2, 0] });
  return assemble(parts);
}

/** Ein Galgen. Er steht am Weg und sagt, wer hier die Regeln macht. */
export function baueGalgen(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(1.4, 0.2, 1.4), color: DUNKELHOLZ, position: [0, 0.1, 0] },
    { geometry: box(0.22, 3.6, 0.22), color: DUNKELHOLZ, position: [-0.5, 1.8, 0] },
    { geometry: box(1.9, 0.2, 0.2), color: DUNKELHOLZ, position: [0.35, 3.5, 0] },
    { geometry: box(0.8, 0.14, 0.14), color: DUNKELHOLZ, position: [-0.15, 3.05, 0], rotation: [0, 0, 0.7] },
    { geometry: box(0.045, 1.1, 0.045), color: 0x9a8a72, position: [1.1, 2.9, 0] },
    { geometry: cylinder(0.13, 0.13, 0.16, 8), color: 0x9a8a72, position: [1.1, 2.3, 0], scale: [1, 1, 0.5] },
  ]);
}

// --- Knochen und Gräber -----------------------------------------------------

/** Ein Knochenhaufen — Rippen, Röhren, ein Becken. */
export function baueKnochenhaufen(): THREE.BufferGeometry {
  const parts: Part[] = [];
  for (let i = 0; i < 7; i++) {
    const w = i * 1.7;
    parts.push({
      geometry: cylinder(0.045, 0.06, 0.5 + (i % 3) * 0.2, 5),
      color: KNOCHEN,
      position: [Math.sin(w) * 0.3, 0.06 + (i % 2) * 0.08, Math.cos(w) * 0.3],
      rotation: [Math.PI / 2, w, (i % 3) * 0.4],
    });
  }
  for (let i = 0; i < 4; i++) {
    const w = i * 2.1 + 0.5;
    parts.push({
      geometry: cylinder(0.03, 0.03, 0.6, 4),
      color: 0xc0b8a4,
      position: [Math.sin(w) * 0.24, 0.16, Math.cos(w) * 0.24],
      rotation: [1.2, w, 0.5],
    });
  }
  return assemble(parts);
}

/**
 * Ein Schädel.
 *
 * Was ihn ausmacht, sind die **zwei dunklen Höhlen** — nicht die Form. Der
 * erste Anlauf hatte eine sorgfältig verbeulte Kugel ohne Löcher, und die sah
 * aus wie ein Stein.
 */
export function baueSchaedel(): THREE.BufferGeometry {
  return assemble([
    { geometry: sphere(0.22, 1), color: KNOCHEN, position: [0, 0.22, 0], scale: [1, 0.95, 1.15] },
    { geometry: box(0.24, 0.16, 0.14), color: KNOCHEN, position: [0, 0.1, 0.2] },
    { geometry: sphere(0.07, 0), color: 0x1a1712, position: [-0.09, 0.25, 0.2], scale: [1, 1.1, 0.5] },
    { geometry: sphere(0.07, 0), color: 0x1a1712, position: [0.09, 0.25, 0.2], scale: [1, 1.1, 0.5] },
    { geometry: box(0.04, 0.05, 0.06), color: 0x1a1712, position: [0, 0.15, 0.24] },
  ]);
}

/** Ein Grabstein, schief. Gerade stehende Grabsteine gibt es nur auf Friedhöfen. */
export function baueGrabstein(): THREE.BufferGeometry {
  return assemble([
    { geometry: rundeBox(0.7, 1.0, 0.18, { rund: 0.3, oben: 0.9, unten: 1.0, seg: 3 }), color: ALTSTEIN, position: [0, 0.5, 0], rotation: [0.09, 0, -0.11] },
    { geometry: box(0.3, 0.05, 0.04), color: DUNKELSTEIN, position: [0.02, 0.62, 0.1], rotation: [0.09, 0, -0.11] },
    { geometry: box(0.22, 0.05, 0.04), color: DUNKELSTEIN, position: [0.02, 0.5, 0.1], rotation: [0.09, 0, -0.11] },
    { geometry: box(0.86, 0.12, 0.4), color: DUNKELSTEIN, position: [0, 0.06, 0] },
  ]);
}

/** Ein Grabkreuz aus zwei Brettern. Ärmer als der Stein, und deshalb häufiger. */
export function baueGrabkreuz(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(0.12, 1.3, 0.08), color: TOTHOLZ, position: [0, 0.65, 0], rotation: [0, 0, 0.14] },
    { geometry: box(0.7, 0.11, 0.07), color: TOTHOLZ, position: [-0.09, 0.98, 0], rotation: [0, 0, 0.14] },
  ]);
}

/** Ein Sarkophag mit Deckel — verschoben, damit man sieht, dass er offen ist. */
export function baueSarkophag(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(2.4, 0.9, 1.1), color: ALTSTEIN, position: [0, 0.45, 0] },
    { geometry: box(2.5, 0.14, 1.2), color: DUNKELSTEIN, position: [0, 0.07, 0] },
    { geometry: box(2.2, 0.1, 0.9), color: 0x1a1712, position: [0, 0.88, 0] },
    // Der Deckel liegt schief und ragt über — ein sauber geschlossener
    // Sarkophag ist ein Steinquader.
    { geometry: box(2.4, 0.22, 1.1), color: STEIN, position: [0.35, 1.0, 0.12], rotation: [0.04, 0.07, -0.03] },
  ]);
}

/** Ein Holzsarg, hochkant an die Wand gelehnt. */
export function baueSarg(): THREE.BufferGeometry {
  return assemble([
    { geometry: rundeBox(0.8, 2.1, 0.5, { rund: 0.08, oben: 0.7, unten: 0.86, seg: 2 }), color: DUNKELHOLZ, position: [0, 1.05, 0], rotation: [-0.14, 0, 0.05] },
    { geometry: box(0.62, 0.09, 0.06), color: EISEN, position: [0, 1.5, 0.3], rotation: [-0.14, 0, 0.05] },
    { geometry: box(0.62, 0.09, 0.06), color: EISEN, position: [0.05, 0.6, 0.42], rotation: [-0.14, 0, 0.05] },
  ]);
}

/** Eine Urne auf einem Sockel. */
export function baueUrne(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(0.6, 0.24, 0.6), color: DUNKELSTEIN, position: [0, 0.12, 0] },
    { geometry: sphere(0.28, 1), color: ALTSTEIN, position: [0, 0.5, 0], scale: [1, 1.2, 1] },
    { geometry: cylinder(0.2, 0.26, 0.16, 8), color: ALTSTEIN, position: [0, 0.8, 0] },
    { geometry: cylinder(0.24, 0.24, 0.06, 8), color: DUNKELSTEIN, position: [0, 0.9, 0] },
  ]);
}

/** Ein Altar: Tisch aus Stein, Schale, Glut. */
export function baueAltar(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(1.8, 0.2, 1.0), color: DUNKELSTEIN, position: [0, 0.1, 0] },
    { geometry: box(1.2, 0.9, 0.7), color: ALTSTEIN, position: [0, 0.65, 0] },
    { geometry: box(1.9, 0.18, 1.1), color: STEIN, position: [0, 1.19, 0] },
    { geometry: cylinder(0.4, 0.28, 0.2, 10), color: DUNKELSTEIN, position: [0, 1.38, 0] },
    { geometry: sphere(0.26, 0), color: 0x8feaf0, position: [0, 1.44, 0], scale: [1, 0.5, 1] },
  ]);
}

/** Ein Runenstein — ein Stein mit einer eingehauenen Zeile, die leuchtet. */
export function baueRunenstein(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: rundeBox(1.0, 2.2, 0.4, { rund: 0.2, oben: 0.82, seg: 3 }), color: ALTSTEIN, position: [0, 1.1, 0], rotation: [0, 0, 0.05] },
  ];
  for (let i = 0; i < 4; i++) {
    parts.push({
      geometry: box(0.3 - (i % 2) * 0.1, 0.07, 0.05),
      color: 0x6fd8e0,
      position: [(i % 2) * 0.1 - 0.05, 1.6 - i * 0.32, 0.2],
      rotation: [0, 0, 0.05],
    });
  }
  return assemble(parts);
}

// --- Ruine ------------------------------------------------------------------

/** Eine abgebrochene Säule — sie steht überall dort, wo eine ganze zu viel wäre. */
export function baueSaeuleBruch(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(1.1, 0.28, 1.1), color: DUNKELSTEIN, position: [0, 0.14, 0] },
    { geometry: cylinder(0.4, 0.44, 1.5, 8), color: ALTSTEIN, position: [0, 1.0, 0] },
    // Die Bruchkante ist schief und ein bisschen breiter als der Schaft — ein
    // gerader Schnitt sieht aus wie gesägt.
    { geometry: cylinder(0.46, 0.4, 0.18, 8), color: 0x6a675f, position: [0.04, 1.78, -0.03], rotation: [0.14, 0, 0.1] },
  ]);
}

/** Trümmer — Bruchstücke einer Mauer, durcheinander. */
export function baueTruemmer(): THREE.BufferGeometry {
  const parts: Part[] = [];
  const stuecke: Array<[number, number, number, number, number, number]> = [
    [0, 0.22, 0, 1.1, 0.44, 0.7],
    [0.9, 0.16, 0.4, 0.7, 0.32, 0.5],
    [-0.7, 0.14, 0.5, 0.6, 0.28, 0.44],
    [0.2, 0.5, -0.3, 0.5, 0.3, 0.4],
    [-0.5, 0.12, -0.6, 0.45, 0.24, 0.36],
  ];
  for (let i = 0; i < stuecke.length; i++) {
    const [x, y, z, w, h, d] = stuecke[i]!;
    parts.push({
      geometry: rundeBox(w, h, d, { rund: 0.06, seg: 2 }),
      color: i % 2 === 0 ? ALTSTEIN : STEIN,
      position: [x, y, z],
      rotation: [(i % 3) * 0.14, i * 0.7, (i % 2) * 0.2 - 0.1],
    });
  }
  return assemble(parts);
}

/** Ein Stück Bogen, das stehen geblieben ist. Halbe Architektur. */
export function baueBogenrest(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: box(0.7, 3.4, 0.7), color: ALTSTEIN, position: [-1.6, 1.7, 0] },
    { geometry: box(0.8, 0.3, 0.8), color: DUNKELSTEIN, position: [-1.6, 0.15, 0] },
  ];
  // Der Bogenansatz: drei Keilsteine, die in die Luft laufen. Der Rest ist
  // heruntergefallen — und genau das erzählt der Abbruch.
  for (let i = 0; i < 3; i++) {
    const w = (i / 7) * Math.PI;
    parts.push({
      geometry: box(0.62, 0.5, 0.72),
      color: i % 2 === 0 ? STEIN : ALTSTEIN,
      position: [-1.6 + Math.sin(w) * 1.7, 3.5 + (1 - Math.cos(w)) * 0.9, 0],
      rotation: [0, 0, -w],
    });
  }
  return assemble(parts);
}

/** Eine Kette mit Fessel, an einem Ring in der Wand. */
export function baueKette(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: box(0.3, 0.3, 0.14), color: DUNKELSTEIN, position: [0, 1.8, 0] },
    { geometry: cylinder(0.12, 0.12, 0.05, 8), color: EISEN, position: [0, 1.7, 0.1], rotation: [Math.PI / 2, 0, 0] },
  ];
  for (let i = 0; i < 7; i++) {
    parts.push({
      geometry: cylinder(0.07, 0.07, 0.04, 6),
      color: EISEN,
      position: [Math.sin(i * 0.9) * 0.08, 1.55 - i * 0.19, 0.12 + i * 0.02],
      rotation: [i % 2 === 0 ? Math.PI / 2 : 0, 0, 0],
      scale: [1, 1, 0.6],
    });
  }
  parts.push({ geometry: cylinder(0.14, 0.14, 0.08, 8), color: 0x2f2f34, position: [0.1, 0.22, 0.26], rotation: [Math.PI / 2, 0, 0.3], scale: [1, 1, 0.5] });
  return assemble(parts);
}

/** Ein eisernes Gittertor, halb offen. */
export function baueEisentor(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: box(0.3, 3.2, 0.3), color: DUNKELSTEIN, position: [-1.5, 1.6, 0] },
    { geometry: box(0.3, 3.2, 0.3), color: DUNKELSTEIN, position: [1.5, 1.6, 0] },
    { geometry: box(3.3, 0.3, 0.34), color: DUNKELSTEIN, position: [0, 3.3, 0] },
  ];
  // Nur ein Flügel, und der steht offen: ein geschlossenes Tor mitten in einer
  // Ruine sieht aus, als sei es abgesperrt — und genau das will man nicht.
  for (let i = 0; i < 6; i++) {
    parts.push({
      geometry: box(0.07, 2.9, 0.07),
      color: EISEN,
      position: [-1.3 + i * 0.24, 1.55, 0.4 + i * 0.09],
      rotation: [0, -0.35, 0],
    });
  }
  parts.push({ geometry: box(1.5, 0.09, 0.09), color: EISEN, position: [-0.75, 2.9, 0.65], rotation: [0, -0.35, 0] });
  parts.push({ geometry: box(1.5, 0.09, 0.09), color: EISEN, position: [-0.75, 0.3, 0.65], rotation: [0, -0.35, 0] });
  return assemble(parts);
}

/** Eine Wandhalterung mit Fackel — für Gänge, die eine Wand haben. */
export function baueWandfackel(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(0.3, 0.5, 0.16), color: DUNKELSTEIN, position: [0, 1.9, -0.08] },
    { geometry: cylinder(0.045, 0.045, 0.5, 5), color: EISEN, position: [0, 2.05, 0.18], rotation: [0.9, 0, 0] },
    { geometry: cylinder(0.12, 0.08, 0.2, 6), color: EISEN, position: [0, 2.28, 0.36] },
    { geometry: sphere(0.14, 0), color: 0xff9a3c, position: [0, 2.42, 0.36], scale: [1, 1.4, 1] },
  ]);
}

/**
 * Eine Spinnwebe in einer Ecke.
 *
 * Aus dünnen Balken statt aus einer Karte: der Laubatlas hat keine Kachel
 * dafür, und eine Farnkachel in Weiss sähe aus wie ein toter Zweig. Acht
 * Speichen und zwei Ringe reichen — was ein Auge als Netz erkennt, sind die
 * Speichen, nicht die Maschen.
 */
export function baueSpinnwebe(): THREE.BufferGeometry {
  const parts: Part[] = [];
  const faden = 0xd0cec4;
  for (let i = 0; i < 8; i++) {
    const w = (i / 8) * Math.PI * 2;
    parts.push({
      geometry: box(1.5, 0.025, 0.025),
      color: faden,
      position: [Math.cos(w) * 0.75, 1.4 + Math.sin(w) * 0.75, 0],
      rotation: [0, 0, w],
    });
  }
  for (const r of [0.45, 0.85]) {
    for (let i = 0; i < 8; i++) {
      const w = (i / 8) * Math.PI * 2;
      parts.push({
        geometry: box(r * 0.8, 0.02, 0.02),
        color: faden,
        position: [Math.cos(w + 0.4) * r, 1.4 + Math.sin(w + 0.4) * r, 0],
        rotation: [0, 0, w + 1.97],
      });
    }
  }
  return assemble(parts);
}

/** Eine Treppe aus Stein, sechs Stufen. Sie führt an ein höheres Niveau. */
export function baueSteintreppe(): THREE.BufferGeometry {
  const parts: Part[] = [];
  for (let i = 0; i < 6; i++) {
    parts.push({
      geometry: box(2.2, 0.26, 0.5),
      color: i % 2 === 0 ? STEIN : ALTSTEIN,
      position: [0, 0.13 + i * 0.26, 1.25 - i * 0.5],
    });
  }
  parts.push({ geometry: box(0.3, 1.7, 3.0), color: DUNKELSTEIN, position: [-1.25, 0.85, 0] });
  parts.push({ geometry: box(0.3, 1.7, 3.0), color: DUNKELSTEIN, position: [1.25, 0.85, 0] });
  return assemble(parts);
}

/** Eine Grabplatte, in den Boden eingelassen. Man läuft darüber. */
export function baueGrabplatte(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: box(1.4, 0.16, 2.2), color: ALTSTEIN, position: [0, 0.08, 0] },
    { geometry: box(1.5, 0.1, 2.3), color: DUNKELSTEIN, position: [0, 0.03, 0] },
  ];
  // Ein eingehauenes Kreuz — flache Balken auf der Platte statt einer echten
  // Nut. Eine Nut wären zwölf Dreiecke für einen Schatten von zwei Zentimetern.
  parts.push({ geometry: box(0.16, 0.04, 1.5), color: 0x4a4842, position: [0, 0.17, 0] });
  parts.push({ geometry: box(0.8, 0.04, 0.16), color: 0x4a4842, position: [0, 0.17, -0.3] });
  return assemble(parts);
}

/** Ein Beinhausregal — Schädel in Fächern. Für die tiefen Gänge. */
export function baueBeinhaus(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: box(2.0, 0.14, 0.7), color: ALTSTEIN, position: [0, 0.07, 0] },
    { geometry: box(2.0, 0.14, 0.7), color: ALTSTEIN, position: [0, 0.85, 0] },
    { geometry: box(2.0, 0.14, 0.7), color: ALTSTEIN, position: [0, 1.63, 0] },
    { geometry: box(0.16, 1.7, 0.7), color: DUNKELSTEIN, position: [-1.0, 0.85, 0] },
    { geometry: box(0.16, 1.7, 0.7), color: DUNKELSTEIN, position: [1.0, 0.85, 0] },
  ];
  for (let reihe = 0; reihe < 2; reihe++) {
    for (let i = 0; i < 4; i++) {
      const x = -0.7 + i * 0.47;
      const y = 0.28 + reihe * 0.78;
      parts.push({ geometry: sphere(0.17, 1), color: KNOCHEN, position: [x, y, 0], scale: [1, 0.95, 1.1] });
      parts.push({ geometry: sphere(0.055, 0), color: 0x1a1712, position: [x - 0.07, y + 0.03, 0.15], scale: [1, 1.1, 0.5] });
      parts.push({ geometry: sphere(0.055, 0), color: 0x1a1712, position: [x + 0.07, y + 0.03, 0.15], scale: [1, 1.1, 0.5] });
    }
  }
  return assemble(parts);
}

/** Ein Opferschale-Ständer, wie er in Gruftgängen steht. */
export function baueOpferschale(): THREE.BufferGeometry {
  return assemble([
    { geometry: cylinder(0.26, 0.36, 0.16, 8), color: DUNKELSTEIN, position: [0, 0.08, 0] },
    { geometry: cylinder(0.12, 0.16, 1.0, 6), color: ALTSTEIN, position: [0, 0.6, 0] },
    { geometry: cylinder(0.42, 0.22, 0.24, 10), color: ALTSTEIN, position: [0, 1.2, 0] },
    { geometry: sphere(0.3, 0), color: 0x8feaf0, position: [0, 1.26, 0], scale: [1, 0.45, 1] },
  ]);
}

/** Ein umgestürzter Karren — die Ruine eines Planwagens. */
export function baueWrack(): THREE.BufferGeometry {
  const parts: Part[] = [
    // Die Ladefläche steht fast senkrecht — deshalb 1,4 m hoch aufgehängt und
    // nicht 0,6: bei 0,6 ragte ihre untere Hälfte einen halben Meter unter den
    // Boden, und auf einer Kuppe stand das Wrack sichtbar in der Luft.
    { geometry: box(2.8, 0.16, 1.4), color: TOTHOLZ, position: [0, 1.35, 0], rotation: [0, 0.1, 1.25] },
    { geometry: box(2.6, 0.45, 0.09), color: TOTHOLZ, position: [-0.3, 1.5, 0.5], rotation: [0, 0.1, 1.25] },
    { geometry: box(1.4, 0.1, 0.1), color: DUNKELHOLZ, position: [1.4, 0.2, -0.4], rotation: [0, 0.4, 0.1] },
    {
      geometry: cylinder(0.5, 0.5, 0.12, 10),
      color: DUNKELHOLZ,
      position: [-0.9, 0.5, -0.7],
      rotation: [1.2, 0, 0.4],
      scale: [1, 1, 0.2],
    },
    {
      geometry: cylinder(0.5, 0.5, 0.12, 10),
      color: DUNKELHOLZ,
      position: [0.4, 0.12, 0.9],
      rotation: [Math.PI / 2, 0, 0],
      scale: [1, 1, 0.2],
    },
  ];
  for (let i = 0; i < 4; i++) {
    parts.push({ geometry: box(0.9, 0.07, 0.07), color: TOTHOLZ, position: [-1.4 + i * 0.3, 0.16, -0.2 + i * 0.3], rotation: [0, i * 0.8, 0.05] });
  }
  return assemble(parts);
}
