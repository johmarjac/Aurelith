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
  // Gelesen wird der Puffer, der tatsächlich hochgeladen wird: Ort, Farbe,
  // Grösse verschränkt. Eine zweite Sicht daneben wäre eine zweite Wahrheit
  // darüber, wo ein Funken steht.
  const N = ParticleField.PRO_PUNKT;
  const ort = (i: number) => {
    const e = field.eckdaten;
    return { x: e[i * N]!, y: e[i * N + 1]!, z: e[i * N + 2]! };
  };

  field.burst(5, 10, -3, { count: 8, color: 0xffffff, speed: 6, size: 3, life: 5, lift: 0.5 });

  // Direkt nach dem Ausbruch sitzen alle auf dem Ursprung.
  const start = ort(0);
  check(
    start.x === 5 && start.y === 10 && start.z === -3,
    'Funken starten am Einschlagpunkt',
  );

  run(field, 0.5);
  let anyMoved = false;
  let allFinite = true;
  for (let i = 0; i < 8; i++) {
    const p = ort(i);
    if (Math.hypot(p.x - 5, p.y - 10, p.z + 3) > 0.1) anyMoved = true;
    if (!Number.isFinite(p.x + p.y + p.z)) allFinite = false;
  }
  check(anyMoved, 'sie fliegen auseinander');
  check(allFinite, 'und bleiben dabei endlich');

  // Nach unten: die Schwerkraft muss wirken. Mit Auftrieb 0,5 fliegen sie erst
  // hoch, aber nach zwei Sekunden ist der Mittelwert unter dem Ursprung.
  run(field, 2.0);
  let sumY = 0;
  for (let i = 0; i < 8; i++) sumY += ort(i).y;
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

// --- Pfeilschweif ----------------------------------------------------------
//
// Der Schweif setzt seine Punkte in festen Zeitabstaenden, nicht je Bild. Der
// Unterschied faellt sonst erst auf einem schnellen Geraet auf, wo ein Pfeil
// die doppelte Zahl Punkte hinter sich herzieht — und dort sucht man ihn
// zuletzt.
//
// Getrieben wird die echte Ansicht. Die Figur ist ein Stummel: `step` fasst
// nur an, was hier steht.
console.log('\nPfeilschweif');
{
  const { WorldView } = await import('../src/render/worldView.ts');
  const { ModelRegistry } = await import('../src/render/modelRegistry.ts');
  const { TextureLoader } = await import('../src/render/textures.ts');
  const THREE = await import('three');

  const dichte = (fps: number): number => {
    const view = new WorldView(
      new ModelRegistry(),
      new TextureLoader(async () => new ArrayBuffer(0)),
      1,
    );
    view.entities.set(1, {
      id: 1,
      x: 0,
      y: 0,
      z: 0,
      height: 1.8,
      yaw: 0,
      targetX: 0,
      targetY: 0,
      targetZ: 0,
      targetYaw: 0,
      attackTimer: -1,
      speed: 0,
      state: 0,
      rig: { root: new THREE.Object3D(), update: () => {}, dispose: () => {} },
    } as never);
    view.spawnArrow(1, 10, 1, 0);

    let hoechststand = 0;
    for (let i = 0; i < Math.ceil(0.5 * fps); i++) {
      view.step(1 / fps, 0);
      hoechststand = Math.max(hoechststand, view.particles.liveCount);
    }
    return hoechststand;
  };

  const werte = [30, 60, 90, 144].map(dichte);
  check(werte[0]! > 5, 'ein Pfeil zieht einen sichtbaren Schweif', `${werte[0]} Punkte`);
  // Ein Punkt Unterschied ist erlaubt, und zwar nicht aus Nachsicht: gezählt
  // wird der Höchststand an lebenden Punkten, abgelesen jeweils am Bildende.
  // Gesetzt werden sie in festen Zeitabständen — ob der älteste im Moment des
  // Ablesens gerade noch lebt oder eben erloschen ist, hängt deshalb daran,
  // wo die Bildgrenze liegt. Der Fehler, um den es geht, sieht anders aus:
  // ein Schweif je Bild statt je Zeit ergäbe bei 144 Bildern fast das
  // Fünffache von 30, nicht einen Punkt mehr.
  const spanne = Math.max(...werte) - Math.min(...werte);
  check(
    spanne <= 1,
    'und zwar unabhaengig von der Bildrate',
    `30/60/90/144 Bilder → ${werte.join('/')} Punkte`,
  );
}

console.log(
  `\n${failures === 0 ? 'Alle Pruefungen bestanden.' : `${failures} Pruefung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
