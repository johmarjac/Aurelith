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
import {
  createFoliageMaterial,
  createSharedMaterial,
  createStoneMaterial,
} from './geometry.ts';
import { gesteinsTextur } from './gestein.ts';
import { laubAtlas } from './laub.ts';
import { materialArt, PROP_BUILDERS, buildArrow, fallbackProp } from './props.ts';
import {
  createRig,
  weaponModelSpecs,
  type CharacterRig,
  type WeaponKey,
} from './rigs.ts';
import { disposeModel, loadModel } from './gltf.ts';

/** Woher die Bytes eines Modells kommen. Im Client der Streamer. */
export type ByteSource = (path: string) => Promise<ArrayBuffer>;

/** Interner Schlüssel des Pfeils im Geometrie-Zwischenspeicher. */
const ARROW_KEY = '\0arrow';

export class ModelRegistry {
  /** Ein Material für die ganze Szene. Farbe kommt aus den Vertizes. */
  readonly material = createSharedMaterial();
  /**
   * Und eines für alles mit Löchern — Blätter, Gras, Farn.
   *
   * Erst beim ersten Laubprop angelegt: die Textur wird auf einer Leinwand
   * gezeichnet, und eine Karte ganz ohne Laub soll dafür nicht zahlen.
   */
  private laubMaterial?: THREE.MeshLambertMaterial;

  /** Und eines für Fels. Ebenso erst beim ersten Stein angelegt. */
  private felsMaterial?: THREE.MeshLambertMaterial;

  /**
   * Womit dieses Prop gezeichnet wird.
   *
   * **Eine** Stelle für die Frage. Weltansicht, Editor und Modellschau bauen
   * jeweils ihre eigenen Instanzennetze, und jede von ihnen müsste sonst
   * wissen, dass ein Busch anders behandelt wird als ein Fass — die dritte
   * hätte man vergessen.
   */
  propMaterial(key: string): THREE.MeshLambertMaterial {
    switch (materialArt(key)) {
      case 'laub':
        this.laubMaterial ??= createFoliageMaterial(laubAtlas());
        return this.laubMaterial;
      case 'fels':
        this.felsMaterial ??= createStoneMaterial(gesteinsTextur());
        return this.felsMaterial;
      default:
        return this.material;
    }
  }

  private readonly propGeometries = new Map<string, THREE.BufferGeometry>();
  private readonly missing = new Set<string>();

  /** Geladene Waffenmodelle, je Schlüssel eines. */
  private readonly weaponModels = new Map<WeaponKey, THREE.Object3D>();
  /**
   * Figuren, die eine Waffe tragen.
   *
   * Nötig, weil Modelle nachträglich eintreffen: wer schon dasteht, bekommt
   * seines dann eingehängt. Bewusst ein `Set` und kein Array — beim Abmelden
   * einer Figur soll nicht die ganze Liste durchsucht werden.
   */
  private readonly armedRigs = new Set<CharacterRig>();

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


  /**
   * Geometrie eines Pfeils.
   *
   * Einfache Formen, wie bestellt: ein Schaft, eine Spitze, zwei Federn. Er
   * liegt entlang +Z, damit `lookAt` reicht, um ihn auszurichten.
   */
  arrowGeometry(): THREE.BufferGeometry {
    const cached = this.propGeometries.get(ARROW_KEY);
    if (cached) return cached;
    const geometry = buildArrow();
    this.propGeometries.set(ARROW_KEY, geometry);
    return geometry;
  }

  /** Frisches Rig für eine Figur. Jedes Entity bekommt sein eigenes. */
  createRig(key: string, weapon?: string, outfit?: string): CharacterRig {
    const rig = createRig(key, this.material, weapon, outfit);

    /*
     * Erst drehen, dann kippen — und deshalb `YXZ`.
     *
     * Die Voreinstellung von three.js ist `XYZ`, und das heisst: die Neigung
     * um X wirkt **nach** der Drehung um Y, also um die Achse der Welt und
     * nicht um die der Figur. Nach Norden sieht das richtig aus; wer nach
     * Osten fliegt, dessen gehobene Nase wird zur Schräglage, und bei genau
     * 90 Grad Kurs kippt die Figur seitwärts, statt zu steigen.
     *
     * `YXZ` dreht zuerst auf den Kurs und kippt dann um die mitgedrehte
     * Querachse. Hier und nicht an der Stelle, die den Winkel setzt: an der
     * Reihenfolge hängt auch der umgefallene Kadaver (`rotation.x` im Rig),
     * und zwei Rigs mit verschiedenen Konventionen wären ein Fehler, der nur
     * in eine Richtung sichtbar ist.
     */
    rig.root.rotation.order = 'YXZ';

    // Ist das Modell schon da, bekommt die frische Figur es sofort; sonst
    // merken wir sie uns für später. Beides ohne Warten — sie steht in jedem
    // Fall im nächsten Bild, notfalls mit dem Platzhalter.
    if (rig.weapon && rig.setWeaponModel) {
      const ready = this.weaponModels.get(rig.weapon);
      if (ready) rig.setWeaponModel(ready);
      this.armedRigs.add(rig);
    }

    return rig;
  }

  /** Welche Waffenmodelle bereits geladen sind. Für Prüfungen von aussen. */
  loadedWeaponModels(): string[] {
    return [...this.weaponModels.keys()];
  }

  /** Meldet ein Rig ab, damit die Registry keine Leichen sammelt. */
  releaseRig(rig: CharacterRig): void {
    this.armedRigs.delete(rig);
  }

  /**
   * Holt die gelieferten Waffenmodelle nach.
   *
   * Bewusst ohne `await` beim Aufrufer: nichts hier darf ein Bild aufhalten.
   * Kommt ein Modell nicht, bleibt der prozedurale Platzhalter stehen und im
   * Protokoll steht, warum — ein fehlendes Schwert ist ein Inhaltsfehler, kein
   * Grund, die Sitzung zu beenden.
   */
  async loadWeaponModels(source: ByteSource): Promise<void> {
    await Promise.all(
      weaponModelSpecs().map(async ({ key, path, length, bottom, axis }) => {
        try {
          const bytes = await source(path);
          const model = await loadModel(bytes, { length, bottom, ...(axis ? { axis } : {}) });
          this.weaponModels.set(key, model);

          for (const rig of this.armedRigs) {
            if (rig.weapon === key) rig.setWeaponModel?.(model);
          }
        } catch (err) {
          console.warn(`[modelle] Waffenmodell "${path}" nicht ladbar — Platzhalter bleibt:`, err);
        }
      }),
    );
  }

  dispose(): void {
    for (const geo of this.propGeometries.values()) geo.dispose();
    this.propGeometries.clear();
    for (const model of this.weaponModels.values()) disposeModel(model);
    this.weaponModels.clear();
    this.armedRigs.clear();
    this.material.dispose();
    this.laubMaterial?.dispose();
  }
}
