/**
 * Funken.
 *
 * Ein Treffer braucht ein Bild. Bisher erschien eine Zahl über dem Monster und
 * sonst nichts — beim Bogen sogar in achtzehn Metern Entfernung, wo die Zahl
 * klein ist und der Pfeil schon verschwunden. Was fehlt, ist der Moment des
 * Aufpralls.
 *
 * Alles läuft über **eine** Punktewolke mit fester Größe. Kein Objekt je
 * Funken, keine Geometrie je Treffer, kein Speicher, der zur Laufzeit wächst:
 * in einem Getümmel schlagen ein Dutzend Wesen gleichzeitig zu, und wenn dabei
 * zwölfmal etwas angelegt wird, merkt man das auf einem Telefon sofort. Die
 * Wolke ist ein Ringpuffer — sind alle Plätze belegt, überschreibt der neueste
 * Funken den ältesten. Ein Treffer, den man nicht sieht, ist besser als ein
 * Bild, das stockt.
 *
 * Gerechnet wird auf der CPU. Bei ein paar hundert Punkten ist das billiger als
 * jede Alternative, und es hält den Zustand an einer Stelle statt in einer
 * Textur.
 */

import * as THREE from 'three';

export interface BurstOptions {
  /** Wie viele Funken. Wird an der Kapazität gedeckelt. */
  count: number;
  /** Grundfarbe, 0xRRGGBB. */
  color: number;
  /** Anfangsgeschwindigkeit in Weltnenheiten je Sekunde. */
  speed: number;
  /** Punktgröße in Bildpunkten auf einen Meter Entfernung. */
  size: number;
  /** Lebensdauer in Sekunden. */
  life: number;
  /**
   * Aufwärtsdrall von 0 bis 1.
   *
   * Null streut in alle Richtungen gleich, eins schickt alles nach oben. Ein
   * Treffer sieht mit etwas Drall nach oben richtiger aus — Funken fallen, sie
   * versickern nicht.
   */
  lift: number;
}

/** Erdbeschleunigung der Funken. Kleiner als echt: sonst fallen sie wie Steine. */
const GRAVITY = 9.0;
/** Luftwiderstand je Sekunde. Bremst den Ausbruch ab, statt ihn ausfransen zu lassen. */
const DRAG = 2.6;

export class ParticleField {
  readonly object: THREE.Points;

  private readonly capacity: number;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;

  /** Geschwindigkeit je Funken. Bleibt auf der CPU. */
  private readonly velocities: Float32Array;
  /** Verbleibende und ursprüngliche Lebensdauer. Null heißt: Platz ist frei. */
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly baseSize: Float32Array;
  /** Ursprüngliche Farbe — die sichtbare wird über die Lebensdauer gedimmt. */
  private readonly baseColor: Float32Array;

  /** Nächster Platz im Ringpuffer. */
  private cursor = 0;
  /** Wie viele Plätze gerade belegt sind. Nur zur Auskunft. */
  private live = 0;

  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;

  constructor(capacity = 512) {
    this.capacity = Math.max(1, capacity);

    this.positions = new Float32Array(this.capacity * 3);
    this.colors = new Float32Array(this.capacity * 3);
    this.sizes = new Float32Array(this.capacity);
    this.velocities = new Float32Array(this.capacity * 3);
    this.life = new Float32Array(this.capacity);
    this.maxLife = new Float32Array(this.capacity);
    this.baseSize = new Float32Array(this.capacity);
    this.baseColor = new Float32Array(this.capacity * 3);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
    // Die Wolke wandert über die ganze Karte; eine Hüllkugel dafür wäre so groß
    // wie die Karte und würde nie aussortiert.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    this.material = new THREE.ShaderMaterial({
      // Additiv und ohne Tiefenschreiben: Funken sind Licht, kein Material.
      // Damit blendet das Ausklingen von selbst aus — was gegen Schwarz geht,
      // verschwindet additiv, ohne dass eine Alphastufe nötig wäre.
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      vertexShader: `
        attribute float size;
        varying vec3 vColor;

        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // Perspektivisch kleiner werdend, sonst sind ferne Treffer so groß
          // wie nahe.
          gl_PointSize = size * (300.0 / max(0.001, -mv.z));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;

        void main() {
          // Runder Funken mit weichem Rand statt eines Quadrats.
          vec2 d = gl_PointCoord - vec2(0.5);
          float r2 = dot(d, d);
          if (r2 > 0.25) discard;
          float falloff = 1.0 - smoothstep(0.0, 0.25, r2);
          gl_FragColor = vec4(vColor * falloff, 1.0);
        }
      `,
      vertexColors: true,
    });

    this.object = new THREE.Points(this.geometry, this.material);
    this.object.name = 'partikel';
    this.object.frustumCulled = false;
    // Nach dem Gelände und den Figuren, damit additives Licht darüberliegt.
    this.object.renderOrder = 5;
  }

  /** Belegte Plätze. Für Prüfungen und zum Nachsehen. */
  get liveCount(): number {
    return this.live;
  }

  /**
   * Streut Funken an einer Stelle.
   *
   * Die Richtungen sind gleichmäßig auf einer Kugel verteilt und dann nach oben
   * verzogen. Gleichmäßig heißt hier wirklich gleichmäßig: `acos(1 - 2u)` statt
   * eines zufälligen Winkels, sonst häufen sich die Funken an den Polen.
   */
  burst(x: number, y: number, z: number, options: BurstOptions): void {
    const count = Math.min(options.count, this.capacity);
    const r = ((options.color >> 16) & 0xff) / 255;
    const g = ((options.color >> 8) & 0xff) / 255;
    const b = (options.color & 0xff) / 255;

    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
      if (this.life[i] === 0) this.live++;

      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(1 - 2 * Math.random());
      const sinPhi = Math.sin(phi);

      let dx = Math.cos(theta) * sinPhi;
      let dy = Math.cos(phi);
      let dz = Math.sin(theta) * sinPhi;

      // Nach oben verziehen und wieder normieren, damit der Drall die
      // Geschwindigkeit nicht nebenbei verändert.
      dy = dy * (1 - options.lift) + options.lift;
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len;
      dy /= len;
      dz /= len;

      // Etwas Streuung im Tempo: ein Ausbruch, in dem alles gleich schnell
      // fliegt, sieht aus wie eine Kugelschale.
      const speed = options.speed * (0.45 + Math.random() * 0.55);

      this.positions[i * 3] = x;
      this.positions[i * 3 + 1] = y;
      this.positions[i * 3 + 2] = z;

      this.velocities[i * 3] = dx * speed;
      this.velocities[i * 3 + 1] = dy * speed;
      this.velocities[i * 3 + 2] = dz * speed;

      const life = options.life * (0.7 + Math.random() * 0.6);
      this.life[i] = life;
      this.maxLife[i] = life;
      this.baseSize[i] = options.size * (0.7 + Math.random() * 0.6);

      this.baseColor[i * 3] = r;
      this.baseColor[i * 3 + 1] = g;
      this.baseColor[i * 3 + 2] = b;
    }
  }

  /** Schiebt alle Funken einen Frame weiter. */
  step(dt: number): void {
    if (this.live === 0) return;

    for (let i = 0; i < this.capacity; i++) {
      const remaining = this.life[i]!;
      if (remaining <= 0) continue;

      const next = remaining - dt;
      if (next <= 0) {
        this.life[i] = 0;
        this.sizes[i] = 0;
        this.live--;
        continue;
      }
      this.life[i] = next;

      // Luftwiderstand als einfacher Abklingfaktor. Bildratenunabhängig, weil
      // er über die Schrittweite exponentiert wird.
      const damping = Math.exp(-DRAG * dt);
      const vx = this.velocities[i * 3]! * damping;
      const vy = (this.velocities[i * 3 + 1]! - GRAVITY * dt) * damping;
      const vz = this.velocities[i * 3 + 2]! * damping;

      this.velocities[i * 3] = vx;
      this.velocities[i * 3 + 1] = vy;
      this.velocities[i * 3 + 2] = vz;

      this.positions[i * 3] += vx * dt;
      this.positions[i * 3 + 1] += vy * dt;
      this.positions[i * 3 + 2] += vz * dt;

      // Ausklingen: quadratisch, damit der Funken hell aufblitzt und dann
      // schnell verschwindet, statt gleichmäßig zu verblassen.
      const t = next / this.maxLife[i]!;
      const fade = t * t;
      this.colors[i * 3] = this.baseColor[i * 3]! * fade;
      this.colors[i * 3 + 1] = this.baseColor[i * 3 + 1]! * fade;
      this.colors[i * 3 + 2] = this.baseColor[i * 3 + 2]! * fade;
      // Etwas schrumpfen, aber nicht auf null — sonst flackert der letzte Frame.
      this.sizes[i] = this.baseSize[i]! * (0.45 + 0.55 * t);
    }

    this.geometry.attributes.position!.needsUpdate = true;
    this.geometry.attributes.color!.needsUpdate = true;
    this.geometry.attributes.size!.needsUpdate = true;
  }

  /** Löscht alle Funken — beim Kartenwechsel. */
  reset(): void {
    this.life.fill(0);
    this.sizes.fill(0);
    this.live = 0;
    this.cursor = 0;
    this.geometry.attributes.size!.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Treffer
// ---------------------------------------------------------------------------

/**
 * Wie ein Treffer aussieht.
 *
 * An einer Stelle und nicht bei jedem Aufrufer, damit Nah- und Fernkampf nicht
 * auseinanderlaufen: ein Treffer ist ein Treffer, egal womit.
 */
export interface HitEffectOptions {
  /** Kritischer Treffer — heller, mehr, schneller. */
  critical: boolean;
  /** Der Treffer war tödlich — ein deutlich größerer Ausbruch. */
  killing: boolean;
  /** Wie viele Funken höchstens. Kommt aus der Qualitätsstufe. */
  budget: number;
}

export function burstHit(
  field: ParticleField,
  x: number,
  y: number,
  z: number,
  options: HitEffectOptions,
): void {
  const scale = options.killing ? 2.2 : options.critical ? 1.5 : 1;

  field.burst(x, y, z, {
    count: Math.max(4, Math.round(options.budget * 0.25 * scale)),
    // Warmes Orange für einen gewöhnlichen Treffer, helles Gelb für einen
    // kritischen. Der Unterschied muss im Augenwinkel lesbar sein, ohne dass
    // man die Zahl liest.
    color: options.critical ? 0xffe9a0 : 0xffb45a,
    speed: 5.5 * (options.killing ? 1.4 : 1),
    size: 1.9 * (options.critical ? 1.25 : 1),
    life: 0.42,
    lift: 0.35,
  });

  // Ein zweiter, langsamerer Schwall in dunklerem Ton. Ein einzelner Ausbruch
  // wirkt flach; zwei mit verschiedener Geschwindigkeit geben Tiefe.
  field.burst(x, y, z, {
    count: Math.max(3, Math.round(options.budget * 0.15 * scale)),
    color: options.killing ? 0xff6a3a : 0xc4622a,
    speed: 2.4,
    size: 2.8,
    life: 0.62,
    lift: 0.55,
  });
}
