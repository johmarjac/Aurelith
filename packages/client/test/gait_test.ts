/**
 * Prüft die Laufbewegung — ohne Browser, ohne Bild.
 *
 * Gemessen wird eine einzige Größe: wie weit sich ein Gelenk von einem Bild
 * zum nächsten bewegt. Ein Schritt ist eine Schwingung mit begrenzter
 * Frequenz und begrenztem Ausschlag, also gibt es dafür eine Obergrenze. Wer
 * sie reißt, springt — und ein Sprung sieht im Spiel aus, als hätte die Figur
 * kurz ausgesetzt.
 *
 * Der Fehler, für den dieser Test geschrieben wurde: die Schrittphase stand
 * als `zeit * frequenz` da. Das ist nur richtig, solange die Frequenz konstant
 * bleibt. Sobald das Tempo sich ändert — beim Anlaufen, beim Anhalten, beim
 * Richtungswechsel — wirkt die neue Frequenz rückwirkend auf die gesamte
 * verstrichene Zeit. Der Fehler wächst deshalb mit der Spielzeit: nach einer
 * halben Stunde war der Sprung ein Vielfaches von 2π.
 *
 *   npx tsx packages/client/test/gait_test.ts
 *
 * Mit AURELITH_GAIT_BUG=1 wird die alte, fehlerhafte Rechnung nachgestellt.
 * Das ist die Gegenprobe: ein Test, der auch damit durchgeht, misst nichts.
 */

import * as THREE from 'three';
import { createRig } from '../src/render/rigs.ts';

const BUG = process.env.AURELITH_GAIT_BUG === '1';

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/**
 * Alle Gelenkwinkel und -höhen als Vektor.
 *
 * Welcher Wert zu welchem Körperteil gehört, ist für die Frage egal: es geht
 * darum, ob *irgendetwas* springt.
 */
function pose(rig: { root: THREE.Object3D }): number[] {
  const v: number[] = [];
  rig.root.traverse((o) => v.push(o.rotation.x, o.rotation.y, o.rotation.z, o.position.y));
  return v;
}

function maxDelta(a: number[], b: number[]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

const FPS = 60;
const DT = 1 / FPS;

/**
 * Die Obergrenze eines ehrlichen Schritts.
 *
 * Zwei Anteile, beide gerechnet und nicht geraten:
 *
 *   **Die Schwingung.** Das Knie ist das schnellste Gelenk — Ausschlag 1,15
 *   rad bei 9 rad/s. Pro Bild sind das 1,15 · 9 / 60 ≈ 0,17.
 *
 *   **Der Tempowechsel.** Der Ausschlag selbst hängt am Tempo, und das läuft
 *   in 0,14 s von null auf voll an. Solange die Rampe läuft, kommen bis zu
 *   1,15 / 0,14 / 60 ≈ 0,14 dazu — allerdings nie gleichzeitig mit dem vollen
 *   Schwung, weil der Ausschlag dabei noch klein ist.
 *
 * Gemessen liegt der schlimmste Fall bei 0,15. Die Grenze steht auf 0,22:
 * genug Luft für beides zusammen, und weit unter dem, was ein echter Sprung
 * wäre — der Fehler, für den dieser Test geschrieben wurde, lag bei
 * Vielfachen von 2π.
 *
 * Vorher stand hier 0,13, hergeleitet aus einem Bein ohne Knie mit 0,65 rad
 * Ausschlag. Die Zahl war richtig, solange die Figur auf Stelzen lief.
 */
const STEP_LIMIT = 0.22;

/**
 * Fährt ein Tempoprofil ab und meldet den größten Sprung.
 *
 * Jeder Lauf bekommt sein **eigenes** Rig. Teilte man sich eines, erbte jeder
 * Lauf die Phase des vorigen, und die Messung hinge daran, in welcher
 * Reihenfolge die Läufe stehen.
 */
function run(startTime: number, profile: (t: number) => number, seconds = 4): number {
  const rig = createRig('player', new THREE.MeshBasicMaterial());
  let prev: number[] | null = null;
  let worst = 0;

  for (let i = 0; i < seconds * FPS; i++) {
    const local = i * DT;
    const speed = profile(local);
    const time = startTime + local;

    if (BUG) {
      // Die alte Rechnung: Phase aus der absoluten Uhr. `dt` wird auf null
      // gesetzt, damit die fortgeschriebene Phase stehen bleibt, und `time`
      // trägt die Schwingung — genau wie vorher.
      const gait = Math.min(1, speed / 6);
      const swing = Math.sin(time * 9 * Math.max(0.35, gait)) * 0.65 * gait;
      rig.update({ speed, attackPhase: -1, pickupPhase: -1, dead: false, time, dt: 0 });
      // Von Hand überschreiben, was die Fabrik jetzt richtig macht.
      rig.root.traverse((o) => {
        if (o.children.length === 1 && o.children[0] instanceof THREE.Mesh) {
          o.rotation.x = swing;
        }
      });
    } else {
      rig.update({ speed, attackPhase: -1, pickupPhase: -1, dead: false, time, dt: DT });
    }

    const p = pose(rig);
    if (prev) worst = Math.max(worst, maxDelta(p, prev));
    prev = p;
  }

  rig.dispose();
  return worst;
}

console.log(`Aurelith — Laufbewegung${BUG ? '  [Gegenprobe: alte Rechnung]' : ''}\n`);

// --- Gleichmäßiges Tempo ---------------------------------------------------
//
// Ohne Tempowechsel gibt es keinen Frequenzwechsel, also auch mit der alten
// Rechnung keinen Sprung. Der Fall ist trotzdem wichtig: er zeigt, dass die
// Grenze überhaupt einzuhalten ist.

console.log('Gleichmaessiges Tempo');
for (const start of [0, 300, 1800]) {
  const worst = run(start, () => 5);
  check(
    worst <= STEP_LIMIT,
    `nach ${(start / 60).toFixed(0)} Minuten Laufzeit`,
    `groesster Sprung ${worst.toFixed(3)} rad`,
  );
}

// --- Richtungswechsel ------------------------------------------------------
//
// Beim Wechsel der Richtung bricht das Tempo kurz ein und läuft wieder hoch.
// Die Rampen entsprechen ACCEL_TIME und DECEL_TIME aus der Steuerung — dort
// springt nichts, das Tempo ändert sich stetig.

console.log('\nRichtungswechsel');
const wende = (t: number): number => {
  if (t < 1) return 5;
  if (t < 1.2) return 5 - (t - 1) * (4 / 0.2); // abbremsen in 0,2 s auf 1
  if (t < 1.34) return 1 + (t - 1.2) * (4 / 0.14); // anfahren in 0,14 s auf 5
  return 5;
};
for (const start of [0, 300, 1800]) {
  const worst = run(start, wende);
  check(
    worst <= STEP_LIMIT,
    `nach ${(start / 60).toFixed(0)} Minuten Laufzeit`,
    `groesster Sprung ${worst.toFixed(3)} rad`,
  );
}

// --- Anhalten und Anlaufen -------------------------------------------------

console.log('\nAnhalten und wieder anlaufen');
const halt = (t: number): number => {
  if (t < 1) return 5;
  if (t < 1.2) return 5 - (t - 1) * (5 / 0.2);
  if (t < 2) return 0;
  if (t < 2.14) return (t - 2) * (5 / 0.14);
  return 5;
};
for (const start of [0, 1800]) {
  const worst = run(start, halt);
  check(
    worst <= STEP_LIMIT,
    `nach ${(start / 60).toFixed(0)} Minuten Laufzeit`,
    `groesster Sprung ${worst.toFixed(3)} rad`,
  );
}

// --- Andere Rigs -----------------------------------------------------------
//
// Vierbeiner und Krabbler rechnen ihre Phase genauso. Ein Fehler, der nur bei
// der Spielfigur behoben ist, fällt am ersten Monster wieder auf.

console.log('\nMonster-Rigs beim Tempowechsel');
if (!BUG) {
  // Echte Schlüssel aus CHARACTER_CONFIGS. Ein unbekannter Name fällt still
  // auf `player` zurück — dann prüfte man fünfmal dieselbe Figur und läse
  // fünfmal denselben Wert.
  for (const key of ['mob_mote', 'mob_pup', 'mob_boar', 'mob_crawler', 'mob_warden']) {
    const rig = createRig(key, new THREE.MeshBasicMaterial());
    let prev: number[] | null = null;
    let worst = 0;
    for (let i = 0; i < 240; i++) {
      const local = i * DT;
      rig.update({
        speed: wende(local),
        attackPhase: -1,
        pickupPhase: -1,
        dead: false,
        time: 1800 + local,
        dt: DT,
      });
      const p = pose(rig);
      if (prev) worst = Math.max(worst, maxDelta(p, prev));
      prev = p;
    }
    rig.dispose();
    // Krabbler schwingen schneller (13 rad/s bei 0,5 Ausschlag ≈ 0,11).
    check(worst <= 0.16, `${key} bleibt stetig`, `groesster Sprung ${worst.toFixed(3)} rad`);
  }
}

// --- Aufheben --------------------------------------------------------------
//
// Die Geste soll man sehen: die Figur beugt sich, greift nach unten und steht
// danach wieder wie vorher. Gemessen wird die rechte Hand in Weltkoordinaten
// — eine Drehung in Bogenmass sagt nichts darüber, ob die Hand tatsächlich am
// Boden ankommt.

console.log('\nAufheben');
if (!BUG) {
  const rig = createRig('player', new THREE.MeshBasicMaterial());
  const stand = { speed: 0, attackPhase: -1, dead: false, dt: DT };

  /** Tiefster Punkt der rechten Hand über den Verlauf einer Phase. */
  const handHoehe = (phase: number): number => {
    rig.update({ ...stand, pickupPhase: phase, time: 10 });
    rig.root.updateMatrixWorld(true);
    let tiefste = Infinity;
    rig.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const p = new THREE.Vector3();
      o.getWorldPosition(p);
      tiefste = Math.min(tiefste, p.y);
    });
    return tiefste;
  };

  const ruhe = handHoehe(-1);
  const mitte = handHoehe(0.5);
  check(mitte < ruhe - 0.1, 'in der Mitte der Geste greift die Figur nach unten',
    `${ruhe.toFixed(2)} → ${mitte.toFixed(2)}`);

  // Anfang und Ende sind die Ruhestellung — sonst ruckt es beim Übergang.
  const anfang = handHoehe(0);
  const ende = handHoehe(1);
  check(Math.abs(anfang - ruhe) < 0.01, 'am Anfang steht sie noch gerade');
  check(Math.abs(ende - ruhe) < 0.01, 'und am Ende wieder');

  // Gegenprobe: ohne Geste passiert nichts. Ohne sie zeigte die Prüfung oben
  // nur, dass die Figur überhaupt Teile hat, die tief liegen.
  check(Math.abs(handHoehe(-1) - ruhe) < 1e-6, 'ohne Geste bleibt alles, wie es ist');

  rig.dispose();
}

// --- Schlag ----------------------------------------------------------------
//
// Ein Hieb muss drei Dinge erfüllen: er beginnt und endet in der Ruhestellung,
// er holt erst aus und zieht dann durch, und drei Hiebe hintereinander sehen
// verschieden aus. Alles drei sind Eigenschaften der Kurve, nicht des Bildes —
// und damit hier prüfbar.

console.log('\nSchlag');
if (!BUG) {
  const rig = createRig('player', new THREE.MeshBasicMaterial());
  const ruhe = { speed: 0, attackPhase: -1, pickupPhase: -1, dead: false, time: 3, dt: DT };

  const beiPhase = (variante: number, p: number): number[] => {
    rig.update({ ...ruhe, attackPhase: p, attackVariant: variante });
    return pose(rig);
  };
  const stand = (): number[] => {
    rig.update({ ...ruhe });
    return pose(rig);
  };

  const still = stand();
  for (const variante of [0, 1, 2]) {
    // Anfang und Ende sind die Ruhestellung. Ohne das ruckt die Figur beim
    // Übergang in den Lauf — und zwar bei jedem einzelnen Schlag.
    check(maxDelta(beiPhase(variante, 0), still) < 1e-6, `Hieb ${variante} beginnt in Ruhe`);
    check(maxDelta(beiPhase(variante, 1), still) < 1e-6, `Hieb ${variante} endet in Ruhe`);

    // Und dazwischen passiert etwas. Gemessen über den ganzen Verlauf und
    // nicht an einer festen Stelle: mitten im Durchziehen läuft der Arm durch
    // die Ruhestellung hindurch, und genau dort gemessen sähe der wuchtigste
    // Hieb aus wie gar keiner.
    let weiteste = 0;
    for (let i = 0; i <= 20; i++) {
      weiteste = Math.max(weiteste, maxDelta(beiPhase(variante, i / 20), still));
    }
    check(weiteste > 1.2, `Hieb ${variante} holt aus und zieht durch`, `${weiteste.toFixed(2)} rad`);
  }

  // Die drei unterscheiden sich — sonst wäre die Abwechslung nur eine Zahl,
  // die niemand sieht. Gesucht wird die Stelle im Verlauf, an der sie am
  // weitesten auseinanderliegen: an einer festen Phase können sich zwei ganz
  // verschiedene Hiebe zufällig kreuzen.
  const weitesteZwischen = (x: number, y: number): number => {
    let weit = 0;
    for (let i = 0; i <= 20; i++) {
      weit = Math.max(weit, maxDelta(beiPhase(x, i / 20), beiPhase(y, i / 20)));
    }
    return weit;
  };
  check(weitesteZwischen(0, 1) > 0.5, 'Schräghieb und Querhieb sehen verschieden aus',
    `${weitesteZwischen(0, 1).toFixed(2)} rad`);
  check(weitesteZwischen(0, 2) > 0.5, 'Schräghieb und Überkopf auch',
    `${weitesteZwischen(0, 2).toFixed(2)} rad`);
  check(weitesteZwischen(1, 2) > 0.5, 'und die beiden anderen untereinander',
    `${weitesteZwischen(1, 2).toFixed(2)} rad`);

  // Stetig muss er auch sein: kein Sprung von einem Bild zum nächsten. Bei
  // 0,45 s Dauer und 60 Bildern sind das rund siebenundzwanzig Schritte.
  let groesster = 0;
  let vorher = beiPhase(0, 0);
  for (let i = 1; i <= 27; i++) {
    const jetzt = beiPhase(0, i / 27);
    groesster = Math.max(groesster, maxDelta(jetzt, vorher));
    vorher = jetzt;
  }
  // Grosszügiger als beim Laufen: ein Hieb *soll* schnell sein. Aber nicht so
  // schnell, dass die Klinge von einer Seite auf die andere springt.
  check(groesster < 0.8, 'der Hieb läuft ohne Sprung durch', `${groesster.toFixed(2)} rad je Bild`);

  rig.dispose();
}

// --- Sprung ----------------------------------------------------------------
//
// Drei Eigenschaften, die zusammen den Sprung ausmachen: er verändert die Pose
// überhaupt, Steigen und Fallen sehen verschieden aus, und dazwischen wird
// überblendet statt umgeschaltet.
//
// Gemessen wird am ganzen Posenvektor und nicht an einem einzelnen Gelenk: die
// Rigs benennen ihre Teile nicht, und ein Test, der das tiefste Mesh für einen
// Fuss hält, misst irgendwann eine Hand.

console.log('\nSprung');
if (!BUG) {
  const rig = createRig('player', new THREE.MeshBasicMaterial());
  const stand = { speed: 0, attackPhase: -1, pickupPhase: -1, dead: false, time: 3, dt: DT };

  const posiere = (luft: number, steigt: boolean): number[] => {
    rig.update({ ...stand, luft, steigt });
    return pose(rig);
  };

  const amBoden = posiere(0, false);
  const steigend = posiere(1, true);
  const fallend = posiere(1, false);

  check(maxDelta(steigend, amBoden) > 0.5, 'in der Luft steht die Figur anders',
    `groesster Unterschied ${maxDelta(steigend, amBoden).toFixed(2)} rad`);
  check(maxDelta(steigend, fallend) > 0.5, 'und Steigen sieht anders aus als Fallen',
    `groesster Unterschied ${maxDelta(steigend, fallend).toFixed(2)} rad`);

  // Die Überblendung: jeder einzelne Wert der halben Pose muss zwischen Boden
  // und voller Sprunghaltung liegen. Ein Umschalten bei einer Schwelle fiele
  // hier durch — und im Bild als Zucken beim Abheben auf.
  const halb = posiere(0.5, true);
  let dazwischen = true;
  for (let i = 0; i < halb.length; i++) {
    const a = Math.min(amBoden[i]!, steigend[i]!) - 1e-6;
    const b = Math.max(amBoden[i]!, steigend[i]!) + 1e-6;
    if (halb[i]! < a || halb[i]! > b) dazwischen = false;
  }
  check(dazwischen, 'auf halbem Weg liegt jede Haltung dazwischen');

  // Die Füsse verlassen den Boden — die Eigenschaft, die man tatsächlich
  // sieht.
  //
  // Verfolgt werden **dieselben** Teile vorher und nachher: die Reihenfolge
  // beim Durchlaufen des Rigs ist fest, also taugt der Index als Kennung. Nur
  // „den tiefsten Punkt" zu messen ginge daneben, sobald ein Saum oder ein
  // Umhang tief hängt und sich beim Sprung nicht bewegt — dann bliebe der
  // tiefste Punkt stehen, obwohl die Beine längst oben sind.
  const teile = (luft: number, steigt: boolean): Array<{ x: number; y: number }> => {
    rig.update({ ...stand, luft, steigt });
    rig.root.updateMatrixWorld(true);
    const raus: Array<{ x: number; y: number }> = [];
    rig.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const p = new THREE.Vector3();
      o.getWorldPosition(p);
      raus.push({ x: p.x, y: p.y });
    });
    return raus;
  };

  const ruhe = teile(0, false);
  // Die Füsse sind die tiefsten Teile **neben** der Mittelachse: ganz unten in
  // der Mitte sitzt ein Teil des Rumpfes, das sich mit ihm hebt und nicht mit
  // den Beinen. Wer nur „das tiefste Mesh" nähme, prüfte an ihm — und bekäme
  // eine Figur durchgewunken, die im Sprung die Beine hängen lässt.
  const fuesse = ruhe
    .map((t, i) => ({ ...t, i }))
    .filter((t) => Math.abs(t.x) > 0.05)
    .sort((a, b) => a.y - b.y)
    .slice(0, 2)
    .map((t) => t.i);
  const gehoben = teile(1, true);
  const angezogen = fuesse.filter((i) => gehoben[i]!.y > ruhe[i]!.y + 0.15).length;
  check(angezogen === 2, 'beide Füsse werden angezogen',
    `${angezogen} von 2 um mehr als 15 cm`);

  // Gegenprobe: ohne Luft ändert die Steigrichtung nichts. Ohne sie prüfte
  // alles oben nur, dass `update` überhaupt etwas tut.
  check(maxDelta(posiere(0, true), amBoden) < 1e-6, 'am Boden ändert `steigt` nichts');

  rig.dispose();
}

console.log(
  `\n${failures === 0 ? 'Alle Pruefungen bestanden.' : `${failures} Pruefung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
