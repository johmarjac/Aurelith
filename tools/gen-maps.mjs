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
  ];

  const portals = [
    {
      id: 'g_dornwald',
      kind: 'gate',
      position: [0, 204],
      radius: 4,
      label: 'Dornwald',
      target: { map: 'dornwald', x: 0, z: -186, yaw: 0 },
      minLevel: 0,
    },
  ];

  const spawners = [
    { id: 's_mote_a', mob: 'mote', position: [-46, 38], radius: 26, count: 7, respawnMs: 9000 },
    { id: 's_mote_b', mob: 'mote', position: [52, 30], radius: 24, count: 6, respawnMs: 9000 },
    { id: 's_mote_c', mob: 'mote', position: [-8, 78], radius: 28, count: 7, respawnMs: 9000 },
    { id: 's_pup_a', mob: 'burrow_pup', position: [70, 96], radius: 26, count: 6, respawnMs: 13000 },
    { id: 's_pup_b', mob: 'burrow_pup', position: [-84, 104], radius: 26, count: 6, respawnMs: 13000 },
    { id: 's_boar', mob: 'thistle_boar', position: [12, 150], radius: 30, count: 5, respawnMs: 20000 },
  ];

  const keepOut = [
    { x: 0, z: 0, r: 26 },
    ...npcs.map((n) => ({ x: n.position[0], z: n.position[1], r: 7 })),
    ...portals.map((p) => ({ x: p.position[0], z: p.position[1], r: 12 })),
    ...spawners.map((s) => ({ x: s.position[0], z: s.position[1], r: s.radius * 0.45 })),
  ];

  const props = [
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

  // Ein paar von Hand gesetzte Landmarken rund um den Startpunkt.
  props.push(
    {
      id: 'p_well',
      model: 'well',
      position: [0, 0, 14],
      rotation: [0, 0, 0],
      scale: 1,
      snapToGround: true,
      collision: 'circle',
      collisionRadius: 2.2,
    },
    {
      id: 'p_sign_start',
      model: 'signpost',
      position: [3.5, 0, 4],
      rotation: [0, 0.6, 0],
      scale: 1,
      snapToGround: true,
      collision: 'none',
      collisionRadius: 0.4,
    },
    {
      id: 'p_gate_arch',
      model: 'gate_arch',
      position: [0, 0, 204],
      rotation: [0, 0, 0],
      scale: 1.4,
      snapToGround: true,
      collision: 'none',
      collisionRadius: 0,
    },
  );

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
      kind: 'return',
      position: [0, -186],
      radius: 4,
      label: 'Lichtmoor',
      target: { map: 'lichtmoor', x: 0, z: 196, yaw: 3.14159 },
      minLevel: 0,
    },
    {
      id: 'g_gruft',
      kind: 'dungeon',
      position: [96, 148],
      radius: 4.5,
      label: 'Schattengruft',
      target: { map: 'gruft_01', x: 0, z: -96, yaw: 0 },
      minLevel: 10,
    },
  ];

  const spawners = [
    { id: 's_boar_a', mob: 'thistle_boar', position: [-58, -60], radius: 30, count: 7, respawnMs: 16000 },
    { id: 's_boar_b', mob: 'thistle_boar', position: [64, -20], radius: 30, count: 7, respawnMs: 16000 },
    { id: 's_bandit_a', mob: 'bandit_scout', position: [-40, 60], radius: 28, count: 6, respawnMs: 22000 },
    { id: 's_bandit_b', mob: 'bandit_scout', position: [30, 110], radius: 28, count: 6, respawnMs: 22000 },
    { id: 's_bandit_c', mob: 'bandit_scout', position: [110, 60], radius: 26, count: 5, respawnMs: 22000 },
  ];

  const keepOut = [
    ...npcs.map((n) => ({ x: n.position[0], z: n.position[1], r: 8 })),
    ...portals.map((p) => ({ x: p.position[0], z: p.position[1], r: 14 })),
    ...spawners.map((s) => ({ x: s.position[0], z: s.position[1], r: s.radius * 0.4 })),
  ];

  const props = [
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

  props.push({
    id: 'p_gruft_arch',
    model: 'dungeon_arch',
    position: [96, 0, 148],
    rotation: [0, -0.9, 0],
    scale: 1.6,
    snapToGround: true,
    collision: 'none',
    collisionRadius: 0,
  });

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
    },
    spawn: { x: 0, z: -186, yaw: 0 },
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
      kind: 'return',
      position: [0, -104],
      radius: 5,
      label: 'Dornwald',
      target: { map: 'dornwald', x: 96, z: 140, yaw: 3.14159 },
      minLevel: 0,
    },
  ];

  const spawners = [
    { id: 's_crawler_a', mob: 'cave_crawler', position: [-30, -20], radius: 22, count: 6, respawnMs: 25000 },
    { id: 's_crawler_b', mob: 'cave_crawler', position: [34, 18], radius: 22, count: 6, respawnMs: 25000 },
    { id: 's_crawler_c', mob: 'cave_crawler', position: [-8, 56], radius: 20, count: 5, respawnMs: 25000 },
    { id: 's_warden', mob: 'dungeon_warden', position: [0, 92], radius: 6, count: 1, respawnMs: 120000 },
  ];

  const keepOut = [
    { x: 0, z: -96, r: 16 },
    ...portals.map((p) => ({ x: p.position[0], z: p.position[1], r: 14 })),
    ...spawners.map((s) => ({ x: s.position[0], z: s.position[1], r: s.radius * 0.5 })),
  ];

  const props = [
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
    },
    spawn: { x: 0, z: -96, yaw: 0 },
    props,
    spawners,
    npcs: [],
    portals,
  };
}

const maps = [lichtmoor(), dornwald(), gruft()];

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
