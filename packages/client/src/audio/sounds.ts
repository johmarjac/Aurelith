/**
 * Der Tonkatalog.
 *
 * Eine Stelle, an der steht, welche Datei zu welchem Ereignis gehört, in
 * welche Kategorie sie fällt und wie laut sie liegt. Verstreute Pfade im
 * Spielcode wären der sichere Weg dahin, dass die Hälfte der Töne zu laut ist
 * und niemand mehr weiß, welche Datei noch benutzt wird.
 *
 * Die Pfade sind Manifest-Pfade, keine Adressen — der Streamer setzt Basis
 * und Versionsnummer davor. Assets kommen vom CDN, nie vom Spielserver.
 */

import type { SoundCategory } from './mixer.ts';

export interface SoundDef {
  path: string;
  category: SoundCategory;
  /** Grundlautstärke, bevor Kategorie und Gesamtregler wirken. */
  gain: number;
  /** Tonhöhenstreuung in Halbtönen, gegen den Maschinengewehr-Eindruck. */
  spread: number;
  /**
   * Wo im Schlag der Ton liegt — als Anteil der Animation, 0 bis 1.
   *
   * Nicht am Anfang, denn dort beginnt das Ausholen. Wer den Bogen hebt, hat
   * noch nichts abgeschossen; das Sirren gehört an den Punkt, an dem der Pfeil
   * die Sehne verlässt. Beim Schwert ebenso: der Ton gehört zum Durchziehen,
   * nicht zum Heben.
   *
   * Die Schlaganimation teilt sich bei 0,45 — davor wird ausgeholt, danach
   * durchgezogen. Deshalb liegen beide Werte dahinter.
   *
   * 0 bedeutet: sofort, ohne Verzögerung.
   */
  cue: number;
  /**
   * Der Ton hängt am Geschoss, nicht am Schwung.
   *
   * Für Fernkampfwaffen: der Server lässt die Schwinge auch dann beginnen,
   * wenn kein Ziel in Reichweite ist — er muss, sonst rechnete die Vorhersage
   * im Client an dieser Stelle anders. Es fliegt dann aber kein Pfeil, und ein
   * Sirren ohne Pfeil klingt nach einem Fehler. Also klingt es erst, wenn
   * wirklich etwas losfliegt; `cue` bleibt dabei ungenutzt.
   */
  viaProjectile?: boolean;
  /** Grundtonhöhe als Abspielrate. Siehe PlayOptions.rate. */
  rate?: number;
}

export type SoundId =
  | 'bogen_schuss'
  | 'schwert_schwung'
  | 'treffer'
  | 'treffer_kritisch'
  | 'treffer_toedlich'
  | 'ausruestung';

export const SOUNDS: Record<SoundId, SoundDef> = {
  bogen_schuss: {
    path: 'audio/bogen_schuss.mp3',
    category: 'weapons',
    gain: 0.9,
    spread: 0.6,
    // Ungenutzt, solange der Ton am Pfeil hängt — steht hier, damit die
    // Umstellung eine Zeile ist, falls es doch der Schwung sein soll.
    cue: 0.5,
    viaProjectile: true,
  },
  schwert_schwung: {
    path: 'audio/schwert_schwung.mp3',
    category: 'weapons',
    // Etwas leiser als der Bogen: das Schwert schwingt bei jedem Schlag,
    // der Bogen schießt seltener. Gleich laut wäre das Schwert nach zwei
    // Minuten Nahkampf unerträglich.
    gain: 0.7,
    spread: 0.8,
    // Etwas spaeter als der Bogen: die Klinge braucht ein Stueck Weg, bis sie
    // dort ist, wo sie zischt.
    cue: 0.6,
  },

  // --- Einschläge ---------------------------------------------------------
  //
  // Eine Aufnahme, drei Ausprägungen. Der kritische Treffer klingt schärfer,
  // weil er etwas höher läuft, der tödliche schwerer, weil er tiefer läuft —
  // und weil es dieselbe Aufnahme ist, passen die drei per Konstruktion
  // zueinander. Drei getrennte Dateien müssten das erst werden.
  //
  // Kategorie `effects`, nicht `weapons`: ein Treffer gehört zum Ziel, nicht
  // zur Waffe. Wer die Waffen leiser dreht, weil ihm das eigene Schwert auf
  // die Nerven geht, will trotzdem hören, ob er trifft.
  //
  // Deutlich leiser als die Schwünge angesetzt: ein Treffer fällt bei jedem
  // Schlag an, und im Gefecht mit mehreren Monstern sind das schnell fünf je
  // Sekunde.
  treffer: {
    path: 'audio/treffer.mp3',
    category: 'effects',
    gain: 0.6,
    spread: 1.0,
    cue: 0,
  },
  treffer_kritisch: {
    path: 'audio/treffer.mp3',
    category: 'effects',
    gain: 0.8,
    spread: 0.7,
    rate: 1.12,
    cue: 0,
  },
  treffer_toedlich: {
    path: 'audio/treffer.mp3',
    category: 'effects',
    gain: 0.85,
    spread: 0.4,
    rate: 0.82,
    cue: 0,
  },

  // --- Oberfläche ---------------------------------------------------------
  //
  // Ohne Ort: ein Waffenwechsel findet nicht in der Welt statt, sondern in
  // der Hand des Spielers. Ihn nach links zu ziehen, weil die Figur gerade
  // links steht, wäre albern.
  ausruestung: {
    path: 'audio/ausruestung.mp3',
    category: 'effects',
    gain: 0.75,
    // Keine Streuung: ein Bestätigungsklang soll jedes Mal gleich klingen.
    // Variation gehört dorthin, wo etwas oft hintereinander passiert.
    spread: 0,
    cue: 0,
  },
};

/**
 * Welcher Ton zu welcher Waffe gehört.
 *
 * Die Schlüssel sind die Waffen aus `rigs.ts`. Fehlt eine, bleibt es still —
 * lieber kein Ton als der falsche.
 */
export const WEAPON_SWING: Partial<Record<string, SoundId>> = {
  bow: 'bogen_schuss',
  sword: 'schwert_schwung',
};

/**
 * Was schon beim Betreten der Welt im Speicher liegen soll.
 *
 * Ein Kampfgeräusch, das erst beim ersten Schlag geladen wird, fehlt genau
 * bei diesem ersten Schlag. Zusammen sind es zwölf Kilobyte — das lohnt die
 * Diskussion nicht, das lädt man einfach.
 */
export const PRELOAD: SoundId[] = [
  'bogen_schuss',
  'schwert_schwung',
  'treffer',
  'ausruestung',
];
