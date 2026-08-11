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
const ZOOM_MIN = 3.5;
const ZOOM_MAX = 22;
const PITCH_MIN = -0.25;
const PITCH_MAX = 1.35;

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

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, quality.viewDistance * 2.2);

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
    this.distance = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.distance + delta));
  }

  /** Ist die Kamera so nah, dass die eigene Figur ausgeblendet werden sollte? */
  get isFirstPerson(): boolean {
    return this.distance <= ZOOM_MIN + 0.2;
  }

  /**
   * Setzt die Kamera hinter das Ziel. `world` dient dazu, sie über dem Boden
   * zu halten — ohne das taucht sie an Hängen in die Erde.
   */
  follow(targetX: number, targetY: number, targetZ: number, world: CoreWorld | undefined, dt: number): void {
    this.followed.lerp(
      this.desired.set(targetX, targetY + 1.4, targetZ),
      // Weiches Nachziehen, aber bildratenunabhängig.
      1 - Math.pow(0.0015, dt),
    );

    const cosP = Math.cos(this.pitch);
    const camX = this.followed.x - Math.sin(this.yaw) * cosP * this.distance;
    const camZ = this.followed.z - Math.cos(this.yaw) * cosP * this.distance;
    let camY = this.followed.y + Math.sin(this.pitch) * this.distance;

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
