#!/usr/bin/env node
/**
 * Rauchtest: NPC anklicken, Auftrag annehmen, Questlog öffnen.
 *
 * Das Protokoll dahinter prüft `packages/server/test/npcflow_test.ts` — dort
 * ohne Browser und bis zur Abgabe. Hier geht es um das, was der Test dort
 * nicht sehen kann: dass ein Klick auf eine Figur im Bild beim richtigen NPC
 * ankommt, dass das Fenster aufgeht und dass der Knopf darin etwas bewirkt.
 *
 *   node tools/smoke-npc.mjs
 *
 * Der Server startet mit `AURELITH_START_POS` direkt neben Aurel. Sonst
 * bestünde der halbe Test aus Hinlaufen.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

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

const waitUntil = async (fn, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

console.log('Aurelith — NPCs, Aufträge, Handel\n');

const server = launch('npx tsx packages/server/src/index.ts', {
  AURELITH_PORT: '8792',
  // Zwei Einheiten neben Aurel, der auf (7, 9) steht.
  AURELITH_START_POS: '7,11',
  DATABASE_URL: '',
});
// `AURELITH_SERVER` sagt Vite, wohin es `/ws` durchreicht — sonst zeigte der
// Proxy auf den Standardport, auf dem hier nichts läuft.
launch('cd packages/client && npx vite --port 5196 --strictPort --host 127.0.0.1', {
  AURELITH_SERVER: 'ws://127.0.0.1:8792',
});

if (!(await waitUntil(async () => server.log.join('').includes('bereit'), 60000))) {
  console.error(server.log.join(''));
  throw new Error('Spielserver kam nicht hoch');
}
if (
  !(await waitUntil(async () => {
    try {
      return (await fetch('http://127.0.0.1:5196/')).ok;
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

const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const fehler = [];
page.on('pageerror', (err) => fehler.push(String(err)));

const name = `Npc${Date.now() % 100000}`;
await page.goto(`http://127.0.0.1:5196/?name=${name}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.aurelith?.localId > 0, { timeout: 40000 });
await page.waitForTimeout(2500);

console.log('Prüfungen');

// --- Der NPC steht da und trägt ein Auftragszeichen ------------------------

const aurel = page.locator('.nameplate', { hasText: 'Aurel' }).first();
check(await aurel.isVisible(), 'Aurels Namensschild ist zu sehen');

const zeichen = await aurel.locator('.np-mark').textContent();
check(zeichen === '!', 'über ihm steht ein Ausrufezeichen', zeichen ?? '(leer)');

// --- Anklicken öffnet das Gespräch ----------------------------------------

const kasten = await aurel.boundingBox();
if (!kasten) throw new Error('Namensschild ohne Ausdehnung');
// Das Schild hängt über dem Kopf; getroffen werden soll der Körper. Fünfzig
// Bildpunkte tiefer liegt er sicher innerhalb des Aufgreifradius.
await page.mouse.click(kasten.x + kasten.width / 2, kasten.y + kasten.height + 50);

const dialog = page.locator('[data-window="dialog"]');
check(
  await waitUntil(async () => (await dialog.getAttribute('data-open')) === 'true', 8000),
  'das Gesprächsfenster geht auf',
);
check((await dialog.textContent())?.includes('Aurel') ?? false, 'und zeigt Aurel');
check(
  (await dialog.textContent())?.includes('Licht im Moor') ?? false,
  'mitsamt dem angebotenen Auftrag',
);

// --- Annehmen landet im Questlog ------------------------------------------

await dialog.getByRole('button', { name: 'Annehmen' }).click();

const questlog = page.locator('[data-window="quests"]');
check(
  await waitUntil(async () => (await questlog.textContent())?.includes('Licht im Moor') ?? false, 8000),
  'der Auftrag steht im Questlog',
);
check(
  (await questlog.textContent())?.includes('0 / 5') ?? false,
  'mit Fortschritt null von fünf',
  (await questlog.textContent())?.match(/\d+ \/ \d+/)?.[0] ?? 'nichts gefunden',
);

// Das Fenster selbst muss sich sofort ändern. Vorher stand der Knopf, den man
// eben gedrückt hatte, unverändert weiter da — es sah aus, als sei nichts
// passiert, und erst Schliessen und neu Ansprechen zeigte den neuen Stand.
check(
  await waitUntil(
    async () => ((await dialog.textContent()) ?? '').includes('Die Wiese ist gleich'),
    5000,
  ),
  'das Gespräch zeigt danach den Fortschrittstext',
);
check(
  (await dialog.getByRole('button', { name: 'Annehmen' }).count()) === 0,
  'und den Annehmen-Knopf nicht mehr',
);
check((await dialog.getAttribute('data-open')) === 'true', 'das Fenster bleibt dabei offen');

// Das Zeichen über Aurel wechselt von „hier gibt es etwas" zu „läuft noch".
check(
  await waitUntil(async () => (await aurel.locator('.np-mark').textContent()) === '?', 5000),
  'das Zeichen über Aurel wechselt',
);

// --- Der Laden -------------------------------------------------------------
//
// Iselda steht zwanzig Einheiten weiter; statt hinzulaufen wird geprüft, dass
// Aurel keinen Ladenknopf hat. Das Handeln selbst prüft der Protokolltest.
check(
  !((await dialog.textContent())?.includes('Waren ansehen') ?? true),
  'Aurel bietet keinen Laden an',
);

// --- Gegenstände: Name und Beschreibung auf Tippen -------------------------
//
// Das ist der Teil, der auf dem Telefon fehlte: die Beschreibung hing am
// `title`-Attribut, und das zeigt ohne Maus niemand an. Geprüft wird deshalb
// mit einem einfachen Klick — genau das, was ein Finger auslöst.

await page.keyboard.press('KeyI');
const inventar = page.locator('[data-window="inventory"]');
check(
  await waitUntil(async () => (await inventar.getAttribute('data-open')) === 'true', 5000),
  'das Inventar geht auf',
);

const belegte = inventar.locator('.item-slot:not(.item-empty)');
check((await belegte.count()) >= 3, 'es liegen Gegenstände darin', String(await belegte.count()));

// Die Kacheln zeigen gerenderte Symbole, keine Farbflächen mehr. Geprüft wird
// nicht nur, dass ein `<img>` dasteht, sondern dass auch etwas darin ankam —
// ein falscher Pfad ergäbe sonst ein leeres, aber vorhandenes Element.
const bilder = await page.evaluate(() =>
  [...document.querySelectorAll('.item-icon-bild')].map((n) => ({
    src: n.getAttribute('src') ?? '',
    breite: n.naturalWidth,
  })),
);
check(bilder.length >= 3, 'die Kacheln tragen Symbolbilder', `${bilder.length} Bilder`);
check(
  bilder.every((b) => b.breite > 0),
  'und alle sind geladen',
  bilder.find((b) => b.breite === 0)?.src ?? 'alle',
);

// --- Die Figur im Inventar -------------------------------------------------
//
// Gemessen statt angesehen. Der erste Aufbau bestand jede Prüfung und war im
// Bild trotzdem kaputt: das Raster war breiter als das Fenster, und die rechte
// Reihe Plätze stand ausserhalb. Ein Rauchtest, der nur „geht auf" prüft,
// findet so etwas nie.

const puppe = await page.evaluate(() => {
  const fenster = document.querySelector('[data-window="inventory"]');
  const leinwand = document.querySelector('.doll-canvas');
  const raster = document.querySelector('.doll');
  if (!fenster || !leinwand || !raster) return undefined;
  const f = fenster.getBoundingClientRect();
  const l = leinwand.getBoundingClientRect();
  const r = raster.getBoundingClientRect();
  return {
    leinwand: { breite: Math.round(l.width), hoehe: Math.round(l.height) },
    // Wie weit das Raster über den Fensterrand hinausragt — **beide** Achsen.
    // Beim ersten Anlauf stand hier nur links/rechts, und genau deshalb ging
    // die Prüfung durch, während die Figur senkrecht aus dem Bild gescrollt
    // war. Eine halbe Messung ist keine.
    ueberstand: Math.round(
      Math.max(0, r.right - f.right) +
        Math.max(0, f.left - r.left) +
        Math.max(0, r.bottom - f.bottom) +
        Math.max(0, f.top - r.top),
    ),
    plaetze: document.querySelectorAll('.equip-slot').length,
    // Höhe des Puppenbereichs gegen die Höhe seines Inhalts. Ein
    // geschrumpftes Flex-Element meldet ein sauberes, aber zu kleines
    // Rechteck — der Inhalt läuft darüber hinaus und wird abgeschnitten,
    // ohne dass irgendein Rand überschritten wäre.
    gequetscht: (() => {
      const d = document.querySelector('.doll');
      const c = document.querySelector('.doll-canvas');
      const l = document.querySelector('.doll-slots.links');
      if (!d || !c || !l) return -1;
      const noetig = Math.max(c.getBoundingClientRect().height, l.scrollHeight);
      return Math.round(noetig - d.getBoundingClientRect().height);
    })(),
    // Scrollt der Körper? Ein gescrollter Körper schiebt die Figur aus dem
    // Bild, ohne dass irgendeine Breite oder Höhe falsch wäre.
    scroll: (() => {
      const b = document.querySelector('[data-window="inventory"] .window-body');
      return b ? `${b.scrollTop}/${b.scrollHeight}@${b.clientHeight}` : '—';
    })(),
    sichtbar: [...document.querySelectorAll('.equip-slot')].filter((n) => {
      const b = n.getBoundingClientRect();
      return (
        b.width > 0 &&
        b.height > 0 &&
        b.right <= f.right + 1 &&
        b.left >= f.left - 1 &&
        b.bottom <= f.bottom + 1 &&
        b.top >= f.top - 1
      );
    }).length,
  };
});

// Die gemessene Geometrie steht im Protokoll. Zwei Anläufe lang habe ich aus
// dem Bildschirmfoto auf die Ursache geschlossen und zweimal daneben gelegen;
// die Zahlen daneben hätten beide Male sofort gezeigt, was los ist.
console.log(`  · Puppe: ${JSON.stringify(puppe)}`);

check(puppe !== undefined, 'die Figur samt Plätzen steht im Inventar');
check(
  (puppe?.leinwand.breite ?? 0) > 40 && (puppe?.leinwand.hoehe ?? 0) > 80,
  'die Leinwand hat eine brauchbare Größe',
  puppe ? `${puppe.leinwand.breite}×${puppe.leinwand.hoehe} px` : '—',
);
check(puppe?.plaetze === 10, 'zehn Ausrüstungsplätze', String(puppe?.plaetze));
check(
  puppe?.sichtbar === puppe?.plaetze,
  'und alle liegen im Fenster',
  `${puppe?.sichtbar} von ${puppe?.plaetze}`,
);
check((puppe?.ueberstand ?? 99) === 0, 'nichts ragt über den Rand', `${puppe?.ueberstand} px`);
check(
  (puppe?.gequetscht ?? 99) <= 0,
  'der Puppenbereich ist nicht zusammengequetscht',
  `${puppe?.gequetscht} px zu wenig`,
);

// Und zuletzt: zeichnet die Figur überhaupt?
//
// Über den lesenden Blick und nicht über die Bildpunkte der Leinwand. Ein
// Versuch mit `readPixels` stand hier und wurde wieder entfernt: three.js
// erhält den Zeichenpuffer nicht (`preserveDrawingBuffer` ist aus), also kam
// dort verlässlich eine leere Fläche zurück — der Test hätte behauptet, die
// Figur fehle, während sie danebenstand. Eine Prüfung, die nicht misst, was
// sie behauptet, ist schlimmer als keine.
const puppenzustand = await page.evaluate(() => window.aurelith.doll);
console.log(`  · Puppenzustand: ${JSON.stringify(puppenzustand)}`);

check(puppenzustand.rig, 'die Figur hat ein Modell');
check(
  puppenzustand.bilder > 0,
  'und zeichnet tatsächlich',
  `${puppenzustand.bilder} Bilder`,
);
check(
  puppenzustand.breite === 256 && puppenzustand.hoehe === 340,
  'auf einem Puffer fester Größe',
  `${puppenzustand.breite}×${puppenzustand.hoehe}`,
);
// Fester Puffer und freier Kasten heissen zusammen: das Bild muss sein
// Verhältnis behalten dürfen. Ohne `contain` zieht CSS es auf die Kastenform,
// und auf dem Telefon — wo das Fenster fast bildschirmbreit wird — stand die
// Figur als gestreckter Schatten da.
check(
  (await page.evaluate(
    () => getComputedStyle(document.querySelector('.doll-canvas')).objectFit,
  )) === 'contain',
  'und wird nicht auf die Kastenform gezogen',
);


const detail = page.locator('.item-detail');
await belegte.first().click();
check(
  await waitUntil(async () => await detail.isVisible(), 3000),
  'ein Klick zeigt die Beschreibung',
);
// Die Sprechblase muss neben der angeklickten Kachel stehen und ganz im Bild
// liegen — sonst nützt sie am rechten Rand nichts, und genau dort steht das
// Inventar.
const blase = await page.evaluate(() => {
  const t = document.querySelector('.item-detail');
  const k = document.querySelector('.item-slot:not(.item-empty)');
  if (!t || !k) return undefined;
  const a = t.getBoundingClientRect();
  const b = k.getBoundingClientRect();
  return {
    abstand: Math.round(Math.min(Math.abs(a.left - b.right), Math.abs(b.left - a.right))),
    imBild:
      a.left >= 0 && a.top >= 0 && a.right <= window.innerWidth && a.bottom <= window.innerHeight,
    breite: Math.round(a.width),
  };
});
console.log(`  · Sprechblase: ${JSON.stringify(blase)}`);
check(blase?.imBild === true, 'die Sprechblase liegt ganz im Bild');
check((blase?.abstand ?? 999) < 40, 'und klebt an der angeklickten Kachel', `${blase?.abstand} px`);

const detailText = (await detail.textContent()) ?? '';
check(detailText.includes('Holzschwert'), 'mit dem Namen des Gegenstands', detailText.slice(0, 40));
check(detailText.includes('Waffe'), 'und seiner Art');
check(/Angriff \d/.test(detailText), 'samt Werten', detailText.match(/Angriff \d+/)?.[0] ?? '—');

// Nochmal auf dieselbe Kachel klappt wieder zu — anders käme man auf einem
// Telefon nicht heraus.
await belegte.first().click();
check(!(await detail.isVisible()), 'ein zweiter Klick klappt sie zu');

// Für die nächsten beiden Prüfungen muss sie wieder offen sein.
await belegte.first().click();
await waitUntil(async () => await detail.isVisible(), 3000);

// Und ein Klick daneben schliesst sie wieder. Ein leeres Kästchen ist
// „daneben" — das ist der Fall, den man beim Aufräumen dauernd trifft.
//
// Der Druck wird von Hand ausgelöst und nicht über `click()`: Playwright
// verweigert einen Klick, sobald irgendetwas ihn abfangen könnte, und die
// Blase liegt nun einmal über dem Beutel. Ob sie *tatsächlich* abfängt, sagt
// die berechnete Eigenschaft daneben — und die ist die eigentliche Auskunft:
// eine Blase, die Zeiger schluckt, blockiert die Kacheln darunter.
const durchlaessig = await page.evaluate(
  () => getComputedStyle(document.querySelector('.detail-head')).pointerEvents,
);
check(durchlaessig === 'none', 'die Sprechblase lässt Zeiger durch', durchlaessig);

await page.evaluate(() => {
  const leer = document.querySelector('.item-slot.item-empty');
  leer?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
});
check(
  await waitUntil(async () => !(await page.locator('.item-detail').isVisible()), 3000),
  'ein Druck ins Leere schliesst die Sprechblase',
);


// Anlegen über den Knopf: der Doppelklick ist auf Touch unzuverlässig, und
// vorher war er der einzige Weg.
const bogen = inventar.locator('.item-slot', { hasText: '' }).nth(1);
await bogen.click();
const anlegen = detail.getByRole('button', { name: 'Anlegen' });
if (await anlegen.count()) {
  await anlegen.click();
  check(
    await waitUntil(
      async () => ((await page.locator('.chat-log').textContent()) ?? '').includes('angelegt'),
      5000,
    ),
    'der Knopf legt den Gegenstand an',
  );
}

// --- Der Rüstungssatz ------------------------------------------------------
//
// Vier Teile anlegen und nachrechnen, was unten in der Werteliste steht. Das
// ist der Punkt, an dem sich ein Satz von vier einzelnen Stücken unterscheidet:
// die Summe allein ergäbe eine andere Zahl als die Summe plus Satzbonus.
//
// Die Erwartung kommt aus derselben Inhaltsdatei, die der Server liest — eine
// im Test eingetippte Zahl wäre beim nächsten Feilen an der Ausrüstung falsch,
// ohne dass jemand es merkt.

const inhalt = JSON.parse(readFileSync(join(root, 'assets', 'content', 'items.json'), 'utf8'));
const satzDef = (inhalt.sets ?? []).find((s) => s.id === 'leder');
const itemDef = (id) => inhalt.items.find((i) => i.id === id);

/** Liest einen Wert aus der Werteliste im Charakterfenster. */
async function wert(name) {
  return await page.evaluate((gesucht) => {
    const liste = document.querySelector('.stat-list');
    if (!liste) return undefined;
    const kinder = [...liste.children];
    const i = kinder.findIndex((n) => n.tagName === 'DT' && n.textContent === gesucht);
    return i >= 0 ? Number(kinder[i + 1]?.textContent) : undefined;
  }, name);
}

if (satzDef) {
  await page.keyboard.press('KeyC');
  const vorher = await wert('Verteidigung');

  // Jede Kachel einmal antippen und am Namen erkennen, was darin liegt. Die
  // Reihenfolge im Beutel ist keine Zusage, an die sich ein Test hängen sollte.
  const namen = satzDef.pieces.map((id) => itemDef(id)?.name);
  let angelegt = 0;
  /** Eine Kachel, in der ein Teil des Satzes liegt — für die Sprechblase danach. */
  let satzKachel;

  // Die Kacheln werden von Hand angetippt und nicht über `click()`: sobald eine
  // Sprechblase offen ist, liegt sie über dem Beutel, und Playwright verweigert
  // jeden Klick, den irgendetwas abfangen könnte. Dass sie *tatsächlich* nichts
  // abfängt, steht ein paar Zeilen weiter oben — hier geht es um den Ablauf.
  //
  // `.item-slot` und nicht nur `[data-bag-slot]`: die Kästchen um die Figur
  // tragen dieselbe Angabe, und ein Klick auf eines davon legt ab. Ohne den
  // Zusatz griff dieser Test der Figur beim Ausziehen unter die Arme und
  // wunderte sich anschliessend über die Werte.
  const kacheln = await page.evaluate(() =>
    [...document.querySelectorAll('.item-slot[data-bag-slot]')]
      .filter((n) => !n.classList.contains('item-empty'))
      .map((n) => Number(n.getAttribute('data-bag-slot'))),
  );

  for (const nummer of kacheln) {
    if (angelegt >= namen.length) break;
    await page.evaluate((n) => {
      document
        .querySelector(`.item-slot[data-bag-slot="${n}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, nummer);
    await waitUntil(async () => await detail.isVisible(), 3000);
    const name = ((await page.locator('.detail-name').textContent()) ?? '').trim();
    if (!namen.includes(name)) continue;
    satzKachel = nummer;
    const knopf = detail.getByRole('button', { name: 'Anlegen' });
    if (!(await knopf.count())) continue;
    await knopf.click();
    await waitUntil(
      async () => ((await page.locator('.chat-log').textContent()) ?? '').includes(name),
      5000,
    );
    angelegt++;
  }
  check(angelegt === namen.length, 'alle vier Teile des Ledersatzes liegen an', `${angelegt}/${namen.length}`);

  // Die Weste am Oberkörper weicht dem Lederwams: ein Platz, ein Stück. Was
  // sie vorher gab, fällt deshalb wieder weg.
  const weste = inhalt.starter.find((s) => s.equipped && itemDef(s.item)?.slot === 'chest');
  const stuecke = satzDef.pieces.reduce((n, id) => n + (itemDef(id)?.defense ?? 0), 0);
  const erwartet = vorher - (itemDef(weste?.item)?.defense ?? 0) + stuecke + satzDef.bonus.defense;

  // Warten, statt sofort abzulesen: die Werte kommen über das Netz, und der
  // vierte Klick ist schneller als die vierte Antwort.
  await waitUntil(async () => (await wert('Verteidigung')) === erwartet, 5000);
  const nachher = await wert('Verteidigung');
  check(
    nachher === erwartet,
    'die Verteidigung enthält Teile *und* Satzbonus',
    `${vorher} → ${nachher}, erwartet ${erwartet}`,
  );
  // Die Gegenprobe zur Rechnung darüber: ohne Satzbonus käme genau dieser Wert
  // heraus. Stimmten beide überein, prüfte die Zeile oben nichts.
  check(
    erwartet !== vorher - (itemDef(weste?.item)?.defense ?? 0) + stuecke,
    'und ohne ihn wäre es eine andere Zahl',
    `Satzbonus ${satzDef.bonus.defense}`,
  );

  // Und die Sprechblase sagt es auch: vier von vier, hervorgehoben.
  //
  // Erst zumachen, dann aufmachen. Ein Klick auf dieselbe Kachel klappt die
  // Blase zu, und welche Kachel zuletzt angetippt wurde, hängt daran, in
  // welcher Reihenfolge die Teile im Beutel liegen — das ist keine Zusage,
  // auf die sich ein Test stützen sollte.
  await page.evaluate(() => {
    document
      .querySelector('.item-slot.item-empty')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  });
  await waitUntil(async () => !(await detail.isVisible()), 3000);

  await page.evaluate((n) => {
    document
      .querySelector(`.item-slot[data-bag-slot="${n}"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, satzKachel ?? kacheln[0]);
  await waitUntil(async () => (await page.locator('.detail-set').count()) > 0, 3000);
  const satzText = await page.evaluate(() => {
    const block = document.querySelector('.detail-set');
    return block ? { text: block.textContent ?? '', aktiv: block.classList.contains('aktiv') } : undefined;
  });
  check(
    (satzText?.text ?? '').includes(`(${satzDef.pieces.length}/${satzDef.pieces.length})`),
    'die Sprechblase meldet den vollständigen Satz',
    satzText?.text?.slice(0, 60) ?? '(kein Satzblock)',
  );
  check(satzText?.aktiv === true, 'und hebt ihn hervor');

  // Zum Schluss noch einmal derselbe Wert. Die Prüfung oben liest ab, sobald
  // die erwartete Zahl das erste Mal dasteht — käme danach noch eine Antwort
  // hinterher, die etwas ablegt, sähe sie es nicht, und das Bild daneben zeigte
  // etwas anderes als der Test behauptet.
  const zumSchluss = await wert('Verteidigung');
  check(zumSchluss === erwartet, 'und sie steht am Ende immer noch da', `${zumSchluss}`);
}

await page.screenshot({ path: join(root, 'artefakte', 'inventar.png') });

// --- Die Uhr ---------------------------------------------------------------

const uhr = await page.locator('.vitals-clock').textContent();
check(/^[☀🌙] \d{2}:\d{2}$/u.test(uhr ?? ''), 'die Weltuhr läuft', uhr ?? '(leer)');

// --- Quer gehaltenes Telefon -----------------------------------------------
//
// Achthundertzwanzig breit, knapp vierhundert hoch — die Maße eines Telefons
// im Querformat. Für die Blattregel ist das zu breit, also bleibt das Inventar
// ein schwebendes Fenster; und genau dort hing es unten heraus: die
// Anfangslage ist eine feste Zahl, und Figur samt Kästchen füllten die Höhe
// allein. Sichtbar war der Beutel nicht, scrollen ging auch nicht.
//
// Gemessen werden beide Hälften der Beschwerde getrennt: *steht es im Bild*
// und *lässt sich der Beutel bewegen*.

await page.setViewportSize({ width: 852, height: 393 });
await page.waitForTimeout(500);

const quer = await page.evaluate(() => {
  const fenster = document.querySelector('[data-window="inventory"]');
  const beutel = fenster?.querySelector('.inventory-grid');
  if (!fenster || !beutel) return undefined;

  const f = fenster.getBoundingClientRect();
  const b = beutel.getBoundingClientRect();
  beutel.scrollTop = 9999;
  const gescrollt = beutel.scrollTop;
  beutel.scrollTop = 0;

  return {
    bild: window.innerHeight,
    oben: Math.round(f.top),
    unten: Math.round(f.bottom),
    beutelHoehe: Math.round(b.height),
    beutelUnten: Math.round(b.bottom),
    ueberlauf: beutel.scrollHeight - beutel.clientHeight,
    gescrollt,
  };
});
console.log('  · Querformat:', JSON.stringify(quer));

check(
  quer !== undefined && quer.oben >= 0 && quer.unten <= quer.bild,
  'quer steht das Inventar ganz im Bild',
  `${quer?.oben}…${quer?.unten} von ${quer?.bild}`,
);
check(
  (quer?.beutelHoehe ?? 0) >= 40 && (quer?.beutelUnten ?? 0) <= (quer?.bild ?? 0),
  'der Beutel ist dabei zu sehen',
  `${quer?.beutelHoehe} px, Unterkante ${quer?.beutelUnten}`,
);
check(
  (quer?.ueberlauf ?? 0) > 0 && (quer?.gescrollt ?? 0) > 0,
  'und lässt sich scrollen',
  `Überlauf ${quer?.ueberlauf} px, gescrollt ${quer?.gescrollt} px`,
);

await page.screenshot({ path: join(root, 'artefakte', 'inventar-quer.png') });

check(fehler.length === 0, 'keine unbehandelten Ausnahmen', String(fehler.length));
if (fehler.length > 0) console.error(fehler.join('\n'));

await browser.close();
shutdown();

console.log(failures === 0 ? '\nAlle Prüfungen bestanden.\n' : `\n${failures} Prüfung(en) fehlgeschlagen.\n`);
process.exit(failures === 0 ? 0 : 1);
