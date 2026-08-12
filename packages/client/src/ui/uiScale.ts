/**
 * Die Größe der Oberfläche.
 *
 * Ein Regler, eine Zahl, eine CSS-Variable — und weil im Stylesheet alle
 * Größen in `rem` stehen, hängt daran alles: Schrift, Kästchen, Fenster,
 * Abstände. Die Wurzelschriftgröße ist der Hebel, den der Browser dafür
 * ohnehin mitbringt.
 *
 * **Nicht `transform: scale()` auf der Oberfläche.** Das wäre eine Zeile
 * weniger und ein Fehler: Fenster tragen ihre Lage in Bildpunkten, und die
 * Sprechblase rechnet ihre Stelle aus `getBoundingClientRect`. Unter einer
 * Skalierung liefern die beiden Seiten verschiedene Koordinatensysteme, und
 * jedes Ziehen driftet. Über die Schriftgröße ändert sich das Layout, nicht
 * das Koordinatensystem.
 *
 * Was in `dvh` steht — die Figur im Inventar, die Höhe der Kästchen quer —
 * bleibt bildschirmbezogen. Das ist Absicht: der Regler soll grösser machen,
 * nicht aus dem Bild schieben.
 */

const SPEICHER = 'aurelith.uiscale';

/** Kleinste, größte und voreingestellte Größe. */
export const UI_SCALE_MIN = 0.7;
export const UI_SCALE_MAX = 1.6;
export const UI_SCALE_STANDARD = 1;

function begrenzen(wert: number): number {
  if (!Number.isFinite(wert)) return UI_SCALE_STANDARD;
  return Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, wert));
}

/** Was zuletzt eingestellt war. Ohne Eintrag die Voreinstellung. */
export function ladeUiScale(): number {
  try {
    const roh = localStorage.getItem(SPEICHER);
    return roh === null ? UI_SCALE_STANDARD : begrenzen(Number(roh));
  } catch {
    // Privates Fenster, gesperrter Speicher — kein Grund, ohne Oberfläche
    // dazustehen.
    return UI_SCALE_STANDARD;
  }
}

/** Stellt die Größe ein und merkt sie sich. Gibt zurück, was tatsächlich gilt. */
export function setzeUiScale(wert: number): number {
  const gilt = begrenzen(wert);
  document.documentElement.style.setProperty('--ui-scale', String(gilt));
  try {
    localStorage.setItem(SPEICHER, String(gilt));
  } catch {
    // Nicht speichern zu können ist kein Grund, nicht zu skalieren.
  }
  return gilt;
}
