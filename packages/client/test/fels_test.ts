/**
 * Findlinge — passt der Stein zu dem, was der Kern von ihm kennt?
 *
 * Ein Fels ist gewürfelt: Lappen in zufällige Richtungen, zufällig gestaucht,
 * zufällig gedreht. Genau daran ist er einmal gescheitert — bei einem
 * unglücklichen Wurf war `rock_small` mit `radius: 0.75` am Ende 2,2 Meter
 * breit und damit fast so gross wie `rock_large`, während sein Kollisionskreis
 * bei 0,85 blieb. Man lief also durch anderthalb Meter Fels hindurch.
 *
 * Deshalb steht hier als Zahl, was die Form behaupten muss:
 *
 *   1. Die Breite folgt dem verlangten Radius — bei jedem Wurf.
 *   2. Der Stein liegt im Boden und nicht darauf oder darüber.
 *   3. Er bringt Bildkoordinaten mit, und die rechnen in **Metern**: ein
 *      grosser und ein kleiner Fels haben dieselbe Körnung.
 *   4. Welches Material ein Prop braucht, sagt genau eine Stelle.
 *
 *   npx tsx packages/client/test/fels_test.ts
 */

import * as THREE from 'three';
import { baueFindling } from '../src/render/findling.ts';
import { GESTEIN_KACHEL_METER } from '../src/render/gestein.ts';
import { materialArt } from '../src/render/props.ts';

let failures = 0;
function check(ok: boolean, was: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${was}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('Aurelith — Findlinge\n');

/** Die Masse eines Findlings. */
function masse(radius: number, seed: number): {
  breite: number;
  hoehe: number;
  unten: number;
  oben: number;
  geo: THREE.BufferGeometry;
} {
  const geo = baueFindling(radius, seed);
  const kasten = new THREE.Box3().setFromBufferAttribute(
    geo.attributes.position as THREE.BufferAttribute,
  );
  return {
    breite: Math.max(kasten.max.x - kasten.min.x, kasten.max.z - kasten.min.z),
    hoehe: kasten.max.y - kasten.min.y,
    unten: kasten.min.y,
    oben: kasten.max.y,
    geo,
  };
}

console.log('Die Breite folgt dem Radius');

/*
 * Zwanzig Würfe und nicht einer. Der Fehler von damals trat bei **manchen**
 * Startwerten auf; ein einzelner Stein, der zufällig passt, beweist nichts.
 */
let schmalster = Infinity;
let breitester = 0;
for (let i = 0; i < 20; i++) {
  const m = masse(0.75, 0x1000 + i * 977);
  const verhaeltnis = m.breite / (2 * 0.75);
  schmalster = Math.min(schmalster, verhaeltnis);
  breitester = Math.max(breitester, verhaeltnis);
  m.geo.dispose();
}
check(
  schmalster > 0.75 && breitester < 1.45,
  'kein Wurf fällt aus dem Rahmen',
  `${schmalster.toFixed(2)}× bis ${breitester.toFixed(2)}×`,
);

/*
 * Die Gegenprobe: der Radius muss überhaupt etwas bewirken. Ohne sie ginge auch
 * eine Fassung durch, die jeden Stein auf dieselbe Grösse normiert — die
 * Prüfung darüber wäre dann für einen Radius richtig und für alle anderen
 * zufällig falsch.
 */
const klein = masse(0.75, 0xaa11);
const gross = masse(1.9, 0xbb22);
check(
  gross.breite > klein.breite * 2,
  'und ein grosser Fels ist wirklich grösser',
  `${klein.breite.toFixed(2)} m ↔ ${gross.breite.toFixed(2)} m`,
);

console.log('\nEr liegt im Boden');

check(gross.unten < 0, 'die Unterkante steckt im Gelände', gross.unten.toFixed(2));
check(
  gross.unten > -gross.hoehe * 0.25,
  'aber nur ein Stück davon',
  `${((-gross.unten / gross.hoehe) * 100).toFixed(0)} % der Höhe`,
);
// Gegenprobe: er ragt heraus. Ein Stein, der ganz im Boden steckt, ist keiner.
check(gross.oben > gross.hoehe * 0.7, 'und ragt heraus', gross.oben.toFixed(2));

console.log('\nDie Körnung rechnet in Metern');

/*
 * Die Bildkoordinaten kommen aus den Weltmassen geteilt durch die Kachelgrösse.
 * Bei einem vier Meter breiten Findling und einer Kachel von 1,6 Metern laufen
 * sie deshalb weit über eins hinaus — genau das ist der Unterschied zu einer
 * ausgerollten Textur, bei der jedes Modell dieselbe Kachel dehnt und der
 * grosse Fels grobkörniger aussieht als der kleine.
 */
const uv = gross.geo.attributes.uv as THREE.BufferAttribute;
let spanne = 0;
for (let i = 0; i < uv.count; i++) {
  spanne = Math.max(spanne, Math.abs(uv.getX(i)), Math.abs(uv.getY(i)));
}
check(uv !== undefined && uv.count === (gross.geo.attributes.position as THREE.BufferAttribute).count,
  'jede Ecke hat Bildkoordinaten', `${uv.count}`);
check(
  spanne > gross.breite / (2 * GESTEIN_KACHEL_METER) - 0.2,
  'und sie laufen über mehrere Kacheln',
  `bis ${spanne.toFixed(2)}`,
);

// Gegenprobe: beim kleinen Stein sind es entsprechend weniger. Wäre die Textur
// je Modell ausgerollt, stünde hier dieselbe Zahl wie oben.
const uvKlein = klein.geo.attributes.uv as THREE.BufferAttribute;
let spanneKlein = 0;
for (let i = 0; i < uvKlein.count; i++) {
  spanneKlein = Math.max(spanneKlein, Math.abs(uvKlein.getX(i)), Math.abs(uvKlein.getY(i)));
}
check(
  spanneKlein < spanne * 0.75,
  'der kleine Stein deckt weniger Kacheln ab',
  `${spanneKlein.toFixed(2)} ↔ ${spanne.toFixed(2)}`,
);

console.log('\nJedes Prop weiss, woraus es gezeichnet wird');

check(materialArt('rock_large') === 'fels', 'ein Findling bekommt Gestein');
check(materialArt('fels_schwebend') === 'fels', 'die schwebende Insel auch');
check(materialArt('bush') === 'laub', 'ein Busch bekommt Laub');
check(materialArt('tree_fir') === 'laub', 'und eine Tanne ebenso');
// Gegenprobe: nicht alles ist Fels oder Laub. Ohne sie ginge eine Fassung
// durch, die immer dasselbe zurückgibt.
check(materialArt('barrel') === 'standard', 'ein Fass bekommt das gemeinsame');
check(materialArt('gibt_es_nicht') === 'standard', 'und ein unbekanntes Modell auch');

klein.geo.dispose();
gross.geo.dispose();

console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
