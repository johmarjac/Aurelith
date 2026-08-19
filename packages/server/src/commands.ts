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

import { ACCESS_NAMES, AccessLevel, MOBS, accessName, maxLevel } from '@aurelith/shared';
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
  /**
   * Eine Ansage an alle auf diesem Spielserver. Gibt zurück, wen sie erreicht
   * hat — der Absender soll sehen, ob sie angekommen ist.
   */
  ansage(text: string): number;
  /**
   * Setzt die Zugriffsstufe eines Kontos — dauerhaft, in der Datenbank.
   *
   * Nimmt keine Antwort entgegen und gibt keine zurück: der Weg dorthin führt
   * im Verbund über den Anmeldeserver und ist damit ein Netzruf. Ein Befehl,
   * der darauf wartet, hielte den Tick auf. Der Host meldet dem Absender
   * selbst, wie es ausgegangen ist.
   */
  setzeStufe(session: Session, name: string, stufe: AccessLevel): void;
  /**
   * Setzt die Stufe einer Figur.
   *
   * `figur` leer heisst: die eigene. Gibt zurück, ob es geklappt hat — anders
   * als bei der Zugriffsstufe geht das ohne Netzruf, denn Figuren stehen in
   * der Weltdatenbank dieses Servers und die gesuchte spielt gerade hier.
   */
  setzeLevel(session: Session, figur: string, level: number): boolean;
  /**
   * Versetzt die Figur an den Startpunkt einer Karte. `false` heisst: diese
   * Karte führt der Kanal nicht.
   */
  teleportiere(session: Session, mapId: string): boolean;
  /** Welche Karten es gibt — für die Absage, wenn eine nicht dabei ist. */
  kartenListe(): string[];
  /**
   * Setzt die Figur an eine Stelle dieser Karte. `false` heisst: die Figur
   * steht gerade in keiner Welt.
   */
  setzeAn(session: Session, x: number, y: number, z: number): boolean;
  /**
   * Wo der **Server** diese Figur führt. `undefined` heisst: sie steht gerade
   * in keiner Welt.
   */
  lage(session: Session): { x: number; y: number; z: number } | undefined;
  /**
   * Setzt ein Monster dieser Kennung vor die Figur. Gibt seinen Namen zurück;
   * `undefined` heisst, dass es nicht gesetzt werden konnte — vor der Figur
   * liegt kein Boden, der etwas trägt.
   *
   * Die Kennung ist hier schon geprüft: welche es gibt, steht in `MOBS` und
   * damit im Befehl. Der Wirt baut nur noch.
   */
  spawneMonster(session: Session, sorte: string): string | undefined;
  /**
   * Eine private Nachricht an eine Figur.
   *
   * `weg` heisst: spielt gerade nicht auf diesem Kanal. `selbst` heisst: das
   * ist die eigene Figur — kein Fehler, aber auch keine Nachricht, und ein
   * stilles Nichts wäre die schlechtere Antwort darauf.
   */
  fluestere(session: Session, name: string, text: string): 'ok' | 'weg' | 'selbst';
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

/**
 * Sucht die Kennung zu einem getippten Wort — Kennung **oder** deutscher Name.
 *
 * Getippt wird im Spiel, und im Spiel heisst das Wesen „Höhlenkriecher" und
 * nicht `cave_crawler`. Beides geht deshalb, und beides ohne Rücksicht auf
 * Gross- und Kleinschreibung: wer diesen Befehl braucht, tippt ihn nebenbei.
 *
 * Hier und nicht beim Wirt: die Namen stehen in der Inhaltstabelle, und die
 * kennt diese Datei ohnehin. Ein Wirt, der das übersetzte, wäre eine zweite
 * Stelle, an der die Schreibweise entschieden wird.
 */
function monsterKennung(wort: string): string | undefined {
  const gesucht = wort.trim().toLowerCase();
  if (MOBS.has(gesucht)) return gesucht;
  for (const [id, def] of MOBS) {
    if (def.name.toLowerCase() === gesucht) return id;
  }
  return undefined;
}

/** Was es zu setzen gibt — für die Absage, wenn ein Name nicht dabei ist. */
function monsterListe(): string[] {
  return [...MOBS.values()].map((m) => m.name).sort();
}

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
  {
    name: 'sys',
    minLevel: AccessLevel.Gamemaster,
    hilfe: '/sys <text> — Ansage an alle auf diesem Kanal (ab Spielleiter)',
    run(host, session, args) {
      /*
       * Der ganze Rest der Zeile ist die Nachricht.
       *
       * `args` ist an Leerzeichen zerlegt — wieder zusammengesetzt steht hier
       * genau das, was getippt wurde, nur mit einfachen Abständen. Das ist
       * gewollt: eine Ansage mit fünf Leerzeichen am Stück ist ein Versehen.
       */
      const text = args.join(' ').trim().slice(0, 200);
      if (text.length === 0) {
        host.systemMessage(session, 'Erwartet: /sys <text>.');
        return;
      }
      const erreicht = host.ansage(text);
      host.systemMessage(session, `Ansage an ${erreicht} Spieler geschickt.`);
    },
  },
  {
    name: 'accesslevel',
    // Nur Verwalter. Ein Spielleiter, der Spielleiter ernennen darf, ernennt
    // sich früher oder später jemanden, der ihn ernennt — die Stufe wäre dann
    // keine Ordnung mehr, sondern eine Kettenreaktion.
    minLevel: AccessLevel.Admin,
    hilfe: `/accesslevel <konto> <${Object.keys(ACCESS_NAMES).join('|')}> — Stufe setzen (ab Verwalter)`,
    run(host, session, args) {
      const [wen, wort] = args;
      if (!wen || !wort) {
        host.systemMessage(session, 'Erwartet: /accesslevel <konto> <stufe>.');
        return;
      }
      /*
       * Gegen die bekannten Wörter und nicht über `accessFromName`.
       *
       * Das gibt für alles Unbekannte „player" zurück. Ein vertipptes
       * `gamemster` würde damit stillschweigend zur Herabstufung — und zwar zu
       * einer, die genau so aussieht wie ein gelungener Befehl.
       */
      const stufenwort = wort.trim().toLowerCase();
      if (!(stufenwort in ACCESS_NAMES)) {
        host.systemMessage(
          session,
          `„${wort}" ist keine Stufe. Erlaubt: ${Object.keys(ACCESS_NAMES).join(', ')}.`,
        );
        return;
      }
      host.setzeStufe(session, wen, ACCESS_NAMES[stufenwort]!);
    },
  },
  {
    name: 'level',
    minLevel: AccessLevel.Gamemaster,
    hilfe: '/level [figur] <stufe> — Stufe setzen (ab Spielleiter)',
    run(host, session, args) {
      /*
       * Ein oder zwei Wörter, und die Stufe steht immer hinten.
       *
       * `/level 30` meint einen selbst, `/level Aurel 30` jemand anderen. Die
       * Unterscheidung an der **Anzahl** und nicht daran, ob das erste Wort
       * eine Zahl ist: eine Figur darf „7" heissen, und dann entschiede eine
       * Zeichenprüfung falsch.
       */
      if (args.length === 0 || args.length > 2) {
        host.systemMessage(session, 'Erwartet: /level <stufe> oder /level <figur> <stufe>.');
        return;
      }
      const figur = args.length === 2 ? args[0]! : '';
      const stufe = Number(args[args.length - 1]);

      if (!Number.isInteger(stufe) || stufe < 1 || stufe > maxLevel()) {
        host.systemMessage(session, `Erwartet: eine ganze Zahl von 1 bis ${maxLevel()}.`);
        return;
      }
      if (!host.setzeLevel(session, figur, stufe)) {
        host.systemMessage(session, `„${figur}" spielt hier gerade nicht.`);
      }
    },
  },
  {
    name: 'tp',
    minLevel: AccessLevel.Gamemaster,
    hilfe: '/tp <karte> | /tp <x> <y> <z> — an eine Karte oder an eine Stelle (ab Spielleiter)',
    run(host, session, args) {
      /*
       * Ein Wort ist eine Karte, drei Zahlen sind eine Stelle.
       *
       * Ein Befehl und nicht zwei: beides heisst „bring mich dorthin", und wer
       * `/tp` tippt, sucht nicht erst, ob es dafür einen zweiten Namen gibt.
       * Unterschieden wird an der **Anzahl** — eine Karte heisst nie „12 4 -7".
       */
      if (args.length === 3) {
        const zahlen = args.map((w) => Number(w));
        if (zahlen.some((n) => !Number.isFinite(n))) {
          host.systemMessage(session, 'Erwartet: /tp <x> <y> <z> — drei Zahlen.');
          return;
        }
        const [x, y, z] = zahlen as [number, number, number];
        if (!host.setzeAn(session, x, y, z)) {
          host.systemMessage(session, 'Gerade geht das nicht.');
          return;
        }
        // Mit den Zahlen zurück: `y` wird auf den Boden angehoben, wenn es
        // darunter lag, und ohne die Antwort wüsste man nicht, wo man steht.
        host.systemMessage(session, `Versetzt auf ${x}, ${y}, ${z}.`);
        return;
      }

      const karte = (args[0] ?? '').trim();
      if (args.length !== 1 || karte.length === 0) {
        host.systemMessage(
          session,
          `Erwartet: /tp <karte> oder /tp <x> <y> <z>. Es gibt: ${host.kartenListe().join(', ')}.`,
        );
        return;
      }
      if (!host.teleportiere(session, karte)) {
        // Mit Liste und nicht nur „gibt es nicht": sich an einem Kartennamen
        // zu vertippen ist der Normalfall, und eine Absage ohne Liste lässt
        // einen genauso ratlos zurück wie vorher.
        host.systemMessage(
          session,
          `Eine Karte „${karte}" gibt es hier nicht. Es gibt: ${host.kartenListe().join(', ')}.`,
        );
      }
    },
  },
  {
    name: 'pm',
    /*
     * Für alle. Eine private Nachricht ist kein Werkzeug der Spielleitung,
     * sondern der halbe Grund, warum man eine Freundesliste hat.
     */
    minLevel: AccessLevel.Player,
    hilfe: '/pm <figur> <nachricht> — eine private Nachricht',
    run(host, session, args) {
      const name = args[0] ?? '';
      // `slice(1).join(' ')` und nicht `args[1]`: eine Nachricht besteht aus
      // Wörtern, und die Zerlegung am Leerzeichen hat sie auseinandergenommen.
      const text = args.slice(1).join(' ').trim();
      if (name === '' || text === '') {
        host.systemMessage(session, 'Erwartet: /pm <figur> <nachricht>.');
        return;
      }
      const ergebnis = host.fluestere(session, name, text);
      if (ergebnis === 'weg') {
        host.systemMessage(session, `${name} spielt gerade nicht.`);
      } else if (ergebnis === 'selbst') {
        host.systemMessage(session, 'Sich selbst zu schreiben spart den Umweg.');
      }
    },
  },
  {
    name: 'position',
    minLevel: AccessLevel.Gamemaster,
    hilfe: '/position — wo Server und Client die Figur führen (ab Spielleiter)',
    run(host, session, args) {
      const server = host.lage(session);
      if (!server) {
        host.systemMessage(session, 'Deine Figur steht gerade in keiner Welt.');
        return;
      }

      const z2 = (v: number): string => v.toFixed(2);
      const serverText = `${z2(server.x)} / ${z2(server.y)} / ${z2(server.z)}`;

      /*
       * Der Client schickt seine eigene Lage als drei Zahlen mit.
       *
       * Anders geht es nicht: der Server weiss nicht, wo der Client die Figur
       * gerade **zeichnet** — er kennt nur, was er selbst rechnet, und genau
       * die beiden sollen verglichen werden. Damit steht die Antwort in einer
       * Zeile statt in zweien, zwischen denen eine Netzlaufzeit liegt.
       *
       * Dass der Client dabei lügen könnte, ist bedeutungslos: aus diesen
       * Zahlen folgt nichts als ein Text. Wer sich selbst falsche
       * Diagnosewerte schickt, hat nur sich selbst belogen.
       */
      if (args.length !== 3) {
        host.systemMessage(session, `Lage — Server ${serverText}`);
        return;
      }

      const zahlen = args.map((w) => Number(w));
      if (zahlen.some((n) => !Number.isFinite(n))) {
        host.systemMessage(session, `Lage — Server ${serverText} (der Client nannte keine Zahlen)`);
        return;
      }

      const [cx, cy, cz] = zahlen as [number, number, number];
      const abweichung = Math.hypot(cx - server.x, cy - server.y, cz - server.z);
      host.systemMessage(
        session,
        `Lage — Server ${serverText} · Client ${z2(cx)} / ${z2(cy)} / ${z2(cz)} · ` +
          `Abweichung ${z2(abweichung)}`,
      );
    },
  },
  {
    name: 'spawn',
    minLevel: AccessLevel.Gamemaster,
    hilfe: '/spawn <monster> — setzt eines vor dich hin (ab Spielleiter)',
    run(host, session, args) {
      /*
       * Der ganze Rest der Zeile ist der Name.
       *
       * Ein Wesen darf zwei Wörter heissen, und `args` ist an Leerzeichen
       * zerlegt. Nur `args[0]` zu nehmen hiesse, sich diese Möglichkeit für
       * immer zu verbauen — an einer Stelle, an der es nichts kostet, sie
       * offenzulassen.
       */
      const wort = args.join(' ').trim();
      if (wort.length === 0) {
        host.systemMessage(session, `Erwartet: /spawn <monster>. Es gibt: ${monsterListe().join(', ')}.`);
        return;
      }

      const sorte = monsterKennung(wort);
      if (sorte === undefined) {
        // Mit Liste, aus demselben Grund wie bei `/tp`: sich an einem Namen zu
        // vertippen ist der Normalfall, und eine Absage ohne Liste lässt einen
        // genauso ratlos zurück wie vorher.
        host.systemMessage(
          session,
          `Ein Monster „${wort}" gibt es nicht. Es gibt: ${monsterListe().join(', ')}.`,
        );
        return;
      }

      const name = host.spawneMonster(session, sorte);
      if (name === undefined) {
        // Die Sorte gibt es — also lag es an der Stelle. Der einzige Grund
        // dafür ist ein Boden, der niemanden trägt: Meer oder Klippe.
        host.systemMessage(session, 'Vor dir ist kein Boden, der etwas trägt.');
        return;
      }
      host.systemMessage(session, `${name} steht vor dir.`);
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
