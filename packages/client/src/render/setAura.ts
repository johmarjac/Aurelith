/**
 * Der Schein eines vollständigen Rüstungssatzes.
 *
 * Wer alle vier Teile eines Satzes trägt und jedes davon mindestens auf +4
 * gebracht hat, läuft in einem warmen Licht herum. Es wird mit jeder Stufe
 * heller, und ab +8 steigen zusätzlich Ringe an der Figur hoch.
 *
 * **Warum nicht die Waffenaura?** Weil eine Waffe eine Linie ist und ein
 * Körper eine Hülle. Die Flecken der Waffenaura sitzen auf der Klingenachse;
 * dieselbe Anordnung an einer Figur läge im Bauch und wäre von aussen nicht zu
 * sehen — man sähe einen Lichtstab durch den Kopf und sonst nichts. Hier
 * sitzen sie deshalb auf einem Mantel um die Figur herum, dort wo die
 * Silhouette ist.
 *
 * **Warm statt weiss.** Die Waffe leuchtet kaltweiss; wer beides trägt, soll
 * die beiden Auren auseinanderhalten können. Ein Bernsteinton liest sich
 * ausserdem als *Rüstung* und nicht als Zauber.
 *
 * **Nicht die Rüstung selbst leuchtet.** Ein emissives Material auf den
 * Kästen, aus denen die Figur besteht, machte sie flächig und nähme ihr die
 * Form — derselbe Grund wie bei der Waffe. Der Schein hängt als eigene
 * Geometrie an der Wurzel des Rigs und läuft damit ohne weiteres Zutun mit.
 */

import * as THREE from 'three';
import { glowStrength } from '@aurelith/shared';
import { auraZeit as zeit } from './auraClock.ts';

/** So viele aufsteigende Funken hat der Schein auf voller Stufe. */
const MAX_FUNKEN = 46;

/** Ab dieser Stufe steigen zusätzlich Ringe an der Figur hoch. */
const RINGE_AB = 8;

/** Bernstein. Erster Wert im Kern, zweiter am weichen Rand. */
const KERN = 'vec3(1.0, 0.92, 0.72)';
const RAND = 'vec3(1.0, 0.72, 0.30)';

const HUELLE_VERTEX = `
  uniform float zeit;
  uniform float staerke;
  uniform float groesse;
  attribute float phase;
  varying float vHelligkeit;

  void main() {
    // Versetztes Atmen wie bei der Waffe: alle Flecken gleichzeitig heller zu
    // machen ergäbe ein Blinken, versetzt ergibt es ein Wandern ums Blech.
    float puls = 0.66 + 0.34 * sin(zeit * 1.7 - phase * 5.2);
    vHelligkeit = puls * staerke;

    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = groesse * (0.75 + 0.25 * staerke) / max(0.001, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const HUELLE_FRAGMENT = `
  varying float vHelligkeit;

  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    float f = 1.0 - d * 2.0;
    float weich = f * f * (3.0 - 2.0 * f);
    vec3 farbe = mix(${RAND}, ${KERN}, weich);
    gl_FragColor = vec4(farbe, weich * vHelligkeit * 0.14);
  }
`;

const FUNKEN_VERTEX = `
  uniform float zeit;
  uniform float staerke;
  uniform float hoehe;
  attribute float phase;
  attribute float radius;
  varying float vHelligkeit;

  void main() {
    // Jeder Funke steigt an der Figur entlang, läuft oben über und fängt unten
    // wieder an. Der Nachkommaanteil macht daraus eine Schleife ohne Sprung,
    // weil er an beiden Enden ohnehin ausgeblendet wird.
    float t = fract(phase + zeit * 0.2);
    float w = phase * 6.2831 + zeit * 0.9;

    vec3 p;
    p.x = cos(w) * radius;
    p.z = sin(w) * radius;
    p.y = t * hoehe;

    float rand = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.7, 1.0, t));
    vHelligkeit = rand * staerke * (0.7 + 0.3 * sin(zeit * 2.6 + phase * 9.0));

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = (16.0 + 16.0 * staerke) / max(0.001, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const FUNKEN_FRAGMENT = `
  varying float vHelligkeit;

  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    float kern = pow(1.0 - d * 2.0, 2.5);
    gl_FragColor = vec4(${KERN}, kern * vHelligkeit * 0.5);
  }
`;

const RING_VERTEX = `
  uniform float zeit;
  uniform float versatz;
  uniform float hoehe;
  varying float vLeben;
  varying vec2 vUv;

  void main() {
    float t = fract(zeit * 0.3 + versatz);
    vec3 p = position;
    // Der Ring wird auf dem Weg nach oben enger — das liest sich als Aufsteigen
    // und nicht als Fahrstuhl.
    p.xz *= mix(1.08, 0.7, t);
    p.y += t * hoehe;

    vUv = uv;
    vLeben = smoothstep(0.0, 0.18, t) * (1.0 - smoothstep(0.62, 1.0, t));

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
    // die Breite des Bands.
    float band = sin(clamp(vUv.x, 0.0, 1.0) * 3.14159);
    gl_FragColor = vec4(${RAND}, band * vLeben * staerke * 0.3);
  }
`;

export class SetAura {
  readonly object = new THREE.Group();

  private readonly ringe: THREE.Mesh[] = [];
  private readonly wegwerf: Array<{ dispose(): void }> = [];
  private readonly staerken: Array<{ value: number }> = [];
  private readonly funkenGeometrie: THREE.BufferGeometry;

  private level = -1;

  /**
   * @param hoehe  Höhe der Figur in Weltnenheiten.
   * @param radius Halber Abstand der Silhouette von der Mitte.
   */
  constructor(hoehe: number, radius = 0.42) {
    const h = Math.max(0.4, hoehe);
    const r = Math.max(0.15, radius);

    // --- Die Hülle ---------------------------------------------------------
    //
    // Flecken auf einem Mantel um die Figur: ein Kranz je Höhenschritt, und
    // jeder Kranz gegen den darunter verdreht. Ohne die Verdrehung stünden die
    // Flecken in Säulen übereinander, und aus jeder zweiten Blickrichtung sähe
    // man Streifen statt eines Scheins.
    // Dicht an dicht, und das ist der Punkt: die Flecken sollen sich
    // überlagern. Der erste Anlauf hatte sechs je Kranz und einen Kranz je
    // dreissig Zentimeter — die Abstände waren so gross wie die Flecken selbst,
    // und im Bild stand die Figur in einer Perlenkette statt in einem Schein.
    const kraenze = Math.max(5, Math.round(h / 0.2));
    const proKranz = 10;
    const anzahl = kraenze * proKranz;
    const huellePos = new Float32Array(anzahl * 3);
    const huellePhase = new Float32Array(anzahl);
    for (let k = 0; k < kraenze; k++) {
      const y = ((k + 0.5) / kraenze) * h;
      // Die Figur ist an den Schultern breiter als an den Füssen; ein Mantel
      // mit festem Radius klebte unten an den Beinen und schwebte oben neben
      // dem Kopf.
      const rk = r * (0.72 + 0.5 * Math.sin((y / h) * Math.PI));
      for (let j = 0; j < proKranz; j++) {
        const i = k * proKranz + j;
        const w = ((j + k * 0.5) / proKranz) * Math.PI * 2;
        huellePos[i * 3] = Math.cos(w) * rk;
        huellePos[i * 3 + 1] = y;
        huellePos[i * 3 + 2] = Math.sin(w) * rk;
        huellePhase[i] = (i / anzahl) * Math.PI * 2;
      }
    }

    const huelleGeo = new THREE.BufferGeometry();
    huelleGeo.setAttribute('position', new THREE.BufferAttribute(huellePos, 3));
    huelleGeo.setAttribute('phase', new THREE.BufferAttribute(huellePhase, 1));

    const huelleStaerke = { value: 0 };
    const huelleMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        zeit,
        staerke: huelleStaerke,
        // Bildpunkte auf einen Meter Entfernung — derselbe Umrechnungsweg wie
        // bei der Waffenaura. Der Fleck ist ungefähr so breit wie ein Arm.
        groesse: { value: Math.max(190, r * 1250) },
      },
      vertexShader: HUELLE_VERTEX,
      fragmentShader: HUELLE_FRAGMENT,
    });

    const huelle = new THREE.Points(huelleGeo, huelleMat);
    huelle.renderOrder = 6;
    this.object.add(huelle);
    this.wegwerf.push(huelleGeo, huelleMat);
    this.staerken.push(huelleStaerke);

    // --- Die Funken --------------------------------------------------------
    const positions = new Float32Array(MAX_FUNKEN * 3);
    const phasen = new Float32Array(MAX_FUNKEN);
    const radien = new Float32Array(MAX_FUNKEN);
    for (let i = 0; i < MAX_FUNKEN; i++) {
      // Der goldene Winkel verteilt Phase und Bahn, ohne dass sich ein Muster
      // bildet — gleichmässige Schritte ergäben sichtbare Reihen.
      phasen[i] = (i * 0.618033988749895) % 1;
      radien[i] = r * (0.95 + (((i * 7919) % 100) / 100) * 0.5);
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
      uniforms: { zeit, staerke: funkenStaerke, hoehe: { value: h } },
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

    // --- Die Ringe ---------------------------------------------------------
    for (let i = 0; i < 2; i++) {
      const ringGeo = new THREE.RingGeometry(r * 1.05, r * 1.5, 28, 1);
      // Flach legen: eine Ringgeometrie steht in der XY-Ebene, gebraucht wird
      // sie quer zur Figur.
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
          hoehe: { value: h },
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

    this.setLevel(0);
  }

  get upgrade(): number {
    return this.level;
  }

  /**
   * Setzt die Satzstufe. Null — und alles unter der Leuchtschwelle — heisst:
   * kein Schein.
   */
  setLevel(level: number): void {
    if (this.level === level) return;
    this.level = level;

    const staerke = glowStrength(level);
    for (const uniform of this.staerken) uniform.value = staerke;

    // Weniger Funken auf niedriger Stufe: die Dichte trägt den Eindruck
    // mindestens so sehr wie die Helligkeit.
    this.funkenGeometrie.setDrawRange(
      0,
      staerke > 0 ? Math.round(12 + staerke * (MAX_FUNKEN - 12)) : 0,
    );

    const mitRingen = level >= RINGE_AB;
    for (const ring of this.ringe) ring.visible = mitRingen;

    this.object.visible = staerke > 0;
  }

  dispose(): void {
    for (const teil of this.wegwerf) teil.dispose();
  }
}
