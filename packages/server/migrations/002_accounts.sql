-- Konten bekommen Passwort und Zugriffsstufe.
--
-- Vorher genügte ein Name: wer ihn kannte, war die Person. Das reichte,
-- solange es nur eine Figur je Konto gab und niemand etwas zu verlieren hatte.
-- Mit Charakterverwaltung und Befehlen, die nicht jedem zustehen, reicht es
-- nicht mehr.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS password_hash TEXT NOT NULL DEFAULT '';

-- Als Wort und nicht als Zahl: wer in die Tabelle sieht, soll lesen können,
-- womit er es zu tun hat. Die Übersetzung in eine Ordnung steht im geteilten
-- Paket (`account/access.ts`).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS access_level TEXT NOT NULL DEFAULT 'player';

-- Bestandskonten haben kein Passwort. Ein leerer Hash passt zu keiner Eingabe
-- — sie müssen neu angelegt werden, und das ist die richtige Antwort: ein
-- Konto ohne Nachweis darf sich nicht anmelden, nur weil es alt ist.

-- Ein Charaktername gilt weltweit nur einmal (steht schon in 001), aber ein
-- Konto braucht seine Figuren auch schnell zur Hand.
CREATE INDEX IF NOT EXISTS characters_account_name_idx ON characters (account_id, name);
