/**
 * Die Seite des Spielservers zum Anmeldeserver hin.
 *
 * Ein Spielserver ist ein **Kanal**: ein Servername, ein Kanalname, eine
 * Adresse. Beim Hochfahren sagt er das dem Anmeldeserver und wiederholt es
 * danach als Lebenszeichen. Wer aufhört, sagt auch das — und wer abstürzt,
 * fällt nach ein paar verpassten Zeichen von selbst aus der Liste.
 *
 * Umgekehrt ruft der Anmeldeserver nie an. Deshalb braucht dieser Server
 * keinen erreichbaren Verwaltungsweg von aussen: er meldet sich, er fragt, er
 * ist fertig.
 *
 * **Ohne Anmeldeserver läuft er trotzdem.** Ist keine Adresse konfiguriert,
 * ist dieser ganze Kasten still, und der Spielserver prüft Passwörter selbst
 * (siehe `gameServer.onLogin`). Das ist der Alleinbetrieb für Entwicklung und
 * Prüfungen — ein Prozess, ein Befehl, kein Netzwerk dazwischen.
 */

import { config } from './config.ts';

/** Wie oft ein Lebenszeichen geht. Der Anmeldeserver verfällt nach 35 s. */
const HERZSCHLAG_MS = 10_000;

/**
 * Was aus einem `/accesslevel` wurde.
 *
 * `ok: false` heisst „das Konto gibt es nicht" — nicht „der Anmeldeserver war
 * weg". Der zweite Fall kommt als `undefined` zurück, und die beiden sollen
 * sich nicht anfühlen wie derselbe: einmal hat sich jemand vertippt, einmal
 * ist ein Server aus.
 */
export type StufenAuskunft =
  | { ok: false }
  | {
      ok: true;
      /** Wie das Konto wirklich heisst — Grossschreibung wie in der Datenbank. */
      name: string;
      vorher: string;
      nachher: string;
      /** Steht der Name in `AURELITH_ADMINS`? Dann gewinnt sie beim nächsten Mal. */
      inListe: boolean;
    };

export interface TicketAuskunft {
  accountId: number;
  accountName: string;
  /**
   * Zugriffsstufe als Wort — siehe `ACCESS_NAMES` im geteilten Paket.
   *
   * Sie steht am Konto, also in der Masterdatenbank, die dieser Prozess nicht
   * kennt. Deshalb reist sie mit der Karte: der Anmeldeserver hat sie beim
   * Anmelden ohnehin in der Hand.
   */
  accessLevel: string;
}

export class LoginClient {
  private timer?: ReturnType<typeof setInterval>;
  /** Wie viele gerade spielen — vom Spielserver gesetzt, vom Herzschlag gelesen. */
  private online = 0;
  /**
   * Stand der Verbindung zum Anmeldeserver.
   *
   * Nur zum Protokollieren: gemeldet wird beim ersten Erfolg und beim ersten
   * Fehlschlag danach. Ohne diese Merke füllt ein abgeschalteter
   * Anmeldeserver das Ausgabefenster mit derselben Zeile alle zehn Sekunden.
   */
  private erreichbar?: boolean;

  get aktiv(): boolean {
    return config.loginUrl !== '';
  }

  /** Meldet den Kanal an und beginnt mit den Lebenszeichen. */
  async start(): Promise<void> {
    if (!this.aktiv) {
      console.warn(
        '[kanal] AURELITH_LOGIN_URL ist nicht gesetzt — Alleinbetrieb.\n' +
          '        Dieser Server prüft Passwörter selbst und steht in keiner Kanalliste.',
      );
      return;
    }

    await this.melde('/intern/register');
    this.timer = setInterval(() => void this.melde('/intern/heartbeat'), HERZSCHLAG_MS);
    // Der Herzschlag darf den Prozess nicht am Leben halten.
    this.timer.unref?.();
  }

  /** Wie viele gerade in diesem Kanal spielen. Geht mit dem nächsten Zeichen raus. */
  setzeOnline(anzahl: number): void {
    this.online = anzahl;
  }

  /**
   * Löst eine Eintrittskarte ein.
   *
   * Gibt zurück, zu wem sie gehört — oder nichts. „Nichts" heisst auch bei
   * einem Netzfehler nichts: eine Karte, deren Echtheit sich nicht klären
   * lässt, wird nicht anerkannt. Alles andere wäre eine Tür, die sich mit
   * einem abgeschalteten Anmeldeserver öffnen lässt.
   */
  async loeseTicket(ticket: string): Promise<TicketAuskunft | undefined> {
    const antwort = await this.ruf('/intern/ticket', { ticket });
    if (!antwort || antwort.ok !== true) return undefined;
    const accountId = Number(antwort.accountId);
    const accountName = String(antwort.accountName ?? '');
    if (!Number.isFinite(accountId) || accountId <= 0 || accountName === '') return undefined;
    // Fehlt die Stufe, gilt die niedrigste. Ein Anmeldeserver, der sie nicht
    // mitschickt, soll niemanden versehentlich zum Verwalter machen.
    const accessLevel = String(antwort.accessLevel ?? 'player');
    return { accountId, accountName, accessLevel };
  }

  /**
   * Meldet ein Konto als spielend oder als weg.
   *
   * Darauf stützt der Anmeldeserver „ein Konto, eine Sitzung" über alle
   * Kanäle hinweg. Fehlschläge werden verschluckt: ein Konto, das
   * fälschlich als frei gilt, ist ein kleineres Übel als ein Spieler, der
   * wegen eines Netzhusters nicht mehr in die Welt kommt.
   *
   * Gibt zurück, wann der Anmeldeserver es zur Kenntnis genommen hat. Beim
   * Trennen interessiert das niemanden — da ist die Leitung ohnehin weg. Beim
   * Abmelden schon: der Client meldet sich unmittelbar danach neu an, und
   * käme er dem hier zuvor, wiese ihn der Anmeldeserver ab.
   */
  async meldeAnwesenheit(accountId: number, drin: boolean): Promise<void> {
    if (!this.aktiv || accountId === 0) return;
    await this.ruf('/intern/anwesend', {
      accountId,
      server: config.serverName,
      channel: config.channelName,
      drin,
    });
  }

  /**
   * Setzt die Zugriffsstufe eines Kontos beim Anmeldeserver — für
   * `/accesslevel`.
   *
   * Dieser Kanal kann das nicht selbst: im Verbund sieht er die Konten nie.
   * Gibt zurück, was der Anmeldeserver dazu gesagt hat, oder nichts, wenn er
   * nicht erreichbar war. „Nichts" heisst hier ausdrücklich nicht „ging schon
   * irgendwie" — der Befehl soll melden, dass er nichts bewirkt hat.
   */
  async setzeStufe(name: string, stufe: string): Promise<StufenAuskunft | undefined> {
    const antwort = await this.ruf('/intern/stufe', { name, stufe });
    if (!antwort) return undefined;
    if (antwort.ok !== true) return { ok: false };
    return {
      ok: true,
      name: String(antwort.name ?? name),
      vorher: String(antwort.vorher ?? ''),
      nachher: String(antwort.nachher ?? stufe),
      inListe: antwort.inListe === true,
    };
  }

  /** Nimmt den Kanal aus der Liste. Beim geordneten Herunterfahren. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (!this.aktiv) return;
    await this.ruf('/intern/abmelden', {
      server: config.serverName,
      channel: config.channelName,
    });
  }

  private async melde(pfad: string): Promise<void> {
    const antwort = await this.ruf(pfad, {
      server: config.serverName,
      channel: config.channelName,
      url: config.publicUrl,
      capacity: config.capacity,
      online: this.online,
    });

    const ok = antwort !== undefined;
    if (ok === this.erreichbar) return;
    this.erreichbar = ok;
    if (ok) {
      console.log(
        `[kanal] Beim Anmeldeserver eingetragen als "${config.serverName} · ` +
          `${config.channelName}" (${config.publicUrl})`,
      );
    } else {
      console.warn(
        `[kanal] Anmeldeserver ${config.loginUrl} antwortet nicht — dieser Kanal ` +
          'steht in keiner Liste, bis er wieder da ist.',
      );
    }
  }

  /**
   * Ein interner Ruf. Gibt den Rumpf zurück oder nichts.
   *
   * Wirft nie: der Spielserver soll weiterlaufen, wenn der Anmeldeserver
   * gerade neu startet. Was daraus folgt, entscheidet der Aufrufer — beim
   * Lebenszeichen ist es eine Zeile im Protokoll, bei einer Eintrittskarte
   * eine Absage.
   */
  private async ruf(pfad: string, body: unknown): Promise<Record<string, unknown> | undefined> {
    try {
      const antwort = await fetch(`${config.loginUrl}${pfad}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-aurelith-secret': config.internalSecret,
        },
        body: JSON.stringify(body),
        // Ein hängender Anmeldeserver darf keinen Spielserver mitnehmen.
        signal: AbortSignal.timeout(5000),
      });
      if (!antwort.ok) return undefined;
      const gelesen: unknown = await antwort.json();
      return typeof gelesen === 'object' && gelesen !== null
        ? (gelesen as Record<string, unknown>)
        : {};
    } catch {
      return undefined;
    }
  }
}
