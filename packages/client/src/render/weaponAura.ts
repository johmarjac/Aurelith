/**
 * Die Aura einer aufgewerteten Waffe.
 *
 * Ab +4 schwebt ein weisser Funkenschleier um die Klinge, der mit jeder
 * weiteren Stufe dichter, grösser und heller wird und dabei ruhig pulsiert.
 *
 * **Nicht die Waffe leuchtet.** Ein emissives Material würde die Klinge selbst
 * aufhellen und damit ihre Form platt machen; man sähe eine weisse Fläche
 * statt eines Schwerts. Stattdessen hängt eine eigene Punktwolke am selben
 * Aufhänger — sie bewegt sich mit jedem Schlag mit, verdeckt die Waffe aber
 * nicht.
 *
 * Die Punkte stehen **fest im Raum der Waffe** und werden nicht je Bild neu
 * gerechnet: die Bewegung entsteht im Vertex-Shader aus der Zeit. Fünfzig
 * Figuren mit Aura kosten damit fünfzig Zeichenaufrufe und keine einzige
 * Schleife auf der CPU.
 */

import * as THREE from 'three';
import { glowStrength } from '@aurelith/shared';

/** So viele Funken hat eine Aura auf voller Stufe. */
const MAX_PUNKTE = 26;

/**
 * Die Zeit, die alle Auren teilen.
 *
 * Ein einziges Uniform-Objekt, das an jedem Aura-Material hängt: wer es
 * fortschreibt, schreibt alle fort. Sonst müsste je Bild über sämtliche Auren
 * gelaufen werden, nur um überall dieselbe Zahl einzutragen.
 */
const zeit = { value: 0 };

/** Schreibt die gemeinsame Uhr fort. Einmal je Bild, nicht je Aura. */
export function stepAuras(dt: number): void {
  zeit.value += dt;
}

const VERTEX = `
  uniform float zeit;
  uniform float staerke;
  // Die beiden Richtungen quer zur Waffe, und die Waffe selbst. Als Uniform
  // statt fest im Shader, weil ein Bogen auf einer anderen Achse liegt als
  // ein Schwert — sonst kreisten seine Funken quer durch die Sehne.
  uniform vec3 quer1;
  uniform vec3 quer2;
  uniform vec3 laengs;
  attribute float phase;
  attribute float radius;
  varying float vHelligkeit;

  void main() {
    // Jeder Funke kreist auf eigener Höhe um die Klinge, mit eigener Phase —
    // gleichmässig verteilte Punkte sähen aus wie ein Zaun.
    float w = zeit * 1.6 + phase;
    vec3 p = position + (cos(w) * quer1 + sin(w) * quer2) * radius;
    p += laengs * sin(zeit * 2.1 + phase * 1.7) * 0.05;

    // Das Pulsieren: langsam, und nie ganz aus. Eine Aura, die vollständig
    // verschwindet, sieht nach einem Fehler aus und nicht nach Atem.
    float puls = 0.62 + 0.38 * sin(zeit * 2.4 + phase * 0.5);
    vHelligkeit = puls * staerke;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    // Grosszuegig: bei der ueblichen Kameradistanz von neun bis zehn Einheiten
    // sind das zwischen zehn und zwanzig Bildpunkten je Funke. Kleiner sah im
    // Bild nach Bildrauschen aus statt nach Schein.
    gl_PointSize = (75.0 + 95.0 * staerke) / max(0.001, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT = `
  varying float vHelligkeit;

  void main() {
    // Weicher Kern, kein harter Kreis: ein Funke ist Licht und keine Scheibe.
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    float f = 1.0 - d * 2.0;
    float kern = pow(f, 3.0);
    gl_FragColor = vec4(1.0, 1.0, 1.0, kern * vHelligkeit * 0.85);
  }
`;

/**
 * Baut eine Aura für einen Waffenhalter.
 *
 * `hoehe` ist die Länge der Waffe: die Funken verteilen sich darüber. Ein Bogen
 * ist länger als ein Dolch, und eine Aura, die immer gleich hoch ist, sitzt bei
 * einem davon falsch.
 */
export class WeaponAura {
  readonly object: THREE.Points;

  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private level = 0;

  constructor(span: { length: number; bottom: number; axis: 'y' | 'z' }) {
    const positions = new Float32Array(MAX_PUNKTE * 3);
    const phasen = new Float32Array(MAX_PUNKTE);
    const radien = new Float32Array(MAX_PUNKTE);

    // Auf welcher Achse die Waffe liegt — daraus folgt, worum die Funken
    // kreisen. Die Zahlen kommen aus derselben Angabe, mit der ein geliefertes
    // Modell eingepasst wird; geraten wird nichts.
    const achse = span.axis === 'z' ? 2 : 1;

    for (let i = 0; i < MAX_PUNKTE; i++) {
      // Der goldene Winkel verteilt die Funken über die Klinge, ohne dass sich
      // ein Muster bildet — bei gleichmässigen Schritten stehen sie in Reihen.
      const t = (i * 0.618033988749895) % 1;
      positions[i * 3] = 0;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = 0;
      positions[i * 3 + achse] = span.bottom + t * span.length;
      phasen[i] = (i * 2.39996) % (Math.PI * 2);
      radien[i] = 0.09 + ((i * 7919) % 100) / 100 * 0.08;
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('phase', new THREE.BufferAttribute(phasen, 1));
    this.geometry.setAttribute('radius', new THREE.BufferAttribute(radien, 1));
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        zeit,
        staerke: { value: 0 },
        quer1: { value: new THREE.Vector3(1, 0, 0) },
        quer2: {
          value: span.axis === 'z' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1),
        },
        laengs: {
          value: span.axis === 'z' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0),
        },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
    });

    this.object = new THREE.Points(this.geometry, this.material);
    // Die Hüllkugel entsteht aus den Ruhelagen der Punkte; im Shader wandern
    // sie darüber hinaus. Ohne das Abschalten flackert die Aura am Bildrand.
    this.object.frustumCulled = false;
    this.object.renderOrder = 6;
    this.object.visible = false;
  }

  get upgrade(): number {
    return this.level;
  }

  /** Setzt die Aufwertungsstufe. Unter +4 bleibt die Aura ganz aus. */
  setUpgrade(level: number): void {
    if (this.level === level) return;
    this.level = level;

    const staerke = glowStrength(level);
    this.material.uniforms.staerke!.value = staerke;
    // Weniger Funken auf niedriger Stufe: die Dichte trägt den Eindruck
    // mindestens so sehr wie die Helligkeit.
    this.geometry.setDrawRange(0, staerke > 0 ? Math.round(8 + staerke * (MAX_PUNKTE - 8)) : 0);
    this.object.visible = staerke > 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
