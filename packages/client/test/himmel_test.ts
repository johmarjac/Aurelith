/**
 * Sonne, Mond und Wolken — was sich davon von aussen prüfen lässt.
 *
 * Die Wolken sind ein Shader, und wie ein Shader aussieht, sagt kein Test.
 * Was er sagen kann, ist alles, was **um** ihn herum stimmen muss, damit man
 * ihn überhaupt zu sehen bekommt:
 *
 *   1. Die Wolkendecke ist eine halbe Kugel. Eine ganze wäre die Hälfte der
 *      Dreiecke für einen Himmel unter dem Boden.
 *   2. Sie zieht mit der Zeit — und nur dann. Eine Uhr, die schon beim Aufruf
 *      läuft, holt im Hintergrundtab alles auf einmal nach.
 *   3. Sie trägt die Farbe des Horizonts und wird nachts dunkler als er. Eine
 *      Wolke, die heller leuchtet als der Himmel dahinter, ist ein Loch.
 *   4. Sonne und Mond stehen sich gegenüber und blenden am Horizont aus,
 *      statt wegzuschalten.
 *
 *   npx tsx packages/client/test/himmel_test.ts
 */

import type * as THREE from 'three';

export {};

let failures = 0;
function check(ok: boolean, was: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${was}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('Aurelith — Himmel\n');

const { SkyBodies } = await import('../src/render/skyBodies.ts');

const himmel = new SkyBodies();
/** Die Wolkendecke — die einzige Lage mit einer Kugelgeometrie. */
const wolken = himmel.root.children.find(
  (k) => (k as THREE.Mesh).geometry?.type === 'SphereGeometry',
) as THREE.Mesh;
const wolkenMaterial = wolken.material as THREE.ShaderMaterial;

// ---------------------------------------------------------------------------
console.log('Die Decke liegt über dem Kopf');

{
  const geo = wolken.geometry as THREE.SphereGeometry;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  let tiefste = Infinity;
  let hoechste = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    tiefste = Math.min(tiefste, pos.getY(i));
    hoechste = Math.max(hoechste, pos.getY(i));
  }
  check(hoechste > 0, 'sie reicht bis über den Zenit', `${hoechste.toFixed(0)}`);
  /*
   * Und **nicht** darunter. Vorher stand hier eine ganze Kugel: die untere
   * Hälfte lag unter dem Boden, wurde nie gesehen und kostete trotzdem die
   * Hälfte der Dreiecke.
   */
  check(tiefste > -1, 'und nicht unter den Horizont', `${tiefste.toFixed(2)}`);
  /*
   * Sie wird nie weggeschnitten: die Kuppel wandert mit der Kamera, und ihre
   * gerechnete Hülle steht derweil am Ursprung. Ohne diese Zeile verschwindet
   * der halbe Himmel, sobald man weit genug gelaufen ist.
   */
  check(wolken.frustumCulled === false, 'und wird nicht weggeschnitten');
}

// ---------------------------------------------------------------------------
console.log('\nSie zieht mit der Zeit');

{
  const zeit = (): number => wolkenMaterial.uniforms.zeit!.value as number;
  const vorher = zeit();
  himmel.step(0);
  check(zeit() === vorher, 'ohne verstrichene Zeit steht sie still');
  himmel.step(0.5);
  himmel.step(0.5);
  check(Math.abs(zeit() - (vorher + 1)) < 1e-6, 'und folgt sonst der Uhr', `${zeit().toFixed(2)} s`);
}

// ---------------------------------------------------------------------------
console.log('\nSie trägt die Farbe des Horizonts');

{
  const farbe = wolkenMaterial.uniforms.farbe!.value as THREE.Color;
  const HORIZONT = 0xd9f2ff;

  himmel.update([0.3, 0.8, 0.2], 0xfff4de, HORIZONT, 0);
  const tags = { r: farbe.r, g: farbe.g, b: farbe.b };
  himmel.update([0.3, -0.8, 0.2], 0xfff4de, HORIZONT, 1);
  const nachts = { r: farbe.r, g: farbe.g, b: farbe.b };

  const hell = (c: { r: number; g: number; b: number }): number => (c.r + c.g + c.b) / 3;
  check(hell(tags) > hell(nachts) * 1.8, 'tagsüber hell, nachts dunkel', `${hell(tags).toFixed(2)} gegen ${hell(nachts).toFixed(2)}`);
  /*
   * Gegenprobe: der **Farbton** bleibt der des Horizonts, es wird nur
   * abgedunkelt. Ohne sie ginge auch eine Wolke durch, die nachts grün wird.
   */
  const tonTag = tags.b / Math.max(1e-6, tags.r);
  const tonNacht = nachts.b / Math.max(1e-6, nachts.r);
  check(Math.abs(tonTag - tonNacht) < 0.02, 'und behält dabei ihren Ton', `${tonTag.toFixed(3)} / ${tonNacht.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
console.log('\nSonne und Mond stehen sich gegenüber');

{
  const scheiben = himmel.root.children.filter(
    (k) => (k as THREE.Mesh).geometry?.type === 'PlaneGeometry',
  ) as THREE.Mesh[];
  check(scheiben.length === 2, 'es gibt zwei Scheiben', `${scheiben.length}`);

  himmel.update([0, 1, 0], 0xfff4de, 0xd9f2ff, 0);
  const [a, b] = scheiben;
  const hoch = a!.position.y > b!.position.y ? a! : b!;
  const tief = hoch === a! ? b! : a!;
  check(hoch.position.y > 0 && tief.position.y < 0, 'die eine oben, die andere unten', `${hoch.position.y.toFixed(0)} / ${tief.position.y.toFixed(0)}`);
  check(hoch.visible && !tief.visible, 'und nur die obere ist zu sehen');

  /*
   * Am Horizont wird ausgeblendet statt weggeschaltet. Sonst blinkt die Sonne
   * beim Untergang weg — und das sieht aus, als hätte jemand das Licht
   * ausgemacht.
   */
  himmel.update([1, 0.04, 0], 0xfff4de, 0xd9f2ff, 0.5);
  const staerken = scheiben.map(
    (s) => (s.material as THREE.ShaderMaterial).uniforms.staerke!.value as number,
  );
  const teilweise = staerken.filter((s) => s > 0.01 && s < 0.99);
  check(teilweise.length >= 1, 'knapp über dem Horizont steht sie halb da', staerken.map((s) => s.toFixed(2)).join(' / '));
}

himmel.dispose?.();

console.log(`\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`);
process.exit(failures === 0 ? 0 : 1);
