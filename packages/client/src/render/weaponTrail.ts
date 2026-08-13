/**
 * Der Schweif hinter einer geschwungenen Klinge.
 *
 * Ein Hieb ist in dem Moment vorbei, in dem man ihn sieht — bei einer halben
 * Sekunde Animation und sechzig Bildern bleibt von der Bewegung im Auge fast
 * nichts. Der Schweif hält den Weg der Klinge kurz fest und macht aus einer
 * schnellen Drehung einen sichtbaren Bogen.
 *
 * **Ein Band, keine Funken.** Aufgezeichnet wird nicht die Spitze, sondern die
 * ganze Klinge: je Bild ein Paar aus Griffende und Spitze. Zwischen zwei
 * aufeinanderfolgenden Paaren spannt sich ein Viereck, und die Kette dieser
 * Vierecke ist das Band. Eine Punktspur der Spitze allein ergäbe einen Faden;
 * was man auf dem Bild sieht, ist eine Fläche.
 *
 * **Ein Puffer für alle.** Wie bei den Funken: eine Geometrie, ein
 * Zeichenaufruf, egal wie viele gleichzeitig zuschlagen. Wer je Figur ein
 * eigenes Band anlegte, hätte bei zehn Kämpfenden zehn Aufrufe und zehnmal
 * denselben Shader.
 *
 * **Additiv und ohne Tiefenschreiben.** Der Schweif ist Licht: er verdeckt
 * nichts, er verblasst von selbst gegen den Hintergrund, und wo zwei Bänder
 * übereinanderliegen, wird es heller statt undurchsichtig. Die Tiefe wird
 * trotzdem geprüft — ein Hieb hinter einem Baum gehört hinter den Baum.
 */

import { Gfx } from '../gfx/gfx.ts';
import { Netz } from '../gfx/mesh.ts';
import { PLATZ, Program } from '../gfx/program.ts';
import type { Mat4 } from '../gfx/math.ts';

/** Zahlen je Ecke: Ort, Farbe, Helligkeit. */
const PRO_ECKE = 7;

/**
 * Wie lange eine Probe im Band bleibt.
 *
 * Kürzer als die Schlaganimation (0,45 s), und das ist der Punkt: der Schweif
 * hängt der Klinge nach, statt den ganzen Hieb als geschlossenen Ring
 * stehenzulassen. Bei zwei Zehntelsekunden bleibt ungefähr ein Viertelkreis
 * stehen — genug für den Eindruck von Schwung, zu wenig für eine Schlaufe.
 */
const LEBENSDAUER = 0.2;

/** So viele Proben je Figur. Bei 60 Bildern sind das zwei Zehntelsekunden. */
const PROBEN = 14;

/** So viele Figuren können gleichzeitig einen Schweif ziehen. */
const BAENDER = 8;

/** Ecken je Band: (PROBEN − 1) Vierecke zu je zwei Dreiecken. */
const ECKEN_JE_BAND = (PROBEN - 1) * 6;

const VERTEX = `#version 300 es
layout(location = ${PLATZ.position}) in vec3 a_ort;
layout(location = ${PLATZ.farbe}) in vec3 a_farbe;
layout(location = ${PLATZ.extra0}) in float a_licht;

uniform mat4 u_sicht;
uniform mat4 u_projektion;

out vec3 v_farbe;
out float v_licht;

void main() {
  v_farbe = a_farbe;
  v_licht = a_licht;
  gl_Position = u_projektion * u_sicht * vec4(a_ort, 1.0);
}
`;

const FRAGMENT = `#version 300 es
precision mediump float;

in vec3 v_farbe;
in float v_licht;
out vec4 farbe;

void main() {
  // Additiv: die Helligkeit steckt in der Farbe, nicht im Alphakanal. Was
  // gegen null geht, verschwindet damit von selbst gegen jeden Hintergrund.
  farbe = vec4(v_farbe * v_licht, 1.0);
}
`;

interface Probe {
  /** Griffende und Spitze in Weltkoordinaten. */
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  /** Sekunden seit der Aufzeichnung. */
  alter: number;
}

interface Band {
  entityId: number;
  farbe: [number, number, number];
  /** Jüngste zuerst. */
  proben: Probe[];
}

export class WeaponTrail {
  private readonly baender: Band[] = [];
  private readonly ecken = new Float32Array(BAENDER * ECKEN_JE_BAND * PRO_ECKE);
  /** Wie viele Ecken im letzten Aufbau tatsächlich beschrieben wurden. */
  private benutzt = 0;

  private netz?: Netz;
  private programm?: Program;
  private gfx?: Gfx;

  /**
   * Zeichnet eine Klingenlage auf.
   *
   * Wird je Bild gerufen, solange ein Hieb läuft. Wer aufhört zu schlagen,
   * ruft nicht mehr — das Band verblasst dann von selbst, statt abrupt zu
   * verschwinden.
   */
  probiere(
    entityId: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    farbe: [number, number, number],
  ): void {
    let band = this.baender.find((b) => b.entityId === entityId);
    if (!band) {
      // Voll? Dann weicht das älteste. Acht gleichzeitige Schweife sieht
      // ohnehin niemand einzeln, und ein wachsender Puffer im Gefecht ist die
      // Sorte Kosten, die genau dann anfällt, wenn es eng wird.
      if (this.baender.length >= BAENDER) {
        let aeltester = 0;
        for (let i = 1; i < this.baender.length; i++) {
          const a = this.baender[i]!.proben[0]?.alter ?? Infinity;
          const b = this.baender[aeltester]!.proben[0]?.alter ?? Infinity;
          if (a > b) aeltester = i;
        }
        this.baender.splice(aeltester, 1);
      }
      band = { entityId, farbe, proben: [] };
      this.baender.push(band);
    }

    band.farbe = farbe;
    band.proben.unshift({ ax, ay, az, bx, by, bz, alter: 0 });
    if (band.proben.length > PROBEN) band.proben.length = PROBEN;
  }

  /** Lässt alle Bänder altern und wirft ab, was verblasst ist. */
  step(dt: number): void {
    for (let i = this.baender.length - 1; i >= 0; i--) {
      const band = this.baender[i]!;
      for (const p of band.proben) p.alter += dt;
      while (band.proben.length > 0 && band.proben[band.proben.length - 1]!.alter > LEBENSDAUER) {
        band.proben.pop();
      }
      if (band.proben.length === 0) this.baender.splice(i, 1);
    }
  }

  /** Löscht alles — beim Kartenwechsel. */
  reset(): void {
    this.baender.length = 0;
    this.benutzt = 0;
  }

  /**
   * Baut die Vierecke und zeichnet sie.
   *
   * Der Aufbau läuft je Bild neu über die Proben. Das ist billiger, als es
   * klingt — acht Bänder zu dreizehn Vierecken sind sechshundert Ecken —, und
   * er erspart jede Buchhaltung darüber, welcher Puffer gerade welchem Band
   * gehört.
   */
  zeichne(gfx: Gfx, sicht: Mat4, projektion: Mat4): void {
    this.benutzt = 0;
    if (this.baender.length === 0) return;

    const d = this.ecken;
    let o = 0;

    for (const band of this.baender) {
      const [r, g, b] = band.farbe;
      for (let i = 0; i + 1 < band.proben.length; i++) {
        const jung = band.proben[i]!;
        const alt = band.proben[i + 1]!;

        // Helligkeit nach Alter, quadratisch: der Schweif blitzt hinter der
        // Klinge auf und verläuft nach hinten schnell ins Nichts. Linear sähe
        // er aus wie ein Stück Stoff.
        const hJung = Math.max(0, 1 - jung.alter / LEBENSDAUER) ** 2;
        const hAlt = Math.max(0, 1 - alt.alter / LEBENSDAUER) ** 2;
        if (hJung <= 0.001 && hAlt <= 0.001) continue;

        // Am Griff dunkler als an der Spitze: dort bewegt sich die Klinge
        // kaum, und ein gleichmässig helles Band sähe aus wie ein Fächer.
        const setze = (
          x: number, y: number, z: number, licht: number,
        ): void => {
          d[o] = x;
          d[o + 1] = y;
          d[o + 2] = z;
          d[o + 3] = r;
          d[o + 4] = g;
          d[o + 5] = b;
          d[o + 6] = licht;
          o += PRO_ECKE;
        };

        const griffJung = hJung * 0.35;
        const griffAlt = hAlt * 0.35;

        // Zwei Dreiecke je Viereck: Griff/Spitze der jungen Probe, Griff/Spitze
        // der älteren.
        setze(jung.ax, jung.ay, jung.az, griffJung);
        setze(jung.bx, jung.by, jung.bz, hJung);
        setze(alt.bx, alt.by, alt.bz, hAlt);

        setze(jung.ax, jung.ay, jung.az, griffJung);
        setze(alt.bx, alt.by, alt.bz, hAlt);
        setze(alt.ax, alt.ay, alt.az, griffAlt);
      }
    }

    this.benutzt = o / PRO_ECKE;
    if (this.benutzt === 0) return;

    this.bereite(gfx);
    if (!this.netz || !this.programm) return;

    this.netz.schreibe(d, this.benutzt);
    // Beide Seiten: ein Band hat keine Rückseite, und je nachdem, von wo man
    // zusieht, zeigen seine Dreiecke in die eine oder die andere Richtung.
    gfx.setzeZustand({ mischung: 'additiv', tiefeSchreiben: false, seiten: 'beide' });
    this.programm.nutze();
    this.programm.mat4('u_sicht', sicht);
    this.programm.mat4('u_projektion', projektion);
    this.netz.zeichne('dreiecke');
  }

  private bereite(gfx: Gfx): void {
    if (this.gfx === gfx && this.netz) return;
    this.netz?.dispose();
    this.programm?.dispose();
    this.gfx = gfx;

    this.programm = new Program(gfx, 'schweif', VERTEX, FRAGMENT);
    this.netz = new Netz(
      gfx,
      this.ecken,
      [
        { platz: PLATZ.position, groesse: 3, versatz: 0 },
        { platz: PLATZ.farbe, groesse: 3, versatz: 3 },
        { platz: PLATZ.extra0, groesse: 1, versatz: 6 },
      ],
      PRO_ECKE,
      undefined,
      true,
    );
  }

  dispose(): void {
    this.netz?.dispose();
    this.programm?.dispose();
    this.netz = undefined;
    this.programm = undefined;
  }
}
