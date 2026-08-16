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
  tree_pine: { form: 'circle', radius: 1.1 },
  tree_fir: { form: 'circle', radius: 1.0 },
  tree_broad: { form: 'circle', radius: 1.4 },
  tree_dead: { form: 'circle', radius: 0.9 },

  // --- Fels -----------------------------------------------------------------
  rock_small: { form: 'circle', radius: 0.85 },
  rock_large: { form: 'circle', radius: 2.0 },
  /*
   * Die schwebenden Felsen sind **Plattformen**: der Radius ist der der
   * begehbaren Scheibe und muss zu dem passen, mit dem `baueSchwebfels` sie
   * baut (9 und 5,5). Läuft das auseinander, steht man auf Luft oder stösst
   * an eine Kante, die man nicht sieht.
   */
  fels_schwebend: { form: 'plattform', radius: 9 },
  fels_schwebend_klein: { form: 'plattform', radius: 5.5 },

  // --- Bewuchs: alles, wodurch man hindurchläuft ----------------------------
  bush: { form: 'none', radius: 0.6 },
  grass_tuft: { form: 'none', radius: 0.3 },
  stump: { form: 'none', radius: 0.45 },
  mushroom_large: { form: 'none', radius: 0.45 },
  crystal: { form: 'none', radius: 0.5 },

  // --- Gebautes -------------------------------------------------------------
  pillar: { form: 'circle', radius: 1.1 },
  brazier: { form: 'circle', radius: 0.6 },
  well: { form: 'circle', radius: 2.2 },
  fence_wood: { form: 'circle', radius: 0.85 },
  fence_stone: { form: 'circle', radius: 0.85 },
  lantern_post: { form: 'circle', radius: 0.4 },
  barrel: { form: 'circle', radius: 0.5 },
  crate: { form: 'circle', radius: 0.6 },
  hay_bale: { form: 'circle', radius: 0.7 },
  /*
   * Wegweiser und Banner stehen **nicht** im Weg. Beide sind Schilder auf
   * einem Pfahl, und beide stehen dort, wo man langläuft — ein Kreis darum
   * wäre auf einer schmalen Strasse eine Falle für den, der ihn nicht sieht.
   */
  signpost: { form: 'none', radius: 0.35 },
  banner: { form: 'none', radius: 0.35 },
};

/**
 * Was für ein Prop gilt, das die Tabelle nicht kennt.
 *
 * Ein neues Modell steht damit erst einmal nicht im Weg. Das ist die harmlose
 * Hälfte des Irrtums: durch einen Baum zu laufen fällt auf und wird
 * nachgetragen, während ein unsichtbarer Kreis mitten auf der Strasse wie ein
 * kaputtes Spiel aussieht und niemand weiss, woher er kommt.
 */
export const KOLLISION_VORGABE: PropKollision = { form: 'none', radius: 0.5 };

/** Die Kollision eines Modells, oder die Vorgabe. */
export function standardKollision(modell: string): PropKollision {
  return PROP_KOLLISION[modell] ?? KOLLISION_VORGABE;
}
