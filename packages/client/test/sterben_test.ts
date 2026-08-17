/**
 * Was passiert, wenn ein Wesen stirbt? — ohne GPU, ohne Browser.
 *
 * Zwei Behauptungen, und beide waren einmal falsch:
 *
 *   1. **Jedes Wesen fällt um.** Die Rigs haben dafür zwei Wege: Figuren und
 *      Banditen kippen nach vorn (`rotation.x`), Vierbeiner und Kriecher zur
 *      Seite beziehungsweise auf den Rücken (`rotation.z`). Ein Rig, das im
 *      Tod dieselbe Haltung behält wie im Leben, sieht aus wie ein Fehler im
 *      Server — man schlägt zu, das Leben ist bei null, und das Wesen steht.
 *   2. **Die Weltansicht fasst einen Kadaver nicht an.** Sie dreht sonst eine
 *      übriggebliebene Querlage vom Fluggerät zurück, und genau das griff auch
 *      bei den Toten: der erschlagene Distelkeiler wurde im selben Bild wieder
 *      aufgestellt. Dass Figuren weiter ordentlich umfielen, machte es zur
 *      Sorte Fehler, die man für eine fehlende Animation hält.
 *
 *   npx tsx packages/client/test/sterben_test.ts
 */

import * as THREE from 'three';
import { ModelRegistry } from '../src/render/modelRegistry.ts';
import { rigLage } from '../src/render/worldView.ts';
import type { RigState } from '../src/render/rigs.ts';

let failures = 0;
function check(ok: boolean, was: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${was}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('Aurelith — Sterben\n');

/** Der Ruhezustand: lebendig, stehend, ohne Schlag. */
const RUHE: RigState = {
  speed: 0,
  attackPhase: -1,
  pickupPhase: -1,
  dead: false,
  time: 0,
  dt: 0.05,
};

console.log('Jedes Wesen fällt um');

const registry = new ModelRegistry();

/** Wie weit das Rig aus der Senkrechten kippt, in Bogenmass. */
function kippung(schluessel: string, tot: boolean): number {
  const rig = registry.createRig(schluessel);
  // Erst ein lebender Schritt: die Rigs setzen ihre Haltung beim Aufstehen
  // zurück, und ohne ihn prüfte man die Ausgangslage statt der Wirkung.
  rig.update(RUHE);
  rig.update({ ...RUHE, dead: tot });
  const { x, z } = rig.root.rotation;
  rig.dispose();
  return Math.max(Math.abs(x), Math.abs(z));
}

/*
 * Alle Wesen, die auf einer Karte stehen — und nicht nur das eine, bei dem es
 * aufgefallen ist. Der Distelkeiler war der Vierbeiner; der Höhlenkriecher
 * hatte denselben Fehler und wäre einzeln geprüft nie aufgefallen.
 */
const WESEN = ['mob_pup', 'mob_boar', 'mob_bandit', 'mob_crawler', 'mob_warden', 'player'];
for (const schluessel of WESEN) {
  const tot = kippung(schluessel, true);
  check(tot > 1, `${schluessel} liegt im Tod`, `${tot.toFixed(2)} rad`);
}

/*
 * Die Gegenprobe: lebendig steht dasselbe Rig aufrecht. Ohne sie ginge auch
 * eine Fassung durch, in der ein Wesen dauerhaft auf der Seite liegt — und die
 * Prüfung darüber wäre für jedes Rig richtig und trotzdem wertlos.
 */
let schlimmstesLebend = 0;
for (const schluessel of WESEN) {
  schlimmstesLebend = Math.max(schlimmstesLebend, kippung(schluessel, false));
}
check(schlimmstesLebend < 0.35, 'und lebendig steht jedes aufrecht', `${schlimmstesLebend.toFixed(2)} rad`);

/*
 * Das Irrlicht schwebt und hat keine Achse, um die es fallen könnte — es
 * schrumpft und sackt ab. Es steht deshalb bewusst **nicht** in der Liste
 * oben; hier steht, dass das Absicht ist und nicht Vergessen.
 */
const irrlicht = kippung('mob_mote', true);
check(irrlicht < 0.35, 'das Irrlicht fällt nicht um, es sackt zusammen', `${irrlicht.toFixed(2)} rad`);

/*
 * --- Und keines verschiebt seine Wurzel ------------------------------------
 *
 * `root.position` gehört der **Weltansicht**: sie schreibt dort in jedem Bild
 * die Stelle hinein, an der das Wesen in der Welt steht. Ein Rig, das dieselbe
 * Zahl anfasst, überschreibt sie — und das ist keine Theorie: der
 * Höhlenkriecher tat es (`root.position.y = 0` im Leben, `0.42 * s` im Tod)
 * und war damit im Spiel **unsichtbar**. Auf einer Wiese vier Meter über null
 * steckte er vier Meter tief im Boden; Namensschild und Schadenszahlen kamen
 * an, zu sehen war nichts.
 *
 * Geprüft wird deshalb für jedes Rig und in beiden Zuständen. Wer eine Haltung
 * braucht, die das Wesen hebt oder senkt, verschiebt `body` — das ist der
 * Knoten, der dafür da ist.
 */
console.log('\nKein Rig verschiebt seine Wurzel');

let groessterVersatz = 0;
let schuldiger = '';
for (const schluessel of [...WESEN, 'mob_mote']) {
  for (const tot of [false, true]) {
    const rig = registry.createRig(schluessel);
    rig.update(RUHE);
    rig.update({ ...RUHE, dead: tot });
    const versatz = rig.root.position.length();
    if (versatz > groessterVersatz) {
      groessterVersatz = versatz;
      schuldiger = `${schluessel}${tot ? ' (tot)' : ''}`;
    }
    rig.dispose();
  }
}
check(
  groessterVersatz === 0,
  'die Wurzel bleibt, wo die Weltansicht sie hingesetzt hat',
  schuldiger === '' ? 'keines' : `${schuldiger} um ${groessterVersatz.toFixed(2)}`,
);

/*
 * Die Gegenprobe: der Kadaver muss trotzdem **über** dem Boden liegen. Ohne
 * sie wäre die Prüfung oben mit einem Rig zufrieden, das gar nichts tut und
 * das tote Tier im Boden versenkt — genau der Anblick, den es zu vermeiden
 * gilt, nur mit einer anderen Ursache.
 */
let tiefsterKadaver = 0;
let tiefstes = '';
for (const schluessel of WESEN) {
  const rig = registry.createRig(schluessel);
  rig.update(RUHE);
  rig.update({ ...RUHE, dead: true });
  rig.root.updateMatrixWorld(true);
  const unten = new THREE.Box3().setFromObject(rig.root).min.y;
  if (unten < tiefsterKadaver) {
    tiefsterKadaver = unten;
    tiefstes = schluessel;
  }
  rig.dispose();
}
check(
  tiefsterKadaver > -0.6,
  'und jeder Kadaver liegt auf dem Boden statt darin',
  tiefstes === '' ? 'keiner sackt ab' : `${tiefstes} bei ${tiefsterKadaver.toFixed(2)}`,
);

console.log('\nDie Weltansicht fasst einen Kadaver nicht an');

check(rigLage('', true) === 'rig', 'ein toter Läufer behält die Haltung seines Rigs');
check(rigLage('flug_besen', true) === 'rig', 'und ein toter Flieger auch');

// Die Gegenprobe: bei einem lebenden Wesen greift die Weltansicht sehr wohl —
// sonst bliebe die Querlage nach dem Absteigen für immer stehen.
check(rigLage('', false) === 'gerade', 'ein lebender Läufer wird geradegestellt');
check(rigLage('flug_board', false) === 'flug', 'und ein fliegender in die Kurve gelegt');

console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
