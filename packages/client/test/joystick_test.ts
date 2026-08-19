/**
 * Der Joystick auf dem Telefon — bleibt er liegen, wo man ihn anfasst?
 *
 * Er erscheint unter dem Daumen, und genau deshalb muss er dort auch bleiben.
 * Eine frühere Fassung zog die Mitte nach, sobald der Daumen den Rand
 * erreichte. Wer eine Weile in eine Richtung hielt, schob damit den ganzen
 * Joystick vor sich her, und die Mitte lag am Ende irgendwo — quer über dem
 * Bild und nicht mehr da, wo der Daumen sie hingelegt hatte. Zurückziehen tat
 * dann erst einmal nichts: der Daumen musste die gewanderte Strecke wieder
 * aufholen, während die Figur weiter geradeaus lief.
 *
 * Geprüft wird deshalb beides — dass voller Ausschlag voller Ausschlag bleibt,
 * **und** dass die Mitte sich dabei nicht bewegt.
 *
 *   npx tsx packages/client/test/joystick_test.ts
 */

// Ohne Import und ohne Export waere diese Datei fuer TypeScript kein Modul,
// und `await` ganz oben gaebe es dort nicht.
export {};

let failures = 0;
function check(ok: boolean, was: string, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${was}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('Aurelith — Joystick\n');

/*
 * Ein Bildschirm aus Pappe.
 *
 * Der Joystick baut drei `div` und schiebt sie mit `transform` umher; mehr
 * braucht er vom Browser nicht. Die Attrappe merkt sich genau das, damit der
 * Test die Lage von Mitte und Knopf ablesen kann — statt sie zu glauben.
 */
const BREITE = 420;
const HOEHE = 900;
interface PappElement {
  className: string;
  hidden: boolean;
  style: { transform: string };
  append(...kinder: PappElement[]): void;
  appendChild(kind: PappElement): void;
  remove(): void;
}
const bau = (): PappElement => ({
  className: '',
  hidden: false,
  style: { transform: '' },
  append(): void {},
  appendChild(): void {},
  remove(): void {},
});
(globalThis as unknown as { document: unknown }).document = { createElement: bau };
(globalThis as unknown as { window: unknown }).window = { innerWidth: BREITE, innerHeight: HOEHE };

const { VirtualJoystick, inThumbZone } = await import('../src/input/joystick.ts');

/** Die Zahlen aus `translate(<x>px, <y>px)`. */
function lage(transform: string): { x: number; y: number } {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(transform);
  if (!m) throw new Error(`unlesbare Verschiebung: "${transform}"`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** Die drei Teile eines Joysticks, so wie sie im Aufbau angelegt werden. */
function teile(stick: InstanceType<typeof VirtualJoystick>): {
  mitte: PappElement;
  knopf: PappElement;
} {
  const s = stick as unknown as { base: PappElement; knob: PappElement };
  return { mitte: s.base, knopf: s.knob };
}

/** Der Daumen liegt unten links — dort, wo er beim Halten ohnehin liegt. */
const START = { x: 80, y: HOEHE - 120 };

// ---------------------------------------------------------------------------
console.log('Er erscheint unter dem Daumen');

{
  const wirt = bau();
  const stick = new VirtualJoystick(wirt as unknown as HTMLElement);
  const { mitte } = teile(stick);

  check(inThumbZone(START.x, START.y, BREITE, HOEHE), 'unten links ist Daumenecke');
  // Gegenprobe: sonst wäre die Ecke der ganze Bildschirm, und links liesse sich
  // nichts mehr anklicken.
  check(!inThumbZone(BREITE - 20, 60, BREITE, HOEHE), 'oben rechts nicht');

  check(stick.element.hidden, 'vor der Berührung ist er unsichtbar');
  check(stick.tryClaim(1, START.x, START.y), 'er nimmt die Berührung an');
  check(!stick.element.hidden, 'und wird sichtbar');
  const gelegt = lage(mitte.style.transform);
  check(
    Math.abs(gelegt.x + 62 - START.x) < 0.001 && Math.abs(gelegt.y + 62 - START.y) < 0.001,
    'die Mitte liegt genau unter dem Daumen',
    `(${gelegt.x + 62}, ${gelegt.y + 62})`,
  );
  stick.dispose();
}

// ---------------------------------------------------------------------------
console.log('Und bleibt liegen, egal wie weit man zieht');

{
  const wirt = bau();
  const stick = new VirtualJoystick(wirt as unknown as HTMLElement);
  const { mitte, knopf } = teile(stick);
  stick.tryClaim(1, START.x, START.y);
  const mitteAmAnfang = mitte.style.transform;

  // Ein Wischer weit über den Rand hinaus: dreihundert Bildpunkte nach oben,
  // in kleinen Schritten wie ein Finger es täte.
  for (let i = 1; i <= 30; i++) stick.move(1, START.x, START.y - i * 10);

  const weit = stick.read();
  check(
    mitte.style.transform === mitteAmAnfang,
    'die Mitte steht nach dreihundert Bildpunkten noch am selben Fleck',
    mitte.style.transform,
  );
  check(
    Math.abs(weit.magnitude - 1) < 0.001 && weit.y < -0.99,
    'und der Ausschlag steht voll nach oben',
    `${weit.x.toFixed(2)} / ${weit.y.toFixed(2)}`,
  );
  const knopfLage = lage(knopf.style.transform);
  const abstand = Math.hypot(knopfLage.x + 26 - START.x, knopfLage.y + 26 - START.y);
  check(
    Math.abs(abstand - 62) < 0.001,
    'der Knopf hängt am Rand und nicht am Daumen',
    `${abstand.toFixed(1)} Bildpunkte von der Mitte`,
  );

  // Weit genug zurück, und es geht andersherum.
  stick.move(1, START.x, START.y + 100);
  const zurueck = stick.read();
  check(
    zurueck.y > 0.99,
    'zurückziehen dreht die Richtung um',
    `${zurueck.x.toFixed(2)} / ${zurueck.y.toFixed(2)}`,
  );

  /*
   * Und hier fällt die gewanderte Mitte auf: der Daumen liegt wieder **genau**
   * auf dem Punkt, an dem er angefasst hat, also muss die Figur stehen.
   *
   * Mit dem alten Nachziehen lag die Mitte nach dem Wischer dreihundert
   * Bildpunkte weiter oben, und derselbe Punkt hiess dann „mehr als halbe
   * Fahrt nach oben". Man legte den Daumen zurück auf den Anfang, und die
   * Figur lief weiter.
   */
  stick.move(1, START.x, START.y);
  const ruhe = stick.read();
  check(
    ruhe.magnitude === 0 && ruhe.x === 0 && ruhe.y === 0,
    'und in der Mitte steht sie still',
    `${ruhe.x} / ${ruhe.y}`,
  );
  stick.dispose();
}

// ---------------------------------------------------------------------------
console.log('Dazwischen bleibt er feinfühlig');

{
  const wirt = bau();
  const stick = new VirtualJoystick(wirt as unknown as HTMLElement);
  stick.tryClaim(1, START.x, START.y);

  // Ein Zittern von acht Bildpunkten ist keine Absicht.
  stick.move(1, START.x + 8, START.y);
  check(stick.read().magnitude === 0, 'ein Zittern von acht Bildpunkten bewegt nichts');

  // Die halbe Strecke ist auch etwa halbe Geschwindigkeit — und nicht null und
  // nicht voll. Ohne diese Prüfung wäre auch ein Joystick grün, der nur die
  // beiden Enden kennt.
  stick.move(1, START.x + 31, START.y);
  const halb = stick.read();
  check(
    halb.magnitude > 0.3 && halb.magnitude < 0.7,
    'auf halbem Weg gibt es halbe Geschwindigkeit',
    halb.magnitude.toFixed(2),
  );
  check(halb.x > 0.3 && Math.abs(halb.y) < 0.001, 'und zwar nach rechts', `${halb.x.toFixed(2)}`);

  // Loslassen räumt auf: eine hängengebliebene Richtung liefe endlos weiter.
  stick.release(1);
  const los = stick.read();
  check(
    !los.active && los.magnitude === 0 && los.x === 0 && los.y === 0,
    'nach dem Loslassen ist alles auf null',
  );
  check(stick.element.hidden, 'und der Joystick wieder unsichtbar');

  // Eine fremde Berührung darf ihn weder bewegen noch loslassen: der zweite
  // Finger gehört der Kamera.
  stick.tryClaim(2, START.x, START.y);
  check(!stick.move(9, START.x + 60, START.y), 'ein fremder Finger bewegt ihn nicht');
  check(stick.read().magnitude === 0, 'und der Ausschlag bleibt bei null');
  check(!stick.release(9), 'und lässt ihn nicht los');
  stick.dispose();
}

console.log(`\n${failures === 0 ? 'Alle Prüfungen bestanden.' : `${failures} Prüfung(en) fehlgeschlagen.`}`);
process.exit(failures === 0 ? 0 : 1);
