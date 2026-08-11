#!/usr/bin/env node
/**
 * Entwicklungslauf: Server und Client zusammen, mit gemeinsamer Ausgabe.
 *
 * Prüft vorher, ob der wasm-Kern gebaut ist — ohne ihn startet weder das eine
 * noch das andere, und die Fehlermeldung wäre nicht hilfreich.
 *
 *   npm run dev
 */

import { spawn } from 'node:child_process';
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

const children = [];

for (const target of targets) {
  const child = spawn('bash', ['-lc', target.command], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
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

  child.on('exit', (code) => {
    console.log(`${prefix}beendet (${code})`);
    stopAll();
    process.exit(code ?? 0);
  });

  children.push(child);
}

function stopAll() {
  for (const child of children) {
    try {
      // Ganze Prozessgruppe, sonst überlebt das Node hinter der Shell.
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Schon beendet.
    }
  }
}

process.on('SIGINT', () => {
  stopAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopAll();
  process.exit(0);
});

console.log('\nAurelith läuft.');
console.log('  Client   http://localhost:5173');
console.log('  Server   ws://localhost:8787/ws');
console.log('  Editor   npm run dev:editor  →  http://localhost:5174\n');
