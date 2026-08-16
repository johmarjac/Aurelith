/**
 * Der Kollisionskörper als sichtbare Schicht.
 *
 * Im Spiel ist die Kollision unsichtbar, und deshalb merkt man einen falschen
 * Radius erst daran, dass man an Luft hängenbleibt oder durch einen Stamm
 * läuft. Beides ist auf einer Karte mit tausend Props schwer zurückzuverfolgen
 * — und beides sieht man hier in einer Sekunde, wenn der Kreis unter dem
 * Modell liegt.
 *
 * Gezeichnet wird, was der Kern tatsächlich kennt (`PROP_KOLLISION`), und
 * nicht, was hier hübsch aussähe:
 *
 * - **Kreis** — eine Wand, um die man herumläuft. Im Kern hat sie keine Höhe:
 *   geprüft wird nur der Abstand in der Ebene. Gezeichnet wird sie deshalb so
 *   hoch, wie die Figur gross ist — dort stösst man an. Eine Wand in voller
 *   Höhe des Modells wäre nicht falscher, aber sie verdeckt bei einem
 *   neun Meter hohen Baum genau das, was man ansehen will.
 * - **Plattform** — eine Scheibe, auf der man steht. Sie liegt bei y = 0, denn
 *   dort liegt der Ursprung eines schwebenden Felsens: seine begehbare Fläche.
 * - **Keine** — dann liegt nur ein dünner Ring da, wo der Radius wäre. Nichts
 *   zu zeichnen wäre falsch: „kein Kreis" und „ich habe den Schalter nicht
 *   gefunden" sähen gleich aus.
 */

import * as THREE from 'three';
import type { PropKollision } from '@aurelith/shared';

/** Rot für das, was blockt; grün für das, worauf man steht. */
const SPERRE = 0xff6a4a;
const FLAECHE = 0x59d98a;
const DURCHLASS = 0x8899aa;

/** So hoch ist die Figur, die anstösst. Danach richtet sich die Wand. */
const SPIELERHOEHE = 1.8;

/**
 * Baut die Anzeige für eine Kollision.
 *
 * `hoehe` ist die Höhe des Modells. Sie deckelt die Wand nach unten: bei einem
 * flachen Findling von einem halben Meter sähe eine Wand in Figurenhöhe aus,
 * als stünde da mehr, als da ist.
 */
export function baueKollisionsanzeige(k: PropKollision, hoehe: number): THREE.Object3D {
  const gruppe = new THREE.Group();
  gruppe.name = 'kollision';

  const farbe = k.form === 'plattform' ? FLAECHE : k.form === 'circle' ? SPERRE : DURCHLASS;

  // Der Ring am Boden. Immer da, auch bei `none` — er ist die Antwort auf
  // „wie weit reicht das eigentlich".
  const staerke = Math.max(0.02, k.radius * 0.02);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(k.radius - staerke, k.radius + staerke, 72),
    new THREE.MeshBasicMaterial({ color: farbe, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI * 0.5;
  // Zwei Zentimeter über dem Boden: genau auf null flimmert er gegen das
  // Bodenraster, und das Flimmern liest sich wie ein kaputtes Modell.
  ring.position.y = 0.02;
  gruppe.add(ring);

  if (k.form === 'circle') {
    const wandHoehe = Math.max(0.3, Math.min(hoehe, SPIELERHOEHE));
    const wand = new THREE.Mesh(
      // Oben und unten offen: eine geschlossene Dose verdeckt das Modell von
      // oben, und von oben schaut man hier oft.
      new THREE.CylinderGeometry(k.radius, k.radius, wandHoehe, 48, 1, true),
      new THREE.MeshBasicMaterial({
        color: farbe,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    wand.position.y = wandHoehe * 0.5;
    gruppe.add(wand);
  }

  if (k.form === 'plattform') {
    const scheibe = new THREE.Mesh(
      new THREE.CircleGeometry(k.radius, 72),
      new THREE.MeshBasicMaterial({
        color: farbe,
        transparent: true,
        opacity: 0.2,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    scheibe.rotation.x = -Math.PI * 0.5;
    scheibe.position.y = 0.01;
    gruppe.add(scheibe);
  }

  return gruppe;
}

/** Wie die Kollision im Fuss steht. */
export function beschreibeKollision(k: PropKollision): string {
  if (k.form === 'none') return 'keine Kollision';
  const art = k.form === 'plattform' ? 'Plattform' : 'Kreis';
  return `${art} r = ${k.radius.toFixed(2)} m`;
}

/** Wirft die Anzeige samt Geometrie und Material weg. */
export function loeseKollisionAuf(gruppe: THREE.Object3D): void {
  gruppe.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  });
}
