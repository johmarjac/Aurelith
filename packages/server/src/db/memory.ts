/**
 * Speicher-Backend. Kein Ersatz für PostgreSQL, sondern die Zusicherung, dass
 * `npm run dev` ohne installierte Datenbank funktioniert. Alles ist beim
 * Neustart weg, und der Server sagt das beim Hochfahren.
 */

import {
  leereLeiste,
  normalisiereLeiste,
  startEigenschaften,
  type AktionsPlatz,
} from '@aurelith/shared';
import { starterRows } from '../inventory.ts';
import { HOEHE_UNBEKANNT } from './types.ts';
import type {
  AccountRecord,
  CharacterRecord,
  FreundRecord,
  GameStore,
  ItemRecord,
  LoadedCharacter,
  QuestRecord,
  SpawnPoint,
} from './types.ts';

interface Figur {
  character: CharacterRecord;
  items: ItemRecord[];
  quests: QuestRecord[];
  aktionen: AktionsPlatz[];
}

/** Namen vergleichen sich ohne Rücksicht auf Gross- und Kleinschreibung. */
const schluessel = (name: string): string => name.trim().toLowerCase();

export class MemoryStore implements GameStore {
  readonly kind = 'memory' as const;

  private readonly accounts = new Map<string, AccountRecord>();
  private readonly figuren = new Map<number, Figur>();
  private nextAccountId = 1;
  private nextCharacterId = 1;

  async init(): Promise<void> {
    // Nichts vorzubereiten.
  }

  async close(): Promise<void> {
    this.accounts.clear();
    this.figuren.clear();
  }

  async findAccount(name: string): Promise<AccountRecord | undefined> {
    const row = this.accounts.get(schluessel(name));
    return row ? { ...row } : undefined;
  }

  async createAccount(
    name: string,
    passwordHash: string,
    accessLevel: string,
  ): Promise<AccountRecord | undefined> {
    if (this.accounts.has(schluessel(name))) return undefined;
    const row: AccountRecord = { id: this.nextAccountId++, name, passwordHash, accessLevel };
    this.accounts.set(schluessel(name), row);
    return { ...row };
  }

  async setAccessLevel(accountId: number, accessLevel: string): Promise<void> {
    for (const row of this.accounts.values()) {
      if (row.id === accountId) row.accessLevel = accessLevel;
    }
  }

  /**
   * Der Speicher ist Master **und** Welt zugleich.
   *
   * Er kommt nur ohne Datenbank vor — ein Prozess, ein Zustand, nichts zu
   * trennen. Der Anspruch geht deshalb immer durch: es gibt keine zweite
   * Welt, mit der man sich stossen könnte.
   */
  async beanspruche(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async touchLogin(): Promise<void> {
    // Im Speicher gibt es keine Buchführung über gestern.
  }

  async listCharacters(accountId: number): Promise<CharacterRecord[]> {
    return [...this.figuren.values()]
      .filter((f) => f.character.accountId === accountId)
      .sort((a, b) => a.character.id - b.character.id)
      .map((f) => ({ ...f.character }));
  }

  async createCharacter(
    accountId: number,
    name: string,
    beruf: string,
    spawn: SpawnPoint,
  ): Promise<CharacterRecord | undefined> {
    for (const f of this.figuren.values()) {
      if (schluessel(f.character.name) === schluessel(name)) return undefined;
    }

    const character: CharacterRecord = {
      id: this.nextCharacterId++,
      accountId,
      name,
      beruf,
      level: 1,
      exp: 0,
      gold: 0,
      hp: 0,
      mp: 0,
      mapId: spawn.mapId,
      x: spawn.x,
      // Eine frische Figur steht auf dem Gelände, und wo das ist, weiss erst
      // die Welt. Der Merker sagt genau das: „Höhe noch nicht bekannt".
      y: HOEHE_UNBEKANNT,
      z: spawn.z,
      yaw: spawn.yaw,
      ...startEigenschaften(),
    };
    this.figuren.set(character.id, {
      character,
      items: starterRows(),
      quests: [],
      aktionen: leereLeiste(),
    });
    return { ...character };
  }

  async deleteCharacter(accountId: number, characterId: number): Promise<boolean> {
    const figur = this.figuren.get(characterId);
    if (!figur || figur.character.accountId !== accountId) return false;
    this.figuren.delete(characterId);
    return true;
  }

  async loadCharacter(
    accountId: number,
    characterId: number,
  ): Promise<LoadedCharacter | undefined> {
    const figur = this.figuren.get(characterId);
    if (!figur || figur.character.accountId !== accountId) return undefined;
    return {
      character: { ...figur.character },
      items: figur.items.map((i) => ({ ...i })),
      quests: figur.quests.map((q) => ({ ...q, progress: [...q.progress] })),
      aktionen: figur.aktionen.map((p) => ({ ...p })),
    };
  }

  async saveCharacter(character: CharacterRecord): Promise<void> {
    const figur = this.figuren.get(character.id);
    if (figur) figur.character = { ...character };
  }

  /**
   * Fremde Identitäten — Anbieter und Kennung auf Konto.
   *
   * Ein `Map` mit „anbieter:kennung" als Schlüssel: zwei verschachtelte Maps
   * wären dieselbe Auskunft mit einer Ebene mehr.
   */
  private readonly identitaeten = new Map<string, number>();

  async findeIdentitaet(provider: string, subject: string): Promise<AccountRecord | undefined> {
    const id = this.identitaeten.get(`${provider}:${subject}`);
    if (id === undefined) return undefined;
    const konto = [...this.accounts.values()].find((k) => k.id === id);
    return konto ? { ...konto } : undefined;
  }

  async legeKontoMitIdentitaet(
    name: string,
    accessLevel: string,
    provider: string,
    subject: string,
    _email: string,
  ): Promise<AccountRecord | undefined> {
    const konto = await this.createAccount(name, '', accessLevel);
    if (!konto) return undefined;
    this.identitaeten.set(`${provider}:${subject}`, konto.id);
    return konto;
  }

  async verknuepfeIdentitaet(
    accountId: number,
    provider: string,
    subject: string,
    _email: string,
  ): Promise<void> {
    // Wie in der Datenbank: eine bestehende Zuordnung bleibt, wie sie ist.
    const schluessel = `${provider}:${subject}`;
    if (!this.identitaeten.has(schluessel)) this.identitaeten.set(schluessel, accountId);
  }

  async saveInventory(characterId: number, items: ItemRecord[]): Promise<void> {
    const figur = this.figuren.get(characterId);
    if (figur) figur.items = items.map((i) => ({ ...i }));
  }

  async saveQuests(characterId: number, quests: QuestRecord[]): Promise<void> {
    const figur = this.figuren.get(characterId);
    if (figur) figur.quests = quests.map((q) => ({ ...q, progress: [...q.progress] }));
  }

  async saveAktionen(characterId: number, plaetze: AktionsPlatz[]): Promise<void> {
    const figur = this.figuren.get(characterId);
    if (figur) figur.aktionen = normalisiereLeiste(plaetze);
  }

  /**
   * Freundschaften — je Figur die Menge ihrer Freunde.
   *
   * Zwei Einträge je Freundschaft wie in der Datenbank, und aus demselben
   * Grund: gefragt wird immer „wer sind meine Freunde", und die Antwort soll
   * eine Nachschlagung sein und keine Suche. Gesetzt und gelöst wird beides
   * nur hier, in einem Zug — halbe Freundschaften kann es damit nicht geben.
   */
  private readonly freunde = new Map<number, Set<number>>();

  async findCharacterByName(name: string): Promise<FreundRecord | undefined> {
    const gesucht = schluessel(name);
    for (const f of this.figuren.values()) {
      if (schluessel(f.character.name) === gesucht) {
        return { id: f.character.id, name: f.character.name, level: f.character.level };
      }
    }
    return undefined;
  }

  async listFriends(characterId: number): Promise<FreundRecord[]> {
    const ids = this.freunde.get(characterId);
    if (!ids) return [];
    const zeilen: FreundRecord[] = [];
    for (const id of ids) {
      const f = this.figuren.get(id);
      // Eine Figur, die es nicht mehr gibt, steht nicht in der Liste. In der
      // Datenbank erledigt das der Fremdschlüssel; hier steht es ausdrücklich.
      if (f) zeilen.push({ id, name: f.character.name, level: f.character.level });
    }
    return zeilen.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  async addFriend(a: number, b: number): Promise<void> {
    if (a === b) return;
    for (const [von, zu] of [
      [a, b],
      [b, a],
    ] as const) {
      const menge = this.freunde.get(von) ?? new Set<number>();
      menge.add(zu);
      this.freunde.set(von, menge);
    }
  }

  async removeFriend(a: number, b: number): Promise<void> {
    this.freunde.get(a)?.delete(b);
    this.freunde.get(b)?.delete(a);
  }
}
