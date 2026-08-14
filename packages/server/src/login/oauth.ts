/**
 * Anmeldung über fremde Anbieter — heute Google.
 *
 * Der Ablauf ist der übliche von OpenID Connect, und er läuft **nicht** über
 * den WebSocket, sondern über gewöhnliches HTTP mit Weiterleitungen: der
 * Browser muss zu Google und wieder zurück, und das kann eine Spielverbindung
 * nicht für ihn tun.
 *
 *   1. Der Client ruft `/auth/google/start?ziel=<seine Adresse>` auf.
 *   2. Wir schicken ihn zu Google — mit einem `state`, in dem sein Ziel steht.
 *   3. Google schickt ihn an `/auth/google/callback` zurück, mit einem `code`.
 *   4. Wir tauschen den Code bei Google gegen ein ID-Token, lesen daraus, wer
 *      da kommt, und suchen oder legen das Konto an.
 *   5. Wir schicken ihn zurück an sein Ziel — mit einer **Anmeldekarte** im
 *      Ankerteil der Adresse.
 *   6. Der Client zeigt die Karte über den WebSocket vor und ist angemeldet.
 *
 * Warum die Karte und nicht gleich eine Sitzung: die Spielverbindung ist ein
 * WebSocket und hat mit dem Browserfenster, das von Google zurückkommt, nichts
 * zu tun. Die Karte ist das Einzige, was zwischen beiden übergeben werden
 * muss — und sie gilt zwei Minuten und genau einmal, wie die Eintrittskarte
 * für einen Kanal.
 *
 * **Was hier absichtlich fehlt:** die Prüfung der Signatur des ID-Tokens. Das
 * Token kommt nicht aus dem Browser, sondern aus unserer eigenen Anfrage an
 * Googles Token-Endpunkt, über TLS und mit unserem Geheimnis. Der Standard
 * lässt die Prüfung für genau diesen Fall ausdrücklich weg (OIDC Core 3.1.3.7,
 * Punkt 6). Käme das Token je aus dem Browser, müsste sie her — dann steht sie
 * hier, und dieser Absatz sagt, warum.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Wie lange ein angefangener Anmeldeversuch gilt. */
const STATE_MS = 10 * 60 * 1000;

export interface AnbieterConfig {
  clientId: string;
  clientSecret: string;
  /**
   * Wohin Google zurückschickt. Muss bei Google Wort für Wort so eingetragen
   * sein — ein fehlender Schrägstrich reicht für eine Absage.
   */
  redirectUri: string;
}

export interface Profil {
  /** Die Kennung des Anbieters für diesen Menschen. Ändert sich nie. */
  subject: string;
  email: string;
  /** Was auf der Visitenkarte steht. Nur ein Vorschlag für den Kontonamen. */
  name: string;
}

/**
 * Unterschreibt den `state` — und prüft ihn zurück.
 *
 * Er reist über den Browser des Spielers und über Google. Ohne Unterschrift
 * könnte jemand ein eigenes Ziel hineinschreiben und den Rückweg samt
 * Anmeldekarte auf seine Seite lenken. Mit Unterschrift ist er ein Zettel, den
 * nur dieser Server ausgestellt haben kann.
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

/** Die Adresse, zu der der Browser geschickt wird. */
export function googleStartUrl(cfg: AnbieterConfig, state: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('response_type', 'code');
  // Mehr als Name und Adresse brauchen wir nicht, also fragen wir nicht mehr.
  url.searchParams.set('scope', 'openid email profile');
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
export async function googleProfil(
  cfg: AnbieterConfig,
  code: string,
): Promise<Profil | undefined> {
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
    /*
     * Googles Begründung mitschreiben, nicht nur die Zahl.
     *
     * Der Status allein ist hier fast wertlos: `400` steht gleichermassen für
     * eine falsch eingetragene Rückadresse (`redirect_uri_mismatch`), einen
     * bereits eingelösten Code (`invalid_grant`) und ein Geheimnis mit einem
     * Anführungszeichen darin (`invalid_client` kommt als 401). Im Rumpf steht
     * genau, welcher Fall es ist — und ohne ihn beginnt die Suche bei null.
     *
     * Das ist eine Protokollzeile auf dem Server und keine Auskunft an den
     * Browser: dem Spieler bleibt „das hat nicht geklappt".
     */
    const grund = await antwort.text().catch(() => '');
    console.warn(
      `[anmelde] Google lehnt den Code ab (${antwort.status}): ${grund.slice(0, 300)}`,
    );
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
    name:
      typeof nutzlast.given_name === 'string' && nutzlast.given_name.length > 0
        ? nutzlast.given_name
        : typeof nutzlast.name === 'string'
          ? nutzlast.name
          : '',
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
