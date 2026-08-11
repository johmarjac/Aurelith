/**
 * Bodenmaterial mit Splatting.
 *
 * Der Boden ist keine einzelne Textur, sondern bis zu vier Ebenen, die nach
 * Neigung und Höhe gemischt werden. Die Gewichte dafür rechnet **die CPU beim
 * Bau des Netzes** aus und legt sie als `splat`-Attribut je Vertex ab — nicht
 * der Shader. Zwei Gründe:
 *
 *   * Neigung und Höhe stehen beim Netzbau ohnehin schon da; sie im Shader
 *     erneut aus Ableitungen zu schätzen wäre teurer und ungenauer.
 *   * Der Fragment-Shader macht dann nur noch eine Linearkombination — vier
 *     Texturabfragen für Farbe, vier für Normalen, fertig.
 *
 * Wo keine Ebene greift, bleibt die prozedurale Vertexfarbe stehen. Eine Karte
 * ohne Ebenen sieht deshalb aus wie vorher, und Ebenen ohne gelieferte Textur
 * tragen ihre Tönung als Farbfläche bei. Das ist der Grund, warum sich das
 * System mit einer einzigen Textur einführen und danach ergänzen lässt.
 *
 * Umgesetzt als Erweiterung von `MeshStandardMaterial` statt als eigenes
 * `ShaderMaterial`: so bleiben Nebel, Schatten und die Lichter des Blueprints
 * ohne Nachbau erhalten.
 */

import * as THREE from 'three';
import { MAX_GROUND_LAYERS, type GroundLayerDef } from '@aurelith/shared';

/** 1×1 weiß. Belegt ungenutzte Sampler, damit keine Warnung entsteht. */
function createStubTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

const VERTEX_COMMON = /* glsl */ `
  attribute vec4 splat;
  varying vec4 vSplat;
  varying vec2 vGround;
`;

const FRAGMENT_COMMON = /* glsl */ `
  uniform sampler2D uAlbedo0;
  uniform sampler2D uAlbedo1;
  uniform sampler2D uAlbedo2;
  uniform sampler2D uAlbedo3;
  uniform sampler2D uNormal0;
  uniform sampler2D uNormal1;
  uniform sampler2D uNormal2;
  uniform sampler2D uNormal3;

  uniform vec4 uTileScale;
  uniform vec4 uHasAlbedo;
  uniform vec4 uHasNormal;
  uniform vec4 uLayerRoughness;
  uniform vec4 uNormalScale;
  uniform vec3 uTint0;
  uniform vec3 uTint1;
  uniform vec3 uTint2;
  uniform vec3 uTint3;

  varying vec4 vSplat;
  varying vec2 vGround;

  /**
   * Gewichte normalisieren. Die Summe ist zugleich die Deckung: wie viel des
   * Pixels von Ebenen bedeckt wird. Der Rest bleibt Vertexfarbe.
   */
  vec4 aurelithSplatWeights(out float cover) {
    vec4 w = max(vSplat, vec4(0.0));
    float total = w.x + w.y + w.z + w.w;
    if (total > 1.0) {
      w /= total;
      total = 1.0;
    }
    cover = total;
    return w;
  }
`;

const MAP_FRAGMENT = /* glsl */ `
  float aurCover;
  vec4 aurW = aurelithSplatWeights(aurCover);

  vec3 aurAlbedo = vec3(0.0);
  aurAlbedo += mix(uTint0, texture2D(uAlbedo0, vGround * uTileScale.x).rgb * uTint0, uHasAlbedo.x) * aurW.x;
  aurAlbedo += mix(uTint1, texture2D(uAlbedo1, vGround * uTileScale.y).rgb * uTint1, uHasAlbedo.y) * aurW.y;
  aurAlbedo += mix(uTint2, texture2D(uAlbedo2, vGround * uTileScale.z).rgb * uTint2, uHasAlbedo.z) * aurW.z;
  aurAlbedo += mix(uTint3, texture2D(uAlbedo3, vGround * uTileScale.w).rgb * uTint3, uHasAlbedo.w) * aurW.w;

  // Unter der Deckung liegt weiter die prozedurale Farbe des Geländes. Ohne
  // gelieferte Textur bleibt sie also stehen, statt durch Grau ersetzt zu werden.
  //
  // Das Swizzle .rgb ist kein Zierrat: Three.js deklariert vColor je nach
  // Fassung als vec3 oder vec4, und .rgb passt auf beides. Ohne es scheitert
  // die Uebersetzung mit "no matching overloaded function" fuer mix.
  diffuseColor.rgb *= mix(vColor.rgb, aurAlbedo / max(aurCover, 1e-4), aurCover);
`;

const ROUGHNESS_FRAGMENT = /* glsl */ `
  float roughnessFactor = mix(
    roughness,
    dot(uLayerRoughness, aurW) / max(aurCover, 1e-4),
    aurCover
  );
`;

const NORMAL_FRAGMENT = /* glsl */ `
  {
    vec3 aurTs = vec3(0.0);
    float aurNw = 0.0;

    aurTs += ((texture2D(uNormal0, vGround * uTileScale.x).xyz * 2.0 - 1.0)
      * vec3(uNormalScale.x, uNormalScale.x, 1.0)) * aurW.x * uHasNormal.x;
    aurNw += aurW.x * uHasNormal.x;
    aurTs += ((texture2D(uNormal1, vGround * uTileScale.y).xyz * 2.0 - 1.0)
      * vec3(uNormalScale.y, uNormalScale.y, 1.0)) * aurW.y * uHasNormal.y;
    aurNw += aurW.y * uHasNormal.y;
    aurTs += ((texture2D(uNormal2, vGround * uTileScale.z).xyz * 2.0 - 1.0)
      * vec3(uNormalScale.z, uNormalScale.z, 1.0)) * aurW.z * uHasNormal.z;
    aurNw += aurW.z * uHasNormal.z;
    aurTs += ((texture2D(uNormal3, vGround * uTileScale.w).xyz * 2.0 - 1.0)
      * vec3(uNormalScale.w, uNormalScale.w, 1.0)) * aurW.w * uHasNormal.w;
    aurNw += aurW.w * uHasNormal.w;

    if (aurNw > 0.001) {
      vec3 aurLocal = normalize(mix(vec3(0.0, 0.0, 1.0), aurTs / aurNw, min(aurNw, 1.0)));

      // Tangentenrahmen fuer eine planare XZ-Projektion.
      //
      // Die UV ist schlicht die Weltposition in X und Z, also zeigt die
      // Tangente entlang Welt-X und die Bitangente entlang Welt-Z — dafuer
      // braucht es keine Ableitungen. Nur muss der Rahmen im Ansichtsraum
      // stehen, denn dort liegt \`normal\`.
      vec3 aurWorldX = normalize((viewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
      vec3 aurN = normal;
      vec3 aurT = normalize(aurWorldX - aurN * dot(aurN, aurWorldX));
      vec3 aurB = cross(aurT, aurN);

      normal = normalize(aurT * aurLocal.x + aurB * aurLocal.y + aurN * aurLocal.z);
    }
  }
`;

export interface TerrainMaterialOptions {
  /** Auf schwachen Geräten bleiben Normalenkarten aus. */
  useNormalMaps: boolean;
}

export class TerrainMaterial {
  readonly material: THREE.MeshStandardMaterial;

  private readonly stub = createStubTexture();
  private readonly loaded: THREE.Texture[] = [];
  private readonly uniforms: Record<string, THREE.IUniform> = {};

  constructor(
    private readonly layers: readonly GroundLayerDef[],
    private readonly options: TerrainMaterialOptions,
  ) {
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      // Boden glänzt nicht. Der Wert wird je Ebene überschrieben, sobald eine
      // greift; er gilt nur dort, wo keine Ebene deckt.
      roughness: 0.95,
      metalness: 0,
    });

    const tile = new THREE.Vector4(0.1, 0.1, 0.1, 0.1);
    const hasAlbedo = new THREE.Vector4(0, 0, 0, 0);
    const hasNormal = new THREE.Vector4(0, 0, 0, 0);
    const roughnessVec = new THREE.Vector4(0.9, 0.9, 0.9, 0.9);
    const normalScale = new THREE.Vector4(1, 1, 1, 1);
    const tints = [0, 1, 2, 3].map(() => new THREE.Color(0xffffff));

    for (let i = 0; i < MAX_GROUND_LAYERS; i++) {
      const layer = layers[i];
      const component = (['x', 'y', 'z', 'w'] as const)[i]!;
      if (layer) {
        tile[component] = 1 / Math.max(0.01, layer.tileSize);
        roughnessVec[component] = layer.roughness;
        normalScale[component] = layer.normalScale;
        tints[i]!.setHex(layer.tint);
      }
      this.uniforms[`uAlbedo${i}`] = { value: this.stub };
      this.uniforms[`uNormal${i}`] = { value: this.stub };
      this.uniforms[`uTint${i}`] = { value: tints[i] };
    }

    this.uniforms.uTileScale = { value: tile };
    this.uniforms.uHasAlbedo = { value: hasAlbedo };
    this.uniforms.uHasNormal = { value: hasNormal };
    this.uniforms.uLayerRoughness = { value: roughnessVec };
    this.uniforms.uNormalScale = { value: normalScale };

    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERTEX_COMMON}`)
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>\n  vSplat = splat;\n  vGround = position.xz;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAGMENT_COMMON}`)
        .replace('#include <map_fragment>', MAP_FRAGMENT)
        // Die Vertexfarbe ist oben schon eingerechnet; ein zweites Mal
        // multipliziert wuerde sie den Boden verdoppelt abdunkeln.
        .replace('#include <color_fragment>', '')
        .replace('#include <roughnessmap_fragment>', ROUGHNESS_FRAGMENT)
        .replace('#include <normal_fragment_maps>', NORMAL_FRAGMENT);
    };

    // Erzwingt eine Neuübersetzung, falls das Material schon einmal benutzt wurde.
    this.material.customProgramCacheKey = () => 'aurelith-terrain-splat';
  }

  /** Trägt eine geladene Farbtextur nach. Bis dahin gilt die Tönung der Ebene. */
  setAlbedo(index: number, texture: THREE.Texture): void {
    if (index < 0 || index >= MAX_GROUND_LAYERS) return;
    this.uniforms[`uAlbedo${index}`]!.value = texture;
    (this.uniforms.uHasAlbedo!.value as THREE.Vector4).setComponent(index, 1);
    this.loaded.push(texture);
  }

  setNormal(index: number, texture: THREE.Texture): void {
    if (!this.options.useNormalMaps) return;
    if (index < 0 || index >= MAX_GROUND_LAYERS) return;
    this.uniforms[`uNormal${index}`]!.value = texture;
    (this.uniforms.uHasNormal!.value as THREE.Vector4).setComponent(index, 1);
    this.loaded.push(texture);
  }

  get layerCount(): number {
    return Math.min(this.layers.length, MAX_GROUND_LAYERS);
  }

  dispose(): void {
    for (const tex of this.loaded) tex.dispose();
    this.loaded.length = 0;
    this.stub.dispose();
    this.material.dispose();
  }
}
