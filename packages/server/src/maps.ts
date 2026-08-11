/**
 * Lädt die Map-Dokumente von der Platte. Server und Client lesen dieselben
 * Dateien — der Server direkt, der Client über den Asset-Streamer vom CDN.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMapDocument, terrainHeight, type MapDocument } from '@aurelith/shared';

export class MapStore {
  private readonly maps = new Map<string, MapDocument>();

  async load(dir: string): Promise<void> {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const raw = await readFile(join(dir, file), 'utf8');
      const doc = parseMapDocument(JSON.parse(raw), file);
      applyGroundSnap(doc);
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

/**
 * Zieht Props mit `snapToGround` auf die Terrainhöhe. Der Editor speichert
 * die Y-Koordinate zwar mit, aber sobald jemand den Terrain-Seed ändert,
 * schweben oder versinken sonst alle Props.
 */
export function applyGroundSnap(doc: MapDocument): void {
  for (const p of doc.props) {
    if (!p.snapToGround) continue;
    p.position[1] = terrainHeight(p.position[0], p.position[2], doc.terrain);
  }
}
