/**
 * Die Uhr, nach der alle Auren gehen.
 *
 * Ein einziges Uniform-Objekt, das an jedem Aura-Material hängt: wer es
 * fortschreibt, schreibt alle fort. Sonst müsste je Bild über sämtliche Auren
 * gelaufen werden — die an den Waffen, die an den Rüstungen, die an der Figur
 * im Inventarfenster —, nur um überall dieselbe Zahl einzutragen.
 *
 * Steht in einer eigenen Datei, seit es zwei Sorten Aura gibt. Läge die Uhr
 * bei einer davon, hinge die andere an ihr, und eine Waffenaura wäre plötzlich
 * die Voraussetzung dafür, dass eine Rüstung pulsiert.
 */

export const auraZeit = { value: 0 };

/** Schreibt die gemeinsame Uhr fort. Einmal je Bild, nicht je Aura. */
export function stepAuras(dt: number): void {
  auraZeit.value += dt;
}
