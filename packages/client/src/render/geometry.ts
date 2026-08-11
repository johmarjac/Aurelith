/**
 * Bausteine für prozedurale Modelle.
 *
 * Alles, was wir zeichnen, ist heute aus Grundkörpern zusammengesetzt und
 * bekommt seine Farbe über Vertexfarben — ein Material für die ganze Szene,
 * also wenige Zustandswechsel und Modelle, die sich instanziieren lassen.
 *
 * Das ist ausdrücklich ein Platzhalter. Die Modelle sollen später gegen
 * gelieferte glTF-Dateien getauscht werden, und die Schnittstelle dazu ist die
 * ModelRegistry: sie liefert Geometrien und Rigs unter einem Schlüssel, und
 * woher die kommen, geht dem Rest des Renderers nichts an.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface Part {
  geometry: THREE.BufferGeometry;
  color: number;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
}

/** Färbt eine Geometrie ein, indem sie ein Vertexfarben-Attribut bekommt. */
export function paint(geometry: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const count = geometry.attributes.position!.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * Verschmilzt Teile zu einer Geometrie. Ein Prop ist damit ein Draw-Call statt
 * fünf, und Instanziierung wird überhaupt erst möglich.
 */
export function assemble(parts: Part[]): THREE.BufferGeometry {
  const prepared = parts.map((part) => {
    // Three.js verschmilzt nur Geometrien mit gleicher Struktur, und die
    // Grundkörper sind uneinheitlich: Zylinder und Kegel sind indiziert,
    // Ikosaeder nicht. Alles auf denselben Nenner bringen ist billiger als
    // jede Kombination von Hand zu prüfen — die Modelle sind klein genug,
    // dass die doppelten Vertizes nicht ins Gewicht fallen.
    const source = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry;
    const geo = source === part.geometry ? source.clone() : source;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    if (part.rotation) {
      q.setFromEuler(new THREE.Euler(part.rotation[0], part.rotation[1], part.rotation[2]));
    }
    m.compose(
      new THREE.Vector3(...(part.position ?? [0, 0, 0])),
      q,
      new THREE.Vector3(...(part.scale ?? [1, 1, 1])),
    );
    geo.applyMatrix4(m);
    paint(geo, part.color);
    return geo;
  });

  const merged = mergeGeometries(prepared, false);
  for (const geo of prepared) geo.dispose();
  if (!merged) throw new Error('Geometrien ließen sich nicht verschmelzen');
  merged.computeVertexNormals();
  return merged;
}

// --- Grundkörper, einmal erzeugt und geteilt --------------------------------

const shared = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 8),
  cone: new THREE.ConeGeometry(0.5, 1, 8),
  sphere: new THREE.IcosahedronGeometry(0.5, 1),
  lowSphere: new THREE.IcosahedronGeometry(0.5, 0),
  octahedron: new THREE.OctahedronGeometry(0.5, 0),
};

export const primitives = shared;

export function box(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

export function cylinder(rTop: number, rBottom: number, h: number, seg = 8): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rTop, rBottom, h, seg);
}

export function cone(r: number, h: number, seg = 8): THREE.BufferGeometry {
  return new THREE.ConeGeometry(r, h, seg);
}

export function sphere(r: number, detail = 1): THREE.BufferGeometry {
  return new THREE.IcosahedronGeometry(r, detail);
}

/**
 * Verzieht eine Geometrie deterministisch — aus einer glatten Kugel wird so
 * ein Felsblock, ohne dass wir Felsen modellieren müssten.
 */
export function roughen(
  geometry: THREE.BufferGeometry,
  amount: number,
  seed: number,
): THREE.BufferGeometry {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  let state = seed >>> 0 || 1;
  const rand = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };

  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) * (1 + (rand() - 0.5) * amount),
      pos.getY(i) * (1 + (rand() - 0.5) * amount),
      pos.getZ(i) * (1 + (rand() - 0.5) * amount),
    );
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/** Ein Material für alles Undurchsichtige. Farbe kommt aus den Vertizes. */
export function createSharedMaterial(): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ vertexColors: true });
}
