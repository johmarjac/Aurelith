#!/usr/bin/env node
/**
 * Erzeugt die Inventarbilder — ein gerendertes Symbol je Gegenstand.
 *
 * Bis hierher war die Kachel im Inventar eine Farbfläche. Das reichte, solange
 * es fünf Gegenstände gab; bei zwanzig sucht man das rote Quadrat unter drei
 * anderen roten Quadraten.
 *
 *   node tools/render-icons.mjs
 *
 * Der Weg ist derselbe wie bei `shot-aura.mjs`: echter Browser, echtes WebGL,
 * dieselben Modelle wie im Spiel. Ein Symbol, das anders gebaut wird als der
 * Gegenstand in der Hand, geht früher oder später auseinander.
 *
 * Ergebnis: `assets/icons/<id>.webp`, und der Pfad landet in `items.json`.
 * Danach `npm run manifest`, damit der Streamer die Bilder kennt.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const itemsFile = join(root, 'assets', 'content', 'items.json');
const iconsDir = join(root, 'assets', 'icons');

/** Kantenlänge des fertigen Bilds. Gezeichnet wird vierfach und verkleinert. */
const SIZE = 96;
const SUPERSAMPLE = 4;

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

const doc = JSON.parse(await readFile(itemsFile, 'utf8'));

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

const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
await page.goto('http://127.0.0.1:5198/', { waitUntil: 'domcontentloaded' });
/*
 * Keine Anmeldung.
 *
 * Hier stand einmal der übliche Weg in die Welt — und er hat hier nie etwas
 * getan: gezeichnet wird weiter unten mit einem eigenen Renderer auf einer
 * eigenen Leinwand, aus Modulen, die direkt geladen werden. Gebraucht wird von
 * der Seite nur, dass ihr Modulgraph steht.
 *
 * Aufgefallen ist es erst, als kein Spielserver mehr lief: dann kommt die
 * Anmeldemaske gar nicht, und das Werkzeug lief in eine Zeitüberschreitung an
 * einer Stelle, an der es nichts zu warten gab.
 */
await page.waitForTimeout(1500);

const gerendert = await page.evaluate(
  async ({ defs, size }) => {
    const THREE = await import('/src/render/three-bridge.ts');
    const { buildItemGeometry } = await import('/src/render/itemModels.ts');

    // Das Spiel selbst beiseiteräumen — es zeichnet sonst gegen dieselbe Fläche.
    document.querySelectorAll('canvas').forEach((c) => c.remove());

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    document.body.appendChild(canvas);

    // `alpha` und `preserveDrawingBuffer`: das eine für den durchsichtigen
    // Hintergrund, das andere, weil `toDataURL` sonst ein leeres Bild liefert —
    // der Puffer ist nach dem Zeichnen normalerweise schon wieder freigegeben.
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    renderer.setClearAlpha(0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    // Dieselbe Beleuchtung wie in der Welt, nur ohne Sonnenstand: ein Symbol
    // soll bei Nacht nicht anders aussehen als bei Tag.
    scene.add(new THREE.HemisphereLight(0xdfeaf4, 0x3a4450, 1.5));
    const licht = new THREE.DirectionalLight(0xfff4de, 1.6);
    licht.position.set(3, 5, 4);
    scene.add(licht);
    const gegenlicht = new THREE.DirectionalLight(0x9fb8d4, 0.5);
    gegenlicht.position.set(-4, 2, -3);
    scene.add(gegenlicht);

    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);

    const out = [];
    for (const def of defs) {
      const geo = buildItemGeometry(def);
      if (!geo) {
        out.push({ id: def.id, data: '' });
        continue;
      }

      const mesh = new THREE.Mesh(geo, material);
      // Über die Diagonale gelegt und leicht gedreht: die klassische
      // Symbolansicht. Von vorn ist ein Schwert ein Strich, und aufrecht füllt
      // es eine quadratische Kachel nur in der Mitte.
      mesh.rotation.set(0, Math.PI * 0.2, -Math.PI * 0.25);
      scene.add(mesh);

      // Ins Bild rücken — über den **Quader**, nicht über die Hüllkugel.
      //
      // Eine Kugel um ein Schwert hat den Radius seiner halben Länge; die
      // Kachel wäre damit zu drei Vierteln leer. Der Quader nach der Drehung
      // ist das, was man tatsächlich sieht, und über die Diagonale gelegt ist
      // er fast quadratisch.
      const box = new THREE.Box3().setFromObject(mesh);
      const mitte = box.getCenter(new THREE.Vector3());
      const groesse = box.getSize(new THREE.Vector3());
      mesh.position.sub(mitte);

      const halb = Math.max(groesse.x, groesse.y) / 2;
      const abstand =
        halb / Math.tan((camera.fov * Math.PI) / 360) + groesse.z / 2;
      // Zehn Prozent Luft: sonst schneidet die Kante des Bilds die Spitze ab.
      camera.position.set(0, 0, abstand * 1.1);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();

      renderer.setSize(size, size, false);
      renderer.render(scene, camera);
      out.push({ id: def.id, data: canvas.toDataURL('image/png') });

      scene.remove(mesh);
      geo.dispose();
    }

    renderer.dispose();
    return out;
  },
  { defs: doc.items, size: SIZE * SUPERSAMPLE },
);

const { default: sharp } = await import('sharp');
await mkdir(iconsDir, { recursive: true });

let geschrieben = 0;
for (const eintrag of gerendert) {
  const item = doc.items.find((i) => i.id === eintrag.id);
  if (!eintrag.data) {
    console.log(`  ${eintrag.id.padEnd(18)} kein Modell — Kachel bleibt einfarbig`);
    delete item.icon;
    continue;
  }

  const png = Buffer.from(eintrag.data.split(',')[1], 'base64');
  const ziel = join(iconsDir, `${eintrag.id}.webp`);
  // Verkleinern statt direkt klein zeichnen: vier zu eins glättet die Kanten
  // besser als jedes Antialiasing im Renderer, und webp mit Alpha ist bei
  // dieser Größe ein paar hundert Byte.
  const info = await sharp(png).resize(SIZE, SIZE, { fit: 'inside' }).webp({ quality: 88 }).toFile(ziel);
  item.icon = `icons/${eintrag.id}.webp`;
  geschrieben++;
  console.log(`  ${eintrag.id.padEnd(18)} ${String(info.size).padStart(5)} Byte`);
}

await writeFile(itemsFile, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

await browser.close();
shutdown();

console.log(`\n${geschrieben} Symbole nach ${iconsDir}`);
console.log('Danach nicht vergessen: npm run manifest');
