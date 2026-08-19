/**
 * Persistenzschnittstellen. Zwei Implementierungen: PostgreSQL für den
 * Betrieb, ein Speicher-Backend für den Fall, dass keine Datenbank
 * konfiguriert ist.
 *
 * Der Rest des Servers kennt nur diese Schnittstellen — es gibt keine Stelle,
 * an der SQL außerhalb von `postgres.ts` steht.
 *
 * **Zwei Datenbanken, zwei Schnittstellen.**
 *
 *   `KontoStore` — die Masterdatenbank. Steht einmal auf der Welt, neben dem
 *   Anmeldeserver, und hält Konten.
 *
 *   `WeltStore` — eine je Server, also je Region. Steht dort, wo die Kanäle
 *   stehen, und hält Figuren, Beutel und Aufträge.
 *
 * Getrennt und nicht ein Interface mit zwei Hälften: der Anmeldeserver **hat**
 * keine Figuren, und ein Kanal **hat** keine Passwörter. Wäre beides eine
 * Schnittstelle, liesse sich das nur zur Laufzeit merken — als Methode, die
 * ins Leere greift, statt als Aufruf, den es nicht gibt.
 */

import type { AktionsPlatz } from '@aurelith/shared';

/**
 * Die Höhe einer Figur, die noch nie gespeichert wurde.
 *
 * Eine Zahl, die als Höhe nicht vorkommen kann — tiefer als jeder Meeresgrund.
 * Ein Merker statt `null`, weil die Spalte `NOT NULL` ist und weil eine Zahl
 * durch jede Schicht dieses Servers unverändert durchgeht; `null` müsste an
 * fünf Stellen einzeln behandelt werden, und eine davon vergisst man.
 */
export const HOEHE_UNBEKANNT = -100000;

export interface CharacterRecord {
  id: number;
  accountId: number;
  name: string;
  /** Kennung des Berufs — siehe `assets/content/classes.json`. */
  beruf: string;
  level: number;
  exp: number;
  gold: number;
  hp: number;
  mp: number;
  mapId: string;
  x: number;
  /**
   * Die Höhe, in Metern.
   *
   * `HOEHE_UNBEKANNT` heisst: diese Zeile stammt aus der Zeit, in der nur
   * `x` und `z` gespeichert wurden. Dann setzt der Server die Figur wie früher
   * auf das Gelände. Alles andere ist eine echte Höhe — auch eine negative,
   * denn der Meeresspiegel der Insel liegt bei minus vier.
   */
  y: number;
  z: number;
  yaw: number;
  /*
   * Die vier Grundeigenschaften. Was daraus folgt, steht nirgends in der
   * Datenbank — Leben, Angriff und der Rest werden bei jedem Laden neu
   * gerechnet, aus Stufe, diesen vier Zahlen und der Ausrüstung.
   *
   * Auch die offenen Punkte stehen nicht hier: sie sind Stufe minus dem, was
   * verteilt ist. Siehe `offenePunkte` im geteilten Paket.
   */
  staerke: number;
  ausdauer: number;
  geschick: number;
  weisheit: number;
}

export interface ItemRecord {
  itemId: string;
  count: number;
  slot: number;
  equipped: boolean;
  /** Aufwertungsstufe, 0 bis 10. Stapelbares hat immer 0. */
  upgrade: number;
  /**
   * Läuft dieses Haustier gerade draussen herum?
   *
   * Nur für `kind: 'pet'` und ausdrücklich **nicht** `equipped`: ein
   * freigelassenes Tier bleibt im Beutel liegen, ein angelegter Panzer wandert
   * an die Figur. Dieselbe Spalte für beides hiesse, dass der Beutel das Tier
   * nicht mehr zeigt, sobald es draussen ist — und genau dort erwartet man es.
   */
  unterwegs: boolean;
}

export interface QuestRecord {
  questId: string;
  /** `QuestStatus` aus dem geteilten Paket. */
  status: number;
  /** Fortschritt je Ziel, in der Reihenfolge der Definition. */
  progress: number[];
}

export interface AccountRecord {
  id: number;
  name: string;
  /** `scrypt$…` — siehe `passwords.ts`. Leer heisst: passt zu nichts. */
  passwordHash: string;
  /** Wort aus `ACCESS_NAMES`. Übersetzt wird im geteilten Paket. */
  accessLevel: string;
}

/** Ein Charakter samt allem, was zum Betreten der Welt gebraucht wird. */
export interface LoadedCharacter {
  character: CharacterRecord;
  items: ItemRecord[];
  quests: QuestRecord[];
  /**
   * Die Aktionsleiste. Immer voller Länge — die leeren Plätze stehen mit
   * darin, damit niemand am anderen Ende die Löcher füllen muss.
   */
  aktionen: AktionsPlatz[];
}

export interface SpawnPoint {
  mapId: string;
  x: number;
  z: number;
  yaw: number;
}

/** Was jede der beiden Sorten kann. */
export interface StoreBasis {
  readonly kind: 'postgres' | 'memory';
  init(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Die Masterdatenbank: Konten.
 *
 * Nur der Anmeldeserver spricht damit — und ein Spielserver im Alleinbetrieb,
 * der ohne Anmeldeserver läuft und deshalb selbst Passwörter prüfen muss.
 */
export interface KontoStore extends StoreBasis {
  /**
   * Konto zum Namen, oder nichts. Der Vergleich ist unabhängig von Gross- und
   * Kleinschreibung: `Held` und `held` sind dieselbe Person.
   */
  findAccount(name: string): Promise<AccountRecord | undefined>;
  /**
   * Legt ein Konto an. Gibt nichts zurück, wenn der Name schon vergeben ist —
   * geprüft wird in der Datenbank und nicht davor, sonst gewinnt bei zwei
   * gleichzeitigen Anmeldungen die Zufälligkeit.
   */
  createAccount(
    name: string,
    passwordHash: string,
    accessLevel: string,
  ): Promise<AccountRecord | undefined>;
  /** Setzt die Zugriffsstufe — für die Liste der Verwalter in der Konfiguration. */
  setAccessLevel(accountId: number, accessLevel: string): Promise<void>;
  /** Merkt sich, wann zuletzt angemeldet wurde. Reine Buchführung. */
  touchLogin(accountId: number): Promise<void>;

  /**
   * Das Konto hinter einer fremden Identität — Google und was folgt.
   *
   * `subject` ist die Kennung des Anbieters, nicht die E-Mail-Adresse: die
   * ändert sich, wird weitergegeben und lässt sich mancherorts neu vergeben.
   */
  findeIdentitaet(provider: string, subject: string): Promise<AccountRecord | undefined>;

  /**
   * Legt ein Konto **ohne Passwort** an und verbindet es mit dieser Identität.
   *
   * Beides in einem Aufruf, weil beides zusammengehört: ein Konto ohne
   * Identität, dessen Anlegen zur Hälfte scheitert, hat kein Passwort und
   * keinen Anbieter — dort käme nie wieder jemand hinein.
   *
   * Nichts, wenn der Name schon vergeben ist. Der Aufrufer probiert dann den
   * nächsten.
   */
  legeKontoMitIdentitaet(
    name: string,
    accessLevel: string,
    provider: string,
    subject: string,
    email: string,
  ): Promise<AccountRecord | undefined>;

  /**
   * Hängt eine **weitere** Identität an ein Konto, das es schon gibt.
   *
   * Der Fall: dieselbe Adresse, ein anderer Anbieter. Wer sich gestern über
   * Google angemeldet hat und heute über Facebook, ist dieselbe Person und
   * soll dieselben Figuren vorfinden — die Adresse ist der Kontoname, und zwei
   * Konten unter einer Adresse gäbe es ohnehin nicht.
   *
   * Die Tabelle kann das von Anfang an: ihr Schlüssel ist (Anbieter, Kennung),
   * `account_id` steht daneben und ist nicht eindeutig. Ein Konto durfte also
   * immer schon mehrere Identitäten haben — es hat sie nur nie bekommen.
   *
   * Doppelt aufgerufen tut es nichts. Zwei Anmeldungen zugleich sind kein
   * Fehler, sondern zweimal dieselbe Aussage.
   */
  verknuepfeIdentitaet(
    accountId: number,
    provider: string,
    subject: string,
    email: string,
  ): Promise<void>;
}

/**
 * Eine Weltdatenbank: Figuren, Beutel, Aufträge.
 *
 * Kein Servername in irgendeiner Signatur — die Datenbank **ist** der Server.
 * Ein Feld dafür wäre eine zweite Wahrheit über dieselbe Trennung, und die
 * schweigende von beiden gewinnt genau dann, wenn jemand sie falsch setzt.
 *
 * `accountId` zeigt in die Masterdatenbank. Dass es das Konto gibt, sagt die
 * Eintrittskarte des Anmeldeservers; ein Fremdschlüssel geht über
 * Datenbankgrenzen hinweg nicht.
 */
export interface WeltStore extends StoreBasis {
  /**
   * Trägt ein, wem diese Welt gehört — oder prüft es.
   *
   * Beim ersten Hochfahren steht der Name da, danach wird er verglichen.
   * Passt er nicht, gibt es den eingetragenen zurück, und der Aufrufer bricht
   * ab: zwei Server auf derselben Datenbank ist ein Fehler, den man sonst
   * erst bemerkt, wenn Spieler fremde Figuren sehen.
   */
  beanspruche(server: string): Promise<{ ok: true } | { ok: false; gehoert: string }>;
  /** Die Figuren dieses Kontos in dieser Welt, in der Reihenfolge ihrer Entstehung. */
  listCharacters(accountId: number): Promise<CharacterRecord[]>;
  /**
   * Legt eine Figur an. Nichts, wenn der Name schon vergeben ist.
   *
   * Der Startbeutel entsteht mit — eine Figur ohne Ausrüstung wäre ein
   * halbfertiger Zustand, den jeder Aufrufer selbst vollenden müsste.
   */
  createCharacter(
    accountId: number,
    name: string,
    beruf: string,
    spawn: SpawnPoint,
  ): Promise<CharacterRecord | undefined>;
  /** Löscht eine Figur — nur, wenn sie dem Konto gehört. */
  deleteCharacter(accountId: number, characterId: number): Promise<boolean>;
  /** Lädt eine Figur samt Beutel und Aufträgen — nur, wenn sie dem Konto gehört. */
  loadCharacter(accountId: number, characterId: number): Promise<LoadedCharacter | undefined>;
  saveCharacter(character: CharacterRecord): Promise<void>;
  saveInventory(characterId: number, items: ItemRecord[]): Promise<void>;
  /**
   * Schreibt den Auftragsstand.
   *
   * Wie beim Inventar vollständig ersetzend: eine Handvoll Zeilen je Charakter,
   * und ein Abgleich wäre mehr Code für dieselbe Wirkung.
   */
  saveQuests(characterId: number, quests: QuestRecord[]): Promise<void>;
  /**
   * Schreibt die Aktionsleiste. Ersetzend wie Beutel und Aufträge.
   *
   * Erwartet die volle Länge; leere Plätze bekommen keine Zeile. Aus zehn
   * Plätzen werden so selten mehr als drei Zeilen.
   */
  saveAktionen(characterId: number, plaetze: AktionsPlatz[]): Promise<void>;

  /**
   * Sucht eine Figur über ihren Namen — ohne Rücksicht auf Gross und Klein.
   *
   * Für die Freundesliste: dort tippt man einen Namen, und daraus muss eine
   * Kennung werden. `undefined` heisst schlicht „gibt es hier nicht" — auf
   * **diesem** Server, denn Figuren stehen je Region getrennt.
   */
  findCharacterByName(name: string): Promise<FreundRecord | undefined>;
  /** Die Freunde dieser Figur, mit Namen und Stufe. Nach Namen sortiert. */
  listFriends(characterId: number): Promise<FreundRecord[]>;
  /**
   * Trägt eine Freundschaft ein — **beide** Richtungen.
   *
   * Zweimal ausgeführt ändert sich nichts: wer schon befreundet ist, bleibt
   * es. Das ist keine Bequemlichkeit, sondern die Antwort auf zwei Anfragen,
   * die sich gekreuzt haben.
   */
  addFriend(a: number, b: number): Promise<void>;
  /** Löst sie wieder — ebenfalls beide Richtungen. */
  removeFriend(a: number, b: number): Promise<void>;
}

/** Eine Figur, so viel wie die Freundesliste von ihr zeigt. */
export interface FreundRecord {
  id: number;
  name: string;
  level: number;
}

/**
 * Beides in einem — für den Alleinbetrieb und den Speicher.
 *
 * Ohne Anmeldeserver liegt alles in derselben Datenbank: es gibt genau einen
 * Prozess, und ihm eine zweite Verbindung zu derselben Adresse aufzuzwingen
 * wäre Zeremonie ohne Wirkung. Im Betrieb kommt diese Sorte nicht vor.
 */
export type GameStore = KontoStore & WeltStore;
