/**
 * Der HTTP-Teil der Anbieteranmeldung.
 *
 * Drei Wege, und alle drei sind gewöhnliches HTTP mit Weiterleitungen — der
 * Grund steht in `oauth.ts`: der Browser muss zu Google und zurück, und das
 * kann ein WebSocket nicht für ihn tun.
 *
 *   GET /anmeldearten          Was dieser Server anbietet. Der Client fragt
 *                              das, bevor er einen Knopf zeigt.
 *   GET /auth/google/start     Losgehen — Weiterleitung zu Google.
 *   GET /auth/google/callback  Zurückkommen — Karte ausstellen und den
 *                              Browser ans Ziel schicken.
 *
 * Diese Wege stehen **ausserhalb** von `/intern/`: sie gehören dem Spieler und
 * seinem Browser, nicht den Spielservern. Ein Proxy, der `/intern/` sperrt,
 * muss diese hier durchlassen.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { anmeldenMitIdentitaet } from '../accounts.ts';
import type { KontoStore } from '../db/index.ts';
import { loginConfig } from './config.ts';
import { baueState, googleProfil, googleStartUrl, pruefeState } from './oauth.ts';
import type { Kartenstapel } from './tickets.ts';

/** Ob dieser Server überhaupt über Google anmelden kann. */
export function googleBereit(): boolean {
  const g = loginConfig.google;
  return g.clientId !== '' && g.clientSecret !== '' && g.redirectUri !== '';
}

/**
 * Darf der Browser nach dem Anmelden dorthin zurück?
 *
 * Geprüft wird die **Herkunft**, nicht die ganze Adresse: der Client hängt an
 * sein Ziel gern noch einen Pfad oder eine Abfrage („?kanal=2"), und die soll
 * er behalten dürfen. Was er nicht darf, ist eine fremde Herkunft — dort läge
 * am Ende die Anmeldekarte.
 */
function zielErlaubt(ziel: string): boolean {
  let url: URL;
  try {
    url = new URL(ziel);
  } catch {
    return false;
  }
  // Nur diese beiden Schemata. `javascript:` und Verwandte hätten in einer
  // Weiterleitung nichts zu suchen, auch wenn ihre Herkunft „null" heisst.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  return loginConfig.ziele.includes(url.origin);
}

/** Eine kurze Seite für den Fall, dass der Weg nicht zu Ende geht. */
function sackgasse(res: ServerResponse, code: number, text: string): void {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${text}\n\nDu kannst das Fenster schliessen und es im Spiel noch einmal versuchen.\n`);
}

/**
 * Behandelt die Anbieterwege. Gibt `true` zurück, wenn die Anfrage erledigt
 * ist — dann geht sie den übrigen Weg im Anmeldeserver nicht mehr.
 */
export async function behandleAnbieterweg(
  req: IncomingMessage,
  res: ServerResponse,
  store: KontoStore,
  anmeldekarten: Kartenstapel,
): Promise<boolean> {
  // `req.url` ist nur Pfad und Abfrage; die Basis ist nur da, damit `URL`
  // etwas zu tun hat, und wird nie gelesen.
  const url = new URL(req.url ?? '/', 'http://anmelde.invalid');

  if (url.pathname === '/anmeldearten') {
    /*
     * Der Client fragt hier, bevor er den Google-Knopf zeigt.
     *
     * Eine Wahrheit darüber, was geht: der Knopf hängt an dem, was der Server
     * wirklich kann, und nicht an einem Schalter im Client, den jemand zu
     * setzen vergisst. Fehlt die Kennung, fehlt der Knopf.
     */
    res.writeHead(200, {
      'access-control-allow-origin': '*',
      'content-type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify({ passwort: true, google: googleBereit() }));
    return true;
  }

  if (url.pathname === '/auth/google/start') {
    if (!googleBereit()) {
      sackgasse(res, 404, 'Dieser Server bietet keine Anmeldung über Google an.');
      return true;
    }
    const ziel = url.searchParams.get('ziel') ?? '';
    if (!zielErlaubt(ziel)) {
      // Absichtlich deutlich: das trifft im Betrieb niemanden ausser dem, der
      // AURELITH_ANMELDE_ZIELE zu setzen vergessen hat — und der soll es lesen.
      console.warn(`[anmelde] Anmeldeziel abgelehnt: ${ziel || '(leer)'}`);
      sackgasse(res, 400, 'Dieses Ziel ist für die Anmeldung nicht freigegeben.');
      return true;
    }

    const state = baueState(ziel, loginConfig.internalSecret);
    res.writeHead(302, { location: googleStartUrl(loginConfig.google, state) });
    res.end();
    return true;
  }

  if (url.pathname === '/auth/google/callback') {
    if (!googleBereit()) {
      sackgasse(res, 404, 'Dieser Server bietet keine Anmeldung über Google an.');
      return true;
    }

    // Zuerst der `state`: er sagt, wohin es zurückgeht. Ohne ihn gibt es kein
    // Ziel, und ohne Ziel keine Karte — auch dann nicht, wenn Google einen
    // gültigen Code mitgeschickt hat.
    const ziel = pruefeZiel(url.searchParams.get('state') ?? '');
    if (!ziel) {
      sackgasse(res, 400, 'Diese Anmeldung ist abgelaufen oder gehört nicht hierher.');
      return true;
    }

    const fehler = url.searchParams.get('error');
    if (fehler) {
      // Der häufigste Fall ist `access_denied` — jemand hat bei Google auf
      // „Abbrechen" gedrückt. Kein Fehler, sondern eine Entscheidung.
      res.writeHead(302, { location: `${ziel}#anmeldung=abgebrochen` });
      res.end();
      return true;
    }

    const code = url.searchParams.get('code') ?? '';
    if (code === '') {
      sackgasse(res, 400, 'Google hat keinen Code mitgeschickt.');
      return true;
    }

    const profil = await googleProfil(loginConfig.google, code);
    if (!profil) {
      res.writeHead(302, { location: `${ziel}#anmeldung=fehler` });
      res.end();
      return true;
    }

    const ergebnis = await anmeldenMitIdentitaet(
      store,
      'google',
      profil.subject,
      profil.name,
      profil.email,
      loginConfig.admins,
    );
    if (!ergebnis.ok) {
      console.warn(`[anmelde] Konto zu Google-Identität nicht möglich: ${ergebnis.fehler}`);
      res.writeHead(302, { location: `${ziel}#anmeldung=fehler` });
      res.end();
      return true;
    }

    const karte = anmeldekarten.stelleAus(
      ergebnis.account.id,
      ergebnis.account.name,
      ergebnis.account.accessLevel,
    );

    /*
     * Die Karte reist im **Ankerteil** und nicht in der Abfrage.
     *
     * Der Anker wird nicht an den Server geschickt, der die Seite ausliefert,
     * und er steht in keinem Zugriffsprotokoll und in keinem `Referer`. Für
     * etwas, das zwei Minuten lang wie ein Passwort wirkt, ist das der
     * Unterschied zwischen „einmal durch den Browser" und „für immer in einer
     * Logdatei".
     */
    res.writeHead(302, { location: `${ziel}#anmeldung=${karte}` });
    res.end();
    return true;
  }

  return false;
}

/**
 * Prüft den `state` und gibt das Ziel zurück — oder nichts.
 *
 * Die Freigabeliste wird **noch einmal** geprüft, obwohl der `state` von uns
 * unterschrieben ist. Der Grund ist die Zeit dazwischen: die Liste kann sich
 * geändert haben, seit der Zettel ausgestellt wurde, und dann gilt die neue.
 */
function pruefeZiel(state: string): string | undefined {
  let ziel: string | undefined;
  try {
    // `pruefeState` rechnet mit einem Zettel im eigenen Format. Kommt etwas
    // ganz anderes an — abgeschnitten, doppelt kodiert —, ist das eine Absage
    // und kein Absturz des Anmeldeservers.
    ziel = pruefeState(state, loginConfig.internalSecret);
  } catch {
    return undefined;
  }
  if (!ziel || !zielErlaubt(ziel)) return undefined;
  return ziel;
}
