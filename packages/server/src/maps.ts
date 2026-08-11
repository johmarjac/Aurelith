/**
 * Lädt die Map-Dokumente von der Platte. Server und Client lesen dieselben
 * Dateien — der Server direkt, der Client über den Asset-Streamer vom CDN.
 *
 * Props werden hier bewusst nicht auf die Terrainhöhe gezogen: der Server
 * braucht von einem Baum nur den Kreis, in den man nicht hineinlaufen kann,
 * und der liegt in der Ebene. Die Höhe interessiert allein den Renderer, und
 * der rechnet sie sich aus derselben Kernfunktion aus.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMapDocument, type MapDocument } from '@aurelith/shared';

export class MapStore {
  private readonly maps = new Map<string, MapDocument>();

  async load(dir: string): Promise<void> {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const raw = await readFile(join(dir, file), 'utf8');
      const doc = parseMapDocument(JSON.parse(raw), file);
      this.maps.set(doc.id, doc);
    }
  }

  get(id: string): MapDocument | undefined {
    return this.maps.get(id);
  }

  require(id: string): MapDocument {
    const m = this.maps.get(id);
    if (!m) throw new Error(`Map "${id}" ist nicht geladen`);
    return m;
  }

  get ids(): string[] {
    return [...this.maps.keys()];
  }

  get size(): number {
    return this.maps.size;
  }
}
