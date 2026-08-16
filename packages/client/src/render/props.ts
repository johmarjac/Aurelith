/**
 * Prozedurale Props — Bäume, Felsen, Säulen, Tore.
 *
 * Jeder Eintrag liefert eine fertig verschmolzene Geometrie. Der Schlüssel
 * (`tree_pine`, `rock_large`, …) ist derselbe, den das Map-Dokument nennt und
 * den der spätere Editor in seiner Palette anbietet. Wird ein Prop irgendwann
 * durch ein geliefertes Modell ersetzt, ändert sich nur diese Datei.
 */

import * as THREE from 'three';
import { assemble, cone, cylinder, sphere, box, type Part } from './geometry.ts';
import { laubKarte, laubNormalen, type LaubKachel } from './laub.ts';
import { baueFindling } from './findling.ts';
import { baueSchwebfels } from './schwebfels.ts';
import { baueFichte, baueLaubbaum, baueTanne } from './baeume.ts';
import * as flora from './propsFlora.ts';
import * as fels from './propsFels.ts';
import * as siedlung from './propsSiedlung.ts';
import * as ruine from './propsRuine.ts';

export type PropBuilder = () => THREE.BufferGeometry;

const BARK = 0x6b4f34;
const DEAD_BARK = 0x5c5245;
const STONE = 0x7d7a70;
const DARK_STONE = 0x4a4a52;

function deadTree(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: cylinder(0.12, 0.28, 3.2, 6), color: DEAD_BARK, position: [0, 1.6, 0] },
  ];
  const branches = [
    { y: 2.2, rot: 0.9, yaw: 0.0, len: 1.2 },
    { y: 2.6, rot: -0.8, yaw: 2.1, len: 1.0 },
    { y: 1.8, rot: 1.1, yaw: 4.0, len: 0.9 },
  ];
  for (const b of branches) {
    parts.push({
      geometry: cylinder(0.05, 0.09, b.len, 5),
      color: DEAD_BARK,
      position: [Math.sin(b.yaw) * b.len * 0.35, b.y, Math.cos(b.yaw) * b.len * 0.35],
      rotation: [b.rot * Math.cos(b.yaw), 0, -b.rot * Math.sin(b.yaw)],
    });
  }
  return assemble(parts);
}

/**
 * Ein Busch aus Laubkarten.
 *
 * Hier standen drei zerknautschte Kugeln, und das war von aussen genau das:
 * drei Kugeln mit sichtbaren Schnittkanten und einer Silhouette wie ein
 * Gummiball. Ein Busch hat aber vor allem **Lücken** — und die kann eine
 * geschlossene Fläche nicht.
 *
 * Also gekreuzte Karten mit einer Blatttextur, deren Rand durchsichtig ist.
 * Die Silhouette kommt aus dem Bild, nicht aus der Geometrie: sechzehn
 * Dreiecke, und trotzdem sieht man Blätter.
 *
 * Die Karten stehen **nicht alle senkrecht**. Ein Kranz senkrechter Karten
 * sieht von oben aus wie ein Stern; ein paar geneigte füllen die Sicht von
 * oben, ohne dass es mehr Karten braucht.
 */
function bush(): THREE.BufferGeometry {
  const parts: Part[] = [];
  const karten: Array<{
    kachel: LaubKachel;
    b: number;
    h: number;
    x: number;
    y: number;
    z: number;
    gier: number;
    kipp: number;
    farbe: number;
  }> = [
    { kachel: 'blatt', b: 1.25, h: 1.0, x: 0, y: 0, z: 0, gier: 0.2, kipp: 0, farbe: 0x5d9a4a },
    { kachel: 'blatt', b: 1.15, h: 0.95, x: 0, y: 0.02, z: 0, gier: 1.25, kipp: 0, farbe: 0x69a852 },
    { kachel: 'blatt', b: 1.05, h: 0.85, x: 0, y: 0.04, z: 0, gier: 2.4, kipp: 0, farbe: 0x4d8639 },
    // Zwei liegende oben drauf — sie schliessen die Sicht von oben.
    {
      kachel: 'blatt', b: 1.0, h: 0.9, x: 0.05, y: 0.72, z: -0.05,
      gier: 0.7, kipp: 1.35, farbe: 0x6fb055,
    },
    {
      kachel: 'blatt', b: 0.85, h: 0.8, x: -0.12, y: 0.6, z: 0.14,
      gier: 2.1, kipp: 1.1, farbe: 0x568f42,
    },
    // Und zwei kleine schräg an den Seiten, damit die Umrisslinie nicht
    // symmetrisch wird.
    {
      kachel: 'blatt', b: 0.8, h: 0.66, x: 0.34, y: 0.16, z: 0.2,
      gier: 0.9, kipp: 0.35, farbe: 0x6aa84c,
    },
    {
      kachel: 'blatt', b: 0.75, h: 0.62, x: -0.3, y: 0.12, z: -0.22,
      gier: 2.7, kipp: -0.3, farbe: 0x4a8038,
    },
    // Eine Blütenkachel: der Busch bekommt damit einen hellen Punkt, an dem
    // das Auge hängenbleibt.
    {
      kachel: 'bluete', b: 0.7, h: 0.6, x: 0.1, y: 0.42, z: 0.26,
      gier: 0.35, kipp: 0.2, farbe: 0x86c25e,
    },
  ];

  for (const k of karten) {
    parts.push({
      geometry: laubKarte(k.kachel, k.b, k.h),
      color: k.farbe,
      position: [k.x, k.y, k.z],
      rotation: [k.kipp, k.gier, 0],
    });
  }

  const geo = assemble(parts);
  // Von der Mitte des Busches nach aussen: eine Karte, die zur Seite steht,
  // wäre mit ihrer eigenen Normalen von oben schwarz.
  laubNormalen(geo, 0.5);
  return geo;
}

/**
 * Ein Grasbüschel — drei gekreuzte Karten mit Halmen.
 *
 * Vorher waren es fünf Kegel, und die sahen aus wie fünf Kegel: dicke Spitzen
 * ohne Kante. Halme sind dünn, und dünn heisst bei Dreiecken teuer — auf einer
 * Textur mit Loch kostet es nichts.
 *
 * Der Ursprung liegt am Boden: `laubKarte` setzt die Karte auf y = 0 auf, und
 * ein Grasbüschel, das in der Luft anfängt, sieht man auf jeder Wiese sofort.
 */
function grassTuft(): THREE.BufferGeometry {
  const parts: Part[] = [];
  const karten = [
    { kachel: 'gras' as const, b: 0.9, h: 0.62, gier: 0.15, farbe: 0x84c264 },
    { kachel: 'gras' as const, b: 0.8, h: 0.55, gier: 1.1, farbe: 0x6faa50 },
    { kachel: 'gras' as const, b: 0.75, h: 0.5, gier: 2.2, farbe: 0x8ecb6b },
    // Ein Farnwedel dazwischen: derselbe Aufwand, und aus einer Wiese aus
    // lauter gleichen Büscheln wird eine mit Unterholz.
    { kachel: 'farn' as const, b: 0.6, h: 0.52, gier: 0.7, farbe: 0x5f9c48 },
  ];
  for (const k of karten) {
    parts.push({
      geometry: laubKarte(k.kachel, k.b, k.h),
      color: k.farbe,
      rotation: [0, k.gier, 0],
    });
  }
  const geo = assemble(parts);
  laubNormalen(geo, 0.25);
  return geo;
}

function stump(): THREE.BufferGeometry {
  return assemble([
    { geometry: cylinder(0.34, 0.42, 0.55, 8), color: BARK, position: [0, 0.28, 0] },
    { geometry: cylinder(0.3, 0.3, 0.06, 8), color: 0xa87f52, position: [0, 0.57, 0] },
  ]);
}

function mushroom(): THREE.BufferGeometry {
  return assemble([
    { geometry: cylinder(0.1, 0.14, 0.7, 6), color: 0xd8cdb4, position: [0, 0.35, 0] },
    { geometry: sphere(0.42, 1), color: 0xa8452f, position: [0, 0.72, 0], scale: [1, 0.6, 1] },
  ]);
}

function crystal(): THREE.BufferGeometry {
  return assemble([
    {
      geometry: new THREE.OctahedronGeometry(0.45, 0),
      color: 0x7fd8e8,
      position: [0, 0.75, 0],
      scale: [1, 1.9, 1],
    },
    {
      geometry: new THREE.OctahedronGeometry(0.26, 0),
      color: 0x9ae4f0,
      position: [0.3, 0.4, 0.15],
      scale: [1, 1.5, 1],
      rotation: [0, 0.6, 0.25],
    },
  ]);
}

function pillar(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(1.1, 0.28, 1.1), color: DARK_STONE, position: [0, 0.14, 0] },
    { geometry: cylinder(0.38, 0.44, 3.4, 8), color: 0x5a5a62, position: [0, 1.9, 0] },
    { geometry: box(1.0, 0.3, 1.0), color: DARK_STONE, position: [0, 3.75, 0] },
  ]);
}

function brazier(): THREE.BufferGeometry {
  return assemble([
    { geometry: cylinder(0.1, 0.16, 1.0, 6), color: 0x3a3a3f, position: [0, 0.5, 0] },
    { geometry: cylinder(0.42, 0.26, 0.34, 8), color: 0x4a4a50, position: [0, 1.15, 0] },
    // Die Glut ist nur Farbe — echtes Licht käme später über Punktlichter,
    // und die kosten auf dem Telefon mehr, als sie hier bringen.
    { geometry: sphere(0.3, 0), color: 0xff9a3c, position: [0, 1.3, 0], scale: [1, 0.7, 1] },
  ]);
}

function well(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: cylinder(1.3, 1.4, 0.9, 12), color: STONE, position: [0, 0.45, 0] },
    { geometry: cylinder(1.1, 1.1, 0.2, 12), color: 0x2a3540, position: [0, 0.92, 0] },
    { geometry: box(0.16, 2.0, 0.16), color: BARK, position: [-1.0, 1.4, 0] },
    { geometry: box(0.16, 2.0, 0.16), color: BARK, position: [1.0, 1.4, 0] },
    { geometry: box(2.6, 0.16, 1.6), color: 0x7a4b2c, position: [0, 2.5, 0], rotation: [0, 0, 0] },
  ];
  return assemble(parts);
}

function signpost(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(0.12, 1.8, 0.12), color: BARK, position: [0, 0.9, 0] },
    { geometry: box(0.9, 0.34, 0.08), color: 0xa87f52, position: [0.3, 1.55, 0] },
  ]);
}

/**
 * Ein Zaunfeld aus Holz.
 *
 * Zwei Meter breit und so gebaut, dass sich Felder aneinanderreihen lassen:
 * die Pfosten sitzen an den Enden, nicht in der Mitte. Wer zwei Stück im
 * Abstand von zwei Metern setzt, bekommt eine durchgehende Linie statt einer
 * Reihe einzelner Stücke mit Lücken.
 */
function fenceWood(): THREE.BufferGeometry {
  const holz = 0x8a6a42;
  return assemble([
    { geometry: box(0.14, 1.15, 0.14), color: BARK, position: [-1, 0.575, 0] },
    { geometry: box(0.14, 1.15, 0.14), color: BARK, position: [1, 0.575, 0] },
    // Zwei Riegel, der obere etwas dicker — sonst wirkt der Zaun kopflastig.
    { geometry: box(2, 0.12, 0.07), color: holz, position: [0, 0.92, 0] },
    { geometry: box(2, 0.1, 0.06), color: holz, position: [0, 0.52, 0] },
  ]);
}

/** Dasselbe in Stein: niedriger, massiver, mit Abdeckung. */
function fenceStone(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(2, 0.7, 0.34), color: STONE, position: [0, 0.35, 0] },
    { geometry: box(2.1, 0.12, 0.44), color: DARK_STONE, position: [0, 0.76, 0] },
    // Ein versetzter Stein je Feld: ohne ihn wiederholt sich eine lange Mauer
    // zu offensichtlich.
    { geometry: box(0.5, 0.24, 0.38), color: 0x8d8a80, position: [-0.5, 0.5, 0] },
  ]);
}

/**
 * Laternenpfahl.
 *
 * Der Glaskörper ist hier nur ein heller Farbwert. Das eigentliche Licht kommt
 * aus `lanterns.ts`: eine feste Handvoll Punktlichter, die zu den
 * nächstgelegenen Laternen wandert. Eine Lichtquelle je Laterne wäre bei
 * fünfzig Stück auf einer Karte fünfzig zusätzliche Lichter — das trägt kein
 * Renderer, der auf einem Telefon laufen soll.
 */
function lanternPost(): THREE.BufferGeometry {
  const eisen = 0x3a3a40;
  const glas = 0xffd88a;
  return assemble([
    // Zwei Meter sechzig statt drei zehn: der erste Anlauf war so hoch und
    // duenn, dass die Laterne im Bild wie eine Lanze aussah.
    { geometry: cylinder(0.11, 0.17, 2.35, 6), color: eisen, position: [0, 1.18, 0] },
    { geometry: cylinder(0.26, 0.3, 0.14, 6), color: eisen, position: [0, 0.07, 0] },
    // Der Kopf sitzt oben auf, nicht an einem Ausleger. Ein Arm braucht ein
    // Gegengewicht, um nicht falsch auszusehen, und das ist bei dieser
    // Bauteilgroesse mehr Aufwand als Wirkung.
    { geometry: box(0.34, 0.1, 0.34), color: eisen, position: [0, 2.4, 0] },
    { geometry: box(0.3, 0.4, 0.3), color: glas, position: [0, 2.65, 0] },
    // Vier Streben, damit der Glaskoerper nicht wie ein Block wirkt.
    { geometry: box(0.05, 0.42, 0.05), color: eisen, position: [0.14, 2.65, 0.14] },
    { geometry: box(0.05, 0.42, 0.05), color: eisen, position: [-0.14, 2.65, 0.14] },
    { geometry: box(0.05, 0.42, 0.05), color: eisen, position: [0.14, 2.65, -0.14] },
    { geometry: box(0.05, 0.42, 0.05), color: eisen, position: [-0.14, 2.65, -0.14] },
    { geometry: box(0.42, 0.07, 0.42), color: eisen, position: [0, 2.88, 0] },
    { geometry: cone(0.3, 0.26, 4), color: eisen, position: [0, 3.04, 0] },
  ]);
}

/** Fass. Steht in jedem Lager herum und füllt Ecken. */
function barrel(): THREE.BufferGeometry {
  const daube = 0x7a5a36;
  const reif = 0x4a4a52;
  return assemble([
    { geometry: cylinder(0.34, 0.34, 0.9, 8), color: daube, position: [0, 0.45, 0] },
    { geometry: cylinder(0.38, 0.38, 0.9, 8), color: daube, position: [0, 0.45, 0], scale: [1, 0.55, 1] },
    { geometry: cylinder(0.39, 0.39, 0.08, 8), color: reif, position: [0, 0.22, 0] },
    { geometry: cylinder(0.39, 0.39, 0.08, 8), color: reif, position: [0, 0.68, 0] },
  ]);
}

/** Kiste. */
function crate(): THREE.BufferGeometry {
  const holz = 0x8a6a42;
  const kante = 0x6b4f34;
  return assemble([
    { geometry: box(0.8, 0.7, 0.8), color: holz, position: [0, 0.35, 0] },
    { geometry: box(0.86, 0.09, 0.09), color: kante, position: [0, 0.62, 0.4] },
    { geometry: box(0.86, 0.09, 0.09), color: kante, position: [0, 0.1, 0.4] },
    { geometry: box(0.09, 0.09, 0.86), color: kante, position: [0.4, 0.62, 0] },
  ]);
}

/** Strohballen. */
function hayBale(): THREE.BufferGeometry {
  const stroh = 0xc9a94f;
  return assemble([
    { geometry: cylinder(0.55, 0.55, 1.1, 8), color: stroh, position: [0, 0.55, 0], rotation: [0, 0, Math.PI / 2] },
    { geometry: box(0.06, 0.08, 1.14), color: 0x8f7a3a, position: [0, 0.55, 0] },
  ]);
}

/** Bannermast — ein Farbtupfer für Lager und Wegkreuzungen. */
function banner(): THREE.BufferGeometry {
  return assemble([
    { geometry: cylinder(0.08, 0.11, 2.9, 6), color: BARK, position: [0, 1.45, 0] },
    { geometry: box(0.06, 1.15, 0.8), color: 0x8c3b3b, position: [0, 2.15, 0.4] },
    { geometry: box(0.08, 0.1, 0.84), color: 0xd8b84a, position: [0, 2.7, 0.4] },
  ]);
}

function archway(stoneColor: number, accent: number): THREE.BufferGeometry {
  return assemble([
    { geometry: box(0.7, 4.4, 0.7), color: stoneColor, position: [-2.0, 2.2, 0] },
    { geometry: box(0.7, 4.4, 0.7), color: stoneColor, position: [2.0, 2.2, 0] },
    { geometry: box(4.8, 0.7, 0.8), color: stoneColor, position: [0, 4.6, 0] },
    { geometry: box(1.2, 0.5, 0.3), color: accent, position: [0, 4.6, 0.4] },
  ]);
}

/**
 * Welche Props aus Laubkarten bestehen.
 *
 * Sie brauchen ein anderes Material — eines mit Textur und Alphatest, siehe
 * `createFoliageMaterial`.
 */
const LAUB_MODELLE: ReadonlySet<string> = new Set([
  'bush',
  'grass_tuft',
  // Bäume gehören dazu, seit ihre Kronen aus Karten bestehen — und der Stamm
  // gleich mit: seine Rinde liegt als deckende Kachel in demselben Atlas.
  'tree_pine',
  'tree_fir',
  'tree_broad',
  // Alles aus `propsFlora.ts`, was Blätter, Halme oder Blüten hat. Was dort
  // aus Körpern gebaut ist — Stämme, Wurzeln, Pilze —, steht hier **nicht**:
  // ein Stamm mit Alphatest verliert seine Kanten an die Blattkachel.
  'farn',
  'schilf',
  'rohrkolben',
  'seerose',
  'blume_weiss',
  'blume_gelb',
  'blume_blau',
  'klee',
  'distel',
  'dornbusch',
  'brombeere',
  'beerenbusch',
  'heidekraut',
  'hochgras',
  'getreide',
  'setzling',
  'efeu',
]);

/**
 * Welche Props die Gesteinstextur tragen.
 *
 * Deckend und einseitig, siehe `createStoneMaterial`. Der schwebende Fels
 * gehört dazu, obwohl oben Gras liegt: die Körnung ist fast farblos, und mal
 * Grün ergibt sie eine Wiese mit Struktur statt einer grünen Scheibe.
 */
const FELS_MODELLE: ReadonlySet<string> = new Set([
  'rock_small',
  'rock_large',
  'fels_schwebend',
  'fels_schwebend_klein',
  // Aus `propsFels.ts`. Die beiden Kristalle stehen bewusst **nicht** dabei:
  // ein Kristall ist glatt, und Gesteinskörnung darauf nimmt ihm genau das,
  // was ihn von einem Stein unterscheidet.
  'kiesel',
  'geroell',
  'steinplatte',
  'felsblock',
  'felsnadel',
  'steinbogen',
  'hinkelstein',
  'steinmann',
  'erzader',
  'moosstein',
  'stalagmit',
  'stalaktit',
  'tropfsteinsaeule',
  'geode',
]);

/** Aus welchem Material ein Prop gezeichnet wird. */
export type MaterialArt = 'standard' | 'laub' | 'fels';

/**
 * Welches Material ein Prop braucht.
 *
 * Eine Funktion und nicht mehrere ausgestellte Mengen: Weltansicht, Editor und
 * Modellschau fragen dieselbe Frage, und drei Stellen, die je Sorte ein
 * weiteres `has(...)` nachtragen müssten, sind drei Gelegenheiten, es zu
 * vergessen. Wer eine vierte Sorte einführt, ändert diese Zeile — und die drei
 * bekommen sie geschenkt, sobald sie den neuen Fall behandeln.
 */
export function materialArt(key: string): MaterialArt {
  if (LAUB_MODELLE.has(key)) return 'laub';
  if (FELS_MODELLE.has(key)) return 'fels';
  return 'standard';
}

/** Der Katalog. Schlüssel entsprechen dem `model`-Feld im Map-Dokument. */
export const PROP_BUILDERS: Record<string, PropBuilder> = {
  tree_pine: () => baueFichte(0x71c3),
  tree_fir: () => baueTanne(0x8ad4),
  tree_broad: () => baueLaubbaum(0x93e5),
  tree_dead: deadTree,
  rock_small: () => baueFindling(0.75, 0xaa11),
  rock_large: () => baueFindling(1.9, 0xbb22),
  // Schwebende Felsen. Der Radius ist zugleich der der begehbaren Scheibe —
  // was im Map-Dokument als `collisionRadius` steht, muss dazu passen.
  fels_schwebend: () => baueSchwebfels(9, 0xf10a),
  fels_schwebend_klein: () => baueSchwebfels(5.5, 0xf20b),
  bush,
  grass_tuft: grassTuft,
  stump,
  mushroom_large: mushroom,
  crystal,
  pillar,
  brazier,
  well,
  signpost,

  // Siedlung und Weg — was eine Karte bewohnt aussehen lässt.
  fence_wood: fenceWood,
  fence_stone: fenceStone,
  lantern_post: lanternPost,
  barrel,
  crate,
  hay_bale: hayBale,
  banner,

  /*
   * --- Bewuchs (`propsFlora.ts`) -------------------------------------------
   *
   * Die Schlüssel sind ab hier deutsch. Die älteren englischen bleiben, wie
   * sie sind: sie stehen in drei erzeugten Karten, im Editor und in
   * `PROP_KOLLISION`, und eine halb umbenannte Palette ist schlimmer als eine
   * gemischte.
   */
  farn: flora.baueFarn,
  schilf: flora.baueSchilf,
  rohrkolben: flora.baueRohrkolben,
  seerose: flora.baueSeerose,
  blume_weiss: flora.baueBlumeWeiss,
  blume_gelb: flora.baueBlumeGelb,
  blume_blau: flora.baueBlumeBlau,
  klee: flora.baueKlee,
  distel: flora.baueDistel,
  dornbusch: flora.baueDornbusch,
  brombeere: flora.baueBrombeere,
  beerenbusch: flora.baueBeerenbusch,
  heidekraut: flora.baueHeidekraut,
  hochgras: flora.baueHochgras,
  getreide: flora.baueGetreide,
  setzling: flora.baueSetzling,
  efeu: flora.baueEfeu,
  baumstamm_liegend: flora.baueBaumstammLiegend,
  wurzelstock: flora.baueWurzelstock,
  hohler_stumpf: flora.baueHohlerStumpf,
  astbruch: flora.baueAstbruch,
  baumpilz: flora.baueBaumpilz,
  leuchtpilz: flora.baueLeuchtpilz,
  pilzring: flora.bauePilzring,

  // --- Stein (`propsFels.ts`) ----------------------------------------------
  kiesel: fels.baueKiesel,
  geroell: fels.baueGeroell,
  steinplatte: fels.baueSteinplatte,
  felsblock: fels.baueFelsblock,
  felsnadel: fels.baueFelsnadel,
  steinbogen: fels.baueSteinbogen,
  hinkelstein: fels.baueHinkelstein,
  steinmann: fels.baueSteinmann,
  erzader: fels.baueErzader,
  moosstein: fels.baueMoosstein,
  stalagmit: fels.baueStalagmit,
  stalaktit: fels.baueStalaktit,
  tropfsteinsaeule: fels.baueTropfsteinsaeule,
  kristallgruppe: fels.baueKristallgruppe,
  kristall_gross: fels.baueKristallGross,
  geode: fels.baueGeode,

  // --- Siedlung und Handwerk (`propsSiedlung.ts`) --------------------------
  marktstand: siedlung.baueMarktstand,
  markttisch: siedlung.baueMarkttisch,
  handkarre: siedlung.baueHandkarre,
  planwagen: siedlung.bauePlanwagen,
  wagenrad: siedlung.baueWagenrad,
  holzstapel: siedlung.baueHolzstapel,
  hackklotz: siedlung.baueHackklotz,
  amboss: siedlung.baueAmboss,
  esse: siedlung.baueEsse,
  schleifstein: siedlung.baueSchleifstein,
  wassertrog: siedlung.baueWassertrog,
  bank: siedlung.baueBank,
  tisch: siedlung.baueTisch,
  hocker: siedlung.baueHocker,
  sackstapel: siedlung.baueSackstapel,
  korb: siedlung.baueKorb,
  kistenstapel: siedlung.baueKistenstapel,
  tonkrug: siedlung.baueTonkrug,
  fackel: siedlung.baueFackel,
  feuerschale: siedlung.baueFeuerschale,
  fahnenmast: siedlung.baueFahnenmast,
  meilenstein: siedlung.baueMeilenstein,
  bildstock: siedlung.baueBildstock,
  statue: siedlung.baueStatue,
  zierbrunnen: siedlung.baueZierbrunnen,
  torpfosten: siedlung.baueTorpfosten,
  blumenkasten: siedlung.baueBlumenkasten,
  bienenkorb: siedlung.baueBienenkorb,
  taubenschlag: siedlung.baueTaubenschlag,
  huehnerstall: siedlung.baueHuehnerstall,
  waescheleine: siedlung.baueWaescheleine,
  pflug: siedlung.bauePflug,
  steg: siedlung.baueSteg,
  ruderboot: siedlung.baueRuderboot,
  fischgestell: siedlung.baueFischgestell,
  fischernetz: siedlung.baueFischernetz,

  // --- Lager, Ruine, Gruft (`propsRuine.ts`) -------------------------------
  lagerfeuer: ruine.baueLagerfeuer,
  zelt: ruine.baueZelt,
  schlafrolle: ruine.baueSchlafrolle,
  bratspiess: ruine.baueBratspiess,
  waffenstaender: ruine.baueWaffenstaender,
  palisade: ruine.bauePalisade,
  spitzbarriere: ruine.baueSpitzbarriere,
  wachturm: ruine.baueWachturm,
  kaefig: ruine.baueKaefig,
  galgen: ruine.baueGalgen,
  knochenhaufen: ruine.baueKnochenhaufen,
  schaedel: ruine.baueSchaedel,
  grabstein: ruine.baueGrabstein,
  grabkreuz: ruine.baueGrabkreuz,
  sarkophag: ruine.baueSarkophag,
  sarg: ruine.baueSarg,
  urne: ruine.baueUrne,
  altar: ruine.baueAltar,
  runenstein: ruine.baueRunenstein,
  saeule_bruch: ruine.baueSaeuleBruch,
  truemmer: ruine.baueTruemmer,
  bogenrest: ruine.baueBogenrest,
  kette: ruine.baueKette,
  eisentor: ruine.baueEisentor,
  wandfackel: ruine.baueWandfackel,
  spinnwebe: ruine.baueSpinnwebe,
  steintreppe: ruine.baueSteintreppe,
  grabplatte: ruine.baueGrabplatte,
  beinhaus: ruine.baueBeinhaus,
  opferschale: ruine.baueOpferschale,
  wrack: ruine.baueWrack,
};

/**
 * Ein Pfeil.
 *
 * Liegt entlang +Z, Spitze voraus — so richtet `lookAt` ihn auf sein Ziel aus,
 * ohne dass jemand eine Drehung nachrechnen muss.
 */
export function buildArrow(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(0.03, 0.03, 0.6), color: 0x8a6b3f, position: [0, 0, 0] },
    { geometry: cone(0.05, 0.16, 6), color: 0x9aa3ad, position: [0, 0, 0.36], rotation: [Math.PI / 2, 0, 0] },
    { geometry: box(0.008, 0.09, 0.12), color: 0xe8e0cc, position: [0, 0, -0.26] },
    { geometry: box(0.09, 0.008, 0.12), color: 0xe8e0cc, position: [0, 0, -0.26] },
  ]);
}

/**
 * Der Torbogen.
 *
 * Bewusst nicht im Prop-Katalog: ein Tor ist kein Dekostück, das man neben
 * eine unsichtbare Zone stellt, sondern das sichtbare Teil der Zone selbst.
 * Gezeichnet wird er aus `doc.portals` — derselben Zeile, die den Server
 * auslösen lässt.
 */
export function buildGateArch(): THREE.BufferGeometry {
  return archway(0x8a8478, 0x4cc9bf);
}

/** Ersatzteil für unbekannte Schlüssel — sichtbar falsch, aber nie ein Absturz. */
export function fallbackProp(): THREE.BufferGeometry {
  return assemble([{ geometry: box(0.8, 1.6, 0.8), color: 0xc0392b, position: [0, 0.8, 0] }]);
}
