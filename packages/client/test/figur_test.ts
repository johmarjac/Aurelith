/**
 * Die Grundkörper im Flyff-Stil — stimmen Mass und Gelenke?
 *
 * Drei Behauptungen, und die erste war schon einmal falsch:
 *
 *   1. **`height` heisst Höhe.** Die Masse im Bauer sind Verhältnisse, und
 *      Verhältnisse summieren sich nicht von selbst zu eins: Haar und Füsse
 *      ragen über die gerechneten Grenzen hinaus, der Kopf taucht in die
 *      Schultern ein. Beim ersten Anlauf kam eine Figur von 1,37 m heraus, wo
 *      1,52 m stehen sollten.
 *   2. **Sie steht auf dem Boden.** Eine Figur, deren Füsse unter null liegen,
 *      versinkt im Gelände; eine, die darüber endet, schwebt. Beides fällt im
 *      Spiel erst auf, wenn jemand danebensteht.
 *   3. **Die Gelenke greifen.** Ein Rig, das sich beim Laufen nicht bewegt,
 *      ist ein Standbild — und sieht auf einem Bildschirmfoto genauso richtig
 *      aus wie ein funktionierendes.
 *
 *   npx tsx packages/client/test/figur_test.ts
 */

import * as THREE from 'three';
import { ModelRegistry } from '../src/render/modelRegistry.ts';
import { CHARACTER_CONFIGS, type RigState } from '../src/render/rigs.ts';

let failures = 0;
function check(ok: boolean, was: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${was}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('Aurelith — Jugendliche\n');

const RUHE: RigState = {
  speed: 0,
  attackPhase: -1,
  pickupPhase: -1,
  dead: false,
  time: 0,
  dt: 0.05,
};

const registry = new ModelRegistry();

/** Der umschliessende Kasten nach einem Ruheschritt. */
function kasten(schluessel: string): { box: THREE.Box3; rig: ReturnType<ModelRegistry['createRig']> } {
  const rig = registry.createRig(schluessel);
  rig.update(RUHE);
  rig.root.updateMatrixWorld(true);
  return { box: new THREE.Box3().setFromObject(rig.root), rig };
}

console.log('Die Figur ist so hoch, wie sie sagt');

for (const schluessel of ['jugend_m', 'jugend_w']) {
  const cfg = CHARACTER_CONFIGS[schluessel]!;
  const { box, rig } = kasten(schluessel);
  const hoehe = box.max.y - box.min.y;
  const soll = 'height' in cfg ? cfg.height : 0;
  check(
    Math.abs(hoehe - soll) < 0.01,
    `${schluessel} misst, was in der Beschreibung steht`,
    `${hoehe.toFixed(3)} m statt ${soll} m`,
  );
  // Und sie steht auf dem Boden. Ein paar Zentimeter Spiel für die Ferse, die
  // beim Ruheschritt eine Spur einsinkt — mehr wäre ein Fehler.
  check(
    Math.abs(box.min.y) < 0.08,
    `${schluessel} steht auf dem Boden`,
    `Unterkante ${box.min.y.toFixed(3)} m`,
  );
  rig.dispose();
}

/*
 * Die Gegenprobe zur Höhe: sie muss überhaupt an `height` hängen. Ohne diese
 * Zeile ginge auch ein Bauer durch, der jede Figur auf eine feste Grösse
 * normiert — die Prüfungen darüber wären dann für genau die eine Zahl richtig.
 */
const kleinerRegistry = new ModelRegistry();
const zwerg = kleinerRegistry.createRig('jugend_m');
zwerg.update(RUHE);
zwerg.root.updateMatrixWorld(true);
const normal = new THREE.Box3().setFromObject(zwerg.root);
zwerg.dispose();
const gross = kasten('jugend_w');
check(
  Math.abs((normal.max.y - normal.min.y) - (gross.box.max.y - gross.box.min.y)) > 0.02,
  'und zwei verschieden hohe Figuren sind verschieden hoch',
  `${(normal.max.y - normal.min.y).toFixed(2)} m ↔ ${(gross.box.max.y - gross.box.min.y).toFixed(2)} m`,
);
gross.rig.dispose();

console.log('\nDer Kopf ist gross — das ist der ganze Stil');

/*
 * Gemessen wird die **Kopfbreite im Verhältnis zur Körperhöhe**.
 *
 * Den Kopf gibt das Rig nicht als eigenes Teil heraus — er steckt mit Rumpf
 * und Haar in einer verschmolzenen Geometrie. Er ist aber das Oberste, was die
 * Figur hat: alles im obersten Zehntel gehört zu ihm — bei der erwachsenen
 * Figur reichte ein Fünftel schon in die Schultern, und gemessen wurde dann
 * deren Breite statt der des Kopfes. Von dort die grösste
 * waagerechte Ausdehnung, geteilt durch die Höhe, und man hat die Zahl, um die
 * es in diesem Stil geht.
 *
 * Die erwachsene Figur aus `rigs.ts` ist der Massstab dagegen. Liefe der Stil
 * auseinander — würde jemand die Jugendlichen „aufräumen", bis sie wie kleine
 * Erwachsene aussehen —, stünden hier zwei ähnliche Zahlen, und genau das
 * fällt sonst niemandem auf.
 */
function kopfAnteil(schluessel: string): number {
  const { box, rig } = kasten(schluessel);
  const hoehe = box.max.y - box.min.y;
  const grenze = box.max.y - hoehe * 0.1;
  let links = Infinity;
  let rechts = -Infinity;
  const p = new THREE.Vector3();
  rig.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      if (p.y < grenze) continue;
      links = Math.min(links, p.x);
      rechts = Math.max(rechts, p.x);
    }
  });
  rig.dispose();
  return (rechts - links) / hoehe;
}
const jung = kopfAnteil('jugend_m');
const erwachsen = kopfAnteil('player');
check(
  jung > erwachsen * 1.2,
  'sein Kopf nimmt im Bild deutlich mehr Platz ein als der einer erwachsenen Figur',
  `${(jung * 100).toFixed(0)} % ↔ ${(erwachsen * 100).toFixed(0)} % der Höhe`,
);

console.log('\nDie Gelenke greifen');

/*
 * Zwei Schritte im Laufen, und der Körper steht danach anders da. Gemessen am
 * umschliessenden Kasten: die Arme schwingen, also ändert sich seine Tiefe.
 */
const laeufer = registry.createRig('jugend_m');
laeufer.update({ ...RUHE, speed: 5, dt: 0.05 });
laeufer.root.updateMatrixWorld(true);
const vorher = new THREE.Box3().setFromObject(laeufer.root).clone();
for (let i = 0; i < 4; i++) laeufer.update({ ...RUHE, speed: 5, time: 0.05 * i, dt: 0.05 });
laeufer.root.updateMatrixWorld(true);
const nachher = new THREE.Box3().setFromObject(laeufer.root);
const bewegt = Math.abs((nachher.max.z - nachher.min.z) - (vorher.max.z - vorher.min.z));
check(bewegt > 0.02, 'im Laufen schwingen die Glieder', `${bewegt.toFixed(3)} m Unterschied`);

// Gegenprobe: im Stand bewegt sich (fast) nichts. „Fast", weil die Figur
// atmet — ohne das sähe sie aus wie ein Möbelstück, und ein Test, der das
// verbietet, verböte genau die richtige Lösung.
laeufer.update({ ...RUHE, speed: 0, time: 3, dt: 0.05 });
laeufer.root.updateMatrixWorld(true);
const still1 = new THREE.Box3().setFromObject(laeufer.root).clone();
laeufer.update({ ...RUHE, speed: 0, time: 3.05, dt: 0.05 });
laeufer.root.updateMatrixWorld(true);
const still2 = new THREE.Box3().setFromObject(laeufer.root);
const ruhig = Math.abs((still2.max.z - still2.min.z) - (still1.max.z - still1.min.z));
check(ruhig < 0.005, 'im Stand bleiben sie liegen', `${ruhig.toFixed(4)} m Unterschied`);
laeufer.dispose();

console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
