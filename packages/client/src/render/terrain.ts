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
import {
  MAX_GROUND_LAYERS,
  decodePaintField,
  sampleField,
  type GroundLayerDef,
  type MapDocument,
} from '@aurelith/shared';
import { TerrainMaterial } from './terrainMaterial.ts';

/** Rechteck in Weltkoordinaten. */
export interface TerrainBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface TerrainMesh {
  object: THREE.Object3D;
  /** Das Bodenmaterial, damit Texturen nachgetragen werden können. */
  ground: TerrainMaterial;
  /**
   * Rechnet einen Ausschnitt neu — Höhen, Farben, Bodenebenen, Normalen.
   *
   * Für den Editor: beim Ziehen eines Pinsels soll man sehen, was man tut, und
   * nicht erst beim Loslassen. Ein kompletter Neuaufbau je Mausbewegung wäre
   * dafür zu teuer — bei einer Karte von 512 Einheiten hat das Netz gut
   * sechzehntausend Vertizes, und eine neue Geometrie je Bild würde den
   * Speicher durchwalken. Angefasst wird deshalb nur, was der Pinsel berührt:
   * bei Radius vierzehn und Zellgrösse vier sind das rund fünfzig Vertizes.
   *
   * Ohne Grenzen wird alles neu gerechnet.
   */
  refresh(bounds?: TerrainBounds): void;
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

export interface BuildTerrainOptions {
  useNormalMaps: boolean;
  /**
   * Lebendes Malfeld statt des kodierten aus dem Dokument.
   *
   * Der Editor haelt seine Gewichte als Zahlen und aendert sie bei jedem
   * Pinselstrich. Sie jedes Mal nach Base64 und zurueck zu wandeln waere
   * neunundachtzig Kilobyte Arbeit je Bild — hier geht dieselbe Sicht direkt
   * hinein.
   */
  paint?: { values: Uint8Array; resolution: number };
}

export function buildTerrain(
  world: CoreWorld,
  doc: MapDocument,
  cellSize: number,
  options: BuildTerrainOptions,
): TerrainMesh {
  const t = doc.terrain;
  const half = t.size / 2;
  const cols = Math.max(2, Math.ceil(t.size / cellSize)) + 1;
  const step = t.size / (cols - 1);

  const heights = world.sampleHeightGrid(-half, -half, step, cols, cols);
  const layers = t.layers.slice(0, MAX_GROUND_LAYERS);

  // Von Hand gemalte Bodenebenen. Wo etwas gemalt wurde, gilt das Gemalte;
  // sonst weiter die Regeln aus Neigung und Höhe. Der Unterschied zwischen
  // „hier soll nichts liegen" und „hier hat niemand gemalt" steckt darin, ob
  // an einem Punkt überhaupt ein Gewicht ungleich null steht.
  const stored = decodePaintField(t.paint);
  const paint = options.paint?.values ?? stored;
  const paintResolution = options.paint?.resolution ?? (stored ? (t.paint?.resolution ?? 0) : 0);
  const painted: number[] = [0, 0, 0, 0];

  const vertexCount = cols * cols;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const splat = new Float32Array(vertexCount * 4);

  const grass = new THREE.Color(t.grassColor);
  const grassAlt = new THREE.Color(t.grassColorAlt);
  const rock = new THREE.Color(t.rockColor);
  const sand = new THREE.Color(t.sandColor);
  const scratch = new THREE.Color();

  /**
   * Rechnet einen einzelnen Stuetzpunkt aus dem Hoehengitter.
   *
   * Die Normale kommt aus zentralen Differenzen und nicht aus
   * `computeVertexNormals`. Zwei Gruende: sie laesst sich fuer einen einzelnen
   * Vertex bestimmen — was ein Neurechnen von Ausschnitten ueberhaupt erst
   * moeglich macht — und es ist dieselbe Formel wie `terrainNormal` im Kern.
   */
  function computeVertex(ix: number, iz: number): void {
    const i = iz * cols + ix;
    const x = -half + ix * step;
    const z = -half + iz * step;
    const y = heights[i]!;

    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;

    // Am Rand faellt der Nachbar weg, dann ist es eine einseitige Differenz —
    // dort steht ohnehin niemand.
    const xr = Math.min(cols - 1, ix + 1);
    const xl = Math.max(0, ix - 1);
    const zr = Math.min(cols - 1, iz + 1);
    const zl = Math.max(0, iz - 1);
    const dx = (xr - xl) * step;
    const dz = (zr - zl) * step;
    const dhdx = (heights[iz * cols + xr]! - heights[iz * cols + xl]!) / dx;
    const dhdz = (heights[zr * cols + ix]! - heights[zl * cols + ix]!) / dz;

    let nx = -dhdx;
    let ny = 1;
    let nz = -dhdz;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    normals[i * 3] = nx;
    normals[i * 3 + 1] = ny;
    normals[i * 3 + 2] = nz;

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

    let sumPainted = 0;
    if (paint && paintResolution >= 2) {
      sampleField(paint, paintResolution, t.size, x, z, MAX_GROUND_LAYERS, painted);
      for (let l = 0; l < MAX_GROUND_LAYERS; l++) sumPainted += painted[l]!;
    }

    for (let l = 0; l < MAX_GROUND_LAYERS; l++) splat[i * 4 + l] = 0;

    if (sumPainted > 0.5) {
      // Gemalt: die Regeln treten zurück. Auf eins normiert, damit ein
      // halbherziger Pinselstrich nicht dunkler ausfällt als ein voller.
      for (let l = 0; l < layers.length; l++) {
        splat[i * 4 + l] = (painted[l]! / sumPainted) * (layers[l]!.strength || 1);
      }
    } else {
      for (let l = 0; l < layers.length; l++) {
        splat[i * 4 + l] = layerWeight(layers[l]!, slopeDeg, y);
      }
    }
  }

  for (let iz = 0; iz < cols; iz++) {
    for (let ix = 0; ix < cols; ix++) computeVertex(ix, iz);
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
  const positionAttr = new THREE.BufferAttribute(positions, 3);
  const normalAttr = new THREE.BufferAttribute(normals, 3);
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  const splatAttr = new THREE.BufferAttribute(splat, 4);
  geometry.setAttribute('position', positionAttr);
  geometry.setAttribute('normal', normalAttr);
  geometry.setAttribute('color', colorAttr);
  geometry.setAttribute('splat', splatAttr);
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
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

  /** Gitterindex zu einer Weltkoordinate, auf das Netz begrenzt. */
  const indexOf = (value: number) =>
    Math.max(0, Math.min(cols - 1, Math.round((value + half) / step)));

  return {
    object: group,
    ground,

    refresh(bounds) {
      // Ein Stützpunkt Rand mehr: die Normale eines Vertex hängt an seinen
      // Nachbarn, und die müssen die neuen Höhen schon kennen.
      const x0 = bounds ? Math.max(0, indexOf(bounds.minX) - 1) : 0;
      const x1 = bounds ? Math.min(cols - 1, indexOf(bounds.maxX) + 1) : cols - 1;
      const z0 = bounds ? Math.max(0, indexOf(bounds.minZ) - 1) : 0;
      const z1 = bounds ? Math.min(cols - 1, indexOf(bounds.maxZ) + 1) : cols - 1;
      if (x1 < x0 || z1 < z0) return;

      // Höhen des Ausschnitts frisch aus dem Kern — mit einem weiteren Ring,
      // weil die Randvertizes ihre Nachbarn brauchen.
      const sx0 = Math.max(0, x0 - 1);
      const sx1 = Math.min(cols - 1, x1 + 1);
      const sz0 = Math.max(0, z0 - 1);
      const sz1 = Math.min(cols - 1, z1 + 1);
      const cx = sx1 - sx0 + 1;
      const cz = sz1 - sz0 + 1;
      const sub = world.sampleHeightGrid(-half + sx0 * step, -half + sz0 * step, step, cx, cz);
      for (let iz = 0; iz < cz; iz++) {
        for (let ix = 0; ix < cx; ix++) {
          heights[(sz0 + iz) * cols + (sx0 + ix)] = sub[iz * cx + ix]!;
        }
      }

      for (let iz = z0; iz <= z1; iz++) {
        for (let ix = x0; ix <= x1; ix++) computeVertex(ix, iz);
      }

      positionAttr.needsUpdate = true;
      normalAttr.needsUpdate = true;
      colorAttr.needsUpdate = true;
      splatAttr.needsUpdate = true;
      // Die Hüllkugel nur beim vollen Durchlauf: ein Pinselstrich verschiebt
      // sie nicht nennenswert, und sie kostet einen Lauf über alle Vertizes.
      if (!bounds) geometry.computeBoundingSphere();
    },

    dispose() {
      geometry.dispose();
      ground.dispose();
      waterGeo?.dispose();
      waterMat?.dispose();
    },
  };
}
