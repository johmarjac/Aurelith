#!/usr/bin/env bash
#
# Aurelith aktualisieren.
#
# Holt den Stand aus dem Repository, faehrt den Stapel herunter, zieht das
# neue Serverbild und startet wieder — samt Anbindung an das Netz des
# Reverse-Proxys, damit SWAG den Server nach dem Neustart wieder findet.
#
#   ./update.sh                 aktualisieren
#   ./update.sh --aufraeumen    danach alte Bilder loeschen
#   ./update.sh --ohne-git      nur Container, Repository unveraendert
#
# Der Netzname des Proxys laesst sich ueberschreiben:
#
#   SWAG_NETWORK=mein_netz ./update.sh

set -euo pipefail

# Immer im Repository arbeiten, egal von wo aufgerufen.
cd "$(dirname "$(readlink -f "$0")")"

SWAG_NETWORK="${SWAG_NETWORK:-swag_default}"
export SWAG_NETWORK

compose() {
  docker compose -f docker-compose.yml -f docker-compose.swag.yml "$@"
}

schritt() {
  printf '\n\033[36m→ %s\033[0m\n' "$1"
}

fehler() {
  printf '\n\033[31m✗ %s\033[0m\n' "$1" >&2
  exit 1
}

aufraeumen=0
mit_git=1
for arg in "$@"; do
  case "$arg" in
    --aufraeumen) aufraeumen=1 ;;
    --ohne-git) mit_git=0 ;;
    -h | --help)
      # Der Kopfkommentar *ist* die Hilfe. Ein fester Zeilenbereich waere
      # beim naechsten Absatz still falsch — also bis zur ersten Zeile
      # lesen, die kein Kommentar mehr ist.
      awk 'NR>1 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "$0"
      exit 0
      ;;
    *) fehler "Unbekannte Option: $arg" ;;
  esac
done

# --- Voraussetzungen --------------------------------------------------------
#
# Lieber hier mit einem klaren Satz abbrechen als spaeter mitten im Neustart
# mit einer Meldung aus dem Innenleben von Compose. Der Stapel ist dann
# naemlich schon unten.

command -v docker >/dev/null || fehler 'docker ist nicht installiert.'
docker compose version >/dev/null 2>&1 || fehler 'docker compose steht nicht bereit.'
docker info >/dev/null 2>&1 ||
  fehler 'Der Docker-Dienst laeuft nicht. Starten mit: sudo systemctl start docker'

[ -f .env ] || fehler 'Es fehlt die .env. Anlegen mit: cp .env.example .env'

grep -qE '^POSTGRES_PASSWORD=.+' .env ||
  fehler 'In der .env fehlt POSTGRES_PASSWORD (oder es ist leer).'

# Seit es den Anmeldeserver gibt, weisen sich die Kanäle bei ihm mit einem
# gemeinsamen Geheimnis aus. Fehlt es, bricht Compose mit einer Meldung ab,
# die nicht sagt, was zu tun ist — deshalb hier, mit Satz.
grep -qE '^AURELITH_INTERNAL_SECRET=.+' .env ||
  fehler 'In der .env fehlt AURELITH_INTERNAL_SECRET (oder es ist leer).
Frei waehlbar, lang, und nicht dasselbe wie das Datenbankpasswort:
  echo "AURELITH_INTERNAL_SECRET=$(head -c 24 /dev/urandom | base64)" >> .env'

docker network inspect "$SWAG_NETWORK" >/dev/null 2>&1 ||
  fehler "Das Netz \"$SWAG_NETWORK\" gibt es nicht. Vorhandene Netze: $(docker network ls --format '{{.Name}}' | tr '\n' ' ')"

# --- Quellstand holen -------------------------------------------------------

if [ "$mit_git" -eq 1 ]; then
  schritt 'Quellstand holen'
  # --ff-only statt eines stillen Merges: gibt es hier lokale Aenderungen,
  # soll das auffallen und nicht in einem Merge-Commit verschwinden, den
  # niemand gemacht hat.
  git pull --ff-only
fi

# --- Neustart ---------------------------------------------------------------

# Erst ziehen, dann herunterfahren — nicht andersherum.
#
# `docker compose pull` fasst laufende Container nicht an. Zieht man dagegen
# nach dem Herunterfahren und das Ziehen schlaegt fehl (privates Paket ohne
# Anmeldung, Registry gerade nicht erreichbar), bleibt der Server unten. So
# laeuft er im Fehlerfall einfach weiter.
schritt 'Neues Serverbild ziehen'
if ! compose pull; then
  fehler "Das Bild liess sich nicht ziehen — der Stapel laeuft unveraendert weiter.
Bei einem privaten Paket fehlt meist die Anmeldung:
  echo <token> | docker login ghcr.io -u <name> --password-stdin"
fi

schritt 'Stapel neu starten'
#
# `--remove-orphans`: Container von Diensten wegraeumen, die es in der
# Compose-Datei nicht mehr gibt.
#
# Ohne das bleiben sie einfach stehen — `down` fasst nur an, was in der Datei
# steht. Genau daran scheiterte der erste Start nach der Aufteilung: der alte
# Container `aurelith-db-1` lief weiter und hielt das Datenverzeichnis
# gesperrt, und die neue `db-master` auf demselben Band starb im selben
# Augenblick mit einer Meldung, die niemand sah. Sichtbar war nur „is
# unhealthy".
#
# Ohne -v: die Datenbanken liegen in Volumes und sollen das ueberleben.
# `--remove-orphans` raeumt Container weg, keine Volumes.
compose down --remove-orphans

# Kommt der Stapel nicht hoch, sind die Protokolle das Einzige, was die
# Ursache nennt.
#
# Compose selbst sagt nur „dependency failed to start: container … is
# unhealthy" — und das steht sowohl da, wenn ein Dienst seine Gesundheits-
# pruefung nicht besteht, als auch dann, wenn er sofort stirbt. Zwei sehr
# verschiedene Faelle unter einem Satz. Wer den Unterschied sehen will,
# braucht die Zeilen aus dem Dienst selbst, und die sind nach dem naechsten
# `up` weg.
if ! compose up -d; then
  schritt 'Protokolle der Dienste (letzte Zeilen)'
  compose logs --tail=40 --no-color || true
  fehler 'Der Stapel kam nicht hoch. Die Ursache steht in den Zeilen darueber.'
fi

# --- Ergebnis ---------------------------------------------------------------

schritt 'Zustand'
compose ps

# Die Dienste brauchen ein paar Sekunden: sie warten auf ihre Datenbank und
# bringen das Schema auf Stand, bevor sie zu horchen anfangen.
#
# Gefragt wird bei **jedem** — ein Stapel, in dem der Anmeldeserver läuft und
# ein Kanal nicht, sieht von aussen gesund aus, und niemand kommt hinein.
warte_auf() {
  dienst="$1"
  port="$2"
  printf '\nWarte auf %s ' "$dienst"
  for _ in $(seq 1 30); do
    if compose exec -T "$dienst" wget -qO- "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      printf '\n\033[32m✓ %s antwortet:\033[0m ' "$dienst"
      compose exec -T "$dienst" wget -qO- "http://127.0.0.1:$port/health"
      printf '\n'
      return 0
    fi
    printf '.'
    sleep 2
  done
  printf '\n\033[31m✗ %s antwortet nicht.\033[0m Protokoll: docker compose logs %s\n' \
    "$dienst" "$dienst"
  return 1
}

fehlt=0
warte_auf login 8790 || fehlt=1
warte_auf kanal1 8787 || fehlt=1
warte_auf kanal2 8788 || fehlt=1
[ "$fehlt" -eq 0 ] || fehler 'Nicht alle Dienste sind hochgekommen.'

if [ "$aufraeumen" -eq 1 ]; then
  schritt 'Alte Bilder loeschen'
  # Nur verwaiste Bilder ohne Container. Die SD-Karte eines Raspberry Pi ist
  # nach ein paar Aktualisierungen sonst voll.
  docker image prune -f
fi
