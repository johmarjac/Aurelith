/**
 * Der Weg in die Welt, für Prüfungen mit Browser.
 *
 * Seit es Konten gibt, beginnt jede Sitzung mit Masken: anmelden, Figur
 * anlegen, betreten. Das steht hier einmal und nicht in acht Rauchtests —
 * sonst wäre jede Änderung an der Anmeldung eine Änderung an acht Dateien, und
 * eine davon bliebe zurück.
 *
 * Angelegt wird jedes Mal ein **frisches** Konto. Ein wiederverwendetes hätte
 * einen Spielstand, und ein Rauchtest, der auf einem Spielstand aufsetzt,
 * prüft irgendwann den Spielstand statt das Spiel.
 *
 * Die Masken sind vier: Anmeldung, Kanalauswahl, Figurenliste, Figur anlegen.
 * Sichtbar ist immer genau eine. Ein Spielserver im Alleinbetrieb — und in
 * diesem Aufbau läuft immer einer — überspringt die Kanalauswahl und schickt
 * gleich die Figurenliste.
 */

/** Wählt in einer bestimmten Maske. Ohne sie träfe ein Klick eine versteckte. */
const IN = (maske, rest) => `.${maske}:not([hidden]) ${rest}`;

/**
 * Meldet ein neues Konto an, legt eine Figur an und betritt mit ihr die Welt.
 *
 * `figur` ist standardmässig derselbe Name wie das Konto — für die meisten
 * Prüfungen ist das die kürzeste Fassung. Wer die beiden **unterscheiden**
 * muss, gibt sie an: solange sie gleich heissen, fällt eine Stelle nicht auf,
 * die versehentlich den Kontonamen nimmt, wo der Figurenname hingehört. Genau
 * so ist die E-Mail-Adresse eines Google-Kontos nach jedem Tor über dem Kopf
 * gelandet.
 */
export async function anmeldenUndBetreten(
  page,
  name,
  passwort = 'pruefer-passwort',
  figur = name,
) {
  await page.waitForSelector(IN('lobby-anmeldung', '.lobby-input'), { timeout: 40000 });

  await page.fill(IN('lobby-anmeldung', '.lobby-input[type="text"]'), name);
  await page.fill(IN('lobby-anmeldung', '.lobby-input[type="password"]'), passwort);
  await page.click(IN('lobby-anmeldung', '.btn:not(.btn-gross)')); // „Konto anlegen"

  // Ein frisches Konto hat keine Figur. Der Weg zum Anlegen führt trotzdem
  // über die Liste — sie ist die Maske, die nach dem Anmelden kommt, leer oder
  // nicht.
  await page.waitForSelector(IN('lobby-auswahl', '.btn-gross'), { timeout: 20000 });
  await page.click(IN('lobby-auswahl', '.btn-gross')); // „＋ Neue Figur"

  await page.waitForSelector(IN('lobby-neu', '.lobby-input'), { timeout: 20000 });
  await page.fill(IN('lobby-neu', '.lobby-input'), figur);
  await page.click(IN('lobby-neu', '.btn-gross')); // „Figur anlegen"

  await betreteErsteFigur(page);
}

/**
 * Meldet ein **bestehendes** Konto an und betritt dessen erste Figur.
 *
 * Für den Fall, dass die Verbindung zwischendurch weg war: das Konto gibt es
 * schon, die Figur auch, und beides soll nicht doppelt entstehen.
 */
export async function anmeldenBestehend(page, name, passwort = 'pruefer-passwort') {
  await page.waitForSelector(IN('lobby-anmeldung', '.lobby-input'), { timeout: 40000 });
  await page.fill(IN('lobby-anmeldung', '.lobby-input[type="text"]'), name);
  await page.fill(IN('lobby-anmeldung', '.lobby-input[type="password"]'), passwort);
  await page.click(IN('lobby-anmeldung', '.btn-gross')); // „Anmelden"

  await betreteErsteFigur(page);
}

/** Betritt die Welt mit der ersten Figur der Liste. */
async function betreteErsteFigur(page) {
  await page.waitForSelector('.lobby-figur .btn', { timeout: 20000 });
  // Die erste Schaltfläche der Zeile ist „Betreten"; die zweite löscht.
  await page.click('.lobby-figur .btn:not(.btn-warn)');
  await warteAufWelt(page);
}

/**
 * Wartet, bis die Welt wirklich steht.
 *
 * `localId` allein reicht nicht mehr: die Karte wird erst geladen, wenn der
 * Server gesagt hat, welche es ist, und bis dahin steht die Maske noch. Wer
 * nur auf die Kennung wartet, prüft ein Gelände, das es noch nicht gibt.
 */
async function warteAufWelt(page) {
  await page.waitForFunction(() => window.aurelith?.localId > 0, { timeout: 40000 });
  // `state: 'hidden'` und nicht `.lobby[hidden]`: eine versteckte Maske wird
  // niemals „sichtbar", und genau darauf wartet Playwright sonst.
  await page.waitForSelector('.lobby', { state: 'hidden', timeout: 60000 });
}
