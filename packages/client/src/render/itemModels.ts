/**
 * Kleine Modelle für alles, was man im Beutel trägt.
 *
 * Waffen haben schon eines — sie hängen im Rig an der Hand. Ein Trank, eine
 * Haut oder ein Panzerstück haben keins, weil sie in der Welt nie auftauchen:
 * Beute fällt ohne Umweg in den Beutel. Für die Inventarbilder braucht es sie
 * trotzdem, und ein Bild von einem Gegenstand, den es als Modell nicht gibt,
 * lässt sich schlecht rendern.
 *
 * Deshalb hier eine Handvoll Formen aus denselben Grundkörpern wie die Props.
 * Sie sind bewusst grob: ein Symbol, das man auf achtundvierzig Bildpunkten
 * erkennt, hat wenige Kanten und klare Farben. Feinheiten fallen bei der Größe
 * ohnehin heraus.
 */

import * as THREE from 'three';
import { assemble, box, cone, cylinder, sphere } from './geometry.ts';
import { buildWeaponGeometry } from './rigs.ts';
import type { ItemDef } from '@aurelith/shared';

type ItemBuilder = () => THREE.BufferGeometry;

/** Heiltrank: bauchige Flasche, Kork, roter Inhalt. */
function potion(): THREE.BufferGeometry {
  const glas = 0xc4433f;
  const kork = 0x8a6a42;
  return assemble([
    { geometry: sphere(0.3, 1), color: glas, position: [0, 0.3, 0], scale: [1, 0.95, 1] },
    { geometry: cylinder(0.1, 0.13, 0.22, 8), color: glas, position: [0, 0.6, 0] },
    { geometry: cylinder(0.11, 0.11, 0.12, 8), color: kork, position: [0, 0.74, 0] },
    // Ein heller Streifen: ohne ihn ist die Kugel im Bild eine flache Scheibe.
    { geometry: box(0.06, 0.28, 0.02), color: 0xe8867f, position: [-0.13, 0.32, 0.24] },
  ]);
}

/** Irrlichtessenz: ein Splitter, der von innen zu leuchten scheint. */
function essence(): THREE.BufferGeometry {
  const kalt = 0x7fd8e8;
  return assemble([
    { geometry: cone(0.22, 0.5, 6), color: kalt, position: [0, 0.5, 0] },
    { geometry: cone(0.22, 0.35, 6), color: kalt, position: [0, 0.33, 0], rotation: [Math.PI, 0, 0] },
    { geometry: cone(0.1, 0.26, 5), color: 0xd8f6ff, position: [0.16, 0.28, 0.06] },
  ]);
}

/** Keilerhaut: ein zusammengerolltes Fell mit Schnur. */
function hide(): THREE.BufferGeometry {
  const fell = 0x8a6a42;
  return assemble([
    {
      geometry: cylinder(0.22, 0.22, 0.8, 10),
      color: fell,
      position: [0, 0.24, 0],
      rotation: [0, 0, Math.PI / 2],
    },
    { geometry: cylinder(0.235, 0.235, 0.08, 10), color: 0x5b4526, position: [-0.2, 0.24, 0], rotation: [0, 0, Math.PI / 2] },
    { geometry: cylinder(0.235, 0.235, 0.08, 10), color: 0x5b4526, position: [0.2, 0.24, 0], rotation: [0, 0, Math.PI / 2] },
  ]);
}

/** Kriecherpanzer: eine gewölbte Platte mit Kante. */
function chitin(): THREE.BufferGeometry {
  const schale = 0x6f7f8a;
  return assemble([
    { geometry: sphere(0.4, 1), color: schale, position: [0, 0.16, 0], scale: [1, 0.42, 0.8] },
    { geometry: box(0.06, 0.1, 0.62), color: 0x4c5860, position: [0, 0.3, 0] },
    { geometry: box(0.5, 0.07, 0.06), color: 0x4c5860, position: [0, 0.26, 0.2] },
  ]);
}

/** Übungsweste: Rumpf mit Schulterstücken. */
function vest(): THREE.BufferGeometry {
  const stoff = 0x6f7f5a;
  return assemble([
    { geometry: box(0.52, 0.6, 0.26), color: stoff, position: [0, 0.42, 0] },
    { geometry: box(0.22, 0.18, 0.24), color: 0x596848, position: [-0.33, 0.62, 0] },
    { geometry: box(0.22, 0.18, 0.24), color: 0x596848, position: [0.33, 0.62, 0] },
    { geometry: box(0.08, 0.6, 0.03), color: 0x3f4a33, position: [0, 0.42, 0.14] },
  ]);
}

/**
 * Rostiger Dolch: kurz, breit, mit schartiger Klinge.
 *
 * In der Hand hält die Figur weiterhin das Schwert-Rig — für Dolch und
 * Eisenklinge gibt es dort noch keine eigene Form. Das Symbol nimmt sie
 * trotzdem vorweg: im Beutel unterscheiden sich die drei Klingen sonst nur
 * durch ihre Beschriftung.
 */
function dagger(): THREE.BufferGeometry {
  const stahl = 0x8c7a5e;
  const griff = 0x4a3a28;
  return assemble([
    { geometry: box(0.09, 0.46, 0.025), color: stahl, position: [0, 0.52, 0] },
    { geometry: cone(0.06, 0.12, 4), color: stahl, position: [0, 0.8, 0] },
    { geometry: box(0.2, 0.05, 0.05), color: 0x5b4f3a, position: [0, 0.28, 0] },
    { geometry: cylinder(0.045, 0.05, 0.22, 6), color: griff, position: [0, 0.16, 0] },
    { geometry: sphere(0.06, 0), color: 0x5b4f3a, position: [0, 0.04, 0] },
  ]);
}

/** Eisenklinge: länger, gerader, mit heller Schneide. */
function ironBlade(): THREE.BufferGeometry {
  const stahl = 0xb8c0c8;
  const griff = 0x3a2f22;
  return assemble([
    { geometry: box(0.11, 0.78, 0.03), color: stahl, position: [0, 0.72, 0] },
    { geometry: box(0.03, 0.78, 0.035), color: 0xdfe6ec, position: [0.03, 0.72, 0] },
    { geometry: cone(0.075, 0.16, 4), color: stahl, position: [0, 1.16, 0] },
    { geometry: box(0.3, 0.07, 0.07), color: 0x6f7780, position: [0, 0.3, 0] },
    { geometry: cylinder(0.05, 0.055, 0.26, 6), color: griff, position: [0, 0.16, 0] },
    { geometry: sphere(0.07, 0), color: 0x6f7780, position: [0, 0.03, 0] },
  ]);
}

/** Der Katalog. Schlüssel entsprechen dem `model`-Feld der Gegenstandstabelle. */
export const ITEM_BUILDERS: Record<string, ItemBuilder> = {
  item_potion: potion,
  item_essence: essence,
  item_hide: hide,
  item_chitin: chitin,
  armor_vest: vest,
  weapon_dagger: dagger,
  weapon_iron_blade: ironBlade,
};

/**
 * Die Geometrie zu einem Gegenstand — Waffe oder nicht.
 *
 * Eine Waffe wird nicht doppelt beschrieben: das Bild zeigt genau das Modell,
 * das die Figur später in der Hand hält. Alles andere kommt aus dem Katalog
 * oben. Kennt keiner von beiden den Gegenstand, gibt es kein Bild — und die
 * Kachel bleibt einfarbig, wie schon vorher.
 */
export function buildItemGeometry(def: ItemDef): THREE.BufferGeometry | undefined {
  // Der eigene Eintrag zuerst: Dolch und Eisenklinge tragen zwar das
  // Schwert-Rig in der Hand, haben als Symbol aber eine eigene Form. Wo es
  // keinen gibt, gilt die Waffe in der Hand — dann zeigt das Bild genau das
  // Modell, das die Figur später schwingt.
  const bauer = ITEM_BUILDERS[def.model];
  if (bauer) return bauer();
  if (def.weaponRig) return buildWeaponGeometry(def.weaponRig);
  return undefined;
}
