<p align="center">
  <img src="packages/client/icons/logo.webp" alt="" width="140" />
</p>

# Aurelith

Browserbasiertes 3D-MMORPG. Klassisches Setting, Kampf mit Zielauswahl und
Kartenaufbau mit Gates und Dungeons im Stil von Flyff — mit eigener Grafik und
eigenem Stack.

Der Aufbau folgt dem Blueprint aus dem Flyff-Universe-Teardown, mit einer
bewussten Abweichung, die weiter unten begründet ist.

---

## Was schon läuft

- **Ein C++-Simulationskern**, nach WebAssembly übersetzt, geladen von Client
  *und* Server — dieselbe Binärdatei, also dieselbe Rechnung auf beiden Seiten.
- **Autoritativer Server** mit fester Schrittweite (20 Hz), Interessenradius und
  Snapshots (10 Hz), PostgreSQL-Anbindung mit Speicher-Fallback.
- **Eigenes Frame-Format** über WebSocket, binär und versioniert, mit
  eingezogener — heute abgeschalteter — Cipher-Schicht.
- **Client-Prediction** der eigenen Bewegung samt Abgleich gegen den Server.
- **Three.js auf WebGL 2**, prozedurale Modelle, instanziierte Props,
  Terrainnetz aus den Höhen des Kerns.
- **Desktop und Mobil**: WASD und Maus am Rechner, virtueller Joystick und
  Angriffsknopf am Telefon.
- **Kampf mit Zielauswahl**: ein Klick visiert an, der zweite greift an — die
  Figur läuft von selbst in Reichweite und schlägt weiter, bis man sie mit
  einem Klick in die Welt oder einem Schritt zur Seite wieder herausholt.
  Getroffen wird ausschliesslich das anvisierte Wesen.
- **UI im Flyff-Zuschnitt**: Werteleisten, Zielfenster, Chat, Inventar,
  Charakterblatt, ziehbare Fenster, Namensschilder, Schadenszahlen — in einem
  eigenen Theme aus Pergament, Holz und Messing, und mit einem Regler für die
  Größe der ganzen Oberfläche.
- **Ausrüstung mit Rüstungssätzen**: dreizehn Plätze, sichtbare Teile an der Figur,
  Satzbonus für den vollständigen Satz und ein Schein um die Rüstung, sobald
  jedes Teil davon mindestens +4 trägt.
- **Fluggeräte**: Besen und Board, gesteuert über die Lage — Nase und Kurs statt
  Richtungstasten. Aufsteigen dauert und zeigt einen Wartebalken; in der Luft
  wird weder geschlagen noch gewirkt, anvisieren geht.
- **Eine Hinweiszeile** unten in der Mitte, in der **jede** Absage steht: warum
  eine Aktion nicht ging, klein und für ein paar Sekunden. Alles, was der Server
  als Systemnachricht schickt, landet dort von selbst.
- **Drei Karten** mit Gates und einem Dungeon, dazu ein **Map-Editor**, der
  dasselbe Dateiformat liest und schreibt.

---

## Schnellstart

```bash
npm install
npm run core     # C++ → wasm (braucht Emscripten, siehe unten)
npm run maps     # Startkarten erzeugen
npm run manifest # Asset-Manifest schreiben
npm run dev      # Server und Client zusammen
```

Danach: <http://localhost:5173>

Der Map-Editor läuft getrennt:

```bash
npm run dev:editor   # → http://localhost:5174
```

### Emscripten

Der Kern ist C++ und wird nach WebAssembly übersetzt. Einmalig:

```bash
git clone --depth 1 https://github.com/emscripten-core/emsdk.git /opt/emsdk
cd /opt/emsdk && ./emsdk install latest && ./emsdk activate latest
```

`tools/build-core.mjs` findet das SDK über `$EMSDK`, `/opt/emsdk` oder
`~/emsdk`. Es baut immer zuerst nativ und führt die Prüfungen aus — die sind in
Sekunden durch und fangen praktisch alles ab, was auch im wasm-Build schiefginge.

### Datenbank

Ohne `DATABASE_URL` startet der Server mit einem Speicher-Backend und sagt das
beim Hochfahren. Für echte Persistenz:

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/aurelith
npm run db:migrate
```

Migrationen liegen als schlichte SQL-Dateien in `packages/server/migrations/`
und werden beim Serverstart mitgezogen.

### Verschlüsselung

Heute läuft alles im Klartext. Zwei Stufen sind vorbereitet:

1. **Transport** — `AURELITH_TLS_KEY` und `AURELITH_TLS_CERT` setzen, dann hört
   der Server auf `wss://` statt `ws://`. Das ist die Stufe, die tatsächlich
   schützt.
2. **Pakete** — die Cipher-ID steht im Frame-Header, beide Seiten handeln sie
   beim Handshake aus, und `packages/shared/src/net/cipher.ts` enthält neben der
   Null-Cipher bereits einen XOR-Stream. Der ist Verschleierung, keine
   Kryptografie; der Schutz gegen Manipulation liegt allein in der
   Server-Autorität.

---

## Aufbau

```
packages/
  core      C++-Simulationskern → WebAssembly. Bewegung, Kollision, Kampf,
            KI, Terrain. Kennt weder Browser noch Netzwerk.
  shared    Protokoll, Frame-Format, Map-Format, Content-Tabellen. TypeScript,
            läuft in Client und Server.
  server    Zwei Serveranwendungen in einem Paket:
            `src/index.ts`       Spielserver — **ein Kanal**. Autorität, treibt
                                 je Karte eine Welt im Kern.
            `src/login/index.ts` Anmeldeserver — Konten und Kanalliste. Von dem
                                 gibt es genau einen.
            Ein Paket, weil Konten, Datenbank und Passwortregeln damit an genau
            einer Stelle stehen. Zwei Prozesse, zwei Rollen.
  client    Dünne Schale, Renderer, Eingabe, UI.
            `icons/aurelith.webp` ist die Zeichnung der Marke; alles andere
            in dem Ordner leitet `tools/gen-icons.mjs` daraus ab.
  editor    Map-Editor auf demselben Stack.
assets/
  maps      aurelith.map-Dokumente
  core      gebauter wasm-Kern (erzeugt)
tools/      Bau- und Testskripte
```

### Warum der Kern in C++ liegt

Der Blueprint empfahl, bei TypeScript zu bleiben, bis ein Profil etwas anderes
zeigt. Wir sind bewusst davon abgewichen — aber nicht zu Flyffs Lösung.

Flyff liefert 8,6 MB wasm aus, weil dort ein vollständiger Windows-Client samt
Renderer, Audio und Szenengraph portiert wurde. Das erzwingt den Ladebildschirm,
gegen den der Blueprint ausdrücklich argumentiert.

Bei uns liegt **nur die Simulation** im Kern: 48 KiB wasm, 18,5 KiB nach Brotli.
Renderer, UI und Netzwerk bleiben TypeScript. Damit bekommen wir die Eigenschaft,
auf die es ankommt — Client und Server führen für Bewegung, Kollision und Kampf
*dieselbe Binärdatei* aus, können also nicht auseinanderlaufen — ohne die
Ladeschranke mitzukaufen.

### Die Brücke

`packages/core/bindings/embind.cpp` ist die einzige Stelle, an der wasm und
JavaScript sich berühren, und sie ist absichtlich eng:

- Jede erreichbare Funktion steht namentlich im `EMSCRIPTEN_BINDINGS`-Block.
- Der Kern ruft nie von sich aus in JavaScript hinein.
- Zustand geht als flacher Puffer über die Grenze, über den JavaScript eine
  Sicht legt — ein Aufruf je Frame statt einem je Entity.
- `describeLayout()` meldet die Byte-Versätze der gepackten Strukturen, und
  `layout.ts` prüft sie beim Start. Der Vertrag wird geprüft, nicht geglaubt.

Das ist der Gegenentwurf zu Flyffs Weg, bei dem C++ über `emval` in den globalen
Namensraum des Browsers greift und jeder Aufruf alles darf.

---

## Karten

Eine Karte ist ein JSON-Dokument (`aurelith.map`, Version 1) mit Terrain,
Props, Spawnern, NPCs und Portalen. Server, Client und Editor lesen dieselbe
Datei — es gibt keinen Export- und keinen Importschritt.

```jsonc
{
  "format": "aurelith.map",
  "version": 1,
  "id": "lichtmoor",
  "terrain": { "size": 512, "seed": 19529, "heightScale": 11, … },
  "props":    [{ "id": "p_0001", "model": "tree_pine", "position": [x, y, z], … }],
  "spawners": [{ "id": "s_mote_a", "mob": "mote", "count": 7, "respawnMs": 9000, … }],
  "portals":  [{ "id": "g_dornwald", "target": { "map": "dornwald", … }, "minLevel": 0 }]
}
```

Die Starkarten erzeugt `tools/gen-maps.mjs` — ein Platzhalter, bis der Editor
weit genug ist. Das Höhenfeld ist prozedural aus dem Seed und wird vom **Kern**
berechnet, nicht vom Renderer: der sichtbare Boden ist damit per Konstruktion
der begehbare Boden.

---

## Prüfen

```bash
npm run typecheck    # alle fünf Pakete
npm run core:test    # native Prüfungen des Kerns
npm test             # alles: Kern, wasm-Brücke, Lenkung, Pinsel, Browser, Pages
```

Einzeln, wenn nur ein Bereich betroffen ist:

```bash
npm run test:wasm        # der Vertrag über die wasm-Brücke
npm run test:steering    # Drehen, Anlaufen, Auslaufen — ohne Browser
npm run test:brushes     # die Editor-Pinsel — ohne Browser
npm run test:particles   # die Funkenwolke und der Pfeilschweif
npm run test:audio       # Richtung und Entfernung im Raumklang
npm run test:gait        # Laufbewegung: springt eine Pose?
npm run test:flugachse   # kippt die Nase um die Achse der Figur oder der Welt?
npm run test:tag         # Tag- und Nachtwechsel: Licht, Farben, Uhr
npm run test:quests      # das Auftragsbuch — ohne Server
npm run test:content     # die Inhaltsdateien: Format und Verweise
npm run test:loot        # wer welche Beute vom Boden aufheben darf
npm run test:sets        # Rüstungssätze: wann sie gelten, wann sie leuchten
npm run test:setglow     # derselbe Satz über das Netz, vom Schmied bis zum Schein
npm run test:npcflow     # ansprechen, annehmen, erlegen, aufheben, abgeben
npm run test:npc         # NPC-Fenster und Inventar im Browser
npm run test:identitaet  # ein Mensch, zwei Anbieter, ein Konto
npm run test:karten      # Eintrittskarten: Frist, Lebenszeichen, Wiedereinstieg
npm run test:vorgang     # Aufsteigen dauert, und eine Absage kostet keine Abklingzeit
npm run test:haustier    # Begleiter: Sorten, Leine, Werte
npm run test:loot-ui     # Beute im Bild: Schild, Antippen, Aufheben
npm run test:skills      # Fertigkeitenbaum: Taste, Beruf, Zug auf die Leiste, Sperre im Flug
npm run test:e2e         # Spiel im Browser, Desktop und Berührung
npm run test:prediction  # springt die eigene Figur beim Laufen zurück?
npm run test:portal      # Tore: hineinlaufen, stehen, F drücken, zurück
npm run test:flug        # Fliegen: aufsteigen, Schub, Nase, anhalten, absteigen
npm run test:background  # überlebt die Verbindung einen Tab im Hintergrund?
npm run test:editor      # Editor: Werkzeuge, Pinsel, Tore, Speichern
npm run test:pages       # der Pages-Bau unter einem Unterpfad
```

Die native Prüfung enthält eine auf **Reproduzierbarkeit**: zwei gleiche Läufe
müssen bitgleiche Zustände ergeben. Darauf setzt die Client-Prediction auf.

Der End-to-End-Test startet Server und Client, öffnet Chromium und prüft, was
ein Typecheck nicht sehen kann — dass der Kern lädt, die Verbindung steht,
Snapshots ankommen und tatsächlich ein Bild entsteht. Dazu die Bedienung
selbst: dass die Leinwand Zeigerereignisse überhaupt erreichen, dass die rechte
Maustaste dreht und das Rad zoomt, dass A und D auf die richtige Bildschirmseite
laufen, und in einem zweiten Kontext mit Berührungsbedienung, dass Joystick und
Zwei-Finger-Zoom greifen.

`window.aurelith` liefert dafür einen **lesenden** Blick auf Kamerastand und
gezeichnete Position. Ohne den lässt sich von außen nicht ansehen, was auf dem
Bildschirm tatsächlich passiert — und genau daran hingen mehrere Fehler, die
man sieht, aber nicht kompiliert bekommt.

### Tageszeit für Prüfungen und Bilder

`AURELITH_TIME_OFFSET_MS` verschiebt die **Serveruhr**. Der Tageszyklus hängt
an ihr und nicht an der Geräteuhr — nur so haben zwei Spieler nebeneinander
dieselbe Tageszeit, und genau deshalb lässt sich die Stunde auch nur dort
stellen. `npm run himmel` nutzt das: es startet je Tageszeit einen Server und
legt Bilder in `artefakte/himmel-*.png`.

Helligkeit lässt sich rechnen, und `npm run test:tag` tut das. Ob eine Nacht
*benutzbar* ist, sieht man nur — dafür sind die Bilder da.

### Konten, Figuren und Zugriffsstufen

Wer spielen will, meldet sich an: Kontoname und Passwort, danach die
Figurenverwaltung. Ein Konto kann `AURELITH_MAX_CHARACTERS` Figuren haben
(Standard vier), sie anlegen, löschen und mit einer davon die Welt betreten.
Passwörter liegen als `scrypt`-Zeile in der Datenbank, nie im Klartext.

Konten aus der Zeit ohne Passwort kommen nicht mehr hinein — ein leerer Hash
passt zu keiner Eingabe. Das ist Absicht: ein Konto ohne Nachweis darf sich
nicht anmelden, nur weil es alt ist.

Jedes Konto hat eine Zugriffsstufe: `player`, `gamemaster`, `developer`,
`admin`. Sie sind aufsteigend — wer eine hat, darf alles, was die Stufen
darunter dürfen — und entscheiden über die Chatbefehle, die der **Server**
ausführt: `/gg <menge>` und `/sys <text>` ab `gamemaster`, `/accesslevel` ab
`admin`. `/help` im Spiel zeigt jedem genau die Befehle, die ihm zustehen.

Vergeben wird auf zwei Wegen, und sie haben eine klare Rangfolge.

**Die Liste in der Konfiguration** ist der erste. Sie muss es sein: auf einem
frischen Server gibt es sonst niemanden, der jemandem etwas geben könnte.

```
AURELITH_ADMINS=johmarjac,helferlein:gamemaster,tester:developer
```

Ohne Doppelpunkt gilt `admin`. Die Liste greift bei **jeder** Anmeldung, also
in beide Richtungen: wer daraus verschwindet, behält beim nächsten Anmelden,
was in der Datenbank steht, und ein ausdrückliches `:player` nimmt eine Stufe
zurück. Ein vertipptes Stufenwort gilt nicht und wird beim Serverstart
gemeldet — sonst würde daraus stillschweigend eine Herabstufung.

**`/accesslevel <konto> <stufe>`** ist der zweite, ab `admin`, und schreibt
dauerhaft in die Datenbank. Als `<konto>` geht auch der Name einer Figur, die
gerade im selben Kanal spielt: im Spiel sieht man Figurennamen, und über einer
Figur mit Google-Konto steht nirgends deren Adresse. Wer gerade online ist,
bekommt die neue Stufe sofort, ohne sich neu anzumelden.

Steht der Name **in der Liste**, gewinnt die Liste bei der nächsten Anmeldung.
Der Befehl sagt das dann auch — eine Zuweisung, die zehn Minuten später von
selbst zurückspringt, wäre schlimmer als eine, die gar nicht erst geht.

### Stufen, Eigenschaften und Punkte

Die Grundwerte einer Figur folgen aus ihrer **Stufe** — Leben, Mana, Angriff
und Verteidigung wachsen linear mit ihr, die Zahlen stehen unter
`progression` in `assets/content/tuning.json`. Gespeichert wird davon nichts:
alles entsteht bei jedem Laden neu aus Stufe, Eigenschaften und Ausrüstung.
Deshalb wirkt eine Änderung an der Datei sofort auf alle Figuren.

Dazu kommen vier **Grundeigenschaften**, die der Spieler selbst setzt:

| | wirkt auf |
| --- | --- |
| Stärke | Angriff |
| Ausdauer | Leben, Verteidigung |
| Geschick | Kritische Chance, Schlagpause |
| Weisheit | Mana |

Jeder Stufenaufstieg bringt Punkte (`punkteJeStufe`), verteilt wird im
Charakterfenster mit `C`. Was ein Punkt bewirkt, steht in
`eigenschaftsWirkung` — an **einer** Stelle, weil der Server damit die Werte
bildet und das Fenster dieselbe Auskunft anzeigt.

Die offenen Punkte stehen in keiner Spalte: sie sind Stufe minus dem, was
verteilt ist. Eine eigene Spalte wäre eine zweite Wahrheit über dieselbe Zahl
— und die eine, die man beim Zurücksetzen einer Stufe vergisst. Wer über seine
Stufe hinaus verteilt hat (nach `/level` nach unten), behält alles und hat
schlicht nichts mehr offen.

`/level <stufe>` setzt die eigene Stufe, `/level <figur> <stufe>` die einer
Figur, die gerade im selben Kanal spielt — beides ab `gamemaster`. Die
Erfahrung fällt dabei auf null: „Stufe 30" heisst der Anfang von Stufe 30.

`/tp <karte>` setzt an den **Startpunkt** der Karte ab — dorthin, wo eine neue
Figur erscheint. Der steht in der Kartendatei, ist im Editor zu verschieben und
per Konstruktion begehbar; die eigene Lage wäre das nicht, sie kann auf einer
kleineren Karte im Berg oder ausserhalb liegen. Ein unbekannter Name wird mit
der Liste der vorhandenen Karten beantwortet.

### Startpunkt für Prüfungen

`AURELITH_START_POS="x,z"` (oder `"x,z,blickrichtung"`) setzt, wo eine **neu
angelegte** Figur erscheint, statt am Startpunkt der Karte. Zusammen mit
`AURELITH_START_MAP` steht die Figur damit sofort dort, wo geprüft werden soll.

Der Portaltest hat das von 43 auf 21 Sekunden gebracht — er lief vorher acht
Einheiten zum Tor, und in SwiftShader kommt der Client auf etwa fünf
Simulationsschritte je Sekunde.

Wirkt nur beim **Anlegen** eines Charakters. Wer schon einen hat, behält seine
gespeicherte Stelle — sonst würde die Angabe im Betrieb jeden bei jedem
Anmelden verschieben.

Zwei Dinge, die beim Kürzen solcher Prüfungen wiederkehren:

- **Wartezeiten nach der Uhr, wenn der Server entscheidet.** Ob ein Tor von
  selbst auslöst, hängt am Servertakt — der läuft mit zwanzig Hertz, egal wie
  oft der Client zeichnet. Hundertzwanzig *Simulationsschritte* abzuwarten
  kostete dafür vierundzwanzig Sekunden, fünf Sekunden Uhrzeit reichen.
- **Schritte abwarten, wenn der Client sich bewegen muss.** Umgekehrt ist eine
  Wartezeit nach der Uhr dort wertlos: bei zwei Bildern je Sekunde ergeben
  1,2 Sekunden mal dreißig Schritte und mal zwei.

`npm run test:pages` baut zusätzlich genau das, was der Pages-Workflow baut,
legt es hinter einen Unterpfad und lädt es. Unterpfade gehen still kaputt:
lokal unter `/` fällt nie auf, wenn eine selbst gebaute Asset-Adresse den
Präfix vergisst.

---

## Veröffentlichen auf GitHub Pages

Der Client läuft dort vollständig — auch der wasm-Kern. Pages setzt für `.wasm`
den richtigen MIME-Typ, und weil unser Kern single-threaded ist, brauchen wir
keine COOP/COEP-Header, die Pages nicht setzen kann.

Der **Spielserver läuft dort nicht**: Pages liefert nur Dateien aus. Er muss
anderswo stehen — und weil Pages über HTTPS ausliefert, verbietet der Browser
daraus ein unverschlüsseltes `ws://`. Der Server muss also `wss://` sprechen;
das sind die beiden TLS-Variablen von oben.

Einmalig im Repository einstellen:

1. **Settings → Pages → Source:** `GitHub Actions`
2. **Settings → Secrets and variables → Actions → Variables:**
   `AURELITH_SERVER_URL` = `wss://…`

Ohne Schritt 1 baut der Workflow durch und scheitert erst beim Veröffentlichen
mit `Failed to create deployment (status: 404)`. Das ist kein Fehler im Build,
sondern die fehlende Freischaltung.

Zu beachten: **Pages aus einem privaten Repository setzt mindestens GitHub Pro
voraus.** Im kostenlosen Tarif lässt sich Pages dort nicht aktivieren — dann
bleibt, das Repository öffentlich zu machen oder woanders zu hosten. Der Bau
selbst ist davon unberührt; das Artefakt liegt in jedem Fall unter dem
Workflow-Lauf und lässt sich herunterladen.

Ohne diese Variable wird trotzdem veröffentlicht: die Welt ist sichtbar und
begehbar-still, und der Client schreibt in den Chat, dass keine Serveradresse
hinterlegt ist. Für eine Schaufenster-Seite reicht das.

Achtung bei der Variablen: der Workflow liest `vars.AURELITH_SERVER_URL` und
reicht sie als `VITE_SERVER_URL` in den Bau. Der Name im Repository muss also
`AURELITH_SERVER_URL` lauten, und sie muss als **Repository**-Variable
angelegt sein — eine Variable, die nur an der Umgebung `github-pages` hängt,
sieht der Bau-Job nicht, weil nur der Deploy-Job diese Umgebung benennt. Und
weil Vite den Wert beim Bauen einbackt, greift eine Änderung erst nach einem
neuen Lauf.

### Serveradresse zur Laufzeit setzen

Weil eine eingebackene Adresse für alle Besucher dieselbe ist — und
`localhost` damit für jeden auf *dessen* eigenen Rechner zeigt —, lässt sich
die Adresse im Spiel setzen:

```
/connect ws://localhost:8787/ws    mit einem Server verbinden
/disconnect                        Adresse löschen und trennen
/server                            aktuelle Adresse anzeigen
/help                              Liste der Befehle
```

Die Adresse landet in `localStorage` und geht der Build-Variablen vor. Damit
kommt man von der veröffentlichten Seite aus an einen lokal laufenden Server,
ohne neu zu bauen.

Ein Vorbehalt bleibt: die Seite kommt über HTTPS, und eine HTTPS-Seite darf
keine unverschlüsselte `ws://`-Verbindung öffnen. Für die Loopback-Adresse
machen Chrome und Edge eine Ausnahme, Safari nicht zuverlässig — der Client
prüft das vorher und sagt es, statt stumm zu scheitern. Für alles andere als
localhost braucht der Server `wss://`.

Danach veröffentlicht `.github/workflows/pages.yml` bei jedem Push:

| | |
|---|---|
| Client | `https://<name>.github.io/Aurelith/` |
| Editor | `https://<name>.github.io/Aurelith/editor/` |

Die Laufnummer des Workflows wird zur Build-Kennung und hängt als `?v=` an
jeder Asset-Adresse. Emscripten ist auf `6.0.6` festgenagelt und wird
zwischengespeichert — ein stiller Wechsel der Toolchain wäre die unangenehmste
Art, einen Build kaputtgehen zu lassen.

### Was auf Pages nicht durchgreift

- **Brotli.** Pages ignoriert die im Build erzeugten `.br`-Dateien und
  komprimiert selbst. Der Blueprint verlangt Brotli im Build statt in der
  Serverkonfiguration; auf Pages gilt das nicht. Bei 48 KiB Kern belanglos,
  bei echten Texturen nicht mehr.
- **Cache-Control.** `immutable, max-age=31536000` lässt sich nicht setzen.
  Die `?v=`-Versionierung funktioniert weiter, die Jahreshälfte der Übernahme
  nicht.
- **Bandbreite.** 100 GB/Monat weich, 1 GB Seitengröße. Für Demos reichlich,
  für einen Start nicht.

Für den echten Betrieb gehört dieselbe `dist/` später auf ein CDN mit eigenen
Headern. `VITE_ASSET_BASE` zeigt dann dorthin, und Assets und Seite liegen auf
verschiedenen Hosts — so wie es der Blueprint vorsieht.

---

## Server, Kanäle und der Anmeldeserver

Es gibt zwei Serveranwendungen.

**Der Anmeldeserver** kennt Konten und führt die Liste der Kanäle. Von ihm gibt
es weltweit einen. Er simuliert nichts, tickt nicht und hält keine Welt — fällt
er aus, kommt niemand mehr neu herein, aber wer drin ist, spielt weiter.

**Der Spielserver** ist ein **Kanal**: ein Servername, ein Kanalname, eine
Adresse, alles aus seiner eigenen Konfiguration. Beim Hochfahren meldet er sich
beim Anmeldeserver an und schickt danach alle zehn Sekunden ein Lebenszeichen.
Bleibt es aus, fällt er aus der Liste. Deshalb gibt es **keine** Kanalliste zum
Pflegen: ein Kanal mehr heisst, einen Prozess mit anderen Namen zu starten.

```
Client ──► Anmeldeserver   anmelden, Liste holen, Eintrittskarte bekommen
       ──► Kanal           Karte vorzeigen, Figuren wählen, spielen

Kanal  ──► Anmeldeserver   anmelden · Lebenszeichen · Karte einlösen · anwesend
```

Der Anmeldeserver ruft nie von sich aus an. Er weiss nicht, wo die Kanäle
stehen — nur, was sie über sich gesagt haben.

**Server und Kanal sind nicht dasselbe.** Ein Server ist eine Welt: die Figuren
darauf gehören ihm, und wer auf einem zweiten Server anfängt, fängt bei null
an. Kanäle sind Lastverteilung **innerhalb** eines Servers: dieselben Figuren,
dieselbe Welt, eine andere Maschine. Wer den Kanal wechselt, spielt dieselbe
Figur weiter; wer den Server wechselt, eine andere.

### Zwei Sorten Datenbank

Server sind vor allem **Regionen** — EU, US —, und eine Region taugt nur
etwas, wenn ihre Daten in ihr liegen. Deshalb gibt es zwei Sorten:

```
Masterdatenbank    Konten. Einmal auf der Welt, beim Anmeldeserver.
Weltdatenbank      Figuren, Beutel, Aufträge. Eine je Server, in dessen Region.
```

Der Grund ist Latenz, und er ist rein rechnerisch: eine Figur wird beim
Betreten geladen und alle dreissig Sekunden geschrieben. Läge sie hinter einem
Seekabel, wäre das in jeder Sitzung spürbar. Ein Konto dagegen wird **einmal je
Sitzung** angefasst — dort ist eine Umlaufzeit über den Atlantik ein
Wimpernschlag beim Klick auf „Anmelden" und danach nie wieder.

Verknüpft sind beide über `characters.account_id` — eine gewöhnliche Zahl ohne
Fremdschlüssel, denn PostgreSQL kann nicht über Datenbanken hinweg verweisen.
Dass es das Konto gibt, sagt die Eintrittskarte des Anmeldeservers.

Ein Kanal sieht die Masterdatenbank nie: die Zugriffsstufe reist mit der Karte.
Das ist keine Sparsamkeit, sondern der Sinn der Aufteilung.

Jede Weltdatenbank trägt in `welt_info`, wem sie gehört. Ein Kanal, der auf die
Datenbank eines anderen Servers gerichtet wird, fährt nicht hoch:

```
Error: Diese Weltdatenbank gehört "US", nicht "EU".
```

Sonst bemerkt man den Fehler erst, wenn Spieler fremde Figuren in ihrer Liste
sehen — und sie betreten dürfen.

Migriert wird je Rolle:

```
DATABASE_URL=…master npm run db:migrate        # Konten
DATABASE_URL=…welt   npm run db:migrate:welt   # Figuren
```

Beide Sätze laufen auch beim Hochfahren mit, unter einer Sperre — bei mehreren
gleichzeitig startenden Kanälen migriert genau einer, die anderen warten.

#### Von einer Datenbank auf zwei

Wer schon einen Stapel aus der Zeit davor laufen hat: `db-master` liegt
absichtlich auf dem **alten** Band (`db-data`). Die Konten bleiben damit, wo
sie sind, und man meldet sich nach dem Umstieg wie gewohnt an.

Die Figuren liegen dort ebenfalls noch, werden aber nicht mehr gelesen — die
Weltdatenbank ist neu und leer. Wer sie mitnehmen will, kopiert sie einmalig
hinüber (Compose-Stapel läuft dabei):

```
docker compose exec -T db-master psql -U aurelith -d aurelith -c "\copy ( \
  SELECT id, account_id, name, class, level, exp, gold, hp, mp, \
         map_id, pos_x, pos_z, yaw, created_at, updated_at \
    FROM characters) TO STDOUT" \
| docker compose exec -T db-eu psql -U aurelith -d aurelith -c "\copy characters ( \
  id, account_id, name, class, level, exp, gold, hp, mp, \
  map_id, pos_x, pos_z, yaw, created_at, updated_at) FROM STDIN"
```

Beutel und Aufträge gehen genauso, mit `character_items` und
`character_quests` und deren Spalten. Danach die Zählerstände nachziehen —
sonst vergibt die neue Datenbank Kennungen, die es schon gibt:

```
docker compose exec -T db-eu psql -U aurelith -d aurelith \
  -c "SELECT setval('characters_id_seq', COALESCE((SELECT max(id) FROM characters), 1));"
```

Die Spalte `server` aus der alten Tabelle wird dabei nicht mitgenommen: in
einer Weltdatenbank ist sie gegenstandslos. Wer mehrere Server in der alten
Tabelle hatte, filtert beim Kopieren nach ihr — je Region ein Durchlauf in die
Datenbank dieser Region.

Ohne `AURELITH_LOGIN_URL` läuft ein Spielserver im **Alleinbetrieb**: er prüft
Passwörter selbst und steht in keiner Liste. Das ist der bequeme Fall für
Entwicklung und Prüfungen — ein Prozess statt zwei, `npm run dev:server` und
fertig.

### Betreiben

Pages liefert den Client. Die Server muss man selbst hinstellen — und weil die
Seite über HTTPS kommt, müssen sie `wss://` sprechen. Das ist keine Kür: ohne
gültiges Zertifikat verweigert der Browser die Verbindung, egal wie offen der
Port ist.

Dafür liegt ein Container bereit, gebaut für amd64 und arm64. Der Raspberry Pi
ist damit ein vollwertiges Ziel.

```
cp .env.example .env      # Datenbankpasswort und AURELITH_INTERNAL_SECRET
docker compose pull
docker compose up -d
```

Ein Anmeldeserver, zwei Kanäle, zwei Datenbanken (`db-master` und `db-eu`). Um
TLS kümmert sich ein vorgelagerter Reverse-Proxy, der hier nicht mitgeliefert
wird — wer schon einen betreibt, will keinen zweiten.

Eine zweite Region ist **kein** zweiter Eintrag in dieser Datei, sondern ein
zweiter Stapel auf einer Maschine dort drüben: eigenes `db-us`, eigene Kanäle,
`AURELITH_LOGIN_URL` auf denselben Anmeldeserver. Nur die Masterdatenbank
bleibt, wo sie ist.

Die internen Wege des Anmeldeservers liegen unter `/intern/` und sind mit
`AURELITH_INTERNAL_SECRET` abgesichert. Sie gehören **nicht** ins offene Netz:
wer sie erreicht, kann einen Kanal in die Liste stellen und Spieler auf seinen
Rechner locken. Der Proxy soll sie nicht durchreichen.

### Anmeldung über Google und Facebook

Neben Name und Passwort kann sich ein Spieler über einen fremden Anbieter
ausweisen. Je Anbieter drei Werte am **Anmeldeserver** schalten das frei;
fehlt einer, bietet der Server diese eine Anmeldeart nicht an und ihr Knopf im
Client erscheint gar nicht erst — ein Knopf, der auf eine Fehlerseite führt,
ist schlechter als keiner. Beide zugleich gehen genauso wie nur einer.

| Variable | Was hinein gehört |
| --- | --- |
| `AURELITH_GOOGLE_CLIENT_ID` | OAuth-Client-ID aus der Google Cloud Console (Typ „Webanwendung") |
| `AURELITH_GOOGLE_CLIENT_SECRET` | das zugehörige Geheimnis |
| `AURELITH_GOOGLE_REDIRECT_URI` | `https://<anmeldeserver>/auth/google/callback` — bei Google **wörtlich** so eingetragen |
| `AURELITH_FACEBOOK_CLIENT_ID` | App-ID aus dem Meta-Entwicklerportal (eine reine Zahl) |
| `AURELITH_FACEBOOK_CLIENT_SECRET` | das App-Geheimnis, 32 Zeichen aus `0-9a-f` |
| `AURELITH_FACEBOOK_REDIRECT_URI` | `https://<anmeldeserver>/auth/facebook/callback` — im Produkt „Facebook Login" unter „Gültige OAuth-Redirect-URIs" eingetragen |
| `AURELITH_ANMELDE_ZIELE` | Herkünfte, zu denen zurückgeschickt werden darf, mit Komma getrennt |

Facebook verlangt zusätzlich, dass die **Domain** der Rückadresse in der App
hinterlegt ist — sonst lädt es sie gar nicht erst und sagt „Die Domain dieser
URL ist nicht in den Domains der App vorhanden". Zwei Felder unter
Einstellungen → Allgemein:

- ganz unten **+ Plattform hinzufügen → Website** mit `https://<domain>/` als
  Site-URL.
- **App-Domains**: dieselbe Domain, nur der Name, ohne `https://` und ohne
  Pfad.

In dieser Reihenfolge, und das ist keine Kosmetik: ohne Plattform nimmt das
Formular die App-Domain zwar entgegen und meldet „gespeichert", verwirft sie
aber — nach dem Neuladen der Seite steht das Feld wieder leer.

Ob Facebook die Rückadresse am Ende akzeptiert, muss man nicht raten: unter
**Facebook Login → Einstellungen** steht neben der Liste der gültigen
Redirect-URIs ein Prüffeld, in das sich die volle Adresse einfügen lässt. Es
antwortet mit Ja oder Nein — und bei neueren Apps hängt die Meldung über die
fehlende Domain ohnehin an dieser Liste und nicht an den App-Domains.

Und wenn der Anbieter meckert, lautet die erste Frage immer: was schicken wir
ihm überhaupt? Die Antwort steht im `Location`-Kopf des Startwegs und braucht
keinen Browser:

```bash
curl -sS -o /dev/null -D - \
  "https://<anmeldeserver>/auth/facebook/start?ziel=<freigegebene-herkunft>" \
  | grep -i '^location'
```

Dort stehen `client_id` und `redirect_uri` im Klartext — genau die beiden
Werte, um die es bei jeder Absage geht. Im Browser lassen sie sich nicht mehr
ablesen: die mobile Fassung des Anmeldedialogs packt alle Parameter in ein
`encrypted_query_string`.

Gemeint ist dabei immer die Domain, auf der der **Anmeldeserver** steht, und
nicht die des Clients. Zurückgeschickt wird an `/auth/facebook/callback`, und
nur diese Adresse sieht Facebook — dass der Client auf GitHub Pages liegt, geht
den Anbieter nichts an. Wohin es von dort aus weitergeht, entscheidet allein
`AURELITH_ANMELDE_ZIELE`.

Beides gehört in die **Haupt-App**, auch wenn zum Ausprobieren eine Test-App
danebensteht: die erbt Plattformen und App-Domains und lässt sie nicht
bearbeiten — das Häkchen für die Website ist dort grau. Zum Ausprobieren
braucht es sie ohnehin nicht, denn die Haupt-App im Entwicklungsmodus lässt
genau dieselben Leute herein: Administratoren, Entwickler und Tester. Wer
trotzdem eine nimmt, muss daran denken, dass sie eine **eigene** App-ID und ein
eigenes Geheimnis hat.

Der Ablauf ist bei beiden derselbe und läuft über HTTP, nicht über den
Spiel-WebSocket: der Browser muss zum Anbieter und zurück, und das kann eine
Spielverbindung nicht für ihn tun. Am Ende bekommt der Client eine
**Anmeldekarte** im Ankerteil der Adresse (`#anmeldung=…`) und zeigt sie über
den WebSocket vor — zwei Minuten gültig, einmal einlösbar, wie die
Eintrittskarte für einen Kanal.

Unterschieden wird nur, was sich wirklich unterscheidet: wohin der Browser
geschickt wird, und wie aus dem Code eine Kennung samt Adresse wird. Beides
steht je Anbieter einmal in `ANBIETER` (`packages/server/src/login/oauth.ts`);
Zielprüfung, Zettel, Karte und Konto kennen nur eine Kennung. Ein dritter
Anbieter ist ein Eintrag in dieser Tabelle und drei Umgebungsvariablen.

Bei Facebook kommt eines von aussen dazu: die App muss im Entwicklerportal auf
**Live** stehen, sonst kommt nur hinein, wer dort als Entwickler oder Tester
eingetragen ist. Eine Prüfung durch Meta braucht es dafür nicht — `email` und
`public_profile` sind die beiden Freigaben, die ohne sie gelten.

Google ist OpenID Connect und liefert die Kennung im ID-Token gleich mit;
Facebook ist es nicht, dort folgt auf den Tausch noch eine Frage an die
Graph-API. Deren Fassung steht als Konstante in derselben Datei und muss von
Zeit zu Zeit hochgezogen werden — Facebook nimmt jede Fassung nach etwa zwei
Jahren ausser Betrieb.

Ein Sonderfall gehört zu Facebook: die Freigabe der E-Mail-Adresse lässt sich
im Anmeldedialog abwählen. Der Kontoname **ist** aber die Adresse, also endet
der Weg dann mit `#anmeldung=ohne-adresse`, und der Client sagt, woran es lag.
Ein Konto namens `facebook-10223…` anzulegen wäre der schlechtere Ausweg — es
liesse sich später an keinen Menschen mehr binden.

`AURELITH_ANMELDE_ZIELE` ist dabei die eigentliche Sicherung und keine
Bequemlichkeit. Die Karte ist so lange so gut wie ein Passwort; ginge das Ziel
ungeprüft aus der Anfrage hervor, liesse sich jeder Spieler mit einem Link auf
eine fremde Seite schicken, die die Karte aus der Adresse liest. Dort gehört
die Herkunft des Clients hinein, bei GitHub Pages also
`https://<benutzer>.github.io`.

Die Wege `/anmeldearten`, `/auth/<anbieter>/start` und
`/auth/<anbieter>/callback` gehören dem Browser des Spielers und müssen —
anders als `/intern/` — vom Proxy durchgereicht werden.

Ein Konto aus diesem Weg hat **kein** Passwort. Die Passwortanmeldung lehnt es
ausdrücklich ab und sagt auch, warum; wer über einen Anbieter kam, soll nicht
raten müssen, welches Passwort er nie gesetzt hat.

**Über Anbieter hinweg entscheidet die Adresse.** Wer sich gestern über Google
angemeldet hat und heute über Facebook, findet dasselbe Konto und dieselben
Figuren vor, sofern dieselbe Adresse dabei herauskommt — das Konto sammelt die
Identitäten. Innerhalb eines Anbieters bleibt dessen Kennung der Schlüssel: wer
seine Adresse dort ändert, behält sein Konto, nur der angezeigte Name bleibt
der alte.

Das steht und fällt damit, dass der Anbieter die Adresse geprüft hat. Sagt
Google ausdrücklich `email_verified: false`, endet der Weg dort; Facebook gibt
über `me` nur die bestätigte Adresse des Kontos heraus. Und angehängt wird nur
an Konten **ohne** Passwort — an ein selbstgewähltes Konto käme man sonst über
einen Anbieter heran, bei dem man sich die Adresse aussucht.

`update.sh` prüft vor dem Ziehen, ob dort, wo Docker seine Daten hält, noch
zwei Gigabyte frei sind, und räumt nach jeder Aktualisierung die verwaisten
Bilder weg (`--behalte-bilder` schaltet das ab). Beides aus einem Anlass: eine
volle SD-Karte zeigt sich nicht als „kein Platz", sondern als eine Datenbank,
die eine halbe Sekunde nach dem Start stirbt, und als ein Compose, das dazu
nur „is unhealthy" sagt.

Lokal beide Anwendungen starten:

```
npm run dev:login                                  # Anmeldeserver, Port 8790
AURELITH_LOGIN_URL=http://localhost:8790 \
AURELITH_CHANNEL_NAME='Kanal 1' \
AURELITH_PUBLIC_URL=ws://localhost:8787/ws \
DATABASE_URL=postgres://… npm run dev:server       # ein Kanal
```

Der Server veröffentlicht seinen Port standardmäßig nur auf der
Loopback-Adresse: erreichbar für einen Proxy auf derselben Maschine, aus dem
Internet nicht. Das ist Absicht — ein offener Klartext-Port neben einem
TLS-Endpunkt ist eine Einladung, den Umweg zu nehmen.

Läuft der Proxy selbst in einem Container, greift das nicht; für ihn ist
`127.0.0.1` sein eigener Container. Dann gibt es zwei saubere Wege:

1. Den Proxy an das Netz dieses Stapels hängen (`aurelith_default`). Er
   erreicht den Server dann unter `server:8787`, ganz ohne veröffentlichten
   Port — die dichteste Lösung.
2. `AURELITH_BIND=0.0.0.0:8787` setzen und den Port in der Firewall zulassen.
   Einfacher, aber der Klartext-Port steht dann offen.

### Was der Proxy können muss

Nur eine Sache, aber die entscheidet alles: **WebSocket-Aufwertungen
durchreichen**. Ohne `Upgrade`- und `Connection`-Weitergabe antwortet der
Proxy auf den Verbindungsaufbau mit einem gewöhnlichen 200 oder 400, und im
Spiel sieht das aus wie ein toter Server.

| Proxy | was zu tun ist |
|---|---|
| Nginx Proxy Manager | Schalter **Websockets Support** im Host |
| Traefik | nichts — reicht Upgrades von sich aus durch |
| Caddy | nichts — `reverse_proxy` kann es von sich aus |
| nginx von Hand | `proxy_set_header Upgrade $http_upgrade;` und `proxy_set_header Connection "upgrade";` |
| SWAG | nichts — die mitgelieferte `proxy.conf` reicht Aufwertungen durch |

### Mit SWAG

SWAG ist nginx im Container, also greift die Loopback-Adresse nicht — für ihn
ist `127.0.0.1` sein eigener Container. Beide müssen an dasselbe Docker-Netz.
Dafür liegen zwei Dateien bei:

```
# Netznamen von SWAG herausfinden
docker inspect swag --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}'

# Spielserver zusätzlich an dieses Netz hängen
SWAG_NETWORK=<netz> docker compose -f docker-compose.yml -f docker-compose.swag.yml up -d

# Proxy-Konfiguration ablegen und SWAG neu starten
cp docker/swag/aurelith.subdomain.conf <swag-config>/nginx/proxy-confs/
docker restart swag
```

Die Endung muss `.conf` sein — `.sample` lädt SWAG nicht.

**Drei** Unterdomains, nicht eine. Der Client verbindet sich nacheinander mit
zwei Servern, und jeder Kanal ist eine eigene Anwendung:

| Unterdomain | Ziel | wofür |
|---|---|---|
| `aurelith` | `aurelith-login:8790` | Anmeldung, Server- und Kanalliste |
| `aurelith-01` | `aurelith-kanal1:8787` | Kanal 1 |
| `aurelith-02` | `aurelith-kanal2:8788` | Kanal 2 |

Für **jede** muss ein CNAME im DNS stehen und jede muss in SWAGs
`SUBDOMAINS=` aufgeführt sein — sonst deckt das Zertifikat sie nicht ab, und
der Browser bricht wortlos ab. Die Namen müssen zu dem passen, was in
`AURELITH_KANAL1_URL` und `AURELITH_KANAL2_URL` steht: das ist die Adresse,
die der Anmeldeserver dem Client nennt.

Ein nach außen veröffentlichter Port wird danach gar nicht mehr gebraucht.

Wenn `https://aurelith-01.<domain>/health` antwortet, die Spielverbindung
aber nicht zustande kommt, fehlen dem Ort für diese Unterdomain die Zeilen
`proxy_set_header Upgrade` und `Connection` — in der mitgelieferten Datei
stehen sie ausdrücklich drin.

### Aktualisieren

```
./update.sh                 Quellstand holen, neues Bild ziehen, neu starten
./update.sh --aufraeumen    danach alte Bilder löschen
./update.sh --ohne-git      nur die Container, Repository unverändert
```

Das Skript prüft vorher, was schiefgehen kann — fehlende `.env`, fehlendes
Passwort, stehender Docker-Dienst, nicht vorhandenes Proxy-Netz — und bricht
mit einem Satz ab, statt mitten im Neustart auszusteigen.

Gezogen wird **vor** dem Herunterfahren. `docker compose pull` fasst laufende
Container nicht an; zöge man erst danach und das Ziehen schlüge fehl, bliebe
der Server unten. So läuft er im Fehlerfall unverändert weiter.

Der Netzname des Proxys ist auf `swag_default` voreingestellt und lässt sich
über `SWAG_NETWORK` überschreiben.

### Von selbst ausrollen

Sobald ein neues Bild in der Registry liegt, kann der Workflow den Pi per SSH
anstoßen — er ruft dort dasselbe `update.sh` auf. Dazu unter
Settings → Secrets and variables → Actions:

| Secret | wofür |
|---|---|
| `PI_HOST` | Adresse des Raspberry Pi |
| `PI_USER` | Benutzer dort |
| `PI_SSH_KEY` | privater Schlüssel, der ganze Block |
| `PI_SSH_PASSPHRASE` | nur falls der Schlüssel eine hat |
| `PI_PASSWORD` | statt des Schlüssels, falls per Passwort angemeldet wird |
| `PI_PATH` | Pfad zum Repository, sonst `/home/johmarjac/aurelith` |
| `TELEGRAM_BOT_TOKEN` | optional, für die Benachrichtigung |
| `TELEGRAM_CHAT_ID` | optional, dieselbe |

Schlüssel **oder** Passwort, je nachdem was hinterlegt ist — leere Felder
ignoriert die Aktion. Der Schlüssel ist die haltbarere Wahl: nicht weil ein
Passwort schlechter gespeichert wäre, beides liegt gleich geschützt als
Secret, sondern weil ein Passwort alles aufschließt, was dieser Benutzer darf,
sudo eingeschlossen. Ein Schlüssel lässt sich in `authorized_keys` auf genau
einen Befehl festnageln:

```
command="cd /home/johmarjac/aurelith && ./update.sh",no-port-forwarding,no-pty ssh-ed25519 AAAA...
```

Ein solcher Schlüssel *zusätzlich* ändert nichts daran, wie man sich selbst
anmeldet — Passwort und Schlüssel gelten nebeneinander.

Bei Passwort muss `PasswordAuthentication yes` in der `sshd_config` stehen. Auf
vielen Systemen ist sie ab Werk aus, und dann scheitert der Schritt mit
*permission denied*, obwohl das Passwort stimmt.

Fehlt `PI_HOST`, wird der Schritt übersprungen und der Workflow bleibt grün —
so lässt sich das Repository auch ohne Pi bauen.

Ausgerollt wird nur vom Vorgabe-Branch und von Versionsschildern. Ein Zweig,
an dem gerade gearbeitet wird, hat auf dem laufenden Server nichts zu suchen.

Und einmalig auf dem Pi, weil das Paket privat ist:

```
echo <token> | docker login ghcr.io -u <name> --password-stdin
```

Ohne das scheitert `docker compose pull` mit *unauthorized* — bei jedem Lauf,
nicht nur beim ersten.

Zwei Kleinigkeiten noch: die Zeitüberschreitung des Proxys großzügig setzen
(eine Spielverbindung steht stundenlang; nginx' Standard von 60 Sekunden
trennt sie mitten im Spiel), und `/health` gibt einen JSON-Puls zurück, falls
der Proxy eine Bereitschaftsprüfung will.

Danach steht der Server unter `wss://<subdomain>/ws`. Im Spiel:

```
/connect wss://spiel.example.org/ws
```

Dauerhaft trägt man dieselbe Adresse als Repository-Variable
`AURELITH_SERVER_URL` ein; dann ist sie in jedem Pages-Build voreingestellt.

### Was im Bild steckt

Das Dockerfile hat drei Stufen. Die erste übersetzt den C++-Kern mit
Emscripten nach WebAssembly und lässt dabei die nativen Prüfungen laufen —
fällt eine, gibt es kein Bild. Die zweite löst die Abhängigkeiten auf, und
zwar nur den Zweig des Servers: das sind 1,2 MB statt 27, weil three.js im
Serverbild nichts verloren hat. Die dritte enthält weder Compiler noch
Toolchain, sondern Node, den übersetzten Kern, die Quellen und die Karten —
zusammen etwa 2 MB über `node:22-alpine`.

Der Server wird bewusst **nicht** vorübersetzt. Er läuft im Betrieb aus
denselben `.ts`-Dateien wie in der Entwicklung, ausgeführt von `tsx`. Damit
kann kein übersetztes Abbild hinter den Quellen zurückbleiben.

Das Startskript bringt das Datenbankschema auf Stand, bevor der Server
hochfährt, und wartet dabei auf PostgreSQL. Ohne `DATABASE_URL` läuft der
Server mit seinem Speicher-Backend weiter — praktisch zum Ausprobieren, aber
alles ist beim Neustart weg. Er sagt das beim Hochfahren deutlich.

`docker compose down` fährt sauber herunter: der Node-Prozess ist PID 1,
bekommt SIGTERM direkt und räumt seine Sitzungen ab, statt nach zehn Sekunden
abgeschossen zu werden.

### Veröffentlichung des Bildes

`.github/workflows/server-image.yml` baut bei jedem Push auf den Serverpfaden
und schiebt nach:

```
ghcr.io/johmarjac/aurelith-server:latest
```

Beide Architekturen liegen unter demselben Schild; `docker pull` sucht sich
die passende Variante selbst heraus. Der teure Teil — die Übersetzung nach
WebAssembly — läuft dabei nur **einmal**: die Stufe hängt an `$BUILDPLATFORM`
und damit am amd64-Läufer. Unter QEMU-Emulation ein zweites Mal zu übersetzen,
ergäbe dieselbe `.wasm` nach vielfacher Wartezeit — wasm ist
architekturunabhängig, das ist der ganze Punkt.

Ist das Paket privat, braucht der Pi einmalig eine Anmeldung:

```
echo <token> | docker login ghcr.io -u <name> --password-stdin
```

Wer lieber auf dem Pi selbst baut, kann das — `docker compose build server` —
sollte aber wissen, dass der Emscripten-Bau dort Minuten dauert und das
SDK-Bild allein über ein Gigabyte belegt.

### Selbst gehostet oder anderswo

Der Server braucht keine nativen Erweiterungen: `pg` und `ws` sind reines
JavaScript, gebaut wird nichts. Damit läuft er überall, wo Node 22 und ein
langlebiger Prozess erlaubt sind. Was **nicht** geht, sind Umgebungen ohne
dauerhafte Verbindungen — serverlose Funktionen und statische Hoster können
keinen WebSocket halten.

---

## Nächste Schritte

- **Speicherbudget messen.** Der wasm-Heap steht auf festen 64 MiB, wächst
  nicht — die Disziplin ist von Flyff übernommen, die Zahl ist noch geraten. Der
  Blueprint verlangt eine gemessene Obergrenze auf dem schwächsten Zielgerät.
- **glTF statt prozeduraler Modelle.** Die ModelRegistry ist die vorgesehene
  Tauschstelle: Schlüssel bleiben, Herkunft ändert sich. Skelette und
  Animationsspuren ersetzen dann die von Hand geschriebenen Posen in `rigs.ts`.
- **Texturformat-Matrix.** S3TC, ETC, ASTC, BPTC — die Entscheidung fällt beim
  ersten gelieferten Asset, nicht später.
- **Editor ausbauen.** Heute setzt und löscht er Props. Als Nächstes: Terrain
  malen, Spawner und Portale bearbeiten, Rückgängig.
- **Fertigkeiten, Quests, Handel, Gruppen.** Das Kampfsystem trägt bislang genau
  einen Schlag.
