/**
 * Anmeldung über fremde Anbieter — Google und Facebook.
 *
 * Der Ablauf ist bei beiden derselbe, und er läuft **nicht** über den
 * WebSocket, sondern über gewöhnliches HTTP mit Weiterleitungen: der Browser
 * muss zum Anbieter und wieder zurück, und das kann eine Spielverbindung nicht
 * für ihn tun.
 *
 *   1. Der Client ruft `/auth/<anbieter>/start?ziel=<seine Adresse>` auf.
 *   2. Wir schicken ihn zum Anbieter — mit einem `state`, in dem sein Ziel steht.
 *   3. Der Anbieter schickt ihn an `/auth/<anbieter>/callback` zurück, mit
 *      einem `code`.
 *   4. Wir tauschen den Code beim Anbieter gegen ein Token, lesen daraus, wer
 *      da kommt, und suchen oder legen das Konto an.
 *   5. Wir schicken ihn zurück an sein Ziel — mit einer **Anmeldekarte** im
 *      Ankerteil der Adresse.
 *   6. Der Client zeigt die Karte über den WebSocket vor und ist angemeldet.
 *
 * Warum die Karte und nicht gleich eine Sitzung: die Spielverbindung ist ein
 * WebSocket und hat mit dem Browserfenster, das vom Anbieter zurückkommt,
 * nichts zu tun. Die Karte ist das Einzige, was zwischen beiden übergeben
 * werden muss — und sie gilt zwei Minuten und genau einmal, wie die
 * Eintrittskarte für einen Kanal.
 *
 * Die Schritte 2 und 4 sind das Einzige, worin sich die Anbieter unterscheiden,
 * und genau die stehen in der Tabelle `ANBIETER` — einmal je Anbieter. Alles
 * andere (Zettel, Zielprüfung, Karte, Konto) kennt nur eine Kennung und ist
 * für beide dasselbe. Als der zweite Anbieter dazukam, war das die eigentliche
 * Arbeit: nicht Facebook einzubauen, sondern Google aus dem Weg zu räumen, in
 * dem es dreissigmal namentlich stand.
 *
 * **Was hier absichtlich fehlt:** die Prüfung der Signatur des ID-Tokens von
 * Google. Das Token kommt nicht aus dem Browser, sondern aus unserer eigenen
 * Anfrage an Googles Token-Endpunkt, über TLS und mit unserem Geheimnis. Der
 * Standard lässt die Prüfung für genau diesen Fall ausdrücklich weg (OIDC Core
 * 3.1.3.7, Punkt 6). Käme das Token je aus dem Browser, müsste sie her — dann
 * steht sie hier, und dieser Absatz sagt, warum.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Wie lange ein angefangener Anmeldeversuch gilt. */
const STATE_MS = 10 * 60 * 1000;

export interface AnbieterConfig {
  clientId: string;
  clientSecret: string;
  /**
   * Wohin der Anbieter zurückschickt. Muss dort Wort für Wort so eingetragen
   * sein — ein fehlender Schrägstrich reicht für eine Absage.
   */
  redirectUri: string;
}

export interface Profil {
  /** Die Kennung des Anbieters für diesen Menschen. Ändert sich nie. */
  subject: string;
  /**
   * Die Adresse — und zugleich der Kontoname.
   *
   * Der Anzeigename des Anbieters steht hier bewusst **nicht** mehr. Er war
   * einmal der Vorschlag für den Kontonamen und musste dafür zurechtgestutzt
   * und durchnummeriert werden, weil zwei Menschen denselben Vornamen haben
   * können. Eine Adresse ist beim Anbieter eindeutig; damit fällt der ganze
   * Umweg weg, und ein Feld, das niemand mehr liest, steht auch nicht mehr da.
   *
   * Leer ist möglich und kein Fehler dieser Datei: Facebook gibt die Adresse
   * nur heraus, wenn der Spieler die Freigabe stehen lässt. Was das bedeutet,
   * entscheidet der Anbieterweg — dort ist jemand, dem man es sagen kann.
   */
  email: string;
}

/** Kennung eines Anbieters — im Pfad, in `/anmeldearten`, in der Konfiguration. */
export type AnbieterId = 'google' | 'facebook';

export interface Anbieter {
  id: AnbieterId;
  /** Wie er heisst. Steht in Protokollzeilen und in Warnungen beim Start. */
  name: string;
  /** Die Adresse, zu der der Browser geschickt wird. */
  startUrl(cfg: AnbieterConfig, state: string): string;
  /** Code einlösen und herausfinden, wer da kommt. */
  profil(cfg: AnbieterConfig, code: string): Promise<Profil | undefined>;
  /**
   * Was an dieser Konfiguration auffällt, ohne sie zu benutzen.
   *
   * Nur das Anbieterspezifische — die Länge eines Geheimnisses, die Form einer
   * Kennung. Was für alle gilt (Anführungszeichen, Leerzeichen, die Endung der
   * Rückadresse), prüft der Anbieterweg für alle zugleich.
   */
  auffaelligkeiten(cfg: AnbieterConfig): string[];
}

/**
 * Unterschreibt den `state` — und prüft ihn zurück.
 *
 * Er reist über den Browser des Spielers und über den Anbieter. Ohne
 * Unterschrift könnte jemand ein eigenes Ziel hineinschreiben und den Rückweg
 * samt Anmeldekarte auf seine Seite lenken. Mit Unterschrift ist er ein Zettel,
 * den nur dieser Server ausgestellt haben kann.
 *
 * Die Zeit steht mit drin: ein Zettel von gestern taugt nichts.
 */
export function baueState(ziel: string, geheimnis: string): string {
  const rumpf = `${Date.now()}.${randomBytes(9).toString('base64url')}.${Buffer.from(ziel).toString('base64url')}`;
  return `${rumpf}.${unterschrift(rumpf, geheimnis)}`;
}

export function pruefeState(state: string, geheimnis: string): string | undefined {
  const teile = state.split('.');
  if (teile.length !== 4) return undefined;
  const rumpf = teile.slice(0, 3).join('.');
  const erwartet = unterschrift(rumpf, geheimnis);

  // Zeitgleicher Vergleich: ein Vergleich, der beim ersten falschen Zeichen
  // abbricht, verrät über seine Dauer, wie viel schon stimmte.
  const a = Buffer.from(teile[3]!);
  const b = Buffer.from(erwartet);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;

  const alter = Date.now() - Number(teile[0]);
  if (!Number.isFinite(alter) || alter < 0 || alter > STATE_MS) return undefined;

  return Buffer.from(teile[2]!, 'base64url').toString();
}

function unterschrift(rumpf: string, geheimnis: string): string {
  return createHmac('sha256', geheimnis).update(rumpf).digest('base64url');
}

/**
 * Was ein Anbieter zu seiner Absage sagt — in **eine** Zeile.
 *
 * Der Status allein ist fast wertlos: `400` steht gleichermassen für eine
 * falsch eingetragene Rückadresse, einen bereits eingelösten Code und ein
 * Geheimnis mit einem Anführungszeichen darin. Im Rumpf steht, welcher Fall es
 * ist — und ohne ihn beginnt die Suche bei null.
 *
 * Alles auf einer Zeile, weil beide Anbieter mit umgebrochenem JSON antworten:
 * mehrzeilig protokolliert überlebt davon nur die erste Zeile ein
 * `grep [anmelde]` — die mit der öffnenden Klammer darin.
 *
 * Das ist eine Protokollzeile auf dem Server und keine Auskunft an den
 * Browser: dem Spieler bleibt „das hat nicht geklappt".
 */
async function absage(antwort: Response): Promise<string> {
  const text = await antwort.text().catch(() => '');
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

// --- Google -----------------------------------------------------------------

function googleStartUrl(cfg: AnbieterConfig, state: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('response_type', 'code');
  // Nur die Adresse — sie ist der Kontoname, und mehr brauchen wir nicht.
  // `profile` stand hier, solange der Anzeigename den Namen ergab; wer weniger
  // erfragt, muss weniger aufbewahren und weniger erklären.
  url.searchParams.set('scope', 'openid email');
  url.searchParams.set('state', state);
  // Kein `prompt=consent`: wer schon einmal zugestimmt hat, soll beim zweiten
  // Mal einfach angemeldet sein.
  url.searchParams.set('include_granted_scopes', 'true');
  return url.toString();
}

/**
 * Tauscht den Code gegen ein ID-Token und liest heraus, wer da kommt.
 *
 * Gibt nichts zurück, wenn irgendetwas daran nicht stimmt — und schreibt den
 * Grund ins Ausgabefenster. Für den Spieler ist jeder Fehlschlag derselbe:
 * „das hat nicht geklappt". Welcher Teil es war, geht ihn nichts an und wäre
 * für jemanden, der es darauf anlegt, eine Auskunft.
 */
async function googleProfil(cfg: AnbieterConfig, code: string): Promise<Profil | undefined> {
  let antwort: Response;
  try {
    antwort = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: cfg.redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    console.warn('[anmelde] Google antwortet nicht:', err);
    return undefined;
  }

  if (!antwort.ok) {
    console.warn(`[anmelde] Google lehnt den Code ab (${antwort.status}): ${await absage(antwort)}`);
    return undefined;
  }

  const daten = (await antwort.json()) as { id_token?: string };
  if (!daten.id_token) {
    console.warn('[anmelde] Googles Antwort enthält kein ID-Token.');
    return undefined;
  }

  const nutzlast = lesePayload(daten.id_token);
  if (!nutzlast) return undefined;

  // Für **uns** ausgestellt? Ein Token für eine andere Anwendung ist echt und
  // trotzdem wertlos — sonst könnte jeder mit einer eigenen Google-App
  // Anmeldungen für diesen Server erzeugen.
  if (nutzlast.aud !== cfg.clientId) {
    // Beide Werte in die Zeile. Eine Kennung ist kein Geheimnis — sie steht in
    // jeder Adresse, die der Browser zu Google trägt —, und der häufigste
    // Grund für diesen Fall ist kein Angriff, sondern ein Anführungszeichen
    // oder ein Leerzeichen, das aus der `.env` mitgekommen ist. Das sieht man
    // nur, wenn beide Zeichenketten nebeneinander stehen.
    console.warn(
      `[anmelde] ID-Token gehört zu einer anderen Anwendung: ` +
        `Token nennt „${String(nutzlast.aud)}", konfiguriert ist „${cfg.clientId}".`,
    );
    return undefined;
  }
  if (nutzlast.iss !== 'accounts.google.com' && nutzlast.iss !== 'https://accounts.google.com') {
    console.warn(`[anmelde] Unerwarteter Aussteller: ${String(nutzlast.iss)}`);
    return undefined;
  }
  if (typeof nutzlast.sub !== 'string' || nutzlast.sub.length === 0) return undefined;

  return {
    subject: nutzlast.sub,
    email: typeof nutzlast.email === 'string' ? nutzlast.email : '',
  };
}

/** Der mittlere Teil eines JWT, als Objekt. Ohne Signaturprüfung — siehe oben. */
function lesePayload(token: string): Record<string, unknown> | undefined {
  const teil = token.split('.')[1];
  if (!teil) return undefined;
  try {
    return JSON.parse(Buffer.from(teil, 'base64url').toString()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// --- Facebook ---------------------------------------------------------------

/**
 * Die Fassung der Graph-API, gegen die wir sprechen.
 *
 * Facebook versioniert seine Schnittstelle und nimmt jede Fassung nach etwa
 * zwei Jahren ausser Betrieb. Ohne Angabe bedient uns der Server mit der
 * **ältesten** noch laufenden — also mit derjenigen, die als Nächstes
 * abgeschaltet wird. Deshalb steht sie hier ausdrücklich, an genau einer
 * Stelle, und muss von Zeit zu Zeit hochgezogen werden. Läuft sie ab, sagt
 * Facebook das im Rumpf seiner Absage, und die steht im Protokoll.
 */
const GRAPH = 'v23.0';

function facebookStartUrl(cfg: AnbieterConfig, state: string): string {
  const url = new URL(`https://www.facebook.com/${GRAPH}/dialog/oauth`);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('response_type', 'code');
  // Nur die Adresse, wie bei Google. `public_profile` kommt bei Facebook
  // ohnehin immer mit und wird nicht gelesen.
  url.searchParams.set('scope', 'email');
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Zwei Schritte statt einem — Facebook ist kein OpenID Connect.
 *
 * Es gibt kein ID-Token, in dem schon steht, wer da kommt: der Code wird gegen
 * ein Zugriffstoken getauscht, und mit dem muss die Kennung anschliessend
 * **abgefragt** werden. Der zweite Weg ist deshalb kein Umweg, sondern der
 * einzige.
 *
 * Was dabei nicht nötig ist: nachzusehen, ob das Token für uns ausgestellt
 * wurde. Bei Google ist das eine echte Prüfung (`aud`), weil ein ID-Token auch
 * aus einer fremden Anwendung stammen könnte. Hier haben **wir** getauscht,
 * mit unserem Geheimnis, gegen unsere Rückadresse — ein Token aus fremder Hand
 * kommt an dieser Stelle nicht vorbei.
 */
async function facebookProfil(cfg: AnbieterConfig, code: string): Promise<Profil | undefined> {
  /*
   * Der Tausch läuft über GET, so wie Facebook ihn beschreibt.
   *
   * Das Geheimnis steht damit in der Abfrage und nicht im Rumpf — bei einem
   * gewöhnlichen OAuth-Endpunkt wäre das ein Mangel. Hier ist die Adresse
   * unsere eigene ausgehende, sie geht über TLS an genau einen Empfänger und
   * wird nirgends protokolliert; ein Proxy, der sie zu sehen bekäme, hätte
   * ohnehin schon das ganze Gespräch.
   */
  const tausch = new URL(`https://graph.facebook.com/${GRAPH}/oauth/access_token`);
  tausch.searchParams.set('client_id', cfg.clientId);
  tausch.searchParams.set('client_secret', cfg.clientSecret);
  tausch.searchParams.set('redirect_uri', cfg.redirectUri);
  tausch.searchParams.set('code', code);

  let antwort: Response;
  try {
    antwort = await fetch(tausch, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    console.warn('[anmelde] Facebook antwortet nicht:', err);
    return undefined;
  }

  if (!antwort.ok) {
    console.warn(
      `[anmelde] Facebook lehnt den Code ab (${antwort.status}): ${await absage(antwort)}`,
    );
    return undefined;
  }

  const daten = (await antwort.json().catch(() => ({}))) as { access_token?: string };
  if (!daten.access_token) {
    console.warn('[anmelde] Facebooks Antwort enthält kein Zugriffstoken.');
    return undefined;
  }

  /*
   * Das Token im Kopf und nicht in der Abfrage.
   *
   * Beides geht; Facebook nimmt `?access_token=…` genauso. Ein Token in einer
   * Adresse landet aber in jedem Zugriffsprotokoll, durch das die Anfrage
   * unterwegs kommt, und es ist für seine Lebensdauer so gut wie ein Passwort.
   */
  const wer = new URL(`https://graph.facebook.com/${GRAPH}/me`);
  wer.searchParams.set('fields', 'id,email');

  let profilAntwort: Response;
  try {
    profilAntwort = await fetch(wer, {
      headers: { authorization: `Bearer ${daten.access_token}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    console.warn('[anmelde] Facebook antwortet nicht auf die Frage nach der Kennung:', err);
    return undefined;
  }

  if (!profilAntwort.ok) {
    console.warn(
      `[anmelde] Facebook gibt die Kennung nicht heraus (${profilAntwort.status}): ` +
        `${await absage(profilAntwort)}`,
    );
    return undefined;
  }

  const ich = (await profilAntwort.json().catch(() => ({}))) as { id?: string; email?: string };
  if (typeof ich.id !== 'string' || ich.id === '') {
    console.warn('[anmelde] Facebooks Antwort enthält keine Kennung.');
    return undefined;
  }

  /*
   * Die Adresse kann fehlen, und das ist keine Störung.
   *
   * Facebook zeigt die Freigabe im Anmeldedialog als abwählbar an, und wer sie
   * abwählt, kommt mit einem gültigen Code und ohne Adresse zurück. Auch ein
   * Konto, das nur an einer Telefonnummer hängt, hat keine. Gemeldet wird es
   * hier, entschieden wird es im Anbieterweg — dort steht jemand davor, dem
   * man sagen kann, woran es lag.
   */
  if (!ich.email) {
    console.warn(`[anmelde] Facebook gibt für ${ich.id} keine Adresse heraus.`);
  }

  return { subject: ich.id, email: typeof ich.email === 'string' ? ich.email : '' };
}

// --- Die Tabelle ------------------------------------------------------------

/**
 * Alle Anbieter, die dieser Server kennt.
 *
 * Die eine Wahrheit darüber, welche es gibt: der Anbieterweg baut daraus seine
 * Pfade, die Konfiguration ihre Felder, `/anmeldearten` seine Antwort und der
 * Start seine Warnungen. Wer einen dritten hinzufügt, schreibt ihn hierhin —
 * und muss danach keine Liste suchen, die er vergessen hat.
 */
export const ANBIETER: readonly Anbieter[] = [
  {
    id: 'google',
    name: 'Google',
    startUrl: googleStartUrl,
    profil: googleProfil,
    auffaelligkeiten: (cfg) => {
      const raus: string[] = [];
      /*
       * Ein Geheimnis der heutigen Bauart hat eine feste Länge.
       *
       * `GOCSPX-` und achtundzwanzig Zeichen, zusammen fünfunddreissig. Weicht
       * das ab, obwohl der Anfang stimmt, hängt etwas daran oder fehlt etwas —
       * und Google sagt dazu nur `invalid_client`, dieselbe Antwort wie bei
       * einem völlig falschen Wert. Die Länge steht hier, das Geheimnis nicht.
       *
       * Nur für diese eine Bauart. Ältere Geheimnisse haben kein Präfix und
       * eine andere Länge; sie hier zu bemängeln wäre eine Warnung über etwas
       * Richtiges, und die liest beim dritten Mal niemand mehr.
       */
      if (cfg.clientSecret.startsWith('GOCSPX-') && cfg.clientSecret.length !== 35) {
        raus.push(
          `das Geheimnis ist ${cfg.clientSecret.length} Zeichen lang, erwartet sind 35 ` +
            '(GOCSPX- und 28 Zeichen)',
        );
      }
      if (!cfg.clientId.endsWith('.apps.googleusercontent.com')) {
        raus.push(
          'die Kennung endet nicht auf .apps.googleusercontent.com — ' +
            'das ist die Kennung, nicht das Geheimnis',
        );
      }
      return raus;
    },
  },
  {
    id: 'facebook',
    name: 'Facebook',
    startUrl: facebookStartUrl,
    profil: facebookProfil,
    auffaelligkeiten: (cfg) => {
      const raus: string[] = [];
      /*
       * Beide Werte haben bei Facebook eine erkennbare Form: die App-ID ist
       * eine reine Zahl, das Geheimnis zweiunddreissig Zeichen aus 0-9a-f. Am
       * häufigsten sind sie schlicht vertauscht — und darauf antwortet
       * Facebook mit derselben nichtssagenden Absage wie auf einen falschen
       * Wert.
       */
      if (!/^\d+$/.test(cfg.clientId)) {
        raus.push('die App-ID ist keine reine Zahl — steht dort das Geheimnis?');
      }
      if (!/^[0-9a-f]{32}$/.test(cfg.clientSecret)) {
        raus.push(
          `das App-Geheimnis ist nicht 32 Zeichen aus 0-9a-f (es sind ${cfg.clientSecret.length})`,
        );
      }
      return raus;
    },
  },
];

/** Der Anbieter zu einer Kennung — oder nichts, wenn es ihn nicht gibt. */
export function anbieterMit(id: string): Anbieter | undefined {
  return ANBIETER.find((a) => a.id === id);
}
