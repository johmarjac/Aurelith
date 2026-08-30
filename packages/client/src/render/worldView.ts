/**
 * Alles Sichtbare einer Map: Boden, Props, Figuren.
 *
 * Zwei Dinge passieren hier, die man leicht übersieht:
 *
 * **Props werden instanziiert.** Sechshundert Bäume sind ein Draw-Call je
 * Modellart, nicht sechshundert Objekte. Deshalb liegt jedes Prop als eine
 * verschmolzene Geometrie mit Vertexfarben vor.
 *
 * **Fremde Figuren werden interpoliert.** Snapshots kommen zehnmal je Sekunde,
 * gezeichnet wird sechzigmal. Ohne Interpolation ruckelt jede Bewegung außer
 * der eigenen. Die eigene Figur läuft über die Prediction und wird hier nur
 * gesetzt, nicht geglättet.
 */

import * as THREE from 'three';
import type { CoreWorld } from '@aurelith/core';
import {
  EntityState,
  EntityType,
  getItem,
  getMob,
  getNpc,
  type MapDocument,
  type SpawnRow,
  type UpdateRow,
} from '@aurelith/shared';
import type { QualitySettings } from '../config.ts';
import type { ModelRegistry } from './modelRegistry.ts';
import { baueFluggeraet } from './rigs.ts';
import { Lanterns, type LanternPlacement } from './lanterns.ts';
import { LootView } from './lootView.ts';
import { WeaponAura } from './weaponAura.ts';
import { SetAura } from './setAura.ts';
import { stepAuras } from './auraClock.ts';
import { ParticleField } from './particles.ts';
import { Bandspur, BRETTBAND, KLINGENBAND } from './bandspur.ts';
import { Laufmarke } from './laufmarke.ts';
import { PortalRing } from './portal.ts';
import { buildTerrain, type TerrainMesh } from './terrain.ts';
import { Grasteppich } from './gras.ts';
import type { TextureLoader } from './textures.ts';
import type { CharacterRig } from './rigs.ts';
import { SICHTWEITEN, type SichtweiteStufe } from '../ui/grafik.ts';

/** Wie lange die Schlaganimation läuft, unabhängig von der Serverabklingzeit. */
export const ATTACK_ANIM_SECONDS = 0.45;
/**
 * Wie lange das Bücken dauert.
 *
 * Länger als ein Schlag: greifen, fassen, aufrichten. Kürzer als eine
 * Sekunde, weil man sonst beim Einsammeln einer Wiese mehr wartet als läuft —
 * und weil die Geste nichts blockiert, ist sie reine Zierde.
 */
export const PICKUP_ANIM_SECONDS = 0.7;

/**
 * Wie lange die Wirbelklinge dreht.
 *
 * Deutlich länger als ein Schlag — es sind zwei ganze Umdrehungen. Kürzer
 * ginge, sähe aber nach Zappeln aus: unter etwa einer Sekunde nimmt das Auge
 * die Figur nicht mehr als drehend wahr, sondern als flackernd.
 *
 * Ungebunden an die Abklingzeit der Fertigkeit, wie schon beim Schlag: die
 * eine Zahl ist Spielregel und steht in `classes.json`, die andere ist Bild.
 */
export const WIRBEL_ANIM_SECONDS = 1.05;

/**
 * Flugzeit eines Pfeils, unabhängig von der Entfernung.
 *
 * Feste Zeit statt fester Geschwindigkeit: bei achtzehn Metern Reichweite
 * wäre ein realistisch langsamer Pfeil eine halbe Sekunde unterwegs, und der
 * Schaden ist längst gefallen. Kurz und gleichmäßig liest sich besser als
 * korrekt.
 */
const ARROW_FLIGHT_SECONDS = 0.16;

/**
 * Abstand zwischen zwei Schweifpunkten, in Sekunden Flugzeit.
 *
 * In Zeit gerechnet und nicht je Bild: sonst zöge ein Pfeil bei 120 Bildern
 * die doppelte Zahl Punkte hinter sich her wie bei 60, und der Schweif wäre
 * auf schnellen Geräten doppelt so dicht. Bei 0,16 Sekunden Flug ergeben
 * zwölf Millisekunden gut ein Dutzend Punkte — genug für eine Linie, wenig
 * genug, dass zehn gleichzeitige Pfeile die Wolke nicht füllen.
 */
const ARROW_TRAIL_STEP = 0.012;

/**
 * Die Farbe des Schweifs, je Waffenart.
 *
 * Was keinen Eintrag hat, zieht keinen: eine Faust schwingt nichts, und ein
 * Bogen wird gespannt, nicht geschwungen. Die Tabelle ist damit zugleich die
 * Antwort auf „wer bekommt überhaupt einen Schweif" — eine zweite Liste
 * daneben liefe irgendwann auseinander.
 */
const SCHWEIF_FARBEN: Record<string, [number, number, number] | undefined> = {
  // Stahl: kühl und hell, mit einem Stich ins Blaue.
  sword: [0.62, 0.82, 1.0],
  // Holz und Wucht: warm, etwas satter.
  club: [1.0, 0.72, 0.38],
  // Magie: violett, deutlich dunkler als die Klinge — sonst überstrahlt der
  // Schweif den Stab selbst.
  staff: [0.68, 0.5, 1.0],
};

interface FlyingArrow {
  mesh: THREE.Mesh;
  /** Läuft, wenn der Pfeil ankommt. Dort gehören Funken und Zahl hin. */
  onArrive?: () => void;
  /** Reststrecke bis zum nächsten Schweifpunkt. */
  trailAccum: number;
  fromX: number;
  fromY: number;
  fromZ: number;
  toX: number;
  toY: number;
  toZ: number;
  elapsed: number;
}

export interface EntityVisual {
  id: number;
  type: EntityType;
  defId: string;
  name: string;
  level: number;
  hp: number;
  maxHp: number;
  state: EntityState;

  /**
   * Höhe im vorigen Bild — nur, um Steigen von Fallen zu unterscheiden.
   *
   * Die senkrechte Geschwindigkeit steht im Kern, kommt aber nicht über das
   * Netz: sie im Schnappschuss mitzuführen wären vier Byte je Wesen und Bild
   * für eine Angabe, die sich hier aus zwei Höhen ablesen lässt.
   */
  hoeheVorher: number;

  /** Gezeichnete Position — läuft der Zielposition hinterher. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Zuletzt vom Server gemeldete Position. */
  targetX: number;
  targetY: number;
  targetZ: number;
  targetYaw: number;

  /** Sekunden seit Beginn der Schlaganimation, oder negativ. */
  attackTimer: number;
  /**
   * Welcher der drei Hiebe zuletzt begonnen hat.
   *
   * Reihum je Figur, damit zwei Schläge hintereinander nicht gleich aussehen.
   * Je Figur und nicht global: sonst hinge die Abwechslung daran, wer sonst
   * noch gerade zuschlägt, und ein einzelner Kämpfer sähe Zufall statt Folge.
   */
  attackVariant: number;
  /**
   * Läuft während einer Geste — Sekunden seit ihrem Beginn, sonst negativ.
   *
   * Getrennt vom Schlag, weil beides zugleich vorkommen kann und weil eine
   * Geste nichts mit dem Kampf zu tun hat: sie kommt vom Server als Ereignis
   * und nicht aus dem Zustand der Simulation.
   */
  pickupTimer: number;
  /**
   * Läuft während der Wirbelklinge — Sekunden seit ihrem Beginn, sonst negativ.
   *
   * Eine eigene Uhr neben `attackTimer`: die Drehung dauert doppelt so lange
   * wie ein Hieb, und wer beides auf dieselbe Uhr legte, müsste bei jedem
   * Blick darauf erst nachsehen, welche Bewegung gerade gemeint ist.
   */
  wirbelTimer: number;
  /** Geschätztes Tempo für die Laufanimation. */
  speed: number;

  /** Verfolgt dieses Wesen gerade jemanden? Färbt das Namensschild. */
  aggro: boolean;

  rig: CharacterRig;
  /** Was die Figur in der Hand hält. Ändert sich beim Anlegen einer Waffe. */
  weapon: string;
  /** Aufwertungsstufe der Waffe. Ab +4 hängt eine Aura daran. */
  weaponUpgrade: number;
  /** Was die Figur anhat — kodiert wie in `encodeOutfit`. */
  outfit: string;
  /** Der Funkenschleier um die Waffe, sofern es einen gibt. */
  aura?: WeaponAura;
  /** Stufe des leuchtenden Rüstungssatzes. 0 heisst: kein Satz, kein Schein. */
  setGlow: number;
  /** Worauf diese Figur fliegt — Modellschlüssel, leer heisst: am Boden. */
  flug: string;
  /** Das Gerät unter ihr, solange sie fliegt. */
  flugMesh?: THREE.Object3D;
  /**
   * Wie schräg die Figur gerade in der Luft liegt, im Bogenmass.
   *
   * Kommt aus dem Kern — bei der eigenen Figur aus der Vorhersage, bei fremden
   * über den Schnappschuss. Hier stand einmal eine Schätzung aus dem
   * zurückgelegten Weg; die ergab genau dann keinen Winkel, wenn die Figur in
   * der Luft stehenblieb, und das ist der Normalfall ohne Schub.
   */
  neigung: number;
  /** Wohin die Neigung gerade wandert. Wie `targetYaw`, nur für die Nase. */
  targetNeigung: number;
  /**
   * Wie weit die Figur sich in die Kurve legt, im Bogenmass.
   *
   * **Reine Zierde.** Der Kern kennt keine Querlage: geflogen wird über Nase
   * und Kurs, und ein dritter Winkel im Snapshot wäre ein Byte je Wesen für
   * etwas, das jeder Client aus dem sieht, was er ohnehin hat — der Kurs dreht
   * sich, also legt sich die Figur. Deshalb steht die Zahl hier und nicht in
   * `EntityView`.
   */
  rollen: number;
  /** Der Kurs des letzten Bildes. Nur, um die Drehrate daraus zu bekommen. */
  yawVorher: number;
  /** Zeit bis zum nächsten Funken hinter dem Besen. Siehe `zeichneFlugspur`. */
  funkenUhr: number;
  /** Der warme Schein um die Figur, sofern ein Satz leuchtet. */
  satzAura?: SetAura;
  /** Höhe über dem Boden für Nameplate und Schadenszahlen. */
  height: number;
}

/**
 * Ein Prop, fertig gerechnet — Lage, Drehung, Färbung.
 *
 * Vorberechnet und nicht bei jeder Nachschau neu: die Matrix eines Props
 * ändert sich nie, nur ob sie gezeichnet wird. Ein Bäumchen zweimal je Sekunde
 * neu zusammenzusetzen wäre Arbeit für ein Ergebnis, das schon dasteht.
 */
interface PropInstanz {
  x: number;
  z: number;
  matrix: THREE.Matrix4;
  farbe: THREE.Color;
}

interface PropGruppe {
  mesh: THREE.InstancedMesh;
  instanzen: PropInstanz[];
  /** Hat überhaupt eines der Props eine Färbung? Sonst spart man den Puffer. */
  faerbt: boolean;
}

function modelKeyFor(type: EntityType, defId: string): string {
  if (type === EntityType.Player) return 'player';
  if (type === EntityType.Npc) return getNpc(defId)?.model ?? 'npc_guide';
  // Ein Begleiter kommt aus der Gegenstandstabelle: seine Kennung **ist** die
  // des Gegenstands im Beutel. Zwei Tabellen für dasselbe Tier — eine für den
  // Beutel, eine für die Welt — wären zwei Stellen, an denen es umbenannt
  // werden müsste.
  if (type === EntityType.Pet) return getItem(defId)?.pet?.model ?? 'mob_mote';
  return getMob(defId)?.model ?? 'mob_mote';
}

function heightFor(type: EntityType, defId: string): number {
  if (type === EntityType.Player) return 1.8;
  if (type === EntityType.Pet) return getItem(defId)?.pet?.height ?? 0.7;
  if (type === EntityType.Npc) {
    const def = getNpc(defId);
    return (def?.height ?? 1.8) * (def?.scale ?? 1);
  }
  const def = getMob(defId);
  return (def?.height ?? 1.5) * (def?.scale ?? 1);
}

/**
 * Wer die Lage des Rigs bestimmt — die Weltansicht oder das Rig selbst.
 *
 * Drei Fälle, und der dritte hat gefehlt:
 *
 * - `flug` — die Weltansicht kippt die Nase und legt die Figur in die Kurve.
 * - `gerade` — sie dreht eine übriggebliebene Querlage zurück. Ohne das bliebe
 *   die letzte Schräglage nach dem Absteigen für immer stehen, und die Figur
 *   liefe schief über die Wiese.
 * - `rig` — **Hände weg.** Ein Kadaver liegt so, wie ihn sein Rig hingelegt
 *   hat.
 *
 * Der dritte Fall war der Fehler: Vierbeiner und Kriecher fallen um, indem ihr
 * Rig `rotation.z` setzt (der Distelkeiler auf die Seite, der Höhlenkriecher
 * auf den Rücken). Das Zurückdrehen für die Fluggeräte griff auch bei ihnen und
 * stellte sie im selben Bild wieder auf — der erschlagene Keiler stand da, als
 * wäre nichts gewesen. Figuren und Banditen fielen weiterhin ordentlich um,
 * weil die für ihr Umfallen `rotation.x` benutzen; genau deshalb sah es aus wie
 * „manche Monster haben eben keine Sterbeanimation".
 *
 * Als eigene Funktion und nicht als `if` mittendrin, damit die Regel ohne
 * Browser und ohne GPU prüfbar ist — siehe `sterben_test.ts`.
 */
export function rigLage(flug: string, tot: boolean): 'flug' | 'gerade' | 'rig' {
  if (tot) return 'rig';
  return flug !== '' ? 'flug' : 'gerade';
}

export class WorldView {
  readonly root = new THREE.Group();
  /**
   * Alles, was lebt — Figuren, Monster, NPCs, Begleiter.
   *
   * Ein eigener Ast und nicht alles nebeneinander unter `root`: der Umriss
   * zeichnet die Wesen ein zweites Mal in ein eigenes Ziel, und er braucht
   * dafür **eine** Sache, die er zeichnen kann. Eine Liste von Rigs, die er
   * sich selbst zusammensucht, wäre eine zweite Buchführung neben `entities`
   * — und Waffe, Fluggerät und Aura hängen ohnehin schon unter dem Rig, also
   * kommen sie hier von selbst mit.
   *
   * Eine `Scene` und keine `Group`: der Umriss setzt für seinen Durchgang ein
   * `overrideMaterial`, und das gibt es nur an einer Szene. Verschachtelt
   * gezeichnet verhält sie sich wie jede andere Gruppe; ihr eigener Nebel und
   * Hintergrund bleiben leer und gelten nur, wenn sie allein gezeichnet wird —
   * genau dann, wenn der Umriss sie zeichnet, und dort ist beides erwünscht.
   *
   * Ohne Verschiebung: `root` steht im Ursprung, und diese Szene auch. Der
   * Umriss zeichnet sie für sich, und dabei kennt three.js ihr Elternteil
   * nicht — stünde hier eine Verschiebung, säße der Strich woanders als die
   * Figur.
   */
  readonly wesen = new THREE.Scene();
  readonly entities = new Map<number, EntityVisual>();

  /**
   * Die Tore dieser Karte. Sie müssen getaktet werden — siehe `step`.
   *
   * Eine eigene Liste und nicht ein Ast im Szenengraph: der Takt braucht die
   * Objekte selbst und keinen Knoten, unter dem sie hängen.
   */
  private portale: PortalRing[] = [];

  private terrain?: TerrainMesh;
  private propMeshes: THREE.InstancedMesh[] = [];
  /**
   * Der Grasteppich um die Figur. Fehlt, solange keine Karte steht — und auf
   * der niedrigsten Stufe dauerhaft, dort ist `grasBueschel` null.
   */
  private gras: Grasteppich | undefined;
  /**
   * Die Props je Modell, vollständig — auch die gerade nicht gezeichneten.
   *
   * Die `InstancedMesh` bekommt je Nachschau nur so viele Einträge, wie in
   * Sichtweite stehen; hier liegt, woraus sie sie nimmt. Ohne diese Liste
   * müsste die Karte für jede Änderung der Sichtweite neu aufgebaut werden.
   */
  private propGruppen: PropGruppe[] = [];
  /** Wie weit Props gezeichnet werden, in Metern. */
  private sichtweite: number = SICHTWEITEN.hoch;
  /** Wo die Kamera bei der letzten Nachschau stand — siehe `pruefeSicht`. */
  private sichtVonX = Number.NaN;
  private sichtVonZ = Number.NaN;
  /** Wie viele Prop-Instanzen zuletzt gezeichnet wurden. Für die Debug-Tafel. */
  gezeichneteProps = 0;
  /** Und wie viele es insgesamt gäbe. */
  propsGesamt = 0;
  /** Pfeile in der Luft. Kurzlebig — meist keiner, selten eine Handvoll. */
  private arrows: FlyingArrow[] = [];
  /** Funken. Eine Wolke für alles, mit fester Größe. */
  readonly particles = new ParticleField();
  /** Der Schweif hinter geschwungenen Klingen. Ein Band für alle. */
  readonly spur = new Bandspur(KLINGENBAND);
  /**
   * Die Fahne hinter einem Flugbrett. Eigenes Band, weil es länger steht.
   *
   * Getrennt vom Klingenschweif und nicht mit ihm zusammengelegt: die beiden
   * unterscheiden sich in der Lebensdauer, und die entscheidet über die Größe
   * des Puffers. Ein gemeinsames Band müsste den längeren nehmen und hätte für
   * jeden Hieb dreissig Proben, von denen sechzehn nie sichtbar würden.
   */
  readonly flugspur = new Bandspur(BRETTBAND);
  /** Warmes Licht an den Laternen. Fester Pool, wandert zum Betrachter. */
  readonly lanterns: Lanterns;
  /** Was gerade auf dem Boden liegt. Wird aus dem Snapshot abgeglichen. */
  readonly loot: LootView;
  /** Der Ring am Wegziel. Eine Marke für alles — es gibt immer nur ein Ziel. */
  readonly laufmarke = new Laufmarke();

  /**
   * Wo die **gezeichnete** Bodenfläche an dieser Stelle liegt.
   *
   * Für alles, was auf dem Boden aufliegen soll. Ohne geladene Karte gibt es
   * keinen Boden — dann `undefined`, und der Aufrufer entscheidet.
   */
  gelaendeHoehe(x: number, z: number): number | undefined {
    return this.terrain?.hoeheAn(x, z);
  }
  /** Zwei Punkte für die Klingenlage. Wiederverwendet, je Bild und Figur. */
  private readonly klingeA = new THREE.Vector3();
  private readonly klingeB = new THREE.Vector3();
  private doc?: MapDocument;
  /** Die Welt der aktuellen Karte — nur für die Bodenhöhe, siehe `setMap`. */
  private welt?: CoreWorld;
  private elapsed = 0;

  /**
   * Meldet den Beginn eines Schlags — für jede Figur, nicht nur die eigene.
   *
   * Die Ansicht selbst macht keinen Ton. Sie weiß, *wann* geschlagen wird und
   * *womit*; was daraus zu hören ist, entscheidet das Spiel.
   */
  onAttackStart?: (entity: EntityVisual) => void;

  constructor(
    private readonly registry: ModelRegistry,
    private readonly textures: TextureLoader,
    private readonly maxAnisotropy: number,
    lanternLights = 4,
  ) {
    // Die Funkenwolke haengt nicht mehr im Szenengraph: sie zeichnet sich in
    // einem eigenen Pass nach three.js, mit unserem eigenen Renderer. Angemeldet
    // wird der Pass dort, wo Szene und Ansicht zusammenkommen — im Spiel.
    // Bestehen bleibt sie trotzdem ueber Kartenwechsel hinweg: feste Groesse,
    // kostet nichts, solange sie leer ist.
    this.lanterns = new Lanterns(lanternLights);
    this.root.add(this.lanterns.root);

    // Wie die Funkenwolke dauerhaft in der Szene und nicht je Karte: die
    // Gruppe ist leer, solange nichts liegt, und `clear` räumt sie mit.
    this.loot = new LootView(registry.material);
    this.root.add(this.loot.root);
    this.root.add(this.laufmarke.root);
    // Der Ast mit den Wesen. Bleibt über Kartenwechsel hinweg bestehen — was
    // darunter hängt, räumt `clear` weg, der Ast selbst nicht.
    this.root.add(this.wesen);
  }

  get mapId(): string {
    return this.doc?.id ?? '';
  }

  /**
   * Wie viele Grasbüschel der Teppich hält und wie viele davon stehen.
   *
   * Für die Diagnose: ob Halme fehlen, weil die Grafikstufe sie abschaltet,
   * weil der Boden sie ablehnt oder weil der Teppich gar nicht gebaut wurde,
   * ist von aussen sonst nicht zu unterscheiden.
   */
  grasStand(): { bueschel: number; stehend: number } {
    return this.gras?.stand() ?? { bueschel: 0, stehend: 0 };
  }

  /** Baut Boden und Props einer Map neu auf. Alte Entities fallen dabei weg. */
  setMap(world: CoreWorld, doc: MapDocument, quality: QualitySettings): void {
    this.clear();
    this.doc = doc;
    // Die Welt wird behalten, weil die Sprunganimation den Boden braucht:
    // „in der Luft" heisst „über dem Gelände", und wie hoch das Gelände liegt,
    // weiss nur der Kern. Eine zweite Höhenrechnung im Renderer wäre eine
    // zweite Wahrheit über den Boden.
    this.welt = world;

    this.terrain = buildTerrain(world, doc, quality.terrainCell, {
      useNormalMaps: quality.groundNormalMaps,
    });
    this.root.add(this.terrain.object);

    /*
     * Der Grasteppich, und er kommt **nach** dem Gelände: er braucht dessen
     * gezeichnete Fläche, um seine Halme daraufzustellen.
     */
    if (quality.grasBueschel > 0) {
      this.gras = new Grasteppich(this.registry.propMaterial('grass_tuft'), {
        anzahl: quality.grasBueschel,
        // Der Kreis wächst mit der Sichtweite, aber lange nicht so schnell:
        // Halme jenseits von dreissig Metern sind ein paar Pixel und kosten
        // trotzdem ihre Füllrate.
        radius: Math.min(30, quality.propDistance * 0.13),
        farbe: doc.terrain.grassColor,
        farbeAlt: doc.terrain.grassColorAlt,
      });
      this.gras.setBoden(this.terrain, doc.terrain.waterLevel);
      this.root.add(this.gras.mesh);
    }

    this.buildProps(world, doc);
    this.buildGates(world, doc);
    void this.loadGroundTextures(doc, this.terrain);
  }

  /**
   * Traegt die Bodentexturen nach, sobald sie da sind.
   *
   * Bewusst ohne Warten: der Boden steht sofort in seinen prozeduralen Farben,
   * und jede Ebene wird sichtbar, wenn ihre Textur eintrifft. Das ist dasselbe
   * Prinzip wie beim Rest des Streamers — Platzhalter sofort, Nachschub, wenn
   * er kommt.
   */
  private async loadGroundTextures(doc: MapDocument, terrain: TerrainMesh): Promise<void> {
    const layers = doc.terrain.layers;
    await Promise.all(
      layers.map(async (layer, index) => {
        // Die Karte kann sich waehrenddessen geaendert haben; dann gehoert das
        // Ergebnis zu einem Terrain, das es nicht mehr gibt.
        const stillCurrent = () => this.terrain === terrain;

        if (layer.texture) {
          try {
            const tex = await this.textures.load(layer.texture, {
              srgb: true,
              anisotropy: this.maxAnisotropy,
            });
            if (stillCurrent()) terrain.ground.setAlbedo(index, tex);
          } catch (err) {
            console.warn(`[boden] Farbtextur "${layer.texture}" nicht ladbar:`, err);
          }
        }

        if (layer.normal) {
          try {
            const tex = await this.textures.load(layer.normal, {
              srgb: false,
              anisotropy: this.maxAnisotropy,
            });
            if (stillCurrent()) terrain.ground.setNormal(index, tex);
          } catch (err) {
            console.warn(`[boden] Normalenkarte "${layer.normal}" nicht ladbar:`, err);
          }
        }
      }),
    );
  }

  private buildProps(world: CoreWorld, doc: MapDocument): void {
    // Nach Modellart bündeln — daraus wird je Art eine InstancedMesh.
    const byModel = new Map<string, typeof doc.props>();
    for (const prop of doc.props) {
      const list = byModel.get(prop.model);
      if (list) list.push(prop);
      else byModel.set(prop.model, [prop]);
    }

    // Wo Laternen stehen — das Licht braucht die Stelle des Glases, nicht die
    // des Fußes.
    const lanterns: LanternPlacement[] = [];

    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const color = new THREE.Color();

    for (const [model, props] of byModel) {
      const geometry = this.registry.propGeometry(model);
      // Laub bekommt ein anderes Material — Textur mit Alphatest. Welches,
      // entscheidet die Ablage; siehe `propMaterial`.
      const mesh = new THREE.InstancedMesh(
        geometry,
        this.registry.propMaterial(model),
        props.length,
      );
      mesh.name = `props:${model}`;
      // Props liegen über die ganze Map verteilt; eine Hüllkugel dafür wäre so
      // groß wie die Map und würde ohnehin nie aussortiert.
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;

      let anyTint = false;
      const instanzen: PropInstanz[] = [];
      for (let i = 0; i < props.length; i++) {
        const prop = props[i]!;
        // Die Höhe kommt aus dem Kern, nicht aus der Datei: ändert jemand im
        // Editor den Terrain-Seed, sitzen die Props trotzdem richtig.
        const y = prop.snapToGround
          ? world.heightAt(prop.position[0], prop.position[2])
          : prop.position[1];

        position.set(prop.position[0], y, prop.position[2]);
        quaternion.setFromEuler(
          new THREE.Euler(prop.rotation[0], prop.rotation[1], prop.rotation[2]),
        );
        scale.setScalar(prop.scale);
        matrix.compose(position, quaternion, scale);

        if (prop.tint !== undefined) {
          anyTint = true;
          color.setHex(prop.tint);
        } else {
          color.setRGB(1, 1, 1);
        }

        instanzen.push({
          x: prop.position[0],
          z: prop.position[2],
          matrix: matrix.clone(),
          farbe: color.clone(),
        });

        if (model === 'lantern_post') {
          /*
           * Die Laternen bleiben vollzählig, auch bei kleiner Sichtweite.
           *
           * Sie sind Lichter und keine Modelle: das Licht einer Laterne fällt
           * auf den Boden, und wenn es mit dem Mast verschwände, ginge in
           * einem Dorf reihum die Beleuchtung aus, während man hindurchläuft.
           * Wie viele es gleichzeitig gibt, deckelt ohnehin `Lanterns`.
           */
          lanterns.push({ x: prop.position[0], y: y + 2.65 * prop.scale, z: prop.position[2] });
        }
      }

      this.root.add(mesh);
      this.propMeshes.push(mesh);
      this.propGruppen.push({ mesh, instanzen, faerbt: anyTint });
      this.propsGesamt += instanzen.length;
    }

    // Und gleich einmal füllen: ohne das stünde die Karte bis zum ersten Bild
    // leer da.
    this.sichtVonX = Number.NaN;
    this.pruefeSicht(0, 0, true);

    this.lanterns.setPlacements(lanterns);
  }

  /**
   * Stellt die Sichtweite ein. Wirkt beim nächsten Bild.
   */
  setzeSichtweite(stufe: SichtweiteStufe): void {
    const meter = SICHTWEITEN[stufe];
    if (meter === this.sichtweite) return;
    this.sichtweite = meter;
    // Erzwingt die Nachschau, auch wenn die Kamera stillsteht.
    this.sichtVonX = Number.NaN;
  }

  /**
   * Füllt die Prop-Netze mit dem, was in Sichtweite steht.
   *
   * **Nicht in jedem Bild**, sondern erst, wenn die Kamera ein Stück gelaufen
   * ist. Die Arbeit ist die Schleife über alle Props einer Karte — bei
   * Lichtmoor sind das fünftausendsiebenhundert —, und die je Bild zu machen
   * hiesse, für ein Ergebnis zu zahlen, das sich zwischen zwei Bildern um
   * nichts ändert. Zwölf Meter Schwelle sind bei Laufgeschwindigkeit gut zwei
   * Sekunden.
   *
   * Der Rand ist grosszügig: gezeichnet wird bis `sichtweite + 12`, damit ein
   * Baum nicht genau an der Schwelle steht und bei jeder Nachschau ein- und
   * ausgeblendet wird. Genau das sähe aus wie ein Flackern und wäre keines.
   */
  pruefeSicht(kameraX: number, kameraZ: number, erzwingen = false): void {
    const SCHWELLE = 12;
    if (
      !erzwingen &&
      Number.isFinite(this.sichtVonX) &&
      Math.hypot(kameraX - this.sichtVonX, kameraZ - this.sichtVonZ) < SCHWELLE
    ) {
      return;
    }
    this.sichtVonX = kameraX;
    this.sichtVonZ = kameraZ;

    const weite = this.sichtweite + SCHWELLE;
    const weiteQ = weite * weite;
    let gezeichnet = 0;

    for (const gruppe of this.propGruppen) {
      let n = 0;
      for (const inst of gruppe.instanzen) {
        const dx = inst.x - kameraX;
        const dz = inst.z - kameraZ;
        if (dx * dx + dz * dz > weiteQ) continue;
        gruppe.mesh.setMatrixAt(n, inst.matrix);
        if (gruppe.faerbt) gruppe.mesh.setColorAt(n, inst.farbe);
        n++;
      }
      /*
       * `count` und nicht `visible`: die Instanzen stehen alle im selben
       * Puffer, und der Zeichner nimmt davon die ersten `n`. Damit kostet ein
       * weggelassener Baum gar nichts — kein Draw-Call, kein Eckpunkt.
       */
      gruppe.mesh.count = n;
      gruppe.mesh.instanceMatrix.needsUpdate = true;
      if (gruppe.faerbt && gruppe.mesh.instanceColor) {
        gruppe.mesh.instanceColor.needsUpdate = true;
      }
      gezeichnet += n;
    }
    this.gezeichneteProps = gezeichnet;
  }

  /**
   * Setzt die Tore — je ein Bannkreis auf dem Boden.
   *
   * Das Tor ist der Kreis, nicht ein Prop, das zufällig neben einer
   * unsichtbaren Zone steht. Vorher konnte man beides unabhängig verschieben,
   * und man lief durch eine leere Wiese, in der es dann plötzlich klickte.
   *
   * Position **und Radius** kommen aus `doc.portals`, also aus derselben
   * Zeile, die auch den Server auslösen lässt. Auseinanderlaufen können sie
   * damit nicht mehr — und was man sieht, ist genau das, was auslöst.
   *
   * Nicht in `propMeshes`: die Sichtweite räumt Bäume weg, ein Tor nie. Wer
   * ein Tor sucht, sucht es aus der Ferne.
   */
  private buildGates(world: CoreWorld, doc: MapDocument): void {
    for (const portal of doc.portals) {
      const [x, z] = portal.position;
      /*
       * `terrain.hoeheAn` und **nicht** `world.heightAt`.
       *
       * Der Kern rechnet eine stetige Funktion, gezeichnet wird ein
       * Dreiecksgitter mit vier bis acht Metern Maschenweite — dazwischen
       * liegt das Dreieck als Sehne unter dem Bogen, stellenweise um einen
       * halben Meter. Eine Scheibe, die der Funktion folgt, verschwindet dort
       * im gezeichneten Hang, und man sieht einen angeknabberten Kreis.
       *
       * Genau dafür gibt es die Funktion am Netz: sie sagt, wo die Fläche
       * **liegt**, und nicht, wo sie rechnerisch läge.
       */
      const boden = this.terrain;
      const ring = new PortalRing(
        { x, y: boden ? boden.hoeheAn(x, z) : world.heightAt(x, z), z },
        portal.radius,
        (px, pz) => (boden ? boden.hoeheAn(px, pz) : world.heightAt(px, pz)),
      );
      this.root.add(ring.root);
      this.portale.push(ring);
    }
  }

  // -------------------------------------------------------------------------
  // Entities
  // -------------------------------------------------------------------------

  spawn(row: SpawnRow): EntityVisual {
    const existing = this.entities.get(row.id);
    if (existing) {
      // Schon da — aber der Server schickt eine volle Zeile auch dann neu,
      // wenn sich die Ausrüstung geändert hat. Dann wird das Rig getauscht,
      // sonst hielte die Figur weiter ihre alte Waffe.
      if (existing.weapon !== row.weapon || existing.outfit !== row.outfit) {
        this.replaceRig(existing, row);
      }
      // Auf- und Absteigen kommt über dieselbe volle Zeile wie ein
      // Waffenwechsel — `applyLoadout` lässt die Figur danach als neu gelten.
      if (existing.flug !== row.flug) this.setzeFluggeraet(existing, row.flug);
      // Die Aufwertung kommt nur in der vollen Zeile — genau deshalb meldet
      // der Server die Figur nach einem Schmiedegang als neu.
      if (existing.weaponUpgrade !== row.weaponUpgrade) {
        existing.weaponUpgrade = row.weaponUpgrade;
        existing.aura?.setUpgrade(row.weaponUpgrade);
      }
      // Dasselbe für den Satz: ein aufgewertetes Teil ändert die Stufe, ohne
      // dass sich am Aussehen der Figur etwas ändert — das Rig bleibt.
      if (existing.setGlow !== row.setGlow) {
        existing.setGlow = row.setGlow;
        existing.satzAura?.setLevel(row.setGlow);
      }
      return existing;
    }

    const key = modelKeyFor(row.type, row.defId);
    // Die Waffe kommt aus dem Snapshot: ohne sie stünde jede fremde Figur mit
    // dem Schwert da, das im Modell voreingestellt ist — auch die mit Bogen.
    const rig = this.registry.createRig(key, row.weapon, row.outfit);
    rig.root.position.set(row.x, row.y, row.z);
    rig.root.rotation.y = row.yaw;
    this.wesen.add(rig.root);

    const visual: EntityVisual = {
      id: row.id,
      type: row.type,
      defId: row.defId,
      name: row.name,
      level: row.level,
      hp: row.hp,
      maxHp: row.maxHp,
      state: row.state,
      x: row.x,
      y: row.y,
      z: row.z,
      yaw: row.yaw,
      targetX: row.x,
      targetY: row.y,
      targetZ: row.z,
      targetYaw: row.yaw,
      hoeheVorher: row.y,
      attackTimer: -1,
      attackVariant: 0,
      pickupTimer: -1,
      wirbelTimer: -1,
      speed: 0,
      rig,
      weapon: row.weapon,
      weaponUpgrade: row.weaponUpgrade,
      outfit: row.outfit,
      setGlow: row.setGlow,
      flug: '',
      neigung: row.neigung,
      targetNeigung: row.neigung,
      rollen: 0,
      yawVorher: row.yaw,
      funkenUhr: 0,
      aggro: row.aggro,
      height: heightFor(row.type, row.defId),
    };
    this.attachAura(visual);
    this.attachSetAura(visual);
    if (row.flug !== '') this.setzeFluggeraet(visual, row.flug);
    this.entities.set(row.id, visual);
    return visual;
  }

  update(row: UpdateRow): void {
    const e = this.entities.get(row.id);
    if (!e) return;

    // Tempo aus dem Sprung zwischen zwei Snapshots schätzen — der Server
    // schickt keine Geschwindigkeit, und für die Laufanimation reicht das.
    const dx = row.x - e.targetX;
    const dz = row.z - e.targetZ;
    e.speed = Math.hypot(dx, dz) * 10;

    e.targetX = row.x;
    e.targetY = row.y;
    e.targetZ = row.z;
    e.targetYaw = row.yaw;
    e.targetNeigung = row.neigung;
    e.hp = row.hp;
    e.aggro = row.aggro;

    if (row.state === EntityState.Attack && e.state !== EntityState.Attack) {
      this.beginAttack(e);
    }
    e.state = row.state;
  }

  /**
   * Startet die Schlaganimation — und meldet es genau einmal.
   *
   * Es gibt zwei Wege hierher: das Kampfereignis, das sofort kommt, und der
   * Schnappschuss, der den Zustand kurz darauf bestätigt. Ohne die Sperre auf
   * `attackTimer` liefe derselbe Schlag zweimal, und man hörte jeden Schuss
   * doppelt.
   */
  private beginAttack(e: EntityVisual): void {
    if (e.attackTimer >= 0) return;
    e.attackTimer = 0;
    e.attackVariant = (e.attackVariant + 1) % 3;
    this.onAttackStart?.(e);
  }

  /**
   * Hängt das Fluggerät unter die Figur — oder nimmt es wieder weg.
   *
   * Am Rig und nicht in der Szene: es soll sich mitdrehen und mitbewegen, ohne
   * dass irgendwo eine zweite Position gepflegt wird. Ein Gerät, das der Figur
   * nachgeführt werden müsste, wäre genau die Sorte doppelte Buchführung, die
   * hier schon dreimal schiefgegangen ist.
   */
  private setzeFluggeraet(visual: EntityVisual, model: string): void {
    if (visual.flugMesh) {
      visual.rig.root.remove(visual.flugMesh);
      visual.flugMesh = undefined;
    }
    visual.flug = model;
    if (model === '') return;

    const mesh = baueFluggeraet(model, this.registry.material);
    visual.rig.root.add(mesh);
    visual.flugMesh = mesh;
  }

  /**
   * Tauscht das Rig einer bestehenden Figur.
   *
   * Nur bei einem Waffenwechsel. Position und Zustand bleiben, was sich ändert
   * ist allein das, was in der Hand liegt — dafür ein neues Rig zu bauen ist
   * grober als nötig, aber es passiert selten und hält den Aufbau einfach.
   */
  private replaceRig(visual: EntityVisual, row: SpawnRow): void {
    this.wesen.remove(visual.rig.root);
    this.registry.releaseRig(visual.rig);
    visual.aura?.dispose();
    visual.aura = undefined;
    visual.satzAura?.dispose();
    visual.satzAura = undefined;
    visual.rig.dispose();

    const rig = this.registry.createRig(modelKeyFor(row.type, row.defId), row.weapon, row.outfit);
    rig.root.position.set(visual.x, visual.y, visual.z);
    rig.root.rotation.y = visual.yaw;
    this.wesen.add(rig.root);

    visual.flugMesh = undefined;
    if (row.flug !== '') this.setzeFluggeraet(visual, row.flug);
    visual.rig = rig;
    visual.weapon = row.weapon;
    visual.weaponUpgrade = row.weaponUpgrade;
    visual.outfit = row.outfit;
    visual.setGlow = row.setGlow;
    this.attachAura(visual);
    this.attachSetAura(visual);
  }

  /**
   * Hängt den Funkenschleier an den Waffenhalter.
   *
   * An den Halter und nicht an die Waffe: die wird ausgetauscht, sobald ein
   * geliefertes Modell nachkommt, der Halter bleibt. Wer keine Waffe trägt,
   * bekommt auch keine Aura — es gäbe nichts, woran sie hinge.
   */
  private attachAura(visual: EntityVisual): void {
    const mount = visual.rig.weaponMount;
    if (!mount) return;

    // Die Ausdehnung kommt aus dem Rig, nicht aus einer Vermutung über den
    // Waffennamen: dort steht sie ohnehin, weil auch gelieferte Modelle darauf
    // eingepasst werden.
    const aura = new WeaponAura(
      visual.rig.weaponSpan ?? { length: 1.1, bottom: -0.2, axis: 'y' },
    );
    aura.setUpgrade(visual.weaponUpgrade);
    mount.add(aura.object);
    visual.aura = aura;
  }

  /**
   * Hängt den Schein eines vollständigen Rüstungssatzes an die Figur.
   *
   * An die Wurzel des Rigs und nicht an einen einzelnen Körperteil: leuchten
   * soll die ganze Rüstung, und ein Schein am Oberkörper liefe beim Laufen mit
   * dem Rumpf mit, statt still um die Figur zu stehen.
   *
   * Die Aura wird auch bei Stufe null gebaut. Sie kostet dann nichts — alles
   * ist unsichtbar und die Funken haben keine Zeichenspanne —, und dafür
   * braucht der Fall „Ausrüstung wurde gerade aufgewertet" keinen zweiten Weg.
   *
   * **Nur für Spieler.** Monster und NPCs tragen keine Rüstungssätze, und drei
   * Geometrien je Irrlicht sind ein Preis für etwas, das nie zu sehen ist. Bei
   * dreissig sichtbaren Wesen ist das der Unterschied zwischen „kostet nichts"
   * und „kostet nichts, aber neunzigmal".
   */
  private attachSetAura(visual: EntityVisual): void {
    if (visual.type !== EntityType.Player) return;
    const aura = new SetAura(visual.height);
    aura.setLevel(visual.setGlow);
    visual.rig.root.add(aura.object);
    visual.satzAura = aura;
  }

  despawn(id: number): void {
    const e = this.entities.get(id);
    if (!e) return;
    this.wesen.remove(e.rig.root);
    this.registry.releaseRig(e.rig);
    e.aura?.dispose();
    e.satzAura?.dispose();
    e.rig.dispose();
    this.entities.delete(id);
  }

  /** Setzt die eigene Figur direkt — sie läuft über die Prediction. */
  setLocal(
    id: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    speed: number,
    neigung: number,
  ): void {
    const e = this.entities.get(id);
    if (!e) return;
    e.x = e.targetX = x;
    e.y = e.targetY = y;
    e.z = e.targetZ = z;
    e.yaw = e.targetYaw = yaw;
    // Ohne Nachlauf, anders als bei fremden Figuren: die eigene Lage kommt aus
    // der Vorhersage und ist in jedem Bild aktuell. Sie zu glätten hiesse, die
    // eigene Eingabe verzögert zu zeigen.
    e.neigung = e.targetNeigung = neigung;
    e.speed = speed;
  }

  /** Löst die Schlaganimation aus, ohne auf den nächsten Snapshot zu warten. */
  triggerAttack(id: number): void {
    const e = this.entities.get(id);
    if (e) this.beginAttack(e);
  }

  /**
   * Schickt einen Pfeil auf die Reise.
   *
   * Reine Anzeige: der Schaden ist gefallen, als der Server das Ereignis
   * geschickt hat. Der Pfeil holt das Bild nach, das dazu gehört — ohne ihn
   * nimmt ein Monster in zwanzig Metern Entfernung grundlos Schaden.
   *
   * Bewusst kein Flug mit eigener Physik: er zieht in gerader Linie vom
   * Angreifer zum Ziel und verschwindet dort. Alles andere wäre eine zweite
   * Wahrheit über etwas, das schon entschieden ist.
   */
  spawnArrow(
    fromId: number,
    toX: number,
    toY: number,
    toZ: number,
    onArrive?: () => void,
  ): void {
    const shooter = this.entities.get(fromId);
    if (!shooter) return;

    const arrow = new THREE.Mesh(this.registry.arrowGeometry(), this.registry.material);
    arrow.frustumCulled = false;
    this.root.add(arrow);

    this.arrows.push({
      mesh: arrow,
      // Aus der Hand, nicht aus den Füßen.
      fromX: shooter.x,
      fromY: shooter.y + shooter.height * 0.62,
      fromZ: shooter.z,
      toX,
      toY,
      toZ,
      elapsed: 0,
      trailAccum: 0,
      ...(onArrive ? { onArrive } : {}),
    });
  }

  /** Bewegt die Pfeile und räumt angekommene weg. */
  private stepArrows(dt: number): void {
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i]!;
      a.elapsed += dt;
      const t = Math.min(1, a.elapsed / ARROW_FLIGHT_SECONDS);

      const x = a.fromX + (a.toX - a.fromX) * t;
      const y = a.fromY + (a.toY - a.fromY) * t;
      const z = a.fromZ + (a.toZ - a.fromZ) * t;
      a.mesh.position.set(x, y, z);
      // Der Pfeil zeigt dorthin, wo er hinfliegt. Der Schaft liegt entlang +Z,
      // also reicht die Blickrichtung.
      a.mesh.lookAt(a.toX, a.toY, a.toZ);

      // --- Schweif ---
      //
      // Der Pfeil ist ein Strich von zwölf Zentimetern, der eine Sechstel
      // Sekunde unterwegs ist — man sieht ihn kaum, und bei ungünstiger
      // Bildrate springt er von der Hand zum Ziel, ohne dazwischen zu sein.
      // Die Punkte bleiben stehen und zeichnen den Weg nach, den er genommen
      // hat.
      //
      // Gesetzt wird auf der Strecke *zwischen* altem und neuem Ort, nicht am
      // neuen: sonst hinge der Abstand der Punkte doch wieder an der Bildrate,
      // nur eine Ebene tiefer.
      a.trailAccum += dt;
      while (a.trailAccum >= ARROW_TRAIL_STEP) {
        a.trailAccum -= ARROW_TRAIL_STEP;
        const back = Math.max(0, t - a.trailAccum / ARROW_FLIGHT_SECONDS);
        this.particles.burst(
          a.fromX + (a.toX - a.fromX) * back,
          a.fromY + (a.toY - a.fromY) * back,
          a.fromZ + (a.toZ - a.fromZ) * back,
          {
            count: 1,
            // Helles Holzgelb, kein Feuer: der Pfeil brennt nicht.
            color: 0xe8d7a6,
            // Fast keine Eigenbewegung — der Schweif soll stehenbleiben und
            // verblassen, nicht auseinanderstieben wie ein Treffer.
            speed: 0.35,
            size: 1.6,
            life: 0.22,
            lift: 0.35,
          },
        );
      }

      if (t < 1) continue;
      this.root.remove(a.mesh);
      this.arrows.splice(i, 1);
      // Erst jetzt der Einschlag. Vorher hätten die Funken gesprüht, während
      // der Pfeil noch unterwegs war.
      a.onArrive?.();
    }
  }

  /**
   * Schiebt alle Figuren einen Frame weiter. `localId` wird von der
   * Interpolation ausgenommen — dort gilt die Vorhersage.
   */
  step(dt: number, localId: number): void {
    this.elapsed += dt;
    this.stepArrows(dt);
    this.particles.step(dt);
    this.loot.step(dt);
    this.laufmarke.step(dt);
    // Die Tore drehen sich. Über `dt` und nicht über die Wanduhr: ein Tor in
    // einem Hintergrundtab holte sonst beim Zurückkommen die ganze verlorene
    // Zeit in einem Bild nach und zuckte.
    for (const p of this.portale) p.update(dt);
    // Eine Uhr für alle Auren: sie pulsieren im Shader, und der braucht nur
    // die Zeit. Je Aura eine Schleife wäre dieselbe Zahl fünfzigmal.
    stepAuras(dt);
    // Bildratenunabhängige Glättung: bei 60 Hz landet man knapp unter einem
    // Snapshot-Intervall, bei 30 Hz genauso weit.
    const blend = 1 - Math.pow(0.0000001, dt);

    for (const e of this.entities.values()) {
      if (e.id !== localId) {
        e.x += (e.targetX - e.x) * blend;
        e.y += (e.targetY - e.y) * blend;
        e.z += (e.targetZ - e.z) * blend;

        let d = e.targetYaw - e.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        e.yaw += d * blend;
      }

      e.rig.root.position.set(e.x, e.y, e.z);
      e.rig.root.rotation.y = e.yaw;

      // Für **jede** Figur, auch am Boden: so steht die Drehrate schon bereit,
      // wenn jemand mitten in der Kurve aufsteigt. Rechnete sie erst ab dem
      // ersten Flugbild, wäre die erste Rate der Sprung eines ganzen Bildes.
      this.rolleNachKurve(e, dt);

      if (e.attackTimer >= 0) {
        e.attackTimer += dt;
        if (e.attackTimer > ATTACK_ANIM_SECONDS) e.attackTimer = -1;
      }
      if (e.pickupTimer >= 0) {
        e.pickupTimer += dt;
        if (e.pickupTimer > PICKUP_ANIM_SECONDS) e.pickupTimer = -1;
      }
      if (e.wirbelTimer >= 0) {
        e.wirbelTimer += dt;
        if (e.wirbelTimer > WIRBEL_ANIM_SECONDS) e.wirbelTimer = -1;
      }

      // In der Luft? Gefragt wird nur bei Spielern — Monster springen nicht,
      // und ein Aufruf in den Kern je Wesen und Bild wäre für sie umsonst.
      let luft = 0;
      let steigt = false;
      if (e.type === EntityType.Player && this.welt) {
        /*
         * Gegen den Boden, auf dem man **steht** — nicht gegen das Gelände.
         *
         * Hier stand `heightAt`, und das kennt nur das Gelände. Wer über einen
         * schwebenden Felsen lief, war damit sechsundzwanzig Meter „in der
         * Luft": die Figur zog die Beine an und glitt über den Stein, statt zu
         * gehen. Man konnte darauf laufen, es sah nur nicht so aus.
         *
         * `bodenUnter` nimmt die Plattform, sobald sie nicht über einem liegt
         * — dieselbe Frage, die auch die Bewegung im Kern stellt, und damit
         * dieselbe Antwort.
         */
        const ueberBoden = e.y - this.welt.bodenUnter(e.x, e.z, e.y);
        // Erst ab einer Handbreit, und ab einem Drittelmeter voll: darunter
        // liegt das Rauschen aus Interpolation und Geländeauflösung, und eine
        // Figur, die beim Gehen über eine Wurzel kurz die Beine anzieht, sieht
        // kaputt aus.
        luft = Math.max(0, Math.min(1, (ueberBoden - 0.08) / 0.3));
        steigt = e.y > e.hoeheVorher + 1e-4;
      }
      // Die Nase wandert zum gemeldeten Winkel, wie die Blickrichtung zu ihrem
      // — die Schnappschüsse kommen seltener als die Bilder, und ein Sprung je
      // Paket sähe man an einer schrägen Figur sofort.
      e.neigung += (e.targetNeigung - e.neigung) * Math.min(1, dt * 12);
      e.hoeheVorher = e.y;

      e.rig.update({
        // In der Luft steht der Gang still. Der Schritt hängt am Tempo, und
        // wer auf einem Brett steht, macht keine Schritte — mit dem echten
        // Tempo ruderte die Figur mit den Beinen durch die Luft.
        speed: e.flug === '' ? e.speed : 0,
        luft,
        steigt,
        // Woraufhin das Rig eine eigene Haltung einnimmt statt der des Sprungs.
        flug: e.flug,
        attackPhase: e.attackTimer >= 0 ? e.attackTimer / ATTACK_ANIM_SECONDS : -1,
        attackVariant: e.attackVariant,
        pickupPhase: e.pickupTimer >= 0 ? e.pickupTimer / PICKUP_ANIM_SECONDS : -1,
        wirbelPhase: e.wirbelTimer >= 0 ? e.wirbelTimer / WIRBEL_ANIM_SECONDS : -1,
        dead: e.state === EntityState.Dead,
        time: this.elapsed,
        dt,
      });

      /*
       * Die Nase kippt das ganze Rig — **nach** dem Rig-Schritt.
       *
       * Der setzt `rotation.x` selbst zurück (auf null, oder beim Umfallen auf
       * die Waagerechte). Davor gesetzt wäre die Neigung im selben Bild wieder
       * weg, und der Fehler sähe aus wie „das Fliegen kippt die Figur nicht".
       *
       * Negativ, weil eine Drehung um +X die Vorderseite nach unten nimmt:
       * `R_x(a)` bildet (0,0,1) auf (0,−sin a, cos a) ab. Wer steigt, soll die
       * Nase heben — also das Gegenteil.
       */
      switch (rigLage(e.flug, e.state === EntityState.Dead)) {
        case 'flug':
          e.rig.root.rotation.x = -e.neigung;
          e.rig.root.rotation.z = e.rollen;
          this.zeichneFlugspur(e, dt);
          break;
        case 'gerade':
          // Wer absteigt, steht wieder gerade. Der Rig-Schritt setzt nur
          // `rotation.x` zurück, nicht `z` — ohne diese Zeile bliebe die
          // letzte Querlage für immer stehen.
          if (e.rig.root.rotation.z !== 0) e.rig.root.rotation.z = 0;
          break;
        case 'rig':
          // Nichts anfassen: der Kadaver liegt, wie das Rig ihn hingelegt hat.
          break;
      }

      // Der Schweif gehört zu jeder Bewegung der Klinge, nicht nur zum Hieb:
      // beim Wirbel zieht er den Kreis nach, und genau der ist die Aussage der
      // Fertigkeit.
      if (e.attackTimer >= 0 || e.wirbelTimer >= 0) this.zeichneKlingenlage(e);
    }

    this.spur.step(dt);
    this.flugspur.step(dt);

    /*
     * Und der Grasteppich zieht der eigenen Figur nach.
     *
     * Der Figur und nicht der Kamera: die Kamera schwenkt und zoomt, die Figur
     * steht in der Mitte des Bildes. Ein Teppich, der der Kamera folgt, rückt
     * bei jedem Blick über die Schulter nach — sichtbar, und ohne Gewinn.
     */
    const ich = this.entities.get(localId);
    if (ich) this.gras?.folge(ich.x, ich.z);
  }

  /**
   * Wie weit sich die Figur in die Kurve legt.
   *
   * Aus der **Änderung** des Kurses und nicht aus der Eingabe: die Eingabe hat
   * nur die eigene Figur, und fremde legten sich dann nie. Der Kurs kommt für
   * beide aus derselben Quelle — Vorhersage hier, Schnappschuss dort —, und
   * damit sieht eine fremde Kurve genauso aus wie die eigene.
   *
   * Geglättet, und zwar deutlich: der Kurs fremder Figuren wandert in Sprüngen
   * zwischen den Schnappschüssen, und eine ungeglättete Rate zuckte im Takt der
   * Pakete. Zwei Zehntelsekunden Trägheit machen daraus ein Einlegen.
   */
  private rolleNachKurve(e: EntityVisual, dt: number): void {
    if (dt <= 0) return;
    let diff = e.yaw - e.yawVorher;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    e.yawVorher = e.yaw;

    /*
     * Nach rechts fliegen heisst: der Kurs wird kleiner (`updateFlight` zieht
     * ihn ab), und die Figur soll sich nach rechts legen.
     *
     * Bei der Drehreihenfolge `YXZ` ist `rotation.z` die **innerste** Drehung,
     * also eine um die eigene Längsachse — genau das, was „sich in die Kurve
     * legen" heisst. Positiv kippt die Oberseite nach −X, und −X ist rechts,
     * wenn die Figur nach +Z schaut. Also: negative Kursänderung, positiver
     * Rollwinkel.
     */
    // Gedeckelt bei gut zwanzig Grad: eine volle Kurve (1,2 rad/s, siehe
    // `kFlugGierRate`) legt die Figur damit sichtbar hinein, ohne dass es
    // aussieht, als stürze sie ab.
    const ziel = Math.max(-0.4, Math.min(0.4, (-diff / dt) * 0.3));
    e.rollen += (ziel - e.rollen) * Math.min(1, dt * 5);
  }

  /**
   * Was das Fluggerät hinter sich herzieht.
   *
   * Zwei Sorten, weil es zwei Geräte gibt und beide etwas anderes sind:
   *
   * - **Das Brett** zieht eine Fahne: seine Hinterkante wird je Bild
   *   aufgezeichnet, und die Kette dieser Kanten ist eine Fläche in der Breite
   *   des Bretts, die nach hinten ausblasst. Dasselbe Band wie hinter einer
   *   Klinge, nur länger — siehe `bandspur.ts`.
   * - **Der Besen** sprüht Funken aus dem Reisig, wie Abgas. Die fallen und
   *   verlöschen von selbst; die Wolke kann das schon.
   *
   * Nur bei Fahrt. Wer in der Luft steht, zieht nichts hinter sich her — eine
   * Fahne an einem stehenden Brett wäre ein Fleck, der mitwandert, und Funken
   * ohne Schub sähen aus wie ein Leck.
   */
  private zeichneFlugspur(e: EntityVisual, dt: number): void {
    const mesh = e.flugMesh;
    if (!mesh || e.speed < 1.5) {
      // Die Uhr zurücksetzen, damit der erste Funke nach dem Anfahren sofort
      // kommt und nicht erst nach dem Rest eines alten Abstands.
      e.funkenUhr = 0;
      return;
    }

    mesh.updateMatrixWorld(true);

    if (e.flug === 'flug_besen') {
      /*
       * Aus dem Reisig, und der sitzt hinten am Stiel: `baueFluggeraet` setzt
       * ihn auf z = −1,05 bei y = 0,75. Die Zahlen hier sind die Gegenzahlen
       * dazu — wer den Besen dort umbaut, sieht seine Funken sonst mitten im
       * Stiel entstehen.
       */
      e.funkenUhr -= dt;
      if (e.funkenUhr > 0) return;
      // Alle drei Hundertstel einer: rund dreissig Funken je Sekunde, dicht
      // genug für einen Streifen und wenig genug, dass die Wolke von 512
      // Plätzen nicht binnen zwei Sekunden nur noch aus Besen besteht.
      e.funkenUhr = 0.03;

      this.klingeA.set(0, 0.75, -1.3);
      mesh.localToWorld(this.klingeA);
      this.particles.burst(this.klingeA.x, this.klingeA.y, this.klingeA.z, {
        count: 2,
        // Warmes Gold wie das Reisig selbst, nur heller: Funken sind Licht.
        color: 0xffcf72,
        // Langsam und ohne Richtung: sie sollen dort stehenbleiben, wo der
        // Besen war, und nicht ihm hinterherfliegen. Die sichtbare Bewegung
        // macht die Figur, die sich entfernt.
        speed: 0.5,
        // Kleiner als ein Treffer-Funke (1,9): das hier sind Sternchen und
        // kein Aufschlag. Die Grösse geht durch `300 / Abstand` — bei 5 stand
        // hinter dem Besen ein einziger gelber Fleck von zweihundert Punkten.
        size: 1.1,
        life: 0.5,
        lift: 0.35,
      });
      return;
    }

    /*
     * Das Brett: die Hinterkante von links nach rechts.
     *
     * Die Zahlen kommen aus `baueFluggeraet` — 0,62 breit, 1,9 lang, Oberkante
     * bei null. Die Kante liegt also bei z = −0,95 und x = ±0,31. Ein Fingerbreit
     * hinter dem Brett, damit die Fahne nicht in ihm steckt.
     */
    this.klingeA.set(-0.31, -0.02, -1.0);
    this.klingeB.set(0.31, -0.02, -1.0);
    mesh.localToWorld(this.klingeA);
    mesh.localToWorld(this.klingeB);
    this.flugspur.probiere(
      e.id,
      this.klingeA.x, this.klingeA.y, this.klingeA.z,
      this.klingeB.x, this.klingeB.y, this.klingeB.z,
      /*
       * Dasselbe Blau wie die Oberseite des Bretts (0x3f7fa8), etwas dunkler.
       *
       * Dunkler und nicht heller: das Band wird additiv gezeichnet, und bei
       * voller Helligkeit stand hinter dem Brett eine weisse Platte statt
       * einer Fahne. Was durchscheinen soll, muss dunkel anfangen.
       */
      [0.16, 0.34, 0.52],
    );
  }

  /**
   * Nimmt die Lage der Klinge für den Schweif auf.
   *
   * **Nach** `rig.update`: erst danach steht die Pose dieses Bildes, und der
   * Schweif soll dorthin, wo die Klinge gerade ist — nicht dorthin, wo sie im
   * vorigen Bild war.
   *
   * Die Weltmatrizen werden hier von Hand nachgezogen. Three.js tut das erst
   * beim Zeichnen, und bis dahin stünden im Halter noch die Zahlen des letzten
   * Bildes. Es kostet einen Durchlauf je zuschlagender Figur — bei einer
   * Handvoll gleichzeitiger Hiebe ist das nichts.
   */
  private zeichneKlingenlage(e: EntityVisual): void {
    const mount = e.rig.weaponMount;
    const span = e.rig.weaponSpan;
    const farbe = SCHWEIF_FARBEN[e.rig.weapon ?? ''];
    // Ohne Waffe kein Schweif: eine Faust zieht keinen Lichtbogen, und ein
    // Bogen wird nicht geschwungen.
    if (!mount || !span || !farbe) return;

    e.rig.root.updateMatrixWorld(true);
    if (span.axis === 'y') {
      this.klingeA.set(0, span.bottom, 0);
      this.klingeB.set(0, span.bottom + span.length, 0);
    } else {
      this.klingeA.set(0, 0, span.bottom);
      this.klingeB.set(0, 0, span.bottom + span.length);
    }
    mount.localToWorld(this.klingeA);
    mount.localToWorld(this.klingeB);

    this.spur.probiere(
      e.id,
      this.klingeA.x, this.klingeA.y, this.klingeA.z,
      this.klingeB.x, this.klingeB.y, this.klingeB.z,
      farbe,
    );
  }

  /**
   * Lässt eine Figur sich nach etwas bücken.
   *
   * Läuft die Geste schon, beginnt sie nicht von vorn: wer zwei Haufen kurz
   * hintereinander aufhebt, soll nicht zucken.
   */
  playPickup(entityId: number): void {
    const e = this.entities.get(entityId);
    if (!e || e.pickupTimer >= 0) return;
    e.pickupTimer = 0;
  }

  /**
   * Lässt eine Figur die Wirbelklinge drehen.
   *
   * Gibt die Stelle zurück, an der es passiert — oder nichts, wenn die Figur
   * gar nicht sichtbar ist. Der Aufrufer setzt die Funken dorthin: die Sicht
   * weiss, wo jemand steht, und der Ruf über das Netz nennt nur die Kennung.
   *
   * Läuft die Drehung schon, beginnt sie nicht von vorn — wie beim Bücken.
   * Anders als dort ist das hier keine Höflichkeit gegenüber dem Auge: der
   * Server lässt die Fertigkeit ohnehin nur einmal je Abklingzeit zu, ein
   * zweiter Ruf wäre also ein doppelt zugestelltes Ereignis.
   */
  playWirbel(entityId: number): { x: number; y: number; z: number } | undefined {
    const e = this.entities.get(entityId);
    if (!e) return undefined;
    if (e.wirbelTimer < 0) e.wirbelTimer = 0;
    return { x: e.x, y: e.y, z: e.z };
  }

  /** Entfernt alle Figuren, behält aber Boden und Props. Für Serverwechsel. */
  clearEntities(): void {
    // Auch die Beute: sie gehört zur alten Sitzung. Was auf der neuen liegt,
    // meldet der erste Snapshot.
    this.loot.clear();
    // Auch die Bänder: sie hängen an Kennungen, die es gleich nicht mehr gibt.
    this.spur.reset();
    this.flugspur.reset();

    for (const e of this.entities.values()) {
      this.wesen.remove(e.rig.root);
      this.registry.releaseRig(e.rig);
    e.rig.dispose();
    }
    this.entities.clear();
  }

  clear(): void {
    for (const a of this.arrows) this.root.remove(a.mesh);
    this.arrows = [];
    // Nur leeren, nicht entfernen — das Objekt bleibt in der Szene.
    this.particles.reset();
    // Dasselbe für die Laternen. Ohne das leuchteten beim Kartenwechsel die
    // Standorte der alten Karte weiter, bis die neuen Props gebaut sind.
    this.lanterns.setPlacements([]);
    // Und für die Beute: sie gehört zur alten Karte und liegt dort weiter.
    this.loot.clear();

    for (const e of this.entities.values()) {
      this.wesen.remove(e.rig.root);
      this.registry.releaseRig(e.rig);
      e.aura?.dispose();
      e.rig.dispose();
    }
    this.entities.clear();

    for (const mesh of this.propMeshes) {
      this.root.remove(mesh);
      mesh.dispose();
    }
    this.propMeshes = [];

    // Die Tore gehören zur alten Karte. Ohne diese Zeilen drehte sich hinter
    // dem Tor ein zweiter Kreis an der Stelle, an der auf der **vorigen**
    // Karte einer stand.
    for (const ring of this.portale) {
      this.root.remove(ring.root);
      ring.dispose();
    }
    this.portale = [];

    /*
     * Der Teppich gehört zur alten Karte: seine Halme stehen auf deren
     * Gelände, und das ist gleich weg. Er wird deshalb abgeräumt und beim
     * nächsten `setMap` neu gebaut — anders als Beute und Laternen, die ihre
     * Grösse über Karten hinweg behalten.
     */
    if (this.gras) {
      this.root.remove(this.gras.mesh);
      this.gras.dispose();
      this.gras = undefined;
    }

    if (this.terrain) {
      this.root.remove(this.terrain.object);
      this.terrain.dispose();
      this.terrain = undefined;
    }
  }
}
