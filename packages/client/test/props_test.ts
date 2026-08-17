/**
 * Der Prop-Katalog — ohne GPU, ohne Browser.
 *
 * Fünf Behauptungen, und jede deckt einen Fehler ab, den man auf einem Bild
 * **nicht** sieht:
 *
 *   1. **Katalog und Kollisionstabelle decken sich.** Ein Modell ohne Eintrag
 *      steht nirgends im Weg (die Vorgabe ist `none`) — das fällt erst auf,
 *      wenn jemand durch eine Statue läuft. Ein Eintrag ohne Modell ist eine
 *      Zeile, die nie greift.
 *   2. **Jedes Modell, das eine Karte nennt, lässt sich bauen.** Ein Tippfehler
 *      im Generator ergibt keinen Absturz, sondern `fallbackProp` — einen roten
 *      Kasten mitten in der Landschaft. Auf einer Karte mit zweitausend Props
 *      sucht den niemand.
 *   3. **Alles steht auf dem Boden.** Der Ursprung gehört an die Unterkante,
 *      sonst schwebt das Prop oder steckt zur Hälfte im Hang. Die Ausnahmen
 *      stehen namentlich hier — und die Gegenprobe prüft, dass sie es auch
 *      wirklich sind.
 *   4. **Kein Prop ist unbezahlbar.** Zweitausend Stück auf einer Karte tragen
 *      nur, weil jedes einzelne klein ist.
 *   5. **Der Kollisionskreis passt zum Modell.** Ein Kreis, der weiter reicht
 *      als das, was man sieht, ist eine unsichtbare Wand.
 *
 *   npx tsx packages/client/test/props_test.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { PROP_BUILDERS } from '../src/render/props.ts';
import { PROP_KOLLISION } from '@aurelith/shared';

let failures = 0;
function check(ok: boolean, was: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${was}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('Aurelith — Props\n');

const schluessel = Object.keys(PROP_BUILDERS);
const tabelle = Object.keys(PROP_KOLLISION);

console.log('Katalog und Kollisionstabelle decken sich');

const ohneEintrag = schluessel.filter((k) => !tabelle.includes(k));
const ohneModell = tabelle.filter((k) => !schluessel.includes(k));
check(ohneEintrag.length === 0, 'jedes Modell steht in der Tabelle', ohneEintrag.join(', ') || 'keines fehlt');
check(ohneModell.length === 0, 'und jede Zeile der Tabelle hat ein Modell', ohneModell.join(', ') || 'keine übrig');
// Gegenprobe: die beiden Listen sind nicht deshalb gleich, weil sie leer sind.
check(schluessel.length > 100, 'und es sind wirklich viele', `${schluessel.length} Modelle`);

console.log('\nJedes Modell, das eine Karte nennt, lässt sich bauen');

const repo = join(import.meta.dirname, '..', '..', '..');
const genutzt = new Set<string>();
interface Karte {
  name: string;
  spawn?: { x: number; z: number };
  props: Array<{ model: string; position: [number, number, number]; collision: string; collisionRadius: number; scale: number }>;
}
const karten: Karte[] = [];
for (const name of ['lichtmoor', 'dornwald', 'gruft_01']) {
  const doc = JSON.parse(readFileSync(join(repo, 'assets', 'maps', `${name}.json`), 'utf8')) as Karte;
  karten.push({ ...doc, name });
  for (const p of doc.props) genutzt.add(p.model);
}
const unbekannt = [...genutzt].filter((m) => !(m in PROP_BUILDERS));
check(unbekannt.length === 0, 'kein Modell auf den Karten fehlt im Katalog', unbekannt.join(', ') || 'keines');
check(genutzt.size > 60, 'und die Karten nutzen den Katalog auch aus', `${genutzt.size} von ${schluessel.length}`);

/*
 * --- Der Startpunkt bleibt frei --------------------------------------------
 *
 * Beim Befüllen der Stadt stand die Statue zwei Meter neben dem Punkt, an dem
 * jeder Spieler die Karte betritt — und sie hat einen Kollisionskreis. Man
 * erschien also im Sockel und musste sich erst herausschieben.
 *
 * Das ist die Sorte Fehler, die man beim Hinsehen nicht findet: auf einem Bild
 * sieht die Statue am richtigen Platz aus, und wer den Startpunkt kennt, hat
 * ihn nicht im Kopf, während er Marktstände setzt.
 */
console.log('\nDer Startpunkt bleibt frei');

const imWeg: string[] = [];
let naechster = Infinity;
for (const karte of karten) {
  if (!karte.spawn) continue;
  for (const p of karte.props) {
    if (p.collision === 'none') continue;
    const d = Math.hypot(p.position[0] - karte.spawn.x, p.position[2] - karte.spawn.z);
    const rand = d - p.collisionRadius * (p.scale ?? 1);
    naechster = Math.min(naechster, rand);
    if (rand < 1.5) imWeg.push(`${karte.name}/${p.model} in ${rand.toFixed(1)} m`);
  }
}
check(imWeg.length === 0, 'kein Prop steht auf dem Startpunkt', imWeg.slice(0, 3).join(' · ') || 'keines');
// Gegenprobe: es steht überhaupt etwas in der Nähe. Läge das nächste Prop
// achtzig Meter entfernt, prüfte die Zeile darüber eine leere Wiese.
check(naechster < 12, 'und trotzdem steht etwas in Sichtweite', `nächstes bei ${naechster.toFixed(1)} m`);

/*
 * Die Ausnahmen von „steht auf dem Boden".
 *
 * Jede hat einen Grund, und der Grund gehört hierher: sonst trägt jemand beim
 * nächsten Aufräumen die Zahl nach, statt zu merken, dass sie so gemeint ist.
 */
const HAENGT: Readonly<Record<string, string>> = {
  // Der Zapfen wächst von der Decke nach unten — sein Ursprung liegt oben.
  stalaktit: 'hängt an der Decke',
  // Sie wird an eine Wand geschraubt, nicht in den Boden gesteckt.
  wandfackel: 'sitzt an der Wand',
  // Der Ursprung liegt in der begehbaren Fläche, nicht an der Unterkante —
  // sonst müsste die Höhe der Scheibe an zwei Stellen stehen.
  fels_schwebend: 'Ursprung in der Wiese obenauf',
  fels_schwebend_klein: 'Ursprung in der Wiese obenauf',
};

console.log('\nAlles steht auf dem Boden');

const gebaut = new Map<string, THREE.BufferGeometry>();
for (const k of schluessel) gebaut.set(k, PROP_BUILDERS[k]!());

const schwebt: string[] = [];
for (const [k, geo] of gebaut) {
  if (k in HAENGT) continue;
  geo.computeBoundingBox();
  const y = geo.boundingBox!.min.y;
  if (y > 0.4 || y < -0.75) schwebt.push(`${k} (${y.toFixed(2)} m)`);
}
check(schwebt.length === 0, 'kein Prop schwebt und keines steckt fest', schwebt.slice(0, 4).join(' · ') || 'keines');

/*
 * Die Gegenprobe zur Ausnahmeliste.
 *
 * Ohne sie bliebe ein Name darin stehen, nachdem das Modell längst am Boden
 * sitzt — und dann prüft die Zeile darüber ein Prop weniger, ohne dass es
 * jemand merkt.
 */
const zuUnrecht: string[] = [];
for (const [k, grund] of Object.entries(HAENGT)) {
  const geo = gebaut.get(k)!;
  geo.computeBoundingBox();
  const y = geo.boundingBox!.min.y;
  if (y <= 0.4 && y >= -0.75) zuUnrecht.push(`${k} steht bei ${y.toFixed(2)} m (${grund})`);
}
check(zuUnrecht.length === 0, 'und jede Ausnahme ist auch eine', zuUnrecht.join(' · ') || `${Object.keys(HAENGT).length} geprüft`);

console.log('\nKein Prop ist unbezahlbar');

let gesamt = 0;
let groesstes = '';
let maxDreiecke = 0;
const teuer: string[] = [];
for (const [k, geo] of gebaut) {
  const n = (geo.index ? geo.index.count : geo.attributes.position!.count) / 3;
  gesamt += n;
  if (n > maxDreiecke) {
    maxDreiecke = n;
    groesstes = k;
  }
  if (n > 1600) teuer.push(`${k} (${n})`);
}
check(teuer.length === 0, 'keines über 1600 Dreiecken', teuer.join(', ') || `grösstes: ${groesstes} mit ${maxDreiecke}`);
// Gegenprobe: die Grenze greift nur, wenn überhaupt etwas in ihre Nähe kommt.
// Lauter Modelle mit zwanzig Dreiecken wären auch unter 1600 und trotzdem
// Kisten.
check(maxDreiecke > 200, 'und die Grenze ist keine leere Zusicherung', `${maxDreiecke} Dreiecke`);
console.log(`  · ${schluessel.length} Modelle, ${gesamt} Dreiecke, im Schnitt ${Math.round(gesamt / schluessel.length)}`);

console.log('\nDer Kollisionskreis passt zum Modell');

const zuWeit: string[] = [];
let engster = { key: '', anteil: 1 };
for (const [k, geo] of gebaut) {
  const kol = PROP_KOLLISION[k]!;
  if (kol.form !== 'circle') continue;
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const halb = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.5;
  if (kol.radius > halb + 0.2) zuWeit.push(`${k}: Kreis ${kol.radius} zu ${halb.toFixed(2)} m Modell`);
  const anteil = kol.radius / Math.max(halb, 1e-6);
  if (anteil < engster.anteil) engster = { key: k, anteil };
}
check(zuWeit.length === 0, 'kein Kreis reicht weiter als das Modell', zuWeit.slice(0, 4).join(' · ') || 'keiner');
/*
 * Und die Gegenprobe in die andere Richtung: bei manchen Modellen ist der
 * Kreis **absichtlich** viel enger. Eine Baumkrone ist drei Meter breit, aber
 * anstossen tut man am Stamm. Fände die Prüfung nirgends so einen Fall, wäre
 * die Tabelle einfach aus den Bounding-Boxen abgeschrieben — und dann liefe
 * man um Kronen herum statt um Stämme.
 */
check(engster.anteil < 0.5, 'und mancher ist bewusst viel enger', `${engster.key} bei ${(engster.anteil * 100).toFixed(0)} %`);

console.log('\nUnd seine Höhe ist die des Modells');

/*
 * Kein Kreis reicht mehr in den Himmel.
 *
 * Die Höhe war einmal null für alles, worüber man nicht springen soll —
 * Bäume, Säulen, Felsen — und null hiess im Kern „bis in die Wolken". Für den
 * Sprung stimmte das und im Raum nicht: ein Fels am Boden versperrte den Weg,
 * der sechsundzwanzig Meter darüber über einen schwebenden Felsen führte. Man
 * lief oben über eine ebene Fläche und stiess an etwas an, das weit unter
 * einem lag.
 *
 * Geprüft wird gegen das Modell und nicht gegen eine Liste erlaubter Zahlen:
 * eine Liste wäre eine zweite Tabelle neben der ersten, und die veraltet.
 */
const ohneHoehe: string[] = [];
const falscheHoehe: string[] = [];
for (const [k, geo] of gebaut) {
  const kol = PROP_KOLLISION[k]!;
  if (kol.form !== 'circle') continue;
  if (kol.hoehe <= 0) {
    ohneHoehe.push(k);
    continue;
  }
  geo.computeBoundingBox();
  const modell = geo.boundingBox!.max.y;
  // Fünf Zentimeter Toleranz: so grob steht die Zahl in der Tabelle.
  if (Math.abs(kol.hoehe - modell) > 0.06) {
    falscheHoehe.push(`${k}: ${kol.hoehe} statt ${modell.toFixed(2)}`);
  }
}
check(ohneHoehe.length === 0, 'jeder Kreis nennt seine Höhe', ohneHoehe.slice(0, 5).join(', ') || 'keiner ohne');
check(
  falscheHoehe.length === 0,
  'und sie ist die des Modells',
  falscheHoehe.slice(0, 4).join(' · ') || 'alle passen',
);

/*
 * Gegenprobe: es gibt sowohl Props, über die man springt, als auch solche,
 * über die man nicht springt. Fehlte eine der beiden Gruppen, wäre die
 * Sprunghöhe entweder bedeutungslos oder die Karte ein Hindernisparcours —
 * und die Prüfung darüber wäre mit beidem zufrieden.
 */
const SPRUNG = 1.68;
const kreise = [...gebaut.keys()].filter((k) => PROP_KOLLISION[k]!.form === 'circle');
const drueber = kreise.filter((k) => PROP_KOLLISION[k]!.hoehe < SPRUNG);
check(
  drueber.length > 0 && drueber.length < kreise.length,
  'über manche springt man und über andere nicht',
  `${drueber.length} von ${kreise.length} unter der Scheitelhöhe`,
);

for (const geo of gebaut.values()) geo.dispose();

console.log(
  `\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
