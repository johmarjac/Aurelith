/**
 * Das Tor — ein Bannkreis auf dem Boden.
 *
 * Vorher stand an jedem Portal ein steinerner Bogen: ein Prop neben einer
 * unsichtbaren Zone. Beides liess sich unabhängig verschieben, beides hatte
 * eine eigene Grösse, und man lief durch eine leere Wiese, in der es dann
 * plötzlich klickte. Jetzt zeichnet der Client den Auslöser selbst — dieselbe
 * Mitte, derselbe Radius, aus derselben Zeile des Kartendokuments.
 *
 * Was hier geprüft wird, ist das, was man nicht sieht, solange es geht:
 *
 *   1. Die Scheibe folgt dem **Gelände**. Eine waagerechte Scheibe steckt im
 *      Hang zur Hälfte im Boden — genau das war der erste Anlauf.
 *   2. Sie ist so gross wie der **Auslöser** und nicht so gross wie eine
 *      Konstante im Zeichner.
 *   3. Sie **bewegt** sich, und zwar nur, wenn jemand die Uhr weiterstellt.
 *   4. Die Runentextur entsteht **einmal** für alle Tore.
 *   5. In den Karten steht kein Torbogen mehr herum.
 *
 *   npx tsx packages/client/test/portal_test.ts
 */

import type * as THREE from 'three';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let failures = 0;
function check(ok: boolean, was: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${was}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('Aurelith — Tore\n');

/*
 * Eine Leinwand aus Pappe.
 *
 * Der Runenring wird im Code auf ein `<canvas>` gemalt, und das gibt es hier
 * nicht. Statt die Zeichnung im Test auszusparen — dann prüfte niemand, ob sie
 * überhaupt stattfindet — zählt diese Attrappe mit, was der Stift tut. Sie muss
 * vor dem Import von `portal.ts` stehen: die Textur entsteht beim ersten Tor,
 * und wer danach shimmt, kommt zu spät.
 */
const stiftzug = { striche: 0, drehungen: 0, kreise: 0 };
const pappstift = {
  lineCap: '',
  lineJoin: '',
  strokeStyle: '',
  fillStyle: '',
  lineWidth: 0,
  shadowColor: '',
  shadowBlur: 0,
  clearRect(): void {},
  beginPath(): void {},
  moveTo(): void {},
  lineTo(): void {},
  arc(): void {
    stiftzug.kreise++;
  },
  stroke(): void {
    stiftzug.striche++;
  },
  fill(): void {},
  save(): void {},
  restore(): void {},
  translate(): void {},
  rotate(): void {
    stiftzug.drehungen++;
  },
};
let leinwaende = 0;
(globalThis as unknown as { document: unknown }).document = {
  createElement(art: string) {
    if (art !== 'canvas') throw new Error(`unerwartetes Element: ${art}`);
    leinwaende++;
    return { width: 0, height: 0, getContext: () => pappstift };
  },
};

// Erst jetzt, mit der Attrappe im Rücken. Die Typen kommen von oben — ein
// `import type` steht nur im Typechecker und stört die Reihenfolge nicht.
const { PortalRing } = await import('../src/render/portal.ts');

/** Die drei Lagen eines Tores, an ihrer Form auseinandergehalten. */
function lagen(ring: InstanceType<typeof PortalRing>): {
  wirbel: THREE.Mesh;
  runen: THREE.Mesh;
  saeule: THREE.Mesh;
} {
  const scheiben: THREE.Mesh[] = [];
  let saeule: THREE.Mesh | undefined;
  for (const kind of ring.root.children) {
    const mesh = kind as THREE.Mesh;
    if (mesh.geometry.type === 'CylinderGeometry') saeule = mesh;
    else scheiben.push(mesh);
  }
  if (scheiben.length !== 2 || !saeule) throw new Error('Tor hat nicht drei Lagen');
  // Die kleinere ist der Wirbel, die grössere der Runenring.
  scheiben.sort((a, b) => weite(a) - weite(b));
  return { wirbel: scheiben[0]!, runen: scheiben[1]!, saeule };
}

/** Der grösste Abstand einer Ecke von der Mitte, in der Waagerechten. */
function weite(mesh: THREE.Mesh): number {
  const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
  let max = 0;
  for (let i = 0; i < pos.count; i++) max = Math.max(max, Math.hypot(pos.getX(i), pos.getZ(i)));
  return max;
}

// ---------------------------------------------------------------------------
console.log('Der Kreis liegt auf dem Boden');

/** Ein Hang: ein Viertel Meter Anstieg je Meter nach Osten. */
const hang = (x: number, _z: number): number => x * 0.25;
const flach = (): number => 3;

const amHang = new PortalRing({ x: 10, y: hang(10, 0), z: -4 }, 4, hang);
const wirbelHang = lagen(amHang).wirbel;

{
  const pos = wirbelHang.geometry.attributes.position as THREE.BufferAttribute;
  let groesserFehler = 0;
  let tiefste = Infinity;
  let hoechste = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const wx = amHang.root.position.x + pos.getX(i);
    const wz = amHang.root.position.z + pos.getZ(i);
    const wy = amHang.root.position.y + pos.getY(i);
    groesserFehler = Math.max(groesserFehler, Math.abs(wy - (hang(wx, wz) + 0.06)));
    tiefste = Math.min(tiefste, pos.getY(i));
    hoechste = Math.max(hoechste, pos.getY(i));
  }
  check(
    groesserFehler < 1e-4,
    'jede Ecke der Scheibe liegt einen Fingerbreit über dem Gelände',
    `grösste Abweichung ${groesserFehler.toFixed(5)} m`,
  );
  /*
   * Gegenprobe: die Scheibe ist am Hang wirklich **schief**.
   *
   * Ohne sie wäre auch eine waagerechte Scheibe grün, sobald jemand die
   * Höhenfunktion ignoriert und statt dessen die Mitte nimmt — die Prüfung
   * oben vergliche dann `y` der Mitte mit `y` der Mitte. Über acht Meter
   * Durchmesser und ein Viertel Steigung müssen zwei Meter Unterschied stehen.
   */
  check(
    hoechste - tiefste > 1.8,
    'und am Hang liegt die eine Seite höher als die andere',
    `${(hoechste - tiefste).toFixed(2)} m Unterschied`,
  );
}

{
  // Und die Gegenprobe zur Gegenprobe: auf ebenem Grund ist sie eben. Sonst
  // stünde hier eine Schüssel, die zufällig am Hang richtig aussieht.
  const eben = new PortalRing({ x: 0, y: flach(), z: 0 }, 4, flach);
  const pos = lagen(eben).wirbel.geometry.attributes.position as THREE.BufferAttribute;
  let tiefste = Infinity;
  let hoechste = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    tiefste = Math.min(tiefste, pos.getY(i));
    hoechste = Math.max(hoechste, pos.getY(i));
  }
  check(
    hoechste - tiefste < 1e-4 && Math.abs(hoechste - 0.06) < 1e-4,
    'auf ebenem Grund liegt sie flach und einen Fingerbreit hoch',
    `${tiefste.toFixed(3)} bis ${hoechste.toFixed(3)} m über der Mitte`,
  );
  eben.dispose();
}

// ---------------------------------------------------------------------------
console.log('Der Kreis ist so gross wie der Auslöser');

for (const radius of [4, 4.5, 7.5]) {
  const tor = new PortalRing({ x: 0, y: 0, z: 0 }, radius, flach);
  const { wirbel, runen, saeule } = lagen(tor);
  check(
    Math.abs(weite(wirbel) - radius) < 1e-3,
    `Radius ${radius} im Dokument, Radius ${weite(wirbel).toFixed(2)} im Bild`,
  );
  /*
   * Der Runenring liegt **aussen herum** und nicht darauf.
   *
   * Läge er innen, verdeckte er den Wirbel; läge er weit draussen, stünde ein
   * zweiter Kreis in der Wiese, und niemand wüsste, welcher der Auslöser ist.
   */
  const band = weite(runen) / weite(wirbel);
  check(band > 1.05 && band < 1.3, 'der Runenring fasst ihn knapp ein', `Faktor ${band.toFixed(2)}`);
  // Die Säule steht **in** dem Kreis und ragt nicht darüber hinaus: sie ist
  // ein Hinweis aus der Ferne und keine Mauer, die den Blick nimmt.
  check(weite(saeule) < weite(wirbel), 'die Lichtsäule bleibt innerhalb des Kreises');
  tor.dispose();
}

// ---------------------------------------------------------------------------
console.log('Es bewegt sich');

{
  const tor = new PortalRing({ x: 0, y: 0, z: 0 }, 4, flach);
  const { runen, wirbel, saeule } = lagen(tor);
  const zeit = (m: THREE.Mesh): number =>
    (m.material as THREE.ShaderMaterial).uniforms.zeit!.value as number;

  const vorher = { wirbel: zeit(wirbel), saeule: zeit(saeule), drehung: runen.rotation.y };

  /*
   * Gegenprobe zuerst: **ohne** verstrichene Zeit steht alles still.
   *
   * Ein Tor, das sich schon beim blossen Aufruf dreht, dreht sich im
   * Hintergrundtab mit der Bildrate statt mit der Uhr — und zuckt beim
   * Zurückkommen um alles, was es nachzuholen glaubt.
   */
  tor.update(0);
  check(
    zeit(wirbel) === vorher.wirbel && runen.rotation.y === vorher.drehung,
    'ohne verstrichene Zeit bewegt sich nichts',
  );

  tor.update(0.5);
  tor.update(0.5);
  check(
    Math.abs(zeit(wirbel) - (vorher.wirbel + 1)) < 1e-6,
    'der Wirbel folgt der verstrichenen Zeit',
    `${zeit(wirbel).toFixed(2)} s`,
  );
  check(
    Math.abs(zeit(saeule) - (vorher.saeule + 1)) < 1e-6,
    'die Lichtsäule ebenso',
    `${zeit(saeule).toFixed(2)} s`,
  );
  check(
    runen.rotation.y > vorher.drehung + 0.05,
    'und der Runenring dreht sich dabei',
    `${runen.rotation.y.toFixed(3)} rad nach einer Sekunde`,
  );
  tor.dispose();
}

// ---------------------------------------------------------------------------
console.log('Die Runen entstehen einmal');

{
  const striche = stiftzug.striche;
  const leinwandZuvor = leinwaende;
  check(
    stiftzug.drehungen === 16,
    'sechzehn Zeichen stehen im Kreis',
    `${stiftzug.drehungen} Drehungen des Stifts`,
  );
  check(stiftzug.kreise === 2, 'dazu zwei Kreise als Fassung', `${stiftzug.kreise}`);
  check(striche >= 18, 'und der Stift hat sie auch gezogen', `${striche} Züge`);

  /*
   * Gegenprobe: das nächste Tor malt **nichts** mehr.
   *
   * Auf Lichtmoor steht nur ein Tor, in einer Stadt könnten es zehn sein.
   * Zehnmal eine halbe Megapixel-Leinwand zu malen und zehnmal dieselbe Textur
   * hochzuladen, wäre für sechzehn Striche eine teure Angewohnheit.
   */
  const weiteres = new PortalRing({ x: 0, y: 0, z: 0 }, 4, flach);
  check(
    stiftzug.striche === striche && leinwaende === leinwandZuvor,
    'ein zweites Tor teilt sich die Textur, statt sie neu zu malen',
    `${leinwaende} Leinwand(en) insgesamt`,
  );
  const a = lagen(amHang).runen.material as THREE.MeshBasicMaterial;
  const b = lagen(weiteres).runen.material as THREE.MeshBasicMaterial;
  check(a.map === b.map && a.map !== null, 'und es ist dieselbe Textur');
  weiteres.dispose();
}
amHang.dispose();

// ---------------------------------------------------------------------------
console.log('In den Karten steht kein Torbogen mehr');

{
  let portale = 0;
  let props = 0;
  let boegen = 0;
  for (const datei of readdirSync(join(repo, 'assets', 'maps'))) {
    if (!datei.endsWith('.json')) continue;
    const doc = JSON.parse(readFileSync(join(repo, 'assets', 'maps', datei), 'utf8')) as {
      props: Array<{ model: string }>;
      portals?: Array<{ radius: number }>;
    };
    props += doc.props.length;
    for (const p of doc.props) if (/gate|arch/i.test(p.model)) boegen++;
    for (const portal of doc.portals ?? []) {
      portale++;
      // Ein Radius null wäre ein Tor ohne Bild: der Kreis nähme die Zahl aus
      // dem Dokument und wäre nicht zu sehen.
      if (!(portal.radius > 0)) boegen++;
    }
  }
  // Die Zählungen zuerst: ohne sie wären die beiden Prüfungen darunter auch
  // dann grün, wenn gar keine Karte gelesen wurde.
  check(portale >= 4, 'die Karten bringen Tore mit', `${portale} Stück`);
  check(props > 1000, 'und Props', `${props} Stück`);
  check(boegen === 0, 'aber kein Prop und kein Radius, der ein Tor darstellen will');
}

console.log(`\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`);
process.exit(failures === 0 ? 0 : 1);
