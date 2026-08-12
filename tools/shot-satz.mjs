#!/usr/bin/env node
/**
 * Bild des Satzscheins auf mehreren Aufwertungsstufen.
 *
 * Derselbe Weg wie bei `shot-aura.mjs` und aus demselben Grund: der Schein
 * entsteht vollständig in einem Shader, und der Software-Rasterer aus
 * `render-rig.mjs` sieht davon nichts. Also echter Browser, echtes WebGL, am
 * Ende ein Bildschirmfoto.
 *
 * Links steht eine Figur ohne Satz — ohne die Gegenprobe im selben Bild wäre
 * nicht zu unterscheiden, ob der Schein zur Stufe passt oder einfach immer da
 * ist.
 *
 *   node tools/shot-satz.mjs
 *
 * Ergebnis: artefakte/satz.png
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const procs = [];

function launch(command) {
  const child = spawn('bash', ['-lc', command], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  procs.push(child);
  return child;
}

function shutdown() {
  for (const child of procs) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Schon beendet.
    }
  }
}
process.on('exit', shutdown);

const waitUntil = async (fn, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

launch('cd packages/client && npx vite --port 5198 --strictPort --host 127.0.0.1');
if (
  !(await waitUntil(async () => {
    try {
      return (await fetch('http://127.0.0.1:5198/')).ok;
    } catch {
      return false;
    }
  }, 60000))
) {
  throw new Error('Client-Server kam nicht hoch');
}

const executablePath = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
].find((p) => existsSync(p));

const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const page = await browser.newPage({ viewport: { width: 1200, height: 560 } });
await page.goto('http://127.0.0.1:5198/?name=Satz', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

// Null ist die Gegenprobe: vollständiger Ledersatz, aber nicht aufgewertet.
const STUFEN = [0, 4, 6, 8, 10];

await page.evaluate(async (stufen) => {
  const THREE = await import('/src/render/three-bridge.ts');
  const { createRig } = await import('/src/render/rigs.ts');
  const { SetAura } = await import('/src/render/setAura.ts');
  const { stepAuras } = await import('/src/render/auraClock.ts');

  // Das Spiel selbst anhalten, damit es nicht gegen die eigene Leinwand malt.
  document.querySelectorAll('canvas').forEach((c) => c.remove());
  document.querySelectorAll('.ui, #ui').forEach((n) => (n.style.display = 'none'));

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:9999';
  document.body.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(0x0a0f14, 1);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0x9fb8d4, 0x30404c, 1.1));
  const sonne = new THREE.DirectionalLight(0xfff2d8, 1.2);
  sonne.position.set(4, 8, 6);
  scene.add(sonne);

  const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 1.4, 8);
  camera.lookAt(0, 1.0, 0);

  // Der volle Ledersatz in der Reihenfolge aus VISIBLE_SLOTS:
  // Kopf, Brust, Hose, Schuhe, Umhang, Brille.
  const OUTFIT = 'leder|leder|leder|leder||';

  stufen.forEach((stufe, i) => {
    const rig = createRig(
      'player',
      new THREE.MeshLambertMaterial({ vertexColors: true }),
      'sword',
      OUTFIT,
    );
    rig.root.position.set((i - (stufen.length - 1) / 2) * 1.8, 0, 0);
    rig.root.rotation.y = 0.5;
    rig.update({ speed: 0, attackPhase: -1, dead: false, time: 0, dt: 1 / 60 });
    scene.add(rig.root);

    const aura = new SetAura(1.8);
    aura.setLevel(stufe);
    rig.root.add(aura.object);

    const marke = document.createElement('div');
    marke.textContent = stufe === 0 ? 'ohne' : `+${stufe}`;
    marke.style.cssText =
      'position:fixed;z-index:10000;color:#d8b84a;font:700 20px monospace;bottom:24px;' +
      `left:${((i + 0.5) / stufen.length) * 100}%;transform:translateX(-50%)`;
    document.body.appendChild(marke);
  });

  // Ein paar Sekunden laufen lassen: das Pulsieren soll im Bild an einer
  // Stelle stehen, an der es tatsächlich etwas zeigt.
  for (let i = 0; i < 60; i++) {
    stepAuras(1 / 60);
    renderer.render(scene, camera);
    await new Promise((r) => requestAnimationFrame(r));
  }
  window.satzFertig = true;
}, STUFEN);

await page.waitForFunction(() => window.satzFertig === true, { timeout: 20000 });
await page.screenshot({ path: join(root, 'artefakte', 'satz.png') });
console.log('→ artefakte/satz.png');

await browser.close();
shutdown();
