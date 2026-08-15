# Regeln für die Arbeit an Aurelith

Dieses Blatt steht über dem Code. Wer hier etwas ändert, ändert es für alle
folgenden Arbeitsschritte — also nur, wenn die Regel wirklich falsch war, und
mit der Begründung dazu.

---

## Sprache

**Alles ist deutsch.** Bezeichner, Kommentare, Commit-Nachrichten, Texte in der
Oberfläche, Ausgaben der Tests. Englische Wörter bleiben nur dort stehen, wo sie
von aussen kommen (`three.js`, `pointerdown`, SQL) oder wo die Umbenennung
älteren Code halb zurücklassen würde — dann aber im ganzen Umfeld einheitlich.

---

## Absagen sind sichtbar

**Jeder Grund, warum eine Aktion nicht geht, erscheint unten in der Mitte** —
in der Hinweiszeile über der Aktionsleiste, dort, wo auch der Wartebalken fürs
Aufsteigen läuft. Klein, vier Sekunden, die neue ersetzt die alte.

Der Weg dorthin ist **eine** Stelle und kein Verteiler:

- **Server:** `systemMessage(session, …)`. Der Client zeigt in `onChat` jede
  Nachricht auf `ChatChannel.System` in der Hinweiszeile an. Wer eine neue
  Absage einbaut, bekommt die Anzeige damit geschenkt — es gibt keine Liste, in
  die man sie zusätzlich eintragen müsste.
- **Client:** `absage(text)` in `packages/client/src/ui/index.ts`. Zeigt
  dieselbe Zeile und schreibt zusätzlich in den Chat, damit der Grund nachlesbar
  bleibt, nachdem die Zeile verblasst ist.

Ein stilles `return` auf eine Spieleraktion ist ein Fehler. „Ich habe gedrückt
und nichts passierte" ist die schlechteste aller Antworten — schlechter als
jede Absage, denn sie sieht aus wie ein kaputtes Spiel. Beispiele, wie die Texte
klingen sollen: „Auf dem Fluggerät lassen sich keine Fertigkeiten wirken.",
„Sammler lässt sich vom Fluggerät aus nicht freilassen.", „Kleiner Heiltrank ist
noch nicht bereit (0,4 s)."

Absagen dürfen **nichts kosten**: die Prüfung steht vor dem Verbrauch, vor der
Abklingzeit und vor dem Abzug. Und der Client prüft mit, wo eine falsche
Annahme teuer wäre — eine Fertigkeit, deren Uhr anläuft, obwohl der Server sie
gleich absagt, bleibt sonst für ihre volle Frist gesperrt, und der Client weiss
hinterher nicht mehr, welche Uhr zurückzudrehen wäre.

---

## Wer entscheidet

Der **Server** entscheidet. Was er nicht durchsetzt, gilt nicht. Prüfungen im
Client sind Höflichkeit — sie ersparen das Flackern und die überflüssige
Nachricht, aber sie ersetzen die Prüfung im Server nie, sie kommen zu ihr dazu.

Der **Kern** (C++ → wasm) rechnet auf beiden Seiten mit derselben Binärdatei.
Was Bewegung ist, gehört dorthin und nicht in den Server — sonst laufen
Vorhersage und Wahrheit auseinander.

**Eingabebits sind Zustände, keine Flanken.** Die Abstimmung des Clients spielt
die noch offenen Eingaben erneut ab; ein Bit, das „umschalten" bedeutet, würde
dabei mehrfach umschalten. Der Umschalter lebt im Client, gesendet wird der
Zustand (`kButtonSchub` ist an, solange Schub an ist).

**Eine Wahrheit je Sache.** Steht dieselbe Angabe an zwei Stellen, laufen sie
auseinander, und zwar genau dann, wenn es darauf ankommt. Lieber eine Stelle
durchreichen als zwei pflegen.

---

## Kommentare

Kommentare erklären das **Warum**, und zwar mit dem konkreten Fehler, den die
Zeile verhindert. „Setzt den Winkel" ist keine Auskunft. „Reihenfolge `YXZ`,
sonst kippt die Nase um die Weltachse und die Figur liegt in der Kurve auf der
Seite" ist eine.

Was einmal falsch war, bleibt als Notiz stehen. Sonst wird es wieder falsch.

---

## Tests

- **Jeder Test braucht eine Gegenprobe.** Ein Test, der auch dann grün ist, wenn
  die Sache kaputt ist, ist schlimmer als keiner. Also immer auch die Bedingung
  prüfen, unter der das Ergebnis _nicht_ eintreten darf.
- **Browsertests warten auf Ticks, nicht auf Millisekunden.** Headless läuft mit
  swiftshader bei ~3,5 Bildern je Sekunde, und der Client deckelt `dt` je Bild
  auf 0,1 s — die Simulation läuft also auf ein Drittel der Wanduhr. Wer
  `waitForTimeout(900)` schreibt, misst nichts. `window.aurelith.ticks` ist das
  Mass.
- **Nie eine Client-Datei anfassen, während ein Browsertest läuft.** Vite lädt
  neu, und der Test stirbt mit „Execution context was destroyed". Erst den Test
  zu Ende laufen lassen.
- Nach jeder Änderung: `npm run typecheck`, dann die betroffenen Tests. Wer den
  Kern anfasst: `npm run core` und `npm run core:test`.
- Die Testliste steht in `package.json` (`npm test` fährt alles). Ein neuer Test
  wird dort **und** im README eingetragen.

Bekannt und geduldet: `npm run test:npcflow` ist im Kampfteil rot (bewusst
liegengelassen), und die Zwei-Finger-Geste in `smoke-e2e` ist gelegentlich
flatterig.

---

## Protokoll

Ändert sich das Format eines Frames, wird `PROTOCOL_VERSION` in
`packages/shared/src/net/opcodes.ts` hochgezählt. Ein Client mit falscher
Version wird abgewiesen — das ist gewollt und besser als ein falsch gelesenes
Byte.

Ändert sich `EntityView`, sind es **drei** Stellen, und alle drei müssen
zusammenpassen:

1. `packages/core/include/aurelith/types.hpp` (Feld und Grösse der Struktur),
2. `packages/core/src/layout.ts` (`stride` und Offset),
3. `packages/core/bindings/embind.cpp` (`offsetof`).

---

## Sicherheit

- Alles unter `/intern/` ist nur mit `AURELITH_INTERNAL_SECRET` erreichbar
  (Kopfzeile `x-aurelith-secret`) und gehört **nie** ins offene Netz.
- `AURELITH_ANMELDE_ZIELE` ist keine Bequemlichkeit, sondern eine Sperre: die
  Anmeldekarte steht im Fragment der URL und ist so gut wie ein Passwort. Eine
  offene Weiterleitung überreicht sie einem Fremden.
- Die Karte („Ticket") läuft **zeitlich** ab, nicht nach Anzahl der Nutzungen.
  Der Kanal frischt sie auf, solange die Verbindung steht; nach einem Abriss
  gilt sie noch 30 Minuten, damit ein Wiederverbinden ohne neue Anmeldung geht.

---

## Datenbank

`DATABASE_URL=''` wählt den Speicher-Fallback. Alle Tests laufen so — kein Test
darf eine echte Datenbank brauchen. Konten liegen in der Hauptdatenbank, Welten
je Region getrennt.

---

## Ablauf

Entwickelt wird auf dem zugewiesenen Zweig, jede fertige Sache bekommt einen
eigenen Commit mit deutscher Nachricht, die sagt, _was_ sich für den Spielenden
ändert — nicht, welche Dateien angefasst wurden.
