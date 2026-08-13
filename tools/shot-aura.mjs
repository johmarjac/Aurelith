#!/usr/bin/env node
/**
 * Bild der Waffenaura auf mehreren Aufwertungsstufen.
 *
 * Der Software-Rasterer aus `render-rig.mjs` kann das nicht: die Aura entsteht
 * vollständig in einem Shader, und ein Rasterer ohne GPU sieht davon nichts.
 * Also derselbe Weg wie bei den Rauchtests — echter Browser, echtes WebGL, und
 * am Ende ein Bildschirmfoto.
 *
 *   node tools/shot-aura.mjs
 *
 * Ergebnis: artefakte/aura.png
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { anmeldenUndBetreten } from './lib/spielstart.mjs';

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

launch('cd packages/client && npx vite --port 5197 --strictPort --host 127.0.0.1');
if (
  !(await waitUntil(async () => {
    try {
      return (await fetch('http://127.0.0.1:5197/')).ok;
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

const page = await browser.newPage({ viewport: { width: 1200, height: 520 } });
// Die Seite nur als Hülle: sie bringt Vite mit, und über Vite lassen sich die
// TypeScript-Module des Clients direkt laden.
await page.goto('http://127.0.0.1:5197/', { waitUntil: 'domcontentloaded' });
await anmeldenUndBetreten(page, `Aura${Date.now() % 100000}`);
await page.waitForTimeout(1500);

const STUFEN = [3, 4, 6, 8, 10];

await page.evaluate(async (stufen) => {
  // Über den Bare-Specifier, den Vite selbst auflöst — ein Pfad in
  // `node_modules` hängt an der Ablage im Dateisystem und stimmt bei einer
  // anderen npm-Fassung nicht mehr.
  const THREE = await import('/src/render/three-bridge.ts');
  const { createRig } = await import('/src/render/rigs.ts');
  const { WeaponAura } = await import('/src/render/weaponAura.ts');
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
  camera.position.set(0, 1.5, 7.5);
  camera.lookAt(0, 1.1, 0);

  const auren = [];
  stufen.forEach((stufe, i) => {
    // `createRig` aus dem Rig-Modul nimmt das Material entgegen; die
    // ModelRegistry im Spiel setzt es selbst. Ohne dieses Argument steht die
    // Figur zwar da, ist aber unsichtbar.
    const rig = createRig(
      'player',
      new THREE.MeshLambertMaterial({ vertexColors: true }),
      'sword',
    );
    rig.root.position.set((i - (stufen.length - 1) / 2) * 1.7, 0, 0);
    // Halb zur Seite gedreht: von vorn verdeckt der Arm die Klinge.
    rig.root.rotation.y = 0.6;
    rig.update({ speed: 0, attackPhase: -1, dead: false, time: 0, dt: 1 / 60 });
    scene.add(rig.root);

    if (rig.weaponMount) {
      const aura = new WeaponAura(rig.weaponSpan ?? { length: 1.1, bottom: -0.2, axis: 'y' });
      aura.setUpgrade(stufe);
      rig.weaponMount.add(aura.object);
      auren.push(aura);
    }

    const marke = document.createElement('div');
    marke.textContent = `+${stufe}`;
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
  window.auraFertig = true;
}, STUFEN);

await page.waitForFunction(() => window.auraFertig === true, { timeout: 20000 });
await page.screenshot({ path: join(root, 'artefakte', 'aura.png') });
console.log('→ artefakte/aura.png');

await browser.close();
shutdown();
