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
}

/**
 * Beides in einem — für den Alleinbetrieb und den Speicher.
 *
 * Ohne Anmeldeserver liegt alles in derselben Datenbank: es gibt genau einen
 * Prozess, und ihm eine zweite Verbindung zu derselben Adresse aufzuzwingen
 * wäre Zeremonie ohne Wirkung. Im Betrieb kommt diese Sorte nicht vor.
 */
export type GameStore = KontoStore & WeltStore;
