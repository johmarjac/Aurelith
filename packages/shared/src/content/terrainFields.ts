/**
 * Gitterfelder über dem Gelände.
 *
 * Zwei Dinge kann man im Editor am Boden ändern, und beide passen nicht in eine
 * Formel: die Höhe (Hügel aufschütten, Senken graben) und die Bodenebene
 * (hier Sand, dort Gras). Beides sind Felder über der ganzen Karte, und beide
 * werden hier gleich behandelt — ein quadratisches Gitter, das die Karte
 * aufspannt, kodiert als Base64 im Map-Dokument.
 *
 * Warum Base64 und kein Array aus Zahlen: ein Gitter mit 129 Stützpunkten je
 * Kante hat 16 641 Werte. Als JSON-Zahlenliste sind das je nach Wert 80 bis
 * 100 KB, als Base64 über Int16 knapp 45 KB — und es bleibt eine Textdatei,
 * die man ansehen und versionieren kann.
 *
 * Der wichtige Punkt: die Höhen liest der **Kern**, also dieselbe Rechnung im
 * Client und auf dem Server. Die Bodenebenen liest nur der Renderer — welche
 * Textur wo liegt, geht die Simulation nichts an.
 */

import { MAX_GROUND_LAYERS } from './mapFormat.ts';

/**
 * Auflösung der Höhenwerte: Vierundsechzigstel eines Weltmeters.
 *
 * Muss mit `kSculptUnit` in packages/core/include/aurelith/types.hpp
 * übereinstimmen — es ist dieselbe Zahl auf beiden Seiten derselben Brücke.
 * int16 reicht damit von -512 bis +512 Metern bei anderthalb Zentimetern
 * Schrittweite.
 */
export const SCULPT_UNIT = 64;

export interface TerrainField {
  /** Stützpunkte je Kante. Das Gitter spannt immer die ganze Karte auf. */
  resolution: number;
  /** Rohdaten, Base64. Länge und Deutung hängen am Feldtyp. */
  data: string;
}

/**
 * Vorgabe für die Feinheit eines Feldes: ein Stützpunkt alle vier Einheiten.
 *
 * Bei einer Karte von 512 Einheiten sind das 129 × 129 Punkte. Fein genug, dass
 * man beim Formen keine Kanten sieht, grob genug, dass die Datei handlich
 * bleibt. Wer mehr braucht, schreibt eine andere Zahl ins Dokument — gelesen
 * wird, was drinsteht.
 */
export function defaultFieldResolution(size: number): number {
  return Math.max(2, Math.round(size / 4) + 1);
}

// --- Base64 ----------------------------------------------------------------
//
// `atob`/`btoa` gibt es in Node ab 16 und in jedem Browser. Bewusst kein
// Buffer: derselbe Code läuft im Server, im Client und im Editor.

function bytesToBase64(bytes: Uint8Array): string {
  // In Blöcken, weil `String.fromCharCode(...alles)` bei grossen Feldern den
  // Aufrufstapel sprengt — bei 128 KB ist das keine theoretische Sorge.
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// --- Höhenfeld -------------------------------------------------------------

/**
 * Liest das Höhenfeld.
 *
 * Gibt `undefined` zurück, wenn keines da ist oder die Länge nicht zur
 * angegebenen Auflösung passt. Ein halb gelesenes Feld wäre schlimmer als
 * keines: es verschiebt den Boden unter den Füssen der Spieler, und zwar auf
 * Client und Server unterschiedlich weit.
 */
export function decodeSculptField(field: TerrainField | undefined): Int16Array | undefined {
  if (!field || field.resolution < 2) return undefined;
  const expected = field.resolution * field.resolution;
  const bytes = base64ToBytes(field.data);
  if (bytes.length !== expected * 2) return undefined;
  // Über einen kopierten Puffer, damit die Ausrichtung stimmt: `base64ToBytes`
  // liefert keine Garantie, dass der Offset gerade ist.
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

export function encodeSculptField(values: Int16Array, resolution: number): TerrainField {
  return {
    resolution,
    data: bytesToBase64(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)),
  };
}

/** Ob im Feld überhaupt etwas steht. Ein Feld aus lauter Nullen kommt weg. */
export function sculptFieldIsEmpty(values: Int16Array): boolean {
  for (let i = 0; i < values.length; i++) if (values[i] !== 0) return false;
  return true;
}

// --- Malfeld ---------------------------------------------------------------

/**
 * Liest das Malfeld.
 *
 * Je Stützpunkt stehen `MAX_GROUND_LAYERS` Bytes: das Gewicht jeder Bodenebene
 * von 0 bis 255. Sind alle vier null, gilt der Punkt als ungemalt — dort
 * entscheiden weiter die Regeln aus Neigung und Höhe. Das ist der Unterschied
 * zwischen „hier soll nichts liegen" und „hier hat niemand gemalt", und ohne
 * ihn müsste man beim Anlegen des Feldes die ganze Karte einmal durchmalen.
 */
export function decodePaintField(field: TerrainField | undefined): Uint8Array | undefined {
  if (!field || field.resolution < 2) return undefined;
  const expected = field.resolution * field.resolution * MAX_GROUND_LAYERS;
  const bytes = base64ToBytes(field.data);
  if (bytes.length !== expected) return undefined;
  return bytes;
}

export function encodePaintField(values: Uint8Array, resolution: number): TerrainField {
  return { resolution, data: bytesToBase64(values) };
}

export function paintFieldIsEmpty(values: Uint8Array): boolean {
  for (let i = 0; i < values.length; i++) if (values[i] !== 0) return false;
  return true;
}

// --- Gemeinsame Gittermathematik -------------------------------------------

/**
 * Rechnet eine Weltkoordinate in eine Gitterkoordinate um.
 *
 * `-size/2` liegt auf 0, `+size/2` auf `resolution - 1`. Dieselbe Abbildung
 * benutzt `sculptAt` im Kern — steht sie hier anders, sitzt der gemalte Boden
 * woanders als der geformte.
 */
export function worldToGrid(value: number, size: number, resolution: number): number {
  const t = (value + size * 0.5) / size;
  return Math.max(0, Math.min(1, t)) * (resolution - 1);
}

/** Die Umkehrung: Mittelpunkt eines Stützpunktes in Weltkoordinaten. */
export function gridToWorld(index: number, size: number, resolution: number): number {
  return (index / (resolution - 1)) * size - size * 0.5;
}

/**
 * Bilineare Abtastung eines Feldes mit `channels` Werten je Stützpunkt.
 *
 * Dieselbe Interpolation wie `sculptAt` im Kern. Sie muss hier stehen, weil der
 * Renderer das Malfeld liest, das der Kern gar nicht kennt — und weil der
 * Editor beide Felder anfassen muss, bevor sie irgendwo ankommen.
 */
export function sampleField(
  field: Int16Array | Uint8Array,
  resolution: number,
  size: number,
  x: number,
  z: number,
  channels: number,
  out: number[],
): void {
  const gx = worldToGrid(x, size, resolution);
  const gz = worldToGrid(z, size, resolution);

  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const x1 = Math.min(x0 + 1, resolution - 1);
  const z1 = Math.min(z0 + 1, resolution - 1);
  const fx = gx - x0;
  const fz = gz - z0;

  const i00 = (z0 * resolution + x0) * channels;
  const i10 = (z0 * resolution + x1) * channels;
  const i01 = (z1 * resolution + x0) * channels;
  const i11 = (z1 * resolution + x1) * channels;

  for (let c = 0; c < channels; c++) {
    const top = field[i00 + c]! + (field[i10 + c]! - field[i00 + c]!) * fx;
    const bottom = field[i01 + c]! + (field[i11 + c]! - field[i01 + c]!) * fx;
    out[c] = top + (bottom - top) * fz;
  }
}
