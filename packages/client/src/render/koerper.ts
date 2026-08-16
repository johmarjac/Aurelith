/**
 * Der Grundkörper — **ein** Netz, kein Haufen Grundkörper.
 *
 * Alles andere in diesem Spiel entsteht aus zusammengesetzten Formen: ein
 * Rumpf, zwei Arme, ein Kopf, verschmolzen zu einer Geometrie. Bei einem Fels
 * ist das richtig. Bei einem Körper nicht — dort sieht man an jeder Schulter
 * die Schnittkante, und keine Zahl der Welt macht daraus einen Übergang.
 *
 * Deshalb hier ein anderer Weg, und es ist derselbe, den Modellierprogramme im
 * Grunde gehen:
 *
 *   1. **Ein Skelett.** Gelenke mit Lage und Dicke, wie ein Drahtgerüst.
 *   2. **Ein Distanzfeld daraus.** Jedes Glied ist ein Kegelstumpf mit runden
 *      Enden; verschmolzen wird **weich**, also mit einer Rundung im Übergang
 *      statt einer Kante (`weichesMin`). Eine Schulter geht damit in den Arm
 *      über.
 *   3. **Ein Netz aus dem Feld** (`baueNetz`, Surface Nets). Es ist
 *      geschlossen, gleichmässig unterteilt und hat geteilte Ecken — also
 *      weiche Normalen ohne Zutun.
 *   4. **Gewichte aus dem Skelett.** Jede Ecke hängt an den Knochen, die ihr
 *      am nächsten sind. Damit ist das Netz ein `SkinnedMesh`: es verformt
 *      sich, statt in Teile zu zerfallen.
 *
 * Was das kostet: das Feld wird auf einem Gitter abgetastet, und das dauert
 * ein paar hundert Millisekunden. Einmal je Figur, beim Bauen. Was es bringt:
 * eine Silhouette ohne Nähte, eine Verformung ohne klaffende Gelenke — und
 * eine Beschreibung, in der „schlanker" **eine Zahl** ist und nicht zwanzig.
 *
 * Die Vorlage ist der Grundkörper aus Flyff: schlank, gut fünfeinhalb Köpfe
 * hoch, spitze Ohren, weiche Schattierung, Unterwäsche. Ausdrücklich **kein**
 * Chibi — der Kopf ist gross, aber nicht ein Viertel der Figur.
 */

import * as THREE from 'three';
import { baueNetz, ellipsoidAbstand, gliedAbstand, weichesMin } from './netz.ts';
import type { CharacterRig, RigState } from './rigs.ts';

export interface KoerperConfig {
  kind: 'koerper';
  geschlecht: 'm' | 'w';
  /** Gesamthöhe in Metern. Alle Masse unten sind Anteile davon. */
  height: number;
  haut: number;
  waesche: number;
  augen: number;
  /**
   * Kantenlänge einer Gitterzelle, als Anteil der Höhe.
   *
   * Der eine Regler zwischen „grob und schnell" und „fein und teuer", und er
   * kostet quadratisch bis kubisch: 1/170 ergab vierzigtausend Dreiecke und
   * knapp drei Sekunden Bauzeit, 1/130 gut zwanzigtausend und eine. Für eine
   * Figur, die man sich einzeln ansieht, ist das die richtige Ecke; für
   * hundert Figuren auf einer Karte wäre selbst das zu viel.
   */
  feinheit?: number;
}

/** Ein Gelenk des Skeletts, in Anteilen der Gesamthöhe. */
interface Gelenk {
  name: string;
  eltern: string | null;
  /** Lage in der Ruhehaltung, in Anteilen der Höhe. */
  pos: [number, number, number];
}

/**
 * Das Skelett.
 *
 * Die Zahlen sind an der Vorlage abgemessen: Kinn bei 0,825, Schulter bei
 * 0,795, Schritt bei 0,50, Knie bei 0,275, Knöchel bei 0,055 der Gesamthöhe.
 * Das ergibt gut fünfeinhalb Kopfhöhen — schlank und langbeinig, und **nicht**
 * die vier Köpfe eines Chibi.
 *
 * Die Reihenfolge ist zugleich die der Gewichte: `skinIndex` verweist auf
 * diese Liste. Wer hier etwas einfügt, verschiebt keine Gewichte, solange er
 * hinten anfügt — und wer mittendrin einfügt, muss neu bauen. Das tut der
 * Bauer ohnehin bei jedem Aufruf.
 */
const SKELETT: readonly Gelenk[] = [
  { name: 'becken', eltern: null, pos: [0, 0.5, 0] },
  { name: 'wirbel', eltern: 'becken', pos: [0, 0.615, 0] },
  { name: 'brust', eltern: 'wirbel', pos: [0, 0.72, 0] },
  { name: 'hals', eltern: 'brust', pos: [0, 0.805, 0] },
  { name: 'kopf', eltern: 'hals', pos: [0, 0.85, 0] },

  { name: 'schulterR', eltern: 'brust', pos: [0.1, 0.778, 0] },
  { name: 'ellbogenR', eltern: 'schulterR', pos: [0.106, 0.6, 0] },
  { name: 'handR', eltern: 'ellbogenR', pos: [0.112, 0.44, 0] },

  { name: 'schulterL', eltern: 'brust', pos: [-0.1, 0.778, 0] },
  { name: 'ellbogenL', eltern: 'schulterL', pos: [-0.106, 0.6, 0] },
  { name: 'handL', eltern: 'ellbogenL', pos: [-0.112, 0.44, 0] },

  { name: 'hueftR', eltern: 'becken', pos: [0.048, 0.495, 0] },
  { name: 'knieR', eltern: 'hueftR', pos: [0.042, 0.275, 0] },
  { name: 'knoechelR', eltern: 'knieR', pos: [0.038, 0.055, 0] },

  { name: 'hueftL', eltern: 'becken', pos: [-0.048, 0.495, 0] },
  { name: 'knieL', eltern: 'hueftL', pos: [-0.042, 0.275, 0] },
  { name: 'knoechelL', eltern: 'knieL', pos: [-0.038, 0.055, 0] },
];

/** Ein Stück Fleisch am Skelett: Kegelstumpf zwischen zwei Punkten. */
interface Glied {
  von: [number, number, number];
  bis: [number, number, number];
  ra: number;
  rb: number;
  /** Wie weich es mit dem Rest verschmilzt. Klein heisst kantig. */
  k?: number;
}

/** Ein rundlicher Körperteil — Kopf, Brustkorb, Becken. */
interface Ballen {
  mitte: [number, number, number];
  r: [number, number, number];
  k?: number;
}

/**
 * Was den Körper ausmacht, in Anteilen der Höhe.
 *
 * Getrennt nach Gliedern und Ballen, weil beides eine andere Aufgabe hat: die
 * Glieder folgen dem Skelett und verformen sich mit, die Ballen geben Rumpf
 * und Kopf ihre Form. Und die Dicken sind das, was den Stil trägt — ein
 * Oberarm von 0,03 der Höhe ist schlank, einer von 0,05 ist kräftig.
 */
function baueFleisch(weiblich: boolean): { glieder: Glied[]; ballen: Ballen[] } {
  const armR = weiblich ? 0.028 : 0.031;
  const beinR = weiblich ? 0.046 : 0.048;
  const schulterB = weiblich ? 0.082 : 0.092;

  const glieder: Glied[] = [];
  const ballen: Ballen[] = [];

  // --- Rumpf --------------------------------------------------------------
  //
  // Drei Ballen übereinander statt eines Zylinders: Brustkorb, Taille, Becken.
  // Die Taille ist der schmalste Punkt, und sie sitzt hoch — genau daran
  // erkennt man eine jugendliche Figur.
  ballen.push({ mitte: [0, 0.72, 0], r: [schulterB * 0.88, 0.072, 0.052] });
  ballen.push({ mitte: [0, 0.625, 0], r: [0.058, 0.05, 0.042] });
  ballen.push({
    mitte: [0, 0.525, 0],
    r: [weiblich ? 0.076 : 0.07, 0.055, 0.048],
  });

  // Schultern: zwei Ballen, die den Brustkorb nach aussen fortsetzen. Ohne sie
  // sitzt der Arm an einer senkrechten Wand.
  for (const s of [-1, 1]) {
    ballen.push({ mitte: [s * schulterB * 0.8, 0.778, 0], r: [0.038, 0.036, 0.036] });
  }

  // --- Hals und Kopf ------------------------------------------------------
  glieder.push({ von: [0, 0.78, 0], bis: [0, 0.845, -0.004], ra: 0.028, rb: 0.026 });
  ballen.push({ mitte: [0, 0.898, -0.002], r: [0.053, 0.07, 0.062] });
  // Der Kiefer: ein kleinerer Ballen davor und darunter. Er zieht das Kinn
  // nach vorn und macht aus der Kugel einen Kopf.
  ballen.push({ mitte: [0, 0.862, 0.014], r: [0.04, 0.038, 0.05] });

  /*
   * Die Ohren.
   *
   * Spitz und schräg nach hinten oben — das auffälligste Merkmal der Vorlage
   * und das Einzige am Kopf, das man aus dreissig Metern noch erkennt. Sie
   * verschmelzen **härter** als der Rest (kleines `k`): mit derselben Weichheit
   * wie der Körper würden sie zu Beulen, und eine Beule ist kein Ohr.
   */
  for (const s of [-1, 1]) {
    glieder.push({
      von: [s * 0.045, 0.9, -0.012],
      bis: [s * 0.078, 0.945, -0.03],
      ra: 0.014,
      rb: 0.002,
      k: 0.006,
    });
  }

  // --- Arme ---------------------------------------------------------------
  for (const s of [-1, 1]) {
    glieder.push({
      von: [s * (schulterB + 0.012), 0.778, 0],
      bis: [s * 0.106, 0.6, 0],
      ra: armR,
      rb: armR * 0.82,
    });
    glieder.push({
      von: [s * 0.106, 0.6, 0],
      bis: [s * 0.112, 0.44, 0],
      ra: armR * 0.82,
      rb: armR * 0.6,
    });
    // Die Hand: ein kurzes, flaches Stück. Finger wären bei dieser Feinheit
    // ein Klumpen — die Vorlage deutet sie ebenfalls nur an.
    // Die Hand: kurz, flach und **breiter** als das Handgelenk. Ohne die
    // Verbreiterung läuft der Arm einfach spitz aus, und es fehlt genau das
    // Stück, an dem man später einen Griff festmacht.
    glieder.push({
      von: [s * 0.112, 0.44, 0],
      bis: [s * 0.114, 0.4, 0.006],
      ra: armR * 0.66,
      rb: armR * 0.72,
      k: 0.008,
    });
  }

  // --- Beine --------------------------------------------------------------
  for (const s of [-1, 1]) {
    glieder.push({
      von: [s * 0.048, 0.5, 0],
      bis: [s * 0.042, 0.275, 0],
      ra: beinR,
      rb: beinR * 0.62,
    });
    glieder.push({
      von: [s * 0.042, 0.275, 0],
      bis: [s * 0.038, 0.058, 0],
      ra: beinR * 0.62,
      rb: beinR * 0.4,
    });
    // Die Wade sitzt hinten und oben am Unterschenkel — ein Bein ohne sie ist
    // ein Stock.
    glieder.push({
      von: [s * 0.041, 0.24, -0.008],
      bis: [s * 0.039, 0.16, -0.004],
      ra: beinR * 0.5,
      rb: beinR * 0.34,
    });
    // Der Fuss, nach vorn.
    glieder.push({
      von: [s * 0.038, 0.05, -0.012],
      bis: [s * 0.038, 0.022, 0.062],
      ra: 0.028,
      rb: 0.021,
    });
  }

  return { glieder, ballen };
}

/** Mischt zwei Farben. */
function mische(a: number, b: number, t: number): number {
  const s = Math.max(0, Math.min(1, t));
  const r = Math.round(((a >> 16) & 0xff) * (1 - s) + ((b >> 16) & 0xff) * s);
  const g = Math.round(((a >> 8) & 0xff) * (1 - s) + ((b >> 8) & 0xff) * s);
  const bl = Math.round((a & 0xff) * (1 - s) + (b & 0xff) * s);
  return (r << 16) | (g << 8) | bl;
}

/**
 * Baut den Grundkörper.
 *
 * Das Ergebnis ist ein `SkinnedMesh` samt Skelett, verpackt als `CharacterRig`
 * — von aussen also dasselbe wie jede andere Figur, und in der Modellschau wie
 * im Spiel gleich zu behandeln.
 */
export function baueKoerper(cfg: KoerperConfig, material: THREE.Material): CharacterRig {
  const h = cfg.height;
  const weiblich = cfg.geschlecht === 'w';
  const { glieder, ballen } = baueFleisch(weiblich);

  /*
   * Das Feld.
   *
   * Alle Teile weich vereinigt. `k` ist die Breite des Übergangs: zwei
   * Hundertstel der Höhe, also gut drei Zentimeter — genug, dass eine Schulter
   * rund in den Arm läuft, und wenig genug, dass ein Handgelenk noch ein
   * Handgelenk ist. Wer hier eine Null einsetzt, bekommt die Schnittkanten
   * zurück, wegen derer diese Datei überhaupt existiert.
   */
  /*
   * Zwei Hundertstel der Höhe waren zu viel.
   *
   * Beim ersten Anlauf verschmolzen die Oberarme mit dem Brustkorb bis
   * hinunter zur Taille: das Übergangsband ist doppelt so breit wie sein
   * Parameter, und drei Zentimeter beidseitig sind mehr als der Abstand
   * zwischen Arm und Rippen. Bei 1,3 Hundertsteln bleibt die Achsel eine
   * Achsel, und die Schulter rundet trotzdem.
   */
  const kStandard = 0.013 * h;
  const feld = (x: number, y: number, z: number): number => {
    let d = 1e9;
    for (const g of ballen) {
      const e = ellipsoidAbstand(
        x, y, z,
        g.mitte[0] * h, g.mitte[1] * h, g.mitte[2] * h,
        g.r[0] * h, g.r[1] * h, g.r[2] * h,
      );
      d = weichesMin(d, e, g.k ?? kStandard);
    }
    for (const g of glieder) {
      const e = gliedAbstand(
        x, y, z,
        g.von[0] * h, g.von[1] * h, g.von[2] * h,
        g.bis[0] * h, g.bis[1] * h, g.bis[2] * h,
        g.ra * h, g.rb * h,
      );
      d = weichesMin(d, e, g.k ?? kStandard);
    }
    return d;
  };

  const schritt = h * (cfg.feinheit ?? 1 / 130);
  const geo = baueNetz(feld, {
    // Grosszügig, aber nicht masslos: der Kasten bestimmt, wie viele Punkte
    // abgetastet werden, und das ist der teure Teil.
    min: [-0.2 * h, -0.02 * h, -0.14 * h],
    max: [0.2 * h, 1.02 * h, 0.16 * h],
    schritt,
  });

  // -------------------------------------------------------------------------
  // Farben
  // -------------------------------------------------------------------------

  const pos = geo.attributes.position as THREE.BufferAttribute;
  const farben = new Float32Array(pos.count * 3);
  const hautDunkel = mische(cfg.haut, 0x000000, 0.12);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i) / h;
    const z = pos.getZ(i);
    let farbe = cfg.haut;

    /*
     * Die Unterwäsche: ein Band um Hüfte und Schrittansatz.
     *
     * Über die **Lage** gefärbt und nicht als eigenes Teil. Ein zweites Netz
     * darüber wäre die Rückkehr zu dem, was hier gerade abgeschafft wurde —
     * und es würde bei jeder Bewegung durch den Körper schneiden.
     */
    if (y > 0.452 && y < 0.588) {
      const rand = Math.min(y - 0.452, 0.588 - y) / 0.02;
      farbe = mische(farbe, cfg.waesche, Math.min(1, rand));
    }
    if (weiblich && y > 0.688 && y < 0.742) {
      const rand = Math.min(y - 0.688, 0.742 - y) / 0.012;
      farbe = mische(farbe, cfg.waesche, Math.min(1, rand));
    }

    // --- Gesicht -----------------------------------------------------------
    //
    // Nur vorn am Kopf, und mit weichem Rand: bei knapp einem Zentimeter
    // Gitterweite deckt ein Auge drei Ecken ab. Eine harte Kante sähe aus wie
    // ein Aufkleber, ein Verlauf wie ein Auge in der Ferne. Richtig wäre eine
    // Textur — die braucht aber eine ausgerollte Fläche, und die ist der
    // nächste Schritt, nicht dieser.
    if (z > 0.01 && y > 0.85 && y < 0.94) {
      const ax = Math.abs(x) / h;
      const augeD = Math.hypot((ax - 0.023) / 0.02, (y - 0.898) / 0.013);
      if (augeD < 1.35) {
        farbe = mische(farbe, cfg.augen, Math.min(1, (1.35 - augeD) * 1.6));
      }
      const braueD = Math.hypot((ax - 0.024) / 0.026, (y - 0.921) / 0.005);
      if (braueD < 1.2) {
        farbe = mische(farbe, 0x5a4030, Math.min(0.8, (1.2 - braueD) * 1.4));
      }
      const mundD = Math.hypot(ax / 0.014, (y - 0.867) / 0.004);
      if (mundD < 1.3) {
        farbe = mische(farbe, 0xc4736e, Math.min(0.7, (1.3 - mundD) * 1.2));
      }
    }

    /*
     * Und ein Hauch Tiefe unter den Achseln und zwischen den Beinen.
     *
     * Eine Fläche in genau einer Farbe sieht flach aus, egal wie gut die Form
     * ist — das Licht allein trennt zwei Rundungen nicht, die dicht
     * beieinanderliegen. Ein Dunkeln in den Falten übernimmt, was sonst eine
     * Umgebungsverdeckung täte, und kostet nichts.
     */
    if (y > 0.42 && y < 0.52 && Math.abs(x) < 0.03 * h) {
      farbe = mische(farbe, hautDunkel, 1 - Math.abs(x) / (0.03 * h));
    }

    farben[i * 3] = ((farbe >> 16) & 0xff) / 255;
    farben[i * 3 + 1] = ((farbe >> 8) & 0xff) / 255;
    farben[i * 3 + 2] = (farbe & 0xff) / 255;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(farben, 3));

  // -------------------------------------------------------------------------
  // Knochen und Gewichte
  // -------------------------------------------------------------------------

  const knochen: THREE.Bone[] = [];
  const nachName = new Map<string, THREE.Bone>();
  for (const g of SKELETT) {
    const b = new THREE.Bone();
    b.name = g.name;
    nachName.set(g.name, b);
    knochen.push(b);
  }
  for (const g of SKELETT) {
    const b = nachName.get(g.name)!;
    const eltern = g.eltern ? nachName.get(g.eltern)! : undefined;
    const e = g.eltern ? SKELETT.find((x) => x.name === g.eltern)!.pos : [0, 0, 0];
    // Knochen sitzen **relativ** zu ihrem Vater. Absolut gesetzt stünde jeder
    // an der richtigen Stelle, bis sich der erste dreht — dann bliebe der Rest
    // stehen, wo er war.
    b.position.set((g.pos[0] - e[0]) * h, (g.pos[1] - e[1]) * h, (g.pos[2] - e[2]) * h);
    if (eltern) eltern.add(b);
  }
  const wurzel = nachName.get('becken')!;
  wurzel.updateMatrixWorld(true);

  /*
   * Die Gewichte.
   *
   * Für jede Ecke die vier nächsten Knochen, gewichtet mit dem Kehrwert ihres
   * Abstands hoch drei. Das ist nicht die Kunst der grossen Werkzeuge — die
   * lösen dafür eine Wärmeleitungsgleichung —, aber es genügt für einen
   * Körper ohne Kleidung: der Abstand zum Knochen ist hier fast überall auch
   * das, was man meint.
   *
   * Gemessen wird zum **Knochenstück** und nicht zu seinem Anfangspunkt: sonst
   * hinge die Mitte eines Oberschenkels zu gleichen Teilen an Hüfte und Knie,
   * und beim Beugen zöge es sie in die Mitte zwischen beiden.
   */
  const stuecke = SKELETT.map((g) => {
    const kinder = SKELETT.filter((x) => x.eltern === g.name);
    const ziel = kinder.length > 0 ? kinder[0]!.pos : g.pos;
    return {
      ax: g.pos[0] * h,
      ay: g.pos[1] * h,
      az: g.pos[2] * h,
      bx: ziel[0] * h,
      by: ziel[1] * h,
      bz: ziel[2] * h,
    };
  });

  const skinIndex = new Uint16Array(pos.count * 4);
  const skinWeight = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    const beste: Array<{ idx: number; w: number }> = [];
    for (let b = 0; b < stuecke.length; b++) {
      const s = stuecke[b]!;
      const dx = s.bx - s.ax;
      const dy = s.by - s.ay;
      const dz = s.bz - s.az;
      const lq = dx * dx + dy * dy + dz * dz;
      const t = lq > 1e-9
        ? Math.max(0, Math.min(1, ((px - s.ax) * dx + (py - s.ay) * dy + (pz - s.az) * dz) / lq))
        : 0;
      const d = Math.hypot(px - (s.ax + dx * t), py - (s.ay + dy * t), pz - (s.az + dz * t));
      beste.push({ idx: b, w: 1 / (d * d * d + 1e-6) });
    }
    beste.sort((a, b) => b.w - a.w);
    let summe = 0;
    for (let n = 0; n < 4; n++) summe += beste[n]!.w;
    for (let n = 0; n < 4; n++) {
      skinIndex[i * 4 + n] = beste[n]!.idx;
      skinWeight[i * 4 + n] = beste[n]!.w / summe;
    }
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));

  const root = new THREE.Object3D();
  const netz = new THREE.SkinnedMesh(geo, material);
  netz.add(wurzel);
  netz.bind(new THREE.Skeleton(knochen));
  root.add(netz);

  const knochenVon = (name: string): THREE.Bone => nachName.get(name)!;
  const becken = knochenVon('becken');
  const wirbel = knochenVon('wirbel');
  const brust = knochenVon('brust');
  const kopf = knochenVon('kopf');
  const schulterR = knochenVon('schulterR');
  const schulterL = knochenVon('schulterL');
  const ellbogenR = knochenVon('ellbogenR');
  const ellbogenL = knochenVon('ellbogenL');
  const hueftR = knochenVon('hueftR');
  const hueftL = knochenVon('hueftL');
  const knieR = knochenVon('knieR');
  const knieL = knochenVon('knieL');

  /*
   * Die Ruhelage der Arme.
   *
   * Im Skelett hängen sie senkrecht — das ist die Haltung, in der das Netz
   * gebaut wurde, und ein Netz muss in seiner Bauhaltung gebunden werden.
   * Danach werden sie ein Stück an den Körper gelegt: dieselbe Zahl, die die
   * Vorlage zeigt, und ohne sie steht die Figur wie ein Kreuz.
   */
  const armRuheZ = 0.06;
  const beckenY = becken.position.y;
  let schrittPhase = 0;

  return {
    root,
    update(state: RigState) {
      if (state.dead) {
        root.rotation.x = -Math.PI / 2.2;
        becken.position.y = beckenY;
        return;
      }
      root.rotation.x = 0;

      const gang = Math.min(1, state.speed / 5);
      schrittPhase += state.dt * 9 * Math.max(0.35, gang);
      const schritt = Math.sin(schrittPhase);

      let armR = -schritt * 0.6 * gang;
      let armL = schritt * 0.6 * gang;
      let armRZ = armRuheZ;
      let armLZ = -armRuheZ;
      let ellR = -0.12 - Math.max(0, -schritt) * 0.3 * gang;
      let ellL = -0.12 - Math.max(0, schritt) * 0.3 * gang;
      let rumpfDreh = 0;
      let rumpfKipp = 0;

      const beugung = state.pickupPhase >= 0 ? Math.sin(state.pickupPhase * Math.PI) : 0;
      if (beugung > 0) {
        armR = beugung * 1.5;
        armL = -beugung * 0.4;
        ellR = -0.1 - beugung * 0.3;
        rumpfKipp = beugung * 0.85;
      }

      if (state.attackPhase >= 0) {
        // Ausholen bis 0,35, dann durchziehen — hinten langsam, vorne schnell.
        const aus = Math.min(1, state.attackPhase / 0.35);
        const durch = Math.max(0, (state.attackPhase - 0.35) / 0.65);
        armR = -2.1 * aus + 3.0 * durch;
        armRZ = armRuheZ + 0.45 * aus - 0.3 * durch;
        ellR = -0.9 * aus + 0.85 * durch;
        armL = 0.45 * aus - 0.7 * durch;
        rumpfDreh = -0.45 * aus + 0.8 * durch;
      }

      const wirbelPhase = state.wirbelPhase ?? -1;
      if (wirbelPhase >= 0) {
        armR = -0.2;
        armL = -0.2;
        armRZ = 1.3;
        armLZ = -1.3;
        ellR = -0.1;
        ellL = -0.1;
        rumpfDreh += wirbelPhase * Math.PI * 2;
      }

      schulterR.rotation.set(armR, 0, armRZ);
      schulterL.rotation.set(armL, 0, armLZ);
      ellbogenR.rotation.x = ellR;
      ellbogenL.rotation.x = ellL;

      wirbel.rotation.set(rumpfKipp * 0.45, rumpfDreh * 0.4, 0);
      brust.rotation.set(rumpfKipp * 0.5, rumpfDreh * 0.6, 0);
      // Der Kopf hält dagegen: wer sich bückt, schaut nach vorn und nicht auf
      // die eigenen Füsse.
      kopf.rotation.x = -rumpfKipp * 0.55 + Math.sin(state.time * 0.7) * 0.02;

      const beinSchwung = schritt * 0.62 * gang;
      hueftR.rotation.x = beinSchwung - rumpfKipp * 0.5;
      hueftL.rotation.x = -beinSchwung - rumpfKipp * 0.5;
      knieR.rotation.x = Math.max(0, -schritt) * 0.85 * gang + beugung * 0.7;
      knieL.rotation.x = Math.max(0, schritt) * 0.85 * gang + beugung * 0.7;

      becken.position.y =
        beckenY +
        Math.abs(Math.sin(schrittPhase)) * 0.02 * h * gang +
        Math.sin(state.time * 1.7) * 0.004 * h -
        beugung * 0.09 * h;
    },
    dispose() {
      geo.dispose();
    },
  };
}
