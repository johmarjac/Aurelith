/**
 * Die Aura einer aufgewerteten Waffe.
 *
 * Ab +4 steht ein weisser Lichtschleier um die Klinge, der mit jeder Stufe
 * dichter und heller wird, ruhig pulsiert und ab +8 zusätzlich Ringe an der
 * Waffe entlangschickt.
 *
 * **Nicht die Waffe leuchtet.** Ein emissives Material würde die Klinge selbst
 * aufhellen und ihre Form platt machen; man sähe eine weisse Fläche statt eines
 * Schwerts. Der Schein hängt deshalb als eigene Geometrie am selben Aufhänger —
 * er bewegt sich mit jedem Schlag mit, verdeckt die Waffe aber nicht.
 *
 * Drei Teile, die zusammen den Eindruck machen:
 *
 *   **Der Halo.** Ein Dutzend sehr weicher, sehr grosser Lichtflecken, die
 *   entlang der Klinge sitzen und sich überlagern. Weil sie zur Kamera stehen,
 *   sieht der Schein aus jeder Richtung gleich aus, und weil sie einzeln kaum
 *   sichtbar sind, ergibt ihre Summe einen weichen Verlauf statt einer Kante.
 *   Sie atmen versetzt, und daraus entsteht das Strömen.
 *
 *   **Die Ringe.** Ab +8 wandern zwei flache Ringe die Waffe hinauf und
 *   verblassen dabei. Sie kosten zwei Zeichenaufrufe und machen den Unterschied
 *   zwischen „leuchtet" und „ist an der Grenze".
 *
 * Zwei Anläufe stehen hinter dieser Aufteilung. Der erste war eine reine
 * Punktwolke aus zwei Dutzend harten Funken — das sah aus wie Bildrauschen und
 * nicht wie Licht. Der zweite war ein Zylindermantel mit Randabfall: als
 * Fläche gedacht, im Bild aber ein Plastiktrichter über der Klinge, weil eine
 * Hülle eine Silhouette hat und Licht keine. Weiche, überlagerte Flecken haben
 * beides nicht.
 *
 * Alles bewegt sich **im Shader**. Fünfzig Figuren mit Aura kosten damit ihre
 * Zeichenaufrufe und keine einzige Schleife auf der CPU.
 */

import * as THREE from 'three';
import { glowStrength } from '@aurelith/shared';
import { auraZeit as zeit } from './auraClock.ts';

/** So viele Funken hat der Schleier auf voller Stufe. */
const MAX_FUNKEN = 40;

/** Ab dieser Stufe wandern zusätzlich Ringe an der Waffe entlang. */
const RINGE_AB = 8;

export interface WeaponSpan {
  length: number;
  bottom: number;
  axis: 'y' | 'z';
}

// ---------------------------------------------------------------------------
// Der Halo
// ---------------------------------------------------------------------------

const HALO_VERTEX = `
  uniform float zeit;
  uniform float staerke;
  uniform float groesse;
  attribute float phase;
  varying float vHelligkeit;

  void main() {
    // Versetztes Atmen: alle Flecken gleichzeitig heller zu machen ergäbe ein
    // Blinken, versetzt ergibt es ein Strömen.
    float puls = 0.68 + 0.32 * sin(zeit * 2.2 - phase * 4.5);
    vHelligkeit = puls * staerke;

    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = groesse * (0.75 + 0.25 * staerke) / max(0.001, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const HALO_FRAGMENT = `
  varying float vHelligkeit;

  void main() {
    // Sehr weich: der Fleck hat keinen Kern, sondern nur Abfall. Einzeln ist
    // er kaum zu sehen — erst ein Dutzend übereinander ergibt den Schein.
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    float f = 1.0 - d * 2.0;
    float weich = f * f * (3.0 - 2.0 * f);
    vec3 farbe = mix(vec3(0.78, 0.9, 1.0), vec3(1.0), weich);
    gl_FragColor = vec4(farbe, weich * vHelligkeit * 0.3);
  }
`;

// ---------------------------------------------------------------------------
// Die Funken
// ---------------------------------------------------------------------------

const FUNKEN_VERTEX = `
  uniform float zeit;
  uniform float staerke;
  uniform float laenge;
  uniform float unten;
  attribute float phase;
  attribute float radius;
  varying float vHelligkeit;

  void main() {
    // Jeder Funke steigt, läuft oben über und fängt unten wieder an. Der
    // Nachkommaanteil macht daraus eine Schleife ohne sichtbaren Sprung, weil
    // er an beiden Enden der Bahn ohnehin ausgeblendet wird.
    float t = fract(phase + zeit * 0.28);
    float w = phase * 6.2831 + zeit * 1.4;

    vec3 p;
    p.x = cos(w) * radius;
    p.z = sin(w) * radius;
    p.y = unten + t * laenge;

    float rand = smoothstep(0.0, 0.15, t) * (1.0 - smoothstep(0.75, 1.0, t));
    vHelligkeit = rand * staerke * (0.7 + 0.3 * sin(zeit * 3.0 + phase * 9.0));

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = (22.0 + 20.0 * staerke) / max(0.001, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const FUNKEN_FRAGMENT = `
  varying float vHelligkeit;

  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    float kern = pow(1.0 - d * 2.0, 2.5);
    gl_FragColor = vec4(1.0, 1.0, 1.0, kern * vHelligkeit * 0.55);
  }
`;

// ---------------------------------------------------------------------------
// Die Ringe
// ---------------------------------------------------------------------------

const RING_VERTEX = `
  uniform float zeit;
  uniform float versatz;
  uniform float laenge;
  uniform float unten;
  varying float vLeben;
  varying vec2 vUv;

  void main() {
    float t = fract(zeit * 0.35 + versatz);
    vec3 p = position;
    // Der Ring wird auf seinem Weg nach oben enger — das liest sich als
    // Aufsteigen und nicht als Fahrstuhl.
    p.xz *= mix(1.05, 0.78, t);
    p.y += unten + t * laenge;

    vUv = uv;
    vLeben = smoothstep(0.0, 0.2, t) * (1.0 - smoothstep(0.6, 1.0, t));

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const RING_FRAGMENT = `
  uniform float staerke;
  varying float vLeben;
  varying vec2 vUv;

  void main() {
    // Innen und aussen weich: eine Scheibe mit harter Kante sähe aus wie ein
    // Aufkleber. Die erste Texturkoordinate läuft bei einer Ringgeometrie über
    // die Breite des Bands, also von innen nach aussen.
    float band = sin(clamp(vUv.x, 0.0, 1.0) * 3.14159);
    gl_FragColor = vec4(1.0, 1.0, 1.0, band * vLeben * staerke * 0.28);
  }
`;

/**
 * Der Lichtschleier um eine Waffe.
 *
 * Alles wird im Raum der Waffe gebaut, mit +Y als Längsachse. Liegt die Waffe
 * auf Z — ein Bogen zum Beispiel —, kippt die ganze Gruppe einmal, statt dass
 * jeder Shader eine Fallunterscheidung mitschleppt.
 */
export class WeaponAura {
  readonly object = new THREE.Group();

  private readonly ringe: THREE.Mesh[] = [];
  private readonly wegwerf: Array<{ dispose(): void }> = [];
  private readonly staerken: Array<{ value: number }> = [];
  private readonly funkenGeometrie: THREE.BufferGeometry;

  private level = 0;

  constructor(span: WeaponSpan) {
    const laenge = Math.max(0.3, span.length);
    const unten = span.bottom;
    // Eng an der Klinge. Der erste Anlauf lag bei einem Zehntel der Länge, und
    // das war breiter als die Waffe — der Schein sass dann nicht an ihr,
    // sondern um sie herum wie ein Rohr.
    const radius = Math.max(0.055, laenge * 0.07);

    // --- Halo --------------------------------------------------------------
    //
    // Die Flecken sitzen dicht an dicht auf der Klingenachse. Dicht, weil sich
    // ihre weichen Ränder überlagern sollen: bei doppeltem Abstand sähe man
    // eine Perlenkette statt eines Verlaufs.
    const haloAnzahl = Math.max(8, Math.round(laenge / 0.09));
    const haloPos = new Float32Array(haloAnzahl * 3);
    const haloPhase = new Float32Array(haloAnzahl);
    for (let i = 0; i < haloAnzahl; i++) {
      haloPos[i * 3 + 1] = unten + ((i + 0.5) / haloAnzahl) * laenge;
      haloPhase[i] = (i / haloAnzahl) * Math.PI * 2;
    }

    const haloGeo = new THREE.BufferGeometry();
    haloGeo.setAttribute('position', new THREE.BufferAttribute(haloPos, 3));
    haloGeo.setAttribute('phase', new THREE.BufferAttribute(haloPhase, 1));

    const haloStaerke = { value: 0 };
    const haloMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        zeit,
        staerke: haloStaerke,
        // Bildpunkte auf einen Meter Entfernung. Der Wert ist so gewählt, dass
        // der Schein knapp doppelt so breit ist wie die Klinge — derselbe
        // Umrechnungsweg wie bei den Funken und beim Laternenschein.
        groesse: { value: Math.max(160, radius * 3400) },
      },
      vertexShader: HALO_VERTEX,
      fragmentShader: HALO_FRAGMENT,
    });

    const halo = new THREE.Points(haloGeo, haloMat);
    halo.renderOrder = 6;
    this.object.add(halo);
    this.wegwerf.push(haloGeo, haloMat);
    this.staerken.push(haloStaerke);

    // --- Funken ------------------------------------------------------------
    const positions = new Float32Array(MAX_FUNKEN * 3);
    const phasen = new Float32Array(MAX_FUNKEN);
    const radien = new Float32Array(MAX_FUNKEN);
    for (let i = 0; i < MAX_FUNKEN; i++) {
      // Der goldene Winkel verteilt Phase und Bahn, ohne dass sich ein Muster
      // bildet — gleichmässige Schritte ergäben sichtbare Reihen.
      phasen[i] = (i * 0.618033988749895) % 1;
      radien[i] = radius * (0.85 + (((i * 7919) % 100) / 100) * 0.65);
    }
    this.funkenGeometrie = new THREE.BufferGeometry();
    this.funkenGeometrie.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.funkenGeometrie.setAttribute('phase', new THREE.BufferAttribute(phasen, 1));
    this.funkenGeometrie.setAttribute('radius', new THREE.BufferAttribute(radien, 1));
    this.funkenGeometrie.setDrawRange(0, 0);

    const funkenStaerke = { value: 0 };
    const funkenMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        zeit,
        staerke: funkenStaerke,
        laenge: { value: laenge },
        unten: { value: unten },
      },
      vertexShader: FUNKEN_VERTEX,
      fragmentShader: FUNKEN_FRAGMENT,
    });
    const funken = new THREE.Points(this.funkenGeometrie, funkenMat);
    // Die Lagen entstehen erst im Shader; eine Hüllkugel aus den Ruhelagen
    // wäre ein Punkt und liesse die Wolke am Bildrand verschwinden.
    funken.frustumCulled = false;
    funken.renderOrder = 7;
    this.object.add(funken);
    this.wegwerf.push(this.funkenGeometrie, funkenMat);
    this.staerken.push(funkenStaerke);

    // --- Ringe -------------------------------------------------------------
    for (let i = 0; i < 2; i++) {
      const ringGeo = new THREE.RingGeometry(radius * 1.25, radius * 1.9, 24, 1);
      // Flach legen: eine Ringgeometrie steht in der XY-Ebene, gebraucht wird
      // sie quer zur Waffe.
      ringGeo.rotateX(-Math.PI / 2);
      const ringStaerke = { value: 0 };
      const ringMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
          zeit,
          staerke: ringStaerke,
          versatz: { value: i * 0.5 },
          laenge: { value: laenge },
          unten: { value: unten },
        },
        vertexShader: RING_VERTEX,
        fragmentShader: RING_FRAGMENT,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.frustumCulled = false;
      ring.renderOrder = 6;
      ring.visible = false;
      this.object.add(ring);
      this.ringe.push(ring);
      this.wegwerf.push(ringGeo, ringMat);
      this.staerken.push(ringStaerke);
    }

    // Liegt die Waffe auf Z, kippt die ganze Gruppe. Siehe Klassenkommentar.
    if (span.axis === 'z') this.object.rotation.x = Math.PI / 2;
    this.object.visible = false;
  }

  get upgrade(): number {
    return this.level;
  }

  /** Setzt die Aufwertungsstufe. Unter +4 bleibt der Schleier ganz aus. */
  setUpgrade(level: number): void {
    if (this.level === level) return;
    this.level = level;

    const staerke = glowStrength(level);
    for (const uniform of this.staerken) uniform.value = staerke;

    // Weniger Funken auf niedriger Stufe: die Dichte trägt den Eindruck
    // mindestens so sehr wie die Helligkeit.
    this.funkenGeometrie.setDrawRange(
      0,
      staerke > 0 ? Math.round(10 + staerke * (MAX_FUNKEN - 10)) : 0,
    );

    const mitRingen = level >= RINGE_AB;
    for (const ring of this.ringe) ring.visible = mitRingen;

    this.object.visible = staerke > 0;
  }

  dispose(): void {
    for (const teil of this.wegwerf) teil.dispose();
  }
}
