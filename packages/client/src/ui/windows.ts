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

    if (draggable) this.bindDrag(bar);
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
    if (open) this.bringToFront();
    this.onToggle?.(open);
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  get isOpen(): boolean {
    return this.open;
  }

  private static topZ = 20;
}
