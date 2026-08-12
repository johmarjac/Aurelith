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
}

export type SoundId = 'bogen_schuss' | 'schwert_schwung';

export const SOUNDS: Record<SoundId, SoundDef> = {
  bogen_schuss: {
    path: 'audio/bogen_schuss.mp3',
    category: 'weapons',
    gain: 0.9,
    spread: 0.6,
  },
  schwert_schwung: {
    path: 'audio/schwert_schwung.mp3',
    category: 'weapons',
    // Etwas leiser als der Bogen: das Schwert schwingt bei jedem Schlag,
    // der Bogen schießt seltener. Gleich laut wäre das Schwert nach zwei
    // Minuten Nahkampf unerträglich.
    gain: 0.7,
    spread: 0.8,
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
export const PRELOAD: SoundId[] = ['bogen_schuss', 'schwert_schwung'];
