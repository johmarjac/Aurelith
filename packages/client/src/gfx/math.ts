/**
 * Matrizen, Vektoren, Quaternionen — das Wenige, was ein Renderer braucht.
 *
 * Eigene Rechnung statt einer Bibliothek, weil sie die Grundlage dafür ist,
 * three.js abzulösen: solange die Matrizen aus `three` kommen, hängt jede
 * Zeile darüber daran mit.
 *
 * Zwei Festlegungen, die alles andere bestimmen:
 *
 *   **Spaltenweise abgelegt**, wie OpenGL es erwartet. `m[12]`, `m[13]`,
 *   `m[14]` sind die Verschiebung. Damit geht eine Matrix ohne Umbau nach
 *   `uniformMatrix4fv`, und wer sie ausdruckt, liest sie wie in jedem
 *   GL-Buch.
 *
 *   **Ergebnis zuerst, Eingaben danach** (`mul(ziel, a, b)`), und das Ziel
 *   darf eine der Eingaben sein. So entsteht in der Zeichenschleife kein
 *   einziges neues Objekt — der Grund, warum hier `Float32Array` steht und
 *   keine Klasse mit Feldern.
 *
 * Winkel überall im Bogenmaß.
 */

/** Eine 4×4-Matrix, spaltenweise. */
export type Mat4 = Float32Array;

export function mat4(): Mat4 {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

export function identity(out: Mat4): Mat4 {
  out.fill(0);
  out[0] = 1;
  out[5] = 1;
  out[10] = 1;
  out[15] = 1;
  return out;
}

export function copy(out: Mat4, m: Mat4): Mat4 {
  out.set(m);
  return out;
}

/**
 * `out = a · b` — erst b, dann a, wie in der Mathematik gelesen.
 *
 * Über Zwischenwerte, damit `out` dieselbe Matrix sein darf wie `a` oder `b`.
 * Ohne das schriebe die Rechnung ihre eigenen Eingaben um, und das Ergebnis
 * wäre für jeden Aufrufer, der Speicher spart, still falsch.
 */
export function mul(out: Mat4, a: Mat4, b: Mat4): Mat4 {
  const a00 = a[0]!, a01 = a[1]!, a02 = a[2]!, a03 = a[3]!;
  const a10 = a[4]!, a11 = a[5]!, a12 = a[6]!, a13 = a[7]!;
  const a20 = a[8]!, a21 = a[9]!, a22 = a[10]!, a23 = a[11]!;
  const a30 = a[12]!, a31 = a[13]!, a32 = a[14]!, a33 = a[15]!;

  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4]!, b1 = b[i * 4 + 1]!, b2 = b[i * 4 + 2]!, b3 = b[i * 4 + 3]!;
    out[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  }
  return out;
}

/**
 * Perspektive mit umgekehrter Handregel, wie GL sie will: Blick nach −Z.
 *
 * `far` darf unendlich sein — dann fällt der hintere Rand weg, und weit
 * entfernte Geometrie verschwindet nicht plötzlich. Gebraucht wird das für die
 * Himmelskuppel.
 */
export function perspective(
  out: Mat4,
  fovY: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[11] = -1;
  if (Number.isFinite(far)) {
    const nf = 1 / (near - far);
    out[10] = (far + near) * nf;
    out[14] = 2 * far * near * nf;
  } else {
    out[10] = -1;
    out[14] = -2 * near;
  }
  return out;
}

/**
 * Setzt eine Matrix aus Ort, Drehung (Quaternion) und Massstab zusammen.
 *
 * Die Reihenfolge ist Verschiebung ∘ Drehung ∘ Massstab und keine Geschmacks-
 * frage: andersherum skalierte man entlang der gedrehten Achsen, und ein
 * ungleichmässiger Massstab verzerrte das Modell schief.
 */
export function compose(
  out: Mat4,
  px: number, py: number, pz: number,
  qx: number, qy: number, qz: number, qw: number,
  sx: number, sy: number, sz: number,
): Mat4 {
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;

  out[0] = (1 - (yy + zz)) * sx;
  out[1] = (xy + wz) * sx;
  out[2] = (xz - wy) * sx;
  out[3] = 0;

  out[4] = (xy - wz) * sy;
  out[5] = (1 - (xx + zz)) * sy;
  out[6] = (yz + wx) * sy;
  out[7] = 0;

  out[8] = (xz + wy) * sz;
  out[9] = (yz - wx) * sz;
  out[10] = (1 - (xx + yy)) * sz;
  out[11] = 0;

  out[12] = px;
  out[13] = py;
  out[14] = pz;
  out[15] = 1;
  return out;
}

/** Quaternion aus einer Drehung um die Y-Achse — die einzige, die Figuren tun. */
export function quatFromYaw(out: Float32Array, yaw: number): Float32Array {
  const h = yaw * 0.5;
  out[0] = 0;
  out[1] = Math.sin(h);
  out[2] = 0;
  out[3] = Math.cos(h);
  return out;
}

/**
 * Invertiert eine beliebige 4×4-Matrix.
 *
 * Der allgemeine Weg über die Adjunkte und nicht die Abkürzung für
 * Starrkörper: die Kamera trägt keinen Massstab, aber ein Knoten mit Massstab
 * käme durch dieselbe Funktion, und eine Abkürzung, die dann still das Falsche
 * rechnet, ist schlimmer als ein paar Multiplikationen mehr.
 *
 * Eine nicht invertierbare Matrix gibt die Einheitsmatrix zurück und meldet
 * `false` — sie einfach stehen zu lassen ergäbe Bilder voller NaN, und die
 * sind von aussen nicht mehr zu deuten.
 */
export function invert(out: Mat4, m: Mat4): boolean {
  const a00 = m[0]!, a01 = m[1]!, a02 = m[2]!, a03 = m[3]!;
  const a10 = m[4]!, a11 = m[5]!, a12 = m[6]!, a13 = m[7]!;
  const a20 = m[8]!, a21 = m[9]!, a22 = m[10]!, a23 = m[11]!;
  const a30 = m[12]!, a31 = m[13]!, a32 = m[14]!, a33 = m[15]!;

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (det === 0 || !Number.isFinite(det)) {
    identity(out);
    return false;
  }
  const d = 1 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return true;
}

/**
 * Die Normalenmatrix zu einer Modellmatrix: transponierte Inverse der oberen
 * 3×3, abgelegt als 4×4.
 *
 * Ohne sie stehen Normalen bei ungleichmässigem Massstab schief auf der
 * Fläche, und die Beleuchtung wandert beim Skalieren.
 */
export function normalMatrix(out: Mat4, model: Mat4): Mat4 {
  invert(out, model);
  // Transponieren der oberen 3×3, der Rest wird zur Einheit.
  const t01 = out[1]!, t02 = out[2]!, t12 = out[6]!;
  out[1] = out[4]!;
  out[4] = t01;
  out[2] = out[8]!;
  out[8] = t02;
  out[6] = out[9]!;
  out[9] = t12;
  out[3] = 0;
  out[7] = 0;
  out[11] = 0;
  out[12] = 0;
  out[13] = 0;
  out[14] = 0;
  out[15] = 1;
  return out;
}

/** Wendet eine Matrix auf einen Punkt an (w = 1), mit perspektivischer Teilung. */
export function transformPoint(
  out: { x: number; y: number; z: number },
  m: Mat4,
  x: number,
  y: number,
  z: number,
): { x: number; y: number; z: number } {
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  const iw = w === 0 ? 1 : 1 / w;
  out.x = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) * iw;
  out.y = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) * iw;
  out.z = (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) * iw;
  return out;
}

// ---------------------------------------------------------------------------
// Sichtkörper
// ---------------------------------------------------------------------------

/**
 * Die sechs Ebenen des Sichtkörpers, je vier Zahlen (Normale, Abstand).
 *
 * Gewonnen aus der kombinierten Sicht-Projektions-Matrix nach Gribb/Hartmann:
 * jede Ebene ist eine Summe oder Differenz zweier Zeilen. Die Normalen werden
 * normiert, sonst ist der Abstand kein Abstand und der Radius einer Hüllkugel
 * nicht vergleichbar.
 */
export type Frustum = Float32Array;

export function frustum(): Frustum {
  return new Float32Array(24);
}

export function frustumFrom(out: Frustum, viewProjection: Mat4): Frustum {
  const m = viewProjection;
  const setze = (i: number, x: number, y: number, z: number, w: number): void => {
    const len = Math.hypot(x, y, z) || 1;
    out[i * 4] = x / len;
    out[i * 4 + 1] = y / len;
    out[i * 4 + 2] = z / len;
    out[i * 4 + 3] = w / len;
  };

  setze(0, m[3]! + m[0]!, m[7]! + m[4]!, m[11]! + m[8]!, m[15]! + m[12]!); // links
  setze(1, m[3]! - m[0]!, m[7]! - m[4]!, m[11]! - m[8]!, m[15]! - m[12]!); // rechts
  setze(2, m[3]! + m[1]!, m[7]! + m[5]!, m[11]! + m[9]!, m[15]! + m[13]!); // unten
  setze(3, m[3]! - m[1]!, m[7]! - m[5]!, m[11]! - m[9]!, m[15]! - m[13]!); // oben
  setze(4, m[3]! + m[2]!, m[7]! + m[6]!, m[11]! + m[10]!, m[15]! + m[14]!); // nah
  setze(5, m[3]! - m[2]!, m[7]! - m[6]!, m[11]! - m[10]!, m[15]! - m[14]!); // fern
  return out;
}

/**
 * Liegt diese Hüllkugel wenigstens teilweise im Bild?
 *
 * Die grobe Prüfung: ganz hinter einer Ebene heisst draussen. Sie sagt bei
 * Kugeln in den Ecken gelegentlich fälschlich „drin" — das kostet einen
 * Zeichenaufruf, während ein fälschliches „draussen" ein Loch ins Bild risse.
 * In dieser Richtung darf sie irren, in der anderen nicht.
 */
export function frustumSeesSphere(f: Frustum, x: number, y: number, z: number, r: number): boolean {
  for (let i = 0; i < 6; i++) {
    const d = f[i * 4]! * x + f[i * 4 + 1]! * y + f[i * 4 + 2]! * z + f[i * 4 + 3]!;
    if (d < -r) return false;
  }
  return true;
}
