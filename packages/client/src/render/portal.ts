/**
 * Das Tor — ein Bannkreis auf dem Boden statt eines Torbogens.
 *
 * Hier stand ein Prop: ein steinerner Bogen, der bei jedem Portal aus dem
 * Boden wuchs. Das war zweimal falsch. Erstens sah jedes Tor gleich aus, egal
 * ob es in eine Gruft oder auf eine Wiese führt — ein Bogen ist Architektur
 * und die gehört der Karte, nicht dem Übergang. Zweitens war es ein Bauwerk,
 * und Bauwerke stehen herum: man lief davor, dahinter, hindurch, und nichts
 * daran sagte „hier geht es weiter".
 *
 * Ein Kreis am Boden sagt es. Er liegt dort, wo man hintreten muss, er ist so
 * gross wie der Auslöser, und er bewegt sich — Bewegung ist das, was ein Auge
 * in einer stehenden Landschaft findet.
 *
 * **Drei Lagen, jede mit einer Aufgabe:**
 *
 *   1. Der **Wirbel** — eine Scheibe mit einem Shader, der zwei gegenläufige
 *      Spiralen zeichnet. Er ist das, was sich dreht.
 *   2. Der **Runenring** — eine zweite Scheibe mit einer im Code gezeichneten
 *      Textur. Sie dreht sich langsam und gegen den Wirbel; das macht aus zwei
 *      Bewegungen eine erkennbare statt einer verwaschenen.
 *   3. Die **Lichtsäule** — ein offener Zylinder, der nach oben verblasst. Sie
 *      ist der Grund, warum man ein Tor auch dann sieht, wenn man von der
 *      Seite kommt und der Boden verdeckt ist.
 *
 * Alles additiv gemischt und ohne Tiefe zu schreiben: drei durchsichtige
 * Lagen übereinander würden sich sonst gegenseitig ausstanzen, und je nach
 * Blickwinkel fehlte eine davon.
 */

import * as THREE from 'three';

/**
 * Wie viele Runen im Kreis stehen.
 *
 * Sechzehn: genug, dass der Ring als Schrift durchgeht, wenig genug, dass
 * jedes Zeichen bei üblichem Abstand noch zu unterscheiden ist. Bei
 * vierundzwanzig wurde daraus ein Zaun.
 */
const RUNEN = 16;

/**
 * Die Zeichen, aus denen der Ring besteht — als Strichzüge im Einheitsquadrat.
 *
 * Von Hand gesetzt und nicht gewürfelt: gewürfelte Striche sehen aus wie
 * gewürfelte Striche. Diese hier sind an das Futhark angelehnt, also an eine
 * Schrift, die tatsächlich aus geraden Kerben besteht — genau deshalb liest
 * das Auge sie als Schrift und nicht als Kratzer.
 *
 * Jeder Eintrag ist eine Liste von Strecken, jede Strecke vier Zahlen:
 * `x0, y0, x1, y1`, jeweils von −1 bis 1.
 */
const ZEICHEN: ReadonlyArray<ReadonlyArray<readonly [number, number, number, number]>> = [
  [[0, -1, 0, 1], [0, 0.4, 0.7, 1], [0, 0.4, -0.7, 1]],
  [[-0.6, -1, -0.6, 1], [-0.6, 1, 0.6, 0.3], [0.6, 0.3, -0.6, -0.1]],
  [[-0.7, -1, 0, 1], [0, 1, 0.7, -1]],
  [[-0.6, -1, -0.6, 1], [-0.6, 1, 0.6, 0]],
  [[0, -1, 0, 1], [0, 1, 0.8, 0.3]],
  [[-0.7, -1, -0.7, 1], [0.7, -1, 0.7, 1], [-0.7, 0.2, 0.7, 0.8]],
  [[-0.8, 1, 0.8, -1], [-0.8, -1, 0.8, 1]],
  [[-0.7, -1, 0, 0], [0, 0, 0.7, -1], [0, 0, 0, 1]],
  [[-0.7, 1, 0.7, 1], [0, 1, 0, -1]],
  [[-0.7, -1, -0.7, 1], [-0.7, 1, 0.7, 1], [0.7, 1, 0.7, -1]],
  [[0, -1, -0.7, 0], [-0.7, 0, 0, 1], [0, 1, 0.7, 0], [0.7, 0, 0, -1]],
  [[-0.6, -1, -0.6, 1], [-0.6, 0.6, 0.6, 1], [-0.6, 0.6, 0.6, 0.2]],
];

/**
 * Die Runentextur — einmal gezeichnet, von allen Portalen geteilt.
 *
 * Auf einer Leinwand und nicht als Datei: alles andere in diesem Renderer
 * entsteht ebenso im Code, und eine Datei mehr wäre eine Datei mehr im
 * Manifest, im Streamer und im Zwischenspeicher — für sechzehn Striche.
 *
 * Geteilt, weil sie keinen Zustand hat: zehn Portale auf einer Karte sind
 * zehn Netze mit **einer** Textur. Freigegeben wird sie nie; sie lebt so lange
 * wie die Seite.
 */
let runenTextur: THREE.CanvasTexture | undefined;

function baueRunenTextur(): THREE.CanvasTexture {
  if (runenTextur) return runenTextur;

  const kante = 512;
  const leinwand = document.createElement('canvas');
  leinwand.width = kante;
  leinwand.height = kante;
  const stift = leinwand.getContext('2d');
  if (!stift) throw new Error('Portal: keine 2D-Leinwand');

  const mitte = kante / 2;
  /*
   * Wo der Ring liegt, in Anteilen des halben Bildes.
   *
   * 0,9 und nicht 1,0: die Textur wird über die **ganze** Scheibe gelegt, und
   * ein Zeichen am äussersten Rand würde vom Rand der Scheibe angeschnitten.
   */
  const bahn = mitte * 0.9;
  const hoehe = kante * 0.030;

  stift.clearRect(0, 0, kante, kante);
  stift.lineCap = 'round';
  stift.lineJoin = 'round';

  // Zwei dünne Kreise als Fassung. Ohne sie schweben die Zeichen im Nichts.
  stift.strokeStyle = 'rgba(190, 150, 255, 0.55)';
  stift.lineWidth = kante * 0.006;
  for (const r of [bahn - hoehe * 1.5, bahn + hoehe * 1.5]) {
    stift.beginPath();
    stift.arc(mitte, mitte, r, 0, Math.PI * 2);
    stift.stroke();
  }

  // Und die Zeichen. Der Schein kommt vom Schatten des Stifts — billiger als
  // eine zweite Lage und weicher als ein zweiter Strich.
  stift.strokeStyle = 'rgba(226, 208, 255, 0.95)';
  stift.shadowColor = 'rgba(150, 110, 255, 0.9)';
  stift.shadowBlur = kante * 0.03;
  stift.lineWidth = kante * 0.009;

  for (let i = 0; i < RUNEN; i++) {
    const winkel = (i / RUNEN) * Math.PI * 2;
    const zeichen = ZEICHEN[i % ZEICHEN.length]!;
    stift.save();
    stift.translate(mitte + Math.cos(winkel) * bahn, mitte + Math.sin(winkel) * bahn);
    // Die Zeichen stehen **auf** dem Kreis, nicht daneben: gedreht um den
    // Winkel plus ein Viertel, damit ihr Fuss zur Mitte zeigt.
    stift.rotate(winkel + Math.PI / 2);
    stift.beginPath();
    for (const [x0, y0, x1, y1] of zeichen) {
      stift.moveTo(x0 * hoehe, y0 * hoehe);
      stift.lineTo(x1 * hoehe, y1 * hoehe);
    }
    stift.stroke();
    stift.restore();
  }

  runenTextur = new THREE.CanvasTexture(leinwand);
  runenTextur.colorSpace = THREE.SRGBColorSpace;
  runenTextur.anisotropy = 4;
  return runenTextur;
}

const WIRBEL_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const WIRBEL_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  uniform float zeit;
  uniform vec3 kern;
  uniform vec3 rand;

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    // Ausserhalb des Kreises nichts. Die Scheibe ist rund, ihre Textur
    // quadratisch — ohne diese Zeile sässe der Wirbel in einem Quadrat.
    if (r > 1.0) discard;
    float a = atan(p.y, p.x);

    /*
     * Zwei Spiralen, gegenläufig.
     *
     * Der Logarithmus des Radius ist der ganze Trick: er macht aus einem
     * Streifenmuster eine Spirale, die zur Mitte hin enger wird — so, wie
     * Wasser in einen Abfluss läuft. Ohne ihn liefen die Arme gerade nach
     * aussen und das Bild sähe aus wie ein Rad.
     *
     * Zwei mit verschiedener Windung und verschiedener Geschwindigkeit, weil
     * eine allein sich als Rad liest, sobald man ihr eine Sekunde zusieht.
     */
    float lr = log(max(r, 0.04));
    float arm1 = sin(a * 3.0 + lr * 7.0 - zeit * 2.2) * 0.5 + 0.5;
    float arm2 = sin(a * 5.0 - lr * 4.0 + zeit * 1.4) * 0.5 + 0.5;
    float arme = max(smoothstep(0.15, 0.95, arm1), smoothstep(0.35, 1.0, arm2) * 0.65);

    // Der helle Schlund in der Mitte und der weiche Rand aussen.
    /*
     * Der Schlund ist **klein**.
     *
     * Beim ersten Anlauf reichte er über die inneren sechs Zehntel, und damit
     * war der halbe Kreis eine gleichmässig helle Platte — die Arme gingen
     * darin unter. Ein Strudel ist fast überall dunkel und nur in der Mitte
     * hell; genau daran erkennt man, dass er einer ist.
     */
    float mitteHell = smoothstep(0.3, 0.0, r) * 0.85;
    float kante = smoothstep(1.0, 0.74, r);

    vec3 farbe = mix(rand, kern, clamp(arme * 0.85 + mitteHell, 0.0, 1.0));
    /*
     * Fast deckend, und das ist der Punkt.
     *
     * Der erste Anlauf mischte additiv: dann leuchtet zwar alles, aber der
     * **dunkle** Grund fehlt — additiv kann nichts abdunkeln, und ohne
     * dunklen Grund gibt es keinen hellen Arm, sondern nur helles Gras. Ein
     * Schlund im Boden ist zuerst ein Loch und erst danach ein Licht.
     */
    float alpha = kante * (0.62 + arme * 0.38);
    gl_FragColor = vec4(farbe, alpha);
  }
`;

const SAEULE_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  uniform float zeit;
  uniform vec3 kern;

  void main() {
    // Unten voll, oben weg. Eine Säule mit harter Oberkante wäre ein Rohr.
    float auf = smoothstep(1.0, 0.1, vUv.y);
    // Senkrechte Schlieren, die um die Säule wandern — sie machen aus einem
    // Zylinder etwas, das strömt.
    float streifen = sin(vUv.x * 26.0 + zeit * 1.6) * 0.5 + 0.5;
    float feiner = sin(vUv.x * 61.0 - zeit * 2.7) * 0.5 + 0.5;
    // Zurückhaltend: die Säule soll das Tor von der Seite verraten und nicht
    // die Wiese daneben aufhellen. Der erste Anlauf war dreimal so kräftig und
    // machte aus dem Kreis einen weissen Fleck.
    float alpha = auf * (0.02 + streifen * 0.035 + feiner * 0.02);
    gl_FragColor = vec4(kern, alpha);
  }
`;

/** Ein Tor, wie man es im Spiel sieht. */
export class PortalRing {
  readonly root = new THREE.Group();

  private readonly runen: THREE.Mesh;
  private readonly wirbelMaterial: THREE.ShaderMaterial;
  private readonly saeuleMaterial: THREE.ShaderMaterial;
  private readonly wegwerf: Array<{ dispose(): void }> = [];

  /**
   * @param lage   Wo das Tor steht, samt der Höhe seiner Mitte.
   * @param radius Der Radius des Auslösers aus dem Kartendokument.
   * @param hoehe  Wie hoch das Gelände an einer Stelle liegt.
   *
   * Der Radius ist **dieselbe Zahl** wie die des Auslösers und keine zweite
   * daneben: was man sieht, ist das, was auslöst. Ein Kreis, der kleiner ist
   * als sein Auslöser, wechselt die Karte, bevor man ihn betreten hat; ein
   * grösserer lässt einen darauf stehen, ohne dass etwas passiert.
   *
   * Die Höhenfunktion ist der Grund, warum der Kreis überhaupt zu sehen ist.
   * Eine waagerechte Scheibe ist in einem Gelände fast nie waagerecht: schon
   * bei einem halben Meter Welle über vier Meter Radius steckt die eine Hälfte
   * im Boden und die andere schwebt. Man sah einen abgeschnittenen Kreis und
   * hielt ihn für einen Fehler in der Anzeige — dieselbe Erwägung wie bei der
   * Laufmarke, und dieselbe Lösung.
   */
  constructor(
    lage: { x: number; y: number; z: number },
    radius: number,
    hoehe: (x: number, z: number) => number,
    farbe = { kern: 0x8fe4ff, rand: 0x25104a, saeule: 0x8f6bff },
  ) {
    const r = Math.max(1, radius);
    this.root.position.set(lage.x, lage.y, lage.z);

    /**
     * Eine Scheibe, die dem Boden folgt.
     *
     * `RingGeometry` und nicht `CircleGeometry`: die eine hat nur Rand und
     * Mitte, die andere Ringe dazwischen. Ohne Stützpunkte im Inneren liesse
     * sich nichts an das Gelände anlegen — man kann nur dort folgen, wo eine
     * Ecke sitzt.
     */
    const scheibe = (aussen: number, luft: number): THREE.BufferGeometry => {
      const geo = new THREE.RingGeometry(0.0001, aussen, 48, 8);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const px = pos.getX(i);
        const pz = pos.getZ(i);
        pos.setY(i, hoehe(lage.x + px, lage.z + pz) - lage.y + luft);
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();
      return geo;
    };

    /*
     * --- 1. Der Wirbel ------------------------------------------------------
     *
     * Ein Fingerbreit über dem Boden. Genau null hiesse, mit dem Gelände um
     * dieselben Bildpunkte zu streiten — das flimmert.
     *
     * Dass ein Fingerbreit reicht, hängt daran, **welche** Höhe der Aufrufer
     * hereinreicht: die des gezeichneten Netzes und nicht die gerechnete des
     * Kerns. Zwischen beiden liegt bis zu ein halber Meter, und mit der
     * gerechneten verschwand die Scheibe in jedem Hang.
     */
    const wirbelGeo = scheibe(r, 0.06);
    this.wirbelMaterial = new THREE.ShaderMaterial({
      uniforms: {
        zeit: { value: 0 },
        kern: { value: new THREE.Color(farbe.kern) },
        rand: { value: new THREE.Color(farbe.rand) },
      },
      vertexShader: WIRBEL_VERTEX,
      fragmentShader: WIRBEL_FRAGMENT,
      transparent: true,
      depthWrite: false,
      // Von oben **und** von unten sichtbar: wer unter einem schwebenden
      // Felsen hindurchgeht, soll das Tor darüber trotzdem sehen.
      side: THREE.DoubleSide,
      // Gewöhnlich gemischt und **nicht** additiv: siehe die Alphazeile im
      // Shader. Additiv wäre der Wirbel ein Scheinwerfer auf der Wiese.
      blending: THREE.NormalBlending,
      // Kein Nebel: ein Tor am Rand der Sicht soll man finden können.
      fog: false,
    });
    const wirbel = new THREE.Mesh(wirbelGeo, this.wirbelMaterial);

    // --- 2. Der Runenring ---------------------------------------------------
    const runenGeo = scheibe(r * 1.16, 0.09);
    const runenMaterial = new THREE.MeshBasicMaterial({
      map: baueRunenTextur(),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.runen = new THREE.Mesh(runenGeo, runenMaterial);

    // --- 3. Die Lichtsäule --------------------------------------------------
    //
    // Offen an beiden Enden, damit man von oben hineinsieht statt auf einen
    // Deckel. Etwas enger als der Kreis: eine Säule genau auf dem Rand sähe
    // aus wie eine Wand um ihn herum.
    const saeuleHoch = r * 2.2;
    const saeuleGeo = new THREE.CylinderGeometry(r * 0.6, r * 0.86, saeuleHoch, 32, 1, true);
    this.saeuleMaterial = new THREE.ShaderMaterial({
      uniforms: { zeit: { value: 0 }, kern: { value: new THREE.Color(farbe.saeule) } },
      vertexShader: WIRBEL_VERTEX,
      fragmentShader: SAEULE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const saeule = new THREE.Mesh(saeuleGeo, this.saeuleMaterial);
    saeule.position.y = saeuleHoch / 2;

    this.root.add(wirbel, this.runen, saeule);
    this.wegwerf.push(wirbelGeo, runenGeo, saeuleGeo, this.wirbelMaterial, runenMaterial, this.saeuleMaterial);
  }

  /**
   * Treibt die Uhr weiter. Ohne diesen Aufruf steht das Tor still.
   *
   * Die Zeit läuft nur hier hoch und nicht aus `performance.now()`: ein Tor,
   * das im Hintergrundtab weiterdreht, holt beim Zurückkommen die ganze
   * verlorene Zeit in einem Bild nach und zuckt.
   */
  update(dt: number): void {
    this.wirbelMaterial.uniforms.zeit!.value += dt;
    this.saeuleMaterial.uniforms.zeit!.value += dt;
    /*
     * Der Runenring dreht sich **gegen** den Wirbel.
     *
     * Zwei Bewegungen in dieselbe Richtung verschmelzen zu einer, und dann
     * sieht man weder die eine noch die andere. Gegenläufig bleibt beides
     * einzeln zu erkennen — dieselbe Erwägung wie bei den zwei Spiralen im
     * Shader, nur eine Ebene höher.
     */
    this.runen.rotation.y += dt * 0.22;
  }

  dispose(): void {
    for (const w of this.wegwerf) w.dispose();
  }
}
