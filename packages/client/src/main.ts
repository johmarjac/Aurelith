/**
 * Die dünne Schale.
 *
 * Der Blueprint weist ihr genau vier Aufgaben zu: Boot, Canvas, Fehler,
 * Storage. Mehr steht hier deshalb nicht. Alles Spielbezogene beginnt in
 * `core/game.ts`.
 */

import { Game } from './core/game.ts';
import { BUILD } from './config.ts';

const STORAGE_KEY = 'aurelith.account';

/**
 * Ein Name ohne Anmeldemaske. Wer schon einen hat, behält ihn; wer keinen hat,
 * bekommt einen und kann später umbenennen. Eine Login-Schranke vor dem ersten
 * Bild wäre genau die Ladeschranke, die wir nicht wollen.
 */
function accountName(): string {
  const fromUrl = new URLSearchParams(location.search).get('name');
  if (fromUrl) {
    try {
      localStorage.setItem(STORAGE_KEY, fromUrl);
    } catch {
      // Privater Modus ohne Storage — der Name gilt dann nur diese Sitzung.
    }
    return fromUrl;
  }

  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  if (stored) return stored;

  const generated = `Held${Math.floor(1000 + Math.random() * 9000)}`;
  try {
    localStorage.setItem(STORAGE_KEY, generated);
  } catch {
    // Ebenfalls kein Grund, nicht zu spielen.
  }
  return generated;
}

function fatal(message: string, detail: unknown): void {
  console.error(message, detail);
  const box = document.createElement('div');
  box.setAttribute(
    'style',
    'position:fixed;inset:auto 1rem 1rem 1rem;z-index:9999;padding:0.9rem 1rem;' +
      'background:#2a1416;border:1px solid #7a2523;border-radius:4px;color:#f0d8d5;' +
      'font:13px/1.5 system-ui,sans-serif;max-height:40vh;overflow:auto',
  );
  box.textContent = `${message} — ${detail instanceof Error ? detail.message : String(detail)}`;
  document.body.appendChild(box);
}

const canvas = document.getElementById('viewport') as HTMLCanvasElement | null;
const uiRoot = document.getElementById('ui-root');

if (!canvas || !uiRoot) {
  fatal('Grundgerüst der Seite fehlt', 'viewport oder ui-root nicht gefunden');
} else {
  console.log(`Aurelith — Build ${BUILD}`);

  const game = new Game(canvas, uiRoot);

  // Fehler, die es bis hierher schaffen, sollen sichtbar sein und nicht nur
  // in einer Konsole liegen, die auf dem Telefon niemand öffnet.
  window.addEventListener('error', (e) => fatal('Unerwarteter Fehler', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => fatal('Unerwarteter Fehler', e.reason));

  game.start(accountName()).catch((err) => fatal('Start fehlgeschlagen', err));

  // Beim Verlassen sauber trennen, damit der Server die Sitzung sofort räumt
  // statt auf den Zeitablauf zu warten.
  window.addEventListener('pagehide', () => game.stop());
}
