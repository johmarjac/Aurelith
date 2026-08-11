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
npm run core:test    # 27 native Prüfungen des Kerns
npm test             # Kern + End-to-End im Browser + Editor + Pages-Bau
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
