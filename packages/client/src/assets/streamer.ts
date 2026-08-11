/**
 * Asset-Streamer.
 *
 * Übernommen aus dem Blueprint, Punkt für Punkt:
 *
 *   * Er redet **nur mit dem CDN**, nie mit dem Spielserver. Damit kann ein
 *     fehlendes Asset keine Sitzung beenden, und der Spielserver bleibt frei
 *     von Auslieferungslast.
 *   * Er lädt über ein **Manifest** mit Pfad, Größe und Hash. Größen vorab zu
 *     kennen heißt: nach echtem Nutzen priorisieren statt raten.
 *   * Die **Version steht im Query-String**, die Objekte selbst sind
 *     unveränderlich. Ein neuer Build ist eine neue Zahl.
 *   * Angefordert wird **nach Priorität, dann nach Distanz**. Was weit weg
 *     ist, wartet.
 *
 * Was er ausdrücklich nicht tut: blockieren. Wer etwas anfordert, bekommt ein
 * Versprechen und zeichnet in der Zwischenzeit einen Platzhalter.
 */

import { parseManifest, type AssetEntry, type AssetManifest } from '@aurelith/shared';
import { ASSET_BASE, BUILD } from '../config.ts';

interface PendingRequest {
  path: string;
  priority: number;
  /** Quadrierte Distanz zum Betrachter. Entscheidet innerhalb einer Stufe. */
  distanceSq: number;
  resolve: (data: ArrayBuffer) => void;
  reject: (err: Error) => void;
}

export interface StreamerStats {
  manifestLoaded: boolean;
  entries: number;
  inFlight: number;
  queued: number;
  bytesLoaded: number;
}

/** Mehr gleichzeitige Anfragen bringen über HTTP/2 nichts und verstopfen mobil. */
const MAX_CONCURRENT = 6;

export class AssetStreamer {
  private manifest?: AssetManifest;
  private index = new Map<string, AssetEntry>();

  private readonly cache = new Map<string, ArrayBuffer>();
  private readonly inFlight = new Map<string, Promise<ArrayBuffer>>();
  private queue: PendingRequest[] = [];
  private active = 0;
  private bytesLoaded = 0;

  /** Bezugspunkt für die Priorisierung nach Distanz. */
  private viewerX = 0;
  private viewerZ = 0;

  /** URL eines Assets — mit Version, damit unveränderlich gecacht werden darf. */
  url(path: string): string {
    return `${ASSET_BASE}/${path}?v=${encodeURIComponent(BUILD)}`;
  }

  async loadManifest(): Promise<AssetManifest> {
    if (this.manifest) return this.manifest;
    const res = await fetch(this.url('manifest.json'), { cache: 'force-cache' });
    if (!res.ok) throw new Error(`Manifest nicht ladbar: HTTP ${res.status}`);
    const manifest = parseManifest(await res.json());
    this.manifest = manifest;
    this.index = new Map(manifest.entries.map((e) => [e.path, e]));
    return manifest;
  }

  setViewer(x: number, z: number): void {
    this.viewerX = x;
    this.viewerZ = z;
  }

  entry(path: string): AssetEntry | undefined {
    return this.index.get(path);
  }

  /** Bereits vorhandene Bytes, oder nichts. Blockiert nie. */
  peek(path: string): ArrayBuffer | undefined {
    return this.cache.get(path);
  }

  /**
   * Fordert ein Asset an. `at` gibt die Weltposition, zu der es gehört — der
   * Streamer zieht Nahes vor. Ohne Position gilt die Priorität aus dem Manifest.
   */
  request(path: string, at?: { x: number; z: number }): Promise<ArrayBuffer> {
    const cached = this.cache.get(path);
    if (cached) return Promise.resolve(cached);

    const running = this.inFlight.get(path);
    if (running) return running;

    const entry = this.index.get(path);
    const dx = at ? at.x - this.viewerX : 0;
    const dz = at ? at.z - this.viewerZ : 0;

    const promise = new Promise<ArrayBuffer>((resolve, reject) => {
      this.queue.push({
        path,
        priority: entry?.priority ?? 5,
        distanceSq: at ? dx * dx + dz * dz : 0,
        resolve,
        reject,
      });
    });

    this.inFlight.set(path, promise);
    this.drain();
    return promise;
  }

  async requestJson<T>(path: string, at?: { x: number; z: number }): Promise<T> {
    const bytes = await this.request(path, at);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  private drain(): void {
    if (this.active >= MAX_CONCURRENT || this.queue.length === 0) return;

    // Erst Priorität, dann Distanz. Beides steht vorab fest, deshalb reicht
    // ein Sortieren beim Ziehen statt einer Prioritätswarteschlange.
    this.queue.sort((a, b) => a.priority - b.priority || a.distanceSq - b.distanceSq);

    while (this.active < MAX_CONCURRENT && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.active++;
      void this.fetchOne(next).finally(() => {
        this.active--;
        this.drain();
      });
    }
  }

  private async fetchOne(req: PendingRequest): Promise<void> {
    try {
      const res = await fetch(this.url(req.path), { cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status} für ${req.path}`);
      const bytes = await res.arrayBuffer();

      const expected = this.index.get(req.path)?.size;
      if (expected !== undefined && expected !== bytes.byteLength) {
        // Kein Abbruch: ein abweichender Umfang ist ein Hinweis auf ein
        // veraltetes Manifest, kein Grund, dem Spieler das Asset vorzuenthalten.
        console.warn(
          `[assets] ${req.path}: ${bytes.byteLength} Byte, Manifest meldet ${expected}`,
        );
      }

      this.cache.set(req.path, bytes);
      this.bytesLoaded += bytes.byteLength;
      req.resolve(bytes);
    } catch (err) {
      this.inFlight.delete(req.path);
      req.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  stats(): StreamerStats {
    return {
      manifestLoaded: this.manifest !== undefined,
      entries: this.index.size,
      inFlight: this.active,
      queued: this.queue.length,
      bytesLoaded: this.bytesLoaded,
    };
  }
}
