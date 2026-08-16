/**
 * Was es zu sehen gibt.
 *
 * Der Katalog wird **aus den Quellen gelesen und nicht danebengeschrieben**:
 * jedes Prop, jede Waffe, jedes Gegenstandsmodell und jede Figur steht schon in
 * genau einer Tabelle im Client, und die wird hier durchgezählt. Eine Liste von
 * Namen in dieser Datei wäre die zweite Wahrheit darüber, welche Modelle es
 * gibt — und sie wäre bei jedem neuen Prop einen Tag lang falsch.
 *
 * Zwei Sorten Eintrag, weil es zwei Sorten Modell gibt: ein Prop ist eine
 * Geometrie, eine Figur ist ein Rig aus Gelenken. Beide liefern am Ende ein
 * `Object3D`, das die Schau in die Szene hängt — der Unterschied bleibt hier
 * und geht die Anzeige nichts an.
 */

import * as THREE from 'three';
import { standardKollision, type PropKollision } from '@aurelith/shared';
import {
  createFoliageMaterial,
  createSharedMaterial,
  createStoneMaterial,
} from '@aurelith/client/render/geometry.ts';
import { gesteinsTextur } from '@aurelith/client/render/gestein.ts';
import { laubAtlas } from '@aurelith/client/render/laub.ts';
import {
  materialArt,
  PROP_BUILDERS,
  buildArrow,
  buildGateArch,
  type MaterialArt,
} from '@aurelith/client/render/props.ts';
import { ITEM_BUILDERS } from '@aurelith/client/render/itemModels.ts';
import {
  CHARACTER_CONFIGS,
  baueFluggeraet,
  buildWeaponGeometry,
  createRig,
  weaponModelSpecs,
  type CharacterRig,
} from '@aurelith/client/render/rigs.ts';

export type Gruppe =
  | 'Props'
  | 'Figuren'
  | 'Waffen'
  | 'Gelieferte Modelle'
  | 'Gegenstände'
  | 'Fluggeräte'
  | 'Sonstiges';

/**
 * Die gelieferten `.glb`-Dateien, von Vite eingesammelt.
 *
 * Über `import.meta.glob` und nicht als Liste von Pfaden: welche Waffe eine
 * Datei hat, steht in `weaponModelSpecs()`, und eine zweite Liste daneben wäre
 * beim nächsten Modell einen Tag lang falsch. Hier wird nur **gefunden**, was
 * es an Dateien gibt; zugeordnet wird über den Pfad aus der Spezifikation.
 */
const GLB_DATEIEN = import.meta.glob('../../../assets/models/*.glb', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

export interface Eintrag {
  /** Schlüssel, wie ihn Karten und Inhaltsdateien nennen. */
  id: string;
  gruppe: Gruppe;
  /**
   * Adresse der gelieferten Datei, sofern es eine ist.
   *
   * Steht sie da, wird das Modell **geladen** statt gebaut, und `baue` liefert
   * so lange einen leeren Halter, bis die Bytes da sind. Ein Ladebalken wäre
   * hier so fehl am Platz wie im Spiel — siehe `gltf.ts`.
   */
  datei?: { url: string; laenge: number; unten: number; achse?: 'x' | 'y' | 'z' };
  /**
   * Baut das Modell.
   *
   * Gibt zusätzlich das Rig zurück, wenn es eines ist — die Schau lässt es
   * dann atmen, statt eine eingefrorene Puppe zu zeigen. Eine Figur, die
   * stillsteht, sieht kaputt aus, und man sähe ihr nicht an, ob die Gelenke
   * überhaupt greifen.
   */
  baue(
    material: THREE.Material,
    laubMaterial: THREE.Material,
    felsMaterial: THREE.Material,
  ): { objekt: THREE.Object3D; rig?: CharacterRig };
  /**
   * Womit das Modell im Weg steht — nur bei Props.
   *
   * Aus `PROP_KOLLISION` und nicht aus einer Liste hier: den Radius kennt
   * schon der Kartengenerator, der Editor und der Kern. Eine vierte Fassung
   * davon zeigte irgendwann einen Kreis, den es im Spiel nicht gibt — und das
   * wäre schlimmer als gar keinen zu zeigen.
   */
  kollision?: PropKollision;
}

/**
 * Ein Modell aus einer reinen Geometrie.
 *
 * `art` sagt, mit welchem Material es gezeichnet wird — Laub braucht die
 * Textur mit Loch, Fels die Gesteinskörnung, alles andere das gemeinsame.
 * Die Frage beantwortet `materialArt` und nicht diese Datei: die Schau soll
 * zeigen, was das Spiel zeigt, und nicht ihre eigene Meinung dazu haben.
 */
function ausGeometrie(
  id: string,
  gruppe: Gruppe,
  bauer: () => THREE.BufferGeometry,
  art: MaterialArt = 'standard',
  kollision?: PropKollision,
): Eintrag {
  return {
    id,
    gruppe,
    ...(kollision ? { kollision } : {}),
    baue: (material, laubMaterial, felsMaterial) => ({
      objekt: new THREE.Mesh(
        bauer(),
        art === 'laub' ? laubMaterial : art === 'fels' ? felsMaterial : material,
      ),
    }),
  };
}

export function baueKatalog(): Eintrag[] {
  const out: Eintrag[] = [];

  for (const key of Object.keys(PROP_BUILDERS).sort()) {
    out.push(
      ausGeometrie(
        key,
        'Props',
        () => PROP_BUILDERS[key]!(),
        materialArt(key),
        standardKollision(key),
      ),
    );
  }

  for (const spec of weaponModelSpecs()) {
    // Die gebaute Fassung — die steht in der Hand, solange die Datei nicht da
    // ist, und für jede Waffe ohne Datei für immer.
    out.push(ausGeometrie(spec.key, 'Waffen', () => buildWeaponGeometry(spec.key)));

    /*
     * Und die gelieferte daneben.
     *
     * Beide, weil beide vorkommen: im Spiel steht der Platzhalter, bis das
     * Modell eintrifft. Wer nur eines von beiden ansehen kann, prüft die
     * Hälfte — und zwar nicht unbedingt die, die man später sieht.
     */
    const datei = Object.entries(GLB_DATEIEN).find(([pfad]) =>
      pfad.endsWith(spec.path.replace(/^models\//, '/')),
    );
    if (!datei) continue;
    out.push({
      id: `${spec.key} (geliefert)`,
      gruppe: 'Gelieferte Modelle',
      datei: {
        url: datei[1],
        laenge: spec.length,
        unten: spec.bottom,
        ...(spec.axis ? { achse: spec.axis } : {}),
      },
      // Bis die Bytes da sind, hängt hier nichts. Der Halter bleibt leer, und
      // die Schau trägt das Modell nach — siehe `main.ts`.
      baue: () => ({ objekt: new THREE.Object3D() }),
    });
  }

  for (const key of Object.keys(ITEM_BUILDERS).sort()) {
    out.push(ausGeometrie(key, 'Gegenstände', () => ITEM_BUILDERS[key]!()));
  }

  out.push(ausGeometrie('gate_arch', 'Sonstiges', buildGateArch));
  out.push(ausGeometrie('arrow', 'Sonstiges', buildArrow));

  for (const key of Object.keys(CHARACTER_CONFIGS).sort()) {
    out.push({
      id: key,
      gruppe: 'Figuren',
      baue: (material) => {
        const rig = createRig(key, material);
        return { objekt: rig.root, rig };
      },
    });
  }

  // Die Fluggeräte kommen nicht aus einer Tabelle, sondern aus einer Funktion
  // mit zwei erlaubten Werten. Die beiden stehen deshalb hier — und wenn ein
  // drittes Gerät dazukommt, fällt es hier auf, weil es fehlt.
  for (const key of ['flug_besen', 'flug_board']) {
    out.push({
      id: key,
      gruppe: 'Fluggeräte',
      baue: (material) => ({ objekt: baueFluggeraet(key, material) }),
    });
  }

  return out;
}

export { createFoliageMaterial, createSharedMaterial, createStoneMaterial, gesteinsTextur, laubAtlas };
