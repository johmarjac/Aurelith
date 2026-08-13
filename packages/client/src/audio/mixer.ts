/**
 * Tonwiedergabe.
 *
 * Ein Mischpult mit benannten Wegen: jeder Ton geht durch die Lautstärke
 * seiner Kategorie und danach durch die Gesamtlautstärke. Wer die Waffen
 * leiser dreht, dreht damit nichts anderes leiser — und das ist der Grund,
 * warum es die Kategorien überhaupt gibt.
 *
 * Der Blueprint verlangt WebAudio, nicht `<audio>`-Elemente. Der Unterschied
 * ist nicht Geschmack: ein `<audio>`-Element je Schuss bedeutet je Schuss
 * einen Dekodierlauf und eine eigene Latenz, und Browser deckeln die Zahl
 * gleichzeitiger Elemente. WebAudio dekodiert einmal in einen Puffer und
 * spielt ihn danach beliebig oft, mit Verzögerungen im Millisekundenbereich.
 *
 * Zwei Dinge, die von außen leicht übersehen werden:
 *
 *   **Ein AudioContext startet gesperrt.** Browser lassen Ton erst nach einer
 *   Nutzerhandlung zu. Deshalb wird der Kontext nicht im Konstruktor
 *   angelegt, sondern beim ersten Tastendruck oder Tipper — und wenn er
 *   trotzdem `suspended` ist, beim nächsten Versuch wieder aufgeweckt.
 *
 *   **Lautstärke ist nicht linear.** Ein Regler auf der Hälfte soll halb so
 *   *laut* klingen, nicht die halbe Amplitude haben. Deshalb geht der
 *   Reglerwert quadriert in die Verstärkung.
 */

/** Die Wege des Mischpults. `master` liegt hinter allen anderen. */
export type SoundCategory = 'weapons' | 'effects' | 'music';

export interface MixerLevels {
  master: number;
  weapons: number;
  effects: number;
  music: number;
  muted: boolean;
}

export const DEFAULT_LEVELS: MixerLevels = {
  master: 0.7,
  weapons: 0.9,
  effects: 0.8,
  music: 0.5,
  muted: false,
};

export interface PlayOptions {
  /** Wo der Ton entsteht. Fehlt er, klingt er ohne Ort — für Oberfläche. */
  at?: { x: number; y: number; z: number };
  /** Zusätzlicher Faktor, etwa für einen leiseren Streiftreffer. */
  gain?: number;
  /**
   * Tonhöhenstreuung in Halbtönen.
   *
   * Ohne sie klingt der zehnte Bogenschuss wie eine Maschine. Schon ein
   * Viertelton hin und her nimmt dem Ganzen das Mechanische — das ist der
   * billigste Gewinn im ganzen Tonsystem.
   */
  spread?: number;
  /**
   * Grundtonhöhe als Abspielrate, 1 ist unverändert.
   *
   * Damit wird aus einer Aufnahme eine Familie: derselbe Einschlag etwas
   * höher klingt schärfer, etwas tiefer schwerer. Drei Dateien für drei
   * Trefferarten wären drei Aufnahmen, die zueinander passen müssen — hier
   * passen sie per Konstruktion, weil es dieselbe ist.
   */
  rate?: number;
}

/** Ab hier ist ein Ton nicht mehr zu hören. */
const MAX_DISTANCE = 60;
/** Innerhalb dieses Radius klingt er in voller Lautstärke. */
const FULL_DISTANCE = 6;

const STORAGE_KEY = 'aurelith.audio';

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface Spatial {
  /** Faktor aus der Entfernung, 0 bis 1. */
  gain: number;
  /**
   * Richtung im Gehör des Zuhörers, als Einheitsvektor.
   *
   * In den Achsen, die WebAudio für seinen Zuhörer vorsieht: +X rechts,
   * +Y oben, **−Z vorn**. Das Minus ist keine Laune, sondern die Vorgabe der
   * Norm — ein Zuhörer blickt entlang (0, 0, −1).
   */
  dir: { x: number; y: number; z: number };
}

/**
 * Wie laut und aus welcher Richtung ein Ton an einer Stelle klingt.
 *
 * Ausgelagert, weil hier die einzige Rechnung im ganzen Tonsystem steht, bei
 * der man sich vertun kann — und ich mich prompt vertan habe.
 *
 * Alles hängt an der Blickrichtung der Kamera. Sie blickt entlang
 * `(sin yaw, cos yaw)`; bildschirmrechts ist damit `(-cos yaw, sin yaw)` —
 * dieselbe Herleitung, an der schon die Belegung von A und D hing. Der erste
 * Anlauf hier nahm `sin(atan2(dx, dz) - yaw)`, und das ist **genau das
 * Negative** davon: jeder Ton wäre auf der falschen Seite gekommen. Im Spiel
 * fällt so etwas kaum auf, weil man nicht weiß, wo der andere Spieler steht.
 *
 * Die Höhe geht unverändert mit ein. Sie zählt nicht in die Entfernung — ein
 * Treffer zwei Meter über dem Boden ist nicht weiter weg als einer am Boden —,
 * wohl aber in die Richtung.
 */
export function spatial(
  dx: number,
  dy: number,
  dz: number,
  listenerYaw: number,
  maxDistance = MAX_DISTANCE,
  fullDistance = FULL_DISTANCE,
): Spatial {
  const distance = Math.hypot(dx, dz);
  if (distance >= maxDistance) return { gain: 0, dir: { x: 0, y: 0, z: -1 } };

  let gain = 1;
  if (distance > fullDistance) {
    // Linear abfallend statt physikalisch: eine echte 1/r-Kurve macht alles
    // ausserhalb weniger Meter unhörbar leise und klingt in einem Spiel mit
    // weiter Sicht schlicht kaputt.
    const t = (distance - fullDistance) / (maxDistance - fullDistance);
    gain = (1 - t) ** 2;
  }

  // Rechts und vorn im Gehör des Zuhörers.
  const rechts = dx * -Math.cos(listenerYaw) + dz * Math.sin(listenerYaw);
  const vorn = dx * Math.sin(listenerYaw) + dz * Math.cos(listenerYaw);

  const laenge = Math.hypot(rechts, dy, vorn);
  if (laenge < 1e-4) return { gain, dir: { x: 0, y: 0, z: -1 } };

  return {
    gain,
    // `-vorn` auf Z, weil der Zuhörer nach −Z blickt.
    dir: { x: rechts / laenge, y: dy / laenge, z: -vorn / laenge },
  };
}

/** Liest die gespeicherten Einstellungen, ohne bei Unsinn umzufallen. */
export function loadLevels(): MixerLevels {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LEVELS };
    const parsed = JSON.parse(raw) as Partial<MixerLevels>;
    return {
      master: clamp01(Number(parsed.master ?? DEFAULT_LEVELS.master)),
      weapons: clamp01(Number(parsed.weapons ?? DEFAULT_LEVELS.weapons)),
      effects: clamp01(Number(parsed.effects ?? DEFAULT_LEVELS.effects)),
      music: clamp01(Number(parsed.music ?? DEFAULT_LEVELS.music)),
      muted: parsed.muted === true,
    };
  } catch {
    // Kaputter Eintrag, privater Modus, abgeschalteter Speicher — in allen
    // Fällen ist die Vorgabe besser als ein Absturz beim Start.
    return { ...DEFAULT_LEVELS };
  }
}

export class Mixer {
  private context?: AudioContext;
  private masterGain?: GainNode;
  private categoryGain = new Map<SoundCategory, GainNode>();

  /** Dekodierte Puffer, nach Pfad. */
  private readonly buffers = new Map<string, AudioBuffer>();
  /**
   * Geholte, aber noch nicht dekodierte Daten.
   *
   * Das Vorladen läuft beim Start — und da gibt es noch keinen Tonkontext,
   * weil der eine Nutzergeste braucht. Ohne diese Zwischenablage war die
   * ganze Arbeit umsonst: die Bytes kamen an, fanden keinen Kontext vor und
   * wurden verworfen. Der erste Schlag blieb dadurch immer stumm, und erst
   * der zweite holte den Ton ein zweites Mal.
   */
  private readonly raw = new Map<string, ArrayBuffer>();
  /** Laufende Ladevorgänge, damit derselbe Ton nicht zweimal geholt wird. */
  private readonly pending = new Map<string, Promise<AudioBuffer | undefined>>();

  private levels: MixerLevels;
  /** Letzter gemeldeter Zustandswechsel — nur für die Diagnose. */
  private lastStateChange = '';
  /**
   * Ob der Kontext seit dem letzten Aufwecken unterbrochen war.
   *
   * Safari kennt `interrupted` — dorthin fällt der Ton, wenn eine andere
   * Anwendung ihn übernimmt oder man die App wechselt. Aus diesem Zustand
   * kommt ein Kontext **nicht verlässlich zurück**: `resume()` meldet Erfolg,
   * der Zustand steht auf `running`, und es bleibt trotzdem still. Genau
   * dieses Muster hat auf dem Telefon nach jedem App-Wechsel den Ton
   * abgeschaltet, bis die Seite neu geladen wurde.
   *
   * Deshalb wird hier gemerkt, dass es eine Unterbrechung gab, und beim
   * nächsten Aufwecken ein frischer Kontext gebaut. Der kostet fast nichts:
   * die Rohdaten liegen noch in `raw` und werden ohnehin neu dekodiert.
   */
  private unterbrochenGewesen = false;

  /** Wo der Zuhörer steht. Bestimmt Lautstärke und Seite eines Tons. */
  private listenerX = 0;
  private listenerY = 0;
  private listenerZ = 0;
  private listenerYaw = 0;

  constructor(levels: MixerLevels = loadLevels()) {
    this.levels = levels;
  }

  get settings(): MixerLevels {
    return { ...this.levels };
  }

  /** Ob überhaupt schon Ton möglich ist — der Kontext braucht eine Geste. */
  get ready(): boolean {
    return this.context?.state === 'running';
  }

  /**
   * Wie es um den Ton steht, in Worten.
   *
   * Nicht für den Code, sondern für die Anzeige. „Ich höre nichts" hat auf
   * einem Telefon drei mögliche Ursachen — der Kontext schläft noch, der
   * Regler steht auf stumm, oder der Lautlos-Schalter des Geräts ist an —
   * und nur die ersten beiden kann die Seite überhaupt sehen. Wer das
   * angezeigt bekommt, muss nicht raten.
   */
  get state(): 'stumm' | 'wartet' | 'bereit' | 'unterbrochen' | 'unmoeglich' {
    if (this.levels.muted) return 'stumm';
    if (!this.context) return 'wartet';
    if (this.context.state === 'running') return 'bereit';
    if (this.context.state === 'closed') return 'unmoeglich';
    // `interrupted` ist Safaris eigener Zustand für „eine andere Anwendung
    // hat den Ton übernommen" — Anruf, Siri, Wecker. Von „wartet auf die
    // erste Geste" zu unterscheiden, weil die Abhilfe dieselbe, der Grund
    // aber ein ganz anderer ist.
    return (this.context.state as string) === 'interrupted' ? 'unterbrochen' : 'wartet';
  }

  /**
   * Weckt den Tonkontext. Muss aus einer Nutzerhandlung heraus geschehen.
   *
   * Mehrfach aufzurufen ist ausdrücklich vorgesehen: der Kontext kann später
   * wieder einschlafen, etwa wenn der Tab lange im Hintergrund lag.
   */
  resume(): void {
    // Ein geschlossener Kontext lässt sich nicht wiederbeleben — dann bleibt
    // nur, einen neuen zu bauen. Die Rohdaten liegen noch da und werden
    // gleich neu dekodiert.
    //
    // Ein unterbrochen gewesener genauso: siehe `unterbrochenGewesen`. Der
    // alte wird zugemacht, damit das Gerät ihn nicht weiter mitschleppt;
    // scheitert das Zumachen, ist es auch egal — er wird ohnehin losgelassen.
    const zustand = this.context?.state as string | undefined;
    const totgeglaubt =
      zustand === 'closed' || (this.unterbrochenGewesen && zustand !== 'running');

    if (this.context && totgeglaubt) {
      if (zustand !== 'closed') void this.context.close?.().catch(() => undefined);
      this.context = undefined;
      this.masterGain = undefined;
      this.categoryGain.clear();
      this.buffers.clear();
      this.unterbrochenGewesen = false;
    }

    if (!this.context) {
      type WithWebkit = typeof globalThis & { webkitAudioContext?: typeof AudioContext };
      const Ctor = globalThis.AudioContext ?? (globalThis as WithWebkit).webkitAudioContext;
      if (!Ctor) return;

      this.context = new Ctor();
      this.masterGain = this.context.createGain();
      this.masterGain.connect(this.context.destination);

      for (const key of ['weapons', 'effects', 'music'] as const) {
        const gain = this.context.createGain();
        gain.connect(this.masterGain);
        this.categoryGain.set(key, gain);
      }
      this.applyLevels();

      // Ein Tropfen Stille, sofort abgespielt.
      //
      // Auf iOS reicht `resume()` allein nicht immer: der Kontext meldet
      // „running" und bleibt trotzdem taub, bis einmal etwas durch ihn
      // hindurchgelaufen ist. Ein Puffer von einem Sample kostet nichts und
      // erspart die Klasse von Fehlern, bei der alles richtig aussieht und
      // nichts zu hören ist.
      const stille = this.context.createBufferSource();
      stille.buffer = this.context.createBuffer(1, 1, this.context.sampleRate);
      stille.connect(this.context.destination);
      stille.start();

      // Alles nachholen, was vor der ersten Geste schon geladen wurde.
      for (const path of this.raw.keys()) void this.decode(path);

      this.context.addEventListener('statechange', () => {
        const jetzt = (this.context?.state ?? '?') as string;
        this.lastStateChange = jetzt;
        // Einmal unterbrochen heisst: beim nächsten Aufwecken einen neuen
        // bauen. Zurückgesetzt wird das nicht hier, sondern erst, wenn der
        // Ersatz steht — ein zwischenzeitliches `running` ist genau die Lüge,
        // um die es geht.
        if (jetzt === 'interrupted') this.unterbrochenGewesen = true;
      });
    }

    // Alles, was nicht läuft, wird aufgeweckt — nicht nur `suspended`.
    //
    // Safari kennt einen dritten Zustand: `interrupted`. Dorthin fällt der
    // Kontext, wenn eine andere Anwendung den Ton übernimmt — ein Anruf,
    // Siri, oder ein Wecker. Die Prüfung stand vorher auf `suspended`, und
    // deshalb wachte er danach nie wieder auf: das Spiel blieb bis zum
    // Neuladen stumm. Der Zustand steht nicht in der Norm, also fragt man
    // besser nach dem, was man will, statt nach dem, was man kennt.
    if (this.context.state !== 'running') void this.context.resume();
  }

  /**
   * Spielt einen bereits geladenen Ton ohne Ort — zum Ausprobieren.
   *
   * Getrennt von `play`, weil hier bewusst *kein* Puffer nachgeladen wird:
   * Wer auf „Ton testen" drückt, soll entweder etwas hören oder erfahren,
   * dass nichts da ist. Ein Knopf, der beim ersten Druck nichts tut und beim
   * zweiten schon, ist schlimmer als einer, der ehrlich fehlschlägt.
   */
  probe(path: string, category: SoundCategory, gain = 1): boolean {
    if (!this.context || this.context.state !== 'running') return false;
    if (!this.buffers.has(path)) return false;

    const source = this.context.createBufferSource();
    source.buffer = this.buffers.get(path)!;
    const voice = this.context.createGain();
    voice.gain.value = gain;
    const target = this.categoryGain.get(category);
    if (!target) return false;

    source.connect(voice).connect(target);
    source.start();
    source.onended = () => {
      source.disconnect();
      voice.disconnect();
    };
    return true;
  }

  setLevels(next: Partial<MixerLevels>): void {
    this.levels = { ...this.levels, ...next };
    this.applyLevels();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.levels));
    } catch {
      // Nicht speichern zu können ist ärgerlich, aber kein Grund, die
      // Einstellung für diese Sitzung zu verwerfen.
    }
  }

  private applyLevels(): void {
    if (!this.masterGain || !this.context) return;
    const now = this.context.currentTime;
    const master = this.levels.muted ? 0 : this.levels.master ** 2;
    // Nicht hart setzen, sondern in zwanzig Millisekunden hinüberfahren:
    // ein Sprung in der Verstärkung knackt hörbar.
    this.masterGain.gain.setTargetAtTime(master, now, 0.02);

    for (const [key, node] of this.categoryGain) {
      node.gain.setTargetAtTime(this.levels[key] ** 2, now, 0.02);
    }
  }

  setListener(x: number, y: number, z: number, yaw: number): void {
    this.listenerX = x;
    // Auf Ohrhöhe, nicht auf Fußhöhe: sonst käme jeder Treffer von oben.
    this.listenerY = y + 1.5;
    this.listenerZ = z;
    this.listenerYaw = yaw;
  }

  /**
   * Lädt einen Ton vor.
   *
   * `fetchBytes` kommt von außen — der Asset-Streamer ist der einzige Weg zu
   * Dateien, und das Mischpult soll nichts über Manifeste und CDN wissen.
   */
  async preload(path: string, fetchBytes: (path: string) => Promise<ArrayBuffer>): Promise<void> {
    await this.buffer(path, fetchBytes);
  }

  private buffer(
    path: string,
    fetchBytes: (path: string) => Promise<ArrayBuffer>,
  ): Promise<AudioBuffer | undefined> {
    const done = this.buffers.get(path);
    if (done) return Promise.resolve(done);

    const running = this.pending.get(path);
    if (running) return running;

    const task = (async (): Promise<AudioBuffer | undefined> => {
      try {
        const bytes = await fetchBytes(path);
        // Erst aufheben, dann dekodieren. Gibt es noch keinen Kontext, holt
        // `resume()` das Dekodieren nach — die Daten sind dann schon da.
        this.raw.set(path, bytes);
        return this.decode(path);
      } catch (err) {
        console.warn(`[ton] ${path} nicht ladbar:`, err);
        return undefined;
      } finally {
        this.pending.delete(path);
      }
    })();

    this.pending.set(path, task);
    return task;
  }

  /** Macht aus aufgehobenen Rohdaten einen abspielbaren Puffer. */
  private async decode(path: string): Promise<AudioBuffer | undefined> {
    const done = this.buffers.get(path);
    if (done) return done;

    const bytes = this.raw.get(path);
    if (!bytes || !this.context) return undefined;

    try {
      // `slice()`, weil decodeAudioData den Puffer übernimmt und danach
      // leert. Die Rohdaten bleiben hier liegen, falls später ein zweiter
      // Kontext entsteht.
      const decoded = await this.context.decodeAudioData(bytes.slice(0));
      this.buffers.set(path, decoded);
      return decoded;
    } catch (err) {
      console.warn(`[ton] ${path} nicht dekodierbar:`, err);
      return undefined;
    }
  }

  /**
   * Spielt einen Ton.
   *
   * Nicht `await`en: der Aufrufer steht mitten im Bild. Ist der Puffer noch
   * nicht da, wird er geholt und der Ton fällt aus — beim nächsten Mal sitzt
   * er. Ein Schuss, der zwei Sekunden zu spät kommt, wäre schlimmer als
   * einer, der fehlt.
   */
  play(
    path: string,
    category: SoundCategory,
    fetchBytes: (path: string) => Promise<ArrayBuffer>,
    options: PlayOptions = {},
  ): void {
    if (!this.context || this.levels.muted) return;

    const ready = this.buffers.get(path);
    if (!ready) {
      void this.buffer(path, fetchBytes);
      return;
    }
    if (this.context.state !== 'running') return;

    const target = this.categoryGain.get(category);
    if (!target) return;

    let gain = options.gain ?? 1;
    let richtung: Spatial['dir'] | undefined;

    if (options.at) {
      const placed = spatial(
        options.at.x - this.listenerX,
        options.at.y - this.listenerY,
        options.at.z - this.listenerZ,
        this.listenerYaw,
      );
      gain *= placed.gain;
      richtung = placed.dir;
    }

    if (gain <= 0.001) return;

    const source = this.context.createBufferSource();
    source.buffer = ready;

    const halbton = options.spread ? (Math.random() * 2 - 1) * options.spread : 0;
    const rate = (options.rate ?? 1) * 2 ** (halbton / 12);
    if (rate !== 1) source.playbackRate.value = rate;

    const voice = this.context.createGain();
    voice.gain.value = gain;

    if (richtung) {
      // Echte Raumklang-Verortung statt bloßem Links/Rechts.
      //
      // `HRTF` rechnet mit einem gemessenen Kopfmodell: der Ton erreicht das
      // abgewandte Ohr später und dumpfer, und daran hört man auch vorn von
      // hinten und oben von unten. Mit einem Stereoregler klingt beides
      // gleich mittig — ein Treffer hinter dem Rücken wäre nicht von einem
      // vor der Nase zu unterscheiden.
      //
      // Die Entfernung rechnet **nicht** der Knoten: `rolloffFactor = 0`
      // schaltet seine Dämpfung ab, und die Verortung bekommt einen
      // Einheitsvektor. Der Abstand steckt in `voice`, wo er zu einer
      // geprüften Kurve gehört statt zu einem der drei Modelle der Norm.
      const panner = this.context.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 1;
      panner.rolloffFactor = 0;
      panner.positionX.value = richtung.x;
      panner.positionY.value = richtung.y;
      panner.positionZ.value = richtung.z;
      source.connect(voice).connect(panner).connect(target);
    } else {
      source.connect(voice).connect(target);
    }

    source.start();
    // Aufräumen, sobald der Ton verklungen ist. Ohne das sammeln sich die
    // Knoten im Graphen an, und nach einer Stunde Kampf sind es Tausende.
    source.onended = () => {
      source.disconnect();
      voice.disconnect();
    };
  }

  /**
   * Was das Mischpult über sich weiß.
   *
   * Hängt an `window.aurelith`. „Es kommt kein Ton" hat zu viele mögliche
   * Ursachen, um sie einzeln durchzuprobieren — hier steht in einer Zeile, wie
   * weit es gekommen ist: keine Daten, Daten aber nicht dekodiert, dekodiert
   * aber Kontext schläft, oder alles bereit und trotzdem still (dann liegt es
   * am Gerät).
   */
  diagnostics(): {
    state: string;
    contextState: string;
    letzterWechsel: string;
    unterbrochenGewesen: boolean;
    sampleRate: number;
    geladen: string[];
    dekodiert: string[];
    levels: MixerLevels;
  } {
    return {
      state: this.state,
      contextState: this.context?.state ?? 'kein Kontext',
      letzterWechsel: this.lastStateChange,
      unterbrochenGewesen: this.unterbrochenGewesen,
      sampleRate: this.context?.sampleRate ?? 0,
      geladen: [...this.raw.keys()],
      dekodiert: [...this.buffers.keys()],
      levels: this.settings,
    };
  }

  dispose(): void {
    void this.context?.close();
    this.context = undefined;
    this.buffers.clear();
  }
}
