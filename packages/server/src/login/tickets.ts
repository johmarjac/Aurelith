/**
 * Eintrittskarten.
 *
 * Eine Karte sagt: „dieses Konto hat sich beim Anmeldeserver ausgewiesen".
 * Der Spielserver prüft kein Passwort mehr — er zeigt die Karte beim
 * Anmeldeserver vor und bekommt zurück, zu wem sie gehört. Damit gibt es
 * genau eine Stelle im ganzen System, die Passwörter kennt, egal wie viele
 * Kanäle laufen.
 *
 * Zwei Eigenschaften machen die Karte ungefährlich, wenn sie doch einmal
 * mitgelesen wird:
 *
 *   **Kurzlebig.** Zwei Minuten reichen, um sich einen Kanal auszusuchen.
 *   **Einmalig.** Sie wird beim Vorzeigen verbraucht. Wer sie abfängt und
 *   zweiter ist, hält ein wertloses Stück Text in der Hand.
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

const GUELTIG_MS = 120_000;

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
      gueltigBis: jetzt + GUELTIG_MS,
    });
    return token;
  }

  /**
   * Löst eine Karte ein. Danach ist sie weg — auch bei einer abgelaufenen.
   *
   * Gibt zurück, zu wem sie gehörte, oder nichts.
   */
  loeseEin(
    token: string,
    jetzt = Date.now(),
  ): { accountId: number; accountName: string; accessLevel: string } | undefined {
    const karte = this.karten.get(token);
    if (!karte) return undefined;
    this.karten.delete(token);
    if (karte.gueltigBis < jetzt) return undefined;
    return {
      accountId: karte.accountId,
      accountName: karte.accountName,
      accessLevel: karte.accessLevel,
    };
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
