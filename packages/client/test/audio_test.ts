/**
 * Prüft die räumliche Zuordnung der Töne — ohne Browser, ohne Ton.
 *
 * Es geht um genau eine Frage: klingt ein Geräusch von der Seite, auf der es
 * im Bild steht? Das ist die einzige Rechnung im Tonsystem, bei der ein
 * Vorzeichen alles umdreht, und im Spiel merkt man den Fehler kaum — man
 * weiß ja nicht, wo der andere Spieler steht.
 *
 * Die Wahrheit dazu steht schon im End-to-End-Test: die Kamera blickt entlang
 * `(sin yaw, cos yaw)`, bildschirmrechts ist `(-cos yaw, sin yaw)`. Dieselbe
 * Herleitung hing schon an der Belegung von A und D.
 *
 *   npx tsx packages/client/test/audio_test.ts
 */

import { DEFAULT_LEVELS, Mixer, loadLevels, spatial } from '../src/audio/mixer.ts';

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('Aurelith — Ton\n');

// --- Richtung --------------------------------------------------------------
//
// Der Zuhörer steht im Ursprung. Für jede Blickrichtung wird eine Quelle auf
// eine bekannte Seite gelegt und geprüft, ob der Vektor stimmt, den WebAudio
// bekommt: +X rechts, +Y oben, **−Z vorn**.

console.log('Richtung');
{
  // Weit genug weg, damit nichts anderes mitspielt.
  const d = 20;

  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7, 2.4]) {
    // Bildschirmrechts ist (-cos yaw, sin yaw) — dieselbe Herleitung wie bei
    // A und D im End-to-End-Test.
    const rechtsX = -Math.cos(yaw) * d;
    const rechtsZ = Math.sin(yaw) * d;
    // Die Kamera blickt entlang (sin yaw, cos yaw).
    const vornX = Math.sin(yaw) * d;
    const vornZ = Math.cos(yaw) * d;

    const rechts = spatial(rechtsX, 0, rechtsZ, yaw);
    const links = spatial(-rechtsX, 0, -rechtsZ, yaw);
    const vorn = spatial(vornX, 0, vornZ, yaw);
    const hinten = spatial(-vornX, 0, -vornZ, yaw);

    const nah = (a: number, b: number): boolean => Math.abs(a - b) < 0.001;
    check(
      nah(rechts.dir.x, 1) && nah(links.dir.x, -1),
      `bei yaw=${yaw.toFixed(2)} liegen rechts und links richtig`,
      `${rechts.dir.x.toFixed(2)} / ${links.dir.x.toFixed(2)}`,
    );
    check(
      nah(vorn.dir.z, -1) && nah(hinten.dir.z, 1),
      `bei yaw=${yaw.toFixed(2)} liegen vorn und hinten richtig`,
      `${vorn.dir.z.toFixed(2)} / ${hinten.dir.z.toFixed(2)}`,
    );
    // Und die Achsen dürfen sich nicht mischen: was rechts liegt, liegt
    // weder vorn noch hinten.
    check(
      Math.abs(rechts.dir.z) < 0.001 && Math.abs(vorn.dir.x) < 0.001,
      `bei yaw=${yaw.toFixed(2)} bleiben die Achsen getrennt`,
    );
  }

  // Höhe: ein Treffer über dem Kopf kommt von oben, einer am Boden von unten.
  const oben = spatial(0, 5, 3, 0);
  const unten = spatial(0, -5, 3, 0);
  check(oben.dir.y > 0.5, 'ein Treffer über dem Zuhörer klingt von oben', oben.dir.y.toFixed(2));
  check(unten.dir.y < -0.5, 'und einer darunter von unten', unten.dir.y.toFixed(2));

  // Der eigene Ort hat keine Richtung — dann darf nichts durch Null geteilt
  // werden und der Vektor muss trotzdem brauchbar sein.
  const hier = spatial(0, 0, 0, 1.2);
  check(
    Number.isFinite(hier.dir.x) && Math.hypot(hier.dir.x, hier.dir.y, hier.dir.z) > 0.99,
    'am eigenen Ort bleibt der Vektor gültig',
  );
}

// --- Entfernung ------------------------------------------------------------

console.log('\nEntfernung');
{
  check(spatial(0, 0, 0, 0).gain === 1, 'direkt daneben volle Lautstaerke');
  check(spatial(0, 0, 5, 0).gain === 1, 'innerhalb des Nahbereichs unveraendert');

  const mittel = spatial(0, 0, 30, 0).gain;
  const fern = spatial(0, 0, 55, 0).gain;
  check(mittel < 1 && mittel > 0, 'auf halber Strecke gedaempft', mittel.toFixed(3));
  check(fern < mittel, 'weiter weg noch leiser', `${mittel.toFixed(3)} → ${fern.toFixed(3)}`);
  check(spatial(0, 0, 60, 0).gain === 0, 'ausserhalb der Reichweite stumm');
  check(spatial(0, 0, 200, 0).gain === 0, 'weit ausserhalb ebenso');

  // Die Hoehe zaehlt nicht in die Entfernung: ein Treffer zwei Meter ueber
  // dem Boden ist nicht weiter weg als einer am Boden.
  check(
    spatial(0, 8, 10, 0).gain === spatial(0, 0, 10, 0).gain,
    'die Hoehe aendert die Lautstaerke nicht',
  );

  // Monoton fallend — ohne Beule irgendwo in der Mitte.
  let vorher = Infinity;
  let monoton = true;
  for (let dz = 0; dz <= 60; dz += 0.5) {
    const g = spatial(0, 0, dz, 0).gain;
    if (g > vorher + 1e-9) monoton = false;
    vorher = g;
  }
  check(monoton, 'die Kurve faellt durchgehend');
}

// --- Gespeicherte Einstellungen --------------------------------------------
//
// `loadLevels` liest aus localStorage. In Node gibt es den nicht — genau der
// Fall, den die Funktion abfangen muss, statt beim Start umzufallen.

console.log('\nEinstellungen');
{
  const ohneSpeicher = loadLevels();
  check(
    ohneSpeicher.master === DEFAULT_LEVELS.master && !ohneSpeicher.muted,
    'ohne Speicher gelten die Vorgaben',
  );

  // Unsinn im Speicher darf nicht durchschlagen.
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };

  store.set('aurelith.audio', '{kaputt');
  check(loadLevels().master === DEFAULT_LEVELS.master, 'kaputter Eintrag faellt auf die Vorgabe');

  store.set('aurelith.audio', JSON.stringify({ master: 5, weapons: -2, muted: 'ja' }));
  const gebogen = loadLevels();
  check(gebogen.master === 1, 'zu grosse Werte werden gedeckelt', String(gebogen.master));
  check(gebogen.weapons === 0, 'negative Werte ebenso', String(gebogen.weapons));
  check(gebogen.muted === false, 'nur echtes true schaltet stumm', String(gebogen.muted));

  store.set('aurelith.audio', JSON.stringify({ master: 0.25, muted: true }));
  const echt = loadLevels();
  check(echt.master === 0.25 && echt.muted === true, 'gueltige Werte kommen durch');
  check(
    echt.weapons === DEFAULT_LEVELS.weapons,
    'fehlende Felder behalten ihre Vorgabe',
    String(echt.weapons),
  );
}

// --- Nach einer Unterbrechung -----------------------------------------------
//
// Der Fall vom Telefon: App gewechselt, zurueckgekommen, kein Ton mehr. Safari
// stellt den Kontext dabei auf `interrupted`, und aus diesem Zustand kommt er
// nicht verlaesslich zurueck — `resume()` meldet Erfolg, der Zustand steht auf
// `running`, und es bleibt still. Geprueft wird deshalb nicht, ob `resume()
// durchlaeuft, sondern ob danach ein **neuer** Kontext dasteht.

console.log('\nUnterbrechung');
{
  class FakeGain {
    gain = { value: 1, setTargetAtTime(): void {} };
    connect(): void {}
    disconnect(): void {}
  }
  class FakeSource {
    buffer: unknown = null;
    connect(): void {}
    start(): void {}
  }

  let gebaut = 0;
  let geschlossen = 0;

  class FakeContext {
    static letzter?: FakeContext;
    state = 'running';
    sampleRate = 48000;
    destination = {};
    currentTime = 0;
    private zuhoerer: Array<() => void> = [];

    constructor() {
      gebaut++;
      FakeContext.letzter = this;
    }
    createGain(): FakeGain {
      return new FakeGain();
    }
    createBufferSource(): FakeSource {
      return new FakeSource();
    }
    createBuffer(): unknown {
      return {};
    }
    addEventListener(_: string, fn: () => void): void {
      this.zuhoerer.push(fn);
    }
    async resume(): Promise<void> {
      // Genau die Luege, um die es geht: der Zustand springt auf `running`,
      // der Kontext bleibt aber taub.
      this.state = 'running';
    }
    async close(): Promise<void> {
      geschlossen++;
      this.state = 'closed';
    }
    /** Was Safari beim App-Wechsel tut. */
    unterbrechen(): void {
      this.state = 'interrupted';
      for (const fn of this.zuhoerer) fn();
    }
  }

  (globalThis as { AudioContext?: unknown }).AudioContext = FakeContext;

  const mixer = new Mixer({ ...DEFAULT_LEVELS });
  mixer.resume();
  check(gebaut === 1, 'die erste Geste baut einen Kontext', String(gebaut));

  mixer.resume();
  check(gebaut === 1, 'eine zweite Geste baut keinen zweiten', String(gebaut));

  FakeContext.letzter!.unterbrechen();
  check(mixer.state === 'unterbrochen', 'die Unterbrechung wird gemeldet', mixer.state);

  mixer.resume();
  check(gebaut === 2, 'nach der Unterbrechung steht ein neuer Kontext', String(gebaut));
  check(geschlossen === 1, 'und der alte wurde zugemacht', String(geschlossen));
  check(mixer.ready, 'und der neue laeuft');

  mixer.resume();
  check(gebaut === 2, 'danach wird nicht weiter neu gebaut', String(gebaut));

  // Gegenprobe: ohne die Unterbrechung darf `resume()` nichts austauschen —
  // sonst wuerde bei jeder Geste ein Kontext weggeworfen, und die Pruefung
  // oben zeigte nur, dass ueberhaupt gebaut wird.
  check(geschlossen === 1, 'und nichts weiter zugemacht', String(geschlossen));
}

console.log(
  `\n${failures === 0 ? 'Alle Pruefungen bestanden.' : `${failures} Pruefung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
