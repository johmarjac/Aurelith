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
  decodePaintField,
  decodeSculptField,
  parseMapDocument,
  MAX_GROUND_LAYERS,
  sampleField,
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

console.log('Eine Insel, die man in Minuten misst');

// Der begehbare Streifen: die grösste Ausdehnung, die keine Zone berührt.
const halb = doc.terrain.size * 0.5;
const frei = (x: number, z: number): boolean => gesperrt(x, z, 'lauf') === undefined;

/*
 * Das geformte Höhenfeld — es sagt, wo Land ist.
 *
 * Gebraucht wird es schon hier oben und nicht erst beim Abschnitt über die
 * Klippe: **die Insel ist nicht die Sperrzone.** Zwischen Küste und Sperre
 * liegen fünfundfünfzig Meter offenes Meer, und wer die Länge der Wanderung
 * am freien Bereich misst, misst hundert Meter Wasser mit.
 */
const feld = doc.terrain.sculpt ? decodeSculptField(doc.terrain.sculpt) : undefined;
check(feld !== undefined, 'die Karte bringt ein geformtes Höhenfeld mit');
const werte = feld ?? new Int16Array(0);
const aufloesung = Math.round(Math.sqrt(werte.length));
const gitter = doc.terrain.size / (aufloesung - 1);
const hoeheBei = (ix: number, iz: number): number => werte[iz * aufloesung + ix]! / SCULPT_UNIT;
const beiX = (x: number): number =>
  Math.max(0, Math.min(aufloesung - 1, Math.round((x + halb) / gitter)));
const hoeheAn = (x: number, z: number): number => hoeheBei(beiX(x), beiX(z));
/** Trägt der Boden hier — oder steht hier Wasser? */
const istLand = (x: number, z: number): boolean => hoeheAn(x, z) > doc.terrain.waterLevel;

/** Wo das Land auf einer Achse anfängt und aufhört — abgetastet, nicht geraten. */
function enden(fest: number, achse: 'x' | 'z'): { von: number; bis: number } {
  let von = halb;
  let bis = -halb;
  for (let v = -halb; v <= halb; v += 1) {
    const land = achse === 'x' ? istLand(v, fest) : istLand(fest, v);
    if (!land || !(achse === 'x' ? frei(v, fest) : frei(fest, v))) continue;
    von = Math.min(von, v);
    bis = Math.max(bis, v);
  }
  return { von, bis };
}

const querachse = enden(0, 'x');
const laengsachse = enden(0, 'z');
const breite = querachse.bis - querachse.von;
const laenge = laengsachse.bis - laengsachse.von;

/**
 * Wie schnell eine Figur läuft — aus der Abstimmung und nicht von Hand.
 *
 * Die Karte wird in **Minuten** gemessen, und Minuten sind Meter durch Tempo.
 * Stünde die Zahl hier noch einmal, hätte eine Änderung an der Abstimmung
 * einen grünen Test und eine Karte, die sich plötzlich anders anfühlt.
 */
const tuning = JSON.parse(
  readFileSync(join(repo, 'assets', 'content', 'tuning.json'), 'utf8'),
) as { progression: { moveSpeed: number } };
const tempo = tuning.progression.moveSpeed;
const minuten = (meter: number): number => meter / tempo / 60;

check(tempo > 0.5 && tempo < 30, 'die Abstimmung nennt ein brauchbares Tempo', `${tempo} Einheiten/s`);

/*
 * **Die eigentliche Zusage: eine Wanderung dauert.**
 *
 * Vorher war Lichtmoor vierhundertsechzig Meter lang — fünfundsiebzig
 * Sekunden von Küste zu Küste, fünfzig von der Stadt zum Tor. Man kam an,
 * bevor die Gegend anfing, eine zu sein. Drei bis fünf Minuten sind die
 * Zusage; darunter ist es ein Vorgarten, darüber ein Fussmarsch, den niemand
 * zweimal am Tag macht.
 *
 * Gemessen wird die **Luftlinie**, und das ist die untere Schranke: der
 * Fluss, die Hügel und die Monster machen den Weg länger, nie kürzer.
 */
check(
  minuten(laenge) >= 3 && minuten(laenge) <= 6,
  'von Süden nach Norden läuft man drei bis fünf Minuten',
  `${laenge.toFixed(0)} m = ${minuten(laenge).toFixed(1)} min`,
);

/*
 * Und quer genauso. Die Insel war ein Schlauch: sechshundert Meter breit auf
 * achtzehnhundert Länge, und von der Strasse aus stand man in anderthalb
 * Minuten am Wasser. Wer ausweichen will, braucht Platz zum Ausweichen —
 * sonst ist die Breite eine Zahl im Dokument und keine Landschaft.
 */
check(
  minuten(breite) >= 3 && minuten(breite) <= 6,
  'und quer von Küste zu Küste ebenfalls drei bis fünf',
  `${breite.toFixed(0)} m = ${minuten(breite).toFixed(1)} min`,
);

const tor = doc.portals[0]!;
const stadtZumTor = Math.hypot(tor.position[0] - doc.spawn.x, tor.position[1] - doc.spawn.z);
check(
  minuten(stadtZumTor) >= 3 && minuten(stadtZumTor) <= 6,
  'und von der Stadt bis zum Tor ebenfalls',
  `${stadtZumTor.toFixed(0)} m = ${minuten(stadtZumTor).toFixed(1)} min`,
);

/*
 * Gegenprobe, und ohne sie wäre die Zusage oben wertlos: der Weg muss auch
 * **gehbar** sein. Eine Strecke, die zwar lang ist, aber durch eine Sperrzone
 * führt, ist keine Wanderung, sondern eine Wand mit Aussicht.
 */
let gesperrtAufDemWeg = 0;
for (let i = 0; i <= 200; i++) {
  const t = i / 200;
  const x = doc.spawn.x + (tor.position[0] - doc.spawn.x) * t;
  const z = doc.spawn.z + (tor.position[1] - doc.spawn.z) * t;
  if (!frei(x, z)) gesperrtAufDemWeg++;
}
check(gesperrtAufDemWeg === 0, 'und die Strecke dorthin liegt frei', `${gesperrtAufDemWeg} von 201 Punkten gesperrt`);

console.log('\nDer Rand ist dicht');

/*
 * Abgetastet und nicht nachgerechnet: die vier Streifen könnten sich in einer
 * Ecke verfehlen, und genau diese Lücke wäre die, durch die jemand hinausläuft.
 * Ein Raster von fünf Einheiten findet jedes Loch, das breiter ist als eine
 * Figur.
 *
 * Geprüft wird der **äusserste Saum** der Karte und nicht ein Kasten mit
 * festen Zahlen. Hier standen einmal die Masse der alten Insel drin, und als
 * die Insel wuchs, lag der halbe Prüfbereich plötzlich mitten auf der Wiese:
 * der Test meldete vierzigtausend Löcher im Rand, und keines davon war eines.
 */
let loecherLauf = 0;
let loecherFlug = 0;
let randpunkte = 0;
for (let x = -halb; x <= halb; x += 5) {
  for (let z = -halb; z <= halb; z += 5) {
    // Die letzten acht Meter vor dem Kartenrand. Dort ist die Welt zu Ende,
    // und dort muss die Sperre stehen — zu Fuss wie in der Luft.
    if (Math.abs(x) < halb - 8 && Math.abs(z) < halb - 8) continue;
    randpunkte++;
    if (!gesperrt(x, z, 'lauf')) loecherLauf++;
    if (!gesperrt(x, z, 'flug')) loecherFlug++;
  }
}
check(randpunkte > 1000, 'es gibt überhaupt einen Rand zu prüfen', `${randpunkte} Punkte`);
check(loecherLauf === 0, 'kein Loch für Läufer', `${loecherLauf} von ${randpunkte}`);
check(loecherFlug === 0, 'und keines für Fliegende', `${loecherFlug} von ${randpunkte}`);

/*
 * Die Gegenprobe: die Mitte ist **nicht** gesperrt. Ohne sie ginge auch eine
 * Karte durch, die überall zu ist — und die wäre formal dicht und praktisch
 * unspielbar.
 */
check(
  frei(0, 0) && frei(0, laengsachse.bis - 100) && frei(-60, laengsachse.von + 100),
  'die Mitte bleibt offen',
);
/*
 * Und das offene Wasser neben der Küste auch: dreissig Meter jenseits der
 * Kante soll ein Fliegender noch hinkommen und die Insel von aussen sehen.
 * Ohne diese Zeile wäre auch eine Karte grün, deren Sperre unmittelbar an der
 * Klippe klebt — ein Rand, der sich wie ein Käfig anfühlt.
 */
check(
  frei(querachse.bis + 30, 0) && frei(0, laengsachse.bis + 30),
  'und das Wasser vor der Küste bleibt offen',
);

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

/**
 * Der Zusammenhang über die **Ränge** und nicht über die Zahlen selbst.
 *
 * Vorher stand hier die gewöhnliche Korrelation, und die verlangt mehr, als
 * die Karte verspricht: sie misst, ob die Stufe *linear* mit der Höhe steigt.
 * Das tut sie mit Absicht nicht — die Anfängerzone ist der längste Abschnitt
 * der Insel, achthundert Meter für die Stufen eins bis drei, und die letzten
 * vier Stufen teilen sich zweihundertvierzig. Als die Insel gestreckt wurde,
 * fiel der Wert deshalb von 0,96 auf 0,948, ohne dass ein einziger Spawner
 * falsch stand.
 *
 * Die Zusage lautet „weiter nördlich heisst nicht schwächer", und das ist
 * eine Aussage über die Reihenfolge. Genau die misst der Rangkoeffizient.
 */
function raenge(werteHier: number[]): number[] {
  const sortiert = werteHier.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const rang = new Array<number>(werteHier.length);
  let i = 0;
  while (i < sortiert.length) {
    let j = i;
    // Gleichstände teilen sich den mittleren Rang — sonst entschiede die
    // Reihenfolge in der Datei über das Ergebnis.
    while (j + 1 < sortiert.length && sortiert[j + 1]![0] === sortiert[i]![0]) j++;
    const mittel = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) rang[sortiert[k]![1]] = mittel;
    i = j + 1;
  }
  return rang;
}
function korreliert(a: number[], b: number[]): number {
  const mA = a.reduce((p, q) => p + q, 0) / a.length;
  const mB = b.reduce((p, q) => p + q, 0) / b.length;
  let oben = 0;
  let untenA = 0;
  let untenB = 0;
  for (let i = 0; i < a.length; i++) {
    oben += (a[i]! - mA) * (b[i]! - mB);
    untenA += (a[i]! - mA) ** 2;
    untenB += (b[i]! - mB) ** 2;
  }
  return oben / Math.sqrt(untenA * untenB);
}

const stufen = mitStufe.map((s) => s.level!);
const zetten = mitStufe.map((s) => s.position[1]);
const korrelation = korreliert(raenge(stufen), raenge(zetten));
check(korrelation > 0.95, 'Stufe und Norden hängen zusammen', `r = ${korrelation.toFixed(3)}`);
/*
 * Gegenprobe: dieselbe Rechnung auf die **Breite** angewandt muss schwach
 * ausfallen. Wer nach Westen ausweicht, soll denselben Gegnern begegnen wie
 * in der Mitte — und ohne diese Zeile wäre auch eine Karte grün, auf der die
 * Ränge mit allem korrelieren, weil die Rechnung kaputt ist.
 */
const quer = korreliert(raenge(stufen), raenge(mitStufe.map((s) => s.position[0])));
check(Math.abs(quer) < 0.4, 'die Breite dagegen sagt nichts über die Stufe', `r = ${quer.toFixed(3)}`);
check(Math.min(...stufen) === 1, 'unten fängt es bei eins an', String(Math.min(...stufen)));
check(Math.max(...stufen) === 20, 'oben endet es bei zwanzig', String(Math.max(...stufen)));

/*
 * Und die Stadt bleibt friedlich: kein Spawner in der Nähe des Startpunkts.
 * Wer beim Händler steht, soll nicht angefallen werden.
 *
 * Der Startpunkt und nicht eine abgeschriebene Lage der Stadt: hier stand
 * `-122`, und nach dem Strecken der Insel lag die Stadt bei −488. Die Prüfung
 * suchte danach Monster an einer Stelle, an der keine Stadt mehr war — und
 * fand prompt eines, das ganz woanders stand.
 */
const imDorf = doc.spawners.filter(
  (s) => Math.hypot(s.position[0] - doc.spawn.x, s.position[1] - doc.spawn.z) < 60,
);
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

/*
 * Das Inselrechteck, aus den gemessenen Enden — jede Schwelle darunter ist
 * ein Anteil davon und keine abgeschriebene Zahl. Hier standen einmal feste
 * Kästen („|x| < 180, z zwischen −180 und 200"), und beim Strecken der Insel
 * lagen sie auf einem Achtel der Fläche: die Aussagen über Plateau und Klippe
 * galten danach für eine Stelle, an der weder das eine noch das andere lag.
 */
const mitteZ = (laengsachse.von + laengsachse.bis) / 2;
const halbBreite = breite / 2;
const halbLaenge = laenge / 2;
const drinnen = (x: number, z: number): boolean =>
  Math.abs(x) < halbBreite && Math.abs(z - mitteZ) < halbLaenge;

let landDrinnen = 0;
let punkteDrinnen = 0;
let landDraussen = 0;
let punkteDraussen = 0;
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
    const neigung = Math.hypot(
      (hoeheBei(ix + 1, iz) - hoeheBei(ix - 1, iz)) / (2 * gitter),
      (hoeheBei(ix, iz + 1) - hoeheBei(ix, iz - 1)) / (2 * gitter),
    );
    // Vierzig Meter Saum um die Insel bleiben aussen vor: dort steht die
    // Klippe, und die gehört weder zum Land noch zum Meer.
    /*
     * Wie weit ein Punkt jenseits des Inselrechtecks liegt.
     *
     * Vorher stand hier ein um vierzehn Prozent geschrumpftes Rechteck, und
     * das hiess bei einer Insel von zwölfhundert Metern Breite: „erst
     * fünfundachtzig Meter draussen". Die Klippe ist zwölf Meter breit — sie
     * lag also **komplett** ausserhalb des Prüfbereichs, und gemessen wurde
     * der flache Meeresgrund dahinter. Fünf Grad, und der Test hatte recht:
     * dort ist es flach.
     */
    const raus = Math.hypot(
      Math.max(0, Math.abs(x) - halbBreite),
      Math.max(0, Math.abs(z - mitteZ) - halbLaenge),
    );
    if (drinnen(x, z)) {
      punkteDrinnen++;
      if (h > doc.terrain.waterLevel) landDrinnen++;
    } else {
      // Der Saum ist die Klippe: sie fällt auf zwölf Metern, die Küste
      // schwankt um fünfundzwanzig. Sechzig Meter fassen beides.
      if (raus < 60) steilsteKlippe = Math.max(steilsteKlippe, neigung);
      // Und weit draussen ist Meer und sonst nichts.
      if (raus > 100) {
        punkteDraussen++;
        if (h > doc.terrain.waterLevel) landDraussen++;
      }
    }
    // Innen das Plateau. Der Fluss liegt innen und ist absichtlich steil —
    // deshalb bleibt sein Graben hier aussen vor.
    const amFluss = Math.abs(x) < 130;
    if (drinnen(x / 0.75, mitteZ + (z - mitteZ) / 0.9) && !amFluss) plateauNeigungen.push(neigung);
  }
}
const grad = (g: number): number => (Math.atan(g) * 180) / Math.PI;

/*
 * **Land ist innen, Meer ist aussen.** Vorher stand hier ein Anteil über die
 * ganze Karte („zwischen 40 und 85 Prozent Land"), und der sagt über die Form
 * nichts: er hängt daran, wie viel Meer um die Insel herum liegt. Nach dem
 * Strecken waren es sechsundzwanzig Prozent, und die Insel war deshalb keinen
 * Deut falscher.
 */
check(
  landDrinnen / punkteDrinnen > 0.9,
  'die Insel selbst liegt trocken',
  `${((landDrinnen / punkteDrinnen) * 100).toFixed(0)} % Land auf ${breite.toFixed(0)} × ${laenge.toFixed(0)} m`,
);
check(
  landDraussen / punkteDraussen < 0.02,
  'und um sie herum ist Meer',
  `${((landDraussen / punkteDraussen) * 100).toFixed(1)} % Land draussen`,
);
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
 * --- Die Zonen -------------------------------------------------------------
 *
 * Lichtmoor ist in fünf Abschnitte geteilt, und die Teilung soll man **sehen**
 * — sonst ist sie keine. Drei Dinge tragen sie, und alle drei stehen hier:
 *
 *   1. Der Boden wird nach Norden unruhiger. Das ist nicht Geschmack, sondern
 *      der Hebel: die Bodentexturen wählen nach Neigung, und welliges Gelände
 *      zeigt darum Erde zwischen dem Gras.
 *   2. Der Bewuchs wechselt. Blüten gibt es nur im Süden, Heidekraut nur im
 *      Norden — und wer beides überall streute, hätte einen Verlauf und keine
 *      Zonen.
 *   3. An jeder Grenze steht eine Reihe Steine quer über die Insel.
 */
console.log('\nDie Zonen');

/**
 * Die Neigungen eines Streifens, in Grad — ohne Fluss und ohne Küste.
 *
 * Gemessen wird nicht der Mittelwert, sondern der **Anteil über
 * vierundzwanzig Grad**: genau dort fängt die Erdtextur an. Der Mittelwert
 * wäre die falsche Zahl — er hängt an den grossen Hügeln, die überall stehen,
 * und die kleine Welligkeit, um die es hier geht, verschwindet darin.
 */
function neigungenIn(z0: number, z1: number): number[] {
  const werteHier: number[] = [];
  for (let iz = 1; iz < aufloesung - 1; iz++) {
    const z = -halb + iz * gitter;
    if (z < z0 || z > z1) continue;
    for (let ix = 1; ix < aufloesung - 1; ix++) {
      const x = -halb + ix * gitter;
      /*
       * Nur die offene Fläche zwischen Fluss und Küste: der Flussgraben ist
       * absichtlich steil, die Küste erst recht, und beide würden die Aussage
       * über die Zone erschlagen. Der Streifen ist als Anteil der Breite
       * angegeben — die Insel ist gewachsen, der Fluss mit ihr.
       */
      if (Math.abs(x) > halbBreite * 0.85 || Math.abs(x) < halbBreite * 0.5) continue;
      werteHier.push(
        grad(
          Math.hypot(
            (hoeheBei(ix + 1, iz) - hoeheBei(ix - 1, iz)) / (2 * gitter),
            (hoeheBei(ix, iz + 1) - hoeheBei(ix, iz - 1)) / (2 * gitter),
          ),
        ),
      );
    }
  }
  return werteHier.sort((p, q) => p - q);
}

/**
 * Die **Welligkeit** eines Streifens: wie stark ein Punkt von seinen Nachbarn
 * abweicht, in Metern.
 *
 * Und nicht die Neigung. Die Neigung misst auch die grossen Formen mit — eine
 * Terrassenkante, den Rand eines Teichs, den Fuss eines Hügels —, und seit es
 * die gibt, kam im Süden derselbe Wert heraus wie im Norden: vier Prozent
 * gegen drei, und die Aussage „im Norden bricht der Boden auf" war damit
 * widerlegt, obwohl sie stimmt. Gemeint ist die **kleine** Unruhe mit
 * siebzehn bis dreissig Metern Wellenlänge, und die sieht man erst, wenn man
 * die grossen Formen abzieht: eine Kante ist über drei Stützpunkte gerade,
 * eine Welle nicht.
 */
function welligkeitIn(z0: number, z1: number): number {
  let summe = 0;
  let zahl = 0;
  for (let iz = 1; iz < aufloesung - 1; iz++) {
    const z = -halb + iz * gitter;
    if (z < z0 || z > z1) continue;
    for (let ix = 1; ix < aufloesung - 1; ix++) {
      const x = -halb + ix * gitter;
      if (Math.abs(x) > halbBreite * 0.85 || Math.abs(x) < halbBreite * 0.5) continue;
      const mittel =
        (hoeheBei(ix + 1, iz) + hoeheBei(ix - 1, iz) + hoeheBei(ix, iz + 1) + hoeheBei(ix, iz - 1)) /
        4;
      summe += Math.abs(hoeheBei(ix, iz) - mittel);
      zahl++;
    }
  }
  return zahl > 0 ? summe / zahl : 0;
}

/** Ab hier zeigt der Boden Erde statt Gras — siehe `groundLayers`. */
const ERDE_AB = 24;
const anteilErde = (n: number[]): number => n.filter((g) => g > ERDE_AB).length / n.length;

/*
 * Süden und Norden als **Anteile der Strecke** und nicht als feste Zahlen:
 * hier stand `(-180, -40)` gegen `(130, 220)`, und nach dem Strecken lagen
 * beide Fenster in derselben Zone. Der Test verglich die Weiden mit sich
 * selbst und meldete, es gebe keinen Unterschied.
 */
const suedVon = laengsachse.von + laenge * 0.1;
const suedBis = laengsachse.von + laenge * 0.3;
const nordVon = laengsachse.von + laenge * 0.78;
const nordBis = laengsachse.von + laenge * 0.95;
const weiden = neigungenIn(suedVon, suedBis);
const norden = neigungenIn(nordVon, nordBis);
const welligSued = welligkeitIn(suedVon, suedBis);
const welligNord = welligkeitIn(nordVon, nordBis);
check(
  welligNord > welligSued * 2,
  'im Norden bricht der Boden auf, im Süden nicht',
  `${welligSued.toFixed(2)} m gegen ${welligNord.toFixed(2)} m Welligkeit`,
);
// Und die Erde kommt tatsächlich durch: der Anteil über der Schwelle, ab der
// die Bodentextur wechselt, ist im Norden höher.
check(
  anteilErde(norden) > anteilErde(weiden),
  'und die Erdtextur kommt dort durch',
  `${(anteilErde(weiden) * 100).toFixed(0)} % gegen ${(anteilErde(norden) * 100).toFixed(0)} % über ${ERDE_AB}°`,
);
/*
 * Und die Gegenprobe: aufgebrochen heisst nicht unbegehbar. Zweiundfünfzig
 * Grad ist die Schwelle im Kern; auch die steilsten fünf Prozent des Nordens
 * müssen darunter bleiben, sonst ist die Zone hübsch und nicht zu betreten.
 */
const nordP95 = norden[Math.floor(norden.length * 0.95)] ?? 0;
check(nordP95 < 45, 'und man kommt trotzdem überall hin', `${nordP95.toFixed(0)}° in den steilsten fünf Prozent`);

/** Die Props einer Sorte, nach `z` sortiert. */
const propsMit = (model: string) =>
  doc.props.filter((p) => p.model === model).map((p) => p.position[2]);

const blumen = [
  ...propsMit('blume_weiss'),
  ...propsMit('blume_gelb'),
  ...propsMit('blume_blau'),
];
const heide = propsMit('heidekraut');
check(blumen.length > 100 && heide.length > 100, 'es gibt Blüten und Heidekraut', `${blumen.length} / ${heide.length}`);
/*
 * Die Stückzahl steht in **jeder** dieser Zeilen noch einmal mit drin, obwohl
 * sie darüber schon geprüft ist. Der Grund ist banal und war einmal ein
 * Fehler: `Math.min()` einer leeren Liste ist `Infinity`, und „Infinity > 100"
 * ist wahr. Eine Karte ganz ohne Heidekraut hätte die Zeile bestanden.
 */
check(
  blumen.length > 100 && Math.max(...blumen) < 0,
  'Blüten stehen nur auf der warmen Hälfte',
  `nördlichste bei z = ${Math.max(...blumen).toFixed(0)}`,
);
check(
  heide.length > 100 && Math.min(...heide) > 100,
  'und Heidekraut nur im kargen Norden',
  `südlichstes bei z = ${Math.min(...heide).toFixed(0)}`,
);
/*
 * Gegenprobe zu den beiden Zeilen darüber: **nicht** jede Sorte gehört genau
 * einer Zone. Gras wächst überall, und ohne diese Zeile bestünde die Prüfung
 * auch eine Karte, auf der jede Pflanze ihren eigenen Streifen hat — das wäre
 * kein Land mehr, sondern ein Balkendiagramm.
 */
const gras = propsMit('grass_tuft');
check(
  Math.min(...gras) < -100 && Math.max(...gras) > 150,
  'Gras dagegen wächst über die ganze Insel',
  `z von ${Math.min(...gras).toFixed(0)} bis ${Math.max(...gras).toFixed(0)}`,
);

/*
 * Die Grenzsteine. Eine Reihe ist eine Reihe, wenn sie **quer** über die Insel
 * geht — acht Steine auf einem Haufen wären keine.
 *
 * **Gesucht statt abgeschrieben.** Hier stand die Liste der Grenzen als vier
 * Zahlen, und beim Strecken der Insel zeigten alle vier auf leeres Gras: der
 * Test meldete vier fehlende Reihen, obwohl jede stand — nur eben viermal
 * weiter nördlich. Gefragt ist ohnehin nicht „steht bei z = 55 eine Reihe",
 * sondern „es gibt vier Reihen, sie liegen quer, und dazwischen liegt
 * Strecke".
 */
const MARKEN = new Set(['hinkelstein', 'meilenstein', 'steinmann', 'bildstock', 'runenstein']);
const markenZ = doc.props.filter((p) => MARKEN.has(p.model));

/*
 * Gesucht wird mit einem **Schiebefenster** und nicht mit festen Fächern.
 *
 * Zwei Gründe, und beide sind hier passiert. Erstens versetzt der Generator
 * jeden Stein um bis zu drei Meter in `z`, damit die Reihe nicht wie mit dem
 * Lineal gezogen aussieht — an einer Fachgrenze zerfiel eine Reihe dadurch in
 * zwei halbe. Zweitens steht im Geröllfeld auch gestreut ein Steinmann; auf
 * zweihundert Metern Zonenlänge kommen so zufällig zehn Stück in ein Fach,
 * und zehn zufällige Steine sahen aus wie eine fünfte Grenze.
 *
 * Eine gesetzte Reihe hat gut dreissig Steine auf einer Linie. Zwanzig als
 * Schwelle trennt sie sauber vom Zufall.
 */
const fenster = (z: number): number[] =>
  markenZ.filter((p) => Math.abs(p.position[2] - z) <= 5).map((p) => p.position[0]);
const roh: Array<{ z: number; xs: number[] }> = [];
for (let z = laengsachse.von; z <= laengsachse.bis; z += 2) {
  const xs = fenster(z);
  if (xs.length >= 20 && Math.max(...xs) - Math.min(...xs) > breite * 0.7) roh.push({ z, xs });
}
// Benachbarte Treffer gehören zur selben Reihe — der beste bleibt.
const reihen: Array<{ z: number; weite: number; zahl: number }> = [];
for (const treffer of roh) {
  const letzte = reihen[reihen.length - 1];
  if (letzte && treffer.z - letzte.z < 30) {
    if (treffer.xs.length > letzte.zahl) {
      letzte.z = treffer.z;
      letzte.zahl = treffer.xs.length;
      letzte.weite = Math.max(...treffer.xs) - Math.min(...treffer.xs);
    }
    continue;
  }
  reihen.push({
    z: treffer.z,
    zahl: treffer.xs.length,
    weite: Math.max(...treffer.xs) - Math.min(...treffer.xs),
  });
}

check(
  reihen.length === 4,
  'vier Grenzen sind als Reihe quer über die Insel gesetzt',
  reihen.map((r) => `z=${r.z} (${r.zahl} Steine, ${r.weite.toFixed(0)} m)`).join(', ') || 'keine',
);
/*
 * Und sie liegen **auseinander**. Ohne diese Zeile wären auch vier Reihen im
 * Abstand von zwölf Metern grün — vier Grenzen an derselben Stelle sind eine
 * Mauer und keine Einteilung.
 */
const abstaende = reihen.slice(1).map((r, i) => r.z - reihen[i]!.z);
check(
  abstaende.length === 3 && Math.min(...abstaende) > laenge * 0.1,
  'und keine zwei liegen beieinander',
  abstaende.map((a) => `${a.toFixed(0)} m`).join(' / ') || 'keine',
);
/*
 * Gegenprobe: **zwischen** zwei Grenzen steht keine solche Reihe. Ohne sie
 * wäre auch ein Generator grün, der die ganze Karte mit Hinkelsteinen
 * zupflastert — dann wäre jede Stelle eine Grenze und damit keine.
 */
const mitte = reihen.length >= 2 ? (reihen[0]!.z + reihen[1]!.z) / 2 : 0;
const mitten = doc.props.filter((p) => MARKEN.has(p.model) && Math.abs(p.position[2] - mitte) < 6);
check(mitten.length < 6, 'mitten in einer Zone steht keine', `${mitten.length} bei z = ${mitte.toFixed(0)}`);

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
 * Wo „draussen" anfängt: die Küste schwankt um bis zu fünfundzwanzig Meter um
 * ihre Linie, und die Klippe braucht rund zwölf Meter, bis sie ihre volle
 * Tiefe hat. Fünfundvierzig Meter jenseits der gemessenen Enden ist die
 * Aussage eindeutig — davor liegt der Strand, und der soll tragen.
 *
 * Gemessen und nicht abgeschrieben: hier standen die Kanten der alten Insel
 * als Zahlen, und nach dem Strecken lag der halbe Prüfbereich auf der Wiese.
 * Der Test meldete eine zwanzig Meter hohe Kuppe „draussen" — sie stand
 * mitten auf der Insel.
 */
const saum = 45;
let traegtDraussen = 0;
let hoechsteKuppe = -1e9;
for (let z = -halb; z <= halb; z += 6) {
  for (let x = -halb; x <= halb; x += 6) {
    const draussen =
      Math.abs(x) > halbBreite + saum || Math.abs(z - mitteZ) > halbLaenge + saum;
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

/*
 * --- Der Weg liegt im Boden ------------------------------------------------
 *
 * Die Laternen standen schon immer an einer Linie, aber darunter war Wiese wie
 * überall: eine Reihe Lichter über Gras, und wo der Weg langgeht, sah man erst
 * an der nächsten Laterne. Die Bodentexturen entscheiden nach **Neigung** —
 * Erde ab vierundzwanzig Grad —, und ein Weg ist flach. Deshalb ist er
 * gemalt, und deshalb steht hier, dass er es ist.
 */
console.log('\nDer Weg liegt im Boden');

const malfeld = decodePaintField(doc.terrain.paint);
check(malfeld !== undefined, 'die Karte bringt ein Malfeld mit');
const malWerte = malfeld ?? new Uint8Array(0);
const malAufloesung = doc.terrain.paint?.resolution ?? 0;
/** Der Index der Erdebene — aus der Ebenenliste und nicht abgezählt. */
const erdeEbene = doc.terrain.layers.findIndex((l) => l.id === 'erde');
const grasEbene = doc.terrain.layers.findIndex((l) => l.id === 'gras');
check(erdeEbene >= 0 && grasEbene >= 0, 'die Karte kennt Gras und Erde', `${grasEbene} / ${erdeEbene}`);

/** Die gemalten Gewichte an einer Stelle, 0 bis 255. */
const gemalt = (x: number, z: number): number[] => {
  const werteHier: number[] = [0, 0, 0, 0];
  if (malAufloesung >= 2) {
    sampleField(malWerte, malAufloesung, doc.terrain.size, x, z, MAX_GROUND_LAYERS, werteHier);
  }
  return werteHier;
};

/**
 * Die Mitte der Strasse auf dieser Höhe — aus dem Malfeld gelesen.
 *
 * Nicht bei x = 0 gesucht und schon gar nicht aus einer zweiten Kopie der
 * Stützpunkte: gemalt ist der Weg, den man sieht. Läge der woanders als der,
 * den der Generator meint, wäre genau das der Fehler. Seit die Strasse
 * schwingt, ist das keine Feinheit mehr — sie steht stellenweise achtzig
 * Meter neben der Mitte der Karte.
 */
function wegMitteBei(z: number): number | undefined {
  let summe = 0;
  let gewicht = 0;
  for (let x = -halbBreite; x <= halbBreite; x += 2) {
    const w = gemalt(x, z)[erdeEbene]!;
    if (w <= 8) continue;
    summe += x * w;
    gewicht += w;
  }
  return gewicht > 0 ? summe / gewicht : undefined;
}

/*
 * Auf der Strasse: Erde, und zwar überwiegend — von der Stadt bis zum Tor.
 * Zehn Stellen über zwölfhundert Meter; eine einzelne sagte nur, dass
 * irgendwo ein Fleck liegt.
 */
let aufDemWeg = 0;
let schwaechste = 255;
for (let i = 0; i <= 10; i++) {
  const z = doc.spawn.z + ((tor.position[1] - doc.spawn.z) * i) / 10;
  const w = gemalt(wegMitteBei(z) ?? 0, z);
  if (w[erdeEbene]! > w[grasEbene]!) aufDemWeg++;
  schwaechste = Math.min(schwaechste, w[erdeEbene]!);
}
check(
  aufDemWeg === 11,
  'auf der ganzen Strecke liegt Erde statt Gras',
  `${aufDemWeg} von 11 Stellen, schwächste ${schwaechste}`,
);

/*
 * Gegenprobe, und ohne sie wäre die Zeile darüber wertlos: **daneben** ist
 * nichts gemalt. Ein Malfeld, das überall Erde sagt, machte aus der Insel
 * einen Acker — und die Prüfung oben wäre trotzdem grün.
 */
let danebenGemalt = 0;
for (let i = 0; i <= 10; i++) {
  const z = doc.spawn.z + ((tor.position[1] - doc.spawn.z) * i) / 10;
  const mitte = wegMitteBei(z) ?? 0;
  // Abstände zur **Strassenmitte**, nicht zur Kartenmitte: die Kurve läuft
  // sonst durch die Stelle, an der nichts sein soll.
  for (const abstand of [-40, 40, -200, 200]) {
    const w = gemalt(mitte + abstand, z);
    if (w.reduce((a, b) => a + b, 0) > 0) danebenGemalt++;
  }
}
check(danebenGemalt === 0, 'vierzig Meter daneben ist nichts gemalt', `${danebenGemalt} von 44 Stellen`);

// Und der Weg hört auf, wo er aufhört: hinter der Stadt und jenseits des Tores
// führt keiner weiter.
const hinterDerStadt = gemalt(wegMitteBei(doc.spawn.z + 40) ?? 0, laengsachse.von + 60).reduce(
  (a, b) => a + b,
  0,
);
const hinterDemTor = gemalt(0, tor.position[1] + 40).reduce((a, b) => a + b, 0);
check(
  hinterDerStadt === 0 && hinterDemTor === 0,
  'und südlich der Stadt wie nördlich des Tores hört er auf',
  `${hinterDerStadt} / ${hinterDemTor}`,
);

/*
 * Und er bleibt ein Weg: gemalt ist ein schmales Band, keine Fläche. Über die
 * ganze Karte gerechnet dürfen es nicht mehr als zwei Prozent sein.
 */
let gemalteStuetzpunkte = 0;
for (let i = 0; i < malAufloesung * malAufloesung; i++) {
  let summe = 0;
  for (let l = 0; l < MAX_GROUND_LAYERS; l++) summe += malWerte[i * MAX_GROUND_LAYERS + l]!;
  if (summe > 0) gemalteStuetzpunkte++;
}
const anteilGemalt = gemalteStuetzpunkte / (malAufloesung * malAufloesung);
check(
  anteilGemalt > 0.002 && anteilGemalt < 0.02,
  'gemalt ist ein Band und keine Fläche',
  `${(anteilGemalt * 100).toFixed(1)} % der Stützpunkte`,
);

/*
 * --- Der Weg macht Kurven, und das Land steigt in Stufen -------------------
 *
 * Beides war einmal nicht so: die Strasse lief achtzehnhundert Meter schnurgerade
 * bei x = 0, und das Land lag von der Südküste bis zum Tor auf derselben Höhe.
 * Man sah das Ziel von der Mitte aus, und links und rechts kam nie in den
 * Blick, weil es keinen Grund gab hinzusehen.
 *
 * Eine Kurve ist aber nur dann besser, wenn man sie auch **gehen** kann —
 * deshalb steht hier beides: dass der Weg schwingt, und dass er dabei nirgends
 * steiler wird, als der Kern einen Schritt annimmt.
 */
console.log('\nDer Weg macht Kurven, und das Land steigt in Stufen');

const wegPunkte: Array<{ z: number; x: number }> = [];
for (let z = doc.spawn.z + 40; z <= tor.position[1] - 10; z += 10) {
  const x = wegMitteBei(z);
  if (x !== undefined) wegPunkte.push({ z, x });
}
check(wegPunkte.length > 100, 'der Weg ist über die ganze Strecke zu finden', `${wegPunkte.length} Stellen`);

const wegXs = wegPunkte.map((p) => p.x);
const ausschlag = Math.max(...wegXs) - Math.min(...wegXs);
check(ausschlag > 80, 'und er schwingt aus, statt gerade zu laufen', `${ausschlag.toFixed(0)} m quer`);
/*
 * Gegenprobe: er schwingt **und kommt an**. Ein Weg, der irgendwohin mäandert,
 * wäre auch krumm — Anfang und Ende liegen aber am Stadttor und am Bannkreis,
 * und beide stehen bei x = 0.
 */
check(
  Math.abs(wegPunkte[0]!.x) < 25 && Math.abs(wegPunkte[wegPunkte.length - 1]!.x) < 25,
  'und fängt am Tor an und hört am Tor auf',
  `${wegPunkte[0]!.x.toFixed(0)} → ${wegPunkte[wegPunkte.length - 1]!.x.toFixed(0)}`,
);

/*
 * **Begehbar von der Stadt bis zum Tor.** Zweiundfünfzig Grad ist die Schwelle
 * im Kern; wo die Strasse eine Terrassenkante nimmt, muss dort eine Rampe
 * liegen. Ohne diese Prüfung fiele erst beim Laufen auf, dass der Weg gegen
 * eine Wand führt — nach drei Minuten Fussmarsch.
 */
let steilsteAmWeg = 0;
let steilsteStelle = 0;
for (const p of wegPunkte) {
  const g = grad(neigungAn(p.x, p.z));
  if (g > steilsteAmWeg) {
    steilsteAmWeg = g;
    steilsteStelle = p.z;
  }
}
check(
  steilsteAmWeg < 45,
  'und man kommt ihn hinauf, ohne zu klettern',
  `steilste Stelle ${steilsteAmWeg.toFixed(0)}° bei z = ${steilsteStelle.toFixed(0)}`,
);

/*
 * Und die Gegenprobe dazu, ohne die alles davon nichts sagte: **daneben** ist
 * es sehr wohl steil. Läge die ganze Insel flach, wäre der Weg trivial
 * begehbar und die Terrassen gäbe es nur im Kommentar.
 */
let steileFlecken = 0;
for (let z = laengsachse.von + 40; z <= laengsachse.bis - 40; z += 6) {
  for (let x = -halbBreite + 40; x <= halbBreite - 40; x += 6) {
    if (grad(neigungAn(x, z)) > 52) steileFlecken++;
  }
}
check(
  steileFlecken > 200,
  'abseits davon steht das Land in Kanten',
  `${steileFlecken} Stellen über 52° im Inneren`,
);

/*
 * Die Stufen selbst: von der Südküste bis zum Tor geht es hinauf, und zwar
 * **in Absätzen**. Gemessen wird an der Strasse, in Schritten von zwanzig
 * Metern: ein Absatz ist ein Schritt, der mehr als anderthalb Meter steigt.
 */
const hoehenAmWeg: number[] = [];
for (let z = doc.spawn.z; z <= tor.position[1]; z += 20) {
  hoehenAmWeg.push(hoeheAn(wegMitteBei(z) ?? 0, z));
}
const anstieg = hoehenAmWeg[hoehenAmWeg.length - 1]! - hoehenAmWeg[0]!;
let absaetze = 0;
for (let i = 1; i < hoehenAmWeg.length; i++) {
  if (hoehenAmWeg[i]! - hoehenAmWeg[i - 1]! > 1.5) absaetze++;
}
check(anstieg > 18, 'das Tor liegt hoch über der Stadt', `${anstieg.toFixed(0)} m höher`);
check(absaetze >= 3 && absaetze < hoehenAmWeg.length / 3, 'und dazwischen liegen Absätze', `${absaetze} von ${hoehenAmWeg.length - 1} Schritten steigen`);

/*
 * Und die Teiche: zwei Mulden im Land, in denen Wasser steht. Sie liegen weit
 * genug von der Küste, dass es nicht das Meer ist — sonst wäre die Prüfung
 * mit jeder Bucht zufrieden.
 */
let teichPunkte = 0;
for (let z = laengsachse.von + 60; z <= laengsachse.bis - 60; z += 6) {
  for (let x = -halbBreite + 60; x <= halbBreite - 60; x += 6) {
    if (hoeheAn(x, z) < doc.terrain.waterLevel) teichPunkte++;
  }
}
check(teichPunkte > 40, 'im Land stehen Teiche', `${teichPunkte} Stützpunkte unter dem Spiegel`);

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
 *
 * Hier stand für die zweite Hälfte einmal `collisionHeight === 0`, also
 * „reicht bis in den Himmel". Diese Null gibt es nicht mehr: sie versperrte
 * auch den Weg, der sechsundzwanzig Meter über dem Prop über einen
 * schwebenden Felsen führte. Jedes Hindernis trägt jetzt die Höhe seines
 * Modells, und „darüber kommt man nicht" heisst schlicht: höher als der
 * Sprung.
 */
const SPRUNGHOEHE = 1.68;
const mitKreis = karten.flatMap((k) => k.props).filter((p) => p.collision === 'circle');
const ueberspringbar = mitKreis.filter(
  (p) => p.collisionHeight > 0 && p.collisionHeight * p.scale < SPRUNGHOEHE,
);
const zuHoch = mitKreis.filter((p) => p.collisionHeight * p.scale >= SPRUNGHOEHE);
check(
  ueberspringbar.length > 200,
  'über einen guten Teil der Hindernisse springt man hinweg',
  `${ueberspringbar.length} von ${mitKreis.length}`,
);
check(
  zuHoch.length > 200,
  'und über den Rest nicht',
  `${zuHoch.length} von ${mitKreis.length}`,
);
/*
 * Und keines reicht mehr in den Himmel. Das ist die eigentliche neue Zeile:
 * ohne sie käme die Null über den Generator jederzeit zurück, und der Fehler
 * — anstossen an etwas, das weit unter einem liegt — sähe wieder wie ein
 * kaputtes Spiel aus.
 */
check(
  mitKreis.every((p) => p.collisionHeight > 0),
  'und keines reicht bis in den Himmel',
  `${mitKreis.filter((p) => p.collisionHeight <= 0).length} ohne Höhe`,
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
