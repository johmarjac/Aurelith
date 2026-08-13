/**
 * Woher der Build seine Kennung nimmt — **nur für Node**.
 *
 * Bewusst nicht in `index.ts` gelistet und mit `.node.ts` benannt: die Datei
 * ruft `git` auf und liest Umgebungsvariablen. Im Browserbündel hätte sie
 * nichts verloren, und der Name sagt das an der Importstelle.
 *
 * Zwei Nutzer, eine Antwort: der Client lässt sie beim Bauen laufen und backt
 * das Ergebnis ein (siehe `vite.config.ts`), der Server ruft sie beim Start
 * auf. Stünde die Reihenfolge zweimal da, hiesse dieselbe Fassung auf beiden
 * Seiten irgendwann verschieden.
 */

import { execFileSync } from 'node:child_process';
import type { BuildStamp } from './stamp.ts';

/** Ruft `git` auf und liefert nichts, wenn es das hier nicht gibt. */
function git(...args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim();
  } catch {
    // Kein git, kein Arbeitsbaum — im Container der Normalfall.
    return undefined;
  }
}

/**
 * Nummer und Zeit dieses Baus.
 *
 * Die Reihenfolge ist die von „am besten belegt" nach „gerade noch
 * brauchbar":
 *
 *   1. `AURELITH_BUILD` / `AURELITH_BUILD_TIME` — was die Veröffentlichung
 *      gesetzt hat. Im Containerbild der einzige Weg: dort gibt es weder
 *      Arbeitsbaum noch git.
 *   2. Der Arbeitsbaum: kurzer Commit-Hash und das Datum dieses Commits. In
 *      der Entwicklung die ehrlichste Angabe — sie benennt den Stand, aus dem
 *      gebaut wurde, und nicht den Moment, in dem jemand den Server gestartet
 *      hat.
 *   3. `dev` und die aktuelle Uhrzeit.
 *
 * `jetzt` kommt von aussen, damit der Fallback prüfbar ist.
 */
export function ermittleBuildStamp(
  env: Record<string, string | undefined> = process.env,
  jetzt: number = Date.now(),
): BuildStamp {
  const nummer = env.AURELITH_BUILD?.trim();
  const zeitText = env.AURELITH_BUILD_TIME?.trim();
  if (nummer) {
    const zeit = zeitText ? deuteZeit(zeitText) : undefined;
    return { nummer, zeit: zeit ?? jetzt };
  }

  const hash = git('rev-parse', '--short=6', 'HEAD');
  if (hash) {
    const commitZeit = deuteZeit(git('log', '-1', '--format=%cI') ?? '');
    return { nummer: hash, zeit: commitZeit ?? jetzt };
  }

  return { nummer: 'dev', zeit: jetzt };
}

/** Nimmt eine ISO-Zeit oder Millisekunden; alles andere gilt als nicht gesetzt. */
function deuteZeit(text: string): number | undefined {
  if (!text) return undefined;
  if (/^\d+$/.test(text)) {
    const ms = Number(text);
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
  }
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms;
}
