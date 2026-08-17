/**
 * Figuren und ihre Bewegung.
 *
 * Ein Rig ist ein kleiner Szenengraph mit benannten Gelenken plus einer
 * `update`-Funktion, die daraus eine Pose macht. Heute stecken hinter den
 * Gelenken zusammengesetzte Grundkörper und eine von Hand geschriebene
 * Laufbewegung.
 *
 * Der Austausch gegen echte Modelle ist genau hier vorgesehen: ein glTF mit
 * Skelett und Animationsspuren erfüllt dieselbe Schnittstelle — `root` ist dann
 * die geladene Szene, `update` füttert einen AnimationMixer statt Winkel zu
 * setzen. Der Rest des Renderers merkt davon nichts.
 */

import * as THREE from 'three';
import { decodeOutfit, type Outfit } from '@aurelith/shared';
import { assemble, box, cone, cylinder, paint, rundeBox, sphere, type Part } from './geometry.ts';

export interface RigState {
  /** Weltnenheiten pro Sekunde. Treibt die Schrittfrequenz. */
  speed: number;
  /** 0..1 während eines Schlags, sonst negativ. */
  attackPhase: number;
  /**
   * Welcher Hieb — 0, 1 oder 2.
   *
   * Reihum gezählt, damit zwei Schläge hintereinander nicht identisch
   * aussehen. Reine Anzeige: die Simulation kennt nur „Schlag", und alle drei
   * dauern gleich lang und richten denselben Schaden an. Wäre es anders,
   * müsste die Variante über das Netz — und dann wäre sie Spielregel und
   * nicht Bild.
   */
  attackVariant?: number;
  /**
   * 0..1 während des Bückens, sonst negativ.
   *
   * Eine Geste und kein Zustand: sie kommt als Ereignis vom Server, die
   * Simulation weiss nichts davon. Rigs, die sich nicht bücken können —
   * Schleim, Vierbeiner —, sehen einfach weg.
   */
  pickupPhase: number;
  /**
   * 0..1 während der Wirbelklinge, sonst negativ.
   *
   * Wie `pickupPhase` eine Geste vom Server und kein Zustand der Simulation:
   * der Kern kennt nur den Flächenschaden, den er im selben Tick austeilt. Ein
   * eigenes Feld und keine vierte Schlagvariante, weil hier die **ganze** Figur
   * dreht und nicht nur ein Arm ausholt — als Variante gerechnet müsste jede
   * Stelle, die `attackPhase` liest, die eine Ausnahme kennen.
   */
  wirbelPhase?: number;
  /**
   * Wie weit die Figur vom Boden weg ist, 0 bis 1.
   *
   * Nicht die Höhe in Metern: die Pose soll beim Absprung weich einsetzen und
   * ist ab einem Vierteldmeter voll ausgeprägt. Wer die Zahl in Metern
   * durchreichte, müsste dieselbe Umrechnung in jedem Rig wiederholen.
   *
   * Weggelassen heisst „am Boden" — die Werkzeuge, die Rigs für Bilder
   * aufstellen, sollen keine Sprungwerte erfinden müssen.
   */
  luft?: number;
  /** Steigt die Figur gerade, oder fällt sie? Formt die Beinhaltung. */
  steigt?: boolean;
  /**
   * Worauf die Figur fliegt — Modellschlüssel, leer heisst: am Boden.
   *
   * Eine eigene Haltung und nicht die des Sprungs. Hier stand vorher nichts,
   * und deshalb griff `luft`: eine fliegende Figur ist ja über dem Boden. Sie
   * zog also beim Steigen die Knie an und streckte beim Sinken die Beine —
   * mitten im Flug, und das Bein dabei neben dem Brett. Was man auf einem
   * Brett tut, hat mit einem Sprung nichts zu tun.
   *
   * Der Schlüssel und kein `boolean`: auf einem Besen sitzt man, auf einem
   * Brett steht man.
   */
  flug?: string;
  dead: boolean;
  /** Sekunden seit Spielstart, für Leerlaufbewegung mit fester Frequenz. */
  time: number;
  /**
   * Sekunden seit dem letzten Bild. Treibt die Schrittphase.
   *
   * Warum nicht einfach `time`: eine Schrittphase als `time * frequenz` ist
   * nur solange richtig, wie die Frequenz konstant bleibt. Sobald sich das
   * Tempo ändert, wirkt die neue Frequenz rückwirkend auf die **gesamte**
   * verstrichene Zeit, und die Phase springt um `time * Δfrequenz`. Nach einer
   * halben Stunde Spielzeit ist dieser Sprung ein Vielfaches von 2π — die
   * Beine stehen von einem Bild aufs nächste irgendwo.
   *
   * Fortgeschrieben statt hochgerechnet gibt es das Problem nicht: die Phase
   * wächst immer nur um `dt * frequenz`, egal wie oft die Frequenz wechselt.
   */
  dt: number;
}

export interface CharacterRig {
  root: THREE.Object3D;
  update(state: RigState): void;
  /**
   * Welche Waffe die Figur trägt — oder nichts.
   *
   * Die `ModelRegistry` braucht das, um zu wissen, welchen Rigs sie ein
   * nachgeliefertes Modell einhängen muss.
   */
  readonly weapon?: WeaponKey;
  /**
   * Tauscht das Waffenmodell aus.
   *
   * `undefined` stellt den prozeduralen Platzhalter wieder her. Das Objekt
   * wird **nicht** übernommen, sondern geklont — dasselbe Modell hängt an
   * vielen Figuren, und jede dreht ihren Arm für sich.
   */
  setWeaponModel?(model: THREE.Object3D | undefined): void;
  /**
   * Der Aufhänger der Waffe, sofern die Figur eine trägt.
   *
   * Alles, was sich mit der Waffe bewegen soll, hängt hier hinein — heute die
   * Aura einer aufgewerteten Waffe, später womöglich ein Flammeneffekt. Nicht
   * die Waffe selbst herausgeben: die wird beim Nachliefern eines Modells
   * ausgetauscht, der Halter bleibt.
   */
  readonly weaponMount?: THREE.Object3D;
  /**
   * Wie weit die Waffe im Raum des Halters reicht.
   *
   * `length` ist ihre Länge, `bottom` der Abstand des unteren Endes vom
   * Griffpunkt, `axis` die Achse, auf der sie liegt. Dieselben Zahlen, mit
   * denen ein geliefertes Modell eingepasst wird — wer etwas *entlang* der
   * Waffe verteilen will, braucht genau sie und soll sie nicht schätzen.
   */
  readonly weaponSpan?: { length: number; bottom: number; axis: 'y' | 'z' };
  dispose(): void;
}

/**
 * Dieselbe Farbe, heller oder dunkler.
 *
 * Damit kommt ein Gesicht mit den fünf Farben aus, die eine Figur ohnehin
 * beschreibt. Fünf weitere Felder für Lippen, Ohren und Stiefel wären fünf
 * Stellen mehr, an denen eine neue Figur unstimmig aussehen kann — hier
 * verschiebt sich alles mit, sobald man die Hautfarbe ändert.
 */
function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * factor));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * factor));
  const b = Math.min(255, Math.round((color & 0xff) * factor));
  return (r << 16) | (g << 8) | b;
}

/**
 * Ein Gelenk: ein Drehpunkt, unter dem die Geometrie hängt.
 *
 * `color` ist nicht optional, obwohl es das sein könnte. Genau daran hing ein
 * Fehler: Arme und Beine wurden aus roher `box`-Geometrie gebaut, und die
 * bringt kein Farbattribut mit. Das gemeinsame Material zeichnet aus
 * Vertexfarben — fehlen sie, kommt Schwarz heraus. Die Figur lief also mit
 * schwarzen Ärmeln und schwarzen Hosenbeinen herum, während `shirt` und
 * `pants` in ihrer Beschreibung standen und niemand sie benutzte.
 */
/**
 * Wie ein Hieb aussieht — drei Sorten, jede über ihren Verlauf beschrieben.
 *
 * Vorher war der Schlag eine Gerade: der Arm ging hoch und wieder herunter,
 * immer dieselbe, immer in derselben Ebene. Das liest sich als „irgendetwas
 * passiert" und nicht als Schwung.
 *
 * Drei Dinge machen den Unterschied:
 *
 *   **Der Bogen.** Ein Hieb läuft nicht in einer Ebene. Neben dem Heben kommt
 *   das Ausstellen zur Seite (`armZ`) und die Drehung des Oberkörpers dazu —
 *   erst daraus wird eine Kurve im Raum, der die Klinge folgen kann.
 *
 *   **Die Zeitverteilung.** Ausholen dauert etwa ein Drittel und wird langsam,
 *   das Durchziehen ist kurz und schnell, danach kommt ein weiches Auslaufen.
 *   Gleichmässig verteilt sähe jeder Schlag aus wie eine Turnübung.
 *
 *   **Die Abwechslung.** Schräghieb, Querhieb, Überkopf — reihum. Zwei gleiche
 *   Schläge hintereinander fallen sofort auf, drei verschiedene fallen nicht
 *   einmal dann auf, wenn man darauf achtet.
 *
 * Alle drei beginnen und enden in der Ruhestellung, sonst ruckt es beim
 * Übergang in den Lauf.
 */
interface Schlagpose {
  /** Schulter: heben und senken. Negativ ist nach hinten oben. */
  armX: number;
  /** Schulter: vom Körper weg und quer darüber. */
  armZ: number;
  /** Der freie Arm hält dagegen. */
  armLX: number;
  /** Oberkörper: Drehung um die Hochachse — der eigentliche Schwung. */
  koerperY: number;
  /** Oberkörper: nach vorn und hinten. */
  koerperX: number;
  /** Gewichtsverlagerung nach vorn, in Weltnenheiten. */
  schritt: number;
  /**
   * Wie stark der Schlagarm angewinkelt ist, 0 bis etwa 1,5.
   *
   * Der Teil, den man am meisten sieht und am wenigsten erwartet: beim
   * Ausholen wird der Arm eingeklappt und beim Durchziehen gestreckt. Ein
   * durchgestreckter Arm, der einen Bogen fährt, sieht aus wie ein Zeiger;
   * erst das Strecken *im* Hieb gibt ihm Wucht.
   */
  ellbogen: number;
}

/** Weich anlaufen. */
function anlauf(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Schnell los, weich aus — die Kurve eines Durchziehens.
 *
 * Quadratisch und nicht kubisch: der Unterschied sind 0,7 statt 0,9 Bogenmass
 * zwischen zwei Bildern im schnellsten Moment. Kubisch schlägt härter zu und
 * lässt die Klinge dabei sichtbar springen — bei sechzig Bildern ist ein
 * halber Radiant je Bild die Grenze dessen, was das Auge noch als Bewegung
 * liest statt als Versatz.
 */
function durchzug(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

function schlagpose(variante: number, p: number): Schlagpose {
  // Drei Abschnitte: ausholen, durchziehen, auslaufen.
  const AUSHOLEN = 0.32;
  const DURCH = 0.66;

  /** Mischt zwischen Ruhe, Ausholpunkt und Endpunkt über den Verlauf. */
  const bahn = (aus: number, ende: number): number => {
    if (p < AUSHOLEN) return aus * anlauf(p / AUSHOLEN);
    if (p < DURCH) {
      const t = durchzug((p - AUSHOLEN) / (DURCH - AUSHOLEN));
      return aus + (ende - aus) * t;
    }
    // Auslaufen: zurück in die Ruhe, aber gemächlicher als der Hieb war.
    const t = anlauf((p - DURCH) / (1 - DURCH));
    return ende * (1 - t);
  };

  switch (variante % 3) {
    // Querhieb: waagerecht von aussen nach innen, mit viel Körperdrehung.
    case 1:
      return {
        armX: bahn(-1.5, -0.9),
        armZ: bahn(-1.35, 1.05),
        armLX: bahn(0.5, -0.45),
        koerperY: bahn(0.75, -0.8),
        koerperX: bahn(-0.05, 0.12),
        schritt: bahn(-0.04, 0.1),
        ellbogen: bahn(1.35, 0.12),
      };
    // Überkopf: gerade hoch, gerade herunter. Der wuchtigste der drei.
    case 2:
      return {
        armX: bahn(-2.75, 1.15),
        armZ: bahn(-0.12, 0.1),
        armLX: bahn(-0.4, 0.5),
        koerperY: bahn(0.12, -0.12),
        koerperX: bahn(-0.22, 0.32),
        schritt: bahn(-0.06, 0.16),
        ellbogen: bahn(1.15, 0.05),
      };
    // Schräghieb von oben aussen nach unten innen — der Grundhieb.
    default:
      return {
        armX: bahn(-2.25, 0.95),
        armZ: bahn(-0.7, 0.6),
        armLX: bahn(0.35, -0.3),
        koerperY: bahn(0.55, -0.65),
        koerperX: bahn(-0.14, 0.2),
        schritt: bahn(-0.05, 0.13),
        ellbogen: bahn(1.25, 0.1),
      };
  }
}

/**
 * Die Wirbelklinge — zwei volle Drehungen mit ausgestreckter Klinge.
 *
 * Aufbau in drei Abschnitten, wie beim Hieb, aber mit anderen Gewichten:
 *
 *   **Ausholen** (kurz). Die Figur geht leicht in die Knie und dreht ein
 *   Stück *gegen* die Drehrichtung. Ohne dieses Gegenholen fängt die Drehung
 *   aus dem Nichts an und sieht aus, als hätte jemand am Modell gedreht.
 *
 *   **Drehen** (lang). Zwei ganze Umdrehungen, schnell beginnend und weich
 *   auslaufend. Zwei und nicht eine: bei einer sieht man die Figur einmal
 *   vorbeikommen und hält es für einen Fehler in der Blickrichtung.
 *
 *   **Auslaufen.** Die Arme kommen herunter, die Drehung steht schon.
 *
 * Der Endwinkel ist ein ganzes Vielfaches von 2π. Das ist der Grund, warum
 * die Pose danach ersatzlos wegfallen darf: 4π und 0 sind dieselbe Blickrichtung,
 * und die Figur steht am Ende genau so, wie sie ohne den Wirbel stünde.
 */
interface Wirbelpose {
  /** Zusätzliche Drehung um die Hochachse. Läuft von 0 bis 4π. */
  drehung: number;
  /** Beide Schultern heben — Arme in die Waagerechte. */
  armX: number;
  /** Beide Arme vom Körper weg. Der Betrag; die Seiten setzen das Vorzeichen. */
  armZ: number;
  /**
   * Faktor auf die Ellbogenbeugung, 1 bis 0.
   *
   * Ein Faktor und kein Winkel: die Beugung, die gerade gilt, kommt aus dem
   * Laufzyklus, und ein eigener Winkel wäre eine zweite Antwort darauf, wie
   * krumm der Arm steht. Null heisst durchgestreckt — eine Wirbelklinge wird
   * nicht angewinkelt geführt, sonst reicht sie nicht bis an den Rand.
   */
  ellbogen: number;
  /** Anheben auf die Fussballen, in Weltnenheiten. Negativ ist das Ausholen. */
  hoehe: number;
  /** Neigung des Oberkörpers gegen die Drehung — die Fliehkraft. */
  kippung: number;
  /** Beugung des nachgezogenen Beins. Auf zwei Sohlen dreht sich niemand. */
  knie: number;
}

function wirbelpose(p: number): Wirbelpose {
  const AUSHOLEN = 0.16;
  const DREHEN = 0.84;
  const VOLL = Math.PI * 4;

  let drehung: number;
  if (p < AUSHOLEN) {
    drehung = -0.7 * anlauf(p / AUSHOLEN);
  } else if (p < DREHEN) {
    drehung = -0.7 + (VOLL + 0.7) * durchzug((p - AUSHOLEN) / (DREHEN - AUSHOLEN));
  } else {
    drehung = VOLL;
  }

  // Die Arme gehen früh hoch und spät wieder herunter — sie sollen schon
  // ausgestreckt sein, wenn die Drehung anfängt, sonst wirbelt die Figur
  // erst und streckt sich dann.
  const auf = anlauf(Math.min(1, p / 0.22));
  const ab = anlauf(Math.max(0, (p - DREHEN) / (1 - DREHEN)));
  const offen = auf * (1 - ab);

  // Das Ausholen drückt die Figur nach unten, die Drehung hebt sie an. Beides
  // in einer Zahl: sonst müsste die aufrufende Stelle wissen, in welchem
  // Abschnitt sie gerade ist.
  const ducken = p < AUSHOLEN ? -0.1 * anlauf(p / AUSHOLEN) : 0;

  return {
    drehung,
    armX: -0.15 * offen,
    armZ: 1.45 * offen,
    ellbogen: 1 - offen,
    hoehe: ducken + 0.11 * offen,
    kippung: -0.12 * offen,
    knie: 0.85 * offen,
  };
}

function joint(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  color: number,
  pivot: [number, number, number],
  offset: [number, number, number],
  disposables: THREE.BufferGeometry[],
): THREE.Object3D {
  const holder = new THREE.Object3D();
  holder.position.set(...pivot);
  const mesh = new THREE.Mesh(paint(geometry, color), material);
  mesh.position.set(...offset);
  holder.add(mesh);
  disposables.push(geometry);
  return holder;
}

// ---------------------------------------------------------------------------
// Humanoid
// ---------------------------------------------------------------------------

/**
 * Farben je Rüstungsstil.
 *
 * Ein Stil und kein Modell je Gegenstand: ein Satz aus vier Teilen soll
 * zusammenpassen, und das tut er am zuverlässigsten, wenn alle vier aus
 * derselben Zeile kommen. `schlicht` ist der Rückfall — ein Teil ohne
 * bekannten Stil bleibt sichtbar, statt still zu verschwinden.
 */
const ARMOR_STYLES: Record<string, { main: number; trim: number }> = {
  leder: { main: 0x8a6a42, trim: 0x5b4526 },
  stoff: { main: 0x6f7f5a, trim: 0x4d5a3e },
  leinen: { main: 0x5a6b8a, trim: 0x3f4c63 },
  messing: { main: 0xc9a44a, trim: 0x7d6520 },
  eisen: { main: 0x9aa4b0, trim: 0x5c646e },
  // Schwerer, dunkler Stoff mit Messingbesatz — der Reisemantel.
  wolle: { main: 0x4a3d5c, trim: 0x8a7a4a },
  schlicht: { main: 0x8a8a8a, trim: 0x5a5a5a },
};

function styleColors(stil: string | undefined): { main: number; trim: number } | undefined {
  if (!stil) return undefined;
  return ARMOR_STYLES[stil] ?? ARMOR_STYLES.schlicht!;
}

/**
 * Die Unterhose.
 *
 * Sie sitzt am Rumpf und nicht an den Beinen, und das ist keine Kleinigkeit:
 * die Beine drehen sich beim Laufen um die Hüfte. Ein Hosenbund, der mitdreht,
 * läuft in zwei Hälften auseinander, sobald die Figur einen Schritt macht.
 */
const UNDERWEAR = 0xf0e4d4;

export interface HumanoidConfig {
  kind: 'humanoid';
  height: number;
  /** Breitenfaktor. Ein Gruftwärter ist nicht nur größer, sondern massiger. */
  bulk: number;
  skin: number;
  shirt: number;
  pants: number;
  hair: number;
  accent: number;
  weapon: 'sword' | 'club' | 'staff' | 'bow' | 'none';
  /**
   * Was die Figur anhat. Fehlt es, steht sie in Unterhose da.
   *
   * Für NPCs ist das der Normalfall *nicht* — sie tragen ihre Kleidung als
   * Farben in der Beschreibung. Deshalb gibt es `dressed`: eine Figur ohne
   * Ausrüstungssystem bleibt angezogen, ein Spieler ohne Rüstung nicht.
   */
  outfit?: Outfit;
  /** Trägt diese Figur ihre Kleidung fest, ohne Ausrüstung? Gilt für NPCs. */
  dressed?: boolean;
}

/**
 * Waffe samt Halteposition.
 *
 * Die Geometrie allein reicht nicht: eine Klinge waechst vom Griff aus in
 * `+Y`, und wer sie einfach an die Hand haengt, laesst sie am Arm entlang nach
 * oben durch Schulter und Rumpf wachsen. Deshalb gehoert zu jeder Waffe, wie
 * sie gehalten wird — und zwar hier, nicht verstreut beim Zusammenbau.
 *
 * `position` ist relativ zur Hand, `rotation` in Bogenmass um die jeweilige
 * Achse. Beides in Einheiten einer 1,8 m hohen Figur; der Arm skaliert es mit.
 */
interface WeaponSpec {
  build(): THREE.BufferGeometry;
  position: [number, number, number];
  rotation: [number, number, number];
  /**
   * Geliefertes Modell, das den prozeduralen Platzhalter ablöst.
   *
   * Der Platzhalter bleibt trotzdem: er steht im ersten Bild da, das Modell
   * kommt, wenn es kommt. Ein Ladebalken für ein Schwert wäre genau die Sorte
   * Barriere, die es nicht geben soll.
   *
   * `length` und `bottom` sind in denselben Einheiten wie die prozeduralen
   * Maße oben — so bleibt die Haltung (`position`, `rotation`) gültig, egal
   * welches Modell eingehängt wird.
   */
  model?: {
    /** Pfad im Manifest. */
    path: string;
    /** Länge von Knauf bis Spitze. */
    length: number;
    /** Wo der Knauf sitzt, relativ zur Faust. */
    bottom: number;
    /**
     * Achse, entlang derer das gelieferte Modell seine Länge hat.
     *
     * Vorgabe ist Y — Waffen werden meist aufrecht modelliert. Der Bogen kam
     * liegend, mit den Wurfarmen entlang Z.
     */
    axis?: 'x' | 'y' | 'z';
  };
}

/** Die Waffen, die ein Rig kennt. */
export type WeaponKey = Exclude<HumanoidConfig['weapon'], 'none'>;

/** Ob eine Zeichenkette eine bekannte Waffe benennt. */
function isWeaponKey(value: string): value is WeaponKey {
  return value === 'sword' || value === 'club' || value === 'staff' || value === 'bow';
}

/**
 * Was an gelieferten Waffenmodellen zu holen ist.
 *
 * Die `ModelRegistry` liest das, nicht die Spezifikationen selbst — sie muss
 * nur wissen, welche Datei zu welchem Schlüssel gehört und wie sie
 * zurechtgerückt wird.
 */
export function weaponModelSpecs(): Array<{
  key: WeaponKey;
  path: string;
  length: number;
  bottom: number;
  axis?: 'x' | 'y' | 'z';
}> {
  const out: Array<{
    key: WeaponKey;
    path: string;
    length: number;
    bottom: number;
    axis?: 'x' | 'y' | 'z';
  }> = [];
  for (const [key, spec] of Object.entries(WEAPON_SPECS) as [WeaponKey, WeaponSpec][]) {
    if (spec.model) out.push({ key, ...spec.model });
  }
  return out;
}

/**
 * Die Geometrie einer Waffe allein, ohne Figur drumherum.
 *
 * Gebraucht für die Inventarbilder: dort steht das Schwert für sich. Es ist
 * bewusst dieselbe Quelle wie in der Hand der Figur — ein zweites Modell fürs
 * Symbol wäre eine zweite Wahrheit über dasselbe Ding.
 */
export function buildWeaponGeometry(key: WeaponKey): THREE.BufferGeometry {
  return WEAPON_SPECS[key].build();
}

const WEAPON_SPECS: Record<WeaponKey, WeaponSpec> = {
  sword: {
    build: () =>
      assemble([
        { geometry: box(0.07, 0.9, 0.02), color: 0xb9863f, position: [0, 0.45, 0] },
        { geometry: box(0.22, 0.06, 0.06), color: 0x5d4324, position: [0, 0.02, 0] },
        { geometry: box(0.06, 0.22, 0.06), color: 0x3f2d18, position: [0, -0.12, 0] },
      ]),
    // Zwei Drehungen, zwei Gründe.
    //
    // Um X: etwas mehr als eine Vierteldrehung, damit die Klinge nach vorn und
    // leicht nach unten zeigt — vom Arm weg statt an ihm entlang.
    //
    // Um Y: eine Vierteldrehung, damit die *Schneide* in Schwingrichtung
    // zeigt. Der Arm dreht um X, die Klinge zieht also durch die YZ-Ebene.
    // Die Breite der Klinge (0,07 in X) muss in dieser Ebene liegen, sonst
    // schlägt die Figur mit der flachen Seite zu. Die Parierstange dreht als
    // Teil derselben Geometrie mit und bleibt dadurch richtig zur Schneide.
    position: [0.02, 0, 0.04],
    rotation: [Math.PI * 0.66, Math.PI / 2, 0],
    // Maße aus der prozeduralen Fassung übernommen: Klinge 0,9 lang, Knauf
    // 0,23 unter dem Griffpunkt. Das geliefertes Modell wird darauf gerechnet,
    // damit die Haltung darüber unverändert gilt.
    model: { path: 'models/wooden_sword.glb', length: 1.13, bottom: -0.23 },
  },

  bow: {
    // Platzhalter: zwei Wurfarme und eine Sehne. Steht nur da, bis das Modell
    // eintrifft — aber es muss dastehen, sonst haelt die Figur im ersten Bild
    // nichts.
    build: () =>
      assemble([
        { geometry: box(0.05, 0.5, 0.05), color: 0x8f6b3a, position: [0, 0.28, 0.06] },
        { geometry: box(0.05, 0.5, 0.05), color: 0x8f6b3a, position: [0, -0.28, 0.06] },
        { geometry: box(0.06, 0.3, 0.06), color: 0x6b4f34, position: [0, 0, 0.02] },
        { geometry: box(0.015, 1.05, 0.015), color: 0xe8e0cc, position: [0, 0, -0.04] },
      ]),
    // Der Bogen wird quer gehalten, Sehne zum Koerper. Anders als beim Schwert
    // zeigt seine Laengsachse nicht nach vorn, sondern nach oben — deshalb
    // dreht hier nur die Y-Achse, um die Wurfarme aus dem Arm zu bringen.
    position: [0.04, -0.05, 0.06],
    rotation: [Math.PI * 0.12, Math.PI / 2, 0],
    model: { path: 'models/wooden_bow.glb', length: 1.15, bottom: -0.58, axis: 'z' },
  },

  club: {
    build: () =>
      assemble([
        { geometry: cylinder(0.05, 0.06, 0.9, 6), color: 0x5d4324, position: [0, 0.35, 0] },
        { geometry: sphere(0.2, 0), color: 0x4a4a52, position: [0, 0.85, 0] },
      ]),
    position: [0.02, 0, 0.04],
    rotation: [Math.PI * 0.62, 0, 0],
  },

  staff: {
    build: () =>
      assemble([
        { geometry: cylinder(0.04, 0.05, 1.5, 6), color: 0x6b4f34, position: [0, 0.6, 0] },
        { geometry: new THREE.OctahedronGeometry(0.14, 0), color: 0x7fd8e8, position: [0, 1.35, 0] },
      ]),
    // Ein Stab bleibt aufrecht — aber nach aussen versetzt, damit er am Arm
    // vorbeigeht und nicht hindurch.
    position: [0.17, -0.42, 0.02],
    rotation: [0, 0, 0],
  },
};

function makeHumanoid(cfg: HumanoidConfig, material: THREE.Material): CharacterRig {
  const disposables: THREE.BufferGeometry[] = [];
  // Fortgeschriebene Schrittphase. Siehe RigState.dt: aus der absoluten
  // Uhr berechnet, spraenge sie bei jedem Tempowechsel.
  let gaitPhase = 0;
  const s = cfg.height / 1.8;
  const w = cfg.bulk;

  const root = new THREE.Object3D();
  const body = new THREE.Object3D();
  root.add(body);

  // Maße in Einheiten einer 1,8 m hohen Figur, danach mit `s` skaliert.
  //
  // Der Drehpunkt eines Beins muss auf seiner eigenen Länge sitzen und die
  // Geometrie um die halbe Länge nach unten versetzt sein — sonst steht die
  // Figur auf Höhe des Restes, den man vergessen hat abzuziehen, und schwebt.
  const legLength = 0.92;
  const hipY = legLength;
  const shoulderY = 1.45;
  const armLength = 0.62;

  // Rumpf, Kopf und Haar als ein Stück — sie bewegen sich nie gegeneinander.
  //
  // Das Gesicht steckt mit drin. Es besteht aus flachen Kästchen, die knapp
  // vor der Kopffläche sitzen: keine Texturen, keine Rundungen, sondern
  // dieselbe Formensprache wie der Rest. Low-Poly heißt nicht wenig Details,
  // sondern Details aus wenigen Flächen.
  //
  // Der Kopf blickt nach +Z. Die Vorderfläche liegt bei z = 0,13; alles, was
  // im Gesicht sitzt, steht ein paar Millimeter davor.
  const brow = shade(cfg.hair, 0.9);

  // Was an ist, und was daraus für Farben folgen.
  //
  // `dressed` gilt für alle, die kein Ausrüstungssystem haben — NPCs tragen
  // ihre Kleidung als Farbe in der Beschreibung, und die soll bleiben. Ein
  // Spieler ohne Rüstung dagegen steht in Unterhose da; genau das ist der
  // Sinn der Sache, denn nur so sieht man, dass ein angelegtes Teil wirkt.
  const angezogen = cfg.dressed !== false;
  const brust = styleColors(cfg.outfit?.chest);
  const hose = styleColors(cfg.outfit?.legs);
  const schuhe = styleColors(cfg.outfit?.feet);
  const helm = styleColors(cfg.outfit?.head);
  const umhang = styleColors(cfg.outfit?.cloak);
  const brille = styleColors(cfg.outfit?.glasses);
  const handschuh = styleColors(cfg.outfit?.hands);

  const rumpfFarbe = brust ? brust.main : angezogen ? cfg.shirt : cfg.skin;
  const armFarbe = brust ? shade(brust.main, 0.92) : angezogen ? shade(cfg.shirt, 0.92) : cfg.skin;
  const beinFarbe = hose ? hose.main : angezogen ? cfg.pants : cfg.skin;
  const stiefelFarbe = schuhe ? schuhe.main : shade(beinFarbe, 0.62);

  /*
   * Der Körper ist aus **gerundeten** Boxen — die Einzelheiten nicht.
   *
   * Was die Silhouette bestimmt, bekommt gebrochene Kanten und eine
   * Verjüngung: Rumpf, Kopf, Glieder, Hände, Füsse. Augen, Brauen, Mund und
   * Gürtelschnallen bleiben Kästchen. Sie sind zwei Zentimeter gross; eine
   * Fase daran kostet Dreiecke und ist aus zwei Metern Entfernung kein
   * Unterschied, den jemand sieht.
   */
  const torsoParts: Part[] = [
    // Der Rumpf verjüngt sich nach unten: Schultern breit, Taille schmal. Das
    // allein nimmt der Figur das Kastenhafte, noch vor jeder Rundung.
    {
      geometry: rundeBox(0.5 * w, 0.6, 0.3 * w, { oben: 1.06, unten: 0.82, rund: 0.075, seg: 3 }),
      color: rumpfFarbe,
      position: [0, 1.22, 0],
    },

    /*
     * Schulterkugeln.
     *
     * Die eine Stelle, an der ein Kastenrumpf immer als Kasten auffällt: der
     * Arm hängt an einer senkrechten Wand, und dazwischen ist eine Kante.
     * Zwei gerundete Körper an den Drehpunkten schliessen die Lücke und
     * machen aus der Ecke eine Wölbung. Sie sitzen **auf** dem Drehpunkt, also
     * dreht der Arm in ihnen — nicht mit ihnen, und darum klafft beim
     * Schwingen nichts auf.
     */
    {
      geometry: rundeBox(0.21 * w, 0.2, 0.21 * w, { unten: 0.86, rund: 0.07, seg: 3 }),
      color: armFarbe,
      position: [0.3 * w, 1.42, 0],
    },
    {
      geometry: rundeBox(0.21 * w, 0.2, 0.21 * w, { unten: 0.86, rund: 0.07, seg: 3 }),
      color: armFarbe,
      position: [-0.3 * w, 1.42, 0],
    },

    /*
     * Das Becken.
     *
     * Unten hörte der Rumpf mit einer waagerechten Platte auf, aus der zwei
     * Beine ragten. Ein gerundetes Stück darunter nimmt die Kante und gibt dem
     * Übergang eine Form — schmaler als der Rumpf, breiter als die beiden
     * Beine zusammen.
     */
    {
      geometry: rundeBox(0.42 * w, 0.19, 0.29 * w, { oben: 1.0, unten: 0.9, rund: 0.06, seg: 3 }),
      color: rumpfFarbe,
      position: [0, 0.99, 0],
    },

    // Hals — vorher saß der Kopf ohne Übergang auf den Schultern.
    {
      geometry: rundeBox(0.14, 0.1, 0.14, { rund: 0.035 }),
      color: shade(cfg.skin, 0.86),
      position: [0, 1.5, 0],
    },

    // Der Kopf: unten schmaler, oben breiter — ein Schädel und kein Würfel.
    {
      geometry: rundeBox(0.28, 0.28, 0.26, { oben: 0.97, unten: 0.85, rund: 0.082, seg: 3 }),
      color: cfg.skin,
      position: [0, 1.66, 0],
    },
    // Kinn: schmaler als der Kopf, damit der Würfel eine Form bekommt.
    {
      geometry: rundeBox(0.2, 0.07, 0.22, { unten: 0.8, rund: 0.03 }),
      color: cfg.skin,
      position: [0, 1.535, 0.012],
    },

    // Ohren.
    { geometry: rundeBox(0.03, 0.075, 0.06, { rund: 0.014 }), color: shade(cfg.skin, 0.94), position: [0.147, 1.665, -0.005] },
    { geometry: rundeBox(0.03, 0.075, 0.06, { rund: 0.014 }), color: shade(cfg.skin, 0.94), position: [-0.147, 1.665, -0.005] },

    // Brauen.
    { geometry: box(0.082, 0.024, 0.02), color: brow, position: [0.06, 1.729, 0.126] },
    { geometry: box(0.082, 0.024, 0.02), color: brow, position: [-0.06, 1.729, 0.126] },

    // Augen: helle Fläche, dunkle Pupille davor.
    { geometry: box(0.066, 0.048, 0.012), color: 0xf0ece4, position: [0.062, 1.699, 0.132] },
    { geometry: box(0.066, 0.048, 0.012), color: 0xf0ece4, position: [-0.062, 1.699, 0.132] },
    { geometry: box(0.03, 0.034, 0.012), color: 0x2a2018, position: [0.066, 1.697, 0.136] },
    { geometry: box(0.03, 0.034, 0.012), color: 0x2a2018, position: [-0.066, 1.697, 0.136] },

    // Nase: der einzige Teil, der wirklich vorsteht.
    { geometry: rundeBox(0.055, 0.08, 0.06, { rund: 0.02 }), color: shade(cfg.skin, 1.04), position: [0, 1.662, 0.145] },

    // Mund.
    { geometry: box(0.082, 0.016, 0.012), color: shade(cfg.skin, 0.72), position: [0, 1.6, 0.13] },

    // Haar: Dach, Nacken, Seiten und eine Strähne über der Stirn. Vier Kästen
    // statt einem — ein einzelner Deckel sieht aus wie ein aufgesetzter Hut.
    { geometry: rundeBox(0.31, 0.09, 0.29, { oben: 0.86, rund: 0.045, seg: 3 }), color: cfg.hair, position: [0, 1.79, 0] },
    { geometry: rundeBox(0.15, 0.09, 0.06, { rund: 0.025 }), color: cfg.hair, position: [0, 1.7, -0.14] },
    // Die Seiten laufen nach unten schmaler zu — ein Haarvorhang, der unten so
    // breit ist wie oben, ist ein Brett neben dem Kopf.
    {
      geometry: rundeBox(0.032, 0.17, 0.28, { unten: 0.8, rund: 0.014, seg: 3 }),
      color: cfg.hair,
      position: [0.148, 1.7, -0.012],
    },
    {
      geometry: rundeBox(0.032, 0.17, 0.28, { unten: 0.8, rund: 0.014, seg: 3 }),
      color: cfg.hair,
      position: [-0.148, 1.7, -0.012],
    },
    // Flach am Kopf und ueber der Braue: eine Straehne, die weiter vorsteht
    // als die Augen, deckt sie zu — und sieht aus wie ein Fehler im Modell.
    { geometry: rundeBox(0.292, 0.05, 0.04, { rund: 0.016 }), color: cfg.hair, position: [0, 1.772, 0.112] },
  ];

  // --- Was die Ausrüstung obendrauf legt -----------------------------------
  //
  // Alles hier ist Zusatz zum nackten Körper. Der Körper steht schon, und
  // jedes Teil legt sich darüber — deshalb liest sich der Unterschied zwischen
  // an- und ausgezogen an genau dieser Liste ab und nicht an fünf verstreuten
  // Bedingungen weiter oben.

  if (brust) {
    // Gürtel und Schulterstücke: erst dadurch ist ein Brustteil als Rüstung zu
    // erkennen und nicht als andersfarbiges Hemd.
    torsoParts.push(
      { geometry: box(0.44 * w, 0.09, 0.32 * w), color: brust.trim, position: [0, 0.96, 0] },
      { geometry: box(0.13 * w, 0.1, 0.32 * w), color: brust.trim, position: [0.3 * w, 1.44, 0] },
      { geometry: box(0.13 * w, 0.1, 0.32 * w), color: brust.trim, position: [-0.3 * w, 1.44, 0] },
      // Ein Kragen schliesst die Lücke zum Hals.
      { geometry: box(0.3 * w, 0.07, 0.26 * w), color: brust.trim, position: [0, 1.5, 0] },
    );
  } else if (angezogen) {
    // Die alte Gürtellinie bleibt, wo eine Figur ohne Ausrüstungssystem steht.
    torsoParts.push({
      geometry: box(0.42 * w, 0.16, 0.28 * w),
      color: cfg.accent,
      position: [0, 0.96, 0],
    });
  }

  if (!hose && !angezogen) {
    // Die Unterhose. Am Rumpf, nicht am Bein — siehe `UNDERWEAR`.
    //
    // Sie muss die Beine **umschliessen**, nicht bündig auf ihnen sitzen. Ein
    // Bein reicht bis 0,23·w nach aussen; genau dort lag vorher auch der Rand
    // der Hose, und zwei deckungsgleiche Flächen flimmern, weil die Tiefe
    // beider gleich weit weg ist und der Puffer zwischen ihnen hin- und
    // herspringt. Ein Fingerbreit mehr, und das Problem verschwindet.
    torsoParts.push(
      { geometry: rundeBox(0.54 * w, 0.21, 0.36 * w, { rund: 0.05, seg: 3 }), color: UNDERWEAR, position: [0, 0.9, 0] },
      { geometry: box(0.55 * w, 0.05, 0.37 * w), color: shade(UNDERWEAR, 0.88), position: [0, 0.995, 0] },
    );
  } else if (hose) {
    // Hosenbund, damit Hose und Rumpf nicht ohne Übergang aneinanderstossen.
    torsoParts.push({
      geometry: box(0.46 * w, 0.11, 0.3 * w),
      color: hose.trim,
      position: [0, 0.93, 0],
    });
  }

  if (helm) {
    // Eine Kappe über dem Haar, mit Schirm und Nackenschutz. Nicht *statt* des
    // Haars: der Kopf ist ein Stück mit dem Rumpf, und ein Helm, der das Haar
    // ersetzen soll, hiesse die ganze Geometrie zweimal zu bauen.
    torsoParts.push(
      { geometry: box(0.33, 0.13, 0.31), color: helm.main, position: [0, 1.83, 0] },
      { geometry: box(0.33, 0.05, 0.09), color: helm.trim, position: [0, 1.78, 0.15] },
      { geometry: box(0.31, 0.13, 0.06), color: helm.trim, position: [0, 1.73, -0.155] },
    );
  }

  if (brille) {
    // Zwei Gläser und ein Steg, knapp vor den Augen.
    torsoParts.push(
      { geometry: box(0.075, 0.05, 0.014), color: brille.main, position: [0.062, 1.699, 0.146] },
      { geometry: box(0.075, 0.05, 0.014), color: brille.main, position: [-0.062, 1.699, 0.146] },
      { geometry: box(0.05, 0.014, 0.012), color: brille.trim, position: [0, 1.699, 0.146] },
      // Bügel zu den Ohren.
      { geometry: box(0.014, 0.014, 0.16), color: brille.trim, position: [0.098, 1.699, 0.07] },
      { geometry: box(0.014, 0.014, 0.16), color: brille.trim, position: [-0.098, 1.699, 0.07] },
    );
  }

  if (umhang) {
    /*
     * Ein Mantel, kein Handtuch.
     *
     * Die erste Fassung war ein Rechteck am Rücken, das an der Hüfte aufhörte
     * — angelegt und abgelegt sah die Figur fast gleich aus, und genau das ist
     * der Fehler, den ein sichtbares Ausrüstungsteil nicht machen darf. Jetzt
     * fällt er bis unter die Knie, wird nach unten breiter statt schmaler, hat
     * einen Kragen und liegt über den Schultern auf.
     *
     * Starr, nicht wehend: ein wehender Mantel bräuchte Simulation, und ein
     * schlecht wehender sieht schlimmer aus als ein ruhiger.
     *
     * Die Bahnen überlappen sich um einen Zentimeter (0,60/0,58 und 0,32/0,30
     * in der Höhe). Bündig aneinandergesetzte Flächen flimmern — dieselbe
     * Regel wie an Sohle und Schaft.
     */
    torsoParts.push(
      // Rücken, von den Schultern bis zur Hüfte.
      { geometry: box(0.5 * w, 0.6, 0.05), color: umhang.main, position: [0, 1.2, -0.185] },
      // Schoss: breiter und tiefer, bis unter die Knie.
      { geometry: box(0.58 * w, 0.58, 0.055), color: shade(umhang.main, 0.94), position: [0, 0.62, -0.2] },
      // Zwei vordere Bahnen, zwischen denen der Rumpf sichtbar bleibt.
      { geometry: box(0.16 * w, 0.86, 0.045), color: shade(umhang.main, 1.04), position: [0.19 * w, 1.06, 0.16] },
      { geometry: box(0.16 * w, 0.86, 0.045), color: shade(umhang.main, 1.04), position: [-0.19 * w, 1.06, 0.16] },
      // Schulterstück, das die Bahnen oben zusammenhält. Bei 1,43 und nicht bei
      // 1,44: seine Oberkante läge sonst genau auf der des Rumpfes (1,52), und
      // zwei deckungsgleiche Flächen flimmern.
      { geometry: box(0.62 * w, 0.16, 0.4 * w), color: umhang.trim, position: [0, 1.43, -0.01] },
      // Kragen, hinten hochgestellt.
      { geometry: box(0.34 * w, 0.16, 0.06), color: umhang.trim, position: [0, 1.56, -0.13] },
      // Schliesse vorn.
      { geometry: box(0.1 * w, 0.08, 0.06), color: shade(umhang.trim, 1.15), position: [0, 1.44, 0.17] },
    );
  }

  const torso = new THREE.Mesh(assemble(torsoParts), material);
  torso.scale.setScalar(s);
  body.add(torso);
  disposables.push(torso.geometry);

  /*
   * Zwei Glieder je Arm und Bein, mit einem Gelenk dazwischen.
   *
   * Vorher war jedes Bein ein einziger langer Kasten. Der konnte pendeln, und
   * das war der ganze Lauf — eine Figur auf Stelzen. Ein Knie kostet einen
   * Knoten und macht aus dem Pendeln einen Schritt: das hintere Bein zieht
   * sich beim Nachholen an, statt wie ein Brett durchzuschwingen.
   *
   * Die Glieder überlappen sich um ein Zehntel ihrer Länge. Ohne das klafft
   * beim Beugen ein Spalt am Gelenk — zwei Kästen, die genau aneinander
   * enden, treffen sich nur, solange sie in einer Linie stehen.
   */
  const OBERSCHENKEL = legLength * 0.5;
  const SCHIENBEIN = legLength * 0.5;
  const OBERARM = armLength * 0.5;
  const UNTERARM = armLength * 0.5;
  const UEBERLAPP = 1.1;

  /*
   * Die Glieder verjüngen sich nach unten — jedes für sich.
   *
   * Ein Oberarm, der am Ellbogen so dick ist wie an der Schulter, liest sich
   * als Rohr. Die Faktoren sind klein: 1,0 oben zu 0,85 unten ist im Bild ein
   * deutlicher Unterschied und im Umriss noch immer eine gerade Linie. Wichtig
   * ist, dass das obere Glied unten dort endet, wo das untere oben anfängt —
   * sonst hat der Ellbogen eine Stufe.
   */
  const oberarmGeo = () =>
    rundeBox(0.16 * w, OBERARM * UEBERLAPP, 0.16 * w, { oben: 1.05, unten: 0.86, rund: 0.03 });
  const unterarmGeo = () =>
    rundeBox(0.145 * w, UNTERARM * UEBERLAPP, 0.145 * w, { oben: 0.98, unten: 0.8, rund: 0.028 });
  const oberschenkelGeo = () =>
    rundeBox(0.19 * w, OBERSCHENKEL * UEBERLAPP, 0.21 * w, { oben: 1.04, unten: 0.86, rund: 0.038 });
  const schienbeinGeo = () =>
    rundeBox(0.165 * w, SCHIENBEIN * UEBERLAPP, 0.185 * w, { oben: 1.0, unten: 0.82, rund: 0.034 });

  // Ärmel in Hemdfarbe, Hosenbeine in Hosenfarbe — beides stand schon in der
  // Beschreibung, wurde aber nie gezeichnet.
  const sleeve = armFarbe;
  const armL = joint(oberarmGeo(), material, sleeve, [-0.34 * w * s, shoulderY * s, 0], [0, -OBERARM / 2, 0], disposables);
  const armR = joint(oberarmGeo(), material, sleeve, [0.34 * w * s, shoulderY * s, 0], [0, -OBERARM / 2, 0], disposables);
  const legL = joint(oberschenkelGeo(), material, beinFarbe, [-0.14 * w * s, hipY * s, 0], [0, -OBERSCHENKEL / 2, 0], disposables);
  const legR = joint(oberschenkelGeo(), material, beinFarbe, [0.14 * w * s, hipY * s, 0], [0, -OBERSCHENKEL / 2, 0], disposables);
  for (const j of [armL, armR, legL, legR]) {
    j.scale.setScalar(s);
    body.add(j);
  }

  // Die unteren Glieder hängen am Ende der oberen. Sie werden **nicht**
  // nochmals skaliert: der Massstab steckt schon im Elternknoten, und zweimal
  // angewandt wäre der Unterarm eines Gruftwärters länger als sein Oberarm.
  const ellbogenL = joint(unterarmGeo(), material, sleeve, [0, -OBERARM, 0], [0, -UNTERARM / 2, 0], disposables);
  const ellbogenR = joint(unterarmGeo(), material, sleeve, [0, -OBERARM, 0], [0, -UNTERARM / 2, 0], disposables);
  const knieL = joint(schienbeinGeo(), material, beinFarbe, [0, -OBERSCHENKEL, 0], [0, -SCHIENBEIN / 2, 0], disposables);
  const knieR = joint(schienbeinGeo(), material, beinFarbe, [0, -OBERSCHENKEL, 0], [0, -SCHIENBEIN / 2, 0], disposables);
  armL.add(ellbogenL);
  armR.add(ellbogenR);
  legL.add(knieL);
  legR.add(knieR);

  // Hände und Füße.
  //
  // Die Hand war ein Würfel von 17 cm Kantenlänge — breiter als der Arm und
  // deutlich breiter als jeder Griff, den sie halten soll. Die Waffe steckte
  // darin, statt gehalten zu werden. Jetzt ist sie schmal und hoch, mit einem
  // Daumen zur Körpermitte hin, und der Griff läuft sichtbar durch die Faust.
  /*
   * Die Hand — und darüber, wenn welche angelegt sind, der Handschuh.
   *
   * Der Handschuh ersetzt die Haut nicht, er **umschliesst** sie: die Faust
   * bleibt stehen und bekommt eine Schale von einem Zentimeter Wandstärke
   * darüber. Bündig anliegende Flächen flimmern, und eine ausgetauschte Farbe
   * sähe aus wie eine bemalte Hand statt wie ein Handschuh. Die Stulpe am
   * Unterarm ist das, was man aus zwei Metern Entfernung tatsächlich sieht.
   */
  const handParts = (thumbSide: number): Part[] => {
    const teile: Part[] = [
      {
        geometry: rundeBox(0.1 * w, 0.155, 0.125 * w, { unten: 0.9, rund: 0.028 }),
        color: cfg.skin,
        position: [0, 0, 0],
      },
      {
        geometry: rundeBox(0.042 * w, 0.062, 0.055 * w, { rund: 0.016 }),
        color: cfg.skin,
        position: [thumbSide * 0.062 * w, 0.032, 0.028],
      },
      // Bündchen: die Grenze zwischen Ärmel und Haut, sonst wächst die Hand
      // ohne Übergang aus dem Hemd.
      {
        geometry: box(0.13 * w, 0.035, 0.14 * w),
        color: shade(handschuh ? handschuh.trim : armFarbe, 0.8),
        position: [0, 0.092, 0],
      },
    ];

    if (handschuh) {
      teile.push(
        // Die Schale über der Faust.
        { geometry: box(0.13 * w, 0.175, 0.155 * w), color: handschuh.main, position: [0, 0.004, 0] },
        // Und über dem Daumen.
        {
          geometry: box(0.07 * w, 0.082, 0.085 * w),
          color: handschuh.main,
          position: [thumbSide * 0.066 * w, 0.032, 0.03],
        },
        // Stulpe: sitzt über dem Bündchen und reicht ein Stück den Arm hinauf.
        { geometry: box(0.19 * w, 0.11, 0.19 * w), color: handschuh.trim, position: [0, 0.15, 0] },
        // Knöchelband, damit die Schale eine Vorderseite hat.
        { geometry: box(0.14 * w, 0.035, 0.03), color: shade(handschuh.trim, 1.1), position: [0, 0.05, 0.078 * w] },
      );
    }
    return teile;
  };

  for (const [unterarm, thumbSide] of [
    [ellbogenR, -1],
    [ellbogenL, 1],
  ] as const) {
    const geo = assemble(handParts(thumbSide));
    const hand = new THREE.Mesh(geo, material);
    hand.position.set(0, -UNTERARM, 0);
    unterarm.add(hand);
    disposables.push(geo);
  }

  /*
   * Der Fuss muss das Bein **umschliessen**, nicht bündig daran enden.
   *
   * Vorher lag die Rückfläche des Stiefels bei -0,100·w und die des Beins
   * ebenfalls bei -0,100·w — zwei deckungsgleiche Flächen, gleich weit von
   * der Kamera weg, und der Tiefenpuffer entschied von Bild zu Bild neu,
   * welche vorn liegt. Sichtbar war das als Flimmern an den Fersen. Dieselbe
   * Falle wie bei der Unterhose, nur eine Achse weiter: die Zehenkappe war
   * zudem seitlich exakt so breit wie das Bein.
   */
  const bootParts: Part[] = [
    { geometry: rundeBox(0.23 * w, 0.1, 0.27 * w, { rund: 0.03 }), color: stiefelFarbe, position: [0, 0, 0.02] },
    // Die Spitze steht nach vorn über — ohne sie steht die Figur auf Stümpfen.
    // Vorn schmaler als hinten, sonst ist es ein Klotz mit Klotz davor.
    {
      geometry: rundeBox(0.2 * w, 0.07, 0.1 * w, { oben: 0.85, unten: 0.9, rund: 0.024 }),
      color: stiefelFarbe,
      position: [0, -0.016, 0.16],
    },
    // Schaft, nur mit echten Stiefeln. Barfuss endet das Bein am Knöchel.
    ...(schuhe
      ? [
          {
            // Grösser als das Bein, kleiner als die Sohle, und in der Tiefe
            // gegen beide versetzt: sonst fällt eine seiner Flächen mit einer
            // der beiden anderen zusammen und es flimmert wieder.
            geometry: box(0.21 * w, 0.16, 0.24 * w),
            color: schuhe.trim,
            position: [0, 0.11, 0.015] as [number, number, number],
          },
        ]
      : []),
  ];
  const stiefel: THREE.Mesh[] = [];
  for (const schienbein of [knieL, knieR]) {
    const geo = assemble(bootParts);
    const boot = new THREE.Mesh(geo, material);
    boot.position.set(0, -SCHIENBEIN, 0);
    schienbein.add(boot);
    stiefel.push(boot);
    disposables.push(geo);
  }
  const [stiefelL, stiefelR] = stiefel as [THREE.Mesh, THREE.Mesh];

  // Die Waffe haengt an der Hand. Nicht mitskalieren: der Arm ist bereits mit
  // `s` skaliert, und zweimal skaliert waere der Gruftwaerter-Knueppel dreimal
  // zu gross.
  const spec = cfg.weapon === 'none' ? undefined : WEAPON_SPECS[cfg.weapon];

  /**
   * Der Aufhänger der Waffe.
   *
   * Haltung sitzt am Halter, nicht an der Waffe selbst — so gilt sie für den
   * prozeduralen Platzhalter und für ein geliefertes Modell gleichermaßen, und
   * beim Tausch muss nichts neu gerechnet werden.
   */
  let weaponMount: THREE.Object3D | undefined;
  let placeholder: THREE.Object3D | undefined;
  let fitted: THREE.Object3D | undefined;

  if (spec) {
    weaponMount = new THREE.Object3D();
    weaponMount.position.set(spec.position[0], -UNTERARM + spec.position[1], spec.position[2]);
    weaponMount.rotation.set(spec.rotation[0], spec.rotation[1], spec.rotation[2]);
    ellbogenR.add(weaponMount);

    const weaponGeo = spec.build();
    placeholder = new THREE.Mesh(weaponGeo, material);
    weaponMount.add(placeholder);
    disposables.push(weaponGeo);
  }

  return {
    root,
    weapon: cfg.weapon === 'none' ? undefined : cfg.weapon,
    weaponMount,
    weaponSpan: spec
      ? {
          length: spec.model?.length ?? 1,
          bottom: spec.model?.bottom ?? -0.2,
          axis: spec.model?.axis === 'z' ? 'z' : 'y',
        }
      : undefined,

    setWeaponModel(model) {
      if (!weaponMount) return;

      if (fitted) {
        weaponMount.remove(fitted);
        fitted = undefined;
      }

      if (model) {
        // Geklont, weil dasselbe Modell an vielen Figuren hängt. Materialien
        // und Geometrien bleiben dabei geteilt — nur die Knoten sind eigen.
        fitted = model.clone(true);
        weaponMount.add(fitted);
      }

      // Der Platzhalter bleibt am Halter, wird aber unsichtbar. Ihn zu
      // entfernen brächte nichts und machte den Weg zurück umständlich.
      if (placeholder) placeholder.visible = model === undefined;
    },
    update(state) {
      if (state.dead) {
        // Umfallen statt verschwinden: der Kadaver bleibt bis zum Respawn.
        root.rotation.x = -Math.PI / 2.2;
        body.position.y = 0;
        return;
      }
      root.rotation.x = 0;

      const gait = Math.min(1, state.speed / 6);
      gaitPhase += state.dt * 9 * Math.max(0.35, gait);
      const schritt = Math.sin(gaitPhase);
      const swing = schritt * 0.65 * gait;

      /*
       * Der Laufzyklus.
       *
       * Hüfte und Knie laufen um eine Viertelperiode versetzt, und das ist der
       * ganze Unterschied zwischen Gehen und Staksen: das Bein pendelt nicht
       * als Stange, sondern zieht sich beim Nachholen an und streckt sich, um
       * aufzusetzen. Der Scheitel der Beugung liegt dort, wo der Fuss hinten
       * ist und nach vorn kommt — bei `-cos` für das eine, bei `+cos` für das
       * andere Bein.
       *
       * Ein Knie beugt nur in eine Richtung. Deshalb `max(0, …)`: die
       * Gegenhälfte der Schwingung wird abgeschnitten statt gespiegelt, sonst
       * knickte das Bein beim Aufsetzen nach vorn durch.
       */
      const KNIE_RUHE = 0.07;
      const knieHub = 1.15 * gait;
      let knieLinks = KNIE_RUHE + Math.max(0, -Math.cos(gaitPhase)) * knieHub;
      let knieRechts = KNIE_RUHE + Math.max(0, Math.cos(gaitPhase)) * knieHub;

      // Der Ellbogen bleibt immer etwas angewinkelt und schwingt mit. Negativ,
      // weil ein Ellbogen die Hand nach **vorn** klappt — die Gegenrichtung
      // zum Knie.
      const armBeuge = 0.16 + gait * 0.5;
      let ellbogenLinks = -(armBeuge + gait * 0.22 * Math.max(0, -schritt));
      let ellbogenRechts = -(armBeuge + gait * 0.22 * Math.max(0, schritt));

      let armLinks = -swing * 0.8;
      let armRechts = swing * 0.8;
      let koerperDrehung = 0;
      let koerperKippung = 0;
      let koerperVor = 0;
      let armRechtsSeite = 0;
      let armLinksSeite = 0;
      let hochAuf = 0;

      // Bücken. Hin und zurück in einer Bewegung: `sin(p·π)` ist bei null und
      // eins genau null, die Figur steht also am Anfang und am Ende ohne
      // Übergang wieder gerade.
      const beugung = state.pickupPhase >= 0 ? Math.sin(state.pickupPhase * Math.PI) : 0;

      if (state.attackPhase >= 0) {
        // Der Hieb wird auf die Laufhaltung **addiert** und ersetzt sie nicht.
        //
        // Beide Enden der Hiebkurve sind null, also stimmt die Haltung am
        // Anfang und am Ende genau mit der überein, die ohne Hieb gälte — und
        // wer im Laufen zuschlägt, bekommt keinen Sprung an den Übergängen.
        // Ersetzend gerechnet schnappte allein schon der Ellbogen: er ist im
        // Stand angewinkelt, die Hiebkurve beginnt aber bei null.
        const hieb = schlagpose(state.attackVariant ?? 0, state.attackPhase);
        armRechts += hieb.armX;
        armRechtsSeite = hieb.armZ;
        armLinks += hieb.armLX;
        ellbogenRechts -= hieb.ellbogen;
        koerperDrehung = hieb.koerperY;
        koerperKippung = hieb.koerperX;
        koerperVor = hieb.schritt;
        // Das vordere Bein geht mit, das hintere stemmt sich dagegen — ohne
        // das steht die Figur beim Schwung auf zwei angenagelten Füssen.
        knieLinks += Math.max(0, hieb.koerperX) * 0.9;
      } else if (beugung > 0) {
        // Der rechte Arm greift nach unten, der linke geht zum Ausgleich nach
        // hinten — so, wie man sich tatsächlich nach etwas bückt. In die Knie
        // geht man dabei ebenfalls, sonst klappt die Figur nur im Rumpf.
        armRechts = beugung * 1.5;
        armLinks = -beugung * 0.5;
        ellbogenRechts = -0.1 - beugung * 0.25;
        ellbogenLinks = -0.1 - beugung * 0.15;
        knieLinks += beugung * 0.75;
        knieRechts += beugung * 0.75;
      }

      // --- Wirbelklinge -----------------------------------------------------
      //
      // Nach dem Hieb und dem Bücken, weil sie beides übersteuert: wer wirbelt,
      // holt nicht nebenbei noch aus. Die Drehung kommt auf `koerperDrehung`
      // **oben drauf** — sie soll auch dann gelten, wenn der Rumpf aus einem
      // anderen Grund schon gedreht war.
      const wirbelPhase = state.wirbelPhase ?? -1;
      if (wirbelPhase >= 0) {
        const wirbel = wirbelpose(wirbelPhase);
        armLinks = wirbel.armX;
        armRechts = wirbel.armX;
        armRechtsSeite = wirbel.armZ;
        // Der linke Arm geht zur anderen Seite: dieselbe Zahl, anderes
        // Vorzeichen — die Schultern liegen spiegelbildlich zur Mitte.
        armLinksSeite = -wirbel.armZ;
        ellbogenLinks *= wirbel.ellbogen;
        ellbogenRechts *= wirbel.ellbogen;
        koerperDrehung += wirbel.drehung;
        koerperKippung += wirbel.kippung;
        knieRechts += wirbel.knie;
        hochAuf = wirbel.hoehe;
      }

      armL.rotation.x = armLinks;
      armR.rotation.x = armRechts;
      armR.rotation.z = armRechtsSeite;
      armL.rotation.z = armLinksSeite;
      ellbogenL.rotation.x = ellbogenLinks;
      ellbogenR.rotation.x = ellbogenRechts;
      body.rotation.y = koerperDrehung;
      body.position.z = koerperVor;

      // Der Oberkörper kippt nach vorn. Die Beine hängen am selben Knoten und
      // würden mitkippen — die ganze Figur fiele wie ein Brett nach vorn —,
      // deshalb halten sie dagegen und bleiben fast senkrecht. Beim Laufen
      // kommt eine leichte Neigung in die Bewegungsrichtung dazu.
      body.rotation.x = beugung * 0.95 + koerperKippung + gait * 0.07;
      legL.rotation.x = swing - beugung * 0.8 - koerperKippung * 0.8 - gait * 0.07;
      legR.rotation.x = -swing - beugung * 0.8 + koerperKippung * 0.45 - gait * 0.07;
      // Zurück aus der Grätsche: die Flughaltung stellt die Beine seitlich, und
      // wer absteigt, soll nicht breitbeinig weiterlaufen. Hier und nicht dort,
      // weil eine Haltung nur aufräumen kann, solange sie noch gilt.
      legL.rotation.z = 0;
      legR.rotation.z = 0;

      // Leichtes Wippen — ohne das wirkt eine stehende Figur wie ein Möbelstück.
      // Beim Bücken geht die Figur zusätzlich in die Knie. Der Lauf senkt sie
      // zusätzlich, solange beide Beine gebeugt sind: das ist der Moment, in
      // dem das Gewicht auf einem Bein hängt.
      body.position.y = Math.abs(Math.sin(gaitPhase)) * 0.05 * gait +
        Math.sin(state.time * 1.8) * 0.012 -
        beugung * 0.18 -
        Math.min(knieLinks, knieRechts) * 0.12 +
        hochAuf;

      // --- Sprung ---------------------------------------------------------
      //
      // Zuletzt und als Überblendung über alles andere: ein Sprung übersteuert
      // Schrittwerk und Wippen, aber nicht schlagartig. Beim Abheben wächst
      // `luft` von null hoch, beim Landen fällt es zurück — die Figur geht
      // also weich in die Sprunghaltung und ebenso weich wieder heraus.
      //
      // Zwei Haltungen, nicht eine: beim Steigen zieht man die Knie an und
      // nimmt die Arme hoch, beim Fallen streckt man die Beine nach unten, um
      // aufzukommen. Eine einzige Pose für beides sieht aus wie eine Puppe an
      // einem Faden.
      /*
       * --- Fliegen ---------------------------------------------------------
       *
       * **Vor** der Sprunghaltung und mit eigenem Ausgang: beides beschreibt
       * eine Figur ohne Boden unter den Füssen, und beides zugleich ergäbe
       * eine, die auf dem Brett steht und dabei die Knie anzieht. Genau das
       * war zu sehen.
       *
       * Zwei Haltungen, weil es zwei Geräte gibt: auf dem Besen sitzt man, auf
       * dem Brett steht man. Beide sind **ruhig** — kein Wippen, kein Schritt.
       * Die Bewegung des Fliegens macht die Landschaft, nicht die Figur.
       */
      const flug = state.flug ?? '';
      if (flug !== '') {
        const sitzt = flug === 'flug_besen';

        // Die Beine: auf dem Besen nach vorn und unten geknickt, auf dem Brett
        // fast gerade — die Sohlen sollen das Brett berühren und nicht daneben
        // in der Luft stehen. Auf dem Brett etwas breiter, weil man quer darauf
        // steht: die Füsse gehören über die Bindungen und nicht in die Mitte.
        legL.rotation.x = sitzt ? -1.35 : -0.06;
        legR.rotation.x = sitzt ? -1.35 : 0.06;
        legL.rotation.z = sitzt ? 0.16 : 0.13;
        legR.rotation.z = sitzt ? -0.16 : -0.13;
        knieLinks = sitzt ? 1.15 : 0.3;
        knieRechts = sitzt ? 1.15 : 0.28;

        /*
         * Die Arme: auf dem Besen nach vorn an den Stiel, auf dem Brett weit
         * zur Seite — die Haltung, mit der man über einen Balken geht.
         *
         * **Das Vorzeichen ist nicht frei wählbar.** Ein Arm hängt an seiner
         * Schulter und dreht um deren Punkt: der linke sitzt bei −X, und eine
         * positive Drehung um Z schwingt ihn nach +X, also **vor die Brust**.
         * Genau so standen die Arme hier — mit 1,15 gekreuzt vor dem Körper,
         * und von aussen sah es aus, als seien sie gar nicht da. Nach aussen
         * geht der linke Arm mit negativem, der rechte mit positivem Wert.
         * Dieselbe Regel wie bei der Wirbelklinge, siehe `armLinksSeite`.
         *
         * Weit heisst wirklich weit (knapp siebzig Grad vom Körper). Das
         * Balancieren liest man erst, wenn die Arme deutlich abstehen und die
         * Ellbogen fast gerade sind.
         */
        armL.rotation.x = sitzt ? -1.15 : -0.1;
        armR.rotation.x = sitzt ? -1.15 : -0.1;
        armL.rotation.z = sitzt ? 0.12 : -1.15;
        armR.rotation.z = sitzt ? -0.12 : 1.15;
        ellbogenL.rotation.x = sitzt ? -0.35 : -0.05;
        ellbogenR.rotation.x = sitzt ? -0.35 : -0.05;

        // Leicht nach vorn gelehnt, wie jeder, der gegen den Fahrtwind steht.
        body.rotation.x = sitzt ? 0.12 : 0.16;
        /*
         * Und auf dem Brett quer dazu — wie auf einem Snowboard.
         *
         * Nicht ganz neunzig Grad: siebzig lassen den Oberkörper zur Fahrt hin
         * offen, und das ist die Haltung, die man von Brettern kennt. Ganz quer
         * sähe die Figur aus, als schaue sie seitwärts an der Fahrt vorbei.
         *
         * Am `body` und nicht am Rig: die Beine hängen daran und drehen mit,
         * die Füsse stehen also quer über dem Brett. Drehte man das Rig, drehte
         * sich das Brett gleich mit — es hängt ebenfalls am Rig — und man
         * stünde wieder längs darauf.
         */
        body.rotation.y = sitzt ? 0 : -1.2;
        body.position.z = 0;
        // Sitzen heisst tiefer: das Gesäss liegt auf dem Stiel, und der liegt
        // unter der Hüfte. Siehe `baueFluggeraet` — dort steht dieselbe Höhe.
        body.position.y = sitzt ? -0.12 : -0.04;

        knieL.rotation.x = knieLinks;
        knieR.rotation.x = knieRechts;
        stiefelL.rotation.x = -knieLinks * 0.55;
        stiefelR.rotation.x = -knieRechts * 0.55;
        return;
      }

      const luft = Math.max(0, Math.min(1, state.luft ?? 0));
      if (luft > 0) {
        const steigt = state.steigt === true;
        const misch = (jetzt: number, sprung: number): number =>
          jetzt * (1 - luft) + sprung * luft;

        legL.rotation.x = misch(legL.rotation.x, steigt ? -1.0 : 0.18);
        legR.rotation.x = misch(legR.rotation.x, steigt ? -0.7 : -0.12);
        // Erst mit dem Knie wird aus „Bein hoch" ein angezogenes Bein.
        knieLinks = misch(knieLinks, steigt ? 1.35 : 0.12);
        knieRechts = misch(knieRechts, steigt ? 0.95 : 0.1);
        armL.rotation.x = misch(armL.rotation.x, steigt ? -1.25 : -0.55);
        armR.rotation.x = misch(armR.rotation.x, steigt ? -1.05 : -0.45);
        ellbogenL.rotation.x = misch(ellbogenL.rotation.x, steigt ? -0.75 : -0.3);
        ellbogenR.rotation.x = misch(ellbogenR.rotation.x, steigt ? -0.7 : -0.28);
        body.rotation.x = misch(body.rotation.x, steigt ? -0.14 : 0.1);
        body.position.y = misch(body.position.y, steigt ? 0.07 : -0.05);
      }

      knieL.rotation.x = knieLinks;
      knieR.rotation.x = knieRechts;
      // Der Knöchel hält den Fuss flacher, als das Schienbein ihn stellen
      // würde. Ohne ihn zeigt die Sohle bei jedem angezogenen Knie nach
      // hinten, und die Figur läuft wie eine Marionette.
      stiefelL.rotation.x = -knieLinks * 0.55;
      stiefelR.rotation.x = -knieRechts * 0.55;
    },
    dispose() {
      for (const g of disposables) g.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Kreaturen
// ---------------------------------------------------------------------------

export interface CreatureConfig {
  kind: 'creature';
  variant: 'blob' | 'quadruped' | 'crawler';
  size: number;
  primary: number;
  secondary: number;
  accent: number;
}

function makeBlob(cfg: CreatureConfig, material: THREE.Material): CharacterRig {
  const disposables: THREE.BufferGeometry[] = [];
  // Fortgeschriebene Schrittphase. Siehe RigState.dt: aus der absoluten
  // Uhr berechnet, spraenge sie bei jedem Tempowechsel.
  let gaitPhase = 0;
  const root = new THREE.Object3D();
  const body = new THREE.Object3D();
  root.add(body);

  const coreGeo = assemble([
    { geometry: sphere(0.42 * cfg.size, 1), color: cfg.primary, position: [0, 0.7 * cfg.size, 0] },
    { geometry: sphere(0.16 * cfg.size, 0), color: cfg.accent, position: [0, 0.7 * cfg.size, 0.3 * cfg.size] },
  ]);
  const core = new THREE.Mesh(coreGeo, material);
  body.add(core);
  disposables.push(coreGeo);

  // Drei Trabanten, die um den Kern kreisen.
  const orbiters: THREE.Object3D[] = [];
  for (let i = 0; i < 3; i++) {
    const geo = sphere(0.1 * cfg.size, 0);
    const holder = new THREE.Object3D();
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(0.55 * cfg.size, 0, 0);
    holder.position.y = 0.7 * cfg.size;
    holder.rotation.y = (i / 3) * Math.PI * 2;
    holder.add(mesh);
    body.add(holder);
    orbiters.push(holder);
    disposables.push(geo);
  }

  return {
    root,
    update(state) {
      if (state.dead) {
        body.scale.setScalar(0.3);
        body.position.y = -0.3;
        return;
      }
      body.scale.setScalar(1);
      // Schweben, nicht laufen — deshalb keine Beine und ein deutlicher Hub.
      body.position.y = Math.sin(state.time * 2.2) * 0.16 + 0.2;
      for (let i = 0; i < orbiters.length; i++) {
        orbiters[i]!.rotation.y = state.time * 1.6 + (i / orbiters.length) * Math.PI * 2;
      }
      if (state.attackPhase >= 0) {
        const p = 1 - Math.abs(state.attackPhase - 0.5) * 2;
        body.scale.set(1 + p * 0.3, 1 - p * 0.2, 1 + p * 0.3);
      }
    },
    dispose() {
      for (const g of disposables) g.dispose();
    },
  };
}

function makeQuadruped(cfg: CreatureConfig, material: THREE.Material): CharacterRig {
  const disposables: THREE.BufferGeometry[] = [];
  // Fortgeschriebene Schrittphase. Siehe RigState.dt: aus der absoluten
  // Uhr berechnet, spraenge sie bei jedem Tempowechsel.
  let gaitPhase = 0;
  const s = cfg.size;
  const root = new THREE.Object3D();
  const body = new THREE.Object3D();
  root.add(body);

  const trunkGeo = assemble([
    { geometry: box(0.62 * s, 0.5 * s, 1.05 * s), color: cfg.primary, position: [0, 0.62 * s, 0] },
    { geometry: box(0.42 * s, 0.38 * s, 0.42 * s), color: cfg.primary, position: [0, 0.72 * s, 0.66 * s] },
    { geometry: cone(0.12 * s, 0.3 * s, 5), color: cfg.accent, position: [0, 0.62 * s, 0.9 * s], rotation: [Math.PI / 2, 0, 0] },
    { geometry: box(0.1 * s, 0.16 * s, 0.06 * s), color: cfg.secondary, position: [-0.14 * s, 0.94 * s, 0.6 * s] },
    { geometry: box(0.1 * s, 0.16 * s, 0.06 * s), color: cfg.secondary, position: [0.14 * s, 0.94 * s, 0.6 * s] },
    { geometry: box(0.1 * s, 0.1 * s, 0.4 * s), color: cfg.secondary, position: [0, 0.72 * s, -0.66 * s] },
  ]);
  const trunk = new THREE.Mesh(trunkGeo, material);
  body.add(trunk);
  disposables.push(trunkGeo);

  const legs: THREE.Object3D[] = [];
  const positions: Array<[number, number]> = [
    [-0.22 * s, 0.36 * s],
    [0.22 * s, 0.36 * s],
    [-0.22 * s, -0.36 * s],
    [0.22 * s, -0.36 * s],
  ];
  for (const [x, z] of positions) {
    const geo = box(0.14 * s, 0.44 * s, 0.14 * s);
    const leg = joint(geo, material, shade(cfg.secondary, 0.9), [x, 0.44 * s, z], [0, -0.22 * s, 0], disposables);
    body.add(leg);
    legs.push(leg);
  }

  return {
    root,
    update(state) {
      if (state.dead) {
        root.rotation.z = Math.PI / 2.1;
        return;
      }
      root.rotation.z = 0;

      const gait = Math.min(1, state.speed / 5);
      gaitPhase += state.dt * 11 * Math.max(0.3, gait);
      const t = gaitPhase;
      // Diagonalgang: vorne links mit hinten rechts.
      legs[0]!.rotation.x = Math.sin(t) * 0.7 * gait;
      legs[3]!.rotation.x = Math.sin(t) * 0.7 * gait;
      legs[1]!.rotation.x = -Math.sin(t) * 0.7 * gait;
      legs[2]!.rotation.x = -Math.sin(t) * 0.7 * gait;

      if (state.attackPhase >= 0) {
        const p = state.attackPhase;
        // Kopf runter, dann vorschnellen.
        body.rotation.x = p < 0.5 ? -0.35 * (p / 0.5) : -0.35 + 0.75 * ((p - 0.5) / 0.5);
      } else {
        body.rotation.x = Math.sin(state.time * 2) * 0.02;
      }
    },
    dispose() {
      for (const g of disposables) g.dispose();
    },
  };
}

/**
 * Der Höhlenkriecher.
 *
 * Hier lag eine flachgedrückte Kugel mit sechs Strichen daran, in fast
 * schwarzem Blaugrau. Auf einem Modellblatt ging das durch; im Spiel war das
 * Tier **unsichtbar** — nachts sowieso, tagsüber ein dunkler Fleck im Gras, an
 * dem nur die Namensschrift darüber verriet, dass dort etwas steht. Der
 * Nutzer hat es als „hat kein 3D-Modell" gemeldet, und das war die richtige
 * Beschreibung dessen, was man sah.
 *
 * Drei Dinge daran waren falsch, und alle drei sind hier behoben:
 *
 *   1. **Zu dunkel.** Ein Wesen muss sich vom Untergrund abheben, und der
 *      Untergrund ist Gras. Der Panzer ist jetzt ein helles Kalkgrau mit
 *      warmen Platten darauf — dieselbe Familie wie Knochen und Stein, aber
 *      hell genug, dass die Silhouette auch im Schatten steht.
 *   2. **Zu flach.** Der Körper lag auf dem Boden, also war die Silhouette
 *      aus Spielerhöhe eine Linie. Jetzt steht er auf gebogenen Beinen, und
 *      zwischen Bauch und Boden ist Luft — Licht kommt darunter durch, und
 *      genau das macht aus einem Fleck ein Tier.
 *   3. **Keine Teile, die man wiedererkennt.** Ein Kopf mit Kiefern, ein
 *      gegliederter Hinterleib, Platten auf dem Rücken und ein Stachel. Das
 *      ist es, woran man aus zwanzig Metern erkennt, was einen da angreift.
 */
function makeCrawler(cfg: CreatureConfig, material: THREE.Material): CharacterRig {
  const disposables: THREE.BufferGeometry[] = [];
  // Fortgeschriebene Schrittphase. Siehe RigState.dt: aus der absoluten
  // Uhr berechnet, spraenge sie bei jedem Tempowechsel.
  let gaitPhase = 0;
  const s = cfg.size;
  const root = new THREE.Object3D();
  const body = new THREE.Object3D();
  root.add(body);

  const panzer = cfg.primary;
  const platte = shade(cfg.primary, 0.72);
  const bauch = shade(cfg.secondary, 1.15);

  /*
   * Der Rumpf.
   *
   * Drei Glieder statt eines Klumpens: Vorderleib, Rücken, Hinterleib. Sie
   * werden nach hinten kleiner und sitzen leicht höher — das ist die Linie,
   * an der man einen Käfer erkennt, bevor man Einzelheiten sieht.
   */
  const rumpfTeile: Part[] = [
    { geometry: sphere(0.34 * s, 1), color: panzer, position: [0, 0.62 * s, 0.34 * s], scale: [1.05, 0.78, 1] },
    { geometry: sphere(0.42 * s, 1), color: panzer, position: [0, 0.66 * s, -0.06 * s], scale: [1.1, 0.82, 1.15] },
    { geometry: sphere(0.32 * s, 1), color: shade(panzer, 0.9), position: [0, 0.6 * s, -0.56 * s], scale: [1, 0.8, 1.2] },
    // Der Bauch, heller: er fängt das Licht von unten und trennt den Körper
    // sichtbar vom Boden.
    { geometry: sphere(0.3 * s, 1), color: bauch, position: [0, 0.46 * s, -0.06 * s], scale: [1.15, 0.5, 1.3] },
  ];

  /*
   * Die Platten auf dem Rücken.
   *
   * Drei flache Keile, nach hinten kleiner. Sie sind der Grund, warum das
   * Tier von oben — also aus der Spielkamera — nicht wie ein Kiesel aussieht:
   * sie werfen Kanten, und Kanten liest das Auge als Panzer.
   */
  for (let i = 0; i < 3; i++) {
    rumpfTeile.push({
      geometry: box(0.5 * s - i * 0.09 * s, 0.07 * s, 0.26 * s),
      color: platte,
      position: [0, (0.86 - i * 0.03) * s, (0.12 - i * 0.34) * s],
      rotation: [0.22 - i * 0.1, 0, 0],
    });
  }

  // Der Stachel am Hinterleib: er sagt „das tut weh", bevor es weh tut.
  rumpfTeile.push({
    geometry: cone(0.09 * s, 0.42 * s, 5),
    color: cfg.accent,
    position: [0, 0.72 * s, -0.84 * s],
    rotation: [-1.15, 0, 0],
  });

  const rumpfGeo = assemble(rumpfTeile);
  const rumpf = new THREE.Mesh(rumpfGeo, material);
  body.add(rumpf);
  disposables.push(rumpfGeo);

  /*
   * Der Kopf sitzt an einem eigenen Halter.
   *
   * Damit kann er beim Zuschlagen vorschnellen, während der Rumpf steht —
   * ein Tier, das beim Angriff mit dem ganzen Körper springt, sieht aus, als
   * würde es geschoben.
   */
  const kopf = new THREE.Object3D();
  kopf.position.set(0, 0.58 * s, 0.62 * s);
  body.add(kopf);

  const kopfTeile: Part[] = [
    { geometry: sphere(0.26 * s, 1), color: shade(panzer, 1.06), position: [0, 0, 0], scale: [1.1, 0.8, 1] },
    // Die Kiefer: zwei Zangen, nach innen gebogen.
    { geometry: cone(0.07 * s, 0.34 * s, 4), color: platte, position: [-0.14 * s, -0.06 * s, 0.26 * s], rotation: [1.35, 0, 0.34] },
    { geometry: cone(0.07 * s, 0.34 * s, 4), color: platte, position: [0.14 * s, -0.06 * s, 0.26 * s], rotation: [1.35, 0, -0.34] },
    // Zwei Fühler, damit der Kopf eine Richtung hat.
    { geometry: cylinder(0.02 * s, 0.03 * s, 0.4 * s, 4), color: platte, position: [-0.12 * s, 0.2 * s, 0.16 * s], rotation: [-0.7, 0, 0.5] },
    { geometry: cylinder(0.02 * s, 0.03 * s, 0.4 * s, 4), color: platte, position: [0.12 * s, 0.2 * s, 0.16 * s], rotation: [-0.7, 0, -0.5] },
  ];
  /*
   * Und die Augen — vier, in zwei Grössen.
   *
   * Sie sind das Einzige an diesem Tier, was leuchtet, und sie sind der
   * Grund, warum man es im Dunkeln überhaupt findet. Ein sehr heller kalter
   * Wert wirkt bei Lambert wie Glut, weil ringsum alles dunkel ist.
   */
  for (const [x, y, r] of [
    [-0.13, 0.06, 0.055],
    [0.13, 0.06, 0.055],
    [-0.2, -0.02, 0.035],
    [0.2, -0.02, 0.035],
  ] as Array<[number, number, number]>) {
    kopfTeile.push({
      geometry: sphere(r * s, 0),
      color: cfg.accent,
      position: [x * s, y * s, 0.2 * s],
    });
  }
  const kopfGeo = assemble(kopfTeile);
  kopf.add(new THREE.Mesh(kopfGeo, material));
  disposables.push(kopfGeo);

  /*
   * Acht Beine in zwei Gliedern.
   *
   * Zwei Glieder und nicht eines: ein gerader Strich vom Körper zum Boden ist
   * ein Stelzenbein, ein geknicktes ist ein Insektenbein. Der Knick steht
   * **über** dem Körper — genau das ist die Silhouette, an der man eine
   * Spinne von einem Hund unterscheidet.
   */
  const beine: Array<{ huefte: THREE.Object3D; knie: THREE.Object3D }> = [];
  for (let i = 0; i < 8; i++) {
    const seite = i % 2 === 0 ? -1 : 1;
    const reihe = Math.floor(i / 2) - 1.5;

    const oberGeo = box(0.06 * s, 0.34 * s, 0.06 * s);
    const huefte = joint(
      oberGeo,
      material,
      platte,
      [seite * 0.34 * s, 0.6 * s, reihe * 0.3 * s],
      [0, -0.17 * s, 0],
      disposables,
    );
    // Nach aussen **und** nach oben: der Knick liegt über dem Rücken.
    huefte.rotation.z = seite * 1.15;

    const unterGeo = box(0.05 * s, 0.46 * s, 0.05 * s);
    const knie = joint(
      unterGeo,
      material,
      shade(platte, 0.85),
      [0, -0.34 * s, 0],
      [0, -0.23 * s, 0],
      disposables,
    );
    knie.rotation.z = -seite * 1.85;
    huefte.add(knie);
    body.add(huefte);
    beine.push({ huefte, knie });
  }

  return {
    root,
    update(state) {
      if (state.dead) {
        /*
         * Auf dem Rücken, mit den Beinen nach oben — und zwar über `body`.
         *
         * `root.position` gehört der **Weltansicht**: dort steht, wo das Wesen
         * in der Welt ist. Hier stand einmal `root.position.y = 0.42 * s` im
         * Tod und `= 0` im Leben, und das war kein Feinschliff, sondern der
         * Grund, warum der Höhlenkriecher im Spiel unsichtbar war: die Zeile
         * überschrieb in jedem Bild die Höhe, die die Weltansicht gerade
         * gesetzt hatte. Auf einer Wiese vier Meter über null steckte das Tier
         * damit vier Meter im Boden — Namensschild und Schadenszahlen kamen an,
         * zu sehen war nichts. Kein anderes Rig fasst `root.position` an.
         *
         * Der Dreh geht um den Ursprung von `body`, und der liegt am Boden:
         * der Rumpf sitzt bei 0,62 darüber und käme nach dem Umklappen ebenso
         * weit darunter zu liegen. Die doppelte Höhe hebt ihn wieder heraus.
         */
        root.rotation.z = Math.PI;
        // Der Dreh geht um den Ursprung, und der liegt am Boden: der Rumpf
        // sitzt 0,62 darüber und käme ebenso weit darunter zu liegen. Der
        // Versatz im **Rumpf** holt ihn heraus — negativ, weil die Drehung um
        // Pi jedes lokale Oben zu einem Unten macht.
        body.position.set(0, -1.05 * s, 0);
        return;
      }
      root.rotation.z = 0;

      const gait = Math.min(1, state.speed / 4.5);
      gaitPhase += state.dt * 13 * Math.max(0.3, gait);
      for (let i = 0; i < beine.length; i++) {
        const seite = i % 2 === 0 ? -1 : 1;
        const phase = gaitPhase + i * 0.82;
        beine[i]!.huefte.rotation.x = Math.sin(phase) * 0.42 * gait;
        beine[i]!.huefte.rotation.z = seite * (1.15 + Math.cos(phase) * 0.18 * gait);
        // Das Knie zieht gegenläufig an: sonst stakst das Tier, statt zu
        // laufen.
        beine[i]!.knie.rotation.x = -Math.sin(phase) * 0.3 * gait;
      }
      body.position.y = Math.sin(state.time * 6) * 0.035 * s;

      if (state.attackPhase >= 0) {
        const p = 1 - Math.abs(state.attackPhase - 0.5) * 2;
        // Der Kopf schnellt vor, der Rumpf folgt nur zum Teil.
        kopf.position.z = (0.62 + p * 0.4) * s;
        kopf.rotation.x = p * 0.5;
        body.position.z = p * 0.18 * s;
      } else {
        kopf.position.z = 0.62 * s;
        kopf.rotation.x = 0;
        body.position.z = 0;
      }
    },
    dispose() {
      for (const g of disposables) g.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Katalog
// ---------------------------------------------------------------------------

export type CharacterConfig = HumanoidConfig | CreatureConfig;

export const CHARACTER_CONFIGS: Record<string, CharacterConfig> = {
  player: {
    kind: 'humanoid',
    height: 1.8,
    bulk: 1,
    skin: 0xe0b087,
    shirt: 0x4a6f9c,
    pants: 0x3a4652,
    hair: 0x4a3527,
    accent: 0x8a5a3c,
    weapon: 'sword',
    // Der einzige, der sich ausziehen kann. Was ein Spieler anhat, sagt seine
    // Ausrüstung — `shirt` und `pants` sind hier nur noch der Rückfall für
    // eine Figur, die aus irgendeinem Grund ohne Ausrüstungsangabe gebaut
    // wird, und für die Farbe der nackten Haut spielen sie keine Rolle.
    dressed: false,
  },

  npc_guide: {
    kind: 'humanoid',
    height: 1.85,
    bulk: 1,
    skin: 0xd9a97c,
    shirt: 0x5f8f6a,
    pants: 0x3c4a3f,
    hair: 0x8a7a5c,
    accent: 0xd8c47a,
    weapon: 'staff',
  },
  npc_smith: {
    kind: 'humanoid',
    height: 1.9,
    bulk: 1.25,
    skin: 0xc99168,
    shirt: 0x6b4a35,
    pants: 0x3a3128,
    hair: 0x2f2118,
    accent: 0x8a8478,
    weapon: 'club',
  },
  npc_merchant: {
    kind: 'humanoid',
    height: 1.72,
    bulk: 0.95,
    skin: 0xe4bc95,
    shirt: 0x8c5a8f,
    pants: 0x4a3a52,
    hair: 0x5c3a2a,
    accent: 0xd8b84a,
    weapon: 'none',
  },
  // Der Kampfmeister: gross, dunkel gekleidet, Klinge am Gürtel. Er lehrt den
  // Krieger, also trägt er, womit ein Krieger kämpft.
  npc_master: {
    kind: 'humanoid',
    height: 1.95,
    bulk: 1.2,
    skin: 0xc08a62,
    shirt: 0x4a3a3a,
    pants: 0x2f2a2a,
    hair: 0x8c8478,
    accent: 0xb0342c,
    weapon: 'sword',
  },
  npc_gatekeeper: {
    kind: 'humanoid',
    height: 2.0,
    bulk: 1.2,
    skin: 0xd0a078,
    shirt: 0x50565e,
    pants: 0x3a3f45,
    hair: 0x3a3028,
    accent: 0x9aa4b0,
    weapon: 'club',
  },

  mob_mote: {
    kind: 'creature',
    variant: 'blob',
    size: 1,
    primary: 0x7fd8e8,
    secondary: 0x5fb0c8,
    accent: 0xe8f8ff,
  },
  mob_pup: {
    kind: 'creature',
    variant: 'quadruped',
    size: 0.9,
    primary: 0x8a6a4a,
    secondary: 0x6a4f36,
    accent: 0xc8b090,
  },
  mob_boar: {
    kind: 'creature',
    variant: 'quadruped',
    size: 1.35,
    primary: 0x5a4a3f,
    secondary: 0x3f342c,
    accent: 0xd8cdb4,
  },
  mob_bandit: {
    kind: 'humanoid',
    height: 1.9,
    bulk: 1.05,
    skin: 0xc99168,
    shirt: 0x5a3a3a,
    pants: 0x3a2f2a,
    hair: 0x241a14,
    accent: 0x8a2f2f,
    weapon: 'sword',
  },
  /*
   * Der Höhlenkriecher — hell, nicht dunkel.
   *
   * Hier stand ein Panzer in 0x4a4a5c, also ein sehr dunkles Blaugrau. Auf
   * einer Wiese und erst recht bei Nacht war das Tier damit nicht zu sehen.
   * Ein Wesen, das man treffen soll, muss sich vom Boden abheben — und der
   * Boden ist grün und mittelhell. Also Kalkgrau mit einem Stich ins Warme.
   */
  mob_crawler: {
    kind: 'creature',
    variant: 'crawler',
    size: 1.2,
    primary: 0xb9b3a2,
    secondary: 0xd8d2bd,
    accent: 0x7fe8d8,
  },
  /*
   * Die beiden Begleiter.
   *
   * Dieselbe Vierbeinerform wie die Monster und bewusst keine eigene: was ein
   * Tier von einem anderen unterscheidet, sind Grösse und Farbe, und dafür
   * eine zweite Bauart zu schreiben hiesse, jede Verbesserung am Gang
   * zweimal zu machen.
   */
  pet_ratte: {
    kind: 'creature',
    variant: 'quadruped',
    size: 0.5,
    primary: 0x8f8578,
    secondary: 0x6a6055,
    accent: 0xd8b8a8,
  },
  pet_fuchs: {
    kind: 'creature',
    variant: 'quadruped',
    size: 0.8,
    primary: 0xc9762f,
    secondary: 0x8a4a1c,
    accent: 0xf0e0d0,
  },
  mob_warden: {
    kind: 'humanoid',
    height: 3.4,
    bulk: 1.7,
    skin: 0x8a8a94,
    shirt: 0x3a3a48,
    pants: 0x2a2a34,
    hair: 0x1a1a22,
    accent: 0x9a7fe8,
    weapon: 'club',
  },
};

/**
 * Besen oder Brett — das Ding unter der Figur.
 *
 * Kein Rig, sondern ein paar Kästen an einer Gruppe: ein Fluggerät bewegt
 * nichts an sich selbst. Es hängt am Rig der Figur und macht deren Drehung und
 * Bewegung mit, ohne dass irgendwo eine zweite Position gepflegt wird.
 *
 * Die Masse sind so gewählt, dass die Figur **darauf** steht und nicht darin:
 * die Oberkante liegt knapp unter den Füssen, also bei y = 0 des Rigs.
 */
export function baueFluggeraet(model: string, material: THREE.Material): THREE.Group {
  const gruppe = new THREE.Group();
  const kasten = (
    w: number,
    h: number,
    t: number,
    farbe: number,
    x: number,
    y: number,
    z: number,
    drehung = 0,
  ): void => {
    const mesh = new THREE.Mesh(paint(new THREE.BoxGeometry(w, h, t), farbe), material);
    mesh.position.set(x, y, z);
    mesh.rotation.x = drehung;
    mesh.castShadow = true;
    gruppe.add(mesh);
  };

  /*
   * Die Höhe ist keine Geschmacksfrage.
   *
   * Der Nullpunkt liegt bei den Füssen der Figur. Ein Brett gehört also knapp
   * darunter — man steht darauf. Ein Besen gehört unter die **Hüfte**, denn
   * man sitzt darauf, und die liegt bei dieser Figur gut siebzig Zentimeter
   * höher. Hier lagen beide auf derselben Höhe, und der Besen schwebte
   * zwischen den Knöcheln, während die Figur darüber in der Luft sass.
   *
   * Die Gegenzahl steht in `rigs`' Flughaltung (`body.position.y`): wer eine
   * ändert, muss die andere ansehen.
   */
  if (model === 'flug_besen') {
    // Stiel der Länge nach, Reisig hinten, Griff vorn — auf Sitzhöhe.
    // 0,75 ist keine gewählte Zahl: das Hüftgelenk der Figur liegt bei 0,92,
    // die Flughaltung senkt sie um 0,12, und ein Stiel von 0,09 Dicke liegt
    // mit seiner Oberkante dann genau unter dem Gesäss.
    kasten(0.09, 0.09, 2.1, 0x6b4423, 0, 0.75, 0.15);
    kasten(0.26, 0.26, 0.55, 0xb08b4f, 0, 0.75, -1.05);
    kasten(0.12, 0.12, 0.3, 0x8a6a3a, 0, 0.89, 0.95);
    return gruppe;
  }

  // Brett: flach, breit, mit zwei Kufen darunter. Die Oberseite liegt bei
  // null — genau dort, wo die Sohlen stehen.
  kasten(0.62, 0.09, 1.9, 0x4a3f36, 0, -0.045, 0);
  kasten(0.5, 0.04, 1.5, 0x3f7fa8, 0, 0.01, 0);
  kasten(0.08, 0.06, 1.5, 0x2a2622, -0.22, -0.115, 0);
  kasten(0.08, 0.06, 1.5, 0x2a2622, 0.22, -0.115, 0);
  return gruppe;
}

/**
 * Frisches Rig.
 *
 * `weapon` übersteuert, was die Figur in der Hand hält — es kommt aus dem
 * Snapshot und damit aus der Ausrüstung des Servers. Ohne das stünde jeder mit
 * dem Schwert da, das in der Figurenbeschreibung voreingestellt ist.
 */
export function createRig(
  key: string,
  material: THREE.Material,
  weapon?: string,
  outfit?: string,
): CharacterRig {
  const base = CHARACTER_CONFIGS[key] ?? CHARACTER_CONFIGS.player!;
  let cfg: CharacterConfig =
    base.kind === 'humanoid' && weapon && isWeaponKey(weapon)
      ? { ...base, weapon }
      : base.kind === 'humanoid' && weapon === 'none'
        ? { ...base, weapon: 'none' as const }
        : base;

  // Das Aussehen kommt als Zeichenkette aus dem Snapshot — für die eigene
  // Figur genauso wie für fremde. Der Client rechnet es sich nicht selbst aus
  // dem Beutel zusammen: dann gäbe es zwei Wahrheiten darüber, was jemand
  // anhat, und die auseinanderlaufende wäre die eigene.
  if (cfg.kind === 'humanoid' && outfit !== undefined && outfit !== '') {
    cfg = { ...cfg, outfit: decodeOutfit(outfit) };
  }

  if (cfg.kind === 'humanoid') return makeHumanoid(cfg, material);
  switch (cfg.variant) {
    case 'blob':
      return makeBlob(cfg, material);
    case 'crawler':
      return makeCrawler(cfg, material);
    default:
      return makeQuadruped(cfg, material);
  }
}
