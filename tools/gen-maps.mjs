#!/usr/bin/env node
/**
 * Erzeugt die Start-Maps als aurelith.map-Dokumente.
 *
 * Das ist ausdrücklich ein Platzhalter für den Editor: sobald der steht, wird
 * hier nichts mehr generiert, sondern von Hand gesetzt. Bis dahin braucht das
 * Spiel Inhalte, und ein deterministischer Generator ist besser als eine
 * dreitausend Zeilen lange JSON-Datei im Diff.
 *
 *   node tools/gen-maps.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'assets', 'maps');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Streut Props über die Fläche und hält Sperrzonen frei — Spawnpunkte, NPCs
 * und Gates sollen begehbar bleiben.
 */
function scatter(rng, { count, size, models, keepOut, minGap, scaleRange, tints }) {
  const placed = [];
  const margin = size * 0.46;
  let attempts = 0;

  while (placed.length < count && attempts < count * 60) {
    attempts++;
    const x = (rng() * 2 - 1) * margin;
    const z = (rng() * 2 - 1) * margin;

    let blocked = false;
    for (const k of keepOut) {
      if (Math.hypot(x - k.x, z - k.z) < k.r) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    for (const p of placed) {
      if (Math.hypot(x - p.position[0], z - p.position[2]) < minGap) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    const model = models[Math.floor(rng() * models.length)];
    const scale = scaleRange[0] + rng() * (scaleRange[1] - scaleRange[0]);
    const prop = {
      id: `p_${String(placed.length + 1).padStart(4, '0')}`,
      model: model.key,
      position: [round(x), 0, round(z)],
      rotation: [0, round(rng() * Math.PI * 2), 0],
      scale: round(scale),
      snapToGround: true,
      collision: model.collision ?? 'none',
      collisionRadius: model.collisionRadius ?? 1,
    };
    if (tints && tints.length > 0) {
      prop.tint = tints[Math.floor(rng() * tints.length)];
    }
    placed.push(prop);
  }

  return placed;
}

const round = (v) => Math.round(v * 100) / 100;

// --------------------------------------------------------------------------
// Gesetzte Props: Zäune, Laternen, Lager.
//
// Der Streuer oben wirft Bäume und Büsche über die Fläche — das macht Natur.
// Alles, was nach Bewohnern aussehen soll, muss dagegen in Linien und Gruppen
// stehen: ein gestreuter Zaun ist kein Zaun, sondern Bauholz im Wald.
// --------------------------------------------------------------------------

/**
 * Reiht Zaunfelder auf einer Strecke auf.
 *
 * Ein Feld ist zwei Einheiten breit und hat seine Pfosten an den Enden, deshalb
 * ergibt eine lückenlose Kette eine durchgehende Linie. Die Strecke wird auf
 * ganze Felder gerundet — lieber ein Feld zu wenig als eines, das über die Ecke
 * hinausragt.
 *
 * Die Drehung: eine Drehung um Y bildet die lokale +X-Achse auf
 * `(cos θ, −sin θ)` ab, das Feld liegt entlang +X. Für die Richtung `(dx, dz)`
 * ist also `θ = atan2(−dz, dx)` — das Minus ist kein Tippfehler.
 */
function fenceRun(model, from, to, { scale = 1, collisionRadius = 0.85 } = {}) {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  const laenge = Math.hypot(dx, dz);
  const feld = 2 * scale;
  const felder = Math.max(1, Math.round(laenge / feld));
  const yaw = round(Math.atan2(-dz, dx));

  const out = [];
  for (let i = 0; i < felder; i++) {
    const t = (i + 0.5) / felder;
    out.push({
      model,
      position: [round(from[0] + dx * t), 0, round(from[1] + dz * t)],
      rotation: [0, yaw, 0],
      scale,
      snapToGround: true,
      collision: 'circle',
      collisionRadius,
    });
  }
  return out;
}

/** Ein geschlossenes Gehege. Vier Läufe, an den Ecken gestoßen. */
function fenceRect(model, cx, cz, halfX, halfZ, opts = {}) {
  return [
    ...fenceRun(model, [cx - halfX, cz - halfZ], [cx + halfX, cz - halfZ], opts),
    ...fenceRun(model, [cx + halfX, cz - halfZ], [cx + halfX, cz + halfZ], opts),
    ...fenceRun(model, [cx + halfX, cz + halfZ], [cx - halfX, cz + halfZ], opts),
    ...fenceRun(model, [cx - halfX, cz + halfZ], [cx - halfX, cz - halfZ], opts),
  ];
}

/** Ein einzelnes gesetztes Prop. */
function place(model, x, z, { yaw = 0, scale = 1, collision = 'none', collisionRadius = 0.6 } = {}) {
  return {
    model,
    position: [round(x), 0, round(z)],
    rotation: [0, round(yaw), 0],
    scale,
    snapToGround: true,
    collision,
    collisionRadius,
  };
}

/**
 * Laternen entlang eines Weges, abwechselnd links und rechts.
 *
 * Versetzt statt paarweise: zwei Laternen nebeneinander leuchten dieselbe
 * Stelle an, versetzte decken den Weg mit der halben Zahl ab. Und weil die
 * Zahl gleichzeitiger Lichter fest ist, ist jede gesparte Laterne eine, die
 * anderswo leuchten kann.
 */
function lanternRoad(from, to, { abstand = 30, seite = 6, scale = 1 } = {}) {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  const laenge = Math.hypot(dx, dz);
  const n = Math.max(1, Math.round(laenge / abstand));
  // Senkrecht zur Wegrichtung.
  const nx = -dz / laenge;
  const nz = dx / laenge;

  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const s = i % 2 === 0 ? seite : -seite;
    out.push(
      place('lantern_post', from[0] + dx * t + nx * s, from[1] + dz * t + nz * s, {
        scale,
        collision: 'circle',
        collisionRadius: 0.4,
      }),
    );
  }
  return out;
}

/** Sperrzonen aus gesetzten Props, damit der Streuer keine Bäume hineinstellt. */
function keepOutOf(props, r) {
  return props.map((p) => ({ x: p.position[0], z: p.position[2], r }));
}

/**
 * Bodenebenen.
 *
 * Gras auf flachem Grund oberhalb des Wassers, Erde an den Haengen, Sand am
 * Ufer. Die Bereiche ueberlappen bewusst — daraus entsteht der Uebergang.
 * Was keine Ebene deckt, bleibt die prozedurale Farbe des Gelaendes; sehr
 * steile Klippen sind deshalb weiterhin Fels als Farbflaeche, weil dafuer
 * noch keine Textur geliefert ist.
 *
 * Die Rauheitswerte sind gemessen, siehe tools/prepare-textures.mjs.
 */
function groundLayers(waterLevel, { grassTint = 0xffffff, dirtTint = 0xffffff, sandTint = 0xffffff } = {}) {
  return [
    {
      id: 'gras',
      texture: 'textures/ground_grass/albedo.webp',
      normal: 'textures/ground_grass/normal.webp',
      // Groessere Kachel heisst weniger Wiederholungen im Bild und damit mehr
      // sichtbare Struktur: bei sechs Einheiten mittelt das Mipmapping die
      // Textur auf ihren Durchschnitt weg, und der ist ein flaches Oliv.
      tileSize: 11,
      slope: [0, 30],
      height: [waterLevel + 0.5, 10000],
      slopeBlend: 8,
      heightBlend: 1.5,
      strength: 1,
      tint: grassTint,
      roughness: 0.91,
      normalScale: 1,
    },
    {
      id: 'erde',
      texture: 'textures/ground_dirt/albedo.webp',
      normal: 'textures/ground_dirt/normal.webp',
      tileSize: 9,
      slope: [24, 62],
      height: [-10000, 10000],
      slopeBlend: 8,
      heightBlend: 3,
      strength: 1,
      tint: dirtTint,
      roughness: 0.78,
      normalScale: 1,
    },
    {
      id: 'sand',
      texture: 'textures/ground_sand/albedo.webp',
      normal: 'textures/ground_sand/normal.webp',
      tileSize: 8,
      slope: [0, 26],
      // Sand gehoert ans Ufer, nicht in jede Senke. Der Spawn von Lichtmoor
      // liegt auf -2,3 und war mit dem weiteren Band zu drei Vierteln Sand.
      height: [-10000, waterLevel + 1],
      slopeBlend: 6,
      heightBlend: 1.2,
      strength: 1,
      tint: sandTint,
      roughness: 0.75,
      normalScale: 0.8,
    },
  ];
}

// --------------------------------------------------------------------------
// Lichtmoor — Anfängerwiese. Weit, hell, wenig Gefahr.
// --------------------------------------------------------------------------

function lichtmoor() {
  const rng = mulberry32(0x4c49_4d00);
  const size = 512;

  const npcs = [
    { id: 'n_guide', def: 'npc_guide', position: [7, 9], yaw: 3.4 },
    { id: 'n_merchant', def: 'npc_merchant', position: [-12, 13], yaw: 2.2 },
    { id: 'n_smith', def: 'npc_smith', position: [16, -7], yaw: 4.4 },
    { id: 'n_gate', def: 'npc_gatekeeper', position: [4, 196], yaw: 3.14 },
    // Der Kampfmeister, bei dem man ab Stufe 15 seinen Beruf lernt. Er stand
    // eine Weile nur in der fertigen Kartendatei und nicht hier — und war nach
    // dem nächsten `npm run maps` weg. Eine Karte hat eine Quelle, und das ist
    // diese Datei; was nur im Erzeugnis steht, hält bis zum nächsten Lauf.
    { id: 'n_master', def: 'npc_master', position: [-5, -9], yaw: 0.6 },
  ];

  const portals = [
    {
      id: 'g_dornwald',
      position: [0, 204],
      yaw: 0,
      radius: 4,
      label: 'Dornwald',
      // Acht Einheiten vor dem Rueckportal, nicht darin. Genau das war der
      // Fehler: der Zielpunkt lag exakt auf dem Gegentor bei (0, -186), und
      // nach Ablauf der Zeitsperre reiste man automatisch zurueck.
      target: { map: 'dornwald', x: 0, z: -178, yaw: 0 },
      minLevel: 0,
    },
  ];

  const spawners = [
    { id: 's_mote_a', mob: 'mote', position: [-46, 38], radius: 26, count: 7, respawnMs: 75000 },
    { id: 's_mote_b', mob: 'mote', position: [52, 30], radius: 24, count: 6, respawnMs: 75000 },
    { id: 's_mote_c', mob: 'mote', position: [-8, 78], radius: 28, count: 7, respawnMs: 75000 },
    { id: 's_pup_a', mob: 'burrow_pup', position: [70, 96], radius: 26, count: 6, respawnMs: 75000 },
    { id: 's_pup_b', mob: 'burrow_pup', position: [-84, 104], radius: 26, count: 6, respawnMs: 75000 },
    { id: 's_boar', mob: 'thistle_boar', position: [12, 150], radius: 30, count: 5, respawnMs: 75000 },
  ];

  // Das Dorf: alles von Hand gesetzt, damit es nach Absicht aussieht.
  //
  // Der Weg nach Norden zum Tor bekommt Laternen — er ist die einzige Strecke,
  // die jeder Spieler zwangsläufig geht, und ohne Licht ist sie nachts eine
  // schwarze Wiese. Nach Süden steht die Koppel mit den Strohballen, weil dort
  // niemand hin muss und sie dem Blick vom Brunnen aus etwas gibt.
  const dorf = [
    place('well', 0, 14, { collision: 'circle', collisionRadius: 2.2 }),
    place('signpost', 3.5, 4, { yaw: 0.6 }),
    place('banner', -3.6, 15.5, { yaw: 0.4 }),

    // Laternen am Brunnenplatz.
    place('lantern_post', -5.5, 10, { collision: 'circle', collisionRadius: 0.4 }),
    place('lantern_post', 5.5, 10, { collision: 'circle', collisionRadius: 0.4 }),
    place('lantern_post', -5.5, 19, { collision: 'circle', collisionRadius: 0.4 }),
    place('lantern_post', 5.5, 19, { collision: 'circle', collisionRadius: 0.4 }),

    // Der Weg zum Tor. Die letzte Laterne steht kurz vor dem Torwaechter.
    ...lanternRoad([0, 30], [0, 186], { abstand: 32, seite: 6.5 }),

    // Koppel suedlich vom Start.
    ...fenceRect('fence_wood', -26, -14, 9, 7),
    place('hay_bale', -29, -16, { yaw: 0.3 }),
    place('hay_bale', -27.4, -12.6, { yaw: 1.9, collision: 'circle', collisionRadius: 0.7 }),
    place('hay_bale', -22.5, -15.8, { yaw: 2.7, collision: 'circle', collisionRadius: 0.7 }),

    // Lager beim Haendler.
    place('crate', -15.5, 16.5, { yaw: 0.5, collision: 'circle', collisionRadius: 0.6 }),
    place('crate', -14.4, 17.6, { yaw: 1.2, scale: 0.85 }),
    place('barrel', -16.8, 15.2, { yaw: 0.2, collision: 'circle', collisionRadius: 0.5 }),
    place('barrel', -13.2, 14.6, { yaw: 1.1, collision: 'circle', collisionRadius: 0.5 }),

    // Und beim Schmied. Mehr Fass als Kiste — Kohle und Wasser.
    place('barrel', 18.6, -9.4, { yaw: 0.7, collision: 'circle', collisionRadius: 0.5 }),
    place('barrel', 19.4, -7.8, { yaw: 2.4, collision: 'circle', collisionRadius: 0.5 }),
    place('crate', 17.2, -10.8, { yaw: 0.9, collision: 'circle', collisionRadius: 0.6 }),
    ...fenceRun('fence_stone', [13, -12.5], [21, -12.5]),

    // Das Tor im Norden: eine kurze Steinmauer links und rechts, damit der
    // Uebergang nach Dornwald wie ein Grenzposten wirkt und nicht wie ein
    // Kreis im Gras.
    ...fenceRun('fence_stone', [-14, 198], [-5, 198]),
    ...fenceRun('fence_stone', [5, 198], [14, 198]),
    place('banner', -6.5, 199.5, { yaw: 3.14 }),
    place('banner', 6.5, 199.5, { yaw: 3.14 }),
  ];

  const keepOut = [
    { x: 0, z: 0, r: 26 },
    ...npcs.map((n) => ({ x: n.position[0], z: n.position[1], r: 7 })),
    ...portals.map((p) => ({ x: p.position[0], z: p.position[1], r: 12 })),
    ...spawners.map((s) => ({ x: s.position[0], z: s.position[1], r: s.radius * 0.45 })),
    ...keepOutOf(dorf, 4),
  ];

  const props = [
    ...dorf,
    ...scatter(rng, {
      count: 190,
      size,
      minGap: 9,
      scaleRange: [0.8, 1.45],
      models: [
        { key: 'tree_pine', collision: 'circle', collisionRadius: 1.1 },
        { key: 'tree_broad', collision: 'circle', collisionRadius: 1.4 },
      ],
      keepOut,
      tints: [0x4f8a3e, 0x5f9a4a, 0x437a36, 0x6aa855],
    }),
    ...scatter(rng, {
      count: 70,
      size,
      minGap: 7,
      scaleRange: [0.6, 1.6],
      models: [
        { key: 'rock_small', collision: 'circle', collisionRadius: 0.8 },
        { key: 'rock_large', collision: 'circle', collisionRadius: 1.9 },
      ],
      keepOut,
    }),
    ...scatter(rng, {
      count: 150,
      size,
      minGap: 5,
      scaleRange: [0.7, 1.3],
      models: [{ key: 'bush' }, { key: 'grass_tuft' }, { key: 'stump' }],
      keepOut: keepOut.map((k) => ({ ...k, r: k.r * 0.55 })),
    }),
  ].map((p, i) => ({ ...p, id: `p_${String(i + 1).padStart(4, '0')}` }));

  return {
    format: 'aurelith.map',
    version: 1,
    id: 'lichtmoor',
    name: 'Lichtmoor',
    environment: {
      skyColor: 0x8ec3ee,
      horizonColor: 0xdcecf9,
      fogColor: 0xc4dcf0,
      fogNear: 110,
      fogFar: 340,
      sunDirection: [0.42, 0.82, 0.38],
      sunColor: 0xfff4de,
      sunIntensity: 1.55,
      ambientColor: 0xa8c4dd,
      ambientIntensity: 0.9,
    },
    terrain: {
      size,
      cellSize: 4,
      seed: 0x4c49,
      heightScale: 11,
      featureScale: 0.011,
      waterLevel: -3.5,
      grassColor: 0x6aa855,
      grassColorAlt: 0x4f8a3e,
      rockColor: 0x8a8478,
      sandColor: 0xd2c294,
      layers: groundLayers(-3.5),
    },
    spawn: { x: 0, z: 0, yaw: 0 },
    props,
    spawners,
    npcs,
    portals,
  };
}

// --------------------------------------------------------------------------
// Dornwald — dichter, dunkler, ab Stufe 6.
// --------------------------------------------------------------------------

function dornwald() {
  const rng = mulberry32(0x444f_524e);
  const size = 512;

  const npcs = [{ id: 'n_gate_back', def: 'npc_gatekeeper', position: [4, -178], yaw: 0 }];

  const portals = [
    {
      id: 'g_lichtmoor',
      position: [0, -186],
      yaw: 3.14159,
      radius: 4,
      label: 'Lichtmoor',
      target: { map: 'lichtmoor', x: 0, z: 196, yaw: 3.14159 },
      minLevel: 0,
    },
    {
      id: 'g_gruft',
      position: [96, 148],
      yaw: -0.9,
      radius: 4.5,
      label: 'Schattengruft',
      target: { map: 'gruft_01', x: 0, z: -96, yaw: 0 },
      minLevel: 10,
    },
  ];

  const spawners = [
    { id: 's_boar_a', mob: 'thistle_boar', position: [-58, -60], radius: 30, count: 7, respawnMs: 75000 },
    { id: 's_boar_b', mob: 'thistle_boar', position: [64, -20], radius: 30, count: 7, respawnMs: 75000 },
    { id: 's_bandit_a', mob: 'bandit_scout', position: [-40, 60], radius: 28, count: 6, respawnMs: 75000 },
    { id: 's_bandit_b', mob: 'bandit_scout', position: [30, 110], radius: 28, count: 6, respawnMs: 75000 },
    { id: 's_bandit_c', mob: 'bandit_scout', position: [110, 60], radius: 26, count: 5, respawnMs: 75000 },
  ];

  // Dornwald ist nicht bewohnt, sondern durchzogen: ein Grenzposten am Tor,
  // ein Banditenlager mittendrin und Licht nur da, wo jemand welches
  // aufgestellt hat. Deshalb keine Laternenreihe wie in Lichtmoor — die paar
  // Lichter sollen im Dunkeln als Ziel wirken, nicht als Beleuchtung.
  const gesetzt = [
    // Grenzposten am Rueckportal.
    ...fenceRun('fence_stone', [-13, -182], [-5, -182]),
    ...fenceRun('fence_stone', [5, -182], [13, -182]),
    place('lantern_post', -7, -176, { collision: 'circle', collisionRadius: 0.4 }),
    place('lantern_post', 7, -176, { collision: 'circle', collisionRadius: 0.4 }),
    place('banner', -9.5, -180, { yaw: 0 }),
    place('crate', 9, -174, { yaw: 0.4, collision: 'circle', collisionRadius: 0.6 }),
    place('barrel', 10.4, -175.6, { yaw: 1.3, collision: 'circle', collisionRadius: 0.5 }),

    // Banditenlager. Der Zaun ist ein Stueckwerk, kein Gehege — drei Laeufe,
    // die nicht schliessen.
    ...fenceRun('fence_wood', [-50, 52], [-38, 52]),
    ...fenceRun('fence_wood', [-50, 52], [-50, 62]),
    ...fenceRun('fence_wood', [-36, 60], [-36, 68]),
    place('lantern_post', -44, 58, { collision: 'circle', collisionRadius: 0.4 }),
    place('lantern_post', -38, 64, { collision: 'circle', collisionRadius: 0.4 }),
    place('crate', -46, 56, { yaw: 0.8, collision: 'circle', collisionRadius: 0.6 }),
    place('crate', -44.8, 57.2, { yaw: 2.1, scale: 0.9 }),
    place('barrel', -42.5, 55, { yaw: 0.3, collision: 'circle', collisionRadius: 0.5 }),
    place('barrel', -41.2, 56.4, { yaw: 1.7, collision: 'circle', collisionRadius: 0.5 }),
    place('hay_bale', -47, 61, { yaw: 1.1, collision: 'circle', collisionRadius: 0.7 }),
    place('banner', -42, 60, { yaw: 2.2 }),

    // Wegkreuzung zwischen den Sauen — zwei Laternen und ein umgeworfenes Fass.
    place('lantern_post', 2, 8, { collision: 'circle', collisionRadius: 0.4 }),
    place('lantern_post', 6, 30, { collision: 'circle', collisionRadius: 0.4 }),
    place('barrel', 4.2, 18.5, { yaw: 0.9, collision: 'circle', collisionRadius: 0.5 }),

    // Vor der Gruft. Hier soll das Licht warnen, nicht einladen.
    place('lantern_post', 88, 142, { collision: 'circle', collisionRadius: 0.4 }),
    place('lantern_post', 100, 140, { collision: 'circle', collisionRadius: 0.4 }),
    ...fenceRun('fence_stone', [84, 136], [92, 136]),
  ];

  const keepOut = [
    ...npcs.map((n) => ({ x: n.position[0], z: n.position[1], r: 8 })),
    ...portals.map((p) => ({ x: p.position[0], z: p.position[1], r: 14 })),
    ...spawners.map((s) => ({ x: s.position[0], z: s.position[1], r: s.radius * 0.4 })),
    ...keepOutOf(gesetzt, 4),
  ];

  const props = [
    ...gesetzt,
    ...scatter(rng, {
      count: 340,
      size,
      minGap: 7,
      scaleRange: [0.9, 1.7],
      models: [
        { key: 'tree_pine', collision: 'circle', collisionRadius: 1.2 },
        { key: 'tree_dead', collision: 'circle', collisionRadius: 0.9 },
        { key: 'tree_broad', collision: 'circle', collisionRadius: 1.5 },
      ],
      keepOut,
      tints: [0x3c6b33, 0x2f5a2b, 0x486f3a, 0x59503c],
    }),
    ...scatter(rng, {
      count: 80,
      size,
      minGap: 8,
      scaleRange: [0.7, 2.0],
      models: [
        { key: 'rock_large', collision: 'circle', collisionRadius: 2.1 },
        { key: 'rock_small', collision: 'circle', collisionRadius: 0.9 },
      ],
      keepOut,
    }),
    ...scatter(rng, {
      count: 180,
      size,
      minGap: 4.5,
      scaleRange: [0.7, 1.4],
      models: [{ key: 'bush' }, { key: 'stump' }, { key: 'mushroom_large' }],
      keepOut: keepOut.map((k) => ({ ...k, r: k.r * 0.5 })),
    }),
  ].map((p, i) => ({ ...p, id: `p_${String(i + 1).padStart(4, '0')}` }));

  return {
    format: 'aurelith.map',
    version: 1,
    id: 'dornwald',
    name: 'Dornwald',
    environment: {
      skyColor: 0x5c7f96,
      horizonColor: 0x9db4bd,
      fogColor: 0x7f97a2,
      fogNear: 60,
      fogFar: 240,
      sunDirection: [-0.3, 0.68, 0.55],
      sunColor: 0xe8e4d2,
      sunIntensity: 1.1,
      ambientColor: 0x76889a,
      ambientIntensity: 0.75,
    },
    terrain: {
      size,
      cellSize: 4,
      seed: 0x444f,
      heightScale: 19,
      featureScale: 0.014,
      waterLevel: -6,
      grassColor: 0x4a6b3c,
      grassColorAlt: 0x37522e,
      rockColor: 0x6e6a62,
      sandColor: 0x9c8f70,
      // Dornwald ist duesterer als Lichtmoor — dieselben Texturen, dunkler
      // getoent, statt eines zweiten Satzes fuer denselben Boden.
      layers: groundLayers(-6, { grassTint: 0xa8b8a0, dirtTint: 0xb0a898, sandTint: 0xa89880 }),
    },
    // Nicht auf dem Rueckportal bei (0, -186): wer dort gespeichert hat,
    // wuerde beim Anmelden sofort weiterbefoerdert.
    spawn: { x: 0, z: -178, yaw: 0 },
    props,
    spawners,
    npcs,
    portals,
  };
}

// --------------------------------------------------------------------------
// Schattengruft — erster Dungeon. Klein, eng, mit Boss am Ende.
// --------------------------------------------------------------------------

function gruft() {
  const rng = mulberry32(0x4752_5546);
  const size = 256;

  const portals = [
    {
      id: 'g_exit',
      position: [0, -104],
      yaw: 3.14159,
      radius: 5,
      label: 'Dornwald',
      target: { map: 'dornwald', x: 96, z: 140, yaw: 3.14159 },
      minLevel: 0,
    },
  ];

  const spawners = [
    { id: 's_crawler_a', mob: 'cave_crawler', position: [-30, -20], radius: 22, count: 6, respawnMs: 75000 },
    { id: 's_crawler_b', mob: 'cave_crawler', position: [34, 18], radius: 22, count: 6, respawnMs: 75000 },
    { id: 's_crawler_c', mob: 'cave_crawler', position: [-8, 56], radius: 20, count: 5, respawnMs: 75000 },
    { id: 's_warden', mob: 'dungeon_warden', position: [0, 92], radius: 6, count: 1, respawnMs: 120000 },
  ];

  // Unter Tage ist die Laterne das einzige warme Licht. Deshalb stehen sie
  // hier am dichtesten: sie zeichnen den Weg vom Eingang bis zum Waerter, und
  // wer zwischen zwei Lichtern steht, sieht immer das naechste.
  const gesetzt = [
    place('lantern_post', -6, -86, { collision: 'circle', collisionRadius: 0.4 }),
    place('lantern_post', 6, -86, { collision: 'circle', collisionRadius: 0.4 }),
    place('crate', -8.5, -92, { yaw: 0.6, collision: 'circle', collisionRadius: 0.6 }),
    place('barrel', 8.2, -91, { yaw: 1.4, collision: 'circle', collisionRadius: 0.5 }),

    ...lanternRoad([-4, -70], [-14, 0], { abstand: 26, seite: 5 }),
    ...lanternRoad([12, 0], [4, 70], { abstand: 26, seite: 5 }),

    // Der Vorraum des Waerters: Mauerreste und zwei Laternen als Rahmen.
    ...fenceRun('fence_stone', [-12, 80], [-4, 80]),
    ...fenceRun('fence_stone', [4, 80], [12, 80]),
    place('lantern_post', -7, 84, { collision: 'circle', collisionRadius: 0.4 }),
    place('lantern_post', 7, 84, { collision: 'circle', collisionRadius: 0.4 }),
  ];

  const keepOut = [
    { x: 0, z: -96, r: 16 },
    ...portals.map((p) => ({ x: p.position[0], z: p.position[1], r: 14 })),
    ...spawners.map((s) => ({ x: s.position[0], z: s.position[1], r: s.radius * 0.5 })),
    ...keepOutOf(gesetzt, 4),
  ];

  const props = [
    ...gesetzt,
    ...scatter(rng, {
      count: 90,
      size,
      minGap: 6,
      scaleRange: [0.9, 2.2],
      models: [
        { key: 'pillar', collision: 'circle', collisionRadius: 1.3 },
        { key: 'rock_large', collision: 'circle', collisionRadius: 2.0 },
      ],
      keepOut,
    }),
    ...scatter(rng, {
      count: 60,
      size,
      minGap: 5,
      scaleRange: [0.7, 1.5],
      models: [{ key: 'crystal' }, { key: 'mushroom_large' }, { key: 'rock_small' }],
      keepOut,
      tints: [0x7fd8e8, 0x9a7fe8, 0x6fb4d8],
    }),
    ...scatter(rng, {
      count: 22,
      size,
      minGap: 14,
      scaleRange: [1, 1],
      models: [{ key: 'brazier' }],
      keepOut,
    }),
  ].map((p, i) => ({ ...p, id: `p_${String(i + 1).padStart(4, '0')}` }));

  return {
    format: 'aurelith.map',
    version: 1,
    id: 'gruft_01',
    name: 'Schattengruft',
    environment: {
      skyColor: 0x0d1218,
      horizonColor: 0x1b2731,
      fogColor: 0x121a22,
      fogNear: 18,
      fogFar: 110,
      sunDirection: [0.2, 0.9, -0.3],
      sunColor: 0x6d8fb0,
      sunIntensity: 0.45,
      ambientColor: 0x2b3a49,
      ambientIntensity: 0.6,
      // Unter Tage wandert keine Sonne. Ohne das liefe der Tageswechsel auch
      // hier, und um die Mittagszeit stuende die Gruft im Sonnenlicht.
      daylight: false,
    },
    terrain: {
      size,
      cellSize: 3,
      seed: 0x4752,
      heightScale: 7,
      featureScale: 0.02,
      waterLevel: -20,
      grassColor: 0x3a3a42,
      grassColorAlt: 0x2c2c34,
      rockColor: 0x4a4a52,
      sandColor: 0x55504a,
      // In der Gruft waechst nichts. Nur Erde, kalt getoent.
      layers: [
        {
          id: 'gruftboden',
          texture: 'textures/ground_dirt/albedo.webp',
          normal: 'textures/ground_dirt/normal.webp',
          tileSize: 5,
          slope: [0, 90],
          height: [-10000, 10000],
          slopeBlend: 6,
          heightBlend: 3,
          strength: 1,
          tint: 0x6a6a7a,
          roughness: 0.78,
          normalScale: 1.2,
        },
      ],
    },
    spawn: { x: 0, z: -96, yaw: 0 },
    props,
    spawners,
    npcs: [],
    portals,
  };
}

const maps = [lichtmoor(), dornwald(), gruft()];

/**
 * Prueft, dass niemand in einem Tor landet.
 *
 * Landet ein Zielpunkt im Radius eines Tores auf der Zielkarte, wird der
 * Spieler von dort sofort weitergereicht — bei einem Rueckportal also direkt
 * wieder zurueck. Genau das ist passiert: Lichtmoor schickte nach Dornwald auf
 * (0, -186), und dort stand das Rueckportal mit Radius 4.
 *
 * Der Server faengt das inzwischen ab, aber ein Tor, das man nur durch eine
 * Notbremse ueberlebt, ist trotzdem falsch gebaut. Deshalb hier, im Build:
 * lieber ein harter Abbruch als eine Karte, die sich seltsam spielt.
 */
function checkArrivals(maps) {
  const byId = new Map(maps.map((m) => [m.id, m]));
  const problems = [];

  const check = (what, mapId, x, z) => {
    const map = byId.get(mapId);
    if (!map) {
      problems.push(`${what} zeigt auf unbekannte Karte "${mapId}"`);
      return;
    }
    for (const portal of map.portals) {
      const d = Math.hypot(x - portal.position[0], z - portal.position[1]);
      if (d <= portal.radius) {
        problems.push(
          `${what} landet bei (${x}, ${z}) im Tor "${portal.id}" auf ${mapId} ` +
            `(Abstand ${d.toFixed(1)}, Radius ${portal.radius})`,
        );
      }
    }
  };

  for (const map of maps) {
    check(`Startpunkt von ${map.id}`, map.id, map.spawn.x, map.spawn.z);
    for (const portal of map.portals) {
      check(`${map.id}/${portal.id}`, portal.target.map, portal.target.x, portal.target.z);
    }
  }

  if (problems.length > 0) {
    console.error('Karten nicht geschrieben — Zielpunkte liegen in Toren:\n');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
}

checkArrivals(maps);

await mkdir(outDir, { recursive: true });
for (const map of maps) {
  const file = join(outDir, `${map.id}.json`);
  await writeFile(file, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  console.log(
    `${map.id.padEnd(12)} ${String(map.props.length).padStart(4)} Props  ` +
      `${String(map.spawners.length).padStart(2)} Spawner  ` +
      `${String(map.npcs.length).padStart(2)} NPCs  ` +
      `${String(map.portals.length).padStart(2)} Portale`,
  );
}
console.log(`\n${maps.length} Maps geschrieben nach ${outDir}`);
