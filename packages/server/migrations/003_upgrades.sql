-- Aufwertungsstufe je Gegenstand, 0 bis 10.
--
-- Am Inventarplatz und nicht an der Gegenstandskennung: zwei Eisenklingen im
-- Beutel sind seit der Aufwertung nicht mehr dasselbe Stueck.

ALTER TABLE character_items
  ADD COLUMN IF NOT EXISTS upgrade SMALLINT NOT NULL DEFAULT 0;
