/**
 * Der Weg in die Welt, für Prüfungen mit Browser.
 *
 * Seit es Konten gibt, beginnt jede Sitzung mit einer Maske: Konto anlegen,
 * Figur anlegen, betreten. Das steht hier einmal und nicht in acht
 * Rauchtests — sonst wäre jede Änderung an der Anmeldung eine Änderung an
 * acht Dateien, und eine davon bliebe zurück.
 *
 * Angelegt wird jedes Mal ein **frisches** Konto. Ein wiederverwendetes hätte
 * einen Spielstand, und ein Rauchtest, der auf einem Spielstand aufsetzt,
 * prüft irgendwann den Spielstand statt das Spiel.
 */

/**
 * Meldet ein neues Konto an, legt eine Figur an und betritt mit ihr die Welt.
 *
 * `name` ist Konto- und Figurenname zugleich: im Spiel steht der Figurenname
 * über der Figur, und die Prüfungen suchen genau danach.
 */
export async function anmeldenUndBetreten(page, name, passwort = 'pruefer-passwort') {
  await page.waitForSelector('.lobby:not([hidden]) .lobby-input', { timeout: 40000 });

  await page.fill('.lobby-form .lobby-input[type="text"]', name);
  await page.fill('.lobby-form .lobby-input[type="password"]', passwort);
  await page.click('.lobby-form .btn:not(.btn-gross)'); // „Konto anlegen"

  await page.waitForSelector('.lobby-neu:not([hidden])', { timeout: 20000 });
  await page.fill('.lobby-neu .lobby-input', name);
  await page.click('.lobby-neu .btn');

  await page.waitForSelector('.lobby-figur .btn', { timeout: 20000 });
  await page.click('.lobby-figur .btn');

  await page.waitForFunction(() => window.aurelith?.localId > 0, { timeout: 40000 });
}

/**
 * Meldet ein **bestehendes** Konto an und betritt dessen erste Figur.
 *
 * Für den Fall, dass die Verbindung zwischendurch weg war: das Konto gibt es
 * schon, die Figur auch, und beides soll nicht doppelt entstehen.
 */
export async function anmeldenBestehend(page, name, passwort = 'pruefer-passwort') {
  await page.waitForSelector('.lobby:not([hidden]) .lobby-form:not([hidden]) .lobby-input', {
    timeout: 40000,
  });
  await page.fill('.lobby-form .lobby-input[type="text"]', name);
  await page.fill('.lobby-form .lobby-input[type="password"]', passwort);
  await page.click('.lobby-form .btn-gross'); // „Anmelden"

  await page.waitForSelector('.lobby-figur .btn', { timeout: 20000 });
  await page.click('.lobby-figur .btn');
  await page.waitForFunction(() => window.aurelith?.localId > 0, { timeout: 40000 });
}
