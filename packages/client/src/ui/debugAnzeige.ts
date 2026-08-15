/**
 * Der Schalter für die Debug-Anzeige.
 *
 * Eine Zahl im Speicher des Browsers, wie die Größe der Oberfläche daneben —
 * und aus demselben Grund dort und nicht im Spielstand: das ist eine
 * Einstellung dieses Geräts und keine der Figur. Wer an zwei Rechnern sitzt,
 * will nicht an beiden die Zahlen sehen, nur weil er sie an einem einmal
 * gebraucht hat.
 *
 * Was die Anzeige *zeigt*, steht nicht hier. Diese Datei weiss nur, ob.
 */

const SPEICHER = 'aurelith.debug';

/** War die Anzeige zuletzt an? Ohne Eintrag: nein. */
export function ladeDebugAnzeige(): boolean {
  try {
    return localStorage.getItem(SPEICHER) === '1';
  } catch {
    // Privates Fenster, gesperrter Speicher — dann eben ohne Zahlen.
    return false;
  }
}

/** Schaltet um und merkt es sich. */
export function setzeDebugAnzeige(an: boolean): void {
  try {
    localStorage.setItem(SPEICHER, an ? '1' : '0');
  } catch {
    // Nicht speichern zu können ist kein Grund, nicht anzuzeigen.
  }
}
