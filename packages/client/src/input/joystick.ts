/**
 * Virtueller Joystick.
 *
 * Er hat keinen festen Platz: er erscheint dort, wo der Daumen die untere linke
 * Ecke berührt. Das ist der Unterschied zwischen „geht" und „geht gut" — bei
 * einem festen Kreis muss man hinsehen, bei einem mitwandernden nicht.
 *
 * Aber er erscheint **einmal** und bleibt dann liegen, wo er erschienen ist.
 *
 * Vorher zog die Mitte dem Daumen nach, sobald er den Rand erreichte — „damit
 * er nicht am Anschlag klebt". Das Kleben war aber gar kein Schaden: am
 * Anschlag ist volle Geschwindigkeit, und weiter geht es nicht. Der Schaden
 * war das Nachziehen. Wer eine Weile in eine Richtung hielt, schob den ganzen
 * Joystick vor sich her — quer über das Bild, unter die Aktionsleiste, aus der
 * Daumenecke heraus. Und weil die Mitte mitgewandert war, lag sie danach nicht
 * mehr dort, wo der Daumen sie angefasst hatte: Zurückziehen tat erst nichts,
 * bis der Daumen die gewanderte Strecke wieder aufgeholt hatte, und die Figur
 * lief unterdessen weiter geradeaus.
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

/**
 * Die Daumenecke: Anteil der Bildbreite und -höhe, in Grenzen.
 *
 * Anteilig, weil ein Tablet mehr Platz hat als ein Telefon; gedeckelt, weil
 * die Ecke auf einem grossen Bild sonst so weit reicht, dass sie wieder im Weg
 * steht. Untergrenze, damit sie auf einem kleinen Bild noch zu treffen ist.
 */
const ZONE_WIDTH_RATIO = 0.45;
const ZONE_HEIGHT_RATIO = 0.42;
const ZONE_MIN_PX = 150;
const ZONE_MAX_PX = 400;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Liegt dieser Punkt in der Daumenecke? Exportiert, damit es prüfbar ist. */
export function inThumbZone(
  clientX: number,
  clientY: number,
  width = window.innerWidth,
  height = window.innerHeight,
): boolean {
  const zoneW = clamp(width * ZONE_WIDTH_RATIO, ZONE_MIN_PX, ZONE_MAX_PX);
  const zoneH = clamp(height * ZONE_HEIGHT_RATIO, ZONE_MIN_PX, ZONE_MAX_PX);
  return clientX <= zoneW && clientY >= height - zoneH;
}

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

  /**
   * Nimmt eine Berührung an, wenn sie in der Daumenecke beginnt.
   *
   * Vorher galt die **ganze linke Bildhälfte**. Das war bequem gedacht und
   * im Spiel eine Sperre: alles links von der Mitte gehörte dem Joystick, also
   * liess sich dort kein Monster anklicken, kein NPC ansprechen und kein Tor
   * treffen. Auf einem Telefon ist das die halbe Welt.
   *
   * Jetzt ist es die untere linke Ecke — dort, wo der Daumen ohnehin liegt.
   * Der Rest des Bildes gehört wieder der Welt.
   */
  tryClaim(pointerId: number, clientX: number, clientY: number): boolean {
    if (this.pointerId !== null) return false;
    if (!inThumbZone(clientX, clientY)) return false;

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
      /*
       * Nur der Knopf wird gedeckelt, die Mitte bleibt stehen.
       *
       * Wer weiter zieht, als der Ausschlag reicht, bekommt weiterhin vollen
       * Ausschlag in diese Richtung — mehr gibt es nicht, und die Mitte
       * hinterherzuschieben brächte nichts ausser einem Joystick, der nach
       * einem langen Wischer woanders liegt als der Daumen ihn hingelegt hat.
       */
      dx = (dx / dist) * RADIUS;
      dy = (dy / dist) * RADIUS;
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
