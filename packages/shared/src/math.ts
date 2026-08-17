/**
 * Deterministische Mathematik. Jede Funktion hier muss auf Client und Server
 * bitgleiche Ergebnisse liefern — sie speist sowohl die Prediction als auch
 * die autoritative Simulation.
 */

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Kürzester Weg zwischen zwei Winkeln, Ergebnis in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDelta(a, b) * t;
}

export function normalizeAngle(a: number): number {
  let r = a % TAU;
  if (r < 0) r += TAU;
  return r;
}

/**
 * Abstand zweier Körper im **Raum** — waagerecht plus die Lücke dazwischen.
 *
 * Spiegel von `abstandRaum` in `types.hpp`; wer eine ändert, ändert beide. Der
 * Kern braucht sie für Wahrnehmung und Schlag, der Server für alles, was eine
 * Reichweite hat: ansprechen, handeln, aufheben, durch ein Tor gehen.
 *
 * Gemessen wird zwischen den Körpern und nicht von Fuss zu Fuss: jeder steht
 * mit den Füssen auf `y` und reicht bis `y + hoehe`. Überschneiden sich die
 * beiden Bereiche — auf jeder Wiese, an jedem Hang, auf jeder Treppe —, ist
 * die senkrechte Lücke null und diese Zahl dieselbe wie `dist2D`. Erst echte
 * Luft dazwischen zählt. Genau deshalb ändert die Regel am Boden nichts.
 *
 * Was keinen Körper hat — ein Beutehaufen, ein Torfeld —, bekommt die Höhe
 * null und ist damit ein Punkt.
 */
export function abstandRaum(
  ax: number,
  ay: number,
  az: number,
  aHoehe: number,
  bx: number,
  by: number,
  bz: number,
  bHoehe: number,
): number {
  const unten = Math.max(ay, by);
  const oben = Math.min(ay + aHoehe, by + bHoehe);
  const lueckeY = Math.max(0, unten - oben);
  return Math.hypot(bx - ax, bz - az, lueckeY);
}

export function dist2D(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dz * dz);
}

export function distSq2D(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return dx * dx + dz * dz;
}

/** FNV-1a. Wandelt Map- und Prop-Namen in stabile Seeds. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — kleiner, schneller, reproduzierbarer PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2D(xi: number, zi: number, seed: number): number {
  let h = seed ^ Math.imul(xi | 0, 0x27d4eb2d) ^ Math.imul(zi | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value-Noise mit glatter Interpolation. Basis für das Terrain. */
export function valueNoise2D(x: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const tx = smoothstep(x - xi);
  const tz = smoothstep(z - zi);
  const a = hash2D(xi, zi, seed);
  const b = hash2D(xi + 1, zi, seed);
  const c = hash2D(xi, zi + 1, seed);
  const d = hash2D(xi + 1, zi + 1, seed);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
}

/** Mehrere Oktaven Value-Noise, Ergebnis in etwa 0..1. */
export function fbm2D(x: number, z: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2D(x * freq, z * freq, (seed + i * 0x9e3779b9) >>> 0) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}
