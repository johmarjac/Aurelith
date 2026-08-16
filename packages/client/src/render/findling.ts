/**
 * Findlinge — die Steine, die auf dem Boden liegen.
 *
 * Zwei Anläufe stehen hinter dieser Datei, und beide sind lehrreich:
 *
 *   1. Zuerst war es eine flachgedrückte Kugel mit `roughen`. Aus jeder
 *      Richtung derselbe Umriss, weiche Kanten, im Bild ein grauer Klumpen.
 *   2. Dann derselbe Körper wie beim schwebenden Felsen, nur gestürzt. Das war
 *      schlimmer: der oberste Ring dort ist die **Erdschicht** unter der
 *      Grasnarbe, und gestürzt lag die oben — ein beiges Brötchen mit einem
 *      Riss darin, denn auch die Bruchkante des Zapfens zeigte nach oben.
 *
 * Die Lehre daraus ist die Regel dieser Datei: **ein Findling ist kein
 * herausgebrochenes Stück Land.** Er hat keine Ober- und keine Unterseite, er
 * hat Facetten, und die machen ihn aus.
 *
 * Gebaut wird er deshalb aus einem Ikosaeder: zwanzig gleich grosse Dreiecke
 * auf einer Kugel, und jede Ecke wird nach aussen oder innen gezogen. Was
 * bleibt, sind grosse ebene Flächen mit scharfen Kanten dazwischen — genau
 * das, was einen Stein von einem Ballon unterscheidet. Ein Rauschen auf einer
 * feinen Kugel ergäbe stattdessen Diagrammpapier.
 *
 * Die Farbe kommt aus der Lage der Fläche und nicht aus dem Zufall: was nach
 * oben zeigt, hat Sonne und Flechten, was nach unten zeigt, liegt im Schatten.
 * Ein Stein mit gewürfelten Grautönen sieht verrauscht aus; einer mit heller
 * Oberseite sieht aus, als läge er da.
 */

import * as THREE from 'three';

/** Wiederholbarer Zufall — derselbe Stein bei jedem Start. */
function wuerfel(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a ^= a << 13;
    a >>>= 0;
    a ^= a >>> 17;
    a ^= a << 5;
    a >>>= 0;
    return a / 4294967296;
  };
}

/**
 * Grundton, Sonnenseite, Schattenseite, Flechte.
 *
 * Deutlich dunkler und kühler, als man beim Schreiben vermutet. Lichtmoor
 * leuchtet am Mittag mit `sunIntensity: 1.9` und einem Himmel von 1,2 dazu —
 * eine Fläche, die zur Sonne zeigt, bekommt also gut das Zweieinhalbfache. Der
 * erste Anlauf war ein warmes 0x94 und sah damit aus wie ein Gipsabdruck.
 *
 * Ein Stein ist ein **dunkles** Grau mit einem Stich ins Blaue; hell wird er
 * erst durch das Licht. Und der Stich ins Blaue ist das, was ihn vom Holz und
 * vom Lehm auf derselben Karte unterscheidet — die sind warm.
 */
const STEIN = 0x53555a;
const SONNE = 0x6a6c70;
const SCHATTEN = 0x3a3c40;
const FLECHTE = 0x55663e;

/** Mischt zwei Farben. */
function mische(a: number, b: number, t: number): number {
  const r = Math.round(((a >> 16) & 0xff) * (1 - t) + ((b >> 16) & 0xff) * t);
  const g = Math.round(((a >> 8) & 0xff) * (1 - t) + ((b >> 8) & 0xff) * t);
  const bl = Math.round((a & 0xff) * (1 - t) + (b & 0xff) * t);
  return (r << 16) | (g << 8) | bl;
}

/**
 * Ein Findling.
 *
 * `radius` ist der halbe Durchmesser in der Breite — nicht die Höhe: der Stein
 * wird flachgedrückt, denn ein Findling liegt, er steht nicht.
 */
export function baueFindling(radius: number, seed: number): THREE.BufferGeometry {
  const rand = wuerfel(seed);

  /*
   * Achtzig Flächen, auch beim kleinen Stein.
   *
   * Mit den zwanzig des blanken Ikosaeders war der Findling ein Kristall: bei
   * anderthalb Metern Breite ist eine einzelne Facette dann einen halben Meter
   * gross, und was man sieht, sind drei Flächen und eine scharfe Kante. Achtzig
   * Dreiecke kosten bei einem Prop, das instanziert gezeichnet wird, nichts,
   * das der Rede wert wäre — hundertfünfzig Steine auf einer Karte sind damit
   * zwölftausend Dreiecke.
   */
  const basis = new THREE.IcosahedronGeometry(1, 1);
  /*
   * Gleich zu Beginn schief stellen — **vor** allem anderen.
   *
   * Zwei Gründe, und der zweite kostete einen Anlauf:
   *
   *   1. Das Ikosaeder von three steht immer gleich: eine Ecke oben, eine
   *      unten, dazwischen zwei Fünferringe. Wird es in dieser Lage
   *      flachgedrückt, liegt der breiteste Punkt immer auf demselben
   *      waagerechten Ring — der Stein bekommt eine umlaufende Kante wie eine
   *      fliegende Untertasse.
   *   2. Die Farbe hängt unten an der Richtung der Fläche. Wird erst gefärbt
   *      und dann gedreht, trägt die Fläche, die jetzt oben liegt, die Farbe
   *      der Unterseite — und der Stein wird ein gleichmässiger grauer Klumpen
   *      ohne Sonnenseite.
   */
  basis.rotateX(rand() * Math.PI);
  basis.rotateY(rand() * Math.PI);
  basis.rotateZ(rand() * Math.PI);
  const pos = basis.attributes.position as THREE.BufferAttribute;

  /*
   * Der Ausschlag je **Richtung**, nicht je Vertex.
   *
   * Das Ikosaeder von three ist nicht indiziert: jede Ecke kommt so oft vor,
   * wie Flächen an ihr hängen. Würfelte man je Vertex, risse der Körper an
   * jeder Kante auf — man sähe durch die Ritzen hindurch. Der Schlüssel ist
   * deshalb die gerundete Richtung, und alle Kopien einer Ecke bekommen
   * denselben Wurf.
   */
  const ausschlag = new Map<string, number>();
  const zieh = (i: number): THREE.Vector3 => {
    const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    const schluessel = `${v.x.toFixed(3)}/${v.y.toFixed(3)}/${v.z.toFixed(3)}`;
    let f = ausschlag.get(schluessel);
    if (f === undefined) {
      f = 0.66 + rand() * 0.52;
      ausschlag.set(schluessel, f);
    }
    return v.multiplyScalar(radius * f);
  };

  const orte: number[] = [];
  const farben: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const kante1 = new THREE.Vector3();
  const kante2 = new THREE.Vector3();
  const normale = new THREE.Vector3();

  for (let i = 0; i < pos.count; i += 3) {
    a.copy(zieh(i));
    b.copy(zieh(i + 1));
    c.copy(zieh(i + 2));

    // Die Normale der Fläche — sie sagt, ob hier Sonne hinfällt.
    normale.copy(kante1.subVectors(b, a).cross(kante2.subVectors(c, a))).normalize();

    /*
     * Oben hell, unten dunkel, und oben manchmal Flechte.
     *
     * Der Faktor `0.5 + n.y * 0.5` läuft von 0 (Unterseite) bis 1 (Oberseite).
     * Ein Stein, dessen Flächen gewürfelte Grautöne tragen, sieht aus wie
     * Rauschen; einer, dessen Oberseite heller ist, sieht aus wie ein Stein im
     * Licht — und zwar auch dann, wenn im Spiel gerade Nacht ist und das Licht
     * die Form nicht mehr zeigt.
     */
    const hoch = 0.5 + normale.y * 0.5;
    let farbe = mische(SCHATTEN, SONNE, hoch);
    farbe = mische(farbe, STEIN, 0.4);
    // Flechte nur auf dem, was wirklich nach oben zeigt — an einer senkrechten
    // Wand wächst nichts, und ein grüner Fleck an der Flanke sieht aus wie ein
    // Fehler in der Textur.
    if (normale.y > 0.45 && rand() < 0.3) farbe = mische(farbe, FLECHTE, 0.35 + rand() * 0.3);

    const streu = 0.94 + rand() * 0.12;
    const rr = (((farbe >> 16) & 0xff) / 255) * streu;
    const gg = (((farbe >> 8) & 0xff) / 255) * streu;
    const bb = ((farbe & 0xff) / 255) * streu;
    for (const p of [a, b, c]) {
      orte.push(p.x, p.y, p.z);
      farben.push(rr, gg, bb);
    }
  }
  basis.dispose();

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(orte, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(farben, 3));

  // Flach und breit: ein Findling liegt, er steht nicht. Das Stauchen dreht die
  // Normalen nur weiter nach oben — die Sonnenseite bleibt die Sonnenseite.
  geo.scale(1, 0.46 + rand() * 0.16, 0.86 + rand() * 0.26);

  /*
   * Und ein Stück im Boden.
   *
   * Ein Stein, der genau auf der Grasnarbe aufsitzt, sieht aus, als hätte ihn
   * jemand hingelegt — und auf einem Hang schwebt er mit einer Kante in der
   * Luft. Ein Achtel der Höhe darunter, und er liegt da, seit es die Wiese
   * gibt. Das Gelände zieht `position[1]` auf seine Höhe (`snapToGround`), der
   * Rest ist die Verschiebung hier.
   */
  const kasten = new THREE.Box3().setFromBufferAttribute(
    geo.attributes.position as THREE.BufferAttribute,
  );
  const hoehe = kasten.max.y - kasten.min.y;
  geo.translate(0, -kasten.min.y - hoehe * 0.12, 0);

  // Flach schattiert: die Vertizes sind nicht geteilt, jedes Dreieck bekommt
  // damit seine eigene Normale — und genau die Kanten, wegen derer der Körper
  // aus einem Ikosaeder gebaut ist.
  geo.computeVertexNormals();
  return geo;
}
