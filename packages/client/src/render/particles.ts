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
 *
 * **Das erste Stück Bild, das ohne three.js entsteht.** Ein eigener Pass auf
 * demselben WebGL-2-Kontext: ein Programm, ein verschränkter Puffer, ein
 * Zeichenaufruf. Alles, was der Punkt braucht, steht in dieser Datei — genau
 * die Eigenschaft, wegen der die Funken der erste Umzug sind.
 */

import { Gfx } from '../gfx/gfx.ts';
import { Netz } from '../gfx/mesh.ts';
import { PLATZ, Program } from '../gfx/program.ts';
import type { Mat4 } from '../gfx/math.ts';

/** Zahlen je Funken im Puffer: Ort, Farbe, Grösse. */
const PRO_PUNKT = 7;

const VERTEX = `#version 300 es
layout(location = ${PLATZ.position}) in vec3 a_ort;
layout(location = ${PLATZ.farbe}) in vec3 a_farbe;
layout(location = ${PLATZ.extra0}) in float a_groesse;

uniform mat4 u_sicht;
uniform mat4 u_projektion;

out vec3 v_farbe;

void main() {
  v_farbe = a_farbe;
  vec4 mv = u_sicht * vec4(a_ort, 1.0);
  // Perspektivisch kleiner werdend, sonst sind ferne Treffer so gross wie nahe.
  gl_PointSize = a_groesse * (300.0 / max(0.001, -mv.z));
  gl_Position = u_projektion * mv;
}
`;

const FRAGMENT = `#version 300 es
precision mediump float;

in vec3 v_farbe;
out vec4 farbe;

void main() {
  // Runder Funken mit weichem Rand statt eines Quadrats.
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float rand = 1.0 - smoothstep(0.0, 0.25, r2);
  farbe = vec4(v_farbe * rand, 1.0);
}
`;

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
  private readonly capacity: number;

  /**
   * Alles, was die Grafikkarte sieht — verschränkt: Ort, Farbe, Grösse.
   *
   * Ein Feld statt dreier, weil es je Bild hochgeladen wird: ein Aufruf statt
   * drei, und die Karte liest einen Funken als einen Block.
   */
  private readonly ecken: Float32Array;

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

  /**
   * Netz und Programm entstehen erst mit dem ersten Kontext.
   *
   * Die Wolke gehört der Weltansicht und wird angelegt, bevor irgendwo ein
   * Bild gezeichnet wird. Ein Programm ohne Kontext wäre an dieser Stelle
   * nicht zu übersetzen — und ein zweiter Ort, an dem die Wolke entsteht, wäre
   * eine zweite Wahrheit darüber, wie viele Funken es gibt.
   */
  private netz?: Netz;
  private programm?: Program;
  private gfx?: Gfx;

  constructor(capacity = 512) {
    this.capacity = Math.max(1, capacity);

    this.ecken = new Float32Array(this.capacity * PRO_PUNKT);
    this.velocities = new Float32Array(this.capacity * 3);
    this.life = new Float32Array(this.capacity);
    this.maxLife = new Float32Array(this.capacity);
    this.baseSize = new Float32Array(this.capacity);
    this.baseColor = new Float32Array(this.capacity * 3);
  }

  /** Belegte Plätze. Für Prüfungen und zum Nachsehen. */
  get liveCount(): number {
    return this.live;
  }

  /**
   * Die Eckdaten, wie sie zur Grafikkarte gehen — für Prüfungen.
   *
   * Sieben Zahlen je Funken: Ort, Farbe, Grösse. Nicht als Bequemlichkeit
   * offengelegt, sondern weil die Alternative wäre, die Flugbahn an einer
   * zweiten Stelle nachzurechnen — und ein Test, der seine eigene Rechnung
   * prüft, misst nichts.
   */
  get eckdaten(): Readonly<Float32Array> {
    return this.ecken;
  }

  /** Zahlen je Funken im Puffer. Der Test liest damit den richtigen Versatz. */
  static readonly PRO_PUNKT = PRO_PUNKT;

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

      const e = i * PRO_PUNKT;
      this.ecken[e] = x;
      this.ecken[e + 1] = y;
      this.ecken[e + 2] = z;

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

      const e = i * PRO_PUNKT;
      const next = remaining - dt;
      if (next <= 0) {
        this.life[i] = 0;
        this.ecken[e + 6] = 0;
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

      this.ecken[e] += vx * dt;
      this.ecken[e + 1] += vy * dt;
      this.ecken[e + 2] += vz * dt;

      // Ausklingen: quadratisch, damit der Funken hell aufblitzt und dann
      // schnell verschwindet, statt gleichmäßig zu verblassen.
      const t = next / this.maxLife[i]!;
      const fade = t * t;
      this.ecken[e + 3] = this.baseColor[i * 3]! * fade;
      this.ecken[e + 4] = this.baseColor[i * 3 + 1]! * fade;
      this.ecken[e + 5] = this.baseColor[i * 3 + 2]! * fade;
      // Etwas schrumpfen, aber nicht auf null — sonst flackert der letzte Frame.
      this.ecken[e + 6] = this.baseSize[i]! * (0.45 + 0.55 * t);
    }
  }

  /**
   * Zeichnet die Wolke — ein eigener Pass nach der Szene.
   *
   * Additiv und ohne Tiefenschreiben: Funken sind Licht, kein Material. Damit
   * blendet das Ausklingen von selbst aus, ohne dass eine Alphastufe nötig
   * wäre. Getestet wird die Tiefe trotzdem — ein Funken hinter einem Baum
   * gehört hinter den Baum.
   *
   * Es wird **die ganze Wolke** gezeichnet, auch die freien Plätze: deren
   * Grösse ist null, und ein Punkt der Grösse null erzeugt kein Fragment. Das
   * ist billiger, als die belegten Plätze je Bild zusammenzuschieben.
   */
  zeichne(gfx: Gfx, sicht: Mat4, projektion: Mat4): void {
    if (this.live === 0) return;
    this.bereite(gfx);
    if (!this.netz || !this.programm) return;

    this.netz.schreibe(this.ecken, this.capacity);

    gfx.setzeZustand({ mischung: 'additiv', tiefeSchreiben: false, seiten: 'beide' });
    this.programm.nutze();
    this.programm.mat4('u_sicht', sicht);
    this.programm.mat4('u_projektion', projektion);
    this.netz.zeichne('punkte');
  }

  /** Legt Programm und Netz beim ersten Zeichnen an. */
  private bereite(gfx: Gfx): void {
    if (this.gfx === gfx && this.netz) return;
    this.netz?.dispose();
    this.programm?.dispose();
    this.gfx = gfx;

    this.programm = new Program(gfx, 'funken', VERTEX, FRAGMENT);
    this.netz = new Netz(
      gfx,
      this.ecken,
      [
        { platz: PLATZ.position, groesse: 3, versatz: 0 },
        { platz: PLATZ.farbe, groesse: 3, versatz: 3 },
        { platz: PLATZ.extra0, groesse: 1, versatz: 6 },
      ],
      PRO_PUNKT,
      undefined,
      true,
    );
  }

  /** Löscht alle Funken — beim Kartenwechsel. */
  reset(): void {
    this.ecken.fill(0);
    this.life.fill(0);
    this.live = 0;
    this.cursor = 0;
  }

  dispose(): void {
    this.netz?.dispose();
    this.programm?.dispose();
    this.netz = undefined;
    this.programm = undefined;
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

/**
 * Der Ring der Wirbelklinge.
 *
 * Ein Kranz aus kleinen Ausbrüchen auf dem Wirkkreis und nicht ein einzelner
 * grosser in der Mitte: der Kreis ist die Aussage der Fertigkeit — wer darin
 * steht, wird getroffen — und ein Ausbruch in der Mitte sagt genau das nicht.
 *
 * Der Radius ist derselbe, mit dem der Server rechnet. Er kommt deshalb von
 * aussen herein und steht nicht hier: eine abgeschriebene Zahl wäre eine
 * zweite Wahrheit über die Reichweite, und sie wäre falsch, sobald jemand die
 * Fertigkeit in `classes.json` anfasst.
 */
export function burstWirbel(
  field: ParticleField,
  x: number,
  y: number,
  z: number,
  radius: number,
  budget: number,
): void {
  // Genug Stellen, dass der Kranz geschlossen wirkt, und nicht mehr: bei
  // sechzehn Punkten auf dreieinhalb Metern liegen sie gut eine Handbreit
  // auseinander, und das schliesst das Auge von selbst.
  const stellen = Math.max(8, Math.min(24, Math.round(budget * 0.2)));
  for (let i = 0; i < stellen; i++) {
    const w = (i / stellen) * Math.PI * 2;
    const px = x + Math.cos(w) * radius;
    const pz = z + Math.sin(w) * radius;

    // Kaltes Klingenweiss nach aussen …
    field.burst(px, y + 0.35, pz, {
      count: 2,
      color: 0xdff0ff,
      speed: 2.6,
      size: 2.2,
      life: 0.4,
      lift: 0.3,
    });
  }

  // … und ein Stoss aus der Mitte, der die Drehung selbst zeigt. Hoch genug
  // angesetzt, dass er auf Höhe der Klinge sitzt und nicht an den Füssen.
  field.burst(x, y + 0.9, z, {
    count: Math.max(6, Math.round(budget * 0.25)),
    color: 0x9ec8ff,
    speed: 4.2,
    size: 2.6,
    life: 0.5,
    lift: 0.15,
  });
}
