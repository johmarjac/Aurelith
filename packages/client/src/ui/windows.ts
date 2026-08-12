/**
 * Fenster.
 *
 * Auf dem Desktop ziehbar wie bei Flyff, auf dem Telefon fahren sie als Blatt
 * von unten ein — dieselbe Klasse, der Unterschied steckt allein im
 * Stylesheet. Ein Fenster, das man auf einem Telefon frei verschieben kann,
 * ist ein Fenster, das man ständig aus Versehen verschiebt.
 */

export class GameWindow {
  readonly element: HTMLDivElement;
  readonly body: HTMLDivElement;

  private open = false;
  private dragPointer: number | null = null;
  private dragOffsetX = 0;
  private dragOffsetY = 0;

  /** Wird bei jedem Öffnen und Schließen gerufen. */
  onToggle?: (open: boolean) => void;

  constructor(
    host: HTMLElement,
    readonly id: string,
    title: string,
    position: { left: number; top: number },
    private readonly draggable: boolean,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'window panel';
    this.element.dataset.open = 'false';
    this.element.dataset.window = id;
    this.element.style.left = `${position.left}px`;
    this.element.style.top = `${position.top}px`;
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-label', title);

    const bar = document.createElement('div');
    bar.className = 'window-title';

    const label = document.createElement('span');
    label.textContent = title;

    const close = document.createElement('button');
    close.className = 'btn window-close';
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', `${title} schließen`);
    close.addEventListener('click', () => this.setOpen(false));

    bar.append(label, close);

    this.body = document.createElement('div');
    this.body.className = 'window-body';

    this.element.append(bar, this.body);
    host.appendChild(this.element);

    GameWindow.alle.push(this);
    GameWindow.beobachteBildgroesse();

    if (draggable) this.bindDrag(bar);
  }

  /**
   * Alle Fenster zurechtrücken, wenn sich das Bild ändert.
   *
   * Das Drehen des Telefons ist der Fall, um den es geht: hochkant passt ein
   * Fenster, quer ist derselbe Platz plötzlich vierhundert Bildpunkte hoch.
   * Ein Fenster, das dabei aus dem Bild rutscht, lässt sich nicht mehr
   * zurückholen — auf dem Telefon gibt es keine Titelleiste zum Ziehen.
   *
   * Einmal für alle und nicht je Fenster: fünf Fenster wären fünf Zuhörer für
   * dasselbe Ereignis.
   */
  private static beobachteBildgroesse(): void {
    if (GameWindow.beobachtet) return;
    GameWindow.beobachtet = true;
    const rueck = (): void => {
      for (const fenster of GameWindow.alle) fenster.clampIntoView();
    };
    window.addEventListener('resize', rueck);
    window.addEventListener('orientationchange', rueck);
    window.visualViewport?.addEventListener('resize', rueck);
  }

  private bindDrag(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.window-close')) return;
      // Auf schmalen Geräten sitzt das Fenster fest — Stylesheet und Verhalten
      // müssen sich einig sein.
      if (window.matchMedia('(max-width: 700px)').matches) return;

      this.dragPointer = e.pointerId;
      const rect = this.element.getBoundingClientRect();
      this.dragOffsetX = e.clientX - rect.left;
      this.dragOffsetY = e.clientY - rect.top;
      handle.setPointerCapture(e.pointerId);
      this.bringToFront();
      e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
      if (this.dragPointer !== e.pointerId) return;
      const maxLeft = window.innerWidth - 60;
      const maxTop = window.innerHeight - 40;
      this.element.style.left = `${Math.max(0, Math.min(maxLeft, e.clientX - this.dragOffsetX))}px`;
      this.element.style.top = `${Math.max(0, Math.min(maxTop, e.clientY - this.dragOffsetY))}px`;
    });

    const end = (e: PointerEvent) => {
      if (this.dragPointer === e.pointerId) this.dragPointer = null;
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  bringToFront(): void {
    // Ein aufsteigender Zähler reicht: Fenster gibt es eine Handvoll, und
    // niemand öffnet sie milliardenfach.
    GameWindow.topZ += 1;
    this.element.style.zIndex = String(GameWindow.topZ);
  }

  setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.element.dataset.open = String(open);
    if (open) {
      this.bringToFront();
      this.clampIntoView();
    }
    this.onToggle?.(open);
  }

  /**
   * Schiebt das Fenster so weit zurück, dass es ganz im Bild steht.
   *
   * Die Anfangslage ist eine feste Zahl — hundert Bildpunkte von oben —, und
   * die passt zu einem Bildschirm und nicht zu einem quer gehaltenen Telefon:
   * dort sind knapp vierhundert Bildpunkte Höhe da, und ein Fenster, das bei
   * hundert anfängt, hängt mit dem Beutel unten heraus. Sichtbar war davon
   * nichts, was man hätte scrollen können — es stand schlicht ausserhalb.
   *
   * Gerechnet wird gegen das **sichtbare** Fenster (`visualViewport`), nicht
   * gegen `innerHeight`: auf dem Telefon zählt letzteres die Fläche unter der
   * Adressleiste mit, und genau dort landete der untere Rand.
   *
   * Bei einem Blattfenster am unteren Rand — schmale Geräte — hat das
   * Stylesheet das letzte Wort; dort wird nichts verschoben.
   */
  clampIntoView(): void {
    if (!this.open) return;
    // Wer nicht schwebt, wird nicht geschoben: Blattfenster und das
    // bildschirmfüllende Inventar stehen im Stylesheet fest, und eine
    // eingetragene Lage in Bildpunkten wäre eine zweite Meinung dazu.
    if (getComputedStyle(this.element).position !== 'absolute') return;

    const sicht = window.visualViewport;
    const breite = sicht?.width ?? window.innerWidth;
    const hoehe = sicht?.height ?? window.innerHeight;
    const rect = this.element.getBoundingClientRect();
    if (rect.height === 0) return;

    const rand = 8;
    const links = Math.max(rand, Math.min(breite - rect.width - rand, rect.left));
    const oben = Math.max(rand, Math.min(hoehe - rect.height - rand, rect.top));
    this.element.style.left = `${Math.round(links)}px`;
    this.element.style.top = `${Math.round(oben)}px`;
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  get isOpen(): boolean {
    return this.open;
  }

  private static topZ = 20;
  private static readonly alle: GameWindow[] = [];
  private static beobachtet = false;
}
