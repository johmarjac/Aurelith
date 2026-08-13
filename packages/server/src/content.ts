/**
 * Inhalte von der Platte laden.
 *
 * Der Server liest dieselben vier JSON-Dateien, die auch der Client über das
 * CDN holt — `assets/content/`. Damit gibt es genau eine Quelle für
 * Gegenstände, Monster, NPCs und Aufträge, und niemand muss zwei Fassungen
 * abgleichen.
 *
 * Muss **vor** dem Kern laufen: der bekommt seine Monsterprofile aus der
 * Tabelle, und ein Kern ohne Monster ist eine leere Welt.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadContent, type ContentSummary } from '@aurelith/shared';

async function json(dir: string, name: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(dir, name), 'utf8'));
  } catch (err) {
    throw new Error(`[inhalt] ${name} nicht lesbar: ${(err as Error).message}`);
  }
}

/** Liest die Inhaltsdateien aus einem Verzeichnis und trägt sie ein. */
export async function loadContentFromDisk(dir: string): Promise<ContentSummary> {
  const [items, mobs, npcs, quests, tuning, classes] = await Promise.all([
    json(dir, 'items.json'),
    json(dir, 'mobs.json'),
    json(dir, 'npcs.json'),
    json(dir, 'quests.json'),
    json(dir, 'tuning.json'),
    json(dir, 'classes.json'),
  ]);

  return loadContent({ items, mobs, npcs, quests, tuning, classes });
}
