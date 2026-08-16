/**
 * Bäume.
 *
 * Die Kronen waren geschlossene Körper — beim Laubbaum drei zerknautschte
 * Kugeln, bei der Fichte drei Kegel übereinander. Beides sieht von aussen
 * genau danach aus: ein Ball auf einem Stiel und ein Tannenbaum aus dem
 * Setzkasten. Was einer Krone fehlt, sind **Lücken**, durch die der Himmel
 * scheint, und eine Silhouette, die nicht rund ist.
 *
 * Also dieselbe Antwort wie beim Busch: Karten mit einer Textur, deren Rand
 * durchsichtig ist. Neu ist der Stamm — der ist deckend und läge damit
 * eigentlich auf dem anderen Material. Er bekommt deshalb eine eigene, volle
 * Kachel im selben Atlas (`rinde`), und damit ist ein Baum **ein**
 * Zeichenaufruf statt zwei. Bei dreihundert Bäumen auf einer Karte ist das
 * kein Feinschliff, sondern der Unterschied.
 *
 * Drei Sorten, und sie unterscheiden sich in mehr als der Grösse:
 *
 * - **Laubbaum** — kurzer Stamm, Äste, eine breite Krone aus Kronenkarten.
 * - **Fichte** — durchgehender Stamm, waagerechte Zweigkränze, nach oben
 *   schmaler. Die Kränze hängen leicht herab.
 * - **Tanne** — schlanker und höher als die Fichte, mit mehr und kürzeren
 *   Kränzen. Zusammen ergeben die beiden einen Nadelwald, der nicht aus
 *   Kopien besteht.
 */

import * as THREE from 'three';
import { assemble, cylinder, type Part } from './geometry.ts';
import { laubKarte, laubNormalen, rindenUV } from './laub.ts';

/** Wiederholbarer Zufall — derselbe Baum bei jedem Start. */
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

/**
 * Ein Stamm mit Rindenkoordinaten.
 *
 * Der Zylinder von three bringt seine eigenen Bildkoordinaten mit; hier werden
 * sie in die Rindenkachel des Atlas gelegt. Ohne das läge der Stamm über dem
 * ganzen Atlas und trüge Gras und Blüten.
 *
 * Die Kachel wiederholt sich **nicht** — sie ist ein Ausschnitt, und ein
 * Ausschnitt, der umläuft, holt sich die Nachbarkachel ins Bild. Für einen
 * zehn Meter hohen Stamm heisst das: die Rinde wird gestreckt. Aus drei Metern
 * sieht man das nicht, und der Preis wäre eine eigene Textur.
 */
function stamm(
  hoehe: number,
  rUnten: number,
  rOben: number,
  segmente = 7,
): THREE.BufferGeometry {
  const geo = cylinder(rOben, rUnten, hoehe, segmente);
  geo.translate(0, hoehe * 0.5, 0);
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const [u, v] = rindenUV(uv.getX(i), uv.getY(i));
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Ein Ast: ein dünner Stamm, gekippt und gedreht. */
function ast(laenge: number, dicke: number): THREE.BufferGeometry {
  return stamm(laenge, dicke, dicke * 0.55, 5);
}

/**
 * Eine Zweigkarte, die **waagerecht vom Ursprung nach +X** wegsteht.
 *
 * `laubKarte` liefert eine stehende Karte mit dem Ursprung unten in der Mitte
 * — richtig für einen Grasbüschel, falsch für einen Zweig: der wächst nicht
 * nach oben, sondern seitwärts aus dem Stamm. Hier wird sie deshalb flach
 * gelegt und so verschoben, dass ihre **innere Kante** im Ursprung sitzt.
 *
 * Das ist mehr als Kosmetik. Vorher trug die Drehung `[π/2, winkel, 0]` die
 * Kippung um die **Weltachse** X statt um die Achse des Zweiges: die Karten
 * klappten in beliebige Richtungen, klebten am Stamm und standen zur Kamera
 * hochkant. Der Baum sah aus wie ein Mast mit Flusen. Steht die Karte erst
 * einmal richtig im Ursprung, genügen Gieren und ein Kippen um Z — und beides
 * ist dann eine Drehung um die eigene Achse des Zweiges.
 */
function zweigKarte(laenge: number, breite: number): THREE.BufferGeometry {
  const geo = laubKarte('nadel', laenge, breite);
  // Flach legen: die Karte steht in der XY-Ebene, sie soll in der XZ-Ebene
  // liegen.
  geo.rotateX(-Math.PI * 0.5);
  // Und die innere Kante in den Ursprung: `laubKarte` zentriert in X.
  geo.translate(laenge * 0.5, 0, 0);
  return geo;
}

/**
 * Ein Laubbaum.
 *
 * Die Krone ist ein Haufen Karten in einer Kugelschale — nicht in einem
 * Kranz: acht Karten im Kreis sähen von oben aus wie ein Rad. Verteilt werden
 * sie über den goldenen Winkel, dieselbe Verteilung, mit der eine Sonnenblume
 * ihre Kerne setzt; sie legt Punkte gleichmässig auf eine Kugel, ohne dass ein
 * Muster entsteht.
 */
export function baueLaubbaum(seed: number): THREE.BufferGeometry {
  const rand = wuerfel(seed);
  const parts: Part[] = [];

  const stammHoehe = 2.6;
  parts.push({ geometry: stamm(stammHoehe, 0.3, 0.17), color: 0x6b4f34 });

  // Drei Äste, damit die Krone nicht auf einem Stab schwebt.
  for (let i = 0; i < 3; i++) {
    const winkel = (i / 3) * Math.PI * 2 + rand() * 0.7;
    const laenge = 1.1 + rand() * 0.5;
    parts.push({
      geometry: ast(laenge, 0.1),
      color: 0x6b4f34,
      position: [0, stammHoehe * 0.72, 0],
      rotation: [Math.cos(winkel) * 0.75, winkel, -Math.sin(winkel) * 0.75],
    });
  }

  const kronenMitte = stammHoehe + 1.1;
  const kronenRadius = 1.5;
  const karten = 9;
  // Der goldene Winkel. Zwei aufeinanderfolgende Karten liegen damit nie
  // nebeneinander, und keine Zahl von Karten ergibt ein Muster.
  const gold = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < karten; i++) {
    const t = (i + 0.5) / karten;
    // Gleichmässig über die Kugel: `acos(1 - 2t)` und nicht ein linearer
    // Winkel — sonst häufen sich die Karten an den Polen.
    const phi = Math.acos(1 - 2 * t) * 0.82;
    const theta = i * gold;
    const gross = 2.5 * (0.7 + rand() * 0.5);

    parts.push({
      geometry: laubKarte('krone', gross, gross * 0.85),
      color: [0x5f9a4a, 0x6cab52, 0x54903f, 0x74b45e][i % 4]!,
      position: [
        Math.sin(phi) * Math.cos(theta) * kronenRadius * 0.55,
        kronenMitte + Math.cos(phi) * kronenRadius * 0.5 - gross * 0.42,
        Math.sin(phi) * Math.sin(theta) * kronenRadius * 0.55,
      ],
      rotation: [(rand() - 0.5) * 1.1, theta, (rand() - 0.5) * 0.6],
    });
  }

  const geo = assemble(parts);
  laubNormalen(geo, kronenMitte);
  return geo;
}

/**
 * Ein Nadelbaum.
 *
 * `schlank` unterscheidet Fichte von Tanne: dieselbe Bauweise, andere Zahlen.
 * Zwei Funktionen dafür wären zweimal dasselbe zu pflegen, und beim nächsten
 * Griff an die Zweige hätte man eine davon vergessen.
 *
 * Die Kränze **hängen**: jede Karte ist um gut zwanzig Grad nach unten
 * gekippt. Waagerecht sähen sie aus wie Regale, und das ist genau der Grund,
 * warum gestapelte Kegel nach Setzkasten aussehen.
 */
function baueNadelbaum(
  seed: number,
  { hoehe, kraenze, breite, schlank }: {
    hoehe: number;
    kraenze: number;
    breite: number;
    schlank: number;
  },
): THREE.BufferGeometry {
  const rand = wuerfel(seed);
  const parts: Part[] = [];

  // Der Stamm läuft durch bis in die Spitze — anders als beim Laubbaum, wo er
  // in der Krone endet. Genau das ist der Unterschied zwischen einem
  // Nadelbaum und einem Laubbaum, und man sieht ihn an der Silhouette.
  // Nur bis kurz unter die Spitze: das letzte Stück steckt ohnehin in den
  // obersten Zweigen, und was darüber hinausragt, ist ein Stock.
  parts.push({ geometry: stamm(hoehe * 0.95, 0.26, 0.06, 6), color: 0x5c4630 });

  const unten = hoehe * 0.16;
  for (let k = 0; k < kraenze; k++) {
    const t = k / (kraenze - 1);
    const y = unten + (hoehe * 0.9 - unten) * t;
    // Nach oben schmaler, und zwar nicht linear: ein Nadelbaum ist unten
    // ausladend und läuft oben spitz zu. Ein Rest bleibt stehen, damit der
    // oberste Kranz nicht zu nichts wird.
    const weite = breite * (0.32 + 0.68 * (1 - t) ** schlank);
    const proKranz = t > 0.75 ? 4 : 6;

    for (let i = 0; i < proKranz; i++) {
      const winkel = (i / proKranz) * Math.PI * 2 + k * 0.9 + rand() * 0.3;
      const laenge = weite * (1.7 + rand() * 0.5);
      parts.push({
        geometry: zweigKarte(laenge, laenge * 0.78),
        color: [0x3f7a3a, 0x356b32, 0x478644, 0x2f5e2c][(k + i) % 4]!,
        position: [0, y, 0],
        // Gieren um den Stamm, dann hängen lassen. Um Z gekippt heisst: der
        // Zweig senkt sich um seine eigene Ansatzachse — waagerechte Kränze
        // sehen aus wie Regale.
        rotation: [0, winkel, -0.3 - rand() * 0.18],
      });
    }
  }

  /*
   * Die Spitze: drei steil stehende Zweige.
   *
   * Vorher waren es zwei kurze, und darüber ragte ein Drittel Stamm nackt in
   * den Himmel — von weitem sah der Baum aus wie ein Mast mit einem Rock. Ein
   * Nadelbaum trägt bis oben.
   */
  for (let i = 0; i < 3; i++) {
    parts.push({
      geometry: zweigKarte(breite * 0.95, breite * 0.7),
      color: [0x3f7a3a, 0x356b32, 0x478644][i]!,
      position: [0, hoehe * (0.86 + i * 0.05), 0],
      rotation: [0, i * 2.1 + rand(), 0.75 + i * 0.15],
    });
  }

  const geo = assemble(parts);
  laubNormalen(geo, hoehe * 0.5);
  return geo;
}

/** Fichte — ausladend, mittelhoch. */
export function baueFichte(seed: number): THREE.BufferGeometry {
  return baueNadelbaum(seed, { hoehe: 6.4, kraenze: 6, breite: 1.5, schlank: 0.8 });
}

/** Tanne — schmaler und höher, mit mehr Kränzen. */
export function baueTanne(seed: number): THREE.BufferGeometry {
  return baueNadelbaum(seed, { hoehe: 8.2, kraenze: 9, breite: 1.15, schlank: 1.15 });
}
