/**
 * Texturen laden — über den Asset-Streamer, nicht über Three.js.
 *
 * Der Blueprint verlangt, dass Assets ausschließlich über den Streamer und das
 * Manifest kommen: mit Version im Query-String, priorisiert nach Distanz, und
 * ohne dass ein fehlendes Asset die Sitzung beendet. Three.js' eigener
 * `TextureLoader` würde daran vorbeigehen, deshalb geht der Weg hier über
 * Bytes → ImageBitmap → Textur.
 */

import * as THREE from 'three';

/**
 * Woher die Bytes kommen. Der Client reicht den Asset-Streamer herein, der
 * Editor ein schlichtes `fetch` — beide bekommen denselben Boden zu sehen,
 * ohne dass der Editor den Streamer mitschleppen muss.
 */
export type ByteSource = (path: string) => Promise<ArrayBuffer>;

export interface TextureOptions {
  /**
   * Farbtexturen liegen in sRGB, Normalenkarten nicht. Wer das verwechselt,
   * bekommt entweder ausgewaschene Farben oder eine Beleuchtung, die nicht
   * stimmt.
   */
  srgb: boolean;
  anisotropy: number;
}

export class TextureLoader {
  private readonly cache = new Map<string, Promise<THREE.Texture>>();

  constructor(private readonly fetchBytes: ByteSource) {}

  load(path: string, options: TextureOptions): Promise<THREE.Texture> {
    const key = `${path}|${options.srgb}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const promise = this.loadOne(path, options);
    this.cache.set(key, promise);
    return promise;
  }

  private async loadOne(path: string, options: TextureOptions): Promise<THREE.Texture> {
    const bytes = await this.fetchBytes(path);
    const blob = new Blob([bytes]);

    let texture: THREE.Texture;
    if (typeof createImageBitmap === 'function') {
      // Kein Umweg über ein DOM-Bild: das dekodiert im Hintergrund und
      // blockiert den Hauptthread nicht.
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY' });
      texture = new THREE.Texture(bitmap);
    } else {
      const url = URL.createObjectURL(blob);
      try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error(`Bild nicht lesbar: ${path}`));
          img.src = url;
        });
        texture = new THREE.Texture(image);
        texture.flipY = true;
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = options.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    // Ohne anisotrope Filterung verschwimmt ein gekachelter Boden im flachen
    // Blickwinkel zu Matsch — und flach ist bei einer Verfolgerkamera der
    // Normalfall.
    texture.anisotropy = options.anisotropy;
    texture.needsUpdate = true;
    return texture;
  }

  dispose(): void {
    for (const promise of this.cache.values()) {
      void promise.then((t) => t.dispose()).catch(() => undefined);
    }
    this.cache.clear();
  }
}
