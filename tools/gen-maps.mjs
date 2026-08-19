#!/usr/bin/env node
/**
 * Erzeugt die Start-Maps als aurelith.map-Dokumente.
 *
 * Das ist ausdrücklich ein Platzhalter für den Editor: sobald der steht, wird
 * hier nichts mehr generiert, sondern von Hand gesetzt. Bis dahin braucht das
 * Spiel Inhalte, und ein deterministischer Generator ist besser als eine
 * dreitausend Zeilen lange JSON-Datei im Diff.
 *
 *   node tools/gen-maps.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Der Kodierer für das Höhenfeld kommt aus `shared` und wird **nicht**
// nachgebaut: die Schrittweite (`SCULPT_UNIT`) ist dieselbe Zahl, die der Kern
// beim Lesen benutzt, und eine zweite Fassung davon liefe beim ersten Drehen
// daran auseinander. Deshalb läuft dieses Werkzeug über `tsx`.
import {
  encodePaintField,
  encodeSculptField,
  MAX_GROUND_LAYERS,
  SCULPT_UNIT,
  standardKollision,
} from '@aurelith/shared';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'assets', 'maps');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Die Kollision eines Modells, fertig fürs Kartendokument.
 *
 * Die Zahl steht **nicht** an jedem Aufruf, sondern einmal in
 * `PROP_KOLLISION` — sonst hat derselbe Baum je nach Karte einen anderen
 * Radius, und genau so war es hier: `rock_large` mit 1,9, 2,0 und 2,1 auf drei
 * Karten, `rock_small` in der Gruft ganz ohne Kreis.
 */
function kollision(modell) {
  const k = standardKollision(modell);
  // `collisionHeight` 0 heisst „bis in den Himmel" — siehe `PropKollision`.
  // Über alles darunter springt man hinweg.
  return { collision: k.form, collisionRadius: k.radius, collisionHeight: k.hoehe };
}

/**
 * Streut Props über die Fläche und hält Sperrzonen frei — Spawnpunkte, NPCs
 * und Gates sollen begehbar bleiben.
 */
function scatter(
  rng,
  { count, size, models, keepOut, minGap, scaleRange, tints, bereich, erlaubt },
) {
  const placed = [];
  const margin = size * 0.46;
  // Ohne Bereich die ganze Fläche — so, wie es vor den rechteckigen Karten war.
  const feld = bereich ?? { x0: -margin, x1: margin, z0: -margin, z1: margin };
  let attempts = 0;

  /*
   * Ein Raster über das Gesetzte — sonst wächst die Streuung quadratisch.
   *
   * Der Mindestabstand wurde einmal gegen **jedes** schon gesetzte Prop
   * geprüft. Auf der alten Karte waren das ein paar hundert je Streuung und
   * niemandem etwas aufgefallen. Auf der langen Karte sind es je Zone
   * mehrere tausend, und bei sechzig Versuchen je Stück wären das Milliarden
   * Vergleiche — die Karte hätte sich nicht mehr erzeugen lassen.
   *
   * Die Maschenweite ist der Mindestabstand selbst: dann liegt alles, was
   * näher als `minGap` sein könnte, in der eigenen oder einer der acht
   * angrenzenden Maschen. Dasselbe für die Sperrkreise, mit deren grösstem
   * Radius als Maschenweite.
   */
  const maschen = new Map();
  const maschenWeite = Math.max(0.5, minGap);
  const schluessel = (ix, iz) => `${ix},${iz}`;
  const zuNah = (x, z) => {
    const ix = Math.floor(x / maschenWeite);
    const iz = Math.floor(z / maschenWeite);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const eimer = maschen.get(schluessel(ix + dx, iz + dz));
        if (!eimer) continue;
        for (const p of eimer) {
          if (Math.hypot(x - p[0], z - p[1]) < minGap) return true;
        }
      }
    }
    return false;
  };

  const sperrWeite = Math.max(1, ...keepOut.map((k) => k.r));
  const sperren = new Map();
  for (const k of keepOut) {
    // Ein Kreis liegt in mehreren Maschen. Eingetragen wird er in alle, die er
    // berührt — sonst fände ihn eine Abfrage am Rand seiner Masche nicht.
    const von = (v) => Math.floor((v - k.r) / sperrWeite);
    const bis = (v) => Math.floor((v + k.r) / sperrWeite);
    for (let iz = von(k.z); iz <= bis(k.z); iz++) {
      for (let ix = von(k.x); ix <= bis(k.x); ix++) {
        const s = schluessel(ix, iz);
        const eimer = sperren.get(s);
        if (eimer) eimer.push(k);
        else sperren.set(s, [k]);
      }
    }
  }
  const gesperrt = (x, z) => {
    const eimer = sperren.get(schluessel(Math.floor(x / sperrWeite), Math.floor(z / sperrWeite)));
    if (!eimer) return false;
    for (const k of eimer) if (Math.hypot(x - k.x, z - k.z) < k.r) return true;
    return false;
  };

  while (placed.length < count && attempts < count * 60) {
    attempts++;
    const x = feld.x0 + rng() * (feld.x1 - feld.x0);
    const z = feld.z0 + rng() * (feld.z1 - feld.z0);

    // Der Bereich sagt „ungefähr hier", die Bedingung sagt „aber nicht im
    // Fluss und nicht im Berg". Zwei Fragen, weil ein Rechteck das eine kann
    // und das andere nicht.
    if (erlaubt && !erlaubt(x, z)) continue;
    if (gesperrt(x, z)) continue;
    if (zuNah(x, z)) continue;

    const model = models[Math.floor(rng() * models.length)];
    const scale = scaleRange[0] + rng() * (scaleRange[1] - scaleRange[0]);
    const prop = {
      id: `p_${String(placed.length + 1).padStart(4, '0')}`,
      model: model.key,
      position: [round(x), 0, round(z)],
      rotation: [0, round(rng() * Math.PI * 2), 0],
      scale: round(scale),
      snapToGround: true,
      ...kollision(model.key),
    };
    if (tints && tints.length > 0) {
      prop.tint = tints[Math.floor(rng() * tints.length)];
    }
    placed.push(prop);
    // Mit der **gerundeten** Lage ins Raster — verglichen wird gegen
    // `position`, und auf zwei Stellen gerundet liegt die um bis zu einem
    // halben Zentimeter daneben. Wer roh einträgt und gerundet vergleicht,
    // bekommt an der Maschengrenze ein anderes Ergebnis als die alte Schleife.
    const px = prop.position[0];
    const pz = prop.position[2];
    const s = schluessel(Math.floor(px / maschenWeite), Math.floor(pz / maschenWeite));
    const eimer = maschen.get(s);
    if (eimer) eimer.push([px, pz]);
    else maschen.set(s, [[px, pz]]);
  }

  return placed;
}

const round = (v) => Math.round(v * 100) / 100;

/** Weiche Kante zwischen 0 und 1 — dieselbe Kurve, die Shader benutzen. */
const glatt = (t) => {
  const u = Math.max(0, Math.min(1, t));
  return u * u * (3 - 2 * u);
};

/**
 * Baut ein Höhenfeld aus einer Funktion.
 *
 * Die Funktion bekommt Weltkoordinaten und liefert die **Differenz** auf das
 * prozedurale Relief — genau das, was `sculpt` im Kartendokument bedeutet. Der
 * Kern addiert sie beim Höhenabruf dazu, im Client wie auf dem Server.
 *
 * Die Auflösung ist gröber als das Bild, aber feiner als das Geländenetz: bei
 * zwei Einheiten Abstand hat eine Flussböschung von fünf Einheiten drei
 * Stützpunkte, und daraus wird eine Kante und keine Rampe. Bei vier Einheiten
 * — der Vorgabe — wäre der Fluss eine Mulde, durch die man hindurchspaziert.
 */
function baueSculpt(size, fn, { schrittweite = 2 } = {}) {
  const resolution = Math.max(2, Math.round(size / schrittweite) + 1);
  const werte = new Int16Array(resolution * resolution);
  const half = size * 0.5;
  const schritt = size / (resolution - 1);

  for (let iz = 0; iz < resolution; iz++) {
    const z = -half + iz * schritt;
    for (let ix = 0; ix < resolution; ix++) {
      const x = -half + ix * schritt;
      const h = fn(x, z);
      // Auf die Schrittweite des Feldes runden. int16 reicht damit bis ±512 m;
      // die Berge hier bleiben weit darunter.
      werte[iz * resolution + ix] = Math.max(
        -32768,
        Math.min(32767, Math.round(h * SCULPT_UNIT)),
      );
    }
  }
  return encodeSculptField(werte, resolution);
}

/**
 * Baut ein Malfeld aus einer Funktion.
 *
 * Die Funktion bekommt Weltkoordinaten und liefert je Bodenebene ein Gewicht
 * von 0 bis 1 — oder nichts, wo nicht gemalt werden soll. Der Unterschied ist
 * der Punkt: ein Stützpunkt mit lauter Nullen heisst „hier hat niemand
 * gemalt", und dort entscheiden weiter die Regeln aus Neigung und Höhe. Nur
 * wo etwas steht, treten sie zurück (siehe `buildTerrain`).
 *
 * Sechs Meter Schrittweite: das Geländenetz selbst hat vier bis acht, und ein
 * feineres Malfeld könnte man gar nicht sehen — die Splatgewichte sitzen an
 * den Vertizes des Netzes. Feiner wäre nur teurer: das Feld trägt vier Bytes
 * je Stützpunkt, bei drei Metern wären das anderthalb Megabyte für einen Weg.
 */
function baueMalfeld(size, fn, { schrittweite = 6 } = {}) {
  const resolution = Math.max(2, Math.round(size / schrittweite) + 1);
  const werte = new Uint8Array(resolution * resolution * MAX_GROUND_LAYERS);
  const half = size * 0.5;
  const schritt = size / (resolution - 1);

  for (let iz = 0; iz < resolution; iz++) {
    const z = -half + iz * schritt;
    for (let ix = 0; ix < resolution; ix++) {
      const x = -half + ix * schritt;
      const gewichte = fn(x, z);
      if (!gewichte) continue;
      const basis = (iz * resolution + ix) * MAX_GROUND_LAYERS;
      for (let l = 0; l < MAX_GROUND_LAYERS; l++) {
        werte[basis + l] = Math.max(0, Math.min(255, Math.round((gewichte[l] ?? 0) * 255)));
      }
    }
  }
  return encodePaintField(werte, resolution);
}

// --------------------------------------------------------------------------
// Gesetzte Props: Zäune, Laternen, Lager.
//
// Der Streuer oben wirft Bäume und Büsche über die Fläche — das macht Natur.
// Alles, was nach Bewohnern aussehen soll, muss dagegen in Linien und Gruppen
// stehen: ein gestreuter Zaun ist kein Zaun, sondern Bauholz im Wald.
// --------------------------------------------------------------------------

/**
 * Reiht Zaunfelder auf einer Strecke auf.
 *
 * Ein Feld ist zwei Einheiten breit und hat seine Pfosten an den Enden, deshalb
 * ergibt eine lückenlose Kette eine durchgehende Linie. Die Strecke wird auf
 * ganze Felder gerundet — lieber ein Feld zu wenig als eines, das über die Ecke
 * hinausragt.
 *
 * Die Drehung: eine Drehung um Y bildet die lokale +X-Achse auf
 * `(cos θ, −sin θ)` ab, das Feld liegt entlang +X. Für die Richtung `(dx, dz)`
 * ist also `θ = atan2(−dz, dx)` — das Minus ist kein Tippfehler.
 */
function fenceRun(model, from, to, { scale = 1 } = {}) {
  // Ein Zaunlauf ist eine Reihe mit zwei Metern Feldbreite — und nichts
  // sonst. Die Rechnung stand hier einmal ausgeschrieben; seit es auch Stege
  // und Palisaden gibt, wäre das dieselbe Formel an zwei Stellen.
  return reihe(model, from, to, 2, { scale });
}

/** Ein geschlossenes Gehege. Vier Läufe, an den Ecken gestoßen. */
function fenceRect(model, cx, cz, halfX, halfZ, opts = {}) {
  return [
    ...fenceRun(model, [cx - halfX, cz - halfZ], [cx + halfX, cz - halfZ], opts),
    ...fenceRun(model, [cx + halfX, cz - halfZ], [cx + halfX, cz + halfZ], opts),
    ...fenceRun(model, [cx + halfX, cz + halfZ], [cx - halfX, cz + halfZ], opts),
    ...fenceRun(model, [cx - halfX, cz + halfZ], [cx - halfX, cz - halfZ], opts),
  ];
}

/**
 * Ein einzelnes gesetztes Prop.
 *
 * `y` schaltet `snapToGround` ab und setzt die Höhe von Hand — für alles, was
 * nicht auf dem Boden steht: ein Tropfstein an der Decke, eine Wandfackel.
 * Ohne diese Möglichkeit klebte die Spitze des Zapfens im Gras.
 */
function place(model, x, z, { yaw = 0, scale = 1, y } = {}) {
  return {
    model,
    position: [round(x), round(y ?? 0), round(z)],
    rotation: [0, round(yaw), 0],
    scale,
    snapToGround: y === undefined,
    ...kollision(model),
  };
}

/**
 * Eine Reihe gleicher Props entlang einer Strecke.
 *
 * Wie `fenceRun`, aber ohne die feste Feldbreite von zwei Metern: Stege,
 * Palisaden und Steinplattenwege haben jeweils ihre eigene. Der Winkel wird
 * mitgegeben, damit ein Steg in Laufrichtung zeigt und nicht quer dazu.
 */
function reihe(model, from, to, feld, { scale = 1, drehung = 0 } = {}) {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  const laenge = Math.hypot(dx, dz);
  const stueck = Math.max(1, Math.round(laenge / (feld * scale)));
  const yaw = round(Math.atan2(-dz, dx) + drehung);
  const out = [];
  for (let i = 0; i < stueck; i++) {
    const t = (i + 0.5) / stueck;
    out.push({
      model,
      position: [round(from[0] + dx * t), 0, round(from[1] + dz * t)],
      rotation: [0, yaw, 0],
      scale,
      snapToGround: true,
      ...kollision(model),
    });
  }
  return out;
}

/**
 * Laternen entlang eines Weges, abwechselnd links und rechts.
 *
 * Versetzt statt paarweise: zwei Laternen nebeneinander leuchten dieselbe
 * Stelle an, versetzte decken den Weg mit der halben Zahl ab. Und weil die
 * Zahl gleichzeitiger Lichter fest ist, ist jede gesparte Laterne eine, die
 * anderswo leuchten kann.
 */
function lanternRoad(from, to, { abstand = 30, seite = 6, scale = 1 } = {}) {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  const laenge = Math.hypot(dx, dz);
  const n = Math.max(1, Math.round(laenge / abstand));
  // Senkrecht zur Wegrichtung.
  const nx = -dz / laenge;
  const nz = dx / laenge;

  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const s = i % 2 === 0 ? seite : -seite;
    out.push(
      place('lantern_post', from[0] + dx * t + nx * s, from[1] + dz * t + nz * s, {
        scale,
      }),
    );
  }
  return out;
}

/** Sperrzonen aus gesetzten Props, damit der Streuer keine Bäume hineinstellt. */
function keepOutOf(props, r) {
  return props.map((p) => ({ x: p.position[0], z: p.position[2], r }));
}

/**
 * Bodenebenen.
 *
 * Gras auf flachem Grund oberhalb des Wassers, Erde an den Haengen, Sand am
 * Ufer. Die Bereiche ueberlappen bewusst — daraus entsteht der Uebergang.
 * Was keine Ebene deckt, bleibt die prozedurale Farbe des Gelaendes; sehr
 * steile Klippen sind deshalb weiterhin Fels als Farbflaeche, weil dafuer
 * noch keine Textur geliefert ist.
 *
 * Die Rauheitswerte sind gemessen, siehe tools/prepare-textures.mjs.
 */
function groundLayers(waterLevel, { grassTint = 0xffffff, dirtTint = 0xffffff, sandTint = 0xffffff } = {}) {
  return [
    {
      id: 'gras',
      texture: 'textures/ground_grass/albedo.webp',
      normal: 'textures/ground_grass/normal.webp',
      // Groessere Kachel heisst weniger Wiederholungen im Bild und damit mehr
      // sichtbare Struktur: bei sechs Einheiten mittelt das Mipmapping die
      // Textur auf ihren Durchschnitt weg, und der ist ein flaches Oliv.
      tileSize: 11,
      slope: [0, 30],
      height: [waterLevel + 0.5, 10000],
      slopeBlend: 8,
      heightBlend: 1.5,
      strength: 1,
      tint: grassTint,
      roughness: 0.91,
      normalScale: 1,
    },
    {
      id: 'erde',
      texture: 'textures/ground_dirt/albedo.webp',
      normal: 'textures/ground_dirt/normal.webp',
      tileSize: 9,
      slope: [24, 62],
      height: [-10000, 10000],
      slopeBlend: 8,
      heightBlend: 3,
      strength: 1,
      tint: dirtTint,
      roughness: 0.78,
      normalScale: 1,
    },
    {
      id: 'sand',
      texture: 'textures/ground_sand/albedo.webp',
      normal: 'textures/ground_sand/normal.webp',
      tileSize: 8,
      slope: [0, 26],
      // Sand gehoert ans Ufer, nicht in jede Senke. Der Spawn von Lichtmoor
      // liegt auf -2,3 und war mit dem weiteren Band zu drei Vierteln Sand.
      height: [-10000, waterLevel + 1],
      slopeBlend: 6,
      heightBlend: 1.2,
      strength: 1,
      tint: sandTint,
      roughness: 0.75,
      normalScale: 0.8,
    },
  ];
}

// --------------------------------------------------------------------------
// Lichtmoor — die Heimatkarte. Hauptstadt im Süden, Stufengebiete nach Norden.
//
// Die Karte ist eine **Insel** in einem quadratischen Gelände: begehbar sind
// zwölfhundert auf achtzehnhundertvierzig Einheiten, rundherum fällt das Land
// über eine Klippe ins Meer, und weit draussen über dem Wasser stehen die
// Sperrzonen. Damit sieht man nie einen Kartenrand, sondern einen Horizont —
// und der Weg führt in genau eine Richtung, nach Norden, wo die Monster mit
// jedem Abschnitt eine Stufe höher stehen.
//
// Der Aufbau von unten nach oben (die Zonentabelle `LM_ZONEN` sagt dasselbe
// noch einmal in Zahlen, und sie ist die Quelle — hier steht der Überblick):
//
//   z −880 … −440  Silberfurt bei −488, die Hauptstadt. Mauer, Markt,
//                  alle Hauptquests. Dahinter die ersten Irrlichter.
//   z −440 …  −80  Stufe 1–3. Die Weiden vor der Stadt.
//   z  −80 …  220  Stufe 4–7. Grabwelpen in den Gruben.
//   z  220 …  500  Stufe 8–11. Distelkeiler an den Uferwiesen.
//   z  500 …  720  Stufe 12–15. Banditen im Geröllfeld.
//   z  720 …  960  Stufe 16–20. Höhlenkriecher und Gruftwärter im Dornsaum,
//                  das Tor nach Dornwald bei 784.
//
// Quer durch alles fliesst die Silberader. Ihre Ufer sind zu steil zum
// Begehen — das ist Absicht: der Fluss teilt die Wiese, und die Brücke ist
// eine Wegmarke statt einer Zierde.
// --------------------------------------------------------------------------

/** Der begehbare Streifen. Alles ausserhalb ist Gebirge und gesperrt. */
const LM = {
  /**
   * Halbe Breite und Enden des begehbaren Plateaus.
   *
   * **Die Karte wird in Minuten gemessen und nicht in Metern.** Eine Figur
   * läuft 6,2 Einheiten je Sekunde (`assets/content/tuning.json`), und damit
   * war die alte Insel — vierhundertvierzig auf vierhundertsechzig — in
   * fünfundsiebzig Sekunden von Süden nach Norden durchquert. Von der Stadt
   * zum Tor waren es fünfzig. Das ist keine Reise, das ist ein Vorgarten:
   * man kam an, bevor die Gegend anfing, eine zu sein.
   *
   * Jetzt **zwölfhundert auf eintausendachthundertvierzig**. Das sind knapp
   * fünf Minuten von der Südküste bis zum Tor im Norden, dreieinhalb von der
   * Stadt aus und gut drei quer von Küste zu Küste — lang genug, dass ein Weg
   * ein Weg ist, und kurz genug, dass niemand ihn zweimal am Tag verflucht.
   * `karte_test.ts` rechnet alle drei nach, damit die Zahlen nicht beim
   * nächsten Verschieben unbemerkt zerfallen.
   *
   * Die **Länge** trägt weiter den Aufbau: Lichtmoor ist eine Strecke von
   * Stufe eins bis zwanzig, und die Stufe folgt dem Norden und nicht dem
   * Abstand zur Mitte. Die Breite ist Landschaft — Platz, um auszuweichen,
   * einen Umweg zu fliegen und etwas zu finden, das nicht am Weg liegt.
   *
   * Und keine vier Wände, sondern eine **Insel**: rundherum fällt das Land
   * über eine Klippe ins Meer. Die Klippe ist steiler als die zweiundfünfzig
   * Grad, die der Kern begehbar nennt — man kommt bis an die Kante und keinen
   * Schritt weiter, auch nicht im Sprung.
   */
  size: 2048,
  x: 600,
  zSued: -880,
  zNord: 960,
  /** Mitte der Hauptstadt. */
  stadtZ: -488,
  stadtR: 48,
};

/**
 * Wo die Küste liegt — sie folgt **nicht** dem Rechteck.
 *
 * Zwei Wellen je Achse verschieben die Kante um bis zu fünfundzwanzig Meter
 * hin und her. Ohne sie wäre die Insel ein Rechteck mit abgeschnittenen
 * Rändern, und nichts verrät einen Generator schneller als eine Küstenlinie,
 * die schnurgerade verläuft.
 */
const kuesteX = (z) => LM.x + Math.sin(z * 0.013) * 16 + Math.sin(z * 0.031) * 9;
const kuesteNord = (x) => LM.zNord + Math.sin(x * 0.011) * 15 + Math.sin(x * 0.027) * 8;
const kuesteSued = (x) => LM.zSued - Math.sin(x * 0.017) * 14 - Math.sin(x * 0.009) * 9;

/** Wie weit ein Punkt jenseits der Küste liegt. Negativ heisst: an Land. */
function ausserhalb(x, z) {
  return Math.max(Math.abs(x) - kuesteX(z), z - kuesteNord(x), kuesteSued(x) - z);
}

/**
 * Der Lauf der Silberader, als Stützpunkte (z, x).
 *
 * Von Hand gesetzt statt aus einer Sinuskurve: die Kurve traf zweimal die
 * Stadt, und ein Fluss quer durch den Marktplatz ist kein Fluss, sondern ein
 * Fehler. Mit Stützpunkten sagt man, wo er sein soll — hier weit östlich an
 * Silberfurt vorbei, dann quer über die Wiese nach Westen und im Norden
 * zurück.
 */
const FLUSS = [
  [-800, 114],
  [-560, 106],
  [-380, 96],
  [-160, 57],
  [80, -30],
  [320, -68],
  [560, -11],
  [760, 44],
  [960, 62],
];

/**
 * Wo die Silberader zu dieser Höhe steht.
 *
 * Zwischen den Stützpunkten mit einer Kosinuskurve geglättet und nicht linear:
 * eine lineare Kette hätte an jedem Stützpunkt einen Knick, und ein Knick im
 * Flussbett sieht aus wie ein Kanal.
 */
function silberader(z) {
  if (z <= FLUSS[0][0]) return FLUSS[0][1];
  const letzte = FLUSS[FLUSS.length - 1];
  if (z >= letzte[0]) return letzte[1];
  for (let i = 0; i + 1 < FLUSS.length; i++) {
    const [z0, x0] = FLUSS[i];
    const [z1, x1] = FLUSS[i + 1];
    if (z > z1) continue;
    const t = (z - z0) / (z1 - z0);
    const w = 0.5 - 0.5 * Math.cos(t * Math.PI);
    return x0 + (x1 - x0) * w;
  }
  return letzte[1];
}

/** Abstand zur Flussmitte. */
function flussAbstand(x, z) {
  return Math.abs(x - silberader(z));
}

/**
 * Wo der Fluss die Strasse kreuzt — dort und nur dort steht eine Brücke.
 *
 * Gesucht statt abgeschrieben: die Zahl aus dem Lauf zu lesen ist eine
 * Wahrheit, sie danebenzuschreiben wären zwei. Wer die Stützpunkte oben
 * verschiebt, bekommt die Brücken mitverschoben.
 */
function brueckenStellen(zVon, zBis) {
  const stellen = [];
  let vorher = silberader(zVon);
  for (let z = zVon + 1; z <= zBis; z++) {
    const jetzt = silberader(z);
    if ((vorher <= 0 && jetzt > 0) || (vorher >= 0 && jetzt < 0)) stellen.push(z);
    vorher = jetzt;
  }
  return stellen;
}

/**
 * Das Gelände von Lichtmoor als Differenz auf das Rauschen.
 *
 * Vier Dinge liegen übereinander, und die Reihenfolge ist Absicht:
 *
 *   1. **Berge am Rand.** Sie fangen dort an, wo der begehbare Streifen
 *      aufhört, und stehen sechzig Einheiten weiter in voller Höhe. Ohne sie
 *      sähe man über die Kante der Welt hinaus.
 *   2. **Hügel innen.** Ein paar Kuppen, damit die Wiese nicht flach ist.
 *   3. **Der Fluss.** Tief eingeschnitten, mit Böschungen von über sechzig
 *      Grad — steiler als begehbar, also ein echtes Hindernis.
 *   4. **Der Stadtgrund.** Eine flache Senke unter Silberfurt, damit Mauer und
 *      Häuser nicht auf einer Schräge stehen.
 */
function lichtmoorHoehe(x, z) {
  let h = 0;

  /*
   * --- 0. Der Streifen liegt trocken --------------------------------------
   *
   * Vier Meter über dem Rauschen, und die Zahl ist gegen den Wasserstand
   * gewählt: das Relief schwankt um sechs, der Spiegel liegt bei −4. Ohne
   * diesen Sockel stand die halbe Wiese unter Wasser — die Stadt hatte einen
   * See auf dem Marktplatz, und der Sandsaum am Ufer reichte bis an die Mauer.
   * Am Rand läuft er aus, dort übernimmt ohnehin das Gebirge.
   */
  h += 4;

  /*
   * --- 1. Die Klippe -------------------------------------------------------
   *
   * Hier stand ein Gebirge: erst hundertachtzehn Meter hoch (eine Wand), dann
   * zweiundvierzig (eine Kette). Beides war dasselbe Missverständnis — der
   * Rand der Welt war ein Berg, den man ansieht, statt eines Ortes, an den
   * man geht.
   *
   * Jetzt ist Lichtmoor eine **Insel**. Das Land hört an einer Klippe auf,
   * darunter liegt das Meer, und darüber sieht man bis an den Horizont. Die
   * Klippe fällt sechsundzwanzig Meter auf zwölf — das sind fünfundsechzig
   * Grad, deutlich über den zweiundfünfzig, bis zu denen der Kern einen gehen
   * lässt. Man kommt also bis an die Kante und keinen Schritt weiter, **auch
   * nicht im Sprung**: die Neigungsprüfung greift unabhängig davon, ob die
   * Füsse gerade den Boden berühren.
   *
   * Die Sperrzonen liegen erst dreissig Meter jenseits der Küste. Wer fliegt,
   * kommt damit über die Kante hinaus und sieht die Insel von aussen — was
   * der ganze Sinn eines Fluggeräts ist.
   */
  const drauss = ausserhalb(x, z);
  if (drauss > 0) {
    // Ein bisschen Unruhe in der Kantenhöhe: eine Klippe, die überall gleich
    // tief fällt, sieht aus wie eine Tischkante.
    const kerbe = Math.sin(x * 0.043) * 1.6 + Math.sin(z * 0.037) * 1.4;
    h -= glatt(drauss / 12) * (26 + kerbe);
  }

  // --- 2. Hügel innen -----------------------------------------------------
  /*
   * Sanfte Kuppen über die ganze Insel.
   *
   * Mehr als früher und **flacher**: auf einer Fläche von zweieinhalb
   * Hektaren sind sechs Hügel nichts, und steile Kuppen machen aus einer
   * offenen Landschaft ein Labyrinth. Der höchste misst zwanzig Meter auf
   * fünfundvierzig Radius — das sind knapp fünfundzwanzig Grad, man läuft
   * hinauf, ohne es zu merken.
   */
  /*
   * Die Kuppen bleiben **rund**, sie werden nicht mitgestreckt.
   *
   * Verschoben wurden nur ihre Mitten — mit der Länge der Insel. Wer statt
   * dessen die Radien in `z` mitgestreckt hätte, bekäme Rücken von
   * hundertsechzig Metern Länge: aus einer Kuppe, über die man läuft, würde
   * eine Welle, die man nicht mehr als Hügel erkennt.
   *
   * Dafür sind es mehr geworden. Achtzehn Kuppen auf achtzehnhundert Metern
   * wären eine alle hundert Meter — dazwischen läge eine Ebene, und eine
   * Ebene ist beim Laufen dasselbe wie ein Gang.
   */
  const kuppen = [
    { x: -84, z: -120, r: 40, h: 12 },
    { x: 79, z: 88, r: 36, h: 10 },
    { x: -54, z: 384, r: 44, h: 14 },
    { x: 90, z: 568, r: 38, h: 13 },
    { x: -95, z: 704, r: 36, h: 15 },
    { x: 27, z: 760, r: 32, h: 11 },
    // Der Westen und der Osten.
    { x: -218, z: -320, r: 52, h: 16 },
    { x: -238, z: 240, r: 46, h: 13 },
    { x: -190, z: 640, r: 42, h: 11 },
    { x: 211, z: -480, r: 48, h: 14 },
    { x: 234, z: 40, r: 50, h: 18 },
    { x: 197, z: 472, r: 44, h: 12 },
    { x: 229, z: 820, r: 38, h: 10 },
    { x: -204, z: -720, r: 44, h: 12 },
    { x: 131, z: -784, r: 40, h: 9 },
    { x: -41, z: -824, r: 46, h: 11 },
    { x: 54, z: 904, r: 42, h: 13 },
    { x: -147, z: 904, r: 38, h: 9 },
    // Und die Kuppen der neuen Länge — je eine Handvoll in jedem Abschnitt,
    // damit zwischen zwei Wegmarken etwas steht.
    { x: -120, z: -640, r: 46, h: 13 },
    { x: 140, z: -600, r: 42, h: 11 },
    { x: -230, z: -560, r: 50, h: 15 },
    { x: 96, z: -360, r: 38, h: 10 },
    { x: -160, z: -200, r: 44, h: 12 },
    { x: 205, z: -160, r: 46, h: 14 },
    { x: -75, z: 0, r: 40, h: 11 },
    { x: 160, z: 200, r: 44, h: 13 },
    { x: -215, z: 400, r: 48, h: 16 },
    { x: 45, z: 300, r: 36, h: 9 },
    { x: 120, z: 660, r: 40, h: 12 },
    { x: -140, z: 500, r: 38, h: 10 },
    { x: 240, z: 640, r: 42, h: 14 },
    { x: -60, z: 860, r: 40, h: 12 },
    /*
     * Und die Kuppen der neuen Breite.
     *
     * Die Insel ist doppelt so breit geworden; ohne diese hier wäre alles
     * jenseits von dreihundert Metern eine Ebene. Sie stehen weiter
     * auseinander als die am Weg — draussen soll es weiter wirken, nicht
     * voller.
     */
    { x: -380, z: -760, r: 50, h: 14 },
    { x: 420, z: -680, r: 46, h: 12 },
    { x: -460, z: -520, r: 52, h: 16 },
    { x: 380, z: -360, r: 44, h: 11 },
    { x: -520, z: -200, r: 48, h: 15 },
    { x: 440, z: -120, r: 50, h: 13 },
    { x: -360, z: 60, r: 46, h: 12 },
    { x: 500, z: 180, r: 52, h: 17 },
    { x: -440, z: 320, r: 44, h: 10 },
    { x: 360, z: 460, r: 48, h: 14 },
    { x: -500, z: 560, r: 50, h: 12 },
    { x: 420, z: 700, r: 46, h: 13 },
    { x: -380, z: 820, r: 44, h: 11 },
    { x: 520, z: 860, r: 48, h: 15 },
  ];
  for (const k of kuppen) {
    const d = Math.hypot(x - k.x, z - k.z) / k.r;
    if (d < 1) h += glatt(1 - d) * k.h;
  }

  /*
   * --- 2b. Das Relief der Zonen -------------------------------------------
   *
   * **Das ist der Hebel, mit dem sich der Boden umfärbt.** Die Bodentexturen
   * wählen nach *Neigung*: Gras bis dreissig Grad, Erde ab vierundzwanzig.
   * Eine Zone, die welliger ist als ihre Nachbarin, zeigt darum von selbst
   * braune Flecken zwischen dem Grün — ohne eine zweite Textur, ohne ein
   * zweites Feld, ohne dass irgendetwas am Shader zu ändern wäre.
   *
   * Nach Norden wird es unruhiger: die Weiden sind ein Tisch, die Gruben
   * bekommen ihre Namensmulden, die Uferwiesen bleiben weich, das Geröllfeld
   * und der Dornsaum werden ruppig. Alle bleiben weit unter den
   * zweiundfünfzig Grad, bis zu denen der Kern einen Schritt annimmt — es ist
   * eine Färbung und kein Hindernis.
   *
   * **Weich überblendet und nicht gestuft.** Ein Sprung in der Amplitude an
   * der Zonengrenze wäre ein Absatz im Gelände, und der wäre je nach Höhe
   * eine Wand. Die Grenze soll man an den Steinen erkennen, nicht daran, dass
   * man nicht weiterkommt.
   */
  const RELIEF = [
    { bis: -80, amp: 0.35, len: 30 },
    { bis: 220, amp: 1.5, len: 20 },
    { bis: 500, amp: 0.8, len: 26 },
    { bis: 720, amp: 1.5, len: 19 },
    { bis: 1e9, amp: 1.7, len: 17 },
  ];
  let amp = RELIEF[RELIEF.length - 1].amp;
  let len = RELIEF[RELIEF.length - 1].len;
  for (let i = 0; i < RELIEF.length; i++) {
    if (z > RELIEF[i].bis) continue;
    const hier = RELIEF[i];
    const vor = RELIEF[i - 1];
    amp = hier.amp;
    len = hier.len;
    // Vierzig Meter Überblendung nach Süden hin: lang genug, dass niemand
    // eine Kante sieht, kurz genug, dass die Zone in ihrer Mitte ihr eigenes
    // Gesicht behält.
    if (vor) {
      const t = glatt(Math.min(1, (z - vor.bis) / 40));
      amp = vor.amp + (hier.amp - vor.amp) * t;
      len = vor.len + (hier.len - vor.len) * t;
    }
    break;
  }
  const k = (2 * Math.PI) / len;
  h +=
    amp *
    (Math.sin(x * k) * Math.sin(z * k) * 0.65 +
      Math.sin(x * k * 2.1 + 1.3) * Math.sin(z * k * 1.9 + 0.9) * 0.35);

  // --- 3. Die Silberader --------------------------------------------------
  //
  // Neun Meter Einschnitt auf fünf Meter Böschung sind gut sechzig Grad —
  // über der Grenze von zweiundfünfzig, bis zu der man geht. Wer hinein will,
  // muss über die Brücke; wer hinüber will, auch.
  const dFluss = flussAbstand(x, z);
  if (dFluss < 13) {
    const tiefe = dFluss <= 8 ? 1 : 1 - (dFluss - 8) / 5;
    /*
     * Vierzehn Meter Einschnitt: der Sockel von oben hebt das Land mit, und
     * ein Fluss, dessen Bett stellenweise über dem Spiegel liegt, ist ein
     * trockener Graben.
     *
     * Ausser unter der Strasse. Dort trägt eine Brücke hinüber, und die
     * braucht einen Damm, auf dem man geht — ein Loch mit Geländer wäre eine
     * Brücke, durch die man hindurchfällt. Zehn Einheiten breit, an den
     * Rändern weich, damit die Böschung daneben stehenbleibt.
     */
    const aufDerStrasse = Math.max(0, 1 - Math.max(0, Math.abs(x) - 7) / 5);
    h -= 14 * tiefe * (1 - aufDerStrasse);
  }

  /*
   * --- 4. Der Grund von Silberfurt ----------------------------------------
   *
   * Eine flache Terrasse, keine Mulde. Hier stand einmal eine Senke, und die
   * lief prompt voll: der Marktplatz lag unter dem Wasserspiegel, und die
   * Sandebene der Bodentexturen zog sich bis an die Mauer. Eine Stadt gehört
   * ein Stück über ihr Umland — dann sieht man sie schon von weitem.
   */
  const dStadt = Math.hypot(x, z - LM.stadtZ) / (LM.stadtR + 18);
  if (dStadt < 1) h += glatt(1 - dStadt) * 5;

  return h;
}

/**
 * Die Zonen von Lichtmoor — der Aufbau der Karte, als Tabelle.
 *
 * Die Karte war eine Strecke mit einem **Verlauf**: Blumen im Süden, Heide im
 * Norden, und dazwischen zweihundert Meter, in denen sich langsam etwas
 * änderte. Beim Laufen merkte man davon nichts. Was man merkt, sind Kanten:
 * hier hört das eine auf, hier fängt das andere an.
 *
 * Fünf Zonen, und ihre Grenzen liegen dort, wo auch die Stufen springen —
 * die Spawner weiter unten teilen dieselbe Strecke in dieselben Abschnitte.
 * Das ist kein Zufall, sondern der Zweck: wer sieht, dass der Boden wechselt,
 * weiss, dass die Gegner härter werden, bevor ihn einer davon anfällt.
 *
 * Je Zone drei Sorten Bewuchs, und jede beantwortet eine andere Frage:
 *
 *   `baeume`  — was man aus der Ferne sieht. Die Silhouette am Horizont.
 *   `boden`   — was man beim Laufen sieht. Entscheidet die Farbe der Fläche.
 *   `streu`   — Kleinkram am Boden: Steine, Pilze, Knochen.
 *   `akzent`  — was es **nur hier** gibt. Selten, gross genug zum Wiedererkennen.
 *
 * Nur `boden` bekommt einen Farbton, und das ist der Grund für die Trennung
 * von `streu`: der Ton färbt **alles** einer Streuung ein, und ein grüner
 * Fliegenpilz oder ein olivfarbener Schädel sähe aus wie ein Fehler. Gefärbt
 * wird, was Pflanze ist.
 *
 * `dichte` ist die Zahl je tausend Quadratmeter und **keine** Stückzahl. Der
 * Unterschied ist der Punkt: die Weiden sind achthundert Meter lang, der
 * Dornsaum zweihundertvierzig, und mit festen Stückzahlen stünde in der einen
 * Zone ein Baum je dreissig Metern und in der anderen ein Wald. Wie dicht es
 * wirkt, soll die Tabelle sagen, nicht die Länge des Abschnitts.
 *
 * **Die Zahlen sind kleiner geworden, als die Insel länger wurde.** Nicht aus
 * Geschmack, sondern aus Arithmetik: die begehbare Fläche ist von zweihundert
 * auf elfhundert Tausend Quadratmeter gewachsen, und mit den alten Dichten
 * stünden zweiundzwanzigtausend Props auf der Karte. Das wären sechs Megabyte
 * Kartendatei, achttausend Kollisionskreise, durch die der Server in jedem
 * Schritt für jedes Monster hindurchrechnet — für einen Boden, der ohnehin
 * kaum voller aussähe. Am stärksten gekürzt ist der Bodenbewuchs: ein
 * Grasbüschel mehr sieht man aus drei Metern, ein Baum weniger fehlt am
 * Horizont.
 *
 * Die Grenzen der Zonen sind Zahlen in `z` und keine Sperren: man läuft
 * hindurch, ohne aufgehalten zu werden. Eine Zone, die man betreten muss,
 * wäre ein Tor — und Tore hat diese Karte genau eines, im Norden.
 */
const LM_ZONEN = [
  {
    id: 'weiden',
    name: 'Silberfurter Weiden',
    z1: -80,
    /*
     * Vor der Stadt, wo man anfängt: hell, offen, freundlich.
     *
     * Laubbäume statt Nadeln und die hellsten Grüntöne der Karte. Der Süden
     * ist der einzige Abschnitt, in dem Blüten den Boden bestimmen — weiter
     * nördlich kommen sie gar nicht mehr vor, und genau daran erkennt man
     * beim Zurücklaufen, dass man wieder zuhause ist.
     */
    baeume: {
      dichte: 2.2,
      minGap: 9,
      scale: [0.9, 1.6],
      models: ['tree_broad', 'tree_broad', 'tree_pine'],
      tints: [0x6aa855, 0x74b45e, 0x7fbf66],
    },
    boden: {
      dichte: 4.0,
      minGap: 3.4,
      models: ['blume_weiss', 'blume_gelb', 'blume_blau', 'klee', 'klee', 'grass_tuft', 'hochgras'],
      // Warm und hell: Gelbgrün, wie eine Wiese im Juni.
      tints: [0x8fc46a, 0x9ed07a, 0x7fbf66, 0xa8d488],
    },
    streu: { dichte: 1.0, minGap: 5, models: ['kiesel', 'moosstein', 'baumpilz'] },
    akzent: { dichte: 0.15, minGap: 24, models: ['bienenkorb', 'setzling', 'beerenbusch'] },
  },
  {
    id: 'gruben',
    name: 'Die Gruben',
    z1: 220,
    /*
     * Wald, und darin liegt Totholz. Dunkler als die Weiden, aber noch grün.
     *
     * Die Pilze stehen hier und nirgendwo sonst: sie brauchen Schatten, und
     * der Abschnitt ist der einzige mit dichtem Bestand.
     */
    baeume: {
      dichte: 3.2,
      minGap: 8,
      scale: [0.8, 1.5],
      models: ['tree_pine', 'tree_broad', 'tree_fir'],
      tints: [0x5f9a4a, 0x4f8a3e, 0x437a36],
    },
    boden: {
      dichte: 3.4,
      minGap: 3.6,
      models: ['farn', 'farn', 'bush', 'grass_tuft', 'hochgras'],
      // Satt und dunkel: Waldboden im Schatten.
      tints: [0x4f8a3e, 0x5f9a4a, 0x437a36],
    },
    streu: {
      dichte: 1.6,
      minGap: 4.5,
      models: ['stump', 'mushroom_large', 'mushroom_large', 'baumpilz', 'moosstein'],
    },
    akzent: { dichte: 0.2, minGap: 26, models: ['wurzelstock', 'hohler_stumpf', 'pilzring'] },
  },
  {
    id: 'ufer',
    name: 'Die Uferwiesen',
    z1: 500,
    /*
     * Hier quert die Silberader die Insel. Der Boden ist feucht, das Gras
     * hoch, und die Bäume stehen weiter auseinander.
     *
     * Der Uferstreifen am Fluss selbst wird gesondert bestreut (Schilf,
     * Rohrkolben) — das gilt über die ganze Karte und gehört deshalb nicht in
     * diese Zone, sondern zum Fluss.
     */
    baeume: {
      dichte: 2.0,
      minGap: 10,
      scale: [0.8, 1.4],
      models: ['tree_broad', 'tree_fir', 'tree_pine'],
      tints: [0x4d8f57, 0x59a066, 0x3f7d4c],
    },
    boden: {
      dichte: 3.6,
      minGap: 3.6,
      models: ['hochgras', 'hochgras', 'schilf', 'grass_tuft', 'klee', 'bush'],
      // Kühl ins Blaugrüne: nass, und das sieht man der Farbe an.
      tints: [0x4d8f6a, 0x59a077, 0x3f7d5c, 0x66a882],
    },
    streu: { dichte: 1.2, minGap: 5, models: ['brombeere', 'distel', 'moosstein', 'kiesel'] },
    akzent: { dichte: 0.2, minGap: 28, models: ['bildstock', 'moosstein', 'baumstamm_liegend'] },
  },
  {
    id: 'geroell',
    name: 'Das Geröllfeld',
    z1: 720,
    /*
     * Der Bruch: ab hier steht nichts Grünes mehr aufrecht.
     *
     * Totholz und Fels, Heidekraut am Boden. Die Bäume behalten ihre Farbe
     * nicht — `tree_dead` bringt seine eigene mit, und ein eingefärbter toter
     * Baum sähe aus wie ein kranker lebender.
     */
    baeume: {
      dichte: 2.8,
      minGap: 8,
      scale: [0.8, 1.4],
      models: ['tree_dead', 'tree_dead', 'tree_fir'],
    },
    boden: {
      dichte: 3.0,
      minGap: 4,
      models: ['heidekraut', 'heidekraut', 'dornbusch', 'grass_tuft'],
      // Ausgebleicht ins Braungraue. Hier wächst nichts mehr gern.
      tints: [0x8a8466, 0x9a9070, 0x7a7358, 0x6f6b55],
    },
    streu: { dichte: 2.4, minGap: 4, models: ['geroell', 'felsblock', 'steinmann', 'kiesel'] },
    akzent: { dichte: 0.35, minGap: 24, models: ['erzader', 'crystal', 'kristallgruppe'] },
  },
  {
    id: 'dornsaum',
    name: 'Der Dornsaum',
    z1: LM.zNord,
    /*
     * Vor dem Tor. Kahl, dunkel, und es liegen Knochen herum.
     *
     * Der letzte Abschnitt ist bewusst der ärmste: wer hier steht, soll
     * sehen, dass der Weg zu Ende ist und dahinter etwas anderes anfängt.
     */
    baeume: {
      dichte: 2.5,
      minGap: 7,
      scale: [0.7, 1.2],
      models: ['tree_dead', 'tree_pine'],
      tints: [0x2f4a35, 0x38553c],
    },
    boden: {
      dichte: 2.4,
      minGap: 4,
      models: ['dornbusch', 'dornbusch', 'heidekraut', 'distel'],
      // Fast ohne Farbe. Der letzte Abschnitt vor dem Tor.
      tints: [0x5c5a4a, 0x4a4a3e, 0x6a6552],
    },
    streu: { dichte: 2.0, minGap: 4.5, models: ['geroell', 'schaedel', 'knochenhaufen', 'kiesel'] },
    akzent: { dichte: 0.35, minGap: 22, models: ['runenstein', 'feuerschale', 'knochenhaufen'] },
  },
];

/**
 * Die Wegmarken der Strecke, als Zahlen an einer Stelle.
 *
 * Das Tor, die fünf Lager der Nebenquestgeber. Alles, was dort steht — NPC,
 * Feuer, Zelt, Zaun —, hängt an einer dieser Zahlen und nicht an einer
 * eigenen. Vorher stand jede Lage ausgeschrieben, und beim Strecken der Insel
 * hätte man jede einzeln nachziehen müssen: fünf Lager mal zehn Props, und
 * das eine, das man übersieht, steht danach im Nichts.
 */
const LM_TOR = 784;

/**
 * Wo der Weg den Boden freigelegt hat — 0 heisst Wiese, 1 heisst nackte Erde.
 *
 * Die Laternen stehen seit jeher an einer Linie, aber der Boden darunter war
 * Gras wie überall: eine Reihe Lichter über einer Wiese, und **wo der Weg
 * langgeht**, sah man erst, wenn man die nächste Laterne fand. Die
 * Bodentexturen entscheiden sonst nach Neigung — Erde ab vierundzwanzig Grad
 * —, und ein Weg ist flach. Etwas, das eine Absicht hat und keine Neigung,
 * muss deshalb **gemalt** werden.
 *
 * Er beginnt am Marktplatz, läuft durch das Stadttor und endet am Bannkreis
 * im Norden. An beiden Enden blendet er über zwanzig Meter aus: ein Weg, der
 * mit einer Kante aufhört, sieht aus wie ein abgeschnittenes Band.
 *
 * Die Breite atmet — zwischen gut vier und sieben Metern —, denn ein Pfad mit
 * überall demselben Abstand zur Mitte ist kein Pfad, sondern ein Lineal.
 */
function lichtmoorWeg(x, z) {
  const von = LM.stadtZ - 14;
  /*
   * Sechzehn Meter **über** das Tor hinaus, nicht bis dorthin.
   *
   * Das Ausblenden über zwanzig Meter fängt sonst schon vor dem Bannkreis an,
   * und der Weg wäre genau dort am schwächsten, wo jeder steht: im Tor. So
   * liegt am Kreis noch volle Erde, und was verblasst, liegt dahinter.
   */
  const bis = LM_TOR + 16;
  if (z < von || z > bis) return 0;
  const enden = Math.min(1, (z - von) / 20, (bis - z) / 20);
  const halb = 5.4 + Math.sin(z * 0.05) * 0.7 + Math.sin(z * 0.013) * 1.1;
  // Aussen über vier Meter auslaufen: dort mischt sich Gras dazu, und der
  // Rand liest sich als ausgetreten statt als geschnitten.
  const quer = 1 - glatt((Math.abs(x) - halb) / 4);
  return Math.max(0, Math.min(1, quer * enden));
}

const LM_LAGER = {
  kraeuter: -184,
  hirte: 56,
  faehrmann: 264,
  jaeger: 448,
  kartograf: 632,
};

function lichtmoor() {
  const rng = mulberry32(0x4c49_4d00);
  const size = LM.size;

  // --- NPCs ---------------------------------------------------------------
  //
  // In der Stadt stehen die, die Hauptquests geben — sie stehen dort, wo jeder
  // ohnehin hinkommt. Auf der Strecke nach Norden stehen die Nebenquests, und
  // zwar je in dem Abschnitt, dessen Monster sie schicken: ein Auftrag, für
  // den man zwanzig Einheiten zurücklaufen muss, wird nicht angenommen.
  const npcs = [
    // Silberfurt.
    { id: 'n_guide', def: 'npc_guide', position: [-6, LM.stadtZ + 12], yaw: 2.6 },
    { id: 'n_merchant', def: 'npc_merchant', position: [-19, LM.stadtZ - 4], yaw: 1.4 },
    { id: 'n_smith', def: 'npc_smith', position: [18, LM.stadtZ - 6], yaw: 4.6 },
    { id: 'n_master', def: 'npc_master', position: [-4, LM.stadtZ + 21], yaw: 3.3 },
    { id: 'n_wache_sued', def: 'npc_wache', position: [-7, LM.stadtZ + 46], yaw: 3.14 },
    { id: 'n_wache_ost', def: 'npc_wache', position: [7, LM.stadtZ + 46], yaw: 3.14 },

    /*
     * Unterwegs, von Süden nach Norden.
     *
     * Die Lager unten stehen bei ihnen, und zwar mit **Abständen zu ihrem
     * Standpunkt** statt mit eigenen Zahlen: der Weg ist viermal so lang
     * geworden, und wer ein Lager aus lauter absoluten Lagen streckt,
     * bekommt ein Feuer, das dreissig Meter neben seinem Zelt brennt.
     */
    { id: 'n_kraeuter', def: 'npc_kraeuterfrau', position: [-24, LM_LAGER.kraeuter], yaw: 1.1 },
    { id: 'n_hirte', def: 'npc_hirte', position: [26, LM_LAGER.hirte], yaw: 4.2 },
    { id: 'n_faehrmann', def: 'npc_faehrmann', position: [-12, LM_LAGER.faehrmann], yaw: 0.4 },
    { id: 'n_jaeger', def: 'npc_jaeger', position: [34, LM_LAGER.jaeger], yaw: 3.8 },
    { id: 'n_kartograf', def: 'npc_kartograf', position: [-38, LM_LAGER.kartograf], yaw: 0.9 },
    { id: 'n_gate', def: 'npc_gatekeeper', position: [5, LM_TOR - 8], yaw: 3.14 },
  ];

  const portals = [
    {
      id: 'g_dornwald',
      position: [0, LM_TOR],
      yaw: 0,
      radius: 4,
      label: 'Dornwald',
      // Acht Einheiten vor dem Rueckportal, nicht darin. Genau das war der
      // Fehler: der Zielpunkt lag exakt auf dem Gegentor bei (0, -186), und
      // nach Ablauf der Zeitsperre reiste man automatisch zurueck.
      target: { map: 'dornwald', x: 0, z: DW.torSued + 8, yaw: 0 },
      minLevel: 0,
    },
  ];

  /*
   * --- Die Stufengebiete ---------------------------------------------------
   *
   * Nach Norden wird es härter, und zwar sichtbar in Schritten: jeder
   * Abschnitt hat seine eigene Sorte, und die Stufe steht am Spawner statt in
   * der Monsterdatei. Damit ergibt dieselbe Handvoll Sorten eine Strecke von
   * Stufe eins bis zwanzig, ohne dass es zwanzig Modelle braucht.
   *
   * Kein Spawner liegt im Fluss oder über der Brücke — beides wären Monster,
   * die man nicht erreicht oder die einem den einzigen Übergang verstopfen.
   */
  const spawners = [
    // Stufe 1–3: die Wiese vor der Stadt.
    { id: 's_mote_a', mob: 'mote', position: [-46, -232], radius: 26, count: 8, respawnMs: 60000, level: 1 },
    { id: 's_mote_b', mob: 'mote', position: [40, -200], radius: 24, count: 7, respawnMs: 60000, level: 2 },
    { id: 's_mote_c', mob: 'mote', position: [-14, -88], radius: 26, count: 7, respawnMs: 60000, level: 3 },
    { id: 's_pup_a', mob: 'burrow_pup', position: [58, -80], radius: 24, count: 6, respawnMs: 70000, level: 3 },

    // Stufe 4–7: die Gruben.
    { id: 's_pup_b', mob: 'burrow_pup', position: [-58, 24], radius: 26, count: 7, respawnMs: 70000, level: 4 },
    { id: 's_pup_c', mob: 'burrow_pup', position: [16, 120], radius: 24, count: 6, respawnMs: 70000, level: 5 },
    { id: 's_boar_a', mob: 'thistle_boar', position: [70, 136], radius: 26, count: 5, respawnMs: 75000, level: 6 },
    { id: 's_boar_b', mob: 'thistle_boar', position: [-72, 192], radius: 26, count: 5, respawnMs: 75000, level: 7 },

    // Stufe 8–11: die Uferwiesen.
    { id: 's_boar_c', mob: 'thistle_boar', position: [30, 336], radius: 28, count: 6, respawnMs: 75000, level: 8 },
    { id: 's_bandit_a', mob: 'bandit_scout', position: [-52, 368], radius: 26, count: 5, respawnMs: 80000, level: 9 },
    { id: 's_bandit_b', mob: 'bandit_scout', position: [72, 416], radius: 24, count: 5, respawnMs: 80000, level: 10 },
    { id: 's_bandit_c', mob: 'bandit_scout', position: [-20, 472], radius: 26, count: 6, respawnMs: 80000, level: 11 },

    // Stufe 12–15: das Geröllfeld.
    { id: 's_bandit_d', mob: 'bandit_scout', position: [56, 552], radius: 26, count: 5, respawnMs: 80000, level: 12 },
    { id: 's_crawl_a', mob: 'cave_crawler', position: [-64, 568], radius: 26, count: 5, respawnMs: 85000, level: 13 },
    { id: 's_crawl_b', mob: 'cave_crawler', position: [10, 624], radius: 26, count: 6, respawnMs: 85000, level: 14 },
    { id: 's_crawl_c', mob: 'cave_crawler', position: [-30, 688], radius: 24, count: 5, respawnMs: 85000, level: 15 },

    // Stufe 16–20: vor dem Tor.
    { id: 's_crawl_d', mob: 'cave_crawler', position: [62, 688], radius: 24, count: 5, respawnMs: 85000, level: 16 },
    { id: 's_warden_a', mob: 'dungeon_warden', position: [-72, 760], radius: 22, count: 4, respawnMs: 95000, level: 17 },
    { id: 's_warden_b', mob: 'dungeon_warden', position: [40, 776], radius: 22, count: 4, respawnMs: 95000, level: 18 },
    { id: 's_warden_c', mob: 'dungeon_warden', position: [-34, 800], radius: 20, count: 3, respawnMs: 95000, level: 20 },

    /*
     * --- Die Flügel im Westen und Osten -------------------------------------
     *
     * Die Insel ist mehr als doppelt so breit wie der alte Streifen, und die
     * Felder oben liegen alle in der Mitte: ohne diese hier wären zwei Drittel
     * der Fläche leeres Gras.
     *
     * Die Stufe folgt weiter dem Norden und **nicht** dem Abstand zur Mitte:
     * wer nach Westen ausweicht, soll nicht plötzlich schwereren Gegnern
     * begegnen, sondern denselben wie auf gleicher Höhe. Der Aufbau der Karte
     * ist eine Strecke von Süd nach Nord, und daran ändert die Breite nichts.
     */
    { id: 's_mote_w', mob: 'mote', position: [-207, -296], radius: 30, count: 8, respawnMs: 60000, level: 2 },
    { id: 's_mote_o', mob: 'mote', position: [201, -264], radius: 30, count: 8, respawnMs: 60000, level: 2 },
    { id: 's_mote_sw', mob: 'mote', position: [-96, -640], radius: 30, count: 7, respawnMs: 60000, level: 1 },
    { id: 's_mote_so', mob: 'mote', position: [88, -688], radius: 30, count: 7, respawnMs: 60000, level: 1 },
    { id: 's_pup_w', mob: 'burrow_pup', position: [-226, -40], radius: 30, count: 7, respawnMs: 70000, level: 4 },
    { id: 's_pup_o', mob: 'burrow_pup', position: [220, -72], radius: 30, count: 7, respawnMs: 70000, level: 4 },
    { id: 's_pup_o2', mob: 'burrow_pup', position: [169, 96], radius: 28, count: 6, respawnMs: 70000, level: 5 },
    { id: 's_boar_w', mob: 'thistle_boar', position: [-190, 176], radius: 30, count: 6, respawnMs: 75000, level: 7 },
    { id: 's_boar_o', mob: 'thistle_boar', position: [212, 232], radius: 30, count: 6, respawnMs: 75000, level: 7 },
    { id: 's_boar_w2', mob: 'thistle_boar', position: [-239, 384], radius: 28, count: 5, respawnMs: 75000, level: 8 },
    { id: 's_bandit_w', mob: 'bandit_scout', position: [-177, 512], radius: 30, count: 6, respawnMs: 80000, level: 10 },
    { id: 's_bandit_o', mob: 'bandit_scout', position: [188, 480], radius: 30, count: 6, respawnMs: 80000, level: 10 },
    { id: 's_bandit_o2', mob: 'bandit_scout', position: [237, 648], radius: 28, count: 5, respawnMs: 80000, level: 12 },
    { id: 's_crawl_w', mob: 'cave_crawler', position: [-215, 712], radius: 28, count: 5, respawnMs: 85000, level: 14 },
    { id: 's_crawl_o', mob: 'cave_crawler', position: [174, 784], radius: 28, count: 5, respawnMs: 85000, level: 15 },
    { id: 's_warden_w', mob: 'dungeon_warden', position: [-163, 896], radius: 24, count: 4, respawnMs: 95000, level: 18 },
    { id: 's_warden_o', mob: 'dungeon_warden', position: [96, 904], radius: 24, count: 4, respawnMs: 95000, level: 19 },

    /*
     * --- Die Felder der neuen Länge -----------------------------------------
     *
     * Die Strecke ist von vierhundertsechzig auf achtzehnhundertvierzig Meter
     * gewachsen; die Felder oben sind mitgewandert, aber nicht mehr geworden.
     * Zwischen zweien lagen damit stellenweise zweihundert Meter, auf denen
     * nichts stand — und eine leere Strecke ist beim Laufen dasselbe wie ein
     * Flur.
     *
     * Die Stufe folgt weiter dem Norden: dieselbe Höhe heisst dieselbe Stufe,
     * egal ob man in der Mitte läuft oder am Rand.
     */
    { id: 's_mote_d', mob: 'mote', position: [-120, -700], radius: 30, count: 7, respawnMs: 60000, level: 1 },
    { id: 's_mote_e', mob: 'mote', position: [110, -640], radius: 30, count: 7, respawnMs: 60000, level: 1 },
    { id: 's_mote_f', mob: 'mote', position: [-90, -380], radius: 28, count: 7, respawnMs: 60000, level: 2 },
    { id: 's_pup_d', mob: 'burrow_pup', position: [130, -300], radius: 28, count: 6, respawnMs: 70000, level: 3 },
    { id: 's_pup_e', mob: 'burrow_pup', position: [-150, -40], radius: 28, count: 6, respawnMs: 70000, level: 4 },
    { id: 's_boar_d', mob: 'thistle_boar', position: [90, 60], radius: 28, count: 5, respawnMs: 75000, level: 6 },
    { id: 's_boar_e', mob: 'thistle_boar', position: [-110, 270], radius: 28, count: 5, respawnMs: 75000, level: 8 },
    { id: 's_bandit_e', mob: 'bandit_scout', position: [60, 420], radius: 28, count: 5, respawnMs: 80000, level: 10 },
    { id: 's_bandit_f', mob: 'bandit_scout', position: [-180, 460], radius: 28, count: 5, respawnMs: 80000, level: 11 },
    { id: 's_crawl_e', mob: 'cave_crawler', position: [150, 540], radius: 28, count: 5, respawnMs: 85000, level: 13 },
    { id: 's_crawl_f', mob: 'cave_crawler', position: [-100, 620], radius: 28, count: 5, respawnMs: 85000, level: 15 },
    { id: 's_warden_d', mob: 'dungeon_warden', position: [170, 740], radius: 24, count: 4, respawnMs: 95000, level: 18 },
    { id: 's_warden_e', mob: 'dungeon_warden', position: [-190, 860], radius: 24, count: 4, respawnMs: 95000, level: 19 },

    /*
     * --- Die Felder der neuen Breite ---------------------------------------
     *
     * Jenseits von dreihundert Metern lag sonst nichts als Gras. Die Stufe
     * folgt weiter dem **Norden**: wer nach Westen ausweicht, trifft dieselben
     * Gegner wie auf gleicher Höhe in der Mitte — sonst wäre die Breite eine
     * zweite Schwierigkeitsachse, und man müsste sie kennen, um zu überleben.
     */
    { id: 's_mote_wf', mob: 'mote', position: [-420, -720], radius: 30, count: 6, respawnMs: 60000, level: 1 },
    { id: 's_mote_of', mob: 'mote', position: [440, -600], radius: 30, count: 6, respawnMs: 60000, level: 1 },
    { id: 's_pup_wf', mob: 'burrow_pup', position: [-480, -360], radius: 30, count: 6, respawnMs: 70000, level: 3 },
    { id: 's_pup_of', mob: 'burrow_pup', position: [420, -200], radius: 30, count: 6, respawnMs: 70000, level: 4 },
    { id: 's_boar_wf', mob: 'thistle_boar', position: [-380, 40], radius: 30, count: 5, respawnMs: 75000, level: 6 },
    { id: 's_boar_of', mob: 'thistle_boar', position: [460, 160], radius: 30, count: 5, respawnMs: 75000, level: 7 },
    { id: 's_bandit_wf', mob: 'bandit_scout', position: [-500, 340], radius: 30, count: 5, respawnMs: 80000, level: 9 },
    { id: 's_bandit_of', mob: 'bandit_scout', position: [400, 480], radius: 30, count: 5, respawnMs: 80000, level: 11 },
    { id: 's_crawl_wf', mob: 'cave_crawler', position: [-420, 620], radius: 28, count: 5, respawnMs: 85000, level: 15 },
    { id: 's_warden_of', mob: 'dungeon_warden', position: [480, 800], radius: 24, count: 4, respawnMs: 95000, level: 19 },
  ];

  /*
   * --- Silberfurt ---------------------------------------------------------
   *
   * Eine Stadt und kein Dorf: Ringmauer aus Stein mit einem Durchlass nach
   * Norden, ein Marktplatz mit Brunnen in der Mitte, Handwerk im Osten, Lager
   * im Westen. Alles von Hand gesetzt — der Streuer macht Natur, und Natur
   * sieht nie nach Absicht aus.
   */
  const cz = LM.stadtZ;
  const mauerHalb = LM.stadtR;
  const stadt = [
    // Ringmauer, im Norden für das Tor unterbrochen.
    ...fenceRun('fence_stone', [-mauerHalb, cz - mauerHalb], [mauerHalb, cz - mauerHalb]),
    ...fenceRun('fence_stone', [mauerHalb, cz - mauerHalb], [mauerHalb, cz + mauerHalb]),
    ...fenceRun('fence_stone', [-mauerHalb, cz + mauerHalb], [-mauerHalb, cz - mauerHalb]),
    ...fenceRun('fence_stone', [-mauerHalb, cz + mauerHalb], [-11, cz + mauerHalb]),
    ...fenceRun('fence_stone', [11, cz + mauerHalb], [mauerHalb, cz + mauerHalb]),

    // Das Stadttor: zwei Säulen, zwei Banner, zwei Laternen.
    place('pillar', -11, cz + mauerHalb),
    place('pillar', 11, cz + mauerHalb),
    place('banner', -13.5, cz + mauerHalb + 2, { yaw: 3.14 }),
    place('banner', 13.5, cz + mauerHalb + 2, { yaw: 3.14 }),
    place('lantern_post', -14, cz + mauerHalb - 3),
    place('lantern_post', 14, cz + mauerHalb - 3),

    /*
     * Der Marktplatz.
     *
     * Ein Platz ist erst einer, wenn er einen **Mittelpunkt** hat und drumherum
     * Betrieb. Der Zierbrunnen ist die Mitte, der alte Ziehbrunnen steht
     * daneben weiter (er war zuerst da), und die Stände stehen im Halbkreis
     * darum — nicht in einer Reihe: eine Reihe liest sich als Zaun.
     */
    place('zierbrunnen', 0, cz),
    place('well', -14, cz + 6),
    /*
     * Die Statue steht **südlich** des Brunnens und nicht nördlich davon.
     *
     * Nördlich stand sie zwei Meter neben dem Startpunkt der Karte (0, −106),
     * und weil sie einen Kollisionskreis hat, erschien man beim ersten
     * Betreten im Sockel. Der Punkt, an dem jeder Spieler auftaucht, muss frei
     * bleiben — `props_test.ts` prüft das jetzt für alle drei Karten.
     */
    place('statue', 0, cz - 14),
    place('marktstand', -8, cz - 6, { yaw: 0.5 }),
    place('marktstand', 8, cz - 5, { yaw: 5.7 }),
    place('marktstand', 11, cz + 6, { yaw: 4.4 }),
    place('markttisch', -11, cz - 2, { yaw: 1.4 }),
    place('markttisch', 6, cz + 10, { yaw: 2.8 }),
    place('korb', -9.6, cz - 4.4, { yaw: 0.3 }),
    place('korb', -10.4, cz - 3.2, { yaw: 1.9, scale: 0.85 }),
    place('korb', 9.4, cz - 3.6, { yaw: 2.6 }),
    place('sackstapel', 12.4, cz + 4.2, { yaw: 0.7 }),
    place('tonkrug', -12.6, cz - 1.0, { yaw: 0.4 }),
    place('tonkrug', 7.4, cz + 11.4, { yaw: 2.1, scale: 0.9 }),
    place('bank', -5, cz + 9, { yaw: 0.2 }),
    place('bank', 5, cz + 9, { yaw: 2.9 }),
    place('bank', -13, cz + 12, { yaw: 1.5 }),
    place('handkarre', 14, cz - 1, { yaw: 1.2 }),
    place('signpost', 4, cz + 8, { yaw: 0.5 }),
    place('brazier', -7, cz - 7),
    place('brazier', 7, cz - 7),
    place('banner', -4.5, cz + 3, { yaw: 0.3 }),
    place('banner', 4.5, cz + 3, { yaw: 5.9 }),
    place('lantern_post', -10, cz + 10),
    place('lantern_post', 10, cz + 10),
    place('lantern_post', -10, cz - 10),
    place('lantern_post', 10, cz - 10),

    /*
     * Handwerkerviertel im Osten: die Schmiede.
     *
     * Esse, Amboss und Schleifstein stehen **beieinander** und in dieser
     * Reihenfolge — so arbeitet ein Schmied, und so liest man es auch ohne
     * Beschriftung. Das Holz und der Hackklotz liegen daneben, der Trog
     * dazwischen: er kühlt das Eisen.
     */
    ...fenceRun('fence_stone', [13, cz - 12], [26, cz - 12]),
    place('esse', 21, cz - 9.5, { yaw: 3.1 }),
    place('amboss', 21.4, cz - 6.6, { yaw: 0.6 }),
    place('schleifstein', 24.2, cz - 7.4, { yaw: 1.2 }),
    place('wassertrog', 18.2, cz - 6.2, { yaw: 1.6 }),
    place('holzstapel', 25.6, cz - 10.4, { yaw: 0.2 }),
    place('hackklotz', 17, cz - 9.8),
    place('barrel', 20.6, cz - 3.4, { yaw: 0.7 }),
    place('barrel', 22.4, cz - 2.2, { yaw: 2.4 }),
    place('crate', 19.2, cz - 10.2, { yaw: 0.9 }),
    place('kistenstapel', 24.4, cz - 3.4, { yaw: 2.1 }),
    place('brazier', 26, cz - 8),
    place('lantern_post', 28, cz + 2),
    place('fackel', 19, cz - 12.6),
    place('fackel', 24, cz - 12.6),

    // Lagerhof im Westen: die Händlerin.
    ...fenceRect('fence_wood', -24, cz - 2, 9, 8),
    place('crate', -21.5, cz + 2.5, { yaw: 0.5 }),
    place('crate', -25.4, cz + 3.6, { yaw: 1.2, scale: 0.85 }),
    place('barrel', -27.8, cz - 1.2, { yaw: 0.2 }),
    place('barrel', -22.2, cz - 3.6, { yaw: 1.1 }),
    place('hay_bale', -28, cz - 6, { yaw: 0.3 }),
    place('lantern_post', -30, cz + 6),
    place('planwagen', -19, cz - 6, { yaw: 1.5 }),
    place('sackstapel', -25.8, cz + 5.4, { yaw: 1.8 }),
    place('sackstapel', -23.4, cz - 5.2, { yaw: 0.4, scale: 0.9 }),
    place('kistenstapel', -28.6, cz + 1.4, { yaw: 0.6 }),
    place('waescheleine', -32, cz - 10, { yaw: 0.4 }),
    place('taubenschlag', -34, cz + 12),
    place('huehnerstall', -30, cz + 16, { yaw: 2.4 }),
    place('bienenkorb', -33.5, cz + 20, { yaw: 0.5 }),
    place('bienenkorb', -31.8, cz + 21.4, { yaw: 2.1, scale: 0.9 }),
    place('blumenkasten', -20, cz + 9, { yaw: 0.1 }),
    place('blumenkasten', -16, cz + 12, { yaw: 1.6 }),

    /*
     * Der Anger im Südwesten: Gemüse, Pflug, ein Feld.
     *
     * Eine Stadt, die nur aus Handwerk besteht, hat nichts zu essen. Das Feld
     * ist der Grund, warum Silberfurt dort liegt, wo es liegt.
     */
    ...reihe('getreide', [-38, cz - 20], [-16, cz - 20], 2.4),
    ...reihe('getreide', [-38, cz - 24], [-16, cz - 24], 2.4),
    ...reihe('getreide', [-36, cz - 28], [-18, cz - 28], 2.4),
    place('pflug', -14, cz - 24, { yaw: 0.3 }),
    place('hay_bale', -40, cz - 22, { yaw: 1.1 }),
    place('wagenrad', -12, cz - 20, { yaw: 0.8 }),

    // Der Übungsplatz beim Kampfmeister, im Norden der Stadt. Er selbst steht
    // **neben** dem Zaun und nicht darin: wer ihn ansprechen will, klickt sonst
    // auf ein Zaunfeld, und der Klick geht ins Holz statt zum Meister.
    ...fenceRect('fence_wood', 12, cz + 22, 8, 6),
    place('hay_bale', 9, cz + 20, { yaw: 1.4 }),
    place('hay_bale', 15, cz + 24, { yaw: 2.8 }),
    place('crate', 17.5, cz + 19, { yaw: 0.4 }),

    // Der Übungsplatz braucht Ziele und einen Ständer für die Waffen.
    place('waffenstaender', 6, cz + 20, { yaw: 1.6 }),
    place('bank', 8, cz + 27, { yaw: 3.0 }),

    // Ein Hain am Südrand, damit die Mauer nicht nackt in der Landschaft steht.
    place('tree_broad', -34, cz - 34, { scale: 1.3 }),
    place('tree_broad', -26, cz - 40, { scale: 1.1 }),
    place('tree_pine', 30, cz - 36, { scale: 1.2 }),
    place('tree_pine', 38, cz - 30, { scale: 1.35 }),
    place('tree_fir', 34, cz - 42, { scale: 1.1 }),
    place('bush', -20, cz - 42, { scale: 1.2 }),
    place('bush', 22, cz - 44, { scale: 1.1 }),
    place('blume_weiss', -18, cz - 38, { scale: 1.2 }),
    place('blume_gelb', 24, cz - 40),
    place('farn', -30, cz - 36, { scale: 1.3 }),

    // Vor den Toren: zwei Pfosten, ein Bildstock, ein Meilenstein. Wer die
    // Stadt verlässt, geht an einem Zeichen vorbei.
    place('torpfosten', -13, cz + mauerHalb + 6),
    place('torpfosten', 13, cz + mauerHalb + 6),
    place('bildstock', -17, cz + mauerHalb + 12, { yaw: 0.6 }),
    place('meilenstein', 4.5, cz + mauerHalb + 16, { yaw: 0.2 }),
  ];

  /*
   * --- Die Strasse nach Norden --------------------------------------------
   *
   * Von der Stadt bis zum Tor, mit Laternen, einem Wegweiser je Abschnitt und
   * einer Brücke über die Silberader. Sie ist die einzige Strecke, die jeder
   * geht — was auf ihr steht, sieht jeder, und was nicht auf ihr steht, sieht
   * nur, wer sucht.
   */
  // Wo der Fluss die Strasse kreuzt, steht eine Brücke — gefunden und nicht
  // festgelegt, siehe `brueckenStellen`.
  const bruecken = brueckenStellen(cz + LM.stadtR, LM.zNord - 12);
  const brueckenbau = bruecken.flatMap((b) => [
    ...fenceRun('fence_stone', [-8, b - 7], [-8, b + 7]),
    ...fenceRun('fence_stone', [8, b - 7], [8, b + 7]),
    place('pillar', -9, b - 8, { scale: 0.8 }),
    place('pillar', 9, b - 8, { scale: 0.8 }),
    place('pillar', -9, b + 8, { scale: 0.8 }),
    place('pillar', 9, b + 8, { scale: 0.8 }),
    place('lantern_post', -9, b),
    place('lantern_post', 9, b),
  ]);

  /*
   * Die Zeichen am Weg — gerechnet und nicht abgeschrieben.
   *
   * Der Weg von der Stadt zum Tor ist zwölfhundert Einheiten lang. Wer da
   * jedes Zeichen einzeln hinschreibt, schreibt vierzig Zeilen und zieht beim
   * nächsten Verschieben vierzig Zeilen nach. Gefragt ist ohnehin keine
   * einzelne Lage, sondern ein **Abstand**: alle achtzig Meter etwas, das
   * sagt „du kommst voran", und dazwischen nichts.
   *
   * Die Seite wechselt, damit die Strasse nicht wie ein Spalier aussieht,
   * und alles steht mindestens viereinhalb Meter neben der Fahrbahn: ein
   * Hindernis auf der einzigen Strecke ist die Sorte Fehler, um die jeder
   * zweimal am Tag herumläuft.
   */
  const wegVon = cz + mauerHalb + 20;
  const wegBis = LM_TOR - 30;
  const wegZeichen = [];
  for (let i = 0, z = wegVon; z <= wegBis; z += 80, i++) {
    const rechts = i % 2 === 0;
    const seite = rechts ? 1 : -1;
    const yaw = rechts ? 0.3 : 2.9;
    // Vier Sorten im Wechsel: Meilenstein, Bank, Bildstock, Wegweiser. Der
    // Wegweiser ist der seltenste — er markiert, und was ständig markiert,
    // markiert nichts.
    const was = ['meilenstein', 'bank', 'bildstock', 'meilenstein', 'signpost', 'bank'][i % 6];
    wegZeichen.push(place(was, seite * (was === 'signpost' ? 5.5 : 4.8), round(z), { yaw }));
  }

  const strasse = [
    ...lanternRoad([0, cz + mauerHalb + 6], [0, LM_TOR - 10], { abstand: 26, seite: 6.5 }),
    ...wegZeichen,

    // Ein liegen gebliebener Karren am Wegrand, halb im Gras.
    place('handkarre', -8.5, 48, { yaw: 2.2 }),
    place('planwagen', 9.5, 288, { yaw: 1.4 }),

    // Die Brücken über die Silberader. Zwei Geländer und vier Pfeiler je
    // Übergang — mehr braucht es nicht, damit man sieht, wo man hinüberkommt.
    ...brueckenbau,

    // Das Tor nach Dornwald: ein Grenzposten und kein Kreis im Gras.
    ...fenceRun('fence_stone', [-16, LM_TOR - 6], [-6, LM_TOR - 6]),
    ...fenceRun('fence_stone', [6, LM_TOR - 6], [16, LM_TOR - 6]),
    place('banner', -7.5, LM_TOR - 4.5, { yaw: 3.14 }),
    place('banner', 7.5, LM_TOR - 4.5, { yaw: 3.14 }),
    place('brazier', -12, LM_TOR - 10),
    place('brazier', 12, LM_TOR - 10),
  ];

  /*
   * --- Die Lager der Nebenquestgeber --------------------------------------
   *
   * Wer draussen steht, steht nicht im Nichts: ein Feuer, eine Kiste, ein
   * Zaunstück. Ohne das sieht ein NPC auf der Wiese aus, als sei er verloren
   * gegangen.
   */
  const lager = [
    /*
     * Kräuterfrau — sie sammelt, also liegt bei ihr, was sie sammelt.
     *
     * Alle Lager rechnen mit einem **Abstand zu ihrem NPC** (`LM_LAGER`) statt
     * mit eigenen Zahlen. Vorher stand jede Lage ausgeschrieben; beim Strecken
     * der Insel wäre aus jedem Lager eine über hundert Meter verteilte
     * Ansammlung geworden, deren Feuer neben niemandem mehr brennt.
     */
    place('lagerfeuer', -21, LM_LAGER.kraeuter - 3),
    place('crate', -27, LM_LAGER.kraeuter + 2, { yaw: 0.8 }),
    place('markttisch', -24, LM_LAGER.kraeuter, { yaw: 0.9 }),
    place('korb', -25.6, LM_LAGER.kraeuter + 2.8, { yaw: 1.4 }),
    place('korb', -22.4, LM_LAGER.kraeuter + 3.6, { yaw: 0.2, scale: 0.85 }),
    place('mushroom_large', -29, LM_LAGER.kraeuter - 4, { scale: 1.2 }),
    place('mushroom_large', -19, LM_LAGER.kraeuter - 8, { scale: 0.9 }),
    place('pilzring', -31, LM_LAGER.kraeuter + 2),
    place('farn', -30, LM_LAGER.kraeuter - 8, { scale: 1.3 }),
    place('farn', -17, LM_LAGER.kraeuter - 1, { scale: 1.1 }),
    place('blume_blau', -26, LM_LAGER.kraeuter - 7),
    place('blume_weiss', -20, LM_LAGER.kraeuter + 4),

    /*
     * Hirte — Gehege, Futter, Wasser. Der Trog ist der Unterschied zwischen
     * einem Zaun und einer Weide.
     */
    ...fenceRect('fence_wood', 30, LM_LAGER.hirte + 2, 10, 7),
    place('hay_bale', 27, LM_LAGER.hirte - 2, { yaw: 0.6 }),
    place('hay_bale', 33, LM_LAGER.hirte + 6, { yaw: 2.2 }),
    place('wassertrog', 24, LM_LAGER.hirte + 4, { yaw: 1.6 }),
    place('huehnerstall', 36, LM_LAGER.hirte - 4, { yaw: 3.4 }),
    place('hocker', 29, LM_LAGER.hirte + 10, { yaw: 0.5 }),
    place('klee', 31, LM_LAGER.hirte, { scale: 1.3 }),
    place('klee', 27, LM_LAGER.hirte + 5, { scale: 1.1 }),

    /*
     * Fährmann am Ufer.
     *
     * Zwei Stege ins Wasser, ein Boot daneben, Netz und Fischgestell an Land.
     * Der Steg zeigt in den Fluss (`drehung`), nicht am Ufer entlang — sonst
     * ist er ein Holzweg neben dem Wasser.
     */
    ...reihe('steg', [-13, LM_LAGER.faehrmann], [-13, LM_LAGER.faehrmann + 12], 4, {
      drehung: Math.PI / 2,
    }),
    place('ruderboot', -17, LM_LAGER.faehrmann + 8, { yaw: 1.4 }),
    place('fischgestell', -18, LM_LAGER.faehrmann - 2, { yaw: 0.7 }),
    place('fischernetz', -9, LM_LAGER.faehrmann, { yaw: 2.4 }),
    place('barrel', -15, LM_LAGER.faehrmann - 4, { yaw: 0.4 }),
    place('crate', -9, LM_LAGER.faehrmann - 4, { yaw: 1.6 }),
    place('lantern_post', -14, LM_LAGER.faehrmann + 4),
    place('schilf', -20, LM_LAGER.faehrmann + 4, { scale: 1.2 }),
    place('rohrkolben', -8, LM_LAGER.faehrmann + 6, { scale: 1.1 }),

    /*
     * Jäger — ein Lager, kein Haus: Zelt, Feuer, Spiess, Schlafrolle.
     */
    place('zelt', 33, LM_LAGER.jaeger - 2, { yaw: 0.7 }),
    place('lagerfeuer', 31, LM_LAGER.jaeger - 4),
    place('bratspiess', 31, LM_LAGER.jaeger - 4, { yaw: 1.2 }),
    place('schlafrolle', 35, LM_LAGER.jaeger - 6, { yaw: 0.9 }),
    place('waffenstaender', 29, LM_LAGER.jaeger, { yaw: 2.6 }),
    place('tree_dead', 39, LM_LAGER.jaeger + 4, { scale: 1.2 }),
    place('crate', 37, LM_LAGER.jaeger - 6, { yaw: 2.4 }),
    place('knochenhaufen', 40, LM_LAGER.jaeger - 4, { yaw: 0.4 }),
    place('fischgestell', 27, LM_LAGER.jaeger - 7, { yaw: 1.9 }),

    /*
     * Kartograf — er misst und zeichnet, also steht bei ihm ein Tisch, und
     * neben dem Zelt ein Steinmann als Vermessungszeichen.
     */
    place('zelt', -37, LM_LAGER.kartograf - 2, { yaw: 2.2 }),
    place('lagerfeuer', -35, LM_LAGER.kartograf - 4),
    place('markttisch', -33, LM_LAGER.kartograf, { yaw: 0.4 }),
    place('hocker', -31, LM_LAGER.kartograf + 2, { yaw: 1.1 }),
    place('steinmann', -44, LM_LAGER.kartograf - 2),
    place('signpost', -42, LM_LAGER.kartograf + 2, { yaw: 1.6 }),
    place('crate', -41, LM_LAGER.kartograf - 6, { yaw: 0.9 }),
    place('schlafrolle', -39, LM_LAGER.kartograf - 6, { yaw: 2.2 }),
  ];

  /*
   * --- Die Schwebenden Steine ---------------------------------------------
   *
   * Riesige Felsen in der Luft, oben eine Wiese. Hinauf kommt nur, wer ein
   * Fluggerät hat — und wer oben absteigt, steht darauf, statt hindurchzufallen
   * (`collision: 'plattform'`, siehe Kartenformat).
   *
   * Der Ursprung des Modells liegt **in** der begehbaren Fläche. Deshalb ist
   * `position[1]` genau deren Höhe, `snapToGround` ist aus, und der Radius der
   * Scheibe steht in `collisionRadius` — dieselbe Zahl, mit der das Modell
   * gebaut wird.
   */
  const schwebfels = (x, y, z, gross = true) => ({
    model: gross ? 'fels_schwebend' : 'fels_schwebend_klein',
    position: [round(x), round(y), round(z)],
    rotation: [0, round(rng() * Math.PI * 2), 0],
    scale: 1,
    snapToGround: false,
    ...kollision(gross ? 'fels_schwebend' : 'fels_schwebend_klein'),
  });

  const schweber = [
    // Eine Treppe aus Steinen über der Wiese: von niedrig nach hoch, damit man
    // sie auch mit dem langsamen Besen erreicht.
    schwebfels(-46, 26, -32, false),
    schwebfels(-58, 34, 72),
    schwebfels(-40, 42, 176, false),
    // Ein Paar über dem Fluss — von dort sieht man die Silberader entlang.
    schwebfels(24, 30, 296),
    schwebfels(44, 38, 384, false),
    // Und drei hohe im Norden, über dem Geröll.
    schwebfels(-24, 46, 552),
    schwebfels(52, 52, 632, false),
    schwebfels(6, 58, 728),
    /*
     * Und eine zweite Treppe im Süden.
     *
     * Die erste fängt erst hinter der Stadt an; auf der neuen Länge liegen
     * zwischen Südküste und ihrem ersten Stein sechshundert Meter, in denen
     * kein einziger Felsen in der Luft steht. Wer dort ein Fluggerät bekommt,
     * soll nicht erst eine Minute nach Norden fliegen, um etwas zum Landen zu
     * finden.
     */
    schwebfels(-120, 24, -700, false),
    schwebfels(-96, 32, -620),
    schwebfels(140, 28, -560, false),
    schwebfels(118, 40, -300),
    schwebfels(-150, 36, -240, false),
    // Und welche weit draussen an den Flanken, als Ziel für einen Umweg.
    schwebfels(-230, 44, 240),
    schwebfels(238, 50, 480, false),
    schwebfels(-210, 56, 820),
    schwebfels(-470, 40, -400),
    schwebfels(450, 48, -80, false),
    schwebfels(-520, 54, 380),
    schwebfels(500, 60, 700, false),
  ];

  const gesetzt = [...stadt, ...strasse, ...lager];

  const keepOut = [
    { x: 0, z: cz + 4, r: 40 },
    ...npcs.map((n) => ({ x: n.position[0], z: n.position[1], r: 8 })),
    ...portals.map((p) => ({ x: p.position[0], z: p.position[1], r: 14 })),
    ...spawners.map((s) => ({ x: s.position[0], z: s.position[1], r: s.radius * 0.4 })),
    ...keepOutOf(gesetzt, 4),
    /*
     * Die Strasse bleibt frei. Ein Baum mitten auf dem Weg ist kein Wald,
     * sondern ein Hindernis, um das jeder zweimal am Tag herumläuft.
     *
     * Der Streifen reicht vom Stadttor bis zum Tor im Norden und rechnet seine
     * Länge aus beidem, statt sie als Stückzahl danebenzuschreiben. Hier stand
     * `length: 40` — vierzig Kreise im Abstand von sieben Metern, also
     * zweihundertachtzig Meter. Das deckte die alte Strasse; auf der neuen
     * hörte der Schutz nach einem Viertel des Weges auf, und der Rest der
     * Strecke wäre zugewachsen.
     */
    ...Array.from({ length: Math.ceil((LM_TOR - (cz + LM.stadtR)) / 7) + 1 }, (_, i) => ({
      x: 0,
      z: cz + LM.stadtR + i * 7,
      r: 7,
    })),
  ];

  /**
   * Auf der Insel, nicht im Fluss und nicht in der Stadt.
   *
   * `ausserhalb(x, z) < -14` statt eines Rechtecks: die Küste wandert um bis
   * zu fünfundzwanzig Meter, und ein festes Rechteck setzte in jeder Bucht
   * Bäume auf die Klippe oder ins Wasser. Vierzehn Meter Abstand halten sie
   * von der Kante fern — dort ist der Hang schon zu steil, um darauf zu
   * stehen.
   */
  const frei = (x, z) =>
    ausserhalb(x, z) < -14 &&
    flussAbstand(x, z) > 15 &&
    Math.hypot(x, z - cz) > LM.stadtR + 10;

  /**
   * Der Bewuchs einer Zone — Bäume, Boden, Akzent.
   *
   * Der Streifen läuft über die **ganze** Breite der Insel; wo genau er
   * aufhört, entscheidet `frei` und damit die Küste. Ein Rechteck wüsste
   * nichts von den Buchten.
   */
  /**
   * Der Bewuchs einer Zone — Bäume, Boden, Streu, Akzent.
   *
   * In **zwei Bändern** und nicht in einem: die Insel ist zwölfhundert Meter
   * breit, und die Strasse läuft in der Mitte. Am Weg soll es aussehen wie
   * bisher; draussen an den Flanken, wo niemand vorbeikommt, ohne es zu
   * wollen, steht die Hälfte.
   *
   * Das ist nicht nur Sparsamkeit, sondern Landschaft: ein Wald, der über
   * einen Kilometer gleich dicht steht, sieht gemalt aus. Und es ist eine
   * Rechnung — mit der Dichte des Weges über die ganze Breite stünden
   * zweiundzwanzigtausend Props auf der Karte, achttausend davon mit
   * Kollisionskreis, durch die der Server in jedem Schritt für jedes Monster
   * hindurchrechnet.
   *
   * Der Streifen läuft über die **ganze** Breite der Insel; wo genau er
   * aufhört, entscheidet `frei` und damit die Küste. Ein Rechteck wüsste
   * nichts von den Buchten.
   */
  /** Halbe Breite des Bandes am Weg. Draussen gilt `FLANKE_DICHTE`. */
  const KORRIDOR = 300;
  const FLANKE_DICHTE = 0.5;
  const zonenBewuchs = (zone, z0) => {
    /*
     * Die Fläche eines Bandes, in tausend Quadratmetern.
     *
     * Roh gerechnet, ohne Abzug für Fluss, Stadt und Küste: was dort
     * hineinfiele, verwirft `frei` ohnehin. Ein genauer Flächeninhalt wäre ein
     * Integral über eine Küstenlinie aus vier Sinuskurven — für eine Zahl, die
     * am Ende „so viel Gras ungefähr" bedeutet.
     */
    const flaeche = (breite) => ((zone.z1 - z0) * breite) / 1000;
    const streuung = (satz, bereich, dichte, extra = {}) =>
      satz
        ? scatter(rng, {
            count: Math.round(satz.dichte * dichte),
            size,
            bereich,
            erlaubt: frei,
            minGap: satz.minGap,
            scaleRange: satz.scale ?? [0.7, 1.4],
            models: satz.models.map((key) => ({ key })),
            tints: satz.tints,
            keepOut,
            ...extra,
          })
        : [];
    const mitte = { x0: -KORRIDOR, x1: KORRIDOR, z0, z1: zone.z1 };
    const west = { x0: -LM.x, x1: -KORRIDOR, z0, z1: zone.z1 };
    const ost = { x0: KORRIDOR, x1: LM.x, z0, z1: zone.z1 };
    const flankenFlaeche = flaeche(LM.x - KORRIDOR) * FLANKE_DICHTE;
    const teil = (satz, extra = {}) => [
      ...streuung(satz, mitte, flaeche(KORRIDOR * 2), extra),
      ...streuung(satz, west, flankenFlaeche, extra),
      ...streuung(satz, ost, flankenFlaeche, extra),
    ];
    const nah = { keepOut: keepOut.map((k) => ({ ...k, r: k.r * 0.5 })) };
    return [
      ...teil(zone.baeume),
      // Der Boden hält weniger Abstand zu NPCs und Spawnern als ein Baum: ein
      // Grasbüschel neben einem Händler stört niemanden, eine Fichte schon.
      ...teil(zone.boden, nah),
      ...teil(zone.streu, nah),
      ...teil(zone.akzent),
    ];
  };

  /**
   * Eine sichtbare Grenze quer über die Insel.
   *
   * Steine im Abstand von gut zwanzig Metern — weit genug, dass man mühelos
   * hindurchgeht, dicht genug, dass man die Reihe als Reihe liest. Das ist
   * der Unterschied zwischen einer Grenze und einer Mauer, und er ist hier
   * Absicht: die Zonen sind eine Auskunft und keine Sperre.
   *
   * Am Weg bei x = 0 steht ein Wegweiser mit zwei Fackeln. Wer der Strasse
   * folgt — und das tun die meisten —, kommt genau dort vorbei.
   */
  const zonenGrenze = (z, akzent) => {
    const stuecke = [];
    let i = 0;
    for (let x = -LM.x + 10; x <= LM.x - 10; x += 18, i++) {
      // Ein Versatz in `z`, damit die Reihe nicht wie mit dem Lineal gezogen
      // aussieht. Drei Meter reichen: die Reihe bleibt lesbar, die gerade
      // Linie ist weg.
      const zz = z + Math.sin(x * 0.07) * 3;
      if (!frei(x, zz)) continue;
      /*
       * Jeder zweite ein Hinkelstein — der ist über drei Meter hoch und damit
       * das, was man von weitem sieht. Gezählt und nicht gerechnet: hier stand
       * einmal `x % 42 === 0`, und weil `x` in Schritten von einundzwanzig
       * läuft und bei einer krummen Zahl anfängt, war die Bedingung fast nie
       * wahr. Aus der Reihe wurden lauter kniehohe Steine, die niemand sah.
       */
      const hoch = i % 2 === 0;
      stuecke.push(
        place(hoch ? 'hinkelstein' : akzent, x, zz, {
          yaw: round(rng() * Math.PI * 2),
          scale: round((hoch ? 1.1 : 0.9) + rng() * 0.4),
        }),
      );
    }
    // Und am Weg: der Wegweiser steht neben der Strasse, nicht darauf.
    stuecke.push(
      place('signpost', 6, z, { yaw: 3.14 }),
      place('fackel', -6, z - 2, {}),
      place('fackel', -6, z + 2, {}),
    );
    return stuecke;
  };

  /** Nördlich der Stadt — dort, wo Fels und Totholz liegen. */
  const wiese = { x0: -LM.x, x1: LM.x, z0: -296, z1: LM.zNord };

  const props = [
    ...gesetzt,
    ...schweber,

    /*
     * --- Bewuchs, Zone für Zone ------------------------------------------
     *
     * Vorher standen hier drei Streuungen mit weichen Übergängen: Wald über
     * die halbe Karte, Süden etwas heller, Totholz ab z = 118. Das ergab
     * einen **Verlauf**, und einen Verlauf sieht man beim Laufen nicht.
     *
     * Jetzt entscheidet die Zonentabelle (`LM_ZONEN`), was wo wächst — und
     * die Grenzen dazwischen sind sichtbar gemacht. Der Unterschied ist
     * nicht die Zahl der Bäume, sondern dass die Änderung eine Kante hat.
     */
    ...LM_ZONEN.flatMap((zone, i) =>
      zonenBewuchs(zone, i === 0 ? LM.zSued : LM_ZONEN[i - 1].z1),
    ),

    /*
     * Und die Grenzen selbst — je eine Reihe Steine mit einem Wegweiser.
     *
     * Die letzte Zone bekommt keine: ihre Nordgrenze ist die Küste, und
     * dahinter liegt nur noch das Tor. Deshalb `slice(0, -1)`.
     */
    ...LM_ZONEN.slice(0, -1).flatMap((zone, i) =>
      zonenGrenze(zone.z1, ['meilenstein', 'steinmann', 'bildstock', 'runenstein'][i] ?? 'meilenstein'),
    ),

    // --- Fels und Geröll --------------------------------------------------
    ...scatter(rng, {
      count: 480,
      size,
      bereich: wiese,
      erlaubt: frei,
      minGap: 6,
      scaleRange: [0.6, 1.7],
      models: [
        { key: 'rock_small' },
        { key: 'rock_large' },
      ],
      keepOut,
    }),
    // Geröllfeld im Norden — dichter, grösser.
    ...scatter(rng, {
      count: 300,
      size,
      bereich: { x0: -LM.x, x1: LM.x, z0: 520, z1: LM.zNord },
      erlaubt: frei,
      minGap: 5,
      scaleRange: [0.9, 2.2],
      models: [
        { key: 'rock_large' },
        { key: 'rock_small' },
      ],
      keepOut,
    }),

    // --- Landmarken: einzeln und gross ------------------------------------
    //
    // Wenige, aber sichtbare. Ein Steinbogen alle zwanzig Meter wäre kein
    // Wahrzeichen mehr, sondern eine Allee.
    ...scatter(rng, {
      count: 40,
      size,
      bereich: { x0: -LM.x, x1: LM.x, z0: -240, z1: LM.zNord },
      erlaubt: frei,
      minGap: 60,
      scaleRange: [0.9, 1.3],
      models: [{ key: 'steinbogen' }, { key: 'felsnadel' }, { key: 'hinkelstein' }],
      keepOut,
    }),

    // Totholz und Waldboden: umgestürzte Stämme, Wurzelstöcke, Astbruch.
    // Sie liegen dort, wo auch die Bäume stehen, und geben dem Boden Relief.
    ...scatter(rng, {
      count: 380,
      size,
      bereich: wiese,
      erlaubt: frei,
      minGap: 9,
      scaleRange: [0.8, 1.3],
      models: [
        { key: 'baumstamm_liegend' },
        { key: 'wurzelstock' },
        { key: 'hohler_stumpf' },
        { key: 'astbruch' },
        { key: 'setzling' },
      ],
      keepOut,
    }),
    // Kleinkram am Boden — Kiesel, Moossteine, Baumpilze, Beeren.
    ...scatter(rng, {
      count: 650,
      size,
      bereich: { x0: -LM.x, x1: LM.x, z0: LM.zSued, z1: LM.zNord },
      erlaubt: frei,
      minGap: 5,
      scaleRange: [0.7, 1.4],
      models: [
        { key: 'kiesel' },
        { key: 'geroell' },
        { key: 'moosstein' },
        { key: 'baumpilz' },
        { key: 'beerenbusch' },
        { key: 'distel' },
      ],
      keepOut: keepOut.map((k) => ({ ...k, r: k.r * 0.6 })),
    }),
    // Und ein Saum aus Schilf und Büschen entlang der Ufer: der Fluss soll
    // eine Kante haben und nicht wie ein Schnitt in der Wiese aussehen.
    ...scatter(rng, {
      count: 900,
      size,
      bereich: { x0: -LM.x, x1: LM.x, z0: LM.zSued, z1: LM.zNord },
      erlaubt: (x, z) => {
        const d = flussAbstand(x, z);
        return d > 12.5 && d < 19 && Math.hypot(x, z - cz) > LM.stadtR + 8;
      },
      minGap: 3.5,
      scaleRange: [0.8, 1.5],
      models: [
        { key: 'grass_tuft' },
        { key: 'bush' },
        // Schilf und Rohrkolben machen aus einer Uferlinie ein Ufer. Sie
        // stehen bewusst dichter als der Rest und nur in diesem Streifen —
        // Schilf mitten auf der Wiese sähe aus wie ein Fehler im Streuer.
        { key: 'schilf' },
        { key: 'schilf' },
        { key: 'rohrkolben' },
        { key: 'brombeere' },
      ],
      keepOut: keepOut.map((k) => ({ ...k, r: k.r * 0.5 })),
    }),
    // Und im Wasser selbst: Seerosen und Kiesel. Der Streifen liegt **unter**
    // dem Uferabstand, also im Fluss.
    ...scatter(rng, {
      count: 400,
      size,
      bereich: { x0: -LM.x, x1: LM.x, z0: LM.zSued, z1: LM.zNord },
      erlaubt: (x, z) => {
        const d = flussAbstand(x, z);
        return d > 2 && d < 9 && Math.hypot(x, z - cz) > LM.stadtR + 8;
      },
      minGap: 5,
      scaleRange: [0.7, 1.3],
      models: [{ key: 'seerose' }, { key: 'seerose' }, { key: 'kiesel' }],
      keepOut: keepOut.map((k) => ({ ...k, r: k.r * 0.4 })),
    }),
  ].map((p, i) => ({ ...p, id: `p_${String(i + 1).padStart(4, '0')}` }));

  /*
   * --- Die Sperren, erst weit draussen -------------------------------------
   *
   * Vorher lagen sie **direkt** an der Kante des begehbaren Streifens: was
   * jenseits des Bergfusses lag, war zu, und man stand vor einer unsichtbaren
   * Wand mit einem Berg dahinter.
   *
   * Jetzt beginnen sie dreissig Meter jenseits der äussersten Küste. Zu Fuss
   * merkt das niemand — dort ist Meer, und an Land hält die Klippe. Wer aber
   * fliegt, kommt über die Kante hinaus, sieht die Insel von aussen und
   * dreht erst weit draussen über dem Wasser um. Genau das ist der
   * Unterschied zwischen einem Rand und einem Käfig.
   */
  const halb = size * 0.5;
  const sperre = LM.x + 55;
  const sperreNord = LM.zNord + 55;
  const sperreSued = LM.zSued - 55;
  const zonen = [
    {
      id: 'z_0001',
      label: 'Westsee',
      position: [-(halb + sperre) * 0.5, 0],
      extent: [(halb - sperre) * 0.5, halb],
      keinLauf: true,
      keinFlug: true,
    },
    {
      id: 'z_0002',
      label: 'Ostsee',
      position: [(halb + sperre) * 0.5, 0],
      extent: [(halb - sperre) * 0.5, halb],
      keinLauf: true,
      keinFlug: true,
    },
    {
      id: 'z_0003',
      label: 'Südsee',
      position: [0, (-halb + sperreSued) * 0.5],
      extent: [halb, (halb + sperreSued) * 0.5],
      keinLauf: true,
      keinFlug: true,
    },
    {
      id: 'z_0004',
      label: 'Nordsee',
      position: [0, (halb + sperreNord) * 0.5],
      extent: [halb, (halb - sperreNord) * 0.5],
      keinLauf: true,
      keinFlug: true,
    },
  ];

  return {
    format: 'aurelith.map',
    version: 1,
    id: 'lichtmoor',
    name: 'Lichtmoor',
    environment: {
      skyColor: 0x8ec3ee,
      horizonColor: 0xdcecf9,
      fogColor: 0xc4dcf0,
      fogNear: 130,
      fogFar: 400,
      sunDirection: [0.42, 0.82, 0.38],
      sunColor: 0xfff4de,
      sunIntensity: 1.9,
      /*
       * Der Boden strahlt zurück, und zwar warm.
       *
       * `ambientColor` ist die **untere** Farbe des Halbkugellichts — das,
       * womit der Boden von unten aufhellt. Hier stand ein kühles Blau, und
       * damit bekam jede nach unten gerichtete Fläche einen kalten Stich:
       * Baumkronen von unten, Gesichter im Gegenlicht, die Unterseite der
       * schwebenden Felsen. Über einer Sommerwiese ist das reflektierte Licht
       * grünlich-warm.
       */
      ambientColor: 0xd6d8bc,
      /*
       * Von 1,2 auf 1,6 angehoben, zusammen mit der Tonwertkurve im Renderer.
       *
       * Die beiden gehören zusammen: mehr Umgebungslicht **ohne** Kurve hätte
       * nur die Schattenseiten angehoben und die Sonnenseiten endgültig
       * weissgebrannt. Mit Kurve hebt es die Schattenseiten und lässt die
       * hellen Flächen ihre Farbe behalten.
       */
      ambientIntensity: 1.6,
    },
    terrain: {
      size,
      cellSize: 4,
      seed: 0x4c49,
      // Flacher als vorher: das Relief kommt jetzt aus dem geformten Feld —
      // Berge, Hügel, Flussbett. Bliebe das Rauschen so kräftig wie vorher,
      // läge die Stadt auf einer Welle und der Fluss stellenweise am Hang.
      heightScale: 6,
      featureScale: 0.009,
      waterLevel: -4,
      grassColor: 0x6aa855,
      grassColorAlt: 0x4f8a3e,
      rockColor: 0x8a8478,
      sandColor: 0xd2c294,
      layers: groundLayers(-4),
      /*
       * Drei Meter Schrittweite und nicht zwei.
       *
       * Das Feld ist quadratisch, und die Karte ist auf 2048 Einheiten
       * gewachsen: bei zwei Metern wären das 1025 mal 1025 Stützpunkte, gut
       * zwei Megabyte allein für das Gelände — für eine Insel, die nur ein
       * Drittel davon bedeckt. Der Rest ist Meer.
       *
       * Bei drei Metern bleibt die Kante trotzdem eine Kante: die Klippe
       * fällt sechsundzwanzig Meter auf zwölf, über die Stützpunkte
       * verschliffen sind es sechsundzwanzig auf fünfzehn — sechzig Grad und
       * damit weiter über den zweiundfünfzig, bis zu denen der Kern einen
       * gehen lässt. Dasselbe für die Flussböschung: vierzehn Meter auf
       * fünf, verschliffen auf acht, sind sechzig Grad. Bei vier Metern wäre
       * beides eine Rampe, und der Fluss keine Grenze mehr.
       */
      sculpt: baueSculpt(size, lichtmoorHoehe, { schrittweite: 3 }),
      /*
       * Der Weg als gemalte Erde.
       *
       * Gemalt wird **beides** — Erde und Gras —, nicht nur die Erde: wo
       * etwas gemalt ist, treten die Regeln aus Neigung und Höhe ganz zurück.
       * Stünde am Rand nur eine halbe Portion Erde, läge dort ein halb
       * durchsichtiger Streifen statt einer Wiese. So geht der Rand in reines
       * Gras über, und das ist genau das, was die Regel daneben ohnehin sagt:
       * die Naht ist unsichtbar.
       */
      paint: baueMalfeld(size, (x, z) => {
        const weg = lichtmoorWeg(x, z);
        return weg > 0.02 ? [1 - weg, weg, 0, 0] : undefined;
      }),
    },
    spawn: { x: 0, z: cz + 16, yaw: 0 },
    props,
    spawners,
    npcs,
    portals,
    zonen,
  };
}

// --------------------------------------------------------------------------
// Dornwald — dichter, dunkler, ab Stufe 6.
// --------------------------------------------------------------------------

/**
 * Die Wegmarken des Dornwalds.
 *
 * Dieselbe Rechnung wie in Lichtmoor: eine Karte wird in Minuten gemessen.
 * Der Dornwald war fünfhundertzwölf Meter im Quadrat — vom Tor nach Lichtmoor
 * bis zum Tor der Schattengruft waren es dreihundertfünfzig Meter, also knapp
 * eine Minute. Man betrat den Wald und stand am nächsten Tor.
 *
 * Jetzt zwölfhundertachtzig im Quadrat und elfhundert Meter zwischen den
 * Toren: drei Minuten, und dazwischen liegt tatsächlich Wald.
 */
const DW = {
  size: 1280,
  /** Tor nach Lichtmoor, im Süden. */
  torSued: -600,
  /** Tor zur Schattengruft, im Nordosten. */
  torGruft: [240, 500],
  /** Das Banditenlager, ungefähr auf halbem Weg. */
  lager: [-150, 40],
};

function dornwald() {
  const rng = mulberry32(0x444f_524e);
  const size = DW.size;

  const npcs = [{ id: 'n_gate_back', def: 'npc_gatekeeper', position: [4, DW.torSued + 8], yaw: 0 }];

  const portals = [
    {
      id: 'g_lichtmoor',
      position: [0, DW.torSued],
      yaw: 3.14159,
      radius: 4,
      label: 'Lichtmoor',
      // Zwölf Einheiten vor dem Tor nach Dornwald, nicht darin — sonst reist
      // man nach Ablauf der Sperre sofort wieder zurück. Und nicht weiter weg:
      // wer ein Tor durchschreitet, soll davorstehen und nicht im Feld.
      target: { map: 'lichtmoor', x: 0, z: LM_TOR - 12, yaw: 3.14159 },
      minLevel: 0,
    },
    {
      id: 'g_gruft',
      position: DW.torGruft,
      yaw: -0.9,
      radius: 4.5,
      label: 'Schattengruft',
      target: { map: 'gruft_01', x: 0, z: -96, yaw: 0 },
      minLevel: 10,
    },
  ];

  /*
   * Die Felder zwischen den beiden Toren.
   *
   * Sie liegen auf der Strecke und nicht um den Eingang herum: der Weg ist
   * elfhundert Meter lang, und wer alle Gegner in den ersten zweihundert
   * aufstellt, hat danach neunhundert Meter leeren Wald.
   */
  const spawners = [
    { id: 's_boar_a', mob: 'thistle_boar', position: [-100, -480], radius: 30, count: 7, respawnMs: 75000 },
    { id: 's_boar_b', mob: 'thistle_boar', position: [110, -420], radius: 30, count: 7, respawnMs: 75000 },
    { id: 's_boar_c', mob: 'thistle_boar', position: [-40, -280], radius: 30, count: 6, respawnMs: 75000 },
    { id: 's_boar_d', mob: 'thistle_boar', position: [150, -180], radius: 30, count: 6, respawnMs: 75000 },
    { id: 's_bandit_a', mob: 'bandit_scout', position: [-120, -60], radius: 28, count: 6, respawnMs: 75000 },
    { id: 's_bandit_b', mob: 'bandit_scout', position: [40, 60], radius: 28, count: 6, respawnMs: 75000 },
    { id: 's_bandit_c', mob: 'bandit_scout', position: [-180, 180], radius: 28, count: 6, respawnMs: 75000 },
    { id: 's_bandit_d', mob: 'bandit_scout', position: [120, 260], radius: 28, count: 6, respawnMs: 75000 },
    { id: 's_bandit_e', mob: 'bandit_scout', position: [-60, 380], radius: 26, count: 5, respawnMs: 75000 },
    { id: 's_bandit_f', mob: 'bandit_scout', position: [200, 380], radius: 26, count: 5, respawnMs: 75000 },
  ];

  // Dornwald ist nicht bewohnt, sondern durchzogen: ein Grenzposten am Tor,
  // ein Banditenlager mittendrin und Licht nur da, wo jemand welches
  // aufgestellt hat. Deshalb keine Laternenreihe wie in Lichtmoor — die paar
  // Lichter sollen im Dunkeln als Ziel wirken, nicht als Beleuchtung.
  const sued = DW.torSued;
  const [lx, lz] = DW.lager;
  const [gx, gz] = DW.torGruft;
  const gesetzt = [
    // Grenzposten am Rueckportal.
    ...fenceRun('fence_stone', [-13, sued + 4], [-5, sued + 4]),
    ...fenceRun('fence_stone', [5, sued + 4], [13, sued + 4]),
    place('lantern_post', -7, sued + 10),
    place('lantern_post', 7, sued + 10),
    place('banner', -9.5, sued + 6, { yaw: 0 }),
    place('crate', 9, sued + 12, { yaw: 0.4 }),
    place('barrel', 10.4, sued + 10.4, { yaw: 1.3 }),
    place('torpfosten', -15, sued + 8),
    place('torpfosten', 15, sued + 8),
    place('meilenstein', 4, sued + 16, { yaw: 0.2 }),
    place('waffenstaender', -11, sued + 13, { yaw: 1.6 }),
    place('spitzbarriere', -18, sued + 10, { yaw: 0.2 }),
    place('spitzbarriere', 18, sued + 10, { yaw: 2.9 }),

    /*
     * Banditenlager.
     *
     * Der Zaun ist Stueckwerk, kein Gehege — drei Laeufe, die nicht
     * schliessen. Dazu Palisade auf der Wetterseite, ein Wachturm mit Blick
     * auf den Weg und ein leerer Kaefig: die drei Dinge, die aus einem
     * Zeltplatz ein Lager machen, dem man besser nicht zu nah kommt.
     */
    ...fenceRun('fence_wood', [lx - 8, lz + 12], [lx + 4, lz + 12]),
    ...fenceRun('fence_wood', [lx - 8, lz + 12], [lx - 8, lz + 22]),
    ...fenceRun('fence_wood', [lx + 6, lz + 20], [lx + 6, lz + 28]),
    ...reihe('palisade', [lx - 10, lz + 6], [lx + 6, lz + 6], 2),
    place('wachturm', lx - 12, lz + 18, { yaw: 0.4 }),
    place('kaefig', lx + 9, lz + 15, { yaw: 0.6 }),
    place('galgen', lx + 12, lz + 6, { yaw: 1.9 }),
    place('zelt', lx - 4, lz + 24, { yaw: 0.5 }),
    place('zelt', lx + 2, lz + 30, { yaw: 2.6 }),
    place('lagerfeuer', lx - 1, lz + 20),
    place('bratspiess', lx - 1, lz + 20, { yaw: 0.6 }),
    place('schlafrolle', lx - 5, lz + 18, { yaw: 1.2 }),
    place('schlafrolle', lx + 2, lz + 22, { yaw: 2.7 }),
    place('waffenstaender', lx + 5, lz + 23, { yaw: 3.1 }),
    place('lantern_post', lx - 2, lz + 18),
    place('lantern_post', lx + 4, lz + 24),
    place('crate', lx - 4, lz + 16, { yaw: 0.8 }),
    place('kistenstapel', lx - 2.8, lz + 17.2, { yaw: 2.1 }),
    place('barrel', lx - 0.5, lz + 15, { yaw: 0.3 }),
    place('barrel', lx + 0.8, lz + 16.4, { yaw: 1.7 }),
    place('hay_bale', lx - 5, lz + 21, { yaw: 1.1 }),
    place('banner', lx, lz + 20, { yaw: 2.2 }),
    place('knochenhaufen', lx + 11, lz + 20, { yaw: 0.3 }),
    place('schaedel', lx + 9.6, lz + 11, { yaw: 1.4 }),

    // Wegkreuzung auf halbem Weg — Laternen, ein umgeworfenes Fass und ein
    // Wrack, das seit Jahren dort liegt.
    place('lantern_post', 2, -140),
    place('lantern_post', 6, -118),
    place('barrel', 4.2, -130, { yaw: 0.9 }),
    place('wrack', 10, -128, { yaw: 0.7 }),
    place('wagenrad', 13, -131, { yaw: 1.9 }),
    place('grabkreuz', -6, -124, { yaw: 0.4 }),
    place('grabkreuz', -7.5, -122, { yaw: 2.2 }),

    /*
     * Ein aufgegebener Aussenposten mitten im Wald.
     *
     * Er ist der einzige Ort auf dieser Karte, an dem Stein steht — und
     * deshalb der einzige, an dem man merkt, dass hier einmal jemand
     * herrschte, bevor die Banditen kamen.
     */
    place('bogenrest', 142, -320, { yaw: 0.6 }),
    place('saeule_bruch', 136, -314, { scale: 1.1 }),
    place('saeule_bruch', 148, -326, { scale: 0.9 }),
    place('truemmer', 140, -326, { yaw: 0.8 }),
    place('truemmer', 146, -316, { yaw: 2.4 }),
    place('steintreppe', 144, -310, { yaw: 3.14 }),
    place('efeu', 138, -318, { scale: 1.4 }),
    place('efeu', 145, -323, { scale: 1.2 }),
    place('runenstein', 150, -318, { yaw: 0.9 }),

    /*
     * Ein zweiter Rastplatz weiter nördlich.
     *
     * Auf elfhundert Metern zwischen zwei Toren braucht es mehr als eine
     * Wegmarke: ohne sie läuft man zwölf Minuten durch immergleiche Dornen,
     * und nichts sagt einem, wie weit man ist.
     */
    place('lagerfeuer', -20, 200),
    place('schlafrolle', -24, 198, { yaw: 1.1 }),
    place('lantern_post', -16, 206),
    place('meilenstein', -12, 212, { yaw: 0.4 }),
    place('baumstamm_liegend', -28, 206, { yaw: 1.6 }),
    place('bogenrest', 96, 300, { yaw: 1.2 }),
    place('truemmer', 104, 306, { yaw: 0.5 }),
    place('efeu', 100, 310, { scale: 1.3 }),

    // Vor der Gruft. Hier soll das Licht warnen, nicht einladen.
    place('lantern_post', gx - 8, gz - 6),
    place('lantern_post', gx + 4, gz - 8),
    ...fenceRun('fence_stone', [gx - 12, gz - 12], [gx - 4, gz - 12]),
    place('grabstein', gx - 10, gz + 4, { yaw: 0.3 }),
    place('grabstein', gx - 6, gz + 7, { yaw: 2.7 }),
    place('grabstein', gx - 14, gz, { yaw: 1.4 }),
    place('grabkreuz', gx - 2, gz + 4, { yaw: 0.8 }),
    place('urne', gx - 8, gz - 2),
    place('knochenhaufen', gx - 4, gz - 1, { yaw: 1.1 }),
    place('schaedel', gx - 12, gz - 5, { yaw: 0.6 }),
    place('bogenrest', gx + 8, gz - 2, { yaw: 2.2 }),
  ];

  const keepOut = [
    ...npcs.map((n) => ({ x: n.position[0], z: n.position[1], r: 8 })),
    ...portals.map((p) => ({ x: p.position[0], z: p.position[1], r: 14 })),
    ...spawners.map((s) => ({ x: s.position[0], z: s.position[1], r: s.radius * 0.4 })),
    ...keepOutOf(gesetzt, 4),
  ];

  const props = [
    ...gesetzt,
    ...scatter(rng, {
      count: 1700,
      size,
      minGap: 7,
      scaleRange: [0.9, 1.7],
      models: [
        { key: 'tree_pine' },
        { key: 'tree_dead' },
        { key: 'tree_broad' },
        { key: 'tree_fir' },
      ],
      keepOut,
      tints: [0x3c6b33, 0x2f5a2b, 0x486f3a, 0x59503c],
    }),
    ...scatter(rng, {
      count: 400,
      size,
      minGap: 8,
      scaleRange: [0.7, 2.0],
      models: [
        { key: 'rock_large' },
        { key: 'rock_small' },
      ],
      keepOut,
    }),
    /*
     * Der Dornwald heisst so.
     *
     * Dornbusch und Brombeere sind hier keine Streuware unter anderen, sondern
     * **die Mehrheit** — ein Wald, in dem das namengebende Gewächs nur alle
     * zwanzig Meter steht, heisst nach etwas, das man nicht sieht.
     */
    ...scatter(rng, {
      count: 1500,
      size,
      minGap: 4.5,
      scaleRange: [0.7, 1.4],
      models: [
        { key: 'dornbusch' },
        { key: 'dornbusch' },
        { key: 'dornbusch' },
        { key: 'brombeere' },
        { key: 'brombeere' },
        { key: 'bush' },
        { key: 'stump' },
        { key: 'mushroom_large' },
        { key: 'farn' },
      ],
      keepOut: keepOut.map((k) => ({ ...k, r: k.r * 0.5 })),
    }),
    // Was auf dem Waldboden liegt: Totholz, Pilze an den Stämmen, Moos.
    ...scatter(rng, {
      count: 750,
      size,
      minGap: 7,
      scaleRange: [0.8, 1.4],
      models: [
        { key: 'baumstamm_liegend' },
        { key: 'wurzelstock' },
        { key: 'astbruch' },
        { key: 'hohler_stumpf' },
        { key: 'baumpilz' },
        { key: 'moosstein' },
        { key: 'pilzring' },
      ],
      keepOut,
    }),
    // Und die Spuren derer, die vor einem hier waren — verteilt und selten,
    // damit jede einzelne noch etwas erzählt.
    ...scatter(rng, {
      count: 200,
      size,
      minGap: 24,
      scaleRange: [0.9, 1.2],
      models: [
        { key: 'grabkreuz' },
        { key: 'knochenhaufen' },
        { key: 'schaedel' },
        { key: 'truemmer' },
        { key: 'wrack' },
        { key: 'felsblock' },
      ],
      keepOut,
    }),
  ].map((p, i) => ({ ...p, id: `p_${String(i + 1).padStart(4, '0')}` }));

  return {
    format: 'aurelith.map',
    version: 1,
    id: 'dornwald',
    name: 'Dornwald',
    environment: {
      skyColor: 0x5c7f96,
      horizonColor: 0x9db4bd,
      fogColor: 0x7f97a2,
      fogNear: 60,
      fogFar: 240,
      sunDirection: [-0.3, 0.68, 0.55],
      sunColor: 0xe8e4d2,
      sunIntensity: 1.45,
      // Auch hier wärmer und heller — der Dornwald soll düster sein, aber
      // düster heisst finstere Farben und nicht „man sieht nichts".
      ambientColor: 0x93967e,
      ambientIntensity: 1.35,
    },
    terrain: {
      size,
      cellSize: 4,
      seed: 0x444f,
      heightScale: 19,
      featureScale: 0.014,
      waterLevel: -6,
      grassColor: 0x4a6b3c,
      grassColorAlt: 0x37522e,
      rockColor: 0x6e6a62,
      sandColor: 0x9c8f70,
      // Dornwald ist duesterer als Lichtmoor — dieselben Texturen, dunkler
      // getoent, statt eines zweiten Satzes fuer denselben Boden.
      layers: groundLayers(-6, { grassTint: 0xa8b8a0, dirtTint: 0xb0a898, sandTint: 0xa89880 }),
    },
    // Nicht auf dem Rueckportal: wer dort gespeichert hat, wuerde beim
    // Anmelden sofort weiterbefoerdert.
    spawn: { x: 0, z: DW.torSued + 8, yaw: 0 },
    props,
    spawners,
    npcs,
    portals,
  };
}

// --------------------------------------------------------------------------
// Schattengruft — erster Dungeon. Klein, eng, mit Boss am Ende.
// --------------------------------------------------------------------------

function gruft() {
  const rng = mulberry32(0x4752_5546);
  const size = 256;

  const portals = [
    {
      id: 'g_exit',
      position: [0, -104],
      yaw: 3.14159,
      radius: 5,
      label: 'Dornwald',
      target: { map: 'dornwald', x: DW.torGruft[0], z: DW.torGruft[1] - 8, yaw: 3.14159 },
      minLevel: 0,
    },
  ];

  const spawners = [
    { id: 's_crawler_a', mob: 'cave_crawler', position: [-30, -20], radius: 22, count: 6, respawnMs: 75000 },
    { id: 's_crawler_b', mob: 'cave_crawler', position: [34, 18], radius: 22, count: 6, respawnMs: 75000 },
    { id: 's_crawler_c', mob: 'cave_crawler', position: [-8, 56], radius: 20, count: 5, respawnMs: 75000 },
    { id: 's_warden', mob: 'dungeon_warden', position: [0, 92], radius: 6, count: 1, respawnMs: 120000 },
  ];

  // Unter Tage ist die Laterne das einzige warme Licht. Deshalb stehen sie
  // hier am dichtesten: sie zeichnen den Weg vom Eingang bis zum Waerter, und
  // wer zwischen zwei Lichtern steht, sieht immer das naechste.
  const gesetzt = [
    /*
     * Der Eingang.
     *
     * Ein Tor, das **offen** steht, eine Treppe hinunter und die letzten
     * Spuren der Lebenden: Kiste, Fass, eine Fackel. Ab hier gehört der Gang
     * den Toten.
     */
    place('eisentor', 0, -90, { yaw: 0 }),
    place('steintreppe', 0, -82, { yaw: 3.14 }),
    place('lantern_post', -6, -86),
    place('lantern_post', 6, -86),
    place('crate', -8.5, -92, { yaw: 0.6 }),
    place('barrel', 8.2, -91, { yaw: 1.4 }),
    place('spinnwebe', -9, -84, { yaw: 0.5 }),
    place('spinnwebe', 9.5, -85, { yaw: 2.6 }),

    ...lanternRoad([-4, -70], [-14, 0], { abstand: 26, seite: 5 }),
    ...lanternRoad([12, 0], [4, 70], { abstand: 26, seite: 5 }),

    /*
     * Der Gang: ein gepflasterter Weg zwischen Grabplatten.
     *
     * Die Platten liegen **im** Weg und nicht daneben — man läuft über die
     * Gräber, und genau das ist die Aussage dieses Ortes.
     */
    ...reihe('steinplatte', [-4, -70], [-14, 0], 1.8, { drehung: Math.PI / 2 }),
    ...reihe('steinplatte', [12, 0], [4, 70], 1.8, { drehung: Math.PI / 2 }),
    place('grabplatte', -8, -44, { yaw: 0.2 }),
    place('grabplatte', -12, -18, { yaw: 0.1 }),
    place('grabplatte', 10, 22, { yaw: 3.2 }),
    place('grabplatte', 7, 48, { yaw: 3.1 }),

    // Zwei Seitenkammern: Beinhaus im Westen, Sarkophage im Osten.
    place('beinhaus', -26, -30, { yaw: 1.6 }),
    place('beinhaus', -26, -24, { yaw: 1.6 }),
    place('opferschale', -21, -27),
    place('sarkophag', 28, 26, { yaw: 1.5 }),
    place('sarkophag', 34, 32, { yaw: 1.5 }),
    place('sarg', 24, 20, { yaw: 0.9 }),
    place('urne', 31, 20),
    place('urne', 32.4, 21.2, { scale: 0.85 }),
    place('kette', 22, 30, { yaw: 0.4 }),

    /*
     * Der Vorraum des Waerters.
     *
     * Mauerreste, zwei Laternen, und dahinter ein Altar — er ist der einzige
     * Ort auf der Karte, der aussieht, als sei er gemeint: alles andere ist
     * Gang und Kammer.
     */
    ...fenceRun('fence_stone', [-12, 80], [-4, 80]),
    ...fenceRun('fence_stone', [4, 80], [12, 80]),
    place('lantern_post', -7, 84),
    place('lantern_post', 7, 84),
    place('altar', 0, 100, { yaw: 0 }),
    place('runenstein', -8, 96, { yaw: 0.5 }),
    place('runenstein', 8, 96, { yaw: 5.8 }),
    place('opferschale', -4, 92),
    place('opferschale', 4, 92),
    place('saeule_bruch', -14, 92, { scale: 1.2 }),
    place('saeule_bruch', 14, 92, { scale: 1.2 }),
    place('knochenhaufen', -10, 104, { yaw: 0.7 }),
    place('knochenhaufen', 11, 103, { yaw: 2.1 }),
    place('schaedel', 0, 106, { yaw: 0.3 }),
  ];

  const keepOut = [
    { x: 0, z: -96, r: 16 },
    ...portals.map((p) => ({ x: p.position[0], z: p.position[1], r: 14 })),
    ...spawners.map((s) => ({ x: s.position[0], z: s.position[1], r: s.radius * 0.5 })),
    ...keepOutOf(gesetzt, 4),
  ];

  const props = [
    ...gesetzt,
    ...scatter(rng, {
      count: 90,
      size,
      minGap: 6,
      scaleRange: [0.9, 2.2],
      models: [
        { key: 'pillar' },
        { key: 'rock_large' },
      ],
      keepOut,
    }),
    /*
     * Tropfstein.
     *
     * Er ist das, was eine Höhle von einem dunklen Wald unterscheidet — und
     * er steht **dichter** als alles andere hier: eine Gruft mit zwei
     * Stalagmiten ist ein Keller.
     */
    ...scatter(rng, {
      count: 110,
      size,
      minGap: 5,
      scaleRange: [0.6, 1.6],
      models: [
        { key: 'stalagmit' },
        { key: 'stalagmit' },
        { key: 'tropfsteinsaeule' },
        { key: 'felsnadel' },
      ],
      keepOut,
    }),
    /*
     * Was in der Gruft leuchtet.
     *
     * Kristall, Geode und Leuchtpilz sind die einzigen hellen Punkte hier
     * unten — sie führen das Auge durch den Gang, ohne dass dafür eine
     * Lichtquelle nötig wäre. Deshalb der eigene Streuer und nicht die
     * Mischung mit dem Geröll: verteilt zwischen dreissig grauen Steinen
     * fiele keiner von ihnen auf.
     */
    ...scatter(rng, {
      count: 80,
      size,
      minGap: 5,
      scaleRange: [0.7, 1.5],
      models: [
        { key: 'crystal' },
        { key: 'kristallgruppe' },
        { key: 'leuchtpilz' },
        { key: 'leuchtpilz' },
        { key: 'mushroom_large' },
        { key: 'rock_small' },
      ],
      keepOut,
      tints: [0x7fd8e8, 0x9a7fe8, 0x6fb4d8],
    }),
    ...scatter(rng, {
      count: 10,
      size,
      minGap: 26,
      scaleRange: [0.9, 1.3],
      models: [{ key: 'kristall_gross' }, { key: 'geode' }],
      keepOut,
    }),
    // Bruchstücke und Knochen zwischen den Säulen.
    ...scatter(rng, {
      count: 70,
      size,
      minGap: 6,
      scaleRange: [0.8, 1.3],
      models: [
        { key: 'truemmer' },
        { key: 'saeule_bruch' },
        { key: 'knochenhaufen' },
        { key: 'schaedel' },
        { key: 'grabstein' },
        { key: 'urne' },
      ],
      keepOut,
    }),
    ...scatter(rng, {
      count: 22,
      size,
      minGap: 14,
      scaleRange: [1, 1],
      models: [{ key: 'brazier' }, { key: 'feuerschale' }],
      keepOut,
    }),
  ].map((p, i) => ({ ...p, id: `p_${String(i + 1).padStart(4, '0')}` }));

  return {
    format: 'aurelith.map',
    version: 1,
    id: 'gruft_01',
    name: 'Schattengruft',
    environment: {
      skyColor: 0x0d1218,
      horizonColor: 0x1b2731,
      fogColor: 0x121a22,
      fogNear: 18,
      fogFar: 110,
      sunDirection: [0.2, 0.9, -0.3],
      sunColor: 0x6d8fb0,
      sunIntensity: 0.7,
      ambientColor: 0x2b3a49,
      ambientIntensity: 0.9,
      // Unter Tage wandert keine Sonne. Ohne das liefe der Tageswechsel auch
      // hier, und um die Mittagszeit stuende die Gruft im Sonnenlicht.
      daylight: false,
    },
    terrain: {
      size,
      cellSize: 3,
      seed: 0x4752,
      heightScale: 7,
      featureScale: 0.02,
      waterLevel: -20,
      grassColor: 0x3a3a42,
      grassColorAlt: 0x2c2c34,
      rockColor: 0x4a4a52,
      sandColor: 0x55504a,
      // In der Gruft waechst nichts. Nur Erde, kalt getoent.
      layers: [
        {
          id: 'gruftboden',
          texture: 'textures/ground_dirt/albedo.webp',
          normal: 'textures/ground_dirt/normal.webp',
          tileSize: 5,
          slope: [0, 90],
          height: [-10000, 10000],
          slopeBlend: 6,
          heightBlend: 3,
          strength: 1,
          tint: 0x6a6a7a,
          roughness: 0.78,
          normalScale: 1.2,
        },
      ],
    },
    spawn: { x: 0, z: -96, yaw: 0 },
    props,
    spawners,
    npcs: [],
    portals,
  };
}

const maps = [lichtmoor(), dornwald(), gruft()];

/**
 * Prueft, dass niemand in einem Tor landet.
 *
 * Landet ein Zielpunkt im Radius eines Tores auf der Zielkarte, wird der
 * Spieler von dort sofort weitergereicht — bei einem Rueckportal also direkt
 * wieder zurueck. Genau das ist passiert: Lichtmoor schickte nach Dornwald auf
 * (0, -186), und dort stand das Rueckportal mit Radius 4.
 *
 * Der Server faengt das inzwischen ab, aber ein Tor, das man nur durch eine
 * Notbremse ueberlebt, ist trotzdem falsch gebaut. Deshalb hier, im Build:
 * lieber ein harter Abbruch als eine Karte, die sich seltsam spielt.
 */
function checkArrivals(maps) {
  const byId = new Map(maps.map((m) => [m.id, m]));
  const problems = [];

  const check = (what, mapId, x, z) => {
    const map = byId.get(mapId);
    if (!map) {
      problems.push(`${what} zeigt auf unbekannte Karte "${mapId}"`);
      return;
    }
    for (const portal of map.portals) {
      const d = Math.hypot(x - portal.position[0], z - portal.position[1]);
      if (d <= portal.radius) {
        problems.push(
          `${what} landet bei (${x}, ${z}) im Tor "${portal.id}" auf ${mapId} ` +
            `(Abstand ${d.toFixed(1)}, Radius ${portal.radius})`,
        );
      }
    }
  };

  for (const map of maps) {
    check(`Startpunkt von ${map.id}`, map.id, map.spawn.x, map.spawn.z);
    for (const portal of map.portals) {
      check(`${map.id}/${portal.id}`, portal.target.map, portal.target.x, portal.target.z);
    }
  }

  if (problems.length > 0) {
    console.error('Karten nicht geschrieben — Zielpunkte liegen in Toren:\n');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
}

checkArrivals(maps);

await mkdir(outDir, { recursive: true });
for (const map of maps) {
  const file = join(outDir, `${map.id}.json`);
  await writeFile(file, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  console.log(
    `${map.id.padEnd(12)} ${String(map.props.length).padStart(4)} Props  ` +
      `${String(map.spawners.length).padStart(2)} Spawner  ` +
      `${String(map.npcs.length).padStart(2)} NPCs  ` +
      `${String(map.portals.length).padStart(2)} Portale`,
  );
}
console.log(`\n${maps.length} Maps geschrieben nach ${outDir}`);
