/**
 * Map-Editor — Grundgerüst.
 *
 * Der Zweck dieses Pakets ist zunächst ein Nachweis: dass Maps tatsächlich
 * Daten sind und sich außerhalb des Spiels bearbeiten lassen. Er lädt dieselbe
 * `aurelith.map`-Datei, die Server und Client lesen, zeichnet sie mit denselben
 * prozeduralen Modellen und schreibt sie unverändert im selben Format zurück.
 *
 * Was er heute kann: Map laden, Props setzen und löschen, Ergebnis
 * herunterladen. Was fehlt und als Nächstes kommt: Terrain malen, Spawner und
 * Portale bearbeiten, Mehrfachauswahl, Rückgängig.
 *
 * Wichtig ist, dass er den **Kern** für die Höhen benutzt und nicht eine eigene
 * Rechnung — sonst stünden die Props im Editor woanders als im Spiel.
 */

import * as THREE from 'three';
import { Core, type CoreModuleFactory, type CoreWorld } from '@aurelith/core';
import {
  MAP_FORMAT_VERSION,
  parseMapDocument,
  serializeMapDocument,
  type MapDocument,
  type PropInstance,
} from '@aurelith/shared';
import { createSharedMaterial } from '@aurelith/client/render/geometry.ts';
import { PROP_BUILDERS } from '@aurelith/client/render/props.ts';
import { buildTerrain, type TerrainMesh } from '@aurelith/client/render/terrain.ts';
import { TextureLoader } from '@aurelith/client/render/textures.ts';
import './style.css';

const MAPS = ['lichtmoor', 'dornwald', 'gruft_01'];

/**
 * Unterpfad, unter dem der Editor liegt. Bei GitHub Pages ohne eigene Domain
 * ist das `/<repo>/editor`, im Entwicklungsbetrieb leer. Alle Asset-Adressen
 * hängen davor — sonst greift der Editor auf der Projektseite ins Leere.
 */
const BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const panel = document.getElementById('panel') as HTMLElement;
const hint = document.getElementById('hint') as HTMLElement;

hint.textContent =
  'Linke Maustaste: Prop setzen · Rechtsklick auf ein Prop: löschen\n' +
  'Ziehen mit mittlerer Maustaste oder Umschalt: Kamera drehen · Rad: zoomen';

// --- Kern ------------------------------------------------------------------

// Über eine Variable, damit weder TypeScript noch Vite versuchen, den Glue
// aufzulösen — er wird zur Laufzeit vom Asset-Pfad geholt.
const glueUrl = `${BASE}/core/aurelith_core.js`;
const glue = (await import(/* @vite-ignore */ glueUrl)) as { default: CoreModuleFactory };
const core = await Core.fromModule(
  await glue.default({
    locateFile: (p: string) => (p.endsWith('.wasm') ? `${BASE}/core/aurelith_core.wasm` : p),
  }),
);

// --- Szene -----------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, 1, 0.5, 2000);
const material = createSharedMaterial();

// Derselbe Texturlader wie im Client, nur mit schlichtem fetch statt Streamer:
// der Editor muss denselben Boden zeigen wie das Spiel, sonst setzt man Props
// auf ein Gelaende, das es so nicht gibt.
const textures = new TextureLoader(async (path) => {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} fuer ${path}`);
  return res.arrayBuffer();
});

scene.add(new THREE.HemisphereLight(0xbcd4ea, 0x3a4a3a, 1.1));
const sun = new THREE.DirectionalLight(0xfff2d8, 1.4);
sun.position.set(60, 90, 40);
scene.add(sun);

const root = new THREE.Group();
scene.add(root);

// Markierung der Zeigerposition auf dem Gelände.
const cursor = new THREE.Mesh(
  new THREE.RingGeometry(0.8, 1.1, 24),
  new THREE.MeshBasicMaterial({ color: 0x4cc9bf, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }),
);
cursor.rotation.x = -Math.PI / 2;
scene.add(cursor);

let camYaw = 0.6;
let camPitch = 0.75;
let camDistance = 90;
const camTarget = new THREE.Vector3();

// --- Zustand ---------------------------------------------------------------

let doc: MapDocument | undefined;
let world: CoreWorld | undefined;
let terrain: TerrainMesh | undefined;
let propMeshes: THREE.InstancedMesh[] = [];
let selectedModel = Object.keys(PROP_BUILDERS)[0]!;
let nextPropId = 1;

const geometryCache = new Map<string, THREE.BufferGeometry>();
function propGeometry(key: string): THREE.BufferGeometry {
  let geo = geometryCache.get(key);
  if (!geo) {
    geo = (PROP_BUILDERS[key] ?? PROP_BUILDERS.rock_small!)();
    geometryCache.set(key, geo);
  }
  return geo;
}

async function loadMap(id: string): Promise<void> {
  const raw = await fetch(`${BASE}/maps/${id}.json`).then((r) => r.json());
  doc = parseMapDocument(raw, id);

  world?.dispose();
  world = core.createWorld(doc.terrain.seed, {
    size: doc.terrain.size,
    cellSize: doc.terrain.cellSize,
    seed: doc.terrain.seed,
    heightScale: doc.terrain.heightScale,
    featureScale: doc.terrain.featureScale,
  });

  if (terrain) {
    root.remove(terrain.object);
    terrain.dispose();
  }
  terrain = buildTerrain(world, doc, doc.terrain.cellSize, { useNormalMaps: true });
  root.add(terrain.object);
  void loadGroundTextures(doc, terrain);

  // Höchste vergebene Nummer weiterzählen, damit neue Kennungen nicht kollidieren.
  nextPropId =
    doc.props.reduce((max, p) => {
      const n = Number(/\d+/.exec(p.id)?.[0] ?? 0);
      return n > max ? n : max;
    }, 0) + 1;

  camTarget.set(doc.spawn.x, world.heightAt(doc.spawn.x, doc.spawn.z), doc.spawn.z);
  rebuildProps();
  renderPanel();
}

/** Traegt die Bodentexturen nach, sobald sie da sind. */
async function loadGroundTextures(document_: MapDocument, mesh: TerrainMesh): Promise<void> {
  const anisotropy = renderer.capabilities.getMaxAnisotropy();
  await Promise.all(
    document_.terrain.layers.map(async (layer, index) => {
      const current = () => terrain === mesh;
      if (layer.texture) {
        const tex = await textures.load(layer.texture, { srgb: true, anisotropy });
        if (current()) mesh.ground.setAlbedo(index, tex);
      }
      if (layer.normal) {
        const tex = await textures.load(layer.normal, { srgb: false, anisotropy });
        if (current()) mesh.ground.setNormal(index, tex);
      }
    }),
  ).catch((err) => console.warn('[boden] Textur nicht ladbar:', err));
}

function rebuildProps(): void {
  for (const mesh of propMeshes) {
    root.remove(mesh);
    mesh.dispose();
  }
  propMeshes = [];
  if (!doc || !world) return;

  const byModel = new Map<string, PropInstance[]>();
  for (const p of doc.props) {
    const list = byModel.get(p.model);
    if (list) list.push(p);
    else byModel.set(p.model, [p]);
  }

  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();

  for (const [model, props] of byModel) {
    const mesh = new THREE.InstancedMesh(propGeometry(model), material, props.length);
    mesh.frustumCulled = false;
    mesh.userData.model = model;
    for (let i = 0; i < props.length; i++) {
      const p = props[i]!;
      const y = p.snapToGround ? world.heightAt(p.position[0], p.position[2]) : p.position[1];
      pos.set(p.position[0], y, p.position[2]);
      quat.setFromEuler(new THREE.Euler(p.rotation[0], p.rotation[1], p.rotation[2]));
      scale.setScalar(p.scale);
      matrix.compose(pos, quat, scale);
      mesh.setMatrixAt(i, matrix);
      color.setHex(p.tint ?? 0xffffff);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    root.add(mesh);
    propMeshes.push(mesh);
  }
}

// --- Bedienfeld ------------------------------------------------------------

function renderPanel(): void {
  panel.replaceChildren();

  const title = document.createElement('h1');
  title.textContent = 'Map-Editor';
  panel.appendChild(title);

  const mapLabel = document.createElement('h2');
  mapLabel.textContent = 'Karte';
  const select = document.createElement('select');
  for (const id of MAPS) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id;
    option.selected = doc?.id === id;
    select.appendChild(option);
  }
  select.addEventListener('change', () => void loadMap(select.value));
  panel.append(mapLabel, select);

  const paletteLabel = document.createElement('h2');
  paletteLabel.textContent = 'Props';
  const palette = document.createElement('div');
  palette.className = 'palette';
  for (const key of Object.keys(PROP_BUILDERS)) {
    const button = document.createElement('button');
    button.textContent = key;
    button.setAttribute('aria-pressed', String(key === selectedModel));
    button.addEventListener('click', () => {
      selectedModel = key;
      renderPanel();
    });
    palette.appendChild(button);
  }
  panel.append(paletteLabel, palette);

  const statsLabel = document.createElement('h2');
  statsLabel.textContent = 'Inhalt';
  const stats = document.createElement('div');
  stats.className = 'stats';
  if (doc) {
    for (const [k, v] of [
      ['Format', `v${doc.version} / v${MAP_FORMAT_VERSION}`],
      ['Props', String(doc.props.length)],
      ['Spawner', String(doc.spawners.length)],
      ['NPCs', String(doc.npcs.length)],
      ['Portale', String(doc.portals.length)],
      ['Größe', `${doc.terrain.size} × ${doc.terrain.size}`],
    ]) {
      const line = document.createElement('div');
      line.textContent = `${k}: ${v}`;
      stats.appendChild(line);
    }
  }
  panel.append(statsLabel, stats);

  const save = document.createElement('button');
  save.textContent = 'Map herunterladen';
  save.addEventListener('click', () => {
    if (!doc) return;
    // Genau das Format, das Server und Client lesen — kein Export, sondern
    // dieselbe Datei.
    const blob = new Blob([serializeMapDocument(doc)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${doc.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
  panel.appendChild(save);
}

// --- Eingabe ---------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let dragging = false;
let lastX = 0;
let lastY = 0;
let dragDistance = 0;

function updatePointer(e: PointerEvent): void {
  pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
}

/** Punkt auf dem Gelände unter dem Zeiger. */
function groundPoint(): THREE.Vector3 | undefined {
  if (!terrain) return undefined;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(terrain.object, true);
  return hits[0]?.point;
}

canvas.addEventListener('pointerdown', (e) => {
  updatePointer(e);
  if (e.button === 1 || e.shiftKey) {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    dragDistance = 0;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
});

canvas.addEventListener('pointermove', (e) => {
  updatePointer(e);
  if (dragging) {
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    dragDistance += Math.abs(dx) + Math.abs(dy);
    camYaw -= dx * 0.005;
    camPitch = Math.max(0.15, Math.min(1.45, camPitch + dy * 0.005));
  }
});

window.addEventListener('pointerup', (e) => {
  if (dragging) {
    dragging = false;
    return;
  }
  if (e.button === 0) placeProp();
  if (e.button === 2) removePropUnderPointer();
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  camDistance = Math.max(12, Math.min(400, camDistance + Math.sign(e.deltaY) * camDistance * 0.12));
}, { passive: false });

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function placeProp(): void {
  const point = groundPoint();
  if (!point || !doc) return;

  doc.props.push({
    id: `p_${String(nextPropId++).padStart(4, '0')}`,
    model: selectedModel,
    position: [round(point.x), 0, round(point.z)],
    rotation: [0, Math.random() * Math.PI * 2, 0],
    scale: 1,
    snapToGround: true,
    // Bäume und Felsen blockieren, Gras und Pilze nicht.
    collision: /tree|rock|pillar|well/.test(selectedModel) ? 'circle' : 'none',
    collisionRadius: 1.2,
  });
  rebuildProps();
  renderPanel();
}

function removePropUnderPointer(): void {
  if (!doc) return;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(propMeshes, false);
  const hit = hits[0];
  if (!hit || hit.instanceId === undefined) return;

  const model = (hit.object as THREE.InstancedMesh).userData.model as string;
  const ofModel = doc.props.filter((p) => p.model === model);
  const victim = ofModel[hit.instanceId];
  if (!victim) return;

  doc.props = doc.props.filter((p) => p !== victim);
  rebuildProps();
  renderPanel();
}

const round = (v: number) => Math.round(v * 100) / 100;

// --- Schleife --------------------------------------------------------------

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function frame(): void {
  requestAnimationFrame(frame);

  const cosP = Math.cos(camPitch);
  camera.position.set(
    camTarget.x - Math.sin(camYaw) * cosP * camDistance,
    camTarget.y + Math.sin(camPitch) * camDistance,
    camTarget.z - Math.cos(camYaw) * cosP * camDistance,
  );
  camera.lookAt(camTarget);

  const point = groundPoint();
  if (point) {
    cursor.position.set(point.x, point.y + 0.15, point.z);
    cursor.visible = true;
  } else {
    cursor.visible = false;
  }

  renderer.render(scene, camera);
}

await loadMap(MAPS[0]!);
frame();
