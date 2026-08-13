/**
 * Die dünne Schale.
 *
 * Der Blueprint weist ihr genau vier Aufgaben zu: Boot, Canvas, Fehler,
 * Storage. Mehr steht hier deshalb nicht. Alles Spielbezogene beginnt in
 * `core/game.ts`.
 *
 * Wer man ist, steht hier nicht mehr: das entscheidet die Anmeldung im Spiel.
 * Ein Name aus dem Speicher der Seite war eine Behauptung, kein Nachweis.
 */

import { Game } from './core/game.ts';
import { BUILD } from './config.ts';

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

  game.start().catch((err) => fatal('Start fehlgeschlagen', err));

  // Beim Verlassen sauber trennen, damit der Server die Sitzung sofort räumt
  // statt auf den Zeitablauf zu warten.
  window.addEventListener('pagehide', () => game.stop());
}
