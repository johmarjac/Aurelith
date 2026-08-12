/**
 * Tag und Nacht.
 *
 * Die ganze Rechnung steht hier und nicht im Renderer, aus zwei Gründen. Sie
 * ist erstens reine Mathematik — Zahlen rein, Farben raus — und damit prüfbar,
 * ohne einen Browser zu starten. Und zweitens braucht der Server sie später
 * auch: ob ein Monster nachts stärker ist oder eine Laterne brennt, ist eine
 * Regel und keine Darstellung.
 *
 * **Die Uhr kommt vom Server.** Nicht `Date.now()` des Clients: zwei Spieler
 * nebeneinander hätten sonst verschiedene Tageszeiten, und wer seine Systemuhr
 * verstellt, hätte Mittag, wenn alle anderen Nacht haben. Der Snapshot trägt
 * ohnehin `serverTimeMs` mit — mehr braucht es nicht, kein zusätzliches Paket
 * und kein Feld.
 */

import type { EnvironmentDef } from './mapFormat.ts';

/**
 * Wie lang ein voller Tag dauert.
 *
 * Vierundzwanzig Minuten: eine Spielstunde ist eine echte Minute. Das ist
 * leicht zu merken, und es sorgt dafür, dass man beim Spielen tatsächlich
 * beides zu sehen bekommt — bei einer echten Stunde je Zyklus säße die Hälfte
 * aller Sitzungen dauerhaft im Dunkeln.
 */
export const DAY_MS = 24 * 60 * 1000;

/** Sonnenaufgang und -untergang als Anteil des Tages. Nur zur Auskunft. */
export const SUNRISE = 0.25;
export const SUNSET = 0.75;

/** Tageszeit als Anteil: 0 ist Mitternacht, 0,5 ist Mittag. */
export function timeOfDay(serverTimeMs: number): number {
  const t = (serverTimeMs % DAY_MS) / DAY_MS;
  return t < 0 ? t + 1 : t;
}

/** „21:30" — für die Uhr in der Oberfläche. */
export function clockText(t: number): string {
  const total = Math.floor(t * 24 * 60);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export interface SkyState {
  /** Richtung *zur* Lichtquelle. Nachts steht dort der Mond. */
  sunDirection: [number, number, number];
  sunColor: number;
  sunIntensity: number;
  ambientColor: number;
  ambientIntensity: number;
  skyColor: number;
  horizonColor: number;
  fogColor: number;
  /**
   * Wie dunkel es ist: 0 am hellen Tag, 1 in tiefer Nacht.
   *
   * Daran hängt alles, was nachts angeht — Laternen, später Fackeln und
   * Fenster. Eine Zahl statt eines Schalters, damit das Anspringen über die
   * Dämmerung verläuft und nicht in einem Bild passiert.
   */
  darkness: number;
}

/** Nachthimmel, Mondlicht, Dämmerung. Keine Karteneinstellung, sondern Stimmung. */
const NIGHT_SKY = 0x070c1c;
const NIGHT_HORIZON = 0x16203c;
const NIGHT_FOG = 0x0c1430;
const MOON_COLOR = 0x9fb4e0;
const DUSK = 0xe08a44;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Mischt zwei 0xRRGGBB-Farben kanalweise. */
export function mixColor(a: number, b: number, t: number): number {
  const k = clamp01(t);
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * k);
  const g = Math.round(ag + (bg - ag) * k);
  const bl = Math.round(ab + (bb - ab) * k);
  return (r << 16) | (g << 8) | bl;
}

/**
 * Farben und Licht zu einer Tageszeit.
 *
 * `base` ist die Karteneinstellung und gilt als **Mittag**: so soll die Karte
 * bei vollem Licht aussehen. Alles andere entsteht daraus. Eine Karte, die
 * kein Tageslicht hat — eine Gruft zum Beispiel —, bekommt ihre Einstellung
 * unverändert zurück.
 */
export function skyAt(t: number, base: EnvironmentDef): SkyState {
  if (base.daylight === false) {
    return {
      sunDirection: [...base.sunDirection] as [number, number, number],
      sunColor: base.sunColor,
      sunIntensity: base.sunIntensity,
      ambientColor: base.ambientColor,
      ambientIntensity: base.ambientIntensity,
      skyColor: base.skyColor,
      horizonColor: base.horizonColor,
      fogColor: base.fogColor,
      // Unter Tage ist es immer Nacht — sonst brennt in der Gruft keine
      // einzige Laterne, obwohl es dort dunkler ist als draußen um Mitternacht.
      darkness: 1,
    };
  }

  // Der Bogen der Sonne. θ läuft von 0 beim Aufgang über π/2 am Mittag bis π
  // beim Untergang; darüber hinaus steht sie unter dem Horizont.
  const theta = (t - SUNRISE) * Math.PI * 2;
  const hoehe = Math.sin(theta);

  // Aufgangsrichtung: senkrecht zur Mittagsrichtung der Karte. Damit wandert
  // die Sonne über den Himmel, ohne dass die Karte etwas davon wissen muss —
  // und am Mittag steht sie da, wo die Karte sie hingestellt hat.
  const [bx, , bz] = base.sunDirection;
  const laenge = Math.hypot(bx, bz) || 1;
  const nx = bx / laenge;
  const nz = bz / laenge;
  const ex = nz;
  const ez = -nx;

  const cos = Math.cos(theta);
  const dx = ex * cos + nx * 0.35 * Math.abs(hoehe);
  const dz = ez * cos + nz * 0.35 * Math.abs(hoehe);
  let dy = hoehe;

  // Nachts scheint der Mond, und der steht am Himmel und nicht unter der
  // Karte. Ohne das Spiegeln käme das Licht von unten und die Figuren wären
  // von den Fußsohlen her beleuchtet.
  if (dy < 0) dy = -dy;

  // Wie weit der Tag ist: null, sobald die Sonne den Horizont berührt, eins,
  // sobald sie ein gutes Stück darüber steht.
  const tag = clamp01(hoehe / 0.25);
  const nacht = 1 - tag;
  /**
   * Dämmerung: am Horizont am stärksten, nach beiden Seiten auslaufend.
   *
   * Das Band ist breit — knapp ein Zehntel des Tages je Übergang. Ein enges
   * Band sah aus wie ein Farbfehler, der kurz aufblitzt: eine Dämmerung, die
   * schneller vorbei ist, als man hinsieht, ist keine.
   */
  const daemmerung = clamp01(1 - Math.abs(hoehe) / 0.45);

  const sonnenfarbe = mixColor(mixColor(MOON_COLOR, base.sunColor, tag), DUSK, daemmerung * 0.8);

  return {
    sunDirection: [dx, dy, dz],
    sunColor: sonnenfarbe,
    // Mondlicht ist nicht null: eine Nacht ohne jedes gerichtete Licht ist
    // eine Fläche aus Umgebungslicht, in der nichts mehr eine Form hat.
    sunIntensity: base.sunIntensity * tag + 0.22 * nacht,
    ambientColor: mixColor(base.ambientColor, NIGHT_HORIZON, nacht),
    // Nicht bis auf null: bei voller Dunkelheit sieht man den Boden nicht mehr
    // und läuft blind. Ein Drittel bleibt stehen — dunkel genug, dass die
    // Laternen wirken, hell genug, dass man den Weg findet.
    ambientIntensity: base.ambientIntensity * (0.34 + 0.66 * tag),
    skyColor: mixColor(base.skyColor, NIGHT_SKY, nacht),
    horizonColor: mixColor(
      mixColor(base.horizonColor, NIGHT_HORIZON, nacht),
      DUSK,
      daemmerung * 0.85,
    ),
    fogColor: mixColor(mixColor(base.fogColor, NIGHT_FOG, nacht), DUSK, daemmerung * 0.45),
    darkness: nacht,
  };
}
