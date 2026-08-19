/**
 * Freundschaften: anfragen, annehmen, ablehnen, lösen.
 *
 * Der ganze Ablauf steht hier und nicht im `GameServer` — aus demselben Grund
 * wie bei den Befehlen: er lässt sich damit prüfen, ohne einen Server zu
 * starten, und er kann nicht versehentlich an der Welt drehen. Was er vom
 * Server braucht, steht in `FreundeHost` und ist absichtlich schmal.
 *
 * **Jede Absage ist eine Nachricht.** Es gibt in dieser Datei kein stilles
 * `return` auf eine Spieleraktion. Wer anfragt und nichts hört, hält das Spiel
 * für kaputt — und hat damit recht.
 */

import { FreundAktion, encodeFreundAnfrage } from '@aurelith/shared';
import type { Session } from './session.ts';
import type { WeltStore } from './db/index.ts';

/**
 * Wie lange eine Frage offen steht, in Millisekunden.
 *
 * Fünfundvierzig Sekunden: lang genug, um sie zu lesen und einen Kampf zu Ende
 * zu bringen, kurz genug, dass ein vergessenes Fenster nicht den halben Abend
 * blockiert. Eine Frage ohne Frist bliebe für immer stehen, und der Fragende
 * erführe nie, dass niemand hinsieht.
 */
export const ANFRAGE_FRIST_MS = 45_000;

/** Eine offene Frage — beim **Angefragten** geführt, denn dort steht sie im Bild. */
interface OffeneFrage {
  vonId: number;
  vonName: string;
  /** Wen sie erreicht hat. Für die Meldung, wenn niemand antwortet. */
  anName: string;
  bis: number;
}

export interface FreundeHost {
  /** Eine Zeile an den Absender, nur an ihn. */
  systemMessage(session: Session, text: string): void;
  /**
   * Die Sitzung, die gerade mit dieser Figur spielt — oder nichts.
   *
   * „Gerade" heisst: auf diesem Kanal, in der Welt. Ein Kanal weiss nichts von
   * den Sitzungen der anderen, und eine Frage über alle Kanäle wäre ein
   * Netzruf je Anfrage.
   */
  sitzungVonFigur(name: string): Session | undefined;
  /** Steckt diese Figur in einem Kampf? Die Regel steht im Kern. */
  imKampf(session: Session): boolean;
  /** Schickt dieser Sitzung ihre Freundesliste — frisch aus der Datenbank. */
  sendeFreunde(session: Session): void;
  /** Schickt ein fertiges Paket. */
  sende(session: Session, paket: Uint8Array): void;
  /** Die Weltdatenbank dieses Kanals. */
  readonly welt: WeltStore;
}

export class Freunde {
  /**
   * Die offenen Fragen, nach der Kennung des **Angefragten**.
   *
   * Eine je Figur und nicht mehrere: die Frage steht als Ja-Nein vor dem Bild,
   * und zwei davon übereinander wären zwei Knöpfe, von denen niemand weiss,
   * zu welcher Frage sie gehören. Wer schon gefragt wird, bekommt keine
   * zweite Frage — der zweite Fragende hört das und kann es später erneut
   * versuchen.
   */
  private readonly offen = new Map<number, OffeneFrage>();

  constructor(private readonly host: FreundeHost) {}

  /** Der Einstieg vom Protokoll her. Eine Stelle, vier Arten. */
  async behandle(session: Session, aktion: number, name: string): Promise<void> {
    const roh = name.trim();
    if (roh.length === 0) {
      this.host.systemMessage(session, 'Dafür fehlt ein Name.');
      return;
    }
    switch (aktion) {
      case FreundAktion.Anfragen:
        await this.anfragen(session, roh);
        return;
      case FreundAktion.Annehmen:
        await this.antworte(session, roh, true);
        return;
      case FreundAktion.Ablehnen:
        await this.antworte(session, roh, false);
        return;
      case FreundAktion.Entfernen:
        await this.entfernen(session, roh);
        return;
      default:
        // Ein Client, der eine Art schickt, die es nicht gibt. Kein Kick — aber
        // auch keine Stille: wer das sieht, hat einen Fehler in seinem Client.
        this.host.systemMessage(session, 'Diese Art von Freundschaftsaktion gibt es nicht.');
    }
  }

  /**
   * Räumt abgelaufene Fragen weg und sagt beiden Seiten Bescheid.
   *
   * Aus dem Tick gerufen. Kein eigener Zeitgeber je Frage: hundert Fragen
   * wären hundert Zeitgeber, und der Tick läuft ohnehin.
   */
  verfalle(jetzt: number): void {
    for (const [anId, frage] of this.offen) {
      if (frage.bis > jetzt) continue;
      this.offen.delete(anId);
      const frager = this.host.sitzungVonFigur(frage.vonName);
      if (frager) {
        this.host.systemMessage(frager, `Keine Antwort auf deine Anfrage an ${frage.anName}.`);
      }
    }
  }

  /**
   * Vergisst, was zu dieser Sitzung gehört — beim Abmelden.
   *
   * Ohne das bliebe die Frage an eine Figur stehen, die nicht mehr da ist, und
   * blockierte deren nächste Anmeldung für eine neue Frage.
   */
  vergiss(session: Session): void {
    const id = session.character?.id;
    if (id !== undefined) this.offen.delete(id);
    // Und die Fragen, die **von** dieser Sitzung ausgingen: der Angefragte
    // soll nicht auf jemanden antworten, der längst weg ist.
    const name = session.character?.name.toLowerCase();
    if (name === undefined) return;
    for (const [anId, frage] of this.offen) {
      if (frage.vonName.toLowerCase() === name) this.offen.delete(anId);
    }
  }

  // -------------------------------------------------------------------------

  private async anfragen(session: Session, name: string): Promise<void> {
    const eigen = session.character;
    if (!eigen) return;

    if (name.toLowerCase() === eigen.name.toLowerCase()) {
      this.host.systemMessage(session, 'Mit sich selbst befreundet zu sein ist keine Freundschaft.');
      return;
    }

    /*
     * Erst nachsehen, ob es die Figur überhaupt gibt, dann, ob sie spielt.
     *
     * Zwei getrennte Absagen, weil sie zwei verschiedene Dinge bedeuten: „den
     * Namen gibt es hier nicht" heisst vertippt, „spielt gerade nicht" heisst
     * später noch einmal. Eine gemeinsame Absage liesse einen raten, welches
     * von beidem gemeint ist.
     */
    const figur = await this.host.welt.findCharacterByName(name);
    if (!figur) {
      this.host.systemMessage(session, `Eine Figur „${name}" gibt es auf diesem Kanal nicht.`);
      return;
    }

    const schonFreund = (await this.host.welt.listFriends(eigen.id)).some((f) => f.id === figur.id);
    if (schonFreund) {
      this.host.systemMessage(session, `${figur.name} steht schon in deiner Freundesliste.`);
      return;
    }

    const ziel = this.host.sitzungVonFigur(figur.name);
    if (!ziel) {
      this.host.systemMessage(session, `${figur.name} spielt gerade nicht.`);
      return;
    }

    if (this.host.imKampf(ziel)) {
      this.host.systemMessage(
        session,
        `${figur.name} ist gerade im Kampf — die Anfrage ging nicht raus.`,
      );
      return;
    }

    const laeuft = this.offen.get(figur.id);
    if (laeuft && laeuft.bis > Date.now()) {
      this.host.systemMessage(session, `${figur.name} wird gerade schon gefragt.`);
      return;
    }

    this.offen.set(figur.id, {
      vonId: eigen.id,
      vonName: eigen.name,
      anName: figur.name,
      bis: Date.now() + ANFRAGE_FRIST_MS,
    });
    this.host.sende(ziel, encodeFreundAnfrage(eigen.name, ANFRAGE_FRIST_MS));
    this.host.systemMessage(session, `Deine Anfrage ist bei ${figur.name}.`);
  }

  private async antworte(session: Session, vonName: string, ja: boolean): Promise<void> {
    const eigen = session.character;
    if (!eigen) return;

    const frage = this.offen.get(eigen.id);
    if (!frage) {
      this.host.systemMessage(session, 'Es steht gerade keine Anfrage offen.');
      return;
    }
    /*
     * Der Name muss passen.
     *
     * Sonst beantwortete eine verspätete Antwort die **nächste** Frage: wer
     * eine Anfrage ablehnt und im selben Moment eine zweite bekommt, hätte
     * damit ungewollt auch die zweite abgelehnt.
     */
    if (frage.vonName.toLowerCase() !== vonName.toLowerCase()) {
      this.host.systemMessage(session, `${vonName} fragt dich gerade nicht.`);
      return;
    }
    this.offen.delete(eigen.id);

    const frager = this.host.sitzungVonFigur(frage.vonName);

    if (!ja) {
      this.host.systemMessage(session, `Anfrage von ${frage.vonName} abgelehnt.`);
      if (frager) {
        this.host.systemMessage(frager, `${eigen.name} hat deine Anfrage abgelehnt.`);
      }
      return;
    }

    await this.host.welt.addFriend(eigen.id, frage.vonId);
    this.host.systemMessage(session, `${frage.vonName} steht jetzt in deiner Freundesliste.`);
    this.host.sendeFreunde(session);
    if (frager) {
      this.host.systemMessage(frager, `${eigen.name} steht jetzt in deiner Freundesliste.`);
      this.host.sendeFreunde(frager);
    }
  }

  private async entfernen(session: Session, name: string): Promise<void> {
    const eigen = session.character;
    if (!eigen) return;

    const freunde = await this.host.welt.listFriends(eigen.id);
    const treffer = freunde.find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (!treffer) {
      this.host.systemMessage(session, `${name} steht nicht in deiner Freundesliste.`);
      return;
    }

    /*
     * Beidseitig — und das ist die eigentliche Aussage dieser Zeile.
     *
     * Wer jemanden aus seiner Liste nimmt, verschwindet auch aus dessen Liste.
     * Alles andere wäre eine Freundschaft, die nur einer von beiden sieht: der
     * eine wundert sich, warum der andere weg ist, der andere weiss von
     * nichts, und keiner von beiden kann es aufklären.
     */
    await this.host.welt.removeFriend(eigen.id, treffer.id);
    this.host.systemMessage(session, `${treffer.name} ist nicht mehr in deiner Freundesliste.`);
    this.host.sendeFreunde(session);

    const andere = this.host.sitzungVonFigur(treffer.name);
    if (andere) {
      this.host.systemMessage(andere, `${eigen.name} hat die Freundschaft gelöst.`);
      this.host.sendeFreunde(andere);
    }
  }
}
