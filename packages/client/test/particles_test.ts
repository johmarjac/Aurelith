/**
 * Prüft die Funkenwolke — ohne Browser, ohne Bild.
 *
 * Was hier zählt, ist nicht das Aussehen, sondern die Buchführung: dass Plätze
 * belegt und wieder frei werden, dass der Ringpuffer bei Überlast nicht
 * überläuft, und dass kein Funken ewig lebt. Genau die Sorte Fehler, die man
 * im Bild nicht sieht — bis nach zehn Minuten Kampf die Bildrate einbricht.
 *
 *   npx tsx packages/client/test/particles_test.ts
 */

import { ParticleField, burstHit } from '../src/render/particles.ts';

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Ein Schritt von einer Sechzigstelsekunde, so oft wie nötig. */
function run(field: ParticleField, seconds: number): void {
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) field.step(1 / 60);
}

console.log('Aurelith — Funken\n');

// --- Buchführung -----------------------------------------------------------
console.log('Buchfuehrung');
{
  const field = new ParticleField(64);
  check(field.liveCount === 0, 'eine frische Wolke ist leer');

  field.burst(0, 0, 0, { count: 10, color: 0xffffff, speed: 4, size: 3, life: 0.4, lift: 0.3 });
  check(field.liveCount === 10, 'ein Ausbruch belegt genau seine Plaetze', String(field.liveCount));

  field.burst(0, 0, 0, { count: 10, color: 0xffffff, speed: 4, size: 3, life: 0.4, lift: 0.3 });
  check(field.liveCount === 20, 'ein zweiter kommt dazu', String(field.liveCount));

  // Nach der laengsten moeglichen Lebensdauer (0,4 * 1,3) muss alles weg sein.
  run(field, 1.0);
  check(field.liveCount === 0, 'alle Funken erloeschen wieder', String(field.liveCount));
}

// --- Ueberlast -------------------------------------------------------------
console.log('\nUeberlast');
{
  const field = new ParticleField(32);

  // Zehn Ausbrueche zu je zwanzig auf eine Wolke fuer zweiunddreissig. Ohne
  // Ringpuffer waere das ein Ueberlauf oder ein wachsendes Feld.
  for (let i = 0; i < 10; i++) {
    field.burst(0, 0, 0, { count: 20, color: 0xffaa00, speed: 5, size: 3, life: 0.5, lift: 0.4 });
  }
  check(
    field.liveCount === 32,
    'die Wolke wird nie voller als ihre Kapazitaet',
    String(field.liveCount),
  );

  // Ein einzelner Ausbruch groesser als die Wolke wird gedeckelt.
  const small = new ParticleField(8);
  small.burst(0, 0, 0, { count: 100, color: 0xffffff, speed: 4, size: 3, life: 0.4, lift: 0 });
  check(small.liveCount === 8, 'ein zu grosser Ausbruch wird gedeckelt', String(small.liveCount));

  run(field, 1.2);
  check(field.liveCount === 0, 'auch nach Ueberlast raeumt sie vollstaendig auf');
}

// --- Bewegung --------------------------------------------------------------
console.log('\nBewegung');
{
  const field = new ParticleField(16);
  const attr = () => field.object.geometry.getAttribute('position');

  field.burst(5, 10, -3, { count: 8, color: 0xffffff, speed: 6, size: 3, life: 5, lift: 0.5 });

  // Direkt nach dem Ausbruch sitzen alle auf dem Ursprung.
  const start = attr();
  check(
    start.getX(0) === 5 && start.getY(0) === 10 && start.getZ(0) === -3,
    'Funken starten am Einschlagpunkt',
  );

  run(field, 0.5);
  const moved = attr();
  let anyMoved = false;
  let allFinite = true;
  for (let i = 0; i < 8; i++) {
    if (Math.hypot(moved.getX(i) - 5, moved.getY(i) - 10, moved.getZ(i) + 3) > 0.1) anyMoved = true;
    if (!Number.isFinite(moved.getX(i) + moved.getY(i) + moved.getZ(i))) allFinite = false;
  }
  check(anyMoved, 'sie fliegen auseinander');
  check(allFinite, 'und bleiben dabei endlich');

  // Nach unten: die Schwerkraft muss wirken. Mit Auftrieb 0,5 fliegen sie erst
  // hoch, aber nach zwei Sekunden ist der Mittelwert unter dem Ursprung.
  run(field, 2.0);
  const later = attr();
  let sumY = 0;
  for (let i = 0; i < 8; i++) sumY += later.getY(i);
  check(sumY / 8 < 10, 'und fallen am Ende', `mittlere Hoehe ${(sumY / 8).toFixed(2)} statt 10`);
}

// --- Trefferwirkung --------------------------------------------------------
console.log('\nTreffer');
{
  const field = new ParticleField(512);
  burstHit(field, 0, 1, 0, { critical: false, killing: false, budget: 80 });
  const normal = field.liveCount;
  check(normal > 0, 'ein Treffer streut Funken', String(normal));

  const critField = new ParticleField(512);
  burstHit(critField, 0, 1, 0, { critical: true, killing: false, budget: 80 });
  check(
    critField.liveCount > normal,
    'ein kritischer Treffer mehr davon',
    `${normal} → ${critField.liveCount}`,
  );

  const killField = new ParticleField(512);
  burstHit(killField, 0, 1, 0, { critical: false, killing: true, budget: 80 });
  check(
    killField.liveCount > critField.liveCount,
    'ein toedlicher noch mehr',
    `${critField.liveCount} → ${killField.liveCount}`,
  );

  // Und die Qualitaetsstufe schlaegt durch: das Budget ist kein Zierrat.
  const lowField = new ParticleField(512);
  burstHit(lowField, 0, 1, 0, { critical: false, killing: false, budget: 24 });
  check(
    lowField.liveCount < normal,
    'ein kleineres Budget streut weniger',
    `${lowField.liveCount} statt ${normal}`,
  );
}

// --- Zuruecksetzen ---------------------------------------------------------
console.log('\nZuruecksetzen');
{
  const field = new ParticleField(64);
  field.burst(0, 0, 0, { count: 30, color: 0xffffff, speed: 4, size: 3, life: 9, lift: 0 });
  check(field.liveCount === 30, 'Funken sind da');
  field.reset();
  check(field.liveCount === 0, 'reset() raeumt sofort ab');

  // Und danach ist die Wolke wieder benutzbar.
  field.burst(0, 0, 0, { count: 5, color: 0xffffff, speed: 4, size: 3, life: 0.3, lift: 0 });
  check(field.liveCount === 5, 'und laesst sich danach weiterbenutzen');
}

console.log(
  `\n${failures === 0 ? 'Alle Pruefungen bestanden.' : `${failures} Pruefung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
