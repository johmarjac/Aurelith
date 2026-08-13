/**
 * Prüft die Laufbewegung — ohne Browser, ohne Bild.
 *
 * Gemessen wird eine einzige Größe: wie weit sich ein Gelenk von einem Bild
 * zum nächsten bewegt. Ein Schritt ist eine Schwingung mit begrenzter
 * Frequenz und begrenztem Ausschlag, also gibt es dafür eine Obergrenze. Wer
 * sie reißt, springt — und ein Sprung sieht im Spiel aus, als hätte die Figur
 * kurz ausgesetzt.
 *
 * Der Fehler, für den dieser Test geschrieben wurde: die Schrittphase stand
 * als `zeit * frequenz` da. Das ist nur richtig, solange die Frequenz konstant
 * bleibt. Sobald das Tempo sich ändert — beim Anlaufen, beim Anhalten, beim
 * Richtungswechsel — wirkt die neue Frequenz rückwirkend auf die gesamte
 * verstrichene Zeit. Der Fehler wächst deshalb mit der Spielzeit: nach einer
 * halben Stunde war der Sprung ein Vielfaches von 2π.
 *
 *   npx tsx packages/client/test/gait_test.ts
 *
 * Mit AURELITH_GAIT_BUG=1 wird die alte, fehlerhafte Rechnung nachgestellt.
 * Das ist die Gegenprobe: ein Test, der auch damit durchgeht, misst nichts.
 */

import * as THREE from 'three';
import { createRig } from '../src/render/rigs.ts';

const BUG = process.env.AURELITH_GAIT_BUG === '1';

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/**
 * Alle Gelenkwinkel und -höhen als Vektor.
 *
 * Welcher Wert zu welchem Körperteil gehört, ist für die Frage egal: es geht
 * darum, ob *irgendetwas* springt.
 */
function pose(rig: { root: THREE.Object3D }): number[] {
  const v: number[] = [];
  rig.root.traverse((o) => v.push(o.rotation.x, o.rotation.y, o.rotation.z, o.position.y));
  return v;
}

function maxDelta(a: number[], b: number[]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

const FPS = 60;
const DT = 1 / FPS;

/**
 * Die Obergrenze eines ehrlichen Schritts.
 *
 * Die schnellste Schwingung im Humanoiden läuft mit 9 rad/s bei einem
 * Ausschlag von 0,65 rad. Pro Bild sind das höchstens 0,65 * 9 / 60 ≈ 0,10 —
 * plus etwas Luft für die überlagerte Wippbewegung.
 */
const STEP_LIMIT = 0.13;

/**
 * Fährt ein Tempoprofil ab und meldet den größten Sprung.
 *
 * Jeder Lauf bekommt sein **eigenes** Rig. Teilte man sich eines, erbte jeder
 * Lauf die Phase des vorigen, und die Messung hinge daran, in welcher
 * Reihenfolge die Läufe stehen.
 */
function run(startTime: number, profile: (t: number) => number, seconds = 4): number {
  const rig = createRig('player', new THREE.MeshBasicMaterial());
  let prev: number[] | null = null;
  let worst = 0;

  for (let i = 0; i < seconds * FPS; i++) {
    const local = i * DT;
    const speed = profile(local);
    const time = startTime + local;

    if (BUG) {
      // Die alte Rechnung: Phase aus der absoluten Uhr. `dt` wird auf null
      // gesetzt, damit die fortgeschriebene Phase stehen bleibt, und `time`
      // trägt die Schwingung — genau wie vorher.
      const gait = Math.min(1, speed / 6);
      const swing = Math.sin(time * 9 * Math.max(0.35, gait)) * 0.65 * gait;
      rig.update({ speed, attackPhase: -1, pickupPhase: -1, dead: false, time, dt: 0 });
      // Von Hand überschreiben, was die Fabrik jetzt richtig macht.
      rig.root.traverse((o) => {
        if (o.children.length === 1 && o.children[0] instanceof THREE.Mesh) {
          o.rotation.x = swing;
        }
      });
    } else {
      rig.update({ speed, attackPhase: -1, pickupPhase: -1, dead: false, time, dt: DT });
    }

    const p = pose(rig);
    if (prev) worst = Math.max(worst, maxDelta(p, prev));
    prev = p;
  }

  rig.dispose();
  return worst;
}

console.log(`Aurelith — Laufbewegung${BUG ? '  [Gegenprobe: alte Rechnung]' : ''}\n`);

// --- Gleichmäßiges Tempo ---------------------------------------------------
//
// Ohne Tempowechsel gibt es keinen Frequenzwechsel, also auch mit der alten
// Rechnung keinen Sprung. Der Fall ist trotzdem wichtig: er zeigt, dass die
// Grenze überhaupt einzuhalten ist.

console.log('Gleichmaessiges Tempo');
for (const start of [0, 300, 1800]) {
  const worst = run(start, () => 5);
  check(
    worst <= STEP_LIMIT,
    `nach ${(start / 60).toFixed(0)} Minuten Laufzeit`,
    `groesster Sprung ${worst.toFixed(3)} rad`,
  );
}

// --- Richtungswechsel ------------------------------------------------------
//
// Beim Wechsel der Richtung bricht das Tempo kurz ein und läuft wieder hoch.
// Die Rampen entsprechen ACCEL_TIME und DECEL_TIME aus der Steuerung — dort
// springt nichts, das Tempo ändert sich stetig.

console.log('\nRichtungswechsel');
const wende = (t: number): number => {
  if (t < 1) return 5;
  if (t < 1.2) return 5 - (t - 1) * (4 / 0.2); // abbremsen in 0,2 s auf 1
  if (t < 1.34) return 1 + (t - 1.2) * (4 / 0.14); // anfahren in 0,14 s auf 5
  return 5;
};
for (const start of [0, 300, 1800]) {
  const worst = run(start, wende);
  check(
    worst <= STEP_LIMIT,
    `nach ${(start / 60).toFixed(0)} Minuten Laufzeit`,
    `groesster Sprung ${worst.toFixed(3)} rad`,
  );
}

// --- Anhalten und Anlaufen -------------------------------------------------

console.log('\nAnhalten und wieder anlaufen');
const halt = (t: number): number => {
  if (t < 1) return 5;
  if (t < 1.2) return 5 - (t - 1) * (5 / 0.2);
  if (t < 2) return 0;
  if (t < 2.14) return (t - 2) * (5 / 0.14);
  return 5;
};
for (const start of [0, 1800]) {
  const worst = run(start, halt);
  check(
    worst <= STEP_LIMIT,
    `nach ${(start / 60).toFixed(0)} Minuten Laufzeit`,
    `groesster Sprung ${worst.toFixed(3)} rad`,
  );
}

// --- Andere Rigs -----------------------------------------------------------
//
// Vierbeiner und Krabbler rechnen ihre Phase genauso. Ein Fehler, der nur bei
// der Spielfigur behoben ist, fällt am ersten Monster wieder auf.

console.log('\nMonster-Rigs beim Tempowechsel');
if (!BUG) {
  // Echte Schlüssel aus CHARACTER_CONFIGS. Ein unbekannter Name fällt still
  // auf `player` zurück — dann prüfte man fünfmal dieselbe Figur und läse
  // fünfmal denselben Wert.
  for (const key of ['mob_mote', 'mob_pup', 'mob_boar', 'mob_crawler', 'mob_warden']) {
    const rig = createRig(key, new THREE.MeshBasicMaterial());
    let prev: number[] | null = null;
    let worst = 0;
    for (let i = 0; i < 240; i++) {
      const local = i * DT;
      rig.update({
        speed: wende(local),
        attackPhase: -1,
        pickupPhase: -1,
        dead: false,
        time: 1800 + local,
        dt: DT,
      });
      const p = pose(rig);
      if (prev) worst = Math.max(worst, maxDelta(p, prev));
      prev = p;
    }
    rig.dispose();
    // Krabbler schwingen schneller (13 rad/s bei 0,5 Ausschlag ≈ 0,11).
    check(worst <= 0.16, `${key} bleibt stetig`, `groesster Sprung ${worst.toFixed(3)} rad`);
  }
}

// --- Aufheben --------------------------------------------------------------
//
// Die Geste soll man sehen: die Figur beugt sich, greift nach unten und steht
// danach wieder wie vorher. Gemessen wird die rechte Hand in Weltkoordinaten
// — eine Drehung in Bogenmass sagt nichts darüber, ob die Hand tatsächlich am
// Boden ankommt.

console.log('\nAufheben');
if (!BUG) {
  const rig = createRig('player', new THREE.MeshBasicMaterial());
  const stand = { speed: 0, attackPhase: -1, dead: false, dt: DT };

  /** Tiefster Punkt der rechten Hand über den Verlauf einer Phase. */
  const handHoehe = (phase: number): number => {
    rig.update({ ...stand, pickupPhase: phase, time: 10 });
    rig.root.updateMatrixWorld(true);
    let tiefste = Infinity;
    rig.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const p = new THREE.Vector3();
      o.getWorldPosition(p);
      tiefste = Math.min(tiefste, p.y);
    });
    return tiefste;
  };

  const ruhe = handHoehe(-1);
  const mitte = handHoehe(0.5);
  check(mitte < ruhe - 0.1, 'in der Mitte der Geste greift die Figur nach unten',
    `${ruhe.toFixed(2)} → ${mitte.toFixed(2)}`);

  // Anfang und Ende sind die Ruhestellung — sonst ruckt es beim Übergang.
  const anfang = handHoehe(0);
  const ende = handHoehe(1);
  check(Math.abs(anfang - ruhe) < 0.01, 'am Anfang steht sie noch gerade');
  check(Math.abs(ende - ruhe) < 0.01, 'und am Ende wieder');

  // Gegenprobe: ohne Geste passiert nichts. Ohne sie zeigte die Prüfung oben
  // nur, dass die Figur überhaupt Teile hat, die tief liegen.
  check(Math.abs(handHoehe(-1) - ruhe) < 1e-6, 'ohne Geste bleibt alles, wie es ist');

  rig.dispose();
}

console.log(
  `\n${failures === 0 ? 'Alle Pruefungen bestanden.' : `${failures} Pruefung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
