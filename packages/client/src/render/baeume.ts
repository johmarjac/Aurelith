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
 * - **Laubbaum** — langer, dünner Stamm und darauf eine flache **Schirmkrone**
 *   aus zwei Lagen mit hängendem Rand.
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
function zweigKarte(
  laenge: number,
  breite: number,
  kachel: 'nadel' | 'krone' = 'nadel',
): THREE.BufferGeometry {
  const geo = laubKarte(kachel, laenge, breite);
  // Flach legen: die Karte steht in der XY-Ebene, sie soll in der XZ-Ebene
  // liegen.
  geo.rotateX(-Math.PI * 0.5);
  // Und die innere Kante in den Ursprung: `laubKarte` zentriert in X.
  geo.translate(laenge * 0.5, 0, 0);
  return geo;
}

/**
 * Ein Laubbaum — eine **Schirmkrone** auf einem schlanken Stamm.
 *
 * Vorher lag die Krone als Haufen Karten in einer Kugelschale, verteilt über
 * den goldenen Winkel. Die Verteilung war richtig und das Ergebnis trotzdem
 * immer dasselbe: ein Ball auf einem Stiel, und zwar egal, wie viele Karten
 * darin steckten. Eine Kugel hat keine Richtung — sie sieht von jeder Seite
 * gleich aus, und ein Wald aus Kugeln ist eine Fläche aus Punkten.
 *
 * Gemeint ist ein **Schirm**: ein langer, dünner Stamm, und darauf eine breite,
 * flache Scheibe aus zwei Lagen, deren Rand nach unten hängt. Das ist die Form,
 * die man aus jeder Entfernung wiedererkennt, weil sie eine Waagerechte hat —
 * eine Linie im Bild, die weder Boden noch Himmel ist.
 *
 * Drei Dinge halten sie zusammen, und jedes verhindert einen eigenen Fehler:
 *
 *   1. **Zwei Lagen, gegeneinander verdreht.** Eine einzige Lage aus sechs
 *      Karten sieht von oben aus wie ein Mühlrad; die zweite Lage füllt die
 *      Lücken der ersten, weil ihre Karten zwischen deren Speichen sitzen.
 *   2. **Ein hängender Rand.** Eine waagerechte Karte verschwindet, sobald die
 *      Kamera auf ihrer Höhe steht — sie ist dann eine Linie. Die Randkarten
 *      stehen deshalb steiler, und damit bleibt in jeder Augenhöhe etwas übrig,
 *      das Fläche hat.
 *   3. **Ein Deckel in der Mitte.** Der Schirm wird von seinem Ansatz nach
 *      aussen gebaut, und der Ansatz ist ein Punkt — ohne zwei flache Karten
 *      quer darüber sähe man von oben durch das Loch auf den Stamm.
 */
export function baueLaubbaum(seed: number): THREE.BufferGeometry {
  const rand = wuerfel(seed);
  const parts: Part[] = [];

  /*
   * Der Stamm ist lang und dünn geworden: vier Meter statt zwei Komma sechs,
   * und oben halb so dick. Ein Schirm auf einem kurzen Stamm ist ein Pilz —
   * was die Form trägt, ist der Abstand zwischen Boden und Krone, und unter
   * dem Schirm soll Platz sein, in dem man steht.
   */
  const stammHoehe = 4;
  parts.push({ geometry: stamm(stammHoehe, 0.28, 0.14), color: 0x6b4f34 });

  /*
   * Drei Äste, und sie stehen **steiler** als früher (nicht mehr um 0,75
   * gekippt, sondern um 0,45): sie tragen die Krone nicht zur Seite, sondern
   * hoch. Flach abstehende Äste unter einem flachen Schirm ergeben zwei
   * Waagerechte übereinander, und die zweite nimmt der ersten die Wirkung.
   */
  for (let i = 0; i < 3; i++) {
    const winkel = (i / 3) * Math.PI * 2 + rand() * 0.7;
    const laenge = 1.2 + rand() * 0.5;
    parts.push({
      geometry: ast(laenge, 0.1),
      color: 0x6b4f34,
      position: [0, stammHoehe * 0.66, 0],
      rotation: [Math.cos(winkel) * 0.45, winkel, -Math.sin(winkel) * 0.45],
    });
  }

  const GRUEN = [0x5f9a4a, 0x6cab52, 0x54903f, 0x74b45e];
  const kronenMitte = stammHoehe - 0.15;

  /*
   * Die beiden Lagen. `neigung` ist die Kippung um die eigene Ansatzachse der
   * Karte — dasselbe Z-Kippen wie beim Nadelbaum, nur viel schwächer: bei 0,2
   * senkt sich die Spitze einer Karte von zwei Metern um vierzig Zentimeter.
   * Das ist die Wölbung eines Schirms und noch keine Glocke.
   */
  const lagen = [
    { y: kronenMitte, karten: 7, laenge: 2.5, neigung: 0.2, dreh: 0 },
    { y: kronenMitte + 0.62, karten: 5, laenge: 1.95, neigung: 0.28, dreh: Math.PI / 7 },
  ];
  for (const lage of lagen) {
    for (let i = 0; i < lage.karten; i++) {
      const winkel = (i / lage.karten) * Math.PI * 2 + lage.dreh + rand() * 0.22;
      const laenge = lage.laenge * (0.85 + rand() * 0.3);
      parts.push({
        geometry: zweigKarte(laenge, laenge * 0.92, 'krone'),
        color: GRUEN[(i + lage.karten) % 4]!,
        position: [0, lage.y, 0],
        rotation: [0, winkel, -lage.neigung - rand() * 0.1],
      });
    }
  }

  /*
   * Der hängende Rand: vier Karten, die aussen ansetzen und deutlich steiler
   * stehen. Sie sind der Grund, warum der Schirm auf Augenhöhe nicht zu einem
   * Strich wird.
   */
  for (let i = 0; i < 4; i++) {
    const winkel = (i / 4) * Math.PI * 2 + 0.4 + rand() * 0.3;
    const laenge = 1.25 + rand() * 0.35;
    parts.push({
      geometry: zweigKarte(laenge, laenge * 1.05, 'krone'),
      color: GRUEN[i % 4]!,
      position: [
        Math.cos(winkel) * 1.55,
        kronenMitte + 0.18,
        Math.sin(winkel) * 1.55,
      ],
      rotation: [0, winkel, -0.85 - rand() * 0.25],
    });
  }

  // Und der Deckel: zwei flache Karten quer über den Ansatz.
  for (let i = 0; i < 2; i++) {
    const gross = 2.1;
    const geo = laubKarte('krone', gross, gross);
    geo.rotateX(-Math.PI * 0.5);
    parts.push({
      geometry: geo,
      color: GRUEN[(i + 2) % 4]!,
      position: [0, kronenMitte + 0.9, 0],
      rotation: [0, i * 1.1 + rand(), 0],
    });
  }

  const geo = assemble(parts);
  /*
   * Die Normalen ziehen von einem Punkt **unter** der Krone nach aussen und
   * nicht von ihrer Mitte. Bei einer Kugel war die Mitte richtig; bei einer
   * Scheibe zeigten die Normalen dann waagerecht nach aussen, und der Schirm
   * wurde von oben schwarz, obwohl die Sonne genau darauf steht.
   */
  laubNormalen(geo, kronenMitte - 1.6);
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
