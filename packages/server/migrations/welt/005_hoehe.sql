-- Die Höhe einer Figur.
--
-- Gespeichert wurden `pos_x`, `pos_z` und `yaw` — die Höhe nicht, denn sie
-- ergab sich ja aus dem Gelände. Seit es schwebende Felsen und Fluggeräte
-- gibt, tut sie das nicht mehr: wer auf einem Felsen ausloggte, stand beim
-- nächsten Anmelden sechsundzwanzig Meter tiefer im Gras, und wer auf dem
-- Besen in der Luft ausloggte, kam am Boden wieder — mit dem Besen unter den
-- Füssen und ohne Erklärung.
--
-- Die Vorgabe ist eine Zahl, die es nicht geben kann: **unter jedem Gelände**.
-- Daran erkennt der Server eine Zeile, die noch aus der Zeit ohne Höhe stammt,
-- und setzt die Figur wie früher auf den Boden. Eine Null täte das nicht — auf
-- der Insel liegt der Meeresspiegel bei minus vier, und eine Null wäre dort
-- eine Höhe wie jede andere.
ALTER TABLE characters
  ADD COLUMN IF NOT EXISTS pos_y REAL NOT NULL DEFAULT -100000;
