-- Die Masterdatenbank. Konten, sonst nichts.
--
-- Sie steht **einmal auf der Welt**, neben dem Anmeldeserver. Das ist die
-- ganze Aufgabenteilung: ein Konto gilt überall, eine Figur nur in ihrer
-- Region — und die Region hat ihre eigene Datenbank in ihrer eigenen
-- Erdhälfte.
--
-- Warum das so sein muss: ein Spieler in Frankfurt, dessen Figuren über ein
-- Seekabel geladen werden, wartet bei jedem Betreten und bei jedem Speichern.
-- Angemeldet wird dagegen genau einmal je Sitzung — dort ist eine Umlaufzeit
-- über den Atlantik eine halbe Sekunde beim Klick auf „Anmelden" und danach
-- nie wieder.
--
-- Hier steht deshalb ausschliesslich, was global gelten muss. Alles, was ein
-- Spieler im Spiel anfasst, liegt in `migrations/welt/`.

CREATE TABLE IF NOT EXISTS accounts (
  id            BIGSERIAL   PRIMARY KEY,
  name          TEXT        NOT NULL UNIQUE,
  -- Argon2id. Der Klartext verlässt den Anmeldeserver nie, und nur er sieht
  -- ihn überhaupt: die Spielserver bekommen Eintrittskarten, keine Passwörter.
  password_hash TEXT        NOT NULL DEFAULT '',
  -- Als Wort und nicht als Zahl: wer in die Tabelle sieht, soll lesen können,
  -- womit er es zu tun hat. Siehe `AccessLevel` in shared.
  access_level  TEXT        NOT NULL DEFAULT 'player',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- Angemeldet wird über den Namen, und zwar bei jedem Anmeldeversuch. Der
-- UNIQUE-Index oben deckt das ab; ein zweiter wäre dieselbe Auskunft doppelt.
