-- Anmeldung über fremde Anbieter — Google und was später dazukommt.
--
-- Eine **eigene Tabelle** und keine zwei Spalten an `accounts`. Der
-- Unterschied ist keiner der Buchhaltung: ein Mensch kann dasselbe Konto
-- später mit Google *und* mit etwas anderem verbinden, und zwei Spalten
-- könnten genau eine Verbindung führen. Wer sie dann erweitert, muss die
-- bestehenden Zeilen umbauen; wer hier eine Zeile hinzufügt, nicht.
--
-- `subject` ist die Kennung des Anbieters für diesen Menschen — bei Google die
-- `sub` aus dem ID-Token. Nicht die E-Mail-Adresse: die ändert sich, wird
-- weitergegeben und lässt sich in manchen Verzeichnissen sogar neu vergeben.
-- Sie steht trotzdem daneben, aber nur zum Nachsehen für einen Menschen.
--
-- Ein Konto ohne Passwort ist damit möglich und gewollt: `password_hash` ist
-- leer, und `anmelden` lehnt eine Passwortanmeldung dafür ab. Wer sich mit
-- Google anmeldet, hat kein Passwort — und soll auch keines raten müssen.
CREATE TABLE IF NOT EXISTS account_identities (
  provider   TEXT        NOT NULL,
  subject    TEXT        NOT NULL,
  account_id BIGINT      NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- Nur zur Anzeige. Nichts hängt daran.
  email      TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);

CREATE INDEX IF NOT EXISTS account_identities_account_idx
  ON account_identities (account_id);
