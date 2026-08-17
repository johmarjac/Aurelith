/**
 * Womit ein Prop im Weg steht — je Modell **einmal** festgelegt.
 *
 * Vorher stand die Zahl an jedem Aufruf in `tools/gen-maps.mjs`, und zwar so
 * oft, wie das Prop auf einer Karte vorkommt. Das Ergebnis war absehbar und
 * liess sich in den erzeugten Karten nachzählen: `rock_large` hatte je nach
 * Karte den Radius 1,9, 2,0 oder 2,1, `tree_pine` 1,1 oder 1,2, `pillar` 0,9,
 * 1,1 oder 1,3 — und `rock_small` stand in der Gruft gar nicht im Weg,
 * während man in Lichtmoor darum herumlief. Keine dieser Abweichungen war
 * gewollt; sie sind einfach entstanden.
 *
 * Deshalb hier eine Tabelle und nicht sechzig Literale. Sie ist die Wahrheit
 * für alle drei, die sie brauchen:
 *
 * - der **Kartengenerator** setzt sie in jedes Prop, das er ablegt,
 * - der **Editor** setzt sie in jedes Prop, das man von Hand hinstellt,
 * - die **Modellschau** zeichnet sie als Ring unter das Modell, damit man
 *   sieht, ob der Kreis zum Baum passt, bevor er auf tausend Karten steht.
 *
 * Der Radius gilt bei `scale: 1`. Server und Client rechnen ihn beim Laden
 * mit der Skalierung des Props mal — ein doppelt so grosser Baum steht auch
 * doppelt so weit im Weg.
 */

import type { PropCollisionShape } from './mapFormat.ts';

export interface PropKollision {
  form: PropCollisionShape;
  /** Radius der Scheibe bei `scale: 1`, in Metern. */
  radius: number;
  /**
   * Wie hoch das Prop im Weg steht, in Metern über seinem Fuss.
   *
   * **Die echte Höhe des Modells**, auf fünf Zentimeter gerundet — für jedes
   * Prop mit einem Kreis, ohne Ausnahme. Was darunter bleibt, lässt sich
   * überspringen: der Sprung erreicht 1,68 m Scheitelhöhe, und die Füsse
   * müssen über die Oberkante. Ein Zaunfeld (1,15 m) und eine Steinmauer
   * (0,82 m) gehen damit, eine Palisade (2,86 m) nicht.
   *
   * Hier stand einmal **„Null heisst bis in den Himmel"**, und Bäume, Säulen
   * und Felsen trugen diese Null. Für den Sprung war das richtig und im Raum
   * falsch: ein Fels am Boden versperrte damit auch den Weg, der
   * sechsundzwanzig Meter darüber über einen schwebenden Felsen führte. Man
   * lief oben über eine ebene Fläche und stiess an etwas an, das weit unter
   * einem lag. Eine Zahl, die bis in die Wolken reicht, ist in einer Welt mit
   * Höhen keine Angabe, sondern ein blinder Fleck — `props_test` lässt keine
   * mehr durch.
   *
   * Null bleibt für `form: 'none'` stehen, wo gar kein Kreis entsteht, und
   * für `plattform`, deren Höhe aus der Lage des Props kommt.
   */
  hoehe: number;
}

/**
 * Der Kreis ist **enger als das Modell**, und das mit Absicht.
 *
 * Eine Baumkrone ist drei Meter breit; wer um drei Meter Radius herumläuft,
 * läuft um Luft herum. Gemeint ist der Stamm — das, wo man tatsächlich
 * anstösst. Bei Felsen und Fässern deckt sich beides ungefähr, bei Bäumen
 * nicht, und genau das sieht man in der Modellschau am Ring unter dem Modell.
 */
export const PROP_KOLLISION: Readonly<Record<string, PropKollision>> = {
  // --- Bäume: gemeint ist der Stamm, nicht die Krone ------------------------
  tree_pine: { form: 'circle', radius: 1.1, hoehe: 7.4 },
  tree_fir: { form: 'circle', radius: 1.0, hoehe: 8.8 },
  tree_broad: { form: 'circle', radius: 1.4, hoehe: 5.55 },
  tree_dead: { form: 'circle', radius: 0.7, hoehe: 3.2 },

  // --- Fels -----------------------------------------------------------------
  rock_small: { form: 'circle', radius: 0.85, hoehe: 0.7 },
  rock_large: { form: 'circle', radius: 2.0, hoehe: 1.9 },
  /*
   * Die schwebenden Felsen sind **Plattformen**: der Radius ist der der
   * begehbaren Scheibe und muss zu dem passen, mit dem `baueSchwebfels` sie
   * baut (9 und 5,5). Läuft das auseinander, steht man auf Luft oder stösst
   * an eine Kante, die man nicht sieht.
   */
  fels_schwebend: { form: 'plattform', radius: 9, hoehe: 0 },
  fels_schwebend_klein: { form: 'plattform', radius: 5.5, hoehe: 0 },

  // --- Bewuchs: alles, wodurch man hindurchläuft ----------------------------
  bush: { form: 'none', radius: 0.6, hoehe: 0 },
  grass_tuft: { form: 'none', radius: 0.3, hoehe: 0 },
  stump: { form: 'none', radius: 0.45, hoehe: 0 },
  mushroom_large: { form: 'none', radius: 0.45, hoehe: 0 },
  crystal: { form: 'none', radius: 0.5, hoehe: 0 },

  /*
   * --- Gebautes -------------------------------------------------------------
   *
   * Säule und Brunnen standen hier mit 1,1 und 2,2 — beides war der
   * **Durchmesser** ihrer Grundfläche und nicht deren Radius. Man blieb also
   * einen halben Meter vor dem Sockel stehen, an einer Kante, die man nicht
   * sah. Aufgefallen ist es erst, als `props_test.ts` jeden Kreis gegen die
   * Ausdehnung des Modells hielt; auf einem Bild sieht man so etwas nie.
   */
  pillar: { form: 'circle', radius: 0.6, hoehe: 3.9 },
  brazier: { form: 'circle', radius: 0.6, hoehe: 1.5 },
  well: { form: 'circle', radius: 1.5, hoehe: 2.6 },
  fence_wood: { form: 'circle', radius: 0.85, hoehe: 1.15 },
  fence_stone: { form: 'circle', radius: 0.85, hoehe: 0.8 },
  lantern_post: { form: 'circle', radius: 0.4, hoehe: 3.15 },
  barrel: { form: 'circle', radius: 0.5, hoehe: 0.9 },
  crate: { form: 'circle', radius: 0.6, hoehe: 0.7 },
  hay_bale: { form: 'circle', radius: 0.7, hoehe: 1.1 },
  /*
   * Wegweiser und Banner stehen **nicht** im Weg. Beide sind Schilder auf
   * einem Pfahl, und beide stehen dort, wo man langläuft — ein Kreis darum
   * wäre auf einer schmalen Strasse eine Falle für den, der ihn nicht sieht.
   */
  signpost: { form: 'none', radius: 0.35, hoehe: 0 },
  banner: { form: 'none', radius: 0.35, hoehe: 0 },

  /*
   * --- Bewuchs: durch alles davon läuft man hindurch -----------------------
   *
   * Kraut, Blüten und Farn sind Bewuchs und kein Hindernis — ein Kreis um
   * jedes Grasbüschel machte aus einer Wiese ein Labyrinth aus unsichtbaren
   * Pfosten. Was hier einen Kreis hat, ist Holz: Wurzelstock, hohler Stumpf,
   * der liegende Stamm.
   */
  farn: { form: 'none', radius: 0.5, hoehe: 0 },
  schilf: { form: 'none', radius: 0.4, hoehe: 0 },
  rohrkolben: { form: 'none', radius: 0.4, hoehe: 0 },
  seerose: { form: 'none', radius: 0.5, hoehe: 0 },
  blume_weiss: { form: 'none', radius: 0.25, hoehe: 0 },
  blume_gelb: { form: 'none', radius: 0.25, hoehe: 0 },
  blume_blau: { form: 'none', radius: 0.25, hoehe: 0 },
  klee: { form: 'none', radius: 0.4, hoehe: 0 },
  distel: { form: 'none', radius: 0.35, hoehe: 0 },
  dornbusch: { form: 'none', radius: 0.55, hoehe: 0 },
  brombeere: { form: 'none', radius: 0.6, hoehe: 0 },
  beerenbusch: { form: 'none', radius: 0.5, hoehe: 0 },
  heidekraut: { form: 'none', radius: 0.35, hoehe: 0 },
  hochgras: { form: 'none', radius: 0.35, hoehe: 0 },
  getreide: { form: 'none', radius: 0.3, hoehe: 0 },
  setzling: { form: 'none', radius: 0.3, hoehe: 0 },
  efeu: { form: 'none', radius: 0.7, hoehe: 0 },
  /*
   * Der liegende Stamm ist vier Meter lang und trotzdem ein **Kreis**: das
   * Format kennt nur Kreis, Plattform und nichts. Der Kreis sitzt in der
   * Mitte, die Enden bleiben begehbar — man steigt also über das letzte
   * Stück drüber. Das ist der ehrlichere Fehler als ein Kreis über die volle
   * Länge, der einen zwei Meter neben dem Stamm anhalten liesse.
   */
  baumstamm_liegend: { form: 'circle', radius: 0.9, hoehe: 0.85 },
  wurzelstock: { form: 'circle', radius: 0.6, hoehe: 1.3 },
  hohler_stumpf: { form: 'circle', radius: 0.55, hoehe: 1.75 },
  astbruch: { form: 'none', radius: 0.8, hoehe: 0 },
  baumpilz: { form: 'none', radius: 0.3, hoehe: 0 },
  leuchtpilz: { form: 'none', radius: 0.4, hoehe: 0 },
  pilzring: { form: 'none', radius: 0.9, hoehe: 0 },

  // --- Stein ----------------------------------------------------------------
  kiesel: { form: 'none', radius: 0.4, hoehe: 0 },
  geroell: { form: 'none', radius: 0.9, hoehe: 0 },
  // Über eine Platte läuft man, nicht darum herum — sie liegt flach im Weg.
  steinplatte: { form: 'none', radius: 1.0, hoehe: 0 },
  felsblock: { form: 'circle', radius: 0.85, hoehe: 2.1 },
  felsnadel: { form: 'circle', radius: 0.55, hoehe: 4.7 },
  /*
   * Der Steinbogen steht **nicht** im Weg, obwohl er der grösste Stein hier
   * ist: seine Beine stehen fünf Meter auseinander, und ein Kreis darum
   * verschlösse genau den Durchgang, für den er gebaut ist. Dasselbe gilt
   * beim Torbogen der Portale.
   */
  steinbogen: { form: 'none', radius: 2.8, hoehe: 0 },
  hinkelstein: { form: 'circle', radius: 0.45, hoehe: 3.15 },
  steinmann: { form: 'circle', radius: 0.4, hoehe: 1.05 },
  erzader: { form: 'circle', radius: 1.1, hoehe: 1.7 },
  moosstein: { form: 'circle', radius: 0.85, hoehe: 0.95 },
  stalagmit: { form: 'circle', radius: 0.45, hoehe: 1.9 },
  // Der Stalaktit hängt an der Decke — dort läuft niemand.
  stalaktit: { form: 'none', radius: 0.4, hoehe: 0 },
  tropfsteinsaeule: { form: 'circle', radius: 0.5, hoehe: 5.2 },
  kristallgruppe: { form: 'none', radius: 0.6, hoehe: 0 },
  kristall_gross: { form: 'circle', radius: 0.7, hoehe: 4.1 },
  geode: { form: 'circle', radius: 0.9, hoehe: 1.5 },

  // --- Siedlung und Handwerk ------------------------------------------------
  marktstand: { form: 'circle', radius: 1.3, hoehe: 2.35 },
  markttisch: { form: 'circle', radius: 1.0, hoehe: 0.85 },
  handkarre: { form: 'circle', radius: 0.9, hoehe: 0.95 },
  planwagen: { form: 'circle', radius: 1.7, hoehe: 2.5 },
  wagenrad: { form: 'none', radius: 0.6, hoehe: 0 },
  holzstapel: { form: 'circle', radius: 0.8, hoehe: 1 },
  hackklotz: { form: 'circle', radius: 0.45, hoehe: 1.45 },
  amboss: { form: 'circle', radius: 0.45, hoehe: 0.75 },
  esse: { form: 'circle', radius: 0.9, hoehe: 3.2 },
  schleifstein: { form: 'circle', radius: 0.5, hoehe: 1.15 },
  wassertrog: { form: 'circle', radius: 0.9, hoehe: 0.55 },
  bank: { form: 'circle', radius: 0.9, hoehe: 0.9 },
  tisch: { form: 'circle', radius: 0.65, hoehe: 0.8 },
  hocker: { form: 'circle', radius: 0.3, hoehe: 0.5 },
  sackstapel: { form: 'circle', radius: 0.6, hoehe: 0.85 },
  korb: { form: 'circle', radius: 0.35, hoehe: 0.5 },
  kistenstapel: { form: 'circle', radius: 0.6, hoehe: 1.9 },
  tonkrug: { form: 'circle', radius: 0.35, hoehe: 1 },
  fackel: { form: 'circle', radius: 0.25, hoehe: 2.35 },
  feuerschale: { form: 'circle', radius: 0.5, hoehe: 0.65 },
  fahnenmast: { form: 'circle', radius: 0.3, hoehe: 4.85 },
  // Wie der Wegweiser: ein Zeichen am Weg, um das niemand herumlaufen soll.
  meilenstein: { form: 'none', radius: 0.3, hoehe: 0 },
  bildstock: { form: 'circle', radius: 0.45, hoehe: 2.95 },
  statue: { form: 'circle', radius: 0.8, hoehe: 3 },
  zierbrunnen: { form: 'circle', radius: 1.8, hoehe: 2.15 },
  torpfosten: { form: 'circle', radius: 0.4, hoehe: 2.9 },
  blumenkasten: { form: 'circle', radius: 0.6, hoehe: 0.7 },
  bienenkorb: { form: 'circle', radius: 0.45, hoehe: 1.05 },
  taubenschlag: { form: 'circle', radius: 0.35, hoehe: 3.65 },
  huehnerstall: { form: 'circle', radius: 0.9, hoehe: 1.15 },
  waescheleine: { form: 'none', radius: 0.5, hoehe: 0 },
  pflug: { form: 'circle', radius: 0.8, hoehe: 1.2 },
  // Auf dem Steg läuft man, und die Bohlen liegen auf Höhe des Ufers.
  steg: { form: 'none', radius: 2.0, hoehe: 0 },
  ruderboot: { form: 'circle', radius: 1.6, hoehe: 0.7 },
  fischgestell: { form: 'circle', radius: 1.1, hoehe: 1.8 },
  fischernetz: { form: 'none', radius: 1.1, hoehe: 0 },

  // --- Lager, Ruine, Gruft --------------------------------------------------
  lagerfeuer: { form: 'circle', radius: 0.8, hoehe: 0.75 },
  zelt: { form: 'circle', radius: 1.5, hoehe: 1.45 },
  schlafrolle: { form: 'none', radius: 0.9, hoehe: 0 },
  bratspiess: { form: 'circle', radius: 0.9, hoehe: 1.4 },
  waffenstaender: { form: 'circle', radius: 0.75, hoehe: 2.35 },
  // Wie das Zaunfeld — zwei Meter breit, Kreis in der Mitte.
  palisade: { form: 'circle', radius: 0.85, hoehe: 2.85 },
  spitzbarriere: { form: 'circle', radius: 1.1, hoehe: 1.45 },
  wachturm: { form: 'circle', radius: 1.6, hoehe: 6.75 },
  kaefig: { form: 'circle', radius: 0.85, hoehe: 2.35 },
  galgen: { form: 'circle', radius: 0.7, hoehe: 3.6 },
  knochenhaufen: { form: 'none', radius: 0.5, hoehe: 0 },
  schaedel: { form: 'none', radius: 0.25, hoehe: 0 },
  grabstein: { form: 'circle', radius: 0.45, hoehe: 1 },
  grabkreuz: { form: 'none', radius: 0.35, hoehe: 0 },
  sarkophag: { form: 'circle', radius: 1.3, hoehe: 1.15 },
  sarg: { form: 'circle', radius: 0.5, hoehe: 2.1 },
  urne: { form: 'circle', radius: 0.35, hoehe: 0.95 },
  altar: { form: 'circle', radius: 1.1, hoehe: 1.55 },
  runenstein: { form: 'circle', radius: 0.5, hoehe: 2.2 },
  saeule_bruch: { form: 'circle', radius: 0.6, hoehe: 1.95 },
  truemmer: { form: 'circle', radius: 0.7, hoehe: 0.65 },
  bogenrest: { form: 'circle', radius: 0.5, hoehe: 4.25 },
  kette: { form: 'none', radius: 0.3, hoehe: 0 },
  // Das Eisentor steht offen. Ein Kreis darin verschlösse den Gang.
  eisentor: { form: 'none', radius: 1.7, hoehe: 0 },
  wandfackel: { form: 'none', radius: 0.3, hoehe: 0 },
  spinnwebe: { form: 'none', radius: 0.8, hoehe: 0 },
  // Über die Treppe läuft man hinauf — der Kern kennt dafür das Höhenfeld.
  steintreppe: { form: 'none', radius: 1.5, hoehe: 0 },
  grabplatte: { form: 'none', radius: 1.2, hoehe: 0 },
  beinhaus: { form: 'circle', radius: 1.0, hoehe: 1.7 },
  opferschale: { form: 'circle', radius: 0.4, hoehe: 1.35 },
  wrack: { form: 'circle', radius: 1.4, hoehe: 2.8 },
};

/**
 * Was für ein Prop gilt, das die Tabelle nicht kennt.
 *
 * Ein neues Modell steht damit erst einmal nicht im Weg. Das ist die harmlose
 * Hälfte des Irrtums: durch einen Baum zu laufen fällt auf und wird
 * nachgetragen, während ein unsichtbarer Kreis mitten auf der Strasse wie ein
 * kaputtes Spiel aussieht und niemand weiss, woher er kommt.
 */
export const KOLLISION_VORGABE: PropKollision = { form: 'none', radius: 0.5, hoehe: 0 };

/** Die Kollision eines Modells, oder die Vorgabe. */
export function standardKollision(modell: string): PropKollision {
  return PROP_KOLLISION[modell] ?? KOLLISION_VORGABE;
}
