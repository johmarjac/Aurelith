/**
 * Kleine Modelle für alles, was man im Beutel trägt.
 *
 * Waffen haben schon eines — sie hängen im Rig an der Hand. Ein Trank, eine
 * Haut oder ein Panzerstück hatten keins. Gebraucht werden sie an zwei
 * Stellen: für die Inventarbilder und für die Beute, die nach einem Kampf auf
 * dem Boden liegt. Beide Male dasselbe Modell — was da liegt, muss aussehen
 * wie das Symbol, das man danach im Beutel wiederfindet.
 *
 * Deshalb hier eine Handvoll Formen aus denselben Grundkörpern wie die Props.
 * Sie sind bewusst grob: ein Symbol, das man auf achtundvierzig Bildpunkten
 * erkennt, hat wenige Kanten und klare Farben. Feinheiten fallen bei der Größe
 * ohnehin heraus.
 */

import * as THREE from 'three';
import { assemble, box, cone, cylinder, sphere, type Part } from './geometry.ts';
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

/**
 * Der Rüstungssatz.
 *
 * Grob und einprägsam: bei achtundvierzig Bildpunkten zählt der Umriss und
 * nichts sonst. Die Farben sind dieselben, die `ARMOR_STYLES` im Rig für
 * `leder` benutzt — was im Beutel liegt, soll aussehen wie das, was danach an
 * der Figur hängt.
 */
const LEDER = 0x8a6a42;
const LEDER_DUNKEL = 0x5b4526;

/** Lederkappe: Schale mit Schirm. */
function cap(): THREE.BufferGeometry {
  return assemble([
    { geometry: sphere(0.3, 1), color: LEDER, position: [0, 0.32, 0], scale: [1, 0.62, 1] },
    { geometry: box(0.32, 0.05, 0.16), color: LEDER_DUNKEL, position: [0, 0.24, 0.2] },
    { geometry: box(0.56, 0.07, 0.5), color: LEDER_DUNKEL, position: [0, 0.2, 0] },
  ]);
}

/** Lederwams: Rumpfstück mit Schulterklappen und Gürtel. */
function tunic(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(0.5, 0.6, 0.26), color: LEDER, position: [0, 0.42, 0] },
    { geometry: box(0.66, 0.13, 0.3), color: LEDER_DUNKEL, position: [0, 0.64, 0] },
    { geometry: box(0.52, 0.1, 0.29), color: LEDER_DUNKEL, position: [0, 0.16, 0] },
    // Schnürung vorn — sonst ist es ein Kasten.
    { geometry: box(0.05, 0.34, 0.02), color: 0xe8d8b8, position: [0, 0.42, 0.14] },
  ]);
}

/** Lederhose: zwei Beine mit Bund. */
function pants(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(0.46, 0.12, 0.26), color: LEDER_DUNKEL, position: [0, 0.62, 0] },
    { geometry: box(0.2, 0.56, 0.24), color: LEDER, position: [-0.12, 0.28, 0] },
    { geometry: box(0.2, 0.56, 0.24), color: LEDER, position: [0.12, 0.28, 0] },
  ]);
}

/** Lederstiefel: Schaft, Sohle, Spitze. */
function boots(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(0.24, 0.42, 0.24), color: LEDER, position: [0, 0.42, -0.02] },
    { geometry: box(0.26, 0.12, 0.42), color: LEDER_DUNKEL, position: [0, 0.16, 0.06] },
    { geometry: box(0.24, 0.08, 0.14), color: LEDER_DUNKEL, position: [0, 0.08, 0.2] },
  ]);
}

/** Lederhandschuhe: Stulpe, Faust, Daumen — ein Paar, leicht versetzt. */
function gloves(): THREE.BufferGeometry {
  const teile: Part[] = [];
  // Zwei Stück nebeneinander und um eine Idee gegeneinander gedreht: ein
  // einzelner Handschuh sähe im Beutel aus wie ein Fäustling, und Handschuhe
  // gibt es paarweise.
  for (const [x, seite, kipp] of [
    [-0.17, 1, 0.18],
    [0.17, -1, -0.18],
  ] as const) {
    teile.push(
      { geometry: box(0.26, 0.3, 0.2), color: LEDER, position: [x, 0.42, 0], rotation: [0, 0, kipp] },
      // Stulpe.
      { geometry: box(0.32, 0.14, 0.26), color: LEDER_DUNKEL, position: [x, 0.62, 0], rotation: [0, 0, kipp] },
      // Daumen.
      { geometry: box(0.1, 0.14, 0.12), color: LEDER, position: [x + seite * 0.15, 0.46, 0.06] },
      // Knöchelband.
      { geometry: box(0.28, 0.06, 0.06), color: LEDER_DUNKEL, position: [x, 0.5, 0.11] },
    );
  }
  return assemble(teile);
}

/** Ohrring: ein Reif mit einem Tropfen daran. */
function earring(): THREE.BufferGeometry {
  const messing = 0xc9a44a;
  const stein = 0x7fd8e8;
  const teile: Part[] = [];
  // Derselbe Trick wie beim Ring: ein Kranz Klötzchen, damit das Loch bleibt.
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    teile.push({
      geometry: box(0.07, 0.07, 0.09),
      color: messing,
      position: [Math.cos(a) * 0.18, 0.52 + Math.sin(a) * 0.18, 0],
      rotation: [0, 0, a],
    });
  }
  // Der Tropfen hängt unten am Reif.
  teile.push(
    { geometry: cylinder(0.025, 0.025, 0.1, 6), color: messing, position: [0, 0.29, 0] },
    { geometry: cone(0.11, 0.24, 6), color: stein, position: [0, 0.14, 0], rotation: [Math.PI, 0, 0] },
    { geometry: cone(0.11, 0.12, 6), color: stein, position: [0, 0.08, 0] },
  );
  return assemble(teile);
}

/** Reisemantel: Kragen, zwei Bahnen, weiter Schoss. */
function coat(): THREE.BufferGeometry {
  const tuch = 0x4a3d5c;
  const besatz = 0x8a7a4a;
  return assemble([
    // Kragen.
    { geometry: box(0.42, 0.12, 0.16), color: besatz, position: [0, 0.78, 0] },
    // Schultern.
    { geometry: box(0.5, 0.16, 0.2), color: shadeItem(tuch, 1.08), position: [0, 0.66, 0] },
    // Zwei Bahnen mit einer Lücke dazwischen — daran erkennt man einen Mantel
    // und keinen Umhang.
    { geometry: box(0.22, 0.56, 0.12), color: tuch, position: [-0.15, 0.32, 0] },
    { geometry: box(0.22, 0.56, 0.12), color: tuch, position: [0.15, 0.32, 0] },
    // Schoss, unten weiter.
    { geometry: box(0.62, 0.16, 0.16), color: shadeItem(tuch, 0.9), position: [0, 0.1, 0] },
    // Knöpfe.
    { geometry: box(0.05, 0.05, 0.04), color: besatz, position: [-0.03, 0.52, 0.07] },
    { geometry: box(0.05, 0.05, 0.04), color: besatz, position: [-0.03, 0.4, 0.07] },
  ]);
}

/** Wanderumhang: ein Tuch, oben schmal, unten weit. */
function cloak(): THREE.BufferGeometry {
  const stoff = 0x5a6b8a;
  return assemble([
    { geometry: box(0.34, 0.2, 0.06), color: stoff, position: [0, 0.72, 0] },
    { geometry: box(0.56, 0.44, 0.07), color: stoff, position: [0, 0.42, 0] },
    { geometry: box(0.66, 0.22, 0.08), color: shadeItem(stoff, 0.88), position: [0, 0.14, 0] },
    // Spange am Hals.
    { geometry: cylinder(0.07, 0.07, 0.05, 8), color: 0xc9a44a, position: [0, 0.78, 0.06], rotation: [Math.PI / 2, 0, 0] },
  ]);
}

/** Lesebrille: zwei Gläser in Messing. */
function glasses(): THREE.BufferGeometry {
  const messing = 0xc9a44a;
  const glas = 0xbfe4f0;
  return assemble([
    { geometry: cylinder(0.17, 0.17, 0.03, 12), color: glas, position: [-0.2, 0.4, 0], rotation: [Math.PI / 2, 0, 0] },
    { geometry: cylinder(0.17, 0.17, 0.03, 12), color: glas, position: [0.2, 0.4, 0], rotation: [Math.PI / 2, 0, 0] },
    { geometry: cylinder(0.19, 0.19, 0.025, 12), color: messing, position: [-0.2, 0.4, -0.01], rotation: [Math.PI / 2, 0, 0] },
    { geometry: cylinder(0.19, 0.19, 0.025, 12), color: messing, position: [0.2, 0.4, -0.01], rotation: [Math.PI / 2, 0, 0] },
    { geometry: box(0.1, 0.035, 0.03), color: messing, position: [0, 0.4, 0] },
    { geometry: box(0.03, 0.03, 0.22), color: messing, position: [-0.37, 0.4, -0.1] },
    { geometry: box(0.03, 0.03, 0.22), color: messing, position: [0.37, 0.4, -0.1] },
  ]);
}

/** Moorkette: Schnur mit einem Splitter Irrlichtessenz. */
function pendant(): THREE.BufferGeometry {
  const schnur = 0x6b4a2c;
  const stein = 0x7fd8e8;
  return assemble([
    { geometry: cylinder(0.03, 0.03, 0.34, 6), color: schnur, position: [-0.16, 0.5, 0], rotation: [0, 0, 0.5] },
    { geometry: cylinder(0.03, 0.03, 0.34, 6), color: schnur, position: [0.16, 0.5, 0], rotation: [0, 0, -0.5] },
    { geometry: cylinder(0.03, 0.03, 0.16, 6), color: schnur, position: [0, 0.36, 0] },
    { geometry: cone(0.16, 0.34, 6), color: stein, position: [0, 0.16, 0] },
    { geometry: cone(0.16, 0.16, 6), color: stein, position: [0, 0.36, 0], rotation: [Math.PI, 0, 0] },
  ]);
}

/** Kupferring: ein Reif, hochkant, damit man das Loch sieht. */
function ring(): THREE.BufferGeometry {
  const kupfer = 0xb87333;
  const teile: Part[] = [];
  // Ein Torus aus acht Klötzchen: `cylinder` allein wäre eine Scheibe, und
  // ein Ring ohne Loch ist keiner.
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    teile.push({
      geometry: box(0.09, 0.09, 0.12),
      color: kupfer,
      position: [Math.cos(a) * 0.24, 0.4 + Math.sin(a) * 0.24, 0],
      rotation: [0, 0, a],
    });
  }
  return assemble(teile);
}

/** Dieselbe Aufhellung wie im Rig — hier lokal, um nichts zu exportieren. */
function shadeItem(color: number, factor: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * factor));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * factor));
  const b = Math.min(255, Math.round((color & 0xff) * factor));
  return (r << 16) | (g << 8) | b;
}

/**
 * Ein Pfeil — Schaft, Spitze, Federn.
 *
 * Schräg gelegt und nicht senkrecht: aufrecht wäre er im quadratischen
 * Symbolbild ein Strich in der Mitte, und man erkennt nichts. Über die
 * Diagonale füllt er die Kachel und zeigt beide Enden.
 */
function arrow(): THREE.BufferGeometry {
  const holz = 0xb9863f;
  const feder = 0xe8e0cc;
  const schraeg: [number, number, number] = [0, 0, Math.PI / 4];
  return assemble([
    { geometry: cylinder(0.035, 0.035, 0.95, 6), color: holz, position: [0, 0.5, 0], rotation: schraeg },
    // Spitze, oben rechts.
    { geometry: cone(0.09, 0.22, 6), color: 0x9aa3ac, position: [0.36, 0.86, 0], rotation: schraeg },
    // Zwei Federn am unteren Ende, leicht gespreizt.
    {
      geometry: box(0.02, 0.22, 0.1),
      color: feder,
      position: [-0.3, 0.2, 0.03],
      rotation: [0.3, 0, Math.PI / 4],
    },
    {
      geometry: box(0.02, 0.22, 0.1),
      color: shadeItem(feder, 0.85),
      position: [-0.3, 0.2, -0.03],
      rotation: [-0.3, 0, Math.PI / 4],
    },
  ]);
}

/** Der Katalog. Schlüssel entsprechen dem `model`-Feld der Gegenstandstabelle. */
export const ITEM_BUILDERS: Record<string, ItemBuilder> = {
  armor_head: cap,
  armor_chest: tunic,
  armor_legs: pants,
  armor_feet: boots,
  armor_hands: gloves,
  armor_cloak: cloak,
  armor_coat: coat,
  armor_glasses: glasses,
  armor_necklace: pendant,
  armor_earring: earring,
  armor_ring: ring,
  item_arrow: arrow,
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
