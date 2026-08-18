/**
 * Die Grafikeinstellungen dieses Geräts.
 *
 * Im Speicher des Browsers und nicht im Spielstand — aus demselben Grund wie
 * die Größe der Oberfläche und der Debug-Schalter daneben: was ein Telefon
 * gerade noch schafft, ist keine Eigenschaft der Figur. Wer am Rechner sitzt,
 * will dort nicht die Sichtweite seines Telefons vorfinden.
 *
 * Was die Zahlen *bewirken*, steht nicht hier. Diese Datei weiss nur, welche.
 */

/**
 * Wie weit Props gezeichnet werden, in Metern.
 *
 * Drei Stufen und kein Regler: eine Sichtweite ist keine Zahl, die man
 * einstellen will, sondern eine Frage von „ruckelt es". Drei benannte
 * Antworten trifft man in zwei Sekunden, ein Regler kostet fünf Minuten
 * Ausprobieren.
 *
 * Die Zahlen hängen am Nebel. Der schluckt alles ab `quality.viewDistance`
 * — je nach Gerät 160, 240 oder 340 Meter —, und ein Baum, der **vor** dem
 * Nebel verschwindet, ist als Loch zu sehen. „Hoch" liegt deshalb auf 340 und
 * damit auf oder hinter jedem dieser Werte: dort verschwindet nichts
 * Sichtbares. Bei „Mittel" und „Niedrig" sieht man das Aufploppen — das ist
 * der Preis, den man bezahlt, und deshalb heissen die Stufen so und nicht
 * „gut" und „schlecht".
 */
export const SICHTWEITEN = {
  niedrig: 90,
  mittel: 180,
  hoch: 340,
} as const;

export type SichtweiteStufe = keyof typeof SICHTWEITEN;

/** Was in der Auswahl steht — Reihenfolge wie im Menü. */
export const SICHTWEITE_NAMEN: ReadonlyArray<readonly [SichtweiteStufe, string]> = [
  ['niedrig', 'Niedrig'],
  ['mittel', 'Mittel'],
  ['hoch', 'Hoch'],
];

export interface GrafikEinstellungen {
  sichtweite: SichtweiteStufe;
  /**
   * Wirft die Sonne Schatten?
   *
   * Der zweitteuerste Posten nach der Sichtweite: die Schattenkarte wird in
   * jedem Bild neu gezeichnet, und auf einem Telefon kostet das mehr als
   * alles, was man dafür sieht.
   */
  schatten: boolean;
  /**
   * Der schwarze Umriss um Figuren und Wesen.
   *
   * Kostet einen zweiten Durchgang je Figur — bei einer Handvoll Wesen im
   * Bild nichts, bei einem vollen Marktplatz spürbar.
   */
  umriss: boolean;
}

export const GRAFIK_VORGABE: GrafikEinstellungen = {
  sichtweite: 'hoch',
  schatten: true,
  umriss: true,
};

const SPEICHER = 'aurelith.grafik';

/** Was zuletzt eingestellt war. Ohne Eintrag: die Vorgabe. */
export function ladeGrafik(): GrafikEinstellungen {
  try {
    const roh = localStorage.getItem(SPEICHER);
    if (!roh) return { ...GRAFIK_VORGABE };
    const daten = JSON.parse(roh) as Partial<GrafikEinstellungen>;
    return {
      // Jedes Feld einzeln geprüft und nicht der ganze Satz übernommen: im
      // Speicher steht, was eine ältere Fassung dieses Spiels hineingeschrieben
      // hat, und eine Stufe, die es nicht mehr gibt, wäre eine Sichtweite von
      // `undefined`.
      sichtweite:
        daten.sichtweite && daten.sichtweite in SICHTWEITEN
          ? daten.sichtweite
          : GRAFIK_VORGABE.sichtweite,
      schatten: typeof daten.schatten === 'boolean' ? daten.schatten : GRAFIK_VORGABE.schatten,
      umriss: typeof daten.umriss === 'boolean' ? daten.umriss : GRAFIK_VORGABE.umriss,
    };
  } catch {
    // Privates Fenster, gesperrter Speicher, kaputtes JSON — dann die Vorgabe.
    return { ...GRAFIK_VORGABE };
  }
}

/** Merkt sich den Stand. */
export function setzeGrafik(werte: GrafikEinstellungen): void {
  try {
    localStorage.setItem(SPEICHER, JSON.stringify(werte));
  } catch {
    // Nicht speichern zu können ist kein Grund, nicht einzustellen.
  }
}
