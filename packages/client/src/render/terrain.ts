/**
 * Terrainnetz.
 *
 * Die Höhen kommen aus dem wasm-Kern — derselben Funktion, die serverseitig
 * entscheidet, wo man stehen kann. Damit ist der sichtbare Boden per
 * Konstruktion der begehbare Boden, und nicht zufällig ähnlich.
 *
 * Das Gitter wird in **einem** Aufruf gefüllt (`sampleHeightGrid`), nicht
 * Stützpunkt für Stützpunkt. Ein Aufruf über die Brücke je Vertex wäre bei
 * siebentausend Vertizes genau die Art von Grenzverkehr, die der Blueprint
 * vermeiden will.
 */

import * as THREE from 'three';
import type { CoreWorld } from '@aurelith/core';
import type { MapDocument } from '@aurelith/shared';

export interface TerrainMesh {
  object: THREE.Object3D;
  dispose(): void;
}

/** Mischt zwei Farben. `t` von 0 bis 1. */
function mix(a: THREE.Color, b: THREE.Color, t: number, out: THREE.Color): THREE.Color {
  out.copy(a).lerp(b, Math.max(0, Math.min(1, t)));
  return out;
}

export function buildTerrain(
  world: CoreWorld,
  doc: MapDocument,
  cellSize: number,
): TerrainMesh {
  const t = doc.terrain;
  const half = t.size / 2;
  const cols = Math.max(2, Math.ceil(t.size / cellSize)) + 1;
  const step = t.size / (cols - 1);

  const heights = world.sampleHeightGrid(-half, -half, step, cols, cols);

  const vertexCount = cols * cols;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);

  const grass = new THREE.Color(t.grassColor);
  const grassAlt = new THREE.Color(t.grassColorAlt);
  const rock = new THREE.Color(t.rockColor);
  const sand = new THREE.Color(t.sandColor);
  const scratch = new THREE.Color();

  for (let iz = 0; iz < cols; iz++) {
    for (let ix = 0; ix < cols; ix++) {
      const i = iz * cols + ix;
      const x = -half + ix * step;
      const z = -half + iz * step;
      const y = heights[i]!;

      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      // Steigung aus den Nachbarhöhen. Steiles wird Fels, Tiefes wird Sand.
      const hx = heights[iz * cols + Math.min(cols - 1, ix + 1)]! - heights[iz * cols + Math.max(0, ix - 1)]!;
      const hz = heights[Math.min(cols - 1, iz + 1) * cols + ix]! - heights[Math.max(0, iz - 1) * cols + ix]!;
      const slope = Math.min(1, Math.hypot(hx, hz) / (step * 1.5));

      // Zwei Grüntöne im Wechsel, damit die Fläche nicht wie Filz aussieht.
      const patch = (Math.sin(x * 0.09) + Math.cos(z * 0.11)) * 0.5;
      mix(grass, grassAlt, patch * 0.5 + 0.5, scratch);
      if (slope > 0.35) mix(scratch, rock, (slope - 0.35) / 0.65, scratch);
      const nearWater = (y - t.waterLevel) / 2.5;
      if (nearWater < 1 && nearWater > -2) mix(scratch, sand, 1 - Math.max(0, nearWater), scratch);

      colors[i * 3] = scratch.r;
      colors[i * 3 + 1] = scratch.g;
      colors[i * 3 + 2] = scratch.b;
    }
  }

  const quads = (cols - 1) * (cols - 1);
  const indices = vertexCount > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  let k = 0;
  for (let iz = 0; iz < cols - 1; iz++) {
    for (let ix = 0; ix < cols - 1; ix++) {
      const a = iz * cols + ix;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;

  const group = new THREE.Group();
  group.add(mesh);

  // Wasserfläche, wenn der Spiegel überhaupt Gelände schneidet.
  let waterGeo: THREE.BufferGeometry | undefined;
  let waterMat: THREE.Material | undefined;
  let lowest = Number.POSITIVE_INFINITY;
  for (const h of heights) if (h < lowest) lowest = h;

  if (t.waterLevel > lowest) {
    waterGeo = new THREE.PlaneGeometry(t.size, t.size);
    waterMat = new THREE.MeshLambertMaterial({
      color: 0x2f6f8f,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = t.waterLevel;
    water.name = 'water';
    group.add(water);
  }

  return {
    object: group,
    dispose() {
      geometry.dispose();
      material.dispose();
      waterGeo?.dispose();
      waterMat?.dispose();
    },
  };
}
