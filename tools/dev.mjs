#!/usr/bin/env node
/**
 * Entwicklungslauf: Server und Client zusammen, mit gemeinsamer Ausgabe.
 *
 * Prüft vorher, ob der wasm-Kern gebaut ist — ohne ihn startet weder das eine
 * noch das andere, und die Fehlermeldung wäre nicht hilfreich.
 *
 *   npm run dev
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const required = [
  join(root, 'assets', 'core', 'aurelith_core.js'),
  join(root, 'assets', 'core', 'aurelith_core.wasm'),
];
if (required.some((f) => !existsSync(f))) {
  console.error('Der wasm-Kern fehlt. Einmal bauen mit:\n  npm run core\n');
  process.exit(1);
}

if (!existsSync(join(root, 'assets', 'maps'))) {
  console.error('Es gibt keine Maps. Erzeugen mit:\n  npm run maps\n');
  process.exit(1);
}

const targets = [
  { name: 'server', color: '[36m', command: 'npm run dev --workspace @aurelith/server' },
  { name: 'client', color: '[35m', command: 'npm run dev --workspace @aurelith/client' },
];

const isWindows = process.platform === 'win32';

const children = [];
let stopping = false;

for (const target of targets) {
  const child = isWindows
    ? spawn(target.command, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: true })
    : spawn('bash', ['-lc', target.command], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Eigene Prozessgruppe, damit `kill(-pid)` alles erwischt, was darunter
        // haengt: bash, npm, tsx und der eigentliche Node-Prozess. Ohne das
        // ueberlebt der Server das Ende der Shell und haelt den Port weiter.
        detached: true,
      });

  const prefix = `${target.color}[${target.name}][0m `;
  const forward = (stream, sink) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split('\n');
      // Der letzte Teil kann eine halbe Zeile sein — die wartet auf den Rest.
      buffer = lines.pop() ?? '';
      for (const line of lines) sink.write(`${prefix}${line}\n`);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.exited = false;
  child.on('exit', (code) => {
    child.exited = true;
    console.log(`${prefix}beendet (${code})`);
    // Faellt einer aus, hat der andere allein keinen Sinn.
    if (!stopping) void stopAll(code ?? 0);
  });

  children.push(child);
}

/**
 * Beendet ein Kind samt allem, was darunter hängt.
 *
 * Zwei Wege, weil es zwei Welten sind:
 *
 *   **Unix.** Die Kinder laufen in einer eigenen Prozessgruppe, und ein Signal
 *   an die negative Kennung erreicht die ganze Gruppe — bash, npm, tsx und den
 *   Server darunter. Ein Signal nur an `child.pid` träfe die Shell und liesse
 *   den Server als Waisen zurück, der weiter auf dem Port sitzt.
 *
 *   **Windows.** Dort gibt es keine Prozessgruppen in diesem Sinn, und
 *   `process.kill` mit negativer Kennung schlägt fehl. Genau das war hier eine
 *   stille Falle: der Fehlschlag landete im `catch`, es passierte nichts, und
 *   nach Strg+C liefen Server und Vite unbeirrt weiter. `taskkill /T` beendet
 *   stattdessen den ganzen Baum.
 */
function signal(child, sig) {
  if (child.exited) return;

  if (isWindows) {
    // /T nimmt die Kinder mit, /F erzwingt. Ein sanftes Beenden gibt es unter
    // Windows für Konsolenprogramme nicht auf diesem Weg — deshalb wird hier
    // erst bei SIGKILL zugeschlagen und bei SIGTERM nur gebeten.
    if (sig === 'SIGKILL') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T'], { stdio: 'ignore' });
    }
    return;
  }

  try {
    process.kill(-child.pid, sig);
  } catch {
    // Schon beendet.
  }
}

const alive = () => children.filter((c) => !c.exited);

/**
 * Beendet beide Kinder — und wartet darauf.
 *
 * Das Warten ist der Punkt. Vorher wurde nur signalisiert und sofort
 * `process.exit` gerufen: die Eingabeaufforderung war zurück, während der
 * Server noch dabei war, Sitzungen zu speichern und den Horcher zu schliessen.
 * Wer dann gleich wieder `npm run dev` tippte, bekam „Adresse bereits in
 * Benutzung" — nicht, weil der Server nicht herunterfährt, sondern weil ihm
 * niemand die Zeit dafür liess.
 *
 * Nach der Frist wird nachgesetzt. Ein Prozess, der auf SIGTERM nicht
 * reagiert, soll den Port nicht behalten.
 */
async function stopAll(exitCode = 0) {
  if (stopping) return;
  stopping = true;

  for (const child of children) signal(child, 'SIGTERM');

  const deadline = Date.now() + GRACE_MS;
  while (alive().length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  if (alive().length > 0) {
    console.log(`\nNoch ${alive().length} Prozess(e) offen — setze nach.`);
    for (const child of children) signal(child, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
  }

  process.exit(exitCode);
}

/** So lange darf ein Kind sich Zeit lassen, bevor nachgesetzt wird. */
const GRACE_MS = 6000;

process.on('SIGINT', () => {
  console.log('\nBeende …');
  void stopAll(0);
});
process.on('SIGTERM', () => void stopAll(0));

console.log('\nAurelith läuft.');
console.log('  Client   http://localhost:5173');
console.log('  Server   ws://localhost:8787/ws');
console.log('  Editor   npm run dev:editor  →  http://localhost:5174\n');
