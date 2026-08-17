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
 *   1. Sie ist eine **Insel** und breit — vorher war sie ein Streifen von
 *      zweihundert Metern Breite, und das las sich beim Laufen als eng.
 *   2. Der äussere Rand ist dicht, zu Fuss **und** in der Luft — aber erst
 *      weit draussen über dem Wasser: an Land hält die Klippe, und bis an
 *      deren Kante soll man kommen.
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
  decodeSculptField,
  parseMapDocument,
  SCULPT_UNIT,
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

console.log('Eine breite Insel, kein Streifen');

// Der begehbare Streifen: die grösste Ausdehnung, die keine Zone berührt.
const halb = doc.terrain.size * 0.5;
const frei = (x: number, z: number): boolean => gesperrt(x, z, 'lauf') === undefined;

let breite = 0;
for (let x = -halb; x <= halb; x += 1) if (frei(x, 0)) breite++;
let laenge = 0;
for (let z = -halb; z <= halb; z += 1) if (frei(0, z)) laenge++;

check(breite > 420 && laenge > 440, 'die Insel ist gross genug', `${breite} × ${laenge}`);
/*
 * Und **breit**, nicht schmal. Vorher stand hier die umgekehrte Behauptung —
 * „deutlich länger als breit" —, und genau die war die Beschwerde: ein
 * Korridor von zweihundert Metern Breite, an dessen Rand man ständig stand.
 * Ein Verhältnis nahe eins heisst offene Landschaft statt Schlauch.
 */
check(
  laenge < breite * 1.5 && breite < laenge * 1.5,
  'und keine Schlucht in eine Richtung',
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
    /*
     * Nur der Bereich, der **gesperrt sein soll** — also weit draussen über
     * dem Wasser. Zwischen Küste und Sperre liegen dreissig Meter offenes
     * Meer, und die sind Absicht: dorthin soll ein Fliegender kommen.
     */
    const draussen = Math.abs(x) > 280 || z > 300 || z < -280;
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

/*
 * --- Die Insel und ihre Klippe ---------------------------------------------
 *
 * Der Rand war zweimal falsch, und beide Male war es dieselbe Idee in einer
 * anderen Höhe: erst eine Wand von hundertachtzehn Metern, dann eine Kette von
 * zweiundvierzig. In beiden Fällen hörte die Welt an einem Berg auf.
 *
 * Jetzt hört sie am **Meer** auf. Was dafür stimmen muss, steht hier als Zahl,
 * und die drei Aussagen hängen zusammen:
 *
 *   - Es gibt Land **und** Wasser. Eine Insel, die ganz über dem Spiegel
 *     liegt, ist ein Tisch; eine, die ganz darunter liegt, ist ein Meer.
 *   - Die Klippe ist steiler als das, was der Kern begehbar nennt. Sonst
 *     läuft man hinunter und steht im Wasser statt an der Kante.
 *   - Das Plateau selbst ist flach genug zum Laufen. Eine Insel aus lauter
 *     Klippen wäre formal richtig und praktisch unbespielbar.
 */
console.log('\nDie Insel und ihre Klippe');

const feld = doc.terrain.sculpt ? decodeSculptField(doc.terrain.sculpt) : undefined;
check(feld !== undefined, 'die Karte bringt ein geformtes Höhenfeld mit');
const werte = feld ?? new Int16Array(0);
const aufloesung = Math.round(Math.sqrt(werte.length));
const gitter = doc.terrain.size / (aufloesung - 1);
const hoeheBei = (ix: number, iz: number): number => werte[iz * aufloesung + ix]! / SCULPT_UNIT;

let ueberWasser = 0;
let unterWasser = 0;
let hoechster = -1e9;
let tiefster = 1e9;
const plateauNeigungen: number[] = [];
let steilsteKlippe = 0;
for (let iz = 1; iz < aufloesung - 1; iz++) {
  for (let ix = 1; ix < aufloesung - 1; ix++) {
    const x = -halb + ix * gitter;
    const z = -halb + iz * gitter;
    const h = hoeheBei(ix, iz);
    hoechster = Math.max(hoechster, h);
    tiefster = Math.min(tiefster, h);
    if (h > doc.terrain.waterLevel) ueberWasser++;
    else unterWasser++;
    const neigung = Math.hypot(
      (hoeheBei(ix + 1, iz) - hoeheBei(ix - 1, iz)) / (2 * gitter),
      (hoeheBei(ix, iz + 1) - hoeheBei(ix, iz - 1)) / (2 * gitter),
    );
    // Innen das Plateau, aussen die Klippe. Der Fluss liegt innen und ist
    // absichtlich steil — deshalb bleibt sein Graben hier aussen vor.
    const amFluss = Math.abs(x) < 100 && Math.abs(z) < 240;
    if (Math.abs(x) < 180 && z > -180 && z < 200 && !amFluss) plateauNeigungen.push(neigung);
    if (Math.abs(x) > 210 || z > 230 || z < -210) steilsteKlippe = Math.max(steilsteKlippe, neigung);
  }
}
const grad = (g: number): number => (Math.atan(g) * 180) / Math.PI;
const anteilLand = ueberWasser / (ueberWasser + unterWasser);

check(anteilLand > 0.4 && anteilLand < 0.85, 'die Insel liegt im Meer', `${(anteilLand * 100).toFixed(0)} % Land`);
check(tiefster < doc.terrain.waterLevel - 8, 'und das Meer hat einen Grund', `${tiefster.toFixed(0)} m`);
/*
 * Die Klippe muss steiler sein als `kMaxWalkableSlopeDeg` (52°) — das ist die
 * Zahl, mit der der Kern entscheidet, ob ein Schritt gilt. Darunter liefe man
 * die Klippe hinunter, und die Insel hätte keinen Rand mehr.
 */
check(grad(steilsteKlippe) > 60, 'die Klippe ist unbegehbar steil', `${grad(steilsteKlippe).toFixed(0)}°`);
// Und die Gegenprobe: das Land dazwischen ist flach genug zum Laufen.
plateauNeigungen.sort((a, b) => a - b);
const neunzig = grad(plateauNeigungen[Math.floor(plateauNeigungen.length * 0.9)]!);
check(neunzig < 30, 'das Plateau selbst läuft sich flach', `${neunzig.toFixed(0)}° im obersten Zehntel`);
check(hoechster < 60, 'und kein Gipfel ragt heraus', `${hoechster.toFixed(0)} m`);

/*
 * --- Draussen trägt der Boden niemanden ------------------------------------
 *
 * Bis an den Rand fliegen zu dürfen heisst, dort auch absteigen zu **wollen**
 * — und das darf nicht gehen. Der Kern kennt kein Wasser: der Meeresgrund ist
 * für ihn gewöhnlicher Boden, und die Klippe ist eine Wand, die von unten
 * niemand hinaufkommt. Wer draussen absteigt, stünde für immer dort, denn das
 * Gerät liegt danach im Beutel. Deshalb sagt der Server es ab
 * (`MapInstance.traegtBoden`).
 *
 * Die Absage ist nur so gut wie die Annahme dahinter: draussen trägt **nichts**
 * — weder über noch unter der Klippenkante. Bliebe dort eine trockene, flache
 * Kuppe stehen, liesse die Absage genau dort durch, wo sie gebraucht wird.
 * Also wird alles abgetastet, was jenseits der Küste liegt, mit demselben
 * Doppelmass wie im Server: über dem Spiegel **und** flach genug zum Stehen.
 */
const beiX = (x: number): number => Math.round((x + halb) / gitter);
const hoeheAn = (x: number, z: number): number => hoeheBei(beiX(x), beiX(z));
const neigungAn = (x: number, z: number): number => {
  const ix = beiX(x);
  const iz = beiX(z);
  return Math.hypot(
    (hoeheBei(ix + 1, iz) - hoeheBei(ix - 1, iz)) / (2 * gitter),
    (hoeheBei(ix, iz + 1) - hoeheBei(ix, iz - 1)) / (2 * gitter),
  );
};
// Dieselbe Rechnung wie `MapInstance.traegtBoden` — die Schwelle ist
// `kMaxWalkableSlopeDeg` aus dem Kern.
const traegt = (x: number, z: number): boolean =>
  hoeheAn(x, z) >= doc.terrain.waterLevel && grad(neigungAn(x, z)) <= 52;

/*
 * Wo „draussen" anfängt: die Küste schwankt um ±25 m um ihre Linie, und die
 * Klippe braucht rund zwölf Meter, bis sie ihre volle Tiefe hat. Erst dahinter
 * ist die Aussage eindeutig — davor liegt der Strand, und der soll tragen.
 */
let traegtDraussen = 0;
let hoechsteKuppe = -1e9;
for (let z = -316; z <= 316; z += 4) {
  for (let x = -316; x <= 316; x += 4) {
    const draussen = Math.abs(x) >= 258 || z >= 276 || z <= -256;
    if (!draussen) continue;
    hoechsteKuppe = Math.max(hoechsteKuppe, hoeheAn(x, z));
    if (traegt(x, z)) traegtDraussen++;
  }
}
check(
  traegtDraussen === 0,
  'jenseits der Küste trägt kein Fleck mehr',
  `höchster Punkt draussen ${hoechsteKuppe.toFixed(0)} m, Spiegel ${doc.terrain.waterLevel} m`,
);
/*
 * Gegenprobe, und sie ist hier keine Formsache: dieselbe Funktion muss auf der
 * Insel `true` sagen. Wäre `traegt` einfach überall falsch — ein Vorzeichen,
 * eine verrutschte Gitterkoordinate —, wäre die Prüfung oben grün und
 * bedeutungslos, und der Server sagte in Wahrheit jedes Absteigen ab.
 */
const startHoehe = hoeheAn(doc.spawn.x, doc.spawn.z);
check(
  traegt(doc.spawn.x, doc.spawn.z),
  'und der Startpunkt trägt',
  `${startHoehe.toFixed(1)} m, ${grad(neigungAn(doc.spawn.x, doc.spawn.z)).toFixed(0)}°`,
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
    if (
      prop.collision !== soll.form ||
      Math.abs(prop.collisionRadius - soll.radius) > 1e-6 ||
      Math.abs(prop.collisionHeight - soll.hoehe) > 1e-6
    ) {
      abweichler.push(
        `${karte.name}/${prop.model}: ${prop.collision} ${prop.collisionRadius}/${prop.collisionHeight} ` +
          `statt ${soll.form} ${soll.radius}/${soll.hoehe}`,
      );
    }
  }
}
check(props > 2000, 'es gibt überhaupt Props zu prüfen', `${props}`);
/*
 * Und über wie viele davon kommt man mit einem Sprung?
 *
 * Die Zahl selbst ist nicht die Aussage — die Aussage ist, dass es überhaupt
 * welche gibt **und** dass nicht alles überspringbar ist. Eine Karte, auf der
 * man über jeden Baum springt, wäre genauso falsch wie eine, auf der jeder
 * Zaun bis in die Wolken reicht.
 */
const mitKreis = karten.flatMap((k) => k.props).filter((p) => p.collision === 'circle');
const ueberspringbar = mitKreis.filter((p) => p.collisionHeight > 0 && p.collisionHeight < 1.6);
const bisZumHimmel = mitKreis.filter((p) => p.collisionHeight === 0);
check(
  ueberspringbar.length > 200,
  'über einen guten Teil der Hindernisse springt man hinweg',
  `${ueberspringbar.length} von ${mitKreis.length}`,
);
check(
  bisZumHimmel.length > 200,
  'und über den Rest nicht',
  `${bisZumHimmel.length} von ${mitKreis.length}`,
);
// Zäune und Mauern sind der Fall, um den es geht — sie müssen dabei sein.
const zaeune = mitKreis.filter((p) => p.model === 'fence_wood' || p.model === 'fence_stone');
check(
  zaeune.length > 0 && zaeune.every((p) => p.collisionHeight > 0 && p.collisionHeight < 1.3),
  'Zäune und Mauern kann man überspringen',
  `${zaeune.length} Felder, höchstes ${Math.max(...zaeune.map((p) => p.collisionHeight)).toFixed(2)} m`,
);
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
