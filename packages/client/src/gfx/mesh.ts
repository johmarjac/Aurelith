/**
 * Puffer und Netze — was gezeichnet wird, und wie es im Speicher liegt.
 *
 * Ein `Netz` ist ein Vertex-Array-Objekt mit allem, was daran hängt. Das VAO
 * ist der Grund, warum das hier so wenig Code ist: die gesamte Zuordnung von
 * Puffern zu Attributplätzen wird **einmal** aufgezeichnet und beim Zeichnen
 * mit einem einzigen Aufruf wieder eingespielt. In WebGL 1 war das eine
 * Erweiterung; in WebGL 2 ist es der Normalfall.
 *
 * Attribute liegen **verschränkt** (Position, Normale, UV hintereinander je
 * Ecke) und nicht in getrennten Feldern. Das ist eine Entscheidung für die
 * Grafikkarte: sie liest eine Ecke als einen zusammenhängenden Block, und
 * jeder Wechsel zwischen weit auseinanderliegenden Feldern kostet einen
 * Cache-Zugriff mehr. Wo Werte je Bild neu geschrieben werden — Funken —,
 * spart es zusätzlich: ein Upload statt drei.
 */

import type { Gfx } from './gfx.ts';

/** Ein Attribut im verschränkten Block. */
export interface AttributPlan {
  /** Platz im Shader, siehe `PLATZ`. */
  platz: number;
  /** Wie viele Zahlen — 1 bis 4. */
  groesse: number;
  /** Versatz in Fliesskommazahlen vom Anfang einer Ecke. */
  versatz: number;
  /**
   * Je Instanz statt je Ecke.
   *
   * Für instanziierte Props: die Ecken kommen einmal, die Matrizen je
   * Exemplar. Ohne das gäbe es je Zaunpfahl einen Zeichenaufruf.
   */
  jeInstanz?: boolean;
}

export type Zeichenart = 'dreiecke' | 'linien' | 'punkte';

export class Netz {
  private readonly gl: WebGL2RenderingContext;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly ibo?: WebGLBuffer;

  /** Wie viele Zahlen eine Ecke belegt. */
  private readonly schrittweite: number;
  /** Wie viele Ecken bzw. Indizes gezeichnet werden. */
  private anzahl = 0;
  private readonly indiziert: boolean;

  /**
   * @param daten   Verschränkte Eckdaten. Darf leer sein und später kommen.
   * @param plan    Welche Attribute wo im Block liegen.
   * @param schrittweite Zahlen je Ecke.
   * @param indizes Optionale Indexliste.
   * @param wandelbar Wird je Bild neu geschrieben?
   */
  constructor(
    private readonly gfx: Gfx,
    daten: Float32Array,
    plan: readonly AttributPlan[],
    schrittweite: number,
    indizes?: Uint16Array | Uint32Array,
    wandelbar = false,
  ) {
    const gl = gfx.gl;
    this.gl = gl;
    this.schrittweite = schrittweite;
    this.indiziert = indizes !== undefined;

    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error('[gfx] Netz: Puffer konnten nicht angelegt werden');
    this.vao = vao;
    this.vbo = vbo;

    gfx.bindeVao(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, daten, wandelbar ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);

    const bytes = Float32Array.BYTES_PER_ELEMENT;
    for (const a of plan) {
      gl.enableVertexAttribArray(a.platz);
      gl.vertexAttribPointer(
        a.platz,
        a.groesse,
        gl.FLOAT,
        false,
        schrittweite * bytes,
        a.versatz * bytes,
      );
      if (a.jeInstanz) gl.vertexAttribDivisor(a.platz, 1);
    }

    if (indizes) {
      const ibo = gl.createBuffer();
      if (!ibo) throw new Error('[gfx] Netz: Indexpuffer konnte nicht angelegt werden');
      this.ibo = ibo;
      // Der Indexpuffer gehört zum VAO — deshalb hier gebunden und nicht später.
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indizes, gl.STATIC_DRAW);
      this.anzahl = indizes.length;
      this.indexTyp = indizes instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    } else {
      this.anzahl = schrittweite > 0 ? daten.length / schrittweite : 0;
    }

    // Sauber verlassen: ein offen gebundenes VAO fängt die Puffer des nächsten
    // Anlegenden ein, und das ist ein Fehler, den man erst drei Netze später
    // sieht.
    gfx.bindeVao(null);
  }

  private indexTyp = 0;

  /**
   * Schreibt Eckdaten neu — für alles, was sich je Bild ändert.
   *
   * `anzahlEcken` deckelt, was davon gezeichnet wird: ein Ringpuffer ist meist
   * nur teilweise gefüllt, und der Rest soll nicht als Dreieck bei null
   * erscheinen.
   */
  schreibe(daten: Float32Array, anzahlEcken: number): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, daten);
    if (!this.indiziert) this.anzahl = anzahlEcken;
  }

  zeichne(art: Zeichenart = 'dreiecke', instanzen = 0): void {
    if (this.anzahl === 0) return;
    const gl = this.gl;
    const modus = art === 'dreiecke' ? gl.TRIANGLES : art === 'linien' ? gl.LINES : gl.POINTS;

    this.gfx.bindeVao(this.vao);
    if (this.indiziert) {
      if (instanzen > 0) gl.drawElementsInstanced(modus, this.anzahl, this.indexTyp, 0, instanzen);
      else gl.drawElements(modus, this.anzahl, this.indexTyp, 0);
    } else if (instanzen > 0) {
      gl.drawArraysInstanced(modus, 0, this.anzahl, instanzen);
    } else {
      gl.drawArrays(modus, 0, this.anzahl);
    }
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.vbo);
    if (this.ibo) gl.deleteBuffer(this.ibo);
    gl.deleteVertexArray(this.vao);
  }
}
