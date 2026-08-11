/**
 * Virtueller Joystick.
 *
 * Er hat keinen festen Platz: er erscheint dort, wo der Daumen die linke
 * Bildschirmhälfte berührt. Das ist der Unterschied zwischen „geht" und „geht
 * gut" — bei einem festen Kreis muss man hinsehen, bei einem mitwandernden
 * nicht.
 *
 * Die Mitte zieht dem Daumen nach, sobald er den Rand erreicht. Ohne das
 * bleibt man bei jedem längeren Wischer am Anschlag hängen.
 */

export interface JoystickOutput {
  /** -1 bis 1, Bildschirmachsen. */
  x: number;
  y: number;
  /** 0 bis 1. */
  magnitude: number;
  active: boolean;
}

/** Radius des Ausschlags in CSS-Pixeln. */
const RADIUS = 62;
/** Kleinere Auslenkungen gelten als Zittern. */
const DEAD_ZONE = 0.14;

export class VirtualJoystick {
  readonly element: HTMLDivElement;

  private readonly base: HTMLDivElement;
  private readonly knob: HTMLDivElement;

  private pointerId: number | null = null;
  private originX = 0;
  private originY = 0;
  private outX = 0;
  private outY = 0;
  private magnitude = 0;

  constructor(private readonly host: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'joystick';
    this.element.hidden = true;

    this.base = document.createElement('div');
    this.base.className = 'joystick-base';
    this.knob = document.createElement('div');
    this.knob.className = 'joystick-knob';

    this.element.append(this.base, this.knob);
    host.appendChild(this.element);
  }

  /** Nimmt eine Berührung an, wenn sie in der linken Hälfte beginnt. */
  tryClaim(pointerId: number, clientX: number, clientY: number): boolean {
    if (this.pointerId !== null) return false;
    if (clientX > window.innerWidth * 0.5) return false;

    this.pointerId = pointerId;
    this.originX = clientX;
    this.originY = clientY;
    this.element.hidden = false;
    this.place(clientX, clientY);
    this.update(clientX, clientY);
    return true;
  }

  move(pointerId: number, clientX: number, clientY: number): boolean {
    if (this.pointerId !== pointerId) return false;
    this.update(clientX, clientY);
    return true;
  }

  release(pointerId: number): boolean {
    if (this.pointerId !== pointerId) return false;
    this.pointerId = null;
    this.outX = 0;
    this.outY = 0;
    this.magnitude = 0;
    this.element.hidden = true;
    return true;
  }

  private place(x: number, y: number): void {
    this.base.style.transform = `translate(${x - RADIUS}px, ${y - RADIUS}px)`;
  }

  private update(clientX: number, clientY: number): void {
    let dx = clientX - this.originX;
    let dy = clientY - this.originY;
    const dist = Math.hypot(dx, dy);

    if (dist > RADIUS) {
      // Mitte nachziehen, damit der Daumen nicht am Anschlag klebt.
      this.originX += (dx / dist) * (dist - RADIUS);
      this.originY += (dy / dist) * (dist - RADIUS);
      dx = (dx / dist) * RADIUS;
      dy = (dy / dist) * RADIUS;
      this.place(this.originX, this.originY);
    }

    const magnitude = Math.min(1, Math.hypot(dx, dy) / RADIUS);
    if (magnitude < DEAD_ZONE) {
      this.outX = 0;
      this.outY = 0;
      this.magnitude = 0;
    } else {
      // Auf den Bereich außerhalb der Totzone neu strecken, damit die
      // langsamste mögliche Bewegung nicht schon halbe Geschwindigkeit ist.
      const scaled = (magnitude - DEAD_ZONE) / (1 - DEAD_ZONE);
      const len = Math.hypot(dx, dy) || 1;
      this.outX = (dx / len) * scaled;
      this.outY = (dy / len) * scaled;
      this.magnitude = scaled;
    }

    this.knob.style.transform = `translate(${this.originX + dx - 26}px, ${this.originY + dy - 26}px)`;
  }

  read(): JoystickOutput {
    return {
      x: this.outX,
      y: this.outY,
      magnitude: this.magnitude,
      active: this.pointerId !== null,
    };
  }

  dispose(): void {
    this.element.remove();
  }
}
