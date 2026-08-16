#!/usr/bin/env node
/**
 * Rauchtest: Beute fällt zu Boden und lässt sich aufheben.
 *
 * Die Regeln dahinter prüft `packages/server/test/loot_test.ts`, den Weg über
 * das Protokoll `packages/server/test/npcflow_test.ts`. Hier geht es um das,
 * was beide nicht sehen können: dass der Haufen im Bild auftaucht, dass ein
 * Schild darüber steht, und dass ein Klick darauf ihn tatsächlich aufhebt.
 *
 *   node tools/smoke-loot.mjs
 *
 * Die Figur startet mitten auf der Irrlichtwiese — `AURELITH_START_POS` spart
 * den Fussweg aus der Stadt, der sonst die halbe Laufzeit wäre.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { anmeldenUndBetreten } from './lib/spielstart.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const procs = [];

function launch(command, env = {}) {
  const child = spawn('bash', ['-lc', command], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  procs.push({ child, log });
  return { child, log };
}

function shutdown() {
  for (const { child } of procs) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Schon beendet.
    }
  }
}
process.on('exit', shutdown);

let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

/** Wie oft im Verlauf schon etwas aufgehoben wurde. */
const meldungen = async () =>
  (((await page.locator('.chat-log').textContent()) ?? '').match(/Aufgehoben:/g) ?? []).length;

const waitUntil = async (fn, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

console.log('Aurelith — Beute am Boden\n');

const server = launch('npx tsx packages/server/src/index.ts', {
  AURELITH_PORT: '8794',
  // Mitten in den Irrlichtschwarm bei (−46, −58), südlich der Stadtmauer.
  AURELITH_START_POS: '-44,-56',
  DATABASE_URL: '',
});
launch('cd packages/client && npx vite --port 5198 --strictPort --host 127.0.0.1', {
  AURELITH_SERVER: 'ws://127.0.0.1:8794',
});

if (!(await waitUntil(async () => server.log.join('').includes('bereit'), 60000))) {
  console.error(server.log.join(''));
  throw new Error('Spielserver kam nicht hoch');
}
if (
  !(await waitUntil(async () => {
    try {
      return (await fetch('http://127.0.0.1:5198/')).ok;
    } catch {
      return false;
    }
  }, 60000))
) {
  throw new Error('Client-Server kam nicht hoch');
}

const executablePath = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
].find((p) => existsSync(p));

const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
});

// Kleines Fenster, halbe Punktdichte — und zwar aus einem handfesten Grund:
// gezeichnet wird hier in SwiftShader, also auf der CPU, und die Bildrate
// hängt fast ausschliesslich an der Zahl der Bildpunkte. Der Client deckelt
// den Simulationsschritt je Bild; bei zwei Bildern je Sekunde läuft die Figur
// deshalb in echter Zeit gemessen nur noch ein Sechstel so schnell, während
// die Monster auf dem Server mit voller Geschwindigkeit umherwandern — der
// Bot bekäme sie nie zu fassen.
//
// Gemessen, nicht geraten: 1100×700 bei voller Dichte ergaben 2,0 Bilder/s
// und 0,96 Einheiten/s, 800×520 bei halber Dichte 7,4 Bilder/s und 3,59
// Einheiten/s. Ein wanderndes Irrlicht ist mit 1,44 Einheiten/s unterwegs —
// darüber muss die Figur liegen, sonst holt sie es nie ein. Auf die
// Prüfungen wirkt die Dichte nicht: `getBoundingClientRect` liefert
// CSS-Punkte, keine Gerätepunkte.
const BREITE = 800;
const HOEHE = 520;
const page = await browser.newPage({
  viewport: { width: BREITE, height: HOEHE },
  deviceScaleFactor: 0.5,
});
const fehler = [];
page.on('pageerror', (err) => fehler.push(String(err)));

const name = `Beute${Date.now() % 100000}`;
await page.goto('http://127.0.0.1:5198/', { waitUntil: 'domcontentloaded' });
await anmeldenUndBetreten(page, name);
await page.waitForTimeout(2500);

const beginn = Date.now();
console.log('Prüfungen');

// --- Vorher liegt nichts ---------------------------------------------------
//
// Die Gegenprobe muss zuerst kommen: eine Ansicht, die von Anfang an Haufen
// zeigt, würde jede folgende Prüfung bestehen, ohne dass je etwas gefallen
// wäre.
check(
  (await page.evaluate(() => window.aurelith.lootCount)) === 0,
  'vor dem ersten Kampf liegt nichts herum',
);
check(
  (await page.locator('.loot-label').count()) === 0,
  'und es steht kein Beuteschild im Bild',
);

// --- Die Monster wandern von selbst ----------------------------------------
//
// Irrlichter greifen niemanden von selbst an: bewegt sich eines, während die
// Figur die Hände im Schoss hat, dann weil es umherwandert. Die Regel dahinter
// prüft `packages/core/test/native_test.cpp` — hier geht es darum, dass die
// Bewegung durch Snapshot und Zeichnung bis ins Bild kommt.
//
// Gemessen werden die Namensschilder, weil `window.aurelith` die Weltlage von
// Monstern bewusst nicht hergibt. Sortiert, damit ein Tausch der Reihenfolge
// nicht als Bewegung durchgeht.
// Nur, was wirklich im Bild steht: ein Schild hinter der Kamera wird auf
// Koordinaten weit ausserhalb projiziert und springt dort um Tausende von
// Bildpunkten, sobald sich das Wesen bewegt. Die Prüfung ginge daran nicht
// kaputt — die Kamera steht ja still —, aber die genannte Zahl hätte mit dem
// Weg des Monsters nichts mehr zu tun.
const monsterPunkte = () =>
  page.evaluate(() => {
    const punkte = [];
    for (const plate of document.querySelectorAll('.nameplate[data-kind="monster"]')) {
      if (plate.style.display === 'none') continue;
      const box = plate.getBoundingClientRect();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      if (x < 0 || x > window.innerWidth || y < 0 || y > window.innerHeight) continue;
      punkte.push([x, y]);
    }
    punkte.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return punkte;
  });

// Kurze Abschnitte, verglichen mit dem Vorgänger **und** mit dem Anfang. Die
// Schilderliste ist nur so lange zuordenbar, wie gleich viele darin stehen —
// deshalb die kurzen Abschnitte. Aber ein Irrlicht rastet zehn Sekunden am
// Stück, und wer nur Nachbarn vergleicht, erwischt womöglich lauter Pausen:
// ein Lauf meldete acht vergleichbare Abschnitte und fünf Bildpunkte. Der
// Vergleich mit dem Anfang sieht auch die Strecke, die in vielen kleinen
// Schritten zusammengekommen ist.
const ABSCHNITTE = 12;
const abstandZu = (a, b) => {
  if (a.length === 0 || a.length !== b.length) return -1;
  let weit = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]);
    if (d > weit) weit = d;
  }
  return weit;
};

const stelleVorher = await page.evaluate(() => ({ ...window.aurelith.player }));
const anfang = await monsterPunkte();
let vorige = anfang;
let weiteste = 0;
let vergleichbar = 0;
for (let runde = 0; runde < ABSCHNITTE; runde++) {
  await page.waitForTimeout(1500);
  const jetzt = await monsterPunkte();
  const zumVorgaenger = abstandZu(jetzt, vorige);
  if (zumVorgaenger >= 0) {
    vergleichbar++;
    if (zumVorgaenger > weiteste) weiteste = zumVorgaenger;
  }
  const zumAnfang = abstandZu(jetzt, anfang);
  if (zumAnfang > weiteste) weiteste = zumAnfang;
  vorige = jetzt;
}
const stelleNachher = await page.evaluate(() => ({ ...window.aurelith.player }));

// Gegenprobe: hätte sich die Figur bewegt, wäre auch die Kamera mit ihr
// gewandert, und dann verschiebt sich jedes Schild im Bild — ohne dass ein
// Monster einen Schritt getan hätte.
const eigenerWeg = Math.hypot(
  stelleNachher.x - stelleVorher.x,
  stelleNachher.z - stelleVorher.z,
);
check(eigenerWeg < 0.1, 'die Figur steht dabei still', `${eigenerWeg.toFixed(2)} Einheiten`);

check(
  vergleichbar >= 3 && weiteste > 8,
  'die Monster wandern von selbst umher',
  `${vergleichbar} von ${ABSCHNITTE} Abschnitten vergleichbar, ` +
    `weiteste Verschiebung ${Math.round(weiteste)} px`,
);

// --- Ein Irrlicht suchen und erlegen ---------------------------------------
//
// Irrlichter greifen nicht von selbst an, also muss die Figur zu ihnen. Der
// Bot steuert nach dem, was **im Bild** steht: die Namensschilder sind nach
// Entfernung sortiert, das erste ist das nächste Wesen. Liegt es links der
// Bildmitte, wird die Kamera gedreht, bis es mittig steht — dann läuft die
// Figur geradeaus darauf zu, denn W folgt der Blickrichtung.
//
// Verfolgt wird ein **angepeiltes** Wesen und nicht „das gerade nächste": seit
// die Irrlichter umherwandern, wechselt das Nächste alle paar Sekunden, und
// ein Bot, der immer dem Nächsten nachläuft, pendelt zwischen zweien hin und
// her, ohne je bei einem anzukommen. Ein Klick ins Bild wählt ein Ziel, und
// das Spiel schreibt `data-target="true"` an dessen Schild — daran ist es
// wiederzuerkennen, ohne dass der Test Weltkoordinaten bräuchte.
//
// Kein Zugriff auf Weltkoordinaten von Monstern: die gibt `window.aurelith`
// bewusst nicht her, und ein Testhaken dafür wäre Gerüst im Auslieferungscode.

const MITTE_X = BREITE / 2;

/**
 * Bildschirmmitte eines Monsterschilds, oder nichts.
 *
 * `nurZiel` verlangt das angepeilte Wesen; sonst gilt das nächste. Die
 * Schilder stehen nach Entfernung sortiert im DOM — das erste sichtbare
 * gehört zum nächsten Wesen. Gefiltert wird über `display`, nicht über
 * Playwrights `:visible`: ein Schild hinter der Kamera wird zwar auf einen
 * Punkt weit ausserhalb des Bildes projiziert, hat dort aber immer noch
 * Ausdehnung und gälte damit als sichtbar.
 */
async function schildOrt(nurZiel) {
  return page.evaluate(
    ({ breite, hoehe, nurZiel, jagd }) => {
      for (const plate of document.querySelectorAll('.nameplate[data-kind="monster"]')) {
        if (plate.style.display === 'none') continue;
        if (nurZiel && plate.dataset.target !== 'true') continue;
        // Nur Irrlichter. Auf der Wiese daneben stehen Grabwelpen und
        // Distelkeiler — Stufe drei und sechs, und die erschlagen eine frische
        // Figur, statt zu sterben. Ein Bot, der „das nächste Wesen" jagt,
        // wandert irgendwann dorthin und liegt dann tot im Feld, während der
        // Test auf Beute wartet, die nie fällt.
        if (!(plate.children[1]?.textContent ?? '').startsWith(jagd)) continue;
        const box = plate.getBoundingClientRect();
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        // „Im Bild" heisst im Bild — nicht „ungefähr". Ein Wesen seitlich oder
        // hinter der Kamera landet bei der Projektion irgendwo daneben, und wer
        // darauf zusteuert, dreht sich fest: das Ziel kommt nie zur Mitte, weil
        // es nie auf dem Schirm war. Solche Schilder werden übersprungen, das
        // nächste in der Liste ist das zweitnächste Wesen.
        if (x < 0 || x > breite || y < 0 || y > hoehe) continue;
        // Der Lebensbalken im Schild sagt, ob die Schläge ankommen — die
        // einzige Rückmeldung, an der ein Bot „ich stehe daneben" von „ich
        // renne daran vorbei" unterscheiden kann.
        const fill = plate.lastElementChild?.firstElementChild;
        const teil = /scaleX\(([\d.]+)\)/.exec(fill?.style.transform ?? '');
        return { x, y, hp: teil ? Number(teil[1]) : 1 };
      }
      return undefined;
    },
    { breite: BREITE, hoehe: HOEHE, nurZiel, jagd: 'Irrlicht' },
  );
}

/**
 * Dreht die Kamera. Ein Zug nach rechts holt ein Ziel rechts der Mitte heran.
 *
 * Gemessen und nicht angenommen: ein Zug von 150 Mauspunkten hat ein
 * Namensschild um gut 500 Bildpunkte verschoben — rund **3,5 Bildpunkte je
 * Mauspunkt**. Wer die Abweichung eins zu eins in einen Zug übersetzt, dreht
 * also mehr als dreimal so weit wie nötig, schiesst über das Ziel hinaus,
 * korrigiert in die Gegenrichtung und pendelt sich fest. Genau daran ist ein
 * Lauf gescheitert, der das Ziel zwar dauernd mittig hatte, aber in zweihundert
 * Runden nichts erlegte.
 */
async function drehe(pixel, schritte = 6) {
  await page.mouse.move(MITTE_X, HOEHE / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(MITTE_X + pixel, HOEHE / 2, { steps: schritte });
  await page.mouse.up({ button: 'right' });
}

let runde = 0;

/** Ob während des Kampfes überhaupt einmal etwas anvisiert war. */
let zielImKampf = false;

/**
 * Kämpft, bis etwas am Boden liegt.
 *
 * Als Funktion und nicht als Schleife am Stück: der zweite Teil des Tests
 * braucht wieder einen Haufen, und ein zweiter abgeschriebener Kampfablauf
 * wäre eine zweite Gelegenheit, ihn falsch zu machen.
 */
async function kaempfeBisBeute() {
  // Seit dem Zielsystem läuft der Bot nicht mehr selbst: ein Klick visiert an,
  // der zweite greift an, und das Spiel bringt die Figur in Reichweite und
  // hält sie dort. Wer hier noch W drückte, bräche den Kampf in jeder Runde
  // wieder ab — eigene Bewegung beendet den Auftrag, genau dafür ist sie da.
  //
  // Gedreht wird trotzdem: ein Wesen ohne Namensschild im Bild ist für diesen
  // Test nicht zu finden, und die Schilder gibt es nur für das, was die Kamera
  // sieht.
  const frist = Date.now() + 240000;
  let fertig = false;

  while (Date.now() < frist) {
    runde++;
    if ((await page.evaluate(() => window.aurelith.lootCount)) > 0) {
      fertig = true;
      break;
    }

    const auftrag = await page.evaluate(() => ({ ...window.aurelith.auftrag }));
    // Für die Prüfung unten: im Kampf **stand** ein Ziel. Ohne diese Notiz
    // wäre „nach dem Tod steht keins mehr" auch dann wahr, wenn nie eines da
    // war — und genau das ist der Fall, den man nicht bemerken würde.
    if (await page.evaluate(() => window.aurelith.targetId)) zielImKampf = true;
    let ziel = await schildOrt(true);

    if (!ziel) {
      // Kein angepeiltes Wesen mehr — erlegt, aus dem Bild gewandert oder noch
      // keines gewählt. Das nächste anklicken; ein Klick ins Bild wählt, was
      // dort steht.
      const naechstes = await schildOrt(false);
      if (naechstes) {
        // Etwas unter das Schild, auf den Körper: das Schild schwebt über dem
        // Wesen, und gewählt wird nach dem, was im Bild unter dem Zeiger liegt.
        await page.mouse.click(naechstes.x, naechstes.y + 18);
        ziel = await schildOrt(true);
      } else {
        // Nichts im Bild: eine Achteldrehung weiter suchen.
        await drehe(80);
      }
    } else if (auftrag.art !== 'kampf') {
      // Anvisiert, aber kein Kampf: der zweite Klick schickt die Figur los.
      // Auch der Weg dorthin gehört dem Spiel — der Bot wartet nur ab.
      await page.mouse.click(ziel.x, ziel.y + 18);
    }

    if (ziel) {
      // Nachführen statt Zielen: ein Bruchteil der Abweichung je Runde. Die
      // Kamera dreht sich nicht von selbst mit, und ein Ziel, das aus dem Bild
      // läuft, verliert sein Schild — und damit seinen Lebensbalken.
      const abweichung = ziel.x - MITTE_X;
      if (Math.abs(abweichung) > 60) {
        // Etwas weniger als der gemessene Kehrwert (0,29): lieber zweimal
        // nachziehen als einmal vorbei.
        await drehe(Math.max(-150, Math.min(150, abweichung * 0.25)), 3);
      }
    }

    if (runde % 10 === 0) {
      const p = await page.evaluate(() => ({ ...window.aurelith.player }));
      console.log(
        `  · Runde ${runde}: ${ziel ? `Ziel ${Math.round(ziel.x)} bei ` +
          `${Math.round(ziel.hp * 100)}% Leben` : 'kein Ziel im Bild'}, ` +
          `Auftrag ${auftrag.art}${auftrag.angriff ? ' (schlägt)' : ''}, ` +
          `Figur bei ${p.x.toFixed(1)}/${p.z.toFixed(1)}`,
      );
    }

    // Eine halbe Sekunde zwischen zwei Eingriffen: jede Drehung schwenkt auch
    // den Anmarsch mit, und wer alle fünfzig Millisekunden schwenkt,
    // beschreibt Schlangenlinien statt eines Weges.
    await page.waitForTimeout(500);
  }

  return fertig;
}

const gefallen = await kaempfeBisBeute();

check(gefallen, 'nach dem Kampf liegt Beute am Boden',
  `${await page.evaluate(() => window.aurelith.lootCount)} Haufen`);

// Ohne Beute hat der Rest keinen Gegenstand. Hier abbrechen und nicht in
// dreissig Sekunden Wartezeit auf ein Schild laufen, das nie kommt — die
// Meldung darüber ist die Nachricht, nicht der Zeitüberlauf danach.
if (!gefallen) {
  await page.screenshot({ path: join(root, 'artefakte', 'beute-fehlgeschlagen.png') });
  await browser.close();
  shutdown();
  console.log(`\n${failures} Prüfung(en) fehlgeschlagen.\n`);
  process.exit(1);
}

/*
 * Die Zielanzeige läuft nach dem Tod aus.
 *
 * Der Kadaver bleibt bis zum Respawn liegen, und solange fand die Auswahl ihn
 * auch: oben stand eine halbe Minute lang ein Gegner mit leerem Balken, den es
 * nicht mehr gab. Ein paar Sekunden soll er stehenbleiben — man will den
 * letzten Treffer sehen —, danach ist die Anzeige frei.
 */
check(zielImKampf, 'im Kampf war etwas anvisiert');
check(
  await waitUntil(async () => (await page.evaluate(() => window.aurelith.targetId)) === 0, 9000),
  'und nach dem Tod erlischt die Anvisierung',
  `targetId ${await page.evaluate(() => window.aurelith.targetId)}`,
);

const schilder = page.locator('.loot-label');
check(
  await waitUntil(async () => (await schilder.count()) > 0, 8000),
  'darüber steht ein Schild',
  String(await schilder.count()),
);

// Verglichen wird gegen die Inhaltstabelle und nicht gegen eine Handvoll
// abgeschriebener Namen: was ein Irrlicht fallen lässt, steht in der
// Beutetabelle und darf sich ändern. Eine Prüfung auf „Gold oder Essenz"
// scheiterte an einem Heiltrank, obwohl das Schild genau das Richtige zeigte.
const gegenstaende = new Set(
  JSON.parse(readFileSync(join(root, 'assets', 'content', 'items.json'), 'utf8')).items.map(
    (i) => i.name,
  ),
);
const beschriftung = (await schilder.first().textContent()) ?? '';
check(
  /^\d+ Gold$/.test(beschriftung) || gegenstaende.has(beschriftung.replace(/ ×\d+$/, '')),
  'und es nennt, was da liegt',
  beschriftung || '(leer)',
);

// Das Schild muss gross genug sein, um es mit dem Daumen zu treffen. Vierzig
// Bildpunkte sind die übliche Untergrenze; darunter zielt man.
const kasten = await schilder.first().boundingBox();
check(
  (kasten?.height ?? 0) >= 18 && (kasten?.width ?? 0) >= 40,
  'das Schild ist gross genug zum Antippen',
  kasten ? `${Math.round(kasten.width)}×${Math.round(kasten.height)} px` : 'ohne Ausdehnung',
);

await page.screenshot({ path: join(root, 'artefakte', 'beute.png') });

// --- Aufheben --------------------------------------------------------------

const vorher = await page.evaluate(() => window.aurelith.lootCount);
// `force`, weil das Schild wippt: Playwright wartet sonst darauf, dass sich
// die Fläche zwei Bilder lang nicht bewegt, und das tut sie nie. Ein echter
// Mausklick an der Stelle des Schilds bleibt es trotzdem — verdeckt jemand
// das Schild, landet der Klick auf dem, was davor liegt, und die Prüfung
// fällt durch. Genau das soll sie.
await schilder.first().click({ force: true });

check(
  await waitUntil(
    async () => ((await page.locator('.chat-log').textContent()) ?? '').includes('Aufgehoben:'),
    8000,
  ),
  'ein Klick auf das Schild hebt die Beute auf',
  ((await page.locator('.chat-log').textContent()) ?? '')
    .split('\n')
    .find((l) => l.includes('Aufgehoben:')) ?? 'keine Meldung',
);
check(
  await waitUntil(async () => (await page.evaluate(() => window.aurelith.lootCount)) < vorher, 8000),
  'und der Haufen verschwindet aus der Welt',
  `${vorher} → ${await page.evaluate(() => window.aurelith.lootCount)}`,
);

// --- Zeiger, Schlagsperre und der Weg hin -----------------------------------
//
// Drei Dinge, die zusammengehören: über einem Haufen zeigt die Maus eine Hand,
// ein Klick dorthin schlägt nicht zu, und liegt er ausserhalb der Reichweite,
// läuft die Figur von selbst hin.
//
// Dafür muss wieder etwas am Boden liegen — der Klick oben hat aufgeräumt.
if ((await page.evaluate(() => window.aurelith.lootCount)) === 0) {
  check(await kaempfeBisBeute(), 'für den zweiten Teil fällt neue Beute');
}

// Erst einmal weg vom Haufen — sonst prüft der Weg dorthin nichts, weil man
// schon davorsteht.
//
// Und zwar *bis* er ausser Reichweite ist, nicht zwei Sekunden lang: in
// SwiftShader zeichnet der Client ein paar Bilder je Sekunde, und ein fester
// Tastendruck brachte die Figur einmal ganze 1,8 Einheiten weit — mitten in
// die Aufhebereichweite hinein. Der Klick hob dann sofort auf, ein Weg wurde
// nie gelaufen, und die Prüfung darunter hätte fast bestanden, ohne dass es
// die geprüfte Sache je gegeben hätte.
const reichweite = JSON.parse(
  readFileSync(join(root, 'assets', 'content', 'tuning.json'), 'utf8'),
).loot.pickupRange;
const abstand = () => page.evaluate(() => window.aurelith.lootNearest);

/** Zwischenstand für die Fehlersuche: was liegt wo, und wie spät ist es. */
const spur = async (was) => {
  const d = await page.evaluate(() => ({
    haufen: window.aurelith.lootCount,
    nah: window.aurelith.lootNearest,
    x: window.aurelith.player.x,
    z: window.aurelith.player.z,
  }));
  console.log(
    `  · ${was}: ${d.haufen} Haufen, nächster ${d.nah.toFixed(1)}, Figur bei ` +
      `${d.x.toFixed(1)}/${d.z.toFixed(1)}, ${Math.round((Date.now() - beginn) / 1000)} s`,
  );
};

await page.keyboard.down('KeyS');
await waitUntil(async () => (await abstand()) > reichweite + 2, 20000);
await page.keyboard.up('KeyS');
await page.waitForTimeout(600);
await spur('nach dem Rückzug');

const entferntVorher = await abstand();
check(
  entferntVorher > reichweite,
  'die Figur steht weit genug vom Haufen weg',
  `${entferntVorher.toFixed(1)} Einheiten, Aufhebereichweite ${reichweite}`,
);

const schild = await schilder.first().boundingBox();
if (schild) {
  const mx = schild.x + schild.width / 2;
  // Das Schild steht über dem Haufen; der Haufen selbst liegt darunter.
  const my = schild.y + schild.height + 12;

  await page.mouse.move(mx, my);
  await page.waitForTimeout(120);
  const zeiger = await page.evaluate(
    () => getComputedStyle(document.querySelector('canvas')).cursor,
  );
  check(zeiger === 'pointer', 'über dem Haufen zeigt die Maus eine Hand', zeiger);

  // Gegenprobe: über freiem Boden ist wieder gewöhnlicher Zeiger. Ohne sie
  // zeigte die Prüfung oben nur, dass irgendwo eine Hand steht.
  //
  // „Frei" wird gesucht und nicht angenommen: eine feste Handbreit daneben lag
  // schon einmal genau auf dem zweiten Haufen, und die Gegenprobe schlug fehl,
  // obwohl alles richtig war. Genommen wird die Stelle auf der Höhe des
  // Schilds, die am weitesten von allen Beuteschildern entfernt ist.
  const schilderKaesten = [];
  for (let i = 0; i < (await schilder.count()); i++) {
    const k = await schilder.nth(i).boundingBox();
    if (k) schilderKaesten.push([k.x + k.width / 2, k.y + k.height / 2]);
  }
  let freiX = 40;
  let freiAbstand = -1;
  for (let x = 40; x <= BREITE - 40; x += 20) {
    let naechster = Infinity;
    for (const [lx, ly] of schilderKaesten) {
      naechster = Math.min(naechster, Math.hypot(lx - x, ly - my));
    }
    if (naechster > freiAbstand) {
      freiAbstand = naechster;
      freiX = x;
    }
  }

  await page.mouse.move(freiX, my);
  await page.waitForTimeout(120);
  const daneben = await page.evaluate(
    () => getComputedStyle(document.querySelector('canvas')).cursor,
  );
  check(
    daneben !== 'pointer' && freiAbstand > 120,
    'daneben nicht',
    `${daneben || '(leer)'}, ${Math.round(freiAbstand)} px vom nächsten Schild`,
  );

  // Drücken und dabei nachsehen, ob geschlagen wird. Gemessen wird, solange
  // die Taste unten ist: ein Klick auf einen Haufen ist ein Aufheben und darf
  // unter keinen Umständen einen Kampf beginnen.
  const aufgehobenVorher = await meldungen();
  await page.mouse.move(mx, my);
  await page.mouse.down();
  await page.waitForTimeout(150);
  const schlaegt = await page.evaluate(() => window.aurelith.auftrag.angriff);
  await page.mouse.up();
  check(schlaegt === false, 'ein Klick auf den Haufen schlägt nicht zu', String(schlaegt));

  check(
    await waitUntil(async () => (await abstand()) < entferntVorher - 1, 12000),
    'die Figur läuft von selbst hin',
    `${entferntVorher.toFixed(1)} → ${(await abstand()).toFixed(1)}`,
  );

  // Gezählt und nicht gesucht: die Meldung vom ersten Aufheben steht noch im
  // Verlauf, und „enthält Aufgehoben" wäre damit schon vor dem Klick wahr.
  const angekommen = await waitUntil(async () => (await meldungen()) > aufgehobenVorher, 30000);
  await spur('nach dem Weg');
  check(
    angekommen,
    'und hebt am Ende auf',
    `${aufgehobenVorher} → ${await meldungen()} Meldungen`,
  );

  // Und zwar ohne Absage. Der Server rechnet mit seiner eigenen Lage der
  // Figur; wer bis auf den letzten Zentimeter der Reichweite heranläuft,
  // bekommt „Das liegt zu weit weg." und steht dann davor. Genau so ist ein
  // Lauf schon einmal geendet — mit einem Haufen in drei Einheiten Abstand
  // und einer Aufhebereichweite von dreieinhalb.
  const verlauf = (await page.locator('.chat-log').textContent()) ?? '';
  check(
    !verlauf.includes('zu weit weg'),
    'und der Server sagt kein „zu weit weg"',
    verlauf.includes('zu weit weg') ? 'Absage im Verlauf' : 'keine Absage',
  );
}

check(fehler.length === 0, 'keine unbehandelten Ausnahmen', String(fehler.length));
if (fehler.length > 0) console.error(fehler.join('\n'));

await browser.close();
shutdown();

console.log(failures === 0 ? '\nAlle Prüfungen bestanden.\n' : `\n${failures} Prüfung(en) fehlgeschlagen.\n`);
process.exit(failures === 0 ? 0 : 1);
