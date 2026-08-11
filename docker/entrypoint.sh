#!/bin/sh
# Startskript des Containers.
#
# Eine einzige Aufgabe: wenn eine Datenbank konfiguriert ist, wartet der
# Container auf sie und bringt das Schema auf Stand, bevor der Server
# hochfährt. Ohne DATABASE_URL läuft der Server mit seinem Speicher-Backend
# weiter — praktisch zum Ausprobieren, aber alles ist beim Neustart weg.
#
# Danach `exec`, damit der Node-Prozess PID 1 wird und SIGTERM direkt
# bekommt. Sonst würde der Server bei `docker stop` nicht sauber
# herunterfahren, sondern nach zehn Sekunden abgeschossen.

set -e

if [ -n "$DATABASE_URL" ]; then
  # Postgres im selben Compose-Stapel braucht ein paar Sekunden, bis es
  # Verbindungen annimmt. Der Healthcheck deckt das ab, aber nicht jeder
  # startet den Server über Compose.
  attempt=1
  until tsx packages/server/src/db/migrate.ts; do
    if [ "$attempt" -ge 10 ]; then
      echo "[entrypoint] Datenbank nach $attempt Versuchen nicht erreichbar — Abbruch." >&2
      exit 1
    fi
    echo "[entrypoint] Datenbank noch nicht bereit (Versuch $attempt), warte 3s ..."
    attempt=$((attempt + 1))
    sleep 3
  done
else
  echo "[entrypoint] Ohne DATABASE_URL — Speicher-Backend, Spielstände sind fluechtig."
fi

exec "$@"
