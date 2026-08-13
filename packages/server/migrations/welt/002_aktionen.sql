-- Die Aktionsleiste einer Figur.
--
-- Zehn Plätze, belegt vom Spieler. Sie gehören zur Figur und nicht zum Konto:
-- ein Krieger legt andere Sachen auf die Leiste als ein Magier, und beide
-- gehören demselben Menschen.
--
-- Eine Zeile je belegtem Platz und keine für die leeren. Der Unterschied
-- zwischen „Platz 4 ist leer" und „von Platz 4 steht nichts in der Datenbank"
-- wäre keiner, den man sinnvoll auseinanderhalten könnte — beides heisst, dass
-- dort nichts liegt.
--
-- `ref` ist die Kennung des Gegenstands oder der Fertigkeit, kein Verweis auf
-- eine Zeile in `character_items`. Ein Beutelplatz ändert sich beim
-- Umsortieren, beim Verkaufen, beim Aufheben; die Kennung bleibt. Ein
-- Fremdschlüssel wäre hier also nicht Strenge, sondern die falsche Frage.
CREATE TABLE IF NOT EXISTS character_actions (
  character_id BIGINT   NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  -- 0 bis 9 — siehe AKTIONS_PLAETZE im geteilten Paket.
  idx          SMALLINT NOT NULL,
  -- Siehe `AktionsArt`: 1 Gegenstand, 2 Fertigkeit. 0 (leer) steht nie hier.
  art          SMALLINT NOT NULL,
  ref          TEXT     NOT NULL,
  PRIMARY KEY (character_id, idx)
);
