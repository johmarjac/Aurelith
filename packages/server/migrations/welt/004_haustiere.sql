-- Freigelassene Begleiter überstehen das Abmelden.
--
-- Ein Haustier ist ein Gegenstand im Beutel und bleibt dort, auch während es
-- draussen läuft — anders als ein Brustpanzer, der beim Anlegen an die Figur
-- wandert. Deshalb reicht `equipped` hier nicht: das hiesse „getragen", und
-- der Client räumt getragene Stücke aus dem Beutel in die Ausrüstungsplätze.
--
-- Eine eigene Spalte sagt genau das, was gemeint ist: dieses Stück läuft
-- gerade draussen herum. Ohne sie stünde nach jedem Abmelden ein Tier im
-- Beutel, das der Spieler zuletzt neben sich laufen sah, und niemand könnte
-- ihm sagen, warum es weg ist.
ALTER TABLE character_items
  ADD COLUMN IF NOT EXISTS unterwegs BOOLEAN NOT NULL DEFAULT FALSE;
