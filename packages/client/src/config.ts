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
 * Wurzel der Assets. Der Streamer redet ausschließlich mit dieser Adresse —
 * nie mit dem Spielserver.
 *
 * Standard ist der Unterpfad der Seite: im Entwicklungsbetrieb leer, bei
 * GitHub Pages ohne eigene Domain `/<repo>`. `VITE_ASSET_BASE` überschreibt
 * das und zeigt später auf ein echtes CDN — dann liegen Assets und Seite auf
 * verschiedenen Hosts, so wie es der Blueprint vorsieht.
 */
export const ASSET_BASE =
  (import.meta.env?.VITE_ASSET_BASE as string | undefined) ??
  (import.meta.env?.BASE_URL ?? '/').replace(/\/$/, '');

/** Schlüssel, unter dem eine im Spiel gesetzte Serveradresse liegt. */
const SERVER_STORAGE_KEY = 'aurelith.server';

/**
 * Serveradresse, die der Spieler über `/connect` gesetzt hat.
 *
 * Sie geht der Build-Variablen vor. Der Grund ist der Betrieb auf einer rein
 * statischen Auslieferung: dort ist `VITE_SERVER_URL` beim Bauen eingebacken,
 * und für jede andere Adresse müsste neu gebaut und veröffentlicht werden.
 */
export function storedServerUrl(): string | null {
  try {
    return localStorage.getItem(SERVER_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredServerUrl(url: string | null): void {
  try {
    if (url) localStorage.setItem(SERVER_STORAGE_KEY, url);
    else localStorage.removeItem(SERVER_STORAGE_KEY);
  } catch {
    // Privater Modus ohne Storage — die Adresse gilt dann nur diese Sitzung.
  }
}

/** Wurde überhaupt eine Serveradresse benannt? Siehe `serverUrl`. */
export function isServerConfigured(): boolean {
  return Boolean(storedServerUrl() ?? import.meta.env?.VITE_SERVER_URL);
}

/**
 * Adresse des Spielservers, in dieser Reihenfolge:
 *
 *   1. was der Spieler mit `/connect` gesetzt hat
 *   2. `VITE_SERVER_URL` aus dem Build
 *   3. derselbe Host wie die Seite
 *
 * Der dritte Fall stimmt im Entwicklungsbetrieb, wo Vite `/ws` durchreicht.
 * Auf einer statischen Auslieferung wie GitHub Pages stimmt er nicht — dort
 * gibt es keinen WebSocket-Endpunkt.
 */
export function serverUrl(): string {
  const stored = storedServerUrl();
  if (stored) return stored;
  const configured = import.meta.env?.VITE_SERVER_URL as string | undefined;
  if (configured) return configured;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/ws`;
}

export interface ServerUrlCheck {
  ok: boolean;
  url: string;
  /** Hinweis, der den Spieler vor einem absehbaren Fehlschlag warnt. */
  warning?: string;
  error?: string;
}

/**
 * Prüft eine eingegebene Adresse, bevor überhaupt verbunden wird.
 *
 * Der Mixed-Content-Fall ist der wichtigste: eine über HTTPS ausgelieferte
 * Seite darf keine unverschlüsselte `ws://`-Verbindung öffnen. Ausgenommen ist
 * die Loopback-Adresse, die Browser als vertrauenswürdig behandeln — dort
 * funktioniert es in Chrome und Edge, in Safari nicht zuverlässig.
 */
export function checkServerUrl(raw: string): ServerUrlCheck {
  const url = raw.trim();
  if (!url) return { ok: false, url, error: 'Keine Adresse angegeben.' };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, url, error: `"${url}" ist keine gültige Adresse.` };
  }

  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    return {
      ok: false,
      url,
      error: `Adresse muss mit ws:// oder wss:// beginnen, nicht mit ${parsed.protocol}`,
    };
  }

  const loopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]' ||
    parsed.hostname.endsWith('.localhost');

  if (location.protocol === 'https:' && parsed.protocol === 'ws:' && !loopback) {
    return {
      ok: false,
      url,
      error:
        'Diese Seite läuft über HTTPS und darf keine unverschlüsselte ws://-Verbindung ' +
        'öffnen. Der Server braucht wss:// — oder du rufst den Client über http:// auf.',
    };
  }

  if (location.protocol === 'https:' && parsed.protocol === 'ws:' && loopback) {
    return {
      ok: true,
      url,
      warning:
        'ws:// auf localhost von einer HTTPS-Seite: Chrome und Edge erlauben das, ' +
        'Safari nicht zuverlässig.',
    };
  }

  return { ok: true, url };
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
  /**
   * Normalenkarten auf dem Boden. Der groesste optische Gewinn auf flachen
   * Flaechen — und vier zusaetzliche Texturabfragen je Pixel, die auf
   * schwachen Telefonen zaehlen.
   */
  groundNormalMaps: boolean;
}

export const QUALITY: Record<QualityLevel, QualitySettings> = {
  niedrig: {
    viewDistance: 160, terrainCell: 8, shadows: false, maxPixelRatio: 1,
    propDistance: 110, groundNormalMaps: false,
  },
  mittel: {
    viewDistance: 240, terrainCell: 6, shadows: false, maxPixelRatio: 1.5,
    propDistance: 170, groundNormalMaps: true,
  },
  hoch: {
    viewDistance: 340, terrainCell: 4, shadows: true, maxPixelRatio: 2,
    propDistance: 260, groundNormalMaps: true,
  },
};
