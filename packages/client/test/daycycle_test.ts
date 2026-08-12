/**
 * Prüft den Tageswechsel — ohne Browser, ohne Bild.
 *
 * Alles, was hier geprüft wird, ist reine Rechnung: Tageszeit rein, Licht und
 * Farben raus. Genau deshalb liegt sie in `@aurelith/shared` und nicht im
 * Renderer.
 *
 *   npx tsx packages/client/test/daycycle_test.ts
 *
 * Die Gegenprobe steht am Ende: dieselben Prüfungen laufen noch einmal gegen
 * eine absichtlich kaputte Fassung, die die Tageszeit ignoriert. Gehen sie
 * auch damit durch, messen sie nichts — und der Test schlägt fehl.
 */

import {
  DAY_MS,
  clockText,
  mixColor,
  skyAt,
  timeOfDay,
  type EnvironmentDef,
  type SkyState,
} from '@aurelith/shared';

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Lichtmoor bei Tag, gekürzt auf das, was der Zyklus liest. */
const BASE: EnvironmentDef = {
  skyColor: 0x8ec3ee,
  horizonColor: 0xdcecf9,
  fogColor: 0xc4dcf0,
  fogNear: 110,
  fogFar: 340,
  sunDirection: [0.42, 0.82, 0.38],
  sunColor: 0xfff4de,
  sunIntensity: 1.55,
  ambientColor: 0xa8c4dd,
  ambientIntensity: 0.9,
};

const luma = (c: number): number =>
  0.2126 * ((c >> 16) & 0xff) + 0.7152 * ((c >> 8) & 0xff) + 0.0722 * (c & 0xff);

// ---------------------------------------------------------------------------
// Die Uhr
// ---------------------------------------------------------------------------

console.log('\nUhr');

check(Math.abs(timeOfDay(0) - 0) < 1e-9, 'Nullpunkt ist Mitternacht', String(timeOfDay(0)));
check(Math.abs(timeOfDay(DAY_MS / 2) - 0.5) < 1e-9, 'halber Tag ist Mittag');
check(Math.abs(timeOfDay(DAY_MS * 3.25) - 0.25) < 1e-9, 'vierter Tag früh: Zyklus wiederholt sich');
// Eine Geräteuhr, die hinter der Epoche steht, gibt es — und ein negativer
// Rest hätte eine Tageszeit unter null ergeben.
check(timeOfDay(-1000) >= 0 && timeOfDay(-1000) < 1, 'negative Zeit bleibt im Bereich');

check(clockText(0) === '00:00', 'Mitternacht als Text', clockText(0));
check(clockText(0.5) === '12:00', 'Mittag als Text', clockText(0.5));
check(clockText(0.25) === '06:00', 'Sonnenaufgang als Text', clockText(0.25));
check(clockText(0.75) === '18:00', 'Sonnenuntergang als Text', clockText(0.75));

console.log('\nFarbmischung');
check(mixColor(0x000000, 0xffffff, 0) === 0x000000, 'Mischung bei 0 ist die erste Farbe');
check(mixColor(0x000000, 0xffffff, 1) === 0xffffff, 'Mischung bei 1 ist die zweite');
check(mixColor(0x000000, 0xffffff, 0.5) === 0x808080, 'Mitte ist Mitte', mixColor(0, 0xffffff, 0.5).toString(16));
// Kanäle dürfen nicht ineinanderlaufen — das passiert, sobald jemand die
// Farben als eine Zahl interpoliert statt kanalweise.
check(mixColor(0xff0000, 0x0000ff, 0.5) === 0x800080, 'Kanäle bleiben getrennt');

// ---------------------------------------------------------------------------
// Der Zyklus
// ---------------------------------------------------------------------------

/**
 * Die Prüfungen als Funktion, damit sie zweimal laufen können: einmal gegen
 * die echte Rechnung, einmal gegen die kaputte.
 */
function pruefe(f: (t: number, base: EnvironmentDef) => SkyState): number {
  const vorher = failures;

  const mittag = f(0.5, BASE);
  const mitternacht = f(0.0, BASE);
  const aufgang = f(0.25, BASE);
  const abend = f(0.8, BASE);

  check(mittag.darkness < 0.05, 'mittags ist es hell', mittag.darkness.toFixed(3));
  check(mitternacht.darkness > 0.95, 'nachts ist es dunkel', mitternacht.darkness.toFixed(3));
  check(
    mittag.sunIntensity > mitternacht.sunIntensity * 3,
    'Sonne ist deutlich stärker als der Mond',
    `${mittag.sunIntensity.toFixed(2)} zu ${mitternacht.sunIntensity.toFixed(2)}`,
  );
  check(
    mitternacht.sunIntensity > 0.05,
    'nachts bleibt gerichtetes Licht übrig',
    mitternacht.sunIntensity.toFixed(3),
  );
  check(
    mitternacht.ambientIntensity > BASE.ambientIntensity * 0.25,
    'nachts bleibt genug Umgebungslicht, um den Boden zu sehen',
    mitternacht.ambientIntensity.toFixed(2),
  );

  check(luma(mittag.skyColor) > luma(mitternacht.skyColor) * 2, 'Nachthimmel ist dunkler');
  check(luma(mittag.fogColor) > luma(mitternacht.fogColor), 'Nachtnebel ist dunkler');

  // Die Sonne steht mittags hoch und beim Aufgang am Horizont.
  const hoehe = (s: SkyState): number => {
    const [x, y, z] = s.sunDirection;
    return y / (Math.hypot(x, y, z) || 1);
  };
  check(hoehe(mittag) > 0.9, 'mittags steht die Sonne hoch', hoehe(mittag).toFixed(2));
  check(hoehe(aufgang) < 0.2, 'beim Aufgang steht sie am Horizont', hoehe(aufgang).toFixed(2));
  // Nachts scheint der Mond — von oben, nicht von unten durch die Karte.
  check(hoehe(mitternacht) > 0.5, 'nachts kommt das Licht von oben', hoehe(mitternacht).toFixed(2));

  // Die Dämmerung wärmt: mehr Rot als Blau.
  const rot = (c: number): number => ((c >> 16) & 0xff) - (c & 0xff);
  check(
    rot(abend.horizonColor) > rot(mittag.horizonColor),
    'abends wird der Horizont wärmer',
    `${rot(abend.horizonColor)} zu ${rot(mittag.horizonColor)}`,
  );

  // Und der Verlauf ist stetig: kein Sprung zwischen zwei Zeitpunkten.
  let maxSprung = 0;
  let vorheriges = f(0, BASE);
  for (let i = 1; i <= 480; i++) {
    const jetzt = f(i / 480, BASE);
    maxSprung = Math.max(maxSprung, Math.abs(jetzt.darkness - vorheriges.darkness));
    vorheriges = jetzt;
  }
  check(maxSprung < 0.06, 'die Dunkelheit läuft stetig', `größter Sprung ${maxSprung.toFixed(3)}`);

  return failures - vorher;
}

console.log('\nTageszyklus');
pruefe(skyAt);

console.log('\nOhne Tageslicht (Gruft)');
const gruft = skyAt(0.5, { ...BASE, daylight: false });
check(gruft.sunIntensity === BASE.sunIntensity, 'Werte bleiben unverändert');
check(gruft.skyColor === BASE.skyColor, 'Himmelsfarbe bleibt unverändert');
check(gruft.darkness === 1, 'unter Tage brennen die Laternen immer');

// ---------------------------------------------------------------------------
// Gegenprobe
// ---------------------------------------------------------------------------

console.log('\nGegenprobe (kaputte Fassung, muss auffallen)');
const stillFailures = failures;
const kaputt = (_t: number, base: EnvironmentDef): SkyState => ({
  sunDirection: [...base.sunDirection] as [number, number, number],
  sunColor: base.sunColor,
  sunIntensity: base.sunIntensity,
  ambientColor: base.ambientColor,
  ambientIntensity: base.ambientIntensity,
  skyColor: base.skyColor,
  horizonColor: base.horizonColor,
  fogColor: base.fogColor,
  darkness: 0,
});

// Die Ausgabe der Gegenprobe unterdrücken — sie soll fehlschlagen, und das
// zwanzig Zeilen lang vorzuführen macht das Protokoll nur unlesbar.
const echtesLog = console.log;
console.log = () => undefined;
const gefunden = pruefe(kaputt);
console.log = echtesLog;
failures = stillFailures;

check(gefunden > 0, 'die kaputte Fassung fällt durch', `${gefunden} Prüfungen schlagen an`);

console.log(failures === 0 ? '\nAlle Prüfungen bestanden.\n' : `\n${failures} Prüfung(en) fehlgeschlagen.\n`);
process.exit(failures === 0 ? 0 : 1);
