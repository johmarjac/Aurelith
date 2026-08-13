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
  getMob,
  getNpc,
  type MapDocument,
  type SpawnRow,
  type UpdateRow,
} from '@aurelith/shared';
import type { QualitySettings } from '../config.ts';
import type { ModelRegistry } from './modelRegistry.ts';
import { Lanterns, type LanternPlacement } from './lanterns.ts';
import { LootView } from './lootView.ts';
import { WeaponAura } from './weaponAura.ts';
import { SetAura } from './setAura.ts';
import { stepAuras } from './auraClock.ts';
import { ParticleField } from './particles.ts';
import { buildTerrain, type TerrainMesh } from './terrain.ts';
import type { TextureLoader } from './textures.ts';
import type { CharacterRig } from './rigs.ts';

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
   * Läuft während einer Geste — Sekunden seit ihrem Beginn, sonst negativ.
   *
   * Getrennt vom Schlag, weil beides zugleich vorkommen kann und weil eine
   * Geste nichts mit dem Kampf zu tun hat: sie kommt vom Server als Ereignis
   * und nicht aus dem Zustand der Simulation.
   */
  pickupTimer: number;
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
  /** Der warme Schein um die Figur, sofern ein Satz leuchtet. */
  satzAura?: SetAura;
  /** Höhe über dem Boden für Nameplate und Schadenszahlen. */
  height: number;
}

function modelKeyFor(type: EntityType, defId: string): string {
  if (type === EntityType.Player) return 'player';
  if (type === EntityType.Npc) return getNpc(defId)?.model ?? 'npc_guide';
  return getMob(defId)?.model ?? 'mob_mote';
}

function heightFor(type: EntityType, defId: string): number {
  if (type === EntityType.Player) return 1.8;
  if (type === EntityType.Npc) {
    const def = getNpc(defId);
    return (def?.height ?? 1.8) * (def?.scale ?? 1);
  }
  const def = getMob(defId);
  return (def?.height ?? 1.5) * (def?.scale ?? 1);
}

export class WorldView {
  readonly root = new THREE.Group();
  readonly entities = new Map<number, EntityVisual>();

  private terrain?: TerrainMesh;
  private propMeshes: THREE.InstancedMesh[] = [];
  /** Pfeile in der Luft. Kurzlebig — meist keiner, selten eine Handvoll. */
  private arrows: FlyingArrow[] = [];
  /** Funken. Eine Wolke für alles, mit fester Größe. */
  readonly particles = new ParticleField();
  /** Warmes Licht an den Laternen. Fester Pool, wandert zum Betrachter. */
  readonly lanterns: Lanterns;
  /** Was gerade auf dem Boden liegt. Wird aus dem Snapshot abgeglichen. */
  readonly loot: LootView;
  private doc?: MapDocument;
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
  }

  get mapId(): string {
    return this.doc?.id ?? '';
  }

  /** Baut Boden und Props einer Map neu auf. Alte Entities fallen dabei weg. */
  setMap(world: CoreWorld, doc: MapDocument, quality: QualitySettings): void {
    this.clear();
    this.doc = doc;

    this.terrain = buildTerrain(world, doc, quality.terrainCell, {
      useNormalMaps: quality.groundNormalMaps,
    });
    this.root.add(this.terrain.object);

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
      const mesh = new THREE.InstancedMesh(geometry, this.registry.material, props.length);
      mesh.name = `props:${model}`;
      // Props liegen über die ganze Map verteilt; eine Hüllkugel dafür wäre so
      // groß wie die Map und würde ohnehin nie aussortiert.
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;

      let anyTint = false;
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
        mesh.setMatrixAt(i, matrix);

        if (prop.tint !== undefined) {
          anyTint = true;
          color.setHex(prop.tint);
        } else {
          color.setRGB(1, 1, 1);
        }
        mesh.setColorAt(i, color);

        if (model === 'lantern_post') {
          // 2,65 ist die Höhe des Glaskörpers im Modell; die Skalierung des
          // Props zieht sie mit.
          lanterns.push({ x: prop.position[0], y: y + 2.65 * prop.scale, z: prop.position[2] });
        }
      }

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      if (!anyTint && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

      this.root.add(mesh);
      this.propMeshes.push(mesh);
    }

    this.lanterns.setPlacements(lanterns);
  }

  /**
   * Zeichnet die Tore.
   *
   * Das Tor ist der Torbogen — nicht mehr ein Prop, das zufällig neben einer
   * unsichtbaren Zone steht. Vorher konnte man beides unabhängig verschieben,
   * und man lief durch eine leere Wiese, in der es dann plötzlich klickte.
   *
   * Die Position kommt aus `doc.portals`, also aus derselben Zeile, die auch
   * den Server auslösen lässt. Auseinanderlaufen können sie damit nicht mehr.
   */
  private buildGates(world: CoreWorld, doc: MapDocument): void {
    if (doc.portals.length === 0) return;

    const geometry = this.registry.gateGeometry();
    const mesh = new THREE.InstancedMesh(geometry, this.registry.material, doc.portals.length);
    mesh.name = 'gates';
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;

    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3(1, 1, 1);
    const euler = new THREE.Euler();

    for (let i = 0; i < doc.portals.length; i++) {
      const portal = doc.portals[i]!;
      const [x, z] = portal.position;
      position.set(x, world.heightAt(x, z), z);
      euler.set(0, portal.yaw, 0);
      quaternion.setFromEuler(euler);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;

    this.root.add(mesh);
    this.propMeshes.push(mesh);
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
    this.root.add(rig.root);

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
      attackTimer: -1,
      pickupTimer: -1,
      speed: 0,
      rig,
      weapon: row.weapon,
      weaponUpgrade: row.weaponUpgrade,
      outfit: row.outfit,
      setGlow: row.setGlow,
      aggro: row.aggro,
      height: heightFor(row.type, row.defId),
    };
    this.attachAura(visual);
    this.attachSetAura(visual);
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
    this.onAttackStart?.(e);
  }

  /**
   * Tauscht das Rig einer bestehenden Figur.
   *
   * Nur bei einem Waffenwechsel. Position und Zustand bleiben, was sich ändert
   * ist allein das, was in der Hand liegt — dafür ein neues Rig zu bauen ist
   * grober als nötig, aber es passiert selten und hält den Aufbau einfach.
   */
  private replaceRig(visual: EntityVisual, row: SpawnRow): void {
    this.root.remove(visual.rig.root);
    this.registry.releaseRig(visual.rig);
    visual.aura?.dispose();
    visual.aura = undefined;
    visual.satzAura?.dispose();
    visual.satzAura = undefined;
    visual.rig.dispose();

    const rig = this.registry.createRig(modelKeyFor(row.type, row.defId), row.weapon, row.outfit);
    rig.root.position.set(visual.x, visual.y, visual.z);
    rig.root.rotation.y = visual.yaw;
    this.root.add(rig.root);

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
    this.root.remove(e.rig.root);
    this.registry.releaseRig(e.rig);
    e.aura?.dispose();
    e.satzAura?.dispose();
    e.rig.dispose();
    this.entities.delete(id);
  }

  /** Setzt die eigene Figur direkt — sie läuft über die Prediction. */
  setLocal(id: number, x: number, y: number, z: number, yaw: number, speed: number): void {
    const e = this.entities.get(id);
    if (!e) return;
    e.x = e.targetX = x;
    e.y = e.targetY = y;
    e.z = e.targetZ = z;
    e.yaw = e.targetYaw = yaw;
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

      if (e.attackTimer >= 0) {
        e.attackTimer += dt;
        if (e.attackTimer > ATTACK_ANIM_SECONDS) e.attackTimer = -1;
      }
      if (e.pickupTimer >= 0) {
        e.pickupTimer += dt;
        if (e.pickupTimer > PICKUP_ANIM_SECONDS) e.pickupTimer = -1;
      }

      e.rig.update({
        speed: e.speed,
        attackPhase: e.attackTimer >= 0 ? e.attackTimer / ATTACK_ANIM_SECONDS : -1,
        pickupPhase: e.pickupTimer >= 0 ? e.pickupTimer / PICKUP_ANIM_SECONDS : -1,
        dead: e.state === EntityState.Dead,
        time: this.elapsed,
        dt,
      });
    }
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

  /** Entfernt alle Figuren, behält aber Boden und Props. Für Serverwechsel. */
  clearEntities(): void {
    // Auch die Beute: sie gehört zur alten Sitzung. Was auf der neuen liegt,
    // meldet der erste Snapshot.
    this.loot.clear();

    for (const e of this.entities.values()) {
      this.root.remove(e.rig.root);
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
      this.root.remove(e.rig.root);
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

    if (this.terrain) {
      this.root.remove(this.terrain.object);
      this.terrain.dispose();
      this.terrain = undefined;
    }
  }
}
