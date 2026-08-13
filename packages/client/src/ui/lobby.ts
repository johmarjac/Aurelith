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
 */

import type { LobbyCharacter } from '@aurelith/shared';

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

export class LobbyView {
  /** Anmelden mit Name und Passwort. */
  onLogin?: (name: string, password: string) => void;
  /** Konto anlegen — Name und Passwort wie beim Anmelden. */
  onCreateAccount?: (name: string, password: string) => void;
  onCreateCharacter?: (name: string) => void;
  onDeleteCharacter?: (characterId: number) => void;
  onEnterWorld?: (characterId: number) => void;

  private readonly root: HTMLDivElement;
  private readonly loginForm: HTMLFormElement;
  private readonly nameInput: HTMLInputElement;
  private readonly passInput: HTMLInputElement;
  private readonly liste: HTMLDivElement;
  private readonly figurenSeite: HTMLDivElement;
  private readonly meldung: HTMLParagraphElement;
  private readonly kontoZeile: HTMLParagraphElement;
  private readonly neuForm: HTMLFormElement;
  private readonly neuInput: HTMLInputElement;

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

  constructor(host: HTMLElement) {
    this.root = el('div', 'lobby');
    this.root.hidden = true;

    const kasten = el('div', 'lobby-box panel');

    kasten.appendChild(el('h1', 'lobby-titel', 'Aurelith'));
    this.meldung = el('p', 'lobby-meldung', '');
    this.meldung.hidden = true;

    // --- Anmelden ---------------------------------------------------------
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

    // --- Figuren ----------------------------------------------------------
    this.figurenSeite = el('div', 'lobby-figuren');
    this.figurenSeite.hidden = true;
    this.kontoZeile = el('p', 'lobby-konto', '');
    this.liste = el('div', 'lobby-liste');

    this.neuForm = el('form', 'lobby-form lobby-neu');
    this.neuInput = el('input', 'lobby-input');
    this.neuInput.type = 'text';
    this.neuInput.placeholder = 'Name der neuen Figur';
    this.neuInput.maxLength = 16;
    const neuKnopf = el('button', 'btn', 'Figur anlegen');
    neuKnopf.type = 'submit';
    this.neuForm.append(this.neuInput, neuKnopf);
    this.neuForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const name = this.neuInput.value.trim();
      if (name.length === 0) return;
      this.onCreateCharacter?.(name);
      this.neuInput.value = '';
    });

    this.figurenSeite.append(this.kontoZeile, this.liste, this.neuForm);

    kasten.append(this.meldung, this.loginForm, this.figurenSeite);
    this.root.appendChild(kasten);
    host.appendChild(this.root);
  }

  /**
   * Zeigt die Maske.
   *
   * Wer schon angemeldet ist, bleibt bei seinen Figuren — dieselbe Maske,
   * dieselbe Seite. Zurück auf das Formular geht es erst nach `zuruecksetzen`,
   * also wenn die Verbindung tatsächlich weg war.
   */
  zeigeAnmeldung(): void {
    this.root.hidden = false;
    if (this.angemeldet) return;
    this.loginForm.hidden = false;
    this.figurenSeite.hidden = true;
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
    this.root.hidden = false;
    this.loginForm.hidden = true;
    this.figurenSeite.hidden = false;
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

      const text = el('div', 'lobby-figur-text');
      text.append(
        el('span', 'lobby-figur-name', figur.name),
        el('span', 'lobby-figur-info', `Stufe ${figur.level} · ${figur.mapId}`),
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

    // Voll ist voll: das Formular verschwindet, statt eine Absage zu ernten.
    this.neuForm.hidden = stand.characters.length >= stand.maxCharacters;
  }
}
