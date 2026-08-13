-- Figuren gehören zu einem Server.
--
-- Ein Konto gilt weltweit, eine Figur nicht: wer auf „Aurelith" spielt und
-- auf „Nordmark" anfängt, fängt dort bei null an. Genau so kennt man es aus
-- anderen Spielen, und es ist der Grund, warum es überhaupt mehrere Server
-- gibt — sie sind getrennte Welten und nicht dieselbe Welt unter zwei Namen.
--
-- **Kanäle** teilen sich dagegen die Figuren eines Servers. Sie sind kein
-- Weltenschnitt, sondern eine Lastverteilung: derselbe Server, dieselben
-- Figuren, nur eine andere Maschine. Deshalb steht hier der Servername und
-- nicht der Kanalname.
--
-- Bestandsfiguren bekommen „Aurelith" — den Namen, unter dem der einzige
-- Server bisher lief (AURELITH_SERVER_NAME hat denselben Vorgabewert). Ein
-- leerer Wert wäre eine Figur ohne Welt, und die fände niemand wieder.
ALTER TABLE characters ADD COLUMN IF NOT EXISTS server TEXT NOT NULL DEFAULT 'Aurelith';

-- Der Name einer Figur ist innerhalb **eines Servers** einzig, nicht darüber
-- hinaus: auf zwei getrennten Welten darf zweimal ein „Bregan" stehen, und
-- das Gegenteil zu verlangen hiesse, allen Spielern eines neuen Servers die
-- Namen der alten wegzunehmen.
ALTER TABLE characters DROP CONSTRAINT IF EXISTS characters_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS characters_server_name_idx ON characters (server, lower(name));

-- Gesucht wird immer nach „meine Figuren auf diesem Server".
CREATE INDEX IF NOT EXISTS characters_account_server_idx ON characters (account_id, server);
