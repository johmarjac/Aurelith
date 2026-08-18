/**
 * Der schwarze Umriss um Figuren und Wesen.
 *
 * Die Technik heisst „umgestülpte Hülle" und ist so alt wie Cel-Shading: zu
 * jedem Netz kommt ein zweites, das entlang seiner Normalen ein Stück nach
 * aussen geschoben und **von innen** gezeichnet wird (`BackSide`). Was man
 * davon sieht, ist genau der Rand — überall dort, wo die Hülle über die
 * Silhouette des Originals hinausragt. Innen liegt sie hinter dem Original und
 * ist verdeckt.
 *
 * Zwei Dinge daran sind nicht selbstverständlich:
 *
 * **Der Versatz wächst mit der Entfernung.** Ein fester Versatz in Metern
 * ergäbe eine Linie, die aus der Nähe fingerdick und aus der Ferne unsichtbar
 * ist. Gerechnet wird deshalb im Blickraum: je weiter weg, desto mehr Meter
 * für dieselbe Zahl Bildpunkte. Genau das macht den Strich zu einem Strich und
 * nicht zu einem Schatten.
 *
 * **Die Normalen müssen glatt sein.** Die Rigs bestehen aus Kästen und Kugeln,
 * und eine Kastenecke hat drei Normalen an derselben Stelle. Schöbe man die
 * drei auseinander, klaffte der Umriss an jeder Ecke auf. `mergeVertices`
 * legt sie vorher zusammen und mittelt sie — die Hülle bleibt geschlossen.
 * Das Original bleibt unangetastet: **dort** sollen die Kanten hart bleiben.
 */

import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Wie breit der Strich ist, ungefähr in Bildpunkten bei 720 Zeilen Höhe.
 *
 * Fünf, und das ist bewusst kräftig. Bei zweieinhalb war der Strich zwar da,
 * las sich aber als Kantenglättung — auf einer hellen Wiese sah die Figur
 * genauso aus wie ohne. Ein Comic-Rand darf man sehen; wer ihn nicht will,
 * schaltet ihn in den Einstellungen ab.
 */
const BREITE = 5.0;

const VERTEX = /* glsl */ `
  uniform float breite;
  void main() {
    vec4 lage = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    /*
     * Nach aussen, und zwar entfernungsabhängig.
     *
     * -lage.z ist der Abstand zur Kamera im Blickraum. Der Faktor ist so
     * gewählt, dass "breite" ungefähr Bildpunkte bei einem Bild von 720 Zeilen
     * und 60 Grad Öffnung bedeutet — genauer geht nur mit der Bildhöhe als
     * zweiter Uniform, und die wäre eine Zahl mehr, die jemand pflegen muss.
     */
    lage.xyz += n * breite * max(-lage.z, 0.2) * 0.0016;
    gl_Position = projectionMatrix * lage;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 farbe;
  void main() {
    gl_FragColor = vec4(farbe, 1.0);
  }
`;

/**
 * Ein Material für alle Umrisse.
 *
 * Eines und nicht je Figur eines: es hat keinen Zustand ausser der Breite, und
 * fünfzig gleiche Materialien wären fünfzig Shader-Umschaltungen je Bild.
 */
let gemeinsam: THREE.ShaderMaterial | undefined;

function material(): THREE.ShaderMaterial {
  if (!gemeinsam) {
    gemeinsam = new THREE.ShaderMaterial({
      uniforms: {
        breite: { value: BREITE },
        farbe: { value: new THREE.Color(0x101014) },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      /*
       * Von innen gezeichnet — das ist der ganze Trick. Und mit Tiefentest,
       * damit ein Umriss hinter einem Baum auch hinter dem Baum bleibt.
       */
      side: THREE.BackSide,
      depthWrite: true,
      // Nicht vom Nebel eingefärbt: ein grauer Umriss in der Ferne sähe aus
      // wie ein Fehler im Modell. Er verschwindet mit der Figur, an der er
      // hängt, und das reicht.
      fog: false,
    });
  }
  return gemeinsam;
}

/**
 * Hängt an jedes Netz unter `wurzel` eine Hülle.
 *
 * Gibt die erzeugten Geometrien zurück — der Aufrufer muss sie freigeben, wenn
 * die Figur verschwindet. Ein Rig hält seine eigenen Geometrien in einer Liste
 * und macht dasselbe; hier steht dieselbe Buchführung, nur für den Rand.
 */
export function baueUmriss(wurzel: THREE.Object3D): THREE.BufferGeometry[] {
  const erzeugt: THREE.BufferGeometry[] = [];

  /*
   * Erst sammeln, dann anhängen.
   *
   * `traverse` läuft über die Kinder, während man sie ändert — hängte man die
   * Hülle sofort an, liefe die Schleife über die eben erzeugte Hülle weiter
   * und baute eine Hülle um die Hülle. Die Rekursion endet erst, wenn der
   * Speicher voll ist.
   */
  const netze: THREE.Mesh[] = [];
  wurzel.traverse((o) => {
    const netz = o as THREE.Mesh;
    if (netz.isMesh && netz.geometry) netze.push(netz);
  });

  for (const netz of netze) {
    /*
     * Erst alles wegwerfen ausser der Lage, **dann** schweissen.
     *
     * `mergeVertices` legt zwei Ecken nur zusammen, wenn **alle** ihre
     * Merkmale übereinstimmen — Lage, Normale, Farbe, Textur. In einem Rig
     * treffen an jeder Kante zwei Flächen mit verschiedenen Normalen und oft
     * auch verschiedenen Farben aufeinander, und damit blieb jede Ecke
     * einzeln stehen: die Hülle klaffte an jeder Kante auf, und statt eines
     * Strichs sah man dunkle Flecken auf den Armen.
     *
     * Ohne Normale und Farbe bleibt die reine Form, und die schweisst sauber.
     * `computeVertexNormals` mittelt danach über die zusammengelegten Ecken —
     * genau die glatte Normale, die eine geschlossene Hülle braucht.
     */
    const roh = netz.geometry.clone();
    roh.deleteAttribute('normal');
    roh.deleteAttribute('color');
    if (roh.hasAttribute('uv')) roh.deleteAttribute('uv');
    const geo = mergeVertices(roh);
    geo.computeVertexNormals();
    roh.dispose();
    erzeugt.push(geo);

    const huelle = new THREE.Mesh(geo, material());
    huelle.name = 'umriss';
    // Dieselbe Lage wie das Netz, an dem sie hängt: als **Kind** angehängt
    // erbt sie jede Drehung der Gliedmasse, an der sie sitzt. Angehängt an
    // den Elternknoten müsste jede Animation zweimal geschrieben werden.
    huelle.castShadow = false;
    huelle.receiveShadow = false;
    // Zuerst zeichnen: die Hülle schreibt Tiefe, und das Original überzeichnet
    // sie danach von vorn. Umgekehrt bliebe an flachen Stellen ein Flimmern.
    huelle.renderOrder = -1;
    netz.add(huelle);
  }

  return erzeugt;
}
