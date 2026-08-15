/**
 * Eintrittskarten.
 *
 * Eine Karte sagt: „dieses Konto hat sich beim Anmeldeserver ausgewiesen".
 * Der Spielserver prüft kein Passwort mehr — er zeigt die Karte beim
 * Anmeldeserver vor und bekommt zurück, zu wem sie gehört. Damit gibt es
 * genau eine Stelle im ganzen System, die Passwörter kennt, egal wie viele
 * Kanäle laufen.
 *
 * **Die Karte gilt auf Zeit und nicht auf Anzahl.**
 *
 * Hier stand einmal „einmalig, sie wird beim Vorzeigen verbraucht", und für
 * eine Karte, die nur den Weg vom Anmeldeserver in den Kanal öffnet, war das
 * richtig. Es kostete aber jede unterbrochene Verbindung die Sitzung: wer auf
 * dem Telefon kurz in eine andere App wechselt, kommt zurück und hält ein
 * wertloses Stück Papier in der Hand — der Kanal weist es ab, und es geht
 * zurück zum Anmeldefenster. Das ist kein Angriff, das ist der Alltag.
 *
 * Die Karte ist damit zum Sitzungspapier geworden, und dafür gelten zwei
 * Fristen:
 *
 *   **Zwei Minuten**, um sich einen Kanal auszusuchen. Wer die Karte in der
 *   Hand hält und nirgends hingeht, verliert sie.
 *
 *   **Dreissig Minuten**, sobald sie einmal eingelöst ist — und diese Frist
 *   schiebt der Kanal weiter, solange die Verbindung steht. Fällt sie weg,
 *   läuft die Frist ab dem letzten Lebenszeichen. Danach führt ein Versuch
 *   zurück zur Anmeldung.
 *
 * Der Preis ist ehrlich zu nennen: eine mitgelesene Karte ist eine halbe
 * Stunde lang brauchbar statt bis zum ersten Vorzeigen. Sie reist deshalb
 * ausschliesslich über dieselbe TLS-Verbindung wie das Passwort, und wer sich
 * bewusst abmeldet, wirft sie sofort weg — siehe `verwirf`.
 */

import { randomBytes } from 'node:crypto';

interface Karte {
  accountId: number;
  accountName: string;
  /** Zugriffsstufe als Wort. Reist mit — der Kanal kennt die Konten nicht. */
  accessLevel: string;
  /** Millisekunden seit der Epoche. */
  gueltigBis: number;
}

/** Frist zwischen Anmeldung und Kanalwahl. */
const AUSWAHL_MS = 120_000;
/** Frist ab dem letzten Lebenszeichen einer eingelösten Karte. */
export const SITZUNG_MS = 30 * 60_000;

export class Kartenstapel {
  private readonly karten = new Map<string, Karte>();

  /**
   * Stellt eine Karte aus.
   *
   * 32 Byte aus dem Zufallsgenerator des Betriebssystems, nicht
   * `Math.random()`: eine erratbare Karte ist ein Konto ohne Passwort.
   */
  stelleAus(
    accountId: number,
    accountName: string,
    accessLevel: string,
    jetzt = Date.now(),
  ): string {
    this.raeume(jetzt);
    const token = randomBytes(32).toString('base64url');
    this.karten.set(token, {
      accountId,
      accountName,
      accessLevel,
      gueltigBis: jetzt + AUSWAHL_MS,
    });
    return token;
  }

  /**
   * Löst eine Karte ein — und macht sie damit zum Sitzungspapier.
   *
   * Sie bleibt liegen, statt verbraucht zu werden, und ihre Frist springt auf
   * die lange. Genau das ist der Unterschied zu vorher: derselbe Spieler darf
   * mit derselben Karte wiederkommen, solange die Frist läuft.
   *
   * Gibt zurück, zu wem sie gehört, oder nichts.
   */
  loeseEin(
    token: string,
    jetzt = Date.now(),
  ): { accountId: number; accountName: string; accessLevel: string } | undefined {
    const karte = this.karten.get(token);
    if (!karte) return undefined;
    if (karte.gueltigBis < jetzt) {
      // Abgelaufen heisst weg — auch wenn niemand mehr danach fragt.
      this.karten.delete(token);
      return undefined;
    }
    karte.gueltigBis = jetzt + SITZUNG_MS;
    return {
      accountId: karte.accountId,
      accountName: karte.accountName,
      accessLevel: karte.accessLevel,
    };
  }

  /**
   * Schiebt die Frist einer Karte weiter. Der Kanal ruft das, solange er die
   * Verbindung hält.
   *
   * `false` heisst: gibt es nicht mehr. Der Kanal kann daraufhin nichts tun —
   * die Sitzung läuft ja — und soll es auch nicht: eine Karte, die verfallen
   * ist, während jemand spielt, kostet ihn nur den Wiedereinstieg, und das ist
   * ein kleineres Übel als eine Sitzung, die mitten im Spiel abbricht.
   */
  frischeAuf(token: string, jetzt = Date.now()): boolean {
    const karte = this.karten.get(token);
    if (!karte) return false;
    if (karte.gueltigBis < jetzt) {
      this.karten.delete(token);
      return false;
    }
    karte.gueltigBis = jetzt + SITZUNG_MS;
    return true;
  }

  /**
   * Wirft eine Karte weg — für das gewollte Abmelden.
   *
   * Wer sich abmeldet, will nicht, dass sein Papier noch eine halbe Stunde
   * gilt. Der Verbindungsabriss geht diesen Weg ausdrücklich **nicht**: dort
   * soll die Karte liegenbleiben, das ist der ganze Zweck der Frist.
   */
  verwirf(token: string): void {
    this.karten.delete(token);
  }

  /** Wirft ab, was abgelaufen ist. Sonst wächst der Stapel ohne Ende. */
  private raeume(jetzt: number): void {
    for (const [token, karte] of this.karten) {
      if (karte.gueltigBis < jetzt) this.karten.delete(token);
    }
  }

  get anzahl(): number {
    return this.karten.size;
  }
}
