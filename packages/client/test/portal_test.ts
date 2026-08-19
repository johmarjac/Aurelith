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
 *   4. Die Funken steigen aus dem Teich und nicht aus dem Erdmittelpunkt.
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

const { PortalRing } = await import('../src/render/portal.ts');

/** Die drei Lagen eines Tores: Bodenschein, Teich, Funken. */
function lagen(ring: InstanceType<typeof PortalRing>): {
  schein: THREE.Mesh;
  teich: THREE.Mesh;
  funken: THREE.Points;
} {
  const scheiben: THREE.Mesh[] = [];
  let funken: THREE.Points | undefined;
  for (const kind of ring.root.children) {
    if ((kind as THREE.Points).isPoints) funken = kind as THREE.Points;
    else scheiben.push(kind as THREE.Mesh);
  }
  if (scheiben.length !== 2 || !funken) throw new Error('Tor hat nicht drei Lagen');
  // Die kleinere ist der Teich, die grössere der Bodenschein.
  scheiben.sort((a, b) => weite(a) - weite(b));
  return { teich: scheiben[0]!, schein: scheiben[1]!, funken };
}

/** Der grösste Abstand einer Ecke von der Mitte, in der Waagerechten. */
function weite(mesh: THREE.Mesh | THREE.Points): number {
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
const teichHang = lagen(amHang).teich;

{
  const pos = teichHang.geometry.attributes.position as THREE.BufferAttribute;
  let groesserFehler = 0;
  let tiefste = Infinity;
  let hoechste = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const wx = amHang.root.position.x + pos.getX(i);
    const wz = amHang.root.position.z + pos.getZ(i);
    const wy = amHang.root.position.y + pos.getY(i);
    groesserFehler = Math.max(groesserFehler, Math.abs(wy - (hang(wx, wz) + 0.08)));
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
  const pos = lagen(eben).teich.geometry.attributes.position as THREE.BufferAttribute;
  let tiefste = Infinity;
  let hoechste = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    tiefste = Math.min(tiefste, pos.getY(i));
    hoechste = Math.max(hoechste, pos.getY(i));
  }
  check(
    hoechste - tiefste < 1e-4 && Math.abs(hoechste - 0.08) < 1e-4,
    'auf ebenem Grund liegt sie flach und einen Fingerbreit hoch',
    `${tiefste.toFixed(3)} bis ${hoechste.toFixed(3)} m über der Mitte`,
  );
  eben.dispose();
}

// ---------------------------------------------------------------------------
console.log('Der Kreis ist so gross wie der Auslöser');

for (const radius of [4, 4.5, 7.5]) {
  const tor = new PortalRing({ x: 0, y: 0, z: 0 }, radius, flach);
  const { teich, schein, funken } = lagen(tor);
  check(
    Math.abs(weite(teich) - radius) < 1e-3,
    `Radius ${radius} im Dokument, Radius ${weite(teich).toFixed(2)} im Bild`,
  );
  /*
   * Der Bodenschein liegt **aussen herum** und deutlich weiter.
   *
   * Er ist der Übergang vom Licht zum Gras; wäre er nur wenig grösser, hätte
   * der Teich wieder eine harte Kante, nur eine hellere. Und wäre er
   * riesengross, läge ein Scheinwerfer auf der Wiese, dessen Mitte niemand
   * mehr findet.
   */
  const band = weite(schein) / weite(teich);
  check(band > 1.6 && band < 2.6, 'der Bodenschein greift weit darüber hinaus', `Faktor ${band.toFixed(2)}`);
  /*
   * Und die Funken steigen **aus dem Teich**: ihre Fusspunkte liegen innerhalb
   * des Kreises. Vorher hätte auch eine Wolke über der halben Wiese bestanden.
   */
  check(
    weite(funken) < weite(teich),
    'die Funken stehen im Kreis',
    `${weite(funken).toFixed(2)} von ${weite(teich).toFixed(2)} m`,
  );
  tor.dispose();
}

// ---------------------------------------------------------------------------
console.log('Es bewegt sich');

{
  const tor = new PortalRing({ x: 0, y: 0, z: 0 }, 4, flach);
  const { teich, schein, funken } = lagen(tor);
  const zeit = (m: THREE.Mesh | THREE.Points): number =>
    (m.material as THREE.ShaderMaterial).uniforms.zeit!.value as number;

  const vorher = { teich: zeit(teich), schein: zeit(schein), funken: zeit(funken) };

  /*
   * Gegenprobe zuerst: **ohne** verstrichene Zeit steht alles still.
   *
   * Ein Tor, das sich schon beim blossen Aufruf bewegt, läuft im
   * Hintergrundtab mit der Bildrate statt mit der Uhr — und zuckt beim
   * Zurückkommen um alles, was es nachzuholen glaubt.
   */
  tor.update(0);
  check(
    zeit(teich) === vorher.teich && zeit(funken) === vorher.funken,
    'ohne verstrichene Zeit bewegt sich nichts',
  );

  tor.update(0.5);
  tor.update(0.5);
  check(
    Math.abs(zeit(teich) - (vorher.teich + 1)) < 1e-6,
    'der Teich folgt der verstrichenen Zeit',
    `${zeit(teich).toFixed(2)} s`,
  );
  check(
    Math.abs(zeit(schein) - (vorher.schein + 1)) < 1e-6,
    'der Bodenschein ebenso',
    `${zeit(schein).toFixed(2)} s`,
  );
  check(
    Math.abs(zeit(funken) - (vorher.funken + 1)) < 1e-6,
    'und die Funken auch',
    `${zeit(funken).toFixed(2)} s`,
  );
  tor.dispose();
}

// ---------------------------------------------------------------------------
console.log('Die Funken steigen aus dem Teich');

{
  const tor = new PortalRing({ x: 6, y: 2, z: -3 }, 5, hang);
  const { funken } = lagen(tor);
  const pos = funken.geometry.attributes.position as THREE.BufferAttribute;
  check(pos.count > 20, 'es sind genug Funken für eine Wolke', `${pos.count}`);

  /*
   * Sie stehen auf dem **Gelände** und nicht auf einer Ebene: am Hang liegt
   * der eine Fusspunkt höher als der andere. Sonst schwebte die halbe Wolke
   * unter dem Boden — an einer Klippe wäre das ein Schwarm im Fels.
   */
  let tiefste = Infinity;
  let hoechste = -Infinity;
  let fehler = 0;
  for (let i = 0; i < pos.count; i++) {
    const wx = tor.root.position.x + pos.getX(i);
    const wz = tor.root.position.z + pos.getZ(i);
    const wy = tor.root.position.y + pos.getY(i);
    fehler = Math.max(fehler, Math.abs(wy - (hang(wx, wz) + 0.1)));
    tiefste = Math.min(tiefste, pos.getY(i));
    hoechste = Math.max(hoechste, pos.getY(i));
  }
  check(fehler < 1e-4, 'jeder steht auf dem Boden', `grösste Abweichung ${fehler.toFixed(5)} m`);
  check(hoechste - tiefste > 0.5, 'und am Hang auf verschiedenen Höhen', `${(hoechste - tiefste).toFixed(2)} m`);

  /*
   * Jeder hat seine eigene Phase und sein eigenes Tempo. Ohne beides stiegen
   * alle im Gleichschritt, und aus einer Wolke würde eine Reihe.
   */
  const phasen = funken.geometry.attributes.phase as THREE.BufferAttribute;
  const tempi = funken.geometry.attributes.tempo as THREE.BufferAttribute;
  let phasenSpanne = 0;
  let tempoSpanne = 0;
  let minP = Infinity;
  let maxP = -Infinity;
  let minT = Infinity;
  let maxT = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    minP = Math.min(minP, phasen.getX(i));
    maxP = Math.max(maxP, phasen.getX(i));
    minT = Math.min(minT, tempi.getX(i));
    maxT = Math.max(maxT, tempi.getX(i));
  }
  phasenSpanne = maxP - minP;
  tempoSpanne = maxT - minT;
  check(phasenSpanne > 0.6, 'sie fangen zu verschiedenen Zeiten an', `Spanne ${phasenSpanne.toFixed(2)}`);
  check(tempoSpanne > 0.05, 'und steigen verschieden schnell', `Spanne ${tempoSpanne.toFixed(3)}`);
  /*
   * Und die Gegenprobe zum Tempo: keiner steht. Ein Funke mit Tempo null
   * hinge für immer an derselben Stelle, und das sähe aus wie ein Fehler im
   * Bild.
   */
  check(minT > 0.01, 'und keiner steht still', `langsamster ${minT.toFixed(3)}`);

  // Ohne Sichtprüfung des Zeichners: die Wolke wandert im Shader nach oben,
  // und three.js wüsste davon nichts. Ohne dieses Merkmal verschwindet sie,
  // sobald ihre gerechnete Hülle aus dem Bild läuft.
  check(funken.frustumCulled === false, 'und die Wolke wird nicht weggeschnitten');
  tor.dispose();
}

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
