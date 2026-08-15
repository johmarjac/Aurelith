/**
 * Um welche Achse kippt die Nase? — ohne GPU, ohne Browser.
 *
 * Das ist die Sorte Fehler, die nicht abstürzt und nicht auffällt, solange
 * man in eine Richtung schaut: die Neigung wird in three.js voreingestellt
 * **nach** der Drehung um Y angewandt, also um die Achse der Welt. Wer nach
 * Norden fliegt, sieht das Richtige; wer nach Osten fliegt, sieht statt einer
 * gehobenen Nase eine Schräglage, und bei genau 90 Grad Kurs kippt die Figur
 * seitwärts, ohne einen Grad zu steigen.
 *
 * Geprüft wird deshalb nicht der Winkel, sondern **wohin die Figur zeigt**:
 * ihre Vorderseite, in Weltkoordinaten, bei vier Kursen. Genau die Zahl, an
 * der man den Unterschied zwischen Nicken und Rollen festmachen kann.
 *
 *   npx tsx packages/client/test/flugachse_test.ts
 */

import * as THREE from 'three';
import { ModelRegistry } from '../src/render/modelRegistry.ts';

let failures = 0;
let checks = 0;

function check(ok: boolean, what: string, detail = ''): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`  FEHLGESCHLAGEN: ${what}${detail ? ` — ${detail}` : ''}`);
  }
}

function checkNear(actual: number, expected: number, tol: number, what: string): void {
  checks++;
  if (Math.abs(actual - expected) > tol) {
    failures++;
    console.log(
      `  FEHLGESCHLAGEN: ${what} (ist ${actual.toFixed(3)}, erwartet ${expected} ± ${tol})`,
    );
  }
}

/**
 * Wohin die Vorderseite zeigt, wenn eine Figur auf `kurs` steht und ihre Nase
 * um `nase` hebt.
 *
 * Dieselben zwei Zuweisungen wie im Renderer: `rotation.y` ist der Kurs,
 * `rotation.x` die **negative** Neigung (eine Drehung um +X nimmt die
 * Vorderseite nach unten). Die Vorderseite eines Rigs ist die lokale +Z-Achse
 * — siehe `worldView`, wo `rotation.y = yaw` zur Blickrichtung
 * `(sin yaw, cos yaw)` wird.
 */
function vorderseite(kurs: number, nase: number, ordnung: THREE.EulerOrder): THREE.Vector3 {
  const o = new THREE.Object3D();
  o.rotation.order = ordnung;
  o.rotation.y = kurs;
  o.rotation.x = -nase;
  o.updateMatrixWorld(true);
  return new THREE.Vector3(0, 0, 1).applyQuaternion(o.quaternion);
}

console.log('Aurelith — die Achse der Nase\n');

const NASE = 0.6; // gut 34 Grad hinauf
const KURSE: Array<[number, string]> = [
  [0, 'Norden'],
  [Math.PI / 2, 'Osten'],
  [Math.PI, 'Süden'],
  [-Math.PI / 2, 'Westen'],
];

// --- Die Nase zeigt hinauf, in jeder Himmelsrichtung ------------------------
//
// Der senkrechte Anteil der Vorderseite ist `sin(nase)` — unabhängig vom Kurs.
// Das ist die Aussage: die Neigung dreht um die **mitgedrehte** Querachse.
for (const [kurs, name] of KURSE) {
  const v = vorderseite(kurs, NASE, 'YXZ');
  checkNear(v.y, Math.sin(NASE), 0.001, `nach ${name} hebt die Nase gleich weit`);
}

// Und der waagerechte Anteil zeigt weiter in den Kurs — die Figur fliegt
// dorthin, wo sie hinsieht, und nicht daneben.
for (const [kurs, name] of KURSE) {
  const v = vorderseite(kurs, NASE, 'YXZ');
  const laenge = Math.hypot(v.x, v.z);
  checkNear(v.x / laenge, Math.sin(kurs), 0.001, `nach ${name} stimmt die Richtung (x)`);
  checkNear(v.z / laenge, Math.cos(kurs), 0.001, `nach ${name} stimmt die Richtung (z)`);
}

// --- Gegenprobe: mit der Voreinstellung stimmt genau ein Kurs ---------------
//
// Ohne diese Prüfung liesse sich nicht sagen, ob oben die Reihenfolge geprüft
// wurde oder bloss die Trigonometrie: nach Norden ergeben beide dasselbe.
{
  const norden = vorderseite(0, NASE, 'XYZ');
  checkNear(norden.y, Math.sin(NASE), 0.001, 'nach Norden sieht auch XYZ richtig aus');

  const osten = vorderseite(Math.PI / 2, NASE, 'XYZ');
  check(
    Math.abs(osten.y) < 0.001,
    'nach Osten gewinnt XYZ keinen Grad Höhe — das war der Fehler',
    `y = ${osten.y.toFixed(3)}`,
  );
}

/*
 * --- Und der Renderer benutzt das auch --------------------------------------
 *
 * Oben steht, welche Reihenfolge stimmt; hier steht, dass die Figuren sie
 * bekommen. Ohne diese Prüfung liesse sich die Zeile in `ModelRegistry`
 * löschen, und der Test bliebe grün — er prüfte dann nur noch three.js.
 */
{
  const registry = new ModelRegistry();
  const rig = registry.createRig('player');
  check(
    rig.root.rotation.order === 'YXZ',
    'eine frische Figur kippt um ihre eigene Querachse',
    `Reihenfolge ${rig.root.rotation.order}`,
  );
  rig.dispose();
}

console.log(`\n${checks} Prüfungen, ${failures} fehlgeschlagen`);
process.exit(failures === 0 ? 0 : 1);
