/**
 * Sonne, Mond und Wolken.
 *
 * Alles hängt an der Himmelskuppel und nicht in der Welt: es hat keinen Ort,
 * nur eine Richtung. Deshalb wandert die ganze Gruppe mit der Kamera mit —
 * wer nach Norden läuft, kommt der Sonne nicht näher.
 *
 * Drei Dinge, die dabei wichtig sind:
 *
 * **Tiefentest an, Tiefenschreiben aus.** Das sieht nach einem Detail aus und
 * ist der Grund, warum die Sonne zuerst über einem Hügel stand statt dahinter:
 * Three.js zeichnet **alle** transparenten Objekte nach den opaken, und
 * `renderOrder` sortiert nur innerhalb dieser Gruppe. Ein Himmelskörper ohne
 * Tiefentest übermalt deshalb die ganze Welt, egal wie klein seine Ordnung
 * ist. Mit Tiefentest verdeckt ihn der Berg, wie er soll — und weil er selbst
 * nicht in den Tiefenpuffer schreibt, verdeckt er die Wolken dahinter nicht.
 *
 * **Kein Nebel.** Der Nebel gehört der Welt. Läge er auch auf dem Himmel,
 * verschwände die Sonne im Dunst, obwohl sie unendlich weit weg ist.
 *
 * **Keine Textur.** Sonne, Mond und Wolken entstehen im Shader aus dem
 * Abstand zur Mitte. Das passt zum Rest — nichts hier lädt ein Bild, damit
 * das Spiel im ersten Bild spielbar ist.
 */

import * as THREE from 'three';

/** Wie weit draußen die Kuppel steht. Reine Konvention — nur Richtungen zählen. */
const DOME = 400;

/**
 * Eine weiche Scheibe: innen voll, nach außen auslaufend.
 *
 * `kern` sagt, bis wohin sie voll deckt, `rand`, wo sie ganz verschwunden
 * ist. Für die Sonne liegt beides eng beieinander — sie ist eine Scheibe mit
 * einem Hof. Der Mond ist härter umrissen.
 */
const SCHEIBE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SCHEIBE_FRAGMENT = /* glsl */ `
  uniform vec3 farbe;
  uniform float staerke;
  uniform float kern;
  uniform float rand;
  varying vec2 vUv;

  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float a = 1.0 - smoothstep(kern, rand, d);
    if (a <= 0.001) discard;
    gl_FragColor = vec4(farbe, a * staerke);
  }
`;

/**
 * Wolken: einzelne Ballen, keine Schleier.
 *
 * Hier lag eine Lage Rauschen mit einem Schwellwert darauf. Das ergibt Dunst
 * in Flecken — von unten sieht man ein gesprenkeltes Grau, und der Himmel hat
 * keine Form. Gemeint sind **Haufenwolken**: wenige, grosse, klar umrissene
 * Ballen mit hellem Kern und weichem Rand, zwischen denen viel Blau steht.
 *
 * Gebaut wie eine Zellenfunktion, nur mit Kegeln statt Abständen: auf einem
 * Raster sitzt je Masche eine gehashte Mitte mit gehashtem Radius, und das
 * Feld ist das Maximum über die neun umliegenden. Ein Maximum und keine Summe
 * — Summen verschmelzen zu einer Decke, sobald zwei Ballen sich berühren.
 *
 * Der Rand wird mit einem Rauschen verzogen, damit aus den Kreisen Wolken
 * werden. **Einmal** gerechnet und auf alle neun angewandt: neun Rauschabrufe
 * je Bildpunkt wären auf einem Telefon der halbe Himmel.
 */
const WOLKEN_VERTEX = /* glsl */ `
  varying vec3 vLocal;
  void main() {
    vLocal = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const WOLKEN_FRAGMENT = /* glsl */ `
  uniform vec3 farbe;
  uniform float zeit;
  uniform float deckung;
  varying vec3 vLocal;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  vec2 hash2(vec2 p) {
    return fract(vec2(
      sin(dot(p, vec2(127.1, 311.7))) * 43758.5453,
      sin(dot(p, vec2(269.5, 183.3))) * 43758.5453
    ));
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * noise(p);
      p *= 2.03;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    // Über den Kopf gelegt, damit die Maschen am Zenit nicht zusammenlaufen:
    // gerechnet wird in der Ebene, nicht auf der Kugel.
    /*
     * Der Nenner ist bei 0,38 gedeckelt und nicht bei 0,14.
     *
     * Die Ebene ueber dem Kopf waechst zum Horizont hin ins Unendliche: bei
     * einem Zehntel Hoehe ist eine Masche zehnmal so lang wie breit, und aus
     * runden Ballen werden waagerechte Schlieren. Mit dem frueheren Deckel
     * bleiben sie rund; darunter staucht sich das Muster, aber dort blendet
     * die Zeile weiter unten es ohnehin aus. Zu frueh gedeckelt — bei 0,38 —
     * lief dafuer alles Untere zu einer Masse zusammen.
     */
    vec2 p = vLocal.xz / max(vLocal.y, 0.26) * 0.62;
    p += vec2(zeit * 0.006, zeit * 0.004);

    // Der Verzug des Randes — einmal fuer alle Ballen.
    float wellig = fbm(p * 1.9) - 0.5;

    vec2 gitter = floor(p);
    float feld = 0.0;
    for (int dz = -1; dz <= 1; dz++) {
      for (int dx = -1; dx <= 1; dx++) {
        vec2 masche = gitter + vec2(float(dx), float(dz));
        // Die Mitte bleibt vom Maschenrand weg, sonst kleben zwei Ballen
        // benachbarter Maschen aneinander und ergeben eine Wurst.
        /*
         * Nicht jede Masche traegt eine Wolke.
         *
         * Mit einer je Masche stand der Himmel voller gleich grosser Ballen in
         * gleichem Abstand — ein Muster, und ein Muster sieht man sofort.
         * Ueber ein Drittel bleibt leer, und dazwischen steht Blau.
         */
        if (hash(masche + 3.71) < 0.42) continue;
        vec2 mitte = masche + 0.22 + 0.56 * hash2(masche);
        float radius = 0.20 + 0.30 * hash(masche + 7.13) + deckung * 0.12;
        float d = length(p - mitte) * (1.0 + wellig * 0.5) / radius;
        // Parabel statt Kegel: der Kern bleibt voll, und der Ballen wirkt
        // rund statt spitz.
        feld = max(feld, 1.0 - d * d);
      }
    }

    // Weicher Rand, harte Mitte: unter dem Schwellwert ist Himmel.
    float a = smoothstep(0.05, 0.46, feld);

    // Zum Horizont hin ausblenden. Ohne das enden die Wolken an einer Linie,
    // und die Kuppel bekommt einen sichtbaren Rand.
    a *= smoothstep(0.03, 0.34, vLocal.y);

    if (a <= 0.003) discard;

    /*
     * Der Kern ist heller als der Rand.
     *
     * Eine Wolke aus einer einzigen Farbe ist ein Fleck. Erst der Verlauf von
     * innen nach aussen macht daraus etwas mit Volumen — und weil das Feld
     * ohnehin die Dicke misst, kostet es nur eine Multiplikation.
     */
    vec3 c = farbe * mix(0.78, 1.16, smoothstep(0.05, 0.7, feld));
    gl_FragColor = vec4(c, a);
  }
`;

function scheibe(
  groesse: number,
  farbe: number,
  kern: number,
  rand: number,
  blending: THREE.Blending,
): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      farbe: { value: new THREE.Color(farbe) },
      staerke: { value: 1 },
      kern: { value: kern },
      rand: { value: rand },
    },
    vertexShader: SCHEIBE_VERTEX,
    fragmentShader: SCHEIBE_FRAGMENT,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(groesse, groesse), material);
  mesh.frustumCulled = false;
  return mesh;
}

export class SkyBodies {
  readonly root = new THREE.Group();

  private readonly sonne = scheibe(120, 0xfff3d0, 0.16, 1.0, THREE.AdditiveBlending);
  private readonly mond = scheibe(64, 0xdbe6ff, 0.62, 0.96, THREE.NormalBlending);
  private readonly wolken: THREE.Mesh;
  private readonly wolkenMaterial: THREE.ShaderMaterial;

  private zeit = 0;

  constructor() {
    // Vor der Welt, aber hinter nichts: die Kuppel selbst steht bei -1000.
    this.sonne.renderOrder = -900;
    this.mond.renderOrder = -900;
    this.root.add(this.sonne, this.mond);

    this.wolkenMaterial = new THREE.ShaderMaterial({
      uniforms: {
        farbe: { value: new THREE.Color(0xffffff) },
        zeit: { value: 0 },
        // Wie stark der Himmel bedeckt ist, von 0 (klar) bis 1 (zu). Fest:
        // Wetter je Karte wäre eine Einstellung im Kartenformat, und die
        // gibt es noch nicht. Eine Stellschraube, die niemand dreht, wäre
        // nur eine Zusage, die keiner einlöst.
        deckung: { value: 0.5 },
      },
      vertexShader: WOLKEN_VERTEX,
      fragmentShader: WOLKEN_FRAGMENT,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.BackSide,
      fog: false,
    });
    // Nur die obere Hälfte: unter dem Horizont gibt es nichts zu bewölken,
    // und die halbe Kugel spart die Hälfte der Dreiecke.
    this.wolken = new THREE.Mesh(
      new THREE.SphereGeometry(DOME * 0.92, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.5),
      this.wolkenMaterial,
    );
    this.wolken.renderOrder = -800;
    this.wolken.frustumCulled = false;
    this.root.add(this.wolken);
  }

  /**
   * Stellt Sonne und Mond an ihren Platz und färbt die Wolken.
   *
   * `sunDisc` ist der **echte** Sonnenstand: nachts steht er unter dem
   * Horizont, und genau dann steht der Mond ihm gegenüber am Himmel. Das ist
   * kein Zufall, sondern dieselbe Achse — deshalb reicht eine Richtung für
   * beide.
   */
  update(
    sunDisc: readonly [number, number, number],
    sunColor: number,
    horizonColor: number,
    darkness: number,
  ): void {
    const len = Math.hypot(sunDisc[0], sunDisc[1], sunDisc[2]) || 1;
    const sx = sunDisc[0] / len;
    const sy = sunDisc[1] / len;
    const sz = sunDisc[2] / len;

    this.setzeScheibe(this.sonne, sx, sy, sz);
    this.setzeScheibe(this.mond, -sx, -sy, -sz);

    // Ausblenden, sobald der Körper untergeht — und nicht schlagartig, sonst
    // blinkt die Sonne am Horizont weg.
    const sonneHoch = Math.max(0, Math.min(1, (sy + 0.06) / 0.18));
    const mondHoch = Math.max(0, Math.min(1, (-sy + 0.06) / 0.18));
    this.sonne.visible = sonneHoch > 0.001;
    this.mond.visible = mondHoch > 0.001;
    (this.sonne.material as THREE.ShaderMaterial).uniforms.staerke!.value = sonneHoch;
    (this.mond.material as THREE.ShaderMaterial).uniforms.staerke!.value = mondHoch * 0.95;

    // Die Sonnenscheibe nimmt die Farbe des Sonnenlichts an — damit wird sie
    // in der Dämmerung von selbst rot, ohne eine zweite Regel dafür.
    (this.sonne.material as THREE.ShaderMaterial).uniforms.farbe!.value.setHex(sunColor);

    // Wolken tragen die Farbe des Horizonts: sie sind das, was von ihm
    // beleuchtet wird. Nachts sind sie dunkler als er, sonst leuchten sie
    // heller als der Himmel dahinter.
    const wolkenfarbe = this.wolkenMaterial.uniforms.farbe!.value as THREE.Color;
    wolkenfarbe.setHex(horizonColor);
    const helligkeit = 1.25 - darkness * 0.75;
    wolkenfarbe.multiplyScalar(helligkeit);
  }

  /** Setzt eine Scheibe auf die Kuppel und dreht sie zur Mitte. */
  private setzeScheibe(mesh: THREE.Mesh, x: number, y: number, z: number): void {
    mesh.position.set(x * DOME, y * DOME, z * DOME);
    mesh.lookAt(0, 0, 0);
  }

  /** Lässt die Wolken ziehen. */
  step(dt: number): void {
    this.zeit += dt;
    this.wolkenMaterial.uniforms.zeit!.value = this.zeit;
  }

  /**
   * Die Kuppel folgt der Kamera — sie hat keinen Ort in der Welt.
   *
   * `far` skaliert sie mit. Ohne das steht sie fest bei `DOME`, und sobald
   * eine Qualitätsstufe die Sichtweite unter diesen Wert drückt, liegt die
   * Sonne hinter der Fernebene und wird weggeschnitten — sichtbar wäre ein
   * Himmel, an dem je nach Einstellung die Sonne fehlt.
   */
  follow(x: number, y: number, z: number, far: number): void {
    this.root.position.set(x, y, z);
    this.root.scale.setScalar((far * 0.85) / DOME);
  }

  dispose(): void {
    for (const m of [this.sonne, this.mond, this.wolken]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
