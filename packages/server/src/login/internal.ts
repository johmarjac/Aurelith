/**
 * Die internen Wege zwischen Spielserver und Anmeldeserver.
 *
 * Sieben Nachrichten, alle in dieselbe Richtung — vom Spielserver zum
 * Anmeldeserver:
 *
 *   `register`      „Ich bin Kanal 2 auf Aurelith und nehme unter dieser
 *                   Adresse Spieler auf."
 *   `heartbeat`     „Ich bin noch da, und es spielen gerade so viele."
 *   `ticket`        „Zu wem gehört diese Eintrittskarte?"
 *   `karte-frisch`  „Diese Karte ist noch in Gebrauch." — hält die Frist offen.
 *   `karte-weg`     „Diese Karte gilt nicht mehr." — beim Abmelden.
 *   `presence`      „Dieses Konto ist bei mir drin / wieder draussen."
 *   `stufe`         „Setz die Zugriffsstufe dieses Kontos." — für /accesslevel.
 *
 * Der Anmeldeserver ruft **nie** von sich aus an. Er weiss nicht, wo die
 * Spielserver stehen — er weiss nur, was sie über sich gesagt haben. Deshalb
 * kommt ein neuer Kanal ohne jede Änderung hier dazu: er meldet sich einfach.
 *
 * Als HTTP und nicht über einen zweiten WebSocket: es sind Frage-und-Antwort-
 * Paare ohne Verlauf, und genau dafür ist HTTP gebaut. Ein dauerhafter Socket
 * müsste Wiederverbinden, Anfragenummern und Zeitüberschreitungen selbst
 * mitbringen — alles davon nur, um dieselben fünf Nachrichten zu übertragen.
 *
 * Ausgewiesen wird sich mit einem gemeinsamen Geheimnis im Kopf. Diese Wege
 * gehören **nicht** ins offene Netz: wer sie erreicht, kann Kanäle in die
 * Liste stellen. Im Betrieb liegen sie hinter derselben Grenze wie die
 * Datenbank.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ACCESS_NAMES } from '@aurelith/shared';
import { loginConfig } from './config.ts';
import type { KontoStore } from '../db/index.ts';
import type { KanalRegister } from './registry.ts';
import type { Kartenstapel } from './tickets.ts';

/** Kopf, in dem das gemeinsame Geheimnis steht. */
export const GEHEIM_KOPF = 'x-aurelith-secret';

/** Grösste Anfrage, die angenommen wird. Alles darüber ist kein Register-Ruf. */
const MAX_BODY = 8 * 1024;

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

async function leseKoerper(req: IncomingMessage): Promise<unknown> {
  const teile: Buffer[] = [];
  let laenge = 0;
  for await (const stueck of req) {
    const buf = stueck as Buffer;
    laenge += buf.length;
    if (laenge > MAX_BODY) throw new Error('Anfrage zu gross');
    teile.push(buf);
  }
  if (laenge === 0) return {};
  return JSON.parse(Buffer.concat(teile).toString('utf8'));
}

function text(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === 'string' ? v : '';
}

function zahl(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Behandelt eine interne Anfrage.
 *
 * Gibt `true` zurück, wenn sie hierher gehörte — dann ist die Antwort schon
 * geschrieben. `false` heisst: nichts für uns, der Aufrufer macht weiter.
 */
export async function behandleIntern(
  req: IncomingMessage,
  res: ServerResponse,
  register: KanalRegister,
  karten: Kartenstapel,
  store: KontoStore,
): Promise<boolean> {
  const pfad = (req.url ?? '').split('?')[0] ?? '';
  if (!pfad.startsWith('/intern/')) return false;

  if (req.method !== 'POST') {
    json(res, 405, { fehler: 'Nur POST.' });
    return true;
  }
  if (req.headers[GEHEIM_KOPF] !== loginConfig.internalSecret) {
    // Ohne Auskunft darüber, was gefehlt hat. Wer das Geheimnis nicht hat,
    // soll auch nicht erfahren, dass es eines gibt.
    json(res, 403, { fehler: 'Nein.' });
    return true;
  }

  let roh: unknown;
  try {
    roh = await leseKoerper(req);
  } catch (err) {
    json(res, 400, { fehler: String(err instanceof Error ? err.message : err) });
    return true;
  }
  const body = (typeof roh === 'object' && roh !== null ? roh : {}) as Record<string, unknown>;

  switch (pfad) {
    // Anmelden und Lebenszeichen sind derselbe Vorgang: beide sagen „dieser
    // Kanal ist da und sieht so aus". Zwei Endpunkte dafür wären zwei Wege,
    // dieselbe Zeile zu schreiben — und einer davon würde beim Ändern
    // vergessen. Der Unterschied steht nur im Protokoll.
    case '/intern/register':
    case '/intern/heartbeat': {
      const server = text(body, 'server');
      const channel = text(body, 'channel');
      const url = text(body, 'url');
      if (!server || !channel || !url) {
        json(res, 400, { fehler: 'server, channel und url müssen dastehen.' });
        return true;
      }
      const neu = pfad.endsWith('register');
      register.melde({
        server,
        channel,
        url,
        capacity: zahl(body, 'capacity'),
        online: zahl(body, 'online'),
      });
      if (neu) console.log(`[kanal] ${server} · ${channel} angemeldet — ${url}`);
      json(res, 200, { ok: true });
      return true;
    }

    case '/intern/abmelden': {
      const server = text(body, 'server');
      const channel = text(body, 'channel');
      register.entferne(server, channel);
      register.raeumeVerfallene();
      console.log(`[kanal] ${server} · ${channel} abgemeldet`);
      json(res, 200, { ok: true });
      return true;
    }

    /*
     * Die Karte am Leben halten — solange der Kanal die Verbindung hält.
     *
     * Daran hängt der Wiedereinstieg nach einem Abriss: die Frist läuft ab dem
     * letzten Lebenszeichen, nicht ab dem Anmelden. Antwort ist bewusst nur
     * `ok` — der Kanal soll daraus nichts weiter ableiten, siehe `frischeAuf`.
     */
    case '/intern/karte-frisch': {
      json(res, 200, { ok: karten.frischeAuf(text(body, 'ticket')) });
      return true;
    }

    /*
     * Und weg damit — beim gewollten Abmelden.
     *
     * Der Abriss geht diesen Weg ausdrücklich nicht: dort soll die Karte
     * liegenbleiben, sonst gäbe es nichts wiederaufzunehmen.
     */
    case '/intern/karte-weg': {
      karten.verwirf(text(body, 'ticket'));
      json(res, 200, { ok: true });
      return true;
    }

    case '/intern/ticket': {
      const konto = karten.loeseEin(text(body, 'ticket'));
      if (!konto) {
        json(res, 200, { ok: false });
        return true;
      }
      json(res, 200, {
        ok: true,
        accountId: konto.accountId,
        accountName: konto.accountName,
        accessLevel: konto.accessLevel,
      });
      return true;
    }

    /*
     * Die Zugriffsstufe eines Kontos setzen — für `/accesslevel` im Spiel.
     *
     * Der Kanal kann das nicht selbst: im Verbund kennt er die Konten gar
     * nicht, die stehen in der Masterdatenbank neben diesem Server. Genau
     * dafür ist dieser Weg da, und er ist der einzige — ein zweiter Ort, an
     * dem Stufen geschrieben werden, wäre eine zweite Wahrheit über eine
     * Angabe, an der Befehlsrechte hängen.
     *
     * Zurück geht auch, ob der Name in `AURELITH_ADMINS` steht. Der Kanal soll
     * das dem Absender sagen können: die Liste gewinnt bei der nächsten
     * Anmeldung, und eine Zuweisung, die zehn Minuten später von selbst
     * zurückspringt, ist schlimmer als eine, die gar nicht erst geht.
     */
    case '/intern/stufe': {
      const name = text(body, 'name').trim();
      const stufe = text(body, 'stufe').trim().toLowerCase();
      if (!name || !(stufe in ACCESS_NAMES)) {
        json(res, 400, { fehler: 'name und eine bekannte stufe müssen dastehen.' });
        return true;
      }

      const konto = await store.findAccount(name);
      if (!konto) {
        json(res, 200, { ok: false, grund: 'unbekannt' });
        return true;
      }
      if (konto.accessLevel !== stufe) await store.setAccessLevel(konto.id, stufe);

      console.log(
        `[konto] ${konto.name}: Stufe ${konto.accessLevel} → ${stufe} (über /accesslevel)`,
      );
      json(res, 200, {
        ok: true,
        name: konto.name,
        vorher: konto.accessLevel,
        nachher: stufe,
        inListe: loginConfig.zugriff.has(konto.name.toLowerCase()),
      });
      return true;
    }

    case '/intern/anwesend': {
      register.setzeOnline(
        zahl(body, 'accountId'),
        text(body, 'server'),
        text(body, 'channel'),
        body.drin === true,
      );
      json(res, 200, { ok: true });
      return true;
    }

    default:
      json(res, 404, { fehler: 'Unbekannter interner Weg.' });
      return true;
  }
}
