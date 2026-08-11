/**
 * Prozedurale Props — Bäume, Felsen, Säulen, Tore.
 *
 * Jeder Eintrag liefert eine fertig verschmolzene Geometrie. Der Schlüssel
 * (`tree_pine`, `rock_large`, …) ist derselbe, den das Map-Dokument nennt und
 * den der spätere Editor in seiner Palette anbietet. Wird ein Prop irgendwann
 * durch ein geliefertes Modell ersetzt, ändert sich nur diese Datei.
 */

import * as THREE from 'three';
import { assemble, cone, cylinder, roughen, sphere, box, type Part } from './geometry.ts';

export type PropBuilder = () => THREE.BufferGeometry;

const BARK = 0x6b4f34;
const DEAD_BARK = 0x5c5245;
const STONE = 0x7d7a70;
const DARK_STONE = 0x4a4a52;
const NEEDLE = 0x3f7a3a;
const LEAF = 0x59a44b;

function pine(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: cylinder(0.16, 0.24, 2.2, 6), color: BARK, position: [0, 1.1, 0] },
  ];
  // Drei Kronenlagen, nach oben schmaler — ergibt die Silhouette einer Fichte.
  const layers = [
    { y: 2.1, r: 1.35, h: 1.7 },
    { y: 3.0, r: 1.05, h: 1.5 },
    { y: 3.8, r: 0.7, h: 1.2 },
  ];
  for (const l of layers) {
    parts.push({ geometry: cone(l.r, l.h, 7), color: NEEDLE, position: [0, l.y, 0] });
  }
  return assemble(parts);
}

function broadleaf(): THREE.BufferGeometry {
  return assemble([
    { geometry: cylinder(0.18, 0.3, 2.6, 6), color: BARK, position: [0, 1.3, 0] },
    { geometry: roughen(sphere(1.5, 1), 0.28, 0x1234), color: LEAF, position: [0, 3.3, 0] },
    {
      geometry: roughen(sphere(1.0, 1), 0.3, 0x5678),
      color: LEAF,
      position: [0.8, 2.9, 0.4],
    },
    {
      geometry: roughen(sphere(0.9, 1), 0.3, 0x9abc),
      color: LEAF,
      position: [-0.7, 3.0, -0.5],
    },
  ]);
}

function deadTree(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: cylinder(0.12, 0.28, 3.2, 6), color: DEAD_BARK, position: [0, 1.6, 0] },
  ];
  const branches = [
    { y: 2.2, rot: 0.9, yaw: 0.0, len: 1.2 },
    { y: 2.6, rot: -0.8, yaw: 2.1, len: 1.0 },
    { y: 1.8, rot: 1.1, yaw: 4.0, len: 0.9 },
  ];
  for (const b of branches) {
    parts.push({
      geometry: cylinder(0.05, 0.09, b.len, 5),
      color: DEAD_BARK,
      position: [Math.sin(b.yaw) * b.len * 0.35, b.y, Math.cos(b.yaw) * b.len * 0.35],
      rotation: [b.rot * Math.cos(b.yaw), 0, -b.rot * Math.sin(b.yaw)],
    });
  }
  return assemble(parts);
}

function rock(size: number, seed: number): THREE.BufferGeometry {
  return assemble([
    {
      geometry: roughen(sphere(size, 1), 0.45, seed),
      color: STONE,
      // Flachgedrückt sitzt ein Fels im Boden, statt darauf zu balancieren.
      position: [0, size * 0.55, 0],
      scale: [1, 0.72, 1],
    },
  ]);
}

function bush(): THREE.BufferGeometry {
  return assemble([
    { geometry: roughen(sphere(0.55, 0), 0.35, 0x2468), color: 0x4a7f3c, position: [0, 0.45, 0] },
    { geometry: roughen(sphere(0.4, 0), 0.35, 0x1357), color: 0x54903f, position: [0.35, 0.3, 0.2] },
    {
      geometry: roughen(sphere(0.35, 0), 0.35, 0x8642),
      color: 0x3f6f33,
      position: [-0.3, 0.28, -0.25],
    },
  ]);
}

function grassTuft(): THREE.BufferGeometry {
  const parts: Part[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    parts.push({
      geometry: cone(0.07, 0.55, 3),
      color: i % 2 === 0 ? 0x6fae52 : 0x5c9644,
      position: [Math.cos(a) * 0.12, 0.28, Math.sin(a) * 0.12],
      rotation: [Math.cos(a) * 0.3, 0, -Math.sin(a) * 0.3],
    });
  }
  return assemble(parts);
}

function stump(): THREE.BufferGeometry {
  return assemble([
    { geometry: cylinder(0.34, 0.42, 0.55, 8), color: BARK, position: [0, 0.28, 0] },
    { geometry: cylinder(0.3, 0.3, 0.06, 8), color: 0xa87f52, position: [0, 0.57, 0] },
  ]);
}

function mushroom(): THREE.BufferGeometry {
  return assemble([
    { geometry: cylinder(0.1, 0.14, 0.7, 6), color: 0xd8cdb4, position: [0, 0.35, 0] },
    { geometry: sphere(0.42, 1), color: 0xa8452f, position: [0, 0.72, 0], scale: [1, 0.6, 1] },
  ]);
}

function crystal(): THREE.BufferGeometry {
  return assemble([
    {
      geometry: new THREE.OctahedronGeometry(0.45, 0),
      color: 0x7fd8e8,
      position: [0, 0.75, 0],
      scale: [1, 1.9, 1],
    },
    {
      geometry: new THREE.OctahedronGeometry(0.26, 0),
      color: 0x9ae4f0,
      position: [0.3, 0.4, 0.15],
      scale: [1, 1.5, 1],
      rotation: [0, 0.6, 0.25],
    },
  ]);
}

function pillar(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(1.1, 0.28, 1.1), color: DARK_STONE, position: [0, 0.14, 0] },
    { geometry: cylinder(0.38, 0.44, 3.4, 8), color: 0x5a5a62, position: [0, 1.9, 0] },
    { geometry: box(1.0, 0.3, 1.0), color: DARK_STONE, position: [0, 3.75, 0] },
  ]);
}

function brazier(): THREE.BufferGeometry {
  return assemble([
    { geometry: cylinder(0.1, 0.16, 1.0, 6), color: 0x3a3a3f, position: [0, 0.5, 0] },
    { geometry: cylinder(0.42, 0.26, 0.34, 8), color: 0x4a4a50, position: [0, 1.15, 0] },
    // Die Glut ist nur Farbe — echtes Licht käme später über Punktlichter,
    // und die kosten auf dem Telefon mehr, als sie hier bringen.
    { geometry: sphere(0.3, 0), color: 0xff9a3c, position: [0, 1.3, 0], scale: [1, 0.7, 1] },
  ]);
}

function well(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geometry: cylinder(1.3, 1.4, 0.9, 12), color: STONE, position: [0, 0.45, 0] },
    { geometry: cylinder(1.1, 1.1, 0.2, 12), color: 0x2a3540, position: [0, 0.92, 0] },
    { geometry: box(0.16, 2.0, 0.16), color: BARK, position: [-1.0, 1.4, 0] },
    { geometry: box(0.16, 2.0, 0.16), color: BARK, position: [1.0, 1.4, 0] },
    { geometry: box(2.6, 0.16, 1.6), color: 0x7a4b2c, position: [0, 2.5, 0], rotation: [0, 0, 0] },
  ];
  return assemble(parts);
}

function signpost(): THREE.BufferGeometry {
  return assemble([
    { geometry: box(0.12, 1.8, 0.12), color: BARK, position: [0, 0.9, 0] },
    { geometry: box(0.9, 0.34, 0.08), color: 0xa87f52, position: [0.3, 1.55, 0] },
  ]);
}

function archway(stoneColor: number, accent: number): THREE.BufferGeometry {
  return assemble([
    { geometry: box(0.7, 4.4, 0.7), color: stoneColor, position: [-2.0, 2.2, 0] },
    { geometry: box(0.7, 4.4, 0.7), color: stoneColor, position: [2.0, 2.2, 0] },
    { geometry: box(4.8, 0.7, 0.8), color: stoneColor, position: [0, 4.6, 0] },
    { geometry: box(1.2, 0.5, 0.3), color: accent, position: [0, 4.6, 0.4] },
  ]);
}

/** Der Katalog. Schlüssel entsprechen dem `model`-Feld im Map-Dokument. */
export const PROP_BUILDERS: Record<string, PropBuilder> = {
  tree_pine: pine,
  tree_broad: broadleaf,
  tree_dead: deadTree,
  rock_small: () => rock(0.7, 0xaa11),
  rock_large: () => rock(1.8, 0xbb22),
  bush,
  grass_tuft: grassTuft,
  stump,
  mushroom_large: mushroom,
  crystal,
  pillar,
  brazier,
  well,
  signpost,
};

/**
 * Der Torbogen.
 *
 * Bewusst nicht im Prop-Katalog: ein Tor ist kein Dekostück, das man neben
 * eine unsichtbare Zone stellt, sondern das sichtbare Teil der Zone selbst.
 * Gezeichnet wird er aus `doc.portals` — derselben Zeile, die den Server
 * auslösen lässt.
 */
export function buildGateArch(): THREE.BufferGeometry {
  return archway(0x8a8478, 0x4cc9bf);
}

/** Ersatzteil für unbekannte Schlüssel — sichtbar falsch, aber nie ein Absturz. */
export function fallbackProp(): THREE.BufferGeometry {
  return assemble([{ geometry: box(0.8, 1.6, 0.8), color: 0xc0392b, position: [0, 0.8, 0] }]);
}
