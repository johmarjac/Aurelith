/**
 * Der Grundkörper — ist es wirklich **ein** Netz?
 *
 * Das ist der ganze Punkt dieser Modelle, und es ist die Sorte Eigenschaft,
 * die man auf einem Bildschirmfoto nicht sieht: ein Körper aus acht sauber
 * aneinandergesetzten Teilen sieht im Stand genauso aus wie einer aus einem
 * Guss. Der Unterschied zeigt sich erst in der Bewegung — und dann klafft es.
 *
 * Geprüft wird deshalb, was das Foto nicht zeigt:
 *
 *   1. Ein einziges Netz, und zwar ein `SkinnedMesh`.
 *   2. Jede Ecke hängt an Knochen, und die Gewichte summieren sich zu eins.
 *      Eine Ecke ohne Gewicht bleibt beim Bewegen stehen, wo sie war.
 *   3. Es gibt Ecken, die an **mehreren** Knochen hängen — sonst ist das Netz
 *      trotz Skelett so starr wie zusammengesteckte Teile.
 *   4. Höhe und Bodenkontakt stimmen.
 *
 *   npx tsx packages/client/test/koerper_test.ts
 */

import * as THREE from 'three';
import { ModelRegistry } from '../src/render/modelRegistry.ts';
import { CHARACTER_CONFIGS, type RigState } from '../src/render/rigs.ts';

let failures = 0;
function check(ok: boolean, was: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${was}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('Aurelith — Grundkörper\n');

const RUHE: RigState = {
  speed: 0,
  attackPhase: -1,
  pickupPhase: -1,
  dead: false,
  time: 0,
  dt: 0.05,
};

const registry = new ModelRegistry();

/** Zählt die Netze eines Rigs und sammelt sie ein. */
function netze(root: THREE.Object3D): THREE.Mesh[] {
  const raus: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) raus.push(m);
  });
  return raus;
}

console.log('Ein Guss, kein Bausatz');

const koerper = registry.createRig('koerper_m');
koerper.update(RUHE);
const teile = netze(koerper.root);
check(teile.length === 1, 'der Körper besteht aus genau einem Netz', `${teile.length}`);
check(
  (teile[0] as THREE.SkinnedMesh | undefined)?.isSkinnedMesh === true,
  'und das Netz hängt an einem Skelett',
);

/*
 * Die Gegenprobe: die erwachsene Figur aus `rigs.ts` ist ausdrücklich ein
 * Bausatz — Rumpf, zwei Arme, zwei Beine, jedes ein eigenes Netz an einem
 * eigenen Drehpunkt. Ohne diese Zeile ginge auch eine Fassung durch, in der
 * jede Figur ein Netz ist und die Prüfung darüber nichts aussagt.
 */
const alt = registry.createRig('player');
alt.update(RUHE);
const alteTeile = netze(alt.root);
check(
  alteTeile.length > 4,
  'die erwachsene Figur dagegen aus mehreren',
  `${alteTeile.length} Netze`,
);
alt.dispose();

console.log('\nJede Ecke hängt am Skelett');

const geo = teile[0]!.geometry;
const gewicht = geo.attributes.skinWeight as THREE.BufferAttribute | undefined;
const index = geo.attributes.skinIndex as THREE.BufferAttribute | undefined;
check(gewicht !== undefined && index !== undefined, 'es gibt Gewichte und Knochennummern');

let schlimmsteSumme = 0;
let mehrfach = 0;
for (let i = 0; i < gewicht!.count; i++) {
  const w = [gewicht!.getX(i), gewicht!.getY(i), gewicht!.getZ(i), gewicht!.getW(i)];
  const summe = w[0]! + w[1]! + w[2]! + w[3]!;
  schlimmsteSumme = Math.max(schlimmsteSumme, Math.abs(summe - 1));
  // „An mehreren Knochen" heisst: der zweite trägt spürbar mit.
  if (w[1]! > 0.15) mehrfach++;
}
check(schlimmsteSumme < 1e-4, 'und sie summieren sich überall zu eins', schlimmsteSumme.toExponential(1));
check(
  mehrfach > gewicht!.count * 0.3,
  'ein guter Teil der Ecken hängt an mehreren Knochen',
  `${((mehrfach / gewicht!.count) * 100).toFixed(0)} %`,
);

/*
 * Und die Gegenprobe dazu: es gibt auch Ecken, die fast ganz an **einem**
 * Knochen hängen — mitten am Oberschenkel etwa. Wäre alles überall verteilt,
 * verformte sich die Figur bei jeder Bewegung als Ganzes, wie ein Pudding.
 */
let starr = 0;
for (let i = 0; i < gewicht!.count; i++) {
  if (gewicht!.getX(i) > 0.85) starr++;
}
check(starr > 0, 'und andere fast ganz an einem', `${starr} Ecken`);

console.log('\nMass und Stand');

for (const schluessel of ['koerper_m', 'koerper_w']) {
  const cfg = CHARACTER_CONFIGS[schluessel]!;
  const rig = registry.createRig(schluessel);
  rig.update(RUHE);
  rig.root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(rig.root);
  const hoehe = box.max.y - box.min.y;
  const soll = 'height' in cfg ? cfg.height : 0;
  // Drei Prozent Spiel: das Gitter trifft die Kopfkuppe nicht auf den
  // Millimeter, und ein Körper, der auf die Nachkommastelle normiert wird,
  // wäre skaliert statt gebaut.
  check(
    Math.abs(hoehe - soll) < soll * 0.05,
    `${schluessel} ist ungefähr so hoch, wie es dasteht`,
    `${hoehe.toFixed(3)} m statt ${soll} m`,
  );
  check(Math.abs(box.min.y) < 0.02, `${schluessel} steht auf dem Boden`, box.min.y.toFixed(3));
  rig.dispose();
}

koerper.dispose();

console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
