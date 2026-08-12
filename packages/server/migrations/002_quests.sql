-- Auftragsstand je Charakter.
--
-- Ein Auftrag ist eine Zeile, der Fortschritt ein Feld je Ziel. Die Reihenfolge
-- der Ziele ist die der Definition in `content/quests.ts` — was dort umsortiert
-- wird, sortiert hier den Fortschritt um. Deshalb steht in der Tabelle keine
-- Zielkennung: sie waere eine zweite Wahrheit ueber dieselbe Reihenfolge.

CREATE TABLE IF NOT EXISTS character_quests (
  character_id BIGINT      NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  quest_id     TEXT        NOT NULL,
  -- QuestStatus aus dem geteilten Paket: 1 aktiv, 2 erfuellt, 3 abgeschlossen.
  status       SMALLINT    NOT NULL DEFAULT 1,
  progress     INTEGER[]   NOT NULL DEFAULT '{}',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (character_id, quest_id)
);

CREATE INDEX IF NOT EXISTS character_quests_char_idx ON character_quests (character_id);
