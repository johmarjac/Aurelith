/**
 * Warmes Licht an den Laternen.
 *
 * Zwei Teile, die zusammen den Eindruck machen:
 *
 *   **Der Schein.** Eine additive Punktwolke am Glas jeder Laterne. Sie
 *   leuchtet immer, unabhängig von der Beleuchtung, und gibt der Laterne den
 *   Halo, den ein beleuchtetes Material nie hinbekommt — Lambert kann nicht
 *   heller werden als sein Licht.
 *
 *   **Die Lichtpfütze.** Echte Punktlichter, die den Boden und alles in der
 *   Nähe anwärmen.
 *
 * Der Kern der Sache ist die **feste Zahl** Lichter. Eine Karte hat womöglich
 * fünfzig Laternen, und fünfzig Lichter würde kein Renderer mitmachen, der auf
 * einem Telefon laufen soll. Stattdessen gibt es eine Handvoll, die immer in
 * der Szene hängen und je Bild zu den nächstgelegenen Laternen wandern.
 *
 * Fest ist die Zahl auch aus einem zweiten Grund: Three.js übersetzt seine
 * Shader neu, sobald sich die Zahl der Lichter ändert. Lichter nach Bedarf
 * anzulegen und wegzunehmen hieße, mitten im Spiel Shader zu übersetzen — und
 * das sieht man als Ruckler.
 */

import * as THREE from 'three';

/** Farbe des Lichts. Bernstein, nicht Weiß — es soll nach Öllampe aussehen. */
const WARM = 0xffb45a;

/** Wie weit eine Lichtpfütze reicht. */
const RANGE = 14;

/**
 * Ab hier ist eine Laterne zu weit weg, um noch ein eigenes Licht zu bekommen.
 *
 * Etwas größer als die Reichweite: sonst würde ein Licht genau dann übergeben,
 * wenn es noch sichtbar ist, und man sähe die Übergabe blinken.
 */
const CONSIDER = RANGE * 1.6;

export interface LanternPlacement {
  x: number;
  y: number;
  z: number;
}

export class Lanterns {
  readonly root = new THREE.Group();

  private readonly places: LanternPlacement[] = [];
  private readonly lights: THREE.PointLight[] = [];

  /** Der Schein am Glas — eine Punktwolke, additiv gezeichnet. */
  private glow?: THREE.Points;
  private glowGeometry?: THREE.BufferGeometry;
  private glowMaterial?: THREE.ShaderMaterial;

  /** Wiederverwendet je Bild, damit die Auswahl nichts anlegt. */
  private readonly ranked: Array<{ place: LanternPlacement; d2: number }> = [];

  constructor(private readonly maxLights: number) {
    for (let i = 0; i < maxLights; i++) {
      const light = new THREE.PointLight(WARM, 0, RANGE, 1.6);
      // Kein Schattenwurf: eine Punktlichtquelle mit Schatten kostet sechs
      // zusätzliche Renderdurchgänge — je Licht.
      light.castShadow = false;
      light.visible = false;
      this.lights.push(light);
      this.root.add(light);
    }
  }

  /** Wie viele Laternen die Karte hat. Nur für die Diagnose. */
  get count(): number {
    return this.places.length;
  }

  /**
   * Setzt die Laternen einer Karte.
   *
   * `y` ist die Höhe des Glases über dem Boden, nicht die des Fußes — das
   * Licht soll von der Lampe kommen und nicht aus dem Pflaster.
   */
  setPlacements(places: LanternPlacement[]): void {
    this.places.length = 0;
    this.places.push(...places);
    this.rebuildGlow();
  }

  private rebuildGlow(): void {
    if (this.glow) {
      this.root.remove(this.glow);
      this.glowGeometry?.dispose();
      this.glowMaterial?.dispose();
      this.glow = undefined;
    }
    if (this.places.length === 0) return;

    const positions = new Float32Array(this.places.length * 3);
    for (let i = 0; i < this.places.length; i++) {
      const p = this.places[i]!;
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
    }

    this.glowGeometry = new THREE.BufferGeometry();
    this.glowGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    // Die Wolke deckt die ganze Karte ab; eine Hüllkugel dafür wäre so groß
    // wie die Karte und würde ohnehin nie aussortiert.
    this.glowGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.glowMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        farbe: { value: new THREE.Color(WARM) },
        // Wie groß der Schein auf einen Meter Entfernung ist. Derselbe
        // Umrechnungsweg wie bei den Funken.
        groesse: { value: 260 },
        // Wie weit der Schein zur Kamera hin vorgezogen wird. Siehe unten.
        vorlauf: { value: 0.45 },
      },
      vertexShader: `
        uniform float groesse;
        uniform float vorlauf;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // Der Punkt sitzt mitten im Glaskörper, und der ist undurchsichtig.
          // Ein Punkt-Sprite wird als Ganzes gegen die Tiefe *seines Mittel-
          // punkts* geprüft — steckt der in einer Wand, verschwindet der ganze
          // Schein. Genau das war zu sehen: die Lichtpfütze lag auf dem Boden,
          // die Laterne selbst blieb dunkel.
          //
          // Deshalb im Sichtraum ein Stück zur Kamera hin, weiter als der
          // Glaskörper halb breit ist. Vom Lampenkopf verdeckt wird der Schein
          // damit nicht mehr, von einem Baum davor weiterhin schon — und
          // genau so soll es sein.
          mv.z = min(mv.z + vorlauf, -0.05);
          gl_PointSize = groesse / max(0.001, -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform vec3 farbe;
        void main() {
          // Weicher Abfall nach außen, im Kern fast weiß — so sieht eine
          // Flamme durch Glas aus, ein gleichmäßiger Kreis dagegen nach
          // Aufkleber.
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;
          float f = 1.0 - d * 2.0;
          float kern = pow(f, 6.0);
          float hof = pow(f, 2.0) * 0.35;
          gl_FragColor = vec4(mix(farbe, vec3(1.0), kern * 0.6), kern + hof);
        }
      `,
    });

    this.glow = new THREE.Points(this.glowGeometry, this.glowMaterial);
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 5;
    this.root.add(this.glow);
  }

  /**
   * Verteilt die vorhandenen Lichter auf die nächstgelegenen Laternen.
   *
   * Die Helligkeit läuft am Rand des Betrachtungsbereichs auf null aus. Ohne
   * das springt eine Lichtpfütze an, sobald man nah genug ist — und aus, sobald
   * eine nähere Laterne das Licht erbt.
   */
  update(viewerX: number, viewerZ: number): void {
    this.ranked.length = 0;
    for (const place of this.places) {
      const dx = place.x - viewerX;
      const dz = place.z - viewerZ;
      const d2 = dx * dx + dz * dz;
      if (d2 > CONSIDER * CONSIDER) continue;
      this.ranked.push({ place, d2 });
    }
    this.ranked.sort((a, b) => a.d2 - b.d2);

    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i]!;
      const entry = this.ranked[i];
      if (!entry) {
        light.visible = false;
        light.intensity = 0;
        continue;
      }

      const d = Math.sqrt(entry.d2);
      // Zwischen RANGE und CONSIDER ausblenden.
      const fade = d <= RANGE ? 1 : Math.max(0, 1 - (d - RANGE) / (CONSIDER - RANGE));
      light.position.set(entry.place.x, entry.place.y, entry.place.z);
      light.intensity = 14 * fade;
      light.visible = fade > 0.001;
    }
  }

  dispose(): void {
    this.glowGeometry?.dispose();
    this.glowMaterial?.dispose();
    for (const light of this.lights) light.dispose();
  }
}
