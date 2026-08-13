/**
 * Map-Dokument — das Austauschformat zwischen Client, Server und Editor.
 *
 * Maps sind bewusst Daten und kein Code. Der Editor, der später Props setzt,
 * Spawner zieht und Gates verbindet, schreibt genau dieses Dokument; der Server
 * liest es von der Platte, der Client bekommt es über den Asset-Streamer vom
 * CDN. Es gibt nur eine Wahrheit, und niemand muss für eine neue Map neu bauen.
 *
 * Erweiterungen sind additiv: neue optionale Felder erhöhen `version` nicht,
 * eine Änderung an bestehenden Feldern schon. `parseMapDocument` ist die
 * einzige Stelle, an der ein Dokument die Systemgrenze passiert.
 */

import type { TerrainField } from './terrainFields.ts';

export const MAP_FORMAT = 'aurelith.map';
export const MAP_FORMAT_VERSION = 1;

export type Vec3Tuple = [number, number, number];
export type Vec2Tuple = [number, number];

export interface EnvironmentDef {
  /** Himmelsfarbe als 0xRRGGBB. */
  skyColor: number;
  horizonColor: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
  /** Richtung zur Sonne, wird beim Laden normalisiert. */
  sunDirection: Vec3Tuple;
  sunColor: number;
  sunIntensity: number;
  ambientColor: number;
  ambientIntensity: number;
  /**
   * Läuft auf dieser Karte ein Tag-und-Nacht-Wechsel?
   *
   * Standardmäßig ja. Wer es abschaltet, bekommt die Werte oben unverändert —
   * gedacht für alles unter Tage, wo eine wandernde Sonne durch den Fels
   * scheinen würde.
   */
  daylight?: boolean;
  /** Optionale Hintergrundmusik, Pfad im Asset-Manifest. */
  music?: string;
  ambientSound?: string;
}

/**
 * Eine Bodenebene.
 *
 * Der Boden entsteht aus mehreren solchen Ebenen, die nach Neigung und Höhe
 * gemischt werden — dieselbe Logik, die heute schon die Vertexfarben erzeugt,
 * nur mit Texturen statt Farben. Wo keine Ebene greift, bleibt die
 * prozedurale Farbe stehen; eine Karte ohne Ebenen sieht deshalb aus wie
 * bisher.
 *
 * Höchstens vier Ebenen je Karte: mehr passt nicht in die Splat-Gewichte,
 * die als ein vec4 je Vertex mitlaufen, und mehr Texturabfragen je Pixel will
 * man auf dem Telefon ohnehin nicht.
 */
export interface GroundLayerDef {
  id: string;
  /** Pfad der Farbtextur im Manifest. Leer = die Ebene trägt nur ihre Tönung. */
  texture: string;
  /** Pfad der Normalenkarte. Leer = flach. */
  normal: string;
  /** Weltnenheiten je Texturkachel. Größer = gröber. */
  tileSize: number;
  /** Neigungsbereich in Grad, in dem die Ebene gilt. */
  slope: Vec2Tuple;
  /** Höhenbereich in Weltnenheiten. */
  height: Vec2Tuple;
  /**
   * Weiche Kante der Neigungsgrenze, in Grad.
   *
   * Absolut und nicht als Anteil des Bereichs: ein Bereich wie
   * `height: [-2, 10000]` ist nach oben offen, und ein Drittel davon wäre ein
   * Übergang über die halbe Welt.
   */
  slopeBlend: number;
  /** Weiche Kante der Höhengrenze, in Weltnenheiten. */
  heightBlend: number;
  /** Gewicht, bevor über alle Ebenen normalisiert wird. */
  strength: number;
  /** Tönung, auf die Textur multipliziert — oder die Farbe, wenn keine da ist. */
  tint: number;
  /** Rauheit. Wird beim Aufbereiten gemessen, siehe tools/prepare-textures.mjs. */
  roughness: number;
  /** Stärke der Normalenkarte. */
  normalScale: number;
}

/** Mehr Ebenen passen nicht in die Splat-Gewichte eines Vertex. */
export const MAX_GROUND_LAYERS = 4;

export interface TerrainDef {
  /** Kantenlänge der Map in Weltnenheiten. */
  size: number;
  /** Abstand zweier Höhenstützpunkte. Kleiner = feineres Netz, teurer. */
  cellSize: number;
  /** Seed des prozeduralen Höhenfelds. Muss auf beiden Seiten gleich sein. */
  seed: number;
  /** Maximale Auslenkung des Höhenfelds. */
  heightScale: number;
  /** Grundfrequenz des Rauschens. Größer = kleinteiliger. */
  featureScale: number;
  waterLevel: number;
  grassColor: number;
  grassColorAlt: number;
  rockColor: number;
  sandColor: number;
  /**
   * Später: Pfad zu einer gelieferten Höhenkarte im Manifest. Solange leer,
   * wird das Feld prozedural aus `seed` erzeugt — Client und Server kommen
   * dabei zwingend auf dieselben Werte.
   */
  heightmap?: string;
  /** Bodenebenen, nach Neigung und Höhe gemischt. Leer = nur Farben. */
  layers: GroundLayerDef[];

  /**
   * Von Hand geformte Höhen, als Differenz auf das prozedurale Relief.
   *
   * Der Kern rechnet sie mit — dieselbe Binärdatei im Client wie auf dem
   * Server, also steht die Figur auf beiden Seiten auf demselben Boden. Fehlt
   * das Feld, bleibt es beim reinen Rauschen.
   */
  sculpt?: TerrainField;

  /**
   * Von Hand gemalte Bodenebenen.
   *
   * Übersteuert dort, wo gemalt wurde, die Mischung aus Neigung und Höhe.
   * Rein visuell: welche Textur wo liegt, geht die Simulation nichts an, und
   * deshalb kennt der Kern dieses Feld auch nicht.
   */
  paint?: TerrainField;
}

export type PropCollisionShape = 'none' | 'circle';

export interface PropInstance {
  /** Stabil über Editor-Sitzungen hinweg. */
  id: string;
  /** Schlüssel in der ModelRegistry, z. B. "tree_pine" oder "rock_small". */
  model: string;
  position: Vec3Tuple;
  /** Rotation in Bogenmaß, Reihenfolge XYZ. */
  rotation: Vec3Tuple;
  scale: number;
  /** Wenn wahr, wird `position[1]` beim Laden auf die Terrainhöhe gezogen. */
  snapToGround: boolean;
  collision: PropCollisionShape;
  collisionRadius: number;
  /** Optionale Farbanpassung, 0xRRGGBB. Erlaubt Varianz ohne neue Modelle. */
  tint?: number;
}

export interface SpawnerDef {
  id: string;
  /** Schlüssel in der Monster-Datenbank. */
  mob: string;
  position: Vec2Tuple;
  radius: number;
  count: number;
  respawnMs: number;
  /** Überschreibt das Level aus der Monster-Definition, wenn gesetzt. */
  level?: number;
}

export interface NpcInstance {
  id: string;
  /** Schlüssel in der NPC-Datenbank. */
  def: string;
  /** Überschreibt den Namen aus der Definition. */
  name?: string;
  position: Vec2Tuple;
  yaw: number;
}

/**
 * Ein Tor.
 *
 * Es gibt genau eine Sorte. Was ein Tor unterscheidet, ist sein Ziel — nicht
 * seine Bauart. Früher standen hier drei Sorten ('gate', 'dungeon', 'return'),
 * die sich in nichts unterschieden ausser der Farbe des Bogens, und der Bogen
 * selbst lag als eigenes Prop daneben: zwei Objekte, die zusammengehörten,
 * aber getrennt verschoben werden konnten. Beides ist weg.
 */

export interface PortalDef {
  id: string;
  position: Vec2Tuple;
  /** Ausrichtung des Bogens in Bogenmaß. Der Durchgang zeigt entlang +Z. */
  yaw: number;
  /** Auslöseradius. Der Bogen wird immer gleich gross gezeichnet. */
  radius: number;
  label: string;
  /** Wohin es geht. Der einzige Parameter, der ein Tor von einem anderen
   *  unterscheidet. */
  target: {
    map: string;
    x: number;
    z: number;
    yaw: number;
  };
  minLevel: number;
}

export interface MapDocument {
  format: typeof MAP_FORMAT;
  version: number;
  id: string;
  name: string;
  environment: EnvironmentDef;
  terrain: TerrainDef;
  spawn: { x: number; z: number; yaw: number };
  props: PropInstance[];
  spawners: SpawnerDef[];
  npcs: NpcInstance[];
  portals: PortalDef[];
}

export class MapFormatError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} (bei ${path})`);
    this.name = 'MapFormatError';
  }
}

function req(obj: unknown, key: string, path: string): unknown {
  if (typeof obj !== 'object' || obj === null) {
    throw new MapFormatError('Objekt erwartet', path);
  }
  const v = (obj as Record<string, unknown>)[key];
  if (v === undefined) throw new MapFormatError(`Feld "${key}" fehlt`, path);
  return v;
}

function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new MapFormatError('endliche Zahl erwartet', path);
  }
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string') throw new MapFormatError('Zeichenkette erwartet', path);
  return v;
}

function vec3(v: unknown, path: string): Vec3Tuple {
  if (!Array.isArray(v) || v.length !== 3) throw new MapFormatError('[x, y, z] erwartet', path);
  return [num(v[0], `${path}[0]`), num(v[1], `${path}[1]`), num(v[2], `${path}[2]`)];
}

function vec2(v: unknown, path: string): Vec2Tuple {
  if (!Array.isArray(v) || v.length !== 2) throw new MapFormatError('[x, z] erwartet', path);
  return [num(v[0], `${path}[0]`), num(v[1], `${path}[1]`)];
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new MapFormatError('Liste erwartet', path);
  return v;
}

function optNum(obj: Record<string, unknown>, key: string, fallback: number, path: string): number {
  return obj[key] === undefined ? fallback : num(obj[key], `${path}.${key}`);
}

function optBool(obj: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof obj[key] === 'boolean' ? (obj[key] as boolean) : fallback;
}

/**
 * Validiert und normalisiert ein rohes Map-Dokument. Fehlende optionale Felder
 * bekommen ihren Standardwert, damit der Rest des Codes nie prüfen muss.
 */
export function parseMapDocument(raw: unknown, source = 'map'): MapDocument {
  const root = raw as Record<string, unknown>;
  const format = str(req(root, 'format', source), `${source}.format`);
  if (format !== MAP_FORMAT) {
    throw new MapFormatError(`Format "${format}", erwartet "${MAP_FORMAT}"`, source);
  }
  const version = num(req(root, 'version', source), `${source}.version`);
  if (version > MAP_FORMAT_VERSION) {
    throw new MapFormatError(
      `Map-Version ${version} ist neuer als unterstützt (${MAP_FORMAT_VERSION})`,
      source,
    );
  }

  const id = str(req(root, 'id', source), `${source}.id`);
  const name = str(req(root, 'name', source), `${source}.name`);

  const envRaw = req(root, 'environment', source) as Record<string, unknown>;
  const envPath = `${source}.environment`;
  const environment: EnvironmentDef = {
    skyColor: optNum(envRaw, 'skyColor', 0x87b6e8, envPath),
    horizonColor: optNum(envRaw, 'horizonColor', 0xcfe3f7, envPath),
    fogColor: optNum(envRaw, 'fogColor', 0xbcd4ea, envPath),
    fogNear: optNum(envRaw, 'fogNear', 90, envPath),
    fogFar: optNum(envRaw, 'fogFar', 320, envPath),
    sunDirection: envRaw.sunDirection
      ? vec3(envRaw.sunDirection, `${envPath}.sunDirection`)
      : [0.45, 0.8, 0.35],
    sunColor: optNum(envRaw, 'sunColor', 0xfff2d8, envPath),
    sunIntensity: optNum(envRaw, 'sunIntensity', 1.5, envPath),
    ambientColor: optNum(envRaw, 'ambientColor', 0x9fb8d4, envPath),
    ambientIntensity: optNum(envRaw, 'ambientIntensity', 0.85, envPath),
    daylight: optBool(envRaw, 'daylight', true),
  };
  if (typeof envRaw.music === 'string') environment.music = envRaw.music;
  if (typeof envRaw.ambientSound === 'string') environment.ambientSound = envRaw.ambientSound;

  const terRaw = req(root, 'terrain', source) as Record<string, unknown>;
  const terPath = `${source}.terrain`;
  const terrain: TerrainDef = {
    size: optNum(terRaw, 'size', 512, terPath),
    cellSize: optNum(terRaw, 'cellSize', 4, terPath),
    seed: optNum(terRaw, 'seed', 1, terPath),
    heightScale: optNum(terRaw, 'heightScale', 14, terPath),
    featureScale: optNum(terRaw, 'featureScale', 0.012, terPath),
    waterLevel: optNum(terRaw, 'waterLevel', -2, terPath),
    grassColor: optNum(terRaw, 'grassColor', 0x5f9a4a, terPath),
    grassColorAlt: optNum(terRaw, 'grassColorAlt', 0x4a7f3c, terPath),
    rockColor: optNum(terRaw, 'rockColor', 0x7d7a70, terPath),
    sandColor: optNum(terRaw, 'sandColor', 0xc9b98a, terPath),
    layers: [],
  };
  if (typeof terRaw.heightmap === 'string') terrain.heightmap = terRaw.heightmap;

  // Die Gitterfelder werden hier nicht dekodiert, nur durchgereicht: wer sie
  // braucht, ruft `decodeSculptField` bzw. `decodePaintField`. Der Server liest
  // nur das erste, der Renderer nur das zweite — beide sollen nicht das jeweils
  // andere entpacken muessen.
  const field = (value: unknown, path: string): TerrainField | undefined => {
    if (typeof value !== 'object' || value === null) return undefined;
    const o = value as Record<string, unknown>;
    const resolution = optNum(o, 'resolution', 0, path);
    if (resolution < 2 || typeof o.data !== 'string') return undefined;
    return { resolution, data: o.data };
  };
  const sculpt = field(terRaw.sculpt, `${terPath}.sculpt`);
  if (sculpt) terrain.sculpt = sculpt;
  const paint = field(terRaw.paint, `${terPath}.paint`);
  if (paint) terrain.paint = paint;

  const layerList = arr(terRaw.layers ?? [], `${terPath}.layers`);
  if (layerList.length > MAX_GROUND_LAYERS) {
    throw new MapFormatError(
      `${layerList.length} Bodenebenen, höchstens ${MAX_GROUND_LAYERS} möglich`,
      `${terPath}.layers`,
    );
  }
  terrain.layers = layerList.map((l, i) => {
    const path = `${terPath}.layers[${i}]`;
    const o = l as Record<string, unknown>;
    return {
      id: str(req(o, 'id', path), `${path}.id`),
      texture: typeof o.texture === 'string' ? o.texture : '',
      normal: typeof o.normal === 'string' ? o.normal : '',
      tileSize: optNum(o, 'tileSize', 8, path),
      slope: o.slope ? vec2(o.slope, `${path}.slope`) : [0, 90],
      height: o.height ? vec2(o.height, `${path}.height`) : [-10000, 10000],
      slopeBlend: optNum(o, 'slopeBlend', 6, path),
      heightBlend: optNum(o, 'heightBlend', 3, path),
      strength: optNum(o, 'strength', 1, path),
      tint: optNum(o, 'tint', 0xffffff, path),
      roughness: optNum(o, 'roughness', 0.9, path),
      normalScale: optNum(o, 'normalScale', 1, path),
    };
  });

  const spawnRaw = req(root, 'spawn', source) as Record<string, unknown>;
  const spawn = {
    x: num(req(spawnRaw, 'x', `${source}.spawn`), `${source}.spawn.x`),
    z: num(req(spawnRaw, 'z', `${source}.spawn`), `${source}.spawn.z`),
    yaw: optNum(spawnRaw, 'yaw', 0, `${source}.spawn`),
  };

  const props: PropInstance[] = arr(root.props ?? [], `${source}.props`).map((p, i) => {
    const path = `${source}.props[${i}]`;
    const o = p as Record<string, unknown>;
    return {
      id: str(req(o, 'id', path), `${path}.id`),
      model: str(req(o, 'model', path), `${path}.model`),
      position: vec3(req(o, 'position', path), `${path}.position`),
      rotation: o.rotation ? vec3(o.rotation, `${path}.rotation`) : [0, 0, 0],
      scale: optNum(o, 'scale', 1, path),
      snapToGround: optBool(o, 'snapToGround', true),
      collision: (o.collision === 'circle' ? 'circle' : 'none') as PropCollisionShape,
      collisionRadius: optNum(o, 'collisionRadius', 1, path),
      ...(typeof o.tint === 'number' ? { tint: o.tint } : {}),
    };
  });

  const spawners: SpawnerDef[] = arr(root.spawners ?? [], `${source}.spawners`).map((s, i) => {
    const path = `${source}.spawners[${i}]`;
    const o = s as Record<string, unknown>;
    return {
      id: str(req(o, 'id', path), `${path}.id`),
      mob: str(req(o, 'mob', path), `${path}.mob`),
      position: vec2(req(o, 'position', path), `${path}.position`),
      radius: optNum(o, 'radius', 20, path),
      count: optNum(o, 'count', 4, path),
      // Wie im Kern: eine gute Minute, wenn die Karte nichts sagt.
      respawnMs: optNum(o, 'respawnMs', 75000, path),
      ...(o.level === undefined ? {} : { level: num(o.level, `${path}.level`) }),
    };
  });

  const npcs: NpcInstance[] = arr(root.npcs ?? [], `${source}.npcs`).map((n, i) => {
    const path = `${source}.npcs[${i}]`;
    const o = n as Record<string, unknown>;
    return {
      id: str(req(o, 'id', path), `${path}.id`),
      def: str(req(o, 'def', path), `${path}.def`),
      ...(typeof o.name === 'string' ? { name: o.name } : {}),
      position: vec2(req(o, 'position', path), `${path}.position`),
      yaw: optNum(o, 'yaw', 0, path),
    };
  });

  const portals: PortalDef[] = arr(root.portals ?? [], `${source}.portals`).map((p, i) => {
    const path = `${source}.portals[${i}]`;
    const o = p as Record<string, unknown>;
    const t = req(o, 'target', path) as Record<string, unknown>;
    return {
      id: str(req(o, 'id', path), `${path}.id`),
      position: vec2(req(o, 'position', path), `${path}.position`),
      yaw: optNum(o, 'yaw', 0, path),
      radius: optNum(o, 'radius', 3, path),
      label: typeof o.label === 'string' ? o.label : '',
      target: {
        map: str(req(t, 'map', `${path}.target`), `${path}.target.map`),
        x: num(req(t, 'x', `${path}.target`), `${path}.target.x`),
        z: num(req(t, 'z', `${path}.target`), `${path}.target.z`),
        yaw: optNum(t, 'yaw', 0, `${path}.target`),
      },
      minLevel: optNum(o, 'minLevel', 0, path),
    };
  });

  return {
    format: MAP_FORMAT,
    version,
    id,
    name,
    environment,
    terrain,
    spawn,
    props,
    spawners,
    npcs,
    portals,
  };
}

/** Gegenstück zum Parser — der Editor schreibt Maps hierüber zurück. */
export function serializeMapDocument(doc: MapDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Leere, gültige Map. Startpunkt für „Neue Map" im Editor. */
export function createEmptyMap(id: string, name: string): MapDocument {
  return {
    format: MAP_FORMAT,
    version: MAP_FORMAT_VERSION,
    id,
    name,
    environment: {
      skyColor: 0x87b6e8,
      horizonColor: 0xcfe3f7,
      fogColor: 0xbcd4ea,
      fogNear: 90,
      fogFar: 320,
      sunDirection: [0.45, 0.8, 0.35],
      sunColor: 0xfff2d8,
      sunIntensity: 1.5,
      ambientColor: 0x9fb8d4,
      ambientIntensity: 0.85,
      daylight: true,
    },
    terrain: {
      size: 512,
      cellSize: 4,
      seed: 1,
      heightScale: 14,
      featureScale: 0.012,
      waterLevel: -2,
      grassColor: 0x5f9a4a,
      grassColorAlt: 0x4a7f3c,
      rockColor: 0x7d7a70,
      sandColor: 0xc9b98a,
      layers: [],
    },
    spawn: { x: 0, z: 0, yaw: 0 },
    props: [],
    spawners: [],
    npcs: [],
    portals: [],
  };
}
