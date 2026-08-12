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

import { DEFAULT_LEVELS, loadLevels, spatial } from '../src/audio/mixer.ts';

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('Aurelith — Ton\n');

// --- Seite -----------------------------------------------------------------
//
// Der Zuhörer steht im Ursprung. Für jede Blickrichtung wird eine Quelle
// genau auf die Bildschirmseiten gelegt und geprüft, ob das Vorzeichen passt.

console.log('Seite');
{
  // Weit genug weg, damit die Nahdämpfung nicht mitspielt.
  const d = 20;

  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7, 2.4]) {
    const rightX = -Math.cos(yaw) * d;
    const rightZ = Math.sin(yaw) * d;

    const rechts = spatial(rightX, rightZ, yaw);
    const links = spatial(-rightX, -rightZ, yaw);

    check(
      rechts.pan > 0.5,
      `bei yaw=${yaw.toFixed(2)} klingt bildschirmrechts rechts`,
      `pan ${rechts.pan.toFixed(2)}`,
    );
    check(
      links.pan < -0.5,
      `bei yaw=${yaw.toFixed(2)} klingt bildschirmlinks links`,
      `pan ${links.pan.toFixed(2)}`,
    );
  }

  // Geradeaus und genau hinter dem Rücken gehören in die Mitte.
  const vorn = spatial(Math.sin(0.7) * 20, Math.cos(0.7) * 20, 0.7);
  const hinten = spatial(-Math.sin(0.7) * 20, -Math.cos(0.7) * 20, 0.7);
  check(Math.abs(vorn.pan) < 0.01, 'geradeaus bleibt mittig', `pan ${vorn.pan.toFixed(3)}`);
  check(Math.abs(hinten.pan) < 0.01, 'im Rücken bleibt mittig', `pan ${hinten.pan.toFixed(3)}`);

  // Der eigene Schlag: Entfernung null, keine Seite.
  check(spatial(0, 0, 1.2).pan === 0, 'am eigenen Ort keine Seite');
}

// --- Entfernung ------------------------------------------------------------

console.log('\nEntfernung');
{
  check(spatial(0, 0, 0).gain === 1, 'direkt daneben volle Lautstaerke');
  check(spatial(0, 5, 0).gain === 1, 'innerhalb des Nahbereichs unveraendert');

  const mittel = spatial(0, 30, 0).gain;
  const fern = spatial(0, 55, 0).gain;
  check(mittel < 1 && mittel > 0, 'auf halber Strecke gedaempft', mittel.toFixed(3));
  check(fern < mittel, 'weiter weg noch leiser', `${mittel.toFixed(3)} → ${fern.toFixed(3)}`);
  check(spatial(0, 60, 0).gain === 0, 'ausserhalb der Reichweite stumm');
  check(spatial(0, 200, 0).gain === 0, 'weit ausserhalb ebenso');

  // Monoton fallend — ohne Beule irgendwo in der Mitte.
  let vorher = Infinity;
  let monoton = true;
  for (let dz = 0; dz <= 60; dz += 0.5) {
    const g = spatial(0, dz, 0).gain;
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

console.log(
  `\n${failures === 0 ? 'Alle Pruefungen bestanden.' : `${failures} Pruefung(en) fehlgeschlagen.`}`,
);
process.exit(failures === 0 ? 0 : 1);
