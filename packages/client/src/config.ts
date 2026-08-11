/**
 * Was der Client über seine Umgebung wissen muss. Alles, was sich zwischen
 * Entwicklung und Betrieb unterscheidet, steht hier und nirgends sonst.
 */

declare const __BUILD__: string;

/**
 * Build-Kennung. Sie hängt an jeder Asset-URL als `?v=` — genau wie Flyffs
 * `FilemapVersion`. Ein neuer Build ist eine neue Zahl, kein Cache-Invalidieren.
 */
export const BUILD = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';

/**
 * Wurzel der Assets. Im Entwicklungsbetrieb serviert Vite den Ordner
 * `assets/`, im Betrieb steht hier das CDN. Der Streamer redet ausschließlich
 * mit dieser Adresse — nie mit dem Spielserver.
 */
export const ASSET_BASE = (import.meta.env?.VITE_ASSET_BASE as string | undefined) ?? '';

/** Adresse des Spielservers. Leer heißt: derselbe Host wie die Seite. */
export function serverUrl(): string {
  const configured = import.meta.env?.VITE_SERVER_URL as string | undefined;
  if (configured) return configured;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/ws`;
}

/** Map, die vor der ersten Antwort des Servers gezeichnet wird. */
export const BOOTSTRAP_MAP = 'lichtmoor';

/**
 * Erkennt Geräte, die per Berührung bedient werden. Entscheidet, ob der
 * virtuelle Joystick erscheint oder WASD gilt — beides ist vorhanden, nur
 * eines ist sichtbar.
 */
export function isTouchDevice(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('ontouchstart' in window || navigator.maxTouchPoints > 0) &&
    // Ein Laptop mit Touchscreen soll trotzdem die Tastatursteuerung bekommen.
    window.matchMedia('(pointer: coarse)').matches
  );
}

/** Grafikstufe. Wird beim Start aus dem Gerät geschätzt und ist umschaltbar. */
export type QualityLevel = 'niedrig' | 'mittel' | 'hoch';

export function guessQuality(): QualityLevel {
  if (isTouchDevice()) return 'mittel';
  const cores = navigator.hardwareConcurrency ?? 4;
  return cores >= 8 ? 'hoch' : 'mittel';
}

export interface QualitySettings {
  /** Sichtweite des Terrainnetzes in Weltnenheiten. */
  viewDistance: number;
  /** Kantenlänge einer Terrainzelle. Kleiner = feiner, teurer. */
  terrainCell: number;
  shadows: boolean;
  maxPixelRatio: number;
  /** Entfernung, ab der Props nicht mehr gezeichnet werden. */
  propDistance: number;
}

export const QUALITY: Record<QualityLevel, QualitySettings> = {
  niedrig: { viewDistance: 160, terrainCell: 8, shadows: false, maxPixelRatio: 1, propDistance: 110 },
  mittel: { viewDistance: 240, terrainCell: 6, shadows: false, maxPixelRatio: 1.5, propDistance: 170 },
  hoch: { viewDistance: 340, terrainCell: 4, shadows: true, maxPixelRatio: 2, propDistance: 260 },
};
