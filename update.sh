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
# Ohne -v: die Datenbank liegt in einem Volume und soll das ueberleben.
compose down
compose up -d

# --- Ergebnis ---------------------------------------------------------------

schritt 'Zustand'
compose ps

# Der Server braucht ein paar Sekunden: er wartet auf die Datenbank und
# bringt das Schema auf Stand, bevor er zu horchen anfaengt.
printf '\nWarte auf den Server '
for _ in $(seq 1 30); do
  if compose exec -T server wget -qO- http://127.0.0.1:8787/health >/dev/null 2>&1; then
    printf '\n\033[32m✓ Server antwortet.\033[0m\n'
    compose exec -T server wget -qO- http://127.0.0.1:8787/health
    printf '\n'
    break
  fi
  printf '.'
  sleep 2
done

if [ "$aufraeumen" -eq 1 ]; then
  schritt 'Alte Bilder loeschen'
  # Nur verwaiste Bilder ohne Container. Die SD-Karte eines Raspberry Pi ist
  # nach ein paar Aktualisierungen sonst voll.
  docker image prune -f
fi
