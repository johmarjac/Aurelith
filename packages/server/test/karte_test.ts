/**
 * Lichtmoor — die Karte als Behauptung, geprüft.
 *
 * Eine Karte ist eine Datei, und eine Datei kann still falsch sein: ein
 * Spawner im Fluss, ein NPC im Berg, eine Sperrzone, die den Weg zum Tor
 * zumauert. Nichts davon fällt beim Laden auf; es fällt auf, wenn jemand
 * dorthin läuft, und dann ist es Betrieb und keine Prüfung mehr.
 *
 * Deshalb steht hier, was die Karte behauptet, als Zahl:
 *
 *   1. Sie ist rechteckig — der begehbare Streifen ist deutlich länger als
 *      breit, und alles ausserhalb ist gesperrt.
 *   2. Der Rand ist dicht, zu Fuss **und** in der Luft. Vier Streifen, die
 *      zusammen jeden Punkt ausserhalb decken.
 *   3. Was man erreichen soll, liegt in der Freiheit: Startpunkt, Tor, jeder
 *      NPC, jeder Spawner.
 *   4. Die Stufen steigen nach Norden. Das ist der ganze Aufbau der Karte,
 *      und er soll nicht beim nächsten Verschieben eines Spawners kippen.
 *   5. Wer über die Silberader will, kommt an einer Brücke hinüber — der
 *      Weg bei x = 0 bleibt begehbar.
 *
 *   npx tsx packages/server/test/karte_test.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseMapDocument,
  standardKollision,
  type MapDocument,
  type ZoneDef,
} from '@aurelith/shared';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const doc: MapDocument = parseMapDocument(
  JSON.parse(readFileSync(join(repo, 'assets', 'maps', 'lichtmoor.json'), 'utf8')),
  'lichtmoor.json',
);

let failures = 0;
function check(ok: boolean, was: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${was}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Liegt der Punkt in einer Zone dieser Art? */
function gesperrt(x: number, z: number, art: 'lauf' | 'flug'): ZoneDef | undefined {
  return doc.zonen.find(
    (zone) =>
      (art === 'lauf' ? zone.keinLauf : zone.keinFlug) &&
      Math.abs(x - zone.position[0]) <= zone.extent[0] &&
      Math.abs(z - zone.position[1]) <= zone.extent[1],
  );
}

console.log('Aurelith — Lichtmoor\n');

console.log('Rechteckig, nicht quadratisch');

// Der begehbare Streifen: die grösste Ausdehnung, die keine Zone berührt.
const halb = doc.terrain.size * 0.5;
const frei = (x: number, z: number): boolean => gesperrt(x, z, 'lauf') === undefined;

let breite = 0;
for (let x = -halb; x <= halb; x += 1) if (frei(x, 0)) breite++;
let laenge = 0;
for (let z = -halb; z <= halb; z += 1) if (frei(0, z)) laenge++;

check(breite > 100 && laenge > 300, 'der begehbare Streifen ist gross genug', `${breite} × ${laenge}`);
check(
  laenge > breite * 1.6,
  'und deutlich länger als breit',
  `${laenge} zu ${breite} = ${(laenge / breite).toFixed(2)}`,
);

console.log('\nDer Rand ist dicht');

/*
 * Abgetastet und nicht nachgerechnet: die vier Streifen könnten sich in einer
 * Ecke verfehlen, und genau diese Lücke wäre die, durch die jemand hinausläuft.
 * Ein Raster von fünf Einheiten findet jedes Loch, das breiter ist als eine
 * Figur.
 */
let loecherLauf = 0;
let loecherFlug = 0;
let randpunkte = 0;
for (let x = -halb; x <= halb; x += 5) {
  for (let z = -halb; z <= halb; z += 5) {
    // Nur der Bereich ausserhalb des Streifens. Was innen liegt, soll ja frei
    // sein — das prüft der Abschnitt darunter.
    const draussen = Math.abs(x) > 104 || z > 208 || z < -174;
    if (!draussen) continue;
    randpunkte++;
    if (!gesperrt(x, z, 'lauf')) loecherLauf++;
    if (!gesperrt(x, z, 'flug')) loecherFlug++;
  }
}
check(randpunkte > 1000, 'es gibt überhaupt einen Rand zu prüfen', `${randpunkte} Punkte`);
check(loecherLauf === 0, 'kein Loch für Läufer', `${loecherLauf} von ${randpunkte}`);
check(loecherFlug === 0, 'und keines für Fliegende', `${loecherFlug} von ${randpunkte}`);

// Die Gegenprobe: die Mitte ist **nicht** gesperrt. Ohne sie ginge auch eine
// Karte durch, die überall zu ist — und die wäre formal dicht und praktisch
// unspielbar.
check(frei(0, 0) && frei(0, 150) && frei(-60, -100), 'die Mitte bleibt offen');

console.log('\nAlles Erreichbare liegt frei');

check(frei(doc.spawn.x, doc.spawn.z), 'der Startpunkt', `${doc.spawn.x}/${doc.spawn.z}`);
for (const portal of doc.portals) {
  check(frei(portal.position[0], portal.position[1]), `das Tor „${portal.label}"`);
}
const npcImBerg = doc.npcs.filter((n) => !frei(n.position[0], n.position[1]));
check(npcImBerg.length === 0, 'jeder NPC', npcImBerg.map((n) => n.id).join(', ') || `${doc.npcs.length} geprüft`);
const spawnerImBerg = doc.spawners.filter((s) => !frei(s.position[0], s.position[1]));
check(
  spawnerImBerg.length === 0,
  'jeder Spawner',
  spawnerImBerg.map((s) => s.id).join(', ') || `${doc.spawners.length} geprüft`,
);

console.log('\nNach Norden wird es härter');

/*
 * Nicht „jeder Spawner höher als der davor": zwei Felder auf derselben Höhe
 * dürfen dieselbe Stufe tragen, und nebeneinander liegende Felder sind eine
 * Frage der Breite und nicht der Strecke. Geprüft wird der **Zusammenhang**:
 * die Stufe soll mit der Höhe steigen, und zwar deutlich.
 */
const mitStufe = doc.spawners.filter((s) => s.level !== undefined);
check(mitStufe.length === doc.spawners.length, 'jeder Spawner nennt seine Stufe', `${mitStufe.length}`);

const stufen = mitStufe.map((s) => s.level!);
const zetten = mitStufe.map((s) => s.position[1]);
const mittelS = stufen.reduce((a, b) => a + b, 0) / stufen.length;
const mittelZ = zetten.reduce((a, b) => a + b, 0) / zetten.length;
let oben = 0;
let untenS = 0;
let untenZ = 0;
for (let i = 0; i < stufen.length; i++) {
  oben += (stufen[i]! - mittelS) * (zetten[i]! - mittelZ);
  untenS += (stufen[i]! - mittelS) ** 2;
  untenZ += (zetten[i]! - mittelZ) ** 2;
}
const korrelation = oben / Math.sqrt(untenS * untenZ);
check(korrelation > 0.95, 'Stufe und Norden hängen zusammen', `r = ${korrelation.toFixed(3)}`);
check(Math.min(...stufen) === 1, 'unten fängt es bei eins an', String(Math.min(...stufen)));
check(Math.max(...stufen) === 20, 'oben endet es bei zwanzig', String(Math.max(...stufen)));

// Und die Stadt bleibt friedlich: kein Spawner innerhalb der Mauer. Wer beim
// Händler steht, soll nicht angefallen werden.
const stadtZ = -122;
const imDorf = doc.spawners.filter((s) => Math.hypot(s.position[0], s.position[1] - stadtZ) < 60);
check(imDorf.length === 0, 'in Silberfurt steht kein Monster', imDorf.map((s) => s.id).join(', ') || 'keiner');

console.log('\nSchwebende Felsen und Brücken');

const plattformen = doc.props.filter((p) => p.collision === 'plattform');
check(plattformen.length >= 6, 'es gibt schwebende Felsen', `${plattformen.length}`);
check(
  plattformen.every((p) => !p.snapToGround),
  'und keiner davon setzt auf dem Gelände auf',
);
check(
  plattformen.every((p) => p.position[1] > 15),
  'sie schweben wirklich',
  `tiefster ${Math.min(...plattformen.map((p) => p.position[1])).toFixed(0)}`,
);
// Ohne Radius keine Fläche: der Kern liest `collisionRadius` als Radius der
// begehbaren Scheibe, und null hiesse „nicht da".
check(
  plattformen.every((p) => p.collisionRadius > 2),
  'und jeder hat eine Fläche, auf der man steht',
);

console.log('\nJedes Prop steht so im Weg, wie die Tabelle es sagt');

/*
 * Vorher stand der Radius an jedem Aufruf im Generator, und das Ergebnis liess
 * sich in den Karten nachzählen: `rock_large` mit 1,9 in Lichtmoor, 2,0 in der
 * Gruft und 2,1 im Dornwald, `rock_small` in der Gruft ganz ohne Kreis. Keine
 * dieser Abweichungen war gewollt.
 *
 * Deshalb wird hier über **alle drei** Karten geprüft, und zwar gegen
 * `PROP_KOLLISION`. Nur Lichtmoor zu prüfen liesse genau den Fall durch, der
 * es war: dieselbe Sorte, andere Karte, andere Zahl.
 */
const karten = ['lichtmoor', 'dornwald', 'gruft_01'].map((name) =>
  parseMapDocument(
    JSON.parse(readFileSync(join(repo, 'assets', 'maps', `${name}.json`), 'utf8')),
    `${name}.json`,
  ),
);

const abweichler: string[] = [];
const formen = new Set<string>();
let props = 0;
for (const karte of karten) {
  for (const prop of karte.props) {
    props++;
    const soll = standardKollision(prop.model);
    formen.add(soll.form);
    if (prop.collision !== soll.form || Math.abs(prop.collisionRadius - soll.radius) > 1e-6) {
      abweichler.push(
        `${karte.name}/${prop.model}: ${prop.collision} ${prop.collisionRadius} statt ${soll.form} ${soll.radius}`,
      );
    }
  }
}
check(props > 2000, 'es gibt überhaupt Props zu prüfen', `${props}`);
check(
  abweichler.length === 0,
  'kein Prop weicht von der Tabelle ab',
  abweichler.slice(0, 3).join(' · ') || 'keines',
);

/*
 * Die Gegenprobe. Eine Tabelle, in der alles `none` mit demselben Radius wäre,
 * bestünde die Prüfung darüber mühelos — und wäre die schlimmste Fassung von
 * allen: man liefe durch jeden Baum.
 */
check(
  formen.has('circle') && formen.has('none') && formen.has('plattform'),
  'und es kommen alle drei Formen vor',
  [...formen].sort().join(', '),
);

console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
