/**
 * Asset-Manifest — die Liste aller ausgelieferten Dateien mit Größe, Hash und
 * Zone.
 *
 * Der Punkt daran ist nicht die Vollständigkeit, sondern dass der Streamer
 * Größen *vorher* kennt. Damit kann er nach echtem Nutzen priorisieren, statt
 * zu raten, und weiß im Voraus, ob ein Nachladen ins Speicherbudget passt.
 *
 * Ausgeliefert wird unter `<cdn>/manifest.json?v=<build>`; die Objekte selbst
 * sind unveränderlich und ein Jahr cachebar. Ein neuer Build ist eine neue
 * Zahl, kein Cache-Invalidieren.
 */

export const MANIFEST_FORMAT = 'aurelith.manifest';
export const MANIFEST_VERSION = 1;

export type AssetKind = 'map' | 'model' | 'texture' | 'audio' | 'data';

export interface AssetEntry {
  /** Pfad relativ zur Asset-Wurzel, ohne führenden Schrägstrich. */
  path: string;
  kind: AssetKind;
  /** Unkomprimierte Größe in Byte. */
  size: number;
  /** SHA-256, hexadezimal, gekürzt auf 16 Zeichen. Reicht zur Integritätsprüfung. */
  hash: string;
  /**
   * Map-ID, zu der das Asset gehört, oder leer für global benötigte Dateien.
   * Der Streamer nutzt das, um beim Kartenwechsel gezielt vorzuladen.
   */
  zone: string;
  /** 0 = sofort, höher = später. Innerhalb einer Stufe entscheidet die Distanz. */
  priority: number;
}

export interface AssetManifest {
  format: typeof MANIFEST_FORMAT;
  version: number;
  /** Build-Zahl, landet als `?v=` an jeder Asset-URL. */
  build: string;
  generatedAt: string;
  entries: AssetEntry[];
}

export function parseManifest(raw: unknown): AssetManifest {
  const o = raw as Record<string, unknown>;
  if (o?.format !== MANIFEST_FORMAT) {
    throw new Error(`Manifest-Format "${String(o?.format)}", erwartet "${MANIFEST_FORMAT}"`);
  }
  const version = Number(o.version);
  if (!Number.isFinite(version) || version > MANIFEST_VERSION) {
    throw new Error(`Manifest-Version ${String(o.version)} wird nicht unterstützt`);
  }
  const entries = Array.isArray(o.entries) ? (o.entries as AssetEntry[]) : [];
  return {
    format: MANIFEST_FORMAT,
    version,
    build: String(o.build ?? '0'),
    generatedAt: String(o.generatedAt ?? ''),
    entries,
  };
}

/** Index für schnelle Pfad-Abfragen. */
export function indexManifest(manifest: AssetManifest): Map<string, AssetEntry> {
  return new Map(manifest.entries.map((e) => [e.path, e]));
}

/** Summierte Bytes einer Zone — Grundlage der Speicherbudget-Prüfung. */
export function zoneBytes(manifest: AssetManifest, zone: string): number {
  let sum = 0;
  for (const e of manifest.entries) {
    if (e.zone === zone || e.zone === '') sum += e.size;
  }
  return sum;
}
