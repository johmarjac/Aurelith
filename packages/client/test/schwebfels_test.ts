/**
 * Steht man auf einem schwebenden Felsen — oder schwebt man dort?
 *
 * Man konnte immer schon darüber laufen: die Bewegung fragt den Kern, und der
 * kennt die Plattformen. Nur **aussah** wie Laufen tat es nicht. Der Zeichner
 * entscheidet an einer einzigen Zahl, ob eine Figur geht oder in der Luft
 * hängt — `y` minus Bodenhöhe —, und er holte diese Bodenhöhe bei `heightAt`.
 * Das kennt nur das Gelände. Sechsundzwanzig Meter über der Wiese heisst dort
 * „in der Luft": die Beine zogen an, der Gang stand still, und die Figur glitt
 * über den Stein.
 *
 * Geprüft wird deshalb genau der Datenweg des Clients — dieselbe Welt, die
 * `game.ts` für die Vorhersage baut, mit den Plattformen aus der echten Karte
 * — und an einem Felsen, der wirklich in Lichtmoor steht.
 *
 *   npx tsx packages/client/test/schwebfels_test.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import createAurelithCore from '../../core/dist/aurelith_core.js';
import { Core } from '../../core/src/index.ts';
import { parseMapDocument, terrainSetup } from '@aurelith/shared';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let failures = 0;
function check(ok: boolean, was: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${was}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('Aurelith — Schwebende Felsen\n');

const doc = parseMapDocument(
  JSON.parse(readFileSync(join(repo, 'assets', 'maps', 'lichtmoor.json'), 'utf8')),
);

const core = await Core.fromModule(await createAurelithCore());
const setup = terrainSetup(doc);
const welt = core.createWorld(doc.terrain.seed, setup.shape);
welt.setSculpt(setup.sculpt, setup.sculptResolution);

/*
 * Nur die Plattformen — genau wie in `game.ts`. Kollider und Sperrzonen haben
 * mit der Frage nichts zu tun, und was hier nicht eingetragen wird, kann auch
 * nicht versehentlich mitantworten.
 */
let flaechen = 0;
for (const prop of doc.props) {
  if (prop.collision !== 'plattform') continue;
  welt.addPlattform(
    prop.position[0],
    prop.position[2],
    prop.collisionRadius * prop.scale,
    prop.position[1],
  );
  flaechen++;
}
check(flaechen > 0, 'die Karte bringt begehbare Flächen mit', `${flaechen}`);

const fels = doc.props.find((p) => p.collision === 'plattform');
if (!fels) throw new Error('ohne Fels keine Prüfung');
const [fx, fy, fz] = fels.position;
const gelaende = welt.heightAt(fx, fz);
check(
  fy > gelaende + 10,
  `„${fels.model}" schwebt hoch genug für die Aussage`,
  `Fläche ${fy.toFixed(1)} m, Gelände ${gelaende.toFixed(1)} m`,
);

console.log('\nWer oben steht, steht auf dem Felsen');

/*
 * Die eine Zahl, an der alles hing. `vonY` ist die Höhe der Figur — sie steht
 * auf der Fläche, fragt also von dort aus.
 */
const obenDrauf = welt.bodenUnter(fx, fz, fy);
check(
  Math.abs(obenDrauf - fy) < 0.01,
  'der Boden unter ihr ist die Fläche des Felsens',
  `${obenDrauf.toFixed(2)} m statt ${fy.toFixed(2)} m`,
);
check(
  Math.abs(fy - obenDrauf) < 0.08,
  'und damit gilt sie dem Zeichner als am Boden',
  `${(fy - obenDrauf).toFixed(2)} m über dem Boden — die Schwelle für „in der Luft" ist 0,08 m`,
);

/*
 * Und die Zeile, die den Fehler festhält: mit `heightAt` — der alten Frage —
 * wäre dieselbe Figur haushoch in der Luft. Ohne sie wüsste man nicht, ob die
 * Prüfung darüber überhaupt etwas unterscheidet, oder ob am selben Ort auch
 * das Gelände zufällig auf dieser Höhe liegt.
 */
check(
  fy - gelaende > 1,
  'gegen das blosse Gelände gerechnet wäre sie es nicht',
  `${(fy - gelaende).toFixed(1)} m — so weit lag der alte Wert daneben`,
);

console.log('\nUnd darunter und daneben gilt wieder das Gelände');

/*
 * Zwei Gegenproben. Ohne sie wäre auch eine Fassung grün, die immer die
 * Plattform nimmt — und die machte den Raum unter jedem Felsen unbetretbar und
 * die Wiese daneben unbegehbar.
 */
const drunter = welt.bodenUnter(fx, fz, gelaende);
check(
  Math.abs(drunter - gelaende) < 0.01,
  'wer darunter durchgeht, steht auf der Wiese',
  `${drunter.toFixed(2)} m`,
);

const weg = (fels.collisionRadius * fels.scale) * 3;
const daneben = welt.bodenUnter(fx + weg, fz, fy);
check(
  Math.abs(daneben - welt.heightAt(fx + weg, fz)) < 0.01,
  'und neben dem Felsen ebenfalls',
  `${daneben.toFixed(2)} m in ${weg.toFixed(0)} m Abstand`,
);

welt.dispose();

console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
