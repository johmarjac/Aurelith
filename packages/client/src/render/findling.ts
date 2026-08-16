/**
 * Findlinge — die Steine, die auf dem Boden liegen.
 *
 * Drei Anläufe stehen hinter dieser Datei, und jeder hat etwas beigebracht:
 *
 *   1. Eine flachgedrückte Kugel mit `roughen`. Aus jeder Richtung derselbe
 *      Umriss, weiche Kanten, im Bild ein grauer Klumpen.
 *   2. Derselbe Körper wie beim schwebenden Felsen, nur gestürzt. Schlimmer:
 *      der oberste Ring dort ist die **Erdschicht** unter der Grasnarbe, und
 *      gestürzt lag die oben — ein beiges Brötchen mit einem Riss darin.
 *   3. Ein Ikosaeder mit einzeln herausgezogenen Ecken, flach schattiert. Die
 *      Form stimmte endlich, aber zwanzig bis achtzig grosse ebene Flächen
 *      lesen sich als **geschliffener** Stein: ein Kristall, kein Findling.
 *
 * Daraus die Regel dieser Datei: **die Unruhe gehört ins Bild, nicht in die
 * Geometrie.** Der Körper ist rund und weich schattiert — eine Kartoffel aus
 * dreihundert Dreiecken mit weichen Beulen —, und was ihn zu Stein macht, ist
 * die Körnung der Textur (`gestein.ts`). Das ist zugleich das billigere
 * Geschäft: Körnung, Sprünge und Flechten kosten einmal eine Kachel und auf
 * jedem Stein der Karte kein einziges Dreieck.
 *
 * Die Beulen kommen aus wenigen grossen Lappen und nicht aus einem Wurf je
 * Ecke. Ein Wurf je Ecke ist Rauschen: bei dreihundert Dreiecken sieht man
 * davon aus fünf Metern nichts mehr, und aus einem Meter sieht es aus wie ein
 * Schwamm. Vier bis sechs Lappen ergeben eine Silhouette, die man wiedererkennt.
 */

import * as THREE from 'three';
import { gesteinsUV } from './gestein.ts';

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
 * Viel dunkler, als die Zahlen vermuten lassen, und das hat zwei Gründe, die
 * sich multiplizieren:
 *
 *   - Die Textur ist um einen Mittelwert von 0,8 gezeichnet und wird **mit**
 *     diesen Farben multipliziert, nicht daneben gelegt.
 *   - Lichtmoor gibt am Mittag Sonne 1,9 **und** Himmel 1,2 dazu. Eine Fläche,
 *     die zur Sonne zeigt, bekommt damit gut das Dreifache — ein Grau von 0x48
 *     kommt als mittleres Grau heraus, ein Grau von 0x94 als Kreide.
 *
 * Nachgemessen und nicht geschätzt: mit einer knallroten Probefarbe rendert der
 * Stein flächig gesättigt. Wer die Farbe für sich beurteilt, stellt sie zu hell
 * ein — und wundert sich über Gipsabdrücke auf der Wiese.
 *
 * Der Stich ins Blaue bleibt: er ist das, was den Fels vom Holz und vom Lehm
 * auf derselben Karte unterscheidet — die sind warm.
 */
const SONNE = 0x5a5d64;
const SCHATTEN = 0x2b2e33;
const FLECHTE = 0x3d4c2c;

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
   * Zweimal unterteilt: 320 Dreiecke, 162 Ecken.
   *
   * Genug, dass die Rundung rund ist und die weichen Normalen etwas zu mitteln
   * haben — bei achtzig Flächen bleibt trotz weicher Schattierung eine
   * kantige Silhouette. Und wenig genug, dass hundertfünfzig Steine auf einer
   * Karte fünfzigtausend Dreiecke sind, gezeichnet in **einem** Aufruf, weil
   * Props instanziert werden.
   */
  const basis = new THREE.IcosahedronGeometry(1, 2);
  const pos = basis.attributes.position as THREE.BufferAttribute;

  /*
   * Die Lappen: wenige grosse Richtungen, in die der Stein ausbeult.
   *
   * `max(0, dot)^3` ist eine weiche Keule um eine Richtung — nah an ihr voll,
   * seitlich schnell bei null, und nirgends eine Kante. Vier bis sechs davon,
   * mal nach aussen und mal nach innen, ergeben eine Kartoffel. Ein Wurf je
   * Ecke ergäbe stattdessen einen Schwamm.
   */
  const lappen: Array<{ richtung: THREE.Vector3; staerke: number; schaerfe: number }> = [];
  // Fünf bis sieben grosse, weiche Lappen — sie machen die Silhouette.
  for (let i = 0, n = 5 + Math.floor(rand() * 3); i < n; i++) {
    lappen.push({
      richtung: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(),
      staerke: (rand() - 0.45) * 0.9,
      schaerfe: 2,
    });
  }
  /*
   * Und ein Dutzend kleine, schärfere darüber.
   *
   * Mit nur den grossen Lappen war der Findling ein Kartoffel-Ellipsoid: die
   * Silhouette wellte sich, aber nirgends sass eine Schulter oder eine Delle.
   * Die schärferen Keulen (`dot^7`) reichen nur über eine Handvoll Ecken und
   * setzen genau die — ohne dass daraus wieder ebene Facetten mit Kanten
   * werden, denn die Normalen bleiben gemittelt.
   */
  for (let i = 0, n = 10 + Math.floor(rand() * 6); i < n; i++) {
    lappen.push({
      richtung: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(),
      staerke: (rand() - 0.5) * 0.5,
      schaerfe: 6,
    });
  }

  /*
   * Ecken zusammenfassen und dabei verschieben.
   *
   * Das Ikosaeder von three ist **nicht** indiziert: jede Ecke kommt so oft
   * vor, wie Flächen an ihr hängen. Für weiche Normalen braucht es aber
   * geteilte Ecken — `computeVertexNormals` mittelt nur über die, die sich
   * einen Eintrag teilen. Also wird hier aus der Dreiecksuppe wieder ein Netz
   * mit Index, und der Schlüssel dafür ist die gerundete Richtung.
   */
  const nummer = new Map<string, number>();
  const ecken: number[] = [];
  const flaechen: number[] = [];
  const richtungen: THREE.Vector3[] = [];

  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    const schluessel = `${v.x.toFixed(3)}/${v.y.toFixed(3)}/${v.z.toFixed(3)}`;
    let idx = nummer.get(schluessel);
    if (idx === undefined) {
      let f = 1;
      for (const l of lappen) {
        const d = Math.max(0, v.dot(l.richtung));
        f += l.staerke * Math.pow(d, l.schaerfe);
      }
      // Eine Spur Unruhe obendrauf, damit die Lappen nicht wie Blasen
      // aussehen. Klein genug, dass die Silhouette weich bleibt.
      f += (rand() - 0.5) * 0.06;
      idx = richtungen.length;
      nummer.set(schluessel, idx);
      richtungen.push(v);
      ecken.push(v.x * radius * f, v.y * radius * f, v.z * radius * f);
    }
    flaechen.push(idx);
  }
  basis.dispose();

  /*
   * Auf die verlangte Grösse zurückrechnen.
   *
   * Die Lappen ziehen mal nach aussen und mal nach innen, und wie viele davon
   * sich überlagern, entscheidet der Zufall — bei einem unglücklichen Wurf war
   * `rock_small` mit `radius: 0.75` am Ende 2,2 Meter breit und damit fast so
   * gross wie `rock_large`. Der mittlere Abstand vom Mittelpunkt wird deshalb
   * auf `radius` normiert: die Form bleibt gewürfelt, die Grösse nicht. Sie
   * muss zum Kollisionskreis passen, und der steht in `PROP_KOLLISION`.
   */
  let summe = 0;
  for (let i = 0; i < ecken.length; i += 3) {
    summe += Math.hypot(ecken[i]!, ecken[i + 1]!, ecken[i + 2]!);
  }
  const norm = (radius * (ecken.length / 3)) / summe;
  for (let i = 0; i < ecken.length; i++) ecken[i]! *= norm;

  const geo = new THREE.BufferGeometry();
  geo.setIndex(flaechen);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(ecken, 3));

  // Flach und breit: ein Findling liegt, er steht nicht. Vor den Normalen,
  // damit die Stauchung in ihnen steckt — `scale` rechnet sie mit.
  geo.scale(1, 0.46 + rand() * 0.18, 0.86 + rand() * 0.26);
  geo.rotateY(rand() * Math.PI * 2);

  // Weich: über die geteilten Ecken gemittelt. Genau der Unterschied zum
  // Vorgänger, und der Grund, warum der Körper indiziert gebaut wird.
  geo.computeVertexNormals();

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
  geo.translate(0, -kasten.min.y - (kasten.max.y - kasten.min.y) * 0.12, 0);

  /*
   * Jetzt erst auflösen — und zwar wegen der Bildkoordinaten.
   *
   * Die Projektion entscheidet je **Dreieck**, aus welcher Richtung sie das
   * Bild auflegt. Geteilte Ecken können das nicht: eine Ecke, an der eine
   * waagerechte und eine senkrechte Fläche hängen, bräuchte zwei verschiedene
   * Koordinaten. `toNonIndexed` trennt sie wieder — die weichen Normalen
   * bleiben dabei erhalten, weil sie schon berechnet sind und nur kopiert
   * werden.
   */
  const offen = geo.toNonIndexed();
  geo.dispose();
  gesteinsUV(offen);

  /*
   * Die Farbe je Ecke, aus der **weichen** Normalen.
   *
   * Je Fläche gefärbt sähe man Flecken mit harten Rändern, während die
   * Schattierung darüber weich verläuft — zwei Sprachen auf einem Körper. Aus
   * der Eckennormalen wird ein Verlauf: oben Sonne, unten Schatten, dazwischen
   * alles.
   */
  const npos = offen.attributes.normal as THREE.BufferAttribute;
  const farben = new Float32Array(npos.count * 3);
  const opos = offen.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < npos.count; i++) {
    const ny = npos.getY(i);
    let farbe = mische(SCHATTEN, SONNE, Math.max(0, Math.min(1, 0.5 + ny * 0.55)));

    /*
     * Flechte nur oben, und als **Fleck**, nicht als Schleier.
     *
     * Der Fleck kommt aus derselben Sorte weicher Keule wie die Beulen, nur
     * über den Ort statt über die Richtung: gleichmässig verteilt sähe die
     * Flechte aus wie ein grüner Schleier über dem ganzen Stein, und das ist
     * genau das, was billige Steine in Spielen kennzeichnet.
     */
    if (ny > 0.25) {
      const x = opos.getX(i);
      const z = opos.getZ(i);
      const fleck = Math.sin(x * 2.7 + seed) * Math.cos(z * 2.1 - seed * 0.5);
      if (fleck > 0.45) {
        farbe = mische(farbe, FLECHTE, Math.min(0.55, (fleck - 0.45) * 1.6) * (ny - 0.25) * 1.3);
      }
    }
    farben[i * 3] = ((farbe >> 16) & 0xff) / 255;
    farben[i * 3 + 1] = ((farbe >> 8) & 0xff) / 255;
    farben[i * 3 + 2] = (farbe & 0xff) / 255;
  }
  offen.setAttribute('color', new THREE.BufferAttribute(farben, 3));
  return offen;
}
