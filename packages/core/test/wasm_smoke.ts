/**
 * Prüft den Kern so, wie ihn die Wirte tatsächlich benutzen: als geladene
 * wasm-Binärdatei über die TypeScript-Hülle.
 *
 * Der native Test in `native_test.cpp` prüft die Simulation. Dieser hier prüft
 * die Brücke — Layout-Vertrag, Sichtpuffer, Ereignisse, Höhengitter. Genau die
 * Dinge, die nativ gar nicht auffallen könnten.
 *
 *   npx tsx packages/core/test/wasm_smoke.ts
 */

import createAurelithCore from '../dist/aurelith_core.js';
import { Core, CoreButton, CoreEntityState, CoreEventType, type CoreMobDef } from '../src/index.ts';

let checks = 0;
let failures = 0;

function check(ok: boolean, what: string): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`  FEHLGESCHLAGEN: ${what}`);
  }
}

function checkNear(actual: number, expected: number, tol: number, what: string): void {
  checks++;
  if (Math.abs(actual - expected) > tol) {
    failures++;
    console.log(`  FEHLGESCHLAGEN: ${what} (ist ${actual.toFixed(4)}, erwartet ${expected} ± ${tol})`);
  }
}

console.log('Aurelith-Kern — wasm-Brücke\n');

// `describeLayout` wird in `Core.fromModule` gegen `layout.ts` geprüft. Kommt
// dieser Aufruf durch, stimmt der Vertrag.
const core = await Core.fromModule(await (createAurelithCore as never as () => Promise<never>)());
console.log(`Kern ${core.version} geladen, Tickrate ${core.tickRate}`);
check(core.tickRate === 20, 'Tickrate ist 20');

const mob: CoreMobDef = {
  maxHp: 100,
  attackDamage: 10,
  defense: 0,
  moveSpeed: 4,
  aggroRange: 0,
  leashRange: 50,
  attackRange: 2,
  attackArc: Math.PI,
  attackCooldownSec: 1,
  attackWindupSec: 0.2,
  radius: 0.6,
  height: 1.6,
  expReward: 25,
  goldReward: 5,
  level: 1,
  aggressive: 0,
};
const mobIndex = core.registerMob(mob);
check(core.mobCount === 1, 'genau eine Monsterart eingetragen');

const world = core.createWorld(1234, {
  size: 512,
  cellSize: 4,
  seed: 1234,
  heightScale: 0,
  featureScale: 0.012,
});

world.spawnPlayer({
  id: 1,
  level: 1,
  x: 0,
  z: 0,
  yaw: 0,
  hp: 200,
  maxHp: 200,
  mp: 50,
  maxMp: 50,
  attackDamage: 20,
  defense: 5,
  moveSpeed: 6,
  attackRange: 3,
  attackArc: 2.67,
  attackCooldownSec: 0.62,
  attackWindupSec: 0.15,
  radius: 0.45,
  height: 1.8,
});
world.spawnMob(10, mobIndex, -1.2, 2.0);
world.spawnMob(11, mobIndex, 1.2, 2.0);

check(world.entityCount === 3, 'drei Entities in der Welt');

// --- Sichtpuffer ------------------------------------------------------------

const rows = world.readEntities();
check(rows.length === 3, 'Sichtpuffer hat drei Zeilen');
const player = rows.find((r) => r.id === 1);
check(player !== undefined, 'Spieler steht im Sichtpuffer');
check(player?.state === CoreEntityState.Idle, 'Spieler beginnt untätig');
checkNear(player?.maxHp ?? 0, 200, 0.01, 'Lebenspunkte kommen durch die Brücke');

// --- Bewegung über die Brücke ----------------------------------------------

for (let i = 0; i < 20; i++) {
  world.applyInput(1, 0, 1, 0, 0, 1 / 20);
  world.step(1 / 20);
  world.drainEvents();
}
world.readEntities(rows);
const moved = rows.find((r) => r.id === 1)!;
checkNear(moved.z, 6, 0.2, 'eine Sekunde Lauf ergibt sechs Einheiten');

// --- Flächenschlag und Ereignisse ------------------------------------------

world.teleport(1, 0, 0, 0);
world.applyInput(1, 0, 0, 0, CoreButton.Attack, 1 / 20);

let hits = 0;
for (let i = 0; i < 8; i++) {
  world.step(1 / 20);
  for (const ev of world.drainEvents()) {
    if (ev.type === CoreEventType.Hit) hits++;
  }
}
check(hits >= 2, `ein Schlag trifft beide Ziele (${hits} Treffer gemeldet)`);

// --- Höhengitter ------------------------------------------------------------

const hilly = core.createWorld(99, {
  size: 512,
  cellSize: 4,
  seed: 4321,
  heightScale: 14,
  featureScale: 0.012,
});
const grid = hilly.sampleHeightGrid(-32, -32, 8, 9, 9);
check(grid.length === 81, 'Höhengitter hat 81 Stützpunkte');
checkNear(grid[40]!, hilly.heightAt(0, 0), 0.001, 'Gitterwert deckt sich mit Einzelabfrage');
check(new Set(grid).size > 10, 'Höhenfeld ist nicht konstant');

// --- Von Hand geformte Höhen ------------------------------------------------
//
// Der eigentliche Punkt dieser Prüfung ist nicht die Interpolation — die prüft
// der native Test genauer. Hier geht es um die Brücke: dass ein Int16Array aus
// JavaScript tatsächlich im Kernspeicher landet und die Höhenrechnung es sieht.

const flat = core.createWorld(7, {
  size: 512,
  cellSize: 4,
  seed: 4321,
  heightScale: 0,
  featureScale: 0.012,
});
checkNear(flat.heightAt(0, 0), 0, 0.001, 'ohne Feld ist das Testgelände eben');

const resolution = 5;
const values = new Int16Array(resolution * resolution);
values[2 * resolution + 2] = 10 * 64; // zehn Meter auf die Mitte
flat.setSculpt(values, resolution);

check(flat.sculptResolution === resolution, 'Kern meldet die Auflösung zurück');
checkNear(flat.heightAt(0, 0), 10, 0.01, 'das Feld kommt im Kern an');
checkNear(flat.heightAt(64, 0), 5, 0.01, 'zwischen den Stützpunkten wird interpoliert');
check(flat.slopeAt(64, 0) > 1, 'der geformte Hang hat eine Steigung');

// Das Gitter, aus dem der Renderer sein Netz baut, muss dasselbe sehen.
const sculptGrid = flat.sampleHeightGrid(-128, 0, 64, 5, 1);
checkNear(sculptGrid[2]!, 10, 0.01, 'das Höhengitter zeigt den geformten Hügel');

flat.setSculpt(undefined, 0);
checkNear(flat.heightAt(0, 0), 0, 0.001, 'abgeschaltet ist wieder rein prozedural');

flat.dispose();
hilly.dispose();
world.dispose();

console.log(`\n${checks} Prüfungen, ${failures} fehlgeschlagen`);
process.exit(failures === 0 ? 0 : 1);
