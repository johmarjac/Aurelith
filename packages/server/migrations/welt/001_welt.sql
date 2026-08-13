-- Eine Weltdatenbank. Figuren, Beutel, Aufträge.
--
-- Davon gibt es **eine je Server** — also je Region: EU eine, US eine. Sie
-- steht dort, wo die Kanäle stehen, die sie benutzen, und genau deshalb gibt
-- es sie: eine Figur wird beim Betreten geladen und alle dreissig Sekunden
-- geschrieben, und beides über ein Seekabel wäre in jeder Sitzung spürbar.
--
-- Die Kanäle eines Servers teilen sich diese Datenbank. Das ist der
-- Unterschied zwischen Kanal und Server: derselbe Kanalnachbar spielt in
-- derselben Datenbank, der Nachbar auf einem anderen Server in einer anderen.
--
-- **Kein Fremdschlüssel auf `accounts`.** Die Konten stehen in der
-- Masterdatenbank, und PostgreSQL kann nicht über Datenbanken hinweg
-- verweisen. `account_id` ist deshalb eine gewöhnliche Zahl — die Zusage, dass
-- es das Konto gibt, kommt von der Eintrittskarte des Anmeldeservers und
-- nicht vom Schema.

/*
 * Wem diese Datenbank gehört.
 *
 * Genau eine Zeile, geschrieben beim ersten Hochfahren eines Kanals. Passt
 * der Name nicht zu dem, was ein Kanal über sich sagt, fährt er nicht hoch.
 *
 * Das ist die Antwort auf einen Fehler, den man sonst erst Wochen später
 * bemerkt: zwei Server, versehentlich auf dieselbe Datenbank gerichtet. Ohne
 * diese Prüfung sähen die Spieler von „Nordmark" plötzlich die Figuren von
 * „Aurelith" — und dürften sie betreten.
 *
 * Der einspaltige Primärschlüssel mit fester Prüfung ist der übliche Weg zu
 * „höchstens eine Zeile": zwei Welten in einer Weltdatenbank gibt es nicht.
 */
CREATE TABLE IF NOT EXISTS welt_info (
  einzig  BOOLEAN     PRIMARY KEY DEFAULT TRUE CHECK (einzig),
  server  TEXT        NOT NULL,
  seit    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS characters (
  id         BIGSERIAL   PRIMARY KEY,
  -- Zeigt in die Masterdatenbank. Siehe oben: kein Fremdschlüssel möglich.
  account_id BIGINT      NOT NULL,
  name       TEXT        NOT NULL,
  -- Kennung des Berufs aus `assets/content/classes.json`. Leer heisst: noch
  -- keiner — den lehrt der Kampfmeister ab Stufe 15.
  class      TEXT        NOT NULL DEFAULT '',
  level      INTEGER     NOT NULL DEFAULT 1,
  exp        BIGINT      NOT NULL DEFAULT 0,
  gold       BIGINT      NOT NULL DEFAULT 0,
  hp         INTEGER     NOT NULL DEFAULT 0,
  mp         INTEGER     NOT NULL DEFAULT 0,
  map_id     TEXT        NOT NULL,
  pos_x      REAL        NOT NULL DEFAULT 0,
  pos_z      REAL        NOT NULL DEFAULT 0,
  yaw        REAL        NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Der Name ist innerhalb dieser Welt einzig — und weil die Datenbank die Welt
-- **ist**, braucht es dafür keine Spalte „Server". Auf einer anderen Region
-- darf derselbe Name noch einmal stehen; das ist kein Zufall, sondern der
-- Grund, warum getrennte Welten getrennte Datenbanken haben.
--
-- Kleingeschrieben verglichen: „Ilva" und „ilva" sind im Gespräch dieselbe
-- Figur, und zwei davon nebeneinander wären eine Falle.
CREATE UNIQUE INDEX IF NOT EXISTS characters_name_idx ON characters (lower(name));
CREATE INDEX IF NOT EXISTS characters_account_idx ON characters (account_id);

CREATE TABLE IF NOT EXISTS character_items (
  id           BIGSERIAL PRIMARY KEY,
  character_id BIGINT    NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  item_id      TEXT      NOT NULL,
  count        INTEGER   NOT NULL DEFAULT 1,
  -- Inventarplatz. -1 heisst: noch kein fester Platz vergeben.
  slot         INTEGER   NOT NULL DEFAULT -1,
  equipped     BOOLEAN   NOT NULL DEFAULT FALSE,
  upgrade      SMALLINT  NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS character_items_char_idx ON character_items (character_id);

CREATE TABLE IF NOT EXISTS character_quests (
  id           BIGSERIAL PRIMARY KEY,
  character_id BIGINT    NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  quest_id     TEXT      NOT NULL,
  -- Siehe `QuestStatus` in shared: angeboten, angenommen, erledigt.
  status       SMALLINT  NOT NULL DEFAULT 0,
  -- Ein Zähler je Ziel, in der Reihenfolge der Ziele im Auftrag.
  progress     INTEGER[] NOT NULL DEFAULT '{}',
  UNIQUE (character_id, quest_id)
);

CREATE INDEX IF NOT EXISTS character_quests_char_idx ON character_quests (character_id);
