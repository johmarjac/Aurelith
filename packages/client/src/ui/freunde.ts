/**
 * Die Freundesliste — Fenster, Auswahl, Anfrage, Antwort.
 *
 * Drei Teile, die zusammengehören und deshalb in einer Datei stehen:
 *
 *   `FreundeFenster` — die Liste mit Name, Stufe und Onlinestand, dazu die
 *   Knöpfe darunter. Eine Zeile lässt sich auswählen; was mit ihr geht, hängt
 *   an dieser Auswahl.
 *
 *   `FreundHinzufuegen` — das kleine Fenster mit dem Eingabefeld. Getrennt,
 *   weil es eine Frage stellt und keine Auskunft gibt: es geht auf, nimmt einen
 *   Namen entgegen und ist wieder weg.
 *
 *   `FreundAnfrageBox` — die Ja-Nein-Frage, wenn jemand einen haben möchte.
 *   Sie steht vor dem Bild und läuft mit der Frist des Servers ab; die Zahl
 *   darin ist eine Anzeige, durchgesetzt wird sie dort.
 *
 * **Diese Datei kennt kein Protokoll.** Was gedrückt wurde, meldet sie über
 * Rückrufe; was daraus wird, entscheidet das Spiel. Sonst stünde die Kodierung
 * an zwei Stellen — hier und in der Verbindung.
 */

import type { FreundZeile } from '@aurelith/shared';
import { GameWindow } from './windows.ts';

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

/** Was das Fenster an das Spiel meldet. */
export interface FreundeRueckrufe {
  /** „Ich möchte diese Figur als Freund." */
  anfragen(name: string): void;
  /** „Diese Figur soll raus." — beidseitig, das entscheidet der Server. */
  entfernen(name: string): void;
  /** Eine Antwort auf eine Anfrage. */
  antworten(vonName: string, ja: boolean): void;
  /**
   * Den Chat für eine private Nachricht vorbereiten.
   *
   * Nur vorbereiten und nicht senden: die Nachricht tippt der Spieler. Das
   * Fenster weiss, **an wen**, und mehr soll es nicht wissen.
   */
  privatNachricht(name: string): void;
  /** In die Gruppe einladen. Gibt es noch nicht — siehe unten. */
  gruppeEinladen(name: string): void;
}

/**
 * Was ein Rechtsklick oder ein Knopf an einem Freund anbietet.
 *
 * Dasselbe Menü wie beim NPC (`NpcMenu`) wäre hier eine Abhängigkeit von den
 * NPC-Fenstern; stattdessen baut das Fenster sich seines selbst — es sind drei
 * Zeilen ohne Beschreibung.
 */
interface MenuEintrag {
  label: string;
  tun: () => void;
}

export class FreundeFenster {
  readonly fenster: GameWindow;

  private readonly liste: HTMLDivElement;
  private readonly menu: HTMLDivElement;
  private readonly knopfEntfernen: HTMLButtonElement;
  private readonly knopfGruppe: HTMLButtonElement;

  private zeilen: readonly FreundZeile[] = [];
  /** Der ausgewählte Name — leer heisst: keiner. */
  private gewaehlt = '';

  constructor(
    host: HTMLElement,
    private readonly rueckrufe: FreundeRueckrufe,
    private readonly oeffneHinzufuegen: () => void,
  ) {
    this.fenster = new GameWindow(
      host,
      'freunde',
      'Freunde',
      { left: window.innerWidth - 320, top: 120 },
      true,
    );

    this.liste = el('div', 'freunde-liste');
    this.fenster.body.appendChild(this.liste);

    const leiste = el('div', 'freunde-leiste');
    const plus = el('button', 'btn freunde-knopf', '+');
    plus.type = 'button';
    plus.title = 'Freund hinzufügen';
    plus.setAttribute('aria-label', 'Freund hinzufügen');
    plus.addEventListener('click', () => this.oeffneHinzufuegen());

    this.knopfEntfernen = el('button', 'btn freunde-knopf', 'Entfernen');
    this.knopfEntfernen.type = 'button';
    this.knopfEntfernen.addEventListener('click', () => {
      if (this.gewaehlt) this.rueckrufe.entfernen(this.gewaehlt);
    });

    this.knopfGruppe = el('button', 'btn freunde-knopf', 'In Gruppe');
    this.knopfGruppe.type = 'button';
    this.knopfGruppe.addEventListener('click', () => {
      if (this.gewaehlt) this.rueckrufe.gruppeEinladen(this.gewaehlt);
    });

    leiste.append(plus, this.knopfEntfernen, this.knopfGruppe);
    this.fenster.body.appendChild(leiste);

    /*
     * Das Kontextmenü hängt am Wirt und nicht im Fenster.
     *
     * Im Fensterrumpf säße es innerhalb eines Bereichs, der scrollt und an den
     * Rändern abgeschnitten wird — ein Menü am unteren Ende der Liste wäre zur
     * Hälfte weg. Am Wirt liegt es über allem und lässt sich frei setzen.
     */
    this.menu = el('div', 'freunde-menu panel');
    this.menu.hidden = true;
    host.appendChild(this.menu);
    window.addEventListener('pointerdown', (ev) => {
      if (this.menu.hidden) return;
      const ziel = ev.target as Node | null;
      if (ziel && this.menu.contains(ziel)) return;
      this.menu.hidden = true;
    });
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') this.menu.hidden = true;
    });

    this.setze([]);
  }

  /** Die ganze Liste — der Server schickt sie vollständig und sortiert. */
  setze(zeilen: readonly FreundZeile[]): void {
    this.zeilen = zeilen;
    // Wer nicht mehr dabei ist, bleibt nicht ausgewählt: sonst zeigte der
    // Knopf „Entfernen" auf jemanden, den es in dieser Liste nicht gibt.
    if (!zeilen.some((z) => z.name === this.gewaehlt)) this.gewaehlt = '';

    if (zeilen.length === 0) {
      this.liste.replaceChildren(
        el('p', 'freunde-leer', 'Noch niemand. Mit + fügst du jemanden hinzu.'),
      );
      this.aktualisiereKnoepfe();
      return;
    }

    this.liste.replaceChildren(
      ...zeilen.map((z) => {
        const zeile = el('div', 'freunde-zeile');
        zeile.dataset.online = String(z.online);
        zeile.dataset.name = z.name;
        zeile.dataset.gewaehlt = String(z.name === this.gewaehlt);
        zeile.append(
          el('span', 'freunde-punkt'),
          el('span', 'freunde-name', z.name),
          el('span', 'freunde-stufe', `Stufe ${z.level}`),
          el('span', 'freunde-stand', z.online ? 'online' : 'offline'),
        );
        zeile.addEventListener('click', () => this.waehle(z.name));
        zeile.addEventListener('contextmenu', (ev) => {
          // Erst auswählen, dann das Menü: sonst zeigte das Menü auf die eine
          // Zeile und die Knöpfe darunter auf eine andere.
          ev.preventDefault();
          this.waehle(z.name);
          this.zeigeMenu(z.name, ev.clientX, ev.clientY);
        });
        return zeile;
      }),
    );
    this.aktualisiereKnoepfe();
  }

  /** Für Prüfungen und für das Spiel: steht dieser Name in der Liste? */
  hat(name: string): boolean {
    return this.zeilen.some((z) => z.name.toLowerCase() === name.toLowerCase());
  }

  private waehle(name: string): void {
    // Noch einmal auf dieselbe Zeile hebt die Auswahl auf. Ohne das bliebe
    // sie kleben, und die Knöpfe darunter zeigten dauerhaft auf jemanden.
    this.gewaehlt = this.gewaehlt === name ? '' : name;
    for (const kind of this.liste.children) {
      const zeile = kind as HTMLElement;
      zeile.dataset.gewaehlt = String(zeile.dataset.name === this.gewaehlt);
    }
    this.aktualisiereKnoepfe();
  }

  private aktualisiereKnoepfe(): void {
    const aus = this.gewaehlt === '';
    this.knopfEntfernen.disabled = aus;
    this.knopfGruppe.disabled = aus;
  }

  private zeigeMenu(name: string, x: number, y: number): void {
    const eintraege: MenuEintrag[] = [
      { label: 'Private Nachricht', tun: () => this.rueckrufe.privatNachricht(name) },
      { label: 'In Gruppe einladen', tun: () => this.rueckrufe.gruppeEinladen(name) },
      { label: 'Aus der Liste entfernen', tun: () => this.rueckrufe.entfernen(name) },
    ];
    this.menu.replaceChildren(
      el('div', 'freunde-menu-kopf', name),
      ...eintraege.map((e) => {
        const knopf = el('button', 'freunde-menu-eintrag', e.label);
        knopf.type = 'button';
        knopf.addEventListener('click', () => {
          this.menu.hidden = true;
          e.tun();
        });
        return knopf;
      }),
    );
    this.menu.hidden = false;

    // Erst anzeigen, dann ins Bild rücken: vorher steht die Breite nicht fest.
    const rand = 8;
    const kasten = this.menu.getBoundingClientRect();
    this.menu.style.left = `${Math.round(Math.max(rand, Math.min(window.innerWidth - kasten.width - rand, x)))}px`;
    this.menu.style.top = `${Math.round(Math.max(rand, Math.min(window.innerHeight - kasten.height - rand, y)))}px`;
  }
}

/** Das kleine Fenster mit dem Eingabefeld. */
export class FreundHinzufuegen {
  readonly fenster: GameWindow;
  private readonly feld: HTMLInputElement;

  constructor(host: HTMLElement, private readonly anfragen: (name: string) => void) {
    this.fenster = new GameWindow(
      host,
      'freund-neu',
      'Freund hinzufügen',
      { left: window.innerWidth / 2 - 140, top: 200 },
      true,
    );

    const text = el(
      'p',
      'freunde-hinweis',
      'Der Name der Figur, wie er über ihrem Kopf steht. Sie muss gerade spielen.',
    );
    this.feld = el('input', 'freunde-feld');
    this.feld.type = 'text';
    this.feld.maxLength = 16;
    this.feld.placeholder = 'Figurenname';
    this.feld.setAttribute('aria-label', 'Figurenname');

    const senden = el('button', 'btn freunde-knopf', 'Anfragen');
    senden.type = 'button';
    senden.addEventListener('click', () => this.schicke());
    this.feld.addEventListener('keydown', (ev) => {
      // Eingabe schickt ab. Wer einen Namen tippt, sucht danach keinen Knopf.
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.schicke();
      }
    });

    const zeile = el('div', 'freunde-leiste');
    zeile.append(this.feld, senden);
    this.fenster.body.append(text, zeile);
  }

  /** Aufmachen und den Zeiger ins Feld. Leer, damit nichts von vorhin steht. */
  oeffne(): void {
    this.feld.value = '';
    this.fenster.setOpen(true);
    this.feld.focus();
  }

  private schicke(): void {
    const name = this.feld.value.trim();
    // Ein leeres Feld ist kein Fehler, sondern eine Frage ohne Inhalt — das
    // Fenster bleibt offen, und der Zeiger steht schon an der richtigen Stelle.
    if (name === '') {
      this.feld.focus();
      return;
    }
    this.anfragen(name);
    this.fenster.setOpen(false);
  }
}

/**
 * Die Ja-Nein-Frage, wenn jemand befreundet sein möchte.
 *
 * Kein `GameWindow`: sie hat keine Titelleiste, wird nicht verschoben und ist
 * nach der Antwort weg. Sie ist eine Frage, kein Fenster — dieselbe Erwägung
 * wie beim Auswahlmenü vor einem NPC-Gespräch.
 */
export class FreundAnfrageBox {
  private readonly root: HTMLDivElement;
  private readonly text: HTMLElement;
  private readonly uhr: HTMLElement;
  private vonName = '';
  private bis = 0;
  private ticker?: number;

  constructor(
    host: HTMLElement,
    private readonly antworten: (vonName: string, ja: boolean) => void,
  ) {
    this.root = el('div', 'freund-anfrage panel');
    this.root.hidden = true;
    this.text = el('p', 'freund-anfrage-text');
    this.uhr = el('span', 'freund-anfrage-uhr');

    const ja = el('button', 'btn freunde-knopf', 'Ja');
    ja.type = 'button';
    ja.addEventListener('click', () => this.antworte(true));
    const nein = el('button', 'btn freunde-knopf', 'Nein');
    nein.type = 'button';
    nein.addEventListener('click', () => this.antworte(false));

    const knoepfe = el('div', 'freunde-leiste');
    knoepfe.append(ja, nein, this.uhr);
    this.root.append(this.text, knoepfe);
    host.appendChild(this.root);
  }

  get offen(): boolean {
    return !this.root.hidden;
  }

  frage(vonName: string, fristMs: number): void {
    this.vonName = vonName;
    this.bis = performance.now() + fristMs;
    this.text.textContent = `${vonName} möchte dich als Freund.`;
    this.root.hidden = false;
    this.zeigeRest();
    window.clearInterval(this.ticker);
    /*
     * Die Uhr läuft im Client mit — und **schliesst** die Frage, wenn sie
     * abgelaufen ist.
     *
     * Nicht, weil der Client entscheidet: der Server verwirft die Anfrage
     * ohnehin nach seiner Frist. Sondern damit kein Knopf stehenbleibt, der
     * nichts mehr bewirkt. Ein Knopf ohne Wirkung ist schlimmer als keiner.
     */
    this.ticker = window.setInterval(() => {
      if (this.zeigeRest() <= 0) this.schliesse();
    }, 500);
  }

  schliesse(): void {
    this.root.hidden = true;
    window.clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private zeigeRest(): number {
    const rest = Math.max(0, this.bis - performance.now());
    this.uhr.textContent = `${Math.ceil(rest / 1000)} s`;
    return rest;
  }

  private antworte(ja: boolean): void {
    const von = this.vonName;
    this.schliesse();
    this.antworten(von, ja);
  }
}
