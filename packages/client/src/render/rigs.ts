/**
 * Figuren und ihre Bewegung.
 *
 * Ein Rig ist ein kleiner Szenengraph mit benannten Gelenken plus einer
 * `update`-Funktion, die daraus eine Pose macht. Heute stecken hinter den
 * Gelenken zusammengesetzte Grundkörper und eine von Hand geschriebene
 * Laufbewegung.
 *
 * Der Austausch gegen echte Modelle ist genau hier vorgesehen: ein glTF mit
 * Skelett und Animationsspuren erfüllt dieselbe Schnittstelle — `root` ist dann
 * die geladene Szene, `update` füttert einen AnimationMixer statt Winkel zu
 * setzen. Der Rest des Renderers merkt davon nichts.
 */

import * as THREE from 'three';
import { assemble, box, cone, cylinder, sphere, type Part } from './geometry.ts';

export interface RigState {
  /** Weltnenheiten pro Sekunde. Treibt die Schrittfrequenz. */
  speed: number;
  /** 0..1 während eines Schlags, sonst negativ. */
  attackPhase: number;
  dead: boolean;
  /** Sekunden seit Spielstart, für Leerlaufbewegung. */
  time: number;
}

export interface CharacterRig {
  root: THREE.Object3D;
  update(state: RigState): void;
  dispose(): void;
}

/** Ein Gelenk: ein Drehpunkt, unter dem die Geometrie hängt. */
function joint(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  pivot: [number, number, number],
  offset: [number, number, number],
  disposables: THREE.BufferGeometry[],
): THREE.Object3D {
  const holder = new THREE.Object3D();
  holder.position.set(...pivot);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...offset);
  holder.add(mesh);
  disposables.push(geometry);
  return holder;
}

// ---------------------------------------------------------------------------
// Humanoid
// ---------------------------------------------------------------------------

export interface HumanoidConfig {
  kind: 'humanoid';
  height: number;
  /** Breitenfaktor. Ein Gruftwärter ist nicht nur größer, sondern massiger. */
  bulk: number;
  skin: number;
  shirt: number;
  pants: number;
  hair: number;
  accent: number;
  weapon: 'sword' | 'club' | 'staff' | 'none';
}

function buildWeapon(kind: HumanoidConfig['weapon'], scale: number): THREE.BufferGeometry | null {
  switch (kind) {
    case 'sword':
      return assemble([
        { geometry: box(0.07, 0.9, 0.02).scale(scale, scale, scale), color: 0xb9863f, position: [0, 0.45 * scale, 0] },
        { geometry: box(0.22, 0.06, 0.06).scale(scale, scale, scale), color: 0x5d4324, position: [0, 0.02 * scale, 0] },
        { geometry: box(0.06, 0.22, 0.06).scale(scale, scale, scale), color: 0x3f2d18, position: [0, -0.12 * scale, 0] },
      ]);
    case 'club':
      return assemble([
        { geometry: cylinder(0.05, 0.06, 0.9, 6).scale(scale, scale, scale), color: 0x5d4324, position: [0, 0.35 * scale, 0] },
        { geometry: sphere(0.2, 0).scale(scale, scale, scale), color: 0x4a4a52, position: [0, 0.85 * scale, 0] },
      ]);
    case 'staff':
      return assemble([
        { geometry: cylinder(0.04, 0.05, 1.5, 6).scale(scale, scale, scale), color: 0x6b4f34, position: [0, 0.6 * scale, 0] },
        { geometry: new THREE.OctahedronGeometry(0.14, 0).scale(scale, scale, scale), color: 0x7fd8e8, position: [0, 1.35 * scale, 0] },
      ]);
    default:
      return null;
  }
}

function makeHumanoid(cfg: HumanoidConfig, material: THREE.Material): CharacterRig {
  const disposables: THREE.BufferGeometry[] = [];
  const s = cfg.height / 1.8;
  const w = cfg.bulk;

  const root = new THREE.Object3D();
  const body = new THREE.Object3D();
  root.add(body);

  // Maße in Einheiten einer 1,8 m hohen Figur, danach mit `s` skaliert.
  //
  // Der Drehpunkt eines Beins muss auf seiner eigenen Länge sitzen und die
  // Geometrie um die halbe Länge nach unten versetzt sein — sonst steht die
  // Figur auf Höhe des Restes, den man vergessen hat abzuziehen, und schwebt.
  const legLength = 0.92;
  const hipY = legLength;
  const shoulderY = 1.45;
  const armLength = 0.62;

  // Rumpf, Kopf und Haar als ein Stück — sie bewegen sich nie gegeneinander.
  const torsoParts: Part[] = [
    { geometry: box(0.5 * w, 0.6, 0.3 * w), color: cfg.shirt, position: [0, 1.22, 0] },
    { geometry: box(0.42 * w, 0.16, 0.28 * w), color: cfg.accent, position: [0, 0.96, 0] },
    { geometry: box(0.28, 0.28, 0.26), color: cfg.skin, position: [0, 1.66, 0] },
    { geometry: box(0.31, 0.1, 0.29), color: cfg.hair, position: [0, 1.76, 0] },
    { geometry: box(0.15, 0.09, 0.06), color: cfg.hair, position: [0, 1.7, -0.14] },
  ];
  const torso = new THREE.Mesh(assemble(torsoParts), material);
  torso.scale.setScalar(s);
  body.add(torso);
  disposables.push(torso.geometry);

  const armGeo = () => box(0.16 * w, armLength, 0.16 * w);
  const legGeo = () => box(0.18 * w, legLength, 0.2 * w);

  const armL = joint(armGeo(), material, [-0.34 * w * s, shoulderY * s, 0], [0, -armLength / 2, 0], disposables);
  const armR = joint(armGeo(), material, [0.34 * w * s, shoulderY * s, 0], [0, -armLength / 2, 0], disposables);
  const legL = joint(legGeo(), material, [-0.14 * w * s, hipY * s, 0], [0, -legLength / 2, 0], disposables);
  const legR = joint(legGeo(), material, [0.14 * w * s, hipY * s, 0], [0, -legLength / 2, 0], disposables);
  for (const j of [armL, armR, legL, legR]) {
    j.scale.setScalar(s);
    body.add(j);
  }

  // Hautfarbe an Händen und Füßen andeuten.
  const skinMat = material;
  const handGeo = box(0.17 * w, 0.14, 0.17 * w);
  const hand = new THREE.Mesh(handGeo, skinMat);
  hand.position.set(0, -armLength, 0);
  armR.add(hand);
  disposables.push(handGeo);

  // Ohne Skalierung: der Arm, an dem die Waffe hängt, ist bereits mit `s`
  // skaliert, und zweimal skaliert wäre der Gruftwärter-Knüppel dreimal zu groß.
  const weaponGeo = buildWeapon(cfg.weapon, 1);
  if (weaponGeo) {
    const weapon = new THREE.Mesh(weaponGeo, material);
    weapon.position.set(0, -armLength - 0.04, 0.05);
    weapon.rotation.x = -0.25;
    armR.add(weapon);
    disposables.push(weaponGeo);
  }

  return {
    root,
    update(state) {
      if (state.dead) {
        // Umfallen statt verschwinden: der Kadaver bleibt bis zum Respawn.
        root.rotation.x = -Math.PI / 2.2;
        body.position.y = 0;
        return;
      }
      root.rotation.x = 0;

      const gait = Math.min(1, state.speed / 6);
      const swing = Math.sin(state.time * 9 * Math.max(0.35, gait)) * 0.65 * gait;

      legL.rotation.x = swing;
      legR.rotation.x = -swing;
      armL.rotation.x = -swing * 0.8;

      if (state.attackPhase >= 0) {
        // Ausholen und Durchziehen: die erste Hälfte hebt, die zweite schlägt.
        const p = state.attackPhase;
        armR.rotation.x = p < 0.45 ? -2.4 * (p / 0.45) : -2.4 + 3.4 * ((p - 0.45) / 0.55);
        body.rotation.y = p < 0.45 ? 0.35 * (p / 0.45) : 0.35 - 0.75 * ((p - 0.45) / 0.55);
      } else {
        armR.rotation.x = swing * 0.8;
        body.rotation.y = 0;
      }

      // Leichtes Wippen — ohne das wirkt eine stehende Figur wie ein Möbelstück.
      body.position.y = Math.abs(Math.sin(state.time * 9 * Math.max(0.35, gait))) * 0.05 * gait +
        Math.sin(state.time * 1.8) * 0.012;
    },
    dispose() {
      for (const g of disposables) g.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Kreaturen
// ---------------------------------------------------------------------------

export interface CreatureConfig {
  kind: 'creature';
  variant: 'blob' | 'quadruped' | 'crawler';
  size: number;
  primary: number;
  secondary: number;
  accent: number;
}

function makeBlob(cfg: CreatureConfig, material: THREE.Material): CharacterRig {
  const disposables: THREE.BufferGeometry[] = [];
  const root = new THREE.Object3D();
  const body = new THREE.Object3D();
  root.add(body);

  const coreGeo = assemble([
    { geometry: sphere(0.42 * cfg.size, 1), color: cfg.primary, position: [0, 0.7 * cfg.size, 0] },
    { geometry: sphere(0.16 * cfg.size, 0), color: cfg.accent, position: [0, 0.7 * cfg.size, 0.3 * cfg.size] },
  ]);
  const core = new THREE.Mesh(coreGeo, material);
  body.add(core);
  disposables.push(coreGeo);

  // Drei Trabanten, die um den Kern kreisen.
  const orbiters: THREE.Object3D[] = [];
  for (let i = 0; i < 3; i++) {
    const geo = sphere(0.1 * cfg.size, 0);
    const holder = new THREE.Object3D();
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(0.55 * cfg.size, 0, 0);
    holder.position.y = 0.7 * cfg.size;
    holder.rotation.y = (i / 3) * Math.PI * 2;
    holder.add(mesh);
    body.add(holder);
    orbiters.push(holder);
    disposables.push(geo);
  }

  return {
    root,
    update(state) {
      if (state.dead) {
        body.scale.setScalar(0.3);
        body.position.y = -0.3;
        return;
      }
      body.scale.setScalar(1);
      // Schweben, nicht laufen — deshalb keine Beine und ein deutlicher Hub.
      body.position.y = Math.sin(state.time * 2.2) * 0.16 + 0.2;
      for (let i = 0; i < orbiters.length; i++) {
        orbiters[i]!.rotation.y = state.time * 1.6 + (i / orbiters.length) * Math.PI * 2;
      }
      if (state.attackPhase >= 0) {
        const p = 1 - Math.abs(state.attackPhase - 0.5) * 2;
        body.scale.set(1 + p * 0.3, 1 - p * 0.2, 1 + p * 0.3);
      }
    },
    dispose() {
      for (const g of disposables) g.dispose();
    },
  };
}

function makeQuadruped(cfg: CreatureConfig, material: THREE.Material): CharacterRig {
  const disposables: THREE.BufferGeometry[] = [];
  const s = cfg.size;
  const root = new THREE.Object3D();
  const body = new THREE.Object3D();
  root.add(body);

  const trunkGeo = assemble([
    { geometry: box(0.62 * s, 0.5 * s, 1.05 * s), color: cfg.primary, position: [0, 0.62 * s, 0] },
    { geometry: box(0.42 * s, 0.38 * s, 0.42 * s), color: cfg.primary, position: [0, 0.72 * s, 0.66 * s] },
    { geometry: cone(0.12 * s, 0.3 * s, 5), color: cfg.accent, position: [0, 0.62 * s, 0.9 * s], rotation: [Math.PI / 2, 0, 0] },
    { geometry: box(0.1 * s, 0.16 * s, 0.06 * s), color: cfg.secondary, position: [-0.14 * s, 0.94 * s, 0.6 * s] },
    { geometry: box(0.1 * s, 0.16 * s, 0.06 * s), color: cfg.secondary, position: [0.14 * s, 0.94 * s, 0.6 * s] },
    { geometry: box(0.1 * s, 0.1 * s, 0.4 * s), color: cfg.secondary, position: [0, 0.72 * s, -0.66 * s] },
  ]);
  const trunk = new THREE.Mesh(trunkGeo, material);
  body.add(trunk);
  disposables.push(trunkGeo);

  const legs: THREE.Object3D[] = [];
  const positions: Array<[number, number]> = [
    [-0.22 * s, 0.36 * s],
    [0.22 * s, 0.36 * s],
    [-0.22 * s, -0.36 * s],
    [0.22 * s, -0.36 * s],
  ];
  for (const [x, z] of positions) {
    const geo = box(0.14 * s, 0.44 * s, 0.14 * s);
    const leg = joint(geo, material, [x, 0.44 * s, z], [0, -0.22 * s, 0], disposables);
    body.add(leg);
    legs.push(leg);
  }

  return {
    root,
    update(state) {
      if (state.dead) {
        root.rotation.z = Math.PI / 2.1;
        return;
      }
      root.rotation.z = 0;

      const gait = Math.min(1, state.speed / 5);
      const t = state.time * 11 * Math.max(0.3, gait);
      // Diagonalgang: vorne links mit hinten rechts.
      legs[0]!.rotation.x = Math.sin(t) * 0.7 * gait;
      legs[3]!.rotation.x = Math.sin(t) * 0.7 * gait;
      legs[1]!.rotation.x = -Math.sin(t) * 0.7 * gait;
      legs[2]!.rotation.x = -Math.sin(t) * 0.7 * gait;

      if (state.attackPhase >= 0) {
        const p = state.attackPhase;
        // Kopf runter, dann vorschnellen.
        body.rotation.x = p < 0.5 ? -0.35 * (p / 0.5) : -0.35 + 0.75 * ((p - 0.5) / 0.5);
      } else {
        body.rotation.x = Math.sin(state.time * 2) * 0.02;
      }
    },
    dispose() {
      for (const g of disposables) g.dispose();
    },
  };
}

function makeCrawler(cfg: CreatureConfig, material: THREE.Material): CharacterRig {
  const disposables: THREE.BufferGeometry[] = [];
  const s = cfg.size;
  const root = new THREE.Object3D();
  const body = new THREE.Object3D();
  root.add(body);

  const shellGeo = assemble([
    { geometry: sphere(0.55 * s, 1), color: cfg.primary, position: [0, 0.42 * s, 0], scale: [1, 0.6, 1.35] },
    { geometry: sphere(0.3 * s, 0), color: cfg.secondary, position: [0, 0.4 * s, 0.62 * s] },
    { geometry: new THREE.OctahedronGeometry(0.1 * s, 0), color: cfg.accent, position: [-0.13 * s, 0.5 * s, 0.78 * s] },
    { geometry: new THREE.OctahedronGeometry(0.1 * s, 0), color: cfg.accent, position: [0.13 * s, 0.5 * s, 0.78 * s] },
  ]);
  const shell = new THREE.Mesh(shellGeo, material);
  body.add(shell);
  disposables.push(shellGeo);

  const legs: THREE.Object3D[] = [];
  for (let i = 0; i < 6; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2) - 1;
    const geo = box(0.07 * s, 0.42 * s, 0.07 * s);
    const leg = joint(
      geo,
      material,
      [side * 0.42 * s, 0.4 * s, row * 0.36 * s],
      [0, -0.21 * s, 0],
      disposables,
    );
    leg.rotation.z = side * 0.6;
    body.add(leg);
    legs.push(leg);
  }

  return {
    root,
    update(state) {
      if (state.dead) {
        root.rotation.z = Math.PI;
        root.position.y = 0.3 * s;
        return;
      }
      root.rotation.z = 0;
      root.position.y = 0;

      const gait = Math.min(1, state.speed / 4.5);
      for (let i = 0; i < legs.length; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const phase = state.time * 13 * Math.max(0.3, gait) + i * 1.05;
        legs[i]!.rotation.x = Math.sin(phase) * 0.5 * gait;
        legs[i]!.rotation.z = side * (0.6 + Math.cos(phase) * 0.15 * gait);
      }
      body.position.y = Math.sin(state.time * 6) * 0.03;

      if (state.attackPhase >= 0) {
        const p = 1 - Math.abs(state.attackPhase - 0.5) * 2;
        body.position.z = p * 0.35 * s;
      } else {
        body.position.z = 0;
      }
    },
    dispose() {
      for (const g of disposables) g.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Katalog
// ---------------------------------------------------------------------------

export type CharacterConfig = HumanoidConfig | CreatureConfig;

export const CHARACTER_CONFIGS: Record<string, CharacterConfig> = {
  player: {
    kind: 'humanoid',
    height: 1.8,
    bulk: 1,
    skin: 0xe0b087,
    shirt: 0x4a6f9c,
    pants: 0x3a4652,
    hair: 0x4a3527,
    accent: 0x8a5a3c,
    weapon: 'sword',
  },

  npc_guide: {
    kind: 'humanoid',
    height: 1.85,
    bulk: 1,
    skin: 0xd9a97c,
    shirt: 0x5f8f6a,
    pants: 0x3c4a3f,
    hair: 0x8a7a5c,
    accent: 0xd8c47a,
    weapon: 'staff',
  },
  npc_smith: {
    kind: 'humanoid',
    height: 1.9,
    bulk: 1.25,
    skin: 0xc99168,
    shirt: 0x6b4a35,
    pants: 0x3a3128,
    hair: 0x2f2118,
    accent: 0x8a8478,
    weapon: 'club',
  },
  npc_merchant: {
    kind: 'humanoid',
    height: 1.72,
    bulk: 0.95,
    skin: 0xe4bc95,
    shirt: 0x8c5a8f,
    pants: 0x4a3a52,
    hair: 0x5c3a2a,
    accent: 0xd8b84a,
    weapon: 'none',
  },
  npc_gatekeeper: {
    kind: 'humanoid',
    height: 2.0,
    bulk: 1.2,
    skin: 0xd0a078,
    shirt: 0x50565e,
    pants: 0x3a3f45,
    hair: 0x3a3028,
    accent: 0x9aa4b0,
    weapon: 'club',
  },

  mob_mote: {
    kind: 'creature',
    variant: 'blob',
    size: 1,
    primary: 0x7fd8e8,
    secondary: 0x5fb0c8,
    accent: 0xe8f8ff,
  },
  mob_pup: {
    kind: 'creature',
    variant: 'quadruped',
    size: 0.9,
    primary: 0x8a6a4a,
    secondary: 0x6a4f36,
    accent: 0xc8b090,
  },
  mob_boar: {
    kind: 'creature',
    variant: 'quadruped',
    size: 1.35,
    primary: 0x5a4a3f,
    secondary: 0x3f342c,
    accent: 0xd8cdb4,
  },
  mob_bandit: {
    kind: 'humanoid',
    height: 1.9,
    bulk: 1.05,
    skin: 0xc99168,
    shirt: 0x5a3a3a,
    pants: 0x3a2f2a,
    hair: 0x241a14,
    accent: 0x8a2f2f,
    weapon: 'sword',
  },
  mob_crawler: {
    kind: 'creature',
    variant: 'crawler',
    size: 1.2,
    primary: 0x4a4a5c,
    secondary: 0x35354a,
    accent: 0x9a7fe8,
  },
  mob_warden: {
    kind: 'humanoid',
    height: 3.4,
    bulk: 1.7,
    skin: 0x8a8a94,
    shirt: 0x3a3a48,
    pants: 0x2a2a34,
    hair: 0x1a1a22,
    accent: 0x9a7fe8,
    weapon: 'club',
  },
};

export function createRig(key: string, material: THREE.Material): CharacterRig {
  const cfg = CHARACTER_CONFIGS[key] ?? CHARACTER_CONFIGS.player!;
  if (cfg.kind === 'humanoid') return makeHumanoid(cfg, material);
  switch (cfg.variant) {
    case 'blob':
      return makeBlob(cfg, material);
    case 'crawler':
      return makeCrawler(cfg, material);
    default:
      return makeQuadruped(cfg, material);
  }
}
