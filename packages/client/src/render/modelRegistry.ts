/**
 * Die Stelle, an der aus einem Schlüssel ein Modell wird.
 *
 * Heute baut sie alles prozedural. Der eigentliche Zweck ist aber der Tausch:
 * `model: "tree_pine"` im Map-Dokument und `model: "mob_boar"` in der
 * Content-Tabelle sollen irgendwann auf gelieferte glTF-Dateien zeigen, ohne
 * dass eine einzige andere Datei sich ändert.
 *
 * Der Weg dorthin ist vorgezeichnet und bewusst offengelassen:
 *
 *   1. `registerGltfProp(key, path)` lädt über den Asset-Streamer, zieht die
 *      Geometrie heraus und legt sie unter demselben Schlüssel ab.
 *   2. `registerGltfRig(key, path)` behält Skelett und Animationsspuren und
 *      gibt ein Rig zurück, dessen `update` einen AnimationMixer füttert
 *      statt Gelenkwinkel zu setzen.
 *
 * Beides ist absichtlich noch nicht implementiert — solange es keine echten
 * Modelle gibt, wäre es Code ohne Nutzer. Wichtig ist, dass nichts im
 * Renderer voraussetzt, wie ein Modell entstanden ist.
 */

import * as THREE from 'three';
import { createSharedMaterial } from './geometry.ts';
import { PROP_BUILDERS, fallbackProp } from './props.ts';
import { createRig, type CharacterRig } from './rigs.ts';

export class ModelRegistry {
  /** Ein Material für die ganze Szene. Farbe kommt aus den Vertizes. */
  readonly material = createSharedMaterial();

  private readonly propGeometries = new Map<string, THREE.BufferGeometry>();
  private readonly missing = new Set<string>();

  /** Geometrie eines Props. Wird beim ersten Zugriff gebaut und behalten. */
  propGeometry(key: string): THREE.BufferGeometry {
    const cached = this.propGeometries.get(key);
    if (cached) return cached;

    const builder = PROP_BUILDERS[key];
    if (!builder) {
      // Einmal melden, dann still weiterzeichnen: eine unbekannte Kennung ist
      // ein Inhaltsfehler, kein Grund, die Sitzung zu beenden.
      if (!this.missing.has(key)) {
        this.missing.add(key);
        console.warn(`[modelle] Unbekanntes Prop "${key}" — Platzhalter wird gezeichnet.`);
      }
      const geo = fallbackProp();
      this.propGeometries.set(key, geo);
      return geo;
    }

    const geometry = builder();
    this.propGeometries.set(key, geometry);
    return geometry;
  }

  hasProp(key: string): boolean {
    return key in PROP_BUILDERS;
  }

  /** Frisches Rig für eine Figur. Jedes Entity bekommt sein eigenes. */
  createRig(key: string): CharacterRig {
    return createRig(key, this.material);
  }

  dispose(): void {
    for (const geo of this.propGeometries.values()) geo.dispose();
    this.propGeometries.clear();
    this.material.dispose();
  }
}
