/**
 * Eingabe für zwei Geräteklassen.
 *
 * Beide Wege erzeugen dasselbe Ergebnis — eine Bewegungsrichtung in
 * Weltachsen, eine Blickrichtung und den Zustand der Angriffstaste. Was
 * darüber liegt, unterscheidet sich:
 *
 *   Desktop  WASD bewegt, rechte Maustaste dreht die Kamera, Rad zoomt,
 *            Leertaste oder Linksklick schlägt zu.
 *   Mobil    Ein Daumen links ist der Joystick, ein Finger rechts dreht die
 *            Kamera, zwei Finger zoomen, ein Knopf schlägt zu.
 *
 * Die Bewegungsrichtung ist immer kamerarelativ: „vorwärts" heißt dorthin, wo
 * man hinsieht. Alles andere fühlt sich in der dritten Person falsch an.
 */

import type { Scene3D } from '../render/scene.ts';
import { VirtualJoystick } from './joystick.ts';

export interface InputSnapshot {
  /** Bewegungswunsch in Weltachsen, Länge höchstens 1. */
  moveX: number;
  moveZ: number;
  /** Blickrichtung, die die Figur einnehmen soll. */
  yaw: number;
  attack: boolean;
  interact: boolean;
}

/** Empfindlichkeit der Kameradrehung, Bogenmaß je Pixel. */
const LOOK_SPEED = 0.0055;
const TOUCH_LOOK_SPEED = 0.0075;

export class InputManager {
  readonly joystick?: VirtualJoystick;

  /** Wird gesetzt, wenn der Spieler die Angriffstaste neu drückt. */
  onAttackPressed?: () => void;
  /** Klick oder Tipper ins Bild, in normalisierten Gerätekoordinaten. */
  onPick?: (ndcX: number, ndcY: number) => void;

  private readonly keys = new Set<string>();
  private attackHeld = false;
  private attackButtonHeld = false;
  private interactPressed = false;

  /** Zeiger, der gerade die Kamera dreht. */
  private lookPointer: number | null = null;
  private lookX = 0;
  private lookY = 0;
  private lookMoved = 0;

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
        e.preventDefault();
        if (!this.attackHeld) this.onAttackPressed?.();
        this.attackHeld = true;
      }
      if (e.code === 'KeyF') this.interactPressed = true;
    };
    const up = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
      if (e.code === 'Space') this.attackHeld = false;
    };
    const blur = () => {
      this.keys.clear();
      this.attackHeld = false;
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
        // Rechte und mittlere Taste drehen ausschließlich.
        this.startLook(e.pointerId, e.clientX, e.clientY);
        this.canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      if (e.button === 0) {
        // Linke Taste dreht auch — schlägt aber zu, wenn sie sich kaum bewegt.
        this.startLook(e.pointerId, e.clientX, e.clientY);
        this.canvas.setPointerCapture(e.pointerId);
        this.attackHeld = true;
        this.onAttackPressed?.();
      }
    };

    const move = (e: PointerEvent) => {
      if (this.lookPointer !== e.pointerId) return;
      this.applyLook(e.clientX, e.clientY, LOOK_SPEED);
    };

    const up = (e: PointerEvent) => {
      if (this.lookPointer === e.pointerId) {
        // Ein Klick, der sich kaum bewegt hat, ist ein Klick — nicht ein Drehen.
        if (e.button === 0 && this.lookMoved < 6) {
          const rect = this.canvas.getBoundingClientRect();
          this.onPick?.(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -(((e.clientY - rect.top) / rect.height) * 2 - 1),
          );
        }
        this.lookPointer = null;
      }
      if (e.button === 0) this.attackHeld = false;
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

  /** Liefert den Eingabezustand dieses Frames in Weltachsen. */
  read(): InputSnapshot {
    let localX = 0;
    let localZ = 0;

    if (this.joystick) {
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
    const yaw = this.scene.yaw;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const moveX = localX * cos + localZ * sin;
    const moveZ = -localX * sin + localZ * cos;

    const moving = Math.hypot(moveX, moveZ) > 0.001;
    const interact = this.interactPressed;
    this.interactPressed = false;

    return {
      moveX,
      moveZ,
      // Beim Laufen schaut die Figur in Laufrichtung, im Stand in Blickrichtung
      // der Kamera. Das ist die Konvention, die Flyff und Metin2 beide nutzen.
      yaw: moving ? Math.atan2(moveX, moveZ) : yaw,
      attack: this.attackHeld || this.attackButtonHeld,
      interact,
    };
  }

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
