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
import { encodeSculptField, SCULPT_UNIT } from '@aurelith/shared';

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

  while (placed.length < count && attempts < count * 60) {
    attempts++;
    const x = feld.x0 + rng() * (feld.x1 - feld.x0);
    const z = feld.z0 + rng() * (feld.z1 - feld.z0);

    // Der Bereich sagt „ungefähr hier", die Bedingung sagt „aber nicht im
    // Fluss und nicht im Berg". Zwei Fragen, weil ein Rechteck das eine kann
    // und das andere nicht.
    if (erlaubt && !erlaubt(x, z)) continue;

    let blocked = false;
    for (const k of keepOut) {
      if (Math.hypot(x - k.x, z - k.z) < k.r) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    for (const p of placed) {
      if (Math.hypot(x - p.position[0], z - p.position[2]) < minGap) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    const model = models[Math.floor(rng() * models.length)];
    const scale = scaleRange[0] + rng() * (scaleRange[1] - scaleRange[0]);
    const prop = {
      id: `p_${String(placed.length + 1).padStart(4, '0')}`,
      model: model.key,
      position: [round(x), 0, round(z)],
      rotation: [0, round(rng() * Math.PI * 2), 0],
      scale: round(scale),
      snapToGround: true,
      collision: model.collision ?? 'none',
      collisionRadius: model.collisionRadius ?? 1,
    };
    if (tints && tints.length > 0) {
      prop.tint = tints[Math.floor(rng() * tints.length)];
    }
    placed.push(prop);
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
function fenceRun(model, from, to, { scale = 1, collisionRadius = 0.85 } = {}) {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  const laenge = Math.hypot(dx, dz);
  const feld = 2 * scale;
  const felder = Math.max(1, Math.round(laenge / feld));
  const yaw = round(Math.atan2(-dz, dx));

  const out = [];
  for (let i = 0; i < felder; i++) {
    const t = (i + 0.5) / felder;
    out.push({
      model,
      position: [round(from[0] + dx * t), 0, round(from[1] + dz * t)],
      rotation: [0, yaw, 0],
      scale,
      snapToGround: true,
      collision: 'circle',
      collisionRadius,
    });
  }
  return out;
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

/** Ein einzelnes gesetztes Prop. */
function place(model, x, z, { yaw = 0, scale = 1, collision = 'none', collisionRadius = 0.6 } = {}) {
  return {
    model,
    position: [round(x), 0, round(z)],
    rotation: [0, round(yaw), 0],
    scale,
    snapToGround: true,
    collision,
    collisionRadius,
  };
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
        collision: 'circle',
        collisionRadius: 0.4,
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
// Die Karte ist **rechteckig**, obwohl das Gelände quadratisch ist: begehbar
// ist ein Streifen von 200 auf 375 Einheiten, alles darum herum ist Gebirge
// und durch Sperrzonen dicht. Damit sieht man nie einen Kartenrand, sondern
// immer einen Horizont aus Bergen — und der Weg führt in genau eine Richtung,
// nach Norden, wo die Monster mit jedem Abschnitt eine Stufe höher stehen.
//
// Der Aufbau von unten nach oben:
//
//   z −170 … −72   Silberfurt, die Hauptstadt. Mauer, Markt, alle Hauptquests.
//   z  −72 …  −10  Stufe 1–3. Irrlichter auf der Wiese.
//   z  −10 …   60  Stufe 4–7. Grabwelpen in den Gruben.
//   z   60 …  120  Stufe 8–11. Distelkeiler am Fluss.
//   z  120 …  170  Stufe 12–15. Banditen im Geröll.
//   z  170 …  204  Stufe 16–20. Höhlenkriecher und Gruftwärter vor dem Tor.
//
// Quer durch alles fliesst die Silberader. Ihre Ufer sind zu steil zum
// Begehen — das ist Absicht: der Fluss teilt die Wiese, und die Brücke ist
// eine Wegmarke statt einer Zierde.
// --------------------------------------------------------------------------

/** Der begehbare Streifen. Alles ausserhalb ist Gebirge und gesperrt. */
const LM = {
  size: 512,
  x: 100,
  zSued: -170,
  zNord: 204,
  /** Mitte der Hauptstadt. */
  stadtZ: -122,
  stadtR: 48,
};

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
  [-200, 84],
  [-110, 78],
  [-40, 42],
  [20, -22],
  [80, -50],
  [140, -8],
  [230, 36],
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

  // --- 1. Gebirge ---------------------------------------------------------
  const ausX = Math.max(0, Math.abs(x) - LM.x) / 62;
  const ausZ = Math.max(0, Math.max(z - LM.zNord, LM.zSued - z)) / 62;
  const aussen = Math.max(ausX, ausZ);
  if (aussen > 0) {
    // Drei überlagerte Wellen: ein Gebirge aus einer einzigen Rampe sähe aus
    // wie ein Wall. Die Zahlen sind teilerfremd, damit sich das Muster nicht
    // sichtbar wiederholt.
    const grat =
      Math.sin(x * 0.031) * 7 + Math.sin(z * 0.023) * 9 + Math.sin((x + z) * 0.017) * 6;
    h += glatt(aussen) * (118 + grat);
  }

  // --- 2. Hügel innen -----------------------------------------------------
  const kuppen = [
    { x: -62, z: -30, r: 34, h: 13 },
    { x: 58, z: 22, r: 30, h: 11 },
    { x: -40, z: 96, r: 38, h: 16 },
    { x: 66, z: 142, r: 32, h: 14 },
    { x: -70, z: 176, r: 30, h: 18 },
    { x: 20, z: 190, r: 26, h: 12 },
  ];
  for (const k of kuppen) {
    const d = Math.hypot(x - k.x, z - k.z) / k.r;
    if (d < 1) h += glatt(1 - d) * k.h;
  }

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

    // Unterwegs, von Süden nach Norden.
    { id: 'n_kraeuter', def: 'npc_kraeuterfrau', position: [-24, -46], yaw: 1.1 },
    { id: 'n_hirte', def: 'npc_hirte', position: [26, 14], yaw: 4.2 },
    { id: 'n_faehrmann', def: 'npc_faehrmann', position: [-12, 66], yaw: 0.4 },
    { id: 'n_jaeger', def: 'npc_jaeger', position: [34, 112], yaw: 3.8 },
    { id: 'n_kartograf', def: 'npc_kartograf', position: [-38, 158], yaw: 0.9 },
    { id: 'n_gate', def: 'npc_gatekeeper', position: [5, 188], yaw: 3.14 },
  ];

  const portals = [
    {
      id: 'g_dornwald',
      position: [0, 196],
      yaw: 0,
      radius: 4,
      label: 'Dornwald',
      // Acht Einheiten vor dem Rueckportal, nicht darin. Genau das war der
      // Fehler: der Zielpunkt lag exakt auf dem Gegentor bei (0, -186), und
      // nach Ablauf der Zeitsperre reiste man automatisch zurueck.
      target: { map: 'dornwald', x: 0, z: -178, yaw: 0 },
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
    { id: 's_mote_a', mob: 'mote', position: [-46, -58], radius: 26, count: 8, respawnMs: 60000, level: 1 },
    { id: 's_mote_b', mob: 'mote', position: [40, -50], radius: 24, count: 7, respawnMs: 60000, level: 2 },
    { id: 's_mote_c', mob: 'mote', position: [-14, -22], radius: 26, count: 7, respawnMs: 60000, level: 3 },
    { id: 's_pup_a', mob: 'burrow_pup', position: [58, -20], radius: 24, count: 6, respawnMs: 70000, level: 3 },

    // Stufe 4–7: die Gruben.
    { id: 's_pup_b', mob: 'burrow_pup', position: [-58, 6], radius: 26, count: 7, respawnMs: 70000, level: 4 },
    { id: 's_pup_c', mob: 'burrow_pup', position: [16, 30], radius: 24, count: 6, respawnMs: 70000, level: 5 },
    { id: 's_boar_a', mob: 'thistle_boar', position: [70, 34], radius: 26, count: 5, respawnMs: 75000, level: 6 },
    { id: 's_boar_b', mob: 'thistle_boar', position: [-72, 48], radius: 26, count: 5, respawnMs: 75000, level: 7 },

    // Stufe 8–11: die Uferwiesen.
    { id: 's_boar_c', mob: 'thistle_boar', position: [30, 84], radius: 28, count: 6, respawnMs: 75000, level: 8 },
    { id: 's_bandit_a', mob: 'bandit_scout', position: [-52, 92], radius: 26, count: 5, respawnMs: 80000, level: 9 },
    { id: 's_bandit_b', mob: 'bandit_scout', position: [72, 104], radius: 24, count: 5, respawnMs: 80000, level: 10 },
    { id: 's_bandit_c', mob: 'bandit_scout', position: [-20, 118], radius: 26, count: 6, respawnMs: 80000, level: 11 },

    // Stufe 12–15: das Geröllfeld.
    { id: 's_bandit_d', mob: 'bandit_scout', position: [56, 138], radius: 26, count: 5, respawnMs: 80000, level: 12 },
    { id: 's_crawl_a', mob: 'cave_crawler', position: [-64, 142], radius: 26, count: 5, respawnMs: 85000, level: 13 },
    { id: 's_crawl_b', mob: 'cave_crawler', position: [10, 156], radius: 26, count: 6, respawnMs: 85000, level: 14 },
    { id: 's_crawl_c', mob: 'cave_crawler', position: [-30, 172], radius: 24, count: 5, respawnMs: 85000, level: 15 },

    // Stufe 16–20: vor dem Tor.
    { id: 's_crawl_d', mob: 'cave_crawler', position: [62, 172], radius: 24, count: 5, respawnMs: 85000, level: 16 },
    { id: 's_warden_a', mob: 'dungeon_warden', position: [-72, 190], radius: 22, count: 4, respawnMs: 95000, level: 17 },
    { id: 's_warden_b', mob: 'dungeon_warden', position: [40, 194], radius: 22, count: 4, respawnMs: 95000, level: 18 },
    { id: 's_warden_c', mob: 'dungeon_warden', position: [-34, 200], radius: 20, count: 3, respawnMs: 95000, level: 20 },
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
    place('pillar', -11, cz + mauerHalb, { collision: 'circle', collisionRadius: 1.1 }),
    place('pillar', 11, cz + mauerHalb, { collision: 'circle', collisionRadius: 1.1 }),
    place('banner', -13.5, cz + mauerHalb + 2, { yaw: 3.14 }),
    place('banner', 13.5, cz + mauerHalb + 2, { yaw: 3.14 }),
    place('lantern_post', -14, cz + mauerHalb - 3, { collision: 'circle', collisionRadius: 0.4 }),
    place('lantern_post', 14, cz + mauerHalb - 3, { collision: 'circle', collisionRadius: 0.4 }),

    // Marktplatz.
    place('well', 0, cz, { collision: 'circle', collisionRadius: 2.2 }),
    place('signpost', 4, cz + 8, { yaw: 0.5 }),
    place('brazier', -7, cz - 7, { collision: 'circle', collisionRadius: 0.6 }),
    place('brazier', 7, cz - 7, { collision: 'circle', collisionRadius: 0.6 }),
    place('banner', -4.5, cz + 3, { yaw: 0.3 }),
    place('banner', 4.5, cz + 3, { yaw: 5.9 }),
    place('lantern_post', -10, cz + 10, { collision: 'circle', collisionRadius: 0.4 }),
    place('lantern_post', 10, cz + 10, { collision: 'circle', collisionRadius: 0.4 }),
    place('lantern_post', -10, cz - 10, { collision: 'circle', collisionRadius: 0.4 }),
    place('lantern_post', 10, cz - 10, { collision: 'circle', collisionRadius: 0.4 }),

    // Handwerkerviertel im Osten: die Schmiede.
    ...fenceRun('fence_stone', [13, cz - 12], [26, cz - 12]),
    place('barrel', 20.6, cz - 8.4, { yaw: 0.7, collision: 'circle', collisionRadius: 0.5 }),
    place('barrel', 22.4, cz - 6.8, { yaw: 2.4, collision: 'circle', collisionRadius: 0.5 }),
    place('crate', 19.2, cz - 10.2, { yaw: 0.9, collision: 'circle', collisionRadius: 0.6 }),
    place('crate', 24.4, cz - 3.4, { yaw: 2.1, scale: 0.9 }),
    place('brazier', 26, cz - 8, { collision: 'circle', collisionRadius: 0.6 }),
    place('lantern_post', 28, cz + 2, { collision: 'circle', collisionRadius: 0.4 }),

    // Lagerhof im Westen: die Händlerin.
    ...fenceRect('fence_wood', -24, cz - 2, 9, 8),
    place('crate', -21.5, cz + 2.5, { yaw: 0.5, collision: 'circle', collisionRadius: 0.6 }),
    place('crate', -25.4, cz + 3.6, { yaw: 1.2, scale: 0.85 }),
    place('barrel', -27.8, cz - 1.2, { yaw: 0.2, collision: 'circle', collisionRadius: 0.5 }),
    place('barrel', -22.2, cz - 3.6, { yaw: 1.1, collision: 'circle', collisionRadius: 0.5 }),
    place('hay_bale', -28, cz - 6, { yaw: 0.3, collision: 'circle', collisionRadius: 0.7 }),
    place('lantern_post', -30, cz + 6, { collision: 'circle', collisionRadius: 0.4 }),

    // Der Übungsplatz beim Kampfmeister, im Norden der Stadt. Er selbst steht
    // **neben** dem Zaun und nicht darin: wer ihn ansprechen will, klickt sonst
    // auf ein Zaunfeld, und der Klick geht ins Holz statt zum Meister.
    ...fenceRect('fence_wood', 12, cz + 22, 8, 6),
    place('hay_bale', 9, cz + 20, { yaw: 1.4, collision: 'circle', collisionRadius: 0.7 }),
    place('hay_bale', 15, cz + 24, { yaw: 2.8, collision: 'circle', collisionRadius: 0.7 }),
    place('crate', 17.5, cz + 19, { yaw: 0.4, collision: 'circle', collisionRadius: 0.6 }),

    // Ein Hain am Südrand, damit die Mauer nicht nackt in der Landschaft steht.
    place('tree_broad', -34, cz - 34, { scale: 1.3, collision: 'circle', collisionRadius: 1.4 }),
    place('tree_broad', -26, cz - 40, { scale: 1.1, collision: 'circle', collisionRadius: 1.3 }),
    place('tree_pine', 30, cz - 36, { scale: 1.2, collision: 'circle', collisionRadius: 1.1 }),
    place('tree_pine', 38, cz - 30, { scale: 1.35, collision: 'circle', collisionRadius: 1.2 }),
    place('tree_fir', 34, cz - 42, { scale: 1.1, collision: 'circle', collisionRadius: 1.0 }),
    place('bush', -20, cz - 42, { scale: 1.2 }),
    place('bush', 22, cz - 44, { scale: 1.1 }),
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
    place('pillar', -9, b - 8, { scale: 0.8, collision: 'circle', collisionRadius: 0.9 }),
    place('pillar', 9, b - 8, { scale: 0.8, collision: 'circle', collisionRadius: 0.9 }),
    place('pillar', -9, b + 8, { scale: 0.8, collision: 'circle', collisionRadius: 0.9 }),
    place('pillar', 9, b + 8, { scale: 0.8, collision: 'circle', collisionRadius: 0.9 }),
    place('lantern_post', -9, b, { collision: 'circle', collisionRadius: 0.4 }),
    place('lantern_post', 9, b, { collision: 'circle', collisionRadius: 0.4 }),
  ]);

  const strasse = [
    ...lanternRoad([0, cz + mauerHalb + 6], [0, 186], { abstand: 26, seite: 6.5 }),

    // Wegweiser an den Abschnittsgrenzen. Sie sagen nichts — sie markieren.
    place('signpost', 5.5, -60, { yaw: 0.4 }),
    place('signpost', -5.5, 0, { yaw: 2.9 }),
    place('signpost', 5.5, 60, { yaw: 0.4 }),
    place('signpost', -5.5, 120, { yaw: 2.9 }),
    place('signpost', 5.5, 170, { yaw: 0.4 }),

    // Die Brücken über die Silberader. Zwei Geländer und vier Pfeiler je
    // Übergang — mehr braucht es nicht, damit man sieht, wo man hinüberkommt.
    ...brueckenbau,

    // Das Tor nach Dornwald: ein Grenzposten und kein Kreis im Gras.
    ...fenceRun('fence_stone', [-16, 190], [-6, 190]),
    ...fenceRun('fence_stone', [6, 190], [16, 190]),
    place('banner', -7.5, 191.5, { yaw: 3.14 }),
    place('banner', 7.5, 191.5, { yaw: 3.14 }),
    place('brazier', -12, 186, { collision: 'circle', collisionRadius: 0.6 }),
    place('brazier', 12, 186, { collision: 'circle', collisionRadius: 0.6 }),
  ];

  /*
   * --- Die Lager der Nebenquestgeber --------------------------------------
   *
   * Wer draussen steht, steht nicht im Nichts: ein Feuer, eine Kiste, ein
   * Zaunstück. Ohne das sieht ein NPC auf der Wiese aus, als sei er verloren
   * gegangen.
   */
  const lager = [
    // Kräuterfrau.
    place('brazier', -21, -49, { collision: 'circle', collisionRadius: 0.6 }),
    place('crate', -27, -44, { yaw: 0.8, collision: 'circle', collisionRadius: 0.6 }),
    place('mushroom_large', -29, -50, { scale: 1.2 }),
    place('mushroom_large', -19, -54, { scale: 0.9 }),

    // Hirte.
    ...fenceRect('fence_wood', 30, 16, 10, 7),
    place('hay_bale', 27, 12, { yaw: 0.6, collision: 'circle', collisionRadius: 0.7 }),
    place('hay_bale', 33, 20, { yaw: 2.2, collision: 'circle', collisionRadius: 0.7 }),

    // Fährmann am Ufer.
    place('barrel', -15, 62, { yaw: 0.4, collision: 'circle', collisionRadius: 0.5 }),
    place('crate', -9, 62, { yaw: 1.6, collision: 'circle', collisionRadius: 0.6 }),
    place('lantern_post', -14, 70, { collision: 'circle', collisionRadius: 0.4 }),

    // Jäger.
    place('brazier', 31, 108, { collision: 'circle', collisionRadius: 0.6 }),
    place('tree_dead', 39, 116, { scale: 1.2, collision: 'circle', collisionRadius: 0.9 }),
    place('crate', 37, 106, { yaw: 2.4, collision: 'circle', collisionRadius: 0.6 }),

    // Kartograf.
    place('brazier', -35, 154, { collision: 'circle', collisionRadius: 0.6 }),
    place('signpost', -42, 160, { yaw: 1.6 }),
    place('crate', -41, 152, { yaw: 0.9, collision: 'circle', collisionRadius: 0.6 }),
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
    collision: 'plattform',
    collisionRadius: gross ? 9 : 5.5,
  });

  const schweber = [
    // Eine Treppe aus Steinen über der Wiese: von niedrig nach hoch, damit man
    // sie auch mit dem langsamen Besen erreicht.
    schwebfels(-46, 26, -8, false),
    schwebfels(-58, 34, 18),
    schwebfels(-40, 42, 44, false),
    // Ein Paar über dem Fluss — von dort sieht man die Silberader entlang.
    schwebfels(24, 30, 74),
    schwebfels(44, 38, 96, false),
    // Und drei hohe im Norden, über dem Geröll.
    schwebfels(-24, 46, 138),
    schwebfels(52, 52, 158, false),
    schwebfels(6, 58, 182),
  ];

  const gesetzt = [...stadt, ...strasse, ...lager];

  const keepOut = [
    { x: 0, z: cz + 4, r: 40 },
    ...npcs.map((n) => ({ x: n.position[0], z: n.position[1], r: 8 })),
    ...portals.map((p) => ({ x: p.position[0], z: p.position[1], r: 14 })),
    ...spawners.map((s) => ({ x: s.position[0], z: s.position[1], r: s.radius * 0.4 })),
    ...keepOutOf(gesetzt, 4),
    // Die Strasse bleibt frei. Ein Baum mitten auf dem Weg ist kein Wald,
    // sondern ein Hindernis, um das jeder zweimal am Tag herumläuft.
    ...Array.from({ length: 40 }, (_, i) => ({ x: 0, z: -70 + i * 7, r: 7 })),
  ];

  /** Innerhalb des Streifens, nicht im Fluss und nicht in der Stadt. */
  const frei = (x, z) =>
    Math.abs(x) < LM.x - 4 &&
    z > LM.zSued + 6 &&
    z < LM.zNord - 4 &&
    flussAbstand(x, z) > 15 &&
    Math.hypot(x, z - cz) > LM.stadtR + 10;

  const wiese = { x0: -LM.x + 4, x1: LM.x - 4, z0: -74, z1: LM.zNord - 6 };
  const sueden = { x0: -LM.x + 4, x1: LM.x - 4, z0: LM.zSued + 8, z1: -70 };

  const props = [
    ...gesetzt,
    ...schweber,

    // --- Wald: dicht im Süden, licht und tot im Norden --------------------
    ...scatter(rng, {
      count: 240,
      size,
      bereich: wiese,
      erlaubt: frei,
      minGap: 8,
      scaleRange: [0.8, 1.5],
      models: [
        { key: 'tree_pine', collision: 'circle', collisionRadius: 1.1 },
        { key: 'tree_broad', collision: 'circle', collisionRadius: 1.4 },
        // Die Tanne ist höher und schmaler als die Fichte. Ein Wald aus einer
        // Sorte sieht aus wie ein Wald aus Kopien; erst die zweite Nadelform
        // gibt der Ferne eine unruhige Kante.
        { key: 'tree_fir', collision: 'circle', collisionRadius: 1.0 },
      ],
      keepOut,
      tints: [0x4f8a3e, 0x5f9a4a, 0x437a36, 0x6aa855],
    }),
    ...scatter(rng, {
      count: 120,
      size,
      bereich: sueden,
      erlaubt: frei,
      minGap: 9,
      scaleRange: [0.9, 1.6],
      models: [
        { key: 'tree_broad', collision: 'circle', collisionRadius: 1.4 },
        { key: 'tree_pine', collision: 'circle', collisionRadius: 1.1 },
        { key: 'tree_fir', collision: 'circle', collisionRadius: 1.0 },
      ],
      keepOut,
      tints: [0x5f9a4a, 0x6aa855, 0x74b45e],
    }),
    // Totholz nur im Norden: ab hier wird es unwirtlich, und das soll man
    // sehen, bevor man das erste Monster trifft.
    ...scatter(rng, {
      count: 90,
      size,
      bereich: { x0: -LM.x + 6, x1: LM.x - 6, z0: 118, z1: LM.zNord - 6 },
      erlaubt: frei,
      minGap: 7,
      scaleRange: [0.8, 1.4],
      models: [{ key: 'tree_dead', collision: 'circle', collisionRadius: 0.9 }],
      keepOut,
    }),

    // --- Fels und Geröll --------------------------------------------------
    ...scatter(rng, {
      count: 130,
      size,
      bereich: wiese,
      erlaubt: frei,
      minGap: 6,
      scaleRange: [0.6, 1.7],
      models: [
        { key: 'rock_small', collision: 'circle', collisionRadius: 0.8 },
        { key: 'rock_large', collision: 'circle', collisionRadius: 1.9 },
      ],
      keepOut,
    }),
    // Geröllfeld im Norden — dichter, grösser.
    ...scatter(rng, {
      count: 90,
      size,
      bereich: { x0: -LM.x + 6, x1: LM.x - 6, z0: 130, z1: LM.zNord - 6 },
      erlaubt: frei,
      minGap: 5,
      scaleRange: [0.9, 2.2],
      models: [
        { key: 'rock_large', collision: 'circle', collisionRadius: 1.9 },
        { key: 'rock_small', collision: 'circle', collisionRadius: 0.8 },
      ],
      keepOut,
    }),

    // --- Unterholz --------------------------------------------------------
    ...scatter(rng, {
      count: 420,
      size,
      bereich: { x0: -LM.x + 3, x1: LM.x - 3, z0: LM.zSued + 8, z1: LM.zNord - 4 },
      erlaubt: (x, z) => flussAbstand(x, z) > 13 && Math.hypot(x, z - cz) > LM.stadtR + 4,
      minGap: 4,
      scaleRange: [0.7, 1.4],
      models: [{ key: 'bush' }, { key: 'grass_tuft' }, { key: 'grass_tuft' }, { key: 'stump' }],
      keepOut: keepOut.map((k) => ({ ...k, r: k.r * 0.5 })),
    }),
    // Pilze im feuchten Süden, Kristalle im kalten Norden. Zwei Sorten
    // Kleinkram, die dem Auge sagen, wo es gerade steht.
    ...scatter(rng, {
      count: 70,
      size,
      bereich: { x0: -LM.x + 6, x1: LM.x - 6, z0: LM.zSued + 10, z1: 40 },
      erlaubt: frei,
      minGap: 5,
      scaleRange: [0.7, 1.5],
      models: [{ key: 'mushroom_large' }],
      keepOut: keepOut.map((k) => ({ ...k, r: k.r * 0.6 })),
    }),
    ...scatter(rng, {
      count: 45,
      size,
      bereich: { x0: -LM.x + 6, x1: LM.x - 6, z0: 140, z1: LM.zNord - 6 },
      erlaubt: frei,
      minGap: 7,
      scaleRange: [0.8, 1.6],
      models: [{ key: 'crystal' }],
      keepOut: keepOut.map((k) => ({ ...k, r: k.r * 0.6 })),
    }),
    // Und ein Saum aus Schilf und Büschen entlang der Ufer: der Fluss soll
    // eine Kante haben und nicht wie ein Schnitt in der Wiese aussehen.
    ...scatter(rng, {
      count: 160,
      size,
      bereich: { x0: -LM.x + 4, x1: LM.x - 4, z0: LM.zSued + 10, z1: LM.zNord - 6 },
      erlaubt: (x, z) => {
        const d = flussAbstand(x, z);
        return d > 12.5 && d < 19 && Math.hypot(x, z - cz) > LM.stadtR + 8;
      },
      minGap: 3.5,
      scaleRange: [0.8, 1.5],
      models: [{ key: 'grass_tuft' }, { key: 'bush' }],
      keepOut: keepOut.map((k) => ({ ...k, r: k.r * 0.5 })),
    }),
  ].map((p, i) => ({ ...p, id: `p_${String(i + 1).padStart(4, '0')}` }));

  /*
   * --- Die Sperren am Rand -------------------------------------------------
   *
   * Vier Streifen, die alles ausserhalb des begehbaren Rechtecks dichtmachen —
   * zu Fuss **und** in der Luft. Die Berge davor sind das Bild, die Zonen sind
   * die Regel: ein Gebirge allein hielte niemanden auf, der ein Fluggerät hat,
   * und dahinter liegt nichts als der Rand der Welt.
   */
  const halb = size * 0.5;
  const zonen = [
    {
      id: 'z_0001',
      label: 'Westgrat',
      position: [-(halb + LM.x) * 0.5, 0],
      extent: [(halb - LM.x) * 0.5, halb],
      keinLauf: true,
      keinFlug: true,
    },
    {
      id: 'z_0002',
      label: 'Ostgrat',
      position: [(halb + LM.x) * 0.5, 0],
      extent: [(halb - LM.x) * 0.5, halb],
      keinLauf: true,
      keinFlug: true,
    },
    {
      id: 'z_0003',
      label: 'Südwall',
      position: [0, -(halb + -LM.zSued) * 0.5 - 0],
      extent: [halb, (halb + LM.zSued) * 0.5],
      keinLauf: true,
      keinFlug: true,
    },
    {
      id: 'z_0004',
      label: 'Nordwall',
      position: [0, (halb + LM.zNord) * 0.5],
      extent: [halb, (halb - LM.zNord) * 0.5],
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
      ambientColor: 0xc2d8ea,
      ambientIntensity: 1.2,
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
      sculpt: baueSculpt(size, lichtmoorHoehe),
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

function dornwald() {
  const rng = mulberry32(0x444f_524e);
  const size = 512;

  const npcs = [{ id: 'n_gate_back', def: 'npc_gatekeeper', position: [4, -178], yaw: 0 }];

  const portals = [
    {
      id: 'g_lichtmoor',
      position: [0, -186],
      yaw: 3.14159,
      radius: 4,
      label: 'Lichtmoor',
      // Zehn Einheiten vor dem Tor nach Dornwald, nicht darin — sonst reist man
      // nach Ablauf der Sperre sofort wieder zurück.
      target: { map: 'lichtmoor', x: 0, z: 184, yaw: 3.14159 },
      minLevel: 0,
    },
    {
      id: 'g_gruft',
      position: [96, 148],
      yaw: -0.9,
      radius: 4.5,
      label: 'Schattengruft',
      target: { map: 'gruft_01', x: 0, z: -96, yaw: 0 },
      minLevel: 10,
    },
  ];

  const spawners = [
    { id: 's_boar_a', mob: 'thistle_boar', position: [-58, -60], radius: 30, count: 7, respawnMs: 75000 },
    { id: 's_boar_b', mob: 'thistle_boar', position: [64, -20], radius: 30, count: 7, respawnMs: 75000 },
    { id: 's_bandit_a', mob: 'bandit_scout', position: [-40, 60], radius: 28, count: 6, respawnMs: 75000 },
    { id: 's_bandit_b', mob: 'bandit_scout', position: [30, 110], radius: 28, count: 6, respawnMs: 75000 },
    { id: 's_bandit_c', mob: 'bandit_scout', position: [110, 60], radius: 26, count: 5, respawnMs: 75000 },
  ];

  // Dornwald ist nicht bewohnt, sondern durchzogen: ein Grenzposten am Tor,
  // ein Banditenlager mittendrin und Licht nur da, wo jemand welches
  // aufgestellt hat. Deshalb keine Laternenreihe wie in Lichtmoor — die paar
  // Lichter sollen im Dunkeln als Ziel wirken, nicht als Beleuchtung.
  const gesetzt = [
    // Grenzposten am Rueckportal.
    ...fenceRun('fence_stone', [-13, -182], [-5, -182]),
    ...fenceRun('fence_stone', [5, -182], [13, -182]),
    place('lantern_post', -7, -176, { collision: 'circle', collisionRadius: 0.4 }),
    place('lantern_post', 7, -176, { collision: 'circle', collisionRadius: 0.4 }),
    place('banner', -9.5, -180, { yaw: 0 }),
    place('crate', 9, -174, { yaw: 0.4, collision: 'circle', collisionRadius: 0.6 }),
    place('barrel', 10.4, -175.6, { yaw: 1.3, collision: 'circle', collisionRadius: 0.5 }),

    // Banditenlager. Der Zaun ist ein Stueckwerk, kein Gehege — drei Laeufe,
    // die nicht schliessen.
    ...fenceRun('fence_wood', [-50, 52], [-38, 52]),
    ...fenceRun('fence_wood', [-50, 52], [-50, 62]),
    ...fenceRun('fence_wood', [-36, 60], [-36, 68]),
    place('lantern_post', -44, 58, { collision: 'circle', collisionRadius: 0.4 }),
    place('lantern_post', -38, 64, { collision: 'circle', collisionRadius: 0.4 }),
    place('crate', -46, 56, { yaw: 0.8, collision: 'circle', collisionRadius: 0.6 }),
    place('crate', -44.8, 57.2, { yaw: 2.1, scale: 0.9 }),
    place('barrel', -42.5, 55, { yaw: 0.3, collision: 'circle', collisionRadius: 0.5 }),
    place('barrel', -41.2, 56.4, { yaw: 1.7, collision: 'circle', collisionRadius: 0.5 }),
    place('hay_bale', -47, 61, { yaw: 1.1, collision: 'circle', collisionRadius: 0.7 }),
    place('banner', -42, 60, { yaw: 2.2 }),

    // Wegkreuzung zwischen den Sauen — zwei Laternen und ein umgeworfenes Fass.
    place('lantern_post', 2, 8, { collision: 'circle', collisionRadius: 0.4 }),
    place('lantern_post', 6, 30, { collision: 'circle', collisionRadius: 0.4 }),
    place('barrel', 4.2, 18.5, { yaw: 0.9, collision: 'circle', collisionRadius: 0.5 }),

    // Vor der Gruft. Hier soll das Licht warnen, nicht einladen.
    place('lantern_post', 88, 142, { collision: 'circle', collisionRadius: 0.4 }),
    place('lantern_post', 100, 140, { collision: 'circle', collisionRadius: 0.4 }),
    ...fenceRun('fence_stone', [84, 136], [92, 136]),
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
      count: 340,
      size,
      minGap: 7,
      scaleRange: [0.9, 1.7],
      models: [
        { key: 'tree_pine', collision: 'circle', collisionRadius: 1.2 },
        { key: 'tree_dead', collision: 'circle', collisionRadius: 0.9 },
        { key: 'tree_broad', collision: 'circle', collisionRadius: 1.5 },
        { key: 'tree_fir', collision: 'circle', collisionRadius: 1.0 },
      ],
      keepOut,
      tints: [0x3c6b33, 0x2f5a2b, 0x486f3a, 0x59503c],
    }),
    ...scatter(rng, {
      count: 80,
      size,
      minGap: 8,
      scaleRange: [0.7, 2.0],
      models: [
        { key: 'rock_large', collision: 'circle', collisionRadius: 2.1 },
        { key: 'rock_small', collision: 'circle', collisionRadius: 0.9 },
      ],
      keepOut,
    }),
    ...scatter(rng, {
      count: 180,
      size,
      minGap: 4.5,
      scaleRange: [0.7, 1.4],
      models: [{ key: 'bush' }, { key: 'stump' }, { key: 'mushroom_large' }],
      keepOut: keepOut.map((k) => ({ ...k, r: k.r * 0.5 })),
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
      ambientColor: 0x76889a,
      ambientIntensity: 1.05,
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
    // Nicht auf dem Rueckportal bei (0, -186): wer dort gespeichert hat,
    // wuerde beim Anmelden sofort weiterbefoerdert.
    spawn: { x: 0, z: -178, yaw: 0 },
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
      target: { map: 'dornwald', x: 96, z: 140, yaw: 3.14159 },
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
    place('lantern_post', -6, -86, { collision: 'circle', collisionRadius: 0.4 }),
    place('lantern_post', 6, -86, { collision: 'circle', collisionRadius: 0.4 }),
    place('crate', -8.5, -92, { yaw: 0.6, collision: 'circle', collisionRadius: 0.6 }),
    place('barrel', 8.2, -91, { yaw: 1.4, collision: 'circle', collisionRadius: 0.5 }),

    ...lanternRoad([-4, -70], [-14, 0], { abstand: 26, seite: 5 }),
    ...lanternRoad([12, 0], [4, 70], { abstand: 26, seite: 5 }),

    // Der Vorraum des Waerters: Mauerreste und zwei Laternen als Rahmen.
    ...fenceRun('fence_stone', [-12, 80], [-4, 80]),
    ...fenceRun('fence_stone', [4, 80], [12, 80]),
    place('lantern_post', -7, 84, { collision: 'circle', collisionRadius: 0.4 }),
    place('lantern_post', 7, 84, { collision: 'circle', collisionRadius: 0.4 }),
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
        { key: 'pillar', collision: 'circle', collisionRadius: 1.3 },
        { key: 'rock_large', collision: 'circle', collisionRadius: 2.0 },
      ],
      keepOut,
    }),
    ...scatter(rng, {
      count: 60,
      size,
      minGap: 5,
      scaleRange: [0.7, 1.5],
      models: [{ key: 'crystal' }, { key: 'mushroom_large' }, { key: 'rock_small' }],
      keepOut,
      tints: [0x7fd8e8, 0x9a7fe8, 0x6fb4d8],
    }),
    ...scatter(rng, {
      count: 22,
      size,
      minGap: 14,
      scaleRange: [1, 1],
      models: [{ key: 'brazier' }],
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
