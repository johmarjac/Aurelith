/**
 * Renderer, Kamera, Licht, Himmel.
 *
 * WebGL 2 ist Vorgabe aus dem Blueprint — nicht WebGL 1 mit sechzehn
 * Erweiterungen wie bei Flyff. Three.js läuft darauf ohnehin; die Prüfung hier
 * stellt nur sicher, dass wir es merken, wenn ein Gerät es nicht kann.
 */

import * as THREE from 'three';
import type { CoreWorld } from '@aurelith/core';
import { Gfx } from '../gfx/gfx.ts';
import type { Mat4 } from '../gfx/math.ts';
import type { EnvironmentDef, SkyState } from '@aurelith/shared';
import type { QualitySettings } from '../config.ts';

/** Wie weit die Kamera hinter der Figur steht, in Stufen. */
const ZOOM_MIN = 0.35;
const ZOOM_MAX = 22;
const PITCH_MIN = -0.25;
const PITCH_MAX = 1.35;

/**
 * Ab hier wird die eigene Figur ausgeblendet.
 *
 * Darunter steckt die Kamera in ihr, und was man dann sähe, wäre die Innenseite
 * des Brustkorbs. Oberhalb bleibt sie stehen — auch ganz nah, denn genau dort
 * will man sie ja ansehen.
 */
const FIRST_PERSON_AT = 0.9;

/**
 * Radius um die Achse der Figur, in den die Kamera nicht eindringt.
 *
 * Ohne das schiebt sich die Kamera beim Herandrehen seitlich durch Schulter und
 * Kopf. Ein Zylinder statt einer Kugel, weil die Figur genau das ist: aufrecht,
 * kantig, überall etwa gleich breit.
 */
const BODY_CLEARANCE = 0.62;

/**
 * Wie schnell ein Mausrad-Schritt zoomt, als Faktor statt als Abstand.
 *
 * Ein fester Abstand je Schritt ist weit draußen zu fein und nah dran viel zu
 * grob — von 3,5 auf 2,3 auf 1,1 sind drei Schritte durch den gesamten
 * interessanten Bereich. Multiplikativ bleibt der Schritt gefühlt gleich groß,
 * egal wo man steht.
 */
const ZOOM_RATE = 0.16;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

import { SkyBodies } from './skyBodies.ts';
import { Umriss } from './umriss.ts';

export class Scene3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /**
   * Unser eigener Renderer auf demselben Kontext.
   *
   * Der Kontext kommt von three.js und wird nicht neu geholt: eine Leinwand
   * hat genau einen, und wer ihn zweimal anfordert, bekommt ohnehin denselben
   * zurück. Ihn beim Eigentümer zu erfragen sagt aber, wem er gehört —
   * heute three.js, am Ende des Umbaus uns.
   */
  readonly gfx: Gfx;

  private readonly sun = new THREE.DirectionalLight(0xffffff, 1.5);
  private readonly ambient = new THREE.HemisphereLight(0xffffff, 0x444444, 0.9);
  private readonly skyMesh: THREE.Mesh;
  private readonly skyGeometry: THREE.SphereGeometry;
  private readonly skyMaterial: THREE.MeshBasicMaterial;
  /** Sonne, Mond und Wolken. Hängen an der Kuppel, nicht in der Welt. */
  private readonly bodies = new SkyBodies();

  /** Kamerastand. Yaw ist zugleich die Blickrichtung der Figur. */
  yaw = 0;
  pitch = 0.55;
  distance = 9;

  private readonly followed = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();

  /** Nebelweiten der Karte. Der Tageszyklus färbt nur, er verschiebt nicht. */
  private fogNear = 90;
  private fogFar = 320;
  /**
   * Wohin die Sonne gerade steht, als Einheitsvektor.
   *
   * Mit Schatten wird die Lichtquelle in `follow` dem Spieler nachgeführt —
   * sonst stünde sie fest im Ursprung und die Schattenkamera liefe leer. Ihre
   * *Richtung* kommt aber vom Tageszyklus, und deshalb steht sie hier.
   */
  private readonly sunDirection = new THREE.Vector3(0.42, 0.82, 0.38).normalize();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private quality: QualitySettings,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: quality.maxPixelRatio <= 1.5,
      powerPreference: 'high-performance',
      // Kein Alpha: der Himmel deckt ohnehin alles ab, und undurchsichtig ist
      // auf mobilen GPUs spürbar billiger.
      alpha: false,
      stencil: false,
    });

    // Derselbe Kontext, zwei Nutzer. Ohne WebGL 2 gäbe es unsere eigenen Pässe
    // gar nicht — deshalb ist das hier keine Warnung mehr, sondern die
    // Bedingung, unter der der Client läuft.
    const gl = this.renderer.getContext();
    if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Aurelith braucht WebGL 2.');
    }
    this.gfx = new Gfx(gl);

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxPixelRatio));
    this.renderer.shadowMap.enabled = quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    /*
     * Eine Tonwertkurve — und der Grund dafür ist gemessen, nicht Geschmack.
     *
     * Ohne sie schneidet der Renderer alles über eins hart ab. Das klingt
     * harmlos, hat aber zwei Folgen, die beide falsch aussehen: eine Fläche,
     * die von Sonne **und** Himmel getroffen wird, ist bei 3,1 Einheiten Licht
     * längst weiss und verliert ihre Farbe, während die Schattenseite nur das
     * Umgebungslicht abbekommt und absäuft. Ein Bildschirmfoto vom Mittag hatte
     * eine mittlere Helligkeit von 74 bis 99 von 255 — bei einem Fünftel der
     * Bildpunkte unter 45. Für einen hellen Sommertag ist das anderthalb
     * Blenden zu wenig.
     *
     * `NeutralToneMapping` (die Khronos-Kurve) lässt alles bis etwa 0,8 in
     * Ruhe und rollt nur die Spitzen ab. Damit kostet mehr Licht keine Farbe
     * mehr, und die Belichtung darf über eins gehen, ohne dass der Himmel zu
     * einer weissen Fläche wird. ACES wäre die andere Wahl gewesen — die
     * entsättigt aber kräftig, und ein Spiel in diesen Farben lebt davon, dass
     * das Gras grün bleibt.
     */
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.3;

    // Nahebene bei 5 cm statt 10: nah an der Figur schneidet 0,1 sonst sichtbar
    // in Nase und Schulter. Die Tiefengenauigkeit trägt das — die Fernebene
    // liegt bei einigen hundert Metern, nicht bei Kilometern.
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, quality.viewDistance * 2.2);

    this.sun.castShadow = quality.shadows;
    if (quality.shadows) {
      this.sun.shadow.mapSize.set(1024, 1024);
      this.sun.shadow.camera.near = 1;
      this.sun.shadow.camera.far = 120;
      const d = 40;
      this.sun.shadow.camera.left = -d;
      this.sun.shadow.camera.right = d;
      this.sun.shadow.camera.top = d;
      this.sun.shadow.camera.bottom = -d;
    }
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.scene.add(this.ambient);

    // Himmelskuppel mit Farbverlauf. Billiger als eine Cubemap und passt zum
    // Rest, der ebenfalls aus Vertexfarben besteht.
    this.skyGeometry = new THREE.SphereGeometry(1, 24, 16);
    this.skyMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.skyMesh = new THREE.Mesh(this.skyGeometry, this.skyMaterial);
    this.skyMesh.renderOrder = -1000;
    this.scene.add(this.skyMesh);
    this.scene.add(this.bodies.root);

    this.resize();
  }

  /** Übernimmt Himmel, Nebel und Licht aus dem Map-Dokument. */
  applyEnvironment(env: EnvironmentDef, viewDistance: number): void {
    this.fogNear = env.fogNear;
    this.fogFar = Math.min(env.fogFar, viewDistance);
    this.paintSky(env.skyColor, env.horizonColor);

    this.scene.fog = new THREE.Fog(env.fogColor, this.fogNear, this.fogFar);
    this.scene.background = new THREE.Color(env.fogColor);

    const [sx, sy, sz] = env.sunDirection;
    const len = Math.hypot(sx, sy, sz) || 1;
    this.sun.position.set((sx / len) * 60, (sy / len) * 60, (sz / len) * 60);
    this.sun.color.setHex(env.sunColor);
    this.sun.intensity = env.sunIntensity;

    this.ambient.color.setHex(env.skyColor);
    this.ambient.groundColor.setHex(env.ambientColor);
    this.ambient.intensity = env.ambientIntensity;

    this.camera.far = Math.max(120, viewDistance * 2.2);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Übernimmt einen Stand des Tageszyklus.
   *
   * Dieselben Größen wie `applyEnvironment`, nur ohne Kamera und Nebelweiten —
   * die gehören der Karte und ändern sich mit der Tageszeit nicht. Die
   * Sonnenrichtung wird hier **nicht** in die Szene übernommen, solange
   * Schatten an sind: dort führt `follow` die Lichtposition dem Spieler nach,
   * damit er nicht aus der Schattenkamera fällt.
   */
  applySky(state: SkyState): void {
    this.paintSky(state.skyColor, state.horizonColor);

    const fog = this.scene.fog;
    if (fog instanceof THREE.Fog) fog.color.setHex(state.fogColor);
    else this.scene.fog = new THREE.Fog(state.fogColor, this.fogNear, this.fogFar);
    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.setHex(state.fogColor);
    }

    const [sx, sy, sz] = state.sunDirection;
    const len = Math.hypot(sx, sy, sz) || 1;
    this.sunDirection.set(sx / len, sy / len, sz / len);
    if (!this.quality.shadows) {
      this.sun.position.copy(this.sunDirection).multiplyScalar(60);
    }

    this.sun.color.setHex(state.sunColor);
    this.sun.intensity = state.sunIntensity;
    // `ambientSkyColor` und nicht `skyColor`: der Himmel ist ein Bild *und*
    // eine Lichtquelle, und nachts sind das zwei verschiedene Farben. Stand
    // hier die Farbe der Kuppel, war das Umgebungslicht nachts schwarz.
    this.ambient.color.setHex(state.ambientSkyColor);
    this.ambient.groundColor.setHex(state.ambientColor);
    this.ambient.intensity = state.ambientIntensity;

    this.bodies.update(state.sunDisc, state.sunColor, state.horizonColor, state.darkness);
  }

  /** Lässt die Wolken ziehen. Je Bild, anders als die Farben. */
  stepSky(dt: number): void {
    this.bodies.step(dt);
  }

  /** Färbt die Himmelskuppel neu ein. */
  private paintSky(skyColor: number, horizonColor: number): void {
    const sky = new THREE.Color(skyColor);
    const horizon = new THREE.Color(horizonColor);

    const pos = this.skyGeometry.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      // Oben Himmelsfarbe, unten Horizontfarbe, dazwischen weich.
      const t = Math.max(0, Math.min(1, pos.getY(i) * 0.5 + 0.5));
      c.copy(horizon).lerp(sky, Math.pow(t, 0.6));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    this.skyGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  /**
   * Schaltet die Schatten — unabhängig von der Geräteklasse.
   *
   * Die Geräteklasse (`quality.shadows`) sagt, was die Voreinstellung sein
   * soll; das hier sagt, was der Spieler will. Nach oben offen: wer auf einem
   * Telefon Schatten sehen möchte, darf das — er sieht auch gleich, was es
   * kostet. Die Zahlentafel steht ja daneben.
   */
  setzeSchatten(an: boolean): void {
    this.renderer.shadowMap.enabled = an;
    this.sun.castShadow = an;
    /*
     * Und die Materialien müssen es erfahren.
     *
     * three.js backt „empfängt Schatten" in den Shader ein. Wer nur
     * `shadowMap.enabled` umlegt, bekommt eine Wiese, die weiter so aussieht
     * wie vorher — bis irgendetwas anderes ihr Material anfasst. Einmal durch
     * die Szene ist beim Umschalten billig; es passiert, wenn jemand ein
     * Häkchen setzt, und nicht in einem Bild.
     */
    this.scene.traverse((o) => {
      const netz = o as { material?: THREE.Material | THREE.Material[] };
      if (!netz.material) return;
      for (const m of Array.isArray(netz.material) ? netz.material : [netz.material]) {
        m.needsUpdate = true;
      }
    });
  }

  /**
   * Der Ast mit den Wesen — die Vorlage für den Umriss.
   *
   * Von aussen gesetzt und nicht hier gebaut: die Szene weiss, wie man
   * zeichnet, und die Weltansicht weiss, was ein Wesen ist. Ohne Vorlage
   * bleibt der Umriss aus, und das ist der richtige Zustand für jeden Moment,
   * in dem noch keine Welt steht.
   */
  private umrissQuelle?: THREE.Scene;
  private umriss?: Umriss;

  setzeUmrissQuelle(wesen: THREE.Scene | undefined): void {
    this.umrissQuelle = wesen;
  }

  /**
   * Schaltet den schwarzen Strich um Figuren und Wesen.
   *
   * Wirkt im nächsten Bild: der Strich hängt an keinem Netz, sondern entsteht
   * in zwei Durchgängen aus dem fertigen Bild. Genau deshalb wurde er von der
   * umgestülpten Hülle darauf umgestellt — siehe `umriss.ts`.
   *
   * Das Ziel entsteht erst beim Einschalten. Wer den Strich nie anmacht,
   * bezahlt keinen Bildpunkt Speicher dafür.
   */
  setzeUmriss(an: boolean): void {
    if (an && !this.umriss) {
      this.umriss = new Umriss();
      this.passeUmrissGroesseAn();
    } else if (!an && this.umriss) {
      this.umriss.dispose();
      this.umriss = undefined;
    }
  }

  private passeUmrissGroesseAn(): void {
    if (!this.umriss) return;
    const breite = this.canvas.clientWidth || window.innerWidth;
    const hoehe = this.canvas.clientHeight || window.innerHeight;
    this.umriss.setzeGroesse(breite, hoehe, this.renderer.getPixelRatio());
  }

  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxPixelRatio));
    this.renderer.shadowMap.enabled = quality.shadows;
    this.sun.castShadow = quality.shadows;
  }

  orbit(deltaYaw: number, deltaPitch: number): void {
    this.yaw -= deltaYaw;
    this.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.pitch + deltaPitch));
  }

  /**
   * Zieht die Kamera hinter eine Blickrichtung — beim Fliegen, beim Steuern.
   *
   * Am Boden bestimmt die Kamera, wohin die Figur läuft; dort wäre eine
   * Nachführung ein Streit zwischen zwei Händen an derselben Achse. In der
   * Luft ist es umgekehrt: die Figur hat einen Kurs, und A und D drehten ohne
   * das etwas, das man nicht sieht.
   *
   * Wann sie greift, entscheidet der Aufrufer — und zwar streng: nur, solange
   * gesteuert wird **und** niemand die Kamera festhält. Ohne diese zweite
   * Bedingung stand hier schon einmal eine Kamera, die jedes Ziehen im
   * nächsten Bild zurückholte.
   *
   * Weich und nicht sofort: eine Kamera, die jeder Kurskorrektur ohne
   * Verzögerung folgt, ist nicht ruhig zu halten.
   */
  folgeRichtung(yaw: number, dt: number): void {
    let diff = yaw - this.yaw;
    // Auf den kürzeren Weg bringen: ohne das dreht die Kamera bei einem
    // Vorzeichenwechsel einmal ganz herum.
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    /*
     * Der Faktor ist bildratenunabhängig und trotzdem eine Wahl: er bestimmt,
     * wie weit die Kamera einem sich **drehenden** Kurs hinterherläuft.
     *
     * Die Nachführung holt je Sekunde den Anteil `1 − k` auf; bei einer
     * Drehrate von 1,2 rad/s bleibt daraus ein fester Rückstand von etwa
     * `Drehrate / ln(1/k)`. Mit 0,08 wären das knapp dreissig Grad — die
     * Figur flöge sichtbar schräg aus dem Bild. Mit 0,004 sind es gut zehn,
     * und das liest sich als weiches Nachziehen.
     */
    this.yaw += diff * (1 - Math.pow(0.004, dt));
  }

  zoom(delta: number): void {
    this.distance = clamp(this.distance * Math.exp(delta * ZOOM_RATE), ZOOM_MIN, ZOOM_MAX);
  }

  /** Ist die Kamera so nah, dass die eigene Figur ausgeblendet werden sollte? */
  get isFirstPerson(): boolean {
    return this.distance <= FIRST_PERSON_AT;
  }

  /**
   * Setzt die Kamera hinter das Ziel. `world` dient dazu, sie über dem Boden
   * zu halten — ohne das taucht sie an Hängen in die Erde.
   */
  follow(targetX: number, targetY: number, targetZ: number, world: CoreWorld | undefined, dt: number): void {
    // Der Drehpunkt wandert beim Herankommen nach oben. Bliebe er auf
    // Brusthöhe, zoomte man aus der Ferne schön heran und stünde am Ende vor
    // einem Hemd — das Gesicht läge über dem Bildrand.
    const closeness = 1 - clamp((this.distance - ZOOM_MIN) / (4 - ZOOM_MIN), 0, 1);
    const pivotY = 1.4 + 0.3 * closeness;

    this.followed.lerp(
      this.desired.set(targetX, targetY + pivotY, targetZ),
      // Weiches Nachziehen, aber bildratenunabhängig.
      1 - Math.pow(0.0015, dt),
    );

    const cosP = Math.cos(this.pitch);
    let camX = this.followed.x - Math.sin(this.yaw) * cosP * this.distance;
    let camZ = this.followed.z - Math.cos(this.yaw) * cosP * this.distance;
    let camY = this.followed.y + Math.sin(this.pitch) * this.distance;

    // Nicht in die Figur hinein.
    //
    // Der Abstand wird vom Drehpunkt aus gemessen, und der sitzt *in* der
    // Figur. Nah dran und flach geneigt landet die Kamera deshalb zwischen
    // den Schultern — man sieht die Rückseite der Vorderseite. Wo die Kamera
    // auf Körperhöhe steht, wird sie hier nach außen geschoben.
    //
    // In der ersten Person entfällt das: dort ist die Figur ohnehin
    // ausgeblendet, und ein Herausschieben nähme dem Modus den Sinn.
    if (!this.isFirstPerson) {
      const dx = camX - this.followed.x;
      const dz = camZ - this.followed.z;
      const horizontal = Math.hypot(dx, dz);
      const withinBody = camY > targetY + 0.1 && camY < targetY + 1.95;
      if (withinBody && horizontal < BODY_CLEARANCE && horizontal > 1e-4) {
        const push = BODY_CLEARANCE / horizontal;
        camX = this.followed.x + dx * push;
        camZ = this.followed.z + dz * push;
      }
    }

    if (world) {
      const ground = world.heightAt(camX, camZ);
      if (camY < ground + 0.8) camY = ground + 0.8;
    }

    this.camera.position.set(camX, camY, camZ);
    this.camera.lookAt(this.followed);

    /*
     * Die Matrizen sofort nachziehen — sonst hinkt alles hinterher, was
     * ausserhalb des Zeichnens auf diese Kamera rechnet.
     *
     * `project()` liest `matrixWorldInverse`, und die schreibt three.js erst
     * in `renderer.render()` fort. Wer die Kamera hier bewegt und noch vor dem
     * Zeichnen projiziert — die Namensschilder tun genau das —, rechnet mit
     * dem Stand des **letzten** Bildes.
     *
     * Beim Laufen fällt das nicht auf: die Kamera zieht weich nach, und ein
     * Bild Rückstand ist ein gleichmässiger Versatz von Bruchteilen eines
     * Bildpunkts. Beim Schwenken schon: der Sprung je Bild ist gross und
     * ungleichmässig, und das Schild zittert hinter dem Kopf her.
     *
     * Der Renderer rechnet es gleich noch einmal. Das ist eine Matrixinversion
     * je Bild und der Preis dafür, dass „wo steht die Kamera" nach diesem
     * Aufruf für alle dasselbe heisst.
     */
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();

    this.skyMesh.position.copy(this.camera.position);
    this.skyMesh.scale.setScalar(this.camera.far * 0.9);
    // Sonne, Mond und Wolken genauso: sie haben eine Richtung und keinen Ort.
    // Wer nach Norden läuft, kommt der Sonne nicht näher.
    this.bodies.follow(
      this.camera.position.x,
      this.camera.position.y,
      this.camera.position.z,
      this.camera.far,
    );

    // Schattenkamera dem Spieler nachführen, sonst fällt er aus ihr heraus.
    // Die Richtung kommt vom Tageszyklus: dadurch wandern die Schatten über
    // den Tag mit, statt immer aus derselben Ecke zu fallen.
    if (this.quality.shadows) {
      this.sun.target.position.set(targetX, targetY, targetZ);
      this.sun.position.set(
        targetX + this.sunDirection.x * 70,
        targetY + Math.max(20, this.sunDirection.y * 70),
        targetZ + this.sunDirection.z * 70,
      );
      this.sun.target.updateMatrixWorld();
    }
  }

  /** Setzt die Kamera hart auf eine Position — beim Kartenwechsel. */
  snapTo(x: number, y: number, z: number): void {
    this.followed.set(x, y + 1.4, z);
  }

  resize(): void {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    // Das Ziel des Umrisses hat dieselbe Grösse wie das Bild. Bliebe es
    // stehen, läge jeder Strich nach dem Drehen des Telefons um den Unterschied
    // daneben — und zwar weiter aussen, je grösser der Unterschied.
    this.passeUmrissGroesseAn();
  }

  /**
   * Eigene Zeichenabschnitte, die nach der Szene laufen.
   *
   * Der Weg, auf dem three.js Stück für Stück verschwindet: ein Modul, das
   * umgezogen ist, hängt sich hier ein und zeichnet mit unserem eigenen
   * Renderer in **denselben** Kontext. Zwei Leinwände übereinander wären die
   * Alternative gewesen — und mit ihnen zwei Tiefenpuffer, also keine
   * Verdeckung zwischen altem und neuem Bild.
   */
  private readonly paesse: Array<(gfx: Gfx, sicht: Mat4, projektion: Mat4) => void> = [];

  fuegePassHinzu(pass: (gfx: Gfx, sicht: Mat4, projektion: Mat4) => void): void {
    this.paesse.push(pass);
  }

  render(): void {
    /*
     * Die Maske **vor** dem Bild, die Striche **danach**.
     *
     * Vorher, weil der erste Durchgang in ein eigenes Ziel geht und das Bild
     * dabei nicht anfassen darf. Danach, weil der zweite Durchgang gegen den
     * Tiefenpuffer des fertigen Bildes läuft — daher kommt die Verdeckung.
     */
    const umriss = this.umriss;
    const wesen = this.umrissQuelle;
    if (umriss && wesen) umriss.zeichneMaske(this.renderer, wesen, this.camera);
    this.renderer.render(this.scene, this.camera);
    if (umriss && wesen) umriss.zeichneLinien(this.renderer);

    if (this.paesse.length === 0) return;

    // Der Zustandsspeicher beider Seiten weiss nichts vom jeweils anderen:
    // vorher vergisst unserer alles, hinterher vergisst three.js alles. Ohne
    // das erbt der nächste Zeichenaufruf stillschweigend fremde Einstellungen
    // — Mischung, Tiefe, Kulling —, und der Fehler zeigt sich als ein Bild,
    // das nur bei bestimmter Reihenfolge kaputt ist.
    this.gfx.beginnePass();
    const sicht = this.camera.matrixWorldInverse.elements as unknown as Mat4;
    const projektion = this.camera.projectionMatrix.elements as unknown as Mat4;
    for (const pass of this.paesse) pass(this.gfx, sicht, projektion);
    this.renderer.resetState();
  }

  dispose(): void {
    this.bodies.dispose();
    this.umriss?.dispose();

    this.skyGeometry.dispose();
    this.skyMaterial.dispose();
    this.renderer.dispose();
  }
}
