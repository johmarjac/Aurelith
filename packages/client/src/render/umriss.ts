/**
 * Der schwarze Umriss um Figuren und Wesen — als Kantensuche im Bild.
 *
 * **Warum nicht mehr die umgestülpte Hülle.** Die erste Fassung hängte an jedes
 * Netz ein zweites, schob es entlang seiner Normalen nach aussen und zeichnete
 * es von innen. Das ist der Trick, den man zuerst findet, und er hat vier
 * Fehler, die man erst im Spiel sieht:
 *
 *   1. **Keine Linien im Inneren.** Ein Arm vor dem Bauch, ein Kopf vor der
 *      Schulter — die Hülle kennt nur die Silhouette, und ohne die inneren
 *      Kanten sieht eine Figur aus wie ein ausgeschnittener Schatten.
 *   2. **Die Dicke schwankt.** Der Versatz läuft entlang der Normalen; an einer
 *      Kante, wo die gemittelte Normale schräg steht, wird der Strich dünner
 *      als in der Fläche. An scharfen Ecken klafft er auf.
 *   3. **Der Preis hängt an der Geometrie.** Jedes Wesen bezahlt einen zweiten
 *      vollen Zeichenaufruf mit derselben Zahl Dreiecke.
 *   4. **Geschweisste Normalen mussten sein.** Ein Rig besteht aus Kästen, und
 *      damit die Hülle nicht aufplatzt, musste vorher jede Geometrie
 *      zusammengelegt und neu benormalt werden — Rechenarbeit beim Erscheinen
 *      jeder Figur, und ein zweiter Satz Puffer auf der Grafikkarte.
 *
 * **Was stattdessen passiert.** Zwei Durchgänge, beide klein:
 *
 *   1. Die Wesen — und nur sie — werden mit einem Normalenmaterial in ein
 *      eigenes Ziel gezeichnet. Darin steht in RGB die Normale im Blickraum,
 *      im Alphakanal eine Eins („hier ist ein Wesen") und im Tiefenpuffer die
 *      Tiefe. Der Rest der Welt kommt nicht vor.
 *   2. Ein bildfüllendes Viereck sucht darin Sprünge — mit dem Kreuz nach
 *      Roberts, also über die beiden Diagonalen eines 2×2-Feldes. Ein Sprung
 *      im Alphakanal ist die Silhouette, einer in der Tiefe eine Überlappung,
 *      einer in der Normale ein Knick. Wo einer davon liegt, kommt ein
 *      schwarzer Punkt.
 *
 * Damit ist die Dicke **in Bildpunkten** angegeben und überall gleich — das ist
 * der eigentliche Gewinn —, und die Kanten im Inneren gibt es geschenkt.
 *
 * **Die Verdeckung macht der Tiefentest.** Das Viereck schreibt in
 * `gl_FragDepth` die Tiefe des Wesens, zu dem der Strich gehört, und läuft
 * gegen den Tiefenpuffer des fertigen Bildes. Steht ein Baum davor, ist dessen
 * Tiefe kleiner, und der Strich fällt weg. Ohne das läge der Umriss einer Figur
 * hinter einem Baum quer über dem Baum — der Fehler, den jede
 * Nachbearbeitung ohne Tiefe hat.
 */

import * as THREE from 'three';

/**
 * Halbe Strichbreite in Bildpunkten (bei einfacher Punktdichte).
 *
 * Die vier Proben liegen auf den Ecken eines Quadrats mit dieser halben
 * Kantenlänge; der Strich wird also ungefähr doppelt so breit. Eins ergibt
 * einen Strich von rund zwei Punkten — kräftig genug, um als gezeichnete Linie
 * gelesen zu werden, und schmal genug, dass ein Gesicht auf zwanzig Metern
 * nicht zuläuft.
 *
 * In Bildpunkten und nicht in Metern: eine Linie, die mit der Entfernung
 * dünner wird, ist keine Linie mehr, sondern ein Schatten. Genau das war der
 * Grund, überhaupt im Bildraum zu rechnen.
 */
const BREITE = 1.0;

/**
 * Ab welchem **relativen** Tiefensprung eine Kante gilt.
 *
 * Relativ und nicht in Metern: derselbe Absatz von zehn Zentimetern ist aus
 * zwei Metern ein deutlicher Sprung und aus fünfzig Metern nichts. Ein fester
 * Abstand hätte in der Nähe alles und in der Ferne nichts gefunden.
 */
const SCHWELLE_TIEFE = 0.012;

/**
 * Ab welchem Knick in der Normale eine Kante gilt.
 *
 * Gemessen als `1 - cos(Winkel)`: 0,25 sind etwa 41 Grad. Darunter liegen die
 * Rundungen einer Kugel, darüber die Kanten eines Kastens — und genau die
 * sollen einen Strich bekommen.
 */
const SCHWELLE_NORMALE = 0.25;

const VERTEX = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    // Ohne Matrizen: das Viereck ist schon in Bildkoordinaten von -1 bis 1.
    // Eine Kamera dafür wäre eine Matrix, die nichts tut, und eine Zahl mehr,
    // die jemand pflegen muss.
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform sampler2D tMaske;
  uniform highp sampler2D tTiefe;
  uniform vec2 aufloesung;
  uniform float breite;
  uniform float nah;
  uniform float fern;
  uniform vec3 farbe;

  in vec2 vUv;

  /*
   * Der Ausgang wird selbst erklärt.
   *
   * In GLSL 3 gibt es "gl_FragColor" nicht mehr, und three.js ergänzt den
   * Ersatz nur für GLSL 1. Wer ihn hier trotzdem schreibt, bekommt vom Treiber
   * "undeclared identifier" — und zwar erst beim ersten Bild, nicht beim
   * Übersetzen.
   */
  layout(location = 0) out vec4 pixelFarbe;

  /*
   * Von der Fenstertiefe zur Entfernung in Metern.
   *
   * Der Puffer speichert die Tiefe nichtlinear — dicht vor der Kamera fein,
   * weit hinten grob. Ein Vergleich zweier roher Werte fände deshalb dicht vor
   * der Nase überall Kanten und in der Ferne keine. Gerechnet wird auf dem
   * Abstand zur Kamera, und der ist eine Länge wie jede andere.
   */
  float blickTiefe(float d) {
    float ndc = d * 2.0 - 1.0;
    return (2.0 * nah * fern) / (fern + nah - ndc * (fern - nah));
  }

  void main() {
    vec2 t = breite / aufloesung;
    // Die vier Ecken eines Quadrats. Das Kreuz nach Roberts vergleicht über die
    // Diagonalen: zwei Differenzen statt der acht eines Sobel, und für einen
    // Strich von zwei Punkten reicht das genau.
    vec2 uv0 = vUv + vec2(-t.x, -t.y);
    vec2 uv1 = vUv + vec2(t.x, t.y);
    vec2 uv2 = vUv + vec2(t.x, -t.y);
    vec2 uv3 = vUv + vec2(-t.x, t.y);

    vec4 m0 = texture(tMaske, uv0);
    vec4 m1 = texture(tMaske, uv1);
    vec4 m2 = texture(tMaske, uv2);
    vec4 m3 = texture(tMaske, uv3);

    // Kein Wesen in der Nähe — der weitaus häufigste Fall, und er ist hier zu
    // Ende. Der Himmel kostet damit vier Texturzugriffe und sonst nichts.
    float da = max(max(m0.a, m1.a), max(m2.a, m3.a));
    if (da < 0.01) discard;

    // Die Silhouette: an der Kante steht auf der einen Seite ein Wesen und auf
    // der anderen nicht.
    float silhouette = abs(m0.a - m1.a) + abs(m2.a - m3.a);

    /*
     * Tiefe und Normale zählen nur, wo **beide** Proben eines Paares auf einem
     * Wesen liegen.
     *
     * Sonst spränge die Tiefe am Rand jeder Figur um die halbe Karte — der
     * Hintergrund liegt im Ziel auf der Fernebene —, und die Silhouette wäre
     * doppelt gezählt, mit einem Strich, der nach aussen ausfranst.
     */
    float paar01 = m0.a * m1.a;
    float paar23 = m2.a * m3.a;

    float d0 = texture(tTiefe, uv0).x;
    float d1 = texture(tTiefe, uv1).x;
    float d2 = texture(tTiefe, uv2).x;
    float d3 = texture(tTiefe, uv3).x;

    float z0 = blickTiefe(d0);
    float z1 = blickTiefe(d1);
    float z2 = blickTiefe(d2);
    float z3 = blickTiefe(d3);
    float naeher = max(min(min(z0, z1), min(z2, z3)), 0.001);
    float tiefeKante = (abs(z0 - z1) * paar01 + abs(z2 - z3) * paar23) / naeher;

    vec3 n0 = m0.rgb * 2.0 - 1.0;
    vec3 n1 = m1.rgb * 2.0 - 1.0;
    vec3 n2 = m2.rgb * 2.0 - 1.0;
    vec3 n3 = m3.rgb * 2.0 - 1.0;
    float normalKante = (1.0 - dot(n0, n1)) * paar01 + (1.0 - dot(n2, n3)) * paar23;

    // "smoothstep" und nicht "step": eine harte Schwelle lässt die inneren
    // Linien an ihren Enden abreissen, und das sieht nach einem Fehler aus.
    // (Anführungszeichen und keine Rückwärtsstriche: das hier steht in einem
    // Template-Literal, und ein Rückwärtsstrich beendet es mitten im Shader.
    // Der Übersetzer meldet dann einen Fehler in TypeScript, dreissig Zeilen
    // weiter unten — zweimal darauf hereingefallen.)
    float kante = max(
      silhouette,
      max(
        smoothstep(${SCHWELLE_TIEFE.toFixed(4)}, ${(SCHWELLE_TIEFE * 2.0).toFixed(4)}, tiefeKante),
        smoothstep(${SCHWELLE_NORMALE.toFixed(4)}, ${(SCHWELLE_NORMALE * 1.6).toFixed(4)}, normalKante)
      )
    );
    if (kante < 0.02) discard;

    /*
     * Die Tiefe des Strichs ist die **vorderste** beteiligte Wesensprobe.
     *
     * Auch für die Punkte neben der Figur: dort liegt das Wesen im Nachbarn,
     * und der Strich gehört zu ihm. Mit der Tiefe des Hintergrunds läge er
     * hinter allem, was zwischen Figur und Kamera steht — und dann sähe man ihn
     * gerade dort nicht, wo er die Figur vom Vordergrund trennen soll.
     */
    float roh = 1.0;
    if (m0.a > 0.5) roh = min(roh, d0);
    if (m1.a > 0.5) roh = min(roh, d1);
    if (m2.a > 0.5) roh = min(roh, d2);
    if (m3.a > 0.5) roh = min(roh, d3);
    if (roh >= 1.0) discard;

    gl_FragDepth = roh;
    pixelFarbe = vec4(farbe, min(1.0, kante));
  }
`;

export class Umriss {
  /** Normale und Wesensmarke in Farbe, dazu ein echter Tiefenpuffer. */
  private readonly ziel: THREE.WebGLRenderTarget;
  private readonly tiefe: THREE.DepthTexture;

  /**
   * Das Material für den ersten Durchgang.
   *
   * `MeshNormalMaterial` schreibt genau das, was gebraucht wird: die Normale
   * im Blickraum nach RGB und eine Eins ins Alpha. Ein eigener Shader dafür
   * wäre dieselbe Zeile noch einmal — und eine, die bei Instanzen und
   * Skalierungen anders falsch sein könnte als die von three.js.
   */
  private readonly maskeMaterial = new THREE.MeshNormalMaterial();

  private readonly material: THREE.ShaderMaterial;
  private readonly viereck: THREE.Mesh;
  private readonly viereckSzene = new THREE.Scene();
  private readonly viereckKamera = new THREE.Camera();

  constructor() {
    // Ein Punkt reicht zum Anlegen; die richtige Grösse setzt `setzeGroesse`
    // beim ersten Bild. Ein Ziel in Fenstergrösse anzulegen hiesse, die Grösse
    // an zwei Stellen zu kennen.
    this.tiefe = new THREE.DepthTexture(1, 1);
    this.tiefe.type = THREE.UnsignedIntType;
    // Tiefe wird punktgenau gelesen: eine gemittelte Tiefe zwischen Figur und
    // Hintergrund ist keine Tiefe, sondern ein Ort, an dem nichts liegt.
    this.tiefe.minFilter = THREE.NearestFilter;
    this.tiefe.magFilter = THREE.NearestFilter;

    this.ziel = new THREE.WebGLRenderTarget(1, 1, {
      depthTexture: this.tiefe,
      depthBuffer: true,
      // Die Farbe dagegen geglättet: dadurch verläuft die Wesensmarke am Rand
      // weich, und der Strich bekommt seine Kantenglättung umsonst. Das
      // fertige Bild ist geglättet, ein harter Strich darüber wäre der einzige
      // Treppenrand im Bild.
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });

    this.material = new THREE.ShaderMaterial({
      // GLSL 3: `gl_FragDepth` gibt es erst dort, und ohne das keine
      // Verdeckung. Der Client setzt WebGL 2 ohnehin voraus.
      glslVersion: THREE.GLSL3,
      uniforms: {
        tMaske: { value: this.ziel.texture },
        tTiefe: { value: this.tiefe },
        aufloesung: { value: new THREE.Vector2(1, 1) },
        breite: { value: BREITE },
        nah: { value: 0.05 },
        fern: { value: 1000 },
        farbe: { value: new THREE.Color(0x0b0b0f) },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      // Prüfen ja, schreiben nein: der Strich verdeckt nichts, was danach noch
      // käme, und ein Eintrag im Tiefenpuffer wäre eine Wand aus Linien.
      depthTest: true,
      depthWrite: false,
      // Kleiner-gleich, nicht kleiner: der Strich liegt auf der Figur, zu der
      // er gehört, und die steht im Tiefenpuffer schon mit genau diesem Wert.
      depthFunc: THREE.LessEqualDepth,
    });

    this.viereck = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    // Ohne Matrizen gibt es auch keine sinnvolle Hülle, nach der man kullen
    // könnte — three.js würde das Viereck sonst je nach Kamera wegwerfen.
    this.viereck.frustumCulled = false;
    this.viereckSzene.add(this.viereck);
  }

  /** Nach jeder Grössenänderung des Bildes — sonst passen Ziel und Bild nicht. */
  setzeGroesse(breite: number, hoehe: number, punktdichte: number): void {
    const w = Math.max(1, Math.floor(breite * punktdichte));
    const h = Math.max(1, Math.floor(hoehe * punktdichte));
    this.ziel.setSize(w, h);
    (this.material.uniforms.aufloesung!.value as THREE.Vector2).set(w, h);
    // Die Breite in Gerätepunkten, damit der Strich auf einem Telefon mit
    // dreifacher Punktdichte genauso dick aussieht wie auf einem Monitor.
    this.material.uniforms.breite!.value = BREITE * punktdichte;
  }

  /**
   * Erster Durchgang: die Wesen in das eigene Ziel.
   *
   * `wesen` ist **nur** der Ast mit den Figuren. Käme die ganze Welt hier
   * vorbei, bekäme jeder Grashalm einen Strich — was ein anderer Stil wäre,
   * aber nicht der, um den es hier geht.
   */
  zeichneMaske(
    renderer: THREE.WebGLRenderer,
    wesen: THREE.Scene,
    kamera: THREE.PerspectiveCamera,
  ): void {
    this.material.uniforms.nah!.value = kamera.near;
    this.material.uniforms.fern!.value = kamera.far;

    const vorherZiel = renderer.getRenderTarget();
    const vorherFarbe = new THREE.Color();
    const vorherAlpha = renderer.getClearAlpha();
    renderer.getClearColor(vorherFarbe);

    /*
     * Was kein Umriss werden soll, ist für diesen einen Durchgang unsichtbar.
     *
     * Betroffen ist der Schein um Waffe und Rüstungssatz: durchsichtige
     * Scheiben, die das Normalenmaterial in undurchsichtige verwandelt — ein
     * schwarzer Ring um jeden Schein wäre das Ergebnis.
     *
     * Ein Merkmal am Objekt und keine Zeichenebene: eine Ebene versteckte den
     * Schein auch vor der Kamera der Inventarpuppe. Und hier statt an den
     * Anhängestellen, weil es dann **eine** Regel ist statt einer Liste von
     * Stellen, in die man ein neues Leuchten einzutragen vergisst.
     */
    const versteckt: THREE.Object3D[] = [];
    wesen.traverse((o) => {
      if (o.visible && o.userData.keinUmriss === true) {
        o.visible = false;
        versteckt.push(o);
      }
    });

    renderer.setRenderTarget(this.ziel);
    // Alpha null: das ist die Aussage „hier ist kein Wesen", und sie steht im
    // selben Kanal wie die Eins, die das Material schreibt.
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    wesen.overrideMaterial = this.maskeMaterial;
    renderer.render(wesen, kamera);
    wesen.overrideMaterial = null;

    for (const o of versteckt) o.visible = true;

    renderer.setRenderTarget(vorherZiel);
    renderer.setClearColor(vorherFarbe, vorherAlpha);
  }

  /**
   * Zweiter Durchgang: die Striche über das fertige Bild.
   *
   * Muss **nach** `renderer.render(szene, kamera)` laufen und ohne Löschen —
   * der Tiefenpuffer des Bildes ist die halbe Miete, siehe oben.
   */
  zeichneLinien(renderer: THREE.WebGLRenderer): void {
    const vorher = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.viereckSzene, this.viereckKamera);
    renderer.autoClear = vorher;
  }

  dispose(): void {
    this.ziel.dispose();
    this.tiefe.dispose();
    this.maskeMaterial.dispose();
    this.material.dispose();
    this.viereck.geometry.dispose();
  }
}
