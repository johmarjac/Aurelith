/**
 * Prüft die Glättung zwischen Eingabe und Simulation.
 *
 * Ohne DOM, ohne Browser, ohne Zeitquelle: `Steering` bekommt seine
 * Schrittweite von außen, also lässt sich hier genau derselbe Takt fahren wie
 * im Spiel — zwanzig Schritte je Sekunde.
 *
 * Jede Prüfung hat eine Gegenprobe im Kopf: sie muss durchfallen, wenn die
 * Glättung fehlt. Deshalb wird nirgends nur „bewegt sich" gemessen, sondern
 * immer die Schrittweite der Änderung.
 *
 *   npx tsx packages/client/test/steering_test.ts
 */

import { angleDelta } from '@aurelith/shared';
import {
  ACCEL_TIME,
  DECEL_TIME,
  Steering,
  TURN_RATE,
} from '../src/input/steering.ts';

/** Simulationstakt des Spiels. */
const DT = 0.05;

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/**
 * Hält eine Richtung über eine Zeitspanne und protokolliert jeden Schritt.
 *
 * Der Zustand *vor* dem ersten Schritt steht mit im Protokoll. Ohne ihn bliebe
 * ausgerechnet der grösste Sprung unsichtbar — der vom Ausgangswinkel auf den
 * ersten Ausgabewert. Genau daran ist eine frühere Fassung dieses Tests in der
 * Gegenprobe vorbeigelaufen: mit abgeschalteter Begrenzung sprang die Figur im
 * ersten Schritt um eine halbe Drehung und stand danach still, und der Test sah
 * lauter gleiche Werte.
 */
function hold(
  s: Steering,
  wishX: number,
  wishZ: number,
  seconds: number,
): { yaw: number; speed: number }[] {
  const out = [{ yaw: s.yaw, speed: s.speed }];
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    const r = s.step(wishX, wishZ, DT);
    out.push({ yaw: r.yaw, speed: Math.hypot(r.moveX, r.moveZ) });
  }
  return out;
}

const maxStep = (values: number[], diff: (a: number, b: number) => number): number => {
  let m = 0;
  for (let i = 1; i < values.length; i++) m = Math.max(m, Math.abs(diff(values[i - 1]!, values[i]!)));
  return m;
};

console.log('Aurelith — Lenkung\n');

// --- Drehen ----------------------------------------------------------------
console.log('Drehen');
{
  const s = new Steering();
  s.reset(0); // schaut nach Norden (+Z)

  // Kehrtwende: nach Süden. Der härteste Fall — eine halbe Drehung.
  const log = hold(s, 0, -1, 1.0);
  const yaws = log.map((r) => r.yaw);

  const biggest = maxStep(yaws, (a, b) => angleDelta(a, b));
  const allowed = TURN_RATE * DT;
  check(
    biggest <= allowed + 1e-6,
    'Kehrtwende ohne Sprung',
    `groesster Schritt ${biggest.toFixed(3)} rad, erlaubt ${allowed.toFixed(3)}`,
  );

  // Gegenprobe an derselben Zahl: ohne Begrenzung waere der erste Schritt PI.
  check(biggest < Math.PI * 0.5, 'kein harter Schnitt (< PI/2 je Schritt)', `${biggest.toFixed(3)} rad`);

  // Angekommen ist sie trotzdem — Glaettung darf nicht heissen „kommt nie an".
  const arrived = Math.abs(angleDelta(yaws.at(-1)!, Math.PI));
  check(arrived < 0.01, 'Kehrtwende erreicht ihr Ziel', `Restwinkel ${arrived.toFixed(4)} rad`);

  // Und zwar in der Zeit, die die Drehrate vorgibt: PI / TURN_RATE. Index 0 im
  // Protokoll ist der Zustand bei t = 0, also ist der Index direkt die Zeit.
  const expected = Math.PI / TURN_RATE;
  const reachedAt = yaws.findIndex((y) => Math.abs(angleDelta(y, Math.PI)) < 0.01) * DT;
  check(
    Math.abs(reachedAt - expected) <= DT,
    'Dauer passt zur Drehrate',
    `${reachedAt.toFixed(2)} s gemessen, ${expected.toFixed(2)} s erwartet`,
  );
}

{
  // Die Bewegung folgt der Eingabe sofort, auch waehrend sich die Figur noch
  // dreht. Das ist die Eigenschaft, die eine fruehere Fassung nicht hatte: dort
  // lief die Figur in Blickrichtung, zog also bei jedem Richtungswechsel erst
  // ein Stueck in die alte Richtung weiter. Bei einer Vierteldrehung kam sie
  // damit im Rauchtest kaum von der Stelle.
  const s = new Steering();
  s.reset(0);
  hold(s, 0, 1, 1.0); // volle Fahrt nach Norden (+Z)

  const first = s.step(1, 0, DT); // jetzt nach Osten (+X)
  check(
    first.moveX > 0.9 && Math.abs(first.moveZ) < 0.1,
    'Bewegung springt sofort in die neue Richtung',
    `(${first.moveX.toFixed(2)}, ${first.moveZ.toFixed(2)})`,
  );
  check(
    Math.abs(angleDelta(first.yaw, Math.PI / 2)) > 0.5,
    'die Blickrichtung hinkt dabei noch hinterher',
    `${first.yaw.toFixed(2)} statt ${(Math.PI / 2).toFixed(2)}`,
  );

  // Und holt binnen der erwarteten Zeit auf.
  hold(s, 1, 0, Math.PI / 2 / TURN_RATE + DT);
  check(
    Math.abs(angleDelta(s.yaw, Math.PI / 2)) < 0.02,
    'und hat nach der Drehzeit aufgeholt',
    `${s.yaw.toFixed(3)}`,
  );
}

// --- Anlaufen und Auslaufen -------------------------------------------------
console.log('\nAnlaufen und Auslaufen');
{
  const s = new Steering();
  s.reset(0);
  const log = hold(s, 0, 1, 0.6); // geradeaus, keine Drehung noetig
  const speeds = log.map((r) => r.speed);

  // Index 0 ist der Stand vor dem ersten Schritt — hier also null.
  check(speeds[1]! > 0, 'reagiert im ersten Schritt', `${speeds[1]!.toFixed(2)}`);
  check(
    speeds[1]! < 0.5,
    'startet nicht mit voller Geschwindigkeit',
    `erster Schritt ${speeds[1]!.toFixed(2)} statt 1.00`,
  );
  check(speeds.at(-1)! > 0.999, 'erreicht volle Geschwindigkeit', `${speeds.at(-1)!.toFixed(3)}`);

  const rampAt = speeds.findIndex((v) => v > 0.999) * DT;
  check(
    Math.abs(rampAt - ACCEL_TIME) <= DT,
    'Anlaufzeit passt',
    `${rampAt.toFixed(2)} s, erwartet ${ACCEL_TIME.toFixed(2)} s`,
  );
}

{
  const s = new Steering();
  s.reset(0);
  hold(s, 0, 1, 0.6); // auf volle Fahrt
  const log = hold(s, 0, 0, 0.6); // loslassen
  const speeds = log.map((r) => r.speed);

  check(speeds[1]! > 0, 'bleibt nicht sofort stehen', `${speeds[1]!.toFixed(2)}`);
  check(speeds.at(-1)! === 0, 'kommt vollstaendig zum Stehen', `${speeds.at(-1)!}`);

  const stopAt = speeds.findIndex((v) => v === 0) * DT;
  check(
    Math.abs(stopAt - DECEL_TIME) <= DT,
    'Auslaufzeit passt',
    `${stopAt.toFixed(2)} s, erwartet ${DECEL_TIME.toFixed(2)} s`,
  );

  // Monoton fallend — kein Zucken auf dem Weg nach unten.
  const rising = speeds.some((v, i) => i > 0 && v > speeds[i - 1]! + 1e-9);
  check(!rising, 'Auslaufen faellt monoton');
}

// --- Blickrichtung bleibt ---------------------------------------------------
console.log('\nBlickrichtung');
{
  const s = new Steering();
  s.reset(0);
  hold(s, 1, 0, 0.6); // nach Osten laufen
  const before = s.yaw;
  hold(s, 0, 0, 1.0); // loslassen
  check(
    Math.abs(angleDelta(before, s.yaw)) < 1e-6,
    'Figur behaelt die Richtung im Stand',
    `${before.toFixed(3)} -> ${s.yaw.toFixed(3)}`,
  );
}

{
  // Nach `reset` steht die Richtung sofort — kein gemaechliches Eindrehen nach
  // dem Einloggen oder einem Kartenwechsel.
  const s = new Steering();
  s.reset(0);
  hold(s, 0, 1, 0.6);
  s.reset(Math.PI);
  const r = s.step(0, 0, DT);
  check(Math.abs(angleDelta(r.yaw, Math.PI)) < 1e-6, 'reset() setzt hart', `${r.yaw.toFixed(3)}`);
  check(Math.hypot(r.moveX, r.moveZ) === 0, 'reset() stoppt die Bewegung');
}

// --- Unabhaengig von der Schrittweite ---------------------------------------
console.log('\nSchrittweite');
{
  // Dieselbe Zeit in feineren Schritten muss zum selben Ergebnis fuehren, sonst
  // rechnet der Client bei anderer Bildrate etwas anderes als der Server.
  const coarse = new Steering();
  coarse.reset(0);
  for (let i = 0; i < 10; i++) coarse.step(0, -1, 0.05);

  const fine = new Steering();
  fine.reset(0);
  for (let i = 0; i < 50; i++) fine.step(0, -1, 0.01);

  check(
    Math.abs(angleDelta(coarse.yaw, fine.yaw)) < 1e-6,
    'gleiche Zeit, gleiches Ergebnis',
    `${coarse.yaw.toFixed(5)} vs ${fine.yaw.toFixed(5)}`,
  );
}

console.log(
  `\n${failures === 0 ? 'Alle Pruefungen bestanden.' : `${failures} Pruefung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
