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
import { Steering } from './steering.ts';

export interface InputSnapshot {
  /** Bewegungswunsch in Weltachsen, Länge höchstens 1. */
  moveX: number;
  moveZ: number;
  /** Blickrichtung, die die Figur einnehmen soll. */
  yaw: number;
  attack: boolean;
  interact: boolean;
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

  /** Wird gesetzt, wenn der Spieler die Angriffstaste neu drückt. */
  onAttackPressed?: () => void;
  /** Klick oder Tipper ins Bild, in normalisierten Gerätekoordinaten. */
  onPick?: (ndcX: number, ndcY: number) => void;
  /**
   * Liegt an dieser Stelle etwas, das man anfasst statt anzugreifen?
   *
   * Beantwortet vom Spiel — hier ist nur bekannt, wo geklickt wurde, nicht
   * was dort liegt. Zwei Dinge hängen an derselben Antwort, und das ist der
   * Sinn der Sache: die Maus zeigt dort eine Hand, und ein Klick dorthin löst
   * keinen Schlag aus. Wären es zwei Abfragen, zeigte irgendwann die eine
   * eine Hand, während die andere zuschlägt.
   */
  attackBlocked?: (ndcX: number, ndcY: number) => boolean;

  private readonly keys = new Set<string>();
  /** Macht aus dem sprunghaften Wunsch eine stetige Bewegung. */
  private readonly steering = new Steering();
  /**
   * Wer den Schlag hält — getrennt nach Hand.
   *
   * Drei Flächen können angreifen: die Leertaste, die Maustaste und der Knopf
   * auf dem Telefon. Sie teilten sich einmal ein einziges Feld, und damit
   * beendete jedes Loslassen den Schlag der anderen: wer die Leertaste hielt
   * und dabei ein Ziel anklickte, hörte beim Loslassen der Maustaste auf zu
   * schlagen — die Leertaste war noch unten, die Figur stand still. Ein Feld
   * je Fläche, und der Schlag gilt, solange **irgendeine** von ihnen hält.
   */
  private attackKey = false;
  private attackMouse = false;
  private attackButtonHeld = false;
  private interactPressed = false;

  /** Hält gerade irgendeine Fläche den Schlag? */
  private get attackHeld(): boolean {
    return this.attackKey || this.attackMouse || this.attackButtonHeld;
  }

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
        e.preventDefault();
        if (!this.attackHeld) this.onAttackPressed?.();
        this.attackKey = true;
      }
      if (e.code === 'KeyF') this.interactPressed = true;
    };
    const up = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
      if (e.code === 'Space') this.attackKey = false;
    };
    const blur = () => {
      this.keys.clear();
      this.attackKey = false;
      this.attackMouse = false;
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
        // Linke Taste schlägt zu und wählt aus. Sie dreht bewusst nicht mit:
        // sonst zielt jeder Klick daneben, weil die Kamera dabei wegkippt.
        this.pickPointer = e.pointerId;
        this.pickMoved = 0;
        this.pickX = e.clientX;
        this.pickY = e.clientY;

        // Auf einen Beutehaufen geklickt heisst aufheben, nicht zuschlagen.
        // Der Schlag beginnt beim Drücken und nicht beim Loslassen — wer erst
        // beim Loslassen entscheidet, hat die Schwungphase schon angefangen
        // und sieht die Figur ins Leere hauen.
        const [nx, ny] = this.toNdc(e.clientX, e.clientY);
        if (this.attackBlocked?.(nx, ny) === true) return;

        if (!this.attackHeld) this.onAttackPressed?.();
        this.attackMouse = true;
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

      // Freie Maus: eine Hand dort, wo ein Klick etwas anfasst. Dieselbe
      // Frage wie beim Drücken — was die Hand zeigt, greift auch nicht an.
      if (this.attackBlocked) {
        const [nx, ny] = this.toNdc(e.clientX, e.clientY);
        this.canvas.style.cursor = this.attackBlocked(nx, ny) ? 'pointer' : '';
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
      if (e.button === 0) this.attackMouse = false;
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
    if (held && !this.attackHeld) this.onAttackPressed?.();
    this.attackButtonHeld = held;
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
      attack: !frozen && this.attackHeld,
      interact: !frozen && interact,
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
