/**
 * Der Anmeldeserver.
 *
 * Er kennt Konten und Kanäle — und sonst nichts. Keine Welt, kein Kern, keine
 * Karten: wer hier verbunden ist, hat noch keine Figur, und wer eine hat, ist
 * längst woanders.
 *
 * Der Ablauf für einen Spieler:
 *
 *   1. `Hello` — Protokollfassung abgleichen, wie überall.
 *   2. `Login` oder `CreateAccount` — hier und nur hier werden Passwörter
 *      geprüft. Es gibt weltweit einen Anmeldeserver; egal wie viele Kanäle
 *      laufen, es bleibt bei dieser einen Stelle.
 *   3. `Realms` zurück: die Liste der Server mit ihren Kanälen — und eine
 *      Eintrittskarte.
 *   4. Der Client sucht sich einen Kanal aus, verbindet sich **dorthin** und
 *      zeigt die Karte vor. Diese Verbindung hier wird dann nicht mehr
 *      gebraucht.
 *
 * Und für einen Spielserver: er meldet sich über die internen Wege an
 * (`internal.ts`) und schickt Lebenszeichen. Der Anmeldeserver ruft ihn nie
 * von sich aus — er weiss nicht, wo die Spielserver stehen, sondern nur, was
 * sie über sich gesagt haben. Das ist der Grund, warum ein neuer Kanal ohne
 * Änderung am Anmeldeserver dazukommt.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import {
  ClientOp,
  FrameError,
  FrameSequencer,
  KickReason,
  PROTOCOL_VERSION,
  CipherSuite,
  accessFromName,
  decodeCredentials,
  decodeSocialLogin,
  decodeFrame,
  decodeHello,
  encodeFrame,
  encodeKick,
  encodeLobbyError,
  encodeRealms,
  encodeServerVersion,
  formatBuild,
  nullCipher,
  readPacket,
  type PacketCipher,
} from '@aurelith/shared';
import { anmelden } from '../accounts.ts';
import { loginConfig } from './config.ts';
import type { AccountRecord, KontoStore } from '../db/index.ts';
import type { KanalRegister } from './registry.ts';
import type { Kartenstapel } from './tickets.ts';

/** So viele Fehlversuche verträgt eine Verbindung, dann fliegt sie. */
const MAX_LOGIN_ATTEMPTS = 6;

/**
 * Eine Verbindung zum Anmeldeserver.
 *
 * Viel kleiner als die Sitzung im Spielserver, und das ist keine Sparsamkeit:
 * hier gibt es keine Figur, keinen Beutel und keine Eingaben. Was fehlt, kann
 * auch nicht auseinanderlaufen.
 */
class LoginSitzung {
  angemeldet = false;
  accountId = 0;
  accountName = '';
  /** Zugriffsstufe als Wort. Geht mit jeder Eintrittskarte an den Kanal. */
  accessLevel = 'player';
  versuche = 0;
  gegruesst = false;
  offen = true;

  private readonly txSeq = new FrameSequencer();
  private readonly suite = new CipherSuite();
  private cipher: PacketCipher = nullCipher;

  constructor(
    readonly id: number,
    private readonly ws: WebSocket,
  ) {}

  get cipherSuite(): CipherSuite {
    return this.suite;
  }

  /**
   * Ein Paket, ein Frame.
   *
   * Anders als im Spiel wird hier nichts gesammelt: es gibt keinen Tick, in
   * dem sich etwas sammeln könnte, und die paar Pakete einer Anmeldung sind
   * einzeln unterwegs schnell genug.
   */
  send(paket: Uint8Array): void {
    if (!this.offen || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(encodeFrame([paket], this.txSeq.next(), this.cipher));
  }

  close(code = 1000, grund = ''): void {
    if (!this.offen) return;
    this.offen = false;
    try {
      this.ws.close(code, grund);
    } catch {
      // Schon zu.
    }
  }
}

export class LoginServer {
  private readonly sitzungen = new Set<LoginSitzung>();
  private naechsteId = 1;

  constructor(
    private readonly store: KontoStore,
    private readonly register: KanalRegister,
    private readonly karten: Kartenstapel,
    /**
     * Anmeldekarten aus dem Anbieterweg.
     *
     * Ein zweiter Stapel und nicht derselbe: die Eintrittskarte öffnet einen
     * **Kanal**, diese hier öffnet eine **Anmeldung**. Aus einem Stapel
     * könnte eine Karte, die für das eine gedacht war, das andere aufsperren.
     */
    private readonly anmeldekarten: Kartenstapel,
  ) {}

  start(httpServer: Server): void {
    const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    wss.on('connection', (ws) => this.onVerbindung(ws));
  }

  private onVerbindung(ws: WebSocket): void {
    const sitzung = new LoginSitzung(this.naechsteId++, ws);
    this.sitzungen.add(sitzung);

    ws.binaryType = 'nodebuffer';
    ws.on('message', (data: Buffer) => {
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      try {
        const frame = decodeFrame(bytes, sitzung.cipherSuite);
        for (const roh of frame.packets) {
          const { opcode, reader } = readPacket(roh);
          void this.onPaket(sitzung, opcode, reader);
        }
      } catch (err) {
        // Ein unlesbarer Rahmen ist hier immer das Ende: es gibt nichts zu
        // retten, und wer nicht sprechen kann, kann sich auch nicht anmelden.
        const code = err instanceof FrameError ? err.code : 'unbekannt';
        console.warn(`[anmelde ${sitzung.id}] Rahmen nicht lesbar: ${code}`);
        sitzung.send(encodeKick(KickReason.BadFrame, code));
        sitzung.close(1002, code);
      }
    });

    const weg = (): void => {
      sitzung.offen = false;
      this.sitzungen.delete(sitzung);
    };
    ws.on('close', weg);
    ws.on('error', weg);
  }

  private async onPaket(
    sitzung: LoginSitzung,
    opcode: number,
    reader: Parameters<typeof decodeCredentials>[0],
  ): Promise<void> {
    switch (opcode) {
      case ClientOp.Hello: {
        const hello = decodeHello(reader);
        if (hello.protocolVersion !== PROTOCOL_VERSION) {
          sitzung.send(
            encodeKick(
              KickReason.ProtocolMismatch,
              `Protokoll ${hello.protocolVersion} passt nicht zu ${PROTOCOL_VERSION}.`,
            ),
          );
          sitzung.close(1002, 'protokoll');
          return;
        }
        sitzung.gegruesst = true;
        return;
      }

      case ClientOp.Login:
        await this.onAnmeldung(sitzung, decodeCredentials(reader), false);
        return;

      case ClientOp.CreateAccount:
        await this.onAnmeldung(sitzung, decodeCredentials(reader), true);
        return;

      case ClientOp.SocialLogin:
        await this.onAnbieterkarte(sitzung, decodeSocialLogin(reader).code);
        return;

      case ClientOp.RealmList:
        // Eine neue Liste heisst eine neue Karte: die alte ist verbraucht,
        // sobald man einen Kanal betreten hat. Wer zurückkommt und wechseln
        // will, holt sich hier eine frische.
        if (sitzung.angemeldet) this.schickeListe(sitzung);
        return;

      case ClientOp.VersionRequest:
        sitzung.send(encodeServerVersion(loginConfig.build));
        return;

      default:
        // Alles Weitere gehört zum Spiel und nicht hierher. Verwerfen und
        // nicht kicken: ein Client, der ein Paket zu früh schickt, ist kein
        // Angreifer.
        return;
    }
  }

  /**
   * Eine Anmeldekarte aus dem Anbieterweg einlösen.
   *
   * Der kurze Weg: die Karte **ist** der Ausweis. Wer sie hat, hat vorher bei
   * Google gestanden — das hat der HTTP-Teil dieses Servers geprüft, bevor er
   * sie ausgestellt hat. Hier bleibt nur, sie einzulösen und dasselbe zu tun
   * wie am Ende einer Passwortanmeldung.
   *
   * Deshalb steht der gemeinsame Teil in `uebernehmeKonto` und nicht zweimal
   * da: „ein Konto, eine Sitzung" und die Serverliste gelten unabhängig davon,
   * wie sich jemand ausgewiesen hat.
   */
  private async onAnbieterkarte(sitzung: LoginSitzung, code: string): Promise<void> {
    if (!sitzung.offen || sitzung.angemeldet) return;

    const karte = this.anmeldekarten.loeseEin(code);
    if (!karte) {
      sitzung.send(
        encodeLobbyError('Die Anmeldung ist abgelaufen. Versuch es noch einmal.'),
      );
      return;
    }

    await this.uebernehmeKonto(sitzung, {
      id: karte.accountId,
      name: karte.accountName,
      accessLevel: karte.accessLevel,
      passwordHash: '',
    });
  }

  private async onAnmeldung(
    sitzung: LoginSitzung,
    daten: { name: string; password: string },
    anlegenWollen: boolean,
  ): Promise<void> {
    if (!sitzung.offen || sitzung.angemeldet) return;

    if (sitzung.versuche >= MAX_LOGIN_ATTEMPTS) {
      sitzung.send(encodeKick(KickReason.AuthFailed, 'Zu viele Fehlversuche.'));
      sitzung.close(1008, 'auth');
      return;
    }
    sitzung.versuche++;

    const ergebnis = await anmelden(
      this.store,
      daten.name,
      daten.password,
      anlegenWollen,
      loginConfig.zugriff,
    );
    if (!ergebnis.ok) {
      sitzung.send(encodeLobbyError(ergebnis.fehler));
      return;
    }

    await this.uebernehmeKonto(sitzung, ergebnis.account);
  }

  /**
   * Der gemeinsame Schluss jeder Anmeldung — mit Passwort wie mit Anbieter.
   *
   * Was danach kommt, hängt nicht mehr davon ab, wie sich jemand ausgewiesen
   * hat: die Sperre „ein Konto, eine Sitzung" gilt für beide, und die
   * Serverliste sieht für beide gleich aus.
   */
  private async uebernehmeKonto(sitzung: LoginSitzung, konto: AccountRecord): Promise<void> {
    /*
     * Ein Konto, eine Sitzung — über **alle** Kanäle hinweg.
     *
     * Diese Prüfung sitzt hier und nicht im Spielserver, weil sie sonst je
     * Kanal gälte: man könnte sich auf Kanal 1 und Kanal 2 gleichzeitig
     * anmelden, und beide Kanäle hätten recht. Der Anmeldeserver ist die
     * einzige Stelle, die alle Kanäle kennt.
     *
     * Die zweite Anmeldung wird abgewiesen, die bestehende bleibt. Andersherum
     * — die ältere fliegt — ist die gefährlichere Richtung: wer das Passwort
     * kennt, könnte den Spieler damit jederzeit aus der Welt werfen.
     */
    const wo = this.register.wo(konto.id);
    if (wo !== undefined) {
      sitzung.send(
        encodeLobbyError(
          `Dieses Konto spielt gerade auf ${wo}. Nach einem Verbindungsabbruch ` +
            'dauert es einen Moment, bis es wieder frei ist.',
        ),
      );
      // Kein Fehlversuch: das Passwort stimmte.
      sitzung.versuche--;
      return;
    }

    sitzung.angemeldet = true;
    sitzung.accountId = konto.id;
    sitzung.accountName = konto.name;
    sitzung.accessLevel = konto.accessLevel;
    sitzung.versuche = 0;
    await this.store.touchLogin(konto.id);

    console.log(
      `[konto] ${konto.name} angemeldet (${konto.accessLevel}, Stufe ` +
        `${accessFromName(konto.accessLevel)})`,
    );
    this.schickeListe(sitzung);
  }

  /** Die Serverliste samt frischer Eintrittskarte. */
  private schickeListe(sitzung: LoginSitzung): void {
    const ticket = this.karten.stelleAus(
      sitzung.accountId,
      sitzung.accountName,
      sitzung.accessLevel,
    );
    sitzung.send(encodeRealms({ ticket, realms: this.register.liste() }));
  }

  stop(): void {
    for (const s of this.sitzungen) {
      s.send(encodeKick(KickReason.ServerShutdown, 'Anmeldeserver fährt herunter.'));
      s.close(1001, 'shutdown');
    }
    this.sitzungen.clear();
  }

  /** Für die Startmeldung. */
  get fassung(): string {
    return formatBuild(loginConfig.build);
  }
}
