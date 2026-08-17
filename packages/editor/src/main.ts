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
  type PortalDef,
  type PropInstance,
  SCULPT_UNIT,
  decodePaintField,
  decodeSculptField,
  encodePaintField,
  encodeSculptField,
  sculptFieldIsEmpty,
  paintFieldIsEmpty,
  standardKollision,
  terrainSetup,
} from '@aurelith/shared';
import {
  createFoliageMaterial,
  createSharedMaterial,
  createStoneMaterial,
} from '@aurelith/client/render/geometry.ts';
import { gesteinsTextur } from '@aurelith/client/render/gestein.ts';
import { laubAtlas } from '@aurelith/client/render/laub.ts';
import { materialArt, PROP_BUILDERS, buildGateArch } from '@aurelith/client/render/props.ts';
import { buildTerrain, type TerrainMesh } from '@aurelith/client/render/terrain.ts';
import { TextureLoader } from '@aurelith/client/render/textures.ts';
import {
  DEFAULT_BRUSH,
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  createPaintField,
  createSculptField,
  paintLayer,
  sculptRaise,
  sculptSmooth,
  type BrushSettings,
  type PaintField,
  type SculptField,
} from './brushes.ts';
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
  'Links: Werkzeug anwenden · Rechtsklick auf Prop, Tor oder Zone: löschen\n' +
  'Rechts ziehen: drehen · Mitte ziehen oder Umschalt: schieben · WASD: schieben\n' +
  'Rad: zoomen · Strg + Rad: Pinselgröße · beim Prop-Werkzeug dreht das Rad, Strg + Rad zoomt';

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
/**
 * Und eines für Laub — Blätter und Gras sind Texturen mit Loch.
 *
 * Erst beim ersten Laubprop angelegt, wie im Spiel: die Textur entsteht auf
 * einer Leinwand, und eine Karte ohne Busch soll dafür nicht zahlen.
 */
let laubMaterial: THREE.MeshLambertMaterial | undefined;
/** Und eines für Fels — Findlinge und die schwebenden Inseln. */
let felsMaterial: THREE.MeshLambertMaterial | undefined;
function propMaterial(key: string): THREE.MeshLambertMaterial {
  switch (materialArt(key)) {
    case 'laub':
      laubMaterial ??= createFoliageMaterial(laubAtlas());
      return laubMaterial;
    case 'fels':
      felsMaterial ??= createStoneMaterial(gesteinsTextur());
      return felsMaterial;
    default:
      return material;
  }
}

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

/**
 * Markierung der Zeigerposition auf dem Gelände.
 *
 * Punkte statt eines Rings. Ein Ring liegt zwangsläufig in **einer** Ebene —
 * der des Mittelpunkts — und verschwindet damit im Hang, sobald das Gelände
 * ringsum ansteigt. Genau da braucht man ihn aber. Jeder Punkt sitzt
 * stattdessen auf der Höhe, die das Gelände an *seiner* Stelle hat, und zeigt
 * damit nebenbei die Form dessen, worauf man gleich malt.
 *
 * Die Punkte liegen auf einem festen Weltgitter und wandern nicht mit dem
 * Zeiger mit — sie erscheinen und verschwinden am Rand des Kreises. Das liest
 * sich als Gitter und nicht als Schwarm.
 */
const CURSOR_MAX_POINTS = 4096;
const cursorPositions = new Float32Array(CURSOR_MAX_POINTS * 3);
const cursorGeometry = new THREE.BufferGeometry();
cursorGeometry.setAttribute('position', new THREE.BufferAttribute(cursorPositions, 3));
cursorGeometry.setDrawRange(0, 0);
const cursor = new THREE.Points(
  cursorGeometry,
  new THREE.PointsMaterial({
    color: 0xffffff,
    // Feste Grösse in Bildpunkten: aus der Übersicht heraus wären
    // abstandsskalierte Punkte sonst unsichtbar.
    size: 4,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.9,
    // Ohne Tiefentest: die Punkte sollen auch dann noch zu sehen sein, wenn
    // ein Hügel dazwischenliegt. Sie sind Werkzeug, nicht Welt.
    depthTest: false,
  }),
);
cursor.renderOrder = 10;
cursor.frustumCulled = false;
scene.add(cursor);

/**
 * Vorschau des Props, das gleich gesetzt wird.
 *
 * Beim Prop-Werkzeug sagen Punkte nichts Nützliches: man will nicht wissen,
 * *wo* der Boden ist, sondern wie das Ding dort aussieht. Also steht statt der
 * Markierung das Prop selbst da — halbdurchsichtig, damit man es von einem
 * bereits gesetzten unterscheiden kann.
 *
 * Damit die Vorschau nicht lügt, muss die Drehung vorher feststehen. Sie wurde
 * bisher beim Setzen ausgewürfelt; jetzt wird sie vorher gezogen, gezeigt und
 * dann genau so verwendet. Nach jedem Setzen kommt eine neue — sonst stünde
 * ein ganzer Wald in Reih und Glied.
 */
const ghostMaterial = new THREE.MeshBasicMaterial({
  // Mit den Vertexfarben des Modells, damit man das Prop erkennt und nicht nur
  // seine Silhouette. Der Farbstich darüber unterscheidet die Vorschau von
  // einem bereits gesetzten Prop.
  vertexColors: true,
  color: 0x8fffee,
  transparent: true,
  opacity: 0.55,
  depthWrite: false,
});
const propGhost = new THREE.Mesh(new THREE.BufferGeometry(), ghostMaterial);
propGhost.visible = false;
propGhost.renderOrder = 9;
scene.add(propGhost);

/** Drehung, mit der das nächste Prop gesetzt wird. */
let pendingPropYaw = 0;
function rollPropYaw(): void {
  pendingPropYaw = Math.random() * Math.PI * 2;
}
rollPropYaw();

let camYaw = 0.6;
let camPitch = 0.75;
let camDistance = 90;
const camTarget = new THREE.Vector3();

// --- Zustand ---------------------------------------------------------------

let doc: MapDocument | undefined;
let world: CoreWorld | undefined;
let terrain: TerrainMesh | undefined;
let propMeshes: THREE.InstancedMesh[] = [];
let gateMesh: THREE.InstancedMesh | undefined;
let selectedModel = Object.keys(PROP_BUILDERS)[0]!;
let nextPropId = 1;

/** Was die linke Maustaste gerade tut. */
type Tool = 'props' | 'gates' | 'zonen' | 'raise' | 'lower' | 'smooth' | 'paint';

/**
 * Ob ein Werkzeug beim Ziehen wirkt.
 *
 * Bewusst eine Aufzählung und keine Verneinung von `'props'`: die stand hier
 * zuerst, und als „Tore" dazukam, fiel es prompt in den Pinselzweig — der Klick
 * wurde als Strich behandelt und danach verworfen, also passierte gar nichts.
 * Eine neue Marke muss hier auftauchen, um mitzuwirken, nicht um sich
 * herauszuhalten.
 */
function isBrushTool(t: Tool): boolean {
  return t === 'raise' || t === 'lower' || t === 'smooth' || t === 'paint';
}
let tool: Tool = 'props';
let brush: BrushSettings = { ...DEFAULT_BRUSH };
/** Welche Bodenebene der Malpinsel aufträgt. */
let paintLayerIndex = 0;

/**
 * Die beiden Gitterfelder der geladenen Karte.
 *
 * Sie liegen hier und nicht im Dokument, weil im Dokument die kodierte Fassung
 * steht: einmal beim Laden entpacken, beim Speichern wieder packen. Alles
 * dazwischen arbeitet auf den Zahlen.
 */
let sculpt: SculptField | undefined;
let paint: PaintField | undefined;
/** Läuft gerade ein Strich? Dann wird beim Loslassen einmal neu aufgebaut. */
let strokeActive = false;
let strokeTouched = 0;
/** Das Tor, das gerade bearbeitet wird. */
let selectedGateId: string | undefined;
let nextGateId = 1;

/**
 * Sperrzonen.
 *
 * Gezogen wird ein Rechteck: aufsetzen, ziehen, loslassen. Ein Klick ohne Weg
 * ergibt keine Zone — eine Fläche von null Metern wäre eine Sperre, die man
 * weder sieht noch je wieder findet.
 */
type ZonenArt = 'beides' | 'lauf' | 'flug';
let zonenArt: ZonenArt = 'beides';
let zonenZiehStart: { x: number; z: number } | undefined;
let zonenMeshes: THREE.Mesh[] = [];
let nextZoneId = 1;
/** Zuletzt getroffener Geländepunkt. Nur für die Auskunft nach aussen. */
let lastGroundPoint: THREE.Vector3 | undefined;

let gateGeometryCache: THREE.BufferGeometry | undefined;
function gateGeometry(): THREE.BufferGeometry {
  gateGeometryCache ??= buildGateArch();
  return gateGeometryCache;
}

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
  const setup = terrainSetup(doc);
  world = core.createWorld(doc.terrain.seed, setup.shape);
  world.setSculpt(setup.sculpt, setup.sculptResolution);

  // Die Gitterfelder entpacken. Fehlt eines, wird ein leeres angelegt — leer
  // heisst „nichts geformt" bzw. „nichts gemalt", und beides ist der Zustand,
  // in dem jede Karte anfängt.
  sculpt = setup.sculpt
    ? { values: setup.sculpt, resolution: setup.sculptResolution }
    : createSculptField(doc.terrain.size);
  const storedPaint = decodePaintField(doc.terrain.paint);
  paint = storedPaint
    ? { values: storedPaint, resolution: doc.terrain.paint!.resolution }
    : createPaintField(doc.terrain.size);

  if (terrain) {
    root.remove(terrain.object);
    terrain.dispose();
  }
  // Das lebende Malfeld direkt hineingeben: sonst muesste es fuer jeden
  // Pinselstrich nach Base64 und zurueck.
  terrain = buildTerrain(world, doc, doc.terrain.cellSize, { useNormalMaps: true, paint });
  root.add(terrain.object);
  void loadGroundTextures(doc, terrain);

  // Höchste vergebene Nummer weiterzählen, damit neue Kennungen nicht kollidieren.
  nextPropId =
    doc.props.reduce((max, p) => {
      const n = Number(/\d+/.exec(p.id)?.[0] ?? 0);
      return n > max ? n : max;
    }, 0) + 1;

  // Hoechste vergebene Torkennung weiterzaehlen.
  nextGateId =
    doc.portals.reduce((max, g) => {
      const n = Number(/\d+/.exec(g.id)?.[0] ?? 0);
      return n > max ? n : max;
    }, 0) + 1;
  selectedGateId = doc.portals[0]?.id;

  nextZoneId =
    doc.zonen.reduce((max, z) => {
      const n = Number(/z_(\d+)/.exec(z.id)?.[1] ?? 0);
      return n > max ? n : max;
    }, 0) + 1;

  camTarget.set(doc.spawn.x, world.heightAt(doc.spawn.x, doc.spawn.z), doc.spawn.z);
  rebuildProps();
  rebuildGates();
  rebuildZonen();
  renderPanel();
}

/**
 * Baut das Geländenetz neu.
 *
 * Nach jedem Strich, aber nicht bei jedem Mausbewegungsereignis: das Netz hat
 * bei einer Karte von 512 Einheiten und Zellgrösse 4 rund siebzehntausend
 * Vertizes, und die neu zu rechnen kostet genug, dass man es beim Ziehen
 * merken würde. Während eines Strichs reicht die Vorschau am Zeiger.
 */
/**
 * Zieht alles nach, was an der Geländehöhe hängt.
 *
 * Nach einem Strich, nicht während. Das Netz selbst wird schon beim Ziehen
 * ausschnittsweise nachgeführt — hier geht es um Props und Tore, die auf dem
 * Boden aufsitzen und sich mit ihm heben und senken.
 */
function settleAfterStroke(): void {
  if (!doc || !world) return;
  rebuildProps();
  rebuildGates();
  // Auch die Zonen: sie sitzen auf dem Gelände auf, und wer einen Berg unter
  // einer Sperre aufschüttet, soll die Sperre danach nicht im Berg suchen.
  rebuildZonen();
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

/**
 * Zeichnet die Tore der Karte.
 *
 * Eigene Instanz-Sammlung und nicht Teil der Props: ein Tor **ist** die Zone,
 * die den Server auslöst — es steht nicht bloss daneben. Wer den Bogen
 * verschiebt, verschiebt damit auch den Auslöser, und andersherum. Genau das
 * ging vorher auseinander, weil der Bogen ein gewöhnliches Prop war.
 *
 * Das ausgewählte Tor wird eingefärbt, damit man beim Bearbeiten sieht, welches
 * gemeint ist.
 */
function rebuildGates(): void {
  if (gateMesh) {
    root.remove(gateMesh);
    gateMesh.dispose();
    gateMesh = undefined;
  }
  if (!doc || !world || doc.portals.length === 0) return;

  const mesh = new THREE.InstancedMesh(gateGeometry(), material, doc.portals.length);
  mesh.frustumCulled = false;

  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);
  const color = new THREE.Color();

  for (let i = 0; i < doc.portals.length; i++) {
    const portal = doc.portals[i]!;
    const [x, z] = portal.position;
    pos.set(x, world.heightAt(x, z), z);
    quat.setFromEuler(new THREE.Euler(0, portal.yaw, 0));
    matrix.compose(pos, quat, scale);
    mesh.setMatrixAt(i, matrix);
    color.setHex(portal.id === selectedGateId ? 0xffd479 : 0xffffff);
    mesh.setColorAt(i, color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  root.add(mesh);
  gateMesh = mesh;
}

/**
 * Zeichnet die Sperrzonen als durchscheinende Quader.
 *
 * Ein Quader und keine Fläche am Boden: eine Flugsperre gilt in der Luft, und
 * eine Markierung im Gras sagte darüber nichts. Die Höhe ist grosszügig —
 * gezeigt wird, dass hier etwas gesperrt ist, nicht wie hoch.
 *
 * Die Farbe sagt, für wen: rot hält Läufer auf, blau Fliegende, violett beide.
 */
function rebuildZonen(): void {
  for (const mesh of zonenMeshes) {
    root.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }
  zonenMeshes = [];
  if (!doc || !world) return;

  for (const zone of doc.zonen) {
    const [x, z] = zone.position;
    const [hx, hz] = zone.extent;
    const farbe =
      zone.keinLauf && zone.keinFlug ? 0xb07be8 : zone.keinLauf ? 0xe8697b : 0x6fa8e8;
    const geo = new THREE.BoxGeometry(hx * 2, ZONEN_HOEHE, hz * 2);
    const mat = new THREE.MeshBasicMaterial({
      color: farbe,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, world.heightAt(x, z) + ZONEN_HOEHE * 0.5 - 4, z);
    mesh.userData.zoneId = zone.id;
    root.add(mesh);
    zonenMeshes.push(mesh);
  }
}

/** Wie hoch ein Zonenquader im Editor gezeichnet wird. Nur Anzeige. */
const ZONEN_HOEHE = 70;

/** Die Zone unter dem Zeiger, falls eine getroffen wird. */
function zoneUnterZeiger(): string | undefined {
  if (zonenMeshes.length === 0) return undefined;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(zonenMeshes, false)[0];
  return hit?.object.userData.zoneId as string | undefined;
}

/** Das Tor unter dem Zeiger, falls eines getroffen wird. */
function gateUnderPointer(): PortalDef | undefined {
  if (!doc || !gateMesh) return undefined;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(gateMesh, false)[0];
  if (!hit || hit.instanceId === undefined) return undefined;
  return doc.portals[hit.instanceId];
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
    const mesh = new THREE.InstancedMesh(propGeometry(model), propMaterial(model), props.length);
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

/**
 * Ein Schieberegler mit Beschriftung.
 *
 * Bewusst `input`-Ereignis und nicht `change`: man will beim Ziehen sehen, wie
 * gross der Pinsel wird, nicht erst beim Loslassen.
 */
function slider(
  caption: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
  format: (v: number) => string,
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'slider';

  const text = document.createElement('span');
  text.textContent = `${caption}: ${format(value)}`;

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    onChange(v);
    text.textContent = `${caption}: ${format(v)}`;
  });

  wrap.append(text, input);
  return wrap;
}

/** Ein beschriftetes Eingabefeld für eine Zahl. */
function numberField(
  caption: string,
  value: number,
  step: number,
  onChange: (v: number) => void,
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field';

  const text = document.createElement('span');
  text.textContent = caption;

  const input = document.createElement('input');
  input.type = 'number';
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) onChange(v);
  });

  wrap.append(text, input);
  return wrap;
}

/** Ein beschriftetes Textfeld. */
function textField(caption: string, value: string, onChange: (v: string) => void): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const text = document.createElement('span');
  text.textContent = caption;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.addEventListener('change', () => onChange(input.value));
  wrap.append(text, input);
  return wrap;
}

/**
 * Karten, die schon einmal geladen wurden — für die Zielprüfung.
 *
 * Der Editor hat immer nur eine Karte offen, die Prüfung braucht aber die Tore
 * der *Zielkarte*. Also einmal holen und behalten; die Dateien ändern sich
 * während einer Sitzung nicht.
 */
const mapCache = new Map<string, MapDocument>();

async function peekMap(id: string): Promise<MapDocument | undefined> {
  if (doc?.id === id) return doc;
  const cached = mapCache.get(id);
  if (cached) return cached;
  try {
    const raw = await fetch(`${BASE}/maps/${id}.json`).then((r) => r.json());
    const parsed = parseMapDocument(raw, id);
    mapCache.set(id, parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Prüft, ob der Zielpunkt eines Tores in einem Tor der Zielkarte landet.
 *
 * Das ist derselbe Fehler, an dem Lichtmoor hing: der Zielpunkt lag exakt auf
 * dem Rückportal, also wurde man nach der Ankunft sofort wieder zurückgereicht.
 * `tools/gen-maps.mjs` bricht deswegen den Build ab — hier soll es einem schon
 * beim Setzen auffallen und nicht erst, wenn man im Spiel im Kreis läuft.
 */
async function checkGateTarget(portal: PortalDef): Promise<string | undefined> {
  const target = await peekMap(portal.target.map);
  if (!target) return `Karte „${portal.target.map}" nicht gefunden.`;

  for (const other of target.portals) {
    if (other === portal) continue;
    const d = Math.hypot(
      portal.target.x - other.position[0],
      portal.target.z - other.position[1],
    );
    if (d <= other.radius) {
      return `Zielpunkt liegt im Tor „${other.label || other.id}" (Abstand ${d.toFixed(1)}, Radius ${other.radius}) — man würde sofort weitergereicht.`;
    }
  }
  return undefined;
}

function renderGatePanel(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'gate-editor';

  if (!doc) return box;

  const portal = doc.portals.find((g) => g.id === selectedGateId);
  if (!portal) {
    const hint_ = document.createElement('div');
    hint_.className = 'stats';
    hint_.textContent =
      doc.portals.length === 0
        ? 'Noch kein Tor auf dieser Karte. Klick ins Gelände setzt eines.'
        : 'Kein Tor ausgewählt. Klick auf einen Bogen wählt ihn aus.';
    box.appendChild(hint_);
    return box;
  }

  // Auswahl unter mehreren Toren.
  if (doc.portals.length > 1) {
    const list = document.createElement('div');
    list.className = 'palette';
    for (const g of doc.portals) {
      const button = document.createElement('button');
      button.textContent = g.label || g.id;
      button.setAttribute('aria-pressed', String(g.id === selectedGateId));
      button.addEventListener('click', () => {
        selectedGateId = g.id;
        rebuildGates();
        renderPanel();
      });
      list.appendChild(button);
    }
    box.appendChild(list);
  }

  const touched = (rebuild: boolean) => {
    if (rebuild) rebuildGates();
    renderPanel();
  };

  box.appendChild(textField('Beschriftung', portal.label, (v) => {
    portal.label = v;
    touched(false);
  }));

  // --- Wo das Tor steht ----------------------------------------------------

  const whereLabel = document.createElement('h3');
  whereLabel.textContent = 'Standort';
  box.appendChild(whereLabel);

  box.appendChild(numberField('X', portal.position[0], 1, (v) => {
    portal.position[0] = v;
    touched(true);
  }));
  box.appendChild(numberField('Z', portal.position[1], 1, (v) => {
    portal.position[1] = v;
    touched(true);
  }));
  box.appendChild(numberField('Ausrichtung', round(portal.yaw), 0.1, (v) => {
    portal.yaw = v;
    touched(true);
  }));
  box.appendChild(numberField('Auslöseradius', portal.radius, 0.5, (v) => {
    portal.radius = Math.max(0.5, v);
    touched(false);
  }));

  // --- Wohin es geht -------------------------------------------------------

  const targetLabel = document.createElement('h3');
  targetLabel.textContent = 'Ziel';
  box.appendChild(targetLabel);

  const mapWrap = document.createElement('label');
  mapWrap.className = 'field';
  const mapText = document.createElement('span');
  mapText.textContent = 'Karte';
  const mapSelect = document.createElement('select');
  for (const id of MAPS) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id;
    option.selected = portal.target.map === id;
    mapSelect.appendChild(option);
  }
  mapSelect.addEventListener('change', () => {
    portal.target.map = mapSelect.value;
    // Sofort neu zeichnen, damit die alte Warnung samt ihrer Marke verschwindet
    // — sonst stünde einen Moment lang ein geprüftes Ergebnis zu einem Ziel da,
    // das es nicht mehr gibt.
    renderPanel();
    void peekMap(mapSelect.value).then((target) => {
      // Beim Kartenwechsel auf deren Startpunkt springen: der ist per
      // Konstruktion frei, und ein Zielpunkt aus der alten Karte waere es
      // hoechstens zufaellig.
      if (target) {
        portal.target.x = target.spawn.x;
        portal.target.z = target.spawn.z;
      }
      renderPanel();
    });
  });
  mapWrap.append(mapText, mapSelect);
  box.appendChild(mapWrap);

  box.appendChild(numberField('Ziel-X', portal.target.x, 1, (v) => {
    portal.target.x = v;
    touched(false);
  }));
  box.appendChild(numberField('Ziel-Z', portal.target.z, 1, (v) => {
    portal.target.z = v;
    touched(false);
  }));
  box.appendChild(numberField('Blickrichtung', round(portal.target.yaw), 0.1, (v) => {
    portal.target.yaw = v;
    touched(false);
  }));

  // Bequemer Weg fuer Tore innerhalb derselben Karte: den Punkt unter dem
  // Zeiger uebernehmen, statt Koordinaten abzutippen.
  const here = document.createElement('button');
  here.textContent = 'Ziel = Zeigerposition';
  here.disabled = portal.target.map !== doc.id;
  here.addEventListener('click', () => {
    if (!lastGroundPoint) return;
    portal.target.x = round(lastGroundPoint.x);
    portal.target.z = round(lastGroundPoint.z);
    renderPanel();
  });
  box.appendChild(here);

  box.appendChild(numberField('Mindeststufe', portal.minLevel, 1, (v) => {
    portal.minLevel = Math.max(0, Math.round(v));
    touched(false);
  }));

  // --- Warnung -------------------------------------------------------------

  const warning = document.createElement('div');
  warning.className = 'warning';
  warning.hidden = true;
  box.appendChild(warning);
  // Die Prüfung braucht die Tore der Zielkarte, holt sie also gegebenenfalls
  // erst. Bis dahin ist „keine Warnung" nicht dasselbe wie „geprüft und in
  // Ordnung" — deshalb die Marke, an der man beides unterscheiden kann.
  void checkGateTarget(portal).then((problem) => {
    // Das Bedienfeld kann inzwischen neu gezeichnet worden sein.
    if (!warning.isConnected) return;
    warning.hidden = problem === undefined;
    warning.textContent = problem ?? '';
    warning.dataset.checked = '1';
  });

  const remove = document.createElement('button');
  remove.textContent = 'Tor löschen';
  remove.addEventListener('click', () => {
    if (!doc) return;
    doc.portals = doc.portals.filter((g) => g !== portal);
    selectedGateId = doc.portals[0]?.id;
    rebuildGates();
    renderPanel();
  });
  box.appendChild(remove);

  return box;
}

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

  // --- Werkzeug ------------------------------------------------------------

  const toolLabel = document.createElement('h2');
  toolLabel.textContent = 'Werkzeug';
  const tools = document.createElement('div');
  tools.className = 'palette';
  const TOOLS: [Tool, string][] = [
    ['props', 'Props'],
    ['gates', 'Tore'],
    ['zonen', 'Zonen'],
    ['raise', 'Anheben'],
    ['lower', 'Absenken'],
    ['smooth', 'Glätten'],
    ['paint', 'Malen'],
  ];
  for (const [key, caption] of TOOLS) {
    const button = document.createElement('button');
    button.textContent = caption;
    button.setAttribute('aria-pressed', String(key === tool));
    button.addEventListener('click', () => {
      tool = key;
      renderPanel();
    });
    tools.appendChild(button);
  }
  panel.append(toolLabel, tools);

  // --- Pinsel --------------------------------------------------------------

  if (isBrushTool(tool)) {
    const brushLabel = document.createElement('h2');
    brushLabel.textContent = 'Pinsel';
    panel.appendChild(brushLabel);

    panel.appendChild(
      slider('Größe', brush.radius, MIN_BRUSH_RADIUS, MAX_BRUSH_RADIUS, 1, (v) => {
        setBrushRadius(v);
      }, (v) => `${v.toFixed(0)} Einheiten`),
    );
    panel.appendChild(
      slider('Härte', brush.hardness, 0, 1, 0.05, (v) => {
        brush = { ...brush, hardness: v };
      }, (v) => `${Math.round(v * 100)} %`),
    );
    panel.appendChild(
      slider('Stärke', brush.strength, 1, 30, 1, (v) => {
        brush = { ...brush, strength: v };
      }, (v) => v.toFixed(0)),
    );

    const tip = document.createElement('div');
    tip.className = 'stats';
    tip.textContent = 'Strg + Rad ändert die Größe.';
    panel.appendChild(tip);
  }

  // --- Bodenebene ----------------------------------------------------------

  if (tool === 'paint') {
    const layerLabel = document.createElement('h2');
    layerLabel.textContent = 'Bodenebene';
    const layers = document.createElement('div');
    layers.className = 'palette';
    const defs = doc?.terrain.layers ?? [];
    if (defs.length === 0) {
      const none = document.createElement('div');
      none.className = 'stats';
      none.textContent = 'Diese Karte hat keine Bodenebenen.';
      panel.append(layerLabel, none);
    } else {
      for (let i = 0; i < defs.length; i++) {
        const button = document.createElement('button');
        button.textContent = defs[i]!.id;
        button.setAttribute('aria-pressed', String(i === paintLayerIndex));
        button.addEventListener('click', () => {
          paintLayerIndex = i;
          renderPanel();
        });
        layers.appendChild(button);
      }
      panel.append(layerLabel, layers);
    }
  }

  // --- Tore ----------------------------------------------------------------

  if (tool === 'gates') {
    const gateLabel = document.createElement('h2');
    gateLabel.textContent = 'Tor';
    panel.append(gateLabel, renderGatePanel());
  }

  // --- Zonen ---------------------------------------------------------------

  if (tool === 'zonen') {
    const zonenLabel = document.createElement('h2');
    zonenLabel.textContent = 'Sperrzone';
    const arten = document.createElement('div');
    arten.className = 'palette';
    const ARTEN: [ZonenArt, string][] = [
      ['beides', 'Kein Lauf + kein Flug'],
      ['lauf', 'Nur kein Lauf'],
      ['flug', 'Nur kein Flug'],
    ];
    for (const [key, caption] of ARTEN) {
      const button = document.createElement('button');
      button.textContent = caption;
      button.setAttribute('aria-pressed', String(key === zonenArt));
      button.addEventListener('click', () => {
        zonenArt = key;
        renderPanel();
      });
      arten.appendChild(button);
    }
    const hinweis = document.createElement('div');
    hinweis.className = 'stats';
    hinweis.textContent =
      'Linke Maustaste aufsetzen, ziehen, loslassen — das Rechteck ist die Zone. ' +
      'Rechtsklick auf eine Zone löscht sie.';
    panel.append(zonenLabel, arten, hinweis);
  }

  // --- Props ---------------------------------------------------------------

  if (tool === 'props') {
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
  }

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
      ['Zonen', String(doc.zonen.length)],
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
    syncFieldsIntoDocument();
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

type Gesture = 'none' | 'orbit' | 'pan' | 'tool';

/**
 * Was der Zeiger gerade tut — und ob die Geste überhaupt im Bild begonnen hat.
 *
 * Das `startedOnCanvas` ist nicht bloss Sorgfalt, es war der Fehler: `pointerup`
 * hing am Fenster, `pointerdown` an der Zeichenfläche. Jeder Klick auf eine
 * Schaltfläche im Bedienfeld setzte deshalb ein Prop in die Welt — die Geste
 * endete im Fenster, und niemand fragte, wo sie angefangen hatte. Am Fenster
 * muss `pointerup` bleiben, sonst reisst ein Ziehen ab, das ausserhalb des
 * Bildes endet; also merkt sich der Anfang, ob er dazugehört.
 */
let gesture: Gesture = 'none';
let startedOnCanvas = false;
let lastX = 0;
let lastY = 0;
let dragDistance = 0;
/** Ob der Zeiger über dem Bild steht. Steuert die Geländemarkierung. */
let pointerOverCanvas = false;

/** Gedrückte Tasten für das Verschieben mit WASD. */
const keys = new Set<string>();

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

/**
 * Verschiebt den Blickpunkt in der Ebene, kamerarelativ.
 *
 * Der Faktor hängt am Abstand: weit draussen schiebt derselbe Mausweg weiter
 * als dicht am Boden. Ohne das kriecht man in der Übersicht über die Karte.
 */
function pan(rightAmount: number, forwardAmount: number): void {
  const sin = Math.sin(camYaw);
  const cos = Math.cos(camYaw);
  // Blickrichtung in der Ebene ist (sin, cos), rechts davon (-cos, sin).
  camTarget.x += -cos * rightAmount + sin * forwardAmount;
  camTarget.z += sin * rightAmount + cos * forwardAmount;

  const half = doc ? doc.terrain.size * 0.5 : 256;
  camTarget.x = Math.max(-half, Math.min(half, camTarget.x));
  camTarget.z = Math.max(-half, Math.min(half, camTarget.z));
}

canvas.addEventListener('pointerdown', (e) => {
  updatePointer(e);
  startedOnCanvas = true;
  lastX = e.clientX;
  lastY = e.clientY;
  dragDistance = 0;

  if (e.button === 2) gesture = 'orbit';
  else if (e.button === 1 || e.shiftKey) gesture = 'pan';
  else if (e.button === 0) gesture = 'tool';
  else gesture = 'none';

  if (gesture !== 'none') {
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  // Ein Pinsel wirkt beim Ziehen, nicht erst beim Loslassen — sonst müsste man
  // für einen Hügel hundertmal klicken.
  if (gesture === 'tool' && isBrushTool(tool)) {
    strokeActive = true;
    strokeTouched = 0;
    applyBrush(0.05);
  }

  // Eine Zone entsteht aus zwei Ecken. Hier die erste; die zweite steht beim
  // Loslassen fest.
  if (gesture === 'tool' && tool === 'zonen') {
    const punkt = groundPoint();
    zonenZiehStart = punkt ? { x: punkt.x, z: punkt.z } : undefined;
  }
});

canvas.addEventListener('pointerenter', () => {
  pointerOverCanvas = true;
});
canvas.addEventListener('pointerleave', () => {
  pointerOverCanvas = false;
});

window.addEventListener('pointermove', (e) => {
  updatePointer(e);
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  dragDistance += Math.abs(dx) + Math.abs(dy);

  if (gesture === 'orbit') {
    camYaw -= dx * 0.005;
    camPitch = Math.max(0.15, Math.min(1.45, camPitch + dy * 0.005));
  } else if (gesture === 'pan') {
    const speed = camDistance * 0.0016;
    pan(-dx * speed, dy * speed);
  }
});

window.addEventListener('pointerup', (e) => {
  const wasGesture = gesture;
  const fromCanvas = startedOnCanvas;
  gesture = 'none';
  startedOnCanvas = false;

  if (strokeActive) {
    strokeActive = false;
    // Einmal am Ende neu aufbauen. Während des Strichs wäre das je
    // Mausbewegung ein kompletter Netzaufbau.
    if (strokeTouched > 0) {
      settleAfterStroke();
      renderPanel();
    }
    return;
  }

  // Hat die Geste nicht im Bild begonnen, geht sie das Bild auch nichts an.
  if (!fromCanvas) {
    zonenZiehStart = undefined;
    return;
  }

  /*
   * Die Zone ist die Ausnahme von der Regel darunter: bei ihr **ist** das
   * Ziehen die Geste, und ein Klick ohne Weg ergibt nichts. Deshalb steht sie
   * vor der Abfrage auf `dragDistance` — sonst käme genau der Fall nie an, für
   * den das Werkzeug gebaut ist.
   */
  if (wasGesture === 'tool' && e.button === 0 && tool === 'zonen') {
    const start = zonenZiehStart;
    zonenZiehStart = undefined;
    const ende = groundPoint();
    if (start && ende && doc) {
      const hx = Math.abs(ende.x - start.x) * 0.5;
      const hz = Math.abs(ende.z - start.z) * 0.5;
      // Unter zwei Metern Halbkante war es ein Klick und kein Rechteck. Eine
      // Sperre dieser Grösse sieht man nicht und findet man nie wieder.
      if (hx >= 2 && hz >= 2) {
        doc.zonen.push({
          id: `z_${String(nextZoneId++).padStart(4, '0')}`,
          position: [round((start.x + ende.x) * 0.5), round((start.z + ende.z) * 0.5)],
          extent: [round(hx), round(hz)],
          keinLauf: zonenArt !== 'flug',
          keinFlug: zonenArt !== 'lauf',
        });
        rebuildZonen();
        renderPanel();
      }
    }
    return;
  }

  // Ein Klick, der sich kaum bewegt hat, ist ein Klick — kein Ziehen.
  if (dragDistance > 6) return;

  if (wasGesture === 'tool' && e.button === 0) {
    if (tool === 'props') placeProp();
    else if (tool === 'gates') placeOrSelectGate();
  }
  if (wasGesture === 'orbit' && e.button === 2) {
    // Erst Zonen, dann Tore, dann Props — von gross nach klein: wer einen
    // durchscheinenden Quader anvisiert, meint ihn und nicht den Baum darin.
    // Und nur im Zonenwerkzeug, sonst käme man an nichts mehr heran, was unter
    // einer Sperre steht.
    if (tool === 'zonen') {
      if (entferneZoneUnterZeiger()) return;
    }
    if (!removeGateUnderPointer()) removePropUnderPointer();
  }
});

/** Löscht die Zone unter dem Zeiger. Gibt zurück, ob eine getroffen wurde. */
function entferneZoneUnterZeiger(): boolean {
  if (!doc) return false;
  const id = zoneUnterZeiger();
  if (!id) return false;
  doc.zonen = doc.zonen.filter((z) => z.id !== id);
  rebuildZonen();
  renderPanel();
  return true;
}

/** Um wie viel das Rad ein Prop dreht. Mit Umschalt feiner. */
const PROP_ROTATE_STEP = Math.PI / 12;

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();

  // Mit Strg regelt das Rad die Pinselgrösse. Das ist der Griff, den man beim
  // Malen ständig braucht — über einen Schieber im Bedienfeld wäre es ein
  // Weg quer über den Bildschirm für jeden zweiten Strich.
  if (e.ctrlKey && isBrushTool(tool)) {
    setBrushRadius(brush.radius * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    renderPanel();
    return;
  }

  // Beim Prop-Werkzeug dreht das Rad die Vorschau. Zum Zoomen dort Strg
  // dazunehmen — man dreht beim Setzen ständig und zoomt selten.
  if (tool === 'props' && !e.ctrlKey) {
    const step = e.shiftKey ? PROP_ROTATE_STEP / 5 : PROP_ROTATE_STEP;
    pendingPropYaw += Math.sign(e.deltaY) * step;
    return;
  }

  camDistance = Math.max(12, Math.min(400, camDistance + Math.sign(e.deltaY) * camDistance * 0.12));
}, { passive: false });

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

/**
 * Schreibt die Gitterfelder zurück ins Dokument.
 *
 * Leere Felder fliegen raus statt als Nullen mitzureisen: ein unbearbeitetes
 * Höhenfeld sind bei 129 Stützpunkten je Kante 45 KB Base64, die nichts
 * aussagen — und eine Karte ohne Feld ist auch die Karte, die es vorher war.
 */
function syncFieldsIntoDocument(): void {
  if (!doc) return;

  if (sculpt && !sculptFieldIsEmpty(sculpt.values)) {
    doc.terrain.sculpt = encodeSculptField(sculpt.values, sculpt.resolution);
  } else {
    delete doc.terrain.sculpt;
  }

  if (paint && !paintFieldIsEmpty(paint.values)) {
    doc.terrain.paint = encodePaintField(paint.values, paint.resolution);
  } else {
    delete doc.terrain.paint;
  }
}

/**
 * Setzt die Punktewolke unter dem Zeiger neu.
 *
 * Die Höhen kommen in **einem** Aufruf aus dem Kern und nicht Punkt für Punkt:
 * bei Radius achtzig sind das über tausend Stützpunkte, und ein Aufruf je Punkt
 * und Bild wäre genau die Art von Grenzverkehr, die es zu vermeiden gilt.
 */
function updateCursor(point: THREE.Vector3 | undefined): void {
  if (!point || !doc || !world) {
    cursorGeometry.setDrawRange(0, 0);
    propGhost.visible = false;
    return;
  }

  // Beim Prop-Werkzeug tritt die Punktemarkierung ganz zurück: dort steht die
  // Vorschau des Props selbst.
  if (tool === 'props') {
    cursorGeometry.setDrawRange(0, 0);
    propGhost.geometry = propGeometry(selectedModel);
    propGhost.position.set(point.x, world.heightAt(point.x, point.z), point.z);
    propGhost.rotation.set(0, pendingPropYaw, 0);
    propGhost.visible = true;
    return;
  }
  propGhost.visible = false;

  // Tore haben keinen Radius — dort steht ein kleines Feld von Punkten, gerade
  // gross genug, um es zu sehen, und klein genug, um keine Fläche
  // vorzutäuschen, die es nicht gibt.
  const radius = isBrushTool(tool) ? brush.radius : doc.terrain.cellSize * 2.5;

  // Gitterweite: die des Geländes, solange die Punktzahl das zulässt. Bei
  // grossen Pinseln wird sie verdoppelt, bis es passt — lieber ein gröberes
  // Gitter als ein Bild, das an der Punktzahl erstickt.
  let spacing = doc.terrain.cellSize;
  const fits = () => {
    const perSide = Math.floor((radius * 2) / spacing) + 2;
    return perSide * perSide <= CURSOR_MAX_POINTS;
  };
  while (!fits()) spacing *= 2;

  // Auf das feste Weltgitter rasten, damit die Punkte stehenbleiben, während
  // der Zeiger darüberwandert.
  const gx0 = Math.ceil((point.x - radius) / spacing) * spacing;
  const gz0 = Math.ceil((point.z - radius) / spacing) * spacing;
  const countX = Math.floor((point.x + radius - gx0) / spacing) + 1;
  const countZ = Math.floor((point.z + radius - gz0) / spacing) + 1;
  if (countX <= 0 || countZ <= 0) {
    cursorGeometry.setDrawRange(0, 0);
    return;
  }

  const heights = world.sampleHeightGrid(gx0, gz0, spacing, countX, countZ);

  const r2 = radius * radius;
  let n = 0;
  for (let iz = 0; iz < countZ && n < CURSOR_MAX_POINTS; iz++) {
    const z = gz0 + iz * spacing;
    for (let ix = 0; ix < countX && n < CURSOR_MAX_POINTS; ix++) {
      const x = gx0 + ix * spacing;
      const dx = x - point.x;
      const dz = z - point.z;
      if (dx * dx + dz * dz > r2) continue;

      cursorPositions[n * 3] = x;
      // Knapp über dem Boden, sonst streiten Punkt und Gelände um dieselbe
      // Tiefe und es flimmert.
      cursorPositions[n * 3 + 1] = heights[iz * countX + ix]! + 0.08;
      cursorPositions[n * 3 + 2] = z;
      n++;
    }
  }

  cursorGeometry.attributes.position!.needsUpdate = true;
  cursorGeometry.setDrawRange(0, n);
}

function setBrushRadius(value: number): void {
  brush = { ...brush, radius: Math.max(MIN_BRUSH_RADIUS, Math.min(MAX_BRUSH_RADIUS, value)) };
}

/**
 * Wendet den aktiven Pinsel auf den Punkt unter dem Zeiger an.
 *
 * `dt` ist die vergangene Zeit — dadurch hängt die Wirkung an der gehaltenen
 * Dauer und nicht an der Bildrate. Ohne das formt ein schneller Rechner
 * doppelt so tief wie ein langsamer, was beim Formen von Gelände die
 * unangenehmere Sorte von Überraschung wäre.
 */
function applyBrush(dt: number): void {
  if (!doc) return;
  const point = groundPoint();
  if (!point) return;

  const size = doc.terrain.size;
  let touched = 0;
  const radius = brush.radius;

  switch (tool) {
    case 'raise':
      if (sculpt) touched = sculptRaise(sculpt, size, point.x, point.z, brush, brush.strength * dt);
      break;
    case 'lower':
      if (sculpt) touched = sculptRaise(sculpt, size, point.x, point.z, brush, -brush.strength * dt);
      break;
    case 'smooth':
      if (sculpt) touched = sculptSmooth(sculpt, size, point.x, point.z, brush, Math.min(1, dt * 6));
      break;
    case 'paint':
      if (paint) {
        touched = paintLayer(paint, size, point.x, point.z, brush, paintLayerIndex, Math.min(1, dt * 4));
      }
      break;
    default:
      return;
  }

  strokeTouched += touched;
  if (touched === 0) return;

  // Der Kern zuerst: das Netz holt seine Höhen von dort, und der Editor soll
  // denselben Boden zeigen, auf dem das Spiel später jemanden stehen lässt.
  if (sculpt && tool !== 'paint') world?.setSculpt(sculpt.values, sculpt.resolution);

  // Sofort sichtbar machen — und nur den berührten Ausschnitt. Ein kompletter
  // Neuaufbau je Mausbewegung wäre bei sechzehntausend Vertizes zu teuer;
  // hier sind es bei Radius vierzehn rund fünfzig.
  //
  // Vorher wurde erst beim Loslassen gezeichnet: man hielt die Maus, sah
  // nichts, liess los — und erst dann stand der Hügel da. Formen ohne zu sehen,
  // was man formt, ist kein Formen.
  terrain?.refresh({
    minX: point.x - radius,
    maxX: point.x + radius,
    minZ: point.z - radius,
    maxZ: point.z + radius,
  });
}

function placeProp(): void {
  const point = groundPoint();
  if (!point || !doc) return;

  const schwebend = selectedModel.startsWith('fels_schwebend');
  /*
   * Die Kollision kommt aus derselben Tabelle wie im Kartengenerator.
   *
   * Hier stand vorher ein Ausdruck über den Namen des Modells (`/tree|rock|
   * pillar|well/`) und ein fester Radius von 1,2 — ein Baum aus dem Editor
   * stand damit anders im Weg als derselbe Baum aus dem Generator, und der
   * Unterschied fiel erst auf, wenn jemand danebenlief.
   */
  const kollision = standardKollision(selectedModel);

  doc.props.push({
    id: `p_${String(nextPropId++).padStart(4, '0')}`,
    model: selectedModel,
    // Schwebende Felsen bekommen gleich Höhe: am Boden wären sie keine.
    position: [round(point.x), schwebend ? round(point.y + 22) : 0, round(point.z)],
    // Genau die Drehung, die in der Vorschau stand.
    rotation: [0, pendingPropYaw, 0],
    scale: 1,
    /*
     * Ein schwebender Felsen ist keine Säule, um die man herumläuft, sondern
     * eine Fläche, auf der man steht: seine Oberkante liegt in `position[1]`,
     * und der Kern liest genau die. Deshalb setzt er sich auch **nicht** auf
     * das Gelände — sonst läge das Schwebende im Gras.
     */
    snapToGround: !schwebend,
    collision: kollision.form,
    collisionRadius: kollision.radius,
    // Auch die Höhe kommt aus der Tabelle: sonst stünde ein Zaun aus dem
    // Editor bis in den Himmel, während man über den aus dem Generator
    // springen kann.
    collisionHeight: kollision.hoehe,
  });
  // Fuer das naechste eine neue Drehung, damit ein Wald kein Spalier wird.
  rollPropYaw();
  rebuildProps();
  renderPanel();
}

/**
 * Setzt ein Tor — oder wählt das an, das schon dort steht.
 *
 * Der Zielort ist zunächst der Startpunkt der eigenen Karte. Das ist bewusst
 * ein gültiges Ziel und kein leeres Feld: ein Tor, das ins Nichts zeigt, wäre
 * eine Falle, in die man im Spiel hineinläuft und aus der man nicht
 * herauskommt. Wohin es wirklich gehen soll, stellt man daneben ein.
 */
function placeOrSelectGate(): void {
  if (!doc) return;

  const existing = gateUnderPointer();
  if (existing) {
    selectedGateId = existing.id;
    rebuildGates();
    renderPanel();
    return;
  }

  const point = groundPoint();
  if (!point) return;

  const portal: PortalDef = {
    id: `g_${String(nextGateId++).padStart(3, '0')}`,
    position: [round(point.x), round(point.z)],
    // Der Bogen schaut zur Kamera, also dorthin, von wo man ihn gerade sieht.
    // Das trifft öfter als Norden.
    yaw: round(camYaw + Math.PI),
    radius: 4,
    label: 'Neues Tor',
    target: { map: doc.id, x: doc.spawn.x, z: doc.spawn.z, yaw: 0 },
    minLevel: 0,
  };
  doc.portals.push(portal);
  selectedGateId = portal.id;

  rebuildGates();
  renderPanel();
}

function removeGateUnderPointer(): boolean {
  if (!doc) return false;
  const victim = gateUnderPointer();
  if (!victim) return false;

  doc.portals = doc.portals.filter((g) => g !== victim);
  if (selectedGateId === victim.id) selectedGateId = doc.portals[0]?.id;
  rebuildGates();
  renderPanel();
  return true;
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

/**
 * Ein Fenster auf den Zustand — nur lesend, für Tests und zum Nachsehen.
 *
 * Dasselbe Prinzip wie `window.aurelith` im Client: was der Editor tut, muss
 * von aussen prüfbar sein, ohne dass ein Test in seine Interna greift.
 */
declare global {
  interface Window {
    aurelithEditor?: {
      camTarget: { x: number; y: number; z: number };
      camYaw: number;
      camPitch: number;
      camDistance: number;
      mapId: string;
      props: number;
      portals: number;
      /** Höhe des höchsten geformten Punktes, in Metern. */
      sculptPeak: number;
      sculptResolution: number;
      /** Was der Kern tatsächlich hat — nicht, was wir ihm geben wollten. */
      coreSculptResolution: number;
      paintPeak: number;
      paintResolution: number;
      heightUnderPointer: number | null;
      /** Punkte der Zeigermarkierung und ihre Hoehenspanne. */
      cursorPoints: number;
      cursorHeightSpread: number;
      /**
       * Hoechster Punkt des **gezeichneten Netzes** unter dem Zeiger.
       *
       * Bewusst aus der Geometrie und nicht aus dem Hoehenfeld: nur so zeigt
       * sich, ob das Bild dem Pinsel wirklich folgt. Das Feld kann laengst
       * einen Huegel enthalten, waehrend das Netz noch flach ist.
       */
      meshPeakNearPointer: (radius?: number) => number;
      selectedGate: string;
      /** Gezeichnete Bilder. Woran man erkennt, ob diese Auskunft frisch ist. */
      frames: number;
      /** Text der Warnung zum Zielpunkt, leer wenn alles passt. */
      gateWarning: string;
      /** Ob die Zielprüfung überhaupt schon durchgelaufen ist. */
      gateWarningChecked: boolean;
      /**
       * Speichern und wieder laden, ohne Datei.
       *
       * Der Kreis, auf den es beim Editor ankommt: was er schreibt, muss der
       * Parser lesen, den auch Server und Client benutzen. Ein Feld, das nur
       * im Editor existiert, wäre schlimmer als keines.
       */
      roundTrip: () => {
        ok: boolean;
        note: string;
        sculptSurvives: boolean;
        peakAfter: number;
        portalsAfter: number;
        targetAfter: string;
      };
    };
  }
}

/** Grösster Betrag im Höhenfeld, in Metern. */
function sculptPeak(field: SculptField | undefined): number {
  if (!field) return 0;
  let peak = 0;
  for (let i = 0; i < field.values.length; i++) {
    const v = Math.abs(field.values[i]!);
    if (v > peak) peak = v;
  }
  return peak / SCULPT_UNIT;
}

function paintPeak(field: PaintField | undefined): number {
  if (!field) return 0;
  let peak = 0;
  for (let i = 0; i < field.values.length; i++) {
    if (field.values[i]! > peak) peak = field.values[i]!;
  }
  return peak;
}

function roundTrip(): {
  ok: boolean;
  note: string;
  sculptSurvives: boolean;
  peakAfter: number;
  portalsAfter: number;
  targetAfter: string;
} {
  const failed = (note: string) => ({
    ok: false,
    note,
    sculptSurvives: false,
    peakAfter: 0,
    portalsAfter: 0,
    targetAfter: '',
  });
  if (!doc) return failed('keine Karte geladen');
  syncFieldsIntoDocument();
  try {
    const text = serializeMapDocument(doc);
    const again = parseMapDocument(JSON.parse(text), doc.id);
    const values = decodeSculptField(again.terrain.sculpt);
    const peakAfter = values
      ? sculptPeak({ values, resolution: again.terrain.sculpt?.resolution ?? 0 })
      : 0;
    const selected = again.portals.find((g) => g.id === selectedGateId);
    return {
      ok: true,
      note: `${(text.length / 1024).toFixed(0)} KB`,
      sculptSurvives: peakAfter > 0.3,
      peakAfter,
      portalsAfter: again.portals.length,
      targetAfter: selected?.target.map ?? '',
    };
  } catch (err) {
    return failed(String(err));
  }
}

/** Höchster Punkt des gezeichneten Geländes im Umkreis des Zeigers. */
function meshPeakNearPointer(radius = brush.radius): number {
  if (!terrain || !lastGroundPoint) return 0;

  const mesh = terrain.object.getObjectByName('terrain') as THREE.Mesh | undefined;
  const attr = mesh?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!attr) return 0;

  const r2 = radius * radius;
  let peak = -Infinity;
  for (let i = 0; i < attr.count; i++) {
    const dx = attr.getX(i) - lastGroundPoint.x;
    const dz = attr.getZ(i) - lastGroundPoint.z;
    if (dx * dx + dz * dz > r2) continue;
    const y = attr.getY(i);
    if (y > peak) peak = y;
  }
  return peak === -Infinity ? 0 : peak;
}

function publishDiagnostics(): void {
  window.aurelithEditor = {
    camTarget: { x: camTarget.x, y: camTarget.y, z: camTarget.z },
    camYaw,
    camPitch,
    camDistance,
    mapId: doc?.id ?? '',
    props: doc?.props.length ?? 0,
    portals: doc?.portals.length ?? 0,
    sculptPeak: sculptPeak(sculpt),
    sculptResolution: sculpt?.resolution ?? 0,
    coreSculptResolution: world?.sculptResolution ?? 0,
    paintPeak: paintPeak(paint),
    paintResolution: paint?.resolution ?? 0,
    heightUnderPointer: lastGroundPoint ? lastGroundPoint.y : null,
    cursorPoints: cursorGeometry.drawRange.count,
    meshPeakNearPointer,
    cursorHeightSpread: (() => {
      const n = cursorGeometry.drawRange.count;
      if (n < 2) return 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < n; i++) {
        const y = cursorPositions[i * 3 + 1]!;
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
      return hi - lo;
    })(),
    selectedGate: selectedGateId ?? '',
    frames,
    gateWarning: (() => {
      const el = panel.querySelector('.warning');
      return el && !(el as HTMLElement).hidden ? (el.textContent ?? '') : '';
    })(),
    gateWarningChecked: panel.querySelector('.warning[data-checked]') !== null,
    roundTrip,
  };
}

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

let lastFrameAt = performance.now();
let frames = 0;

function frame(now = performance.now()): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrameAt) / 1000);
  lastFrameAt = now;

  // Verschieben mit WASD. Die Geschwindigkeit hängt am Abstand, damit sich das
  // Tempo in der Übersicht und dicht am Boden gleich anfühlt.
  const step = camDistance * 1.2 * dt;
  let right = 0;
  let forward = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) forward += step;
  if (keys.has('KeyS') || keys.has('ArrowDown')) forward -= step;
  if (keys.has('KeyD') || keys.has('ArrowRight')) right += step;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) right -= step;
  if (right !== 0 || forward !== 0) pan(right, forward);

  const cosP = Math.cos(camPitch);
  camera.position.set(
    camTarget.x - Math.sin(camYaw) * cosP * camDistance,
    camTarget.y + Math.sin(camPitch) * camDistance,
    camTarget.z - Math.cos(camYaw) * cosP * camDistance,
  );
  camera.lookAt(camTarget);

  // Einen laufenden Strich fortsetzen. Hier und nicht im Mausereignis, weil
  // der Pinsel auch dann weiterwirken soll, wenn der Zeiger stillsteht.
  if (strokeActive) applyBrush(dt);

  // Die Markierung nur zeigen, wenn der Zeiger auch im Bild steht — sonst
  // klebt sie am Gelaende, waehrend man im Bedienfeld arbeitet.
  const point = pointerOverCanvas || gesture !== 'none' ? groundPoint() : undefined;
  lastGroundPoint = point;
  updateCursor(point);

  renderer.render(scene, camera);
  frames++;
  publishDiagnostics();
}

await loadMap(MAPS[0]!);
frame();
