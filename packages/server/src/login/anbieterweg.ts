/**
 * Der HTTP-Teil der Anbieteranmeldung.
 *
 * Gewöhnliches HTTP mit Weiterleitungen — der Grund steht in `oauth.ts`: der
 * Browser muss zum Anbieter und zurück, und das kann ein WebSocket nicht für
 * ihn tun.
 *
 *   GET /anmeldearten             Was dieser Server anbietet. Der Client fragt
 *                                 das, bevor er einen Knopf zeigt.
 *   GET /auth/<anbieter>/start    Losgehen — Weiterleitung zum Anbieter.
 *   GET /auth/<anbieter>/callback Zurückkommen — Karte ausstellen und den
 *                                 Browser ans Ziel schicken.
 *
 * `<anbieter>` ist eine Kennung aus `ANBIETER` und keine Auswahl aus zwei
 * fest verdrahteten Zeichenketten: die beiden Wege sehen für Google und
 * Facebook Zeile für Zeile gleich aus, und zweimal dasselbe hinzuschreiben
 * hiesse, jede künftige Änderung an der Zielprüfung oder der Karte an zwei
 * Stellen zu machen — und eine davon zu vergessen.
 *
 * Diese Wege stehen **ausserhalb** von `/intern/`: sie gehören dem Spieler und
 * seinem Browser, nicht den Spielservern. Ein Proxy, der `/intern/` sperrt,
 * muss diese hier durchlassen.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { anmeldenMitIdentitaet } from '../accounts.ts';
import type { KontoStore } from '../db/index.ts';
import { loginConfig } from './config.ts';
import { ANBIETER, anbieterMit, baueState, pruefeState, type Anbieter } from './oauth.ts';
import type { Kartenstapel } from './tickets.ts';

/** Ob dieser Server über diesen Anbieter anmelden kann. */
export function anbieterBereit(a: Anbieter): boolean {
  const cfg = loginConfig.anbieter[a.id];
  return cfg.clientId !== '' && cfg.clientSecret !== '' && cfg.redirectUri !== '';
}

/** Was `/anmeldearten` sagt — und woran der Client seine Knöpfe hängt. */
export function anmeldearten(): Record<string, boolean> {
  const arten: Record<string, boolean> = { passwort: true };
  for (const a of ANBIETER) arten[a.id] = anbieterBereit(a);
  return arten;
}

/**
 * Sieht die Anbieterkonfiguration überhaupt nach einer aus?
 *
 * Gemeldet wird beim Start, nicht beim ersten Spieler. Der Anlass ist ein
 * Fehlschlag, der nichts über sich verrät: Google antwortet auf eine Kennung
 * mit einem Anführungszeichen darin mit `401 invalid_client`, und dieselbe
 * Antwort kommt bei einem falschen Geheimnis. Facebook macht es genauso. Wer
 * beides für richtig hält, weil es in der `.env` richtig **aussieht**, sucht
 * lange.
 *
 * Bewusst nur gemeldet und nicht behoben. Anführungszeichen wegzuschneiden
 * hiesse, eine falsche Datei zum Laufen zu bringen — und beim nächsten Wert,
 * der wirklich eines enthält, stünde man vor demselben Rätsel, nur andersherum.
 *
 * Das Geheimnis selbst steht in keiner Zeile. Was daran auffällt, lässt sich
 * auch ohne es sagen.
 *
 * Geprüft wird nur, was eingerichtet ist: ein Server ohne Facebook soll nicht
 * bei jedem Start erklärt bekommen, dass das leere Feld keine App-ID ist.
 */
export function meldeAnbieterAuffaelligkeiten(): void {
  /*
   * Zeichenweise und nicht paarweise.
   *
   * Der erste Anlauf suchte Anführungszeichen nur am Anfang **und** am Ende.
   * Genau der häufigste Fall fiel damit durch: eines von beiden bleibt beim
   * Kopieren hängen, der Wert ist ein Zeichen zu lang, und die Prüfung sagt
   * nichts. Kennungen und Geheimnisse bestehen aus Buchstaben, Ziffern,
   * Strich, Unterstrich und Punkt — alles andere darin ist ein Versehen, egal
   * wo es steht.
   */
  const auffaellig = (wert: string): string | undefined => {
    const stoerer = [...wert].find((z) => !/[A-Za-z0-9._\-:/]/.test(z));
    if (stoerer === undefined) return undefined;
    if (/\s/.test(stoerer)) return 'enthält ein Leerzeichen';
    return `enthält das Zeichen „${stoerer}"`;
  };

  for (const a of ANBIETER) {
    if (!anbieterBereit(a)) continue;
    const cfg = loginConfig.anbieter[a.id];
    const praefix = `AURELITH_${a.id.toUpperCase()}`;

    for (const [name, wert] of [
      [`${praefix}_CLIENT_ID`, cfg.clientId],
      [`${praefix}_CLIENT_SECRET`, cfg.clientSecret],
      [`${praefix}_REDIRECT_URI`, cfg.redirectUri],
    ] as const) {
      const was = auffaellig(wert);
      if (was) console.warn(`[anmelde] ${name} ${was} — ${a.name} wird das ablehnen.`);
    }

    // Die Rückadresse muss auf den Weg zeigen, den dieser Server auch bedient.
    // Zeigt sie woandershin, kommt der Browser nie an — und der Anbieter sagt
    // dazu nur, dass die Adresse nicht eingetragen sei.
    if (!cfg.redirectUri.endsWith(`/auth/${a.id}/callback`)) {
      console.warn(
        `[anmelde] ${praefix}_REDIRECT_URI endet nicht auf /auth/${a.id}/callback: ` +
          `${cfg.redirectUri}`,
      );
    }

    for (const was of a.auffaelligkeiten(cfg)) {
      console.warn(`[anmelde] ${a.name}: ${was}.`);
    }
  }
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
     * Der Client fragt hier, bevor er die Anbieterknöpfe zeigt.
     *
     * Eine Wahrheit darüber, was geht: die Knöpfe hängen an dem, was der Server
     * wirklich kann, und nicht an einem Schalter im Client, den jemand zu
     * setzen vergisst. Fehlt die Kennung, fehlt der Knopf.
     */
    res.writeHead(200, {
      'access-control-allow-origin': '*',
      'content-type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify(anmeldearten()));
    return true;
  }

  // `/auth/<kennung>/<schritt>` — die Kennung kommt aus der Tabelle, nicht aus
  // einer Aufzählung an dieser Stelle. Ein unbekannter Name fällt durch und
  // wird zur gewöhnlichen 404 des Anmeldeservers.
  const weg = /^\/auth\/([a-z]+)\/(start|callback)$/.exec(url.pathname);
  const anbieter = weg ? anbieterMit(weg[1]!) : undefined;
  if (!weg || !anbieter) return false;
  const schritt = weg[2];
  const cfg = loginConfig.anbieter[anbieter.id];

  if (!anbieterBereit(anbieter)) {
    sackgasse(res, 404, `Dieser Server bietet keine Anmeldung über ${anbieter.name} an.`);
    return true;
  }

  if (schritt === 'start') {
    const ziel = url.searchParams.get('ziel') ?? '';
    if (!zielErlaubt(ziel)) {
      // Absichtlich deutlich: das trifft im Betrieb niemanden ausser dem, der
      // AURELITH_ANMELDE_ZIELE zu setzen vergessen hat — und der soll es lesen.
      console.warn(`[anmelde] Anmeldeziel abgelehnt: ${ziel || '(leer)'}`);
      sackgasse(res, 400, 'Dieses Ziel ist für die Anmeldung nicht freigegeben.');
      return true;
    }

    const state = baueState(ziel, loginConfig.internalSecret);
    res.writeHead(302, { location: anbieter.startUrl(cfg, state) });
    res.end();
    return true;
  }

  {
    // Zuerst der `state`: er sagt, wohin es zurückgeht. Ohne ihn gibt es kein
    // Ziel, und ohne Ziel keine Karte — auch dann nicht, wenn der Anbieter
    // einen gültigen Code mitgeschickt hat.
    const ziel = pruefeZiel(url.searchParams.get('state') ?? '');
    if (!ziel) {
      sackgasse(res, 400, 'Diese Anmeldung ist abgelaufen oder gehört nicht hierher.');
      return true;
    }

    const fehler = url.searchParams.get('error');
    if (fehler) {
      // Der häufigste Fall ist `access_denied` — jemand hat beim Anbieter auf
      // „Abbrechen" gedrückt. Kein Fehler, sondern eine Entscheidung.
      res.writeHead(302, { location: `${ziel}#anmeldung=abgebrochen` });
      res.end();
      return true;
    }

    const code = url.searchParams.get('code') ?? '';
    if (code === '') {
      sackgasse(res, 400, `${anbieter.name} hat keinen Code mitgeschickt.`);
      return true;
    }

    const profil = await anbieter.profil(cfg, code);
    if (!profil) {
      res.writeHead(302, { location: `${ziel}#anmeldung=fehler` });
      res.end();
      return true;
    }

    /*
     * Ohne Adresse geht es nicht weiter — und das wird gesagt.
     *
     * Der Kontoname **ist** die Adresse. Facebook gibt sie nur heraus, wenn
     * der Spieler die Freigabe im Anmeldedialog stehen lässt; wer sie abwählt,
     * kommt mit einem gültigen Code und ohne Adresse zurück.
     *
     * Das steht hier und nicht in `accounts.ts`, obwohl dort die Konten
     * entstehen: an dieser Stelle gibt es einen Browser, den man mit einem
     * eigenen Hinweis zurückschicken kann. Ein Konto anzulegen, das
     * „facebook-10223…" heisst, wäre der schlechtere Ausweg — es liesse sich
     * später an keinen Menschen mehr binden.
     */
    if (profil.email === '') {
      res.writeHead(302, { location: `${ziel}#anmeldung=ohne-adresse` });
      res.end();
      return true;
    }

    /*
     * Der Griff in die Datenbank kann werfen — und dann darf er den Rückweg
     * nicht verschlucken.
     *
     * Ohne diesen Fangblock endete eine fehlende Tabelle oder eine
     * weggebrochene Verbindung als abgewiesenes Versprechen im Rückruf des
     * HTTP-Servers: **keine** Antwort, kein Statuscode, nichts. Der Browser
     * stünde mit einer weissen Seite auf `/auth/<anbieter>/callback` und
     * wartete, bis er selbst aufgibt — und im Protokoll stünde eine Ausnahme
     * ohne Zusammenhang. Ein Fehlschlag muss zurückführen, nicht ins Nichts.
     */
    let ergebnis: Awaited<ReturnType<typeof anmeldenMitIdentitaet>>;
    try {
      ergebnis = await anmeldenMitIdentitaet(
        store,
        anbieter.id,
        profil.subject,
        profil.email,
        loginConfig.zugriff,
      );
    } catch (err) {
      console.error(`[anmelde] Konto zu ${anbieter.name}-Identität nicht abrufbar:`, err);
      res.writeHead(302, { location: `${ziel}#anmeldung=fehler` });
      res.end();
      return true;
    }
    if (!ergebnis.ok) {
      console.warn(
        `[anmelde] Konto zu ${anbieter.name}-Identität nicht möglich: ${ergebnis.fehler}`,
      );
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
