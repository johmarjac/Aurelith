/**
 * Die Konsole — was das Spiel über sich selbst zu sagen hat.
 *
 * Ein Fenster im Spiel und nicht die des Browsers, aus einem einzigen Grund:
 * auf dem Telefon gibt es keine. Wer dort einen Fehler sieht, kann bisher nur
 * beschreiben, was passiert ist; hier kann er ihn ablesen und mit einem Druck
 * kopieren.
 *
 * Drei Quellen laufen zusammen:
 *
 *   **Was der Client selbst meldet** — Verbindung, Fassung, Kartenwechsel,
 *   alles, was sonst nur in `console.log` stünde.
 *
 *   **Was der Browser meldet** — `console.warn`, `console.error`, unbehandelte
 *   Ausnahmen und abgewiesene Versprechen. Dafür werden die Ausgabefunktionen
 *   umgeleitet; sie tun danach beides, wie vorher *und* hier hinein.
 *
 *   **Was vom Server kommt** — Kicks und unlesbare Rahmen. Genau das
 *   Gegenstück zum Rahmenprotokoll auf der Serverseite: derselbe Fehler,
 *   einmal von jeder Seite gesehen.
 *
 * Wiederholungen werden gezählt statt gestapelt. Eine Warnung, die in jedem
 * Bild kommt, füllte sonst in zehn Sekunden das ganze Fenster und schöbe genau
 * die eine Zeile heraus, die man sucht.
 */

import { GameWindow } from './windows.ts';

export type LogArt = 'info' | 'netz' | 'warnung' | 'fehler';

/** Mehr Zeilen hebt niemand auf — und der DOM wird träge. */
const MAX_ZEILEN = 300;

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

function uhrzeit(): string {
  const d = new Date();
  const zwei = (n: number): string => String(n).padStart(2, '0');
  return `${zwei(d.getHours())}:${zwei(d.getMinutes())}:${zwei(d.getSeconds())}`;
}

export class Konsole {
  readonly fenster: GameWindow;

  private readonly liste: HTMLDivElement;
  private readonly zaehler: HTMLSpanElement;
  /** Die zuletzt geschriebene Zeile — für die Wiederholungszählung. */
  private letzte?: { text: string; art: LogArt; element: HTMLDivElement; mal: number };
  /** Schon einmal umgeleitet? Zweimal wäre eine Endlosschleife. */
  private umgeleitet = false;
  /** Zählt alles, was je hereinkam — auch das Weggeworfene. */
  private gesamt = 0;
  private fehler = 0;

  constructor(host: HTMLElement) {
    this.fenster = new GameWindow(
      host,
      'konsole',
      'Konsole',
      { left: 40, top: Math.max(60, window.innerHeight - 420) },
      true,
    );

    const kopf = el('div', 'konsole-kopf');
    this.zaehler = el('span', 'konsole-zaehler', '0 Zeilen');

    const filter = el('select', 'konsole-filter');
    for (const [wert, text] of [
      ['alles', 'Alles'],
      ['netz', 'Netz'],
      ['problem', 'Nur Probleme'],
    ] as const) {
      const opt = el('option', undefined, text);
      opt.value = wert;
      filter.appendChild(opt);
    }
    filter.addEventListener('change', () => {
      this.liste.dataset.filter = filter.value;
    });

    const kopieren = el('button', 'btn', 'Kopieren');
    kopieren.type = 'button';
    kopieren.addEventListener('click', () => void this.kopiere(kopieren));

    const leeren = el('button', 'btn', 'Leeren');
    leeren.type = 'button';
    leeren.addEventListener('click', () => this.leere());

    kopf.append(this.zaehler, filter, kopieren, leeren);

    this.liste = el('div', 'konsole-liste');
    this.liste.dataset.filter = 'alles';
    this.fenster.body.append(kopf, this.liste);
  }

  /**
   * Schreibt eine Zeile.
   *
   * Dieselbe Zeile zweimal hintereinander wird zur Zählung an der ersten —
   * `×12` statt zwölf gleicher Zeilen. Das ist kein Schönheitsgewinn: eine
   * Warnung je Bild verdrängt sonst binnen Sekunden alles, was davor stand.
   */
  schreibe(art: LogArt, text: string): void {
    this.gesamt++;
    if (art === 'fehler') this.fehler++;

    if (this.letzte && this.letzte.text === text && this.letzte.art === art) {
      this.letzte.mal++;
      const mal = this.letzte.element.querySelector('.konsole-mal');
      if (mal) mal.textContent = `×${this.letzte.mal}`;
      else this.letzte.element.appendChild(el('span', 'konsole-mal', `×${this.letzte.mal}`));
      this.aktualisiereZaehler();
      return;
    }

    // Am unteren Rand mitlaufen — aber nur, wenn man dort auch steht. Wer
    // nach oben gescrollt hat, liest gerade etwas; ihn wegzuziehen macht die
    // Konsole in genau dem Moment unbrauchbar, in dem sie gebraucht wird.
    const amEnde =
      this.liste.scrollTop + this.liste.clientHeight >= this.liste.scrollHeight - 24;

    const zeile = el('div', 'konsole-zeile');
    zeile.dataset.art = art;
    zeile.append(el('span', 'konsole-zeit', uhrzeit()), el('span', 'konsole-text', text));
    this.liste.appendChild(zeile);

    while (this.liste.childElementCount > MAX_ZEILEN) this.liste.firstElementChild?.remove();
    if (amEnde) this.liste.scrollTop = this.liste.scrollHeight;

    this.letzte = { text, art, element: zeile, mal: 1 };
    this.aktualisiereZaehler();
  }

  private aktualisiereZaehler(): void {
    const sichtbar = this.liste.childElementCount;
    this.zaehler.textContent =
      `${sichtbar} Zeile${sichtbar === 1 ? '' : 'n'}` +
      (this.gesamt > sichtbar ? ` von ${this.gesamt}` : '') +
      (this.fehler > 0 ? ` · ${this.fehler} Fehler` : '');
    this.zaehler.dataset.fehler = String(this.fehler > 0);
  }

  leere(): void {
    this.liste.replaceChildren();
    this.letzte = undefined;
    this.gesamt = 0;
    this.fehler = 0;
    this.aktualisiereZaehler();
  }

  /** Der ganze Inhalt als Text — zum Einfügen in einen Fehlerbericht. */
  get text(): string {
    return [...this.liste.children]
      .map((z) => (z as HTMLElement).innerText.replace(/\s+/g, ' ').trim())
      .join('\n');
  }

  /**
   * Legt den Inhalt in die Zwischenablage.
   *
   * Mit Rückmeldung am Knopf, denn kopieren ist eine Handlung ohne sichtbares
   * Ergebnis — ohne sie weiss niemand, ob es geklappt hat. Und mit einem
   * zweiten Weg für den Fall, dass die Zwischenablage verwehrt wird: das
   * passiert ohne HTTPS und in älteren Browsern zuverlässig.
   */
  private async kopiere(knopf: HTMLButtonElement): Promise<void> {
    const inhalt = this.text;
    let geklappt = false;
    try {
      await navigator.clipboard.writeText(inhalt);
      geklappt = true;
    } catch {
      geklappt = false;
    }
    knopf.textContent = geklappt ? 'Kopiert' : 'Nicht erlaubt';
    window.setTimeout(() => {
      knopf.textContent = 'Kopieren';
    }, 1600);
    if (!geklappt) this.schreibe('warnung', 'Zwischenablage verwehrt — Text von Hand markieren.');
  }

  /**
   * Leitet die Ausgaben des Browsers hierher um.
   *
   * Die ursprünglichen Funktionen werden **weiterhin gerufen**: die Konsole des
   * Browsers bleibt vollständig, dies hier kommt dazu. Eine Umleitung, die
   * schluckt, wäre beim Suchen eines Fehlers das Letzte, was man will.
   *
   * Der Wächter gegen Rekursion ist keine Vorsicht, sondern Notwendigkeit: was
   * beim Schreiben einer Zeile selbst eine Warnung auslöst, riefe sich sonst
   * bis zum Stapelüberlauf.
   */
  uebernehmeGlobales(): void {
    if (this.umgeleitet) return;
    this.umgeleitet = true;

    let drin = false;
    const umleiten = (
      name: 'log' | 'info' | 'warn' | 'error',
      art: LogArt,
    ): void => {
      const original = console[name].bind(console);
      console[name] = (...args: unknown[]): void => {
        original(...args);
        if (drin) return;
        drin = true;
        try {
          this.schreibe(art, args.map((a) => this.alsText(a)).join(' '));
        } finally {
          drin = false;
        }
      };
    };

    umleiten('log', 'info');
    umleiten('info', 'info');
    umleiten('warn', 'warnung');
    umleiten('error', 'fehler');

    window.addEventListener('error', (ev) => {
      const stelle = ev.filename ? ` (${ev.filename.split('/').pop()}:${ev.lineno})` : '';
      this.schreibe('fehler', `${ev.message}${stelle}`);
    });

    window.addEventListener('unhandledrejection', (ev) => {
      this.schreibe('fehler', `Unbehandelt: ${this.alsText(ev.reason)}`);
    });
  }

  /**
   * Ein Argument als Text.
   *
   * Fehler mit Meldung statt `[object Object]`, alles andere über JSON — und
   * wenn auch das nicht geht (Zyklen, Proxys), der schlichte String. Ein
   * Debugfenster, das an der Ausgabe seiner eigenen Werte scheitert, ist
   * schlimmer als keins.
   */
  private alsText(wert: unknown): string {
    if (typeof wert === 'string') return wert;
    if (wert instanceof Error) return `${wert.name}: ${wert.message}`;
    if (wert === null || wert === undefined) return String(wert);
    if (typeof wert === 'object') {
      try {
        return JSON.stringify(wert);
      } catch {
        return String(wert);
      }
    }
    return String(wert);
  }
}
