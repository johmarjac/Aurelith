/**
 * Eingabe für zwei Geräteklassen.
 *
 * Beide Wege erzeugen dasselbe Ergebnis — eine Bewegungsrichtung in
 * Weltachsen und eine Blickrichtung. Was darüber liegt, unterscheidet sich:
 *
 *   Desktop  WASD bewegt, rechte Maustaste dreht die Kamera, Rad zoomt,
 *            Linksklick wählt aus und greift an, Leertaste springt.
 *   Mobil    Ein Daumen links ist der Joystick, ein Finger rechts dreht die
 *            Kamera, zwei Finger zoomen, ein Tipper wählt aus, zwei Knöpfe
 *            greifen an und springen.
 *
 * Angriff und Sprung sind **Drücke** und kein Halten. Der Angriff heisst seit
 * dem Zielsystem „greif das an, was ausgewählt ist", und das Weiterschlagen
 * besorgt danach das Spiel; der Sprung ist ohnehin ein einzelner Absprung. Was
 * beide gemeinsam haben: eine gehaltene Taste hat hier nichts mehr zu sagen,
 * und deshalb wird nur die Flanke gemeldet.
 *
 * Die Bewegungsrichtung ist immer kamerarelativ: „vorwärts" heißt dorthin, wo
 * man hinsieht. Alles andere fühlt sich in der dritten Person falsch an.
 */

import type { Scene3D } from '../render/scene.ts';
import { VirtualJoystick } from './joystick.ts';
import { Steering } from './steering.ts';

export interface InputSnapshot {
  /** Bewegungswunsch in Weltachsen, Länge höchstens 1. */
  moveX: number;
  moveZ: number;
  /** Blickrichtung, die die Figur einnehmen soll. */
  yaw: number;
  interact: boolean;
  /**
   * In diesem Schritt wurde abgesprungen.
   *
   * Genau **einen** Schritt lang wahr, auch wenn die Taste unten bleibt: der
   * Kern lehnt einen zweiten Absprung in der Luft zwar ohnehin ab, aber die
   * Absicht gehört hierher und nicht in eine Regel dort.
   */
  sprung: boolean;
  /**
   * Der Steuerknüppel **roh**, ohne Kamera und ohne Glättung.
   *
   * Am Boden ist die Eingabe ein Wunsch, wohin es gehen soll — dafür wird sie
   * in Weltachsen gedreht und geglättet, und daraus folgt die Blickrichtung.
   * In der Luft ist sie etwas ganz anderes: W und S kippen die Nase, A und D
   * drehen den Kurs. Eine gedrehte Achse wäre dort sinnlos, denn es gibt keine
   * Richtung, in die man laufen wollte.
   *
   * Deshalb beides: `moveX`/`moveZ` für den Boden, diese hier für die Luft.
   * Ein Wert, der je nach Zustand etwas anderes bedeutet, wäre schlimmer.
   */
  rohX: number;
  rohZ: number;
  /**
   * Ob in diesem Takt tatsächlich jemand gesteuert hat.
   *
   * Nicht dasselbe wie „die Figur bewegt sich": die Glättung lässt sie noch
   * ein Stück weiterlaufen, nachdem die Taste losgelassen wurde. Wer wissen
   * will, ob ein automatischer Lauf abgebrochen werden soll, muss nach der
   * **Absicht** fragen und nicht nach der Bewegung.
   */
  manual: boolean;
}

/** Empfindlichkeit der Kameradrehung, Bogenmaß je Pixel. */
const LOOK_SPEED = 0.0055;
const TOUCH_LOOK_SPEED = 0.0075;

export class InputManager {
  readonly joystick?: VirtualJoystick;

  /**
   * Der Spieler hat die Angriffstaste gedrückt.
   *
   * Nur die **Flanke**, kein Halten: was daraus wird — anlaufen, zuschlagen,
   * weiterschlagen — entscheidet das Spiel anhand des gewählten Ziels.
   */
  onAttackPressed?: () => void;
  /** Klick oder Tipper ins Bild, in normalisierten Gerätekoordinaten. */
  onPick?: (ndcX: number, ndcY: number) => void;
  /**
   * Liegt an dieser Stelle etwas, das man mit der Hand aufnimmt?
   *
   * Beantwortet vom Spiel — hier ist nur bekannt, wo der Zeiger steht, nicht
   * was dort liegt. Ausschliesslich für den Mauszeiger: über einem Beutehaufen
   * zeigt er eine Hand.
   */
  zeigerFasstAn?: (ndcX: number, ndcY: number) => boolean;

  private readonly keys = new Set<string>();
  /** Macht aus dem sprunghaften Wunsch eine stetige Bewegung. */
  private readonly steering = new Steering();
  /**
   * Ob die Angriffstaste unten ist — getrennt nach Fläche.
   *
   * Gebraucht wird das nur, um die **Flanke** zu erkennen: `keydown`
   * wiederholt sich, solange eine Taste gehalten wird, und jede Wiederholung
   * wäre sonst ein neuer Angriffsbefehl. Der Zustand selbst geht nirgendwohin.
   */
  private attackButtonHeld = false;
  private interactPressed = false;
  /**
   * Sprungtaste gedrückt — bis der nächste Simulationsschritt sie abholt.
   *
   * `jumpKey` merkt sich, dass die Taste noch unten ist: `keydown` wiederholt
   * sich, solange man sie hält, und jede Wiederholung wäre sonst ein neuer
   * Absprung, sobald die Figur den Boden berührt.
   */
  private jumpPressed = false;
  private jumpKey = false;

  /** Zeiger, der gerade die Kamera dreht. */
  private lookPointer: number | null = null;
  private lookX = 0;
  private lookY = 0;
  private lookMoved = 0;

  /** Zeiger der linken Taste — er wählt aus, dreht aber nicht. */
  private pickPointer: number | null = null;
  private pickX = 0;
  private pickY = 0;
  private pickMoved = 0;

  /** Für die Zwei-Finger-Zoomgeste. */
  private readonly pinchPointers = new Map<number, { x: number; y: number }>();
  private pinchDistance = 0;

  private disposers: Array<() => void> = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly scene: Scene3D,
    private readonly touch: boolean,
    uiHost: HTMLElement,
  ) {
    if (touch) {
      this.joystick = new VirtualJoystick(uiHost);
      this.bindTouch();
    } else {
      this.bindKeyboard();
      this.bindMouse();
    }
    this.bindShared();
  }

  // -------------------------------------------------------------------------
  // Desktop
  // -------------------------------------------------------------------------

  private bindKeyboard(): void {
    const down = (e: KeyboardEvent) => {
      // Eingaben im Chat gehören dem Chat.
      if (isTypingTarget(e.target)) return;
      this.keys.add(e.code);
      if (e.code === 'Space') {
        // Ohne das scrollt die Seite unter dem Spiel weg.
        e.preventDefault();
        if (!this.jumpKey) this.jumpPressed = true;
        this.jumpKey = true;
      }
      if (e.code === 'KeyF') this.interactPressed = true;
    };
    const up = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
      if (e.code === 'Space') this.jumpKey = false;
    };
    const blur = () => {
      this.keys.clear();
      this.jumpKey = false;
    };

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    this.disposers.push(() => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    });
  }

  private bindMouse(): void {
    const down = (e: PointerEvent) => {
      if (e.button === 2 || e.button === 1) {
        // Rechte und mittlere Taste drehen die Kamera — und sonst nichts.
        this.startLook(e.pointerId, e.clientX, e.clientY);
        this.canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      if (e.button === 0) {
        // Die linke Taste wählt aus — anvisieren, angreifen, hingehen,
        // aufheben. Was davon, entscheidet das Spiel beim Loslassen. Sie dreht
        // bewusst nicht mit: sonst zielt jeder Klick daneben, weil die Kamera
        // dabei wegkippt.
        this.pickPointer = e.pointerId;
        this.pickMoved = 0;
        this.pickX = e.clientX;
        this.pickY = e.clientY;
      }
    };

    const move = (e: PointerEvent) => {
      if (this.pickPointer === e.pointerId) {
        this.pickMoved += Math.abs(e.clientX - this.pickX) + Math.abs(e.clientY - this.pickY);
        this.pickX = e.clientX;
        this.pickY = e.clientY;
        return;
      }
      if (this.lookPointer === e.pointerId) {
        this.applyLook(e.clientX, e.clientY, LOOK_SPEED);
        return;
      }

      // Freie Maus: eine Hand dort, wo ein Klick etwas aufhebt.
      if (this.zeigerFasstAn) {
        const [nx, ny] = this.toNdc(e.clientX, e.clientY);
        this.canvas.style.cursor = this.zeigerFasstAn(nx, ny) ? 'pointer' : '';
      }
    };

    const up = (e: PointerEvent) => {
      if (this.lookPointer === e.pointerId) this.lookPointer = null;

      if (this.pickPointer === e.pointerId) {
        // Ein Klick, der sich kaum bewegt hat, ist ein Klick — kein Wischen.
        if (this.pickMoved < 6) {
          const [nx, ny] = this.toNdc(e.clientX, e.clientY);
          this.onPick?.(nx, ny);
        }
        this.pickPointer = null;
      }
    };

    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.scene.zoom(Math.sign(e.deltaY) * 1.2);
    };

    const context = (e: Event) => e.preventDefault();

    this.canvas.addEventListener('pointerdown', down);
    this.canvas.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    this.canvas.addEventListener('wheel', wheel, { passive: false });
    this.canvas.addEventListener('contextmenu', context);

    this.disposers.push(() => {
      this.canvas.removeEventListener('pointerdown', down);
      this.canvas.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.canvas.removeEventListener('wheel', wheel);
      this.canvas.removeEventListener('contextmenu', context);
    });
  }

  // -------------------------------------------------------------------------
  // Mobil
  // -------------------------------------------------------------------------

  private bindTouch(): void {
    const down = (e: PointerEvent) => {
      if (this.joystick?.tryClaim(e.pointerId, e.clientX, e.clientY)) {
        e.preventDefault();
        return;
      }
      this.pinchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinchPointers.size === 2) {
        this.pinchDistance = this.currentPinchDistance();
        this.lookPointer = null;
        return;
      }
      this.startLook(e.pointerId, e.clientX, e.clientY);
    };

    const move = (e: PointerEvent) => {
      if (this.joystick?.move(e.pointerId, e.clientX, e.clientY)) {
        e.preventDefault();
        return;
      }

      const tracked = this.pinchPointers.get(e.pointerId);
      if (tracked) {
        tracked.x = e.clientX;
        tracked.y = e.clientY;
      }

      if (this.pinchPointers.size === 2) {
        const next = this.currentPinchDistance();
        this.scene.zoom((this.pinchDistance - next) * 0.02);
        this.pinchDistance = next;
        return;
      }

      if (this.lookPointer === e.pointerId) {
        this.applyLook(e.clientX, e.clientY, TOUCH_LOOK_SPEED);
      }
    };

    const up = (e: PointerEvent) => {
      if (this.joystick?.release(e.pointerId)) return;
      this.pinchPointers.delete(e.pointerId);
      if (this.lookPointer === e.pointerId) {
        if (this.lookMoved < 10) {
          const rect = this.canvas.getBoundingClientRect();
          this.onPick?.(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -(((e.clientY - rect.top) / rect.height) * 2 - 1),
          );
        }
        this.lookPointer = null;
      }
    };

    this.canvas.addEventListener('pointerdown', down, { passive: false });
    this.canvas.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);

    this.disposers.push(() => {
      this.canvas.removeEventListener('pointerdown', down);
      this.canvas.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    });
  }

  private currentPinchDistance(): number {
    const [a, b] = [...this.pinchPointers.values()];
    if (!a || !b) return this.pinchDistance;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  // -------------------------------------------------------------------------
  // Gemeinsames
  // -------------------------------------------------------------------------

  private bindShared(): void {
    // Kein Doppeltipp-Zoom, kein Gummiband-Scrollen.
    const preventGesture = (e: Event) => e.preventDefault();
    document.addEventListener('gesturestart', preventGesture);
    document.addEventListener('dblclick', preventGesture);
    this.disposers.push(() => {
      document.removeEventListener('gesturestart', preventGesture);
      document.removeEventListener('dblclick', preventGesture);
    });
  }

  private startLook(pointerId: number, x: number, y: number): void {
    this.lookPointer = pointerId;
    this.lookX = x;
    this.lookY = y;
    this.lookMoved = 0;
  }

  private applyLook(x: number, y: number, speed: number): void {
    const dx = x - this.lookX;
    const dy = y - this.lookY;
    this.lookX = x;
    this.lookY = y;
    this.lookMoved += Math.abs(dx) + Math.abs(dy);
    this.scene.orbit(dx * speed, dy * speed);
  }

  /** Der Angriffsknopf der Touch-Oberfläche meldet sich hierüber. */
  setAttackButton(held: boolean): void {
    if (held && !this.attackButtonHeld) this.onAttackPressed?.();
    this.attackButtonHeld = held;
  }

  /** Der Sprungknopf der Touch-Oberfläche. Dasselbe wie die Leertaste. */
  springe(): void {
    this.jumpPressed = true;
  }

  /**
   * Liefert den Eingabezustand dieses Schrittes in Weltachsen.
   *
   * `dt` ist die Schrittweite der Simulation, nicht die des Bildes: die
   * Glättung gehört in denselben festen Takt wie die Bewegung, sonst
   * unterscheidet sich das Ergebnis je nach Bildrate und die Vorhersage
   * driftet gegen den Server.
   *
   * `frozen` heißt „der Spieler steuert gerade nicht" — beim Tippen im Chat.
   * Die Glättung läuft trotzdem weiter, damit die Figur ausläuft statt zu
   * stehen wie angenagelt.
   */
  read(dt: number, frozen = false): InputSnapshot {
    let localX = 0;
    let localZ = 0;

    if (frozen) {
      // Nichts einsammeln, aber unten weiter glätten.
    } else if (this.joystick) {
      const j = this.joystick.read();
      localX = j.x;
      // Auf dem Bildschirm ist unten positiv, in der Welt ist vorne negativ.
      localZ = -j.y;
    } else {
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) localZ += 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) localZ -= 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) localX -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) localX += 1;
    }

    const length = Math.hypot(localX, localZ);
    if (length > 1) {
      localX /= length;
      localZ /= length;
    }

    // Kamerarelativ in Weltachsen drehen.
    //
    // Die Kamera steht bei `ziel - (sin yaw, cos yaw) * abstand`, ihre
    // Blickrichtung ist also `vorwärts = (sin yaw, cos yaw)`. Bildschirmrechts
    // ergibt sich daraus als Kreuzprodukt aus Blickrichtung und Oben —
    // `rechts = vorwärts × oben = (-cos yaw, sin yaw)`.
    //
    // Hier stand vorher das Negative davon, wodurch A und D vertauscht waren.
    const yaw = this.scene.yaw;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);

    const forwardX = sin;
    const forwardZ = cos;
    const rightX = -cos;
    const rightZ = sin;

    // Der rohe Wunsch. Beim Laufen schaut die Figur in Laufrichtung — und
    // behält sie danach.
    //
    // Vorher galt im Stand die Blickrichtung der Kamera, wodurch die Figur
    // beim Loslassen zurückschnappte und sich beim Drehen der Kamera
    // mitdrehte, ohne dass jemand etwas getan hätte. Die Blickrichtung gehört
    // der Figur, nicht dem Sichtwinkel.
    const wishX = localX * rightX + localZ * forwardX;
    const wishZ = localX * rightZ + localZ * forwardZ;

    const interact = this.interactPressed;
    this.interactPressed = false;
    const sprung = this.jumpPressed;
    this.jumpPressed = false;

    // Der automatische Lauf geht durch dieselbe Glättung wie die Hand am
    // Joystick — nicht an ihr vorbei. Sonst gäbe es zwei Arten, wie sich eine
    // Figur in Bewegung setzt, und die Blickrichtung käme nur bei einer davon
    // heraus: `steering` leitet sie aus dem Wunsch ab.
    //
    // Der Wunsch von aussen steht bereits in Weltachsen und wird deshalb
    // nicht mehr gedreht.
    const selbst = localX !== 0 || localZ !== 0;
    const auto = !selbst && (this.autoX !== 0 || this.autoZ !== 0);
    const steered = this.steering.step(
      auto ? this.autoX : wishX,
      auto ? this.autoZ : wishZ,
      dt,
    );

    return {
      moveX: steered.moveX,
      moveZ: steered.moveZ,
      yaw: steered.yaw,
      interact: !frozen && interact,
      sprung: !frozen && sprung,
      rohX: frozen ? 0 : localX,
      rohZ: frozen ? 0 : localZ,
      manual: selbst,
    };
  }

  /**
   * Setzt einen Bewegungswunsch, der ohne Hand am Steuer gilt.
   *
   * In **Weltachsen** und höchstens einen Meter lang. Gedacht für den Weg zu
   * einem Beutehaufen: wer darauf klickt, soll hinlaufen, ohne die Taste zu
   * halten. Eigene Eingabe schlägt ihn jederzeit — deshalb wird er nur
   * genommen, wenn gerade niemand steuert.
   */
  setAutoWish(x: number, z: number): void {
    this.autoX = x;
    this.autoZ = z;
  }

  /**
   * Setzt die Blickrichtung von außen — beim Einloggen und nach einem
   * Kartenwechsel. Ohne das stünde die Figur nach dem Erscheinen nach Norden,
   * egal was der Server gespeichert hat.
   */
  setFacing(yaw: number): void {
    this.steering.reset(yaw);
  }

  /**
   * Dreht die Figur zu einem Winkel, ohne sie anzuhalten — für den Kampf.
   *
   * Eigene Steuerung schlägt ihn: sobald jemand drückt, gilt wieder die
   * Laufrichtung.
   */
  richteAus(yaw: number): void {
    this.steering.ausrichten(yaw);
  }

  /** Bildpunkte in normalisierte Gerätekoordinaten. */
  private toNdc(clientX: number, clientY: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    ];
  }

  /** Bewegungswunsch ohne Hand am Steuer — siehe `setAutoWish`. */
  private autoX = 0;
  private autoZ = 0;

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers = [];
    this.joystick?.dispose();
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}
