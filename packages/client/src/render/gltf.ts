/**
 * Gelieferte Modelle.
 *
 * Der Punkt, auf den die `ModelRegistry` von Anfang an hingeschrieben war:
 * `model: "wooden_sword"` soll irgendwann auf eine echte Datei zeigen, ohne
 * dass sich sonst etwas ändert. Hier steht die Hälfte davon, die glTF liest.
 *
 * Zwei Eigenschaften sind wichtiger als alles andere:
 *
 *   **Der Lader greift nie selbst ins Netz.** Er bekommt Bytes und gibt eine
 *   Szene zurück. Woher die Bytes kommen — Streamer, Zwischenspeicher,
 *   schlichtes fetch im Editor — geht ihn nichts an. Genau deshalb werden
 *   Modelle als .glb gepackt: eine Datei, ein Eintrag im Manifest, eine
 *   Anfrage mit Version im Query-String. Ein .gltf mit Nebendateien würde die
 *   Nachbardateien selbst holen und den Streamer umgehen.
 *
 *   **Nichts wartet auf ein Modell.** Was hier ankommt, ersetzt einen
 *   Platzhalter, der längst dasteht. Ein Ladebalken für ein Schwert wäre genau
 *   die Sorte Barriere, die der Blueprint nicht haben will.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Wie ein geliefertes Modell in unser Koordinatensystem gebracht wird. */
export interface ModelNormalization {
  /**
   * Gewünschte Länge entlang der Hauptachse, in Weltnenheiten.
   *
   * Gelieferte Modelle haben keine verlässliche Größe — dieses Schwert misst in
   * seinen eigenen Einheiten 3,66, ein anderes misst 40. Statt für jedes Modell
   * einen Skalierungsfaktor abzutippen, wird auf eine Länge gerechnet, die im
   * Spiel Sinn ergibt.
   */
  length: number;
  /**
   * Wo der untere Rand landen soll, relativ zum Ursprung.
   *
   * Beim Schwert ist das der Knauf: er sitzt knapp unterhalb der Faust, und
   * alles darüber ragt aus ihr heraus.
   */
  bottom: number;
  /**
   * Achse, entlang derer das Modell seine Länge hat.
   *
   * Vorgabe ist Y — Waffen werden aufrecht modelliert, Klinge nach oben. Steht
   * ein Modell anders da, wird es hier gedreht statt in der Datei.
   */
  axis?: 'x' | 'y' | 'z';
}

/**
 * Baut aus glb-Bytes eine Szene und rückt sie zurecht.
 *
 * Das Ergebnis hat seinen Ursprung dort, wo die Hand zufasst, und die
 * angegebene Länge — unabhängig davon, in welchen Einheiten der Urheber
 * gearbeitet hat.
 */
export async function loadModel(
  bytes: ArrayBuffer,
  normalize: ModelNormalization,
): Promise<THREE.Object3D> {
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(bytes, '');
  const scene = gltf.scene;

  // Nach der Drehung messen, nicht davor: sonst bezieht sich die Länge auf die
  // Achse des Urhebers und nicht auf unsere.
  if (normalize.axis === 'x') scene.rotation.z = Math.PI / 2;
  else if (normalize.axis === 'z') scene.rotation.x = -Math.PI / 2;
  scene.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(centre);

  const scale = size.y > 1e-6 ? normalize.length / size.y : 1;

  // Ein Halter darüber, damit die Skalierung nicht mit der Drehung streitet:
  // die Szene behält ihre eigene Ausrichtung, der Halter bringt sie an ihren
  // Platz.
  const holder = new THREE.Object3D();
  holder.add(scene);
  holder.scale.setScalar(scale);

  // Waagerecht mittig, senkrecht auf den gewünschten unteren Rand. Das Zentrum
  // in X und Z ist nötig, weil Modelle selten um ihren Ursprung gebaut sind —
  // dieses Schwert liegt in Z um mehr als eine halbe Einheit daneben.
  scene.position.set(-centre.x, -box.min.y + normalize.bottom / scale, -centre.z);

  // Werkzeug- und Figurenmodelle sollen von beiden Seiten sichtbar sein und
  // Schatten annehmen wie der Rest.
  holder.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.castShadow = false;
    node.receiveShadow = true;
    const material = node.material as THREE.Material | THREE.Material[];
    for (const m of Array.isArray(material) ? material : [material]) {
      // Sketchfab exportiert vieles doppelseitig; bei geschlossenen Körpern
      // kostet das nur Füllrate.
      m.side = THREE.FrontSide;
    }
  });

  return holder;
}

/** Gibt Geometrien und Materialien eines geladenen Modells frei. */
export function disposeModel(object: THREE.Object3D): void {
  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.geometry.dispose();
    const material = node.material as THREE.Material | THREE.Material[];
    for (const m of Array.isArray(material) ? material : [material]) {
      const withMap = m as THREE.Material & { map?: THREE.Texture | null };
      withMap.map?.dispose();
      m.dispose();
    }
  });
}
