/**
 * Der Kontext und sein Zustand — die unterste Schicht unseres Renderers.
 *
 * WebGL ist eine Zustandsmaschine, und der teuerste Fehler im Umgang mit ihr
 * ist, denselben Zustand mehrmals je Bild zu setzen. Deshalb liegt hier ein
 * Speicher davor: was schon gilt, wird nicht noch einmal gesetzt.
 *
 * **Der Speicher darf nie besser wissen als die Wirklichkeit.** Solange
 * three.js im selben Kontext zeichnet, ist zwischen zwei unserer Pässe alles
 * verstellt. Ein Pass beginnt deshalb mit `beginnePass()`, und das *vergisst*
 * den Speicher, statt ihn für gültig zu halten. Ohne diese eine Zeile wären
 * die Fehler daraus die schlimmste Sorte: sie hingen davon ab, was ein anderes
 * Stück Code vorher gezeichnet hat.
 */

/** Wie gemischt wird. Mehr Fälle gibt es bei uns nicht. */
export type Mischung = 'aus' | 'alpha' | 'additiv';
/** Welche Seiten wegfallen. */
export type Seiten = 'hinten' | 'vorne' | 'beide';

export interface Zustand {
  tiefeTest: boolean;
  tiefeSchreiben: boolean;
  mischung: Mischung;
  seiten: Seiten;
}

const VORGABE: Zustand = {
  tiefeTest: true,
  tiefeSchreiben: true,
  mischung: 'aus',
  seiten: 'hinten',
};

export class Gfx {
  readonly gl: WebGL2RenderingContext;

  /** Was zuletzt gesetzt wurde. `undefined` heisst: unbekannt, also neu setzen. */
  private zustand?: Zustand;
  private programm: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  /** Welche Textur in welcher Einheit hängt. Index = Einheit. */
  private readonly einheiten: Array<WebGLTexture | null> = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  /**
   * Holt den Kontext von einer Leinwand.
   *
   * Eine Leinwand hat genau **einen** Kontext — wer zweimal fragt, bekommt
   * denselben zurück, und wer WebGL 1 daneben anlegen wollte, bekäme null.
   * Genau darauf beruht der schrittweise Umbau: unsere Pässe und three.js
   * teilen sich denselben Kontext, statt zwei Leinwände übereinanderzulegen.
   */
  static vonLeinwand(canvas: HTMLCanvasElement): Gfx {
    const gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL 2 ist auf diesem Gerät nicht verfügbar.');
    return new Gfx(gl);
  }

  /** Beginnt einen eigenen Zeichenabschnitt: alles Gemerkte gilt nicht mehr. */
  beginnePass(): void {
    this.zustand = undefined;
    this.programm = null;
    this.vao = null;
    this.einheiten.length = 0;
  }

  /**
   * Stellt den Zeichenzustand ein. Was nicht genannt ist, geht auf die Vorgabe
   * zurück — nicht auf „bleibt, wie es war".
   *
   * Der Unterschied ist der zwischen einem Pass, der überall gleich aussieht,
   * und einem, der davon abhängt, was vorher gezeichnet wurde.
   */
  setzeZustand(wunsch: Partial<Zustand>): void {
    const z: Zustand = { ...VORGABE, ...wunsch };
    const alt = this.zustand;
    const gl = this.gl;

    if (!alt || alt.tiefeTest !== z.tiefeTest) {
      if (z.tiefeTest) gl.enable(gl.DEPTH_TEST);
      else gl.disable(gl.DEPTH_TEST);
    }
    if (!alt || alt.tiefeSchreiben !== z.tiefeSchreiben) gl.depthMask(z.tiefeSchreiben);

    if (!alt || alt.mischung !== z.mischung) {
      if (z.mischung === 'aus') {
        gl.disable(gl.BLEND);
      } else {
        gl.enable(gl.BLEND);
        // Vorgemischtes Alpha wird nicht verwendet: unsere Texturen kommen als
        // gewöhnliche PNGs, und ein Mischmodus, der etwas anderes annimmt,
        // säumt jede Kante dunkel.
        if (z.mischung === 'alpha') gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        else gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      }
    }

    if (!alt || alt.seiten !== z.seiten) {
      if (z.seiten === 'beide') {
        gl.disable(gl.CULL_FACE);
      } else {
        gl.enable(gl.CULL_FACE);
        gl.cullFace(z.seiten === 'hinten' ? gl.BACK : gl.FRONT);
      }
    }

    this.zustand = z;
  }

  nutzeProgramm(programm: WebGLProgram): void {
    if (this.programm === programm) return;
    this.gl.useProgram(programm);
    this.programm = programm;
  }

  bindeVao(vao: WebGLVertexArrayObject | null): void {
    if (this.vao === vao) return;
    this.gl.bindVertexArray(vao);
    this.vao = vao;
  }

  bindeTextur(einheit: number, textur: WebGLTexture | null): void {
    if (this.einheiten[einheit] === textur) return;
    this.gl.activeTexture(this.gl.TEXTURE0 + einheit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, textur);
    this.einheiten[einheit] = textur;
  }
}
