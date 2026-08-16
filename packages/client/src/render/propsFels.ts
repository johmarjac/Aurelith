/**
 * Stein — Geröll, Platten, Nadeln, Tropfstein, Kristall.
 *
 * Alles hier trägt die Gesteinstextur (`gestein.ts`) und wird deshalb über
 * `steinKoerper` gebaut: die legt die Bildkoordinaten je Dreieck auf, mischt
 * harte und weiche Normalen und färbt aus der Normalen ein — oben Sonne, unten
 * Schatten. Wer eine Geometrie ohne diesen Schritt in die Fels-Liste einträgt,
 * bekommt einen Stein mit einer über die ganze Fläche gezogenen Kachel; das
 * sieht aus wie ein Aufkleber und nicht wie Korn.
 *
 * **Der Ursprung liegt am Boden.** Zwei Ausnahmen stehen dabei: Tropfsteine an
 * der Decke hängen nach unten und werden von Hand gesetzt (`snapToGround`
 * aus), und die schwebenden Felsen haben ihre eigene Datei.
 *
 * Die Formen sind bewusst verschieden **im Umriss**, nicht in der Grösse: ein
 * Geröllfeld, ein Findling und ein Felsblock in drei Massstäben sähen aus wie
 * dasselbe Modell dreimal. Also flach und breit, hoch und schmal, kantig und
 * gerundet — das unterscheidet man auch aus dreissig Metern.
 */

import * as THREE from 'three';
import { assemble, fuegeZusammen, type Part } from './geometry.ts';
import { gesteinsUV } from './gestein.ts';
import { knicke } from './findling.ts';

/** Deterministischer Würfel — dieselbe Karte sieht immer gleich aus. */
function wuerfel(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a ^= a << 13;
    a >>>= 0;
    a ^= a >>> 17;
    a ^= a << 5;
    a >>>= 0;
    return a / 4294967296;
  };
}

const SONNE = 0x6f6d68;
const SCHATTEN = 0x3a3a3e;

/**
 * Macht aus einer Geometrie einen Fels.
 *
 * Vier Schritte, und jeder verhindert einen bestimmten Fehler:
 * Ecken auftrennen (sonst kann die Projektion je Dreieck nicht entscheiden),
 * Bildkoordinaten aus der Weltlage (sonst ist das Korn gestreckt), Normalen
 * halb hart (sonst ist der Stein entweder Kristall oder Knetgummi) und die
 * Farbe aus der Normalen (sonst ist er eine graue Scheibe).
 */
function steinKoerper(geo: THREE.BufferGeometry, hell = SONNE, dunkel = SCHATTEN): THREE.BufferGeometry {
  geo.computeVertexNormals();
  const offen = geo.toNonIndexed();
  geo.dispose();
  gesteinsUV(offen);
  knicke(offen, 0.5);

  const nor = offen.attributes.normal as THREE.BufferAttribute;
  const anzahl = nor.count;
  const farben = new Float32Array(anzahl * 3);
  const oben = new THREE.Color(hell);
  const unten = new THREE.Color(dunkel);
  for (let i = 0; i < anzahl; i++) {
    const t = Math.max(0, Math.min(1, nor.getY(i) * 0.5 + 0.5));
    farben[i * 3] = unten.r + (oben.r - unten.r) * t;
    farben[i * 3 + 1] = unten.g + (oben.g - unten.g) * t;
    farben[i * 3 + 2] = unten.b + (oben.b - unten.b) * t;
  }
  offen.setAttribute('color', new THREE.BufferAttribute(farben, 3));
  return offen;
}

/** Ein einzelner verbeulter Klumpen — der Grundstein aller Formen hier. */
function klumpen(
  rand: () => number,
  radius: number,
  stufen: number,
  beulen: number,
  staerke: number,
): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(radius, stufen);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const richtungen = Array.from({ length: beulen }, () => ({
    r: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(),
    s: (rand() - 0.45) * staerke,
  }));
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const n = p.clone().normalize();
    let f = 1;
    for (const b of richtungen) f += b.s * Math.max(0, n.dot(b.r)) ** 3;
    p.multiplyScalar(f);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  pos.needsUpdate = true;
  return geo;
}

/** Mehrere Klumpen zu einem Prop — jeder mit eigener Lage und Streckung. */
function haufen(
  seed: number,
  stuecke: Array<{ x: number; y: number; z: number; r: number; sy?: number; sx?: number; stufen?: number }>,
): THREE.BufferGeometry {
  const rand = wuerfel(seed);
  const teile: THREE.BufferGeometry[] = [];
  for (const s of stuecke) {
    const g = klumpen(rand, s.r, s.stufen ?? 1, 4, 0.6);
    g.scale(s.sx ?? 1, s.sy ?? 1, 1);
    g.translate(s.x, s.y, s.z);
    teile.push(g);
  }
  const roh = fuegeZusammen(teile);
  for (const t of teile) t.dispose();
  return steinKoerper(roh);
}

// --- Geröll und Blöcke ------------------------------------------------------

/** Kieselhaufen — flach, nur ein paar Zentimeter. Streuware für Wege und Ufer. */
export function baueKiesel(): THREE.BufferGeometry {
  return haufen(0x1a01, [
    { x: 0, y: 0.08, z: 0, r: 0.2, sy: 0.5 },
    { x: 0.28, y: 0.06, z: 0.14, r: 0.14, sy: 0.55 },
    { x: -0.22, y: 0.05, z: 0.2, r: 0.12, sy: 0.5 },
    { x: 0.1, y: 0.05, z: -0.26, r: 0.13, sy: 0.5 },
    { x: -0.3, y: 0.04, z: -0.14, r: 0.09, sy: 0.6 },
  ]);
}

/** Geröllfeld — dieselbe Idee eine Nummer grösser, als Fläche gedacht. */
export function baueGeroell(): THREE.BufferGeometry {
  return haufen(0x1a02, [
    { x: 0, y: 0.2, z: 0, r: 0.42, sy: 0.55 },
    { x: 0.62, y: 0.14, z: 0.3, r: 0.3, sy: 0.5 },
    { x: -0.55, y: 0.16, z: 0.42, r: 0.34, sy: 0.55 },
    { x: 0.24, y: 0.12, z: -0.6, r: 0.26, sy: 0.5 },
    { x: -0.34, y: 0.1, z: -0.5, r: 0.22, sy: 0.5 },
    { x: 0.75, y: 0.09, z: -0.2, r: 0.18, sy: 0.55 },
  ]);
}

/**
 * Eine Steinplatte.
 *
 * Sie liegt flach und ist fast eben — daraus baut der Generator Wege, Stufen
 * und die Böden von Ruinen. Deshalb hier eine Box mit gebrochenen Kanten und
 * kein Klumpen: eine Platte, die sich wellt, kann man nicht aneinanderlegen.
 */
export function baueSteinplatte(): THREE.BufferGeometry {
  const rand = wuerfel(0x1a03);
  const geo = new THREE.BoxGeometry(1.8, 0.22, 1.4, 3, 1, 3);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    // Nur die Ränder werden unruhig; die Oberseite bleibt eben, damit die
    // Platte begehbar aussieht.
    const kante = Math.abs(pos.getX(i)) > 0.8 || Math.abs(pos.getZ(i)) > 0.6 ? 1 : 0.15;
    pos.setXYZ(
      i,
      pos.getX(i) + (rand() - 0.5) * 0.14 * kante,
      pos.getY(i) + (rand() - 0.5) * 0.05 * kante,
      pos.getZ(i) + (rand() - 0.5) * 0.14 * kante,
    );
  }
  pos.needsUpdate = true;
  geo.translate(0, 0.11, 0);
  return steinKoerper(geo, 0x7a7770, 0x45443f);
}

/** Felsblock — kantig und hoch, wo ein Findling rund und flach ist. */
export function baueFelsblock(): THREE.BufferGeometry {
  const rand = wuerfel(0x1a04);
  const geo = new THREE.BoxGeometry(1.5, 2.1, 1.3, 2, 3, 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    // Nach oben schmaler: ein Block mit senkrechten Wänden ist eine Kiste.
    const f = 0.72 + 0.28 * (1 - (y + 1.05) / 2.1);
    pos.setXYZ(
      i,
      pos.getX(i) * f + (rand() - 0.5) * 0.22,
      y + (rand() - 0.5) * 0.16,
      pos.getZ(i) * f + (rand() - 0.5) * 0.22,
    );
  }
  pos.needsUpdate = true;
  geo.translate(0, 1.0, 0);
  return steinKoerper(geo);
}

/** Felsnadel — hoch und schmal. Sie gibt einer flachen Fläche eine Senkrechte. */
export function baueFelsnadel(): THREE.BufferGeometry {
  const rand = wuerfel(0x1a05);
  const geo = new THREE.CylinderGeometry(0.22, 0.9, 4.6, 7, 4);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) * (1 + (rand() - 0.5) * 0.3),
      pos.getY(i) + (rand() - 0.5) * 0.3,
      pos.getZ(i) * (1 + (rand() - 0.5) * 0.3),
    );
  }
  pos.needsUpdate = true;
  geo.translate(0, 2.3, 0);
  return steinKoerper(geo);
}

/**
 * Ein natürlicher Steinbogen.
 *
 * Kein Torbogen: der ist gebaut und hat rechte Winkel. Dieser hier ist aus
 * einem Felsen ausgewaschen, also aus Klumpen entlang eines Bogens. Er ist
 * ein Wegzeichen — man sieht ihn von weitem und weiss, wo man ist.
 */
export function baueSteinbogen(): THREE.BufferGeometry {
  const rand = wuerfel(0x1a06);
  const teile: THREE.BufferGeometry[] = [];
  /*
   * Vierzehn Klumpen und nicht neun.
   *
   * Beim ersten Anlauf lagen sie so weit auseinander, dass man jeden einzeln
   * sah: eine Kette aus Perlen statt eines Bogens. Der Abstand zwischen zwei
   * Mittelpunkten muss **kleiner** sein als ihr Radius, sonst verschmilzt
   * nichts. Bei Radius 0,8 und einem Bogen von rund neun Metern Länge sind
   * das vierzehn.
   */
  const schritte = 14;
  for (let i = 0; i <= schritte; i++) {
    const t = i / schritte;
    const w = Math.PI * t;
    const g = klumpen(rand, 0.78 + Math.sin(w) * 0.22, 1, 3, 0.4);
    // Der Bogen sitzt 0,3 m höher, als die Kurve ihn setzen würde: sonst
    // hängt der unterste Klumpen mit seinem halben Durchmesser unter dem Boden.
    g.translate(Math.cos(w) * 2.6, 0.3 + Math.sin(w) * 3.2, (rand() - 0.5) * 0.4);
    teile.push(g);
  }
  const roh = fuegeZusammen(teile);
  for (const t of teile) t.dispose();
  return steinKoerper(roh);
}

/** Hinkelstein — ein aufgerichteter Stein. Menschen haben ihn hingestellt. */
export function baueHinkelstein(): THREE.BufferGeometry {
  const rand = wuerfel(0x1a07);
  const geo = new THREE.BoxGeometry(0.9, 3.2, 0.5, 2, 4, 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) + 1.6) / 3.2;
    pos.setXYZ(
      i,
      pos.getX(i) * (1 - t * 0.25) + (rand() - 0.5) * 0.1,
      pos.getY(i),
      pos.getZ(i) * (1 - t * 0.2) + (rand() - 0.5) * 0.08,
    );
  }
  pos.needsUpdate = true;
  geo.translate(0, 1.55, 0);
  // Leicht schief: ein senkrechter Menhir sieht aus wie ein Grabstein aus dem
  // Baumarkt. Die Neigung ist das, was ihn alt aussehen lässt.
  geo.rotateZ(0.06);
  return steinKoerper(geo, 0x74716a, 0x403f3b);
}

/** Steinmann — aufeinandergelegte Platten. Ein Wegzeichen im Geröll. */
export function baueSteinmann(): THREE.BufferGeometry {
  return haufen(0x1a08, [
    { x: 0, y: 0.16, z: 0, r: 0.44, sy: 0.42 },
    { x: 0.04, y: 0.44, z: -0.03, r: 0.34, sy: 0.42 },
    { x: -0.05, y: 0.68, z: 0.04, r: 0.26, sy: 0.45 },
    { x: 0.03, y: 0.86, z: 0, r: 0.18, sy: 0.5 },
    { x: 0, y: 0.99, z: 0, r: 0.11, sy: 0.6 },
  ]);
}

/**
 * Eine Erzader.
 *
 * Ein Felsen mit hellen Einschlüssen. Sie ist der einzige Stein hier, dem man
 * ansieht, wozu er da ist — deshalb steht sie dort, wo es später etwas
 * abzubauen gäbe, und nicht als Streuware im Wald.
 */
export function baueErzader(): THREE.BufferGeometry {
  const rand = wuerfel(0x1a09);
  const fels = klumpen(rand, 1.0, 2, 5, 0.7);
  fels.scale(1.2, 0.85, 1);
  fels.translate(0, 0.7, 0);
  const stein = steinKoerper(fels, 0x625f5a, 0x333336);

  // Die Einschlüsse sitzen **auf** dem Fels und tragen die Standardfarbe —
  // sie sollen glänzen, und die Gesteinskörnung nähme ihnen genau das.
  const adern: Part[] = [];
  for (let i = 0; i < 6; i++) {
    const w = rand() * Math.PI * 2;
    const h = 0.4 + rand() * 0.8;
    adern.push({
      geometry: new THREE.OctahedronGeometry(0.1 + rand() * 0.07, 0),
      color: 0xc8b25a,
      position: [Math.sin(w) * 0.95, h, Math.cos(w) * 0.8],
      scale: [1, 0.7, 1],
    });
  }
  const gold = assemble(adern);
  const geo = fuegeZusammen([stein, gold]);
  stein.dispose();
  gold.dispose();
  return geo;
}

/** Moosstein — ein Findling mit grüner Kappe. Feuchter Wald, Nordseite. */
export function baueMoosstein(): THREE.BufferGeometry {
  const rand = wuerfel(0x1a0a);
  const fels = klumpen(rand, 0.8, 2, 5, 0.7);
  fels.scale(1.15, 0.62, 1);
  fels.translate(0, 0.4, 0);
  const stein = steinKoerper(fels, 0x6a6862, 0x37363a);
  // Das Moos ist eine flachgedrückte Halbkugel obendrauf — sichtbar von oben,
  // unsichtbar von der Seite. Genau so wächst es.
  const moos = assemble([
    {
      geometry: new THREE.IcosahedronGeometry(0.62, 1),
      color: 0x4d7a3c,
      position: [0, 0.66, 0],
      scale: [1.05, 0.3, 1.05],
    },
  ]);
  const geo = fuegeZusammen([stein, moos]);
  stein.dispose();
  moos.dispose();
  return geo;
}

// --- Tropfstein und Kristall ------------------------------------------------

/** Stalagmit — wächst vom Boden nach oben, dick unten, spitz oben. */
export function baueStalagmit(): THREE.BufferGeometry {
  const rand = wuerfel(0x1a0b);
  const teile: THREE.BufferGeometry[] = [];
  for (const [x, z, h, r] of [
    [0, 0, 1.9, 0.34],
    [0.36, 0.2, 1.1, 0.22],
    [-0.3, 0.24, 0.7, 0.16],
  ] as Array<[number, number, number, number]>) {
    const g = new THREE.ConeGeometry(r, h, 7, 3);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(
        i,
        pos.getX(i) * (1 + (rand() - 0.5) * 0.35),
        pos.getY(i),
        pos.getZ(i) * (1 + (rand() - 0.5) * 0.35),
      );
    }
    pos.needsUpdate = true;
    g.translate(x, h * 0.5, z);
    teile.push(g);
  }
  const roh = fuegeZusammen(teile);
  for (const t of teile) t.dispose();
  return steinKoerper(roh, 0x8a8378, 0x413f45);
}

/**
 * Stalaktit — hängt von der Decke.
 *
 * Sein Ursprung liegt **oben**, nicht am Boden: er wird an eine Höhe gesetzt
 * und wächst nach unten. `snapToGround` muss dafür aus sein, sonst klebt die
 * Spitze im Boden und der Zapfen steht in der Luft darüber.
 */
export function baueStalaktit(): THREE.BufferGeometry {
  const rand = wuerfel(0x1a0c);
  const teile: THREE.BufferGeometry[] = [];
  for (const [x, z, h, r] of [
    [0, 0, 1.7, 0.3],
    [0.3, 0.18, 1.0, 0.2],
    [-0.26, -0.2, 0.6, 0.14],
  ] as Array<[number, number, number, number]>) {
    const g = new THREE.ConeGeometry(r, h, 7, 3);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(
        i,
        pos.getX(i) * (1 + (rand() - 0.5) * 0.35),
        pos.getY(i),
        pos.getZ(i) * (1 + (rand() - 0.5) * 0.35),
      );
    }
    pos.needsUpdate = true;
    g.rotateZ(Math.PI);
    g.translate(x, -h * 0.5, z);
    teile.push(g);
  }
  const roh = fuegeZusammen(teile);
  for (const t of teile) t.dispose();
  return steinKoerper(roh, 0x8a8378, 0x413f45);
}

/** Eine durchgewachsene Säule — Boden und Decke haben sich getroffen. */
export function baueTropfsteinsaeule(): THREE.BufferGeometry {
  const rand = wuerfel(0x1a0d);
  const geo = new THREE.CylinderGeometry(0.34, 0.46, 5.2, 8, 6);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    // Die Einschnürungen in der Mitte sind das, woran man eine Tropfsteinsäule
    // erkennt — eine gleichmässige Säule ist ein Rohr.
    const t = (pos.getY(i) + 2.6) / 5.2;
    const f = 0.8 + 0.35 * Math.abs(Math.sin(t * Math.PI * 3.5));
    pos.setXYZ(i, pos.getX(i) * f, pos.getY(i), pos.getZ(i) * f);
  }
  pos.needsUpdate = true;
  geo.translate((rand() - 0.5) * 0.1, 2.6, 0);
  return steinKoerper(geo, 0x8a8378, 0x413f45);
}

/**
 * Kristallgruppe und Riesenkristall.
 *
 * Sie tragen **nicht** die Gesteinstextur: ein Kristall ist glatt, und Korn
 * darauf nimmt ihm genau das, was ihn von einem Stein unterscheidet.
 */
export function baueKristallgruppe(): THREE.BufferGeometry {
  const rand = wuerfel(0x1a0e);
  const teile: Part[] = [];
  for (let i = 0; i < 6; i++) {
    const w = (i / 6) * Math.PI * 2 + rand() * 0.6;
    const r = 0.12 + rand() * 0.14;
    const h = 0.9 + rand() * 1.1;
    teile.push({
      geometry: new THREE.OctahedronGeometry(r, 0),
      color: i % 2 === 0 ? 0x7fd8e8 : 0x9ae4f0,
      position: [Math.sin(w) * 0.45, h * 0.45, Math.cos(w) * 0.45],
      scale: [1, h / r / 2, 1],
      rotation: [Math.cos(w) * 0.3, w, -Math.sin(w) * 0.3],
    });
  }
  return assemble(teile);
}

/** Ein einzelner grosser Kristall — er ist ein Ziel, kein Beiwerk. */
export function baueKristallGross(): THREE.BufferGeometry {
  return assemble([
    {
      geometry: new THREE.OctahedronGeometry(0.8, 0),
      color: 0x6fc8e0,
      position: [0, 2.0, 0],
      scale: [1, 2.6, 1],
    },
    {
      geometry: new THREE.OctahedronGeometry(0.42, 0),
      color: 0x8fdcee,
      position: [0.6, 0.9, 0.3],
      scale: [1, 2.0, 1],
      rotation: [0, 0.7, 0.3],
    },
    {
      geometry: new THREE.OctahedronGeometry(0.3, 0),
      color: 0x9ae4f0,
      position: [-0.5, 0.6, -0.35],
      scale: [1, 1.8, 1],
      rotation: [0.2, 1.9, -0.35],
    },
  ]);
}

/**
 * Eine Geode — ein Stein, der aufgebrochen ist.
 *
 * Aussen Fels, innen Kristall. Sie ist der Beweis dafür, dass die beiden
 * Materialien nebeneinander funktionieren: die raue Schale nimmt der glatten
 * Füllung nichts, und umgekehrt.
 */
export function baueGeode(): THREE.BufferGeometry {
  const rand = wuerfel(0x1a0f);
  const schale = klumpen(rand, 0.85, 2, 5, 0.55);
  schale.scale(1, 0.9, 1);
  schale.translate(0, 0.7, 0);
  const stein = steinKoerper(schale, 0x6a6760, 0x37363a);

  const innen: Part[] = [
    {
      geometry: new THREE.IcosahedronGeometry(0.5, 0),
      color: 0x2a2038,
      position: [0, 0.78, 0.5],
      scale: [1, 1, 0.4],
    },
  ];
  for (let i = 0; i < 7; i++) {
    const w = rand() * Math.PI * 2;
    const r = rand() * 0.32;
    innen.push({
      geometry: new THREE.OctahedronGeometry(0.07 + rand() * 0.05, 0),
      color: 0xb08fe0,
      position: [Math.sin(w) * r, 0.78 + Math.cos(w) * r, 0.6],
      scale: [1, 1.6, 1],
      rotation: [1.4, 0, w],
    });
  }
  const kern = assemble(innen);
  const geo = fuegeZusammen([stein, kern]);
  stein.dispose();
  kern.dispose();
  return geo;
}
