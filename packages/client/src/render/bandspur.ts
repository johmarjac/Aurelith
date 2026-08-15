/**
 * Ein Band, das einer bewegten Kante nachhängt.
 *
 * Zwei Dinge im Spiel sehen so aus, und beide sind dieselbe Sache: der Schweif
 * hinter einer geschwungenen Klinge und die Fahne hinter einem Flugbrett. In
 * beiden Fällen wird je Bild **eine Kante** aufgezeichnet — zwei Punkte —, und
 * zwischen zwei aufeinanderfolgenden Kanten spannt sich ein Viereck. Die Kette
 * dieser Vierecke ist das Band. Eine Punktspur allein ergäbe einen Faden; was
 * man auf dem Bild sieht, ist eine Fläche.
 *
 * Ein Hieb ist in dem Moment vorbei, in dem man ihn sieht — bei einer halben
 * Sekunde Animation und sechzig Bildern bleibt von der Bewegung im Auge fast
 * nichts. Das Band hält den Weg kurz fest und macht aus einer schnellen
 * Drehung einen sichtbaren Bogen.
 *
 * **Ein Puffer für alle.** Wie bei den Funken: eine Geometrie, ein
 * Zeichenaufruf, egal wie viele gleichzeitig zuschlagen. Wer je Figur ein
 * eigenes Band anlegte, hätte bei zehn Kämpfenden zehn Aufrufe und zehnmal
 * denselben Shader.
 *
 * **Additiv und ohne Tiefenschreiben.** Das Band ist Licht: es verdeckt
 * nichts, es verblasst von selbst gegen den Hintergrund, und wo zwei Bänder
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
 * Wie ein Band aussieht — die Zahlen, in denen sich Klinge und Brett
 * unterscheiden.
 *
 * Alles andere ist gleich, und deshalb steht es auch nur einmal da.
 */
export interface BandspurOptionen {
  /**
   * Wie lange eine Probe im Band bleibt.
   *
   * Bei der Klinge kürzer als die Schlaganimation (0,45 s), und das ist der
   * Punkt: der Schweif hängt der Klinge nach, statt den ganzen Hieb als
   * geschlossenen Ring stehenzulassen. Bei zwei Zehntelsekunden bleibt
   * ungefähr ein Viertelkreis stehen — genug für den Eindruck von Schwung, zu
   * wenig für eine Schlaufe.
   */
  lebensdauer: number;
  /** So viele Proben je Figur. Bei 60 Bildern ist das die Länge in Sekunden. */
  proben: number;
  /** So viele Figuren können gleichzeitig ein Band ziehen. */
  baender: number;
  /**
   * Wie hell die **erste** der beiden Kantenpunkte ist, 0 bis 1.
   *
   * Bei der Klinge dunkel: dort ist der Griff, der sich kaum bewegt, und ein
   * gleichmässig helles Band sähe aus wie ein Fächer. Beim Brett ist es die
   * andere Seite derselben Kante und gehört genauso hell wie die erste.
   */
  ersteKante: number;
}

/** Der Schweif hinter einer Klinge. */
export const KLINGENBAND: BandspurOptionen = {
  lebensdauer: 0.2,
  proben: 14,
  baender: 8,
  ersteKante: 0.35,
};

/**
 * Die Fahne hinter einem Flugbrett.
 *
 * Länger als beim Schweif, und das ist der ganze Unterschied: ein Brett fährt
 * mit zehn Metern je Sekunde, eine halbe Sekunde sind also gut fünf Meter —
 * „ein paar Meter", wie es aussehen soll. Bei dreissig Proben reicht das auch
 * dann noch zurück, wenn die Bildrate einbricht.
 */
export const BRETTBAND: BandspurOptionen = {
  lebensdauer: 0.55,
  proben: 30,
  baender: 6,
  ersteKante: 1,
};

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
  /** Die beiden Enden der aufgezeichneten Kante, in Weltkoordinaten. */
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

export class Bandspur {
  private readonly baender: Band[] = [];
  private readonly ecken: Float32Array;
  /** Wie viele Ecken im letzten Aufbau tatsächlich beschrieben wurden. */
  private benutzt = 0;

  private netz?: Netz;
  private programm?: Program;
  private gfx?: Gfx;

  constructor(private readonly opt: BandspurOptionen = KLINGENBAND) {
    // Ecken je Band: (Proben − 1) Vierecke zu je zwei Dreiecken.
    this.ecken = new Float32Array(opt.baender * (opt.proben - 1) * 6 * PRO_ECKE);
  }

  /**
   * Zeichnet eine Kante auf.
   *
   * Wird je Bild gerufen, solange es etwas aufzuzeichnen gibt. Wer aufhört —
   * der Hieb ist vorbei, das Brett steht still —, ruft nicht mehr: das Band
   * verblasst dann von selbst, statt abrupt zu verschwinden.
   */
  probiere(
    entityId: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    farbe: [number, number, number],
  ): void {
    let band = this.baender.find((b) => b.entityId === entityId);
    if (!band) {
      // Voll? Dann weicht das älteste. Acht gleichzeitige Bänder sieht ohnehin
      // niemand einzeln, und ein wachsender Puffer im Gefecht ist die Sorte
      // Kosten, die genau dann anfällt, wenn es eng wird.
      if (this.baender.length >= this.opt.baender) {
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
    if (band.proben.length > this.opt.proben) band.proben.length = this.opt.proben;
  }

  /** Lässt alle Bänder altern und wirft ab, was verblasst ist. */
  step(dt: number): void {
    for (let i = this.baender.length - 1; i >= 0; i--) {
      const band = this.baender[i]!;
      for (const p of band.proben) p.alter += dt;
      while (band.proben.length > 0 && band.proben[band.proben.length - 1]!.alter > this.opt.lebensdauer) {
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

        // Helligkeit nach Alter, quadratisch: das Band blitzt hinter der Kante
        // auf und verläuft nach hinten schnell ins Nichts. Linear sähe es aus
        // wie ein Stück Stoff.
        const hJung = Math.max(0, 1 - jung.alter / this.opt.lebensdauer) ** 2;
        const hAlt = Math.max(0, 1 - alt.alter / this.opt.lebensdauer) ** 2;
        if (hJung <= 0.001 && hAlt <= 0.001) continue;

        // Wie hell die erste Kantenhälfte steht, entscheidet `ersteKante` —
        // beim Schweif der dunkle Griff, beim Brett die zweite Brettkante.
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

        const ersteJung = hJung * this.opt.ersteKante;
        const ersteAlt = hAlt * this.opt.ersteKante;

        // Zwei Dreiecke je Viereck: beide Kantenpunkte der jungen Probe, beide
        // der älteren.
        setze(jung.ax, jung.ay, jung.az, ersteJung);
        setze(jung.bx, jung.by, jung.bz, hJung);
        setze(alt.bx, alt.by, alt.bz, hAlt);

        setze(jung.ax, jung.ay, jung.az, ersteJung);
        setze(alt.bx, alt.by, alt.bz, hAlt);
        setze(alt.ax, alt.ay, alt.az, ersteAlt);
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

    this.programm = new Program(gfx, 'bandspur', VERTEX, FRAGMENT);
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
