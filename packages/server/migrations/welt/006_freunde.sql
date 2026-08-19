-- Freundschaften zwischen Figuren.
--
-- **Zwei Zeilen je Freundschaft, eine je Richtung.** Das ist bewusst doppelt
-- und nicht sparsam: die Frage, die tausendmal gestellt wird, lautet „wer sind
-- meine Freunde", und die beantwortet ein Index auf `character_id` in einem
-- Zugriff. Mit einer Zeile je Paar — kleinere Kennung zuerst — müsste jede
-- Abfrage beide Spalten durchsuchen und das Ergebnis danach umdrehen, und
-- genau dieses Umdrehen vergisst man an einer von drei Stellen.
--
-- Die doppelte Buchführung ist keine, solange sie an **einer** Stelle
-- geschrieben wird: `addFriend` und `removeFriend` setzen und löschen immer
-- beide Richtungen. Es gibt keinen Weg in diese Tabelle, der nur eine anfasst.
--
-- Eine halbe Freundschaft wäre der Zustand, den niemand erklären kann: der
-- eine hat den anderen in der Liste, der andere nicht — und beide sehen etwas
-- anderes, wenn sie nachschauen.
CREATE TABLE IF NOT EXISTS character_friends (
  character_id BIGINT      NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  friend_id    BIGINT      NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  seit         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (character_id, friend_id),
  -- Niemand ist mit sich selbst befreundet. Die Prüfung steht auch im Server;
  -- hier steht sie, damit sie auch dann gilt, wenn jemand von Hand einträgt.
  CHECK (character_id <> friend_id)
);

CREATE INDEX IF NOT EXISTS character_friends_char_idx ON character_friends (character_id);
