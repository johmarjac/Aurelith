/**
 * Die Pinsel.
 *
 * Zwei Werkzeuge, ein Prinzip: ein runder Bereich um einen Punkt, in dem ein
 * Feld verändert wird — zur Mitte hin stark, zum Rand hin auslaufend. Beim
 * Formen ändert sich die Höhe, beim Malen das Gewicht einer Bodenebene.
 *
 * Bewusst ohne DOM, ohne Three.js und ohne Zeitquelle: was hier passiert, ist
 * reine Feldarithmetik, und die soll man prüfen können, ohne einen Browser zu
 * starten. Der Editor ruft es an, die Prüfungen rufen es an, sonst niemand.
 */

import {
  MAX_GROUND_LAYERS,
  SCULPT_UNIT,
  defaultFieldResolution,
  worldToGrid,
} from '@aurelith/shared';

/** Kleinster und grösster Pinselradius in Welteinheiten. */
export const MIN_BRUSH_RADIUS = 2;
export const MAX_BRUSH_RADIUS = 80;

export interface BrushSettings {
  /** Radius in Welteinheiten. */
  radius: number;
  /**
   * Härte von 0 bis 1.
   *
   * Null heisst: von der Mitte bis zum Rand gleichmässig auslaufend. Eins
   * heisst: bis zum Rand voll, dann Kante. Dazwischen wandert der Punkt, ab
   * dem es abfällt, nach aussen.
   */
  hardness: number;
  /** Stärke je Sekunde — Meter beim Formen, Deckung beim Malen. */
  strength: number;
}

export const DEFAULT_BRUSH: BrushSettings = { radius: 14, hardness: 0.4, strength: 8 };

/**
 * Gewicht des Pinsels in einem Abstand von der Mitte.
 *
 * Glatt (smoothstep) und nicht linear: eine lineare Kante hinterlässt beim
 * Formen einen sichtbaren Knick im Gelände, weil die Ableitung springt.
 */
export function brushFalloff(distance: number, radius: number, hardness: number): number {
  if (distance >= radius) return 0;
  const inner = radius * Math.min(0.98, Math.max(0, hardness));
  if (distance <= inner) return 1;
  const t = 1 - (distance - inner) / (radius - inner);
  return t * t * (3 - 2 * t);
}

/**
 * Bereich des Gitters, den ein Pinsel überhaupt berühren kann.
 *
 * Ohne diese Eingrenzung liefe jeder Strich über alle 16 641 Stützpunkte, und
 * das bei jedem Mausbewegungsereignis.
 */
function affectedRange(
  centre: number,
  radius: number,
  size: number,
  resolution: number,
): { from: number; to: number } {
  const lo = worldToGrid(centre - radius, size, resolution);
  const hi = worldToGrid(centre + radius, size, resolution);
  return { from: Math.max(0, Math.floor(lo)), to: Math.min(resolution - 1, Math.ceil(hi)) };
}

/** Weltkoordinate eines Stützpunktes. */
function gridCoord(index: number, size: number, resolution: number): number {
  return (index / (resolution - 1)) * size - size * 0.5;
}

// --- Formen ----------------------------------------------------------------

export interface SculptField {
  values: Int16Array;
  resolution: number;
}

export function createSculptField(size: number, resolution?: number): SculptField {
  const r = resolution ?? defaultFieldResolution(size);
  return { values: new Int16Array(r * r), resolution: r };
}

/**
 * Hebt oder senkt das Gelände.
 *
 * `amount` in Metern, negativ senkt. Gerechnet wird in den Vierundsechzigsteln,
 * in denen das Feld gespeichert ist — einmal auf- und einmal abrunden würde
 * bei kleinen Strichen sonst gar nichts bewirken.
 *
 * Rückgabe: wie viele Stützpunkte sich tatsächlich geändert haben. Der Editor
 * baut das Netz nur dann neu, was bei gedrückter Maustaste den Unterschied
 * zwischen flüssig und ruckelnd ausmacht.
 */
export function sculptRaise(
  field: SculptField,
  size: number,
  x: number,
  z: number,
  brush: BrushSettings,
  amount: number,
): number {
  const { values, resolution } = field;
  const rx = affectedRange(x, brush.radius, size, resolution);
  const rz = affectedRange(z, brush.radius, size, resolution);
  let touched = 0;

  for (let iz = rz.from; iz <= rz.to; iz++) {
    const wz = gridCoord(iz, size, resolution);
    for (let ix = rx.from; ix <= rx.to; ix++) {
      const wx = gridCoord(ix, size, resolution);
      const w = brushFalloff(Math.hypot(wx - x, wz - z), brush.radius, brush.hardness);
      if (w <= 0) continue;

      const i = iz * resolution + ix;
      const next = values[i]! + amount * w * SCULPT_UNIT;
      const clamped = Math.max(-32768, Math.min(32767, Math.round(next)));
      if (clamped !== values[i]) {
        values[i] = clamped;
        touched++;
      }
    }
  }
  return touched;
}

/**
 * Glättet das Gelände in Richtung des Mittelwerts unter dem Pinsel.
 *
 * Nicht bloss Zierrat: wer einen Hügel aufschüttet, erzeugt am Rand des
 * Pinsels zwangsläufig eine Stufe, und ohne ein Werkzeug dagegen bleibt sie.
 */
export function sculptSmooth(
  field: SculptField,
  size: number,
  x: number,
  z: number,
  brush: BrushSettings,
  strength: number,
): number {
  const { values, resolution } = field;
  const rx = affectedRange(x, brush.radius, size, resolution);
  const rz = affectedRange(z, brush.radius, size, resolution);

  // Erst den Mittelwert bilden, dann anziehen. Beides in einem Durchgang würde
  // je nach Reihenfolge der Stützpunkte etwas anderes ergeben.
  let sum = 0;
  let count = 0;
  for (let iz = rz.from; iz <= rz.to; iz++) {
    const wz = gridCoord(iz, size, resolution);
    for (let ix = rx.from; ix <= rx.to; ix++) {
      const wx = gridCoord(ix, size, resolution);
      if (Math.hypot(wx - x, wz - z) >= brush.radius) continue;
      sum += values[iz * resolution + ix]!;
      count++;
    }
  }
  if (count === 0) return 0;
  const average = sum / count;

  let touched = 0;
  const t = Math.max(0, Math.min(1, strength));
  for (let iz = rz.from; iz <= rz.to; iz++) {
    const wz = gridCoord(iz, size, resolution);
    for (let ix = rx.from; ix <= rx.to; ix++) {
      const wx = gridCoord(ix, size, resolution);
      const w = brushFalloff(Math.hypot(wx - x, wz - z), brush.radius, brush.hardness);
      if (w <= 0) continue;

      const i = iz * resolution + ix;
      const next = Math.round(values[i]! + (average - values[i]!) * t * w);
      if (next !== values[i]) {
        values[i] = next;
        touched++;
      }
    }
  }
  return touched;
}

// --- Malen -----------------------------------------------------------------

export interface PaintField {
  values: Uint8Array;
  resolution: number;
}

export function createPaintField(size: number, resolution?: number): PaintField {
  const r = resolution ?? defaultFieldResolution(size);
  return { values: new Uint8Array(r * r * MAX_GROUND_LAYERS), resolution: r };
}

/**
 * Malt eine Bodenebene.
 *
 * Die gewählte Ebene wächst, die anderen weichen — die Summe je Stützpunkt
 * bleibt bei 255, sobald überhaupt etwas gemalt wurde. Ohne dieses Verdrängen
 * würde ein zweiter Anstrich den ersten nur überdecken, und beim dritten wäre
 * die Summe irgendwo jenseits von gut und böse.
 *
 * Ein noch unberührter Stützpunkt (alles null) bekommt beim ersten Strich das
 * volle Gewicht auf die gemalte Ebene: dort gab es vorher keine Aufteilung, die
 * man hätte verschieben können.
 */
export function paintLayer(
  field: PaintField,
  size: number,
  x: number,
  z: number,
  brush: BrushSettings,
  layer: number,
  coverage: number,
): number {
  if (layer < 0 || layer >= MAX_GROUND_LAYERS) return 0;
  const { values, resolution } = field;
  const rx = affectedRange(x, brush.radius, size, resolution);
  const rz = affectedRange(z, brush.radius, size, resolution);
  let touched = 0;

  for (let iz = rz.from; iz <= rz.to; iz++) {
    const wz = gridCoord(iz, size, resolution);
    for (let ix = rx.from; ix <= rx.to; ix++) {
      const wx = gridCoord(ix, size, resolution);
      const w = brushFalloff(Math.hypot(wx - x, wz - z), brush.radius, brush.hardness);
      if (w <= 0) continue;

      const base = (iz * resolution + ix) * MAX_GROUND_LAYERS;
      const gain = Math.max(0, Math.min(1, coverage * w));

      let total = 0;
      for (let l = 0; l < MAX_GROUND_LAYERS; l++) total += values[base + l]!;

      if (total === 0) {
        // Erster Strich auf einem unberührten Punkt.
        const next = Math.round(255 * gain);
        if (next !== values[base + layer]) {
          values[base + layer] = next;
          // Der Rest bleibt null; die Summe ist damit unter 255, und der
          // Renderer normiert. So ist ein zarter erster Strich auch zart.
          touched++;
        }
        continue;
      }

      // Anziehen: die gemalte Ebene Richtung 255, alle anderen Richtung null.
      let changed = false;
      for (let l = 0; l < MAX_GROUND_LAYERS; l++) {
        const target = l === layer ? 255 : 0;
        const next = Math.round(values[base + l]! + (target - values[base + l]!) * gain);
        if (next !== values[base + l]) {
          values[base + l] = next;
          changed = true;
        }
      }
      if (changed) touched++;
    }
  }
  return touched;
}
