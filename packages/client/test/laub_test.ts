/**
 * Laubkarten — liegt die richtige Kachel auf der richtigen Karte?
 *
 * Der Atlas ist 2×2, und die Bildzeilen laufen von oben nach unten, während
 * die Texturachse von unten nach oben läuft. Genau an dieser Umkehrung geht es
 * schief, und zwar **still**: der Busch trägt dann Gras und das Gras Blätter.
 * Man sieht es sofort, sobald man hinschaut — aber nur, wenn jemand hinschaut.
 *
 * Geprüft wird ohne Browser: `laubKarte` rechnet nur Bildkoordinaten aus, und
 * die Zeichenleinwand für den Atlas selbst kommt hier gar nicht vor.
 *
 *   npx tsx packages/client/test/laub_test.ts
 */

import * as THREE from 'three';
import { LAUB_KACHEL, laubKarte, laubNormalen, type LaubKachel } from '../src/render/laub.ts';

let failures = 0;
function check(ok: boolean, was: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${was}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('Aurelith — Laubkarten\n');

console.log('Jede Kachel liegt in ihrem Viertel');

/** Der Bereich, den die Bildkoordinaten einer Karte tatsächlich abdecken. */
function spanne(kachel: LaubKachel): { u0: number; u1: number; v0: number; v1: number } {
  const geo = laubKarte(kachel, 1, 1);
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (let i = 0; i < uv.count; i++) {
    u0 = Math.min(u0, uv.getX(i));
    u1 = Math.max(u1, uv.getX(i));
    v0 = Math.min(v0, uv.getY(i));
    v1 = Math.max(v1, uv.getY(i));
  }
  geo.dispose();
  return { u0, u1, v0, v1 };
}

const nah = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

for (const kachel of Object.keys(LAUB_KACHEL) as LaubKachel[]) {
  const [spalte, zeile] = LAUB_KACHEL[kachel];
  const s = spanne(kachel);
  // Die Zeile kehrt sich um: Bildzeile 0 ist die **obere** Hälfte der Textur.
  const vSoll = (1 - zeile) * 0.5;
  check(
    nah(s.u0, spalte * 0.5) && nah(s.u1, spalte * 0.5 + 0.5),
    `${kachel}: waagerecht im richtigen Viertel`,
    `u ${s.u0.toFixed(2)}…${s.u1.toFixed(2)}`,
  );
  check(
    nah(s.v0, vSoll) && nah(s.v1, vSoll + 0.5),
    `${kachel}: senkrecht im richtigen Viertel`,
    `v ${s.v0.toFixed(2)}…${s.v1.toFixed(2)}`,
  );
}

/*
 * Die Gegenprobe: keine zwei Kacheln decken denselben Bereich.
 *
 * Ohne sie ginge auch eine Fassung durch, in der alle vier auf demselben
 * Viertel liegen — jede Prüfung darüber wäre dann für genau eine Kachel richtig
 * und für die anderen drei zufällig auch, wenn die Zahlen zusammenfallen.
 */
const bereiche = (Object.keys(LAUB_KACHEL) as LaubKachel[]).map((k) => {
  const s = spanne(k);
  return `${s.u0.toFixed(2)}/${s.v0.toFixed(2)}`;
});
check(
  new Set(bereiche).size === bereiche.length,
  'und keine zwei Kacheln liegen übereinander',
  bereiche.join(' '),
);

console.log('\nDie Karte steht auf dem Boden');

/*
 * Der Ursprung liegt unten in der Mitte.
 *
 * Ein Grasbüschel, dessen Ursprung in der Mitte läge, stünde zur Hälfte im
 * Erdreich — oder, mit `snapToGround`, zur Hälfte darüber in der Luft. Auf
 * einer Wiese mit vierhundert Büscheln sieht man das aus jeder Entfernung.
 */
const karte = laubKarte('gras', 0.8, 0.6);
const kasten = new THREE.Box3().setFromBufferAttribute(
  karte.attributes.position as THREE.BufferAttribute,
);
check(nah(kasten.min.y, 0), 'die Unterkante liegt bei null', kasten.min.y.toFixed(3));
check(nah(kasten.max.y, 0.6), 'und die Oberkante auf der Höhe der Karte', kasten.max.y.toFixed(3));
check(
  nah(kasten.min.x, -0.4) && nah(kasten.max.x, 0.4),
  'waagerecht steht sie mittig',
  `${kasten.min.x.toFixed(2)}…${kasten.max.x.toFixed(2)}`,
);

console.log('\nDie Normalen zeigen nach aussen');

/*
 * Sonst wäre eine seitlich stehende Karte von oben schwarz: ihre eigene
 * Normale liegt in der Kartenebene und zeigt nach vorn, nicht nach oben.
 * `laubNormalen` ersetzt sie durch die einer Kugel um die Mitte des Busches.
 */
const gedreht = laubKarte('blatt', 1, 1);
gedreht.rotateY(Math.PI * 0.5);
laubNormalen(gedreht, 0.5);
const nor = gedreht.attributes.normal as THREE.BufferAttribute;
const pos = gedreht.attributes.position as THREE.BufferAttribute;
let schlechteste = 1;
for (let i = 0; i < nor.count; i++) {
  const nach = new THREE.Vector3(pos.getX(i), pos.getY(i) - 0.5, pos.getZ(i)).normalize();
  const n = new THREE.Vector3(nor.getX(i), nor.getY(i), nor.getZ(i));
  schlechteste = Math.min(schlechteste, n.dot(nach));
}
check(schlechteste > 0.999, 'jede Normale zeigt von der Mitte weg', schlechteste.toFixed(4));

// Gegenprobe: **vor** dem Aufruf zeigen sie alle in dieselbe Richtung. Ohne
// sie prüfte die Zeile darüber nur, dass Vektoren normiert sind.
const roh = laubKarte('blatt', 1, 1);
roh.rotateY(Math.PI * 0.5);
const rohNor = roh.attributes.normal as THREE.BufferAttribute;
const erste = new THREE.Vector3(rohNor.getX(0), rohNor.getY(0), rohNor.getZ(0));
let gleich = true;
for (let i = 1; i < rohNor.count; i++) {
  const n = new THREE.Vector3(rohNor.getX(i), rohNor.getY(i), rohNor.getZ(i));
  if (n.dot(erste) < 0.999) gleich = false;
}
check(gleich, 'ohne den Aufruf zeigen sie alle gleich', erste.toArray().map((v) => v.toFixed(2)).join('/'));

console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
