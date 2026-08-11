-- Grundschema. Konten, Charaktere, Inventar.
--
-- Bewusst schmal gehalten: alles, was die Simulation zur Laufzeit braucht,
-- steht im Speicher. Die Datenbank hält nur das, was einen Neustart überleben
-- muss.

CREATE TABLE IF NOT EXISTS accounts (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT        NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS characters (
  id         BIGSERIAL PRIMARY KEY,
  account_id BIGINT      NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name       TEXT        NOT NULL UNIQUE,
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

CREATE INDEX IF NOT EXISTS characters_account_idx ON characters (account_id);

CREATE TABLE IF NOT EXISTS character_items (
  id           BIGSERIAL PRIMARY KEY,
  character_id BIGINT  NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  item_id      TEXT    NOT NULL,
  count        INTEGER NOT NULL DEFAULT 1,
  -- Inventarplatz. -1 heißt: noch kein fester Platz vergeben.
  slot         INTEGER NOT NULL DEFAULT -1,
  equipped     BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS character_items_char_idx ON character_items (character_id);
