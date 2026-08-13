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
 * Drei Masken, nicht eine.
 *
 *   `anmeldung` — Konto und Passwort. Schmal, mittig, sonst nichts.
 *   `figuren`   — die Liste der Figuren dieses Kontos.
 *   `neu`       — eine Figur anlegen.
 *
 * Immer genau eine davon ist sichtbar, und jede hat ihren eigenen Kasten mit
 * eigener Überschrift. Untereinander in einem Kasten war es vorher, und dabei
 * war nie klar, wo die eine Sache aufhört und die nächste anfängt: das
 * Anlegeformular sah aus wie eine weitere Zeile der Liste, und der Kopf des
 * Kastens sagte immer dasselbe.
 */

import { getClass, type LobbyCharacter } from '@aurelith/shared';

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

/** Welche der drei Masken gerade gilt. */
type Seite = 'anmeldung' | 'figuren' | 'neu';

export class LobbyView {
  /** Anmelden mit Name und Passwort. */
  onLogin?: (name: string, password: string) => void;
  /** Konto anlegen — Name und Passwort wie beim Anmelden. */
  onCreateAccount?: (name: string, password: string) => void;
  onCreateCharacter?: (name: string) => void;
  onDeleteCharacter?: (characterId: number) => void;
  onEnterWorld?: (characterId: number) => void;

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

    this.figurenSeite.append(
      el('h1', 'lobby-titel', 'Deine Figuren'),
      this.kontoZeile,
      this.liste,
      zurNeu,
    );
    // Der Knopf wird ausgeblendet, wenn das Konto voll ist — gemerkt, damit
    // `setStand` ihn wiederfindet, ohne im DOM zu suchen.
    this.neuKnopf = zurNeu;

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

    this.root.append(this.anmeldungSeite, this.figurenSeite, this.neuSeite);
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
    this.figurenSeite.hidden = seite !== 'figuren';
    this.neuSeite.hidden = seite !== 'neu';

    const kasten =
      seite === 'anmeldung'
        ? this.anmeldungSeite
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
   * Vergisst die Anmeldung — nach einem Verbindungsabriss.
   *
   * Es gibt kein Sitzungspapier, das eine neue Verbindung ausweisen könnte:
   * wer die Leitung verliert, meldet sich neu an.
   */
  zuruecksetzen(): void {
    this.angemeldet = false;
    this.formularSteht = false;
    this.stand = undefined;
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
      zeilen.push(el('p', 'lobby-leer', 'Noch keine Figur. Leg eine an.'));
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
