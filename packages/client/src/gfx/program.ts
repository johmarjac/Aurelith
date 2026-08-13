/**
 * Shaderprogramme: übersetzen, binden, mit Werten füllen.
 *
 * GLSL ES 3.00, weil der Kontext WebGL 2 ist. Damit stehen `layout(location)`
 * für Attribute und `textureLod` ohne Erweiterung zur Verfügung — die
 * Erweiterungsakrobatik, die Flyffs WebGL-1-Client betreibt, entfällt
 * vollständig.
 *
 * Zwei Dinge sind hier wichtiger als Bequemlichkeit:
 *
 *   **Ein Übersetzungsfehler nennt den Shader und die Zeile.** Ein „program
 *   link failed" ohne Quelle kostet bei prozedural zusammengesetzten Shadern
 *   mehr Zeit als der ganze Shader.
 *
 *   **Unbekannte Uniformnamen fallen auf.** Sie stumm zu schlucken ist die
 *   übliche Lösung und die schlechteste: ein Tippfehler im Namen sieht dann
 *   genauso aus wie ein Wert, der zufällig null ist.
 */

import type { Gfx } from './gfx.ts';
import type { Mat4 } from './math.ts';

/** Attributplätze, die alle Programme gleich benennen. */
export const PLATZ = {
  position: 0,
  normale: 1,
  uv: 2,
  farbe: 3,
  /** Freie Plätze für das, was ein Programm zusätzlich braucht. */
  extra0: 4,
  extra1: 5,
  extra2: 6,
} as const;

function uebersetze(
  gl: WebGL2RenderingContext,
  art: number,
  quelle: string,
  name: string,
): WebGLShader {
  const shader = gl.createShader(art);
  if (!shader) throw new Error(`${name}: Shader konnte nicht angelegt werden`);
  gl.shaderSource(shader, quelle);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '(keine Meldung)';
    gl.deleteShader(shader);
    // Mit Zeilennummern: der Meldungstext nennt eine Zeile, und die Quelle
    // steht hier zusammengesetzt aus Bausteinen — ohne Nummern sucht man sie
    // von Hand ab.
    const nummeriert = quelle
      .split('\n')
      .map((z, i) => `${String(i + 1).padStart(3)} | ${z}`)
      .join('\n');
    throw new Error(`${name} (${art === gl.VERTEX_SHADER ? 'Vertex' : 'Fragment'}):\n${log}\n${nummeriert}`);
  }
  return shader;
}

export class Program {
  readonly handle: WebGLProgram;

  private readonly orte = new Map<string, WebGLUniformLocation | null>();
  private readonly gemeldet = new Set<string>();

  constructor(
    private readonly gfx: Gfx,
    readonly name: string,
    vertex: string,
    fragment: string,
  ) {
    const gl = gfx.gl;
    const vs = uebersetze(gl, gl.VERTEX_SHADER, vertex, name);
    const fs = uebersetze(gl, gl.FRAGMENT_SHADER, fragment, name);

    const programm = gl.createProgram();
    if (!programm) throw new Error(`${name}: Programm konnte nicht angelegt werden`);
    gl.attachShader(programm, vs);
    gl.attachShader(programm, fs);
    gl.linkProgram(programm);

    // Die Shader selbst werden nicht mehr gebraucht, sobald gelinkt ist.
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(programm, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(programm) ?? '(keine Meldung)';
      gl.deleteProgram(programm);
      throw new Error(`${name}: Linken fehlgeschlagen — ${log}`);
    }

    this.handle = programm;
  }

  nutze(): void {
    this.gfx.nutzeProgramm(this.handle);
  }

  /**
   * Der Ort eines Uniforms, gemerkt.
   *
   * `getUniformLocation` ist ein Aufruf über die Grenze zum Treiber; einer je
   * Wert und Bild wäre je nach Anzahl die teuerste Zeile im ganzen Renderer.
   */
  private ort(name: string): WebGLUniformLocation | null {
    let o = this.orte.get(name);
    if (o === undefined) {
      o = this.gfx.gl.getUniformLocation(this.handle, name);
      this.orte.set(name, o);
      if (o === null && !this.gemeldet.has(name)) {
        this.gemeldet.add(name);
        // Kein Abbruch: ein Uniform, das der Übersetzer wegoptimiert hat, weil
        // es im Shader nicht benutzt wird, ist völlig in Ordnung. Aber es soll
        // einmal dastehen — ein Tippfehler sieht sonst genauso aus.
        console.warn(`[gfx] ${this.name}: Uniform „${name}" gibt es nicht (oder ist ungenutzt).`);
      }
    }
    return o;
  }

  mat4(name: string, m: Mat4): void {
    const o = this.ort(name);
    if (o) this.gfx.gl.uniformMatrix4fv(o, false, m);
  }

  float(name: string, v: number): void {
    const o = this.ort(name);
    if (o) this.gfx.gl.uniform1f(o, v);
  }

  int(name: string, v: number): void {
    const o = this.ort(name);
    if (o) this.gfx.gl.uniform1i(o, v);
  }

  vec2(name: string, x: number, y: number): void {
    const o = this.ort(name);
    if (o) this.gfx.gl.uniform2f(o, x, y);
  }

  vec3(name: string, x: number, y: number, z: number): void {
    const o = this.ort(name);
    if (o) this.gfx.gl.uniform3f(o, x, y, z);
  }

  vec4(name: string, x: number, y: number, z: number, w: number): void {
    const o = this.ort(name);
    if (o) this.gfx.gl.uniform4f(o, x, y, z, w);
  }

  /** Hängt eine Textur in eine Einheit und zeigt dem Sampler darauf. */
  textur(name: string, einheit: number, textur: WebGLTexture | null): void {
    this.gfx.bindeTextur(einheit, textur);
    this.int(name, einheit);
  }

  dispose(): void {
    this.gfx.gl.deleteProgram(this.handle);
    this.orte.clear();
  }
}
