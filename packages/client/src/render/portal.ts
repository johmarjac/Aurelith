/**
 * Das Tor — ein Lichtteich auf dem Boden statt eines Torbogens.
 *
 * Hier stand ein Prop: ein steinerner Bogen, der bei jedem Portal aus dem
 * Boden wuchs. Das war zweimal falsch. Erstens sah jedes Tor gleich aus, egal
 * ob es in eine Gruft oder auf eine Wiese führt — ein Bogen ist Architektur
 * und die gehört der Karte, nicht dem Übergang. Zweitens war es ein Bauwerk,
 * und Bauwerke stehen herum: man lief davor, dahinter, hindurch, und nichts
 * daran sagte „hier geht es weiter".
 *
 * Danach lag hier ein Bannkreis mit zwei Spiralarmen und einem Runenring.
 * Der zeigte sich als das Falsche: harte Kanten, ein Muster, das sich dreht,
 * und ein Ring aus Schrift — zusammen ein Zauberzeichen. Gemeint war etwas
 * anderes: eine **Pfütze aus Licht**, in der es brodelt. Kein Zeichen, das
 * jemand gemalt hat, sondern eine Stelle, an der die Welt dünn ist.
 *
 * **Drei Lagen, jede mit einer Aufgabe:**
 *
 *   1. Der **Teich** — eine Scheibe mit einem Shader, der Zellen kocht:
 *      helle Flecken mit dunklen Nähten dazwischen, die langsam wandern und
 *      dabei ihre Form ändern. Das ist die Fläche, in die man tritt.
 *   2. Der **Schein** — eine grössere, viel schwächere Scheibe darunter. Sie
 *      hellt den Boden ringsum auf, so wie eine leuchtende Fläche das täte.
 *      Ohne sie klebt der Teich auf dem Gras wie ein Aufkleber.
 *   3. Die **Funken** — ein paar Dutzend Punkte, die aus dem Teich aufsteigen
 *      und oben verblassen. Sie sind der Grund, warum man ein Tor auch dann
 *      bemerkt, wenn der Boden hinter einem Hügel liegt.
 *
 * Alles additiv gemischt und ohne Tiefe zu schreiben: drei durchsichtige Lagen
 * übereinander würden sich sonst gegenseitig ausstanzen, und je nach
 * Blickwinkel fehlte eine davon. Additiv ist hier auch inhaltlich richtig —
 * gemeint ist Licht, das dazukommt, und nicht Farbe, die den Boden ersetzt.
 */

import * as THREE from 'three';

/**
 * Die Farben des Teichs.
 *
 * `kern` ist das Weiss in der Mitte, `rand` das Türkis, mit dem er nach aussen
 * hin ausläuft, `schein` die Farbe des Bodenscheins. Alle drei sind hell und
 * kalt: ein Übergang ist etwas Unheimliches, und Unheimliches ist blau.
 */
export interface PortalFarben {
  kern: number;
  rand: number;
  schein: number;
}

const STANDARD_FARBEN: PortalFarben = { kern: 0xeaf7ff, rand: 0x49d6d0, schein: 0x2fc2c8 };

/*
 * Achtung beim Ändern der Shader: **keine Backticks in den GLSL-Kommentaren.**
 * Der Quelltext steht in einem Template-Literal, und ein Backtick darin
 * beendet es mitten im Shader. Das ist hier schon zweimal passiert, und der
 * Fehler zeigt sich als eine Handvoll unverständlicher TypeScript-Meldungen
 * dreissig Zeilen weiter unten.
 */

const TEICH_VERTEX = /* glsl */ `
  varying vec2 vLage;
  void main() {
    // Die Lage im Modell, nicht die UV: die Scheibe ist ein Ring mit
    // gedrehten Koordinaten, und deren UV waeren eine Spirale.
    vLage = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Der Teich.
 *
 * Kern der Sache ist eine **Zellenfunktion** (Worley): der Abstand zum
 * nächstgelegenen von lauter zufällig gesetzten Punkten. Wo zwei Zellen
 * aneinanderstossen, liegt eine Naht — und genau diese Nähte sind das, was
 * man im Wasser sieht, wenn Licht sich darin bricht. Ein Rauschen aus Sinus
 * täte es nicht: das wabert, aber es hat keine Ränder, und ohne Ränder sieht
 * man keine Bewegung, sondern nur Flimmern.
 *
 * Die Punkte wandern mit der Zeit auf kleinen Kreisen. Dadurch ändern die
 * Zellen ihre Form, statt als starres Muster zu rotieren — das ist der
 * Unterschied zwischen kochen und sich drehen.
 *
 * Zwei Grössen übereinander: grobe Zellen tragen die Form, feine das Detail.
 * Eine allein sieht entweder aus wie Kacheln oder wie Rauschen.
 */
const TEICH_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vLage;
  uniform float zeit;
  uniform float radius;
  uniform vec3 kern;
  uniform vec3 rand;

  vec2 wuerfel(vec2 p) {
    // Ein billiger Hash. Die Zahlen sind die ueblichen Primzahl-Konstanten;
    // was zaehlt, ist allein, dass benachbarte Zellen unaehnliche Punkte
    // bekommen.
    float n = sin(dot(p, vec2(127.1, 311.7))) * 43758.5453;
    float m = sin(dot(p, vec2(269.5, 183.3))) * 43758.5453;
    return fract(vec2(n, m));
  }

  /** Abstand zur naechsten und zur zweitnaechsten Zellmitte. */
  vec2 zellen(vec2 p, float t) {
    vec2 gitter = floor(p);
    vec2 rest = fract(p);
    float erst = 8.0;
    float zweit = 8.0;
    for (int dz = -1; dz <= 1; dz++) {
      for (int dx = -1; dx <= 1; dx++) {
        vec2 nachbar = vec2(float(dx), float(dz));
        vec2 mitte = wuerfel(gitter + nachbar);
        // Auf einem kleinen Kreis wandern lassen, jede Zelle mit eigener
        // Phase. Ohne das steht das Muster still und dreht sich nur.
        mitte += 0.28 * vec2(sin(t + mitte.x * 6.283), cos(t * 0.9 + mitte.y * 6.283));
        float d = length(nachbar + mitte - rest);
        if (d < erst) { zweit = erst; erst = d; }
        else if (d < zweit) { zweit = d; }
      }
    }
    return vec2(erst, zweit);
  }

  void main() {
    float r = length(vLage) / radius;
    if (r > 1.0) discard;

    // Die Zellen langsam gegen den Uhrzeigersinn schieben — nicht drehen:
    // eine Drehung um die Mitte macht aus dem Teich einen Strudel, und ein
    // Strudel hat ein Loch in der Mitte.
    vec2 p = vLage / radius;
    float dreh = zeit * 0.06;
    vec2 gedreht = vec2(p.x * cos(dreh) - p.y * sin(dreh), p.x * sin(dreh) + p.y * cos(dreh));

    vec2 grob = zellen(gedreht * 2.1 + vec2(0.0, zeit * 0.05), zeit * 0.5);
    vec2 fein = zellen(gedreht * 4.3 - vec2(zeit * 0.04, 0.0), zeit * 0.8);

    // Der Abstand zwischen erster und zweiter Zelle ist an der Naht null und
    // in der Mitte einer Zelle gross: das gibt helle Flecken mit dunklen
    // Faeden dazwischen, genau wie Licht auf dem Grund eines Beckens.
    float nahtGrob = smoothstep(0.0, 0.66, grob.y - grob.x);
    float nahtFein = smoothstep(0.0, 0.52, fein.y - fein.x);
    // Der Grundwert liegt nicht bei null: eine Naht ist eine **dunklere**
    // Stelle im Licht und kein Loch. Ohne den Sockel war der Teich ein Netz
    // aus schwarzen Faeden statt einer Pfuetze, in der es brodelt.
    float milch = 0.34 + 0.66 * (nahtGrob * 0.62 + nahtFein * 0.38);

    // Zur Mitte hin voller, zum Rand hin duenner. Der Rand selbst bekommt
    // einen hellen Saum: eine Flaeche ohne Kante liest sich als Fleck, mit
    // Kante als Oeffnung.
    float fuellung = 1.0 - smoothstep(0.45, 1.0, r);
    float saum = smoothstep(0.58, 0.9, r) * (1.0 - smoothstep(0.9, 1.0, r));
    // Ein langsames Atmen ueber alles. Zwei Frequenzen, damit es nicht
    // taktet.
    float puls = 0.82 + 0.12 * sin(zeit * 1.15) + 0.06 * sin(zeit * 0.43 + 1.7);

    /*
     * Zur Mitte hin weiss, zum Rand hin tuerkis — und zwar ueber das Quadrat
     * der Milchigkeit: linear gemischt blieb der ganze Teich tuerkis, weil
     * schon halbe Milch halb Weiss ergab und die hellen Flecken damit
     * verschwanden.
     */
    vec3 farbe = mix(rand, kern, clamp(milch * milch * (0.5 + 0.5 * fuellung) + fuellung * 0.3, 0.0, 1.0));
    float alpha = (fuellung * (0.62 + 0.38 * milch) + saum * 0.8) * puls;
    gl_FragColor = vec4(farbe * (0.78 + 0.5 * milch), clamp(alpha, 0.0, 1.0));
  }
`;

/**
 * Der Bodenschein.
 *
 * Eine flache Kuppel aus Farbe, die nach aussen ausläuft — mehr nicht. Sie
 * ersetzt kein Licht: der Zeichner rechnet keine Lichtquelle für ein Tor, und
 * eine echte wäre für einen Effekt, den man aus zwanzig Metern sieht, zu
 * teuer. Was sie leistet, ist der Übergang: ohne sie hört der Teich an seiner
 * Kante auf, und alles, was ohne Übergang aufhört, sieht aufgeklebt aus.
 */
const SCHEIN_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vLage;
  uniform float zeit;
  uniform float radius;
  uniform vec3 schein;

  void main() {
    float r = length(vLage) / radius;
    if (r > 1.0) discard;
    // Quadratisch abfallend, nicht linear: linear ergibt einen Teller mit
    // sichtbarem Rand, quadratisch einen Schein.
    float f = 1.0 - r;
    float puls = 0.86 + 0.14 * sin(zeit * 1.15);
    gl_FragColor = vec4(schein, f * f * 0.62 * puls);
  }
`;

/**
 * Die Funken.
 *
 * Punkte statt Bildtafeln: ein Funke ist ein Lichtpunkt, und ein Lichtpunkt
 * braucht keine Geometrie. Die Grösse nimmt mit der Entfernung ab
 * (`gl_PointSize` durch die Sichttiefe geteilt), sonst sind die Funken eines
 * weit entfernten Tores so gross wie die des eigenen.
 *
 * Der Aufstieg steckt im Shader und nicht im Aufrufer: `mod` über die Zeit
 * lässt jeden Funken für sich von unten nach oben laufen und wieder von vorn
 * anfangen, ohne dass irgendwo eine Liste mit Lebenszeiten gepflegt werden
 * müsste.
 */
const FUNKEN_VERTEX = /* glsl */ `
  precision highp float;
  attribute float phase;
  attribute float tempo;
  uniform float zeit;
  uniform float hoehe;
  uniform float groesse;
  varying float vLeben;

  void main() {
    // 0 unten, 1 oben — und dann wieder 0.
    float t = fract(phase + zeit * tempo);
    vLeben = t;
    vec3 p = position;
    p.y += t * hoehe;
    // Beim Steigen leicht nach innen ziehen: aufsteigende Luft tut das, und
    // ohne es sieht die Saeule aus wie ein Zylinder aus Punkten.
    p.xz *= 1.0 - t * 0.35;
    vec4 sicht = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * sicht;
    gl_PointSize = groesse * (1.0 - t * 0.4) * (300.0 / max(1.0, -sicht.z));
  }
`;

const FUNKEN_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform vec3 farbe;
  varying float vLeben;

  void main() {
    // Runde Funken statt Quadrate: der Punkt kommt als Quadrat, und die
    // Ecken muessen weg.
    vec2 d = gl_PointCoord - 0.5;
    float rund = 1.0 - smoothstep(0.18, 0.5, length(d));
    // Unten aufblenden, oben ausblenden — ein Funke, der auf voller
    // Helligkeit erscheint, blitzt.
    float leben = smoothstep(0.0, 0.15, vLeben) * (1.0 - smoothstep(0.55, 1.0, vLeben));
    gl_FragColor = vec4(farbe, rund * leben * 0.75);
  }
`;

/** Wie viele Funken über einem Tor stehen. */
const FUNKEN = 24;

export class PortalRing {
  readonly root = new THREE.Group();

  private readonly teichMaterial: THREE.ShaderMaterial;
  private readonly scheinMaterial: THREE.ShaderMaterial;
  private readonly funkenMaterial: THREE.ShaderMaterial;
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
   * Die Höhenfunktion ist der Grund, warum der Teich überhaupt zu sehen ist.
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
    farbe: PortalFarben = STANDARD_FARBEN,
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
      const geo = new THREE.RingGeometry(0.0001, aussen, 48, 10);
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
     * --- 1. Der Bodenschein -------------------------------------------------
     *
     * Zuerst, weil er **unter** dem Teich liegt: er ist grösser, und ohne
     * Tiefenschreiben entscheidet die Reihenfolge im Baum, was worüber liegt.
     * Ein Fingerbreit über dem Boden — genau null hiesse, mit dem Gelände um
     * dieselben Bildpunkte zu streiten, und das flimmert.
     *
     * Dass ein Fingerbreit reicht, hängt daran, **welche** Höhe der Aufrufer
     * hereinreicht: die des gezeichneten Netzes und nicht die gerechnete des
     * Kerns. Zwischen beiden liegt bis zu ein halber Meter, und mit der
     * gerechneten verschwand die Scheibe in jedem Hang.
     */
    const scheinRadius = r * 2.3;
    const scheinGeo = scheibe(scheinRadius, 0.05);
    this.scheinMaterial = new THREE.ShaderMaterial({
      uniforms: {
        zeit: { value: 0 },
        radius: { value: scheinRadius },
        schein: { value: new THREE.Color(farbe.schein) },
      },
      vertexShader: TEICH_VERTEX,
      fragmentShader: SCHEIN_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      // Kein Nebel: ein Tor am Rand der Sicht soll man finden können.
      fog: false,
    });
    const schein = new THREE.Mesh(scheinGeo, this.scheinMaterial);

    // --- 2. Der Teich -------------------------------------------------------
    const teichGeo = scheibe(r, 0.08);
    this.teichMaterial = new THREE.ShaderMaterial({
      uniforms: {
        zeit: { value: 0 },
        radius: { value: r },
        kern: { value: new THREE.Color(farbe.kern) },
        rand: { value: new THREE.Color(farbe.rand) },
      },
      vertexShader: TEICH_VERTEX,
      fragmentShader: TEICH_FRAGMENT,
      transparent: true,
      depthWrite: false,
      // Von oben **und** von unten sichtbar: wer unter einem schwebenden
      // Felsen hindurchgeht, soll das Tor darüber trotzdem sehen.
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const teich = new THREE.Mesh(teichGeo, this.teichMaterial);

    /*
     * --- 3. Die Funken ------------------------------------------------------
     *
     * Gleichverteilt in der Fläche und nicht im Radius: `sqrt` auf den Wurf,
     * sonst drängen sich alle in der Mitte. Die Höhe kommt aus dem Radius, ein
     * kleines Tor soll keine grosse Fontäne haben.
     */
    const lagen = new Float32Array(FUNKEN * 3);
    const phasen = new Float32Array(FUNKEN);
    const tempi = new Float32Array(FUNKEN);
    for (let i = 0; i < FUNKEN; i++) {
      const winkel = Math.random() * Math.PI * 2;
      const abstand = Math.sqrt(Math.random()) * r * 0.86;
      const fx = Math.cos(winkel) * abstand;
      const fz = Math.sin(winkel) * abstand;
      lagen[i * 3] = fx;
      lagen[i * 3 + 1] = hoehe(lage.x + fx, lage.z + fz) - lage.y + 0.1;
      lagen[i * 3 + 2] = fz;
      phasen[i] = Math.random();
      // Verschiedene Geschwindigkeiten, sonst steigen alle im Gleichschritt
      // und man sieht Reihen statt Funken.
      tempi[i] = 0.12 + Math.random() * 0.16;
    }
    const funkenGeo = new THREE.BufferGeometry();
    funkenGeo.setAttribute('position', new THREE.BufferAttribute(lagen, 3));
    funkenGeo.setAttribute('phase', new THREE.BufferAttribute(phasen, 1));
    funkenGeo.setAttribute('tempo', new THREE.BufferAttribute(tempi, 1));
    this.funkenMaterial = new THREE.ShaderMaterial({
      uniforms: {
        zeit: { value: 0 },
        hoehe: { value: r * 1.5 },
        groesse: { value: Math.max(1.1, r * 0.2) },
        farbe: { value: new THREE.Color(farbe.kern) },
      },
      vertexShader: FUNKEN_VERTEX,
      fragmentShader: FUNKEN_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const funken = new THREE.Points(funkenGeo, this.funkenMaterial);
    // Die Punkte haben keine sinnvolle Hülle — sie wandern im Shader nach
    // oben, und three.js wüsste davon nichts. Ohne diese Zeile verschwindet
    // die ganze Wolke, sobald ihre gerechnete Hülle aus dem Bild läuft.
    funken.frustumCulled = false;

    this.root.add(schein, teich, funken);
    this.wegwerf.push(
      scheinGeo,
      teichGeo,
      funkenGeo,
      this.scheinMaterial,
      this.teichMaterial,
      this.funkenMaterial,
    );
  }

  /**
   * Treibt die Uhr weiter. Ohne diesen Aufruf steht das Tor still.
   *
   * Die Zeit läuft nur hier hoch und nicht aus `performance.now()`: ein Tor,
   * das im Hintergrundtab weiterläuft, holt beim Zurückkommen die ganze
   * verlorene Zeit in einem Bild nach — die Funken springen dann auf einmal
   * um zwanzig Runden weiter.
   */
  update(dt: number): void {
    this.teichMaterial.uniforms.zeit!.value += dt;
    this.scheinMaterial.uniforms.zeit!.value += dt;
    this.funkenMaterial.uniforms.zeit!.value += dt;
  }

  dispose(): void {
    for (const w of this.wegwerf) w.dispose();
  }
}
