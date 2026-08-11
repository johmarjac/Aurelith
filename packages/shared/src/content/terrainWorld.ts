/**
 * Die eine Stelle, an der aus einem Map-Dokument eine Welt im Kern wird.
 *
 * Server, Client und Editor bauen jeweils eine — und wenn sie es dreimal
 * verschieden tun, steht die Figur auf drei verschiedenen Böden. Genau das
 * würde beim Formen sofort auffallen: der Server lässt jemanden über einen
 * Hügel laufen, den es im Client nicht gibt, und die Vorhersage rutscht bei
 * jedem Schritt zurück.
 *
 * Deshalb hier, in `shared`, und ohne jede Abhängigkeit auf den Kern: was
 * herauskommt, sind Daten, die zu `CoreTerrainDef` passen, plus das dekodierte
 * Höhenfeld. Der Aufruf bleibt bei den dreien — sie halten die Welt, nicht wir.
 */

import type { MapDocument } from './mapFormat.ts';
import { decodeSculptField } from './terrainFields.ts';

/** Genau die Felder, die der Kern als Geländebeschreibung entgegennimmt. */
export interface CoreTerrainShape {
  size: number;
  cellSize: number;
  seed: number;
  heightScale: number;
  featureScale: number;
}

export interface TerrainSetup {
  shape: CoreTerrainShape;
  /** Von Hand geformte Höhen, oder `undefined` für rein prozedural. */
  sculpt?: Int16Array;
  /** Stützpunkte je Kante. Null, wenn kein Feld da ist. */
  sculptResolution: number;
}

export function terrainSetup(doc: MapDocument): TerrainSetup {
  const t = doc.terrain;
  const shape: CoreTerrainShape = {
    size: t.size,
    cellSize: t.cellSize,
    seed: t.seed,
    heightScale: t.heightScale,
    featureScale: t.featureScale,
  };

  const sculpt = decodeSculptField(t.sculpt);
  // Passt die Länge nicht zur Auflösung, liefert `decodeSculptField` nichts.
  // Dann bleibt es beim prozeduralen Boden — auf allen Seiten gleich, und das
  // ist die Eigenschaft, auf die es hier ankommt.
  return sculpt
    ? { shape, sculpt, sculptResolution: t.sculpt?.resolution ?? 0 }
    : { shape, sculptResolution: 0 };
}
