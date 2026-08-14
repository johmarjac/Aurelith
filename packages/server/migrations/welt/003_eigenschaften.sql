-- Die vier Grundeigenschaften einer Figur.
--
-- Vier Spalten und **keine fünfte für die offenen Punkte**. Die ergeben sich
-- aus der Stufe minus dem, was schon verteilt ist; eine eigene Spalte wäre
-- eine zweite Wahrheit über dieselbe Zahl — und die eine, die man beim
-- Zurücksetzen einer Stufe vergisst.
--
-- Der Vorgabewert steht hier als Zahl und in `tuning.json` als
-- `startEigenschaft`. Das ist bewusst doppelt und trotzdem kein Widerspruch:
-- SQL kann nicht in die Inhaltsdatei sehen, und dieser Wert gilt nur für
-- Zeilen, die es schon gibt. Was **neu** angelegt wird, bekommt seine
-- Startwerte aus der Inhaltsdatei — die Spaltenvorgabe kommt dabei nie zum
-- Zug.
--
-- Bestehende Figuren bekommen damit die Startwerte und behalten alle Punkte
-- ihrer bisherigen Stufen als offene. Das ist die freundliche Auslegung: sie
-- haben nichts verteilt, also ist auch nichts ausgegeben.
ALTER TABLE characters
  ADD COLUMN IF NOT EXISTS staerke  INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS ausdauer INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS geschick INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS weisheit INTEGER NOT NULL DEFAULT 15;
