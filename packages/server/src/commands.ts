/**
 * Chatbefehle, die der **Server** ausführt.
 *
 * Die Trennung ist keine Geschmacksfrage: `/connect` und `/version` gehören
 * dem Client, weil sie von der Verbindung handeln und nicht von der Welt.
 * Alles, was am Spielstand rührt, gehört hierher — ein Client, der sich Gold
 * selbst gutschreibt, ist kein Befehl, sondern ein Fehler.
 *
 * Jeder Befehl nennt die Stufe, ab der er zusteht. Geprüft wird an einer
 * Stelle, in `run`; stünde die Prüfung in jedem Befehl, fehlte sie irgendwann
 * in einem.
 */

import { AccessLevel, accessName } from '@aurelith/shared';
import type { Session } from './session.ts';

/**
 * Was ein Befehl vom Server braucht.
 *
 * Ein schmaler Ausschnitt statt des ganzen `GameServer`: so lässt sich die
 * Befehlstabelle prüfen, ohne einen Server zu starten, und ein Befehl kann
 * nicht versehentlich an der Welt drehen.
 */
export interface CommandHost {
  /** Eine Zeile an den Absender, nur an ihn. */
  systemMessage(session: Session, text: string): void;
  /** Schreibt Gold gut und schickt die neuen Werte. */
  giveGold(session: Session, amount: number): void;
}

export interface CommandDef {
  /** Ohne Schrägstrich, kleingeschrieben. */
  name: string;
  /** Ab dieser Stufe steht der Befehl zu. */
  minLevel: AccessLevel;
  /** Eine Zeile für `/help`. */
  hilfe: string;
  run(host: CommandHost, session: Session, args: string[]): void;
}

/** Obergrenze für `/gg`. Kein Schutz vor Missbrauch, sondern vor Vertippern. */
const MAX_GOLD = 1_000_000;

export const COMMANDS: readonly CommandDef[] = [
  {
    name: 'gg',
    minLevel: AccessLevel.Gamemaster,
    hilfe: '/gg <menge> — schreibt Gold gut (ab Spielleiter)',
    run(host, session, args) {
      const menge = Number(args[0]);
      if (!Number.isInteger(menge) || menge <= 0 || menge > MAX_GOLD) {
        host.systemMessage(session, `Erwartet: /gg <ganze Zahl von 1 bis ${MAX_GOLD}>.`);
        return;
      }
      host.giveGold(session, menge);
      host.systemMessage(session, `${menge} Gold gutgeschrieben.`);
    },
  },
];

/**
 * Führt eine Chatzeile als Befehl aus, wenn sie einer ist.
 *
 * Gibt `true` zurück, wenn die Zeile verarbeitet wurde — dann geht sie nicht
 * mehr an die Umstehenden. Auch der abgelehnte Befehl gilt als verarbeitet:
 * sonst stünde „/gg 5000" im Chat der ganzen Wiese.
 */
export function runCommand(host: CommandHost, session: Session, text: string): boolean {
  if (!text.startsWith('/')) return false;

  const [wort, ...args] = text.slice(1).trim().split(/\s+/);
  const name = (wort ?? '').toLowerCase();
  if (name.length === 0) return true;

  if (name === 'help') {
    const erlaubt = COMMANDS.filter((c) => session.access >= c.minLevel);
    if (erlaubt.length === 0) {
      host.systemMessage(session, 'Vom Server gibt es keine Befehle für dich.');
    } else {
      for (const befehl of erlaubt) host.systemMessage(session, befehl.hilfe);
    }
    return true;
  }

  const befehl = COMMANDS.find((c) => c.name === name);
  if (!befehl) {
    host.systemMessage(session, `Unbekannter Befehl: /${name}`);
    return true;
  }

  if (session.access < befehl.minLevel) {
    // Bewusst mit Nennung der nötigen Stufe: wer sie hat, soll den Fehler bei
    // sich suchen können, und wer sie nicht hat, erfährt nichts, was ihm
    // weiterhülfe.
    host.systemMessage(
      session,
      `Dieser Befehl steht erst ab Stufe „${accessName(befehl.minLevel)}" zu.`,
    );
    return true;
  }

  befehl.run(host, session, args);
  return true;
}
