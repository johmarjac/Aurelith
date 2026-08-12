/**
 * Renderer, Kamera, Licht, Himmel.
 *
 * WebGL 2 ist Vorgabe aus dem Blueprint — nicht WebGL 1 mit sechzehn
 * Erweiterungen wie bei Flyff. Three.js läuft darauf ohnehin; die Prüfung hier
 * stellt nur sicher, dass wir es merken, wenn ein Gerät es nicht kann.
 */

import * as THREE from 'three';
import type { CoreWorld } from '@aurelith/core';
import type { EnvironmentDef } from '@aurelith/shared';
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

export class Scene3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private readonly sun = new THREE.DirectionalLight(0xffffff, 1.5);
  private readonly ambient = new THREE.HemisphereLight(0xffffff, 0x444444, 0.9);
  private readonly skyMesh: THREE.Mesh;
  private readonly skyGeometry: THREE.SphereGeometry;
  private readonly skyMaterial: THREE.MeshBasicMaterial;

  /** Kamerastand. Yaw ist zugleich die Blickrichtung der Figur. */
  yaw = 0;
  pitch = 0.55;
  distance = 9;

  private readonly followed = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();

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

    const gl = this.renderer.getContext();
    const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    if (!isWebGL2) {
      console.warn('[render] Kein WebGL 2 — die Darstellung kann abweichen.');
    }

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxPixelRatio));
    this.renderer.shadowMap.enabled = quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

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

    this.resize();
  }

  /** Übernimmt Himmel, Nebel und Licht aus dem Map-Dokument. */
  applyEnvironment(env: EnvironmentDef, viewDistance: number): void {
    const sky = new THREE.Color(env.skyColor);
    const horizon = new THREE.Color(env.horizonColor);

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

    this.scene.fog = new THREE.Fog(env.fogColor, env.fogNear, Math.min(env.fogFar, viewDistance));
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

    this.skyMesh.position.copy(this.camera.position);
    this.skyMesh.scale.setScalar(this.camera.far * 0.9);

    // Schattenkamera dem Spieler nachführen, sonst fällt er aus ihr heraus.
    if (this.quality.shadows) {
      this.sun.target.position.set(targetX, targetY, targetZ);
      this.sun.position.set(targetX + 40, targetY + 60, targetZ + 30);
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
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.skyGeometry.dispose();
    this.skyMaterial.dispose();
    this.renderer.dispose();
  }
}
