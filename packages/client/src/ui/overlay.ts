/**
 * Namensschilder und Schadenszahlen.
 *
 * Beides liegt als DOM über der Leinwand und wird je Frame an die projizierte
 * Weltposition geschoben. Der Vorteil gegenüber Sprites in der Szene ist
 * scharfer Text in jeder Auflösung; der Preis ist, dass es sich nur für
 * wenige gleichzeitige Elemente lohnt — deshalb die Deckelung.
 *
 * Beide Sorten arbeiten aus einem Pool. Elemente je Frame zu erzeugen und
 * wegzuwerfen wäre die zuverlässigste Art, den Garbage Collector im Takt der
 * Bildrate zu wecken.
 */

import * as THREE from 'three';
import { EntityState, EntityType, type LootRow } from '@aurelith/shared';
import type { EntityVisual } from '../render/worldView.ts';

/** Mehr Schilder gleichzeitig sind auf keinem Bildschirm noch lesbar. */
const MAX_NAMEPLATES = 24;
const MAX_DAMAGE_NUMBERS = 40;
/** Ab dieser Entfernung wird kein Schild mehr gezeichnet. */
const NAMEPLATE_RANGE = 48;

/**
 * Beuteschilder gibt es weniger und näher als Namensschilder.
 *
 * Näher, weil ein Haufen in vierzig Metern nichts ist, was man anklicken will;
 * weniger, weil sie anders als Namensschilder *bedienbar* sind — zwölf
 * Klickflächen übereinander wären ein Feld aus Fehlgriffen.
 */
const MAX_LOOT_LABELS = 12;
const LOOT_LABEL_RANGE = 22;

/**
 * Wie lange eine Sprechblase über dem Kopf steht.
 *
 * Lang genug, um sie im Vorbeilaufen zu lesen, kurz genug, dass eine
 * Unterhaltung nicht als Wand aus Blasen über der Wiese hängt. Der letzte
 * Satz gilt: wer nachlegt, ersetzt seine eigene Blase, statt eine zweite
 * danebenzustellen.
 */
const BLASE_MS = 5200;

interface FloatingNumber {
  element: HTMLDivElement;
  x: number;
  y: number;
  z: number;
  age: number;
  lifetime: number;
  driftX: number;
}

export class Overlay {
  readonly element: HTMLDivElement;

  /**
   * Wird gerufen, wenn jemand auf ein Beuteschild tippt.
   *
   * Das Schild ist bewusst die Klickfläche und nicht das Modell am Boden. Ein
   * Haufen ist einen halben Meter groß und liegt oft hinter einer Figur; auf
   * dem Telefon wäre er kaum zu treffen. Das Schild steht darüber, ist so
   * breit wie sein Text und fängt den Druck ab, bevor er die Welt erreicht.
   */
  onPickup?: (lootId: number) => void;

  private readonly plates: HTMLDivElement[] = [];
  private readonly lootLabels: HTMLDivElement[] = [];
  /** Der Auswahlrahmen. Genau einer — es gibt genau ein Ziel. */
  private zielRahmen?: HTMLDivElement;
  private readonly numbers: FloatingNumber[] = [];
  private readonly numberPool: HTMLDivElement[] = [];

  private readonly projected = new THREE.Vector3();

  /**
   * Das Kurzzeichen der eigenen Zugriffsstufe — leer für gewöhnliche Spieler.
   *
   * Nur die **eigene**: die Stufe eines fremden Kontos steht in keinem
   * Schnappschuss, und sie gehört auch nicht hinein. Wer wissen will, wer hier
   * Spielleiter ist, soll das im Spiel erfahren und nicht am Namensschild
   * ablesen können.
   */
  private eigenerRang = '';

  /** Setzt das Kurzzeichen. Aus der Zugriffsstufe des angemeldeten Kontos. */
  setzeRang(kurz: string): void {
    this.eigenerRang = kurz;
  }

  /**
   * Was gerade über wessen Kopf steht — Kennung des Wesens auf Text und Frist.
   *
   * Am **Wesen** und nicht am Namen: über einem Kopf steht der Figurenname,
   * gesprochen wird unter dem Kontonamen, und zwei Figuren desselben Namens
   * gibt es auf zwei Karten sehr wohl.
   */
  private readonly blasen = new Map<number, { text: string; bis: number }>();
  private readonly blasenEls = new Map<number, HTMLDivElement>();

  constructor(host: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'overlay';
    host.appendChild(this.element);
  }

  private plate(index: number): HTMLDivElement {
    let el = this.plates[index];
    if (el) return el;

    el = document.createElement('div');
    el.className = 'nameplate';
    // Das Auftragszeichen steht *über* dem Namen, wie man es kennt: ein „!"
    // heisst „hier gibt es etwas", ein „?" heisst „hier gibst du es ab".
    el.innerHTML =
      '<div class="np-mark"></div><div class="np-name"></div><div class="np-bar"><span></span></div>';
    this.element.appendChild(el);
    this.plates[index] = el;
    return el;
  }

  /**
   * Lässt jemanden etwas sagen — sichtbar über seinem Kopf.
   *
   * Ohne Wesen keine Blase: eine Zeile aus dem Globalkanal kommt von jemandem,
   * der drei Karten weiter steht, und über welchem Kopf sie stehen sollte,
   * gibt es hier nicht zu entscheiden.
   */
  zeigeBlase(entityId: number, text: string): void {
    if (entityId === 0 || text.length === 0) return;
    this.blasen.set(entityId, { text, bis: performance.now() + BLASE_MS });
  }

  /**
   * Schiebt die Sprechblasen an ihre Köpfe — je Bild.
   *
   * Getrennt von den Namensschildern, obwohl beides über demselben Kopf sitzt:
   * Schilder sind gedeckelt und nach Entfernung sortiert, Blasen nicht. Wer
   * spricht, soll zu sehen sein, auch als fünfundzwanzigster in der Menge —
   * und die **eigene** Figur trägt eine, obwohl sie nie ein Schild bekommt.
   */
  updateSprechblasen(
    camera: THREE.PerspectiveCamera,
    entities: Iterable<EntityVisual>,
    width: number,
    height: number,
  ): void {
    const jetzt = performance.now();
    for (const [id, blase] of this.blasen) {
      if (blase.bis > jetzt) continue;
      this.blasen.delete(id);
      this.blasenEls.get(id)?.remove();
      this.blasenEls.delete(id);
    }
    if (this.blasen.size === 0) return;

    const gesehen = new Set<number>();
    for (const e of entities) {
      const blase = this.blasen.get(e.id);
      if (!blase) continue;
      gesehen.add(e.id);

      let el = this.blasenEls.get(e.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'sprechblase';
        this.element.appendChild(el);
        this.blasenEls.set(e.id, el);
      }
      if (el.textContent !== blase.text) el.textContent = blase.text;

      // Über dem Namensschild, nicht darauf: das Schild sitzt bei +0,45 über
      // dem Scheitel, die Blase eine gute Kopfhöhe darüber.
      this.projected.set(e.x, e.y + e.height + 1.05, e.z).project(camera);
      if (this.projected.z > 1) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      el.style.transform =
        `translate(${(this.projected.x * 0.5 + 0.5) * width}px, ` +
        `${(-this.projected.y * 0.5 + 0.5) * height}px) translate(-50%, -100%)`;
      // Die letzte Sekunde blendet aus — ein Verschwinden ohne Übergang liest
      // sich als Aussetzer der Anzeige.
      const rest = blase.bis - jetzt;
      el.style.opacity = String(Math.max(0, Math.min(1, rest / 900)));
    }

    // Wer aus dem Bild gelaufen ist, hat keine Lage mehr — seine Blase auch
    // nicht. Sie bleibt in der Liste stehen und kommt wieder, wenn er wieder
    // auftaucht; nur zu sehen ist sie in der Zwischenzeit nicht.
    for (const [id, el] of this.blasenEls) {
      if (!gesehen.has(id)) el.style.display = 'none';
    }
  }

  /**
   * Setzt die Schilder neu. `entities` wird nach Entfernung sortiert, damit bei
   * mehr Zielen als Plätzen die nächsten gewinnen.
   */
  updateNameplates(
    camera: THREE.PerspectiveCamera,
    entities: Iterable<EntityVisual>,
    localId: number,
    targetId: number,
    width: number,
    height: number,
    /** Auftragszeichen je NPC-Kennung: „neu", „laeuft" oder „fertig". */
    marks?: ReadonlyMap<string, string>,
  ): void {
    const candidates: Array<{ e: EntityVisual; dist: number }> = [];

    for (const e of entities) {
      /*
       * Die eigene Figur bekommt **auch** ein Schild.
       *
       * Sie hatte lange keines, und die Begründung war naheliegend: man weiss
       * ja, wer man ist. Nur sieht man in einer Menge nicht mehr, welche der
       * Figuren die eigene ist — und wer eine Zugriffsstufe hat, soll sie über
       * dem Kopf tragen, so wie andere sie an ihm sehen würden.
       */
      if (e.state === EntityState.Dead) continue;
      const dist = camera.position.distanceTo(this.projected.set(e.x, e.y, e.z));
      if (dist > NAMEPLATE_RANGE) continue;
      candidates.push({ e, dist });
    }

    candidates.sort((a, b) => a.dist - b.dist);
    const shown = Math.min(candidates.length, MAX_NAMEPLATES);

    for (let i = 0; i < shown; i++) {
      const { e } = candidates[i]!;
      const el = this.plate(i);

      this.projected.set(e.x, e.y + e.height + 0.45, e.z).project(camera);
      // Hinter der Kamera projiziert Three.js nach vorn gespiegelt — solche
      // Punkte müssen weg, sonst kleben Schilder am falschen Bildrand.
      if (this.projected.z > 1) {
        el.style.display = 'none';
        continue;
      }

      const sx = (this.projected.x * 0.5 + 0.5) * width;
      const sy = (-this.projected.y * 0.5 + 0.5) * height;

      el.style.display = '';
      el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%)`;
      el.dataset.kind =
        e.type === EntityType.Monster ? 'monster' : e.type === EntityType.Npc ? 'npc' : 'player';
      el.dataset.target = String(e.id === targetId);
      // Rot, sobald das Wesen jemanden verfolgt. Nicht nur „greift mich an":
      // ein Monster, das gerade jemand anderen jagt, ist genauso gefährlich,
      // wenn man ihm in den Weg läuft.
      el.dataset.aggro = String(e.type === EntityType.Monster && e.aggro);

      // Reihenfolge der Kinder: Zeichen, Name, Balken. `firstElementChild` war
      // einmal der Name — seit über ihm das Auftragszeichen hängt, wäre das
      // still der falsche Knoten.
      const mark = el.children[0] as HTMLElement;
      const name = el.children[1] as HTMLElement;

      const markKind = e.type === EntityType.Npc ? marks?.get(e.defId) : undefined;
      const markText = markKind === 'neu' ? '!' : markKind ? '?' : '';
      if (mark.textContent !== markText) mark.textContent = markText;
      mark.dataset.kind = markKind ?? '';

      /*
       * Der eigene Rang steht in eckigen Klammern vor dem Namen, und dann ist
       * die ganze Zeile rot — nicht nur die Klammer. Ein Schild, bei dem nur
       * das Präfix gefärbt ist, liest sich wie zwei Angaben; gemeint ist eine.
       */
      const eigen = e.id === localId;
      const rang = eigen ? this.eigenerRang : '';
      el.dataset.rang = rang;
      const label =
        e.type === EntityType.Monster
          ? `${e.name} (${e.level})`
          : rang
            ? `[${rang}] ${e.name}`
            : e.name;
      if (name.textContent !== label) name.textContent = label;

      const bar = el.lastElementChild as HTMLElement;
      const fill = bar.firstElementChild as HTMLElement;
      // NPCs haben keine Lebenspunkte, die jemanden interessieren.
      const showBar = e.type === EntityType.Monster;
      bar.style.visibility = showBar ? 'visible' : 'hidden';
      if (showBar) {
        fill.style.transform = `scaleX(${Math.max(0, Math.min(1, e.hp / Math.max(1, e.maxHp)))})`;
      }
    }

    for (let i = shown; i < this.plates.length; i++) {
      this.plates[i]!.style.display = 'none';
    }
  }

  /**
   * Legt den Auswahlrahmen an: vier Ecken, die auf das Ziel zeigen.
   *
   * Vier Kinder und kein Bild: die Ecken sollen mit dem Ziel wachsen und
   * schrumpfen, und eine Grafik dafür wäre entweder unscharf oder ein Satz
   * Dateien für jede Grösse.
   */
  private rahmen(): HTMLDivElement {
    if (this.zielRahmen) return this.zielRahmen;
    const el = document.createElement('div');
    el.className = 'ziel-rahmen';
    el.innerHTML = '<i></i><i></i><i></i><i></i>';
    el.style.display = 'none';
    // Vor die Schilder, damit ein Namensschild darüber lesbar bleibt.
    this.element.insertBefore(el, this.element.firstChild);
    this.zielRahmen = el;
    return el;
  }

  /**
   * Setzt den Auswahlrahmen um das anvisierte Wesen.
   *
   * Hell heisst anvisiert, rot heisst angegriffen — dieselbe Auskunft, die
   * auch der Auftrag der Figur trägt, nur sichtbar. `kampf` kommt deshalb von
   * aussen und wird hier nicht erraten: das Overlay weiss nichts davon, was
   * die Figur vorhat.
   *
   * Die Grösse wird aus der **projizierten** Höhe des Wesens genommen und
   * nicht aus einer festen Zahl: ein Rahmen in fester Pixelgrösse liegt in der
   * Ferne um das halbe Bild und in der Nähe im Bauch des Monsters.
   */
  updateZielrahmen(
    camera: THREE.PerspectiveCamera,
    ziel: EntityVisual | undefined,
    kampf: boolean,
    width: number,
    height: number,
  ): void {
    const el = this.rahmen();
    if (!ziel || ziel.state === EntityState.Dead) {
      el.style.display = 'none';
      return;
    }

    // Fusspunkt und Scheitel getrennt projizieren — daraus ergibt sich die
    // Höhe im Bild, und die stimmt auch bei geneigter Kamera ungefähr.
    this.projected.set(ziel.x, ziel.y, ziel.z).project(camera);
    if (this.projected.z > 1) {
      el.style.display = 'none';
      return;
    }
    const fussY = (-this.projected.y * 0.5 + 0.5) * height;
    const mitteX = (this.projected.x * 0.5 + 0.5) * width;

    this.projected.set(ziel.x, ziel.y + ziel.height, ziel.z).project(camera);
    const kopfY = (-this.projected.y * 0.5 + 0.5) * height;

    // Etwas Luft rundherum, sonst klebt der Rahmen am Modell.
    const hoehe = Math.max(28, Math.min(420, Math.abs(fussY - kopfY) * 1.35));
    const breite = hoehe * 0.85;
    // Die Ecken wachsen mit, aber gedeckelt: sonst füllen sie bei einem Wesen
    // direkt vor der Nase den halben Bildschirm.
    const ecke = Math.max(7, Math.min(22, hoehe * 0.2));

    el.style.display = '';
    el.style.width = `${Math.round(breite)}px`;
    el.style.height = `${Math.round(hoehe)}px`;
    el.style.setProperty('--ecke', `${Math.round(ecke)}px`);
    el.style.transform =
      `translate(${Math.round(mitteX)}px, ${Math.round((fussY + kopfY) / 2)}px) ` +
      'translate(-50%, -50%)';
    el.dataset.kampf = String(kampf);
  }

  private lootLabel(index: number): HTMLDivElement {
    let el = this.lootLabels[index];
    if (el) return el;

    el = document.createElement('div');
    el.className = 'loot-label';
    // Auf `pointerdown` und nicht auf `click`: die Welt darunter hört
    // ebenfalls auf `pointerdown`, und ein `click` käme zu spät, um ihn zu
    // verschlucken. `stopPropagation` verhindert, dass derselbe Druck
    // zusätzlich ein Ziel wählt.
    el.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const id = Number(el?.dataset.loot ?? 0);
      if (id > 0) this.onPickup?.(id);
    });
    this.element.appendChild(el);
    this.lootLabels[index] = el;
    return el;
  }

  /**
   * Setzt die Beuteschilder neu.
   *
   * `label` kommt von aussen, weil der Name eines Gegenstands aus der
   * Inhaltstabelle stammt und die Beschriftung von Gold anders lautet — beides
   * weiß die Ansicht, die die Haufen führt, und nicht dieses Overlay.
   */
  updateLootLabels(
    camera: THREE.PerspectiveCamera,
    piles: Iterable<{ row: LootRow }>,
    label: (row: LootRow) => string,
    width: number,
    height: number,
  ): void {
    const candidates: Array<{ row: LootRow; dist: number }> = [];
    for (const { row } of piles) {
      const dist = camera.position.distanceTo(this.projected.set(row.x, row.y, row.z));
      if (dist > LOOT_LABEL_RANGE) continue;
      candidates.push({ row, dist });
    }

    candidates.sort((a, b) => a.dist - b.dist);
    const shown = Math.min(candidates.length, MAX_LOOT_LABELS);

    for (let i = 0; i < shown; i++) {
      const { row } = candidates[i]!;
      const el = this.lootLabel(i);

      this.projected.set(row.x, row.y + 1.05, row.z).project(camera);
      if (this.projected.z > 1) {
        el.style.display = 'none';
        continue;
      }

      const sx = (this.projected.x * 0.5 + 0.5) * width;
      const sy = (-this.projected.y * 0.5 + 0.5) * height;

      el.style.display = '';
      el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%)`;
      el.dataset.loot = String(row.id);
      el.dataset.kind = row.gold > 0 ? 'gold' : 'item';

      const text = label(row);
      if (el.textContent !== text) el.textContent = text;
    }

    for (let i = shown; i < this.lootLabels.length; i++) {
      this.lootLabels[i]!.style.display = 'none';
      // Die Kennung mit ausräumen: ein verborgenes Schild, das noch eine alte
      // Nummer trägt, hebt beim nächsten Treffer den falschen Haufen auf.
      delete this.lootLabels[i]!.dataset.loot;
    }
  }

  /** Wirft eine Zahl über einer Weltposition aus. */
  addNumber(
    x: number,
    y: number,
    z: number,
    text: string,
    kind: 'dealt' | 'taken' | 'crit' | 'exp',
  ): void {
    if (this.numbers.length >= MAX_DAMAGE_NUMBERS) {
      // Die älteste weicht — neuer Schaden ist immer interessanter.
      const oldest = this.numbers.shift();
      if (oldest) this.recycle(oldest);
    }

    const element = this.numberPool.pop() ?? document.createElement('div');
    element.className = 'damage';
    element.dataset.kind = kind;
    element.textContent = text;
    element.style.opacity = '1';
    this.element.appendChild(element);

    this.numbers.push({
      element,
      x,
      y,
      z,
      age: 0,
      lifetime: kind === 'crit' ? 1.3 : 1.0,
      // Leichte Streuung zur Seite, damit mehrere Treffer nicht übereinander
      // liegen — bei mehreren Angreifern auf einem Ziel ist das der Normalfall.
      driftX: (Math.random() - 0.5) * 0.9,
    });
  }

  private recycle(n: FloatingNumber): void {
    n.element.remove();
    if (this.numberPool.length < MAX_DAMAGE_NUMBERS) this.numberPool.push(n.element);
  }

  updateNumbers(
    camera: THREE.PerspectiveCamera,
    dt: number,
    width: number,
    height: number,
  ): void {
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i]!;
      n.age += dt;
      if (n.age >= n.lifetime) {
        this.recycle(n);
        this.numbers.splice(i, 1);
        continue;
      }

      const t = n.age / n.lifetime;
      this.projected
        .set(n.x + n.driftX * t, n.y + t * 1.6, n.z)
        .project(camera);

      if (this.projected.z > 1) {
        n.element.style.opacity = '0';
        continue;
      }

      const sx = (this.projected.x * 0.5 + 0.5) * width;
      const sy = (-this.projected.y * 0.5 + 0.5) * height;
      n.element.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -50%)`;
      // Erst zum Schluss ausblenden, sonst liest man die Zahl nie zu Ende.
      n.element.style.opacity = String(Math.min(1, (1 - t) * 3));
    }
  }
}
