/**
 * Anmeldung und Charakterverwaltung — alles, was vor der Welt kommt.
 *
 * Eine eigene Datei und nicht ein weiterer Abschnitt in `ui/index.ts`: was
 * hier steht, gilt genau so lange, bis eine Figur die Welt betritt, und danach
 * nie wieder. Die Spieloberfläche kennt es nicht, und es kennt die
 * Spieloberfläche nicht.
 *
 * Die Maske liegt **über** der schon gezeichneten Welt. Der Client lädt Kern,
 * Inhalte und Karte, während hier jemand tippt — wer sich angemeldet hat, ist
 * damit sofort drin, statt erst einen Ladebalken zu sehen.
 *
 * Vier Masken, nicht eine.
 *
 *   `anmeldung` — Konto und Passwort. Schmal, mittig, sonst nichts.
 *   `kanaele`   — Server links, Kanäle rechts. Kommt nur, wenn am anderen Ende
 *                 ein Anmeldeserver hängt; ein Spielserver im Alleinbetrieb
 *                 schickt gleich die Figurenliste.
 *   `figuren`   — die Liste der Figuren dieses Kontos.
 *   `neu`       — eine Figur anlegen.
 *
 * Immer genau eine davon ist sichtbar, und jede hat ihren eigenen Kasten mit
 * eigener Überschrift. Untereinander in einem Kasten war es vorher, und dabei
 * war nie klar, wo die eine Sache aufhört und die nächste anfängt: das
 * Anlegeformular sah aus wie eine weitere Zeile der Liste, und der Kopf des
 * Kastens sagte immer dasselbe.
 */

import { getClass, type LobbyCharacter, type RealmRow, type RealmsMsg } from '@aurelith/shared';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface LobbyStand {
  accountName: string;
  accessLevel: number;
  maxCharacters: number;
  characters: LobbyCharacter[];
}

/**
 * Ist dieser Kanal voll?
 *
 * An einer Stelle, weil die Antwort an zwei Stellen gebraucht wird — beim
 * Sperren einer Zeile und beim Vorwählen. Zwei Abschriften wären zwei
 * Vorstellungen von „voll", und die Vorwahl liefe irgendwann auf einen Kanal,
 * den man nicht betreten kann.
 */
function istVoll(r: RealmRow): boolean {
  return r.capacity > 0 && r.online >= r.capacity;
}

/** Welche der Masken gerade gilt. */
type Seite = 'anmeldung' | 'kanaele' | 'figuren' | 'neu';

export class LobbyView {
  /** Anmelden mit Name und Passwort. */
  onLogin?: (name: string, password: string) => void;
  /** Konto anlegen — Name und Passwort wie beim Anmelden. */
  onCreateAccount?: (name: string, password: string) => void;
  onCreateCharacter?: (name: string) => void;
  onDeleteCharacter?: (characterId: number) => void;
  onEnterWorld?: (characterId: number) => void;
  /**
   * Einen Kanal betreten: Adresse und Eintrittskarte.
   *
   * Was daraus wird, entscheidet das Spiel — die Maske weiss nicht, dass
   * dahinter eine zweite Verbindung aufgebaut wird.
   */
  onEnterChannel?: (url: string, ticket: string) => void;
  /** Die Kanalliste neu holen. Bringt auch eine frische Eintrittskarte mit. */
  onRefreshRealms?: () => void;
  /**
   * Zurück zur Kanalauswahl.
   *
   * Das ist mehr als ein Maskenwechsel: die Verbindung zum Kanal wird
   * beendet und die zum Anmeldeserver neu aufgebaut, denn nur dort gibt es
   * eine neue Eintrittskarte. Was das genau heisst, weiss das Spiel.
   */
  onBackToChannels?: () => void;

  private readonly root: HTMLDivElement;
  private readonly anmeldungSeite: HTMLDivElement;
  private readonly figurenSeite: HTMLDivElement;
  private readonly neuSeite: HTMLDivElement;

  private readonly loginForm: HTMLFormElement;
  private readonly nameInput: HTMLInputElement;
  private readonly passInput: HTMLInputElement;
  private readonly liste: HTMLDivElement;
  private readonly meldung: HTMLParagraphElement;
  private readonly kontoZeile: HTMLParagraphElement;
  private readonly neuForm: HTMLFormElement;
  private readonly neuInput: HTMLInputElement;
  private readonly neuKnopf: HTMLButtonElement;
  private readonly kanaeleSeite: HTMLDivElement;
  private readonly serverListe: HTMLDivElement;
  private readonly kanalListe: HTMLDivElement;
  private readonly kanalKnopf: HTMLButtonElement;
  private readonly kanalWechsel: HTMLButtonElement;
  private readonly woZeile: HTMLParagraphElement;

  /** Was der Anmeldeserver zuletzt gemeldet hat. */
  private realms: RealmRow[] = [];
  /** Die Eintrittskarte zur aktuellen Liste. Leer heisst: keine. */
  private ticket = '';
  /** Welcher Servername links ausgewählt ist. */
  private gewaehlterServer = '';
  /** Welcher Kanal rechts ausgewählt ist — Kanalname innerhalb des Servers. */
  private gewaehlterKanal = '';
  /**
   * Wo man gerade spielt, als fertige Zeile.
   *
   * Leer im Alleinbetrieb: dann gibt es keine Kanäle, und eine Zeile „ · "
   * über der Figurenliste wäre eine Auskunft über nichts.
   */
  private wo = '';

  /** Welche Maske gerade offen ist. Die eine Wahrheit darüber. */
  private seite: Seite = 'anmeldung';

  /** Welche Figur gerade zum Löschen bestätigt werden will. */
  private loeschKandidat = 0;
  /** Der zuletzt gemeldete Stand — für Nachfragen wie „wie heisst Nummer 7?". */
  private stand?: LobbyStand;
  /**
   * Ist dieses Konto angemeldet?
   *
   * Die Maske wird auch dann noch angestossen, wenn längst jemand in der
   * Figurenliste steht: die Verbindungsanzeige meldet mit jedem Pong wieder
   * „verbunden". Ohne diese Merke sprang die Liste im Sekundentakt zurück auf
   * das Anmeldeformular — sichtbar als Knöpfe, die sich nicht drücken liessen.
   */
  private angemeldet = false;
  /**
   * Steht das Anmeldeformular schon?
   *
   * Ohne diese Merke baute sich die Maske jedes Mal neu auf, wenn die
   * Verbindungsanzeige „verbunden" meldete — und das tut sie mit jedem Pong,
   * also im Sekundentakt. Wer ins Passwortfeld tippte, verlor nach ein, zwei
   * Sekunden den Fokus zurück ins Namensfeld.
   */
  private formularSteht = false;

  constructor(host: HTMLElement) {
    this.root = el('div', 'lobby');
    this.root.hidden = true;

    // Die Meldung gehört keiner Maske: sie wandert zu der, die gerade offen
    // ist. Eine je Maske wären drei Stellen, an denen dieselbe Absage stehen
    // kann — und zwei davon wären beim Lesen die falsche.
    this.meldung = el('p', 'lobby-meldung', '');
    this.meldung.hidden = true;

    // --- Maske 1: Anmelden -------------------------------------------------
    this.anmeldungSeite = el('div', 'lobby-box panel lobby-anmeldung');
    this.anmeldungSeite.append(
      el('h1', 'lobby-titel', 'Aurelith'),
      el('p', 'lobby-unter', 'Melde dich an oder leg ein Konto an.'),
    );

    this.loginForm = el('form', 'lobby-form');
    this.nameInput = el('input', 'lobby-input');
    this.nameInput.type = 'text';
    this.nameInput.placeholder = 'Kontoname';
    this.nameInput.autocomplete = 'username';
    this.nameInput.maxLength = 16;
    this.passInput = el('input', 'lobby-input');
    this.passInput.type = 'password';
    this.passInput.placeholder = 'Passwort';
    this.passInput.autocomplete = 'current-password';
    this.passInput.maxLength = 64;

    const anmelden = el('button', 'btn btn-gross', 'Anmelden');
    anmelden.type = 'submit';
    const anlegen = el('button', 'btn', 'Konto anlegen');
    anlegen.type = 'button';

    const knoepfe = el('div', 'lobby-knoepfe');
    knoepfe.append(anmelden, anlegen);
    this.loginForm.append(this.nameInput, this.passInput, knoepfe);

    // Absenden über das Formular und nicht über den Knopf: dann tut die
    // Eingabetaste dasselbe wie der Klick, und auf dem Telefon erscheint auf
    // der Tastatur „Los" statt eines Zeilenumbruchs.
    this.loginForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      this.onLogin?.(this.nameInput.value.trim(), this.passInput.value);
    });
    anlegen.addEventListener('click', () => {
      this.onCreateAccount?.(this.nameInput.value.trim(), this.passInput.value);
    });
    this.anmeldungSeite.appendChild(this.loginForm);

    // --- Maske 2: Figuren --------------------------------------------------
    this.figurenSeite = el('div', 'lobby-box panel lobby-auswahl');
    this.figurenSeite.hidden = true;
    this.kontoZeile = el('p', 'lobby-konto', '');
    this.liste = el('div', 'lobby-liste');

    const zurNeu = el('button', 'btn btn-gross', '＋ Neue Figur');
    zurNeu.type = 'button';
    zurNeu.addEventListener('click', () => this.zeigeSeite('neu'));

    // Der Weg zurück zur Kanalauswahl. Sichtbar nur, wenn es überhaupt eine
    // gab — im Alleinbetrieb führte er ins Leere.
    this.kanalWechsel = el('button', 'btn', 'Kanal wechseln');
    this.kanalWechsel.type = 'button';
    // Der Weg zurück führt über den Anmeldeserver, und der kennt diese
    // Verbindung nicht mehr — die Eintrittskarte war einmalig. Also noch
    // einmal anmelden. Das steht am Knopf, damit es niemanden überrascht.
    this.kanalWechsel.title = 'Zurück zur Kanalauswahl — mit erneuter Anmeldung.';
    this.kanalWechsel.hidden = true;
    this.kanalWechsel.addEventListener('click', () => this.onBackToChannels?.());

    const figurenKnoepfe = el('div', 'lobby-knoepfe');
    figurenKnoepfe.append(zurNeu, this.kanalWechsel);

    // Wo man ist — Server und Kanal, über der Liste. Die Figuren gehören zum
    // **Server**: auf einem anderen sind es andere.
    this.woZeile = el('p', 'lobby-wo', '');
    this.woZeile.hidden = true;

    this.figurenSeite.append(
      el('h1', 'lobby-titel', 'Deine Figuren'),
      this.woZeile,
      this.kontoZeile,
      this.liste,
      figurenKnoepfe,
    );
    // Der Knopf wird ausgeblendet, wenn das Konto voll ist — gemerkt, damit
    // `setStand` ihn wiederfindet, ohne im DOM zu suchen.
    this.neuKnopf = zurNeu;

    // --- Maske 2b: Server und Kanal ---------------------------------------
    //
    // Zwei Spalten: links, welcher Server — rechts, welcher Kanal darin. Das
    // ist keine Zierde, sondern die Form der Sache: ein Kanal gehört immer zu
    // genau einem Server, und eine einzige lange Liste aus „Aurelith · Kanal
    // 1", „Aurelith · Kanal 2" würde diese Zugehörigkeit in jeder Zeile
    // wiederholen, statt sie einmal zu zeigen.
    this.kanaeleSeite = el('div', 'lobby-box panel lobby-kanaele');
    this.kanaeleSeite.hidden = true;
    this.serverListe = el('div', 'kanal-spalte');
    this.kanalListe = el('div', 'kanal-spalte');

    const spalten = el('div', 'kanal-spalten');
    const linkeSpalte = el('div', 'kanal-seite');
    linkeSpalte.append(el('h2', 'kanal-titel', 'Server'), this.serverListe);
    const rechteSpalte = el('div', 'kanal-seite');
    rechteSpalte.append(el('h2', 'kanal-titel', 'Kanal'), this.kanalListe);
    spalten.append(linkeSpalte, rechteSpalte);

    this.kanalKnopf = el('button', 'btn btn-gross', 'Betreten');
    this.kanalKnopf.type = 'button';
    this.kanalKnopf.addEventListener('click', () => this.betreteKanal());
    const neuLaden = el('button', 'btn', 'Liste neu laden');
    neuLaden.type = 'button';
    neuLaden.addEventListener('click', () => this.onRefreshRealms?.());

    const kanalKnoepfe = el('div', 'lobby-knoepfe');
    kanalKnoepfe.append(this.kanalKnopf, neuLaden);
    this.kanaeleSeite.append(
      el('h1', 'lobby-titel', 'Welt betreten'),
      el('p', 'lobby-unter', 'Wähle einen Server und darin einen Kanal.'),
      spalten,
      kanalKnoepfe,
    );

    // --- Maske 3: Figur anlegen -------------------------------------------
    this.neuSeite = el('div', 'lobby-box panel lobby-neu');
    this.neuSeite.hidden = true;

    this.neuForm = el('form', 'lobby-form');
    this.neuInput = el('input', 'lobby-input');
    this.neuInput.type = 'text';
    this.neuInput.placeholder = 'Name der Figur';
    this.neuInput.maxLength = 16;

    const anlegenKnopf = el('button', 'btn btn-gross', 'Figur anlegen');
    anlegenKnopf.type = 'submit';
    const zurueck = el('button', 'btn', 'Zurück');
    zurueck.type = 'button';
    zurueck.addEventListener('click', () => this.zeigeSeite('figuren'));

    const neuKnoepfe = el('div', 'lobby-knoepfe');
    neuKnoepfe.append(anlegenKnopf, zurueck);

    this.neuForm.append(
      this.neuInput,
      // Kein Beruf an dieser Stelle: den lernt man ab Stufe 15 beim
      // Kampfmeister. Wer ihn hier wählte, entschiede über Fertigkeiten, von
      // denen er noch keine gesehen hat.
      el('p', 'lobby-unter', 'Deinen Beruf lernst du später im Spiel — ab Stufe 15.'),
      neuKnoepfe,
    );
    this.neuForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const name = this.neuInput.value.trim();
      if (name.length === 0) return;
      this.onCreateCharacter?.(name);
      this.neuInput.value = '';
      // Zurück zur Liste: die Antwort des Servers ist ein neuer Stand, und der
      // gehört dorthin. Bleibt man stehen, sieht man den Erfolg nicht.
      this.zeigeSeite('figuren');
    });

    this.neuSeite.append(el('h1', 'lobby-titel', 'Neue Figur'), this.neuForm);

    this.root.append(this.anmeldungSeite, this.kanaeleSeite, this.figurenSeite, this.neuSeite);
    host.appendChild(this.root);
    this.zeigeSeite('anmeldung');
  }

  /**
   * Schaltet auf eine der drei Masken um.
   *
   * Genau eine ist sichtbar. Die Meldung wandert mit — sie steht unter der
   * Überschrift der Maske, zu der sie gehört, und nicht in einer, die man
   * gerade verlassen hat.
   */
  private zeigeSeite(seite: Seite): void {
    this.seite = seite;
    this.anmeldungSeite.hidden = seite !== 'anmeldung';
    this.kanaeleSeite.hidden = seite !== 'kanaele';
    this.figurenSeite.hidden = seite !== 'figuren';
    this.neuSeite.hidden = seite !== 'neu';

    const kasten =
      seite === 'anmeldung'
        ? this.anmeldungSeite
        : seite === 'kanaele'
          ? this.kanaeleSeite
          : seite === 'figuren'
            ? this.figurenSeite
            : this.neuSeite;
    // Nach der Überschrift, vor allem anderen.
    kasten.insertBefore(this.meldung, kasten.children[1] ?? null);

    if (seite === 'neu') this.neuInput.focus();
  }

  /**
   * Zeigt die Maske.
   *
   * Darf beliebig oft gerufen werden und tut dann auch nichts weiter: der
   * Aufrufer sieht nur „die Leitung steht" und nicht, ob das eine Neuigkeit
   * ist. Wer schon angemeldet ist, bleibt bei seinen Figuren; wer schon vor
   * dem Formular sitzt, behält Eingabe und Fokus. Zurück auf das Formular geht
   * es erst nach `zuruecksetzen`, also wenn die Verbindung wirklich weg war.
   */
  zeigeAnmeldung(): void {
    this.root.hidden = false;
    if (this.angemeldet || this.formularSteht) return;
    this.formularSteht = true;
    this.zeigeSeite('anmeldung');
    this.nameInput.focus();
  }

  /**
   * Übernimmt die Server- und Kanalliste des Anmeldeservers.
   *
   * Kommt an derselben Stelle an, an der im Alleinbetrieb `setStand` käme:
   * beides ist die Antwort auf eine erfolgreiche Anmeldung, und welche der
   * beiden kommt, entscheidet die Gegenstelle. Der Client fragt nicht danach.
   */
  zeigeKanaele(msg: RealmsMsg): void {
    this.realms = msg.realms;
    this.ticket = msg.ticket;
    this.angemeldet = true;
    this.formularSteht = false;
    this.root.hidden = false;
    this.zeigeFehler('');

    // Die bisherige Wahl behalten, wenn es sie noch gibt: die Liste wird auch
    // neu geladen, während man davorsitzt, und eine Auswahl, die dabei
    // wegspringt, macht das Neuladen unbrauchbar.
    if (!this.realms.some((r) => r.server === this.gewaehlterServer)) {
      this.gewaehlterServer = this.realms[0]?.server ?? '';
      this.gewaehlterKanal = '';
    }
    this.baueKanalListen();
    this.zeigeSeite('kanaele');
  }

  /** Die beiden Spalten neu aufbauen. Aus `realms` und der aktuellen Wahl. */
  private baueKanalListen(): void {
    // Servernamen in der Reihenfolge, in der sie in der Liste stehen: die
    // kommt sortiert vom Anmeldeserver, und eine zweite Sortierung hier wäre
    // eine zweite Meinung darüber, wie die Liste aussieht.
    const server: string[] = [];
    for (const r of this.realms) if (!server.includes(r.server)) server.push(r.server);

    this.serverListe.replaceChildren(
      ...server.map((name) => {
        const kanaele = this.realms.filter((r) => r.server === name);
        const leute = kanaele.reduce((summe, r) => summe + r.online, 0);
        const knopf = el('button', 'kanal-zeile');
        knopf.type = 'button';
        knopf.dataset.gewaehlt = name === this.gewaehlterServer ? '1' : '0';
        knopf.append(
          el('span', 'kanal-name', name),
          el('span', 'kanal-info', `${kanaele.length} Kanäle · ${leute} online`),
        );
        knopf.addEventListener('click', () => {
          this.gewaehlterServer = name;
          this.gewaehlterKanal = '';
          this.baueKanalListen();
        });
        return knopf;
      }),
    );

    const kanaele = this.realms.filter((r) => r.server === this.gewaehlterServer);

    /*
     * Den ersten freien Kanal vorwählen.
     *
     * Ohne das steht die Maske mit einem Knopf da, der nichts tut: „Betreten"
     * ist gesperrt, solange nichts gewählt ist, und ein gesperrter Knopf, den
     * man drückt, meldet nichts — er tut einfach nichts. Genau so ist es
     * gewesen, und niemand konnte daran erkennen, dass noch eine Wahl fehlt.
     *
     * Der erste **freie**: einen vollen vorzuwählen führte auf denselben
     * toten Knopf.
     */
    if (!kanaele.some((r) => r.channel === this.gewaehlterKanal)) {
      const frei = kanaele.find((r) => !istVoll(r)) ?? kanaele[0];
      this.gewaehlterKanal = frei?.channel ?? '';
    }

    if (kanaele.length === 0) {
      this.kanalListe.replaceChildren(
        el('p', 'lobby-leer', 'Kein Kanal ist gerade erreichbar.'),
      );
    } else {
      this.kanalListe.replaceChildren(
        ...kanaele.map((r) => {
          const knopf = el('button', 'kanal-zeile');
          knopf.type = 'button';
          // Die Adresse steht im Hinweis und nicht in der Zeile: sie ist lang
          // und interessiert genau dann, wenn etwas nicht geht — dann aber
          // sofort, ohne Umweg über die Konsole.
          knopf.title = r.url;
          knopf.dataset.gewaehlt = r.channel === this.gewaehlterKanal ? '1' : '0';
          // Voll heisst voll: der Knopf bleibt lesbar, lässt sich aber nicht
          // drücken. Ihn wegzulassen wäre schlechter — dann fehlte der Kanal
          // in der Liste, und niemand wüsste, dass es ihn gibt.
          const voll = istVoll(r);
          knopf.disabled = voll;
          knopf.append(
            el('span', 'kanal-name', r.channel),
            el(
              'span',
              'kanal-info',
              voll
                ? `voll (${r.online}/${r.capacity})`
                : r.capacity > 0
                  ? `${r.online}/${r.capacity} online`
                  : `${r.online} online`,
            ),
          );
          knopf.addEventListener('click', () => {
            this.gewaehlterKanal = r.channel;
            this.baueKanalListen();
          });
          return knopf;
        }),
      );
    }

    this.kanalKnopf.disabled = this.gewaehlterKanal === '' || this.ticket === '';
  }

  private betreteKanal(): void {
    const kanal = this.realms.find(
      (r) => r.server === this.gewaehlterServer && r.channel === this.gewaehlterKanal,
    );

    // Beides sollte nicht vorkommen — der Knopf ist dann gesperrt. Trotzdem
    // eine Meldung statt eines stillen `return`: ein Knopf, der nichts tut und
    // nichts sagt, ist das Schlimmste, was eine Maske anbieten kann.
    if (!kanal) {
      this.zeigeFehler('Wähle zuerst einen Kanal.');
      return;
    }
    if (this.ticket === '') {
      this.zeigeFehler('Die Eintrittskarte ist verbraucht. Lade die Liste neu.');
      return;
    }

    // Die Karte gilt nur einmal. Sie hier zu vergessen ist keine Vorsicht,
    // sondern Ehrlichkeit: ein zweiter Druck auf denselben Knopf würde sonst
    // mit einer verbrauchten Karte losziehen und ohne Grund scheitern.
    const ticket = this.ticket;
    this.ticket = '';
    this.kanalKnopf.disabled = true;
    this.wo = `${kanal.server} · ${kanal.channel}`;
    this.onEnterChannel?.(kanal.url, ticket);
  }

  /**
   * Vergisst die Anmeldung — nach einem Verbindungsabriss.
   *
   * Es gibt kein Sitzungspapier, das eine neue Verbindung ausweisen könnte:
   * wer die Leitung verliert, meldet sich neu an.
   */
  zuruecksetzen(): void {
    // Der Kontoname bleibt im Feld stehen: wer den Kanal wechselt, meldet
    // sich mit demselben Konto neu an, und ihn erneut tippen zu lassen wäre
    // eine Schikane ohne Zweck. Das Passwort bleibt selbstverständlich leer.
    if (this.stand) this.nameInput.value = this.stand.accountName;
    this.passInput.value = '';
    this.angemeldet = false;
    this.formularSteht = false;
    this.stand = undefined;
    // Die Kanalliste **nicht**: sie gehört zum Anmeldeserver, und der ist
    // gerade noch da. Wer auf einem Kanal die Verbindung verliert, soll die
    // Liste wiedersehen und nicht bei null anfangen — er hat sich eben erst
    // angemeldet.
  }

  verbergen(): void {
    this.root.hidden = true;
  }

  get sichtbar(): boolean {
    return !this.root.hidden;
  }

  /** Wie die Figur mit dieser Kennung heisst. */
  nameVon(characterId: number): string | undefined {
    return this.stand?.characters.find((c) => c.id === characterId)?.name;
  }

  /** Eine Absage vom Server — bleibt stehen, bis sich etwas ändert. */
  zeigeFehler(text: string): void {
    this.meldung.textContent = text;
    this.meldung.hidden = text.length === 0;
    this.meldung.dataset.art = 'fehler';
  }

  /**
   * Übernimmt den Stand aus der Verwaltung.
   *
   * Die Liste wird jedes Mal neu gebaut. Ein Abgleich wäre schneller und
   * hätte den Preis, dass zwei Vorstellungen vom Zustand nebeneinander
   * bestehen — bei höchstens einer Handvoll Figuren ist das ein schlechter
   * Tausch.
   */
  setStand(stand: LobbyStand): void {
    this.stand = stand;
    this.angemeldet = true;
    this.formularSteht = false;
    this.root.hidden = false;
    this.zeigeFehler('');
    this.loeschKandidat = 0;

    this.woZeile.textContent = this.wo;
    this.woZeile.hidden = this.wo === '';
    this.kanalWechsel.hidden = this.wo === '';

    const stufe = ['Spieler', 'Spielleiter', 'Entwickler', 'Verwalter'][stand.accessLevel] ?? '';
    this.kontoZeile.textContent =
      `${stand.accountName} — ${stufe} · ` +
      `${stand.characters.length} von ${stand.maxCharacters} Figuren`;

    const zeilen: HTMLElement[] = [];
    for (const figur of stand.characters) {
      const zeile = el('div', 'lobby-figur');
      zeile.dataset.characterId = String(figur.id);

      // Der Beruf steht als Name da, wenn die Inhalte ihn kennen, sonst als
      // Kennung: eine Figur mit einem Beruf, den dieser Client nicht kennt,
      // soll trotzdem betretbar bleiben.
      const beruf = getClass(figur.beruf);
      const text = el('div', 'lobby-figur-text');
      text.append(
        el('span', 'lobby-figur-name', `${beruf?.glyph ?? ''} ${figur.name}`.trim()),
        el(
          'span',
          'lobby-figur-info',
          `Stufe ${figur.level} · ${beruf?.name ?? figur.beruf} · ${figur.mapId}`,
        ),
      );

      const betreten = el('button', 'btn', 'Betreten');
      betreten.type = 'button';
      betreten.addEventListener('click', () => this.onEnterWorld?.(figur.id));

      // Löschen fragt nach — aber ohne Fenster davor: der Knopf wird zur
      // Rückfrage und beim zweiten Druck ernst. Ein Bestätigungsfenster wäre
      // dieselbe Frage mit mehr Aufbau, und `confirm()` blockiert auf dem
      // Telefon die ganze Seite.
      const loeschen = el('button', 'btn btn-warn', 'Löschen');
      loeschen.type = 'button';
      loeschen.addEventListener('click', () => {
        if (this.loeschKandidat === figur.id) {
          this.onDeleteCharacter?.(figur.id);
          return;
        }
        this.loeschKandidat = figur.id;
        for (const anderer of zeilen) {
          const knopf = anderer.querySelector<HTMLButtonElement>('.btn-warn');
          if (knopf) knopf.textContent = 'Löschen';
        }
        loeschen.textContent = 'Wirklich löschen?';
      });

      const knoepfe = el('div', 'lobby-knoepfe');
      knoepfe.append(betreten, loeschen);
      zeile.append(text, knoepfe);
      zeilen.push(zeile);
    }

    if (zeilen.length === 0) {
      zeilen.push(
        el(
          'p',
          'lobby-leer',
          this.wo === ''
            ? 'Noch keine Figur. Leg eine an.'
            : 'Auf diesem Server noch keine Figur. Leg eine an.',
        ),
      );
    }
    this.liste.replaceChildren(...zeilen);

    // Voll ist voll: der Weg zur Anlegemaske verschwindet, statt eine Absage
    // zu ernten.
    const voll = stand.characters.length >= stand.maxCharacters;
    this.neuKnopf.hidden = voll;

    // Wer gerade anlegt, bleibt beim Anlegen — ausser das Konto ist inzwischen
    // voll. Sonst risse jede Antwort des Servers die Maske unter den Fingern
    // weg, etwa die auf ein Löschen in einem zweiten Fenster.
    if (this.seite !== 'neu' || voll) this.zeigeSeite('figuren');
  }
}
