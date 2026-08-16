/**
 * Modellschau — jedes Modell einzeln, gross, drehbar.
 *
 * Wozu: Props, Figuren und Waffen entstehen prozedural, und man sieht sie im
 * Spiel immer nur klein, aus einem Winkel und im Vorbeilaufen. Was daran krumm
 * ist, fällt so nicht auf. Hier steht ein einzelnes Modell in der Mitte, und
 * man kann es von allen Seiten ansehen.
 *
 * **Am Telefon bedienbar, und zwar zuerst.** Der Editor ist ein Werkzeug für
 * den Schreibtisch; diese Seite ist eine zum Danebenhalten. Deshalb:
 *
 *   - ein Finger dreht (Gieren und Nicken),
 *   - zwei Finger zoomen und schieben zugleich — Abstand ändert den Zoom,
 *     die Mitte zwischen ihnen schiebt,
 *   - das Bedienfeld klappt weg, damit das Modell die ganze Fläche bekommt.
 *
 * Die Seite lädt **keinen** wasm-Kern und keine Karte: sie baut die Modelle
 * selbst aus denselben Bauern, die der Client benutzt. Damit ist sie eine
 * reine Dateiablieferung und läuft auf GitHub Pages unter `/model_viewer/`.
 */

import * as THREE from 'three';
import { loadModel } from '@aurelith/client/render/gltf.ts';
import type { CharacterRig } from '@aurelith/client/render/rigs.ts';
import {
  baueKollisionsanzeige,
  beschreibeKollision,
  loeseKollisionAuf,
} from './kollision.ts';
import {
  baueKatalog,
  createFoliageMaterial,
  createSharedMaterial,
  laubAtlas,
  type Eintrag,
} from './katalog.ts';
import './style.css';

// ---------------------------------------------------------------------------
// Szene
// ---------------------------------------------------------------------------

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const kopf = document.getElementById('kopf') as HTMLElement;
const panel = document.getElementById('panel') as HTMLElement;
const klapp = document.getElementById('klapp') as HTMLButtonElement;
const fuss = document.getElementById('fuss') as HTMLElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);

/**
 * Drei Lichter, und jedes hat eine Aufgabe.
 *
 * Ein einzelnes Licht von vorn lässt jedes Modell flach aussehen — genau die
 * Frage, die man hier beantworten will („stimmt die Form?"), wäre damit nicht
 * zu beantworten. Führung von schräg oben, Aufhellung von der Gegenseite,
 * Umgebung als Rest.
 *
 * **Die Zahlen sind die von Lichtmoor am Mittag**, und das ist keine
 * Kleinigkeit. Vorher stand hier eine Führung von 2,1 und ein gleichmässiges
 * Umgebungslicht — eine eigene Beleuchtung, die mit der des Spiels nichts zu
 * tun hatte. Wer die Farbe eines Modells danach beurteilt, beurteilt sie
 * verkehrt: was hier stimmte, war im Spiel zu dunkel, und umgekehrt.
 *
 * Und die Umgebung ist ein Halbkugellicht wie dort: von oben der Himmel, von
 * unten ein dunkler Boden. Ein gleichmässiges Umgebungslicht hellt die
 * Unterseite genauso auf wie die Oberseite, und damit verschwindet genau der
 * Unterschied, an dem man einen Stein als Stein erkennt.
 */
const fuehrung = new THREE.DirectionalLight(0xfff8de, 1.9);
fuehrung.position.set(4, 7, 5);
// Nur eine Aufhellung, damit die Rückseite nicht schwarz ist. Im Spiel gibt es
// sie nicht — sie darf deshalb auch nichts an der Form erzählen.
const gegenlicht = new THREE.DirectionalLight(0xbfd6ff, 0.3);
gegenlicht.position.set(-5, 3, -4);
const umgebung = new THREE.HemisphereLight(0x8ec0ee, 0x444444, 1.2);
scene.add(fuehrung, gegenlicht, umgebung);

const material = createSharedMaterial();
// Und das Material für alles mit Löchern. Anders als im Spiel gleich angelegt:
// hier wird ohnehin durch den ganzen Katalog geblättert.
const laubMaterial = createFoliageMaterial(laubAtlas());

/** Der Boden — nur als Bezug. Ohne ihn schwebt jedes Modell im Nichts. */
const gitter = new THREE.GridHelper(20, 20, 0x4cc9bf, 0x2c3a45);
scene.add(gitter);
const achsen = new THREE.AxesHelper(2.5);
scene.add(achsen);

/** Wo das aktuelle Modell hängt. Eine Gruppe, damit ein Wechsel ein Austausch ist. */
const halter = new THREE.Group();
scene.add(halter);

/**
 * Die Kollisionsanzeige — **neben** dem Halter und nicht darin.
 *
 * Sonst dreht sie mit, wenn „von selbst drehen" an ist. Bei einem Kreis fiele
 * das nicht auf, bei der Wand darüber aber schon: ihre Segmentkanten liefen
 * mit, und das sähe aus, als drehte sich der Kollisionskörper gegen das
 * Modell.
 */
let kollisionsNetz: THREE.Object3D | undefined;

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------

const katalog = baueKatalog();

/** Was gerade zu sehen ist. */
let aktuell: Eintrag = katalog[0]!;
let rig: CharacterRig | undefined;

/** Kamera in Kugelkoordinaten um den Blickpunkt. */
let kameraGier = 0.6;
let kameraNick = 0.35;
let abstand = 6;
const blickpunkt = new THREE.Vector3(0, 1, 0);

const einstellungen = {
  /** Stärke der Beleuchtung. 0 heisst: nur Umgebung, alles gleich hell. */
  licht: 1,
  wireframe: false,
  gitter: true,
  achsen: false,
  drehen: true,
  hell: false,
  /** Zeigt die Figuren im Lauf statt im Stand. Nur für Rigs. */
  laufen: false,
  /** Zeigt den Kollisionskörper — Kreis oder Plattform. Nur bei Props. */
  kollision: false,
  /**
   * Wie viele Meter Bildhöhe die Kamera zeigt.
   *
   * `0` heisst „an das Modell anpassen": jedes Modell füllt dann das Bild.
   * Bequem zum Ansehen, aber irreführend zum Vergleichen — ein Grasbüschel
   * sieht damit so gross aus wie ein Torbogen, und beim Durchblättern hält man
   * ein Prop für zu gross, das im Spiel richtig ist. Eine feste Bildhöhe ist
   * ein Massstab: der Baum ist dann zehnmal so hoch wie der Busch, weil er es
   * ist.
   */
  bezug: 12,
};

const gespeichert = localStorage.getItem('aurelith.modellschau');
if (gespeichert) {
  try {
    Object.assign(einstellungen, JSON.parse(gespeichert));
  } catch {
    // Kaputter Eintrag: dann eben die Vorgaben. Ein Absturz beim Start wäre
    // die schlechtere Antwort auf eine Zeile im lokalen Speicher.
  }
}
const merke = (): void =>
  localStorage.setItem('aurelith.modellschau', JSON.stringify(einstellungen));

// ---------------------------------------------------------------------------
// Modell laden
// ---------------------------------------------------------------------------

/** Wirft weg, was gerade hängt — samt Geometrie. */
function leere(): void {
  for (const kind of [...halter.children]) halter.remove(kind);
  rig?.dispose();
  rig = undefined;
  if (kollisionsNetz) {
    scene.remove(kollisionsNetz);
    loeseKollisionAuf(kollisionsNetz);
    kollisionsNetz = undefined;
  }
}

/**
 * Zählt jeden Wechsel mit.
 *
 * Ein geliefertes Modell kommt über das Netz, und in der Zeit kann längst ein
 * anderes gewählt sein. Ohne diese Zahl hinge dann beides im Halter — das
 * Schwert von eben und der Baum von jetzt.
 */
let wechsel = 0;

function zeige(eintrag: Eintrag): void {
  leere();
  aktuell = eintrag;
  const meins = ++wechsel;

  const gebaut = eintrag.baue(material, laubMaterial);
  rig = gebaut.rig;
  halter.add(gebaut.objekt);

  if (eintrag.datei) {
    const { url, laenge, unten, achse } = eintrag.datei;
    void (async () => {
      try {
        const bytes = await (await fetch(url)).arrayBuffer();
        const objekt = await loadModel(bytes, {
          length: laenge,
          bottom: unten,
          ...(achse ? { axis: achse } : {}),
        });
        if (meins !== wechsel) return;
        halter.add(objekt);
        richteKameraAus(objekt);
      } catch (fehler) {
        fuss.textContent = `${eintrag.id} — Datei nicht ladbar: ${String(fehler)}`;
      }
    })();
  }

  // Ein Rig steht sonst in seiner Ausgangshaltung — Arme durch den Körper,
  // Beine gestreckt. Ein Schritt bringt es in die Pose, die man im Spiel sieht.
  rig?.update({ speed: 0, attackPhase: -1, pickupPhase: -1, dead: false, time: 0, dt: 0.016 });

  richteKameraAus(gebaut.objekt);
  zeichnePanel();
}

/**
 * Stellt die Kamera auf die **Grösse des Modells** ein.
 *
 * Ohne das steht ein Grasbüschel als Punkt in der Ferne und ein Torbogen ragt
 * aus dem Bild. Gemessen wird nach dem Bauen, weil die Modelle prozedural sind
 * und ihre Ausmasse nirgends niedergeschrieben stehen — und noch einmal, wenn
 * eine gelieferte Datei nachträglich eintrifft.
 */
function richteKameraAus(objekt: THREE.Object3D): void {
  const kasten = new THREE.Box3().setFromObject(objekt);
  if (kasten.isEmpty()) return;
  const groesse = new THREE.Vector3();
  const mitte = new THREE.Vector3();
  kasten.getSize(groesse);
  kasten.getCenter(mitte);
  const spanne = Math.max(groesse.x, groesse.y, groesse.z, 0.3);
  hoeheDesModells = groesse.y;

  if (einstellungen.bezug > 0) {
    /*
     * Fester Massstab: die Kamera zeigt immer dieselbe Zahl Meter, ganz gleich,
     * wie gross das Modell ist. Der Abstand folgt aus dem Öffnungswinkel —
     * halbe Bildhöhe geteilt durch den Tangens des halben Winkels.
     *
     * Der Blickpunkt liegt **nicht** in der Mitte des Modells, sondern bei
     * 40 % der Bildhöhe über dem Boden. Sonst wanderte der Boden von Modell zu
     * Modell im Bild herum, und der Massstab wäre wieder keiner: man
     * vergliche Höhen ohne gemeinsame Grundlinie.
     */
    const halb = einstellungen.bezug * 0.5;
    abstand = halb / Math.tan((camera.fov * Math.PI) / 360);
    blickpunkt.set(0, einstellungen.bezug * 0.4, 0);
    // Das Raster bleibt bei einem Meter je Feld — es ist in dieser Betriebsart
    // das Lineal, und ein mitwachsendes Lineal misst nichts.
    gitter.scale.setScalar(1);
  } else {
    blickpunkt.set(mitte.x, mitte.y, mitte.z);
    abstand = spanne * 2.4;
    gitter.scale.setScalar(Math.max(0.15, spanne / 6));
  }
  zeigeMasse(groesse, kasten);
  baueKollision();
}

/** Höhe des zuletzt gebauten Modells — die Kollisionswand wird so hoch. */
let hoeheDesModells = 1;

/**
 * Legt die Kollisionsanzeige unter das Modell, oder räumt sie weg.
 *
 * Wird bei jedem Wechsel und bei jedem Umschalten gerufen. Neu gebaut und
 * nicht nur versteckt, weil der Radius am Modell hängt: ein verstecktes Netz
 * vom vorigen Prop wäre beim nächsten Einschalten der falsche Kreis.
 */
function baueKollision(): void {
  if (kollisionsNetz) {
    scene.remove(kollisionsNetz);
    loeseKollisionAuf(kollisionsNetz);
    kollisionsNetz = undefined;
  }
  if (!einstellungen.kollision || !aktuell.kollision) return;
  kollisionsNetz = baueKollisionsanzeige(aktuell.kollision, hoeheDesModells);
  scene.add(kollisionsNetz);
}

function zeigeMasse(groesse: THREE.Vector3, kasten: THREE.Box3): void {
  const dreiecke = zaehleDreiecke();
  // Die Kollision steht immer im Fuss, auch wenn der Kreis nicht gezeichnet
  // ist: die Zahl ist die Frage, und das Bild ist nur die Antwort darauf.
  const kollision = aktuell.kollision ? ` · ${beschreibeKollision(aktuell.kollision)}` : '';
  fuss.textContent =
    `${aktuell.id} · ${groesse.x.toFixed(2)} × ${groesse.y.toFixed(2)} × ${groesse.z.toFixed(2)} m` +
    ` · Boden bei y = ${kasten.min.y.toFixed(2)} · ${dreiecke} Dreiecke${kollision}`;
}

/**
 * Wie viele Dreiecke das Modell hat.
 *
 * Steht mit im Fuss, weil es die Frage ist, die bei prozeduralen Modellen als
 * Zweites kommt: ein Baum mit achttausend Dreiecken ist auf dem Telefon ein
 * Problem, und sechshundert davon stehen auf einer Karte.
 */
function zaehleDreiecke(): number {
  let summe = 0;
  halter.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geo = mesh.geometry as THREE.BufferGeometry;
    const anzahl = geo.index ? geo.index.count : (geo.getAttribute('position')?.count ?? 0);
    summe += anzahl / 3;
  });
  return Math.round(summe);
}

// ---------------------------------------------------------------------------
// Bedienfeld
// ---------------------------------------------------------------------------

function zeichnePanel(): void {
  panel.textContent = '';

  const wahlLabel = document.createElement('label');
  wahlLabel.textContent = 'Modell';
  wahlLabel.htmlFor = 'modellwahl';
  const wahl = document.createElement('select');
  wahl.id = 'modellwahl';
  wahl.className = 'wahl';

  // Nach Gruppen sortiert und mit Überschrift: der Katalog hat weit über
  // sechzig Einträge, und eine flache Liste findet man auf dem Telefon nicht
  // mehr durch.
  const gruppen = new Map<string, Eintrag[]>();
  for (const e of katalog) {
    const liste = gruppen.get(e.gruppe) ?? [];
    liste.push(e);
    gruppen.set(e.gruppe, liste);
  }
  for (const [gruppe, liste] of gruppen) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = `${gruppe} (${liste.length})`;
    for (const e of liste) {
      const option = document.createElement('option');
      option.value = e.id;
      option.textContent = e.id;
      option.selected = e.id === aktuell.id;
      optgroup.appendChild(option);
    }
    wahl.appendChild(optgroup);
  }
  wahl.addEventListener('change', () => {
    const naechster = katalog.find((e) => e.id === wahl.value);
    if (naechster) zeige(naechster);
  });
  panel.append(wahlLabel, wahl);

  // Vor und zurück: am Telefon blättert man damit durch alle Modelle, ohne die
  // Auswahlliste jedes Mal aufzuziehen. Genau der Weg, auf dem man einen
  // Katalog einmal ganz durchsieht.
  const blaettern = document.createElement('div');
  blaettern.className = 'reihe';
  for (const [text, schritt] of [
    ['‹ Vorheriges', -1],
    ['Nächstes ›', 1],
  ] as [string, number][]) {
    const knopf = document.createElement('button');
    knopf.type = 'button';
    knopf.textContent = text;
    knopf.addEventListener('click', () => {
      const i = katalog.findIndex((e) => e.id === aktuell.id);
      zeige(katalog[(i + schritt + katalog.length) % katalog.length]!);
    });
    blaettern.appendChild(knopf);
  }
  panel.appendChild(blaettern);

  // --- Massstab ------------------------------------------------------------

  const massLabel = document.createElement('h2');
  massLabel.textContent = 'Massstab';
  const masse = document.createElement('div');
  masse.className = 'palette';
  // Drei feste Bildhöhen und die Anpassung. Die Zahlen decken ab, was es gibt:
  // ein Pilz, ein Baum, ein schwebender Fels.
  const BEZUEGE: [string, number][] = [
    ['2 m', 2],
    ['12 m', 12],
    ['40 m', 40],
    ['Anpassen', 0],
  ];
  for (const [text, wert] of BEZUEGE) {
    const knopf = document.createElement('button');
    knopf.type = 'button';
    knopf.textContent = text;
    knopf.setAttribute('aria-pressed', String(einstellungen.bezug === wert));
    knopf.addEventListener('click', () => {
      einstellungen.bezug = wert;
      merke();
      // Neu ausrichten und nicht nur den Abstand setzen: bei „Anpassen" hängt
      // auch der Blickpunkt am Modell, und der steht sonst noch auf der festen
      // Höhe von vorhin.
      zeige(aktuell);
    });
    masse.appendChild(knopf);
  }
  panel.append(massLabel, masse);

  // --- Licht ---------------------------------------------------------------

  const lichtLabel = document.createElement('h2');
  lichtLabel.textContent = 'Licht';
  const lichter = document.createElement('div');
  lichter.className = 'palette';
  const STUFEN: [string, number][] = [
    ['Aus', 0],
    ['Dunkel', 0.5],
    ['Normal', 1],
    ['Hell', 1.8],
  ];
  for (const [text, wert] of STUFEN) {
    const knopf = document.createElement('button');
    knopf.type = 'button';
    knopf.textContent = text;
    knopf.setAttribute('aria-pressed', String(Math.abs(einstellungen.licht - wert) < 0.01));
    knopf.addEventListener('click', () => {
      einstellungen.licht = wert;
      wendeAn();
      merke();
      zeichnePanel();
    });
    lichter.appendChild(knopf);
  }
  panel.append(lichtLabel, lichter);

  // --- Schalter ------------------------------------------------------------

  const schalterLabel = document.createElement('h2');
  schalterLabel.textContent = 'Anzeige';
  panel.appendChild(schalterLabel);

  const SCHALTER: [keyof typeof einstellungen, string][] = [
    ['kollision', 'Kollision zeigen'],
    ['wireframe', 'Drahtgitter'],
    ['gitter', 'Bodenraster'],
    ['achsen', 'Achsen'],
    ['drehen', 'Von selbst drehen'],
    ['hell', 'Heller Hintergrund'],
    ['laufen', 'Figuren laufen lassen'],
  ];
  for (const [schluessel, text] of SCHALTER) {
    const zeile = document.createElement('label');
    zeile.className = 'schalter';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = Boolean(einstellungen[schluessel]);
    box.addEventListener('change', () => {
      (einstellungen[schluessel] as boolean) = box.checked;
      wendeAn();
      merke();
      // Der Fokus bleibt sonst auf dem Kästchen liegen, und die nächste
      // Leertaste schaltet es wieder um, statt die Geste zu bedienen.
      box.blur();
    });
    zeile.append(box, document.createTextNode(text));
    panel.appendChild(zeile);
  }

  const zurueck = document.createElement('button');
  zurueck.type = 'button';
  zurueck.className = 'weit';
  zurueck.textContent = 'Ansicht zurücksetzen';
  zurueck.addEventListener('click', () => {
    kameraGier = 0.6;
    kameraNick = 0.35;
    zeige(aktuell);
  });
  panel.appendChild(zurueck);
}

/** Trägt die Einstellungen in die Szene. */
function wendeAn(): void {
  const l = einstellungen.licht;
  fuehrung.intensity = 1.9 * l;
  gegenlicht.intensity = 0.3 * l;
  // Bei ausgeschaltetem Licht bleibt die Umgebung stehen und wird sogar
  // stärker: sonst wäre das Bild schwarz, und „Licht aus" soll die Form ohne
  // Schattierung zeigen und nicht gar nichts.
  umgebung.intensity = l === 0 ? 1.6 : 1.2 * l;
  material.wireframe = einstellungen.wireframe;
  laubMaterial.wireframe = einstellungen.wireframe;
  gitter.visible = einstellungen.gitter;
  achsen.visible = einstellungen.achsen;
  baueKollision();
  renderer.setClearColor(einstellungen.hell ? 0xdfe7ec : 0x0b1014, 1);
  document.body.dataset.hell = einstellungen.hell ? '1' : '0';
}

klapp.addEventListener('click', () => {
  const zu = panel.dataset.zu === '1';
  panel.dataset.zu = zu ? '0' : '1';
  klapp.setAttribute('aria-expanded', String(zu));
});

// ---------------------------------------------------------------------------
// Bedienung
// ---------------------------------------------------------------------------

/**
 * Zeiger, die gerade auf der Leinwand liegen.
 *
 * Eine Karte und keine Zählung: bei zwei Fingern braucht es beide Punkte, und
 * beim Loslassen muss genau der richtige verschwinden. Mit einem Zähler steht
 * nach einem verlorenen `pointerup` — beim Wischen über den Rand keine
 * Seltenheit — für immer eine Zwei darin.
 */
const zeiger = new Map<number, { x: number; y: number }>();
/** Abstand und Mitte der beiden Finger im letzten Bild. */
let letzterAbstand = 0;
let letzteMitte = { x: 0, y: 0 };

canvas.addEventListener('pointerdown', (e) => {
  try {
    // Der Fang hält den Zeiger auch dann bei der Leinwand, wenn der Finger
    // über das Bedienfeld wandert. Er scheitert bei einem Ereignis, das kein
    // echter Zeiger ist — dann geht es ohne, statt die Geste abzubrechen.
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* kein echter Zeiger */
  }
  zeiger.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (zeiger.size === 2) merkeZweifinger();
  e.preventDefault();
});

function merkeZweifinger(): void {
  const [a, b] = [...zeiger.values()];
  if (!a || !b) return;
  letzterAbstand = Math.hypot(a.x - b.x, a.y - b.y);
  letzteMitte = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
}

canvas.addEventListener('pointermove', (e) => {
  const alt = zeiger.get(e.pointerId);
  if (!alt) return;
  const dx = e.clientX - alt.x;
  const dy = e.clientY - alt.y;
  zeiger.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (zeiger.size === 1) {
    // Ein Finger dreht. Die Empfindlichkeit hängt an der Bildbreite, damit
    // dieselbe Wischbewegung auf jedem Gerät gleich weit dreht.
    kameraGier -= dx * (Math.PI / window.innerWidth) * 1.6;
    kameraNick = Math.max(
      -1.45,
      Math.min(1.45, kameraNick + dy * (Math.PI / window.innerHeight) * 1.4),
    );
    return;
  }

  if (zeiger.size >= 2) {
    const [a, b] = [...zeiger.values()];
    if (!a || !b) return;
    const jetztAbstand = Math.hypot(a.x - b.x, a.y - b.y);
    const jetztMitte = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };

    /*
     * Zoom **und** Verschieben aus derselben Geste, und zwar gleichzeitig.
     *
     * Zwei getrennte Gesten (erst zoomen, dann schieben) wären am Telefon eine
     * Zumutung: man macht beides in einer Bewegung, und ein Griff, der nur
     * eines davon annimmt, fühlt sich kaputt an. Der Abstand der Finger sagt
     * den Zoom, ihre Mitte das Schieben — die beiden Zahlen sind unabhängig,
     * also lassen sie sich auch unabhängig lesen.
     */
    if (letzterAbstand > 0 && jetztAbstand > 0) {
      abstand = Math.max(0.3, Math.min(200, abstand * (letzterAbstand / jetztAbstand)));
    }
    schiebe(jetztMitte.x - letzteMitte.x, jetztMitte.y - letzteMitte.y);

    letzterAbstand = jetztAbstand;
    letzteMitte = jetztMitte;
  }
});

for (const art of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
  canvas.addEventListener(art, (e) => {
    zeiger.delete((e as PointerEvent).pointerId);
    if (zeiger.size === 2) merkeZweifinger();
    else letzterAbstand = 0;
  });
}

/**
 * Schiebt den Blickpunkt in der Bildebene.
 *
 * Kamerarelativ und nicht in Weltachsen: der Griff soll das Modell unter dem
 * Finger halten, egal wie weit man vorher gedreht hat.
 */
function schiebe(dx: number, dy: number): void {
  const tempo = (abstand * 2) / window.innerHeight;
  const rechts = new THREE.Vector3();
  const hoch = new THREE.Vector3();
  camera.matrixWorld.extractBasis(rechts, hoch, new THREE.Vector3());
  blickpunkt.addScaledVector(rechts, -dx * tempo);
  blickpunkt.addScaledVector(hoch, dy * tempo);
}

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    abstand = Math.max(0.3, Math.min(200, abstand * (e.deltaY > 0 ? 1.12 : 1 / 1.12)));
  },
  { passive: false },
);

// Am Schreibtisch schiebt die rechte Maustaste — dieselbe Bewegung wie mit
// zwei Fingern, nur mit dem Gerät, das da ist.
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const i = katalog.findIndex((x) => x.id === aktuell.id);
    zeige(katalog[(i + (e.key === 'ArrowRight' ? 1 : -1) + katalog.length) % katalog.length]!);
  }
});

// ---------------------------------------------------------------------------
// Bildschleife
// ---------------------------------------------------------------------------

function passeAn(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', passeAn);

let letzteZeit = performance.now();
let laufzeit = 0;

function bild(): void {
  const jetzt = performance.now();
  const dt = Math.min(0.1, (jetzt - letzteZeit) / 1000);
  letzteZeit = jetzt;
  laufzeit += dt;

  if (einstellungen.drehen) halter.rotation.y += dt * 0.45;

  // Ein Rig lebt: entweder es steht und atmet, oder es läuft. Beides zeigt,
  // ob die Gelenke greifen — eine eingefrorene Puppe zeigt es nicht.
  rig?.update({
    speed: einstellungen.laufen ? 5 : 0,
    attackPhase: -1,
    pickupPhase: -1,
    dead: false,
    time: laufzeit,
    dt,
  });

  const cosNick = Math.cos(kameraNick);
  camera.position.set(
    blickpunkt.x + Math.sin(kameraGier) * cosNick * abstand,
    blickpunkt.y + Math.sin(kameraNick) * abstand,
    blickpunkt.z + Math.cos(kameraGier) * cosNick * abstand,
  );
  camera.lookAt(blickpunkt);

  renderer.render(scene, camera);
  requestAnimationFrame(bild);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

kopf.textContent = 'Aurelith — Modellschau';
passeAn();
wendeAn();
zeige(katalog[0]!);
// Am Telefon fängt das Bedienfeld zugeklappt an: dort ist die Fläche knapp,
// und das Modell ist der Grund, warum man hier ist.
panel.dataset.zu = window.innerWidth < 720 ? '1' : '0';
klapp.setAttribute('aria-expanded', String(panel.dataset.zu === '0'));
requestAnimationFrame(bild);

// Für den Rauchtest: was gerade zu sehen ist, ohne in die Szene greifen zu
// müssen. Lesend — die Schau bedient sich nicht selbst.
Object.defineProperty(window, 'modellschau', {
  value: {
    get modelle() {
      return katalog.map((e) => ({ id: e.id, gruppe: e.gruppe }));
    },
    get aktuell() {
      return aktuell.id;
    },
    get kamera() {
      return {
        gier: kameraGier,
        nick: kameraNick,
        abstand,
        blick: { x: blickpunkt.x, y: blickpunkt.y, z: blickpunkt.z },
      };
    },
    get panelZu() {
      return panel.dataset.zu === '1';
    },
    get einstellungen() {
      return { ...einstellungen };
    },
    /**
     * Was von der Kollision zu sehen ist.
     *
     * `gezeichnet` und nicht nur der Schalter: eingeschaltet, aber nichts in
     * der Szene, ist genau der Fehler, den ein Blick auf die Einstellung nicht
     * findet — und bei einer Figur ist er sogar richtig, denn Figuren haben
     * keine.
     */
    get kollision() {
      return {
        an: einstellungen.kollision,
        gezeichnet: Boolean(kollisionsNetz),
        text: aktuell.kollision ? beschreibeKollision(aktuell.kollision) : null,
      };
    },
  },
});
