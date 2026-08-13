/**
 * Fassung eines Builds — Nummer und Zeitpunkt, als eine Zeile.
 *
 * Client und Server bilden denselben String, und zwar mit derselben Funktion.
 * Zwei Formatierungen wären zwei Wahrheiten über dieselbe Sache: die Zeilen
 * stünden im selben Chatfenster untereinander und liessen sich trotzdem nicht
 * vergleichen, weil die eine den Monat vor dem Tag schreibt und die andere
 * nicht.
 */

export interface BuildStamp {
  /**
   * Buildnummer. Was der Bau als Kennung mitbekommen hat: die Laufnummer der
   * Veröffentlichung, sonst der kurze Commit-Hash, sonst `dev`.
   */
  nummer: string;
  /** Zeitpunkt des Baus, Millisekunden seit der Epoche. */
  zeit: number;
}

const zwei = (n: number): string => String(n).padStart(2, '0');

/**
 * `nummer-YYMMdd-HHmmss`, zum Beispiel `a1b2c3-260813-142207`.
 *
 * **In UTC.** Der Server steht in einem Rechenzentrum, der Spieler irgendwo
 * sonst; in Ortszeit gerechnet stünden im Chat zwei Zeiten, deren Abstand
 * nichts über den Abstand der Builds sagt. Wer beide Zeilen liest, soll sie
 * nebeneinanderhalten können.
 *
 * Ohne Zeitangabe — eine Fassung, die von einem Server ohne Stempel kommt —
 * bleibt die Nummer allein stehen. Eine erfundene Null-Zeit („700101-000000")
 * sähe aus wie eine Angabe und wäre keine.
 */
export function formatBuild(stamp: BuildStamp): string {
  const nummer = stamp.nummer.trim() || 'unbekannt';
  if (!Number.isFinite(stamp.zeit) || stamp.zeit <= 0) return nummer;

  const d = new Date(stamp.zeit);
  const datum = `${zwei(d.getUTCFullYear() % 100)}${zwei(d.getUTCMonth() + 1)}${zwei(d.getUTCDate())}`;
  const uhr = `${zwei(d.getUTCHours())}${zwei(d.getUTCMinutes())}${zwei(d.getUTCSeconds())}`;
  return `${nummer}-${datum}-${uhr}`;
}
