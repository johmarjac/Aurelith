/**
 * Die Jugendlichen — Grundkörper im Flyff-Stil.
 *
 * Das ist **keine** kleinere Fassung der Figur aus `rigs.ts`. Die ist nach
 * menschlichem Mass gebaut: siebeneinhalb Köpfe hoch, Schultern doppelt so
 * breit wie der Kopf, Gesicht aus ein paar Kästchen. Wer sie schrumpft,
 * bekommt einen kleinen Erwachsenen und nicht das, was diesen Stil ausmacht.
 *
 * Ausschlaggebend sind vier Verhältnisse, und sie stehen weiter unten als
 * Zahlen:
 *
 *   1. **Der Kopf ist riesig.** Gut ein Viertel der Gesamthöhe, also gut vier
 *      Köpfe für die ganze Figur statt siebeneinhalb. Das allein macht neun
 *      Zehntel des Eindrucks.
 *   2. **Die Augen sind riesig.** Sie nehmen ein Drittel der Gesichtshöhe ein
 *      und stehen weit auseinander. Dazu Lidschatten oben, ein heller Punkt
 *      im Auge — ohne den ist es ein Knopf und kein Blick.
 *   3. **Der Körper ist schmal und kurz.** Schultern kaum breiter als der
 *      Kopf, Arme und Beine dünn, Hände und Füsse klein. Der Rumpf ist die
 *      kürzeste Strecke der Figur.
 *   4. **Keine Nase.** Eine Nase in diesem Stil ist ein Fehler; angedeutet
 *      wird sie höchstens als Schatten, und den kann eine Fläche nicht.
 *
 * Gebaut wird der **Grundkörper** — die Figur in Unterwäsche, so wie sie in
 * der Figurenerstellung dasteht, bevor irgendetwas angelegt ist. Alles, was
 * später darüberkommt, hängt an denselben Gelenken.
 *
 * Zwei Sorten, männlich und weiblich, aus einer Funktion: dieselben Gelenke,
 * dieselbe Bewegung, andere Zahlen für Schultern, Hüfte und Haar. Zwei
 * getrennte Bauer wären zweimal dieselbe Animation zu pflegen, und beim
 * nächsten Griff an den Schritt hätte man eine davon vergessen.
 */

import * as THREE from 'three';
import { assemble, box, cylinder, paint, rundeBox, sphere, type Part } from './geometry.ts';
import type { CharacterRig, RigState } from './rigs.ts';

/**
 * Das Mass aller Dinge: die Kopfhöhe.
 *
 * Alle Längen unten stehen in Vielfachen der **Figurenhöhe** und ergeben
 * zusammen gut vier Kopfhöhen. Wer an einer Zahl dreht, dreht am Verhältnis —
 * und das Verhältnis ist der Stil.
 */
export interface JugendConfig {
  kind: 'jugend';
  geschlecht: 'm' | 'w';
  /** Gesamthöhe in Metern, Haarspitze eingeschlossen. */
  height: number;
  skin: number;
  hair: number;
  /** Die Farbe der Iris. Das Weisse und der Glanzpunkt sind fest. */
  augen: number;
  /** Unterwäsche und ihr Besatz. */
  waesche: number;
  waescheTrim: number;
}

/** Dunkler oder heller — dieselbe Rechnung wie in `rigs.ts`. */
function schatten(farbe: number, faktor: number): number {
  const r = Math.min(255, Math.round(((farbe >> 16) & 0xff) * faktor));
  const g = Math.min(255, Math.round(((farbe >> 8) & 0xff) * faktor));
  const b = Math.min(255, Math.round((farbe & 0xff) * faktor));
  return (r << 16) | (g << 8) | b;
}

/**
 * Ein Gelenk: ein Drehpunkt mit einem Netz daran.
 *
 * `pivot` ist die Lage des Drehpunkts im Elternteil, `offset` die des Netzes
 * im Gelenk. Die Trennung ist der ganze Sinn: ein Oberarm dreht um die
 * Schulter, nicht um seine Mitte — läge das Netz im Drehpunkt, schwänge er um
 * seinen Bauchnabel.
 */
function gelenk(
  geometrie: THREE.BufferGeometry,
  material: THREE.Material,
  farbe: number,
  pivot: [number, number, number],
  offset: [number, number, number],
  muell: THREE.BufferGeometry[],
): THREE.Object3D {
  const halter = new THREE.Object3D();
  halter.position.set(...pivot);
  const netz = new THREE.Mesh(paint(geometrie, farbe), material);
  netz.position.set(...offset);
  halter.add(netz);
  muell.push(geometrie);
  return halter;
}

/**
 * Das Gesicht.
 *
 * Flache Plättchen dicht vor der Kopffläche, in dieser Reihenfolge von hinten
 * nach vorn: Augenweiss, Iris, Glanzpunkt. Jede Lage steht einen Millimeter
 * weiter vorn — dieselbe Ebene wäre ein Z-Kampf, und der flackert genau dann,
 * wenn die Kamera sich bewegt.
 *
 * Der Kopf blickt nach +Z.
 */
function gesicht(kopfTiefe: number, breite: number, augenFarbe: number): Part[] {
  const vorn = kopfTiefe * 0.5;
  /*
   * Gross, tief und weit auseinander.
   *
   * Alle drei Zahlen sind der Stil. Augen in der Mitte des Kopfes lesen sich
   * als erwachsen; erst wenn sie unterhalb der Mitte sitzen und ein gutes
   * Drittel der Gesichtsbreite einnehmen, entsteht der Eindruck, um den es
   * hier geht.
   */
  const augeX = breite * 0.24;
  const augeY = -breite * 0.05;
  const augeB = breite * 0.3;
  const augeH = breite * 0.42;

  const teile: Part[] = [];
  for (const seite of [-1, 1]) {
    // Das Weisse — hochkant und oben gerundet: ein liegendes Rechteck sieht
    // müde aus, ein stehendes wach. Genau daran hängt der Ausdruck.
    teile.push({
      geometry: rundeBox(augeB, augeH, 0.012, { rund: augeB * 0.42, oben: 0.92, seg: 2 }),
      color: 0xfdfbf7,
      position: [seite * augeX, augeY, vorn + 0.004],
    });
    // Die Iris, etwas tiefer sitzend und schmaler als das Weisse: darüber
    // bleibt ein heller Streifen stehen, und der macht den Blick offen.
    teile.push({
      geometry: rundeBox(augeB * 0.72, augeH * 0.62, 0.01, { rund: augeB * 0.3, seg: 2 }),
      color: augenFarbe,
      position: [seite * augeX, augeY - augeH * 0.1, vorn + 0.012],
    });
    // Die Pupille.
    teile.push({
      geometry: rundeBox(augeB * 0.34, augeH * 0.3, 0.008, { rund: augeB * 0.16, seg: 2 }),
      color: 0x1a1418,
      position: [seite * augeX, augeY - augeH * 0.12, vorn + 0.018],
    });
    /*
     * Der Glanzpunkt, oben links im Auge.
     *
     * Beide auf **derselben** Seite und nicht spiegelbildlich: ein Glanzpunkt
     * ist die Spiegelung derselben Lichtquelle, und die steht nicht zweimal
     * da. Gespiegelt sehen die Augen aus, als schielten sie.
     */
    teile.push({
      geometry: rundeBox(augeB * 0.22, augeB * 0.22, 0.006, { rund: augeB * 0.11, seg: 2 }),
      color: 0xffffff,
      position: [seite * augeX - augeB * 0.16, augeY + augeH * 0.16, vorn + 0.024],
    });
    // Der Lidschatten: ein dunkler Balken auf der Oberkante des Auges. Er
    // ersetzt die Wimpern, die als Geometrie zu dünn wären, um zu tragen.
    teile.push({
      geometry: box(augeB * 1.04, augeH * 0.12, 0.01),
      color: 0x2a2026,
      position: [seite * augeX, augeY + augeH * 0.45, vorn + 0.014],
    });
  }

  // Der Mund: ein kurzer Strich, tief im Gesicht. Alles darüber wäre ein
  // Grinsen, und ein Grundkörper soll neutral dastehen.
  teile.push({
    geometry: rundeBox(breite * 0.13, breite * 0.03, 0.01, { rund: breite * 0.014, seg: 1 }),
    color: 0x9a5f58,
    position: [0, -breite * 0.36, vorn + 0.004],
  });

  return teile;
}

/**
 * Das Haar.
 *
 * Es ist in diesem Stil kein Detail, sondern die halbe Silhouette — und der
 * einzige Teil, an dem man männlich und weiblich schon aus dreissig Metern
 * unterscheidet. Deshalb steht es hier ausführlich und nicht als Kappe mit
 * einem Wurf Zufall darüber.
 */
function haare(
  weiblich: boolean,
  kopfB: number,
  kopfH: number,
  kopfT: number,
  farbe: number,
): Part[] {
  const dunkel = schatten(farbe, 0.82);
  const teile: Part[] = [
    // Die Kappe: etwas grösser als der Kopf und nach oben gewölbt. Sie sitzt
    // hoch, damit unten die Stirn frei bleibt.
    {
      // Eine Kuppe und kein Deckel: dieselbe starke Rundung wie der Kopf
      // darunter, sonst sitzt ein Kasten auf einem Ei.
      geometry: rundeBox(kopfB * 1.07, kopfH * 0.66, kopfT * 1.07, {
        rund: kopfB * 0.4,
        unten: 1.02,
        oben: 0.9,
        seg: 4,
      }),
      color: farbe,
      position: [0, kopfH * 0.25, -kopfT * 0.02],
    },
  ];

  /*
   * Der Pony — drei Strähnen über der Stirn, ungleich lang.
   *
   * Gleich lange Strähnen ergeben einen Topfschnitt, und der ist das Einzige,
   * was in diesem Stil sofort billig aussieht. Die mittlere ist die kürzeste,
   * damit das Gesicht frei bleibt.
   */
  const ponyLagen: Array<[number, number, number]> = weiblich
    ? [
        [-0.3, 0.5, 0.22],
        [0.0, 0.42, 0.18],
        [0.3, 0.54, 0.24],
      ]
    : [
        [-0.28, 0.42, 0.3],
        [0.02, 0.34, 0.26],
        [0.3, 0.46, 0.32],
      ];
  for (const [x, laenge, breite] of ponyLagen) {
    teile.push({
      geometry: rundeBox(kopfB * breite, kopfH * laenge, kopfT * 0.24, {
        rund: kopfB * 0.06,
        unten: 0.55,
        seg: 2,
      }),
      color: farbe,
      position: [kopfB * x, kopfH * (0.32 - laenge * 0.42), kopfT * 0.46],
      rotation: [0.12, x * 0.5, x * 0.35],
    });
  }

  // Die Seitensträhnen: sie fallen an den Wangen herunter und rahmen das
  // Gesicht. Beim Mädchen länger — das ist der halbe Unterschied.
  const seitenLaenge = weiblich ? 1.15 : 0.5;
  for (const seite of [-1, 1]) {
    teile.push({
      geometry: rundeBox(kopfB * 0.2, kopfH * seitenLaenge, kopfT * 0.34, {
        rund: kopfB * 0.07,
        unten: 0.6,
        seg: 2,
      }),
      color: farbe,
      position: [seite * kopfB * 0.5, kopfH * (0.22 - seitenLaenge * 0.46), kopfT * 0.12],
      rotation: [0, 0, seite * 0.07],
    });
  }

  // Hinten: beim Jungen ein kurzer Nacken, beim Mädchen eine lange Masse bis
  // zwischen die Schulterblätter.
  const hintenLaenge = weiblich ? 1.5 : 0.42;
  teile.push({
    geometry: rundeBox(kopfB * 0.82, kopfH * hintenLaenge, kopfT * 0.42, {
      rund: kopfB * 0.14,
      unten: weiblich ? 0.7 : 0.5,
      seg: 3,
    }),
    color: dunkel,
    position: [0, kopfH * (0.2 - hintenLaenge * 0.46), -kopfT * 0.42],
  });

  if (!weiblich) {
    /*
     * Zwei Spitzen oben — die eine Zutat, ohne die eine männliche Frisur in
     * diesem Stil wie ein Helm aussieht. Schräg gestellt und ungleich gross:
     * zwei gleiche Hörner wären ein Muster.
     */
    teile.push({
      geometry: rundeBox(kopfB * 0.2, kopfH * 0.34, kopfT * 0.22, { rund: kopfB * 0.05, oben: 0.3, seg: 2 }),
      color: farbe,
      position: [kopfB * 0.16, kopfH * 0.52, kopfT * 0.18],
      rotation: [-0.5, 0.2, -0.25],
    });
    teile.push({
      geometry: rundeBox(kopfB * 0.16, kopfH * 0.26, kopfT * 0.18, { rund: kopfB * 0.04, oben: 0.3, seg: 2 }),
      color: farbe,
      position: [-kopfB * 0.22, kopfH * 0.5, kopfT * 0.1],
      rotation: [-0.4, -0.3, 0.3],
    });
  } else {
    // Ein Band im Haar. Es sitzt quer über der Kappe und gibt der weiblichen
    // Frisur einen Punkt, an dem das Auge hängenbleibt.
    teile.push({
      geometry: rundeBox(kopfB * 0.86, kopfH * 0.05, kopfT * 0.3, { rund: kopfB * 0.02, seg: 2 }),
      color: 0xd8607e,
      position: [0, kopfH * 0.44, kopfT * 0.2],
      rotation: [0.2, 0, 0],
    });
  }

  return teile;
}

/**
 * Baut einen Jugendlichen.
 *
 * Alle Längen kommen aus `h`, der Gesamthöhe: die Figur lässt sich damit
 * grösser oder kleiner stellen, ohne dass ein Verhältnis kippt. Genau das ist
 * der Zweck — ein Modell, das nur in einer Grösse stimmt, ist kein Modell,
 * sondern ein Bild.
 */
export function baueJugend(cfg: JugendConfig, material: THREE.Material): CharacterRig {
  const muell: THREE.BufferGeometry[] = [];
  const weiblich = cfg.geschlecht === 'w';
  const h = cfg.height;

  /*
   * Die Verhältnisse.
   *
   * Der Kopf ist 0,26 der Gesamthöhe — knapp vier Köpfe für die ganze Figur.
   * Zum Vergleich: die erwachsene Figur in `rigs.ts` kommt auf 0,13, also
   * siebeneinhalb. Diese eine Zahl ist der Unterschied zwischen den beiden
   * Stilen; alles andere folgt ihr.
   */
  const kopfH = h * 0.25;
  const kopfB = kopfH * 0.96;
  const kopfT = kopfH * 0.92;

  /*
   * Die Aufteilung nach oben, und sie geht **auf**.
   *
   * Beine 0,46 h, Rumpf 0,31 h — der Hals sitzt damit bei 0,77 h, und was
   * darüber kommt, ist Kopf samt Haar. Beim ersten Anlauf standen hier Zahlen,
   * die zusammen nur 0,9 h ergaben: die Figur war anderthalb statt der
   * verlangten anderthalb Meter, und wer sie auf Augenhöhe eines NPCs stellen
   * wollte, hätte sich gewundert. Der Test misst deshalb den umschliessenden
   * Kasten gegen `height`.
   */
  const beinLaenge = h * 0.44;
  const hueftY = beinLaenge;
  const rumpfH = h * 0.26;
  const schulterY = hueftY + rumpfH * 0.88;
  const halsY = hueftY + rumpfH;
  /*
   * Der Kopf sitzt **auf** den Schultern, nicht über ihnen.
   *
   * `0.36` statt der halben Kopfhöhe: das Kinn taucht damit ein Stück hinter
   * dem Schlüsselbein ein, und ein Hals ist praktisch nicht mehr zu sehen.
   * Genau das unterscheidet diesen Stil von einer geschrumpften erwachsenen
   * Figur — dort war ein Hals zu sehen, und der liess die Figur sofort wie
   * eine Gliederpuppe aussehen.
   */
  const kopfY = halsY + kopfH * 0.46;

  // Schultern rund anderthalb Kopfbreiten — beim Mädchen etwas schmaler, dafür
  // die Hüfte breiter. Mehr Unterschied als das braucht es nicht.
  const schulterX = kopfB * (weiblich ? 0.62 : 0.72);
  const hueftX = kopfB * (weiblich ? 0.5 : 0.44);
  const armLaenge = h * 0.27;
  /*
   * Die Dicke der Glieder.
   *
   * Deutlich mehr, als „schlank" vermuten lässt. Der erste Anlauf hatte Arme
   * von fünf Zentimetern, und die Figur sah aus wie eine Gliederpuppe aus dem
   * Zeichenbedarf: in diesem Stil sind die Glieder zwar dünn im Verhältnis zum
   * Kopf, aber sie haben Volumen. Ein Arm ist gut ein Drittel so dick wie der
   * Kopf breit ist.
   */
  const gliedD = kopfB * (weiblich ? 0.28 : 0.32);

  const root = new THREE.Object3D();
  const koerper = new THREE.Object3D();
  root.add(koerper);

  const haut = cfg.skin;
  const hautDunkel = schatten(haut, 0.94);

  // --- Rumpf, Hals, Kopf ---------------------------------------------------
  //
  // Ein Stück: sie bewegen sich nie gegeneinander. Der Kopf dreht in diesem
  // Rig nicht eigenständig — wer in diesem Stil den Kopf einzeln dreht,
  // bekommt einen Hals zu sehen, den es gar nicht gibt.
  const rumpfTeile: Part[] = [
    /*
     * Der Brustkorb.
     *
     * Oben breiter als unten, und beim Mädchen weniger stark: eine
     * ausgeprägte V-Form liest sich als erwachsener Mann. Die Taille sitzt
     * hoch, weil der Rumpf insgesamt kurz ist.
     */
    {
      geometry: rundeBox(schulterX * 2 * 0.86, rumpfH * 0.62, gliedD * 2.1, {
        oben: weiblich ? 1.0 : 1.08,
        unten: weiblich ? 0.86 : 0.8,
        rund: gliedD * 0.5,
        seg: 3,
      }),
      color: haut,
      position: [0, hueftY + rumpfH * 0.66, 0],
    },
    // Bauch und Becken — schmaler als die Brust, beim Mädchen etwas breiter
    // als bei ihm. Mehr Unterschied als das braucht es nicht.
    {
      geometry: rundeBox(hueftX * 2 * 1.1, rumpfH * 0.44, gliedD * 1.9, {
        oben: 0.92,
        unten: weiblich ? 1.06 : 0.98,
        rund: gliedD * 0.45,
        seg: 3,
      }),
      color: haut,
      position: [0, hueftY + rumpfH * 0.2, 0],
    },
    // Schulterkugeln: sie schliessen die Lücke zwischen Rumpf und Arm. Der
    // Arm dreht **in** ihnen, nicht mit ihnen — sonst klafft es beim Schwung.
    {
      geometry: sphere(gliedD * 0.62, 1),
      color: haut,
      position: [schulterX, schulterY, 0],
    },
    {
      geometry: sphere(gliedD * 0.62, 1),
      color: haut,
      position: [-schulterX, schulterY, 0],
    },
    // Der Hals — kaum mehr als ein Zapfen. Er soll den Übergang füllen, nicht
    // sichtbar sein: siehe die Lage des Kopfes weiter oben.
    {
      geometry: cylinder(gliedD * 0.62, gliedD * 0.7, rumpfH * 0.1, 8),
      color: hautDunkel,
      position: [0, halsY - rumpfH * 0.02, 0],
    },
    /*
     * Der Kopf.
     *
     * Nach unten schmaler — das ist das Kinn, und ohne die Verjüngung sitzt
     * ein Würfel auf dem Hals. Nach hinten etwas tiefer als breit, damit er
     * von der Seite nicht rund wirkt.
     */
    {
      /*
       * Rund, nicht kastig.
       *
       * `rund` bei 0,42 der Breite heisst: von der ebenen Fläche bleibt kaum
       * etwas übrig, der Kopf ist fast ein Ei. Mit einem Viertel sah er aus
       * wie eine Schachtel mit gebrochenen Kanten — und das ist der Eindruck,
       * an dem dieser Stil am ehesten scheitert.
       */
      geometry: rundeBox(kopfB, kopfH, kopfT, { oben: 0.94, unten: 0.7, rund: kopfB * 0.42, seg: 5 }),
      color: haut,
      position: [0, kopfY, 0],
    },
    // Die Ohren: zwei kleine Scheiben. Sie verschwinden beim Mädchen fast
    // unter dem Haar und sind trotzdem da — fehlen sie, sieht der Kopf von
    // vorn richtig und von der Seite kahl aus.
    {
      geometry: rundeBox(kopfB * 0.06, kopfH * 0.16, kopfT * 0.14, { rund: kopfB * 0.03, seg: 2 }),
      color: haut,
      position: [kopfB * 0.5, kopfY - kopfH * 0.02, -kopfT * 0.04],
    },
    {
      geometry: rundeBox(kopfB * 0.06, kopfH * 0.16, kopfT * 0.14, { rund: kopfB * 0.03, seg: 2 }),
      color: haut,
      position: [-kopfB * 0.5, kopfY - kopfH * 0.02, -kopfT * 0.04],
    },
  ];

  /*
   * Die Unterwäsche.
   *
   * Sie sitzt am **Rumpf** und nicht an den Beinen. Das ist keine
   * Kleinigkeit: die Beine drehen sich beim Laufen um die Hüfte, und ein
   * Bund, der mitdreht, läuft in zwei Hälften auseinander, sobald die Figur
   * einen Schritt macht. Dieselbe Regel wie bei der erwachsenen Figur.
   */
  rumpfTeile.push({
    geometry: rundeBox(hueftX * 2 * 1.2, rumpfH * 0.44, gliedD * 1.9, {
      oben: 0.94,
      unten: 1.04,
      rund: gliedD * 0.35,
      seg: 3,
    }),
    color: cfg.waesche,
    position: [0, hueftY + rumpfH * 0.08, 0],
  });
  rumpfTeile.push({
    geometry: box(hueftX * 2 * 1.16, rumpfH * 0.028, gliedD * 1.88),
    color: cfg.waescheTrim,
    position: [0, hueftY + rumpfH * 0.27, 0],
  });

  if (weiblich) {
    // Ein schlichtes Band als Oberteil, mit demselben Besatz wie unten. Zwei
    // Teile, die sichtbar zusammengehören — daran erkennt man Unterwäsche und
    // nicht an dem, was sie bedeckt.
    rumpfTeile.push({
      // Etwas **breiter** als der Rumpf darunter: ein Kleidungsstück liegt auf
      // dem Körper, es steckt nicht darin. Gleich breit gezeichnet sieht es
      // aus wie ein aufgemalter Streifen, und genau so sah es aus.
      geometry: rundeBox(schulterX * 2 * 0.92, rumpfH * 0.24, gliedD * 2.28, {
        oben: 1.0,
        unten: 0.98,
        rund: gliedD * 0.45,
        seg: 3,
      }),
      color: cfg.waesche,
      position: [0, hueftY + rumpfH * 0.76, 0],
    });
    /*
     * Der Besatz ist ein **Strich**, kein Balken.
     *
     * Beim ersten Anlauf war er dreimal so dick, dazu kamen zwei klotzige
     * Träger über die Schultern — und die Figur trug drei rosa Querstreifen
     * quer über den Rumpf. Was Unterwäsche kenntlich macht, ist ihre
     * Zurückhaltung: eine Kante oben, dieselbe Farbe unten, fertig.
     */
    rumpfTeile.push({
      geometry: box(schulterX * 2 * 0.93, rumpfH * 0.022, gliedD * 2.3),
      color: cfg.waescheTrim,
      position: [0, hueftY + rumpfH * 0.65, 0],
    });
  }

  /*
   * Gesicht und Haar sitzen am **Kopf** — und werden deshalb gemeinsam um
   * `kopfY` gehoben.
   *
   * Beides rechnet in Kopfkoordinaten, also mit dem Ursprung in der Mitte des
   * Kopfes. Genau das ist einmal schiefgegangen: das Haar wurde gehoben, das
   * Gesicht nicht — Augen und Mund lagen dann zwischen den Füssen, und weil
   * sie klein und dunkel sind, sah es aus, als hätte die Figur etwas verloren.
   * Ein gemeinsamer Schritt kann diesen Fehler nicht mehr machen.
   */
  for (const teil of [
    ...gesicht(kopfT, kopfB, cfg.augen),
    ...haare(weiblich, kopfB, kopfH, kopfT, cfg.hair),
  ]) {
    rumpfTeile.push({
      ...teil,
      position: [
        teil.position?.[0] ?? 0,
        (teil.position?.[1] ?? 0) + kopfY,
        teil.position?.[2] ?? 0,
      ] as [number, number, number],
    });
  }

  const rumpfGeo = assemble(rumpfTeile);
  koerper.add(new THREE.Mesh(rumpfGeo, material));
  muell.push(rumpfGeo);

  // --- Arme ----------------------------------------------------------------
  //
  // Zwei Glieder je Arm, damit sich der Ellbogen beugen kann. Der Unterarm
  // hängt **im** Oberarm: dreht der Oberarm, wandert der Ellbogen mit.
  const armOben = armLaenge * 0.52;
  const armUnten = armLaenge * 0.48;
  const armR = gelenk(
    rundeBox(gliedD * 0.78, armOben, gliedD * 0.78, { oben: 1.05, unten: 0.82, rund: gliedD * 0.34, seg: 3 }),
    material,
    haut,
    [schulterX, schulterY, 0],
    [0, -armOben * 0.5, 0],
    muell,
  );
  const armL = gelenk(
    rundeBox(gliedD * 0.78, armOben, gliedD * 0.78, { oben: 1.05, unten: 0.82, rund: gliedD * 0.34, seg: 3 }),
    material,
    haut,
    [-schulterX, schulterY, 0],
    [0, -armOben * 0.5, 0],
    muell,
  );
  koerper.add(armR, armL);

  const ellbogenR = gelenk(
    rundeBox(gliedD * 0.66, armUnten, gliedD * 0.66, { oben: 1.02, unten: 0.86, rund: gliedD * 0.3, seg: 3 }),
    material,
    haut,
    [0, -armOben, 0],
    [0, -armUnten * 0.5, 0],
    muell,
  );
  const ellbogenL = gelenk(
    rundeBox(gliedD * 0.66, armUnten, gliedD * 0.66, { oben: 1.02, unten: 0.86, rund: gliedD * 0.3, seg: 3 }),
    material,
    haut,
    [0, -armOben, 0],
    [0, -armUnten * 0.5, 0],
    muell,
  );
  armR.add(ellbogenR);
  armL.add(ellbogenL);

  /*
   * Kugeln in den Ellbogen.
   *
   * Zwei Zylinder, die aneinanderstossen, klaffen auf, sobald das Gelenk sich
   * beugt — man sieht durch die Figur hindurch. Eine Kugel im Drehpunkt füllt
   * die Lücke in **jeder** Stellung, und sie kostet zwei Dutzend Dreiecke.
   * Beim ersten Anlauf fehlte sie, und die Arme sahen aus wie die einer
   * Gliederpuppe aus dem Zeichenbedarf.
   */
  for (const arm of [armR, armL]) {
    const geo = sphere(gliedD * 0.37, 1);
    const kugel = new THREE.Mesh(paint(geo, haut), material);
    kugel.position.y = -armOben;
    arm.add(kugel);
    muell.push(geo);
  }

  // Die Hände: kleine Kugeln. In diesem Stil sind Finger nicht nur zu teuer,
  // sie wären auch falsch — die Vorlage hat Fäustlinge.
  for (const [arm, seite] of [
    [ellbogenR, 1],
    [ellbogenL, -1],
  ] as Array<[THREE.Object3D, number]>) {
    const geo = sphere(gliedD * 0.52, 1);
    const hand = new THREE.Mesh(paint(geo, haut), material);
    hand.position.set(seite * gliedD * 0.02, -armUnten - gliedD * 0.2, 0);
    hand.scale.set(1, 1.15, 0.9);
    arm.add(hand);
    muell.push(geo);
  }

  // --- Beine ---------------------------------------------------------------
  const oberschenkel = beinLaenge * 0.52;
  const unterschenkel = beinLaenge * 0.48;
  const beinD = gliedD * (weiblich ? 0.92 : 0.96);

  const beinR = gelenk(
    rundeBox(beinD * 1.08, oberschenkel, beinD * 1.08, { oben: 1.06, unten: 0.8, rund: beinD * 0.34, seg: 3 }),
    material,
    haut,
    [hueftX, hueftY, 0],
    [0, -oberschenkel * 0.5, 0],
    muell,
  );
  const beinL = gelenk(
    rundeBox(beinD * 1.08, oberschenkel, beinD * 1.08, { oben: 1.06, unten: 0.8, rund: beinD * 0.34, seg: 3 }),
    material,
    haut,
    [-hueftX, hueftY, 0],
    [0, -oberschenkel * 0.5, 0],
    muell,
  );
  koerper.add(beinR, beinL);

  const knieR = gelenk(
    rundeBox(beinD * 0.9, unterschenkel, beinD * 0.9, { oben: 1.04, unten: 0.76, rund: beinD * 0.3, seg: 3 }),
    material,
    haut,
    [0, -oberschenkel, 0],
    [0, -unterschenkel * 0.5, 0],
    muell,
  );
  const knieL = gelenk(
    rundeBox(beinD * 0.9, unterschenkel, beinD * 0.9, { oben: 1.04, unten: 0.76, rund: beinD * 0.3, seg: 3 }),
    material,
    haut,
    [0, -oberschenkel, 0],
    [0, -unterschenkel * 0.5, 0],
    muell,
  );
  beinR.add(knieR);
  beinL.add(knieL);

  // Dieselben Kugeln in den Knien, aus demselben Grund.
  for (const bein of [beinR, beinL]) {
    const geo = sphere(beinD * 0.42, 1);
    const kugel = new THREE.Mesh(paint(geo, haut), material);
    kugel.position.y = -oberschenkel;
    bein.add(kugel);
    muell.push(geo);
  }

  /*
   * Und die Beine der Hose — an den **Oberschenkeln**, nicht am Rumpf.
   *
   * Umgekehrt wie beim Bund, und aus demselben Grund: was mit dem Bein
   * mitgehen soll, gehört ans Bein. Ein Hosenbein am Rumpf bliebe beim
   * Schritt stehen, während das Bein daraus hervorschiebt.
   */
  for (const bein of [beinR, beinL]) {
    const geo = rundeBox(beinD * 1.16, oberschenkel * 0.5, beinD * 1.16, {
      oben: 1.0,
      unten: 1.06,
      rund: beinD * 0.3,
      seg: 2,
    });
    const stulpe = new THREE.Mesh(paint(geo, cfg.waesche), material);
    stulpe.position.y = -oberschenkel * 0.22;
    bein.add(stulpe);
    muell.push(geo);
  }

  // Die Füsse. Klein und nach vorn gerichtet — barfuss, denn Schuhe sind
  // Ausrüstung und gehören nicht an den Grundkörper.
  for (const knie of [knieR, knieL]) {
    const geo = rundeBox(beinD * 1.02, beinD * 0.56, beinD * 1.7, { rund: beinD * 0.22, seg: 2 });
    const fuss = new THREE.Mesh(paint(geo, haut), material);
    fuss.position.set(0, -unterschenkel - beinD * 0.2, beinD * 0.3);
    knie.add(fuss);
    muell.push(geo);
  }

  /*
   * Zum Schluss auf die verlangte Höhe bringen.
   *
   * Die Masse oben sind Verhältnisse, und Verhältnisse summieren sich nicht
   * von selbst zu eins: Haar und Füsse ragen über die gerechneten Grenzen
   * hinaus, der Kopf taucht in die Schultern ein. Beim ersten Anlauf kam eine
   * Figur von 1,37 m heraus, wo 1,52 m stehen sollten — und wer sie neben
   * einen NPC stellt, sieht den Unterschied sofort.
   *
   * Statt die Zahlen nachzujustieren, bis sie zufällig aufgehen — und beim
   * nächsten Griff ans Haar wieder auseinanderzulaufen —, wird hier einmal
   * gemessen und skaliert. `height` heisst damit wirklich Höhe.
   */
  root.updateMatrixWorld(true);
  const kasten = new THREE.Box3().setFromObject(root);
  const istHoehe = kasten.max.y - kasten.min.y;
  if (istHoehe > 1e-4) root.scale.setScalar(h / istHoehe);

  // -------------------------------------------------------------------------
  // Bewegung
  // -------------------------------------------------------------------------

  /*
   * Fortgeschriebene Schrittphase — nicht `time * frequenz`.
   *
   * Dieselbe Falle wie bei allen anderen Rigs: eine aus der absoluten Uhr
   * gerechnete Phase springt bei jedem Tempowechsel um `time * Δfrequenz`,
   * und nach einer halben Stunde Spielzeit stehen die Beine von einem Bild
   * aufs nächste irgendwo.
   */
  let schrittPhase = 0;

  return {
    root,
    update(state: RigState) {
      if (state.dead) {
        // Nach vorn umfallen, wie die erwachsene Figur. Der Kadaver bleibt bis
        // zum Respawn liegen — siehe `rigLage` in der Weltansicht, die ihn
        // danach in Ruhe lässt.
        root.rotation.x = -Math.PI / 2.2;
        koerper.position.y = 0;
        return;
      }
      root.rotation.x = 0;

      const gang = Math.min(1, state.speed / 5);
      schrittPhase += state.dt * 10 * Math.max(0.35, gang);
      const schritt = Math.sin(schrittPhase);

      /*
       * Der Schwung ist gross.
       *
       * Bei kurzen Beinen und einem schweren Kopf sieht ein zurückhaltender
       * Gang aus wie Schleichen: die Strecke, die ein Bein zurücklegt, ist
       * absolut klein, und was man wahrnimmt, ist der **Winkel**. Deshalb
       * knapp fünfzig Grad statt der fünfunddreissig der erwachsenen Figur.
       */
      const beinSchwung = schritt * 0.85 * gang;
      const armSchwung = -schritt * 0.7 * gang;

      let armRechts = armSchwung;
      let armLinks = -armSchwung;
      let ellbogenRechtsX = -0.12 - Math.max(0, schritt) * 0.35 * gang;
      let ellbogenLinksX = -0.12 - Math.max(0, -schritt) * 0.35 * gang;
      let armRechtsZ = 0.12;
      let armLinksZ = -0.12;
      let rumpfDrehung = 0;
      let rumpfKippung = 0;
      let knieRechts = Math.max(0, -schritt) * 0.7 * gang;
      let knieLinks = Math.max(0, schritt) * 0.7 * gang;

      // --- Bücken -----------------------------------------------------------
      const beugung = state.pickupPhase >= 0 ? Math.sin(state.pickupPhase * Math.PI) : 0;
      if (beugung > 0) {
        armRechts = beugung * 1.6;
        armLinks = -beugung * 0.4;
        ellbogenRechtsX = -0.1 - beugung * 0.3;
        knieRechts += beugung * 0.8;
        knieLinks += beugung * 0.8;
        rumpfKippung += beugung * 0.9;
      }

      /*
       * --- Schlagen ---------------------------------------------------------
       *
       * Ein Hieb von oben, nicht von der Seite: er ist aus jeder Kameralage zu
       * erkennen. Der Rumpf dreht mit — ein Arm, der allein ausholt, sieht aus,
       * als winke die Figur.
       */
      if (state.attackPhase >= 0) {
        const p = state.attackPhase;
        // Ausholen bis 0,35, dann durchziehen. Die Grenze ist nicht die Mitte:
        // ein Schlag ist hinten langsam und vorne schnell.
        const aus = Math.min(1, p / 0.35);
        const durch = Math.max(0, (p - 0.35) / 0.65);
        armRechts = -2.2 * aus + 3.1 * durch;
        armRechtsZ = 0.12 + 0.5 * aus - 0.35 * durch;
        ellbogenRechtsX = -0.9 * aus + 0.8 * durch;
        armLinks = 0.5 * aus - 0.8 * durch;
        rumpfDrehung = -0.5 * aus + 0.9 * durch;
        rumpfKippung = 0.1 * durch;
      }

      // --- Wirbeln ----------------------------------------------------------
      const wirbel = state.wirbelPhase ?? -1;
      if (wirbel >= 0) {
        armRechts = -0.2;
        armLinks = -0.2;
        armRechtsZ = 1.35;
        armLinksZ = -1.35;
        ellbogenRechtsX = -0.1;
        ellbogenLinksX = -0.1;
        rumpfDrehung += wirbel * Math.PI * 2;
      }

      armR.rotation.set(armRechts, 0, armRechtsZ);
      armL.rotation.set(armLinks, 0, armLinksZ);
      ellbogenR.rotation.x = ellbogenRechtsX;
      ellbogenL.rotation.x = ellbogenLinksX;

      koerper.rotation.y = rumpfDrehung;
      // Der Rumpf kippt, die Beine halten dagegen — sonst fällt die ganze
      // Figur wie ein Brett nach vorn, statt sich zu bücken.
      koerper.rotation.x = rumpfKippung;
      beinR.rotation.x = beinSchwung - rumpfKippung * 0.85;
      beinL.rotation.x = -beinSchwung - rumpfKippung * 0.85;
      knieR.rotation.x = knieRechts;
      knieL.rotation.x = knieLinks;

      /*
       * Wippen und Atmen.
       *
       * Bei einem Kopf von einem Viertel der Körperhöhe ist jedes Auf und Ab
       * doppelt so gut zu sehen wie bei der erwachsenen Figur — also fällt es
       * kleiner aus. Ein stehendes Modell ohne Atem sieht trotzdem aus wie ein
       * Möbelstück, deshalb bleibt es.
       */
      koerper.position.y =
        Math.abs(Math.sin(schrittPhase)) * 0.03 * h * gang +
        Math.sin(state.time * 1.9) * 0.006 * h -
        beugung * 0.12 * h -
        Math.min(knieLinks, knieRechts) * 0.09 * h;
    },
    dispose() {
      for (const g of muell) g.dispose();
    },
  };
}
