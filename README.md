# Aurelith

Browserbasiertes 3D-MMORPG. Klassisches Setting, Flächenkampf im Stil von
Metin2, Kartenaufbau mit Gates und Dungeons im Stil von Flyff — mit eigener
Grafik und eigenem Stack.

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
- **UI im Flyff-Zuschnitt**: Werteleisten, Zielfenster, Chat, Inventar,
  Charakterblatt, ziehbare Fenster, Namensschilder, Schadenszahlen.
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
  server    Autorität. Node, ws, PostgreSQL. Treibt je Karte eine Welt im Kern.
  client    Dünne Schale, Renderer, Eingabe, UI.
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
npm run test:particles   # die Funkenwolke — ohne Browser
npm run test:e2e         # Spiel im Browser, Desktop und Berührung
npm run test:prediction  # springt die eigene Figur beim Laufen zurück?
npm run test:portal      # Tore: hineinlaufen, stehen, F drücken, zurück
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

### Startpunkt für Prüfungen

`AURELITH_START_POS="x,z"` (oder `"x,z,blickrichtung"`) setzt, wo ein **neu
angelegter** Charakter erscheint, statt am Startpunkt der Karte. Zusammen mit
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

## Server betreiben

Pages liefert den Client. Den Server muss man selbst hinstellen — und weil die
Seite über HTTPS kommt, muss er `wss://` sprechen. Das ist keine Kür: ohne
gültiges Zertifikat verweigert der Browser die Verbindung, egal wie offen der
Port ist.

Dafür liegt ein Container bereit, gebaut für amd64 und arm64. Der Raspberry Pi
ist damit ein vollwertiges Ziel.

```
cp .env.example .env      # Domain und Datenbankpasswort eintragen
docker compose pull
docker compose up -d
```

Drei Dienste: der Spielserver, PostgreSQL für die Spielstände, und Caddy als
TLS-Endpunkt davor. Caddy holt und erneuert das Zertifikat selbst, sobald die
Domain auf die Maschine zeigt und die Ports **80 und 443** von außen
erreichbar sind — Port 80 wird für die Prüfung von Let's Encrypt gebraucht,
nicht nur für die Umleitung.

Danach steht der Server unter `wss://<domain>/ws`. Im Spiel:

```
/connect wss://spiel.example.org/ws
```

Dauerhaft trägt man dieselbe Adresse als Repository-Variable
`AURELITH_SERVER_URL` ein; dann ist sie in jedem Pages-Build voreingestellt.

Der Spielserver selbst hat **keine** Portfreigabe nach außen. Er ist nur über
Caddy erreichbar, und das ist Absicht — ein offener Klartext-Port neben einem
TLS-Endpunkt ist eine Einladung, den Umweg zu nehmen.

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
