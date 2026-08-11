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
 *
 * Hier entstehen außerdem die **Splat-Gewichte**: welche Bodenebene an welchem
 * Punkt wie stark gilt. Neigung und Höhe stehen an dieser Stelle ohnehin schon
 * da — sie im Shader noch einmal zu schätzen wäre teurer und ungenauer.
 */

import * as THREE from 'three';
import type { CoreWorld } from '@aurelith/core';
import { MAX_GROUND_LAYERS, type GroundLayerDef, type MapDocument } from '@aurelith/shared';
import { TerrainMaterial } from './terrainMaterial.ts';

export interface TerrainMesh {
  object: THREE.Object3D;
  /** Das Bodenmaterial, damit Texturen nachgetragen werden können. */
  ground: TerrainMaterial;
  dispose(): void;
}

/** Mischt zwei Farben. `t` von 0 bis 1. */
function mix(a: THREE.Color, b: THREE.Color, t: number, out: THREE.Color): THREE.Color {
  out.copy(a).lerp(b, Math.max(0, Math.min(1, t)));
  return out;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Wie stark ein Wert in einem Bereich liegt, mit weichen Rändern.
 *
 * Ohne die weichen Ränder entstünden harte Kanten dort, wo eine Ebene endet —
 * und die fallen auf einem Hang sofort als Linie auf.
 *
 * `blend` ist eine absolute Breite in der Einheit des Werts, kein Anteil des
 * Bereichs. Das ist der Unterschied zwischen einem Übergang von drei Metern
 * und einem von dreitausend: Bereiche wie `[-2, 10000]` sind nach oben offen,
 * und ein Anteil davon verschmiert über die halbe Welt.
 */
function band(value: number, min: number, max: number, blend: number): number {
  const b = Math.max(1e-4, blend);
  return smoothstep(min - b, min + b, value) * (1 - smoothstep(max - b, max + b, value));
}

function layerWeight(layer: GroundLayerDef, slopeDeg: number, height: number): number {
  return (
    band(slopeDeg, layer.slope[0], layer.slope[1], layer.slopeBlend) *
    band(height, layer.height[0], layer.height[1], layer.heightBlend) *
    layer.strength
  );
}

export function buildTerrain(
  world: CoreWorld,
  doc: MapDocument,
  cellSize: number,
  options: { useNormalMaps: boolean },
): TerrainMesh {
  const t = doc.terrain;
  const half = t.size / 2;
  const cols = Math.max(2, Math.ceil(t.size / cellSize)) + 1;
  const step = t.size / (cols - 1);

  const heights = world.sampleHeightGrid(-half, -half, step, cols, cols);
  const layers = t.layers.slice(0, MAX_GROUND_LAYERS);

  const vertexCount = cols * cols;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const splat = new Float32Array(vertexCount * 4);

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

      // Zentrale Differenzen. Am Rand fällt der Nachbar weg, dann ist es eine
      // einseitige Differenz — dort steht ohnehin niemand.
      const xr = Math.min(cols - 1, ix + 1);
      const xl = Math.max(0, ix - 1);
      const zr = Math.min(cols - 1, iz + 1);
      const zl = Math.max(0, iz - 1);
      const dhdx = (heights[iz * cols + xr]! - heights[iz * cols + xl]!) / ((xr - xl) * step);
      const dhdz = (heights[zr * cols + ix]! - heights[zl * cols + ix]!) / ((zr - zl) * step);
      const slopeDeg = Math.atan(Math.hypot(dhdx, dhdz)) * (180 / Math.PI);

      // Prozedurale Grundfarbe. Sie bleibt überall dort sichtbar, wo keine
      // Bodenebene deckt — also bis Texturen geliefert sind.
      const normalizedSlope = Math.min(1, slopeDeg / 45);
      const patch = (Math.sin(x * 0.09) + Math.cos(z * 0.11)) * 0.5;
      mix(grass, grassAlt, patch * 0.5 + 0.5, scratch);
      if (normalizedSlope > 0.35) mix(scratch, rock, (normalizedSlope - 0.35) / 0.65, scratch);
      const nearWater = (y - t.waterLevel) / 2.5;
      if (nearWater < 1 && nearWater > -2) mix(scratch, sand, 1 - Math.max(0, nearWater), scratch);

      colors[i * 3] = scratch.r;
      colors[i * 3 + 1] = scratch.g;
      colors[i * 3 + 2] = scratch.b;

      for (let l = 0; l < layers.length; l++) {
        splat[i * 4 + l] = layerWeight(layers[l]!, slopeDeg, y);
      }
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
  geometry.setAttribute('splat', new THREE.BufferAttribute(splat, 4));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const ground = new TerrainMaterial(layers, options);
  const mesh = new THREE.Mesh(geometry, ground.material);
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
    ground,
    dispose() {
      geometry.dispose();
      ground.dispose();
      waterGeo?.dispose();
      waterMat?.dispose();
    },
  };
}
